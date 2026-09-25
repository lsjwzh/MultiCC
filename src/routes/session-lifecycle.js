'use strict';

const { createCodexRolloutGuard } = require('../chat/codex-rollout-guard');
const { isChatStateBusy } = require('../session/runtime-busy');

// Single-session lifecycle routes: DELETE /api/sessions/:id (cascades through
// the session's worktree, tmux pane and chat process), POST .../relocate
// (re-homes a session into a different directory with a fresh worktree), and
// POST .../restart (kill tmux + respawn the CLI in place, fresh conversation),
// and POST .../restart-spawn (chat counterpart: destroy the CLI process and all
// of its runtime state, keeping the conversation).
// The whole-server POST /api/restart is deliberately NOT here — it stays in
// server.js where its detached-scheduler wiring lives.
//
// The first three routes were extracted verbatim from server.js and their
// behaviour is preserved exactly. Every dependency is injected, with maps passed
// by reference and the module's own `fs` defaulting to the host's so tests can
// substitute an in-memory one.

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[session-lifecycle] ${name} must be a function`);
  }
}

function createSessionLifecycleRuntime(rawDeps) {
  const deps = rawDeps || {};
  const {
    sessions,
    chatSessions,
    persistedSessions,
    directories,
    invalidSessions,
    sessionPersistence,
    getChatStream,
    hasLiveBackgroundTasks,
    reapBackgroundTasks,
    asyncHandler,
    destroySessionCascade,
    tmuxKillSession,
    appendEvent,
    ensureDirGitReady,
    gitRelocateWorktree,
    gitWorktreeAdd,
    fs,
    broadcastTo,
    stopOutputCapture,
    assignKillReason,
    finishProviderAttempt,
    createSession,
    cwdForSession,
    cleanupPushMonitor,
    getSessionGitRuntime,
    // Optional: restart-spawn uses it to release the scheduler slot through the
    // canonical cancel. Deliberately not in the required list below — every
    // other route here predates it and must keep composing without it.
    getSessionWorkHost,
  } = deps;

  // restart-spawn force-archives the codex rollout of the restarted session so
  // the respawn builds a fresh thread instead of resuming possibly-wedged
  // history (injectable for tests).
  const codexRolloutGuard = deps.codexRolloutGuard || createCodexRolloutGuard({});

  for (const [map, name] of [
    [sessions, 'sessions'], [chatSessions, 'chatSessions'],
    [persistedSessions, 'persistedSessions'], [directories, 'directories'],
    [invalidSessions, 'invalidSessions'],
  ]) {
    if (!map || typeof map.get !== 'function' || typeof map.delete !== 'function') {
      throw new TypeError(`[session-lifecycle] ${name} map is required`);
    }
  }
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[session-lifecycle] sessionPersistence.mutate is required');
  }
  if (!fs || typeof fs.existsSync !== 'function') {
    throw new TypeError('[session-lifecycle] fs.existsSync is required');
  }
  for (const [fn, name] of [
    [getChatStream, 'getChatStream'], [hasLiveBackgroundTasks, 'hasLiveBackgroundTasks'],
    [reapBackgroundTasks, 'reapBackgroundTasks'], [asyncHandler, 'asyncHandler'],
    [destroySessionCascade, 'destroySessionCascade'],
    [tmuxKillSession, 'tmuxKillSession'], [appendEvent, 'appendEvent'],
    [ensureDirGitReady, 'ensureDirGitReady'], [gitRelocateWorktree, 'gitRelocateWorktree'],
    [gitWorktreeAdd, 'gitWorktreeAdd'], [broadcastTo, 'broadcastTo'],
    [stopOutputCapture, 'stopOutputCapture'], [assignKillReason, 'assignKillReason'],
    [finishProviderAttempt, 'finishProviderAttempt'],
    [createSession, 'createSession'], [cwdForSession, 'cwdForSession'],
    [cleanupPushMonitor, 'cleanupPushMonitor'], [getSessionGitRuntime, 'getSessionGitRuntime'],
  ]) assertFunction(fn, name);
  // chatStream is required further down server.js (chat machinery composes
  // after these routes mount); resolve it per request, never snapshot.
  const chatStream = () => getChatStream();

  function terminalizeProviderAttempt(chat, reasonCode) {
    const attempt = chat?._activeRunner?.providerAttempt;
    if (!attempt) return false;
    try {
      finishProviderAttempt(attempt, {
        outcome: 'failed', errorCategory: 'cancelled', reasonCode,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function backgroundTasksAreLive(sessionId) {
    try { return hasLiveBackgroundTasks(sessionId) === true; }
    catch (_) { return true; }
  }

  // Session-level relocate, shared by the HTTP route below and the task-board's
  // task-level move. Returns { ok, ... } or { ok: false, status, body } so the
  // caller decides how to surface it. opts.carry takes the worktree's
  // uncommitted changes (tracked diff + untracked files) into the new worktree.
  async function relocateSessionWorkspace(id, targetDirId, opts = {}) {
    const targetDir = directories.get(targetDirId);
    if (!targetDir) return { ok: false, status: 404, body: { error: 'target directory not found' } };
    const persisted = persistedSessions.get(id);
    if (!persisted) return { ok: false, status: 404, body: { error: 'session not found' } };
    if (persisted.dirId === targetDirId) return { ok: true, unchanged: true, cwd: targetDir.path };
    if (!fs.existsSync(targetDir.path)) return { ok: false, status: 400, body: { error: `directory path missing on disk: ${targetDir.path}` } };
    const force = opts.force === true;
    const activeTerminal = sessions.get(id);
    const activeChat = chatSessions.get(id);
    const activeBackground = backgroundTasksAreLive(id);
    // chat 运行时忙判定的唯一来源（src/session/runtime-busy.js）。clients.size 是另一
    // 条轴（有没有人在看这个会话），所以单独 OR 上来。
    const active = activeBackground || !!activeTerminal
      || isChatStateBusy(activeChat) || (activeChat?.clients?.size || 0) > 0;
    if (active && !force) {
      return { ok: false, status: 409, body: { ok: false, blocked: true, reasons: ['active'], error: 'active session cannot be relocated' } };
    }

    // The session's worktree belongs to the OLD directory's repo — relocate means
    // a fresh worktree in the target directory.
    const oldDir = directories.get(persisted.dirId);
    const readyTarget = await ensureDirGitReady(targetDir);
    if (!readyTarget.ok) {
      return { ok: false, status: 400, body: { error: `目标目录 git 未就绪: ${readyTarget.reason}` } };
    }

    // A never-materialized (planned) workspace owns no worktree yet: moving is
    // a pure record update — the worktree gets created in the new directory on
    // first use instead of being created just to be moved. An ACTIVE session
    // still falls through to the full path so its forced teardown runs.
    if ((!persisted.worktreePath || !persisted.branch) && !active) {
      sessionPersistence.mutate('http.relocate-session-planned', () => {
        persisted.dirId = targetDirId;
        persisted.cliSessionId = null;
      });
      invalidSessions.delete(id);
      return { ok: true, cwd: targetDir.path, forced: force, planned: true };
    }

    const oldSession = sessions.get(id);
    const relocated = await gitRelocateWorktree(oldDir, targetDir, persisted, {
      force, active,
      carry: opts.carry === true,
      activeCheck: force ? null : () => getSessionGitRuntime().isWorktreeActive(id),
      beforeRemove: async () => {
        if (oldSession) {
          broadcastTo(oldSession.clients, { type: 'relocate', cwd: targetDir.path });
          await stopOutputCapture(oldSession);
          await tmuxKillSession(oldSession.id);
          sessions.delete(id);
        }
        if (force) {
          if (activeChat) terminalizeProviderAttempt(activeChat, 'relocate');
          reapInterruptedBackgroundTasks(id, 'relocate');
          if (activeChat) {
            assignKillReason(activeChat._activeRunner, 'relocate');
            if (activeChat.claudeProc) try { activeChat.claudeProc.kill('SIGTERM'); } catch (_) {}
            chatStream().close(id);
            chatSessions.delete(id);
          }
        }
      },
    });
    if (!relocated.ok) return { ok: false, status: relocated.blocked ? 409 : 500, body: relocated };

    sessionPersistence.mutate('http.relocate-session', () => {
      persisted.worktreePath = relocated.worktreePath;
      persisted.branch = relocated.branch;
      persisted.dirId = targetDirId;
      // Clear cliSessionId so the new instance starts fresh in the new directory.
      persisted.cliSessionId = null;
    });
    invalidSessions.delete(id);

    if (persisted.kind === 'terminal') {
      try {
        await createSession(id);
      } catch (err) {
        return { ok: false, status: 500, body: { error: err.message } };
      }
    }
    return { ok: true, cwd: targetDir.path, forced: force,
      carried: relocated.carried || null,
      operationId: relocated.operationId,
      queueDepth: relocated.queueDepth,
      backup: relocated.backup || null };
  }

  function reapInterruptedBackgroundTasks(sessionId, reasonCode) {
    try { return reapBackgroundTasks(sessionId, reasonCode); }
    catch (_) { return 0; }
  }

  function mountRoutes(app) {
    app.delete('/api/sessions/:id', asyncHandler(async (req, res) => {
      const id = req.params.id;
      const session = sessions.get(id);
      const chat = chatSessions.get(id);
      const persisted = persistedSessions.get(id);
      if (!session && !chat && !persisted) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const force = req.query.force === '1' || req.body?.force === true;
      // Commander is the fleet's dispatcher — it can only be removed by deleting its
      // whole directory (which cascades through destroySessionCascade), never on its
      // own. Guard here on the single-session route only, unconditional of force.
      if (persisted?.type === 'commander') {
        return res.status(400).json({ error: 'Commander 会话不可单独删除，只能随其所属工作区一起删除' });
      }
      // A task-bound hidden session is its task's resume file and the only copy
      // of that task's chat evidence, so the supported disposal is deleting the
      // owning task (DELETE /api/task-board/tasks/:id), which cascades this room,
      // its worktree and every attached client. The fleet never lists task-bound
      // rooms and the chat view has no session-DELETE affordance, so a bare
      // DELETE arriving here is a sweep script — default-refuse, or bulk cleanup
      // would silently orphan task chat history.
      //
      // force=1 is deliberately weaker than the commander guard above, but it is
      // NOT a general hard reset: while the owning task still archives this room
      // the retention service refuses the physical delete with
      // TASK_HISTORY_REFERENCED (409), because the room's history has no second
      // copy (docs/chat-history-retention.md). force only clears the way for an
      // ORPHANED binding — a room whose task is already gone — and for the
      // task-deletion path, which releases the binding before calling the
      // cascade. The in-band reset for a live task is the chat view's
      // clear_history, which drops the native CLI session too.
      if (persisted?.taskBoundTaskId && !force) {
        return res.status(400).json({
          code: 'task_bound_session',
          taskId: persisted.taskBoundTaskId,
          error: 'task-bound 会话不可单独删除（任务 1:1 绑定）；请删除所属任务，或在会话内使用清空历史；force=1 只用于清理绑定任务已不存在的遗留会话',
        });
      }
      if (persisted) {
        const dir = directories.get(persisted.dirId);
        if (!dir) return res.status(404).json({ error: 'directory not found' });
        const result = await destroySessionCascade(persisted, dir, { force, removeRecord: false });
        if (!result.ok) return res.status(409).json(result);
        sessionPersistence.mutate('http.delete-session', records => records.delete(id));
        appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
        return res.json({ ...result, forced: force });
      } else {
        if (session) { await tmuxKillSession(id); for (const client of session.clients || []) try { client.terminate(); } catch (_) {} }
        if (chat) terminalizeProviderAttempt(chat, 'session_delete');
        reapInterruptedBackgroundTasks(id, 'session_delete');
        if (chat) { if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {} chatStream().close(id); for (const client of chat.clients || []) try { client.terminate(); } catch (_) {} }
        sessions.delete(id);
        chatSessions.delete(id);
      }
      res.json({ ok: true, forced: force });
    }));

    // Relocate: moves a session to a different directory. Caller passes the target dirId.
    // (Old "change cwd" semantics are gone — cwd lives on the directory now.)
    app.post('/api/sessions/:id/relocate', asyncHandler(async (req, res) => {
      const id = req.params.id;
      const targetDirId = (req.body.dirId || '').trim();
      if (!targetDirId) return res.status(400).json({ error: 'dirId required (cwd is now owned by the directory)' });
      const force = req.query.force === '1' || req.body?.force === true;
      const carry = req.body?.carry === true;
      const result = await relocateSessionWorkspace(id, targetDirId, { force, carry });
      if (!result.ok && result.status) return res.status(result.status).json(result.body);
      res.json(result);
    }));

    // ── Restart session (kill tmux + respawn CLI in same directory, fresh conversation) ──
    app.post('/api/sessions/:id/restart', asyncHandler(async (req, res) => {
      const id = req.params.id;
      const oldSession = sessions.get(id);
      const persisted = persistedSessions.get(id);
      if (!oldSession && !persisted) return res.status(404).json({ error: 'Session not found' });
      if (persisted && persisted.kind && persisted.kind !== 'terminal') {
        return res.status(400).json({ error: 'restart only applies to terminal sessions' });
      }

      const cwd = cwdForSession(persisted);
      const oldClients = oldSession ? [...oldSession.clients] : [];

      sessions.delete(id);
      if (oldSession) {
        await stopOutputCapture(oldSession);
        if (oldSession.exitCheckTimer) clearInterval(oldSession.exitCheckTimer);
        if (oldSession.captureTimer) clearInterval(oldSession.captureTimer);
        cleanupPushMonitor(id);
        oldSession.clients.clear();
      }
      await tmuxKillSession(id);

      // Clear cliSessionId so a brand-new conversation starts (claude allocates a fresh UUID,
      // codex generates a fresh thread on first turn). The worktree is kept across restarts;
      // only recreate it if it has gone missing.
      if (persisted) {
        let nextWorktreePath = persisted.worktreePath;
        let nextBranch = persisted.branch;
        const dir = directories.get(persisted.dirId);
        if (dir && (!persisted.worktreePath || !fs.existsSync(persisted.worktreePath))) {
          const ready = await ensureDirGitReady(dir);
          if (ready.ok) {
            try {
              const { worktreePath, branch } = await gitWorktreeAdd(dir.path, id, dir.baseBranch);
              nextWorktreePath = worktreePath;
              nextBranch = branch;
            } catch (e) {
              console.warn(`[multicc] restart: worktree recreate failed for ${id}: ${e.message}`);
            }
          }
        }
        sessionPersistence.mutate('http.restart-session', () => {
          persisted.cliSessionId = null;
          persisted.worktreePath = nextWorktreePath;
          persisted.branch = nextBranch;
        });
      }

      try {
        await createSession(id);
        console.log(`[multicc] Session ${id} restarted in ${cwd}`);
        broadcastTo(oldClients, { type: 'restart' });
        res.json({ ok: true, cwd });
      } catch (err) {
        console.error('[multicc] Restart failed:', err);
        res.status(500).json({ error: err.message });
      }
    }));

    // ── Hard-restart a chat session's CLI spawn ──
    // /restart above is terminal-only: it kills the tmux pane and builds a new
    // one. A chat session has no pane. Its CLI is a persistent `-p` stream
    // process plus in-memory runtime state — the busy flag, the in-flight turn's
    // unsettled promise, the replay buffer, the router MCP sidecar, and the
    // scheduler slot. When that state and the real process disagree (the CLI
    // died mid-turn, a provider 429 burned the retry budget, a kill was only
    // ever *requested*), re-reading the session list changes nothing: the
    // session reads as idle everywhere and still refuses every message. This
    // tears the spawn down for real.
    //
    // For codex the native rollout is force-archived here, so the respawn starts
    // a FRESH thread instead of resuming possibly oversized/wedged history —
    // restarting the process alone never helps when the rollout itself is the
    // bug (resume hangs deterministically). MultiCC's context layers recompose
    // every turn, so the rebuilt conversation keeps its grounding. The archived
    // file is preserved under <codex home>/multicc-archived-rollouts. Other CLIs
    // keep the classic behavior: the vendor session id stays on the persisted
    // record and the next turn respawns with --resume <same id>.
    //
    // The respawn is deliberately lazy. Only the turn engine can compute a spawn
    // (provider env, model args, subagent routing), so eagerly rebuilding the
    // process here would mean duplicating that; the next message spawns it with
    // config that is correct by construction.
    app.post('/api/sessions/:id/restart-spawn', asyncHandler(async (req, res) => {
      const id = req.params.id;
      const persisted = persistedSessions.get(id);
      const cs = chatSessions.get(id);
      if (!persisted && !cs) return res.status(404).json({ error: 'Session not found' });
      if (persisted && persisted.kind && persisted.kind !== 'chat') {
        return res.status(400).json({ error: 'restart-spawn only applies to chat sessions; terminal sessions use /restart' });
      }

      // Snapshot what was actually wrong, so the reply can show the caller that
      // something real was torn down rather than just claiming success.
      const streamBefore = (() => { try { return chatStream().status(id); } catch (_) { return null; } })();
      const before = {
        alive: !!streamBefore?.alive,
        busy: !!streamBefore?.busy,
        queued: streamBefore?.queued || 0,
        pid: streamBefore?.pid || null,
        isStreaming: !!cs?.isStreaming,
      };

      // 1. Business state first, through the canonical cancel. It releases the
      //    scheduler's active slot — the `P` that makes controlAllowedByClassify
      //    refuse every new unit of session work — writes the terminal verdict
      //    and republishes the task projection. Killing the process first would
      //    park the scheduler on a turn whose runner had already vanished.
      let cancelled = null;
      const workHost = typeof getSessionWorkHost === 'function' ? getSessionWorkHost() : null;
      if (workHost && typeof workHost.cancelActiveTurn === 'function') {
        try {
          cancelled = await workHost.cancelActiveTurn(id, {
            reason: 'restart_spawn', killReason: 'restart_spawn', source: 'restart_spawn',
          });
        } catch (error) {
          cancelled = { ok: false, code: 'cancel_failed', error: error.message };
        }
      }
      if (!cancelled || cancelled.ok !== true) {
        terminalizeProviderAttempt(cs, 'restart_spawn');
      }
      reapInterruptedBackgroundTasks(id, 'restart_spawn');

      // 2. Destroy the stream session: SIGTERM→SIGKILL the process, settle any
      //    in-flight turn, release the router MCP sidecar, drop the entry.
      try { chatStream().close(id); } catch (error) {
        console.warn(`[multicc] restart-spawn: stream close failed for ${id}: ${error.message}`);
      }

      // 3. Clear the per-session runtime the stream module does not own. Without
      //    this a stale isStreaming keeps the turn engine rejecting delivery as
      //    session-busy even though nothing is running any more.
      if (cs) {
        if (cs.claudeProc) { try { cs.claudeProc.kill('SIGTERM'); } catch (_) {} }
        cs.claudeProc = null;
        cs.isStreaming = false;
        cs.streamReplay = [];
        cs.lineBuf = '';
        cs.currentAssistantText = '';
        cs.currentToolCalls = [];
        cs._activeTurn = null;
        cs._activeRunner = null;
      }

      // 4. codex only, after the process is dead: force-archive the native
      //    rollout (any size) and drop cliSessionId so the lazy respawn starts
      //    a fresh thread. Fail-open: a guard error never fails the restart.
      let rolloutArchived = null;
      if (persisted) {
        const guardResult = codexRolloutGuard.enforce(persisted, { force: true });
        if (guardResult.action === 'archived') {
          persisted.cliSessionId = null;
          sessionPersistence.mutate('http.restart-spawn-rollout-archive', records => {
            const rec = records.get(id);
            if (rec) rec.cliSessionId = null;
          });
          rolloutArchived = guardResult.archived.map(item => ({
            file: item.file, sizeBytes: item.sizeBytes, archivedTo: item.archivedTo,
          }));
          console.log(`[multicc] restart-spawn ${id}: codex rollout archived: ${JSON.stringify(rolloutArchived)}`);
        }
      }

      if (persisted) appendEvent(persisted.dirId, 'session_spawn_restarted', persisted.label || id, null);
      console.log(`[multicc] restart-spawn ${id}: ${JSON.stringify(before)}`);
      res.json({ ok: true, before, cancelled, rolloutArchived, cli: persisted?.cli || cs?.cli || null });
    }));
    // Chainable: hosts capture the runtime as createSessionLifecycleRuntime({...}).mountRoutes(app).
    return api;
  }

  // Kept as a compatibility port. Archiving never disposes the task's evidence.
  async function releaseTaskBoundSession(id) {
    return { ok: false, code: 'task_history_retained' };
  }

  const api = { mountRoutes, releaseTaskBoundSession, relocateSessionWorkspace };
  return api;
}

module.exports = { createSessionLifecycleRuntime };

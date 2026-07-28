'use strict';

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
    createSession,
    cwdForSession,
    cleanupPushMonitor,
    getSessionGitRuntime,
    // Optional: restart-spawn uses it to release the scheduler slot through the
    // canonical cancel. Deliberately not in the required list below — every
    // other route here predates it and must keep composing without it.
    getSessionWorkHost,
  } = deps;

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
    [getChatStream, 'getChatStream'], [asyncHandler, 'asyncHandler'], [destroySessionCascade, 'destroySessionCascade'],
    [tmuxKillSession, 'tmuxKillSession'], [appendEvent, 'appendEvent'],
    [ensureDirGitReady, 'ensureDirGitReady'], [gitRelocateWorktree, 'gitRelocateWorktree'],
    [gitWorktreeAdd, 'gitWorktreeAdd'], [broadcastTo, 'broadcastTo'],
    [stopOutputCapture, 'stopOutputCapture'], [assignKillReason, 'assignKillReason'],
    [createSession, 'createSession'], [cwdForSession, 'cwdForSession'],
    [cleanupPushMonitor, 'cleanupPushMonitor'], [getSessionGitRuntime, 'getSessionGitRuntime'],
  ]) assertFunction(fn, name);
  // chatStream is required further down server.js (chat machinery composes
  // after these routes mount); resolve it per request, never snapshot.
  const chatStream = () => getChatStream();

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
        return res.status(400).json({ error: 'commander 会话不可单独删除，只能随其所属 fleet 一起删除' });
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
      const targetDir = directories.get(targetDirId);
      if (!targetDir) return res.status(404).json({ error: 'target directory not found' });
      const persisted = persistedSessions.get(id);
      if (!persisted) return res.status(404).json({ error: 'session not found' });
      if (persisted.dirId === targetDirId) return res.json({ ok: true, unchanged: true, cwd: targetDir.path });
      if (!fs.existsSync(targetDir.path)) return res.status(400).json({ error: `directory path missing on disk: ${targetDir.path}` });
      const force = req.query.force === '1' || req.body.force === true;
      const activeTerminal = sessions.get(id);
      const activeChat = chatSessions.get(id);
      const active = !!activeTerminal || !!(activeChat && (activeChat.claudeProc || activeChat.isStreaming || activeChat.clients?.size));
      if (active && !force) {
        return res.status(409).json({ ok: false, blocked: true, reasons: ['active'], error: 'active session cannot be relocated' });
      }

      // The session's worktree belongs to the OLD directory's repo — relocate means
      // a fresh worktree in the target directory.
      const oldDir = directories.get(persisted.dirId);
      const readyTarget = await ensureDirGitReady(targetDir);
      if (!readyTarget.ok) {
        return res.status(400).json({ error: `目标目录 git 未就绪: ${readyTarget.reason}` });
      }

      const oldSession = sessions.get(id);
      const relocated = await gitRelocateWorktree(oldDir, targetDir, persisted, {
        force, active,
        activeCheck: force ? null : () => getSessionGitRuntime().isWorktreeActive(id),
        beforeRemove: async () => {
          if (oldSession) {
            broadcastTo(oldSession.clients, { type: 'relocate', cwd: targetDir.path });
            await stopOutputCapture(oldSession);
            await tmuxKillSession(oldSession.id);
            sessions.delete(id);
          }
          if (activeChat && force) {
            assignKillReason(activeChat._activeRunner, 'relocate');
            if (activeChat.claudeProc) try { activeChat.claudeProc.kill('SIGTERM'); } catch (_) {}
            chatStream().close(id);
            chatSessions.delete(id);
          }
        },
      });
      if (!relocated.ok) return res.status(relocated.blocked ? 409 : 500).json(relocated);

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
          return res.status(500).json({ error: err.message });
        }
      }
      res.json({ ok: true, cwd: targetDir.path, forced: force,
        operationId: relocated.operationId,
        queueDepth: relocated.queueDepth,
        backup: relocated.backup || null });
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
    // The conversation is NOT lost. The vendor session id lives on the persisted
    // record, so the next turn re-ensures and respawns with --resume <same id>.
    // To start a genuinely blank conversation, clear the history first — that
    // path already invalidates every CLI's native session — then restart here.
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

      if (persisted) appendEvent(persisted.dirId, 'session_spawn_restarted', persisted.label || id, null);
      console.log(`[multicc] restart-spawn ${id}: ${JSON.stringify(before)}`);
      res.json({ ok: true, before, cancelled, cli: persisted?.cli || cs?.cli || null });
    }));
  }

  return { mountRoutes };
}

module.exports = { createSessionLifecycleRuntime };

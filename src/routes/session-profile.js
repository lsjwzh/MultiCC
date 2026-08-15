'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeManualMemory } = require('../memory/runtime');

// Session profile routes: PATCH /api/sessions/:id (label/model/effort/agent/
// rolePrompt/memory/auto-flags/provider/subagent edits) and POST
// /api/sessions/:id/fork (Happier-parity transcript branch).
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; the only
// change is that mutable host state (chatHistoryService, folderMemory, the
// CLI-switch snapshot helper) is read through getters so a runtime that is
// composed after this module mounts is still resolved at request time rather
// than captured as a stale null snapshot.

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[session-profile] ${name} must be a function`);
  }
}

function createSessionProfileRoutes(rawDeps) {
  const deps = rawDeps || {};
  const {
    persistedSessions,
    directories,
    sessionPersistence,
    sessionPolicy,
    providers,
    providerRouterRuntime,
    getChatStream,
    validProviderId,
    asyncHandler,
    appendEvent,
    workspaceBroadcast,
    chatBroadcast,
    getTaskState,
    rememberActiveCliState,
    buildHandoffCheckpoint,
    cliStateSummary,
    cliAvailabilitySummary,
    cliHandoffSummary,
    createSessionRecord,
    loadChatHistory,
    newChatMsgId,
    getChatHistoryService,
    getFolderMemory,
    getCliSwitchGitSnapshot,
  } = deps;

  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[session-profile] persistedSessions map is required');
  }
  if (!directories || typeof directories.get !== 'function') {
    throw new TypeError('[session-profile] directories map is required');
  }
  if (!sessionPersistence
    || typeof sessionPersistence.begin !== 'function'
    || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[session-profile] sessionPersistence (with begin/mutate) is required');
  }
  if (!sessionPolicy
    || typeof sessionPolicy.normalizeEffort !== 'function'
    || typeof sessionPolicy.validEffortForCli !== 'function'
    || typeof sessionPolicy.effectiveSessionEffort !== 'function'
    || typeof sessionPolicy.effortLabel !== 'function'
    || typeof sessionPolicy.normalizeCliAgent !== 'function'
    || typeof sessionPolicy.providerDefaultModel !== 'function'
    || typeof sessionPolicy.effectiveSessionModel !== 'function'
    || typeof sessionPolicy.serializeSubagent !== 'function') {
    throw new TypeError('[session-profile] sessionPolicy must expose effort/model/subagent helpers');
  }
  if (!providers
    || typeof providers.appTypeForCli !== 'function'
    || typeof providers.modelValidForProvider !== 'function'
    || typeof providers.codexProviderProxyable !== 'function'
    || typeof providers.CODEX_HOMES_DIR !== 'string') {
    throw new TypeError('[session-profile] providers must expose app-type/model/codex helpers and CODEX_HOMES_DIR');
  }
  if (!providerRouterRuntime || typeof providerRouterRuntime.getProviderSummary !== 'function') {
    throw new TypeError('[session-profile] providerRouterRuntime.getProviderSummary is required');
  }
  for (const [fn, name] of [
    [getChatStream, 'getChatStream'],
    [validProviderId, 'validProviderId'], [asyncHandler, 'asyncHandler'],
    [appendEvent, 'appendEvent'], [workspaceBroadcast, 'workspaceBroadcast'],
    [chatBroadcast, 'chatBroadcast'], [getTaskState, 'getTaskState'],
    [rememberActiveCliState, 'rememberActiveCliState'],
    [buildHandoffCheckpoint, 'buildHandoffCheckpoint'],
    [cliStateSummary, 'cliStateSummary'], [cliAvailabilitySummary, 'cliAvailabilitySummary'],
    [cliHandoffSummary, 'cliHandoffSummary'],
    [createSessionRecord, 'createSessionRecord'], [loadChatHistory, 'loadChatHistory'],
    [newChatMsgId, 'newChatMsgId'],
    [getChatHistoryService, 'getChatHistoryService'], [getFolderMemory, 'getFolderMemory'],
    [getCliSwitchGitSnapshot, 'getCliSwitchGitSnapshot'],
  ]) assertFunction(fn, name);

  // chatStream is composed further down server.js (after route mounting), so it
  // arrives as a getter and resolves per call.
  const chatStream = () => getChatStream();

  const {
    normalizeEffort,
    validEffortForCli,
    effectiveSessionEffort,
    effortLabel,
    normalizeCliAgent,
    providerDefaultModel,
    effectiveSessionModel,
    serializeSubagent,
  } = sessionPolicy;

  function mountRoutes(app) {
    // PATCH a session — supports display-name edits via label.
    app.patch('/api/sessions/:id', (req, res) => {
      const s = persistedSessions.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'session not found' });
      if (s.type === 'aux' || s.type === 'gateway') {
        return res.status(400).json({ error: 'system session cannot be renamed' });
      }
      if (req.body.cli !== undefined) {
        return res.status(400).json({
          error: 'cli cannot be changed with PATCH; use POST /api/sessions/:id/switch-cli',
        });
      }
      const mutation = sessionPersistence.begin('http.patch-session');
      const rejectMutation = (status, body) => {
        mutation.rollback();
        return res.status(status).json(body);
      };
      try {
      if (req.body.label !== undefined) {
        const label = (req.body.label || '').toString().trim();
        if (label.length > 80) return rejectMutation(400, { error: 'label too long (max 80)' });
        s.label = label || null;
        appendEvent(s.dirId, 'session_renamed', s.label || s.id, s.id);
        // Renames used to be write-only: the PATCH persisted + audited but no
        // socket heard about it, so every client kept showing the old title
        // until its next full list reload. Push the new label on both planes —
        // workspace (fleet lists/dashboards) and the session's own chat socket
        // (open chat headers).
        const labelEvent = { type: 'session_updated', sessionId: s.id, label: s.label || null };
        workspaceBroadcast(s.dirId, labelEvent);
        chatBroadcast(s.id, labelEvent);
      }
      if (req.body.model !== undefined) {
        const model = (req.body.model || '').toString().trim();
        // Allow `/` and `:` for OpenRouter-style ids and provider:model forms.
        if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
          return rejectMutation(400, { error: 'invalid model' });
        }
        s.model = model || null;
        // Non-Claude chat sessions spawn per turn. Claude chat keeps a warm
        // process, so close it now or the UI would report the new model while the
        // next turn still runs on the old one. Terminal sessions still need a
        // manual restart to relaunch their CLI with it.
        if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream().close(s.id);
        appendEvent(s.dirId, 'session_model_changed', `${s.label || s.id} → ${s.model || '默认'}`, s.id);
      }
      if (req.body.effort !== undefined) {
        const effort = normalizeEffort(req.body.effort);
        if (effort === undefined) return rejectMutation(400, { error: 'invalid effort' });
        if (!validEffortForCli(s.cli || 'claude', effort)) return rejectMutation(400, { error: 'invalid reasoning level' });
        s.effort = effort || null;
        if ((s.cli || 'claude') === 'claude') chatStream().close(s.id);
        appendEvent(s.dirId, 'session_effort_changed', `${s.label || s.id} → ${effectiveSessionEffort(s) || effortLabel(s.effort)}`, s.id);
      }
      if (req.body.agent !== undefined) {
        const agent = normalizeCliAgent(s.cli || 'claude', req.body.agent);
        if (agent === undefined) return rejectMutation(400, { error: 'agent is only supported by Claude/OpenCode and must be a valid agent name' });
        s.agent = agent;
        if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream().close(s.id);
        appendEvent(s.dirId, 'session_agent_changed', `${s.label || s.id} → ${s.agent || '默认 agent'}`, s.id);
      }
      if (req.body.rolePrompt !== undefined) {
        const rp = (req.body.rolePrompt == null ? '' : String(req.body.rolePrompt));
        if (rp.length > 40000) return rejectMutation(400, { error: 'rolePrompt too long (max 40000)' });
        // null clears the session override → it falls back to the directory default.
        s.rolePrompt = rp.trim() || null;
        if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream().close(s.id);
        appendEvent(s.dirId, 'session_role_changed', s.rolePrompt ? (s.label || s.id) : `${s.label || s.id}（清除，继承目录）`, s.id);
      }
      if (req.body.memory !== undefined) {
        // Session memory: structured entries (array of {type,text,ts}).
        // Accept both new array format and legacy string (auto-converted).
        const normalized = normalizeManualMemory(req.body.memory);
        if (normalized.error) return rejectMutation(400, { error: normalized.error });
        const { entries } = normalized;
        s.memory = entries;
        appendEvent(s.dirId, 'memory_updated', s.memory ? '手动编辑会话记忆' : '清空会话记忆', s.id);
        workspaceBroadcast(s.dirId, { type: 'memory', sessionId: s.id, memory: s.memory || [] });
      }
      // streaming (流式常驻) is no longer user-configurable: claude chat always runs
      // in persistent-streaming mode. Any legacy `streaming` field in the PATCH body
      // is ignored — the routing guard in runChatTurn keys on cli only.
      if (req.body.autoContinue !== undefined) {
        // autoContinue is no longer user-configurable (the streaming picker dropped
        // this toggle). Accept the field for back-compat with older clients but pin
        // it true. The old auto-drive paths are
        // retired; classify's D/W guards are the safety rails now.
        s.autoContinue = true;
      }
      if (req.body.autoCommit !== undefined) {
        // Auto-commit and merge worktree back to base branch after a successful turn.
        s.autoCommit = !!req.body.autoCommit;
        appendEvent(s.dirId, 'session_autocommit_changed', `${s.label || s.id} → ${s.autoCommit ? '自动提交合并' : '关闭'}`, s.id);
      }
      if (req.body.provider !== undefined) {
        // Per-session cc-switch provider. '' / null clears the override → default login.
        const v = validProviderId(s.cli || 'claude', (req.body.provider || '').toString().trim());
        if (!v.ok) return rejectMutation(400, { error: 'invalid provider' });
        const prevProvider = s.provider;
        s.provider = v.value;
        // Codex keeps each provider's threads under its own CODEX_HOME
        // (sessions/YYYY/MM/DD/rollout-<ts>-<cliSessionId>.jsonl). Switching provider
        // repoints the next spawn at a different home, so `codex exec resume <id>`
        // would no longer find this session's rollout and silently start a fresh
        // thread. Carry the rollout over to the new home so resume keeps working.
        if (s.cli === 'codex' && s.cliSessionId && prevProvider !== v.value) {
          try {
            const codexHomeFor = (pid) => pid
              ? path.join(providers.CODEX_HOMES_DIR, pid)
              : path.join(os.homedir(), '.codex');
            const srcSessions = path.join(codexHomeFor(prevProvider), 'sessions');
            let srcFile = null;
            if (fs.existsSync(srcSessions)) {
              const walk = (d) => {
                if (srcFile) return;
                let entries;
                try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                  if (srcFile) return;
                  if (e.isDirectory()) walk(path.join(d, e.name));
                  else if (e.isFile() && e.name.endsWith(`-${s.cliSessionId}.jsonl`)) srcFile = path.join(d, e.name);
                }
              };
              walk(srcSessions);
            }
            if (srcFile) {
              const dstFile = path.join(codexHomeFor(v.value), 'sessions', path.relative(srcSessions, srcFile));
              if (!fs.existsSync(dstFile)) {
                fs.mkdirSync(path.dirname(dstFile), { recursive: true });
                fs.copyFileSync(srcFile, dstFile);
                console.log(`[multicc/provider] migrated codex rollout ${s.cliSessionId}: ${prevProvider || '默认'} -> ${v.value || '默认'}`);
              }
            }
          } catch (e) {
            console.warn(`[multicc/provider] codex rollout migration failed for ${s.id}:`, e.message);
          }
        }
        // When switching provider the old session.model may hold a model that
        // only works with the previous backend (e.g. claude-opus-4-8 set while
        // on Anthropic Official, then switching to DeepSeek/GLM which don't
        // ship that model). Replace it with the new provider's primary model
        // (or the user's /model default when switching back to the default login)
        // so the card always shows a concrete, correct model name instead of a
        // stale "默认" placeholder. The user can still re-set via /model afterwards.
        const sessionCli = s.cli || 'claude';
        const appType = providers.appTypeForCli(sessionCli);
        const globalProviderCli = sessionCli === 'opencode' || sessionCli === 'zcode';
        const providerSummary = v.value
          ? providerRouterRuntime.getProviderSummary(globalProviderCli ? undefined : appType, v.value)
          : null;
        // ZCode/OpenCode consume either pool directly. Their default must be the
        // provider's real model id, never Claude's synthetic alias-tier fallback.
        const nextDefaultModel = globalProviderCli
          ? (providerSummary?.model || providerSummary?.modelOptions?.[0] || null)
          : providerDefaultModel(appType, v.value);
        // Provider-less OpenCode/ZCode sessions run on the CLI's native config
        // (e.g. OpenCode Go in ~/.config/opencode/opencode.json); their model is
        // a native `provider/model` id from /api/opencode/models, which the
        // claude-pool validation below always rejects. Skipping it here stops
        // every default-provider save from silently wiping the model to 默认.
        const nativeCliDefault = globalProviderCli && !v.value;
        const validationAppType = nativeCliDefault
          ? null
          : (providerSummary?.appType || appType);
        if ((appType || globalProviderCli) && req.body.model === undefined) {
          s.model = nextDefaultModel || null;
        } else if (validationAppType && !providers.modelValidForProvider(
          validationAppType,
          v.value,
          s.model,
          providerSummary,
        )) {
          // The same PATCH carried a model (the AI-config dialog always submits
          // provider+model together), but the new provider doesn't serve it — a
          // stale value from the previous provider. Replace it with the new
          // provider's primary model instead of letting every subsequent spawn
          // 400/10404 against a model the provider never had.
          const stale = s.model;
          s.model = nextDefaultModel || null;
          appendEvent(s.dirId, 'session_model_changed',
            `${s.label || s.id} → ${s.model || '默认'}（${stale} 与新 Provider 不兼容，已自动替换）`, s.id);
        }
        // Chat sessions pick it up on the next per-turn spawn; a warm streaming
        // process must be torn down so it relaunches with the new env.
        if ((s.cli || 'claude') === 'claude') chatStream().close(s.id);
        const pname = v.value
          ? (providerSummary?.name || v.value)
          : (sessionCli === 'zcode' ? 'ZCode 原生 / Coding Plan' : (appType ? '默认登录' : '厂商客户端设置'));
        appendEvent(s.dirId, 'session_provider_changed', `${s.label || s.id} → ${pname}`, s.id);
        // Push current classify state to chat so the classify bar updates immediately
        // (otherwise the chat page shows stale / blank until the next classify run).
        try {
          const ts = getTaskState(s);
          if (ts && (ts.goal || ts.classifyState)) {
            chatBroadcast(s.id, { type: 'task_state', goal: ts.goal || '', phase: ts.phase || 'idle', classifyState: ts.classifyState || null });
          }
        } catch (_) {}
      }
      if (req.body.subagent !== undefined) {
        // Per-session subagent provider+model. Claude encodes the route in its model;
        // Codex materializes native default/worker/explorer agent config layers that
        // select a second model_provider. null / '' / {} clears the override.
        const sa = req.body.subagent;
        const cli = s.cli || 'claude';
        const clearing = sa === null || sa === '' || (typeof sa === 'object' && Object.keys(sa).length === 0);
        if (!clearing && cli !== 'claude' && cli !== 'codex') {
          return rejectMutation(400, { error: 'subagent routing is only supported by Claude and Codex' });
        }
        if (clearing) {
          s.subagent = null;
        } else if (typeof sa === 'object') {
          const subApp = (s.cli === 'codex') ? 'codex' : 'claude';
          const v = validProviderId(subApp, (sa.providerId || '').toString().trim());
          if (!v.ok) return rejectMutation(400, { error: 'invalid subagent provider' });
          const model = (sa.model || '').toString().trim();
          if (!model) return rejectMutation(400, { error: 'subagent model required' });
          if (s.cli === 'codex') {
            if (!s.provider) return rejectMutation(400, { error: 'Codex subagent routing requires a selected main provider' });
            if (!providers.codexProviderProxyable(v.value)) {
              return rejectMutation(400, { error: 'Codex subagent provider has no callable HTTP endpoint' });
            }
          }
          s.subagent = { providerId: v.value, model };
        } else {
          return rejectMutation(400, { error: 'invalid subagent' });
        }
        // A warm streaming process must relaunch to pick up CLAUDE_CODE_SUBAGENT_MODEL.
        if ((s.cli || 'claude') === 'claude') chatStream().close(s.id);
        const subApp2 = (s.cli === 'codex') ? 'codex' : 'claude';
        const saName = s.subagent
          ? `${providerRouterRuntime.getProviderSummary(subApp2, s.subagent.providerId)?.name || s.subagent.providerId} / ${s.subagent.model}`
          : '默认(随主)';
        appendEvent(s.dirId, 'session_subagent_changed', `${s.label || s.id} 子任务 → ${saName}`, s.id);
      }
      rememberActiveCliState(s);
      mutation.commit();
      res.json({
        ...s,
        // The full checkpoint can contain recent visible conversation text. Keep
        // it server-side and expose only lifecycle metadata in ordinary responses.
        cliStates: cliStateSummary(s),
        cliAvailability: cliAvailabilitySummary(),
        pendingCliHandoff: cliHandoffSummary(s),
        subagent: serializeSubagent(s.subagent),
        effectiveModel: effectiveSessionModel(s),
        effectiveEffort: effectiveSessionEffort(s),
      });
      } catch (error) {
        mutation.rollback();
        throw error;
      }
    });

    // ── Session fork (Happier-parity: branch a session at any message) ──
    // Creates a NEW live session that inherits the source's provider/model/effort/
    // rolePrompt and replays the transcript up to (and including) the chosen message
    // as its starting context — like Happier's forkedTranscriptSnapshot + replaySeed.
    // The 50-message rolling window means old messages may already be distilled into
    // memory; we therefore also copy the source session's private memory folder so the
    // forked session isn't blind to pre-window context. A `forkedFrom` meta record is
    // stamped as the first message of the new history.
    app.post('/api/sessions/:id/fork', asyncHandler(async (req, res) => {
      const src = persistedSessions.get(req.params.id);
      if (!src) return res.status(404).json({ error: 'session not found' });
      if (src.type === 'aux' || src.type === 'gateway') {
        return res.status(400).json({ error: 'system session cannot be forked' });
      }
      const b = req.body || {};
      const label = (b.label || '').toString().trim() || null;
      const includeMemory = b.includeMemory !== false; // default true
      const atMessageId = b.atMessageId ? String(b.atMessageId) : null;

      // Slice source history up to (and including) the chosen message id.
      // If atMessageId is null/omitted, fork from the latest message.
      const history = loadChatHistory(src.id);
      let sliced;
      if (!atMessageId) {
        sliced = history.map(m => ({ ...m }));
      } else {
        const idx = history.findIndex(m => m && m.id === atMessageId);
        if (idx < 0) return res.status(400).json({ error: 'atMessageId not found in history' });
        sliced = history.slice(0, idx + 1).map(m => ({ ...m }));
      }

      // Create the forked session record, inheriting the source's CLI/provider/model/
      // effort/native-agent/rolePrompt so it continues from the same backend.
      const dir = directories.get(src.dirId);
      const r = await createSessionRecord({
        dir, cli: src.cli, kind: 'chat', label: label || `${src.label || src.id} · fork`,
        provider: src.provider == null ? undefined : src.provider,
        model: src.model, effort: src.effort, agent: src.agent, rolePrompt: src.rolePrompt,
        persistence: 'required', persistenceSource: 'http.fork-session-create',
      });
      if (!r.ok) return res.status(400).json({ error: r.error });
      const newSid = r.id;

      // Seed the new session's chat history with the sliced transcript. The forkedFrom
      // meta message goes first so the agent and UI can see this is a fork.
      const forkMeta = {
        id: newChatMsgId(),
        role: 'system',
        content: `Forked from session \`${src.id}\` (label: ${src.label || '—'}) at message \`${atMessageId || 'latest'}\`. ` +
                 `This session continues from that point; prior context above is the replayed transcript, ` +
                 `and the source session's distilled memory has been copied into this session's memory folder.`,
        ts: Date.now(),
        forkedFrom: { sessionId: src.id, atMessageId: atMessageId || null, atTs: sliced.length ? sliced[sliced.length - 1].ts : null },
      };
      const newHistory = [forkMeta, ...sliced];
      getChatHistoryService().replace(newSid, newHistory, { reason: 'fork' });

      // A fork has a fresh vendor-native session, so copying display history alone
      // is not context continuation. Seed the same one-shot checkpoint mechanism
      // used by cross-CLI switches; it is consumed only after the fork produces a
      // successful result.
      const forkGitSnapshot = await getCliSwitchGitSnapshot()(r.session);
      const forkCheckpoint = buildHandoffCheckpoint({
        session: src,
        fromCli: src.cli,
        toCli: r.session.cli,
        history: sliced,
        git: forkGitSnapshot,
      });
      sessionPersistence.mutate('http.fork-session-finalize', () => {
        if (src.subagent && src.subagent.providerId && src.subagent.model) {
          r.session.subagent = { providerId: src.subagent.providerId, model: src.subagent.model };
        }
        r.session.pendingCliHandoff = {
          id: `fork_${crypto.randomBytes(8).toString('hex')}`,
          fromCli: src.cli,
          toCli: r.session.cli,
          createdAt: forkCheckpoint.createdAt,
          status: 'pending',
          reusedTarget: false,
          checkpoint: forkCheckpoint,
        };
        rememberActiveCliState(r.session);
      });

      // Copy the source session's private memory folder (CLAUDE.md/AGENTS.md + any
      // notes) so pre-window distilled context survives into the fork. Best-effort.
      const folderMemory = getFolderMemory();
      if (includeMemory) {
        try {
          const srcMemDir = folderMemory.sessionDir(src);
          const dstMemDir = folderMemory.sessionDir(r.session);
          if (fs.existsSync(srcMemDir)) {
            fs.mkdirSync(dstMemDir, { recursive: true });
            fs.cpSync(srcMemDir, dstMemDir, { recursive: true });
          }
        } catch (e) {
          console.error(`[multicc/fork] memory copy failed ${src.id}→${newSid}:`, e.message);
        }
      }

      appendEvent(src.dirId, 'session_forked', `${src.label || src.id} → ${newSid}`, newSid);
      res.json({
        ok: true,
        sessionId: newSid,
        session: {
          ...r.session,
          cliStates: cliStateSummary(r.session),
          pendingCliHandoff: cliHandoffSummary(r.session),
        },
        forkedFrom: forkMeta.forkedFrom, replayedMessages: sliced.length });
    }));
  }

  return { mountRoutes };
}

module.exports = { createSessionProfileRoutes };

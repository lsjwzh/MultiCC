'use strict';

const crypto = require('node:crypto');

function cliHandoffSummary(session) {
  const handoff = session && session.pendingCliHandoff;
  return handoff ? {
    id: handoff.id,
    fromCli: handoff.fromCli,
    toCli: handoff.toCli,
    status: handoff.status,
    reason: handoff.reason || null,
    createdAt: handoff.createdAt,
    reusedTarget: !!handoff.reusedTarget,
  } : null;
}

function requireFunction(options, name) {
  if (typeof options[name] !== 'function') {
    throw new TypeError(`[cli-switch-runtime] ${name} is required`);
  }
}

function createCliSwitchRuntime(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[cli-switch-runtime] options are required');
  }
  const records = options.records;
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] records map is required');
  }
  const sessionPersistence = options.sessionPersistence;
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[cli-switch-runtime] sessionPersistence.mutate is required');
  }
  const supportedClis = options.supportedClis;
  if (!Array.isArray(supportedClis)) {
    throw new TypeError('[cli-switch-runtime] supportedClis array is required');
  }
  for (const name of [
    'getProviderDefaults', 'codexDefaultReasoningLevel', 'getHistory',
    'buildHandoffCheckpoint', 'activateCliState', 'rememberActiveCliState',
    'ensureCliStates', 'cliStateSummary', 'gitWorktreeSnapshot', 'cwdForSession',
    'getChatStream', 'cancelClassify', 'assignKillReason', 'appendMessage',
    'appendEvent', 'chatBroadcast', 'workspaceBroadcast', 'saveBestEffort',
    'cliAvailabilitySummary', 'sessionProviderName', 'effectiveSessionModel',
    'effectiveSessionEffort', 'serializeSubagent',
  ]) requireFunction(options, name);

  const chatSessions = options.chatSessions;
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] chatSessions map is required');
  }
  const clock = options.clock || Date.now;
  const handoffIdFactory = options.handoffIdFactory
    || (() => `handoff_${crypto.randomBytes(8).toString('hex')}`);

  function cliSwitchDefaults(cli) {
    const providerDefaults = options.getProviderDefaults() || {};
    return {
      provider: providerDefaults[cli] || null,
      model: null,
      effort: cli === 'codex' ? options.codexDefaultReasoningLevel() : null,
      subagent: null,
      agent: null,
    };
  }

  async function cliSwitchGitSnapshot(session) {
    const fallback = { branch: session.branch || null, head: null, changes: [] };
    try {
      const snapshot = await options.gitWorktreeSnapshot(
        options.cwdForSession(session),
        session.branch || null,
      );
      return { branch: snapshot.branch, head: snapshot.head, changes: snapshot.changes };
    } catch (_) {
      return fallback;
    }
  }

  function cliSwitchBusyState(sessionId) {
    const chat = chatSessions.get(sessionId);
    const stream = options.getChatStream().status(sessionId);
    const busy = !!(
      (chat && (chat.isStreaming || chat.claudeProc))
      || (stream && (stream.busy || stream.queued > 0))
    );
    return { busy, cs: chat, stream };
  }

  function resetChatRuntimeForCli(chat, session) {
    if (!chat) return;
    options.assignKillReason(chat._activeRunner, 'cli_switch');
    if (chat.claudeProc) {
      try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
      chat.claudeProc = null;
    }
    options.cancelClassify(chat);
    chat.cli = session.cli;
    chat.chatTurnCount = (session.cliSessionId || session._streamSessionId) ? 1 : 0;
    chat.lineBuf = '';
    chat.currentAssistantText = '';
    chat.currentToolCalls = [];
    chat.currentCost = null;
    chat.isStreaming = false;
    chat.streamReplay = [];
    chat._adapterError = null;
    chat._activeRunner = null;
    chat._activeTurn = null;
    chat._continuationLineage = null;
    chat._resultSaved = false;
    chat._sawApiError = false;
  }

  function performCliSwitch(session, targetCli, switchOptions = {}) {
    const fromCli = session.cli || 'claude';
    const now = clock();
    const checkpoint = options.buildHandoffCheckpoint({
      session,
      fromCli,
      toCli: targetCli,
      history: options.getHistory(session.id),
      git: switchOptions.gitSnapshot || { branch: session.branch || null, head: null, changes: [] },
      now,
    });
    const result = options.activateCliState(session, targetCli, {
      fresh: switchOptions.fresh === true,
      defaults: cliSwitchDefaults(targetCli),
      now,
    });
    const handoff = {
      id: handoffIdFactory(),
      fromCli,
      toCli: targetCli,
      createdAt: checkpoint.createdAt,
      status: 'pending',
      reusedTarget: result.reused,
      checkpoint,
    };
    session.pendingCliHandoff = handoff;

    options.getChatStream().close(session.id);
    resetChatRuntimeForCli(chatSessions.get(session.id), session);
    options.rememberActiveCliState(session, now);
    options.appendMessage(session.id, {
      role: 'system',
      content: `CLI switched from ${fromCli} to ${targetCli}. A structured handoff checkpoint will be delivered with the next message.`,
      ts: now,
      cliSwitch: {
        handoffId: handoff.id,
        fromCli,
        toCli: targetCli,
        reusedTarget: result.reused,
      },
    });
    options.appendEvent(
      session.dirId,
      'session_cli_changed',
      `${session.label || session.id}: ${fromCli} → ${targetCli}`,
      session.id,
    );
    options.chatBroadcast(session.id, {
      type: 'cli_switched',
      cli: targetCli,
      fromCli,
      handoffId: handoff.id,
      reusedTarget: result.reused,
      fresh: switchOptions.fresh === true,
      provider: session.provider || null,
      providerName: options.sessionProviderName(session),
      model: session.model || null,
      effectiveModel: options.effectiveSessionModel(session),
      effort: session.effort || null,
      effectiveEffort: options.effectiveSessionEffort(session),
      subagent: options.serializeSubagent(session.subagent),
    });
    if (session.dirId) {
      options.workspaceBroadcast(session.dirId, {
        type: 'session_cli_changed', sessionId: session.id, cli: targetCli,
      });
    }
    return { result, handoff };
  }

  function consumePendingCliHandoff(sessionName) {
    const session = records.get(sessionName);
    const handoff = session && session.pendingCliHandoff;
    if (!handoff || handoff.status !== 'pending') return false;
    session.lastCliHandoff = {
      id: handoff.id,
      fromCli: handoff.fromCli,
      toCli: handoff.toCli,
      createdAt: handoff.createdAt,
      consumedAt: new Date(clock()).toISOString(),
    };
    delete session.pendingCliHandoff;
    options.rememberActiveCliState(session);
    options.saveBestEffort('runtime.consume-cli-handoff');
    options.chatBroadcast(sessionName, {
      type: 'system',
      subtype: 'cli_handoff_applied',
      message: handoff.reason === 'history_clear_keep'
        ? `✓ 保留的最近消息已由 ${handoff.toCli} 作为新上下文接收`
        : `✓ ${handoff.fromCli} → ${handoff.toCli} 的上下文交接已由目标 CLI 接收`,
    });
    return true;
  }

  function mountRoutes(app, asyncHandler) {
    if (!app || typeof app.post !== 'function') throw new TypeError('[cli-switch-runtime] app.post is required');
    if (typeof asyncHandler !== 'function') throw new TypeError('[cli-switch-runtime] asyncHandler is required');
    app.post('/api/sessions/:id/switch-cli', asyncHandler(async (req, res) => {
      const session = records.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'session not found' });
      if (session.type === 'aux' || session.type === 'gateway') {
        return res.status(400).json({ error: 'system session must be switched by its bridge controller' });
      }
      if (session.kind !== 'chat') {
        return res.status(400).json({ error: 'only chat sessions can switch CLI' });
      }
      const targetCli = String(req.body && req.body.cli || '').trim().toLowerCase();
      if (!supportedClis.includes(targetCli)) {
        return res.status(400).json({ error: `cli must be one of: ${supportedClis.join(', ')}` });
      }
      const fresh = !!(req.body && req.body.fresh);
      if ((session.cli || 'claude') === targetCli && !fresh) {
        sessionPersistence.mutate('http.switch-cli-noop', () => options.ensureCliStates(session));
        return res.json({
          ok: true,
          changed: false,
          cli: targetCli,
          cliStates: options.cliStateSummary(session),
          cliAvailability: options.cliAvailabilitySummary(),
          pendingCliHandoff: cliHandoffSummary(session),
        });
      }
      const availability = options.cliAvailabilitySummary();
      if (!availability[targetCli]?.available) {
        return res.status(400).json({ error: `${targetCli} CLI is not installed or not executable` });
      }
      const activity = cliSwitchBusyState(session.id);
      if (activity.busy) {
        return res.status(409).json({
          error: 'session is running; wait for the current turn to finish or cancel it before switching CLI',
          stream: activity.stream || null,
        });
      }
      const gitSnapshot = await cliSwitchGitSnapshot(session);
      const switched = sessionPersistence.mutate('http.switch-cli', () =>
        performCliSwitch(session, targetCli, { fresh, gitSnapshot }));
      return res.json({
        ok: true,
        changed: true,
        cli: session.cli,
        fromCli: switched.result.fromCli,
        handoffId: switched.handoff.id,
        reusedTarget: switched.result.reused,
        fresh,
        cliStates: options.cliStateSummary(session),
        cliAvailability: availability,
        effectiveModel: options.effectiveSessionModel(session),
        effectiveEffort: options.effectiveSessionEffort(session),
        provider: session.provider || null,
        providerName: options.sessionProviderName(session),
        model: session.model || null,
        effort: session.effort || null,
        agent: session.agent || null,
        subagent: options.serializeSubagent(session.subagent),
      });
    }));
  }

  return Object.freeze({
    mountRoutes,
    cliSwitchDefaults,
    cliSwitchGitSnapshot,
    cliSwitchBusyState,
    performCliSwitch,
    consumePendingCliHandoff,
  });
}

module.exports = { cliHandoffSummary, createCliSwitchRuntime };

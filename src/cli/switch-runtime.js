'use strict';

// Rust owns switching policy, patches and DTOs. This host retains JS object
// identity, persistence transactions, process handles and asynchronous ports.
const crypto = require('node:crypto');
const { getNative } = require('../native/runtime');
const { selectionKey } = require('../providers/auto-provider-config');
const capability = require('./cli-capability');
const { nativeSessionExists } = require('./native-session-exists');
const { nativeVendorOf } = require('../providers/native-vendor');
const { createCliToolsHost, OFFICIAL_INSTALL_SPECS } = require('./tools-host');
const { mountCliSwitchHostRoute, hostFailure } = require('../routes/cli-switch-host');

function call(op, input) {
  return JSON.parse(getNative().cliSwitchRuntimeRequest(op, JSON.stringify(input)));
}
function cliHandoffSummary(session) {
  return call('handoffSummary', { handoff: session?.pendingCliHandoff });
}
function sessionFacts(session) {
  if (!session) return null;
  const { id, type, kind, cli, label, branch, provider, providerSelection, model, effort,
    agent, pendingConfiguration, cliSessionId, _streamSessionId, workspaceState, worktreePath } = session;
  return { id, type, kind, cli, label, branch, provider, providerSelection, model, effort,
    agent, pendingConfiguration, cliSessionId, streamSessionId: _streamSessionId, workspaceState, worktreePath };
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
    'getChatStream', 'hasLiveBackgroundTasks', 'cancelClassify', 'assignKillReason',
    'finishProviderAttempt', 'appendMessage',
    'appendEvent', 'chatBroadcast', 'workspaceBroadcast', 'saveBestEffort',
    'cliAvailabilitySummary', 'sessionProviderName', 'sessionProviderBaseUrl',
    'effectiveSessionModel',
    'effectiveSessionEffort', 'serializeSubagent',
    // The /ws/chat replay buffer is native state behind the replay hub now; the
    // CLI reset clears it there instead of writing a dead `streamReplay` field.
    'clearReplay',
  ]) requireFunction(options, name);

  const chatSessions = options.chatSessions;
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] chatSessions map is required');
  }
  const clock = options.clock || Date.now;
  const handoffIdFactory = options.handoffIdFactory || (() => `handoff_${crypto.randomBytes(8).toString('hex')}`);
  const prepareRoute = options.prepareCliSwitchRoute || require('./switch-preparation').prepareCliSwitchRoute;
  const preparations = new Map();
  const tools = createCliToolsHost(options);

  function viewFacts(session) {
    return { session: sessionFacts(session), providerName: options.sessionProviderName(session),
      providerBaseUrl: options.sessionProviderBaseUrl(session), effectiveModel: options.effectiveSessionModel(session),
      effectiveEffort: options.effectiveSessionEffort(session), subagent: options.serializeSubagent(session.subagent) };
  }
  function configurationBusy(sessionId) {
    try {
      const stream = options.getChatStream()?.status?.(sessionId);
      return call('busy', { chatBusy: getNative().sessionRuntimeIsChatStateBusy(chatSessions.get(sessionId)),
        streamBusy: stream?.busy, streamQueued: stream?.queued,
        phase: options.getPreparation?.(sessionId)?.phase,
        background: !!options.hasLiveBackgroundTasks(sessionId) });
    } catch (_) { return call('busy', { observationFailed: true }); }
  }
  function cliSwitchBusyState(sessionId) {
    const cs = chatSessions.get(sessionId), stream = options.getChatStream().status(sessionId);
    return { busy: call('busy', { chatBusy: getNative().sessionRuntimeIsChatStateBusy(cs), streamBusy: stream?.busy,
      streamQueued: stream?.queued }), cs, stream };
  }
  // 返回继承路由的变化（{from,to,family} 或 null）：切换提示（switchNotice/switchEvent
  // 的 subagentChange）靠它说明「子任务改走主线路 / 改走目标家族默认」。自设路由
  // keep 不变 = null。from/to 上补 name（provider 目录显示名）让前端直接可读。
  // before 由调用方在 activateCliState 之前捕获传入：activate 会用目标车道的
  // lane 快照覆盖 session.subagent，切换前正在生效的路由只在 activate 前可见。
  function followSubagentDefault(target, before) {
    if (before === undefined) {
      before = target.subagent && typeof target.subagent === 'object' ? { ...target.subagent } : null;
    }
    const facts = { cli: target.cli, provider: target.provider, subagent: target.subagent,
      ephemeral: target.ephemeral, loginFlow: target.loginFlow,
      bindings: typeof options.validProviderId === 'function' && typeof options.getProviders === 'function' };
    let candidate = call('subagentCandidate', facts);
    if (candidate.action === 'keep') return null;
    let providers;
    if (candidate.action === 'defaults') {
      const providerDefaults = options.getProviderDefaults() || {};
      providers = options.getProviders();
      candidate = call('subagentCandidate', { ...facts, providerDefaults });
    }
    let next = candidate.value;
    if (candidate.action === 'validate') {
      const checked = options.validProviderId(candidate.family, candidate.providerId);
      let result = call('subagentResult', { candidate, checked });
      if (result.action === 'proxy') result = call('subagentResult', { candidate, checked,
        proxyable: providers.codexProviderProxyable(checked.value) });
      next = result.value;
    }
    target.subagent = next;
    const lane = target.cliStates?.[target.cli];
    if (lane) lane.subagent = next ? { ...next } : null;
    const after = next && typeof next === 'object' ? { ...next } : null;
    const sameRoute = (!before && !after)
      || (!!before && !!after && before.providerId === after.providerId && before.model === after.model);
    if (sameRoute) return null;
    const nameOf = (route) => {
      if (!route || typeof providers?.getProvider !== 'function') return null;
      const family = target.cli === 'codex' || target.cli === 'codex-exp' ? 'codex' : 'claude';
      try {
        const entry = providers.getProvider(family, route.providerId);
        return (entry && (entry.name || entry.label)) || null;
      } catch (_) { return null; }
    };
    return {
      family: target.cli === 'codex' || target.cli === 'codex-exp' ? 'codex' : 'claude',
      from: before ? { providerId: before.providerId, model: before.model, name: nameOf(before) } : null,
      to: after ? { providerId: after.providerId, model: after.model, name: nameOf(after) } : null,
    };
  }
  function cliSwitchDefaults(cli) {
    const plan = call('defaults', { cli, providerDefaults: options.getProviderDefaults() || {} });
    if (plan.needsCodexEffort) plan.fields.effort = options.codexDefaultReasoningLevel();
    return plan.fields;
  }
  async function cliSwitchGitSnapshot(session) {
    try {
      const snapshot = await options.gitWorktreeSnapshot(options.cwdForSession(session), session.branch || null);
      return { branch: snapshot.branch, head: snapshot.head, changes: snapshot.changes };
    } catch (_) { return { branch: session.branch || null, head: null, changes: [] }; }
  }
  function resetChatRuntimeForCli(chat, session) {
    if (!chat) return;
    options.assignKillReason(chat._activeRunner, 'cli_switch');
    if (chat._activeRunner?.providerAttempt) options.finishProviderAttempt(chat._activeRunner.providerAttempt,
      { outcome: 'failed', errorCategory: 'cancelled', reasonCode: 'cli_switch' });
    if (chat.claudeProc) {
      try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
      chat.claudeProc = null;
    }
    options.cancelClassify(chat);
    const plan = call('resetPlan', sessionFacts(session));
    if (plan.refreshCwd && typeof options.cwdForSession === 'function') {
      try { const cwd = options.cwdForSession(session); if (cwd) chat.cwd = cwd; } catch (_) {}
    }
    // `resetPlan.fields` still carries `streamReplay: []`, but the replay buffer
    // is native state behind src/ws/ws-host.js — assigning it would create a
    // dead property that forks the real buffer. Strip it and clear through the hub.
    const fields = plan.fields && typeof plan.fields === 'object' ? { ...plan.fields } : {};
    delete fields.streamReplay;
    Object.assign(chat, fields);
    options.clearReplay(session.id);
  }
  async function prepareSwitch(session, targetCli, switchOptions = {}) {
    const target = JSON.parse(JSON.stringify(session));
    options.activateCliState(target, targetCli, { fresh: switchOptions.fresh === true,
      defaults: cliSwitchDefaults(targetCli) });
    const prepared = await prepareRoute(call('prepareRoute', { targetCli, sessionId: session.id,
      fresh: switchOptions.fresh === true, target: { cliSessionId: target.cliSessionId, provider: target.provider },
      providerSupplied: switchOptions.provider !== undefined, provider: switchOptions.provider }));
    if (!prepared.probeHandled) {
      try { prepared.nativeSessionExists = (options.nativeSessionExists || nativeSessionExists)(targetCli, target.cliStates[targetCli]); }
      catch (_) { prepared.nativeSessionExists = null; }
    }
    return prepared;
  }
  function performCliSwitch(session, targetCli, switchOptions = {}) {
    targetCli = capability.nameOf(String(targetCli == null ? '' : targetCli).trim());
    const fromCli = session.cli || 'claude', now = clock();
    const checkpoint = options.buildHandoffCheckpoint({ session, fromCli, toCli: targetCli,
      history: options.getHistory(session.id),
      git: switchOptions.gitSnapshot || { branch: session.branch || null, head: null, changes: [] }, now });
    const subagentBeforeSwitch = session.subagent && typeof session.subagent === 'object' ? { ...session.subagent } : null;
    const result = options.activateCliState(session, targetCli, { fresh: switchOptions.fresh === true,
      defaults: cliSwitchDefaults(targetCli), nativeSessionExists: () => switchOptions.prepared.nativeSessionExists, now });
    const subagentChange = followSubagentDefault(session, subagentBeforeSwitch);
    if (result.staleNativeSessionId) console.warn(`[multicc/cli-switch] [${session.id}] ${targetCli} native session ${result.staleNativeSessionId} no longer exists; switching without reuse`);
    const handoff = call('handoff', { id: handoffIdFactory(), fromCli, targetCli, checkpoint, reused: result.reused });
    session.pendingCliHandoff = handoff;
    options.rememberActiveCliState(session, now);
    const publish = () => {
      options.getChatStream().close(session.id);
      resetChatRuntimeForCli(chatSessions.get(session.id), session);
      const notice = call('switchNotice', { session: sessionFacts(session), fromCli, targetCli,
        handoffId: handoff.id, reused: result.reused, fresh: switchOptions.fresh === true,
        forced: switchOptions.forced === true, now, subagentChange });
      if (notice.forced) options.chatBroadcast(session.id, notice.forced);
      const failed = error => (options.logger || console).warn?.('chat_cli_switch_notice_persist_failed',
        { sessionId: session.id, fromCli, toCli: targetCli, message: error?.message || String(error) });
      try {
        const pending = options.appendMessage(session.id, notice.message);
        if (pending && typeof pending.then === 'function') pending.then(saved => {
          if (saved === false) (options.logger || console).warn?.('chat_cli_switch_notice_not_persisted', { sessionId: session.id, fromCli, toCli: targetCli });
        }, failed);
      } catch (error) { failed(error); }
      options.appendEvent(session.dirId, 'session_cli_changed', notice.eventText, session.id);
      options.chatBroadcast(session.id, call('switchEvent', { ...viewFacts(session), fromCli, targetCli,
        handoffId: handoff.id, reused: result.reused, fresh: switchOptions.fresh === true, subagentChange }));
      if (session.dirId) options.workspaceBroadcast(session.dirId, notice.workspace);
    };
    if (!switchOptions.deferEffects) publish();
    return { result, handoff, publish };
  }
  function consumePendingCliHandoff(sessionName) {
    const session = records.get(sessionName);
    const plan = call('consume', { handoff: session?.pendingCliHandoff });
    if (!plan) return false;
    plan.last.consumedAt = new Date(clock()).toISOString();
    session.lastCliHandoff = plan.last;
    delete session.pendingCliHandoff;
    options.rememberActiveCliState(session);
    options.saveBestEffort('runtime.consume-cli-handoff');
    options.chatBroadcast(sessionName, plan.event);
    return true;
  }
  function responseBody(mode, session, extra = {}) {
    return call('response', { mode, ...(mode === 'noop' ? { session: sessionFacts(session) } : viewFacts(session)), cliStates: options.cliStateSummary(session),
      cliAvailability: Object.prototype.hasOwnProperty.call(extra, 'cliAvailability') ? extra.cliAvailability : options.cliAvailabilitySummary(), ...extra });
  }
  function queueCliSwitch(session, targetCli, fresh) {
    const draft = JSON.parse(JSON.stringify(session));
    const plan = call('stagePlan', { cli: session.cli, pending: session.pendingConfiguration, targetCli, fresh });
    if (plan.action === 'desired') {
      draft.cli = session.pendingConfiguration.cli;
      Object.assign(draft, session.pendingConfiguration.profile);
    } else if (plan.action === 'activate') {
      options.activateCliState(draft, targetCli, { fresh, defaults: cliSwitchDefaults(targetCli) });
      followSubagentDefault(draft);
    }
    sessionPersistence.mutate('http.stage-cli-switch', () => {
      session.pendingConfiguration = call('stageConfiguration', { draft: { ...sessionFacts(draft),
        subagent: draft.subagent, rolePrompt: draft.rolePrompt }, fresh, nowIso: new Date().toISOString() });
    });
    const event = { type: 'session_configuration_pending', sessionId: session.id, pendingConfiguration: session.pendingConfiguration };
    options.chatBroadcast(session.id, event);
    options.workspaceBroadcast(session.dirId, event);
    return responseBody('staged', session);
  }
  function reservationFacts(sessionId) {
    try {
      const pending = options.pendingAutoCliSwitch?.(sessionId, records.get(sessionId)?.cli || 'claude');
      return { reservation: !!pending };
    } catch (error) {
      console.warn('[cli-switch] auto provider lane reservation unavailable; turn deferred:', error?.message);
      return { reservationFailed: true };
    }
  }
  function canContinueOnCurrentCli(sessionId) { return call('currentAllowed', reservationFacts(sessionId)); }
  function preparedAllowed(sessionId, session, signature) {
    const changed = records.get(sessionId) !== session || JSON.stringify(session) !== signature;
    return call('preparedGate', { changed, busy: changed ? false : configurationBusy(sessionId) });
  }
  function withConfigurationPreparation(sessionId, prepare) {
    if (preparations.has(sessionId)) return null;
    const operation = Promise.resolve().then(prepare);
    preparations.set(sessionId, operation);
    const clear = () => { if (preparations.get(sessionId) === operation) preparations.delete(sessionId); };
    operation.then(clear, clear);
    return operation;
  }
  function applyTurnConfiguration(sessionId, turnOptions = {}, text = '') {
    return withConfigurationPreparation(sessionId, async () => {
      if (await applyPendingConfiguration(sessionId, turnOptions) === false) return false;
      try { if (await autoSwitchCli(sessionId, turnOptions, text) === false) return false; }
      catch (error) {
        console.warn('[cli-switch] auto provider lane switch failed:', error?.message);
        if (!canContinueOnCurrentCli(sessionId)) return false;
      }
      try { await options.getChatStream()?.settle?.(sessionId); }
      catch (error) {
        console.warn('[cli-switch] previous CLI process has not exited yet; turn deferred:', error?.code || error?.message);
        return false;
      }
      return canContinueOnCurrentCli(sessionId);
    }) || Promise.resolve(false);
  }
  async function autoSwitchCli(sessionId, turnOptions, text) {
    const session = records.get(sessionId), pool = session?.providerSelection;
    const facts = { pool, pending: !!session?.pendingConfiguration, planner: typeof options.planAutoCliSwitch === 'function' };
    let gate = call('autoGate', facts);
    while (gate.action === 'observeBusy' || gate.action === 'observeReservation') {
      if (gate.action === 'observeBusy') facts.busy = configurationBusy(sessionId);
      else Object.assign(facts, reservationFacts(sessionId));
      gate = call('autoGate', facts);
    }
    if (gate.action === 'clear') options.clearAutoProviderSession?.(sessionId);
    if (gate.action === 'allow') return true;
    if (gate.action !== 'plan') return canContinueOnCurrentCli(sessionId);
    const availability = options.cliAvailabilitySummary() || {};
    const pendingPlan = options.planAutoCliSwitch({ session, text, turnOptions });
    const signatureBeforePlan = JSON.stringify(session);
    const plan = pendingPlan && typeof pendingPlan.then === 'function' ? await pendingPlan : pendingPlan;
    if (records.get(sessionId) !== session || JSON.stringify(session) !== signatureBeforePlan) return false;
    const fromCli = session.cli || 'claude';
    if (!call('autoPlanGate', { plan, cli: fromCli, available: !!availability[plan?.cli]?.available }).prepare) return canContinueOnCurrentCli(sessionId);
    const signature = JSON.stringify(session);
    const prepared = await prepareSwitch(session, plan.cli, { provider: plan.providerId });
    if (!preparedAllowed(sessionId, session, signature)) return canContinueOnCurrentCli(sessionId);
    const commit = call('autoCommit', { plan, fromCli, nativeVendor: nativeVendorOf(plan.providerId) !== null });
    let switched;
    sessionPersistence.mutate('runtime.auto-provider-cli-switch', () => {
      switched = performCliSwitch(session, plan.cli, { deferEffects: true, prepared });
      if (commit.restorePool) session.providerSelection = pool;
      Object.assign(session, commit.fields);
      session.pendingCliHandoff.reason = commit.reason;
      options.rememberActiveCliState(session);
    });
    switched.publish();
    options.chatBroadcast(sessionId, commit.event);
    return canContinueOnCurrentCli(sessionId);
  }
  async function applyPendingConfiguration(sessionId, turnOptions = {}) {
    const session = records.get(sessionId), pending = session?.pendingConfiguration;
    const facts = { pending: !!pending, options: turnOptions };
    let gate = call('pendingGate', facts);
    if (gate.action === 'observe') {
      Object.assign(facts, { observed: true, busy: configurationBusy(sessionId), chatBusy: getNative().sessionRuntimeIsChatStateBusy(chatSessions.get(sessionId)) });
      gate = call('pendingGate', facts);
    }
    if (gate.action === 'observeAvailability') gate = call('pendingGate', { ...facts,
      available: !!options.cliAvailabilitySummary()[pending?.cli]?.available });
    if (gate.action !== 'prepare') return gate.action === 'allow';
    const signature = JSON.stringify(session);
    const prepared = await prepareSwitch(session, pending.cli, { fresh: pending.fresh, provider: pending.profile.provider });
    if (!preparedAllowed(sessionId, session, signature)) return false;
    const plan = call('pendingCommit', { pending, cli: session.cli || 'claude', nativeSessionExists: prepared.nativeSessionExists,
      sessionId });
    let switched;
    sessionPersistence.mutate('runtime.apply-pending-configuration', () => {
      const before = selectionKey(session.providerSelection);
      if (plan.switch) switched = performCliSwitch(session, pending.cli, { fresh: pending.fresh, deferEffects: true, prepared });
      Object.assign(session, pending.profile);
      if (call('configurationChanged', { before, after: selectionKey(session.providerSelection) })) delete session.autoProviderLastRoute;
      delete session.pendingConfiguration;
      options.rememberActiveCliState(session);
    });
    options.clearAutoProviderSession?.(sessionId);
    if (switched) switched.publish();
    else if (plan.closeStream) options.getChatStream().close(session.id);
    options.chatBroadcast(sessionId, plan.event);
    options.workspaceBroadcast(session.dirId, plan.event);
    options.appendEvent(session.dirId, 'session_configuration_applied', '已应用下一轮 AI 配置', sessionId);
    return true;
  }
  // ── the host port behind `POST /api/sessions/:id/switch-cli` ─────────────
  //
  // The front door answers `manualGate`'s four refusals itself. These three ops
  // are the only facts/side effects it may ask Node for.

  function hostFacts(sessionId) {
    const session = records.get(sessionId);
    return {
      ok: true,
      exists: !!session,
      // `publicSessionAccessGuard`'s predicate, reproduced for the front door so
      // the 404 happens before the body is parsed and before OPTIONS.
      internalSlot: !!(session && session.taskExecutionSlot === true),
      session: sessionFacts(session),
      supported: supportedClis,
    };
  }

  function hostNoop(sessionId) {
    const session = records.get(sessionId);
    if (!session) return hostFailure(new Error('session not found'));
    sessionPersistence.mutate('http.switch-cli-noop', () => options.ensureCliStates(session));
    options.clearAutoProviderSession?.(session.id);
    return { ok: true, body: responseBody('noop', session, { pendingCliHandoff: cliHandoffSummary(session) }) };
  }

  async function hostSwitch(sessionId, targetCli, fresh) {
    try {
      const session = records.get(sessionId);
      if (!session) return hostFailure(new Error('session not found'));
      // Retired route body, verbatim: availability → ready()/observeBusy →
      // queue → Git snapshot → ready() again → signature → prepare → commit.
      const availability = options.cliAvailabilitySummary();
      const ready = () => {
        const facts = { targetCli, available: !!availability[targetCli]?.available,
          pending: !!session.pendingConfiguration, preparing: preparations.has(session.id) };
        const stage = call('manualReady', facts);
        return stage.action === 'observeBusy' ? call('manualReady', { ...facts, busy: configurationBusy(session.id) }) : stage;
      };
      let stage = ready();
      if (stage.action === 'respond') return { ok: true, status: stage.status, body: stage.body };
      if (stage.action === 'queue') return { ok: true, status: 200, body: queueCliSwitch(session, targetCli, fresh) };
      const gitSnapshot = await cliSwitchGitSnapshot(session);
      stage = ready();
      if (stage.action === 'queue') return { ok: true, status: 200, body: queueCliSwitch(session, targetCli, fresh) };
      const signature = JSON.stringify(session);
      const preparation = prepareSwitch(session, targetCli, { fresh });
      preparations.set(session.id, preparation);
      let prepared;
      try { prepared = await preparation; }
      finally { if (preparations.get(session.id) === preparation) preparations.delete(session.id); }
      if (!preparedAllowed(session.id, session, signature)) {
        const conflict = call('manualConflict', {});
        return { ok: true, status: conflict.status, body: conflict.body };
      }
      const switched = sessionPersistence.mutate('http.switch-cli', () => performCliSwitch(session, targetCli, { fresh, gitSnapshot, prepared, deferEffects: true }));
      switched.publish();
      options.clearAutoProviderSession?.(session.id);
      return { ok: true, status: 200, body: responseBody('switched', session, { fromCli: switched.result.fromCli,
        handoffId: switched.handoff.id, reusedTarget: switched.result.reused, fresh, cliAvailability: availability }) };
    } catch (error) {
      return hostFailure(error);
    }
  }

  function mountRoutes(app, asyncHandler) {
    // The host port needs `app.post`; `tools.mountRoutes` still needs both verbs
    // and the async wrapper below.
    if (!app || typeof app.post !== 'function') throw new TypeError('[cli-switch-runtime] app.post is required');
    if (typeof app.get !== 'function') throw new TypeError('[cli-switch-runtime] app.get is required');
    if (typeof asyncHandler !== 'function') throw new TypeError('[cli-switch-runtime] asyncHandler is required');
    mountCliSwitchHostRoute(app, {
      facts: hostFacts,
      noop: hostNoop,
      switch: hostSwitch,
      isLocal: options.isLocalRequest,
    });
    tools.mountRoutes(app, asyncHandler);
  }
  return Object.freeze({ mountRoutes, startUpdateWatch: tools.startUpdateWatch, cliSwitchDefaults, cliSwitchGitSnapshot,
    cliSwitchBusyState, performCliSwitch, consumePendingCliHandoff, withConfigurationPreparation,
    applyPendingConfiguration: applyTurnConfiguration });
}
module.exports = { cliHandoffSummary, createCliSwitchRuntime, OFFICIAL_INSTALL_SPECS };

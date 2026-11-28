'use strict';

// FROZEN from src/cli/switch-runtime.js before the `switch-cli` route moved to
// the Rust front door. The differential (docs/rust-migration/differential/
// cli-switch.js) mounts this module as the Node oracle; never edit it to match
// the new implementation — that would make the comparison compare new code with
// itself. Requires are retargeted at the current tree so it keeps loading.
const crypto = require('node:crypto');
const { getNative } = require('../../src/native/runtime');
const { isChatStateBusy } = require('./session-runtime-busy-oracle');
const { selectionKey } = require('./frozen-b10-network/auto-provider-config');
const capability = require('../../src/cli/cli-capability');
const { nativeSessionExists } = require('../../src/cli/native-session-exists');
const { nativeVendorOf } = require('./frozen-catalog-inputs/native-vendor');
const { createCliToolsHost, OFFICIAL_INSTALL_SPECS } = require('../../src/cli/tools-host');

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
  ]) requireFunction(options, name);

  const chatSessions = options.chatSessions;
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[cli-switch-runtime] chatSessions map is required');
  }
  const clock = options.clock || Date.now;
  const handoffIdFactory = options.handoffIdFactory || (() => `handoff_${crypto.randomBytes(8).toString('hex')}`);
  const prepareRoute = options.prepareCliSwitchRoute || require('./frozen-file-batch7/switch-preparation').prepareCliSwitchRoute;
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
      return call('busy', { chatBusy: isChatStateBusy(chatSessions.get(sessionId)),
        streamBusy: stream?.busy, streamQueued: stream?.queued,
        phase: options.getPreparation?.(sessionId)?.phase,
        background: !!options.hasLiveBackgroundTasks(sessionId) });
    } catch (_) { return call('busy', { observationFailed: true }); }
  }
  function cliSwitchBusyState(sessionId) {
    const cs = chatSessions.get(sessionId), stream = options.getChatStream().status(sessionId);
    return { busy: call('busy', { chatBusy: isChatStateBusy(cs), streamBusy: stream?.busy,
      streamQueued: stream?.queued }), cs, stream };
  }
  function followSubagentDefault(target) {
    const facts = { cli: target.cli, provider: target.provider, subagent: target.subagent,
      ephemeral: target.ephemeral, loginFlow: target.loginFlow,
      bindings: typeof options.validProviderId === 'function' && typeof options.getProviders === 'function' };
    let candidate = call('subagentCandidate', facts);
    if (candidate.action === 'keep') return;
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
    Object.assign(chat, plan.fields);
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
    const result = options.activateCliState(session, targetCli, { fresh: switchOptions.fresh === true,
      defaults: cliSwitchDefaults(targetCli), nativeSessionExists: () => switchOptions.prepared.nativeSessionExists, now });
    followSubagentDefault(session);
    if (result.staleNativeSessionId) console.warn(`[multicc/cli-switch] [${session.id}] ${targetCli} native session ${result.staleNativeSessionId} no longer exists; switching without reuse`);
    const handoff = call('handoff', { id: handoffIdFactory(), fromCli, targetCli, checkpoint, reused: result.reused });
    session.pendingCliHandoff = handoff;
    options.rememberActiveCliState(session, now);
    const publish = () => {
      options.getChatStream().close(session.id);
      resetChatRuntimeForCli(chatSessions.get(session.id), session);
      const notice = call('switchNotice', { session: sessionFacts(session), fromCli, targetCli,
        handoffId: handoff.id, reused: result.reused, fresh: switchOptions.fresh === true, forced: switchOptions.forced === true, now });
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
        handoffId: handoff.id, reused: result.reused, fresh: switchOptions.fresh === true }));
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
  function applyTurnConfiguration(sessionId, turnOptions = {}, text = '') {
    if (preparations.has(sessionId)) return Promise.resolve(false);
    const operation = (async () => {
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
    })();
    preparations.set(sessionId, operation);
    const clear = () => { if (preparations.get(sessionId) === operation) preparations.delete(sessionId); };
    operation.then(clear, clear);
    return operation;
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
      Object.assign(facts, { observed: true, busy: configurationBusy(sessionId), chatBusy: isChatStateBusy(chatSessions.get(sessionId)) });
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
  function mountRoutes(app, asyncHandler) {
    if (!app || typeof app.post !== 'function') throw new TypeError('[cli-switch-runtime] app.post is required');
    if (typeof app.get !== 'function') throw new TypeError('[cli-switch-runtime] app.get is required');
    if (typeof asyncHandler !== 'function') throw new TypeError('[cli-switch-runtime] asyncHandler is required');
    app.post('/api/sessions/:id/switch-cli', asyncHandler(async (req, res) => {
      const session = records.get(req.params.id);
      const gate = call('manualGate', { exists: !!session, session: sessionFacts(session), body: req.body, supported: supportedClis });
      if (gate.action === 'respond') return res.status(gate.status).json(gate.body);
      const { targetCli, fresh } = gate;
      if (gate.action === 'noop') {
        sessionPersistence.mutate('http.switch-cli-noop', () => options.ensureCliStates(session));
        options.clearAutoProviderSession?.(session.id);
        return res.json(responseBody('noop', session, { pendingCliHandoff: cliHandoffSummary(session) }));
      }
      const availability = options.cliAvailabilitySummary();
      const ready = () => {
        const facts = { targetCli, available: !!availability[targetCli]?.available,
          pending: !!session.pendingConfiguration, preparing: preparations.has(session.id) };
        const stage = call('manualReady', facts);
        return stage.action === 'observeBusy' ? call('manualReady', { ...facts, busy: configurationBusy(session.id) }) : stage;
      };
      let stage = ready();
      if (stage.action === 'respond') return res.status(stage.status).json(stage.body);
      if (stage.action === 'queue') return res.json(queueCliSwitch(session, targetCli, fresh));
      const gitSnapshot = await cliSwitchGitSnapshot(session);
      stage = ready();
      if (stage.action === 'queue') return res.json(queueCliSwitch(session, targetCli, fresh));
      const signature = JSON.stringify(session);
      const preparation = prepareSwitch(session, targetCli, { fresh });
      preparations.set(session.id, preparation);
      let prepared;
      try { prepared = await preparation; }
      finally { if (preparations.get(session.id) === preparation) preparations.delete(session.id); }
      if (!preparedAllowed(session.id, session, signature)) {
        const conflict = call('manualConflict', {});
        return res.status(conflict.status).json(conflict.body);
      }
      const switched = sessionPersistence.mutate('http.switch-cli', () => performCliSwitch(session, targetCli, { fresh, gitSnapshot, prepared, deferEffects: true }));
      switched.publish();
      options.clearAutoProviderSession?.(session.id);
      return res.json(responseBody('switched', session, { fromCli: switched.result.fromCli,
        handoffId: switched.handoff.id, reusedTarget: switched.result.reused, fresh, cliAvailability: availability }));
    }));
    tools.mountRoutes(app, asyncHandler);
  }
  return Object.freeze({ mountRoutes, startUpdateWatch: tools.startUpdateWatch, cliSwitchDefaults, cliSwitchGitSnapshot,
    cliSwitchBusyState, performCliSwitch, consumePendingCliHandoff, applyPendingConfiguration: applyTurnConfiguration });
}
// The oracle mount point: the retired route exactly as it was registered by
// server.js (`cliSwitchRuntime.mountRoutes(app, asyncHandler)`).
function createLegacyCliSwitchRoutes({ app, asyncHandler = handler => handler, options }) {
  const runtime = createCliSwitchRuntime(options);
  runtime.mountRoutes(app, asyncHandler);
  return runtime;
}

// ── differential world ──────────────────────────────────────────────────────
//
// Deterministic `createCliSwitchRuntime` options for
// docs/rust-migration/differential/cli-switch.js. The Node oracle (this file)
// and the Rust side's host stub (the real src/cli/switch-runtime.js) both build
// the world from the same scenario JSON, so every corpus case sees one set of
// facts. Nothing here touches the network, the filesystem or the clock.
const DEFAULT_AVAILABILITY = Object.freeze(
  Object.fromEntries(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'qoder']
    .map(id => [id, { available: true }])),
);

function createCliSwitchWorld() {
  const {
    SUPPORTED_CHAT_CLIS, ensureCliStates, rememberActiveCliState,
    activateCliState, stateSummary, buildHandoffCheckpoint,
  } = require('../../src/cli-switch');
  const state = {
    scenario: {},
    records: new Map(),
    chatSessions: new Map(),
    effects: [],
    stream: null,
  };
  state.stream = {
    status: () => state.scenario.streamState || null,
    close: id => state.effects.push(`stream-close:${id}`),
    settle: async () => {},
  };
  const deps = {
    records: state.records,
    chatSessions: state.chatSessions,
    sessionPersistence: {
      mutate(source, fn) {
        state.effects.push(`mutate:${source}`);
        if (state.scenario.persistThrows && state.scenario.persistThrows === source) {
          // `coded` mirrors `PersistenceError` (src/session/persistence.js):
          // status 500 and a public code that safeErrorHandler echoes.
          if (state.scenario.persistThrowShape === 'coded') {
            const error = new Error('session state could not be persisted');
            error.code = 'SESSION_PERSISTENCE_FAILED';
            error.status = 500;
            throw error;
          }
          throw new Error('disk-full');
        }
        return fn(state.records);
      },
    },
    supportedClis: SUPPORTED_CHAT_CLIS,
    getProviderDefaults: () => ({ codex: 'codex-default', claude: 'claude-default' }),
    codexDefaultReasoningLevel: () => 'xhigh',
    getHistory: id => [{ role: 'user', content: `history:${id}`, ts: 90 }],
    buildHandoffCheckpoint,
    activateCliState,
    rememberActiveCliState,
    ensureCliStates,
    cliStateSummary: stateSummary,
    gitWorktreeSnapshot: async () => ({
      branch: `multicc/${state.scenario.session ? state.scenario.session.id : 'none'}`,
      head: 'abc123',
      changes: ['M file.js'],
    }),
    cwdForSession: session => `/tmp/wt-${session.id}`,
    getChatStream: () => state.stream,
    hasLiveBackgroundTasks: () => state.scenario.backgroundActive === true,
    cancelClassify: () => state.effects.push('cancel-classify'),
    assignKillReason: (_runner, reason) => state.effects.push(`kill-reason:${reason}`),
    finishProviderAttempt: (attempt, facts) => state.effects.push(
      `attempt-finish:${attempt.routeAttemptId}:${facts.reasonCode}`),
    appendMessage: (_id, message) => state.effects.push(`message:${message.cliSwitch.handoffId}`),
    appendEvent: (_dirId, type) => state.effects.push(`event:${type}`),
    chatBroadcast: (_id, event) => state.effects.push(`chat:${event.type}`),
    workspaceBroadcast: (_dirId, event) => state.effects.push(`workspace:${event.type}`),
    saveBestEffort: source => state.effects.push(`save:${source}`),
    cliAvailabilitySummary: () => state.scenario.availability || DEFAULT_AVAILABILITY,
    refreshCliEnvironment: async () => {},
    sessionProviderName: value => (value.provider ? `name:${value.provider}` : null),
    sessionProviderBaseUrl: value => (value.provider ? `https://${value.provider}.example.com` : null),
    effectiveSessionModel: value => value.model || 'effective-default',
    effectiveSessionEffort: value => value.effort || 'effective-default',
    serializeSubagent: value => value,
    clock: () => 1000,
    handoffIdFactory: () => 'handoff_fixed',
    nativeSessionExists: () => null,
    clearAutoProviderSession: id => state.effects.push(`clear-auto:${id}`),
    isLocalRequest: () => true,
    prepareCliSwitchRoute: async input => {
      state.effects.push(`prepare:${input.nativeSessionId || ''}`);
      if (state.scenario.conflict && state.scenario.session) {
        const current = state.records.get(state.scenario.session.id);
        if (current) current.model = 'changed-during-prepare';
      }
      return { probeHandled: true, nativeSessionExists: null, synchronized: false };
    },
  };
  function apply(scenario) {
    const next = JSON.parse(JSON.stringify(scenario || {}));
    state.scenario = next;
    state.effects.length = 0;
    state.records.clear();
    state.chatSessions.clear();
    if (next.session) {
      const session = JSON.parse(JSON.stringify(next.session));
      ensureCliStates(session, 100);
      state.records.set(session.id, session);
      if (next.chat) state.chatSessions.set(session.id, JSON.parse(JSON.stringify(next.chat)));
    }
  }
  return { deps, state, apply, effects: state.effects, records: state.records };
}

module.exports = {
  cliHandoffSummary,
  createCliSwitchRuntime,
  createLegacyCliSwitchRoutes,
  createCliSwitchWorld,
  OFFICIAL_INSTALL_SPECS,
};

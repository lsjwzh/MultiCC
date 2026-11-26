'use strict';

// The scripted host facts behind the retired orchestration / unattended /
// Aux / goal handlers. The oracle (frozen modules, mounted on Express) and the
// front door's Node child (live modules, behind the host port) both build this
// world from the same factory, so every value in a response comes from the
// handler that produced it, not from the real machine.
//
// Nothing here touches the runtime: the Aux model call, the durable
// orchestration runtime, the FIFO scheduler, the unattended supervisor and the
// turn engine are in-memory fakes that record each call. The only filesystem
// work is the two small config files inside the side's own temporary
// directory. A `control.json` in the shared work directory lets the runner flip
// a fact (supervisor absent, quota cache down, ...) for both sides alike.
const fs = require('node:fs');
const path = require('node:path');

// Both sides freeze the clock: the Aux queue stamps tasks and durations.
const FROZEN_NOW = 1794687600000;

const quiet = { log() {}, warn() {}, error() {}, info() {} };

// Planted secrets: they appear only inside failure messages the handlers must
// sanitize and in the aux provider targets' hidden fields. A response that
// contains one has leaked.
const CANARIES = [
  'sk-AUXSECRET1234567890abcdef',
  'CANARY-PROVIDER-TOKEN-7f3a',
  '/Users/secret/path',
];

function createWorld({ dir, controlFile, callsFile = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const control = () => {
    try { return JSON.parse(fs.readFileSync(controlFile, 'utf8')); } catch (_) { return {}; }
  };
  const record = (name, args) => {
    // The one documented difference (the host-unreachable 503) runs a handler on
    // the oracle only; its effects are not part of the comparison.
    if (control().suppressCalls === true) return;
    const entry = { name, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) };
    calls.push(entry);
    if (callsFile) fs.appendFileSync(callsFile, `${JSON.stringify(entry)}\n`);
  };

  const records = new Map([
    ['s1', { id: 's1', cwd: '/repo', label: 'Main' }],
    ['s2', { id: 's2', cwd: '/repo2', label: 'Second' }],
    ['worker1', { id: 'worker1', cwd: '/repo', label: '任务 · 修复登录', taskBoundTaskId: 'task-9' }],
    ['aux1', { id: 'aux1', type: 'aux' }],
    ['gw1', { id: 'gw1', type: 'gateway' }],
    ['internal1', { id: 'internal1', cwd: '/slot', taskExecutionSlot: true }],
  ]);

  const state = { auxHistory: [], unattended: new Map(), counter: 0 };
  state.unattended.set('s1', { status: 'running', goal: 'ship it', maxDurationMinutes: 120, startedAt: FROZEN_NOW - 60000 });

  // ── Aux queue / goal ────────────────────────────────────────────────────
  const goalVerdict = {
    verdict: 'ok', score: 90, issues: [], questions: ['范围？'], criteria: ['测试通过'], revised: '把登录修好并补测试',
  };
  const auxProviders = {
    claude: [
      { id: 'official', name: 'Official', appType: 'claude', modelOptions: ['m1', 'm2'], wireApi: 'messages' },
      { id: 'broken', name: 'Broken', appType: 'claude', modelOptions: [] },
      { id: 'nomodel', name: 'No model', appType: 'claude', modelOptions: [] },
    ],
    codex: [
      { id: 'codex-official', name: 'Codex Official', appType: 'codex', isOfficial: true, activeAccountId: 'global', modelOptions: [] },
      { id: 'codex-thirdparty', name: 'Codex Third', appType: 'codex', modelOptions: ['g1'], wireApi: 'responses' },
    ],
  };
  const providers = {
    listProviders(appType) { return auxProviders[appType] || []; },
    resolveAuxHttpTarget(protocol, id) {
      record('resolveAuxHttpTarget', { protocol, id });
      if (id === 'official') return { available: true, wireApi: 'messages', model: 'm1', modelOptions: ['m1', 'm2'], apiKey: CANARIES[0] };
      if (id === 'broken') return { available: false, reason: `缺少凭据 ${CANARIES[1]} 于 ${CANARIES[2]}` };
      if (id === 'nomodel') return { available: true, wireApi: 'messages', modelOptions: [] };
      if (id === 'codex-official') return { available: true, wireApi: 'responses', model: 'gpt-x', modelOptions: [] };
      if (id === 'codex-thirdparty') return { available: true, wireApi: 'responses', modelOptions: ['g1'] };
      return { available: false, reason: 'unknown provider' };
    },
  };
  const auxDeps = {
    fs,
    crypto: require('node:crypto'),
    rootDir: '/repo',
    auxConfigFile: path.join(dir, 'aux-config.json'),
    goalConfigFile: path.join(dir, 'goal-config.json'),
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    persistedSessions: records,
    savePersistedSessionsBestEffort() {},
    isShuttingDown: () => control().shuttingDown === true,
    recordApiError(error) {
      record('recordApiError', { source: error.source, provider: error.provider });
      return {
        action: 'fail_fast',
        retryAt: null,
        error: { category: 'auth', provider: error.provider, code: error.code || null, httpStatus: error.httpStatus || null, retryable: false, retryAfterMs: null },
      };
    },
    recordApiSuccess(provider) { record('recordApiSuccess', { provider }); },
    appendChatMessage(id, message) {
      // A precheck without a caller-chosen id gets a random UUID on each side.
      const taskId = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(message.taskId || '') ? '<uuid>' : (message.taskId || null);
      record('appendChatMessage', { id, role: message.role, taskId });
      state.auxHistory.push({ role: message.role, ts: message.ts, taskId });
      return Promise.resolve();
    },
    loadChatHistory: () => [...state.auxHistory],
    viewChatHistory: () => [...state.auxHistory],
    providers,
    getPort: () => 8081,
    getClaudeOfficialViaProxy: () => false,
    executeAuxHttp({ prompt, model, target }) {
      record('executeAuxHttp', { model, wireApi: target && target.wireApi || null, promptHead: String(prompt).slice(0, 12) });
      if (String(prompt).includes('HANGFOREVER')) return new Promise(() => {});
      if (String(prompt).includes('FAILPLEASE')) {
        const error = new Error(`upstream said ${CANARIES[0]} and ${CANARIES[2]}/x`);
        error.status = 401;
        return Promise.reject(error);
      }
      if (String(prompt).includes('用户任务')) return Promise.resolve(JSON.stringify(goalVerdict));
      return Promise.resolve(`echo:${String(prompt).slice(0, 20)}`);
    },
    broadcast(clients, payload) { record('broadcast', { type: payload.type, status: payload.status || null }); },
    onHealthChange() { record('onHealthChange', null); },
    providerLimitCache: {
      async snapshot() {
        if (control().limitCacheDown === true) throw new Error('quota cache offline');
        return { entries: { 'claude:official': {
          kind: 'subscription', status: 'ok', summary: { used: 12 }, summaryText: '12%',
          fetchedAt: FROZEN_NOW - 1000, updatedAt: FROZEN_NOW - 500, lastError: null, lastErrorAt: null,
        }, 'claude:nomodel': {
          kind: 'balance', status: 'error', summary: null, summaryText: '',
          fetchedAt: FROZEN_NOW - 10 * 24 * 3600 * 1000, updatedAt: FROZEN_NOW - 9 * 24 * 3600 * 1000, lastError: 'limit fetch failed', lastErrorAt: FROZEN_NOW - 5,
        } } };
      },
    },
    getCliAvailability: () => (control().cliAvailabilityNull === true ? null
      : { claude: { available: true }, codex: { available: false } }),
    codexModelsRuntime: {
      peekProvider: id => (id === 'codex-official' ? { models: [{ model: 'gpt-x' }, { model: 'gpt-y' }, null] } : null),
    },
    now: () => FROZEN_NOW,
    env: { AUX_TIMEOUT_MS: '10000', GOAL_PRECHECK_TIMEOUT_MS: '1000', AUX_CONCURRENCY: '2' },
    logger: quiet,
  };

  // ── Aux run log ─────────────────────────────────────────────────────────
  const runs = [
    { runId: 'r1', anchorMessageId: 'm1', taskId: 't1', kind: 'classify' },
    { runId: 'r2', anchorMessageId: 'm2', taskId: 't1', kind: 'summarize' },
    { runId: 'r3', anchorMessageId: 'm2', taskId: 't2', kind: 'classify' },
  ];
  const auxRunLog = {
    list: (_sid, options) => { record('auxRunLog.list', { limit: options && options.limit }); return runs; },
    byAnchor: (_sid, id) => { record('auxRunLog.byAnchor', { id }); return runs.filter(run => run.anchorMessageId === id); },
    byTask: (_sid, id) => { record('auxRunLog.byTask', { id }); return runs.filter(run => run.taskId === id); },
    get: (_sid, id) => runs.find(run => run.runId === id) || null,
  };

  // ── unattended supervisor ───────────────────────────────────────────────
  const unattendedHost = {
    get(id) { record('unattended.get', { id }); return state.unattended.get(id) || null; },
    async start(id, body) {
      record('unattended.start', { id, body });
      if (body.goal === 'FAIL') return { ok: false, status: 409, code: 'already_running' };
      if (body.goal === 'NOCODE') return { ok: false };
      const value = { status: 'running', goal: body.goal || '', maxDurationMinutes: body.maxDurationMinutes || 120, startedAt: FROZEN_NOW };
      state.unattended.set(id, value);
      return { ok: true, unattended: value };
    },
    update(id, body) {
      record('unattended.update', { id, body });
      if (!state.unattended.has(id)) return { ok: false, status: 404, code: 'not_running' };
      const value = { ...state.unattended.get(id), maxDurationMinutes: body.maxDurationMinutes || 120 };
      state.unattended.set(id, value);
      return { ok: true, unattended: value };
    },
    stop(id) {
      record('unattended.stop', { id });
      const value = state.unattended.get(id);
      if (!value) return { ok: false, status: 409, code: 'not_running' };
      state.unattended.set(id, { ...value, status: 'stopped' });
      return { ok: true, unattended: { ...value, status: 'stopped' } };
    },
    async resume(id, body) {
      record('unattended.resume', { id, body });
      return { ok: true };
    },
    clear(id) {
      record('unattended.clear', { id });
      state.unattended.delete(id);
      return { ok: true, unattended: null };
    },
  };
  const unattendedDeps = {
    records,
    getUnattended: () => (control().unattendedDown === true ? null : unattendedHost),
  };

  // ── orchestration runtime ───────────────────────────────────────────────
  const operations = [
    { id: 'op-run', kind: 'dispatch', status: 'running', ownerSessionId: 's1', requestOutboxId: 'e-run', createdAt: 3000, startedAt: 3001, updatedAt: 3002, spec: { targetId: 'worker1', chatId: 'worker1', taskId: 'task-9', resultMode: 'async' } },
    { id: 'op-q1', kind: 'dispatch', status: 'pending', ownerSessionId: 's1', requestOutboxId: 'e-q1', createdAt: 2000, spec: { targetId: 'worker1', chatId: 'worker1', oneWay: true } },
    { id: 'op-self', kind: 'dispatch', status: 'pending', ownerSessionId: 's1', createdAt: 2500, spec: { targetId: 's1', chatId: 's1' } },
    { id: 'op-t1', kind: 'dispatch', status: 'completed', ownerSessionId: 's2', createdAt: 800, completedAt: 900, updatedAt: 901, spec: { targetId: 's1' } },
    { id: 'op-t2', kind: 'dispatch', status: 'failed', ownerSessionId: 's1', createdAt: 850, completedAt: 950, spec: { targetId: 's2', chatId: 's2' } },
    { id: 'op-t3', kind: 'dispatch', status: 'interrupted', ownerSessionId: 's1', createdAt: 700, completedAt: 710, spec: { targetId: 'ghost' } },
    { id: 'op-t4', kind: 'dispatch', status: 'cancelled', ownerSessionId: 's2', createdAt: 600, updatedAt: 650, spec: { targetId: 'worker1', chatId: 'worker1' } },
    { id: 'op-run2', kind: 'dispatch', status: 'running', ownerSessionId: 's2', createdAt: 3500, spec: { targetId: 'worker1', chatId: 'worker1' } },
    { id: 'op-d1', kind: 'detached', status: 'running', ownerSessionId: 's1', externalId: 'job-1', createdAt: 100 },
  ];
  const schedules = {
    worker1: { active: { entryId: 'e-run', deliveryId: 'e-run', startedAt: 5 }, queued: [{ entryId: 'e-q1', position: 1 }, { entryId: 'e-q2', position: 2 }] },
    s1: { active: null, queued: [{ entryId: 'operation:op-self:request', position: 1 }, { entryId: 'e-held', position: 2 }] },
  };
  const scheduled = [{ id: 'sm-0', sessionId: 's1', message: 'older', dueAt: FROZEN_NOW + 1000, status: 'pending' }];
  const outbox = {
    'e-delivered': { state: 'delivered' },
    'e-dead': { state: 'dead-letter', lastError: 'delivery failed hard' },
    'e-cancelled': { state: 'cancelled' },
  };
  const promoted = new Set();
  const runtime = {
    async scheduleMessage(input) {
      record('scheduleMessage', input);
      const message = input.message;
      if (message === 'BOOM') throw Object.assign(new Error('scheduler busy'), { statusCode: 429, code: 'scheduler_busy' });
      if (message === 'RAW') throw new Error('plain failure');
      if (typeof message !== 'string' || !message.trim()) {
        throw Object.assign(new Error('message required'), { code: 'invalid_scheduled_message' });
      }
      if (message === 'DUP') return { id: 'sm-0', sessionId: input.sessionId, message, duplicate: true, dueAt: FROZEN_NOW + 1000, clientScheduleId: input.clientScheduleId || null };
      state.counter += 1;
      return { id: `sm-${state.counter}`, sessionId: input.sessionId, message, dueAt: FROZEN_NOW + (Number(input.delaySeconds) || 0) * 1000, clientScheduleId: input.clientScheduleId || null, status: 'pending' };
    },
    async listScheduledMessages(sessionId) {
      record('listScheduledMessages', { sessionId });
      if (sessionId === 's2') throw new Error('store offline');
      return scheduled.filter(item => item.sessionId === sessionId);
    },
    async cancelScheduledMessage(sessionId, messageId) {
      record('cancelScheduledMessage', { sessionId, messageId });
      if (messageId === 'explode') throw new Error('cancel exploded');
      if (messageId === 'sm-0') return { ok: true, id: 'sm-0', status: 'cancelled' };
      if (messageId === 'sm-done') return { ok: false, code: 'already_delivered' };
      if (messageId === 'sm-nocode') return { ok: false };
      return { ok: false, code: 'not_found' };
    },
    operations: {
      // The route needs `list` to exist; it prefers `listReferences`.
      list() { throw new Error('operations.list must not be used when listReferences exists'); },
      listReferences(query) {
        record('operations.listReferences', query);
        return operations.filter(operation => !query.kind || operation.kind === query.kind)
          .filter(operation => !query.ownerSessionId || operation.ownerSessionId === query.ownerSessionId);
      },
      async listTasks({ sessionId }) {
        record('operations.listTasks', { sessionId });
        if (sessionId === 's2') throw Object.assign(new Error('task index offline'), { statusCode: 503 });
        if (sessionId === 'worker1') throw new Error('plain task failure');
        return [{ taskId: 'task-9', sessionId, state: 'running' }];
      },
      async taskActivity({ sessionId, taskIds }) {
        // A qs object is only ever type-checked (the native store rejects every
        // shape but a string or an array alike), so it is recorded and echoed as
        // a marker rather than by its (unforwarded) keys.
        const plainObject = taskIds && typeof taskIds === 'object' && !Array.isArray(taskIds);
        const seen = plainObject ? { object: true } : taskIds;
        record('operations.taskActivity', { sessionId, taskIds: seen });
        if (taskIds === 'explode') throw new Error('activity failed');
        return [{ taskId: 'task-9', received: seen }];
      },
    },
    sessionScheduler: {
      async status(id) {
        record('sessionScheduler.status', { id });
        if (id === 's2') throw new Error('scheduler offline');
        // "Insert now" promotes the entry unless the run asks for a held slot.
        if (id === 's1' && promoted.has('e-held') && control().queueHeld !== true) {
          return { active: { entryId: 'e-held', startedAt: FROZEN_NOW }, queued: [] };
        }
        return schedules[id] || { active: null, queued: [] };
      },
      async resolve(sessionId, input) {
        record('sessionScheduler.resolve', { sessionId, ...input });
        if (input.reason === 'none') return { ok: false, code: 'no_active_task' };
        if (input.reason === 'blocked') return { ok: false, code: 'resolve_blocked' };
        return { ok: true, action: input.action, idempotencyKey: input.idempotencyKey, text: input.text === undefined ? null : input.text };
      },
      async cancelQueued(sessionId, entryId, options) {
        record('sessionScheduler.cancelQueued', { sessionId, entryId, options });
        if (entryId === 'missing') return { ok: false, code: 'queued_entry_not_found' };
        if (entryId === 'locked') return { ok: false, code: 'entry_locked' };
        return { ok: true, entryId, cancelled: true };
      },
      async reorderQueued(sessionId, entryId, options) {
        record('sessionScheduler.reorderQueued', { sessionId, entryId, options });
        if (entryId === 'missing') return { ok: false, code: 'queued_entry_not_found' };
        if (entryId === 'locked') return { ok: false, code: 'entry_locked' };
        return { ok: true, entryId, options };
      },
      async editQueued(sessionId, entryId, options) {
        record('sessionScheduler.editQueued', { sessionId, entryId, options });
        if (entryId === 'missing') return { ok: false, code: 'queued_entry_not_found' };
        if (!options.text) return { ok: false, code: 'queued_entry_text_required' };
        if (entryId === 'locked') return { ok: false, code: 'entry_locked' };
        return { ok: true, entryId, text: options.text };
      },
      async insertQueued(sessionId, entryId, options) {
        record('sessionScheduler.insertQueued', { sessionId, entryId, options });
        if (entryId === 'missing') return { ok: false, code: 'queued_entry_not_found' };
        if (entryId === 'locked') return { ok: false, code: 'entry_locked' };
        promoted.add(entryId);
        return { ok: true, entryId };
      },
    },
    async tick() { record('tick', null); },
    outbox: { async get(entryId) { record('outbox.get', { entryId }); return outbox[entryId] || null; } },
    // The out-of-scope wait / detached surface still mounted on Node.
    async register(input) { record('register', input); return { id: 'w-new', token: 'tok-wait', status: 'pending' }; },
    async resolveCallback(id, token, data) {
      record('resolveCallback', { id, token, data });
      if (id === 'w-missing') return { ok: false, code: 'not_found' };
      if (token !== 'tok-wait') return { ok: false, code: 'invalid_token' };
      return { ok: true, id, idempotent: false, status: 'resolved' };
    },
    async listForSession(sessionId) {
      record('listForSession', { sessionId });
      if (sessionId === 's2') throw new Error('wait store offline');
      if (sessionId === 'worker1') return [{ id: 'bad', sessionId: '' }];
      return [{ id: 'w1', sessionId, mode: 'callback', checks: 0, maxChecks: 5, intervalSec: 10, createdAt: FROZEN_NOW - 2000, status: 'pending' }];
    },
    async stats() { return { waits: 1, pending: 1 }; },
    async cancel(id) { record('cancel', { id }); return id === 'w1' ? { ok: true, status: 'cancelled' } : { ok: false, code: 'not_found' }; },
    async startDetached(input) {
      record('startDetached', { sessionId: input.sessionId, command: input.spec.command });
      return { operation: { id: 'op-d2', externalId: 'job-2', status: 'running' }, state: { pid: 4242, logPath: '/tmp/job-2.log' }, idempotent: false };
    },
  };
  const waitInjector = {
    listForSession(sessionId) {
      record('waitInjector.listForSession', { sessionId });
      return sessionId === 's1' ? [{ id: 'lw1', session: 's1', mode: 'poll', checks: 2, maxChecks: 9, intervalSec: 5, createdAt: FROZEN_NOW - 9000 }] : [];
    },
    stats() { return { waits: sessionStats() }; },
    cancel(id) { record('waitInjector.cancel', { id }); return { ok: id === 'lw1' }; },
  };
  function sessionStats() { return 1; }
  const detached = {
    status(id) { record('detached.status', { id }); return id === 'job-1' || id === 'job-2' ? { taskId: id, pid: 4242, done: false } : null; },
  };

  const { createErrorDto, requestContext, toWaitDto, withApiMeta } = require('../frozen-file-batch20/api-contract');
  const v1Error = (req, res, status, message, code) => res.status(status).json(createErrorDto({ ...requestContext(req, res), message, code }));

  const orchestrationDeps = {
    records,
    runtime,
    waitInjector,
    detached,
    cwdForSession: session => session.cwd || '/repo',
    resolveCwd: (base, value) => `${base}/${value}`,
    toWaitDto,
    withApiMeta,
    requestContext,
    v1Error,
    cancelActiveTurn: async (sessionId, options) => {
      record('cancelActiveTurn', { sessionId, options });
      if (options.reason === 'nosession') return { ok: false, code: 'session_not_found' };
      if (options.reason === 'stuck') return { ok: false, code: 'cancel_failed' };
      if (options.reason === 'throw') throw new Error('cancel exploded');
      return { ok: true, cancelled: true, operationId: options.operationId || null };
    },
    dismissUserInput: async (id, requestId) => {
      record('dismissUserInput', { id, requestId });
      if (requestId === 'gone') return { ok: false, code: 'not_pending' };
      if (requestId === 'boom') throw new Error('dismiss exploded');
      return { ok: true, requestId };
    },
    busyReasons: (id) => { record('busyReasons', { id }); return ['workspace_busy']; },
    unstickBlocked: async (id, options) => { record('unstickBlocked', { id, options }); return { escalated: false }; },
  };

  return {
    FROZEN_NOW, CANARIES, records, state, calls, auxDeps, auxRunLog, unattendedDeps,
    orchestrationDeps, quiet, control,
  };
}

/** The retired mounts in the order server.js registered them, on `app`. */
function mountFrozen(app, frozen, world) {
  const { createPublicSessionAccessGuard } = require('../legacy-public-session-access');
  const guard = createPublicSessionAccessGuard({
    records: world.records,
    v1NotFound: (req, res) => world.orchestrationDeps.v1Error(req, res, 404, 'session not found', 'session_not_found'),
  });
  app.use('/api/sessions/:id', guard);
  app.use('/api/v1/sessions/:id', guard);
  frozen.unattended().mountUnattendedRoutes(app, world.unattendedDeps);
  frozen.auxGoal().mountAuxGoalRoutes(app, world.auxDeps);
  frozen.auxRuns().createAuxRunRoutes({ records: world.records, getLog: () => world.auxRunLog }).mountRoutes(app);
  frozen.orchestration().createOrchestrationRoutes(world.orchestrationDeps).mountRoutes(app);
}

module.exports = { createWorld, mountFrozen, FROZEN_NOW, CANARIES };

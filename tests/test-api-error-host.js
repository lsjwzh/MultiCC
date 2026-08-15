'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApiErrorHost } = require('../src/chat/api-error-host');

function decision(overrides = {}) {
  return {
    action: 'retry',
    reason: 'bounded_retry',
    attempt: 1,
    delayMs: 1_000,
    retryAt: 2_000,
    duplicate: false,
    error: {
      category: 'provider_transient',
      provider: 'claude',
      code: null,
      httpStatus: 503,
      retryable: true,
      retryAfterMs: null,
      safeToRetry: true,
      phase: 'before_first_token',
      partialOutput: false,
      maxAttempts: 2,
      userAction: '稍后重试',
      sanitizedMessage: 'service unavailable',
      ...overrides.error,
    },
    ...overrides,
  };
}

function harness(options = {}) {
  const logs = [];
  const taskWrites = [];
  const broadcasts = [];
  const workspaceEvents = [];
  const injections = [];
  const statuses = [];
  const timers = [];
  const intervals = [];
  const records = new Map([['session-1', {
    dirId: 'dir-1',
    summary: 'task',
    taskState: { goal: 'repair' },
  }]]);
  let nextDecision = options.nextDecision || (() => decision());
  const policy = {
    evaluate(raw, context) { return nextDecision(raw, context); },
    recordSuccess(provider, context) { logs.push({ event: 'success', provider, context }); },
    snapshot() { return { circuits: [] }; },
  };
  const auxQueue = {
    queue: [],
    currentTask: null,
    getStatus: () => ({ health: { unhealthy: false } }),
    enqueue: () => Promise.resolve({ cancelled: true }),
    recordSuccess() {},
  };
  const host = createApiErrorHost({
    policy,
    logger: {
      info(event, fields) { logs.push({ event, fields }); },
      warn(event, fields) { logs.push({ event, fields }); },
      error(event, fields) { logs.push({ event, fields }); },
    },
    persistedSessions: records,
    getTaskState: persisted => persisted.taskState || {},
    setTaskState: (sessionId, patch, writeOptions) => {
      taskWrites.push({ sessionId, patch, writeOptions });
    },
    chatBroadcast: (sessionId, payload) => broadcasts.push({ sessionId, payload }),
    workspaceBroadcast: (dirId, payload) => workspaceEvents.push({ dirId, payload }),
    sessionDelivery: {
      deliverRetry: (sessionId, message, deliveryOptions) =>
        injections.push({ sessionId, message, deliveryOptions }),
    },
    getAuxQueue: () => auxQueue,
    setSessionStatus: (sessionId, status) => statuses.push({ sessionId, status }),
    clearIncrementalSave: sessionId => logs.push({ event: 'clear', sessionId }),
    isCurrentTurnRunner: (state, turn, runner) => state._activeRunner === runner
      && state._activeTurn === turn,
    isShuttingDown: () => false,
    now: () => 1_000,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
    setInterval: callback => {
      const timer = { callback, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearInterval: timer => { timer.cleared = true; },
    networkThreshold: 3,
    probeTimeoutMs: options.probeTimeoutMs,
  });
  return {
    host, logs, taskWrites, broadcasts, workspaceEvents, injections, statuses,
    timers, intervals, records, auxQueue,
    decideWith(fn) { nextDecision = fn; },
  };
}

test('turn policy decision persists stable state and duplicate delivery does not rebroadcast', () => {
  const h = harness();
  const state = {};
  const turn = { turnId: 'turn-1' };
  const runner = {};
  h.host.evaluateTurnApiError({
    sessionName: 'session-1', cs: state, persisted: { cli: 'claude' },
    turn, runner, raw: { httpStatus: 503 }, phase: 'before_first_token',
  });
  h.decideWith(() => decision({ duplicate: true }));
  h.host.evaluateTurnApiError({
    sessionName: 'session-1', cs: state, persisted: { cli: 'claude' },
    turn, runner, raw: { httpStatus: 503 }, phase: 'before_first_token',
  });
  assert.equal(h.taskWrites.length, 2);
  assert.equal(h.broadcasts.length, 2, 'only the first decision emits policy + warning events');
  assert.equal(h.broadcasts[0].payload.type, 'api_error_policy');
  assert.equal(h.taskWrites[0].patch.apiError.category, 'provider_transient');
  assert.equal('sanitizedMessage' in h.taskWrites[0].patch.apiError, false);
});

test('turn policy receives the owned turn elapsed budget', () => {
  const h = harness();
  let observed = null;
  h.decideWith((raw, context) => {
    observed = context;
    return decision();
  });
  h.host.evaluateTurnApiError({
    sessionName: 'session-1',
    cs: { turnStartedAt: 250 },
    persisted: { cli: 'claude' },
    turn: { turnId: 'turn-elapsed' },
    runner: {},
    raw: { httpStatus: 503 },
    phase: 'before_first_token',
  });
  assert.equal(observed.elapsedMs, 750);
});

test('owned retry reuses the current turn, resets partial state, and cancels when superseded', () => {
  const h = harness();
  const turn = { turnId: 'turn-1' };
  const runner = {};
  const state = {
    _activeTurn: turn,
    _activeRunner: runner,
    currentAssistantText: 'partial',
    currentToolCalls: [{ name: 'Thinking' }],
  };
  let starts = 0;
  h.host.scheduleOwnedRetry({
    sessionName: 'session-1', cs: state, persisted: {}, turn, runner,
    decision: decision(), provider: 'claude', start: () => { starts += 1; },
  });
  assert.equal(h.timers[0].delay, 1_000);
  assert.equal(h.statuses[0].status.status, 'waiting');
  h.timers[0].callback();
  assert.equal(starts, 1);
  assert.equal(state.currentAssistantText, '');
  assert.deepEqual(state.currentToolCalls, []);

  h.host.scheduleOwnedRetry({
    sessionName: 'session-1', cs: state, persisted: {}, turn, runner,
    decision: decision(), provider: 'claude', start: () => { starts += 1; },
  });
  state._activeRunner = {};
  h.timers[1].callback();
  assert.equal(starts, 1, 'a superseded runner never replays the request');
});

test('only network failures open the global hold and recovery resumes held sessions', async () => {
  const h = harness();
  h.decideWith(raw => decision({
    error: { category: raw.category, provider: raw.provider || 'claude' },
  }));
  h.host.recordApiError({ category: 'provider_transient' });
  assert.equal(h.host.snapshot().consecutiveFails, 0);
  h.host.recordApiError({ category: 'network' });
  h.host.recordApiError({ category: 'network' });
  h.host.recordApiError({ category: 'network' });
  assert.equal(h.host.isNetworkUnhealthy(), true);
  assert.equal(h.intervals.length, 1);
  h.host.holdSession('session-1', 'offline', '真实待处理数据');
  assert.equal(h.host.isHeld('session-1'), true);
  assert.equal(h.workspaceEvents.length, 1);
  h.host.recordApiSuccess('claude');
  await Promise.resolve();
  assert.equal(h.host.isNetworkUnhealthy(), false);
  assert.equal(h.injections.length, 1);
  assert.match(h.injections[0].message, /真实待处理数据/);
  assert.equal(h.injections[0].deliveryOptions.taskSource, 'api_recovery');
  assert.match(h.injections[0].deliveryOptions.idempotencyKey, /^api-recovery:session-1:/);
});

test('Aux recovery probe skips permanent authentication/configuration failures', () => {
  const h = harness();
  let enqueued = 0;
  h.auxQueue.enqueue = () => { enqueued += 1; return Promise.resolve({}); };
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: false, category: 'authentication_permission' },
  });
  h.host.auxHealthProbe();
  assert.equal(enqueued, 0);
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: false, category: 'adapter_configuration' },
  });
  h.host.auxHealthProbe();
  assert.equal(enqueued, 0);
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: true, retryAt: 2_000 },
  });
  h.host.auxHealthProbe();
  assert.equal(enqueued, 0, 'a credible reset time blocks probes before the window');
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: true, retryAt: 1_000 },
  });
  h.host.auxHealthProbe();
  assert.equal(enqueued, 1);
});

test('Aux recovery probe retries external billing quota and clears health on success', async () => {
  const h = harness({ probeTimeoutMs: 12_345 });
  let enqueuedTask = null;
  let successes = 0;
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: false, category: 'billing_quota', retryAt: null },
  });
  h.auxQueue.enqueue = task => {
    enqueuedTask = task;
    return Promise.resolve({ text: 'ok', cancelled: false });
  };
  h.auxQueue.recordSuccess = () => { successes += 1; };
  h.host.auxHealthProbe();
  await Promise.resolve();
  assert.equal(enqueuedTask.type, 'health_probe');
  assert.deepEqual(enqueuedTask.meta, { probe: true, timeout: 12_345 });
  assert.equal(successes, 1);
});

test('Aux recovery probe does not enqueue a second health probe while one is active', () => {
  const h = harness();
  let enqueued = 0;
  h.auxQueue.getStatus = () => ({
    health: { unhealthy: true, retryable: false, category: 'billing_quota', retryAt: null },
  });
  h.auxQueue.enqueue = () => { enqueued += 1; return Promise.resolve({ text: 'ok' }); };
  h.auxQueue.queue = [{ type: 'health_probe' }];
  h.host.auxHealthProbe();
  assert.equal(enqueued, 0);
  h.auxQueue.queue = [];
  h.auxQueue.currentTask = { type: 'health_probe' };
  h.host.auxHealthProbe();
  assert.equal(enqueued, 0);
});

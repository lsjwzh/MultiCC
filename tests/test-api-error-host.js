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
      rootCause: 'service unavailable',
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
    now: typeof options.now === 'function' ? options.now : () => 1_000,
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
  assert.equal(h.taskWrites[0].patch.apiError.rootCause, 'service unavailable');
  assert.match(h.broadcasts[1].payload.message, /根因：service unavailable/);
});

test('turn duration is diagnostic only and recovery budget starts at first host decision', () => {
  let clock = 200_000;
  const h = harness({ now: () => clock });
  const observed = [];
  h.decideWith((raw, context) => {
    observed.push(context);
    return decision();
  });
  const state = { turnStartedAt: 1_000 };
  const turn = { turnId: 'turn-elapsed' };
  h.host.evaluateTurnApiError({
    sessionName: 'session-1',
    cs: state,
    persisted: { cli: 'claude' },
    turn,
    runner: {},
    raw: { httpStatus: 503 },
    phase: 'before_first_token',
  });
  assert.equal(observed[0].turnElapsedMs, 199_000);
  assert.equal(observed[0].recoveryElapsedMs, 0);
  assert.equal(observed[0].elapsedMs, 0);

  clock += 10_000;
  h.host.evaluateTurnApiError({
    sessionName: 'session-1', cs: state, persisted: { cli: 'claude' },
    turn, runner: {}, raw: { httpStatus: 503 }, attempt: 1,
    phase: 'before_first_token',
  });
  assert.equal(observed[1].turnElapsedMs, 209_000);
  assert.equal(observed[1].recoveryElapsedMs, 10_000);
});

test('turn policy binds errors and idempotency to the owned provider route attempt', () => {
  const h = harness();
  const observed = [];
  h.decideWith((raw, context) => {
    observed.push(context);
    const base = decision();
    return decision({
      error: {
        ...base.error,
        provider: context.provider,
        providerId: context.providerId,
        providerName: context.providerName,
        runtimeEpoch: context.runtimeEpoch,
        routeAttemptId: context.routeAttemptId,
        routeGeneration: context.routeGeneration,
        attemptNo: context.attemptNo,
      },
    });
  });
  const turn = { turnId: 'turn-routed' };
  const usageAttribution = {
    cli: 'codex',
    providerId: 'provider-a',
    providerName: 'Provider A',
    turnId: 'turn-routed',
    decisionId: 'decision-1',
    routeAttemptId: 'route-attempt-1',
    routeGeneration: 7,
    attemptNo: 2,
    providerRevision: 'revision-a',
  };
  h.host.evaluateTurnApiError({
    sessionName: 'session-1',
    cs: { cli: 'claude' },
    persisted: { cli: 'claude', provider: 'stale-provider' },
    turn,
    runner: {
      usageAttribution,
      providerAttempt: {
        ...usageAttribution,
        runtimeEpoch: 'runtime-epoch-1',
      },
    },
    raw: { httpStatus: 503, provider: 'claude' },
    phase: 'before_first_token',
  });

  assert.equal(observed[0].provider, 'codex', 'legacy error.provider remains the concrete CLI');
  assert.equal(observed[0].providerId, 'provider-a');
  assert.equal(observed[0].providerName, 'Provider A');
  assert.equal(observed[0].runtimeEpoch, 'runtime-epoch-1');
  assert.equal(observed[0].decisionId, 'decision-1');
  assert.equal(observed[0].routeAttemptId, 'route-attempt-1');
  assert.equal(observed[0].routeGeneration, 7);
  assert.equal(observed[0].attemptNo, 2);
  assert.equal(observed[0].providerRevision, 'revision-a');
  assert.match(observed[0].idempotencyKey, /route-attempt-1/);
  assert.deepEqual(
    {
      provider: h.taskWrites[0].patch.apiError.provider,
      providerId: h.taskWrites[0].patch.apiError.providerId,
      providerName: h.taskWrites[0].patch.apiError.providerName,
      runtimeEpoch: h.taskWrites[0].patch.apiError.runtimeEpoch,
      routeAttemptId: h.taskWrites[0].patch.apiError.routeAttemptId,
      routeGeneration: h.taskWrites[0].patch.apiError.routeGeneration,
      attemptNo: h.taskWrites[0].patch.apiError.attemptNo,
    },
    {
      provider: 'codex',
      providerId: 'provider-a',
      providerName: 'Provider A',
      runtimeEpoch: undefined,
      routeAttemptId: undefined,
      routeGeneration: undefined,
      attemptNo: undefined,
    },
  );
  assert.deepEqual({
    scope: h.broadcasts[0].payload.providerRouteScope,
    turnId: h.broadcasts[0].payload.turnId,
    decisionId: h.broadcasts[0].payload.decisionId,
    routeAttemptId: h.broadcasts[0].payload.routeAttemptId,
    providerRevision: h.broadcasts[0].payload.providerRevision,
  }, {
    scope: 'attempt', turnId: 'turn-routed', decisionId: 'decision-1',
    routeAttemptId: 'route-attempt-1', providerRevision: 'revision-a',
  });

  h.host.evaluateTurnApiError({
    sessionName: 'session-1',
    cs: { cli: 'claude' },
    persisted: { cli: 'claude', provider: 'stale-provider' },
    turn,
    runner: {
      usageAttribution: {
        ...usageAttribution,
        routeAttemptId: 'route-attempt-2',
        routeGeneration: 8,
        attemptNo: 3,
      },
      providerAttempt: {
        ...usageAttribution,
        runtimeEpoch: 'runtime-epoch-1',
        routeAttemptId: 'route-attempt-2',
        routeGeneration: 8,
        attemptNo: 3,
      },
    },
    raw: { httpStatus: 503, provider: 'claude' },
    phase: 'before_first_token',
  });
  assert.match(observed[1].idempotencyKey, /route-attempt-2/);
  assert.notEqual(observed[1].idempotencyKey, observed[0].idempotencyKey,
    'two physical route attempts in one logical turn are never deduplicated together');
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

test('network recovery never resumes a scrubbed TaskRun execution slot', async () => {
  const h = harness();
  h.records.get('session-1').taskExecutionSlot = true;
  h.decideWith(raw => decision({
    error: { category: raw.category, provider: raw.provider || 'claude' },
  }));
  h.host.recordApiError({ category: 'network' });
  h.host.recordApiError({ category: 'network' });
  h.host.recordApiError({ category: 'network' });
  h.host.holdSession('session-1', 'offline', 'must survive in TaskRun ledger');
  h.host.recordApiSuccess('claude');
  await Promise.resolve();
  assert.equal(h.injections.length, 0);
  assert.equal(h.logs.some(entry => entry.event === 'api_error_task_run_requires_new_run'), true);
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

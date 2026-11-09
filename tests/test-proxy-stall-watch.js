'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  PROXY_STALL_CODES,
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  MODEL_REQUEST_DEADLINE,
  MODEL_CONNECT_TIMEOUT,
  createProxyStallWatch,
  isProxyStallCode,
  terminateStalledResponse,
} = require('../src/providers/proxy-stall-watch');
const { observeProxyRequest } = require('../src/providers/proxy-outcome');
const { createProviderProxyAdmission, createProviderProxyGuard } = require('../src/providers/proxy-guard');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createApiErrorPolicyRuntime } = require('../src/chat/api-error-policy');
const { failoverSafety } = require('../src/chat/auto-provider-policy');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');
const { resolveAutoStallTimeoutMs } = require('../src/chat/auto-stall-timeout');

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

// Deterministic timers: the watchdog is only allowed to schedule through the
// ports it is given, so a test never waits on wall-clock time.
function timerHarness() {
  const scheduled = new Map();
  let nextId = 0;
  return {
    setTimeout(fn, ms) {
      const id = ++nextId;
      const handle = { id, unrefCalls: 0, unref() { handle.unrefCalls += 1; return handle; } };
      scheduled.set(id, { fn, ms, handle });
      return handle;
    },
    clearTimeout(handle) {
      if (handle && scheduled.has(handle.id)) scheduled.delete(handle.id);
    },
    pending: () => [...scheduled.values()],
    intervals: () => [...scheduled.values()].map(entry => entry.ms),
    fire() {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const entry of entries) entry.fn();
      return entries.length;
    },
  };
}

// `teardownLog`, when given, receives only the teardown, so a test can order it
// against the observation's own settle and the watchdog's own report.
function fakeResponse(teardownLog) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  res.headersSent = false;
  res.destroyed = false;
  res.writes = [];
  res.events = [];
  res.writeHead = function writeHead(status, headers) {
    res.headersSent = true;
    res.head = { status, headers };
    res.events.push(`writeHead:${status}`);
    return res;
  };
  res.write = function write(chunk) {
    res.headersSent = true;
    res.writes.push(String(chunk));
    res.events.push(`write:${String(chunk).length}`);
    return true;
  };
  res.flushHeaders = function flushHeaders() {
    res.headersSent = true;
    res.events.push('flushHeaders');
  };
  res.end = function end(chunk) {
    res.writableEnded = true;
    res.events.push('end');
    if (chunk !== undefined) res.writes.push(String(chunk));
    return res;
  };
  res.destroy = function destroy() {
    res.destroyed = true;
    res.events.push('destroy');
    if (teardownLog) teardownLog.push('destroy');
    res.emit('close');
    return res;
  };
  return res;
}

function inferenceRequest(protocol = 'claude') {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = protocol === 'claude' ? '/p1/pr1.s.t/v1/messages' : '/p1/pr1.s.t/main/responses';
  return req;
}

function attemptRuntime() {
  let sequence = 0;
  return createProviderAttemptRuntime({
    runtimeEpoch: 'epoch-stall',
    nextId: prefix => `${prefix}-${++sequence}`,
  });
}

function beginAttempt(runtime, input = {}) {
  return runtime.beginAttempt({
    sessionId: 's1', turnId: 't1', cli: 'claude', providerId: 'p1',
    providerName: 'P1', protocol: 'anthropic', model: 'm1',
    providerRevision: 'revision-1', attemptNo: 1, ...input,
  });
}

test('native timeout is settled before a queued close, while an earlier close wins', () => {
  for (const timedOutFirst of [true, false]) {
    const req = inferenceRequest();
    const res = fakeResponse();
    res.headersSent = true;
    const terminals = [];
    let watch;
    const observation = observeProxyRequest('claude', req, res,
      (outcome, event) => terminals.push({ outcome, event }),
      () => watch?.handleNativeDisconnect() === true);
    watch = createProxyStallWatch({ protocol: 'claude', req, res, observation, requestKind: 'inference' });
    assert.equal(watch.arm({ stallTimeoutMs: 2000, requestTimeoutMs: 4000 }), true);
    let callback;
    const exchange = {
      startStreamWatch(_idle, _remaining, _deadline, _progressed, cb) { callback = cb; },
      abort() { return timedOutFirst ? 'stream_idle_timeout' : undefined; },
      streamProgressed() { return true; },
      stopStreamWatch() {},
      noteStreamProgress() { return false; },
      streamTimeoutCode() { return timedOutFirst ? 'stream_idle_timeout' : undefined; },
    };
    assert.equal(watch.useNativeProgress(exchange), true);
    // The close handler runs before the already-queued TSFN callback.
    res.emit('close');
    callback(JSON.stringify({ code: 'stream_idle_timeout', progressed: true }));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].event.errorCode, timedOutFirst ? 'stream_idle_timeout' : 'DOWNSTREAM_DISCONNECT');
    assert.equal(terminals[0].outcome.termination, timedOutFirst ? 'upstream_failure' : 'downstream_disconnect');
    watch.dispose();
  }
});

// ---------------------------------------------------------------------------
// Unit: the watchdog itself
// ---------------------------------------------------------------------------

test('the watchdog only arms for an inference request with a positive stall budget', () => {
  const timers = timerHarness();
  const armed = [];
  const cases = [
    [{ requestKind: 'inference', stallTimeoutMs: 30_000 }, true],
    [{ requestKind: 'inference', stallTimeoutMs: 0 }, false],
    [{ requestKind: 'inference' }, false],
    [{ requestKind: 'inference', stallTimeoutMs: -1 }, false],
    [{ requestKind: 'inference', stallTimeoutMs: 1.5 }, false],
    [{ requestKind: 'auxiliary', stallTimeoutMs: 30_000 }, false],
    [{ requestKind: 'probe', stallTimeoutMs: 30_000 }, false],
  ];
  for (const [overrides, expected] of cases) {
    const res = fakeResponse();
    const watch = createProxyStallWatch({
      protocol: 'claude', req: inferenceRequest(), res,
      observation: observeProxyRequest('claude', inferenceRequest(), res),
      requestKind: overrides.requestKind,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    assert.equal(watch.arm({ stallTimeoutMs: overrides.stallTimeoutMs }), expected,
      `arm(${JSON.stringify(overrides)})`);
    armed.push(watch.isArmed());
    watch.dispose();
  }
  assert.deepEqual(armed, cases.map(([, expected]) => expected));
});

test('a non-inference request never wraps the response object', () => {
  const timers = timerHarness();
  const res = fakeResponse();
  const original = { write: res.write, end: res.end, writeHead: res.writeHead };
  const watch = createProxyStallWatch({
    protocol: 'claude', req: inferenceRequest(), res,
    observation: observeProxyRequest('claude', inferenceRequest(), res),
    requestKind: 'auxiliary',
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  assert.equal(watch.arm({ stallTimeoutMs: 60_000 }), false);
  assert.equal(res.write, original.write);
  assert.equal(res.end, original.end);
  assert.equal(res.writeHead, original.writeHead);
  assert.equal(timers.pending().length, 0);
});

test('silence with no downstream byte is a before-response stall answered with 504', () => {
  const timers = timerHarness();
  const req = inferenceRequest();
  // One ordered log across all three parties: the observation's settle, the
  // watchdog's own report, and the socket teardown.
  const order = [];
  const res = fakeResponse(order);
  const observation = observeProxyRequest('claude', req, res,
    (outcome, event) => order.push(`settle:${event.errorCode || outcome.termination}`));
  const watch = createProxyStallWatch({
    protocol: 'claude', req, res, observation,
    sessionId: 'session-1', providerId: 'provider-a', role: 'main',
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onStall: detail => order.push(`stall:${detail.code}`),
  });
  assert.equal(watch.arm({ stallTimeoutMs: 120_000 }), true);
  assert.deepEqual(timers.intervals(), [120_000]);

  timers.fire();

  assert.deepEqual(order, [
    `settle:${RESPONSE_STALLED_BEFORE_RESPONSE}`,
    `stall:${RESPONSE_STALLED_BEFORE_RESPONSE}`,
    'destroy',
  ], 'the observation settles before the teardown, and the CLI sees the 504 first');
  assert.equal(res.head.status, 504);
  assert.equal(res.head.headers['content-type'], 'application/json');
  assert.equal(res.head.headers['x-should-retry'], 'false');
  const body = JSON.parse(res.writes[0]);
  assert.equal(res.head.headers['content-length'], Buffer.byteLength(res.writes[0]),
    'an explicit content-length makes the 504 complete without a terminating chunk');
  assert.deepEqual(body, {
    error: { type: 'upstream_stalled', code: RESPONSE_STALLED_BEFORE_RESPONSE, message: 'upstream made no progress for 120s' },
  });
  assert.equal(res.destroyed, true, 'the socket is destroyed so the proxy releases the dead upstream');
  assert.equal(res.writableEnded, false, 'a polite end would leave the upstream socket open');
});

test('a stall after any downstream byte is a stream idle timeout and destroys', () => {
  const timers = timerHarness();
  const req = inferenceRequest();
  const res = fakeResponse();
  const settled = [];
  const observation = observeProxyRequest('claude', req, res,
    outcome => settled.push(outcome.termination));
  const watch = createProxyStallWatch({
    protocol: 'claude', req, res, observation,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  watch.arm({ stallTimeoutMs: 20_000 });
  // A flushed header block is a downstream byte even before the first chunk.
  res.flushHeaders();
  res.write('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n');
  res.write('event: content_block_delta\n\n');
  assert.deepEqual(timers.intervals(), [20_000]);
  const before = res.events.length;
  timers.fire();
  assert.deepEqual(res.events.slice(before), ['destroy']);
  assert.equal(res.head, undefined, 'a stream already in flight is not answered again');
  assert.deepEqual(settled, ['upstream_failure']);
  assert.equal(res.destroyed, true);
});

test('wrapping progress preserves response return values and one idle timer', () => {
  const timers = timerHarness();
  const req = inferenceRequest();
  const res = fakeResponse();
  const watch = createProxyStallWatch({
    protocol: 'claude', req, res,
    observation: observeProxyRequest('claude', req, res),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  watch.arm({ stallTimeoutMs: 15_000 });
  assert.equal(timers.pending().length, 1);
  for (const [index, signal] of [
    () => res.writeHead(200, { 'content-type': 'text/event-stream' }),
    () => res.write('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n'),
    () => res.flushHeaders(),
    () => res.write('chunk-2'),
  ].entries()) {
    signal();
    assert.equal(timers.pending().length, 1, `signal ${index} keeps exactly one armed timer`);
    assert.deepEqual(timers.intervals(), [15_000]);
  }
  assert.equal(watch.progressed(), true);
  // The wrappers are transparent: every original return value and `this` survive.
  assert.equal(res.write('probe'), true, 'the wrapped write keeps its return value');
  assert.equal(res.writeHead(200), res, 'the wrapped writeHead keeps returning the response');
  assert.equal(timers.pending().length, 1, 'and both of those restarted the budget again');
});

test('finish, close and error all clear the timer for good', () => {
  for (const event of ['finish', 'close', 'error']) {
    const timers = timerHarness();
    const req = inferenceRequest();
    const res = fakeResponse();
    const watch = createProxyStallWatch({
      protocol: 'claude', req, res,
      observation: observeProxyRequest('claude', req, res),
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    watch.arm({ stallTimeoutMs: 30_000 });
    assert.equal(timers.pending().length, 1);
    res.emit(event);
    assert.equal(timers.pending().length, 0, `${event} clears the watchdog`);
    assert.equal(timers.fire(), 0, `${event} leaves nothing to fire`);
    assert.equal(res.destroyed, false);
  }
});

test('a normal stream ends through the wrapped end without any teardown', () => {
  const timers = timerHarness();
  const req = inferenceRequest();
  const res = fakeResponse();
  const observation = observeProxyRequest('claude', req, res);
  const watch = createProxyStallWatch({
    protocol: 'claude', req, res, observation,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  watch.arm({ stallTimeoutMs: 30_000 });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: message_stop\n\n');
  res.end();
  assert.equal(res.writableEnded, true);
  assert.equal(timers.pending().length, 0);
  assert.equal(res.destroyed, false);
  assert.equal(observation.outcome({ status: 'success', statusCode: 200 }).termination, 'completed');
});

test('an unref-able timer can never hold the process open, and stall codes are shared', () => {
  const timers = timerHarness();
  const res = fakeResponse();
  const req = inferenceRequest();
  const watch = createProxyStallWatch({
    protocol: 'claude', req, res,
    observation: observeProxyRequest('claude', req, res),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  watch.arm({ stallTimeoutMs: 60_000 });
  assert.equal(timers.pending()[0].handle.unrefCalls, 1);
  assert.equal(isProxyStallCode('stream_idle_timeout'), true);
  assert.equal(isProxyStallCode('STREAM_IDLE_TIMEOUT'), true);
  assert.equal(isProxyStallCode('response_stalled_before_response'), true);
  assert.equal(isProxyStallCode('DOWNSTREAM_DISCONNECT'), false);
  assert.deepEqual([...PROXY_STALL_CODES], [RESPONSE_STALLED_BEFORE_RESPONSE, STREAM_IDLE_TIMEOUT, MODEL_REQUEST_DEADLINE, MODEL_CONNECT_TIMEOUT]);
});

test('termination without a destroy port still finishes the response', () => {
  const res = fakeResponse();
  delete res.destroy;
  terminateStalledResponse(res, { code: RESPONSE_STALLED_BEFORE_RESPONSE, timeoutMs: 1_000 });
  assert.equal(res.head.status, 504);
  assert.equal(JSON.parse(res.writes[0]).error.code, RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.equal(terminateStalledResponse(null, { code: STREAM_IDLE_TIMEOUT }), false);
});

// ---------------------------------------------------------------------------
// Admission: the real proxy surface, a real attempt runtime
// ---------------------------------------------------------------------------

function admissionHarness({ stallTimeoutMs = 60_000, providerId = 'p1', handler } = {}) {
  const runtime = attemptRuntime();
  const attempt = beginAttempt(runtime, { stallTimeoutMs, providerId, providerName: providerId });
  const capability = runtime.proxySessionId(attempt);
  const timers = timerHarness();
  const outcomes = [];
  const stalls = [];
  let mounted;
  const admission = createProviderProxyAdmission({
    protocol: 'claude',
    app: { use(_path, fn) { mounted = fn; } },
    authorizeProxyRequest: runtime.authorizeProxyRequest,
    getProvider: () => ({ id: providerId }),
    onOutcome: event => { outcomes.push(event); runtime.observeProxyOutcome(event); },
    onStall: detail => stalls.push(detail),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  admission.app.use('/claude-proxy', handler(admission));
  return { runtime, attempt, capability, timers, outcomes, stalls, mounted, admission };
}

test('an Auto attempt that never answers is stalled, retired and refused on re-dial', async () => {
  const harness = admissionHarness({
    handler: admission => (req, res) => {
      admission.getProvider('claude', 'p1');
      // The upstream accepted the request and then sent nothing at all.
    },
  });
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: `/p1/${harness.capability}/v1/messages`,
  });
  const res = fakeResponse();
  await harness.mounted(req, res, error => { throw error; });
  assert.equal(harness.timers.pending().length, 1, 'armed at dial time');
  assert.equal(harness.timers.pending()[0].ms, 60_000);

  harness.timers.fire();
  assert.equal(res.head.status, 504);
  assert.equal(JSON.parse(res.writes[0]).error.code, RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.equal(res.destroyed, true);
  assert.deepEqual(harness.stalls.map(detail => detail.code), [RESPONSE_STALLED_BEFORE_RESPONSE]);
  // The host recorded the stall, and the attempt now refuses the re-dial codex
  // and the Anthropic SDK would otherwise attempt several times.
  assert.equal(harness.runtime.snapshot('s1').stalled, true);
  assert.equal(harness.runtime.proxyFailure(harness.attempt).code, RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.deepEqual(harness.runtime.authorizeProxyRequest({
    protocol: 'claude', sessionId: harness.capability, providerId: 'p1', role: 'main',
  }), { ok: false, code: 'attempt_stalled', sessionId: 's1' });
  // The socket teardown is a strictly weaker cause and never reaches the host
  // as its own outcome: the adapter is told about the stall and nothing after.
  assert.equal(harness.timers.fire(), 0);
  assert.deepEqual(harness.outcomes.map(event => event.errorCode),
    [RESPONSE_STALLED_BEFORE_RESPONSE]);
  // Even if a disconnect were reported out of band, the runtime keeps the
  // stall: a stall is evidence, and a teardown is only an effect.
  const disconnect = {
    ...harness.attempt, roleKind: 'main', routeAttribution: 'exact', providerId: 'p1',
    status: 'error', errorCode: 'DOWNSTREAM_DISCONNECT',
    proxyOutcome: {
      version: 1, requestId: 'req-1', requestKind: 'inference',
      termination: 'downstream_disconnect', httpStatus: null,
    },
  };
  assert.equal(harness.runtime.observeProxyOutcome(disconnect).failure.code,
    RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.equal(harness.runtime.proxyFailure(harness.attempt).code, RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.equal(harness.runtime.snapshot('s1').stalled, true);
});

test('the stalled re-dial is refused with a non-retryable 409, every other 409 unchanged', () => {
  const runtime = attemptRuntime();
  const attempt = beginAttempt(runtime, { stallTimeoutMs: 60_000 });
  const capability = runtime.proxySessionId(attempt);
  const failures = [
    { ok: false, code: 'attempt_stalled' },
    { ok: false, code: 'proxy_attempt_not_running' },
  ];
  const seen = [];
  const guard = createProviderProxyGuard({
    protocol: 'claude',
    authorizeProxyRequest: () => failures.shift(),
    onRejected: event => seen.push(event.reason),
  });
  const responses = [fakeResponse(), fakeResponse()];
  guard({ method: 'POST', url: `/p1/${capability}/v1/messages` }, responses[0], () => {});
  guard({ method: 'POST', url: `/p1/${capability}/v1/messages` }, responses[1], () => {});
  assert.equal(responses[0].head.status, 409);
  assert.equal(responses[0].head.headers['x-should-retry'], 'false');
  assert.equal(JSON.parse(responses[0].writes[0]).error, 'provider route attempt is no longer active');
  assert.deepEqual(responses[1].head.headers, { 'content-type': 'application/json' },
    'only a proved stall is marked non-retryable');
  assert.deepEqual(seen, ['attempt_stalled', 'proxy_attempt_not_running']);
});

test('an explicitly disabled legacy watch (budget 0) does not wrap responses', async () => {
  const harness = admissionHarness({
    stallTimeoutMs: 0,
    handler: admission => (req, res) => {
      const original = res.write;
      admission.getProvider('claude', 'p1');
      assert.equal(res.write, original, 'an attempt without a budget is never wrapped');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\n\n');
    },
  });
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: `/p1/${harness.capability}/v1/messages`,
  });
  const res = fakeResponse();
  await harness.mounted(req, res, error => { throw error; });
  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.runtime.snapshot('s1').stallTimeoutMs, 0);
  assert.equal(harness.timers.fire(), 0);
  assert.equal(res.destroyed, false);
  assert.equal(res.head.status, 200);
});

test('a mid-stream stall inside the admission is the idle-timeout code', async () => {
  const harness = admissionHarness({
    stallTimeoutMs: 25_000,
    handler: admission => (req, res) => {
      admission.getProvider('claude', 'p1');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n');
    },
  });
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: `/p1/${harness.capability}/v1/messages`,
  });
  const res = fakeResponse();
  await harness.mounted(req, res, error => { throw error; });
  harness.timers.fire();
  assert.equal(res.head.status, 200, 'headers already went out: the only honest ending is a destroy');
  assert.equal(res.destroyed, true);
  assert.equal(harness.runtime.proxyFailure(harness.attempt).code, STREAM_IDLE_TIMEOUT);
  assert.equal(harness.outcomes[0].proxyOutcome.requestKind, 'inference');
  assert.equal(harness.outcomes[0].proxyOutcome.termination, 'upstream_failure');
});

// ---------------------------------------------------------------------------
// End to end: does the stall actually fail the turn over?
// ---------------------------------------------------------------------------

// What turn-engine does at close: `rawApiError = boundaryErrorEnvelope ||
// runner.apiErrorRaw || proxyFailure || {…}`. With no CLI-authored error text
// (the shape the incident had: the upstream never spoke) the host's own
// proxyFailure is the evidence the decision is formed from.
function decisionFor(proxyFailure, { partialOutput = false } = {}) {
  const policy = createApiErrorPolicyRuntime({ now: () => 1_700_000_000_000 });
  return policy.evaluate(proxyFailure, {
    provider: 'codex',
    cli: 'codex',
    providerId: proxyFailure.providerId,
    source: 'proxy_response',
    sessionId: 's1',
    turnId: 't1',
    phase: partialOutput ? 'stream' : 'before_first_token',
    partialOutput,
    sideEffects: false,
    idempotencyKey: `s1:t1:0:${proxyFailure.code}`,
  });
}

function autoFixture() {
  const catalog = [
    { id: 'stalled', name: 'Stalled line', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'stalled-model', modelOptions: ['stalled-model'] },
    { id: 'backup', name: 'Backup line', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'backup-model', modelOptions: ['backup-model'] },
  ];
  const events = [];
  const runtime = createAutoProviderRuntime({
    providers: {
      appTypeForCli: () => 'claude',
      listProviders: () => catalog,
      providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
      modelValidForProvider: (_appType, providerId, model) =>
        catalog.some(item => item.id === providerId && item.model === model),
    },
    now: () => 1_000_000,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's1', cli: 'claude', provider: 'legacy-concrete',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: false,
      candidates: [{ providerId: 'stalled', priority: 1 }, { providerId: 'backup', priority: 2 }],
    },
  };
  return { runtime, session, events };
}

test('a recorded stall becomes a timeout decision in a safe phase, so Auto switches lines', () => {
  for (const code of PROXY_STALL_CODES.filter(code => code !== MODEL_REQUEST_DEADLINE)) {
    const proxyFailure = {
      source: 'proxy_response',
      provider: 'codex',
      providerId: 'stalled',
      providerName: 'Stalled line',
      httpStatus: null,
      code,
      message: 'upstream request failed',
      observedAt: 1,
    };
    const decision = decisionFor(proxyFailure);
    assert.equal(decision.error.category, 'timeout', `${code} classifies as timeout`);
    assert.equal(decision.error.code, code);
    assert.equal(decision.error.phase, 'before_first_token');
    assert.equal(decision.error.partialOutput, false);
    assert.equal(decision.error.safeToRetry, true);

    // The snapshot the turn hands to failoverSafety: nothing was shown to the
    // user yet, so the physical route may still be replaced.
    const attempt = {
      providerId: 'stalled',
      replayFence: 'none',
      visibleOutputObserved: false,
      toolIntentObserved: false,
      sideEffectObserved: false,
    };
    const safety = failoverSafety(decision, attempt);
    assert.deepEqual(safety, { ok: true, reason: 'failover_timeout' }, `${code} is failoverable`);

    const { runtime, session, events } = autoFixture();
    const autoTurn = runtime.beginTurn({ session, turnId: 't1', promptText: 'hello' });
    assert.equal(autoTurn.enabled, true);
    assert.equal(autoTurn.initial().providerId, 'stalled');
    const failover = autoTurn.failover(decision, attempt);
    assert.equal(failover.invocationOptions.providerId, 'backup',
      `${code} moves the turn to the next candidate`);
    assert.equal(failover.decision.action, 'retry');
    assert.equal(failover.decision.reason, 'provider_failover');
    assert.equal(failover.decision.providerFailover.category, 'timeout');
    assert.equal(failover.fromProviderName, 'Stalled line');
    assert.equal(failover.toProviderName, 'Backup line');
    assert.deepEqual(events.map(event => event.routePhase), ['selected', 'switched']);
    assert.equal(events[1].reasonCode, 'failover_timeout');
  }
});

test('the stall the watchdog records is the evidence the turn fails over with', async () => {
  // The whole chain, with no hand-built intermediate: a real admission, a real
  // attempt runtime, the runtime's own recorded failure and its own snapshot.
  const harness = admissionHarness({
    providerId: 'stalled',
    handler: admission => (req, res) => { admission.getProvider('claude', 'stalled'); },
  });
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', url: `/stalled/${harness.capability}/v1/messages`,
  });
  const res = fakeResponse();
  await harness.mounted(req, res, error => { throw error; });
  harness.timers.fire();

  // This is exactly the object turn-engine reads as `proxyFailure` and hands to
  // evaluateTurnApiError as the raw error (turn-engine.js `rawApiError`).
  const recorded = harness.runtime.proxyFailure(harness.attempt);
  assert.equal(recorded.source, 'proxy_response');
  assert.equal(recorded.httpStatus, null, 'no HTTP status: the upstream never spoke');
  assert.equal(recorded.code, RESPONSE_STALLED_BEFORE_RESPONSE);
  // And this is exactly the object it hands to failoverSafety as attemptFacts.
  const attemptFacts = harness.runtime.snapshot('s1');
  assert.equal(attemptFacts.replayFence, 'none');
  assert.equal(attemptFacts.visibleOutputObserved, false);
  assert.equal(attemptFacts.toolIntentObserved, false);
  assert.equal(attemptFacts.sideEffectObserved, false);

  const decision = decisionFor(recorded);
  assert.equal(decision.error.category, 'timeout');
  assert.equal(decision.error.code, RESPONSE_STALLED_BEFORE_RESPONSE);
  assert.equal(decision.error.phase, 'before_first_token',
    'the turn had not shown the user anything');
  assert.deepEqual(failoverSafety(decision, attemptFacts),
    { ok: true, reason: 'failover_timeout' });

  const { runtime, session } = autoFixture();
  const autoTurn = runtime.beginTurn({ session, turnId: 't1', promptText: 'hello' });
  assert.equal(autoTurn.initial().providerId, 'stalled');
  const failover = autoTurn.failover(decision, attemptFacts);
  assert.equal(failover.invocationOptions.providerId, 'backup');
  assert.equal(failover.fromProviderName, 'Stalled line');
  assert.equal(failover.toProviderName, 'Backup line');
});

test('a stall after visible output is not replayed: it reserves the next line instead', () => {
  const proxyFailure = {
    source: 'proxy_response', provider: 'codex', providerId: 'stalled',
    providerName: 'Stalled line', httpStatus: null, code: STREAM_IDLE_TIMEOUT,
    message: 'upstream request failed', observedAt: 1,
  };
  const decision = decisionFor(proxyFailure, { partialOutput: true });
  const attempt = {
    providerId: 'stalled', replayFence: 'visible_output',
    visibleOutputObserved: true, toolIntentObserved: false, sideEffectObserved: false,
  };
  const safety = failoverSafety(decision, attempt);
  assert.equal(safety.ok, false);
  assert.equal(safety.reason, 'unsafe_failure_phase');
  const { runtime, session } = autoFixture();
  const autoTurn = runtime.beginTurn({ session, turnId: 't1', promptText: 'hello' });
  autoTurn.initial();
  assert.equal(autoTurn.failover(decision, attempt), null);
  const handoff = autoTurn.prepareHandoff(decision, attempt);
  assert.equal(handoff.providerId, 'backup');
  assert.equal(handoff.reasonCode, 'unsafe_failure_phase');
});

// ---------------------------------------------------------------------------
// Wiring: which sessions carry a budget
// ---------------------------------------------------------------------------

test('all chat sessions carry the idle budget, with a compatible Auto override', () => {
  const auto = { id: 's1', providerSelection: { mode: 'auto', candidates: [] } };
  const manual = { id: 's2', providerSelection: { mode: 'manual', candidates: [] } };
  const bare = { id: 's3' };
  assert.equal(resolveAutoStallTimeoutMs(auto, {}), 300_000);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' }), 45_000);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '0' }), 0);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '-1' }), 0);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '1000' }), 15_000,
    'a short budget is clamped up to the reviewed floor');
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '99999999' }), 600_000,
    'a long budget is clamped down to the reviewed ceiling');
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: 'nonsense' }), 300_000);
  assert.equal(resolveAutoStallTimeoutMs(manual, { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' }), 300_000);
  assert.equal(resolveAutoStallTimeoutMs(bare, {}), 300_000);
});

// 公共请求策略回归：虚拟时钟只推进请求时间，不启动真实模型或生产服务。
function virtualClock() {
  let at = 1_000;
  let id = 0;
  const jobs = new Map();
  return {
    now: () => at,
    setTimeout(fn, ms) { const handle = { id: ++id, unref() {} }; jobs.set(handle, { fn, at: at + ms }); return handle; },
    clearTimeout(handle) { jobs.delete(handle); },
    size: () => jobs.size,
    tick(ms) {
      const until = at + ms;
      for (;;) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        at = next[1].at; jobs.delete(next[0]); next[1].fn();
      }
      at = until;
    },
  };
}

const { resolveModelRequestPolicy } = require('../src/chat/model-request-policy');
const { recoverModelTimeout } = require('../src/chat/model-timeout-recovery');
const { withModelConnectWatch } = require('../src/providers/model-connect-watch');
const { createModelStreamProgress } = require('../src/providers/model-stream-progress');

test('native stream progress handles split UTF-8, mixed chunks and oversized frames', () => {
  const progress = createModelStreamProgress();
  const frame = Buffer.from('data: {"type":"response.output_text.delta","delta":"你好🌍"}\r\n\r\n');
  for (const byte of frame.subarray(0, frame.length - 1)) assert.equal(progress(Buffer.from([byte])), false);
  assert.equal(progress(frame.subarray(frame.length - 1)), true);
  assert.equal(progress(': ping\n\ndata: {"type":"message_start"}\n\n'), false);
  assert.equal(progress('x'.repeat(262_145)), false);
  assert.equal(progress('data: {"type":"content_block_start","content_block":{"type":"tool_use"}}\n\n'), false);
  assert.equal(progress(Buffer.from('data: {"type":"content_block_start","content_block":{"type":"tool_use"}}\n\n')), true);
});

test('Rust connection deadlines fire once and cancellation prevents delivery', async () => {
  const { RustRequestTimer } = require('../src/native/runtime').getNative();
  let calls = 0;
  const expired = new RustRequestTimer(10, () => { calls++; });
  const cancelled = new RustRequestTimer(10, () => { calls += 100; });
  cancelled.cancel();
  cancelled.cancel();
  await new Promise(resolve => setTimeout(resolve, 80));
  expired.cancel();
  assert.equal(calls, 1);
});

test('an outstanding Rust connection deadline does not keep Node alive', () => {
  const { spawnSync } = require('node:child_process');
  const runtime = require.resolve('../src/native/runtime');
  const child = spawnSync(process.execPath, ['-e',
    `const { getNative } = require(${JSON.stringify(runtime)}); global.timer = new (getNative().RustRequestTimer)(60000, () => {});`,
  ], { env: process.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('a queued connection timeout cannot retire a request after connection succeeds', async () => {
  const { channel } = require('node:diagnostics_channel');
  const request = {};
  const response = new EventEmitter();
  let calls = 0;
  const context = { attempt: { connectTimeoutMs: 10 }, response,
    stall: { isArmed: () => true, connectTimeout() { calls++; } } };
  withModelConnectWatch(context, () => {
    channel('undici:request:create').publish({ request });
    // Hold JS while Rust expires the timer, then deliver the successful
    // connection event before Node drains the queued callback.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    channel('undici:request:bodySent').publish({ request });
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 0);
  assert.equal(response.listenerCount('close'), 0);
  assert.equal(response.listenerCount('finish'), 0);
});

test('Rust request timers own idle and absolute deadlines and are cancelled on completion', async () => {
  const res = fakeResponse();
  const settled = [];
  const watch = createProxyStallWatch({ protocol: 'claude', requestKind: 'inference', res,
    observation: { settle: event => settled.push(event.errorCode) } });
  assert.equal(watch.arm({ stallTimeoutMs: 20, requestTimeoutMs: 200 }), true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(settled, [RESPONSE_STALLED_BEFORE_RESPONSE]);
  assert.equal(res.destroyed, true);

  const completed = fakeResponse();
  const late = [];
  const finished = createProxyStallWatch({ protocol: 'claude', requestKind: 'inference', res: completed,
    observation: { settle: event => late.push(event) } });
  assert.equal(finished.arm({ stallTimeoutMs: 20, requestTimeoutMs: 30 }), true);
  completed.end();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(late, []);
});

test('公共默认值覆盖所有 CLI，并明确区分深度推理与普通请求', () => {
  for (const cli of ['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'codebuddy']) {
    assert.deepEqual(resolveModelRequestPolicy({ cli }, {}), {
      stallTimeoutMs: 300_000, requestTimeoutMs: 900_000, connectTimeoutMs: 600_000,
    });
    assert.deepEqual(resolveModelRequestPolicy({ cli, effort: 'high' }, {}), {
      stallTimeoutMs: 600_000, requestTimeoutMs: 1_800_000, connectTimeoutMs: 600_000,
    });
  }
  assert.equal(resolveModelRequestPolicy({}, { MULTICC_MODEL_IDLE_TIMEOUT_MS: '1000' }).stallTimeoutMs, 15_000);
  assert.equal(resolveModelRequestPolicy({}, { MULTICC_MODEL_CONNECT_TIMEOUT_MS: '600000' }).connectTimeoutMs, 600_000,
    '显式配置 600 秒不能被旧的 120 秒上限截断');
  const disabled = resolveModelRequestPolicy({}, { MULTICC_MODEL_IDLE_TIMEOUT_MS: '0' });
  assert.equal(disabled.stallTimeoutMs, 0);
  assert.equal(disabled.requestTimeoutMs, 900_000, '关闭空闲计时不取消总预算');
});

test('模型请求预算保留 Auto 兼容入口的优先级和数值边界', () => {
  const auto = { effort: 'ULTRACODE', providerSelection: { mode: 'auto' } };
  assert.deepEqual(resolveModelRequestPolicy(auto, {
    MULTICC_AUTO_STALL_TIMEOUT_MS: '45000.9', MULTICC_MODEL_IDLE_TIMEOUT_MS: null,
    MULTICC_MODEL_REQUEST_TIMEOUT_MS: '-2', MULTICC_MODEL_CONNECT_TIMEOUT_MS: 'Infinity',
  }), { stallTimeoutMs: 45_000, requestTimeoutMs: 30_000, connectTimeoutMs: 600_000 });
  assert.deepEqual(resolveModelRequestPolicy(auto, {
    MULTICC_AUTO_STALL_TIMEOUT_MS: '45000', MULTICC_MODEL_IDLE_TIMEOUT_MS: '',
    MULTICC_MODEL_REQUEST_TIMEOUT_MS: '9999999', MULTICC_MODEL_CONNECT_TIMEOUT_MS: '500',
  }), { stallTimeoutMs: 600_000, requestTimeoutMs: 3_600_000, connectTimeoutMs: 1_000 });
  assert.equal(resolveModelRequestPolicy({ providerSelection: { mode: 'manual' } }, {
    MULTICC_AUTO_STALL_TIMEOUT_MS: '45000',
  }).stallTimeoutMs, 300_000);
  assert.equal(resolveModelRequestPolicy({}, { MULTICC_MODEL_REQUEST_TIMEOUT_MS: 123456n }).requestTimeoutMs, 123_456);
  const frozen = resolveModelRequestPolicy({}, { MULTICC_MODEL_IDLE_TIMEOUT_MS: -0 });
  assert.equal(Object.is(frozen.stallTimeoutMs, -0), false);
  assert.ok(Object.isFrozen(frozen));
});

for (const protocol of ['claude', 'codex']) {
  test(`${protocol}：保活不续期、分片有效事件续期、总截止时间不续期`, () => {
    const clock = virtualClock();
    const res = fakeResponse();
    const failures = [];
    const watch = createProxyStallWatch({ protocol, req: inferenceRequest(protocol), res,
      observation: { settle: event => failures.push(event) }, ...clock });
    watch.arm({ stallTimeoutMs: 100, requestTimeoutMs: 250 });
    const event = protocol === 'claude'
      ? { type: 'content_block_delta', delta: { text: '你好' } }
      : { type: 'response.reasoning_summary_text.delta', delta: '你好' };
    const bytes = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
    clock.tick(80);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keepalive\n\ndata: {"type":"ping"}\n\n');
    assert.equal(watch.progressed(), false);
    res.write(bytes.subarray(0, bytes.length - 6));
    res.write(bytes.subarray(bytes.length - 6));
    assert.equal(watch.progressed(), true);
    clock.tick(80); res.write(bytes);
    clock.tick(80); res.write(bytes);
    assert.equal(res.destroyed, false);
    clock.tick(10);
    assert.equal(res.destroyed, true);
    assert.equal(failures[0].errorCode, MODEL_REQUEST_DEADLINE);
    assert.equal(failures.length, 1);
    assert.equal(clock.size(), 0);
  });

  test(`${protocol}：只有保活仍按首次有效事件超时，正常结束之后长工具不受计时影响`, () => {
    const clock = virtualClock();
    const res = fakeResponse();
    const failures = [];
    const watch = createProxyStallWatch({ protocol, req: inferenceRequest(protocol), res,
      observation: { settle: event => failures.push(event) }, ...clock });
    watch.arm({ stallTimeoutMs: 100, requestTimeoutMs: 250 });
    for (let i = 0; i < 4; i++) { clock.tick(20); res.write('data: {"type":"ping"}\n\n'); }
    clock.tick(20);
    assert.equal(failures[0].errorCode, RESPONSE_STALLED_BEFORE_RESPONSE);
    const next = fakeResponse();
    const nextWatch = createProxyStallWatch({ protocol, req: inferenceRequest(protocol), res: next,
      observation: { settle: () => assert.fail('工具运行期间不应触发请求超时') }, ...clock });
    nextWatch.arm({ stallTimeoutMs: 100, requestTimeoutMs: 250 });
    next.end();
    clock.tick(3_600_000);
    assert.equal(clock.size(), 0);
    assert.equal(next.destroyed, false);
  });

  test(`${protocol}：固定供应商两次失败共享预算，超时关闭常驻 runner，第三次不重放`, () => {
    const clock = virtualClock();
    const runtime = createProviderAttemptRuntime({ runtimeEpoch: 'epoch-budget', now: clock.now });
    const cs = { _activeTurn: { turnId: 't1' } };
    const chatSessions = new Map([['s1', cs]]);
    const stopped = [];
    const chatStream = { cancel: sid => stopped.push(sid) };
    let mounted;
    let admission;
    admission = createProviderProxyAdmission({ protocol,
      app: { use(_path, fn) { mounted = fn; }, post(_path, fn) { mounted = fn; } },
      authorizeProxyRequest: runtime.authorizeProxyRequest, getProvider: () => ({ id: 'p1' }),
      onOutcome: event => {
        const outcome = runtime.observeProxyOutcome(event);
        recoverModelTimeout({ event, outcome, chatSessions, chatStream });
      }, ...clock,
    });
    const handler = () => admission.getProvider(protocol, 'p1');
    admission.app[protocol === 'claude' ? 'use' : 'post']('/test', handler);
    const start = attemptNo => {
      const attempt = beginAttempt(runtime, { cli: protocol, attemptNo, stallTimeoutMs: 100, requestTimeoutMs: 250 });
      cs._activeRunner = { kind: 'stream', providerAttempt: attempt };
      const capability = runtime.proxySessionId(attempt);
      const req = Object.assign(new EventEmitter(), { method: 'POST',
        url: protocol === 'claude' ? `/p1/${capability}/v1/messages` : `/p1/${capability}/main/responses`,
        params: { providerId: 'p1', sessionId: capability, role: 'main' } });
      const res = fakeResponse();
      mounted(req, res, error => { throw error; });
      return { attempt, res };
    };
    const first = start(1);
    clock.tick(100);
    assert.equal(first.res.destroyed, true);
    const failure = runtime.proxyFailure(first.attempt);
    assert.equal(failure.requestDeadlineAt, 1_250);
    assert.equal(failure.retryBudgetExhausted, false);
    assert.equal(stopped.length, 1);
    assert.equal(cs._activeRunner.killReason, undefined, '超时不能伪装成用户取消');
    assert.equal(cs._activeRunner.apiErrorRaw.code, RESPONSE_STALLED_BEFORE_RESPONSE);
    const policy = createApiErrorPolicyRuntime({ now: clock.now });
    const decide = raw => policy.evaluate(raw, { phase: 'before_first_token', partialOutput: false, sideEffects: false });
    // 这里使用极短测试预算，退避已无空间；真实预算另行验证。
    assert.equal(decide(failure).reason, 'request_budget_exhausted');
    runtime.finishAttempt(first.attempt, { outcome: 'failed' });
    clock.tick(25);
    const second = start(2);
    assert.equal(second.attempt.requestDeadlineAt, 1_250);
    clock.tick(100);
    const final = runtime.proxyFailure(second.attempt);
    assert.equal(final.retryBudgetExhausted, true);
    assert.equal(stopped.length, 2);
    assert.equal(decide(final).action, 'fail_fast');
    // Spending the same-provider budget is not an Auto stop condition: the
    // fail-fast answer ends retries on this line and the pool moves on.
    const safety = failoverSafety(decide(final), runtime.snapshot('s1'));
    assert.equal(safety.ok, true, safety.reason);
    assert.equal(safety.reason, 'failover_timeout');
    runtime.finishAttempt(second.attempt, { outcome: 'failed' });
    const fresh = beginAttempt(runtime, { turnId: 't2', requestTimeoutMs: 250 });
    assert.equal(fresh.requestDeadlineAt, null);
    assert.equal(fresh.requestFailures, 0);
  });
}

test('安全超时只自动重试一次；部分输出、工具副作用与预算用尽均明确失败', () => {
  const policy = createApiErrorPolicyRuntime({ now: () => 1000, random: () => 0 });
  const raw = { source: 'proxy_response', code: RESPONSE_STALLED_BEFORE_RESPONSE, requestDeadlineAt: 901_000 };
  const base = { phase: 'before_first_token', partialOutput: false, sideEffects: false };
  assert.equal(policy.evaluate(raw, base).action, 'retry');
  assert.equal(policy.evaluate(raw, { ...base, attempt: 1 }).action, 'fail_fast');
  for (const facts of [{ partialOutput: true }, { sideEffects: true }]) {
    assert.equal(policy.evaluate(raw, { ...base, ...facts }).action, 'fail_fast');
  }
  assert.equal(policy.evaluate({ ...raw, retryBudgetExhausted: true }, base).action, 'fail_fast');
  assert.equal(policy.evaluate({ ...raw, code: MODEL_REQUEST_DEADLINE }, base).action, 'fail_fast');
});

test('子请求和旧 attempt 的超时不能终止当前主 runner', () => {
  const runtime = attemptRuntime();
  const attempt = beginAttempt(runtime, { requestTimeoutMs: 900_000 });
  let stops = 0;
  const cs = { _activeTurn: { turnId: 't1' }, _activeRunner: { kind: 'stream', providerAttempt: attempt } };
  const chatSessions = new Map([['s1', cs]]);
  const event = { ...attempt, roleKind: 'sub', routeAttribution: 'exact', status: 'error', errorCode: STREAM_IDLE_TIMEOUT };
  assert.equal(recoverModelTimeout({ event, outcome: runtime.observeProxyOutcome(event), chatSessions,
    chatStream: { cancel() { stops++; } } }), false);
  assert.equal(recoverModelTimeout({ event: { ...event, turnId: 'old' },
    outcome: { accepted: true, failure: { code: STREAM_IDLE_TIMEOUT } }, chatSessions,
    chatStream: { cancel() { stops++; } } }), false);
  assert.equal(stops, 0);
});

test('真实 Node HTTP 连接在 DNS 悬挂时受连接预算保护', async () => {
  const http = require('node:http');
  const res = fakeResponse();
  let request;
  let timeoutCount = 0;
  const context = { response: res, attempt: { connectTimeoutMs: 30 },
    stall: { isArmed: () => true, connectTimeout() { timeoutCount++; res.destroy(); request.destroy(); } } };
  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('连接计时器没有结束 DNS 悬挂')), 2000);
    withModelConnectWatch(context, () => {
      request = http.get({ hostname: 'model.invalid', lookup() {} });
      request.on('error', () => {});
      request.on('close', () => { clearTimeout(guard); resolve(); });
    });
  });
  assert.equal(timeoutCount, 1);
});

test('真实 Undici 已建立连接后等待响应头，不再受连接预算限制', async () => {
  const http = require('node:http');
  const server = http.createServer((_req, res) => setTimeout(() => res.end('ok'), 80));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = fakeResponse();
  let timeouts = 0;
  const context = { response, attempt: { connectTimeoutMs: 30 },
    stall: { isArmed: () => true, connectTimeout() { timeouts++; } } };
  try {
    const result = await withModelConnectWatch(context, () => fetch(`http://127.0.0.1:${server.address().port}`));
    assert.equal(await result.text(), 'ok');
    assert.equal(timeouts, 0, '连接预算不能误当首字节预算');
  } finally { response.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// HTTP/2 路径不发布 undici:client:sendHeaders（只有 H1 发布）。cli-provider-router 的
// 上游传输固定 allowH2:true，借道走 HTTPS 隧道时会协商 h2，旧实现里连接计时器因此永远
// 等不到结束信号，在第 30 秒把仍在进行的长流式请求当成「连接超时」掐断。
function h2Fixture() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http2 = require('node:http2');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-h2-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (_req, res) => { setTimeout(() => res.end('ok'), 150); });
  return {
    server,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

for (const [label, init] of [['POST 带请求体', { method: 'POST', body: '{"model":"x"}' }], ['无请求体的 GET', {}]]) {
  test(`真实 Undici HTTP/2 已发出请求后等待响应头（${label}），不再受连接预算限制`, async t => {
    try { require('node:child_process').execFileSync('openssl', ['version'], { stdio: 'ignore' }); }
    catch (_) { return t.skip('需要 openssl 生成临时证书'); }
    const { Agent, fetch: request } = require('undici');
    const { server, cleanup } = h2Fixture();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const dispatcher = new Agent({ allowH2: true, connect: { rejectUnauthorized: false } });
    const response = fakeResponse();
    let timeouts = 0;
    const context = { response, attempt: { connectTimeoutMs: 40 },
      stall: { isArmed: () => true, connectTimeout() { timeouts++; } } };
    try {
      const url = `https://127.0.0.1:${server.address().port}/`;
      const result = await withModelConnectWatch(context, () => request(url, { ...init, dispatcher }));
      assert.equal(await result.text(), 'ok');
      // 等待超过连接预算后，计时器也不应迟到触发。
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(timeouts, 0, 'H2 请求已发出，连接预算不能再触发');
    } finally { response.end(); void dispatcher.destroy(); server.close(); cleanup(); }
  });
}

test('同一 CLI 内部的 5xx 重试不再耗尽宿主预算，成功后才为下一模型请求恢复计数', () => {
  const clock = virtualClock();
  const runtime = createProviderAttemptRuntime({ now: clock.now });
  const attempt = beginAttempt(runtime, { requestTimeoutMs: 900_000 });
  const event = { ...attempt, roleKind: 'main', routeAttribution: 'exact',
    requestDeadlineAt: 901_000, status: 'error', statusCode: 502, errorCode: 'UPSTREAM_HTTP_ERROR',
    proxyOutcome: { version: 1, requestId: 'request-a', requestKind: 'inference', termination: 'upstream_failure', httpStatus: 502 } };
  assert.equal(runtime.observeProxyOutcome(event).failure.retryBudgetExhausted, false);
  assert.equal(runtime.snapshot('s1').requestFailures, 1);
  // Claude CLI 自己收到 502 后会立即重试一次。这次物理请求仍然记录失败次数，
  // 但不得判定预算用尽，也不得把线路标成 stalled —— 否则宿主自己的重试和换线
  // 都没机会发生（线上 502 两次即终局的原因）。
  const clientRetry = runtime.observeProxyOutcome({ ...event,
    proxyOutcome: { ...event.proxyOutcome, requestId: 'request-b' } }).failure;
  assert.equal(clientRetry.retryBudgetExhausted, false, '客户端内部重试不能吃光宿主预算');
  assert.equal(runtime.snapshot('s1').requestFailures, 2);
  assert.equal(runtime.snapshot('s1').stalled, false, '5xx 不能封死这条线路');
  const policy = createApiErrorPolicyRuntime({ now: clock.now });
  const decision = policy.evaluate(clientRetry, { phase: 'before_first_token' });
  assert.equal(decision.action, 'retry');
  assert.equal(failoverSafety(decision, runtime.snapshot('s1')).ok, true, '预算不再误伤自动换线');
  // 成功请求才清空计数与截止时间。
  runtime.observeProxyOutcome({ ...event, status: 'success', errorCode: null,
    proxyOutcome: { ...event.proxyOutcome, termination: 'completed', requestId: 'request-c' } });
  assert.equal(runtime.snapshot('s1').requestFailures, 0);
  assert.equal(runtime.snapshot('s1').requestDeadlineAt, null);
});

test('绝对截止时间仍然耗尽请求预算：5xx 免疫不等于无限重试', () => {
  const clock = virtualClock();
  const runtime = createProviderAttemptRuntime({ now: clock.now });
  const attempt = beginAttempt(runtime, { requestTimeoutMs: 900_000 });
  clock.tick(901_000);
  const event = { ...attempt, roleKind: 'main', routeAttribution: 'exact',
    requestDeadlineAt: 901_000, status: 'error', errorCode: 'UPSTREAM_HTTP_ERROR',
    proxyOutcome: { version: 1, requestId: 'request-deadline', requestKind: 'inference', termination: 'upstream_failure', httpStatus: 502 } };
  const failure = runtime.observeProxyOutcome(event).failure;
  assert.equal(failure.retryBudgetExhausted, true);
  assert.equal(runtime.snapshot('s1').stalled, true);
});

test('进程超时的强杀只针对捕获的旧进程，不会杀掉替换后的 runner', () => {
  const clock = virtualClock();
  const signals = [];
  const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    kill: signal => signals.push(signal) });
  const attempt = beginAttempt(attemptRuntime());
  const cs = { _activeTurn: { turnId: 't1' }, _activeRunner: { kind: 'process', providerAttempt: attempt }, claudeProc: proc };
  assert.equal(recoverModelTimeout({ event: attempt, outcome: { accepted: true, failure: { code: MODEL_CONNECT_TIMEOUT } },
    chatSessions: new Map([['s1', cs]]), setTimeout: clock.setTimeout }), true);
  cs.claudeProc = { kill: () => assert.fail('不能杀新进程') };
  clock.tick(1_500);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('真实 Undici 连接悬挂被中止，未准入的 HTTP 请求不受该策略影响', async () => {
  const { Agent, fetch: request } = require('undici');
  const dispatcher = new Agent({ connect() {} });
  const controller = new AbortController();
  const response = fakeResponse();
  let timeouts = 0;
  const context = { response, attempt: { connectTimeoutMs: 30 },
    stall: { isArmed: () => true, connectTimeout() { timeouts++; controller.abort(); response.destroy(); } } };
  const guard = setTimeout(() => controller.abort(), 2000);
  try {
    await assert.rejects(withModelConnectWatch(context,
      () => request('http://model.invalid', { dispatcher, signal: controller.signal })));
    assert.equal(timeouts, 1);
    const channel = require('node:diagnostics_channel').channel('undici:request:create');
    channel.publish({ request: {} }); // 无请求作用域，不能启动计时器。
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(timeouts, 1);
  } finally { clearTimeout(guard); void dispatcher.destroy(); }
});

test('子请求在二次供应商解析后不继承主请求的重试截止时间', () => {
  const clock = virtualClock();
  const res = fakeResponse();
  const watch = createProxyStallWatch({ protocol: 'claude', req: inferenceRequest(), res,
    observation: { settle() {} }, ...clock });
  watch.arm({ requestTimeoutMs: 250, requestDeadlineAt: 1_010, stallTimeoutMs: 0 });
  watch.isolateRetryBudget();
  clock.tick(20);
  assert.equal(res.destroyed, false);
  assert.equal(watch.deadlineAt(), 1_250);
  clock.tick(230);
  assert.equal(res.destroyed, true);
  assert.equal(clock.size(), 0);
});

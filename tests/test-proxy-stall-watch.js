'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  PROXY_STALL_CODES,
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
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
    error: { type: 'upstream_stalled', code: RESPONSE_STALLED_BEFORE_RESPONSE, message: 'upstream sent no data for 120s' },
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
  res.write('event: message_start\n\n');
  res.write('event: content_block_delta\n\n');
  assert.deepEqual(timers.intervals(), [20_000]);
  const before = res.events.length;
  timers.fire();
  assert.deepEqual(res.events.slice(before), ['destroy']);
  assert.equal(res.head, undefined, 'a stream already in flight is not answered again');
  assert.deepEqual(settled, ['upstream_failure']);
  assert.equal(res.destroyed, true);
});

test('every downstream progress signal restarts the idle budget', () => {
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
    () => res.write('chunk-1'),
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
  assert.deepEqual([...PROXY_STALL_CODES], [RESPONSE_STALLED_BEFORE_RESPONSE, STREAM_IDLE_TIMEOUT]);
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

test('a non-Auto attempt (budget 0) keeps today\'s behaviour: no timer, no wrapper, no stall', async () => {
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
      res.write('event: message_start\n\n');
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
  for (const code of PROXY_STALL_CODES) {
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
    assert.deepEqual(events.map(event => event.phase), ['selected', 'switched']);
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

test('only an Auto Provider session carries the stall budget, and the env overrides it', () => {
  const auto = { id: 's1', providerSelection: { mode: 'auto', candidates: [] } };
  const manual = { id: 's2', providerSelection: { mode: 'manual', candidates: [] } };
  const bare = { id: 's3' };
  assert.equal(resolveAutoStallTimeoutMs(auto, {}), 120_000);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' }), 45_000);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '0' }), 0);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '-1' }), 0);
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '1000' }), 15_000,
    'a short budget is clamped up to the reviewed floor');
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: '99999999' }), 600_000,
    'a long budget is clamped down to the reviewed ceiling');
  assert.equal(resolveAutoStallTimeoutMs(auto, { MULTICC_AUTO_STALL_TIMEOUT_MS: 'nonsense' }), 120_000);
  assert.equal(resolveAutoStallTimeoutMs(manual, { MULTICC_AUTO_STALL_TIMEOUT_MS: '45000' }), 0);
  assert.equal(resolveAutoStallTimeoutMs(bare, {}), 0);
});

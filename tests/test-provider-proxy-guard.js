'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { observeProxyRequest } = require('../src/providers/proxy-outcome');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const {
  classifyProviderProxyRoute,
  createProviderProxyAdmission,
  createProviderProxyGuard,
} = require('../src/providers/proxy-guard');

function responseHarness() {
  const state = { status: null, headers: null, body: '' };
  return {
    state,
    res: {
      writeHead(status, headers) { state.status = status; state.headers = headers; },
      end(body) { state.body = String(body || ''); },
    },
  };
}

test('attempt proxy guard authorizes the exact URL route before CPR sees a request', () => {
  const calls = [];
  let nextCalls = 0;
  const guard = createProviderProxyGuard({
    protocol: 'claude',
    authorizeProxyRequest: input => { calls.push(input); return { ok: true }; },
  });
  guard({ method: 'POST', url: '/provider-a/pr1.session.token/v1/messages?beta=1' }, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(calls, [{
    protocol: 'claude', providerId: 'provider-a', sessionId: 'pr1.session.token',
    role: 'main', method: 'POST',
  }]);
});

test('attempt proxy guard rejects stale capabilities without echoing route metadata', () => {
  let nextCalls = 0;
  const guard = createProviderProxyGuard({
    protocol: 'codex', authorizeProxyRequest: () => ({ ok: false, code: 'stale-secret' }),
  });
  const { state, res } = responseHarness();
  guard({ method: 'POST', url: '/provider-a/pr1.session.secret/main/responses' }, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.equal(state.status, 409);
  assert.equal(state.headers['content-type'], 'application/json');
  assert.equal(state.body.includes('stale-secret'), false);
  assert.equal(state.body.includes('pr1.session.secret'), false);
});

test('Claude connectivity probes are answered locally only after attempt authorization', () => {
  for (const suffix of ['', '/', '/api/hello', '/api/hello?source=cli']) {
    for (const authorized of [true, false]) {
      let decisions = 0;
      let forwarded = 0;
      const guard = createProviderProxyGuard({
        protocol: 'claude',
        authorizeProxyRequest: input => {
          decisions += 1;
          assert.equal(input.method, 'HEAD');
          return { ok: authorized };
        },
      });
      const { res, state } = responseHarness();
      guard({ method: 'HEAD', url: `/provider-a/pr1.session.token${suffix}` }, res,
        () => { forwarded += 1; });
      assert.equal(decisions, 1);
      assert.equal(forwarded, 0, 'a probe must never produce upstream error or usage evidence');
      assert.equal(authorized ? res.statusCode : state.status, authorized ? 200 : 409);
      if (authorized) assert.equal(state.body, '');
    }
  }
});

test('the connectivity exception does not swallow model requests or host routes', () => {
  let forwarded = 0;
  const guard = createProviderProxyGuard({
    protocol: 'claude', authorizeProxyRequest: () => ({ ok: true }),
  });
  for (const [method, url] of [
    ['POST', '/provider-a/pr1.session.token/v1/messages'],
    ['HEAD', '/provider-a/pr1.session.token/v1/messages'],
    ['GET', '/provider-a/pr1.session.token/api/hello'],
    ['POST', '/provider-a/pr1.session.token/api/hello'],
    ['HEAD', '/provider-a/pr1.session.token/api/hello/extra'],
    ['HEAD', '/provider-a/remote/api/hello'],
  ]) guard({ method, url }, {}, () => { forwarded += 1; });
  assert.equal(forwarded, 6);
  createProviderProxyGuard({ protocol: 'codex', authorizeProxyRequest: () => ({ ok: true }) })(
    { method: 'HEAD', url: '/provider-a/pr1.session.token/main/api/hello' }, {},
    () => { forwarded += 1; },
  );
  assert.equal(forwarded, 7);
});

test('host-scoped Codex and Claude routes stay outside attempt ownership', () => {
  let authorized = 0;
  let nextCalls = 0;
  const authorizeProxyRequest = () => { authorized += 1; return { ok: false }; };
  const codex = createProviderProxyGuard({ protocol: 'codex', authorizeProxyRequest });
  const claude = createProviderProxyGuard({ protocol: 'claude', authorizeProxyRequest });
  codex({ method: 'POST', url: '/official-provider/responses' }, {}, () => { nextCalls += 1; });
  for (const bucket of ['aux', 'remote', 'speedtest']) {
    claude({ method: 'POST', url: `/provider-a/${bucket}/v1/messages` }, {}, () => { nextCalls += 1; });
  }
  assert.equal(authorized, 0);
  assert.equal(nextCalls, 4);
});

test('unknown Claude route buckets remain fail-closed as attempt routes', () => {
  assert.equal(classifyProviderProxyRoute('claude', [
    'provider-a', 'unknown-bucket', 'v1', 'messages',
  ]).scope, 'attempt');
  let authorized = 0;
  const guard = createProviderProxyGuard({
    protocol: 'claude',
    authorizeProxyRequest: () => { authorized += 1; return { ok: false }; },
  });
  const { state, res } = responseHarness();
  guard({ method: 'POST', url: '/provider-a/unknown-bucket/v1/messages' }, res, () => {});
  assert.equal(authorized, 1);
  assert.equal(state.status, 409);
});

test('host-scoped Claude admission never re-authorizes relay or speedtest provider lookup', async () => {
  let mounted;
  let authorized = 0;
  let providerReads = 0;
  const app = { use(_pathname, handler) { mounted = handler; } };
  const admission = createProviderProxyAdmission({
    protocol: 'claude', app,
    authorizeProxyRequest: () => { authorized += 1; return { ok: false }; },
    getProvider: () => { providerReads += 1; return {}; },
  });
  admission.app.use('/claude-proxy', () => admission.getProvider('claude', 'provider-a'));
  for (const bucket of ['remote', 'speedtest']) {
    await mounted({ method: 'POST', url: `/provider-a/${bucket}/v1/messages` }, {}, error => { throw error; });
  }
  assert.equal(authorized, 0);
  assert.equal(providerReads, 2);
});

test('attempt-scoped Codex Official routes require the exact active capability', () => {
  const calls = [];
  let nextCalls = 0;
  const guard = createProviderProxyGuard({
    protocol: 'codex',
    authorizeProxyRequest: input => { calls.push(input); return { ok: true }; },
  });
  guard({
    method: 'POST',
    url: '/official-provider/pr1.session.capability/main/responses',
  }, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.deepEqual(calls, [{
    protocol: 'codex', providerId: 'official-provider',
    sessionId: 'pr1.session.capability', role: 'main', method: 'POST',
  }]);
});

test('final admission rechecks after async Claude body parsing and blocks upstream lookup', async () => {
  let mounted;
  let releaseBody;
  let authorized = true;
  let providerReads = 0;
  const app = { use(_pathname, handler) { mounted = handler; } };
  const admission = createProviderProxyAdmission({
    protocol: 'claude',
    app,
    authorizeProxyRequest: () => ({ ok: authorized }),
    getProvider: () => { providerReads += 1; return { id: 'provider-a' }; },
  });
  admission.app.use('/claude-proxy', async () => {
    await new Promise(resolve => { releaseBody = resolve; });
    admission.getProvider('claude', 'provider-a');
  });
  const { state, res } = responseHarness();
  const pending = mounted({
    method: 'POST', url: '/provider-a/pr1.session.token/v1/messages',
  }, res, error => { throw error; });
  authorized = false;
  releaseBody();
  await pending;
  assert.equal(providerReads, 0);
  assert.equal(state.status, 409);
});

test('final admission authorizes the Provider decoded from a Claude sub route', async () => {
  let mounted;
  const decisions = [];
  let providerReads = 0;
  const app = { use(_pathname, handler) { mounted = handler; } };
  const admission = createProviderProxyAdmission({
    protocol: 'claude',
    app,
    authorizeProxyRequest: input => {
      decisions.push(input);
      return { ok: input.providerId !== 'provider-unauthorized' };
    },
    getProvider: () => { providerReads += 1; return {}; },
  });
  admission.app.use('/claude-proxy', async () => {
    admission.getProvider('claude', 'provider-unauthorized');
  });
  const { state, res } = responseHarness();
  await mounted({
    method: 'POST', url: '/provider-main/pr1.session.token/v1/messages',
  }, res, error => { throw error; });
  assert.equal(providerReads, 0);
  assert.equal(state.status, 409);
  assert.equal(decisions[0].role, 'sub');
  assert.equal(decisions[0].providerId, 'provider-unauthorized');
});

test('an exception after proxy request activity always closes the producer exactly once', async () => {
  let mounted;
  const activities = [];
  const app = { use(_pathname, handler) { mounted = handler; } };
  const admission = createProviderProxyAdmission({
    protocol: 'claude', app,
    authorizeProxyRequest: () => ({ ok: true }),
    getProvider: () => ({}),
    onActivity: event => activities.push(event),
  });
  admission.app.use('/claude-proxy', async () => {
    admission.onActivity({
      sessionId: 'pr1.session.token', role: 'main', providerId: 'provider-a', phase: 'request',
    });
    const error = new Error('invalid upstream header');
    error.code = 'ERR_INVALID_CHAR';
    throw error;
  });
  let forwardedError = null;
  await mounted({ method: 'POST', url: '/provider-a/pr1.session.token/v1/messages' }, {}, error => {
    forwardedError = error;
  });
  assert.equal(forwardedError.code, 'ERR_INVALID_CHAR');
  assert.deepEqual(activities.map(event => event.phase), ['request', 'end']);
  assert.equal(activities[1].status, 'error');
  assert.equal(activities[1].errorCode, 'ERR_INVALID_CHAR');
});

test('handler rejection never duplicates an end already emitted by CPR', async () => {
  let mounted;
  const activities = [];
  const app = { use(_pathname, handler) { mounted = handler; } };
  const admission = createProviderProxyAdmission({
    protocol: 'claude', app,
    authorizeProxyRequest: () => ({ ok: true }),
    getProvider: () => ({}),
    onActivity: event => activities.push(event),
  });
  admission.app.use('/claude-proxy', async () => {
    admission.onActivity({ sessionId: 'pr1.session.token', role: 'sub', providerId: 'provider-b', phase: 'request' });
    admission.onActivity({ sessionId: 'pr1.session.token', role: 'sub', providerId: 'provider-b', phase: 'end' });
    throw new Error('late handler failure');
  });
  await mounted({ method: 'POST', url: '/provider-a/pr1.session.token/v1/messages' }, {}, () => {});
  assert.deepEqual(activities.map(event => event.phase), ['request', 'end']);
});

test('request outcomes derive disconnect direction from HTTP lifecycle, not error codes', () => {
  for (const protocol of ['claude', 'codex']) {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: protocol === 'claude' ? '/v1/messages' : '/responses' });
    const res = new EventEmitter();
    const observed = observeProxyRequest(protocol, req, res);
    const raw = { status: 'error', statusCode: 200, errorCode: 'CLIENT_ABORTED' };
    assert.equal(observed.outcome(raw).termination, 'upstream_failure', 'a string is not transport evidence');
    res.emit('close');
    const outcome = observed.outcome({ ...raw, errorCode: 'ANY_VENDOR_CODE' });
    assert.equal(outcome.requestKind, 'inference');
    assert.equal(outcome.termination, 'downstream_disconnect');
    assert.equal(observed.outcome({ ...raw, statusCode: 429 }).termination, 'upstream_http_error');
    assert.equal(observed.outcome({ status: 'success', statusCode: 200 }).termination, 'completed');
    assert.equal(observed.outcome(raw).requestId, outcome.requestId);
  }
});

test('concurrent request outcomes keep their own purpose and transport observations', async () => {
  let mounted;
  const observed = [];
  const pending = [];
  const admission = createProviderProxyAdmission({
    protocol: 'claude', app: { use(_path, handler) { mounted = handler; } },
    authorizeProxyRequest: () => ({ ok: true }), getProvider: () => ({}),
    onUsageEvent: event => observed.push(event),
  });
  admission.app.use('/claude-proxy', async (_req, res) => {
    await new Promise(resolve => pending.push(resolve));
    admission.onUsageEvent({ status: 'error', statusCode: res.testStatus, errorCode: 'SAME_CODE' });
  });
  const firstReq = Object.assign(new EventEmitter(), { method: 'HEAD', url: '/p/s/api/hello' });
  const secondReq = Object.assign(new EventEmitter(), { method: 'POST', url: '/p/s/v1/messages' });
  const firstRes = Object.assign(new EventEmitter(), { testStatus: 404 });
  const secondRes = Object.assign(new EventEmitter(), { testStatus: 200 });
  const first = mounted(firstReq, firstRes, error => { throw error; });
  const second = mounted(secondReq, secondRes, error => { throw error; });
  secondRes.emit('close');
  pending[1]();
  await second;
  pending[0]();
  await first;
  assert.deepEqual(observed.map(e => [e.proxyOutcome.requestKind, e.proxyOutcome.termination]), [
    ['inference', 'downstream_disconnect'], ['probe', 'upstream_http_error'],
  ]);
  assert.notEqual(observed[0].proxyOutcome.requestId, observed[1].proxyOutcome.requestId);
});

test('socket events outside async context retain admission identity without consuming usage attribution', async () => {
  const runtime = createProviderAttemptRuntime();
  const attempt = runtime.beginAttempt({ sessionId: 's1', turnId: 't1', cli: 'claude',
    providerId: 'p1', providerName: 'P1', model: 'm1', protocol: 'anthropic', providerRevision: 'r1', attemptNo: 1 });
  const capability = runtime.proxySessionId(attempt);
  const outcomes = [];
  let handler;
  const admission = createProviderProxyAdmission({ protocol: 'claude',
    app: { use(_path, fn) { handler = fn; } },
    authorizeProxyRequest: runtime.authorizeProxyRequest, getProvider: () => ({}),
    onOutcome: event => { outcomes.push(event); runtime.observeProxyOutcome(event); },
  });
  admission.app.use('/claude-proxy', (req, res) => {
    admission.getProvider('claude', 'p1');
    admission.onActivity({ sessionId: capability, providerId: 'p1', role: 'main', phase: 'request' });
    // Real IncomingMessage/ServerResponse events originate outside the ALS
    // scope used to invoke the adapter. The host closure must own this failure.
    res.once('close', () => admission.onUsageEvent({ status: 'error', errorCode: 'UNRECOGNIZED_CODE' }));
  });
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: `/p1/${capability}/v1/messages` });
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  handler(req, res, error => { throw error; });
  await new Promise(resolve => setImmediate(resolve));
  res.emit('close');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].sessionId, 's1');
  assert.equal(outcomes[0].routeAttemptId, attempt.routeAttemptId);
  assert.equal(outcomes[0].proxyOutcome.termination, 'downstream_disconnect');
  assert.ok(runtime.proxyFailure(attempt));
  assert.equal(runtime.proxyFailure(attempt, { resultDurable: true, completion: { version: 1, state: 'completed', settled: true } }), null);
});

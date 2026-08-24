'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProviderProxyAdmission,
  createProviderProxyGuard,
} = require('../src/provider-proxy-guard');

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

test('session-less Codex Official and Claude Aux routes stay outside attempt ownership', () => {
  let authorized = 0;
  let nextCalls = 0;
  const authorizeProxyRequest = () => { authorized += 1; return { ok: false }; };
  const codex = createProviderProxyGuard({ protocol: 'codex', authorizeProxyRequest });
  const claude = createProviderProxyGuard({ protocol: 'claude', authorizeProxyRequest });
  codex({ method: 'POST', url: '/official-provider/responses' }, {}, () => { nextCalls += 1; });
  claude({ method: 'POST', url: '/provider-a/aux/v1/messages' }, {}, () => { nextCalls += 1; });
  assert.equal(authorized, 0);
  assert.equal(nextCalls, 2);
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

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createCodexOfficialRelayHandler,
  isOfficialCodexOAuthProvider,
  mountCodexOfficialRelay,
  readCodexOfficialCredential,
} = require('../src/codex-official-relay');

function officialProvider() {
  return {
    id: 'official',
    appType: 'codex',
    name: 'OpenAI Official',
    settingsConfig: {
      auth: { auth_mode: 'chatgpt', tokens: { access_token: 'stored-snapshot' } },
      config: 'model = "gpt-5.6-sol"\n',
    },
  };
}

function request(body = {}) {
  const req = new EventEmitter();
  req.params = {
    providerId: 'official',
    sessionId: 'pr1.session.attempt-capability',
    role: 'main',
  };
  req.headers = {};
  req.body = body;
  return req;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.jsonBody = value; res.writableEnded = true; return res; };
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  res.write = value => { res.chunks.push(Buffer.from(value)); return true; };
  res.end = value => {
    if (value != null) res.chunks.push(Buffer.from(value));
    res.writableEnded = true;
  };
  res.flushHeaders = () => {};
  return res;
}

function jwt(exp) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
}

test('Official detection is narrow and excludes API-key/custom providers', () => {
  assert.equal(isOfficialCodexOAuthProvider(officialProvider()), true);
  assert.equal(isOfficialCodexOAuthProvider({ ...officialProvider(), appType: 'claude' }), false);
  assert.equal(isOfficialCodexOAuthProvider({
    ...officialProvider(), settingsConfig: { auth: { auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-x' } },
  }), false);
  assert.equal(isOfficialCodexOAuthProvider({
    ...officialProvider(), settingsConfig: { auth: { auth_mode: 'chatgpt' }, proxyTarget: { baseUrl: 'https://api.test' } },
  }), false);
  assert.equal(isOfficialCodexOAuthProvider({
    ...officialProvider(),
    settingsConfig: {
      auth: { auth_mode: 'chatgpt' },
      config: 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.test/v1"\n',
    },
  }), false);
  assert.equal(isOfficialCodexOAuthProvider({
    ...officialProvider(),
    settingsConfig: {
      auth: { auth_mode: 'chatgpt' },
      config: "model_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://api.test/v1'\n",
    },
  }), false);
});

test('credential reader returns only the current access token/account and fails closed', () => {
  const accessToken = jwt(2_000_000_000);
  const value = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, account_id: 'acct-1', refresh_token: 'must-not-return' },
  });
  assert.deepEqual(readCodexOfficialCredential({
    readFileSync: () => value,
    now: () => 1_000_000_000_000,
  }), {
    ok: true,
    accessToken,
    accountId: 'acct-1',
    expiresAt: 2_000_000_000_000,
  });
  assert.deepEqual(readCodexOfficialCredential({ readFileSync: () => { throw new Error('missing'); } }), {
    ok: false, reason: 'credential_unreadable',
  });
  assert.deepEqual(readCodexOfficialCredential({
    readFileSync: () => JSON.stringify({ tokens: { access_token: accessToken } }),
  }), { ok: false, reason: 'account_id_missing' });
});

test('non-Official providers fall through to the existing CPR proxy', async () => {
  let nextCalls = 0;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => ({ appType: 'codex', settingsConfig: { auth: { OPENAI_API_KEY: 'sk-x' } } }),
    fetch: async () => { throw new Error('must not fetch'); },
  });
  await handler(request(), response(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});

test('Official relay swaps host OAuth credentials and streams Responses SSE', async () => {
  const calls = [];
  const activity = [];
  const usage = [];
  const deltas = [];
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'fresh-host-token', accountId: 'acct-host' }),
    onActivity: event => activity.push(event),
    onUsageEvent: event => usage.push(event),
    onDelta: (delta, context) => deltas.push({ delta, context }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const req = request({ model: 'gpt-5.6-sol', input: 'hi', stream: true, store: true });
  const res = response();
  await handler(req, res, () => assert.fail('Official must not fall through'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fresh-host-token');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'acct-host');
  assert.equal(calls[0].init.headers.originator, 'codex_cli_rs');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'gpt-5.6-sol');
  assert.equal(sent.stream, true);
  assert.equal(sent.store, false);
  assert.match(Buffer.concat(res.chunks).toString('utf8'), /response\.completed/);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(activity.map(event => event.phase), ['request', 'first_byte', 'end']);
  assert.equal(activity[0].sessionId, 'pr1.session.attempt-capability');
  assert.equal(activity[0].role, 'main');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].usage, {
    inputTokens: 7, outputTokens: 3, cacheWrite: 0, cacheRead: 0,
  });
  assert.equal(usage[0].sessionId, 'pr1.session.attempt-capability');
  assert.equal(usage[0].routeName, 'main');
  assert.equal(usage[0].source, 'exact');
  assert.equal(usage[0].coverage, 'observed');
  assert.deepEqual(deltas, [{
    delta: { type: 'text', text: 'OK' },
    context: {
      providerId: 'official', sessionId: 'pr1.session.attempt-capability',
      role: 'main', roleKind: 'main', agentRole: null,
      routeName: 'main', model: 'gpt-5.6-sol',
    },
  }]);
});

test('Official relay attributes a controlled Codex agent role as a sub route', async () => {
  const activity = [];
  const usage = [];
  const deltas = [];
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'fresh-host-token', accountId: 'acct-host' }),
    onActivity: event => activity.push(event),
    onUsageEvent: event => usage.push(event),
    onDelta: (delta, context) => deltas.push({ delta, context }),
    fetch: async () => new Response([
      'data: {"type":"response.output_text.delta","delta":"SUB_OK"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const req = request({ model: 'gpt-5.6-sol', input: 'sub', stream: true });
  req.params.role = 'worker';
  await handler(req, response(), () => assert.fail('Official must not fall through'));
  assert.deepEqual(activity.map(event => ({
    phase: event.phase, role: event.role, roleKind: event.roleKind,
    agentRole: event.agentRole, routeName: event.routeName,
  })), [
    { phase: 'request', role: 'sub', roleKind: 'sub', agentRole: 'worker', routeName: 'worker' },
    { phase: 'first_byte', role: 'sub', roleKind: 'sub', agentRole: 'worker', routeName: 'worker' },
    { phase: 'end', role: 'sub', roleKind: 'sub', agentRole: 'worker', routeName: 'worker' },
  ]);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].roleKind, 'sub');
  assert.equal(usage[0].agentRole, 'worker');
  assert.equal(usage[0].routeName, 'worker');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].context.roleKind, 'sub');
  assert.equal(deltas[0].context.agentRole, 'worker');
  assert.equal(deltas[0].context.routeName, 'worker');

  const invalid = request({ model: 'gpt-5.6-sol', input: 'bad role' });
  invalid.params.role = 'aux';
  const invalidResponse = response();
  await handler(invalid, invalidResponse, () => assert.fail('Official must not fall through'));
  assert.equal(invalidResponse.statusCode, 400);
});

test('missing credentials and upstream rejection expose no credential material', async () => {
  const unavailable = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: false, reason: 'access_token_missing' }),
    fetch: async () => assert.fail('must not fetch'),
  });
  let res = response();
  await unavailable(request(), res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.jsonBody.code, 'CODEX_OFFICIAL_OAUTH_UNAVAILABLE');

  const rejected = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'must-not-leak', accountId: 'private-account' }),
    fetch: async () => new Response('Bearer must-not-leak private-account', { status: 401 }),
  });
  res = response();
  await rejected(request(), res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.jsonBody.code, 'CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED');
  assert.equal(JSON.stringify(res.jsonBody).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(res.jsonBody).includes('private-account'), false);
});

test('client abort cancels the host OAuth hop and closes attempt activity', async () => {
  let upstreamSignal;
  const activity = [];
  const usage = [];
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'host-only-token', accountId: 'host-account' }),
    onActivity: event => activity.push(event),
    onUsageEvent: event => usage.push(event),
    fetch: async (_url, init) => {
      upstreamSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted by client')), { once: true });
      });
    },
  });
  const req = request({ model: 'gpt-5.6-sol', input: 'abort me', stream: true });
  const pending = handler(req, response(), () => assert.fail('Official must not fall through'));
  await new Promise(resolve => setImmediate(resolve));
  req.emit('aborted');
  await pending;
  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual(activity.map(event => event.phase), ['request', 'end']);
  assert.equal(activity[1].status, 'error');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].errorCode, 'CLIENT_ABORTED');
});

test('mount uses the attempt-scoped CPR namespace and mounts once per app', () => {
  const routes = [];
  const app = { post: (route, handler) => routes.push({ route, handler }) };
  const options = { getProvider: () => officialProvider(), fetch: async () => new Response(null, { status: 204 }) };
  assert.equal(mountCodexOfficialRelay(app, options), true);
  assert.equal(mountCodexOfficialRelay(app, options), false);
  assert.deepEqual(routes.map(item => item.route), [
    '/codex-proxy/:providerId/:sessionId/:role/responses',
    '/codex-proxy/:providerId/responses',
  ]);
});

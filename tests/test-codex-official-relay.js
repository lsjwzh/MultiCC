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
  req.params = { providerId: 'official' };
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
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'fresh-host-token', accountId: 'acct-host' }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response('data: {"type":"response.completed"}\n\n', {
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
  assert.equal(Buffer.concat(res.chunks).toString('utf8'), 'data: {"type":"response.completed"}\n\n');
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.writableEnded, true);
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

test('mount uses the existing codex-proxy namespace and mounts once per app', () => {
  const routes = [];
  const app = { post: (route, handler) => routes.push({ route, handler }) };
  const options = { getProvider: () => officialProvider(), fetch: async () => new Response(null, { status: 204 }) };
  assert.equal(mountCodexOfficialRelay(app, options), true);
  assert.equal(mountCodexOfficialRelay(app, options), false);
  assert.deepEqual(routes.map(item => item.route), ['/codex-proxy/:providerId/responses']);
});

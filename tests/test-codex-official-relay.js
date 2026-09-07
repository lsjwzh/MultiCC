'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createCodexOfficialRelayHandler,
  isOfficialCodexOAuthProvider,
  mountCodexOfficialRelay,
  readCodexOfficialCredential,
} = require('../src/codex/official-relay');

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
  assert.deepEqual(readCodexOfficialCredential({ readFileSync: () => '{}' }), {
    ok: false, reason: 'access_token_missing',
  });
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

test('only the explicit cc-switch built-in empty official record is compatible', () => {
  const legacy = { id: 'codex-official', appType: 'codex', source: 'ccswitch',
    settingsConfig: { auth: {}, config: '' } };
  assert.equal(isOfficialCodexOAuthProvider(legacy), true);
  assert.equal(isOfficialCodexOAuthProvider({ ...legacy, id: 'empty-custom' }), false);
  assert.equal(isOfficialCodexOAuthProvider({ ...legacy, source: 'local' }), false);
  assert.equal(isOfficialCodexOAuthProvider({ ...legacy,
    settingsConfig: { auth: { auth_mode: 'apikey' }, config: '' } }), false);
  assert.equal(isOfficialCodexOAuthProvider({ ...legacy,
    settingsConfig: { auth: { OPENAI_API_KEY: 'secret' }, config: '' } }), false);
});

test('legacy official reads the current global login and isolated accounts never fall back to it', async () => {
  const reads = [];
  const legacy = { id: 'official', appType: 'codex', source: 'ccswitch',
    settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '' } };
  let provider = legacy;
  let sent = false;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => provider,
    authFile: '/global/auth.json',
    resolveAccountAuthFile: () => '/isolated/auth.json',
    readFileSync: file => {
      reads.push(file);
      if (file !== '/global/auth.json') throw new Error('missing');
      return JSON.stringify({ tokens: { access_token: 'global-token', account_id: 'account' } });
    },
    fetch: async () => { sent = true; return new Response('{}'); },
  });
  await handler(request({ stream: false }), response(), () => {});
  assert.equal(sent, true);
  sent = false;
  provider = { ...legacy, settingsConfig: { ...legacy.settingsConfig,
    officialAccount: { id: '0123456789abcdef' } } };
  const res = response();
  await handler(request(), res, () => {});
  assert.equal(sent, false);
  assert.equal(res.statusCode, 503);
  assert.match(res.jsonBody.error, /独立登录/);
  assert.deepEqual(reads, ['/global/auth.json', '/isolated/auth.json']);
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

test('resuming a cross-provider history converts foreign item IDs without breaking tool pairing', async () => {
  const history = [
    { type: 'message', id: 'msg_user', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    { type: 'function_call', id: 'tool_foreign_a', call_id: 'tool_foreign_a', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call', id: 'tool_foreign_b', call_id: 'tool_foreign_b', name: 'exec_command', arguments: '{"cmd":"date"}' },
    { type: 'function_call_output', id: 'fco_a', call_id: 'tool_foreign_a', output: '/workspace' },
    { type: 'function_call_output', id: 'fco_b', call_id: 'tool_foreign_b', output: 'today' },
    { type: 'function_call', id: 'fc_official', call_id: 'call_official', name: 'exec_command', arguments: '{}' },
    { type: 'function_call', call_id: 'call_without_item_id', name: 'exec_command', arguments: '{}' },
    { type: 'custom_tool_call', id: 'ctc_official', call_id: 'custom_call', name: 'exec', input: '1 + 1' },
    { type: 'reasoning', id: 'rs_official', encrypted_content: 'opaque-reasoning', summary: [] },
  ];
  const original = structuredClone(history);
  let sent;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'host-token', accountId: 'host-account' }),
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      // Reproduce the Official schema check that rejected the live transcript.
      const invalid = sent.input.find(item => item.type === 'function_call' && item.id && !item.id.startsWith('fc'));
      if (invalid) return new Response('Invalid input item id: expected fc prefix', { status: 400 });
      return new Response('data: {"type":"response.completed","response":{}}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const res = response();
  await handler(request({ model: 'gpt-6-astra', input: history, stream: true }), res, () => assert.fail('fallthrough'));
  assert.equal(res.statusCode, 200);
  assert.match(Buffer.concat(res.chunks).toString(), /response.completed/);
  for (const index of [1, 2]) {
    const { id, ...expected } = original[index];
    const { id: convertedId, ...actual } = sent.input[index];
    assert.match(convertedId, /^fc_/);
    assert.deepEqual(actual, expected);
    assert.equal(sent.input[index].call_id, sent.input[index + 2].call_id);
  }
  for (const index of [0, 3, 4, 5, 6, 7, 8]) assert.deepEqual(sent.input[index], original[index]);
  assert.deepEqual(history, original, 'request normalization must not rewrite persisted native history');
});

test('the actual rejection cause survives relay, Codex decoding, policy and user notice', async () => {
  const { createCodexAdapter } = require('../src/cli-adapters/codex');
  const { normalizeApiError, retryNotice } = require('../src/chat/api-error-policy');
  const cause = {
    message: "Invalid 'input[6].id': 'tool_9YShioVyW54hGPy24ul8O3Cg'. Expected an ID that begins with 'fc'.",
    type: 'invalid_request_error', code: 'invalid_value', param: 'input[6].id',
  };
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'private-token', accountId: 'private-account' }),
    fetch: async () => new Response(JSON.stringify({ error: cause, debug: 'never expose this field' }), {
      status: 400, headers: { 'x-request-id': 'upstream-123', 'content-type': 'application/json' },
    }),
  });
  const res = response();
  await handler(request(), res, () => assert.fail('fallthrough'));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonBody.error, { ...cause, requestId: 'upstream-123' });
  assert.equal(res.headers['x-request-id'], 'upstream-123');
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /never expose this field/);
  const adapter = createCodexAdapter({ isResponseCompletedDisconnect: () => false, isTransportDisconnect: () => false });
  // Match the CLI's string-wrapped HTTP body, including an appended route URL.
  const wireMessage = `unexpected status 400 Bad Request: ${JSON.stringify(res.jsonBody)}, url: http://127.0.0.1/codex-proxy/provider/responses`;
  const [decoded] = adapter.decodeEvent({ type: 'turn.failed', error: { message: wireMessage } });
  assert.equal(decoded.message, cause.message);
  assert.equal(decoded.error.httpStatus, 400);
  assert.equal(decoded.error.code, 'invalid_value');
  assert.equal(decoded.error.param, 'input[6].id');
  assert.equal(decoded.error.requestId, 'upstream-123');
  const error = normalizeApiError(decoded.error);
  const notice = retryNotice({ error, action: 'stop' });
  assert.match(notice, /input\[6\]\.id/);
  assert.match(notice, /Expected an ID that begins with 'fc'/);
  assert.doesNotMatch(notice, /upstream rejected the request/);
});

test('one schema rejection repairs only the optional field and then completes normally', async () => {
  const sent = [];
  const logs = [];
  const usage = [];
  const body = { model: 'model', input: [
    { type: 'function_call', id: 'tool_a', call_id: 'tool_a', name: 'exec', arguments: '{}', status: 'completed' },
    { type: 'function_call_output', call_id: 'tool_a', output: 'done' },
  ], stream: true };
  const original = structuredClone(body);
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
    onUsageEvent: event => usage.push(event),
    logger: { warn: (event, fields) => logs.push({ event, fields }) },
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      if (sent.length === 1) return new Response(JSON.stringify({ error: {
        message: "Unknown parameter: 'input[0].status'.", type: 'invalid_request_error', param: 'input[0].status',
      } }), { status: 400 });
      return new Response('data: {"type":"response.completed","response":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const res = response();
  await handler(request(body), res, () => {});
  assert.equal(sent.length, 2);
  assert.match(sent[0].input[0].id, /^fc_/);
  assert.equal(Object.hasOwn(sent[1].input[0], 'status'), false);
  assert.equal(sent[1].input[0].id, sent[0].input[0].id);
  assert.equal(sent[1].input[0].call_id, sent[1].input[1].call_id);
  assert.deepEqual(body, original);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(usage.map(event => event.status), ['success']);
  assert.deepEqual(logs.map(item => item.event), ['model_history_preprocessed', 'model_history_repaired_after_rejection']);
});

test('rejection repair is bounded to one attempt and final errors retain both causes', async () => {
  let calls = 0;
  const usage = [];
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
    onUsageEvent: event => usage.push(event),
    fetch: async () => {
      const field = ++calls === 1 ? 'status' : 'id';
      return new Response(JSON.stringify({ error: { message: `Unknown parameter: 'input[0].${field}'.`, param: `input[0].${field}` } }), { status: 400 });
    },
  });
  const res = response();
  await handler(request({ input: [{ type: 'function_call', id: 'fc_a', status: 'completed', call_id: 'call_a', name: 'exec', arguments: '{}' }] }), res, () => {});
  assert.equal(calls, 2);
  assert.equal(res.statusCode, 400);
  assert.equal(res.jsonBody.error.param, 'input[0].id');
  assert.equal(res.jsonBody.previousError.param, 'input[0].status');
  assert.equal(res.jsonBody.historyRepairs.length, 1);
  assert.deepEqual(usage.map(event => event.status), ['error']);
});

test('unrelated errors and semantic tool fields are never retried by the converter', async () => {
  for (const [status, param] of [[401, 'input[0].id'], [429, 'input[0].status'], [500, 'input[0].status'], [400, 'input[0].arguments']]) {
    let calls = 0;
    const handler = createCodexOfficialRelayHandler({
      getProvider: () => officialProvider(),
      readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
      fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: `Unknown parameter: '${param}'.`, param } }), { status, headers: { 'retry-after': '60' } }); },
    });
    const res = response();
    await handler(request({ input: [{ type: 'function_call', id: 'fc_a', status: 'completed', arguments: '{}' }] }), res, () => {});
    assert.equal(calls, 1);
    assert.equal(res.statusCode, status);
    assert.equal(res.jsonBody.error.param, param);
    assert.equal(res.headers['retry-after'], '60');
  }
});

test('HTTP 200 carrying response.failed remains a failure and is never replayed', async () => {
  const usage = [];
  let calls = 0;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
    onUsageEvent: event => usage.push(event),
    fetch: async () => {
      calls++;
      return new Response('data: {"type":"response.failed","response":{"error":{"code":"invalid_value","message":"invalid tool schema"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const res = response();
  await handler(request(), res, () => {});
  assert.equal(calls, 1);
  assert.deepEqual(usage.map(event => [event.status, event.errorCode]), [['error', 'invalid_value']]);
  assert.match(Buffer.concat(res.chunks).toString(), /invalid tool schema/);
});

test('transport errors preserve nested causes without leaking host credentials', async () => {
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret-token', accountId: 'private-account' }),
    fetch: async () => { throw new Error('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED secret-token private-account'), { code: 'ECONNREFUSED' }) }); },
  });
  const res = response();
  await handler(request(), res, () => {});
  assert.equal(res.statusCode, 502);
  assert.equal(res.jsonBody.error.code, 'ECONNREFUSED');
  assert.match(res.jsonBody.error.message, /ECONNREFUSED/);
  assert.doesNotMatch(JSON.stringify(res.jsonBody), /secret-token|private-account/);
});

test('non-Official Codex routes share preprocessing before the CPR bridge', async () => {
  const body = { input: [{ type: 'function_call', id: 'tool_a', call_id: 'tool_a', name: 'exec', arguments: '{}' }] };
  const req = request(body);
  let forwarded;
  const handler = createCodexOfficialRelayHandler({ getProvider: () => null, fetch: async () => assert.fail('must fall through') });
  await handler(req, response(), () => { forwarded = req.body; });
  assert.match(forwarded.input[0].id, /^fc_/);
  assert.equal(forwarded.input[0].call_id, 'tool_a');
  assert.equal(body.input[0].id, 'tool_a');
});

test('a stream read failure exposes its socket cause without replaying partial output', async () => {
  let calls = 0;
  let reads = 0;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret-token', accountId: 'private-account' }),
    fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        else controller.error(new Error('socket closed', { cause: Object.assign(new Error('ECONNRESET secret-token'), { code: 'ECONNRESET' }) }));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const res = response();
  await handler(request(), res, () => {});
  const output = Buffer.concat(res.chunks).toString();
  assert.equal(calls, 1);
  assert.match(output, /partial/);
  assert.match(output, /response.failed/);
  assert.match(output, /ECONNRESET/);
  assert.doesNotMatch(output, /secret-token/);
});

test('client abort while reading a rejection cancels diagnosis without a second request', async () => {
  let calls = 0;
  let cancelled = false;
  const usage = [];
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
    onUsageEvent: event => usage.push(event),
    fetch: async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 400 }); },
  });
  const req = request();
  const res = response();
  const pending = handler(req, res, () => {});
  await new Promise(resolve => setImmediate(resolve));
  req.emit('aborted');
  await pending;
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(res.jsonBody, undefined);
  assert.deepEqual(usage.map(event => event.errorCode), ['CLIENT_ABORTED']);
});

test('an empty successful upstream response becomes a diagnostic 502', async () => {
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: true, accessToken: 'secret', accountId: 'account' }),
    fetch: async () => new Response(null, { status: 204 }),
  });
  const res = response();
  await handler(request(), res, () => {});
  assert.equal(res.statusCode, 502);
  assert.match(res.jsonBody.error.message, /204 without a response body/);
});

test('missing credentials and upstream rejection expose no credential material', async () => {
  const logs = [];
  const unavailable = createCodexOfficialRelayHandler({
    getProvider: () => officialProvider(),
    readCredential: () => ({ ok: false, reason: 'access_token_missing' }),
    fetch: async () => assert.fail('must not fetch'),
    logger: { warn: (event, fields) => logs.push({ event, fields }) },
  });
  let res = response();
  await unavailable(request(), res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.jsonBody.code, 'CODEX_OFFICIAL_OAUTH_UNAVAILABLE');
  assert.deepEqual(logs, [{ event: 'codex_official_credential_unavailable', fields: {
    providerId: 'official', credentialSource: 'global', reason: 'access_token_missing',
  } }]);

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

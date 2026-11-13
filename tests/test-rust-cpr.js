'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const nodeRouter = require('cli-provider-router');
const { createProviderRouterRuntime } = require('../src/providers/router-runtime');
const { createRustCprRouter } = require('../src/providers/rust-cpr');
const { createClaudeEgressAgentResolver } = require('../src/claude-auth/egress-agent');
const native = require('../src/native/runtime').getNative();
const available = native?.cprProtocolVersion?.() === 1;
if (process.env.MULTICC_REQUIRE_RUST_TESTS === '1') assert.equal(available, true, '必须构建包含 CPR 的 Rust 模块');
const rustTest = (name, fn) => test(name, { skip: !available && '尚未构建 Rust CPR', timeout: 15000 }, fn);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const sse = obj => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const claudeBody = { model: 'sonnet', stream: true, messages: [{ role: 'user', content: '你好' }] };
const claudeStream = sse({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 2 } } })
  + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🌏' } })
  + sse({ type: 'message_delta', usage: { output_tokens: 4 } }) + sse({ type: 'message_stop' });
const responseStream = sse({ type: 'response.output_text.delta', delta: '你好' })
  + sse({ type: 'response.completed', response: { id: 'resp_fixture', output: [], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } } } });

async function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-cpr-'));
  const requests = [], usage = [], activity = [], deltas = [], rates = [], outcomes = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body, url: req.url });
    if (options.upstream) return options.upstream(req, res, requests);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(options.protocol === 'codex' ? responseStream : claudeStream);
  });
  const upstreamUrl = await listen(upstream);
  const entries = options.entries?.(upstreamUrl) || {
    main: { id: 'main', name: '主线路', settingsConfig: { env: { ANTHROPIC_BASE_URL: upstreamUrl, ANTHROPIC_AUTH_TOKEN: 'test-upstream-key', ANTHROPIC_DEFAULT_SONNET_MODEL: 'wire-model[1M]' } } },
    codex: { id: 'codex', name: 'Codex', settingsConfig: { auth: { OPENAI_API_KEY: 'test-codex-key' }, config: `model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "${upstreamUrl}/v1"\nwire_api = "responses"\n` } },
  };
  const providers = { getProvider: (_, id) => entries[id] || null, getProviderSummary: () => null,
    resolveSpawnEnv: () => ({ env: {} }), buildChildEnv: () => ({ env: {} }), resolveSessionWireModel: model => model };
  const runtime = createProviderRouterRuntime({ providers, env: {
    CLAUDE_OFFICIAL_VIA_PROXY: '1', ...options.env }, mode: options.mode || 'legacy',
  dataRoot: root, codexHomesDir: path.join(root, 'codex') });
  const app = express();
  const callbacks = { onUsageObserved: e => usage.push(e), onActivity: e => activity.push(e),
    onDelta: (e, ctx) => deltas.push({ e, ctx }), onRateLimit: e => rates.push(e) };
  const protocol = options.protocol || 'claude';
  if (protocol === 'codex') app.use(express.json({ limit: '50mb' }));
  const mounted = runtime.mountProtocolProxies(app, { protocols: [protocol], ...callbacks,
    onProxyOutcome: e => outcomes.push(e),
    ...(options.authorize ? { authorizeProxyRequest: options.authorize } : {}),
    ...(options.authorizeAsync ? { authorizeProxyRequestAsync: options.authorizeAsync } : {}),
    codexProxyTrace: false,
    ...(protocol === 'claude' ? { claudeProxy: { captureEnabled: false, ...options.proxy?.(upstreamUrl) } }
      : { codexProxy: { ...options.proxy?.(upstreamUrl) } }) });
  app.use((error, req, res, next) => { if (res.headersSent) res.destroy(); else res.status(500).json({ error: error.code || '宿主异常' }); });
  const server = http.createServer(app), base = await listen(server);
  t.after(async () => {
    await Promise.allSettled(Object.values(mounted).map(m => m?.close?.()));
    await Promise.all([close(server), close(upstream)]); fs.rmSync(root, { recursive: true, force: true });
  });
  return { base, entries, runtime, requests, usage, activity, deltas, rates, outcomes,
    post: (url, body, headers = {}) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('Rust CPR 是唯一后端，旧原生模块不能冒充', () => {
  assert.throws(() => createRustCprRouter(nodeRouter, { native: {} }), /版本不匹配/);
});

rustTest('旧的 MULTICC_CPR_BACKEND=node 配置文件被忽略，运行时固定 Rust', async t => {
  const h = await harness(t, { env: { MULTICC_CPR_BACKEND: 'node' } });
  assert.equal(h.runtime.proxyBackend, 'rust');
});

rustTest('Claude 模型改写、请求路径、凭据、SSE 原文和用量正确', async t => {
  const h = await harness(t);
  const res = await h.post('/claude-proxy/main/fixture/v1/messages?beta=true', claudeBody,
    { authorization: 'Bearer downstream-virtual', 'x-api-key': 'downstream-virtual', 'accept-encoding': 'gzip' });
  assert.equal(res.status, 200); assert.equal(await res.text(), claudeStream);
  assert.equal(h.runtime.proxyBackend, 'rust');
  assert.equal(h.requests[0].headers.authorization, 'Bearer test-upstream-key');
  assert.equal(h.requests[0].headers['x-api-key'], undefined);
  assert.equal(h.requests[0].url, '/v1/messages?beta=true');
  assert.equal(JSON.parse(h.requests[0].body).model, 'wire-model');
  assert.equal(Number(h.requests[0].headers['content-length']), Buffer.byteLength(h.requests[0].body));
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].status, 'success');
  assert.equal(h.usage[0].tokens.input, 7); assert.equal(h.usage[0].tokens.output, 4);
  assert.deepEqual(h.activity.map(e => e.phase), ['request', 'first_byte', 'end']);
  assert.equal(h.deltas.length, 1); assert.equal(h.deltas[0].e.type, 'text');
});

rustTest('Claude 流尾重复输入和缓存累计快照不会重复计量，原文透传', async t => {
  const stream = sse({ type: 'message_start', message: { usage: { input_tokens: 38, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } })
    + sse({ type: 'message_delta', usage: { input_tokens: 38, output_tokens: 21, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } })
    + sse({ type: 'message_stop' });
  const h = await harness(t, { upstream: (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream);
  } });
  const response = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(response.status, 200); assert.equal(await response.text(), stream);
  assert.equal(h.usage.length, 1);
  assert.deepEqual(h.usage[0].tokens, { input: 38, output: 21, cacheRead: 2, cacheWrite: 3, total: 59 });
});

rustTest('Claude 未改写请求保留字节和缓存前缀；API_KEY 不转发虚拟 Bearer', async t => {
  const h = await harness(t, { entries: url => ({ main: { settingsConfig: { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'test-api-key' } } } }) });
  const raw = '{ "model" : "claude-test", "messages" : [] , "stream": false }';
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', raw, { authorization: 'Bearer virtual', 'x-api-key': 'virtual' });
  await res.text();
  assert.equal(h.requests[0].body, raw); assert.equal(h.requests[0].headers.authorization, undefined);
  assert.equal(h.requests[0].headers['x-api-key'], 'test-api-key');
});

rustTest('Claude 子路由解码与悬空供应商回退均使用真正被拨号线路的模型', async t => {
  const h = await harness(t);
  let res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'cpr:missing:sonnet' });
  assert.equal(res.status, 200); await res.text();
  assert.equal(JSON.parse(h.requests[0].body).model, 'wire-model'); assert.equal(h.usage[0].roleKind, 'sub');
  h.entries.sub = { name: '子线路', settingsConfig: h.entries.main.settingsConfig };
  res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'ccfw:sub:sonnet' });
  await res.text(); assert.equal(h.usage[1].providerId, 'sub');
});

rustTest('Codex 原生 Responses 流、命名子代理和缓存用量正确', async t => {
  const h = await harness(t, { protocol: 'codex', mode: 'cpr' });
  const res = await h.post('/codex-proxy/codex/fixture/explorer/responses', { model: 'gpt-fixture', input: [], stream: true });
  assert.equal(res.status, 200); assert.equal(await res.text(), responseStream);
  assert.equal(h.runtime.proxyBackend, 'rust');
  assert.equal(h.requests[0].url, '/v1/responses'); assert.equal(h.requests[0].headers.authorization, 'Bearer test-codex-key');
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].tokens.input, 7);
  assert.equal(h.usage[0].tokens.output, 4); assert.equal(h.usage[0].tokens.cacheRead, 5);
  assert.equal(h.usage[0].agentRole, 'explorer');
  assert.deepEqual(h.activity.map(e => e.phase), ['request', 'first_byte', 'end']);
  assert.equal(h.deltas.length, 1); assert.equal(h.deltas[0].e.type, 'text');
});

rustTest('SSE 跨字节中文、工具参数、推理和响应内失败均由 Rust 正确归因', async t => {
  const stream = sse({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } })
    + sse({ type: 'content_block_delta', index: 1, delta: { thinking: '推理🌏' } })
    + sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'read' } })
    + sse({ type: 'content_block_delta', index: 2, delta: { partial_json: '{"路径":"中文"}' } })
    + sse({ type: 'error', error: { message: 'fixture failure' } });
  const h = await harness(t, { upstream: async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(stream);
    for (let i = 0; i < bytes.length; i++) { res.write(bytes.subarray(i, i + 1)); if (i % 25 === 0) await new Promise(resolve => setImmediate(resolve)); }
    res.end();
  } });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(await res.text(), stream);
  assert.equal(h.usage[0].status, 'error'); assert.equal(h.usage[0].errorCode, 'UPSTREAM_RESPONSE_FAILED');
  assert.deepEqual(h.deltas.map(d => d.e), [{ type: 'reasoning', text: '推理🌏' }, { type: 'tool', tool: { name: 'read', arguments: '{"路径":"中文"}' }, toolId: 'tool_1' }]);
});

rustTest('Codex 非流式 JSON 记录用量，401 保留上游错误且不会重试', async t => {
  const h = await harness(t, { protocol: 'codex', upstream: (req, res, requests) => {
    res.writeHead(requests.length === 1 ? 200 : 401, { 'content-type': 'application/json', 'x-fixture-error': 'yes' });
    res.end(requests.length === 1 ? JSON.stringify({ usage: { input_tokens: 9, output_tokens: 2 } }) : '{"error":"fixture rejection"}');
  } });
  let res = await h.post('/codex-proxy/codex/fixture/main/responses', { model: 'gpt-fixture', input: [], stream: false });
  assert.equal(res.status, 200); await res.text(); assert.equal(h.usage[0].tokens.input, 9);
  res = await h.post('/codex-proxy/codex/fixture/main/responses', { input: [] });
  assert.equal(res.status, 401); assert.equal(await res.text(), '{"error":"fixture rejection"}');
  assert.equal(h.requests.length, 2); assert.equal(h.usage[1].errorCode, 'UPSTREAM_HTTP_ERROR');
});

rustTest('Rust 仍经过宿主授权；失效路由和跨供应商子路由都不能拨号', async t => {
  const h = await harness(t, { authorize: arg => ({ ok: arg.providerId === 'main', code: 'attempt_not_active' }) });
  let res = await h.post('/claude-proxy/other/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 409); await res.text();
  res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'cpr:other:sonnet' });
  assert.equal(res.status, 409); await res.text(); assert.equal(h.requests.length, 0);
});

rustTest('异步额度在最终拨号前再次检查，Claude 与 Codex 均不会拨出被封禁线路', async t => {
  for (const protocol of ['claude', 'codex']) {
    let calls = 0;
    const h = await harness(t, { protocol, authorize: () => ({ ok: true }),
      authorizeAsync: async () => ++calls === 1 ? { ok: true } : { ok: false, code: 'quota_guard:5h:99pct' } });
    const res = await h.post(protocol === 'claude' ? '/claude-proxy/main/fixture/v1/messages'
      : '/codex-proxy/codex/fixture/main/responses', protocol === 'claude' ? claudeBody : { model: 'fixture', input: [] });
    assert.equal(res.status, 409);
    await res.text();
    assert.equal(calls, 2);
    assert.equal(h.requests.length, 0);
    const allowed = await harness(t, { protocol, authorize: () => ({ ok: true }),
      authorizeAsync: async () => ({ ok: true, attempt: {} }) });
    const ok = await allowed.post(protocol === 'claude' ? '/claude-proxy/main/fixture/v1/messages'
      : '/codex-proxy/codex/fixture/main/responses', protocol === 'claude' ? claudeBody : { model: 'fixture', input: [] });
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal(allowed.requests.length, 1);
  }
});

rustTest('官方 OAuth 更换凭据后只重拨一次，逻辑用量和结束事件各一次', async t => {
  let token = 'old-test', refreshes = 0;
  const h = await harness(t, { entries: () => ({ main: { name: '官方', settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, readOfficialCredential: () => ({ token }), recoverOfficialCredential: async () => { refreshes++; token = 'new-test'; return { token }; } }),
    upstream: (req, res) => {
      res.writeHead(req.headers.authorization === 'Bearer old-test' ? 401 : 200, { 'content-type': 'application/json' });
      res.end(req.headers.authorization === 'Bearer old-test' ? '{"error":"expired"}' : '{"usage":{"input_tokens":1,"output_tokens":2}}');
    } });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', { model: 'claude-fixture', messages: [] });
  assert.equal(res.status, 200); await res.text(); assert.equal(refreshes, 1); assert.equal(h.requests.length, 2);
  assert.equal(h.usage.length, 1); assert.equal(h.usage[0].status, 'success');
  assert.deepEqual(h.activity.map(e => e.phase), ['request', 'first_byte', 'end']);
  assert.match(h.requests[1].headers['anthropic-beta'], /oauth-2025-04-20/);
});

rustTest('上游拒绝修复在输出前重拨，修复次数有界', async t => {
  const h = await harness(t, { protocol: 'codex', proxy: () => ({ hookRetryMax: 1,
    onUpstreamRejected: ({ body }) => ({ retry: true, body: { ...body, repaired: true } }) }),
    upstream: (req, res, requests) => { res.writeHead(requests.length < 2 ? 400 : 200, { 'content-type': 'text/event-stream' }); res.end(requests.length < 2 ? '{"error":"history"}' : responseStream); } });
  const res = await h.post('/codex-proxy/codex/fixture/main/responses', { model: 'fixture', input: [] });
  assert.equal(res.status, 200); assert.equal(await res.text(), responseStream);
  assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].body).repaired, true); assert.equal(h.usage.length, 1);
});

rustTest('Responses 兼容模式在输出前退避重试繁忙响应，并补齐缺失结束事件', async t => {
  const h = await harness(t, { protocol: 'codex', entries: url => ({ codex: { settingsConfig: { proxyTarget: { mode: 'responses-compat', baseUrl: url + '/responses', apiKey: 'test-key' } } } }),
    upstream: (req, res, requests) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(requests.length === 1 ? sse({ type: 'response.failed', response: { error: { message: 'system is busy' } } })
        : sse({ type: 'response.output_text.delta', delta: '完成' }));
    } });
  const res = await h.post('/codex-proxy/codex/fixture/main/responses', { model: 'fixture', input: [] });
  const text = await res.text(); assert.equal(h.requests.length, 2); assert.doesNotMatch(text, /system is busy/);
  assert.match(text, /response.completed/); assert.match(text, /完成/); assert.equal(h.usage[0].status, 'unobservable');
});

rustTest('客户端在连接期和流期间取消，Rust 释放上游并只结束一次', async t => {
  for (const streaming of [false, true]) {
    let upstreamClosed;
    const closed = new Promise(resolve => { upstreamClosed = resolve; });
    const h = await harness(t, { upstream: (req, res) => {
      res.once('close', upstreamClosed);
      if (streaming) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); }
    } });
    const request = http.request(h.base + '/claude-proxy/main/fixture/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' } });
    const response = new Promise(resolve => request.once('response', resolve));
    request.on('error', () => {}); request.end(JSON.stringify(claudeBody));
    while (!h.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
    if (streaming) await response;
    request.destroy(); await closed;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.usage.length, 1); assert.equal(h.usage[0].errorCode, 'CLIENT_DISCONNECTED');
    assert.equal(h.activity.filter(e => e.phase === 'end').length, 1);
  }
});

rustTest('不支持的协议和上游重定向不会自动借用 Node 或泄露凭据', async t => {
  const h = await harness(t, { protocol: 'codex', upstream: (req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/stolen' }); res.end('redirect'); } });
  let res = await h.post('/codex-proxy/codex/fixture/main/responses', { input: [] });
  assert.equal(res.status, 302); await res.text(); assert.equal(h.requests.length, 1);
  h.entries.codex.settingsConfig.proxyTarget = { mode: 'chat-to-responses', baseUrl: 'http://127.0.0.1:1/chat', apiKey: 'test-key' };
  res = await h.post('/codex-proxy/codex/fixture/main/responses', { input: [] });
  assert.equal(res.status, 400); assert.match(await res.text(), /不支持.*协议模式/); assert.equal(h.requests.length, 1);
});

rustTest('官方账号专用出口确实经插件代理，出口失败时不能直连', async t => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url);
    const forward = http.request(req.url, { method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    forward.on('error', () => res.destroy()); req.pipe(forward);
  });
  const proxyUrl = await listen(proxy); t.after(() => close(proxy));
  let enabled = true, resolutions = 0;
  const resolver = createClaudeEgressAgentResolver({ runPluginCommand: async () => {
    resolutions++;
    return enabled ? { status: 200, payload: { proxyUrl } } : { status: 503, payload: { error: 'fixture unavailable' } };
  }, createAgent: () => { throw new Error('Rust 不应创建 Node Agent'); } });
  const h = await harness(t, { entries: () => ({ main: { name: '官方', egressBinding: { pluginId: 'fixture', profileId: 'account' }, settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, readOfficialCredential: () => ({ token: 'fixture-oauth' }), resolveUpstreamAgent: resolver.resolveUpstreamAgent }) });
  let res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 200); await res.text(); assert.equal(seen.length, 1); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers.authorization, 'Bearer fixture-oauth');
  enabled = false;
  res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 400); await res.text(); assert.equal(h.requests.length, 1); assert.equal(resolutions, 2);
});

rustTest('统一网络策略决定 Rust 出口，策略失败不能静默直连', async t => {
  const seen = [], resolutions = [];
  const proxy = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* 消费代理请求正文。 */ }
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(claudeStream);
  });
  const proxyUrl = await listen(proxy); t.after(() => close(proxy));
  let unavailable = false;
  t.mock.method(require('../src/network/outbound').policy, 'proxyForUrl', async url => {
    resolutions.push(url);
    if (unavailable) throw new Error('fixture-policy-unavailable');
    return proxyUrl;
  });
  const h = await harness(t, { entries: () => ({ main: { settingsConfig: { env: {
    ANTHROPIC_BASE_URL: 'http://rust-cpr-fixture.invalid', ANTHROPIC_API_KEY: 'fixture-key',
  } } } }) });
  let res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 200); assert.equal(await res.text(), claudeStream);
  assert.deepEqual(seen, ['http://rust-cpr-fixture.invalid/v1/messages']);
  assert.deepEqual(resolutions, seen); assert.equal(h.requests.length, 0);
  unavailable = true;
  res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 502); assert.doesNotMatch(await res.text(), /fixture-policy-unavailable/);
  assert.equal(seen.length, 1); assert.equal(h.requests.length, 0);
});

rustTest('限流响应头同时传递 5h 和周额度；HEAD 不拨号、不记账', async t => {
  const h = await harness(t, { upstream: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-5h-utilization': '0.8',
      'anthropic-ratelimit-unified-5h-status': 'allowed_warning', 'anthropic-ratelimit-unified-5h-reset': '1900000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.65', 'anthropic-ratelimit-unified-7d-reset': '1900500000' });
    res.end(claudeStream);
  } });
  let res = await fetch(h.base + '/claude-proxy/main/fixture', { method: 'HEAD' });
  assert.equal(res.status, 200); assert.equal(h.requests.length, 0); assert.equal(h.usage.length, 0);
  res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody); await res.text();
  assert.equal(h.rates.length, 1); assert.equal(h.rates[0].rateLimitInfo.utilization, 0.8);
  assert.equal(h.rates[0].rateLimitInfo.resetsAt, 1900000000);
  assert.deepEqual(h.rates[0].rateLimitInfo.windows.map(w => [w.window, w.usedPercent]), [['5h', 80], ['1wk', 65]]);
  assert.equal(h.requests.length, 1, 'only the conversation request reaches the upstream');
  assert.equal(h.requests[0].url, '/v1/messages');
});

rustTest('周额度单独返回或耗尽时仍上报，响应头缺失时不伪造', async t => {
  let count = 0;
  const h = await harness(t, { upstream: (_req, res) => {
    count++;
    const headers = count === 3 ? {} : { 'anthropic-ratelimit-unified-7d-utilization': count === 1 ? '0.65' : '1',
      'anthropic-ratelimit-unified-7d-reset': '1900500000' };
    res.writeHead(count === 2 ? 429 : 200, { 'content-type': 'application/json', ...headers });
    res.end(count === 2 ? '{"error":{"type":"rate_limit_error"}}' : '{}');
  } });
  for (let i = 0; i < 3; i++) {
    const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
    assert.equal(res.status, i === 1 ? 429 : 200);
    await res.text();
  }
  assert.equal(h.rates.length, 2);
  assert.equal(h.rates[0].rateLimitInfo.rateLimitType, 'weekly');
  assert.equal(h.rates[1].rateLimitInfo.windows[0].usedPercent, 100);
  assert.equal(h.requests.length, 3);
});

rustTest('429 额度墙带 x-should-retry: false，普通限流保持可重试', async t => {
  let count = 0;
  const h = await harness(t, { upstream: (_req, res) => {
    count++;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(count === 1
      ? '{"error":{"type":"rate_limit_error","message":"You have exceeded the 5-hour usage quota."}}'
      : '{"error":{"type":"rate_limit_error","message":"rate limit exceeded, please retry after 2s"}}');
  } });
  let res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 429); assert.equal(res.headers.get('x-should-retry'), 'false'); await res.text();
  res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 429); assert.equal(res.headers.get('x-should-retry'), null); await res.text();
});

rustTest('429 结算事件透传结构化 rejection，旧原生模块不新增字段', async t => {
  const rejection = { kind: 'window', scope: 'account', window: '5h', resetMs: 1790000000000,
    code: 'five_hour', model: 'wire-model', source: 'headers' };
  // 假原生交换让错误正文路径可控：只需要 open/errorBody/close/abort。
  const fakeNative = extra => ({
    RustProviderRequest: native.RustProviderRequest,
    authorizeProviderRequest: native.authorizeProviderRequest,
    codexOfficialError: native.codexOfficialError,
    cprProtocolVersion: () => 1,
    cprRequestLifecycleVersion: () => 3,
    cprRoute: async () => JSON.stringify({ protocol: 'claude', providerId: 'main', mainProviderId: 'main',
      sessionId: 'fixture-session', role: 'main', agentRole: '', routeName: 'main', model: 'wire-model',
      apiPath: '/v1/messages', query: '', isStream: false }),
    // proxyUrl 非空即跳过宿主出口解析；连接不会被真正拨号。
    cprPrepare: async () => JSON.stringify({ plan: { route: { model: 'wire-model', isStream: false, protocol: 'claude' },
      providerName: '主线路', url: 'http://rejection-fixture.invalid/v1/messages', method: 'POST', headers: {}, body: '{}',
      mode: 'raw', proxyUrl: 'http://rejection-fixture.invalid:9' } }),
    cprCreateExchange: async () => ({
      open: async () => JSON.stringify({ status: 429, headers: {}, isStream: false, rateLimit: null }),
      errorBody: async () => ({ data: Buffer.from('{"error":{"type":"rate_limit_error"}}'), complete: true, noRetry: true, ...extra }),
      read: async () => { throw new Error('unreachable'); }, close: async () => {}, abort: () => {},
    }),
  });
  for (const [label, extra, expected] of [
    ['新原生模块', { rejection: JSON.stringify(rejection) }, rejection],
    ['旧原生模块', {}, undefined],
  ]) {
    const events = [];
    const router = createRustCprRouter(nodeRouter, { native: fakeNative(extra), env: {} });
    const app = express();
    const mounted = router.mountClaudeProxy(app, { claudeProxyPath: '/cpr-rejection',
      hopCredentials: { verify: () => ({ ok: true, managed: false }) },
      getProvider: () => ({ id: 'main', name: '主线路', settingsConfig: { env: {} } }),
      onUsageEvent: event => events.push(event) });
    const server = http.createServer(app), base = await listen(server);
    t.after(async () => { await mounted.close(); await close(server); });
    const res = await fetch(`${base}/cpr-rejection/main/fixture/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(claudeBody) });
    assert.equal(res.status, 429, label);
    assert.equal(await res.text(), '{"error":{"type":"rate_limit_error"}}', label);
    assert.equal(res.headers.get('x-should-retry'), 'false', label);
    assert.equal(events.length, 1, label);
    if (expected) assert.deepEqual(events[0].rejection, expected, label);
    else assert.equal('rejection' in events[0], false, label);
  }
});

rustTest('首包等待有上限，错误回调不会包含上游地址或能力令牌', async t => {
  const h = await harness(t, { proxy: () => ({ headersTimeoutMs: 25 }), upstream: () => {} });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 502); const text = await res.text(); assert.match(text, /UPSTREAM_HEADERS_TIMEOUT/);
  assert.doesNotMatch(text, /test-upstream-key|127\.0\.0\.1/); assert.equal(h.usage[0].errorCode, 'UPSTREAM_HEADERS_TIMEOUT');
});

rustTest('Rust 上游 CONNECT 悬挂按当前请求连接预算退出并归因', async t => {
  const proxy = http.createServer();
  const sockets = new Set();
  let connections = 0;
  proxy.on('connect', (_request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Keep the CONNECT handshake open so the test does not depend on the
    // machine's DNS or external network.
    if (++connections === 2) setTimeout(() => socket.destroy(), 150);
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await close(proxy); });
  const resolver = () => null;
  resolver.resolveProxyUrl = async () => proxyUrl;
  const attempt = { sessionId: 'fixture', turnId: 't1', routeAttemptId: 'r1',
    connectTimeoutMs: 60, stallTimeoutMs: 1000, requestTimeoutMs: 5000 };
  const h = await harness(t, {
    authorize: args => ({ ok: true, attempt: { ...attempt,
      connectTimeoutMs: args.sessionId === 'second' ? 500 : 60 } }),
    entries: () => ({ main: { id: 'main', name: 'test', settingsConfig: { env: {
      ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_AUTH_TOKEN: 'test-key',
    } } } }),
    proxy: () => ({ resolveUpstreamAgent: resolver }),
  });
  // The watchdog writes a complete 504 before destroying the socket. Depending
  // on local buffering the client may instead observe that destruction first.
  const response = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody).catch(() => null);
  if (response) {
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'model_connect_timeout');
  }
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0].errorCode, 'model_connect_timeout');
  assert.equal(h.outcomes[0].proxyOutcome.termination, 'upstream_failure');
  assert.equal(h.outcomes[0].routeAttemptId, 'r1');
  const second = await h.post('/claude-proxy/main/second/v1/messages', claudeBody);
  assert.equal(second.status, 502);
  assert.match(await second.text(), /UPSTREAM_CONNECT_FAILED/);
  assert.equal(h.outcomes.length, 2);
  assert.notEqual(h.outcomes[1].errorCode, 'model_connect_timeout',
    'same proxy with a larger budget must not reuse the short-timeout client');
});

rustTest('Rust 传输的有效 SSE 帧续期空闲预算而无需 Node 再解析', async t => {
  const toolStart = sse({ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'fixture', name: 'test', input: {} } });
  const stop = sse({ type: 'message_stop' });
  // Send progress immediately, then span multiple idle budgets. A generous
  // per-frame margin keeps runner scheduling jitter out of the silence test.
  const stallTimeoutMs = 1500, frameCount = 13, sentAt = [];
  const h = await harness(t, {
    authorize: () => ({ ok: true, attempt: { sessionId: 'fixture', turnId: 't1', routeAttemptId: 'r1',
      connectTimeoutMs: 3000, stallTimeoutMs, requestTimeoutMs: 10000 } }),
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const write = () => { sentAt.push(performance.now()); res.write(toolStart); };
      write();
      let count = 1;
      const timer = setInterval(() => {
        if (++count <= frameCount) write();
        else { clearInterval(timer); res.end(stop); }
      }, 250);
      res.once('close', () => clearInterval(timer));
    },
  });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 200);
  const body = await res.text().catch(error => {
    error.message += `; frames=${sentAt.length}; gapsMs=${JSON.stringify(sentAt.slice(1).map((at, i) => Math.round(at - sentAt[i])))}; timeouts=${JSON.stringify(h.outcomes.map(outcome => outcome.errorCode))}`;
    throw error;
  });
  assert.equal(body, toolStart.repeat(frameCount) + stop);
  assert.ok(sentAt.at(-1) - sentAt[0] > stallTimeoutMs * 1.5,
    'valid progress must keep the stream alive beyond its initial idle budget');
  assert.equal(h.deltas.length, 0, 'the tool-start frame must itself renew the watchdog');
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0].proxyOutcome.termination, 'completed');
});

rustTest('Rust 流计时器在首条有效帧前和进度后分别归因，并关闭上游', async t => {
  // This budget includes admission and dialing. Leave startup room on shared
  // runners so both cases reach the upstream whose stream teardown is tested.
  const stallTimeoutMs = 1500;
  for (const progress of [false, true]) {
    let closed;
    const upstreamClosed = new Promise(resolve => { closed = resolve; });
    const frame = sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } });
    const h = await harness(t, {
      authorize: () => ({ ok: true, attempt: { sessionId: 'fixture', turnId: 't1', routeAttemptId: 'r1',
        connectTimeoutMs: 1000, stallTimeoutMs, requestTimeoutMs: 8000 } }),
      upstream: (_req, res) => {
        res.once('close', closed);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        if (progress) res.write(frame);
        else res.write(': keepalive\n\n');
      },
    });
    // The timeout can close the downstream before fetch delivers its headers.
    // Either transport surface must preserve the same timeout and cleanup facts.
    const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody).catch(() => null);
    if (res) { assert.equal(res.status, 200); await res.text().catch(() => {}); }
    let closeTimer;
    try {
      await Promise.race([upstreamClosed, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error(`upstream not closed; progress=${progress}; requests=${h.requests.length}; outcomes=${JSON.stringify(h.outcomes.map(o => o.errorCode))}`)), 2500);
      })]);
    } finally { clearTimeout(closeTimer); }
    assert.equal(h.requests.length, 1);
    assert.equal(h.outcomes.length, 1);
    assert.equal(h.outcomes[0].errorCode, progress ? 'stream_idle_timeout' : 'response_stalled_before_response');
    assert.equal(h.outcomes[0].proxyOutcome.termination, 'upstream_failure');
  }
});

rustTest('Rust 流持续输出时总截止仍生效且不被空闲续期延长', async t => {
  const frame = sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } });
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const h = await harness(t, {
    authorize: () => ({ ok: true, attempt: { sessionId: 'fixture', turnId: 't1', routeAttemptId: 'r1',
      connectTimeoutMs: 1000, stallTimeoutMs: 700, requestTimeoutMs: 340 } }),
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      const timer = setInterval(() => res.write(frame), 70);
      res.once('close', () => { clearInterval(timer); closed(); });
    },
  });
  const started = Date.now();
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 200);
  await res.text().catch(() => {});
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not closed')), 2500))]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0].errorCode, 'model_request_deadline');
});

rustTest('Rust 流的客户端取消与计时竞争只终结一次，不留下上游连接', async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const h = await harness(t, {
    authorize: () => ({ ok: true, attempt: { sessionId: 'fixture', turnId: 't1', routeAttemptId: 'r1',
      connectTimeoutMs: 1000, stallTimeoutMs: 220, requestTimeoutMs: 2000 } }),
    upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      res.write(': ready\n\n'); res.once('close', closed);
    },
  });
  const controller = new AbortController();
  const res = await fetch(h.base + '/claude-proxy/main/fixture/v1/messages', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(claudeBody), signal: controller.signal });
  assert.equal(res.status, 200);
  controller.abort();
  await res.text().catch(() => {});
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not closed')), 2500))]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(h.outcomes.length, 1);
  assert.notEqual(h.outcomes[0].errorCode, 'stream_idle_timeout');
  assert.notEqual(h.outcomes[0].errorCode, 'response_stalled_before_response');
});

rustTest('超大 OAuth 错误原样转发，宿主不恢复、不重复记账', async t => {
  const errorBody = '测'.repeat(30 * 1024);
  let recoveries = 0;
  const h = await harness(t, { entries: () => ({ main: { settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, readOfficialCredential: () => ({ token: 'fixture-oauth' }), recoverOfficialCredential: async () => { recoveries++; return { token: 'new-fixture' }; } }),
    upstream: (req, res) => { res.writeHead(401); res.end(errorBody); } });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 401); assert.equal(await res.text(), errorBody);
  assert.equal(recoveries, 0); assert.equal(h.usage.length, 1);
});

rustTest('未结束的 OAuth 错误由宿主超时取消，上游连接不会遗留', async t => {
  let closedUpstream, recoveries = 0;
  const closed = new Promise(resolve => { closedUpstream = resolve; });
  const h = await harness(t, { entries: () => ({ main: { settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, authErrorTimeoutMs: 40, readOfficialCredential: () => ({ token: 'fixture-oauth' }), recoverOfficialCredential: async () => { recoveries++; return { token: 'new-fixture' }; } }),
    upstream: (req, res) => { res.once('close', closedUpstream); res.writeHead(401, { 'content-length': '999' }); res.write('{"error":'); } });
  await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody).then(res => res.text()).catch(() => {});
  await closed;
  assert.equal(recoveries, 0); assert.equal(h.requests.length, 1); assert.equal(h.activity.filter(e => e.phase === 'end').length, 1);
});

rustTest('Rust 官方 Codex 代理使用当前账号凭据，隔离私有请求头并保留流和用量', async t => {
  let token = 'fixture-current';
  const h = await harness(t, { protocol: 'codex',
    entries: () => ({ official: { id: 'official', appType: 'codex', name: '官方测试账号',
      settingsConfig: { auth: { auth_mode: 'chatgpt' }, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } } } }),
    proxy: upstream => ({ codexOfficialRelay: { upstreamUrl: `${upstream}/backend-api/codex/responses`,
      readCredential: async ({ provider }) => { assert.equal(provider.id, 'official'); return { ok: true, accessToken: token, accountId: 'fixture-account' }; } } }),
  });
  const body = { model: 'fixture-model', stream: true, store: true, input: [{ type: 'reasoning', content: [{ type: 'text', text: 'private-schema' }], encrypted_content: 'opaque' }] };
  const response = await h.post('/codex-proxy/official/session/main/responses', body, {
    authorization: 'Bearer borrower-capability', 'chatgpt-account-id': 'wrong-account', 'x-multicc-private': 'internal', 'x-forwarded-for': '198.51.100.1', 'x-access-token': 'host-secret', originator: 'codex-fixture' });
  assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0];
  assert.equal(sent.headers.authorization, 'Bearer fixture-current');
  assert.equal(sent.headers['chatgpt-account-id'], 'fixture-account');
  assert.equal(sent.headers['x-multicc-private'], undefined); assert.equal(sent.headers['x-access-token'], undefined);
  assert.equal(sent.headers['x-forwarded-for'], undefined); assert.equal(sent.headers.originator, 'codex-fixture');
  const sentBody = JSON.parse(sent.body);
  assert.equal(sentBody.store, false); assert.equal(sentBody.input[0].content, undefined);
  assert.ok(h.usage.length > 0);
  token = 'fixture-rotated';
  await (await h.post('/codex-proxy/official/session/main/responses', body)).text();
  assert.equal(h.requests[1].headers.authorization, 'Bearer fixture-rotated');
});

rustTest('Rust 官方 Codex 账号缺失时不读取全局登录，也不拨上游', async t => {
  const h = await harness(t, { protocol: 'codex',
    entries: () => ({ official: { id: 'official', appType: 'codex', settingsConfig: { auth: { auth_mode: 'chatgpt' }, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } } } }),
    proxy: upstream => ({ codexOfficialRelay: { upstreamUrl: upstream, resolveAccountAuthFile: () => null } }),
  });
  const response = await h.post('/codex-proxy/official/session/main/responses', { model: 'fixture', input: 'hello' });
  assert.equal(response.status, 503); assert.equal((await response.json()).reason, 'account_credential_unresolved');
  assert.equal(h.requests.length, 0);
});

rustTest('Rust 官方上游错误不能把宿主 OAuth 令牌或账号传给借用方', async t => {
  const h = await harness(t, { protocol: 'codex',
    entries: () => ({ official: { id: 'official', appType: 'codex', settingsConfig: { auth: { auth_mode: 'chatgpt' } } } }),
    proxy: upstream => ({ codexOfficialRelay: { upstreamUrl: upstream,
      readCredential: async () => ({ ok: true, accessToken: 'fixture-private-token', accountId: 'fixture-private-account' }) } }),
    upstream: (_, res) => { res.writeHead(403); res.end(JSON.stringify({ error: { message: 'Denied fixture-private-token for fixture-private-account' } })); },
  });
  const response = await h.post('/codex-proxy/official/session/main/responses', { model: 'fixture', input: 'hello' });
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.doesNotMatch(text, /fixture-private/); assert.match(text, /REDACTED/);
});

rustTest('Rust Claude 指定账号没有凭据端口时明确拒绝，不查询共享登录', async t => {
  const h = await harness(t, {
    entries: () => ({ account: { id: 'account', appType: 'claude', settingsConfig: { env: {}, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } } } }),
  });
  const response = await h.post('/claude-proxy/account/session/v1/messages', claudeBody);
  assert.equal(response.status, 502); assert.match(await response.text(), /account_credential_unresolved/);
  assert.equal(h.requests.length, 0); assert.equal(h.usage.length, 1);
});

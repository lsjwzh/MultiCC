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
const { createRustCprRouter, resolveCprBackend } = require('../src/providers/rust-cpr');
const { createClaudeEgressAgentResolver } = require('../src/claude-auth/egress-agent');
const { mountCprBackendSettingsRoutes } = require('../src/routes/cpr-backend-settings');
const native = require('../src/native/runtime').getNative('cpr', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
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

async function harness(t, backend, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-cpr-'));
  const requests = [], usage = [], activity = [], deltas = [], rates = [];
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
  const runtime = createProviderRouterRuntime({ providers, env: { MULTICC_CPR_BACKEND: backend,
    CLAUDE_OFFICIAL_VIA_PROXY: '1' }, mode: options.mode || 'legacy', dataRoot: root, codexHomesDir: path.join(root, 'codex') });
  const app = express();
  const callbacks = { onUsageObserved: e => usage.push(e), onActivity: e => activity.push(e),
    onDelta: (e, ctx) => deltas.push({ e, ctx }), onRateLimit: e => rates.push(e) };
  const protocol = options.protocol || 'claude';
  if (protocol === 'codex') app.use(express.json({ limit: '50mb' }));
  const mounted = runtime.mountProtocolProxies(app, { protocols: [protocol], ...callbacks,
    ...(options.authorize ? { authorizeProxyRequest: options.authorize } : {}),
    codexProxyTrace: false,
    ...(protocol === 'claude' ? { claudeProxy: { captureEnabled: false, ...options.proxy?.(upstreamUrl) } }
      : { codexProxy: { ...options.proxy?.(upstreamUrl) } }) });
  app.use((error, req, res, next) => { if (res.headersSent) res.destroy(); else res.status(500).json({ error: error.code || '宿主异常' }); });
  const server = http.createServer(app), base = await listen(server);
  t.after(async () => {
    await Promise.allSettled(Object.values(mounted).map(m => m?.close?.()));
    await Promise.all([close(server), close(upstream)]); fs.rmSync(root, { recursive: true, force: true });
  });
  return { base, entries, runtime, requests, usage, activity, deltas, rates,
    post: (url, body, headers = {}) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}

test('隐藏开关默认 Node，非法值失败，旧原生模块不能冒充 Rust CPR', () => {
  assert.equal(resolveCprBackend({}), 'node'); assert.equal(resolveCprBackend({ MULTICC_CPR_BACKEND: ' Rust ' }), 'rust');
  assert.throws(() => resolveCprBackend({ MULTICC_CPR_BACKEND: 'auto' }), /只支持/);
  assert.throws(() => createRustCprRouter(nodeRouter, { native: {} }), /版本不匹配/);
});

async function settingsHarness(t, overrides = {}) {
  let config = {}, writes = [];
  const runtime = { proxyBackend: 'node' };
  const app = express(); app.use(express.json());
  mountCprBackendSettingsRoutes(app, { runtime, getNative: () => native,
    readEnvFile: () => ({ UNRELATED: 'fixture-other-value', ...config }),
    writeEnvFile: updates => { writes.push(updates); config = { ...config, ...updates }; }, ...overrides });
  const server = http.createServer(app), base = await listen(server);
  t.after(() => close(server));
  return { runtime, writes, config: () => config,
    read: () => fetch(base + '/api/settings/cpr-backend'),
    save: body => fetch(base + '/api/settings/cpr-backend', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}

rustTest('设置入口保存和撤回待重启选择，当前运行版本保持不变', async t => {
  const h = await settingsHarness(t);
  let view = await (await h.read()).json();
  assert.equal(view.currentBackend, 'node'); assert.equal(view.configuredBackend, 'node');
  assert.equal(view.restartRequired, false); assert.equal(view.rustAvailable, true);
  view = await (await h.save({ backend: 'rust', UNRELATED: 'must-not-save' })).json();
  assert.equal(view.currentBackend, 'node'); assert.equal(view.configuredBackend, 'rust');
  assert.equal(view.restartRequired, true); assert.equal(h.runtime.proxyBackend, 'node');
  assert.deepEqual(h.writes, [{ MULTICC_CPR_BACKEND: 'rust' }]);
  assert.equal((await (await h.read()).json()).configuredBackend, 'rust');
  view = await (await h.save({ backend: 'node' })).json();
  assert.equal(view.restartRequired, false); assert.equal(view.currentBackend, 'node');
  assert.doesNotMatch(JSON.stringify(view), /UNRELATED|fixture-other-value|updates/);
});

rustTest('设置入口拒绝非法值和不可用 Rust，同时允许回退 Node', async t => {
  const h = await settingsHarness(t, { getNative: () => ({ cprBackendSettings: native.cprBackendSettings }) });
  for (const value of [undefined, true, {}, 'auto', 'rust\nOTHER=1']) {
    const response = await h.save({ backend: value });
    assert.equal(response.status, 400); await response.text();
  }
  let response = await h.save({ backend: 'rust' });
  assert.equal(response.status, 503); await response.text(); assert.equal(h.writes.length, 0);
  response = await h.save({ backend: 'node' });
  assert.equal(response.status, 200); await response.text(); assert.equal(h.writes.length, 1);
});

rustTest('设置写入失败不会伪报已保存，也不会公开配置路径或敏感正文', async t => {
  const h = await settingsHarness(t, { writeEnvFile: () => { throw Error('/private/fixture/config fixture-sensitive-text'); } });
  const response = await h.save({ backend: 'rust' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private|fixture-sensitive-text/);
  assert.equal((await (await h.read()).json()).configuredBackend, 'node');
});

rustTest('Node 与 Rust 差分：Claude 模型改写、请求路径、凭据、SSE 原文和用量一致', async t => {
  const results = [];
  for (const backend of ['node', 'rust']) {
    const h = await harness(t, backend);
    const res = await h.post('/claude-proxy/main/fixture/v1/messages?beta=true', claudeBody,
      { authorization: 'Bearer downstream-virtual', 'x-api-key': 'downstream-virtual', 'accept-encoding': 'gzip' });
    assert.equal(res.status, 200); assert.equal(await res.text(), claudeStream);
    assert.equal(h.runtime.proxyBackend, backend);
    assert.equal(h.requests[0].headers.authorization, 'Bearer test-upstream-key');
    assert.equal(h.requests[0].headers['x-api-key'], undefined);
    assert.equal(h.requests[0].url, '/v1/messages?beta=true');
    assert.equal(JSON.parse(h.requests[0].body).model, 'wire-model');
    assert.equal(Number(h.requests[0].headers['content-length']), Buffer.byteLength(h.requests[0].body));
    results.push({ tokens: h.usage[0].tokens, status: h.usage[0].status, phases: h.activity.map(e => e.phase), deltas: h.deltas.map(d => d.e) });
  }
  assert.deepEqual(results[1], results[0]);
});

rustTest('Claude 未改写请求保留字节和缓存前缀；API_KEY 不转发虚拟 Bearer', async t => {
  const h = await harness(t, 'rust', { entries: url => ({ main: { settingsConfig: { env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'test-api-key' } } } }) });
  const raw = '{ "model" : "claude-test", "messages" : [] , "stream": false }';
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', raw, { authorization: 'Bearer virtual', 'x-api-key': 'virtual' });
  await res.text();
  assert.equal(h.requests[0].body, raw); assert.equal(h.requests[0].headers.authorization, undefined);
  assert.equal(h.requests[0].headers['x-api-key'], 'test-api-key');
});

rustTest('Claude 子路由解码与悬空供应商回退均使用真正被拨号线路的模型', async t => {
  const h = await harness(t, 'rust');
  let res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'cpr:missing:sonnet' });
  assert.equal(res.status, 200); await res.text();
  assert.equal(JSON.parse(h.requests[0].body).model, 'wire-model'); assert.equal(h.usage[0].roleKind, 'sub');
  h.entries.sub = { name: '子线路', settingsConfig: h.entries.main.settingsConfig };
  res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'ccfw:sub:sonnet' });
  await res.text(); assert.equal(h.usage[1].providerId, 'sub');
});

rustTest('Node 与 Rust 差分：Codex 原生 Responses 流、命名子代理、缓存用量一致', async t => {
  const results = [];
  for (const backend of ['node', 'rust']) {
    const h = await harness(t, backend, { protocol: 'codex', mode: 'cpr' });
    const res = await h.post('/codex-proxy/codex/fixture/explorer/responses', { model: 'gpt-fixture', input: [], stream: true });
    assert.equal(res.status, 200); assert.equal(await res.text(), responseStream);
    assert.equal(h.requests[0].url, '/v1/responses'); assert.equal(h.requests[0].headers.authorization, 'Bearer test-codex-key');
    results.push({ tokens: h.usage[0].tokens, roleKind: h.usage[0].roleKind, agentRole: h.usage[0].agentRole,
      routeName: h.usage[0].routeName, phases: h.activity.map(e => e.phase), deltas: h.deltas.map(d => d.e) });
  }
  assert.deepEqual(results[1], results[0]);
});

rustTest('SSE 跨字节中文、工具参数、推理和响应内失败均由 Rust 正确归因', async t => {
  const stream = sse({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } })
    + sse({ type: 'content_block_delta', index: 1, delta: { thinking: '推理🌏' } })
    + sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'read' } })
    + sse({ type: 'content_block_delta', index: 2, delta: { partial_json: '{"路径":"中文"}' } })
    + sse({ type: 'error', error: { message: 'fixture failure' } });
  const h = await harness(t, 'rust', { upstream: async (req, res) => {
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
  const h = await harness(t, 'rust', { protocol: 'codex', upstream: (req, res, requests) => {
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
  const h = await harness(t, 'rust', { authorize: arg => ({ ok: arg.providerId === 'main', code: 'attempt_not_active' }) });
  let res = await h.post('/claude-proxy/other/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 409); await res.text();
  res = await h.post('/claude-proxy/main/fixture/v1/messages', { ...claudeBody, model: 'cpr:other:sonnet' });
  assert.equal(res.status, 409); await res.text(); assert.equal(h.requests.length, 0);
});

rustTest('官方 OAuth 更换凭据后只重拨一次，逻辑用量和结束事件各一次', async t => {
  let token = 'old-test', refreshes = 0;
  const h = await harness(t, 'rust', { entries: () => ({ main: { name: '官方', settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
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
  const h = await harness(t, 'rust', { protocol: 'codex', proxy: () => ({ hookRetryMax: 1,
    onUpstreamRejected: ({ body }) => ({ retry: true, body: { ...body, repaired: true } }) }),
    upstream: (req, res, requests) => { res.writeHead(requests.length < 2 ? 400 : 200, { 'content-type': 'text/event-stream' }); res.end(requests.length < 2 ? '{"error":"history"}' : responseStream); } });
  const res = await h.post('/codex-proxy/codex/fixture/main/responses', { model: 'fixture', input: [] });
  assert.equal(res.status, 200); assert.equal(await res.text(), responseStream);
  assert.equal(h.requests.length, 2); assert.equal(JSON.parse(h.requests[1].body).repaired, true); assert.equal(h.usage.length, 1);
});

rustTest('Responses 兼容模式在输出前退避重试繁忙响应，并补齐缺失结束事件', async t => {
  const h = await harness(t, 'rust', { protocol: 'codex', entries: url => ({ codex: { settingsConfig: { proxyTarget: { mode: 'responses-compat', baseUrl: url + '/responses', apiKey: 'test-key' } } } }),
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
    const h = await harness(t, 'rust', { upstream: (req, res) => {
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
  const h = await harness(t, 'rust', { protocol: 'codex', upstream: (req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/stolen' }); res.end('redirect'); } });
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
  const h = await harness(t, 'rust', { entries: () => ({ main: { name: '官方', egressBinding: { pluginId: 'fixture', profileId: 'account' }, settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
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
  const h = await harness(t, 'rust', { entries: () => ({ main: { settingsConfig: { env: {
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

for (const backend of ['node', 'rust']) rustTest(`${backend} 限流响应头同时传递 5h 和周额度；HEAD 不拨号、不记账`, async t => {
  const h = await harness(t, backend, { upstream: (req, res) => {
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

for (const backend of ['node', 'rust']) rustTest(`${backend} 周额度单独返回或耗尽时仍上报，响应头缺失时不伪造`, async t => {
  let count = 0;
  const h = await harness(t, backend, { upstream: (_req, res) => {
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

rustTest('首包等待有上限，错误回调不会包含上游地址或能力令牌', async t => {
  const h = await harness(t, 'rust', { proxy: () => ({ headersTimeoutMs: 25 }), upstream: () => {} });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 502); const text = await res.text(); assert.match(text, /UPSTREAM_HEADERS_TIMEOUT/);
  assert.doesNotMatch(text, /test-upstream-key|127\.0\.0\.1/); assert.equal(h.usage[0].errorCode, 'UPSTREAM_HEADERS_TIMEOUT');
});

rustTest('超大 OAuth 错误原样转发，宿主不恢复、不重复记账', async t => {
  const errorBody = '测'.repeat(30 * 1024);
  let recoveries = 0;
  const h = await harness(t, 'rust', { entries: () => ({ main: { settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, readOfficialCredential: () => ({ token: 'fixture-oauth' }), recoverOfficialCredential: async () => { recoveries++; return { token: 'new-fixture' }; } }),
    upstream: (req, res) => { res.writeHead(401); res.end(errorBody); } });
  const res = await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody);
  assert.equal(res.status, 401); assert.equal(await res.text(), errorBody);
  assert.equal(recoveries, 0); assert.equal(h.usage.length, 1);
});

rustTest('未结束的 OAuth 错误由宿主超时取消，上游连接不会遗留', async t => {
  let closedUpstream, recoveries = 0;
  const closed = new Promise(resolve => { closedUpstream = resolve; });
  const h = await harness(t, 'rust', { entries: () => ({ main: { settingsConfig: { officialAccount: { id: 'a'.repeat(16) }, env: {} } } }),
    proxy: url => ({ officialBaseUrl: url, authErrorTimeoutMs: 40, readOfficialCredential: () => ({ token: 'fixture-oauth' }), recoverOfficialCredential: async () => { recoveries++; return { token: 'new-fixture' }; } }),
    upstream: (req, res) => { res.once('close', closedUpstream); res.writeHead(401, { 'content-length': '999' }); res.write('{"error":'); } });
  await h.post('/claude-proxy/main/fixture/v1/messages', claudeBody).then(res => res.text()).catch(() => {});
  await closed;
  assert.equal(recoveries, 0); assert.equal(h.requests.length, 1); assert.equal(h.activity.filter(e => e.phase === 'end').length, 1);
});

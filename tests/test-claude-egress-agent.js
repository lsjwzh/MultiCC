'use strict';

// 每个 Claude 官方账号的专用出口：CPR 拨上游前经 resolveUpstreamAgent 问出口，
// 「CLI → cli-provider-router → 插件出口 → api.anthropic.com」。这里钉住：
//   • 真正转发时 CPR 用的是**这个账号**的凭据，并且确实经插件给的代理出去；
//   • 绑定缺失 = 直连、不碰插件；插件缺失 = 可行动的报错，且绝不回落直连；
//   • 出口地址不缓存（改了身份的出口，下一次请求就走新地址）；
//   • 装着的 CPR 不认钩子时，绑了出口的账号在读令牌处失败，而不是从本机 IP 出去。

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('cli-provider-router');
const {
  createClaudeEgressAgentResolver,
  guardCredentialReader,
} = require('../src/native/binding').claudeEgress;

const PROVIDER_ID = 'claude-official-aaaaaaaaaaaaaaaa';
const BINDING = { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' };
const QUIET = { warn() {}, info() {}, error() {} };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

// A real (if minimal) forward proxy: absolute-form requests carry the target in
// the request line, so relaying them by URL is enough for the http case.
async function startProxy(seen) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      const target = new URL(req.url);
      const upstream = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname + target.search,
        method: req.method, headers: req.headers,
      }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      upstream.end(body);
    });
  });
  return { server, port: await listen(server) };
}

async function startUpstream(seen) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  return { server, port: await listen(server) };
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function accountProvider(extra = {}) {
  return {
    id: PROVIDER_ID, appType: 'claude', name: 'Claude 官方 · 工作号',
    settingsConfig: { env: {}, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } },
    ...extra,
  };
}

async function withOfficialViaProxy(fn) {
  const prev = process.env.CLAUDE_OFFICIAL_VIA_PROXY;
  process.env.CLAUDE_OFFICIAL_VIA_PROXY = '1';
  try { return await fn(); } finally {
    if (prev == null) delete process.env.CLAUDE_OFFICIAL_VIA_PROXY;
    else process.env.CLAUDE_OFFICIAL_VIA_PROXY = prev;
  }
}

// The real CPR claude handler, wired the way server.js wires it.
async function startCpr({ provider, upstreamPort, runPluginCommand, readCredential }) {
  const resolver = createClaudeEgressAgentResolver({ logger: QUIET, runPluginCommand });
  const server = http.createServer(router.createClaudeHandler({
    getProvider: () => provider,
    officialBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    readOfficialCredential: readCredential || (async () => ({ token: 'acct-token' })),
    resolveUpstreamAgent: resolver.resolveUpstreamAgent,
  }));
  return { server, port: await listen(server) };
}

test('the installed cli-provider-router honours resolveUpstreamAgent', () => {
  assert.equal(router.CAPABILITIES.upstreamAgent, '1.0',
    'package.json must pin a cli-provider-router with CAPABILITIES.upstreamAgent');
});

test('a bound account leaves through the plugin egress, with CPR injecting its own credential', async (t) => {
  const proxySeen = [];
  const upstreamSeen = [];
  const proxy = await startProxy(proxySeen);
  const upstream = await startUpstream(upstreamSeen);
  const credentialArgs = [];
  const provider = accountProvider({ egressBinding: BINDING });
  const cpr = await startCpr({
    provider,
    upstreamPort: upstream.port,
    readCredential: async (arg) => { credentialArgs.push(arg); return { token: 'acct-token' }; },
    runPluginCommand: async (id, command, input) => {
      assert.equal(id, 'chrome-proxy-launcher');
      assert.equal(command, 'egress');
      assert.equal(input.id, 'us-home');
      return { status: 200, payload: { proxyUrl: `http://127.0.0.1:${proxy.port}`, kind: 'core' } };
    },
  });
  t.after(() => Promise.all([close(cpr.server), close(proxy.server), close(upstream.server)]));

  const response = await withOfficialViaProxy(() => post(cpr.port,
    `/claude-proxy/${PROVIDER_ID}/session-1/v1/messages?beta=true`,
    { model: 'claude-sonnet-5-5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
    { authorization: 'Bearer cli-virtual-token', 'anthropic-beta': 'claude-code-20250219' }));

  assert.equal(response.status, 200);
  assert.equal(response.json.type, 'message');
  assert.equal(credentialArgs.length, 1);
  assert.equal(credentialArgs[0].accountId, 'aaaaaaaaaaaaaaaa', 'the official branch still resolves THIS account');
  assert.equal(proxySeen.length, 1, 'the dial went through the plugin proxy');
  assert.equal(proxySeen[0].url, `http://127.0.0.1:${upstream.port}/v1/messages?beta=true`);
  assert.equal(upstreamSeen.length, 1);
  const sent = upstreamSeen[0];
  assert.equal(sent.headers.authorization, 'Bearer acct-token', 'CPR replaced the CLI token with the account one');
  assert.match(String(sent.headers['anthropic-beta']), /oauth-2025-04-20/);
  assert.equal(JSON.parse(sent.body).model, 'claude-sonnet-5-5');
});

test('an unbound account dials directly and never asks the plugin', async (t) => {
  const upstreamSeen = [];
  const upstream = await startUpstream(upstreamSeen);
  let pluginCalls = 0;
  const cpr = await startCpr({
    provider: accountProvider(),
    upstreamPort: upstream.port,
    runPluginCommand: async () => { pluginCalls += 1; return { status: 200, payload: { proxyUrl: 'http://127.0.0.1:1' } }; },
  });
  t.after(() => Promise.all([close(cpr.server), close(upstream.server)]));

  const response = await withOfficialViaProxy(() => post(cpr.port,
    `/claude-proxy/${PROVIDER_ID}/session-1/v1/messages`, { model: 'claude-sonnet-5-5', stream: false, messages: [] }));
  assert.equal(response.status, 200);
  assert.equal(upstreamSeen.length, 1);
  assert.equal(pluginCalls, 0);
});

test('an uninstalled plugin fails with an actionable message and never falls back to direct', async (t) => {
  const upstreamSeen = [];
  const upstream = await startUpstream(upstreamSeen);
  const cpr = await startCpr({
    provider: accountProvider({ egressBinding: BINDING }),
    upstreamPort: upstream.port,
    runPluginCommand: async () => ({ status: 404, payload: { error: '插件 chrome-proxy-launcher 不存在' } }),
  });
  t.after(() => Promise.all([close(cpr.server), close(upstream.server)]));

  const response = await withOfficialViaProxy(() => post(cpr.port,
    `/claude-proxy/${PROVIDER_ID}/session-1/v1/messages`, { model: 'claude-sonnet-5-5', messages: [] }));
  assert.equal(response.status, 400);
  assert.equal(response.json.error.type, 'PLUGIN_MISSING');
  assert.match(response.json.error.message, /未安装「Chrome 隔离出口启动器」插件/);
  assert.equal(upstreamSeen.length, 0, 'a required egress must not silently go out directly');
});

test('the egress address is re-resolved per request, so an edited profile applies at once', async () => {
  const urls = ['http://127.0.0.1:7001', 'socks5://127.0.0.1:7002'];
  const created = [];
  let calls = 0;
  const resolver = createClaudeEgressAgentResolver({
    logger: QUIET,
    runPluginCommand: async () => ({ status: 200, payload: { proxyUrl: urls[Math.min(calls++, urls.length - 1)] } }),
    createAgent: (url) => { created.push(url); return { url }; },
  });
  const context = { provider: accountProvider({ egressBinding: BINDING }), providerId: PROVIDER_ID };
  assert.equal((await resolver.resolveUpstreamAgent(context)).url, urls[0]);
  assert.equal((await resolver.resolveUpstreamAgent(context)).url, urls[1], 'no stale cached egress');
  assert.equal((await resolver.resolveUpstreamAgent(context)).url, urls[1]);
  assert.deepEqual(created, urls, 'agents are reused per address, not re-created per request');
});

test('concurrent requests of one account share a single egress resolution', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resolver = createClaudeEgressAgentResolver({
    logger: QUIET,
    runPluginCommand: async () => { calls += 1; await gate; return { status: 200, payload: { proxyUrl: 'http://127.0.0.1:7001' } }; },
    createAgent: url => ({ url }),
  });
  const context = { provider: accountProvider({ egressBinding: BINDING }), providerId: PROVIDER_ID };
  const pending = [resolver.resolveUpstreamAgent(context), resolver.resolveUpstreamAgent(context)];
  release();
  const [a, b] = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('an outdated router fails bound accounts at the credential step instead of leaking the host IP', async () => {
  const read = async () => ({ token: 'acct-token' });
  assert.equal(guardCredentialReader(read, { supported: true }), read);
  const guarded = guardCredentialReader(read, { supported: false });
  const bound = await guarded({ provider: accountProvider({ egressBinding: BINDING }), accountId: 'aaaaaaaaaaaaaaaa' });
  assert.equal(bound.token, null);
  assert.match(bound.reason, /专用出口.*cli-provider-router/);
  assert.deepEqual(await guarded({ provider: accountProvider(), accountId: 'aaaaaaaaaaaaaaaa' }), { token: 'acct-token' });
  assert.deepEqual(await guarded('Claude Code-credentials'), { token: 'acct-token' });
});

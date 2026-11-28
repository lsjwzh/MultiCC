'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const router = require('cli-provider-router');
const { createProviderRouterPort } = require('../src/providers/router-port');
const { createOfficialAccountStore } = require('../src/native/binding').officialAccounts;
const { createClaudeAccountCredentialService } = require('../src/claude-auth/account-credentials');
const { createClaudeAccountRefreshSupervisor } = require('../src/claude-auth/accounts-refresh');
const ACCOUNT_A = 'a'.repeat(16), ACCOUNT_B = 'b'.repeat(16);

const originalToggle = process.env.CLAUDE_OFFICIAL_VIA_PROXY;
process.env.CLAUDE_OFFICIAL_VIA_PROXY = '1';
test.after(() => {
  if (originalToggle === undefined) delete process.env.CLAUDE_OFFICIAL_VIA_PROXY;
  else process.env.CLAUDE_OFFICIAL_VIA_PROXY = originalToggle;
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const denied = (res, status = 401, message = 'OAuth access token has been revoked') => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-original-error': 'yes' });
  res.end(JSON.stringify({ error: { type: 'authentication_error', message } }));
};
const success = res => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, output_tokens: 1 } }));
};

// 真实 CPR + 宿主挂载 + 本地模拟上游；不接触真实账号或钥匙串。
async function harness(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-auth-recovery-'));
  const requests = [], activities = [], usages = [], outcomes = [], recoveries = [], authorizations = [];
  const tokens = { [ACCOUNT_A]: 'old-a', [ACCOUNT_B]: 'old-b' };
  const downstreamClosed = deferred(), recovering = deferred();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { auth: req.headers.authorization, body: Buffer.concat(chunks), url: req.url };
    requests.push(record);
    (opts.upstream || ((r, s) => r.auth.startsWith('Bearer old-') ? denied(s) : success(s)))(record, res);
  });
  await listen(upstream);
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const app = express();
  if (opts.parsed) app.use(express.json());
  const providers = {
    a: { id: 'a', name: 'A', settingsConfig: { officialAccount: { id: ACCOUNT_A }, env: {} } },
    b: { id: 'b', name: 'B', settingsConfig: { officialAccount: { id: ACCOUNT_B }, env: {} } },
    third: { id: 'third', name: '第三方', settingsConfig: { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'api-key' } } },
    'claude-official': { id: 'claude-official', name: '共享登录', settingsConfig: { env: {} } },
  };
  const providerStore = { getProvider: (type, id) => providers[id] };
  const port = createProviderRouterPort({
    mode: opts.mode || 'cpr', router, providerStore,
    legacy: { getProvider: providerStore.getProvider, mountClaudeProxy: router.mountClaudeProxy, normalizeUsageEvent: router.normalizeUsageEvent },
    embeddingPaths: { cprPaths: { home: root }, codexHomesDir: path.join(root, 'codex') },
  });
  port.mountProtocolProxies(app, {
    protocols: ['claude'],
    authorizeProxyRequest: arg => {
      authorizations.push(arg);
      return { ok: opts.authorized ? opts.authorized(arg) : true, attempt: { attemptId: 'test-attempt' } };
    },
    onActivity: event => activities.push(event),
    onUsageObserved: event => usages.push(event),
    onProxyOutcome: event => {
      outcomes.push(event);
      if (event.proxyOutcome.termination === 'downstream_disconnect') downstreamClosed.resolve();
    },
    claudeProxy: {
      officialBaseUrl: baseUrl,
      captureEnabled: false,
      hopCredentials: { authorize: () => ({ ok: true }), verify: () => ({ ok: true }) },
      readOfficialCredential: arg => opts.credentials
        ? opts.credentials.readOfficialCredential(arg)
        : { token: typeof arg === 'object' ? tokens[arg.accountId] : 'shared' },
      recoverOfficialCredential: async (arg, failed) => {
        recoveries.push({ id: arg.accountId, failed });
        recovering.resolve();
        if (opts.credentials) return opts.credentials.recoverOfficialCredential(arg, failed);
        if (opts.recover) return opts.recover(arg, failed, tokens);
        tokens[arg.accountId] = `new-${arg.providerId}`;
        return { token: tokens[arg.accountId] };
      },
      ...(opts.errorTimeout ? { authErrorTimeoutMs: opts.errorTimeout } : {}),
    },
  });
  app.use((error, req, res, next) => { if (res.headersSent) return res.destroy(); res.status(500).end('handler failed'); });
  const server = http.createServer(app);
  await listen(server);
  t.after(async () => { await close(server); await close(upstream); fs.rmSync(root, { recursive: true, force: true }); });
  function start({ provider = 'a', body, onData } = {}) {
    const payload = body || '{ "model": "claude-test", "max_tokens": 16, "messages": [{"role":"user","content":"你好"}] }';
    let response, request;
    const result = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port,
        path: `/claude-proxy/${provider}/session/v1/messages?beta=true`, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, res => {
        response = res;
        const chunks = [];
        res.on('data', c => { chunks.push(c); onData?.(c); });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(payload);
      request = req;
    });
    return { result, cancel: () => { response?.destroy(); request.destroy(); } };
  }
  return { requests, activities, usages, outcomes, recoveries, authorizations, tokens, start, downstreamClosed, recovering };
}

for (const mode of ['legacy', 'shadow', 'cpr']) {
test(`${mode}：首次 401 换凭据后只重发该请求，原始字节及最终归因保留`, { timeout: 5000 }, async t => {
  const h = await harness(t, { mode });
  const result = await h.start().result;
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(h.requests.map(r => r.auth), ['Bearer old-a', 'Bearer new-a']);
  assert.deepEqual(h.requests[0].body, h.requests[1].body);
  assert.equal(h.requests[1].url, '/v1/messages?beta=true');
  assert.deepEqual(h.recoveries, [{ id: ACCOUNT_A, failed: 'old-a' }]);
  assert.equal(h.usages.length, 1);
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.outcomes[0].proxyOutcome.termination, 'completed');
  assert.deepEqual(h.activities.map(e => e.phase), ['request', 'first_byte', 'end']);
  assert.equal(h.activities.at(-1).status, 'success');
  assert.equal(h.authorizations.length, 3, '入口鉴权一次，两次转发各重新验证路由');
});
}

test('请求发出后后台开始续期：401 等待保存新凭据再继续，不重复续期', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-auth-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createOfficialAccountStore({ root });
  // 固定标记对应测试 Provider；全部为临时假凭据。
  store.writeClaudeCredential(ACCOUNT_A, { access_token: 'old-a', refresh_token: 'refresh-old', expired: new Date(Date.now() + 3600e3).toISOString() });
  const supervisor = createClaudeAccountRefreshSupervisor({ accounts: store });
  const credentials = createClaudeAccountCredentialService({ accounts: store, exclusive: supervisor.exclusive,
    fetch: () => { throw new Error('异常恢复不得额外续期'); },
  });
  const release = deferred();
  t.after(() => release.resolve());
  let rotation;
  const h = await harness(t, { credentials, upstream: (req, res) => {
    if (req.auth === 'Bearer old-a') {
      rotation = supervisor.exclusive(ACCOUNT_A, async () => {
        await release.promise;
        store.writeClaudeCredential(ACCOUNT_A, { access_token: 'new-a', refresh_token: 'refresh-new', expired: new Date(Date.now() + 3600e3).toISOString() });
      });
      denied(res);
    } else success(res);
  } });
  const pending = h.start().result;
  await h.recovering.promise;
  assert.equal(h.requests.length, 1, '续期未完成前保持等待');
  release.resolve();
  assert.equal((await pending).status, 200);
  await rotation;
  assert.deepEqual(h.requests.map(r => r.auth), ['Bearer old-a', 'Bearer new-a']);
  assert.equal(credentials.status(ACCOUNT_A).refreshCount, 0);
  assert.equal(h.usages.length, 1);
  assert.equal(h.outcomes[0].proxyOutcome.termination, 'completed');
});

test('解析后的正文和子路由按实际账号恢复，账号之间不串号', { timeout: 5000 }, async t => {
  const h = await harness(t, { parsed: true });
  const body = JSON.stringify({ model: 'ccfw:b:claude-test', messages: [], max_tokens: 1 });
  const [sub, main] = await Promise.all([h.start({ body }).result, h.start().result]);
  assert.equal(sub.status, 200);
  assert.equal(main.status, 200);
  assert.deepEqual(h.recoveries.map(r => r.id).sort(), [ACCOUNT_A, ACCOUNT_B]);
  assert.equal(h.usages.length, 2);
  assert.deepEqual(h.usages.map(e => e.providerId).sort(), ['a', 'b']);
});

for (const mode of ['失败', '异常', '相同令牌', '二次拒绝']) {
  test(`恢复${mode}时有界结束，保留最终错误`, { timeout: 5000 }, async t => {
    const h = await harness(t, {
      recover: mode === '二次拒绝' ? undefined : async (arg, failed) => {
        if (mode === '异常') throw new Error('模拟续期失败');
        return { token: mode === '相同令牌' ? failed : null };
      },
      upstream: (req, res) => denied(res),
    });
    const result = await h.start().result;
    assert.equal(result.status, 401);
    assert.equal(result.headers['x-original-error'], 'yes');
    assert.match(result.body, /revoked/);
    assert.equal(h.requests.length, mode === '二次拒绝' ? 2 : 1);
    assert.equal(h.recoveries.length, 1);
    assert.equal(h.usages.length, 1);
    assert.equal(h.outcomes.length, 1);
    assert.equal(h.outcomes[0].proxyOutcome.httpStatus, 401);
    assert.equal(h.activities.filter(e => e.phase === 'end').length, 1);
  });
}

test('只有明确撤销的 403 会恢复，权限错误和非托管凭据保持原行为', { timeout: 5000 }, async t => {
  for (const [provider, status, message, retries] of [
    ['a', 403, 'OAuth token revoked', 1],
    ['a', 403, 'organization access denied', 0],
    ['third', 401, 'invalid API key', 0],
    ['claude-official', 401, 'OAuth token revoked', 0],
  ]) {
    const h = await harness(t, { upstream: (req, res) => req.auth.startsWith('Bearer new-') ? success(res) : denied(res, status, message) });
    const result = await h.start({ provider }).result;
    assert.equal(result.status, retries ? 200 : status);
    assert.equal(h.recoveries.length, retries);
    assert.equal(h.requests.length, retries + 1);
  }
});

test('恢复期间路由失效时重新鉴权，禁止向旧上游重发', { timeout: 5000 }, async t => {
  let active = true;
  const h = await harness(t, { authorized: () => active, recover: async (arg, failed, tokens) => {
    active = false; tokens[ACCOUNT_A] = 'new-a'; return { token: tokens[ACCOUNT_A] };
  } });
  const result = await h.start().result;
  assert.equal(result.status, 409);
  assert.equal(h.requests.length, 1);
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.activities.filter(e => e.phase === 'end').length, 1);
});

test('成功 SSE 即时输出，流内错误也不会触发重放', { timeout: 5000 }, async t => {
  const first = deferred(), finish = deferred();
  const h = await harness(t, { upstream: (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"先输出"}}\n\n');
    finish.promise.then(() => res.end('event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"OAuth token revoked"}}\n\n'));
  } });
  t.after(() => finish.resolve());
  const pending = h.start({ onData: () => first.resolve() });
  await first.promise;
  assert.equal(h.requests.length, 1);
  assert.equal(h.usages.length, 0, '首次输出时上游仍未结束');
  finish.resolve();
  assert.match((await pending.result).body, /先输出/);
  assert.equal(h.recoveries.length, 0);
});

test('客户端在续期期间取消时不重发，活动正常收尾', { timeout: 5000 }, async t => {
  const recovering = deferred(), release = deferred();
  const h = await harness(t, { recover: async () => {
    recovering.resolve(); await release.promise; return { token: 'new-a' };
  } });
  const pending = h.start();
  const ended = pending.result.catch(() => {});
  await recovering.promise;
  pending.cancel();
  await ended;
  await h.downstreamClosed.promise;
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.requests.length, 1);
  assert.equal(h.outcomes.length, 1);
  assert.equal(h.activities.filter(e => e.phase === 'end').length, 1);
});

test('超大认证错误直接转发，不恢复也不截断', { timeout: 5000 }, async t => {
  const body = 'x'.repeat(70 * 1024);
  const h = await harness(t, { upstream: (req, res) => { res.writeHead(401); res.end(body); } });
  const result = await h.start().result;
  assert.equal(result.status, 401);
  assert.equal(result.body, body);
  assert.equal(h.recoveries.length, 0);
  assert.equal(h.usages.length, 1);
});

test('未结束的认证错误有暂存时限，不会触发恢复或留下上游连接', { timeout: 5000 }, async t => {
  const closed = deferred();
  const h = await harness(t, { errorTimeout: 40, upstream: (req, res) => {
    res.once('close', closed.resolve);
    res.writeHead(401, { 'content-length': '999' });
    res.write('{"error":');
  } });
  await h.start().result.catch(() => {});
  await closed.promise;
  assert.equal(h.requests.length, 1);
  assert.equal(h.recoveries.length, 0);
  assert.equal(h.activities.filter(e => e.phase === 'end').length, 1);
});

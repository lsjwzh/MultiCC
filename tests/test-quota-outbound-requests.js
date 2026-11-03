'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let handler = async () => { throw new Error('unexpected outbound request'); };
mock.method(require('../src/network/outbound'), 'outboundFetch', (...args) => handler(...args));
const { fetchCodexUsage } = require('../src/routes/codex-quota');
const { pollCodexUsage } = require('../src/usage-limit-poller');
const { fetchKimiBalance } = require('../src/routes/kimi-quota');
const { fetchWithCookies } = require('../src/routes/qoder-quota');
const { fetchCliUsage } = require('../src/quota/claude-cli-oauth');
const { fetchZenGoUsage } = require('../src/quota/opencode-zen');
const { pollClaudeUsage } = require('../src/routes/provider-balance');
const { createCliLoginDetector } = require('../src/official-accounts-cli-login');

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('Codex 页面与轮询共用请求地址、认证头和代理入口，保留各自结果结构', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outbound-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: 'test-token', account_id: 'test-account' } }));
  const calls = [];
  handler = async (url, init) => {
    calls.push({ url, init });
    return json({ rate_limit: { primary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: 10000 } } });
  };
  try {
    const route = await fetchCodexUsage(1000, { authFile });
    const poll = await pollCodexUsage({ authFile }, 1000);
    assert.equal(route.status, 'ok');
    assert.equal(route.weekly.remainingPercent, 84);
    assert.equal(poll.utilization, 0.16);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(calls[0].url, calls[1].url);
    assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
    assert.ok(calls.every(call => call.init.signal instanceof AbortSignal));

    handler = async () => json({ error: { code: 'token_revoked' } }, 401);
    assert.equal((await fetchCodexUsage(1000, { authFile })).status, 'no_auth');
    await assert.rejects(pollCodexUsage({ authFile }, 1000), error =>
      error.kind === 'limit_fetch_failed' && /HTTP 401/.test(error.detail));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex 页面 401 时先自愈凭证再重试一次，修复失败则维持 no_auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outbound-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: 'old-token', account_id: 'test-account' } }));
  const calls = [];
  try {
    handler = async (_url, init) => {
      calls.push(init.headers.Authorization);
      return calls.length === 1
        ? json({ error: { code: 'token_expired' } }, 401)
        : json({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 10000 } } });
    };
    const refreshAuth = async (input) => {
      assert.equal(input && input.authFile, authFile);
      fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: 'new-token', account_id: 'test-account' } }));
      return true;
    };
    const result = await fetchCodexUsage(1000, { authFile, refreshAuth });
    assert.equal(result.status, 'ok');
    assert.deepEqual(calls, ['Bearer old-token', 'Bearer new-token']);

    calls.length = 0;
    handler = async (_url, init) => {
      calls.push(init.headers.Authorization);
      return json({ error: { code: 'token_revoked' } }, 401);
    };
    const declined = await fetchCodexUsage(1000, { authFile, refreshAuth: async () => false });
    assert.equal(declined.status, 'no_auth');
    assert.equal(calls.length, 1, 'no retry without a repair');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('余量轮询超时会中止统一请求并保留超时诊断', async () => {
  handler = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(pollCodexUsage({}, 0, 5, () => ({ accessToken: 'test-token' })), error =>
    error.kind === 'limit_fetch_failed' && /timeout after 5ms/.test(error.detail));
});

test('Kimi 与 OpenCode 默认查询使用统一请求入口', async () => {
  const calls = [];
  handler = async (url) => {
    calls.push(url);
    return url.includes('moonshot')
      ? json({ data: { available_balance: 12 } })
      : json({ usage: { rolling: { percent: 12, resetsAt: '2030-01-01T00:00:00Z' } } });
  };
  assert.equal((await fetchKimiBalance({ host: 'api.moonshot.cn', apiKey: 'test-key' })).available, 12);
  assert.equal((await fetchZenGoUsage({ credentials: [{ apiKey: 'test-key', baseUrl: 'https://opencode.ai/zen/go/v1' }] })).status, 'ok');
  assert.equal(calls.length, 2);
});

test('Claude CLI 余量、供应商余量和账号信息默认使用统一请求入口', async () => {
  const calls = [];
  handler = async (url) => {
    calls.push(url);
    return url.endsWith('/profile') ? json({ account: { email: 'test@example.invalid', uuid: 'test-id' } })
      : json({ five_hour: { utilization: 20, resets_at: '2030-01-01T00:00:00Z' } });
  };
  const readCredentials = async () => ({ ok: true, accessToken: 'test-token' });
  assert.equal((await fetchCliUsage({ readCredentials })).usage.five_hour.utilization, 20);
  assert.equal((await pollClaudeUsage({}, 0, 1000, { readCliCredentials: readCredentials })).utilization, 0.2);
  const detector = createCliLoginDetector({ accounts: { listClaudeAccounts: () => [] }, readClaudeCli: readCredentials });
  await detector.detect();
  assert.equal(detector.status('claude').email, 'test@example.invalid');
  assert.deepEqual(calls.map(url => new URL(url).pathname), ['/api/oauth/usage', '/api/oauth/usage', '/api/oauth/profile']);
});

test('Qoder 代理请求保留手动重定向和登录失效语义', async () => {
  handler = async (url, init) => {
    assert.equal(new URL(url).hostname, 'qoder.com.cn');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Cookie, 'session=test-cookie');
    return json({}, 302, { location: '/login' });
  };
  assert.equal((await fetchWithCookies([{ name: 'session', value: 'test-cookie' }])).status, 'needs_login');
  handler = async url => json(url.includes('big_model_credits') ? { total_quota: 100 } : { plan: 'test-plan' });
  const result = await fetchWithCookies([{ name: 'session', value: 'test-cookie' }]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.plan, { plan: 'test-plan' });
});

test('余量和账户请求不能重新绕过统一网络入口', () => {
  const files = [
    'src/usage-limit-poller.js', 'src/routes/codex-quota.js', 'src/routes/claude-accounts.js',
    'src/routes/claude-usage-quota.js', 'src/routes/provider-balance.js', 'src/routes/qoder-quota.js',
    'src/routes/kimi-quota.js', 'src/quota/claude-cli-oauth.js', 'src/quota/opencode-zen.js',
    'src/official-accounts-cli-login.js', 'src/providers/jev-client.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /globalThis\.fetch|global\.fetch|\bhttps?\.(request|get)\s*\(/, file);
    // Relative fetch inside browser-evaluated scripts belongs to Chrome.
    assert.doesNotMatch(source, /\bfetch\(\s*(?!['"]\/)[A-Za-z_$'"`]/, file);
  }
  for (const file of ['src/usage-limit-poller.js', 'src/routes/codex-quota.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /['"]https:\/\/chatgpt\.com\/backend-api\/wham\/usage['"]/,
      `${file} 不得复制 Codex 余量请求实现`);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dateMs, subscriptionFromBody, codexAuthSubscription } = require('../src/quota/subscription');
const { mountAccountSubscriptionRoute } = require('../src/routes/account-subscription');
const { createOfficialAccountStore } = require('../src/official-accounts');

const DATE = '2030-05-12T12:00:00Z';
const MS = Date.parse(DATE);
const ID = 'aaaaaaaaaaaaaaaa';
const jwt = payload => `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
const auth = (claims = {}) => ({ tokens: { account_id: 'account-a', access_token: 'fixture-token', id_token: jwt({
  iat: 1893456000, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-a', ...claims },
}) } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function route(vendor, deps) {
  let handler;
  mountAccountSubscriptionRoute({ get(url, fn) { assert.equal(url, `/api/${vendor}/subscription`); handler = fn; } }, vendor, deps);
  return async (account = ID) => {
    let body, status = 200;
    await handler({ query: { account } }, { set() {}, status(code) { status = code; return this; }, json(value) { body = value; } });
    return { status, body };
  };
}

test('只接受有效订阅日期，不把重置、登录过期或创建时间当成续费', () => {
  for (const value of [null, '', false, {}, [], 'bad', 0, -1, Infinity, '   ']) assert.equal(dateMs(value), null);
  assert.equal(dateMs(MS / 1000), MS);
  assert.equal(dateMs(String(MS)), MS);
  assert.equal(subscriptionFromBody({ resets_at: DATE, expires_at: DATE, created_at: DATE, exp: MS / 1000 }), null);
  const result = subscriptionFromBody({ subscription: { next_billing_date: DATE } });
  assert.equal(result.nextBillingAt, MS);
  assert.equal(result.currentPeriodEnd, null);
});

test('本期到期与已取消续费不冒充下一次扣费日期', () => {
  const end = subscriptionFromBody({ current_period_end: DATE });
  assert.equal(end.nextBillingAt, null);
  assert.equal(end.currentPeriodEnd, MS);
  assert.equal(end.autoRenew, null);
  assert.equal(subscriptionFromBody({ subscription: { current_period_end: DATE, auto_renew: true } }).nextBillingAt, MS);
  const cancelled = subscriptionFromBody({ subscription: { current_period_end: DATE, next_billing_at: DATE, cancel_at_period_end: true } });
  assert.equal(cancelled.nextBillingAt, null);
  assert.equal(cancelled.autoRenew, false);
});

test('Codex 登录快照只读取同一账号订阅声明，公开结果不含凭据', () => {
  const result = codexAuthSubscription(auth({ chatgpt_subscription_active_until: DATE }));
  assert.equal(result.currentPeriodEnd, MS);
  assert.equal(result.nextBillingAt, null);
  assert.equal(result.source, 'login');
  assert.equal(result.observedAt, 1893456000000);
  assert.equal(codexAuthSubscription(auth({ chatgpt_account_id: 'different', chatgpt_subscription_active_until: DATE })), null);
  assert.equal(codexAuthSubscription({ tokens: { access_token: 'opaque' } }), null);
  assert.doesNotMatch(JSON.stringify(result), /fixture|token|account-a/);
});

test('Codex 接口使用指定账号，支持实时日期、登录快照和鉴权失效', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOfficialAccountStore({ root: dir });
  const account = store.createCodexAccount();
  fs.writeFileSync(account.authFile, JSON.stringify(auth({ chatgpt_subscription_active_until: DATE })));
  assert.equal(store.listCodexAccounts()[0].subscription.currentPeriodEnd, MS);
  let response = json({ subscription: { next_billing_at: DATE } });
  let calls = 0;
  const read = route('codex', { resolveAccountAuthFile: id => id === ID ? account.authFile : null,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'account-a');
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      assert.ok(init.signal instanceof AbortSignal);
      return response;
    } });
  assert.equal((await read()).body.subscription.nextBillingAt, MS);
  response = json({});
  assert.equal((await read()).body.subscription.source, 'login');
  response = json({}, 503);
  const stale = (await read()).body;
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.stale, true);
  response = json({}, 401);
  assert.deepEqual((await read()).body, { status: 'no_auth' });
  assert.equal((await read('bbbbbbbbbbbbbbbb')).body.status, 'no_auth');
  assert.equal((await read('../bad')).status, 400);
  assert.equal(calls, 4);
});

test('Claude 只读指定账号 profile，合并并发查询且不刷新凭据', async () => {
  const seen = [];
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const read = route('claude', {
    accounts: { listClaudeAccounts: () => [{ id: ID }, { id: 'bbbbbbbbbbbbbbbb' }] },
    credentials: { peekAccountToken: async id => { seen.push(id); return { token: `fixture-${id}` }; },
      readAccountToken: () => assert.fail('不得触发凭据刷新') },
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/api/oauth/profile');
      assert.equal(options.headers.Authorization, `Bearer fixture-${ID}`);
      await new Promise(resolve => { release = resolve; started(); });
      return json({ organization: { subscription: { next_billing_date: DATE } }, account: { email: 'private@example.invalid' } });
    },
  });
  const first = read(), second = read();
  await ready;
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(seen, [ID]);
  assert.equal(results[0].body.subscription.nextBillingAt, MS);
  assert.equal(results[0].body.subscription.source, 'profile');
  assert.deepEqual(results[0], results[1]);
  assert.doesNotMatch(JSON.stringify(results), /fixture|private@example/);
  assert.equal((await read('cccccccccccccccc')).status, 404);
});

test('Claude 缺少日期、过期凭据、网络错误均不跨账号兜底', async () => {
  const deps = { accounts: { listClaudeAccounts: () => [{ id: ID }] },
    credentials: { peekAccountToken: async () => ({ token: 'fixture' }) },
    fetch: async () => json({ organization: { subscription_type: 'max' } }) };
  assert.deepEqual((await route('claude', deps)()).body, { status: 'ok', subscription: null });
  const noAuth = { ...deps, credentials: { peekAccountToken: async () => ({ reason: 'access_token_expired' }) }, fetch: () => assert.fail('不应请求上游') };
  assert.equal((await route('claude', noAuth)()).body.status, 'no_auth');
  assert.equal((await route('claude', { ...deps, fetch: async () => { throw new Error('network'); } })()).body.status, 'unavailable');
  assert.equal((await route('claude', { ...deps, fetch: async () => json({}, 401) })()).body.status, 'no_auth');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subscriptionFromBody, codexAuthSubscription } = require('../src/quota/subscription');
const { mountAccountSubscriptionRoute } = require('./helpers/legacy-account-subscription-route');
const { registerAccountSubscriptionReader } = require('../src/quota/account-subscription-reader');
const subscriptions = require('../src/quota/account-subscription-cache');
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

test('挂载点注册的读者仍是 subscriptions.refresh 的数据源', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  subscriptions.configure({ file: path.join(dir, 'provider-limit-cache.db') });
  let asked = 0;
  const reader = registerAccountSubscriptionReader('claude', {
    accounts: { listClaudeAccounts: () => [{ id: ID }] },
    credentials: { peekAccountToken: async () => ({ token: 'fixture' }) },
    fetch: async () => { asked++; return json({ organization: { subscription: { next_billing_date: DATE } } }); },
  });
  assert.equal(typeof reader, 'function');
  const result = await subscriptions.refresh({ appType: 'claude', officialAccountId: ID });
  assert.equal(result.status, 'ok');
  assert.equal(result.subscription.nextBillingAt, MS);
  assert.equal(asked, 1);
});

test('网关写进共享库的订阅最多隔一次 project 就被 Node 看到', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-cross-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-limit-cache.db');
  subscriptions.configure({ file });
  await subscriptions.ready();
  const providers = [{ id: 'p1', appType: 'claude', isOfficial: true, builtinOfficial: false,
    officialAccountId: ID, subscription: null }];
  assert.equal(subscriptions.project(providers)[0].subscription, null);

  // A *different process* (the Rust front door) writes one observation.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  const subscription = { nextBillingAt: 1900000000000, currentPeriodEnd: null,
    autoRenew: null, observedAt: 1893456000000, source: 'profile' };
  db.prepare(`INSERT INTO provider_subscriptions(vendor,account_id,subscription_json,observed_at,last_attempt_at)
    VALUES (?,?,?,?,?) ON CONFLICT(vendor,account_id) DO UPDATE SET
    subscription_json=excluded.subscription_json,observed_at=excluded.observed_at,
    last_attempt_at=excluded.last_attempt_at`)
    .run('claude', ID, JSON.stringify(subscription), 1893456000000, 1893456000000);
  db.close();

  // The synchronous projection that notices the change still answers from its
  // snapshot; it has started the reload, which the next call observes.
  subscriptions.project(providers);
  for (let i = 0; i < 100 && !subscriptions.project(providers)[0].subscription; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(subscriptions.project(providers)[0].subscription, subscription);
});

test('Node 记录与网关并发写同一个 SQLite 不丢写也不报 BUSY', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-limit-cache.db');
  subscriptions.configure({ file });
  await subscriptions.ready();
  const { DatabaseSync } = require('node:sqlite');
  const gateway = new DatabaseSync(file);
  t.after(() => { try { gateway.close(); } catch (_) {} });
  const gatewayRow = { nextBillingAt: 1900000000001, currentPeriodEnd: null,
    autoRenew: null, observedAt: 1893456000001, source: 'profile' };
  // The gateway (another process) holds the write lock while Node records.
  // The addon's 5s busy_timeout must absorb it: no SQLITE_BUSY escapes, and
  // neither side loses its row.
  gateway.exec('BEGIN IMMEDIATE');
  const nodeRow = { nextBillingAt: 1900000000002, currentPeriodEnd: null,
    autoRenew: null, observedAt: 1893456000002, source: 'usage' };
  const record = subscriptions.record('codex', 'bbbbbbbbbbbbbbbb',
    { status: 'ok', subscription: nodeRow }, 1893456000003);
  // Give the addon time to reach the locked INSERT, then release.
  await new Promise(resolve => setTimeout(resolve, 30));
  gateway.exec('COMMIT');
  gateway.prepare(`INSERT INTO provider_subscriptions(vendor,account_id,subscription_json,observed_at,last_attempt_at)
    VALUES (?,?,?,?,?) ON CONFLICT(vendor,account_id) DO UPDATE SET
    subscription_json=excluded.subscription_json,observed_at=excluded.observed_at,
    last_attempt_at=excluded.last_attempt_at`)
    .run('codex', 'cccccccccccccccc', JSON.stringify(gatewayRow), 1893456000001, 1893456000001);
  await record;

  const reader = new DatabaseSync(file);
  const rows = reader.prepare('SELECT vendor,account_id,subscription_json FROM provider_subscriptions ORDER BY account_id').all();
  reader.close();
  const byAccount = Object.fromEntries(rows.map(row => [`${row.vendor}:${row.account_id}`, JSON.parse(row.subscription_json)]));
  assert.deepEqual(byAccount['codex:bbbbbbbbbbbbbbbb'], nodeRow);
  assert.deepEqual(byAccount['codex:cccccccccccccccc'], gatewayRow);
});

function createCacheTable(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_subscriptions (
    vendor TEXT NOT NULL, account_id TEXT NOT NULL, subscription_json TEXT,
    observed_at REAL NOT NULL DEFAULT 0, last_attempt_at REAL NOT NULL,
    PRIMARY KEY(vendor, account_id)) WITHOUT ROWID;`);
  return db;
}

function writeRow(db, vendor, account, subscription, at) {
  db.prepare(`INSERT INTO provider_subscriptions(vendor,account_id,subscription_json,observed_at,last_attempt_at)
    VALUES (?,?,?,?,?) ON CONFLICT(vendor,account_id) DO UPDATE SET
    subscription_json=excluded.subscription_json,observed_at=excluded.observed_at,
    last_attempt_at=excluded.last_attempt_at`)
    .run(vendor, account, subscription == null ? null : JSON.stringify(subscription),
      subscription?.observedAt ?? 0, at);
}

test('record 之后落库的外部写入不会被事后指纹吞掉（确定性复现）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-limit-cache.db');
  const seed = createCacheTable(file);
  seed.close();

  const RACE = 'abcdefabcdefabcd';
  const fakes = {
    accountSubscriptionCache(_file, text) {
      const input = JSON.parse(text);
      if (input.operation === 'record') {
        // The gateway writes a *different* row after the native kernel took
        // its post-write table but before the host bridge sees the answer.
        const other = new (require('node:sqlite').DatabaseSync)(file);
        writeRow(other, 'claude', RACE, {
          nextBillingAt: 1900000000000, currentPeriodEnd: null, autoRenew: true,
          observedAt: 1893456000000, source: 'profile',
        }, 1893456000001);
        other.close();
        // Deliberately omit the gateway row from the returned table.
        return JSON.stringify({ 'codex:1111111111111111': { subscription: null, lastAttemptAt: 1 } });
      }
      const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
      const entries = {};
      for (const row of db.prepare('SELECT vendor,account_id,subscription_json,last_attempt_at FROM provider_subscriptions').all()) {
        entries[`${row.vendor}:${row.account_id}`] = {
          subscription: row.subscription_json == null ? null : JSON.parse(row.subscription_json),
          lastAttemptAt: row.last_attempt_at,
        };
      }
      db.close();
      return JSON.stringify(entries);
    },
    projectAccountSubscriptions(text) {
      return JSON.stringify(JSON.parse(text).providers);
    },
  };

  const runtimePath = require.resolve('../src/native/runtime');
  const cachePath = require.resolve('../src/quota/account-subscription-cache');
  const runtime = require(runtimePath);
  const saved = { getNative: runtime.getNative, runNative: runtime.runNative };
  t.after(() => {
    runtime.getNative = saved.getNative;
    runtime.runNative = saved.runNative;
    delete require.cache[cachePath];
    require(cachePath);
  });
  runtime.getNative = () => fakes;
  runtime.runNative = operation => Promise.resolve().then(operation);
  delete require.cache[cachePath];
  const cache = require(cachePath);
  cache.configure({ file });

  await cache.record('codex', '1111111111111111', { status: 'ok' }, Date.now());
  // Before the fix the host stored the post-record stamp, which already
  // included this row, so project() never reloaded and the snapshot stayed
  // permanently stale. After the fix the record clears the fingerprint and
  // the next project() starts exactly one re-read.
  let seen = false;
  for (let i = 0; i < 50 && !seen; i += 1) {
    cache.project([]);
    for (let j = 0; j < 20 && !seen; j += 1) {
      await new Promise(resolve => setImmediate(resolve));
      seen = Boolean(cache.snapshot()[`claude:${RACE}`]);
    }
  }
  assert.equal(seen, true, 'project() must eventually observe a gateway row written during record');
});

test('多写者、record 与 project 交错时所有写入最终都可见', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-subscription-stress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'provider-limit-cache.db');
  subscriptions.configure({ file });
  await subscriptions.ready();
  const a = createCacheTable(file);
  const b = new (require('node:sqlite').DatabaseSync)(file);
  for (const db of [a, b]) db.exec('PRAGMA busy_timeout = 5000');
  t.after(() => { try { a.close(); } catch (_) {} try { b.close(); } catch (_) {} });

  let seed = 0x2545f491;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const expected = new Set();
  const writers = [a, b];
  for (let round = 0; round < 40; round += 1) {
    const account = (0x1000000000000000n + BigInt(round)).toString(16);
    const writer = writers[round % 2];
    const at = 1893456000000 + round;
    writeRow(writer, 'claude', account, {
      nextBillingAt: 1900000000000 + round, currentPeriodEnd: null, autoRenew: true,
      observedAt: at, source: 'profile',
    }, at);
    expected.add(`claude:${account}`);
    if (random() < 0.7) {
      const rec = (0x2000000000000000n + BigInt(round)).toString(16);
      await subscriptions.record('claude', rec, {
        status: 'ok', subscription: {
          nextBillingAt: 1900000001000 + round, currentPeriodEnd: null, autoRenew: true,
          observedAt: at + 1, source: 'profile',
        },
      }, at + 1);
      expected.add(`claude:${rec}`);
    }
    subscriptions.project([]);
    if (round % 5 === 0) await new Promise(resolve => setTimeout(resolve, 2));
  }

  let missing = [...expected];
  for (let step = 0; step < 400 && missing.length; step += 1) {
    subscriptions.project([]);
    await new Promise(resolve => setTimeout(resolve, 3));
    const snapshot = subscriptions.snapshot();
    missing = [...expected].filter(key => !(key in snapshot));
  }
  assert.deepEqual(missing, [], 'every concurrent write must become visible within a finite number of project() calls');
});

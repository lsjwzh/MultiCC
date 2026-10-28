'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-test-virtual-provider-'));
process.env.MULTICC_DATA_DIR = root;
const core = require('../src/providers/core');
const virtual = require('../src/providers/virtual-provider');
const { createProviderLimitCache } = require('../src/quota/provider-limit-cache');
const { createLimitRecorder } = require('../src/quota/limit-cache-recorder');
const { createProviderRelayShareStore } = require('../src/providers/relay-share-store');
const { createInstance, listen, listenHttp, closeServer, serverOrigin, postJson, ACCESS_TOKEN } = require('./helpers/provider-sharing');
const native = require('../src/native/runtime').getNative('virtual_provider');
const available = typeof native?.selectVirtualProvider === 'function';
if (process.env.MULTICC_REQUIRE_RUST_TESTS === '1') assert.ok(available, 'build the virtual provider Rust addon');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('virtual provider CRUD, durable quota failover and scoped sharing use real Rust HTTP requests', { skip: !available, timeout: 20000 }, async t => {
  const requests = [];
  const upstream = await listenHttp(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/empty')) { res.writeHead(429); res.end('{"error":"quota exhausted"}'); return; }
    if (req.url.startsWith('/ambiguous')) { res.writeHead(500); res.end('{"error":"upstream unavailable"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now()/1000)+3600) });
    res.end(JSON.stringify({ id: 'fixture', type: 'message', object: 'response', role: 'assistant', model: 'shared-model',
      content: [{ type: 'text', text: 'ok' }], output: [], usage: { input_tokens: 2, output_tokens: 1 } }));
  }, '127.0.0.1');
  t.after(() => closeServer(upstream));
  const cache = createProviderLimitCache({ file: path.join(root, 'limits.db') });
  const recorder = createLimitRecorder({ cache, persistedSessions: new Map(), providers: core });
  virtual.configure({ cache, recordDto: recorder.recordDto });
  t.after(() => cache.close());
  const shares = createProviderRelayShareStore({ file: path.join(root, 'shares.json') });
  const host = createInstance({ providers: core, providerRelayShares: shares, defaultsFile: path.join(root, 'defaults.json'), activity: [], backend: 'rust' });
  const server = await listen(host.app, '127.0.0.1');
  t.after(async () => { await host.close(); await closeServer(server); });
  const origin = serverOrigin(server), base = serverOrigin(upstream);
  for (const appType of ['claude', 'codex']) {
    await t.test(appType, async () => {
      const first = core.createProvider({ appType, name: 'Empty', baseUrl: `${base}/empty`, authToken: 'fixture-empty', model: 'shared-model' });
      const second = core.createProvider({ appType, name: 'Usable', baseUrl: `${base}/usable`, authToken: 'fixture-usable', model: 'shared-model' });
      const created = await postJson(`${origin}/api/providers`, { appType, name: 'Team pool', virtual: {
        strategy: 'ordered', members: [{ id: first.id }, { id: second.id }] } }, { 'x-access-token': ACCESS_TOKEN });
      assert.equal(created.response.status, 200);
      const id = created.body.id;
      assert.equal(core.getProvider(appType, id).virtual.members.length, 2);
      const summary = core.getProviderSummary(appType, id);
      assert.equal(summary.isOfficial, false); assert.equal(summary.hasToken, false);
      assert.deepEqual(summary.compatibleClis, [appType, `${appType}-exp`]);
      const shared = await postJson(`${origin}/api/providers/${appType}/${id}/relay-share`, {
        publicBaseUrl: origin, token: 'fixture-share-secret', label: 'Team' }, { 'x-access-token': ACCESS_TOKEN });
      assert.equal(shared.response.status, 200);
      const payload = JSON.parse(Buffer.from(shared.body.code.split('.')[1], 'base64url').toString());
      assert.ok(payload.authToken.startsWith('mcr1.'));
      assert.doesNotMatch(shared.body.code, /fixture-usable|fixture-empty/);
      const url = `${shared.body.baseUrl}/${appType === 'claude' ? 'v1/messages' : 'responses'}`;
      const body = appType === 'claude' ? { model: 'shared-model', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }
        : { model: 'shared-model', input: 'hello', stream: false };
      const before = requests.length;
      const result = await postJson(url, body, { authorization: `Bearer ${payload.authToken}`, 'x-forwarded-for': '198.51.100.2' });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(requests.length - before, 2);
      assert.match(requests[before].url, /^\/empty/); assert.match(requests[before+1].url, /^\/usable/);
      assert.equal(requests[before+1].headers.authorization || requests[before+1].headers['x-api-key'], appType === 'claude' ? 'Bearer fixture-usable' : 'Bearer fixture-usable');
      assert.equal(cache.get(appType, first.id).summary.status, 'rejected');
      const restored = createProviderLimitCache({ file: path.join(root, 'limits.db') });
      assert.equal(restored.get(appType, first.id).summary.status, 'rejected'); restored.close();
      const secondCall = requests.length;
      assert.equal((await postJson(url, body, { authorization: `Bearer ${payload.authToken}`, 'x-forwarded-for': '198.51.100.2' })).response.status, 200);
      assert.equal(requests.length - secondCall, 1, 'the empty member stays parked');
      const otherUrl = url.replace(id, second.id);
      assert.equal((await postJson(otherUrl, body, { authorization: `Bearer ${payload.authToken}`, 'x-forwarded-for': '198.51.100.2' })).response.status, 403);
      shares.revoke(shared.body.share.id);
      assert.equal((await postJson(url, body, { authorization: `Bearer ${payload.authToken}`, 'x-forwarded-for': '198.51.100.2' })).response.status, 403);
      core.updateProvider(appType, id, { virtual: { strategy: 'ordered', members: [{ id: second.id, expiresAt: Date.now()-1000 }] } });
      assert.equal(virtual.status(core.getProvider(appType, id), core.listProviders()).availableCount, 0);
      const expiredStart = requests.length;
      assert.equal((await postJson(url, body, { 'x-access-token': ACCESS_TOKEN })).response.status, 503);
      assert.equal(requests.length, expiredStart, 'expired pools must not dial a member or the placeholder');
      const balance = require('../src/routes/provider-balance').createProviderBalanceRuntime(core);
      assert.deepEqual(await balance.queryOne(appType, id), { ok: false, reason: 'no_available_member', providerId: id, appType, virtual: true });
      const ambiguous = core.createProvider({ appType, name: 'Ambiguous', baseUrl: `${base}/ambiguous`, authToken: 'fixture-ambiguous', model: 'shared-model' });
      core.updateProvider(appType, id, { virtual: { strategy: 'ordered', members: [{ id: ambiguous.id }, { id: second.id }] } });
      const ambiguousStart = requests.length;
      assert.equal((await postJson(url, body, { 'x-access-token': ACCESS_TOKEN })).response.status, 500);
      assert.equal(requests.length - ambiguousStart, 1, 'ambiguous failures must not replay generation');
      core.updateProvider(appType, id, { virtual: { strategy: 'ordered', members: [{ id: ambiguous.id }, { id: second.id }] } });
      recorder.recordDto(appType, ambiguous.id, { kind: 'balance', available: true, total: 0, currency: 'CNY' });
      const depletedStart = requests.length;
      assert.equal((await postJson(url, body, { 'x-access-token': ACCESS_TOKEN })).response.status, 200);
      assert.equal(requests.length - depletedStart, 1, '生产缓存中的零余额成员必须在拨号前跳过');
      assert.match(requests[depletedStart].url, /^\/usable/);
    });
  }
});

test('virtual validation rejects cross-CLI and nested members without mutating the store', { skip: !available }, () => {
  const claude = core.createProvider({ appType: 'claude', name: 'Claude', baseUrl: 'https://example.invalid', authToken: 'test', model: 'm' });
  const before = fs.readFileSync(path.join(root, 'providers.json'), 'utf8');
  assert.throws(() => core.createProvider({ appType: 'codex', name: 'invalid', virtual: { members: [{ id: claude.id }] } }), /相同 CLI/);
  assert.equal(fs.readFileSync(path.join(root, 'providers.json'), 'utf8'), before);
});

test('账号订阅查询持久化后参与自动切换，续费恢复、失败及旧快照不会串号或覆盖新数据', { skip: !available }, async t => {
  const subscriptions = require('../src/quota/account-subscription-cache');
  const { mountAccountSubscriptionRoute } = require('../src/routes/account-subscription');
  const account = 'aaaaaaaaaaaaaaaa', other = 'bbbbbbbbbbbbbbbb';
  const file = path.join(root, 'subscription-limits.db');
  const cache = createProviderLimitCache({ file });
  subscriptions.configure({ file }); virtual.configure({ cache });
  const now = Date.now();
  const members = [account, other].map(id => ({ id: `claude-official-${id}`, appType: 'claude',
    isOfficial: true, officialAccountId: id, modelOptions: ['m'], name: id,
    subscription: { autoRenew: true, observedAt: now - 100000, currentPeriodEnd: now - 1000 } }));
  const pool = { id: 'subscription-pool', appType: 'claude', virtual: { strategy: 'ordered', members: members.map(p => ({ id: p.id })) } };
  const oldList = core.listProviders;
  core.listProviders = () => members;
  t.after(() => { core.listProviders = oldList; subscriptions.configure(); virtual.configure(); virtual.setRefresher(null); cache.close(); });
  let calls = 0, handler, cancelled = true;
  mountAccountSubscriptionRoute({ get(_, fn) { handler = fn; } }, 'claude', {
    accounts: { listClaudeAccounts: () => [{ id: account }, { id: other }] },
    credentials: { peekAccountToken: async id => ({ token: `fixture-${id}` }) },
    fetch: async (_, options) => {
      calls++;
      const first = options.headers.Authorization === `Bearer fixture-${account}`;
      return new Response(JSON.stringify({ account: { email: 'private@example.invalid', subscription: {
        current_period_end: new Date(first && cancelled ? now - 1000 : now + 86400000).toISOString(),
        auto_renew: !(first && cancelled), next_payment_date: new Date(now + 86400000).toISOString(),
      } } }));
    },
  });
  virtual.setRefresher(async (appType, id) => cache.record(appType, id, { kind: 'window',
    summary: { kind: 'window', usedPercentage: 10 }, fetchedAt: Date.now() }));
  await virtual.refresh(pool);
  assert.equal(calls, 2, '路由前自动读取每个账号的订阅');
  assert.equal(virtual.status(pool, members).selectedId, members[1].id);
  assert.equal(subscriptions.project(members)[0].subscription.autoRenew, false);
  await virtual.refresh(pool);
  assert.equal(calls, 2, '五分钟内不重复查询订阅');
  subscriptions.configure({ file }); await subscriptions.ready();
  assert.equal(virtual.status(pool, members).selectedId, members[1].id, '重开数据库后仍跳过已到期成员');
  await subscriptions.record('claude', account, { status: 'unavailable' }, Date.now());
  await subscriptions.record('claude', account, { status: 'ok', subscription: members[0].subscription }, Date.now());
  assert.equal(virtual.status(pool, members).selectedId, members[1].id, '失败及旧登录快照不覆盖较新的取消续费');
  assert.equal(subscriptions.project([{ ...members[0], isOfficial: false }])[0].subscription.autoRenew, true, '普通线路不能串用官方账号缓存');
  cancelled = false;
  await handler({ query: { account } }, { set() {}, json() {} });
  assert.equal(virtual.status(pool, members).selectedId, members[0].id, '新的实时续费观察恢复该成员');
  assert.ok(subscriptions.project(members)[0].subscription.nextBillingAt > now);
  const disk = JSON.parse(await native.accountSubscriptionCache(file, JSON.stringify({ operation: 'read' })));
  assert.doesNotMatch(JSON.stringify(disk), /fixture|private@example|access_token/);
  const noAuth = { ...members[0], needsLogin: true };
  assert.equal(virtual.status(pool, [noAuth, members[1]]).selectedId, members[1].id, '订阅仍在有效期不代表凭据可用');
});

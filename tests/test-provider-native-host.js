'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createNativeProviderStore } = require('../src/providers/native-store');
const { credential, readCli } = require('../src/providers/native-credentials');
const native = require('../src/native/runtime').getNative('provider_store', 'rust');
const { createHopCredentialStore } = require(path.join(path.dirname(require.resolve('cli-provider-router')), 'proxy/hop-credentials'));
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-native-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('原子 Provider 存储保留旧格式字段，并拒绝损坏配置与过期编辑覆盖', t => {
  const root = temp(t), file = path.join(root, 'providers.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, metadata: { keep: true }, providers: [{ id: 'old' }] }));
  const a = createNativeProviderStore(file), b = createNativeProviderStore(file);
  const first = a.read(), stale = b.read();
  first.push({ id: 'new' }); a.write(first);
  stale.push({ id: 'lost' });
  assert.throws(() => b.write(stale), /PROVIDER_STORE_CONFLICT/);
  assert.deepEqual(a.read().map(p => p.id), ['old', 'new']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).metadata, { keep: true });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'broken-private-data');
  assert.throws(() => a.read(), error => error.message === 'PROVIDER_STORE_INVALID_JSON');
  assert.throws(() => a.write(first), /PROVIDER_STORE_INVALID_JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken-private-data');
  fs.rmSync(file);
  const empty = a.read(); assert.deepEqual(empty, []); empty.push({ id: 'array' }); a.write(empty);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file))));
});

test('跨进程写入只能有一个胜者，不会静默覆盖配置', async t => {
  const file = path.join(temp(t), 'providers.json');
  const store = createNativeProviderStore(file), initial = store.read(); store.write(initial);
  const snapshot = JSON.parse(native.providerStore(file, '{"operation":"read"}'));
  const script = `const n=require('./src/native/runtime').getNative('provider_store','rust');try { n.providerStore(process.argv[1],process.argv[2]);process.exitCode=0; }catch(e){ process.exitCode=/PROVIDER_STORE_(CONFLICT|BUSY)/.test(e.message)?2:3; }`;
  const writes = [1, 2].map(id => new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', script, file,
      JSON.stringify({ operation: 'write', revision: snapshot.revision, records: [{ id }] })], { stdio: 'ignore' });
    child.on('exit', resolve); child.on('error', () => resolve(3));
  }));
  assert.deepEqual((await Promise.all(writes)).sort(), [0, 2]);
  assert.equal(store.read().length, 1);
});

test('凭据轮换逐次重读；账号删除和损坏绝不回退到全局账号', async t => {
  const file = path.join(temp(t), 'auth.json');
  const write = token => credential({ operation: 'writeJson', file, data: { tokens: { access_token: token, account_id: 'account-a' } } });
  write('fixture-first');
  assert.equal(credential({ operation: 'codexAuth', file }).accessToken, 'fixture-first');
  write('fixture-rotated');
  assert.equal(credential({ operation: 'codexAuth', file }).accessToken, 'fixture-rotated');
  fs.writeFileSync(file, '{broken');
  assert.equal(credential({ operation: 'codexAuth', file }), null);
  assert.throws(() => write('must-not-overwrite'), /PROVIDER_STORE_INVALID_JSON/);
  fs.rmSync(file);
  assert.equal(credential({ operation: 'codexAuth', file }), null);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-cli', expiresAt: Date.now() + 60000 } }));
  const cli = await readCli({ platform: 'linux', file });
  assert.equal(cli.accessToken, 'fixture-cli'); assert.equal(cli.store, 'file');
});

test('Rust 验证既有能力凭据格式、路由作用域、过期与即时撤销', async t => {
  const file = path.join(temp(t), 'hop.json');
  const store = createHopCredentialStore({ dataFile: file });
  const route = { cli: 'claude', providerId: 'pool', sessionId: 'direct-example', roleKind: 'main' };
  const issued = store.issue(route);
  const verify = (overrides = {}) => native.authorizeProviderRequest(JSON.stringify({ file, route, headers: { authorization: `Bearer ${issued.token}` }, now: Date.now(), ...overrides })).then(JSON.parse);
  assert.equal((await verify()).ok, true);
  assert.equal((await verify({ route: { ...route, providerId: 'member' } })).ok, false);
  assert.equal((await verify({ headers: { authorization: 'Bearer different' } })).reason, 'mismatch');
  assert.equal((await verify({ now: issued.expiresAt })).reason, 'expired');
  store.revoke({ id: issued.id });
  assert.equal((await verify()).reason, 'revoked');
  fs.writeFileSync(file, '{private-corrupt');
  await assert.rejects(verify(), /PROVIDER_STORE_INVALID_JSON/);
});

test('Rust 订阅查询使用指定出口，不跟随重定向，错误返回不泄露凭据', async t => {
  let leaked = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/leak' }); return res.end(); }
    if (req.url === '/leak') leaked = true;
    if (req.url === '/large') return res.end('x'.repeat(1024 * 1024 + 1));
    if (req.url === '/auth') { res.writeHead(401); return res.end('private-token'); }
    res.end(JSON.stringify({ subscription: { next_billing_at: '2030-01-01' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = (suffix, proxyUrl) => native.queryAccountSubscription(JSON.stringify({ vendor: 'claude', url: base + suffix, headers: { Authorization: 'Bearer fixture-secret' }, proxyUrl })).then(JSON.parse);
  assert.equal((await query('/ok')).subscription.nextBillingAt, Date.parse('2030-01-01'));
  assert.deepEqual(await query('/auth'), { status: 'no_auth' });
  assert.deepEqual(await query('/redirect'), { status: 'unavailable' }); assert.equal(leaked, false);
  assert.deepEqual(await query('/large'), { status: 'unavailable' });
  assert.deepEqual(await query('/ok', 'http://127.0.0.1:1'), { status: 'unavailable' }, '出口失败不能直连');
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertTestDir } = require('../src/paths');
const {
  createProviderRelayShareStore,
  parseCredential,
  relayRouteFromBaseUrl,
  routeTarget,
} = require('../src/providers/relay-share-store');

test('provider relay shares are scoped, hashed, durable, revocable and usage-accounted', async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-shares-')));
  const file = path.join(root, 'provider-relay-shares.json');
  let time = 1_000;
  const make = () => createProviderRelayShareStore({ file, now: () => time });
  const store = make();
  const first = (await store.create({
    appType: 'claude',
    providerId: 'glm-provider',
    providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'first-manual-secret',
    label: 'office mac',
  }));
  const second = (await store.create({
    appType: 'claude',
    providerId: 'glm-provider',
    providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'second-manual-secret',
    label: 'home mac',
  }));

  assert.equal(parseCredential(first.credential).id, first.share.id);
  assert.deepEqual(routeTarget('/claude-proxy/glm-provider/remote/v1/messages'), {
    appType: 'claude', providerId: 'glm-provider',
  });
  assert.equal(routeTarget('/claude-proxy/glm-provider/speedtest/v1/messages'), null);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('first-manual-secret'), false);
  assert.equal(disk.includes(first.credential), false);
  assert.equal(JSON.stringify((await store.list())).includes('second-manual-secret'), false);

  time = 1_100;
  let decision = (await store.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  }));
  assert.equal(decision.ok, true);
  let listed = (await store.list({ appType: 'claude', providerId: 'glm-provider' }));
  const used = listed.find(record => record.id === first.share.id);
  assert.equal(used.accessCount, 1);
  assert.equal(used.lastUsedAt, 1_100);

  decision = (await store.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/another-provider/remote/v1/messages',
  }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'relay_share_scope_mismatch');
  assert.equal((await store.list()).find(record => record.id === first.share.id).accessCount, 1);

  const reloaded = make();
  assert.equal((await reloaded.list()).find(record => record.id === first.share.id).accessCount, 1);
  assert.equal((await reloaded.revoke(first.share.id)).status, 'revoked');
  assert.equal((await reloaded.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  })).ok, false);
  assert.equal((await reloaded.authorize({
    credential: second.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  })).ok, true, 'revoking one link leaves the other link active');

  listed = (await reloaded.list());
  assert.equal(listed.find(record => record.id === first.share.id).status, 'revoked');
  assert.equal(listed.find(record => record.id === second.share.id).accessCount, 1);
});

test('relay credentials cannot cross protocol or host-route boundaries', async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-scope-')));
  const store = createProviderRelayShareStore({
    file: path.join(root, 'provider-relay-shares.json'),
  });
  const created = (await store.create({
    appType: 'codex',
    providerId: 'official',
    providerName: 'Official',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'codex-manual-secret',
  }));
  assert.equal((await store.authorize({
    credential: created.credential,
    pathname: '/codex-proxy/official/responses',
  })).ok, true);
  for (const pathname of [
    '/claude-proxy/official/remote/v1/messages',
    '/api/providers',
    '/claude-proxy/official/speedtest/v1/messages',
  ]) {
    assert.equal((await store.authorize({ credential: created.credential, pathname })).ok, false, pathname);
  }
  await assert.rejects(() => store.create({
    appType: 'claude', providerId: 'p', publicBaseUrl: 'https://x',
    relayBaseUrl: 'https://x/claude-proxy/p/remote', token: 'short',
  }), /relay token/);
});

test('an active share can be copied again from its sealed copy, never from plaintext on disk', async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-seal-')));
  const file = path.join(root, 'provider-relay-shares.json');
  const make = () => createProviderRelayShareStore({ file });
  const store = make();
  const created = (await store.create({
    appType: 'claude', providerId: 'glm-provider', providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'sealed-manual-secret',
  }));
  assert.equal(created.share.recoverable, true);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('sealed-manual-secret'), false, 'no plaintext secret on disk');
  assert.equal(disk.includes(created.credential), false, 'no plaintext credential on disk');
  assert.equal(JSON.stringify((await store.list())).includes('credentialSealed'), false, 'list() never exposes the sealed copy');
  assert.equal(fs.statSync(`${file}.key`).mode & 0o077, 0, 'key file is owner-only');

  // A reloaded store (restart) still returns the exact same credential.
  const again = (await make().getCredential(created.share.id));
  assert.equal(again.ok, true);
  assert.equal(again.credential, created.credential);
  assert.equal((await make().authorize({
    credential: again.credential, pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  })).ok, true, 'the copied credential is the working one');

  assert.deepEqual({ ...(await store.getCredential('missing')) }, { ok: false, code: 'not_found' });
  (await store.revoke(created.share.id));
  assert.deepEqual({ ...(await store.getCredential(created.share.id)) }, { ok: false, code: 'revoked' });
  assert.equal((await store.list())[0].recoverable, false);
});

test('shares created before sealing existed, or with a lost key, report not_recoverable', async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-legacy-')));
  const file = path.join(root, 'provider-relay-shares.json');
  const store = createProviderRelayShareStore({ file });
  const created = (await store.create({
    appType: 'codex', providerId: 'official', providerName: 'Official',
    publicBaseUrl: 'https://relay.example', relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'legacy-manual-secret',
  }));
  // Legacy record: strip the sealed copy as pre-feature versions never wrote it.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.data;
  for (const row of rows) delete row.credentialSealed;
  fs.writeFileSync(file, JSON.stringify(parsed));
  const legacy = createProviderRelayShareStore({ file });
  assert.equal((await legacy.list())[0].recoverable, false);
  assert.equal((await legacy.getCredential(created.share.id)).code, 'not_recoverable');
  assert.equal((await legacy.authorize({ credential: created.credential, pathname: '/codex-proxy/official/responses' })).ok, true,
    'a legacy share keeps working; it just cannot be copied again');

  // Lost/rotated key: sealed data cannot be opened, and the store never guesses.
  const sealed = createProviderRelayShareStore({ file: path.join(root, 'b.json') });
  const second = (await sealed.create({
    appType: 'codex', providerId: 'official', providerName: 'Official',
    publicBaseUrl: 'https://relay.example', relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'rotated-manual-secret',
  }));
  fs.writeFileSync(path.join(root, 'b.json.key'), 'ab'.repeat(32));
  const rotated = createProviderRelayShareStore({ file: path.join(root, 'b.json') });
  assert.equal((await rotated.getCredential(second.share.id)).code, 'not_recoverable');
});

// ── relayRouteFromBaseUrl：导入方识别借道链接 ────────────────────────────────

test('relayRouteFromBaseUrl recognizes lender relay endpoints on both protocols', async () => {
  assert.deepEqual(
    relayRouteFromBaseUrl('https://relay.example:3000/claude-proxy/glm/remote'),
    { appType: 'claude', providerId: 'glm', url: 'https://relay.example:3000/claude-proxy/glm/remote' },
  );
  // Extra subpaths and trailing slashes normalize back to the endpoint itself.
  assert.deepEqual(
    relayRouteFromBaseUrl('http://192.168.1.9:3000/claude-proxy/glm/remote/v1/messages/'),
    { appType: 'claude', providerId: 'glm', url: 'http://192.168.1.9:3000/claude-proxy/glm/remote' },
  );
  assert.deepEqual(
    relayRouteFromBaseUrl('https://macbook.example-host.ts.net/codex-proxy/official'),
    { appType: 'codex', providerId: 'official', url: 'https://macbook.example-host.ts.net/codex-proxy/official' },
  );
  // URL-encoded provider ids round-trip encoded.
  assert.deepEqual(
    relayRouteFromBaseUrl('https://relay.example/codex-proxy/my%20provider'),
    { appType: 'codex', providerId: 'my provider', url: 'https://relay.example/codex-proxy/my%20provider' },
  );
});

test('relayRouteFromBaseUrl rejects loopback, local plumbing and non-relay URLs', async () => {
  // Loopback /claude-proxy、/codex-proxy 是本机 CPR 自己的管线，绝不算借道。
  for (const url of [
    'http://127.0.0.1:3000/codex-proxy/abc',
    'http://localhost:3000/claude-proxy/abc/remote',
    'http://[::1]:3000/claude-proxy/abc/remote',
  ]) {
    assert.equal(relayRouteFromBaseUrl(url), null, url);
  }
  // 本机 aux/speedtest 桶、非中转路径、非 http(s)、垃圾输入。
  for (const url of [
    'https://relay.example/claude-proxy/abc/aux/v1/messages',
    'https://relay.example/claude-proxy/abc/speedtest/v1/messages',
    'https://relay.example/claude-proxy/abc',
    'https://open.bigmodel.cn/api/paas/v4',
    'ftp://relay.example/claude-proxy/abc/remote',
    'not a url',
    '',
  ]) {
    assert.equal(relayRouteFromBaseUrl(url), null, url);
  }
});

// The oracle remains under tests only. Production has no JS crypto or writer.
const legacyRelay = require('./helpers/legacy-relay-share-store');
const relayInput = (overrides = {}) => ({
  appType: 'claude', providerId: '提供方😀', providerName: 'Relay',
  publicBaseUrl: 'https://relay.example',
  relayBaseUrl: 'https://relay.example/claude-proxy/p/remote',
  token: 'fixture-only-secret', label: '共享\ud800', ...overrides,
});
function relayFixture(t) {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'shares.json') };
}
const jsonValue = value => JSON.parse(JSON.stringify(value));

test('native relay parser matches the old URL and credential boundary contracts', () => {
  const segments = ['p', 'my%20provider', '%2F', '%00', '%E4%B8%AD', '%F0%9F%98%80', '%ED%A0%80', '%FF', '%', '..', '%2e', 'x%2Fy', "a!b'()", ''];
  const prefixes = ['', '/', '//example.com/', 'https://EXAMPLE.com:443/', 'http://127.1/', 'http://[::1]/', 'ftp://example.com/'];
  let count = 0;
  for (const prefix of prefixes) for (const segment of segments) for (const lane of ['codex-proxy', 'claude-proxy']) {
    const input = `${prefix}${lane}/${segment}/remote/v1?x=1#fragment`;
    for (const fn of ['routeTarget', 'relayRouteFromBaseUrl']) {
      const actual = fn === 'routeTarget' ? routeTarget(input) : relayRouteFromBaseUrl(input);
      assert.deepEqual(actual, legacyRelay[fn](input), `${fn}: ${input}`);
      count++;
    }
  }
  for (const value of [null, 1, {}, [], ['x'], 'mcr1.abcdefghijklmnop.12345678',
    ' mcr1.abcdefghijklmnop.1234.5678 ', 'mcr1.abcdefghijklmnop.1234 5678',
    'mcr1.abcdefghijklmnop.中文字符', 'mcr1.abcdefghijklmnop.' + 'x'.repeat(128),
    'mcr1.abcdefghijklmnop.' + 'x'.repeat(129), 'mcr1.abcdefghijklmno.12345678']) {
    assert.deepEqual(parseCredential(value), legacyRelay.parseCredential(value));
  }
  assert.equal(count, 392);
});

test('legacy and native owners mutually read sealed credentials, usage, revocations and unknown UTF-16 fields', async t => {
  const { file } = relayFixture(t);
  const now = () => 12345678;
  const old = legacyRelay.createProviderRelayShareStore({ file, now });
  const first = old.create(relayInput());
  let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.data[0].future = { '10': 'ten', '2': 'two', surrogate: '\ud800', nested: [null, '😀'] };
  fs.writeFileSync(file, JSON.stringify(disk));
  const native = createProviderRelayShareStore({ file, now });
  assert.deepEqual(await native.getCredential(first.share.id), old.getCredential(first.share.id));
  assert.deepEqual(await native.list(), jsonValue(old.list()));
  assert.equal((await native.authorize({ credential: first.credential,
    pathname: '/claude-proxy/%E6%8F%90%E4%BE%9B%E6%96%B9%F0%9F%98%80/remote/v1' })).ok, true);
  const second = await native.create(relayInput({ token: 'native-created-fixture', appType: 'codex', providerId: 'native' }));
  const rollback = legacyRelay.createProviderRelayShareStore({ file, now });
  assert.deepEqual(rollback.getCredential(second.share.id), await native.getCredential(second.share.id));
  assert.deepEqual(rollback.list(), await native.list());
  assert.equal(rollback.authorize({ credential: second.credential, pathname: '/codex-proxy/native/responses' }).ok, true);
  rollback.revoke(first.share.id);
  const restart = createProviderRelayShareStore({ file, now });
  assert.equal((await restart.getCredential(first.share.id)).code, 'revoked');
  assert.equal((await restart.authorize({ credential: first.credential,
    pathname: '/claude-proxy/%E6%8F%90%E4%BE%9B%E6%96%B9%F0%9F%98%80/remote/v1' })).code, 'relay_share_inactive');
  assert.deepEqual(await restart.list(), rollback.list());
  assert.equal(await restart.revokeProvider('codex', 'native'), 1);
  assert.equal((await restart.authorize({ credential: second.credential, pathname: '/codex-proxy/native/responses' })).ok, false);
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.data[0].future, { '10': 'ten', '2': 'two', surrogate: '\ud800', nested: [null, '😀'] });
  assert.equal(disk.__multiccSchema.kind, 'provider-relay-shares');
  assert.equal(disk.__multiccSchema.version, 1);
  assert.equal(disk.data[1].accessCount, 1);
  assert.equal(disk.data[1].lastUsedAt, now());
  for (const suffix of ['', '.key', '.bak1', '.bak2', '.bak3']) {
    const raw = fs.readFileSync(file + suffix, 'utf8');
    assert.equal(raw.includes(first.credential), false);
    assert.equal(raw.includes(second.credential), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file + suffix).mode & 0o077, 0);
  }
});

test('raw legacy arrays, damaged primaries and rolling backups have identical recovery decisions', async t => {
  const { root } = relayFixture(t);
  const options = { now: () => 1234 };
  const seed = path.join(root, 'seed.json');
  const old = legacyRelay.createProviderRelayShareStore({ file: seed, ...options });
  const first = old.create(relayInput());
  const envelope = fs.readFileSync(seed, 'utf8');
  const array = JSON.stringify(JSON.parse(envelope).data);
  const cases = [
    [null, envelope], [array], [envelope], ['{', envelope], ['{}', '{', array],
    ['{', '{}', '{', envelope], ['{', '{}', '{', '{}'], ['null'],
    ['{"__multiccSchema":1,"data":{}}', envelope],
  ];
  for (let i = 0; i < cases.length; i++) {
    const file = path.join(root, `case-${i}.json`);
    cases[i].forEach((value, n) => { if (value !== null) fs.writeFileSync(file + (n ? `.bak${n}` : ''), value); });
    fs.copyFileSync(seed + '.key', file + '.key');
    let expected;
    try { expected = legacyRelay.createProviderRelayShareStore({ file, ...options }).list(); }
    catch (error) { expected = error; }
    if (expected instanceof Error) {
      assert.throws(() => createProviderRelayShareStore({ file, ...options }), error => error.name === expected.name, `case ${i}`);
    } else {
      const store = createProviderRelayShareStore({ file, ...options });
      assert.deepEqual(await store.list(), expected, `case ${i}`);
      if (expected.length) assert.equal((await store.getCredential(first.share.id)).credential, first.credential);
    }
  }
});

test('native failed authorization writes never grant access or change memory and a later retry persists once', async t => {
  const { root } = relayFixture(t);
  const directory = path.join(root, 'live');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'shares.json');
  const store = createProviderRelayShareStore({ file, now: () => 1234 });
  const made = await store.create(relayInput({ providerId: 'p' }));
  const before = await store.list();
  const parked = path.join(root, 'parked');
  fs.renameSync(directory, parked);
  fs.writeFileSync(directory, 'not a directory');
  for (const action of [
    () => store.authorize({ credential: made.credential, pathname: '/claude-proxy/p/remote/v1/messages' }),
    () => store.revoke(made.share.id),
    () => store.create(relayInput({ providerId: 'new' })),
    () => store.revokeProvider('claude', 'p'),
  ]) {
    await assert.rejects(action, error => error.code === 'STATE_WRITE_FAILED');
    assert.deepEqual(await store.list(), before);
  }
  fs.unlinkSync(directory);
  fs.renameSync(parked, directory);
  assert.equal((await store.authorize({ credential: made.credential, pathname: '/claude-proxy/p/remote' })).ok, true);
  assert.equal((await store.list())[0].accessCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data[0].accessCount, 1);
});

test('queued requests preserve revoke order without blocking the JS event loop', async t => {
  const { file } = relayFixture(t);
  const store = createProviderRelayShareStore({ file, now: () => 1234 });
  const made = await store.create(relayInput({ providerId: 'p' }));
  const input = { credential: made.credential, pathname: '/claude-proxy/p/remote/v1/messages' };
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 1);
  try {
    const before = Array.from({ length: 12 }, () => store.authorize(input));
    const revocation = store.revoke(made.share.id);
    const after = Array.from({ length: 12 }, () => store.authorize(input));
    assert.ok((await Promise.all(before)).every(result => result.ok));
    assert.equal((await revocation).status, 'revoked');
    assert.ok((await Promise.all(after)).every(result => result.code === 'relay_share_inactive'));
    assert.equal((await store.list())[0].accessCount, 12);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data[0].accessCount, 12);
    assert.ok(ticks > 0, 'scrypt and writes must yield to the JS host');
  } finally { clearInterval(ticker); }
});

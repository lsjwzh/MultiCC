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

test('provider relay shares are scoped, hashed, durable, revocable and usage-accounted', () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-shares-')));
  const file = path.join(root, 'provider-relay-shares.json');
  let time = 1_000;
  const make = () => createProviderRelayShareStore({ file, now: () => time });
  const store = make();
  const first = store.create({
    appType: 'claude',
    providerId: 'glm-provider',
    providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'first-manual-secret',
    label: 'office mac',
  });
  const second = store.create({
    appType: 'claude',
    providerId: 'glm-provider',
    providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'second-manual-secret',
    label: 'home mac',
  });

  assert.equal(parseCredential(first.credential).id, first.share.id);
  assert.deepEqual(routeTarget('/claude-proxy/glm-provider/remote/v1/messages'), {
    appType: 'claude', providerId: 'glm-provider',
  });
  assert.equal(routeTarget('/claude-proxy/glm-provider/speedtest/v1/messages'), null);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('first-manual-secret'), false);
  assert.equal(disk.includes(first.credential), false);
  assert.equal(JSON.stringify(store.list()).includes('second-manual-secret'), false);

  time = 1_100;
  let decision = store.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  });
  assert.equal(decision.ok, true);
  let listed = store.list({ appType: 'claude', providerId: 'glm-provider' });
  const used = listed.find(record => record.id === first.share.id);
  assert.equal(used.accessCount, 1);
  assert.equal(used.lastUsedAt, 1_100);

  decision = store.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/another-provider/remote/v1/messages',
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'relay_share_scope_mismatch');
  assert.equal(store.list().find(record => record.id === first.share.id).accessCount, 1);

  const reloaded = make();
  assert.equal(reloaded.list().find(record => record.id === first.share.id).accessCount, 1);
  assert.equal(reloaded.revoke(first.share.id).status, 'revoked');
  assert.equal(reloaded.authorize({
    credential: first.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  }).ok, false);
  assert.equal(reloaded.authorize({
    credential: second.credential,
    pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  }).ok, true, 'revoking one link leaves the other link active');

  listed = reloaded.list();
  assert.equal(listed.find(record => record.id === first.share.id).status, 'revoked');
  assert.equal(listed.find(record => record.id === second.share.id).accessCount, 1);
});

test('relay credentials cannot cross protocol or host-route boundaries', () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-scope-')));
  const store = createProviderRelayShareStore({
    file: path.join(root, 'provider-relay-shares.json'),
  });
  const created = store.create({
    appType: 'codex',
    providerId: 'official',
    providerName: 'Official',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'codex-manual-secret',
  });
  assert.equal(store.authorize({
    credential: created.credential,
    pathname: '/codex-proxy/official/responses',
  }).ok, true);
  for (const pathname of [
    '/claude-proxy/official/remote/v1/messages',
    '/api/providers',
    '/claude-proxy/official/speedtest/v1/messages',
  ]) {
    assert.equal(store.authorize({ credential: created.credential, pathname }).ok, false, pathname);
  }
  assert.throws(() => store.create({
    appType: 'claude', providerId: 'p', publicBaseUrl: 'https://x',
    relayBaseUrl: 'https://x/claude-proxy/p/remote', token: 'short',
  }), /relay token/);
});

test('an active share can be copied again from its sealed copy, never from plaintext on disk', () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-seal-')));
  const file = path.join(root, 'provider-relay-shares.json');
  const make = () => createProviderRelayShareStore({ file });
  const store = make();
  const created = store.create({
    appType: 'claude', providerId: 'glm-provider', providerName: 'GLM',
    publicBaseUrl: 'https://relay.example',
    relayBaseUrl: 'https://relay.example/claude-proxy/glm-provider/remote',
    token: 'sealed-manual-secret',
  });
  assert.equal(created.share.recoverable, true);
  const disk = fs.readFileSync(file, 'utf8');
  assert.equal(disk.includes('sealed-manual-secret'), false, 'no plaintext secret on disk');
  assert.equal(disk.includes(created.credential), false, 'no plaintext credential on disk');
  assert.equal(JSON.stringify(store.list()).includes('credentialSealed'), false, 'list() never exposes the sealed copy');
  assert.equal(fs.statSync(`${file}.key`).mode & 0o077, 0, 'key file is owner-only');

  // A reloaded store (restart) still returns the exact same credential.
  const again = make().getCredential(created.share.id);
  assert.equal(again.ok, true);
  assert.equal(again.credential, created.credential);
  assert.equal(make().authorize({
    credential: again.credential, pathname: '/claude-proxy/glm-provider/remote/v1/messages',
  }).ok, true, 'the copied credential is the working one');

  assert.deepEqual({ ...store.getCredential('missing') }, { ok: false, code: 'not_found' });
  store.revoke(created.share.id);
  assert.deepEqual({ ...store.getCredential(created.share.id) }, { ok: false, code: 'revoked' });
  assert.equal(store.list()[0].recoverable, false);
});

test('shares created before sealing existed, or with a lost key, report not_recoverable', () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-relay-legacy-')));
  const file = path.join(root, 'provider-relay-shares.json');
  const store = createProviderRelayShareStore({ file });
  const created = store.create({
    appType: 'codex', providerId: 'official', providerName: 'Official',
    publicBaseUrl: 'https://relay.example', relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'legacy-manual-secret',
  });
  // Legacy record: strip the sealed copy as pre-feature versions never wrote it.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.data;
  for (const row of rows) delete row.credentialSealed;
  fs.writeFileSync(file, JSON.stringify(parsed));
  const legacy = createProviderRelayShareStore({ file });
  assert.equal(legacy.list()[0].recoverable, false);
  assert.equal(legacy.getCredential(created.share.id).code, 'not_recoverable');
  assert.equal(legacy.authorize({ credential: created.credential, pathname: '/codex-proxy/official/responses' }).ok, true,
    'a legacy share keeps working; it just cannot be copied again');

  // Lost/rotated key: sealed data cannot be opened, and the store never guesses.
  const sealed = createProviderRelayShareStore({ file: path.join(root, 'b.json') });
  const second = sealed.create({
    appType: 'codex', providerId: 'official', providerName: 'Official',
    publicBaseUrl: 'https://relay.example', relayBaseUrl: 'https://relay.example/codex-proxy/official',
    token: 'rotated-manual-secret',
  });
  fs.writeFileSync(path.join(root, 'b.json.key'), 'ab'.repeat(32));
  const rotated = createProviderRelayShareStore({ file: path.join(root, 'b.json') });
  assert.equal(rotated.getCredential(second.share.id).code, 'not_recoverable');
});

// ── relayRouteFromBaseUrl：导入方识别借道链接 ────────────────────────────────

test('relayRouteFromBaseUrl recognizes lender relay endpoints on both protocols', () => {
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

test('relayRouteFromBaseUrl rejects loopback, local plumbing and non-relay URLs', () => {
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

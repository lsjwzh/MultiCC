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
  routeTarget,
} = require('../src/provider-relay-share-store');

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

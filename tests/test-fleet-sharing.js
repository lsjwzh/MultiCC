'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  FleetSharingError,
  blockedAddress,
  createFleetSharing,
  normalizeShareUrl,
} = require('../src/fleet-sharing');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-fleet-sharing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const directories = new Map([['fleet-1', {
    id: 'fleet-1', name: 'Local Fleet', path: '/private/repository', createdAt: '2026-01-01T00:00:00.000Z',
  }]]);
  const sessions = [{
    id: 'secret-session-id', dirId: 'fleet-1', label: 'Worker One', cli: 'codex', kind: 'chat',
    provider: 'private-provider', worktreePath: '/private/worktree', createdAt: '2026-01-02T00:00:00.000Z',
  }, {
    id: 'commander-id', dirId: 'fleet-1', label: 'Commander', cli: 'claude', kind: 'chat', type: 'commander',
  }];
  const sharing = createFleetSharing({
    sharesFile: path.join(root, 'fleet-shares.json'),
    externalFleetsFile: path.join(root, 'external-fleets.json'),
    getDirectory: id => directories.get(id),
    listSessions: id => sessions.filter(session => session.dirId === id),
    now: () => clock,
    lookupHost: async () => [{ address: '192.168.1.22', family: 4 }],
    ...overrides,
  });
  return {
    root, directories, sessions, sharing,
    tick(ms) { clock += ms; },
  };
}

function expectFleetError(fn, code, status) {
  assert.throws(fn, error => error instanceof FleetSharingError
    && error.code === code && (status === undefined || error.status === status));
}

test('Fleet share persists a scrypt password hash and exports a Fleet-scoped interactive capability', t => {
  const h = fixture(t);
  expectFleetError(() => h.sharing.createShare('fleet-1', { password: 'short' }), 'INVALID_PASSWORD');
  const created = h.sharing.createShare('fleet-1', {
    password: 'correct horse', expiresInDays: 2, maxAccesses: 2, description: 'Read-only team view',
  });
  assert.match(created.token, /^fleet_share_/);
  assert.equal(created.remainingAccesses, 2);

  const raw = fs.readFileSync(path.join(h.root, 'fleet-shares.json'), 'utf8');
  assert.equal(raw.includes('correct horse'), false);
  const persisted = JSON.parse(raw).shares[created.token];
  assert.match(persisted.passwordHash, /^[a-f0-9]{64}$/);
  assert.match(persisted.salt, /^[a-f0-9]{32}$/);
  assert.match(persisted.accessGrant, /^[A-Za-z0-9_-]{43,128}$/);

  expectFleetError(() => h.sharing.accessSharedFleet(created.token, 'wrong password'), 'WRONG_PASSWORD', 403);
  assert.equal(h.sharing.listShares('fleet-1')[0].remainingAccesses, 2,
    'wrong passwords do not consume the access budget');

  const payload = h.sharing.accessSharedFleet(created.token, 'correct horse');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.fleet.name, 'Local Fleet');
  assert.equal(payload.fleet.sessionCount, 2);
  assert.deepEqual(payload.fleet.sessions.map(item => item.type), ['worker', 'commander']);
  assert.deepEqual(payload.fleet.sessions.map(item => item.id), ['secret-session-id', 'commander-id']);
  assert.equal(payload.fleet.sessions[0].provider, 'private-provider');
  assert.equal(payload.capability.token, created.token);
  assert.match(payload.capability.grant, /^[A-Za-z0-9_-]{43,128}$/);
  const wire = JSON.stringify(payload);
  assert.equal(wire.includes('/private/'), false, 'capability payload excludes filesystem paths');
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'PATCH', pathname: '/api/sessions/secret-session-id',
  }), true);
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'PATCH', pathname: '/api/sessions/other-session',
  }), false);
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'POST', pathname: '/api/sessions/secret-session-id/relocate',
  }), false, 'a scoped capability cannot move a session into another Fleet');
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'GET', pathname: `/api/fleet-shares/${created.token}/state`,
  }), true);
  assert.equal(h.sharing.listShares('fleet-1')[0].remainingAccesses, 1);
  h.sharing.accessSharedFleet(created.token, 'correct horse');
  expectFleetError(() => h.sharing.accessSharedFleet(created.token, 'correct horse'), 'SHARE_EXHAUSTED', 410);
});

test('Fleet share expiry, ownership checks, and durable revoke fail closed', t => {
  const h = fixture(t);
  const created = h.sharing.createShare('fleet-1', { password: 'password', expiresInDays: 1 });
  assert.equal(h.sharing.revokeShare('other-fleet', 'fleet_share_missing_token_value_123456'), false,
    'unknown tokens remain idempotent even when the requested fleet differs');
  expectFleetError(() => h.sharing.revokeShare('wrong-owner', created.token), 'SHARE_FLEET_MISMATCH');
  h.tick(86400_001);
  expectFleetError(() => h.sharing.accessSharedFleet(created.token, 'password'), 'SHARE_NOT_FOUND', 404);
  assert.equal(h.sharing.revokeShare('fleet-1', created.token), true);
  assert.equal(h.sharing.listShares('fleet-1').length, 0);
});

test('share URL normalization accepts landing/API links and rejects credential or metadata targets', async () => {
  const landing = normalizeShareUrl(`https://fleet.example.test/fleet-share/fleet_share_${'a'.repeat(32)}`);
  assert.equal(landing.apiUrl, `https://fleet.example.test/api/fleet-shares/fleet_share_${'a'.repeat(32)}/import`);
  const api = normalizeShareUrl(`http://127.0.0.1:3100/api/fleet-shares/fleet_share_${'b'.repeat(32)}/import`);
  assert.equal(api.origin, 'http://127.0.0.1:3100');
  expectFleetError(() => normalizeShareUrl(`https://user:pass@host/fleet-share/fleet_share_${'c'.repeat(32)}`), 'INVALID_SHARE_URL');
  expectFleetError(() => normalizeShareUrl('file:///tmp/fleet-share/token'), 'INVALID_SHARE_URL');
  assert.equal(blockedAddress('169.254.169.254'), true);
  assert.equal(blockedAddress('192.168.1.2'), false);
  assert.equal(blockedAddress('127.0.0.1'), false, 'same-host multi-instance imports are supported');
  assert.equal(blockedAddress('fe80::1'), true);
});

test('external import is server-to-server, upserts the same source, and never persists the password', async t => {
  const requests = [];
  let remoteName = 'Remote Fleet';
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          schemaVersion: 1,
          instanceId: 'instance-remote',
          capability: {
            token: `fleet_share_${'d'.repeat(32)}`,
            grant: 'g'.repeat(43),
          },
          fleet: {
            id: 'remote-fleet-1', name: remoteName, description: 'Remote snapshot',
            sessions: [{ id: 'remote-worker-1', label: 'Remote worker', cli: 'zcode', kind: 'chat' }],
          },
        });
      },
    };
  };
  const h = fixture(t, { fetchImpl });
  const shareUrl = `http://remote.lan:3000/fleet-share/fleet_share_${'d'.repeat(32)}`;
  const first = await h.sharing.importExternal({ shareUrl, password: 'secret-pass', alias: 'My remote' });
  assert.equal(first.name, 'My remote');
  assert.equal(first.sessionCount, 1);
  assert.equal(first.interactive, true);
  assert.equal(requests[0].url, `http://remote.lan:3000/api/fleet-shares/fleet_share_${'d'.repeat(32)}/import`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { password: 'secret-pass' });

  const persistedText = fs.readFileSync(path.join(h.root, 'external-fleets.json'), 'utf8');
  assert.equal(persistedText.includes('secret-pass'), false);
  assert.equal(persistedText.includes('g'.repeat(43)), true, 'only the random Fleet grant is persisted');
  assert.equal(JSON.stringify(first).includes('g'.repeat(43)), false, 'the grant is never returned by the external Fleet list DTO');
  remoteName = 'Remote Fleet Renamed';
  const second = await h.sharing.importExternal({ shareUrl, password: 'secret-pass' });
  assert.equal(second.id, first.id);
  assert.equal(second.name, 'My remote', 'refresh preserves the local alias');
  assert.equal(second.remoteName, 'Remote Fleet Renamed');
  assert.equal(h.sharing.listExternal().length, 1);
  assert.equal(h.sharing.removeExternal(first.id), true);
  assert.equal(h.sharing.removeExternal(first.id), false);
});

test('external import rejects redirects and incompatible remote payloads without a local record', async t => {
  let mode = 'redirect';
  const h = fixture(t, {
    fetchImpl: async () => mode === 'redirect' ? {
      ok: false, status: 302, headers: { get: () => null }, text: async () => '',
    } : {
      ok: true, status: 200, headers: { get: () => null }, text: async () => '{"unexpected":true}',
    },
  });
  const input = { shareUrl: `https://remote.test/fleet-share/fleet_share_${'e'.repeat(32)}`, password: 'password' };
  await assert.rejects(h.sharing.importExternal(input), error => error.code === 'REMOTE_REDIRECT_REJECTED');
  mode = 'invalid';
  await assert.rejects(h.sharing.importExternal(input), error => error.code === 'INVALID_REMOTE_RESPONSE');
  assert.deepEqual(h.sharing.listExternal(), []);
});

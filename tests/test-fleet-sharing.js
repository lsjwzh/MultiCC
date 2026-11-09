'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { serveRemote } = require('./helpers/workspace-remote-server');
const {
  FleetSharingError,
  blockedAddress,
  createFleetSharing,
  normalizeShareUrl,
} = require('./helpers/native-workspace-sharing');

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
    ...overrides,
  });
  return {
    root, directories, sessions, sharing,
    tick(ms) { clock += ms; },
  };
}

async function expectAsyncError(fn, code, status) {
  await assert.rejects(fn, error => error instanceof FleetSharingError
    && error.code === code && (status === undefined || error.status === status));
}

function expectFleetError(fn, code, status) {
  assert.throws(fn, error => error instanceof FleetSharingError
    && error.code === code && (status === undefined || error.status === status));
}

test('Fleet share persists a scrypt password hash and exports a Fleet-scoped interactive capability', async t => {
  const h = fixture(t);
  await expectAsyncError(() => h.sharing.createShare('fleet-1', { password: 'short' }), 'INVALID_PASSWORD');
  const created = await h.sharing.createShare('fleet-1', {
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

  await expectAsyncError(() => h.sharing.accessSharedFleet(created.token, 'wrong password'), 'WRONG_PASSWORD', 403);
  assert.equal(h.sharing.listShares('fleet-1')[0].remainingAccesses, 2,
    'wrong passwords do not consume the access budget');

  const payload = await h.sharing.accessSharedFleet(created.token, 'correct horse');
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
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'GET', pathname: '/api/git/log?dirId=fleet-1&limit=50',
  }), true);
  assert.equal(h.sharing.authorizeRequest({
    token: created.token, grant: payload.capability.grant, method: 'GET', pathname: '/api/git/log?dirId=other-fleet&limit=50',
  }), false, 'global Git readers remain bound to the shared Fleet query');
  assert.equal(h.sharing.listShares('fleet-1')[0].remainingAccesses, 1);
  await h.sharing.accessSharedFleet(created.token, 'correct horse');
  await expectAsyncError(() => h.sharing.accessSharedFleet(created.token, 'correct horse'), 'SHARE_EXHAUSTED', 410);
});

test('Fleet share expiry, ownership checks, and durable revoke fail closed', async t => {
  const h = fixture(t);
  const created = await h.sharing.createShare('fleet-1', { password: 'password', expiresInDays: 1 });
  assert.equal(await h.sharing.revokeShare('other-fleet', 'fleet_share_missing_token_value_123456'), false,
    'unknown tokens remain idempotent even when the requested fleet differs');
  await expectAsyncError(() => h.sharing.revokeShare('wrong-owner', created.token), 'SHARE_FLEET_MISMATCH');
  h.tick(86400_001);
  await expectAsyncError(() => h.sharing.accessSharedFleet(created.token, 'password'), 'SHARE_NOT_FOUND', 404);
  assert.equal(await h.sharing.revokeShare('fleet-1', created.token), true);
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
  const remote = await serveRemote(t, fetchImpl);
  const h = fixture(t);
  const shareUrl = `${remote.origin}/fleet-share/fleet_share_${'d'.repeat(32)}`;
  const first = await h.sharing.importExternal({ shareUrl, password: 'secret-pass', alias: 'My remote' });
  assert.equal(first.name, 'My remote');
  assert.equal(first.sessionCount, 1);
  assert.equal(first.interactive, true);
  assert.equal(requests[0].url, `${remote.origin}/api/fleet-shares/fleet_share_${'d'.repeat(32)}/import`);
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
  assert.equal(await h.sharing.removeExternal(first.id), true);
  assert.equal(await h.sharing.removeExternal(first.id), false);
});

test('external import rejects redirects and incompatible remote payloads without a local record', async t => {
  let mode = 'redirect';
  const remote = await serveRemote(t, async () => mode === 'redirect' ? {
      ok: false, status: 302, headers: { get: () => null }, text: async () => '',
    } : {
      ok: true, status: 200, headers: { get: () => null }, text: async () => '{"unexpected":true}',
    });
  const h = fixture(t);
  const input = { shareUrl: `${remote.origin}/fleet-share/fleet_share_${'e'.repeat(32)}`, password: 'password' };
  await assert.rejects(h.sharing.importExternal(input), error => error.code === 'REMOTE_REDIRECT_REJECTED');
  mode = 'invalid';
  await assert.rejects(h.sharing.importExternal(input), error => error.code === 'INVALID_REMOTE_RESPONSE');
  assert.deepEqual(h.sharing.listExternal(), []);
});

test('external WebSocket ticket preserves the remote code/message and propagates correlation', async t => {
  const requests = [];
  let requestNo = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    requestNo += 1;
    if (requestNo === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify({
            schemaVersion: 1,
            instanceId: 'instance-remote',
            capability: {
              token: `fleet_share_${'w'.repeat(32)}`,
              grant: 'r'.repeat(43),
            },
            fleet: {
              id: 'remote-fleet', name: 'Remote Fleet', sessions: [{ id: 'remote-chat', label: 'Chat' }],
            },
          });
        },
      };
    }
    const body = Buffer.from(JSON.stringify({
      code: 'FLEET_SCOPE_FORBIDDEN',
      error: 'remote grant expired',
      requestId: 'remote-request-11',
      correlationId: 'correlation-11',
    }));
    return {
      ok: false,
      status: 403,
      headers: {
        get(name) {
          if (name === 'x-multicc-request-id') return 'remote-request-11';
          if (name === 'x-correlation-id') return 'correlation-11';
          if (name === 'content-type') return 'application/json';
          return null;
        },
      },
      async arrayBuffer() { return body; },
    };
  };
  const remote = await serveRemote(t, fetchImpl);
  const h = fixture(t);
  const external = await h.sharing.importExternal({
    shareUrl: `${remote.origin}/fleet-share/fleet_share_${'w'.repeat(32)}`,
    password: 'password',
  });

  await assert.rejects(
    h.sharing.issueExternalWsTicket(external.id, {
      pathname: '/ws/chat', sessionId: 'remote-chat',
    }, { correlationId: 'correlation-11' }),
    error => error.code === 'FLEET_SCOPE_FORBIDDEN'
      && error.message === 'remote grant expired'
      && error.category === 'remote'
      && error.upstreamRequestId === 'remote-request-11'
      && error.correlationId === 'correlation-11',
  );
  assert.equal(requests[1].init.headers['x-correlation-id'], 'correlation-11');
});

test('external import preserves a structured remote error code and original message', async t => {
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    headers: {
      get(name) {
        if (name === 'x-multicc-request-id') return 'remote-import-7';
        if (name === 'x-correlation-id') return 'correlation-import-7';
        return null;
      },
    },
    async text() {
      return JSON.stringify({
        code: 'REMOTE_PROVIDER_OVERLOADED',
        error: 'worker queue saturated at source',
        category: 'provider',
        retryable: true,
        action: 'retry_later',
      });
    },
  });
  const remote = await serveRemote(t, fetchImpl);
  const h = fixture(t);
  await assert.rejects(
    h.sharing.importExternal({
      shareUrl: `${remote.origin}/fleet-share/fleet_share_${'w'.repeat(32)}`,
      password: 'password',
    }, { correlationId: 'correlation-import-7' }),
    error => error.code === 'REMOTE_PROVIDER_OVERLOADED'
      && error.message === 'worker queue saturated at source'
      && error.category === 'provider'
      && error.retryable === true
      && error.action === 'retry_later'
      && error.upstreamRequestId === 'remote-import-7'
      && error.correlationId === 'correlation-import-7',
  );
});

const legacySharing = require('./helpers/legacy-workspace-sharing');
function reopen(h, factory = createFleetSharing, overrides = {}) {
  return factory({
    sharesFile: path.join(h.root, 'fleet-shares.json'),
    externalFleetsFile: path.join(h.root, 'external-fleets.json'),
    getDirectory: id => h.directories.get(id),
    listSessions: id => h.sessions.filter(session => session.dirId === id),
    now: () => 1_800_000_000_000,
    ...overrides,
  });
}

test('native and legacy workspace-sharing stores read each other with unchanged schema and password hashes', async t => {
  const h = fixture(t);
  const old = reopen(h, legacySharing.createFleetSharing);
  const created = old.createShare('fleet-1', { password: '旧密码🔑\ud800', maxAccesses: 4, description: '描述\udfff' });
  const file = path.join(h.root, 'fleet-shares.json');
  const legacyState = JSON.parse(fs.readFileSync(file, 'utf8'));
  legacyState.shares[created.token].unknownFutureField = { value: '\ud800', nested: [1, null, true] };
  fs.writeFileSync(file, JSON.stringify(legacyState));
  const native = reopen(h);
  assert.deepEqual(native.listShares('fleet-1'), old.listShares('fleet-1'));
  const first = await native.accessSharedFleet(created.token, '旧密码🔑\ud800');
  const fromNative = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fromNative.shares[created.token].passwordHash, legacyState.shares[created.token].passwordHash);
  assert.deepEqual(fromNative.shares[created.token].unknownFutureField, legacyState.shares[created.token].unknownFutureField);
  assert.equal(fromNative.shares[created.token].accessCount, 1);
  const oldAgain = reopen(h, legacySharing.createFleetSharing);
  assert.deepEqual(oldAgain.readSharedFleet(created.token, first.capability.grant), first);
  oldAgain.accessSharedFleet(created.token, '旧密码🔑\ud800');
  assert.equal(reopen(h).listShares('fleet-1')[0].accessCount, 2);
  const next = await reopen(h).createShare('fleet-1', { password: 'new-password' });
  assert.equal(reopen(h, legacySharing.createFleetSharing).accessSharedFleet(next.token, 'new-password').fleet.id, 'fleet-1');
  // Reopen only between operations: this fixture models an offline upgrade/rollback.
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('workspace authorization matches legacy route policy and uses current session membership', async t => {
  const h = fixture(t);
  const created = await h.sharing.createShare('fleet-1', { password: 'password' });
  const payload = await h.sharing.accessSharedFleet(created.token, 'password');
  const old = reopen(h, legacySharing.createFleetSharing);
  const paths = [
    '/api/providers', '/api/providers/', '/api/v1/providers', '/api/provider-defaults',
    '/api/agent-presets', '/api/agent-presets/a', '/api/agent-presets/a/b',
    '/api/claude/models', '/api/qoder/models', '/api/opencode/models',
    '/api/git/log?dirId=fleet-1', '/api/git/commit-files?dirId=fleet-1', '/api/git/commit-diff?dirId=other',
    '/api/git/log?dirId=other&dirId=fleet-1', '/api/git/log?dirId=fleet-1&dirId=other',
    '/api/directories/fleet-1', '/api/directories/fleet-1/whatever', '/api/directories/other',
    '/api/directories/%66leet-1', '/api/directories/%ff', '/api/directories/',
    '/api/sessions/secret-session-id', '/api/sessions/secret-session-id/relocate',
    '/api/sessions/secret-session-id/relocate/', '/api/sessions/%73ecret-session-id',
    '/api/sessions/other', '/api/sessions/%FF', `/api/fleet-shares/${created.token}/state`,
    'http://other/api/sessions/secret-session-id', '//other/api/sessions/secret-session-id',
    'http://[invalid]/api/providers', '/api/sessions/x/../secret-session-id', '',
  ];
  let checked = 0;
  for (const method of ['GET', 'get', 'POST', 'PATCH', 'DELETE', '', null, [], ['GET'], {}, 0, true]) {
    for (const pathname of paths) for (const grant of [payload.capability.grant, 'invalid', null]) {
      const input = { token: created.token, grant, method, pathname };
      assert.equal(h.sharing.authorizeRequest(input), old.authorizeRequest(input), JSON.stringify({ method, pathname, grant: !!grant }));
      checked++;
    }
  }
  t.diagnostic(`${checked} legacy/native HTTP scope cases; WS issuance is covered by gateway HTTP tests`);
  const input = { token: created.token, grant: payload.capability.grant, pathname: '/api/sessions/secret-session-id' };
  assert.equal(h.sharing.authorizeRequest(input), true);
  h.sessions[0].dirId = 'other';
  assert.equal(h.sharing.authorizeRequest(input), false, 'removed members cannot use an old snapshot');
  await h.sharing.revokeShare('fleet-1', created.token);
  assert.equal(h.sharing.authorizeRequest({ ...input, pathname: '/api/providers' }), false, 'awaited revoke applies immediately');
});

test('failed durable writes do not publish a share, revoke authority, or consume access', async t => {
  const h = fixture(t);
  const created = await h.sharing.createShare('fleet-1', { password: 'password' });
  const payload = await h.sharing.accessSharedFleet(created.token, 'password');
  const file = path.join(h.root, 'fleet-shares.json');
  const saved = fs.readFileSync(file);
  fs.unlinkSync(file); fs.mkdirSync(file);
  await assert.rejects(h.sharing.createShare('fleet-1', { password: 'new-password' }));
  await assert.rejects(h.sharing.revokeShare('fleet-1', created.token));
  await assert.rejects(h.sharing.accessSharedFleet(created.token, 'password'));
  assert.equal(h.sharing.listShares('fleet-1').length, 1);
  assert.equal(h.sharing.listShares('fleet-1')[0].accessCount, 1);
  assert.equal(h.sharing.authorizeRequest({ token: created.token, grant: payload.capability.grant, pathname: '/api/providers' }), true);
  assert.equal(fs.readdirSync(h.root).some(name => name.includes('.tmp.')), false);
  fs.rmdirSync(file); fs.writeFileSync(file, saved);
  await h.sharing.revokeShare('fleet-1', created.token);
  assert.equal(reopen(h).listShares('fleet-1').length, 0);
});

test('concurrent password access respects the budget and cannot revive a revoked grant', async t => {
  const h = fixture(t);
  const created = await h.sharing.createShare('fleet-1', { password: 'password', maxAccesses: 1 });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => h.sharing.accessSharedFleet(created.token, 'password')));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of attempts.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'SHARE_EXHAUSTED');
  const next = await h.sharing.createShare('fleet-1', { password: 'password' });
  const pending = h.sharing.accessSharedFleet(next.token, 'password');
  const revoke = h.sharing.revokeShare('fleet-1', next.token);
  await assert.rejects(pending, error => error.code === 'SHARE_NOT_FOUND');
  assert.equal(await revoke, true);
  assert.equal(reopen(h).listShares('fleet-1').some(r => r.token === next.token), false);
});

test('password work and file writes leave the Node event loop responsive', async t => {
  const h = fixture(t);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    const pending = h.sharing.createShare('fleet-1', { password: 'password' });
    for (let i = 0; i < 50; i++) assert.deepEqual(h.sharing.listShares('missing'), []);
    await pending;
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'scrypt executes on native workers');
});

test('remote workspace payload normalization preserves legacy JSON and UTF-16 behavior', t => {
  const { validateFleetPayload } = require('./helpers/native-workspace-sharing');
  const base = {
    schemaVersion: 1, instanceId: 'source',
    capability: { token: `fleet_share_${'x'.repeat(32)}`, grant: 'g'.repeat(43) },
    fleet: { id: 'directory', name: 'Workspace', description: 'text', sessions: [{ id: 's', label: 'session' }] },
  };
  const variants = [null, true, false, 0, -1, 1.5, '', '  ', 'x', '\u0000 a\t b\u007f', '\u00a0 x\ufeff', '\ud800', '\udfff', '😀'.repeat(260), [], {}, ['x'], { id: 'nested' }];
  const paths = [
    ['schemaVersion'], ['instanceId'], ['capability'], ['capability', 'token'], ['capability', 'grant'],
    ['fleet'], ['fleet', 'id'], ['fleet', 'name'], ['fleet', 'description'], ['fleet', 'sessions'],
    ...['id', 'label', 'cli', 'kind', 'type', 'createdAt', 'active', 'model', 'effectiveModel', 'provider'].map(key => ['fleet', 'sessions', 0, key]),
  ];
  const outcome = (fn, input) => {
    try { return { value: fn(input) }; }
    catch (error) { return { code: error.code, message: error.message, status: error.status }; }
  };
  let cases = 0;
  for (const keys of paths) for (const value of variants) {
    const input = structuredClone(base);
    let target = input; for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
    assert.deepEqual(outcome(validateFleetPayload, input), outcome(legacySharing.validateFleetPayload, input), keys.join('.'));
    cases++;
  }
  t.diagnostic(`${cases} legacy/native payload cases`);
});

test('external legacy caches retain unknown fields and malformed session projection on refresh', async t => {
  const h = fixture(t);
  const file = path.join(h.root, 'external-fleets.json');
  let refreshedPayload;
  const remote = await serveRemote(t, async () => ({ status: 200, headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(JSON.stringify(refreshedPayload)) }));
  const record = {
    id: 'external-1', alias: '名称\ud800', remoteName: 'Remote', sourceOrigin: remote.origin,
    sourceInstanceId: 'remote', sourceFleetId: 'workspace', shareUrl: 'https://remote.test/fleet-share/legacy',
    remoteToken: `fleet_share_${'t'.repeat(32)}`, remoteGrant: 'g'.repeat(43),
    importedAt: 1, refreshedAt: 2, sessions: [null, 1, 'x\ud800', [1, 2], { id: 'one' }],
    unknownFutureField: ['\udfff'],
  };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, fleets: { 'external-1': record } }));
  const old = reopen(h, legacySharing.createFleetSharing);
  const native = reopen(h);
  assert.deepEqual(native.listExternal(), old.listExternal());
  assert.deepEqual(native.externalAuthority('external-1'), old.externalAuthority('external-1'));
  refreshedPayload = { schemaVersion: 1, instanceId: 'remote',
    capability: { token: record.remoteToken, grant: record.remoteGrant },
    fleet: { id: 'workspace', name: 'Refreshed', sessions: [{ id: 'fresh' }] } };
  const refreshing = reopen(h);
  const refreshed = await refreshing.refreshExternal('external-1');
  assert.equal(refreshed.remoteName, 'Refreshed');
  assert.equal(refreshed.sessions[0].id, 'fresh');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).fleets['external-1'].unknownFutureField, record.unknownFutureField);
  assert.deepEqual(reopen(h, legacySharing.createFleetSharing).listExternal(), [refreshed]);
  assert.equal(await refreshing.removeExternal('external-1'), true);
  assert.deepEqual(reopen(h, legacySharing.createFleetSharing).listExternal(), []);
});

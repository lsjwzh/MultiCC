'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertTestDir } = require('../src/paths');

const { start: startGateway } = require('./helpers/external-workspace-gateway');

const PASSWORD = 'two-ip-fleet-password';

function isPrivateLanIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function findLanIPv4() {
  const available = Object.values(os.networkInterfaces())
    .flatMap(entries => entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  const configured = String(process.env.MULTICC_TEST_LAN_IP || '').trim();
  if (configured) {
    assert.equal(isPrivateLanIPv4(configured), true,
      'MULTICC_TEST_LAN_IP must be an RFC1918 IPv4 address');
    assert.equal(available.includes(configured), true,
      `MULTICC_TEST_LAN_IP is not assigned to this machine: ${configured}`);
    return configured;
  }
  return available.find(isPrivateLanIPv4) || null;
}

async function requestJson(url, init) {
  const headers = new URL(url).hostname === '127.0.0.1' ? {} : { 'x-access-token': 'fixture-token' };
  const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch (_) { assert.fail(`expected JSON from ${url}, received: ${text.slice(0, 200)}`); }
  return { response, body };
}

function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Fleet sharing works from a LAN-bound source to a loopback-bound target', async t => {
  const lanIp = findLanIPv4();
  if (!lanIp) {
    t.skip('requires an active RFC1918 LAN IPv4 address (or MULTICC_TEST_LAN_IP)');
    return;
  }

  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-fleet-two-ip-')));
  const sourceDataDir = assertTestDir(path.join(root, 'source'));
  const targetDataDir = assertTestDir(path.join(root, 'target'));
  const sourceDirectories = new Map([['fleet-source', {
    id: 'fleet-source',
    name: 'LAN Source Fleet',
    path: '/private/source-repository',
    createdAt: '2026-08-01T00:00:00.000Z',
  }]]);
  const sourceSessions = new Map([
    ['private-worker-id', {
      id: 'private-worker-id',
      dirId: 'fleet-source',
      label: 'LAN Worker',
      cli: 'codex',
      kind: 'chat',
      provider: 'private-provider',
      worktreePath: '/private/source-worktree',
      createdAt: '2026-08-02T00:00:00.000Z',
    }],
    ['private-commander-id', {
      id: 'private-commander-id',
      dirId: 'fleet-source',
      label: 'LAN Commander',
      cli: 'claude',
      kind: 'chat',
      type: 'commander',
      createdAt: '2026-08-03T00:00:00.000Z',
    }],
  ]);

  let sourceServer;
  let targetServer;
  t.after(async () => {
    await Promise.all([sourceServer?.close(), targetServer?.close()]);
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  sourceServer = await startGateway(t, true, { dir: sourceDataDir, host: lanIp,
    source: { directories: [...sourceDirectories.values()], sessions: [...sourceSessions.values()] },
  });
  targetServer = await startGateway(t, true, { dir: targetDataDir });
  let sourceOrigin = sourceServer.origin;
  let targetOrigin = targetServer.origin;

  assert.equal(new URL(sourceServer.origin).hostname, lanIp);
  assert.equal(new URL(targetServer.origin).hostname, '127.0.0.1');
  assert.notEqual(new URL(sourceServer.origin).hostname, new URL(targetServer.origin).hostname);

  const created = await postJson(`${sourceOrigin}/api/fleets/fleet-source/share`, {
    password: PASSWORD,
    expiresInDays: 2,
    maxAccesses: 3,
    description: 'Two-IP integration test',
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(new URL(created.body.url).hostname, lanIp,
    'the generated URL advertises the source LAN address');
  assert.equal(JSON.stringify(created.body).includes(PASSWORD), false);

  const landing = await fetch(created.body.url);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /收到一个工作区分享/);

  const rejected = await postJson(`${targetOrigin}/api/external-fleets/import`, {
    shareUrl: created.body.url,
    password: 'incorrect-password',
    alias: 'Imported over LAN',
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.body.code, 'WRONG_PASSWORD');
  const emptyAfterFailure = await requestJson(`${targetOrigin}/api/external-fleets`);
  assert.deepEqual(emptyAfterFailure.body.fleets, []);

  const imported = await postJson(`${targetOrigin}/api/external-fleets/import`, {
    shareUrl: created.body.url,
    password: PASSWORD,
    alias: 'Imported over LAN',
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.ok, true);
  assert.equal(imported.body.fleet.name, 'Imported over LAN');
  assert.equal(imported.body.fleet.remoteName, 'LAN Source Fleet');
  assert.equal(imported.body.fleet.sourceOrigin, sourceOrigin);
  assert.equal(imported.body.fleet.sourceFleetId, 'fleet-source');
  assert.equal(imported.body.fleet.sessionCount, 2);
  assert.deepEqual(imported.body.fleet.sessions.map(session => session.type), ['worker', 'commander']);
  assert.deepEqual(imported.body.fleet.sessions.map(session => session.id), ['private-worker-id', 'private-commander-id']);
  assert.equal(imported.body.fleet.sessions[0].provider, 'private-provider');
  assert.equal(imported.body.fleet.interactive, true);

  const importedWire = JSON.stringify(imported.body);
  for (const forbidden of [
    PASSWORD,
    '/private/source-repository',
    '/private/source-worktree',
  ]) {
    assert.equal(importedWire.includes(forbidden), false, `cross-IP capability excludes ${forbidden}`);
  }

  const shares = await requestJson(`${sourceOrigin}/api/fleets/fleet-source/shares`);
  assert.equal(shares.response.status, 200);
  assert.equal(shares.body.shares[0].remainingAccesses, 2,
    'a wrong password does not consume an access; the successful import consumes one');

  const persistedText = fs.readFileSync(path.join(targetDataDir, 'external-fleets.json'), 'utf8');
  assert.equal(persistedText.includes(PASSWORD), false);
  assert.equal(persistedText.includes(sourceOrigin), true);
  const persistedGrant = JSON.parse(persistedText).fleets[imported.body.fleet.id].remoteGrant;
  assert.match(persistedGrant, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(importedWire.includes(persistedGrant), false, 'the target list DTO never exposes its stored grant');

  const proxyBase = `${targetOrigin}/api/external-fleets/${encodeURIComponent(imported.body.fleet.id)}/remote`;
  const renamed = await requestJson(`${proxyBase}/api/sessions/private-worker-id`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Renamed through loopback target' }),
  });
  assert.equal(renamed.response.status, 200);
  assert.equal((await requestJson(`${sourceOrigin}/fixture/state`)).body.sessions.find(s => s.id === 'private-worker-id').label, 'Renamed through loopback target',
    'an imported Fleet reuses the source session mutation API');
  const refreshedAfterRename = await requestJson(`${targetOrigin}/api/external-fleets`);
  assert.equal(refreshedAfterRename.body.fleets[0].sessions
    .find(session => session.id === 'private-worker-id').label, 'Renamed through loopback target',
  'a successful remote mutation refreshes the target cache');

  const createdRemote = await postJson(`${proxyBase}/api/directories/fleet-source/sessions`, {
    label: 'Created through imported Fleet',
  });
  assert.equal(createdRemote.response.status, 200);
  assert.equal((await requestJson(`${sourceOrigin}/fixture/state`)).body.sessions.some(s => s.id === createdRemote.body.id), true,
    'new-session uses the same source lifecycle API');

  const deniedOtherSession = await requestJson(`${proxyBase}/api/sessions/not-in-fleet`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'must not run' }),
  });
  assert.equal(deniedOtherSession.response.status, 403,
    'the Fleet capability cannot mutate a session outside its source Fleet');
  const gitLog = await requestJson(`${proxyBase}/api/git/log?dirId=fleet-source&limit=50`);
  assert.equal(gitLog.response.status, 200);
  assert.equal(gitLog.body.dirId, 'fleet-source', 'the existing Git-tree API is reused through Fleet scope');
  const deniedOtherGit = await requestJson(`${proxyBase}/api/git/log?dirId=other-fleet&limit=50`);
  assert.equal(deniedOtherGit.response.status, 403);

  await postJson(`${sourceOrigin}/fixture/session`, {
    id: 'new-remote-worker', dirId: 'fleet-source', label: 'New LAN Worker', cli: 'zcode', kind: 'terminal',
  });
  const refreshed = await postJson(
    `${targetOrigin}/api/external-fleets/${encodeURIComponent(imported.body.fleet.id)}/refresh`,
    {},
  );
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.fleet.sessionCount, 4,
    'the loopback target refreshes interactive Fleet state from the LAN source without the password');
  assert.equal(refreshed.body.fleet.sessions.some(session => session.id === 'new-remote-worker'), true);

  await targetServer.close();
  targetServer = undefined;
  targetServer = await startGateway(t, true, { dir: targetDataDir });
  targetOrigin = targetServer.origin;
  const afterRestart = await requestJson(`${targetOrigin}/api/external-fleets`);
  assert.equal(afterRestart.response.status, 200);
  assert.equal(afterRestart.body.fleets.length, 1);
  assert.equal(afterRestart.body.fleets[0].id, imported.body.fleet.id,
    'the loopback target reloads the imported Fleet from disk');

  const revoked = await requestJson(
    `${sourceOrigin}/api/fleets/fleet-source/share/${encodeURIComponent(created.body.token)}`,
    { method: 'DELETE' },
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.body.ok, true);

  const refreshAfterRevoke = await postJson(`${targetOrigin}/api/external-fleets/import`, {
    shareUrl: created.body.url,
    password: PASSWORD,
  });
  assert.equal(refreshAfterRevoke.response.status, 404);
  assert.equal(refreshAfterRevoke.body.code, 'SHARE_NOT_FOUND');
  const retainedSnapshot = await requestJson(`${targetOrigin}/api/external-fleets`);
  assert.equal(retainedSnapshot.body.fleets.length, 1,
    'revoking the source prevents further operation but does not delete the target Fleet reference');

  console.log(`fleet sharing two-IP integration: source=${sourceOrigin} target=${targetOrigin}`);
});

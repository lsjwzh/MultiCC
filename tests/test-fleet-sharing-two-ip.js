'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { assertTestDir, createPaths } = require('../src/paths');
const { mountFleetSharingRoutes } = require('../src/routes/fleet-sharing');

const PAGE_FILE = path.join(__dirname, '..', 'public', 'fleet-share.html');
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

function listen(app, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function serverOrigin(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function createInstance({ dataDir, directories = new Map(), sessions = new Map() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  mountFleetSharingRoutes(app, {
    paths: createPaths({ dataDir }),
    directories,
    sessions,
    pageFile: PAGE_FILE,
    logger: { error() {} },
  });
  return app;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
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
    await Promise.all([closeServer(sourceServer), closeServer(targetServer)]);
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  sourceServer = await listen(createInstance({
    dataDir: sourceDataDir,
    directories: sourceDirectories,
    sessions: sourceSessions,
  }), lanIp);
  targetServer = await listen(createInstance({ dataDir: targetDataDir }), '127.0.0.1');
  let sourceOrigin = serverOrigin(sourceServer);
  let targetOrigin = serverOrigin(targetServer);

  assert.equal(sourceServer.address().address, lanIp);
  assert.equal(targetServer.address().address, '127.0.0.1');
  assert.notEqual(sourceServer.address().address, targetServer.address().address);

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
  assert.match(await landing.text(), /收到一个 Fleet 分享/);

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

  const importedWire = JSON.stringify(imported.body);
  for (const forbidden of [
    PASSWORD,
    '/private/source-repository',
    '/private/source-worktree',
    'private-provider',
    'private-worker-id',
    'private-commander-id',
  ]) {
    assert.equal(importedWire.includes(forbidden), false, `cross-IP snapshot excludes ${forbidden}`);
  }

  const shares = await requestJson(`${sourceOrigin}/api/fleets/fleet-source/shares`);
  assert.equal(shares.response.status, 200);
  assert.equal(shares.body.shares[0].remainingAccesses, 2,
    'a wrong password does not consume an access; the successful import consumes one');

  const persistedText = fs.readFileSync(path.join(targetDataDir, 'external-fleets.json'), 'utf8');
  assert.equal(persistedText.includes(PASSWORD), false);
  assert.equal(persistedText.includes(sourceOrigin), true);

  await closeServer(targetServer);
  targetServer = undefined;
  targetServer = await listen(createInstance({ dataDir: targetDataDir }), '127.0.0.1');
  targetOrigin = serverOrigin(targetServer);
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
    'revoking the source prevents refresh but does not delete the target read-only snapshot');

  console.log(`fleet sharing two-IP integration: source=${sourceOrigin} target=${targetOrigin}`);
});

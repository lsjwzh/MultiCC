'use strict';

// Isolated HTTP fault-injection coverage for session persistence semantics.
// All state and fake CLI executables live below one mkdtemp root. No AI process
// is started and no native CLI receives a prompt.

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const ACCESS_TOKEN = 'session-persistence-api-test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-persistence-api-'));
const dataDir = assertTestDir(path.join(root, 'data'));
const projectDir = path.join(root, 'project');
const binDir = path.join(root, 'bin');
const failureMarker = path.join(dataDir, 'inject-session-save-failure');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
for (const cli of ['claude', 'codex', 'opencode', 'zcode', 'qoderclicn']) {
  const file = path.join(binDir, cli);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

let server = null;
let base = null;
let stderr = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function api(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-Request-Id': `persistence-test-${Date.now()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data, headers: response.headers };
}

function diskSessions() {
  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.data;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await api('GET', '/api/directories');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated session-persistence server did not become ready');
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ACCESS_TOKEN,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      MULTICC_DATA_DIR: dataDir,
      MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE: failureMarker,
      MULTICC_SESSION_PERSISTENCE_RETRY_MS: '50',
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGINT');
  const exited = await Promise.race([
    new Promise(resolve => server.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited && server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

function injectFailure(enabled) {
  if (enabled) fs.writeFileSync(failureMarker, 'EIO');
  else fs.rmSync(failureMarker, { force: true });
}

function assertPersistenceFailure(response, label) {
  assert.equal(response.status, 500, `${label} must fail closed`);
  assert.equal(response.data.code, 'SESSION_PERSISTENCE_FAILED');
  assert.equal(typeof response.data.requestId, 'string');
  assert.ok(response.data.requestId.length > 0);
  assert.equal(response.headers.get('x-multicc-request-id'), response.data.requestId);
}

async function sessionView(directoryId, sessionId) {
  const response = await api('GET', `/api/directories/${directoryId}/sessions`);
  assert.equal(response.status, 200);
  return response.data.sessions.find(session => session.id === sessionId) || null;
}

(async () => {
  await startServer();

  let response = await api('POST', '/api/directories', {
    name: 'persistence fixture', path: projectDir,
  });
  assert.equal(response.status, 200);
  const directoryId = response.data.id;

  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'stable-session',
  });
  assert.equal(response.status, 200);
  const stableId = response.data.id;
  const baselineDisk = diskSessions();
  const baseline = baselineDisk.find(session => session.id === stableId);
  assert.equal(baseline.label, 'stable-session');
  assert.equal(baseline.cli, 'opencode');

  injectFailure(true);

  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'must-not-become-a-ghost',
  });
  assertPersistenceFailure(response, 'create');
  let sessions = (await api('GET', `/api/directories/${directoryId}/sessions`)).data.sessions;
  assert.equal(sessions.some(session => session.label === 'must-not-become-a-ghost'), false);
  assert.equal(diskSessions().some(session => session.label === 'must-not-become-a-ghost'), false);

  response = await api('POST', '/api/cron', {
    name: 'fault-cron', dirId: directoryId, cli: 'opencode',
    prompt: 'must never reach a CLI', cron: '0 0 1 1 *', enabled: false,
  });
  assert.equal(response.status, 200);
  const cronId = response.data.id;
  response = await api('POST', `/api/cron/${cronId}/run`);
  assertPersistenceFailure(response, 'manual cron session create');
  sessions = (await api('GET', `/api/directories/${directoryId}/sessions`)).data.sessions;
  assert.equal(sessions.some(session => session.label === '⏰ fault-cron'), false);
  await api('DELETE', `/api/cron/${cronId}`);

  response = await api('PATCH', `/api/sessions/${stableId}`, {
    label: 'failed-update', model: 'model-that-must-rollback', autoCommit: false,
  });
  assertPersistenceFailure(response, 'update');
  let current = await sessionView(directoryId, stableId);
  assert.equal(current.label, 'stable-session');
  assert.equal(current.model, null);
  assert.equal(diskSessions().find(session => session.id === stableId).label, 'stable-session');

  response = await api('POST', `/api/sessions/${stableId}/switch-cli`, { cli: 'zcode' });
  assertPersistenceFailure(response, 'switch');
  current = await sessionView(directoryId, stableId);
  assert.equal(current.cli, 'opencode');
  assert.equal(diskSessions().find(session => session.id === stableId).cli, 'opencode');

  response = await api('DELETE', `/api/sessions/${stableId}?force=1`);
  assertPersistenceFailure(response, 'delete');
  current = await sessionView(directoryId, stableId);
  assert.ok(current, 'failed delete must restore the in-memory record');
  assert.ok(diskSessions().some(session => session.id === stableId), 'failed delete must retain the disk record');

  injectFailure(false);
  await stopServer();
  await startServer();

  current = await sessionView(directoryId, stableId);
  assert.ok(current, 'record survives restart after failed delete');
  assert.equal(current.label, 'stable-session');
  assert.equal(current.cli, 'opencode');
  assert.equal(current.model, null);
  sessions = (await api('GET', `/api/directories/${directoryId}/sessions`)).data.sessions;
  assert.equal(sessions.some(session => session.label === 'must-not-become-a-ghost'), false);

  response = await api('PATCH', `/api/sessions/${stableId}`, { label: 'committed-after-restart' });
  assert.equal(response.status, 200, 'service remains writable after injected failures and restart');
  assert.equal(diskSessions().find(session => session.id === stableId).label, 'committed-after-restart');

  await api('DELETE', `/api/sessions/${stableId}?force=1`);
  await api('DELETE', `/api/directories/${directoryId}?force=1`);
  await stopServer();
  assertTestDir(root);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('session persistence HTTP fault injection: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-8000));
  injectFailure(false);
  await stopServer();
  try { assertTestDir(root); fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});

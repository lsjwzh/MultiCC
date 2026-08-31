'use strict';

// Isolated HTTP composition test for durable detached orchestration. Public
// HTTP dispatch is intentionally retired in favor of the process-scoped Router
// MCP; the only external process here is a harmless sleep command that is
// cancelled through session deletion.

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { assertTestDir } = require('../src/paths');
const { _loadDatabaseState } = require('../src/orchestration-sqlite-store');

const ROOT = path.join(__dirname, '..');
const ACCESS_TOKEN = 'durable-operations-api-test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-operations-api-'));
const dataDir = assertTestDir(path.join(root, 'data'));
const projectDir = path.join(root, 'project');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

let server;
let base;
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

async function api(method, route, body, headers = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await api('GET', '/api/directories');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated durable-operation server did not become ready');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGINT');
  const exited = await Promise.race([
    new Promise(resolve => server.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited && server.exitCode === null) server.kill('SIGKILL');
}

function readOrchestration(file) {
  const db = new Database(file, { readonly: true });
  try { return _loadDatabaseState(db, file); } finally { db.close(); }
}

(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ACCESS_TOKEN,
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();

  let response = await api('POST', '/api/directories', {
    name: 'durable operations', path: projectDir,
  });
  assert.equal(response.status, 200);
  const directoryId = response.data.id;
  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'parent',
  });
  assert.equal(response.status, 200);
  const parentId = response.data.id;
  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'worker',
  });
  assert.equal(response.status, 200);
  const workerId = response.data.id;

  const dispatchBody = { target: workerId, message: 'deterministic dispatch payload' };
  const legacyDispatch = await api(
    'POST', `/api/sessions/${parentId}/dispatch`, dispatchBody,
    { 'Idempotency-Key': 'retired-raw-dispatch' },
  );
  assert.equal([404, 405].includes(legacyDispatch.status), true);
  const legacyV1Dispatch = await api(
    'POST', `/api/v1/sessions/${parentId}/dispatch`, dispatchBody,
    { 'Idempotency-Key': 'retired-v1-dispatch' },
  );
  assert.equal([404, 405].includes(legacyV1Dispatch.status), true);

  const detached = await api(
    'POST', `/api/sessions/${parentId}/run-detached`,
    { command: 'sleep 30', label: 'cancel fixture' },
    { 'Idempotency-Key': 'raw-detached-capability' },
  );
  assert.equal(detached.status, 200);
  assert.equal(detached.data.ok, true);
  assert.equal(typeof detached.data.operationId, 'string');
  assert.equal(typeof detached.data.taskId, 'string');
  assert.equal(['admitted', 'running'].includes(detached.data.status), true);
  assert.equal(detached.data.dispatchEndpoint, null);

  const ownJobs = await api('GET', `/api/sessions/${parentId}/detached`);
  const otherJobs = await api('GET', `/api/sessions/${workerId}/detached`);
  assert.equal(ownJobs.data.tasks.some(task => task.taskId === detached.data.taskId || task.id === detached.data.taskId), true);
  assert.deepEqual(otherJobs.data.tasks, []);
  const taskLedger = await api('GET', `/api/sessions/${parentId}/tasks`);
  assert.equal(taskLedger.status, 200);
  assert.deepEqual(taskLedger.data, { tasks: [], count: 0 });

  const orchestrationFile = path.join(dataDir, 'orchestration.sqlite');
  const detachedDir = path.join(dataDir, 'detached');
  assert.equal(fs.statSync(orchestrationFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(detachedDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(detachedDir, detached.data.taskId, 'meta.json')).mode & 0o777, 0o600);
  const durableText = JSON.stringify(readOrchestration(orchestrationFile));
  assert.equal(durableText.includes('retired-raw-dispatch'), false);
  assert.equal(durableText.includes('retired-v1-dispatch'), false);
  assert.equal(durableText.includes('raw-detached-capability'), false);

  response = await api('DELETE', `/api/sessions/${parentId}?force=1`);
  assert.equal(response.status, 200);
  const snapshot = readOrchestration(orchestrationFile);
  assert.equal(snapshot.operations[detached.data.operationId].status, 'cancelled');

  await api('DELETE', `/api/directories/${directoryId}?force=1`);
  await stopServer();
  assertTestDir(root);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('durable operations HTTP integration: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-5000));
  await stopServer();
  try { assertTestDir(root); fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});

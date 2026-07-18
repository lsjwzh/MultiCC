'use strict';

// Isolated HTTP contract test for durable explicit waits.  The worker interval
// is deliberately long so the test exercises registration/callback persistence
// without starting any native AI CLI.

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const ACCESS_TOKEN = 'durable-wait-api-test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-wait-api-'));
const dataDir = path.join(root, 'data');
const projectDir = path.join(root, 'project');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
assertTestDir(dataDir);

let server;
let stderr = '';

async function api(method, route, body, token = ACCESS_TOKEN) {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function callback(route, body) {
  const response = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await api('GET', '/api/directories');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated server did not become ready');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGINT');
  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
}

(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ACCESS_TOKEN,
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();

  let response = await api('POST', '/api/directories', { name: 'durable wait', path: projectDir });
  assert.equal(response.status, 200);
  const directoryId = response.data.id;
  response = await api('POST', `/api/directories/${directoryId}/sessions`, { cli: 'opencode', kind: 'chat' });
  assert.equal(response.status, 200);
  const sessionId = response.data.id;

  const registered = await api('POST', `/api/sessions/${sessionId}/wait`, {
    mode: 'callback',
    injectPrefix: '[external]',
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.ok, true);
  assert.equal(registered.data.status, 'pending');
  assert.equal(typeof registered.data.id, 'string');
  assert.equal(typeof registered.data.token, 'string');
  assert.match(registered.data.callbackUrl, /\/api\/wait\//);

  const stateFile = path.join(dataDir, 'orchestration.json');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes(registered.data.token), false);

  const callbackRoute = new URL(registered.data.callbackUrl).pathname
    + new URL(registered.data.callbackUrl).search;
  const first = await callback(callbackRoute, { data: { answer: 7 } });
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.duplicate, false);
  assert.equal(first.data.status, 'resolved');

  const duplicate = await callback(callbackRoute, { data: { answer: 7 } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);

  const conflict = await callback(callbackRoute, { data: { answer: 8 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'payload_conflict');

  const badToken = await callback(`/api/wait/${registered.data.id}/resolve?token=wrong`, { data: { answer: 7 } });
  assert.equal(badToken.status, 403);
  assert.equal(badToken.data.error, 'bad token');

  response = await api('GET', `/api/sessions/${sessionId}/waits`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.waits, []);
  assert.equal(response.data.stats.resolvedWaits, 1);
  assert.equal(response.data.stats.pendingDeliveries, 1);

  const durableText = fs.readFileSync(stateFile, 'utf8');
  assert.equal(durableText.includes(registered.data.token), false);
  assert.equal(durableText.includes('wrong'), false);

  await stopServer();
  assertTestDir(root);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('durable wait HTTP integration: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-4000));
  await stopServer();
  try { assertTestDir(root); fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});

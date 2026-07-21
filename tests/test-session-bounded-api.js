'use strict';

// Deterministic composition test for the production session bounded context.
// It uses isolated state and inert CLI stubs; no model is invoked and no real
// credentials or user data are read.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const ACCESS_TOKEN = 'session-bounded-api-test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-bounded-api-'));
const dataDir = assertTestDir(path.join(root, 'data'));
const projectDir = path.join(root, 'project');
const binDir = path.join(root, 'bin');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
for (const cli of ['claude', 'codex', 'opencode', 'zcode', 'qoderclicn']) {
  fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

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

async function api(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await api('GET', '/api/directories')).status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated bounded-session server did not become ready');
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), ACCESS_TOKEN,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      MULTICC_DATA_DIR: dataDir,
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
}

function pick(value, fields) {
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

(async () => {
  await startServer();
  let response = await api('POST', '/api/directories', {
    name: 'bounded fixture', path: projectDir,
  });
  assert.equal(response.status, 200);
  const directoryId = response.data.id;

  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'bounded-session',
  });
  assert.equal(response.status, 200);
  const sessionId = response.data.id;

  const messages = Array.from({ length: 35 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message-${index + 1}`,
    ts: 1000 + index,
    ...(index === 34 ? { deliveryId: 'delivery-final' } : {}),
  }));
  const historyDir = path.join(dataDir, 'chat_history');
  fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(historyDir, `${sessionId}.json`), JSON.stringify(messages), { mode: 0o600 });

  const legacyList = await api('GET', '/api/sessions');
  const v1List = await api('GET', '/api/v1/sessions');
  assert.equal(legacyList.status, 200);
  assert.equal(v1List.status, 200);
  const legacy = legacyList.data.find(item => item.id === sessionId);
  const v1 = v1List.data.sessions.find(item => item.id === sessionId);
  const common = [
    'id', 'dirId', 'cli', 'kind', 'label', 'model', 'effectiveModel', 'effort',
    'effectiveEffort', 'agent', 'provider', 'subagent', 'autoCommit', 'autoDispatch',
    'createdAt', 'lastActivity', 'clients', 'active',
  ];
  assert.deepEqual(pick(legacy, common), pick(v1, common));
  assert.deepEqual(
    pick(legacy.mergeState || {}, ['ahead', 'behind', 'dirty', 'mergeReady']),
    pick(v1.mergeState || {}, ['ahead', 'behind', 'dirty', 'mergeReady']),
  );
  assert.equal('cliSessionId' in legacy, true, 'legacy-only payload fields remain additive');
  assert.equal('cliSessionId' in v1, false, 'bounded DTO stays narrow');

  const legacyDetail = await api('GET', `/api/sessions/${sessionId}`);
  const v1Detail = await api('GET', `/api/v1/sessions/${sessionId}`);
  assert.equal(legacyDetail.status, 200);
  assert.equal(v1Detail.status, 200);
  assert.deepEqual(
    pick(legacyDetail.data, ['id', 'cli', 'model', 'effectiveModel', 'effort', 'effectiveEffort', 'agent', 'provider', 'subagent', 'lastActivity', 'clients', 'active']),
    pick(v1Detail.data.session, ['id', 'cli', 'model', 'effectiveModel', 'effort', 'effectiveEffort', 'agent', 'provider', 'subagent', 'lastActivity', 'clients', 'active']),
  );
  assert.equal('cwd' in legacyDetail.data, true);
  assert.equal('cwd' in v1Detail.data.session, false);

  const legacyDirectory = await api('GET', `/api/directories/${directoryId}/sessions`);
  const legacyWorkspace = await api('GET', `/api/directories/${directoryId}/workspace`);
  const v1Workspace = await api('GET', `/api/v1/directories/${directoryId}/workspace`);
  assert.equal(legacyDirectory.status, 200);
  assert.equal(legacyWorkspace.status, 200);
  assert.equal(v1Workspace.status, 200);
  assert.ok(legacyDirectory.data.sessions.some(item => item.id === sessionId));
  const oldWorkspace = legacyWorkspace.data.sessions.find(item => item.id === sessionId);
  const boundedWorkspace = v1Workspace.data.workspace.sessions.find(item => item.session.id === sessionId);
  assert.deepEqual(
    pick(oldWorkspace, ['id', 'status', 'clients', 'pendingNotes', 'classifyState', 'goal', 'phase']),
    {
      id: boundedWorkspace.session.id,
      status: boundedWorkspace.status,
      clients: boundedWorkspace.session.clients,
      pendingNotes: boundedWorkspace.pendingNotes,
      classifyState: boundedWorkspace.classifyState,
      goal: boundedWorkspace.goal,
      phase: boundedWorkspace.phase,
    },
  );

  const newest = await api('GET', `/api/sessions/${sessionId}/history?limit=10`);
  assert.equal(newest.status, 200);
  assert.deepEqual(Object.keys(newest.data).sort(), ['hasMore', 'messages']);
  assert.equal(newest.data.messages.length, 10);
  assert.equal(newest.data.messages[0].id, 'm26');
  assert.equal(newest.data.messages.at(-1).deliveryId, 'delivery-final');
  assert.equal(newest.data.hasMore, true);
  const older = await api('GET', `/api/sessions/${sessionId}/history?before=m26&limit=10`);
  assert.equal(older.status, 200);
  assert.deepEqual(older.data.messages.map(message => message.id),
    ['m16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25']);

  await stopServer();
  assertTestDir(root);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('session bounded-context isolated API: passed');
})().catch(async (error) => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-8000));
  await stopServer();
  try { assertTestDir(root); fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});

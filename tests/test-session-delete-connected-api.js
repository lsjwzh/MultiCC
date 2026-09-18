'use strict';

// Isolated HTTP/WebSocket regression: an attached chat page must not make an
// explicitly deleted session undeletable. No prompt is sent and no AI starts.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const ACCESS_TOKEN = 'session-delete-connected-test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-delete-connected-'));
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

async function api(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, data };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await api('GET', '/api/directories');
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated session-delete server did not become ready');
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

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return Promise.race([
    new Promise(resolve => socket.once('close', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('session WebSocket was not closed')), 3000)),
  ]);
}

async function startServer(port) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ACCESS_TOKEN,
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await waitForServer();

}

function waitForFrame(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`missing ${type}`)); }, 5000);
    function onMessage(data) {
      const frame = JSON.parse(data);
      if (frame.type !== type) return;
      clearTimeout(timer); socket.off('message', onMessage); resolve(frame);
    }
    socket.on('message', onMessage);
  });
}

(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer(port);

  let response = await api('POST', '/api/directories', {
    name: 'connected delete fixture', path: projectDir,
  });
  assert.equal(response.status, 200);
  const directoryId = response.data.id;

  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'connected chat',
  });
  assert.equal(response.status, 200);
  const sessionId = response.data.id;
  // Creating a chat room through the directory route mints the board task that
  // 1:1-owns it; that task is the room's supported disposal path.
  const sessionTaskId = response.data.taskId;
  assert.equal(typeof sessionTaskId, 'string');

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(sessionId)}`);
  await waitForOpen(socket);
  await new Promise(resolve => setTimeout(resolve, 50));

  response = await api('GET', `/api/sessions/${sessionId}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.clients, 1);
  assert.equal(response.data.active, true);

  // A bare DELETE never touches a task-bound room: the room is the task's resume
  // file, so a sweep script must not be able to orphan the task's chat history.
  response = await api('DELETE', `/api/sessions/${sessionId}`);
  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'task_bound_session');
  assert.equal(response.data.taskId, sessionTaskId);
  response = await api('GET', `/api/sessions/${sessionId}`);
  assert.equal(response.status, 200, 'a refused delete leaves the attached page intact');
  assert.equal(response.data.clients, 1);

  // force=1 clears that guard but not retention: the archive still owns this
  // room's history, so the physical delete stays refused.
  response = await api('DELETE', `/api/sessions/${sessionId}?force=1`);
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'TASK_HISTORY_REFERENCED');
  response = await api('GET', `/api/sessions/${sessionId}`);
  assert.equal(response.status, 200, 'retention refusal leaves the room addressable');

  // The owning task is the room's disposal path; deleting it must dispose the
  // room and close any page still attached to it.
  response = await api('DELETE', `/api/task-board/tasks/${sessionTaskId}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.deleted, true);
  await waitForClose(socket);

  response = await api('GET', `/api/sessions/${sessionId}`);
  assert.equal(response.status, 404);

  // A second, independent room for the durable-evidence scenarios below.
  response = await api('POST', `/api/directories/${directoryId}/sessions`, {
    cli: 'opencode', kind: 'chat', label: 'dirty worktree',
  });
  assert.equal(response.status, 200);
  const dirtySessionId = response.data.id;

  // Seed durable task evidence while this isolated server is stopped. Never
  // send a prompt: the fixture needs no native CLI or external AI provider.
  await stopServer();
  const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');
  const history = createChatHistoryFileRepository({ dataDir });
  const original = [
    { id: 'task-user', role: 'user', taskId: 'retained-task', content: 'full requirement', ts: 1 },
    { id: 'task-answer', role: 'assistant', taskId: 'retained-task', content: 'full evidence', ts: 2 },
  ];
  history.write(dirtySessionId, original);
  const originalBytes = fs.readFileSync(history.fileFor(dirtySessionId), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'task_board.json'), JSON.stringify({
    // The board store refuses a hand-written file without its schema envelope.
    schemaVersion: 2, revision: 2,
    modules: {}, tasks: { 'retained-task': {
      id: 'retained-task', title: 'retain task evidence', status: 'done', chatSessionId: dirtySessionId,
      refs: [{ sessionId: dirtySessionId, dirId: directoryId, userMsgId: 'task-user', assistantMsgId: 'task-answer', ts: 1 }],
    } },
  }));
  await startServer(port);
  const historySocket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(dirtySessionId)}`);
  const initialPage = waitForFrame(historySocket, 'chat_history');
  await waitForOpen(historySocket);
  const seeded = (await initialPage).messages;
  assert.equal(seeded.length, 2);
  // A task-bound room's transport is the task shell, so the bare WS
  // clear_history is refused by design and the display-only hide has to go
  // through the HTTP compatibility route. Either way it must hide the view
  // without touching the original bytes.
  for (const message of seeded) {
    response = await api('DELETE', `/api/sessions/${dirtySessionId}/messages/${encodeURIComponent(message.id)}`);
    assert.equal(response.status, 200);
  }
  historySocket.terminate();
  response = await api('GET', `/api/sessions/${dirtySessionId}/history`);
  assert.deepEqual(response.data.messages, []);
  response = await api('GET', `/api/task-board/tasks/retained-task/messages`);
  assert.equal(response.data.messages.length, 2, 'task projection still reads every original message');
  response = await api('POST', '/api/task-board/tasks/retained-task/status', { status: 'archived' });
  assert.equal(response.status, 200);
  assert.equal(response.data.releasedSession, false);
  response = await api('DELETE', `/api/sessions/${dirtySessionId}?force=1`);
  assert.equal(response.status, 409);
  assert.equal(response.data.code, 'TASK_HISTORY_REFERENCED', 'force cannot bypass task evidence protection');
  assert.equal(fs.readFileSync(history.fileFor(dirtySessionId), 'utf8'), originalBytes);
  await stopServer();
  await startServer(port);
  response = await api('GET', `/api/sessions/${dirtySessionId}/history`);
  assert.deepEqual(response.data.messages, [], 'hidden state survives a real server restart');
  const archiveSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(dirtySessionId)}&historyScope=archive`);
  const archivePage = waitForFrame(archiveSocket, 'chat_history');
  await waitForOpen(archiveSocket);
  assert.equal((await archivePage).messages.length, 2, 'task chat replays the full evidence');
  archiveSocket.terminate();
  await api('DELETE', `/api/directories/${directoryId}?force=1`);
  await stopServer();
  assertTestDir(root);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('session display retention and deletion HTTP/WebSocket integration: passed');
})().catch(async error => {
  console.error(error);
  if (stderr) console.error(stderr.slice(-8000));
  await stopServer();
  try { assertTestDir(root); fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = 1;
});

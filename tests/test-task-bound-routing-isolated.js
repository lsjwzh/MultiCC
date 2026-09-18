'use strict';

// Process-level proof of the task-first ingress (#38) and of the retired
// Commander-anchored board endpoints: board input owns a hidden task-bound
// chat session and the turn runs there — no Commander hop, no pooled execution
// slot, no TaskRun ledger row. The server owns a temporary data root and the
// bound session runs a deterministic fake Codex; no live task, chat history,
// project, or AI provider is touched.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir, createPaths } = require('../src/paths');
const { readJson } = require('../src/state/store');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'board-routing-isolated';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-board-route-'));
const dataRoot = assertTestDir(path.join(testRoot, 'data'));
const project = path.join(testRoot, 'project');
const fakeCodex = path.join(testRoot, 'fake-codex.js');
const invocationFile = path.join(testRoot, 'codex-invocations.jsonl');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const args = process.argv.slice(2);
  const sessionId = process.env.MULTICC_SESSION_ID || 'unknown';
  const threadId = 'fake-' + sessionId;
  // A resumable native identity: the product refuses to continue a Codex
  // session whose rollout is missing, so the stand-in keeps one per session.
  const sessionsDir = path.join(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'), 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'rollout-' + threadId + '.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: process.cwd() } }) + '\\n');
  fs.appendFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({ cwd: process.cwd(), args, sessionId }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'FAKE-WORKER-DONE' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 },
  }) + '\\n');
}
main().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\\n');
  process.exitCode = 1;
});
`);
fs.chmodSync(fakeCodex, 0o755);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// Transcripts are stored one JSON message per line (legacy files are a single
// JSON array), so read them the way the durable format is written.
function readTranscript(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function waitUntil(check, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), ACCESS_TOKEN: TOKEN,
      MULTICC_DATA_DIR: dataRoot,
      MULTICC_MEMORY_ROOT: path.join(dataRoot, 'memories'),
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100',
      MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS: '0',
      CLAUDE_CMD: path.join(testRoot, 'missing-claude'),
      CODEX_CMD: fakeCodex,
      OPENCODE_CMD: path.join(testRoot, 'missing-opencode'),
      QODER_CMD: path.join(testRoot, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-50000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-50000); });

  async function api(method, route, body, expected = 200) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (response.status !== expected) {
      throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
    }
    return data;
  }

  async function stop() {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }

  const invocationRows = () => {
    if (!fs.existsSync(invocationFile)) return [];
    return fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
  };
  const execRows = () => invocationRows().filter(row => row.args[0] === 'exec');

  try {
    await waitUntil(async () => (await fetch(`${base}/readyz`)).status === 200, 'isolated board-routing server did not become ready', 300);
    const directory = await api('POST', '/api/directories', {
      name: 'Task-first board ingress', path: project, create: true,
    });
    let sessions = await api('GET', '/api/sessions');
    // Task-first: a directory owns tasks, not roles. Registering one must not
    // seed a Commander or any other role execution/worktree.
    assert.equal(sessions.some(session => session.dirId === directory.id), false,
      'registering a directory seeds no role session');

    // The retired Commander-anchored directory composer must fail closed
    // rather than invent a worker for a fleet that has no typed Commander.
    const legacyDir = await fetch(base + '/api/task-board/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ dirId: directory.id, text: '从任务面板进入统一通道', clientMsgId: 'panel-isolated-1' }),
    });
    assert.equal(legacyDir.status, 409, 'the legacy dir-level board ingress is retired, never silent');
    assert.equal((await legacyDir.json()).error, 'commander_not_found');

    // A session created by hand is task-first too: it becomes a hidden
    // task-bound chat room with its own worktree, never a fleet-visible role.
    const observer = await api('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'codex', kind: 'chat', label: '旁观任务',
    });
    const target = await api('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'codex', kind: 'chat', label: '目标任务',
    });
    const paths = createPaths({ dataDir: dataRoot });
    for (const record of [observer, target]) {
      assert.ok(record.id && record.taskBoundTaskId, 'a new session is a task-bound chat room');
      assert.equal(record.cliSessionId, null,
        'a new session has no native CLI session before its first turn');
      assert.equal(fs.existsSync(path.join(paths.chatHistoryDir, `${record.id}.json`)), false,
        'a new session has no chat history before its first turn');
    }
    assert.notEqual(observer.taskBoundTaskId, target.taskBoundTaskId);

    sessions = await api('GET', '/api/sessions');
    assert.equal(sessions.some(session => session.id === observer.id || session.id === target.id), false,
      'task-bound sessions stay out of the ordinary Fleet list');
    assert.equal(sessions.some(session => session.dirId === directory.id && session.type === 'commander'), false,
      'no Commander session exists to hop through');

    const persisted = readJson(paths.sessionsFile, { legacyIsArray: true }).data;
    const durableTarget = persisted.find(session => session.id === target.id);
    assert.ok(durableTarget, 'the bound session is a durable record, not an ephemeral slot');
    assert.equal(durableTarget.taskBoundTaskId, target.taskBoundTaskId,
      'the 1:1 binding is persisted on the record');
    assert.notEqual(durableTarget.type, 'commander');
    assert.equal(durableTarget.taskExecutionSlot === true, false, 'no pooled execution slot is created');

    // The observer socket proves the turn never leaks into another room.
    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(observer.id)}&token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('message', raw => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch (_) { return; }
        events.push(event);
      });
      socket.on('error', reject);
    });

    // #38 · the ONLY admission path is the task-bound chat session: the shell
    // receipt names it, and the card owns that same session.
    const shell = await api('POST', '/api/task-shells', { sessionId: target.id });
    const shellId = shell.id;
    assert.equal(shell.sourceSessionId, target.id);
    const sendInput = {
      text: '从任务面板进入统一通道', clientMsgId: 'panel-isolated-1', intent: 'work',
    };
    const panelFirst = await api('POST', `/api/task-shells/${shellId}/messages`, sendInput);
    assert.equal(panelFirst.sessionId, target.id, 'the receipt names the bound session');
    assert.equal(panelFirst.taskId, target.taskBoundTaskId);
    const panelReplay = await api('POST', `/api/task-shells/${shellId}/messages`, sendInput);
    assert.deepEqual(panelReplay, panelFirst, 'replay is an idempotent re-delivery');

    const invocationRowsSeen = await waitUntil(() => (execRows().length === 1 ? invocationRows() : null),
      'the board turn did not trigger exactly one bound-session execution', 200);
    assert.equal(invocationRowsSeen.every(row => row.sessionId === target.id), true,
      'only the task-bound session executes a model turn for board input');
    assert.equal(fs.realpathSync(execRows()[0].cwd), fs.realpathSync(durableTarget.worktreePath));
    // The replay above raced the first execution: prove it never added a run.
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(execRows().length, 1, 'a replay never opens a second execution');

    const panelCard = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board');
      return value.tasks.find(task => task.id === panelFirst.taskId) || null;
    }, 'the task did not project from its bound session history');
    assert.equal(panelCard.chatSessionId, target.id, 'the durable card owns its bound session');
    assert.equal(panelCard.body, '从任务面板进入统一通道');
    assert.equal(panelCard.legacy, false);
    assert.equal(Object.hasOwn(panelCard, 'taskText'), false,
      'task board index may keep a derived title but never a second canonical body');
    const readOnlyBoard = JSON.parse(fs.readFileSync(paths.taskBoardFile, 'utf8'));
    const projectedTask = readOnlyBoard.tasks[panelCard.id];
    assert.equal(Object.hasOwn(projectedTask, 'body'), false);
    assert.notEqual(projectedTask.chatSessionId, observer.id, 'the observer room never receives the card');

    // The empty-room regression this path exists to prevent: the user's own
    // text and the reply live in the bound session's history — the very file
    // the chat view opens when the card is clicked.
    const boundHistoryFile = path.join(paths.chatHistoryDir, target.id + '.json');
    const boundHistory = await waitUntil(() => {
      const rows = readTranscript(boundHistoryFile);
      return rows.some(message => message.role === 'assistant'
        && String(message.content || '').includes('FAKE-WORKER-DONE')) ? rows : null;
    }, 'the bound session history did not record the turn', 250);
    assert.equal(
      boundHistory.filter(message => message.role === 'user'
        && String(message.content || '') === '从任务面板进入统一通道').length,
      1,
      'the raw user text is the first user turn of the bound room, verbatim and once',
    );

    // The task detail view projects that same history — no transport wrapper
    // exists to leak into it any more.
    const detailView = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board/tasks/' + panelCard.id + '/messages');
      return value.items?.some(item => item.role === 'assistant'
        && String(item.text || '').includes('FAKE-WORKER-DONE')) ? value : null;
    }, 'task detail projection did not include the reply', 250);
    const detailTexts = detailView.items.map(item => String(item.text || ''));
    assert.equal(detailTexts.filter(text => text === '从任务面板进入统一通道').length, 1,
      'raw admission text appears exactly once in the task detail projection');
    assert.equal(detailTexts.some(text => text.includes('【Commander 单向路由任务】')
      || text.includes('[MultiCC 任务运行上下文')), false,
    'a bound turn carries no transport wrapper and no compiled ledger context');

    // The old per-task send ingress cannot bypass shell ownership.
    const retired = await fetch(base + '/api/task-board/tasks/' + panelCard.id + '/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ text: 'blocked old ingress', clientMsgId: 'retired' }),
    });
    assert.equal(retired.status, 409);
    assert.equal((await retired.json()).error, 'task_shell_route_required');

    // The same shell continues the same idle execution and native identity.
    const continued = await api('POST', `/api/task-shells/${shellId}/messages`, {
      taskId: panelCard.id, text: '补充同一任务的验收细节', clientMsgId: 'panel-isolated-2', intent: 'work',
    });
    assert.equal(continued.sessionId, target.id);
    const followupExecs = await waitUntil(() => (execRows().length === 2 ? execRows() : null),
      'follow-up did not trigger a second bound-session execution', 250);
    assert.equal(fs.realpathSync(followupExecs[1].cwd), fs.realpathSync(durableTarget.worktreePath),
      'the follow-up runs in the bound session worktree, never a fresh slot');
    const followupPayload = String(followupExecs[1].args[followupExecs[1].args.length - 1] || '');
    assert.ok(followupPayload.includes('补充同一任务的验收细节'),
      'follow-up payload carries the new admission text');
    assert.equal(followupPayload.includes('【Commander 单向路由任务】'), false,
      'the pooled transport wrapper is gone');
    assert.equal(followupPayload.includes('[MultiCC 任务运行上下文'), false,
      'a live bound session needs no compiled ledger context — the session IS the context');

    const detailAfterFollowup = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board/tasks/' + panelCard.id + '/messages');
      const texts = (value.items || []).map(item => String(item.text || ''));
      return texts.some(text => text === '补充同一任务的验收细节')
        && texts.filter(text => text.includes('FAKE-WORKER-DONE')).length >= 2 ? value : null;
    }, 'task detail projection did not include the follow-up turn', 250);
    const followupTexts = detailAfterFollowup.items.map(item => String(item.text || ''));
    assert.equal(followupTexts.filter(text => text === '补充同一任务的验收细节').length, 1,
      'follow-up admission appears exactly once in the projection');

    const observerHistory = readTranscript(path.join(paths.chatHistoryDir, observer.id + '.json'));
    assert.equal(JSON.stringify(observerHistory).includes('从任务面板进入统一通道'), false,
      'board input never enters another session history');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(events.some(event => event.type === 'assistant'), false,
      'the observed task-bound room never runs a model turn for board input');
    assert.equal(events.some(event => event.type === 'dispatch.result'), false,
      'no worker result flows back to the observer socket');
    assert.equal(fs.existsSync(path.join(paths.chatHistoryDir, observer.id + '.json')), false,
      'the observed room keeps no history at all');
    socket.terminate();
    await stop();
    console.log('board input → task-bound shell session → real CLI turn: passed');
  } catch (error) {
    await stop();
    throw Object.assign(error, { message: `${error.message}\n${output}` });
  } finally {
    assertTestDir(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

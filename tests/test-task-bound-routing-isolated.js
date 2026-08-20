'use strict';

// Process-level proof for the real task ingress (#38): board input binds a
// hidden task-bound chat session and the turn runs there — no Commander hop,
// no pooled execution slot, no TaskRun ledger row. The server owns a temporary
// data root and the bound session runs a deterministic fake Codex; no live
// task, chat history, project, or AI provider is touched.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir, createPaths } = require('../src/paths');
const { readJson } = require('../src/state-store');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'commander-routing-isolated';
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-commander-route-'));
const dataRoot = assertTestDir(path.join(testRoot, 'data'));
const project = path.join(testRoot, 'project');
const fakeCodex = path.join(testRoot, 'fake-codex.js');
const invocationFile = path.join(testRoot, 'codex-invocations.jsonl');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
async function main() {
  const args = process.argv.slice(2);
  const sessionId = process.env.MULTICC_SESSION_ID || 'unknown';
  fs.appendFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({ cwd: process.cwd(), args, sessionId }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + sessionId }) + '\\n');
  const base = process.env.MULTICC_BASE_URL;
  const headers = process.env.ACCESS_TOKEN
    ? { Authorization: 'Bearer ' + process.env.ACCESS_TOKEN }
    : {};
  const sessionsResponse = await fetch(base + '/api/sessions', { headers });
  const sessions = await sessionsResponse.json();
  const current = sessions.find(session => session.id === sessionId);
  if (current && current.type === 'commander') {
    const target = sessions.find(session => session.dirId === current.dirId
      && session.type !== 'commander'
      && String(session.label || '').startsWith('全栈工程师'));
    if (!target) throw new Error('fake Commander could not resolve a worker');
    const payload = String(args[args.length - 1] || '');
    const knownTasks = ['实现一个隔离测试功能', '从任务面板进入统一通道', '补充同一任务的验收细节'];
    const message = knownTasks.find(value => payload.includes(value)) || payload.slice(-2000);
    const toolResponse = await fetch(base + '/api/internal/router-tools/route_task', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-multicc-router-capability': process.env.MULTICC_ROUTER_CAPABILITY || '',
      },
      body: JSON.stringify({ arguments: { target_session_id: target.id, message } }),
    });
    const toolBody = await toolResponse.json();
    if (!toolResponse.ok || !toolBody.ok) throw new Error('route_task failed: ' + JSON.stringify(toolBody));
    process.stdout.write(JSON.stringify({
      type: 'item.started',
      item: { type: 'mcp_tool_call', id: 'route-call', tool: 'mcp__multicc_router__route_task',
        arguments: JSON.stringify({ target_session_id: target.id, message }) },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', id: 'route-call', status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify(toolBody.result) }] } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'FAKE-COMMANDER-ROUTED' },
    }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'FAKE-WORKER-DONE' },
    }) + '\\n');
  }
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
      CLAUDE_CMD: path.join(testRoot, 'missing-claude'),
      CODEX_CMD: fakeCodex,
      OPENCODE_CMD: path.join(testRoot, 'missing-opencode'),
      QODER_CMD: path.join(testRoot, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-50000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-50000); });

  async function api(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const data = raw ? JSON.parse(raw) : null;
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${raw}`);
    return data;
  }

  async function stop() {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }

  try {
    await waitUntil(async () => (await fetch(`${base}/readyz`)).status === 200, 'isolated Commander server did not become ready', 300);
    const directory = await api('POST', '/api/directories', {
      name: 'Commander routing', path: project, create: true,
    });
    let sessions = await api('GET', '/api/sessions');
    const commander = sessions.find(session => session.dirId === directory.id && session.type === 'commander');
    assert.ok(commander, 'directory creation seeds a typed Commander');

    for (const ordinal of [1, 2]) {
      await api('POST', `/api/directories/${directory.id}/sessions`, {
        cli: 'codex', kind: 'chat', label: `全栈工程师 ${ordinal}`,
        rolePrompt: `# 角色：全栈工程师 ${ordinal}\n执行工程任务`,
      });
    }
    const specialist = await api('POST', `/api/directories/${directory.id}/sessions`, {
      cli: 'codex', kind: 'chat', label: '架构师', rolePrompt: '# 角色：架构师\n只接受用户手工任务',
    });
    sessions = await api('GET', '/api/sessions');
    const pristineWorkers = sessions.filter(session => session.dirId === directory.id
      && String(session.label || '').startsWith('全栈工程师'));
    assert.equal(pristineWorkers.length, 2);
    assert.equal(pristineWorkers.every(session => !session.cliSessionId), true,
      'new workers have no native CLI session before route_task');
    const pristinePaths = createPaths({ dataDir: dataRoot });
    assert.equal(pristineWorkers.every(session =>
      !fs.existsSync(path.join(pristinePaths.chatHistoryDir, `${session.id}.json`))), true,
    'new workers have no chat history or manual initialization before route_task');

    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(commander.id)}&token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('message', raw => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch (_) { return; }
        events.push(event);
      });
      socket.on('error', reject);
    });

    const panelFirst = await api('POST', '/api/task-board/send', {
      dirId: directory.id,
      text: '从任务面板进入统一通道',
      clientMsgId: 'panel-isolated-1',
    });
    const panelReplay = await api('POST', '/api/task-board/send', {
      dirId: directory.id,
      text: '从任务面板进入统一通道',
      clientMsgId: 'panel-isolated-1',
    });
    const panelCard = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board');
      return value.tasks.find(task => task.body === '从任务面板进入统一通道') || null;
    }, 'panel task did not project from its bound session history');
    assert.equal(panelCard.body, '从任务面板进入统一通道');
    assert.equal(panelCard.legacy, false);

    // #38 · the ONLY admission path is the task-bound chat session: no
    // Commander hop, no pooled execution slot, no TaskRun ledger row.
    assert.equal(panelFirst.taskBound, true);
    assert.equal(panelFirst.routingMode, 'task-bound');
    assert.equal(panelFirst.commanderSessionId, null, 'the Commander is not a dispatch hop');
    const boundId = panelFirst.target;
    assert.ok(boundId, 'the receipt names the bound session');
    assert.notEqual(boundId, commander.id);
    assert.equal(panelFirst.workerSessionId, boundId);
    assert.equal(panelReplay.taskId, panelFirst.taskId);
    assert.equal(panelReplay.target, boundId);
    assert.equal(panelReplay.duplicate, true, 'panel replay is an idempotent re-delivery');
    assert.equal((await api('GET', '/api/task-board')).tasks.filter(task => task.id === panelCard.id).length, 1);

    const paths = createPaths({ dataDir: dataRoot });
    const persistedBoard = JSON.parse(fs.readFileSync(paths.taskBoardFile, 'utf8'));
    const projectedTask = persistedBoard.tasks[panelCard.id];
    assert.equal(projectedTask.chatSessionId, boundId, 'the durable card owns its bound session');
    assert.equal(projectedTask.routing?.workerSessionId, boundId);
    assert.equal(projectedTask.routing?.oneWay, true);
    assert.notEqual(projectedTask.routing?.workerSessionId, specialist.id, 'specialist is never auto-routed');
    assert.equal(Object.hasOwn(projectedTask, 'body'), false);
    assert.equal(Object.hasOwn(projectedTask, 'taskText'), false,
      'task board index may keep a derived title but never a second canonical body');

    const invocationRows = await waitUntil(() => {
      if (!fs.existsSync(invocationFile)) return null;
      const rows = fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
      return rows.filter(row => row.args[0] === 'exec').length === 1 ? rows : null;
    }, 'panel task did not trigger exactly one bound-session execution', 200);
    const persisted = readJson(paths.sessionsFile, { legacyIsArray: true }).data;
    const durableCommander = persisted.find(session => session.id === commander.id);
    const durableBound = persisted.find(session => session.id === boundId);
    assert.ok(durableBound, 'the bound session is a durable record, not an ephemeral slot');
    assert.equal(durableBound.taskBoundTaskId, panelCard.id, 'the 1:1 binding is persisted on the record');
    assert.notEqual(durableBound.type, 'commander');
    assert.equal(durableBound.taskExecutionSlot === true, false, 'no pooled execution slot is created');
    assert.ok(invocationRows.find(row =>
      fs.realpathSync(row.cwd) === fs.realpathSync(durableBound.worktreePath)));
    assert.equal(invocationRows.some(row =>
      fs.realpathSync(row.cwd) === fs.realpathSync(durableCommander.worktreePath)), false,
    'Commander never executes a model turn for board input');
    assert.equal((await api('GET', '/api/sessions')).some(session => session.id === boundId), false,
      'the bound session stays out of the ordinary Fleet list');

    // The empty-room regression this path exists to prevent: the user's own
    // text and the reply live in the bound session's history — the very file
    // the chat view opens when the card is clicked.
    const boundHistoryFile = path.join(paths.chatHistoryDir, boundId + '.json');
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

    // A follow-up re-enters the SAME room instead of admitting a second run.
    await api('POST', '/api/task-board/tasks/' + panelCard.id + '/send', {
      text: '补充同一任务的验收细节', clientMsgId: 'panel-isolated-2',
    });
    const followupExecs = await waitUntil(() => {
      const rows = fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
      const execs = rows.filter(row => row.args[0] === 'exec');
      return execs.length === 2 ? execs : null;
    }, 'follow-up did not trigger a second bound-session execution', 200);
    assert.equal(fs.realpathSync(followupExecs[1].cwd), fs.realpathSync(durableBound.worktreePath),
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

    const commanderHistoryFile = path.join(paths.chatHistoryDir, commander.id + '.json');
    const commanderHistory = readTranscript(commanderHistoryFile);
    assert.equal(JSON.stringify(commanderHistory).includes('从任务面板进入统一通道'), false,
      'board input never enters the Commander chat history');

    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(events.some(event => event.type === 'assistant'), false, 'Commander never runs a model turn for board input');
    assert.equal(events.some(event => event.type === 'dispatch.result'), false, 'no worker result flows back to the Commander');
    sessions = await api('GET', '/api/sessions');
    assert.equal(sessions.find(session => session.id === specialist.id).type, null, 'specialist metadata remains manual-only');
    socket.terminate();
    await stop();
    console.log('board send → task-bound chat session → real CLI turn: passed');
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

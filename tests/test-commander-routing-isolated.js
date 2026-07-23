'use strict';

// Process-level proof for the real Commander input path. The server owns a
// temporary data root and the selected worker runs a deterministic fake Codex;
// no live task, chat history, project, or AI provider is touched.

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
fs.appendFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-worker-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FAKE-WORKER-DONE' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
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
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100',
      CLAUDE_CMD: path.join(testRoot, 'missing-claude'),
      CODEX_CMD: fakeCodex,
      OPENCODE_CMD: path.join(testRoot, 'missing-opencode'),
      QODER_CMD: path.join(testRoot, 'missing-qoder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });

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
    await waitUntil(async () => (await fetch(`${base}/readyz`)).status === 200, 'isolated Commander server did not become ready');
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

    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?session=${encodeURIComponent(commander.id)}&token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Commander route receipt timeout')), 10000);
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'user_message', text: '实现一个隔离测试功能', clientMsgId: 'commander-isolated-1',
      })));
      socket.on('message', raw => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch (_) { return; }
        events.push(event);
        if (event.type === 'result' && event.commanderRoute === true) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on('error', reject);
    });

    const board = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board');
      return value.tasks.find(task => task.routing?.oneWay && task.routing?.targetSessionId === commander.id) || null;
    }, 'Commander input did not create a one-way task card');
    assert.ok(board.routing.workerSessionId, 'task card preserves the selected worker');
    assert.equal(board.routing.targetSessionId, commander.id);
    assert.equal(board.routing.oneWay, true);
    assert.notEqual(board.routing.workerSessionId, specialist.id, 'specialist is never auto-routed');

    const execInvocation = await waitUntil(() => {
      if (!fs.existsSync(invocationFile)) return null;
      const rows = fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
      return rows.find(row => row.args[0] === 'exec') || null;
    }, 'selected worker fake CLI was not invoked');
    const persisted = readJson(createPaths({ dataDir: dataRoot }).sessionsFile, { legacyIsArray: true }).data;
    const durableCommander = persisted.find(session => session.id === commander.id);
    const durableWorker = persisted.find(session => session.id === board.routing.workerSessionId);
    assert.equal(fs.realpathSync(execInvocation.cwd), fs.realpathSync(durableWorker.worktreePath),
      'only the selected worker executes the CLI');
    assert.notEqual(fs.realpathSync(execInvocation.cwd), fs.realpathSync(durableCommander.worktreePath),
      'Commander never executes the CLI');

    const paths = createPaths({ dataDir: dataRoot });
    const workerHistoryFile = path.join(paths.chatHistoryDir, `${board.routing.workerSessionId}.json`);
    const workerHistory = await waitUntil(() => {
      if (!fs.existsSync(workerHistoryFile)) return null;
      const messages = JSON.parse(fs.readFileSync(workerHistoryFile, 'utf8'));
      return messages.some(message => message.role === 'assistant' && message.content === 'FAKE-WORKER-DONE')
        ? messages : null;
    }, 'worker history did not persist the routed turn');
    const canonicalStart = workerHistory.find(message => message.role === 'user' && message.taskStart === true);
    assert.equal(canonicalStart.taskId, board.id);
    assert.equal(canonicalStart.taskSource, 'commander');
    assert.equal(canonicalStart.taskText, '实现一个隔离测试功能');
    assert.match(canonicalStart.content, /Commander 单向路由任务/);

    const replayResult = new Promise((resolve, reject) => {
      const prior = events.filter(event => event.type === 'result' && event.commanderRoute === true).length;
      const timer = setTimeout(() => reject(new Error('Commander idempotent replay timeout')), 10000);
      const handler = raw => {
        let event;
        try { event = JSON.parse(raw.toString()); } catch (_) { return; }
        events.push(event);
        if (event.type === 'result' && event.commanderRoute === true
            && events.filter(item => item.type === 'result' && item.commanderRoute === true).length > prior) {
          clearTimeout(timer);
          socket.off('message', handler);
          resolve();
        }
      };
      socket.on('message', handler);
      socket.send(JSON.stringify({
        type: 'user_message', text: '实现一个隔离测试功能', clientMsgId: 'commander-isolated-1',
      }));
    });
    await replayResult;
    await new Promise(resolve => setTimeout(resolve, 300));
    const afterReplayRows = fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
    assert.equal(afterReplayRows.filter(row => row.args[0] === 'exec').length, 1,
      'same Commander taskId must not execute twice');

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
    assert.equal(panelFirst.taskId, panelReplay.taskId);
    const panelCard = await waitUntil(async () => {
      const value = await api('GET', '/api/task-board');
      return value.tasks.find(task => task.id === panelFirst.taskId && task.body) || null;
    }, 'panel task did not project from canonical worker history');
    assert.equal(panelCard.body, '从任务面板进入统一通道');
    assert.equal(panelCard.legacy, false);
    assert.equal((await api('GET', '/api/task-board')).tasks.filter(task => task.id === panelFirst.taskId).length, 1);
    assert.equal(fs.readFileSync(paths.taskBoardFile, 'utf8').includes('从任务面板进入统一通道'), false,
      'task board index must not duplicate the canonical task body');
    await waitUntil(() => {
      const rows = fs.readFileSync(invocationFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
      return rows.filter(row => row.args[0] === 'exec').length === 2;
    }, 'panel task did not trigger worker execution exactly once');

    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(events.some(event => event.type === 'assistant'), false, 'Commander emits no assistant reply');
    assert.equal(events.some(event => event.type === 'dispatch.result'), false, 'worker result never flows back to Commander');
    sessions = await api('GET', '/api/sessions');
    assert.equal(sessions.find(session => session.id === specialist.id).type, null, 'specialist metadata remains manual-only');
    assert.ok(['worker'].includes(sessions.find(session => session.id === board.routing.workerSessionId).type));
    socket.terminate();
    await stop();
    console.log('Commander real WS → task board → one-way worker route: passed');
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

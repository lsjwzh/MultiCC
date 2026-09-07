'use strict';

// Full host / SQLite / scheduler / worktree / fake Codex proof. No live model,
// user history or production service is used or restarted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createPaths, assertTestDir } = require('../src/paths');
const { readJson } = require('../src/state/store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-isolated-'));
const dataDir = assertTestDir(path.join(root, 'data'));
const project = path.join(root, 'project'), fake = path.join(root, 'fake-codex.js');
const invocations = path.join(root, 'invocations.jsonl'), release = path.join(root, 'release');
fs.mkdirSync(project); fs.mkdirSync(dataDir);
const testHome = path.join(root, 'home'), preload = path.join(root, 'home.cjs');
fs.mkdirSync(testHome);
fs.writeFileSync(preload, 'require("node:os").homedir = () => ' + JSON.stringify(testHome) + ';');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const prompt = args.at(-1) || '';
const nativeId = 'fake-' + process.env.MULTICC_SESSION_ID;
const sessionsDir = require('node:path').join(process.env.CODEX_HOME || require('node:path').join(require('node:os').homedir(), '.codex'), 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(require('node:path').join(sessionsDir, 'rollout-' + nativeId + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: process.cwd() } }) + '\\n');
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ sessionId: process.env.MULTICC_SESSION_ID, cwd: process.cwd(), prompt }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-' + process.env.MULTICC_SESSION_ID }));
async function main() {
  if (prompt.includes('WAIT_CANCEL') && fs.readFileSync(${JSON.stringify(invocations)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(r => r.sessionId === process.env.MULTICC_SESSION_ID).length === 1) {
    while (true) await new Promise(r => setTimeout(r, 100));
  }
  if (prompt.includes('HOLD_ORIGINAL')) {
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 100));
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SHELL_COMPLETED_EVIDENCE' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
`); fs.chmodSync(fake, 0o755);

async function wait(check, label, count = 250) {
  for (let i = 0; i < count; i++) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label);
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); const port = server.address().port;
  await new Promise(r => server.close(r)); return port;
}
const rows = () => fs.existsSync(invocations) ? fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  let server, socket, logs = '', base;
  const token = 'task-shell-isolated';
  async function api(route, body, expected = 200) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, expected, `${route}: ${text}`);
    return JSON.parse(text);
  }
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    await exited; clearTimeout(timer);
  }
  async function start(enabled = '1') {
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: token,
        NODE_OPTIONS: '--require ' + preload, MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS: '0', MULTICC_DATA_DIR: dataDir, MULTICC_MEMORY_ROOT: path.join(dataDir, 'memories'), MULTICC_TASK_SHELLS: enabled,
        MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100', CODEX_CMD: fake,
        CLAUDE_CMD: path.join(root, 'missing-claude'), OPENCODE_CMD: path.join(root, 'missing-opencode'), QODER_CMD: path.join(root, 'missing-qoder') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', c => { logs = (logs + c).slice(-30000); });
    server.stderr.on('data', c => { logs = (logs + c).slice(-30000); });
    await wait(async () => { try { return (await fetch(base + '/readyz')).ok; } catch (_) { return false; } }, 'server readiness', 400);
  }
  try {
    await start();
    const directory = await api('/api/directories', { name: 'Task shell experiment', path: project, create: true });
    const a = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Shell A' });
    const b = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Shell B' });
    const sa = await api('/api/task-shells', { sessionId: a.id }), sb = await api('/api/task-shells', { sessionId: b.id });
    const first = await api(`/api/task-shells/${sa.id}/messages`, { text: 'HOLD_ORIGINAL', clientMsgId: 'one', intent: 'work' });
    await wait(() => rows().some(r => r.sessionId === first.sessionId), 'first execution did not start');
    await api(`/api/task-shells/${sb.id}/links`, { taskId: first.taskId });
    const newTaskInput = { text: 'INDEPENDENT_TASK', newTask: true, clientMsgId: 'two', intent: 'work' };
    const second = await api(`/api/task-shells/${sb.id}/messages`, newTaskInput);
    assert.notEqual(second.taskId, first.taskId); assert.equal(second.decision, 'new');
    const replay = await api(`/api/task-shells/${sb.id}/messages`, newTaskInput); assert.deepEqual(replay, second);
    await wait(() => rows().some(r => r.sessionId === second.sessionId), 'new task execution did not start concurrently');
    const paths = createPaths({ dataDir });
    const sessions = readJson(paths.sessionsFile, { legacyIsArray: true }).data;
    const recordA = sessions.find(s => s.id === first.sessionId), recordB = sessions.find(s => s.id === second.sessionId);
    assert.equal(recordB.autoCommit, false);
    assert.notEqual(recordA.worktreePath, recordB.worktreePath);
    assert.notEqual(recordA.cliSessionId, recordB.cliSessionId);
    assert.equal(recordB.taskBoundTaskId, second.taskId);
    assert.ok(fs.existsSync(path.join(recordB.worktreePath, '.git')));
    assert.equal(rows().filter(r => r.sessionId === second.sessionId).length, 1);
    assert.equal(rows().find(r => r.sessionId === second.sessionId).prompt.includes('HOLD_ORIGINAL'), false, 'unfinished source input must not become snapshot context');
    const detail = await wait(async () => {
      const d = await api(`/api/task-shells/${sb.id}/tasks/${second.taskId}`);
      return d.messages.some(m => m.role === 'assistant' && String(m.content).includes('SHELL_COMPLETED_EVIDENCE')) && d;
    }, 'formal history missing');
    assert.equal(detail.task.parentTaskId, null);
    assert.match(detail.task.baseline.commit, /^[a-f0-9]{40,64}$/);
    const events = [];
    socket = new WebSocket(base.replace('http', 'ws') + `/ws/chat?session=${second.sessionId}&shell=${sb.id}&token=${token}`);
    socket.on('message', data => { events.push(JSON.parse(String(data))); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await wait(() => events.some(e => e.type === 'chat_history' && e.messages.some(m => m.content === 'HOLD_ORIGINAL')), 'shell reconnect lost original history');
    const shellPage = await api(`/api/task-shells/${sb.id}/history?limit=100`);
    assert.ok(shellPage.messages.some(m => m.sourceSessionId === first.sessionId));
    assert.ok(shellPage.messages.some(m => m.sourceSessionId === second.sessionId));
    assert.equal((await api(`/api/task-shells/${sb.id}/chat`)).activeSessionId, second.sessionId);
    for (const type of ['user_message', 'cancel', 'clear_history']) socket.send(JSON.stringify({ type, text: 'BYPASS', clientMsgId: 'bypass' }));
    await wait(() => events.filter(e => e.code === 'task_shell_route_required').length >= 3, 'native WS bypass must reject');
    socket.close(); socket = null;
    fs.writeFileSync(release, 'done');
    await wait(async () => (await api(`/api/task-shells/${sa.id}/tasks/${first.taskId}`)).messages.some(m => m.role === 'assistant'), 'original never completed');
    const protectedMerge = await api(`/api/task-board/tasks/${first.taskId}/merge-tasks`, { sourceTaskIds: [second.taskId] }, 409);
    assert.equal(protectedMerge.error, 'task_shell_identity_immutable');
    // Freeze two sources as references in a fresh task. This is sharing, not a merge.
    await api(`/api/task-shells/${sa.id}/links`, { taskId: second.taskId });
    const third = await api(`/api/task-shells/${sa.id}/messages`, { text: 'USE_BOTH_CONTEXTS', newTask: true, clientMsgId: 'three', intent: 'work', contextTaskIds: [first.taskId, second.taskId] });
    await wait(() => rows().some(r => r.sessionId === third.sessionId), 'reference execution missing');
    const prompt = rows().find(r => r.sessionId === third.sessionId).prompt;
    assert.ok(prompt.includes(first.taskId) && prompt.includes(second.taskId));
    assert.ok(prompt.includes('SHELL_COMPLETED_EVIDENCE'));
    await wait(async () => (await api(`/api/task-shells/${sa.id}/tasks/${third.taskId}`)).messages.some(m => m.role === 'assistant'), 'reference completion missing');
    const cancelTask = await api(`/api/task-shells/${sa.id}/messages`, { text: 'WAIT_CANCEL', newTask: true, clientMsgId: 'cancel-job', intent: 'work' });
    const running = await wait(async () => {
      const d = await api(`/api/task-shells/${sa.id}/tasks/${cancelTask.taskId}`);
      return rows().some(r => r.sessionId === cancelTask.sessionId) && d.execution.turnId && d;
    }, 'cancel target did not start');
    await api(`/api/task-shells/${sa.id}/messages`, { text: '', clientMsgId: 'stop', intent: 'cancel', taskId: cancelTask.taskId, turnId: running.execution.turnId });
    await wait(async () => !(await api(`/api/task-shells/${sa.id}/tasks/${cancelTask.taskId}`)).execution.busy, 'cancel did not release occupancy');
    const resumed = await api(`/api/task-shells/${sa.id}/messages`, { text: 'RESUME_AFTER_CANCEL', clientMsgId: 'resume', intent: 'work', taskId: cancelTask.taskId });
    assert.equal(resumed.taskId, cancelTask.taskId);
    await wait(() => rows().filter(r => r.sessionId === cancelTask.sessionId).length === 2, 'cancelled idle task did not resume');
    await wait(async () => (await api(`/api/task-shells/${sa.id}/tasks/${cancelTask.taskId}`)).messages.some(m => m.role === 'assistant' && String(m.content).includes('SHELL_COMPLETED_EVIDENCE')), 'resumed task did not complete');
    // Existing App transport enters the same shell runtime and keeps a stable
    // execution/native identity when the adopted source is idle.
    const source = await api(`/api/directories/${directory.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Existing conversation' });
    const appEvents = [];
    socket = new WebSocket(base.replace('http', 'ws') + `/ws/chat?session=${source.id}&token=${token}`);
    socket.on('message', data => appEvents.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const appInput = { type: 'user_message', taskShell: true, text: 'ADOPT_SOURCE', clientMsgId: 'app-source' };
    socket.send(JSON.stringify(appInput));
    const routed = await wait(() => appEvents.find(e => e.type === 'task_shell_routed'), 'App input did not enter shell');
    assert.equal(routed.sessionId, source.id);
    await wait(async () => (await api(`/api/task-shells/${routed.shellId}/tasks/${routed.taskId}`)).messages.some(m => m.role === 'assistant'), 'adopted source did not finish');
    socket.send(JSON.stringify(appInput));
    await wait(() => appEvents.filter(e => e.type === 'task_shell_routed').length === 2, 'App retry did not acknowledge');
    assert.equal(rows().filter(r => r.sessionId === source.id).length, 1, 'same App message must not execute twice');
    const adopted = await api('/api/task-shells', { sessionId: source.id });
    assert.equal(adopted.defaultTaskId, routed.taskId);
    assert.equal(adopted.tasks[0].adopted, true);
    socket.close(); socket = null;
    if (process.env.MULTICC_SHELL_BROWSER_TEST === '1') {
      const { withCdpHarness } = require('./helpers/cdp-harness');
      const next = await api(`/api/task-shells/${adopted.id}/messages`, { text: 'BROWSER_SECOND_TASK', newTask: true, clientMsgId: 'browser-second' });
      await wait(async () => (await api(`/api/task-shells/${adopted.id}/tasks/${next.taskId}`)).messages.some(m => m.role === 'assistant'), 'browser second task incomplete');
      await withCdpHarness({ timeoutMs: 20000 }, async page => {
        await page.send('Network.setExtraHTTPHeaders', { headers: { Authorization: `Bearer ${token}` } });
        await page.navigate(base + `/chat.html?session=${source.id}`);
        assert.ok(await page.waitFor('typeof shellChatView !== "undefined" && ws?.readyState === 1'), 'full chat did not connect');
        assert.equal(await page.evaluate('_sessionName'), next.sessionId);
        assert.ok(await page.waitFor('document.getElementById("messages").textContent.includes("ADOPT_SOURCE") && document.getElementById("messages").textContent.includes("BROWSER_SECOND_TASK")'), 'old/new history not visible together');
        const thirdBrowser = await api(`/api/task-shells/${adopted.id}/messages`, { text: 'BROWSER_THIRD_TASK', newTask: true, clientMsgId: 'browser-third' });
        await wait(async () => (await api(`/api/task-shells/${adopted.id}/tasks/${thirdBrowser.taskId}`)).messages.some(m => m.role === 'assistant'), 'browser third task incomplete');
        await page.evaluate('inputEl.value = "继续"; send()');
        assert.ok(await page.waitFor(`_sessionName === ${JSON.stringify(thirdBrowser.sessionId)} && ws?.readyState === 1`), 'routed execution did not reconnect');
        assert.equal(await page.evaluate('new URL(location.href).searchParams.get("session")'), source.id);
        assert.ok(await page.waitFor('document.getElementById("messages").textContent.includes("ADOPT_SOURCE") && document.getElementById("messages").textContent.includes("BROWSER_THIRD_TASK")'), 'switch discarded shell history');
        await page.send('Page.reload');
        assert.ok(await page.waitFor(`typeof _sessionName !== "undefined" && _sessionName === ${JSON.stringify(thirdBrowser.sessionId)} && ws?.readyState === 1 && document.getElementById("messages").textContent.includes("BROWSER_THIRD_TASK")`), 'reload did not restore latest history and execution');
        await page.evaluate('loadOlderHistory()');
        assert.ok(await page.waitFor('document.getElementById("messages").textContent.includes("ADOPT_SOURCE")'), 'older source history is missing after reload pagination');
        const originalOwner = await page.evaluate('shellMessageOwner(Array.from(document.querySelectorAll(".msg.user")).find(n => n.textContent.includes("ADOPT_SOURCE")))');
        assert.equal(originalOwner.sessionId, source.id, 'message actions must target the original execution');
        await page.navigate(base + `/chat.html?session=${thirdBrowser.sessionId}`);
        assert.ok(await page.waitFor(`typeof shellChatView !== "undefined" && shellChatView.shellId === ${JSON.stringify(adopted.id)} && ws?.readyState === 1`), 'generated execution URL lost its originating shell');
        await page.evaluate('loadOlderHistory()');
        assert.ok(await page.waitFor('document.getElementById("messages").textContent.includes("ADOPT_SOURCE")'), 'generated execution URL lost original history');
        console.log('PASS full chat browser: stable source URL, internal execution switch, old/new history and reload');
      });
    }
    await stop();
    await start('0');
    const after = await api(`/api/task-shells/${sa.id}`); assert.equal((await api('/api/task-shells/config')).enabled, true); assert.equal(after.tasks.length, 4);
    assert.ok((await api(`/api/task-shells/${sa.id}/tasks/${third.taskId}`)).messages.length >= 2);
    const alwaysOn = await api(`/api/task-shells/${sa.id}/messages`, { text: 'ALWAYS_ON', clientMsgId: 'always-on' });
    await wait(async () => (await api(`/api/task-shells/${sa.id}/tasks/${alwaysOn.taskId}`)).messages.some(m => m.role === 'assistant'), 'permanent task route did not execute');
    console.log('PASS task-shell isolated: explicit concurrent task, stable replay, independent worktree/native identity, formal history, WS guard, multi-source seed, restart/permanent routing');
  } catch (error) { console.error(logs); throw error; }
  finally { socket?.terminate(); if (!fs.existsSync(release)) fs.writeFileSync(release, 'done'); await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

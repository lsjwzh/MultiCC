'use strict';

// Full host / SQLite / scheduler / worktree / fake Codex proof. No live model,
// user history or production service is used or restarted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
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
  async function api(route, body, expected = 200, method = null) {
    const response = await fetch(base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
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
        MULTICC_ENV_FILE: path.join(dataDir, '.env'),
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
    const a = await require('./helpers/legacy-task-session')({ dataDir, dirId: directory.id, id: 'shell-a', stop, start });
    const b = await require('./helpers/legacy-task-session')({ dataDir, dirId: directory.id, id: 'shell-b', stop, start });
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
    assert.equal(detail.task.baseline, null, 'planned task does not preallocate a baseline');
    // Full-history task index: metadata only, conversation order, anchored
    // segments, and a revision that both clients can compare before writing.
    const taskIndex = await api(`/api/task-shells/${sb.id}/task-index`);
    assert.equal(taskIndex.version, 1);
    assert.equal(taskIndex.shellId, sb.id);
    assert.match(taskIndex.scopeRevision, /^[0-9a-f]{8,}$/);
    assert.deepEqual(taskIndex.tasks.map(task => task.taskId), [first.taskId, second.taskId]);
    assert.equal(taskIndex.tasks[0].segments[0].firstMessageRef.sourceSessionId, first.sessionId);
    assert.ok(taskIndex.tasks[1].segments[0].firstMessageRef.sourceMessageId);
    assert.equal(typeof taskIndex.tasks[0].capabilities.canDetach, 'boolean');
    assert.equal(JSON.stringify(taskIndex).includes('HOLD_ORIGINAL'), false, 'index must not leak message bodies');
    const reopened = await api(`/api/task-shells/${sb.id}/task-index`);
    assert.equal(reopened.scopeRevision, taskIndex.scopeRevision);
    // Manual whole-turn re-attribution (P1): the overlay moves a turn without
    // touching the transcript, is idempotent, and can be reverted.
    const originalTurn = taskIndex.tasks[1].segments[0].firstMessageRef;
    const turnId = (await api(`/api/task-shells/${sb.id}/history?historyScope=archive&limit=100`)).messages
      .find(m => m.sourceSessionId === originalTurn.sourceSessionId && m.turnId)?.turnId;
    assert.ok(turnId, 'the second task must expose a turn id');
    const change = { turns: [{ sessionId: originalTurn.sourceSessionId, turnId }], target: { taskId: first.taskId } };
    const changePreview = await api(`/api/task-shells/${sb.id}/task-operations/preview`, change);
    assert.equal(changePreview.changed, 1);
    assert.equal(changePreview.scopeRevision, taskIndex.scopeRevision);
    const applyInput = { ...change, clientMsgId: 'reattribute-1', previewToken: changePreview.previewToken,
      expectedRevision: changePreview.scopeRevision };
    const appliedChange = await api(`/api/task-shells/${sb.id}/task-operations`, applyInput);
    assert.equal(appliedChange.status, 'applied');
    assert.deepEqual(await api(`/api/task-shells/${sb.id}/task-operations`, applyInput), appliedChange, 'replay must be idempotent');
    const moved = await api(`/api/task-shells/${sb.id}/task-index`);
    assert.notEqual(moved.scopeRevision, taskIndex.scopeRevision);
    assert.equal(moved.tasks.find(task => task.taskId === first.taskId).turnCount, 2);
    assert.equal(moved.tasks.find(task => task.taskId === second.taskId)?.turnCount || 0, 0);
    const movedHistory = await api(`/api/task-shells/${sb.id}/history?historyScope=archive&limit=100`);
    const movedMessage = movedHistory.messages.find(message => message.sourceSessionId === originalTurn.sourceSessionId
      && message.turnId === turnId);
    assert.equal(movedMessage.taskId, first.taskId, 'the turn must answer to its new task');
    const withEmpty = await api(`/api/task-shells/${sb.id}/task-index?includeEmpty=1`);
    assert.equal(withEmpty.tasks.find(task => task.taskId === second.taskId).empty, true);
    await assert.rejects(async () => api(`/api/task-shells/${sb.id}/task-operations`,
      { ...change, clientMsgId: 'reattribute-stale', expectedRevision: taskIndex.scopeRevision }),
    /revision|changed/i);
    const undone = await api(`/api/task-operations/${appliedChange.id}/undo`, { clientMsgId: 'undo-1' });
    assert.equal(undone.status, 'reverted');
    // Automatic attribution (P2): the ladder is a host setting, the journal is
    // readable, and a suggestion that was never recorded cannot be accepted.
    const ladder = await api('/api/settings/task-attribution');
    assert.deepEqual(ladder.modes, ['off', 'shadow', 'suggest', 'auto']);
    assert.equal((await api('/api/settings/task-attribution', { mode: 'auto' })).mode, 'auto');
    assert.equal((await api('/api/settings/task-attribution')).mode, 'auto');
    await api('/api/settings/task-attribution', { mode: 'nonsense' }, 400);
    assert.equal((await api('/api/settings/task-attribution', { mode: 'suggest' })).mode, 'suggest');
    const decisions = await api(`/api/task-shells/${sb.id}/attribution-decisions`);
    assert.deepEqual(decisions.decisions, []);
    await api(`/api/task-shells/${sb.id}/attribution-decisions/dec_missing/accept`, { clientMsgId: 'x' }, 404);
    await api(`/api/task-shells/${sb.id}/attribution-decisions/dec_missing/dismiss`, {}, 404);
    const restored = await api(`/api/task-shells/${sb.id}/task-index`);
    assert.equal(restored.scopeRevision, taskIndex.scopeRevision);
    const restoredHistory = await api(`/api/task-shells/${sb.id}/history?historyScope=archive&limit=100`);
    assert.equal(restoredHistory.messages.find(message => message.sourceSessionId === originalTurn.sourceSessionId
      && message.turnId === turnId).taskId, second.taskId);
    // Fork at a message in the middle, through the same API used by chat.html.
    // The copied task annotations must not be adopted as the fork's identity.
    const rawHistory = (await api(`/api/sessions/${second.sessionId}/history?limit=100`)).messages;
    const cut = rawHistory.find(m => m.role === 'user' && m.taskId === second.taskId);
    assert.ok(cut);
    const transcriptFork = await api(`/api/sessions/${second.sessionId}/fork`, { atMessageId: cut.id, includeMemory: false });
    const forkShell = await api('/api/task-shells', { sessionId: transcriptFork.sessionId });
    assert.notEqual(forkShell.currentTaskId, second.taskId);
    assert.equal((await api(`/api/task-shells/${forkShell.id}/chat`)).activeSessionId, transcriptFork.sessionId);
    const copied = (await api(`/api/task-shells/${forkShell.id}/history?limit=100`)).messages;
    const inheritedCut = copied.find(m => m.sourceMessageId === cut.id);
    assert.equal(inheritedCut.inherited, true);
    assert.equal(inheritedCut.taskId, undefined);
    assert.equal(inheritedCut.inheritedFrom.taskId, second.taskId);
    assert.equal(copied.some(m => m.role === 'assistant'), false, 'messages after the fork point are excluded');
    assert.equal((await api(`/api/task-shells/${sb.id}/chat`)).activeSessionId, second.sessionId);
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
    // Board preview preserves ownership. A manual fork owns a new real worktree
    // at the source commit and retains history without executing on creation.
    const preview = await api(`/api/task-shell-tasks/${first.taskId}`);
    assert.equal(preview.readOnly, false);
    const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.writeFileSync(path.join(recordA.worktreePath, 'fork-evidence'), 'source-only');
    gitAt(recordA.worktreePath, 'add', 'fork-evidence');
    gitAt(recordA.worktreePath, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', 'fork source evidence');
    const sourceCommit = gitAt(recordA.worktreePath, 'rev-parse', 'HEAD');
    const forkInput = { clientMsgId: 'isolated-fork' };
    const fork = await api(`/api/task-shell-tasks/${first.taskId}/fork`, forkInput);
    assert.deepEqual(await api(`/api/task-shell-tasks/${first.taskId}/fork`, forkInput), fork);
    const forkRecord = readJson(paths.sessionsFile, { legacyIsArray: true }).data.find(r => r.id === fork.sessionId);
    assert.notEqual(forkRecord.worktreePath, recordA.worktreePath);
    assert.ok(!forkRecord.workspaceOwnerSessionId);
    assert.equal(forkRecord.workspaceState, 'planned');
    assert.equal(forkRecord.workspaceBaseCommit, sourceCommit);
    assert.equal(fs.existsSync(forkRecord.worktreePath), false, 'fork records do not eagerly create a worktree');
    assert.equal(rows().some(r => r.sessionId === fork.sessionId), false);
    const forkEntry = await api(`/api/task-shell-tasks/${fork.taskId}`);
    assert.equal(forkEntry.readOnly, false);
    assert.ok(forkEntry.messages.some(m => m.inherited && m.role === 'assistant'));
    assert.equal((await api(`/api/task-shells/${sa.id}`)).currentTaskId, first.taskId);
    await api(`/api/task-shell-tasks/${fork.taskId}/messages`, { text: 'FORK_CONTINUE', clientMsgId: 'fork-continue', intent: 'work' });
    await wait(() => rows().some(r => r.sessionId === fork.sessionId), 'fork execution missing');
    assert.equal(fs.realpathSync(rows().find(r => r.sessionId === fork.sessionId).cwd), fs.realpathSync(forkRecord.worktreePath));
    assert.equal(gitAt(forkRecord.worktreePath, 'rev-parse', 'HEAD'), sourceCommit);
    assert.equal(fs.readFileSync(path.join(forkRecord.worktreePath, 'fork-evidence'), 'utf8'), 'source-only');
    const protectedMerge = await api(`/api/task-board/tasks/${first.taskId}/merge-tasks`, { sourceTaskIds: [second.taskId] }, 409);
    assert.equal(protectedMerge.error, 'task_shell_identity_immutable');
    // Freeze two sources as references in a fresh task. This is sharing, not a merge.
    await api(`/api/task-shells/${sa.id}/links`, { taskId: second.taskId });
    const third = await api(`/api/task-shells/${sa.id}/messages`, { text: 'USE_BOTH_CONTEXTS', newTask: true, clientMsgId: 'three', intent: 'work', contextTaskIds: [first.taskId, second.taskId] });
    await wait(() => rows().some(r => r.sessionId === third.sessionId), 'reference execution missing');
    assert.notEqual(fs.realpathSync(rows().find(r => r.sessionId === third.sessionId).cwd), fs.realpathSync(recordA.worktreePath));
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
    const source = await require('./helpers/legacy-task-session')({ dataDir, dirId: directory.id, id: 'existing-conversation', stop, start });
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
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errs||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errs||=[]).push(String(e.reason)))` });
        await page.navigate(base + `/chat.html?session=${source.id}`);
        assert.ok(await page.waitFor(`location.pathname === '/air' && new URLSearchParams(location.search).get('task') === ${JSON.stringify(next.taskId)}`));
        // 消息容器在 task-first 聊天页里是 #messages；#history 只存在于退役的
        // task-shell.html，拿它等内容会永远等到空。
        const history = `document.getElementById('conversation')?.contentDocument?.getElementById('messages')?.textContent`;
        const shown = await page.waitFor(`${history}?.includes('BROWSER_SECOND_TASK')`);
        assert.ok(shown);
        // 任务壳的对话是跨任务连续的：同一壳里前一任务的 ADOPT_SOURCE 也在这份
        // 合并历史里（chat-shell-entry 走 /api/task-shells/:id/history），旧断言
        // 「只显示本任务历史」是 task-shell.html 时代的隔离语义，已被壳合并取代。
        assert.equal(await page.evaluate(`${history}.includes('ADOPT_SOURCE')`), true, 'shell conversation keeps cross-task continuity');
        await page.send('Page.reload');
        assert.ok(await page.waitFor(`${history}?.includes('BROWSER_SECOND_TASK')`));
        await page.navigate(base + `/air?task=${routed.taskId}`);
        assert.ok(await page.waitFor(`${history}?.includes('ADOPT_SOURCE')`));
        console.log('PASS task browser: legacy bookmarks resolve to Air, shell history stays continuous and survives reload');
      });
    }
    await wait(async () => !(await api(`/api/task-shell-tasks/${fork.taskId}`)).execution.busy, 'fork remains busy before lifecycle checks');
    await api(`/api/task-board/tasks/${fork.taskId}/status`, { status: 'archived' });
    const archivedEntry = await api(`/api/task-shell-tasks/${fork.taskId}`);
    assert.equal(archivedEntry.status, 'archived'); assert.equal(archivedEntry.readOnly, true);
    await api(`/api/task-shell-tasks/${fork.taskId}/messages`, { text: 'must reject', clientMsgId: 'archived-send' }, 409);
    await api(`/api/task-board/tasks/${fork.taskId}/status`, { status: 'active' });
    const refusedDelete = await api(`/api/task-board/tasks/${fork.taskId}`, undefined, 409, 'DELETE');
    assert.equal(refusedDelete.error, 'task_workspace_unmerged');
    assert.equal((await api(`/api/task-shell-tasks/${fork.taskId}`)).readOnly, false, 'preflight refusal leaves task usable');
    assert.ok((await api(`/api/task-shell-tasks/${fork.taskId}`)).messages.length > 0, 'preflight preserves history');
    gitAt(project, 'merge', '--ff-only', sourceCommit);
    await api(`/api/task-board/tasks/${fork.taskId}`, undefined, 200, 'DELETE');
    await api(`/api/task-shell-tasks/${fork.taskId}`, undefined, 404);
    await api(`/api/sessions/${fork.sessionId}`, undefined, 404);
    assert.equal(fs.existsSync(forkRecord.worktreePath), false, 'dedicated task worktree is disposed');
    await stop();
    await start('0');
    await api(`/api/task-shell-tasks/${fork.taskId}`, undefined, 404);
    const after = await api(`/api/task-shells/${sa.id}`); assert.equal((await api('/api/task-shells/config')).enabled, true); assert.equal(after.tasks.length, 4);
    assert.ok((await api(`/api/task-shells/${sa.id}/tasks/${third.taskId}`)).messages.length >= 2);
    const alwaysOn = await api(`/api/task-shells/${sa.id}/messages`, { text: 'ALWAYS_ON', clientMsgId: 'always-on' });
    await wait(async () => (await api(`/api/task-shells/${sa.id}/tasks/${alwaysOn.taskId}`)).messages.some(m => m.role === 'assistant'), 'permanent task route did not execute');
    console.log('PASS task-shell isolated: explicit concurrent task, stable replay, independent worktree/native identity, formal history, WS guard, multi-source seed, restart/permanent routing');
  } catch (error) { console.error(logs); throw error; }
  finally { socket?.terminate(); if (!fs.existsSync(release)) fs.writeFileSync(release, 'done'); await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

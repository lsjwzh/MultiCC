'use strict';

// Task-shell semantic context isolation + on-demand supplementary context, driven
// through the REAL production path: a fake Codex CLI acts as a minimal MCP client
// that spawns the real scripts/multicc-router-mcp.js over stdio and issues a genuine
// tools/call get_task_context. The server therefore observes an actual tool call
// reaching refillContext (not merely a prompt hint). No live model, user history or
// production service is used or restarted; everything runs against a temp data dir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createPaths, assertTestDir } = require('../src/paths');
const { readJson } = require('../src/state/store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-ctx-'));
const dataDir = assertTestDir(path.join(root, 'data'));
const project = path.join(root, 'project');
const project2 = path.join(root, 'project2');
const fake = path.join(root, 'fake-codex.js');
const mcpScript = path.join(__dirname, '..', 'scripts', 'multicc-router-mcp.js');
const invocations = path.join(root, 'invocations.jsonl');
const mcpCalls = path.join(root, 'mcp-calls.jsonl');
const nativeDir = path.join(root, 'native');
const release2 = path.join(root, 'release2');
fs.mkdirSync(project); fs.mkdirSync(project2); fs.mkdirSync(dataDir); fs.mkdirSync(nativeDir);

const testHome = path.join(root, 'home'), preload = path.join(root, 'home.cjs');
fs.mkdirSync(testHome);
fs.writeFileSync(preload, 'require("node:os").homedir = () => ' + JSON.stringify(testHome) + ';');

// Fixed nonces keep the run deterministic: task A always answers 4271, task B 8899.
// The fake CLI is a stand-in for the model: it calls get_task_context ONLY when the
// answer depends on another task (mirroring renderLazyContextPrompt's contract), and
// answers from its own native session memory otherwise.
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const MCP_SCRIPT = ${JSON.stringify(mcpScript)};
const INVOCATIONS = ${JSON.stringify(invocations)};
const MCP_CALLS = ${JSON.stringify(mcpCalls)};
const NATIVE_DIR = ${JSON.stringify(nativeDir)};
const RELEASE2 = ${JSON.stringify(release2)};
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const prompt = args.at(-1) || '';
const sessionId = process.env.MULTICC_SESSION_ID || 'unknown';
const nativeId = 'fake-' + sessionId;
const sessionsDir = path.join(process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'), 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(path.join(sessionsDir, 'rollout-' + nativeId + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: process.cwd() } }) + '\\n');
const nativeFile = path.join(NATIVE_DIR, 'native-' + String(sessionId).replace(/[^\\w.-]/g, '_') + '.jsonl');
function loadMemory() {
  try { return fs.readFileSync(nativeFile, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse).map(r => r.text); }
  catch (_) { return []; }
}
function remember(text) { fs.mkdirSync(NATIVE_DIR, { recursive: true }); fs.appendFileSync(nativeFile, JSON.stringify({ text }) + '\\n'); }
function extract(text, marker) {
  const key = '任务' + marker + '的随机数字是';
  const i = String(text).indexOf(key);
  if (i < 0) return null;
  const m = String(text).slice(i + key.length).match(/[0-9]+/);
  return m ? m[0] : null;
}
fs.appendFileSync(INVOCATIONS, JSON.stringify({ sessionId, cwd: process.cwd(), prompt }) + '\\n');
function emit(o) { console.log(JSON.stringify(o)); }
// Minimal protocol-level MCP client: speak JSON-RPC 2.0 to the REAL router MCP server.
function callGetTaskContext() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout });
    let answered = false;
    const timer = setTimeout(() => { if (!answered) { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('mcp_timeout')); } }, 20000);
    rl.on('line', line => {
      let m; try { m = JSON.parse(line); } catch (_) { return; }
      if (m.id === 1 && m.result) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_context', arguments: {} } }) + '\\n');
      } else if (m.id === 2) {
        answered = true; clearTimeout(timer);
        const sc = m.result && m.result.structuredContent;
        try { rl.close(); } catch (_) {}
        try { child.kill('SIGKILL'); } catch (_) {}
        resolve(sc || null);
      }
    });
    child.on('error', e => { if (!answered) { clearTimeout(timer); reject(e); } });
    child.on('close', () => { if (!answered) { clearTimeout(timer); reject(new Error('mcp_closed_early')); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-cli', version: '0.0.1' } } }) + '\\n');
  });
}
async function main() {
  emit({ type: 'thread.started', thread_id: 'fake-' + sessionId });
  const memory = loadMemory().join('\\n');
  let answer, mcpResult = null, marker = '';
  if (prompt.includes('HOLD_UPDATE')) {
    while (!fs.existsSync(RELEASE2)) await new Promise(r => setTimeout(r, 100));
    answer = '任务A后台处理完成 HOLD_DONE';
  } else if (prompt.includes('回复任务A')) {
    answer = '任务A的随机数字是 4271';
  } else if (prompt.includes('回复任务B')) {
    answer = '任务B的随机数字是 8899';
  } else if (prompt.includes('你自己的数字')) {
    marker = (prompt.match(/任务([ABZ])/) || [])[1] || '';
    const n = extract(memory, marker);
    answer = n ? ('任务' + marker + '自己的数字是 ' + n) : ('未找到任务' + marker + '的本会话上下文');
  } else if (prompt.includes('给你回复的数字')) {
    marker = (prompt.match(/任务([ABZ])/) || [])[1] || '';
    mcpResult = await callGetTaskContext();
    const ctx = (mcpResult && mcpResult.context) || '';
    fs.appendFileSync(MCP_CALLS, JSON.stringify({ sessionId, marker, prompt, taskIds: (mcpResult && mcpResult.task_ids) || [], ok: !!(mcpResult && mcpResult.ok), context: ctx }) + '\\n');
    const n = extract(ctx, marker);
    answer = n ? ('任务' + marker + '回复的数字是 ' + n) : ('未找到任务' + marker + '的上下文，安全失败');
  } else {
    answer = 'SHELL_OK';
  }
  remember(answer);
  emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
`);
fs.chmodSync(fake, 0o755);

async function wait(check, label, count = 400) {
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
const calls = () => fs.existsSync(mcpCalls) ? fs.readFileSync(mcpCalls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  let server, logs = '', base;
  const token = 'task-shell-context-isolation';
  async function api(route, body, expected = 200) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: token,
        NODE_OPTIONS: '--require ' + preload, MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS: '0', MULTICC_DATA_DIR: dataDir, MULTICC_MEMORY_ROOT: path.join(dataDir, 'memories'), MULTICC_TASK_SHELLS: enabled,
        MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100', CODEX_CMD: fake,
        CLAUDE_CMD: path.join(root, 'missing-claude'), OPENCODE_CMD: path.join(root, 'missing-opencode'), QODER_CMD: path.join(root, 'missing-qoder'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', c => { logs = (logs + c).slice(-40000); });
    server.stderr.on('data', c => { logs = (logs + c).slice(-40000); });
    await wait(async () => { try { return (await fetch(base + '/readyz')).ok; } catch (_) { return false; } }, 'server readiness', 500);
  }
  // Find the assistant answer text for a task from its formal shell history.
  async function answerOf(shellId, taskId, needle) {
    const detail = await api(`/api/task-shells/${shellId}/tasks/${taskId}`);
    const hit = detail.messages.find(m => m.role === 'assistant' && String(m.content).includes(needle));
    return hit ? String(hit.content) : null;
  }
  async function receiptOf(shellId, clientMsgId) {
    const view = await api(`/api/task-shells/${shellId}`);
    return view.receipts.find(r => r.clientMsgId === clientMsgId) || null;
  }
  try {
    await start();
    const dir1 = await api('/api/directories', { name: 'Ctx isolation', path: project, create: true });
    const source = await api(`/api/directories/${dir1.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Source S' });
    const sa = await api('/api/task-shells', { sessionId: source.id });

    // ---- Phase 1: task A setup (continues the adopted source task, runs in session S) ----
    const msg1 = await api(`/api/task-shells/${sa.id}/messages`, { text: '你现在是任务A，请回复任务A+一个随机数字', clientMsgId: 'setup-a', intent: 'work' });
    const TA = { id: msg1.taskId, sessionId: msg1.sessionId };
    await wait(() => rows().some(r => r.sessionId === TA.sessionId && r.prompt.includes('回复任务A')), 'task A execution did not start');
    await wait(() => answerOf(sa.id, TA.id, '4271'), 'task A answer missing');
    assert.equal(TA.sessionId, source.id, 'adopted task A must run in the source session');
    console.log(`[case A] task A id=${TA.id} session=${TA.sessionId} answer=4271`);

    // ---- Phase 2: task B setup (explicit new task -> isolated native execution in the shell worktree) ----
    const msg2 = await api(`/api/task-shells/${sa.id}/messages`, { text: '你现在是任务B，请回复任务B+一个随机数字', newTask: true, clientMsgId: 'setup-b', intent: 'work' });
    const TB = { id: msg2.taskId, sessionId: msg2.sessionId };
    assert.equal(msg2.decision, 'new');
    assert.notEqual(TB.id, TA.id); assert.notEqual(TB.sessionId, TA.sessionId);
    await wait(() => rows().some(r => r.sessionId === TB.sessionId && r.prompt.includes('回复任务B')), 'task B execution did not start');
    await wait(() => answerOf(sa.id, TB.id, '8899'), 'task B answer missing');
    // Native isolation: one shell worktree + distinct native CLI session ids.
    const paths = createPaths({ dataDir });
    const sessions = readJson(paths.sessionsFile, { legacyIsArray: true }).data;
    const recA = sessions.find(s => s.id === TA.sessionId), recB = sessions.find(s => s.id === TB.sessionId);
    assert.ok(recA && recB, 'both execution sessions must be persisted');
    assert.equal(recA.worktreePath, recB.worktreePath, 'tasks in the same shell share its worktree');
    assert.equal(recB.workspaceOwnerSessionId, source.id);
    assert.notEqual(recA.cliSessionId, recB.cliSessionId, 'A and B must have isolated native CLI sessions');
    console.log(`[case B] task B id=${TB.id} session=${TB.sessionId} answer=8899; shared worktree, isolated native histories`);

    // ---- Phase 3: CORE ask-A from task B -> requirements (1)(2)(3) ----
    const msg3Body = { text: '任务A给你回复的数字是啥', clientMsgId: 'ask-a', intent: 'work' };
    const msg3 = await api(`/api/task-shells/${sa.id}/messages`, msg3Body);
    assert.equal(msg3.taskId, TB.id, 'ask-A continues the current task B execution');
    assert.equal(msg3.sessionId, TB.sessionId);
    const askRow = await wait(() => rows().find(r => r.sessionId === TB.sessionId && r.prompt.includes('任务A给你回复的数字')), 'ask-A turn did not start');
    // Requirement (1): the initial context entering task B's execution must NOT carry A's secret.
    assert.ok(!askRow.prompt.includes('4271'), 'initial ask-A prompt must not contain task A nonce');
    assert.ok(!askRow.prompt.includes(TA.id), 'initial ask-A prompt must not contain task A id/conversation');
    assert.match(askRow.prompt, /get_task_context/, 'initial context must carry the lazy-context instruction naming get_task_context');
    // Requirement (2): the model MUST issue a real get_task_context MCP call referencing task A.
    const askCall = await wait(() => calls().find(c => c.sessionId === TB.sessionId && c.marker === 'A'), 'no real get_task_context MCP call observed');
    assert.equal(askCall.ok, true, 'get_task_context must succeed');
    assert.ok(askCall.taskIds.includes(TA.id), `refill must return task A context, got ${JSON.stringify(askCall.taskIds)}`);
    assert.ok(askCall.context.includes('4271'), 'refilled context must contain task A nonce');
    const askReceipt = await wait(async () => { const r = await receiptOf(sa.id, 'ask-a'); return r && r.status === 'accepted' && r; }, 'ask-A receipt not accepted');
    assert.equal(askReceipt.contextSavings && askReceipt.contextSavings.contextRefilled, true, 'server must record contextRefilled on the ask-A receipt');
    // Requirement (3): the answer restores task A's number, not task B's.
    const askAnswer = await wait(() => answerOf(sa.id, TB.id, '任务A回复的数字是'), 'ask-A answer missing');
    assert.ok(askAnswer.includes('4271'), 'answer must restore task A nonce 4271');
    assert.ok(!askAnswer.includes('8899'), 'answer must NOT be task B nonce 8899');
    console.log(`[case CORE] req1 no-leak OK; req2 real MCP refill task_ids=${JSON.stringify(askCall.taskIds)} contextRefilled=true; req3 answer="${askAnswer}"`);

    // ---- Phase 4: continue asking B's OWN number -> must NOT refill ----
    const callsBefore = calls().length;
    const msg4 = await api(`/api/task-shells/${sa.id}/messages`, { text: '任务B你自己的数字是啥', taskId: TB.id, clientMsgId: 'ask-b', intent: 'work' });
    assert.equal(msg4.taskId, TB.id);
    const ownAnswer = await wait(() => answerOf(sa.id, TB.id, '任务B自己的数字是'), 'ask-B own answer missing');
    assert.ok(ownAnswer.includes('8899'), 'B own answer must be 8899 from native context');
    assert.ok(!ownAnswer.includes('4271'), 'B own answer must not pull task A nonce');
    assert.equal(calls().length, callsBefore, 'answering B from its own context must NOT call get_task_context');
    const askBReceipt = await wait(async () => { const r = await receiptOf(sa.id, 'ask-b'); return r && r.status === 'accepted' && r; }, 'ask-B receipt not accepted');
    assert.notEqual(askBReceipt.contextSavings && askBReceipt.contextSavings.contextRefilled, true, 'ask-B receipt must not be marked refilled');
    console.log('[case b] ask-B own number answered from native context, zero MCP refill');

    // ---- Phase 5: explicit continue from task A's link -> back to A identity, no B carried ----
    await api(`/api/task-shells/${sa.id}/tasks/resolve`, { taskId: TA.id });
    const msg5 = await api(`/api/task-shells/${sa.id}/messages`, { text: '任务A你自己的数字是啥', taskId: TA.id, clientMsgId: 'ask-a-own', intent: 'work' });
    assert.equal(msg5.taskId, TA.id); assert.equal(msg5.sessionId, TA.sessionId, 'explicit A link must run in A execution identity');
    const aOwnAnswer = await wait(() => answerOf(sa.id, TA.id, '任务A自己的数字是'), 'A own answer missing');
    assert.ok(aOwnAnswer.includes('4271'), 'A own answer must be 4271');
    assert.ok(!aOwnAnswer.includes('8899'), 'A execution must not carry task B nonce');
    console.log(`[case d] explicit A-link continue ran in session=${msg5.sessionId} answer="${aOwnAnswer}"`);

    // ---- Phase 6: same clientMsgId replay -> execute/refill only once ----
    const aCallsBefore = calls().filter(c => c.sessionId === TB.sessionId && c.marker === 'A').length;
    const aRowsBefore = rows().filter(r => r.sessionId === TB.sessionId && r.prompt.includes('任务A给你回复的数字')).length;
    const replay = await api(`/api/task-shells/${sa.id}/messages`, msg3Body);
    assert.deepEqual(replay, msg3, 'replay of same clientMsgId must return the identical receipt result');
    await new Promise(r => setTimeout(r, 600));
    assert.equal(calls().filter(c => c.sessionId === TB.sessionId && c.marker === 'A').length, aCallsBefore, 'replay must not trigger another MCP refill');
    assert.equal(rows().filter(r => r.sessionId === TB.sessionId && r.prompt.includes('任务A给你回复的数字')).length, aRowsBefore, 'replay must not re-execute the turn');
    console.log('[case e] clientMsgId replay idempotent: no second execution, no second refill');

    // ---- Phase 7: ask a nonexistent/unlinked task Z -> no leak, safe failure ----
    await api(`/api/task-shells/${sa.id}/tasks/resolve`, { taskId: TB.id });
    const msg7 = await api(`/api/task-shells/${sa.id}/messages`, { text: '任务Z给你回复的数字是啥', taskId: TB.id, clientMsgId: 'ask-z', intent: 'work' });
    assert.equal(msg7.taskId, TB.id);
    const zCall = await wait(() => calls().find(c => c.sessionId === TB.sessionId && c.marker === 'Z'), 'ask-Z did not attempt get_task_context');
    const zAnswer = await wait(() => answerOf(sa.id, TB.id, '未找到任务Z'), 'ask-Z safe-failure answer missing');
    assert.ok(!zAnswer.includes('4271') && !zAnswer.includes('8899'), 'safe failure must not leak any real nonce');
    assert.ok(zCall.context.includes('4271'), 'refill still returned A context, yet the answer must not fabricate Z');
    console.log(`[case c] ask-Z safe-failure answer="${zAnswer}" (no nonce leaked)`);

    // ---- Phase 8: wrong taskId / cross-project reference fail closed ----
    const dir2 = await api('/api/directories', { name: 'Other project', path: project2, create: true });
    const source2 = await api(`/api/directories/${dir2.id}/sessions`, { cli: 'codex', kind: 'chat', label: 'Source S2' });
    const sb = await api('/api/task-shells', { sessionId: source2.id });
    const other = await api(`/api/task-shells/${sb.id}/messages`, { text: '你现在是任务C，请回复任务C+一个随机数字', newTask: true, clientMsgId: 'setup-c', intent: 'work' });
    const TC2 = { id: other.taskId, sessionId: other.sessionId };
    // Task C only needs to EXIST under dir2 to prove cross-project fail-closed; its
    // execution is irrelevant here, so do not depend on the CLI spawning for it.
    await wait(async () => (await api(`/api/task-shells/${sb.id}/tasks/${TC2.id}`)).task.id === TC2.id, 'task C record missing');
    const xp = await api(`/api/task-shells/${sa.id}/messages`, { text: 'cross project probe', taskId: TC2.id, clientMsgId: 'cross-project', intent: 'work' }, 403);
    assert.equal(xp.code, 'project_mismatch', 'cross-project taskId must fail closed with project_mismatch');
    const nf = await api(`/api/task-shells/${sa.id}/messages`, { text: 'missing task probe', taskId: 'tsk_doesnotexist0000000000000000', clientMsgId: 'missing-task', intent: 'work' }, 404);
    assert.equal(nf.code, 'task_not_found', 'unknown taskId must fail closed with task_not_found');
    console.log(`[case h] cross-project -> 403 ${xp.code}; unknown task -> 404 ${nf.code}`);

    // ---- Phase 9: concurrency -> a sibling task must NOT borrow an unfinished turn ----
    await api(`/api/task-shells/${sa.id}/tasks/resolve`, { taskId: TA.id });
    const holdBody = { text: 'HOLD_UPDATE 任务A后台处理中', taskId: TA.id, clientMsgId: 'hold-a', intent: 'work' };
    await api(`/api/task-shells/${sa.id}/messages`, holdBody);
    await wait(() => rows().some(r => r.sessionId === TA.sessionId && r.prompt.includes('HOLD_UPDATE')), 'held A turn did not start');
    const conc = await api(`/api/task-shells/${sa.id}/messages`, { text: '任务A给你回复的数字是啥', newTask: true, clientMsgId: 'conc-ask-a', intent: 'work' });
    const TD = { id: conc.taskId, sessionId: conc.sessionId };
    await new Promise(r => setTimeout(r, 600));
    assert.equal(rows().some(r => r.sessionId === TD.sessionId), false, 'same-workspace execution must wait for A');
    fs.writeFileSync(release2, 'done');
    await wait(() => answerOf(sa.id, TA.id, 'HOLD_DONE'), 'held A turn never completed');
    const concCall = await wait(() => calls().find(c => c.sessionId === TD.sessionId && c.marker === 'A'), 'concurrent ask-A did not refill');
    assert.ok(concCall.context.includes('4271'), 'concurrent refill must see task A COMPLETED nonce');

    const concAnswer = await wait(() => answerOf(sa.id, TD.id, '任务A回复的数字是'), 'concurrent ask-A answer missing');
    assert.ok(concAnswer.includes('4271') && !concAnswer.includes('8899'), 'concurrent answer must be A nonce only');
    fs.writeFileSync(release2, 'done');
    await wait(() => answerOf(sa.id, TA.id, 'HOLD_DONE'), 'held A turn never completed');
    console.log(`[case g] concurrent task ${TD.id} refilled A completed context (4271) after waiting for the shared workspace`);

    // ---- Phase 10: restart -> isolation + lazy refill still hold ----
    await stop();
    await start('1');
    assert.equal((await api('/api/task-shells/config')).enabled, true);
    const reopened = await api('/api/task-shells', { sessionId: source.id });
    assert.equal(reopened.id, sa.id, 'shell identity must survive restart');
    const taskIds = reopened.tasks.map(t => t.id);
    assert.ok(taskIds.includes(TA.id) && taskIds.includes(TB.id), 'A and B must persist across restart');
    await api(`/api/task-shells/${sa.id}/tasks/resolve`, { taskId: TB.id });
    const post = await api(`/api/task-shells/${sa.id}/messages`, { text: '重启后：任务A给你回复的数字是啥', taskId: TB.id, clientMsgId: 'post-restart-ask-a', intent: 'work' });
    assert.equal(post.sessionId, TB.sessionId);
    const postCall = await wait(() => calls().find(c => c.sessionId === TB.sessionId && c.marker === 'A' && c.prompt && c.prompt.includes('重启后')), 'post-restart refill missing');
    assert.ok(postCall.taskIds.includes(TA.id), 'post-restart refill must still return task A');
    assert.ok(postCall.context.includes('4271'), 'post-restart refilled context must contain task A nonce');
    const postReceipt = await wait(async () => { const r = await receiptOf(sa.id, 'post-restart-ask-a'); return r && r.status === 'accepted' && r; }, 'post-restart receipt not accepted');
    assert.equal(postReceipt.contextSavings && postReceipt.contextSavings.contextRefilled, true, 'post-restart refill must be recorded');
    const postAnswer = await wait(() => answerOf(sa.id, TB.id, '任务A回复的数字是 4271'), 'post-restart answer missing');
    assert.ok(postAnswer.includes('4271'), 'post-restart answer must restore A nonce');
    const sessions2 = readJson(paths.sessionsFile, { legacyIsArray: true }).data;
    const recA2 = sessions2.find(s => s.id === TA.sessionId), recB2 = sessions2.find(s => s.id === TB.sessionId);
    assert.equal(recA2.worktreePath, recB2.worktreePath, 'shell workspace ownership must survive restart');
    console.log('[case f] post-restart: shell identity, A/B isolation and lazy refill all hold');

    console.log('PASS task-shell context isolation: real get_task_context MCP refill, no initial leak, correct A nonce, B-own no-refill, A-link identity, replay idempotency, safe-failure, cross-project/unknown fail-closed, concurrency no-borrow, restart persistence');
  } catch (error) { console.error(logs); throw error; }
  finally { if (!fs.existsSync(release2)) fs.writeFileSync(release2, 'done'); await stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

'use strict';

// M2 · chat.html?task=<id> host mode (docs/chat-view-unification-design.md §3-M2).
// The task transcript adapter: bootstrap (task DTO + M0 first page), the dir
// workspace WS consumption (M1 task_run_stream envelopes, unwrapped and fed to
// the same event controller), the POST send/cancel transport, older-page URLs,
// run separators and the reconnect reconcile. Headless: every host port is
// injected, timers included.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTaskMode } = require('../public/chat-task-mode');

function fakeClock() {
  const timers = new Map();
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq; },
    clearTimeoutFn: id => timers.delete(id),
    pending: () => [...timers.values()],
    runOne: () => { const first = timers.entries().next().value; if (!first) return null; timers.delete(first[0]); first[1].fn(); return first[1]; },
  };
}

// A fetch stub routed by URL substring. Responders return [status, body].
function fetchStub(routes, calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) {
        const [status, body] = typeof responder === 'function' ? responder(init) : responder;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        };
      }
    }
    throw new Error('unstubbed url: ' + url);
  };
}

function harness({ task = null } = {}) {
  const clock = fakeClock();
  const calls = { system: [], separators: [], identity: [], status: [], events: [], wsOpen: [], clis: [] };
  const taskDto = task || {
    id: 'tsk-1', title: '重构登录页', status: 'active',
    dirIds: ['dir-9'], runState: 'running',
    runs: [
      { runId: 'tr_1', executionStatus: 'succeeded', startedAt: 100, terminalAt: 190 },
      { runId: 'tr_2', executionStatus: 'running', startedAt: 300, terminalAt: null },
    ],
  };
  const firstPage = {
    messages: [
      { id: 'm1', role: 'user', content: '第一次', ts: 10, taskRunId: 'tr_1' },
      { id: 'm2', role: 'assistant', content: '第一次回复', ts: 20, taskRunId: 'tr_1' },
      { id: 'm3', role: 'user', content: '第二次', ts: 30, taskRunId: 'tr_2', clientMsgId: 'c-3' },
    ],
    hasMore: false,
  };
  const sockets = [];
  const WebSocketCtor = class {
    constructor(url) { this.url = url; sockets.push(this); this.sent = []; }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
  };
  const storePlan = [];
  const deps = {
    taskId: 'tsk-1',
    window: { location: { protocol: 'https:', host: 'multicc.test' } },
    fetch: fetchStub([
      ['/api/task-board/tasks/tsk-1?', [200, { ok: true, task: taskDto }]],
      ['/api/task-board/tasks/tsk-1/messages', [200, firstPage]],
      ['/api/task-board/tasks/tsk-1/send', [200, { ok: true, taskRunId: 'tr_3' }]],
      ['/api/task-board/tasks/tsk-1/cancel-run', [200, { ok: true, cancelled: true }]],
    ], calls.fetch = []),
    withToken: url => url,
    multiccWsUrl: async url => url + '&ticket=once',
    WebSocket: WebSocketCtor,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    addSystemMsg: text => calls.system.push(text),
    renderRunSeparator: info => calls.separators.push(info),
    updateTaskIdentity: dto => calls.identity.push(dto),
    statusUpdate: (text, kind) => calls.status.push([text, kind]),
    setWs: socket => calls.wsOpen.push(socket),
    applyHistoryPlan: plan => storePlan.push(plan),
    historyStore: { acceptHistory: page => ({ mode: 'initial', ...page }) },
    resetHistoryView: () => calls.system.push('::reset-view'),
    handleEvent: (event, generation) => calls.events.push({ event, generation }),
    setCli: cli => calls.clis.push(cli),
    getGeneration: () => 7,
    debug: () => {},
    reconnectDelayMs: () => 0,
  };
  const mode = createTaskMode(deps);
  return { mode, calls, clock, sockets, storePlan, deps, taskDto };
}

test('boot loads the task DTO + first transcript page and subscribes to the dir workspace WS', async () => {
  const { mode, calls, sockets, storePlan } = harness();
  await mode.boot();
  // Identity callback got the task DTO (host renders title/badge from it).
  assert.equal(calls.identity.length, 1);
  assert.equal(calls.identity[0].title, '重构登录页');
  // First page fed through the shared history-store → applyHistoryPlan pipeline.
  assert.equal(storePlan.length, 1);
  assert.deepEqual(storePlan[0].messages.map(m => m.id), ['m1', 'm2', 'm3']);
  // Initial separators: one per run boundary (run 2 starts at m3).
  assert.deepEqual(calls.separators.map(s => s.runId), ['tr_1', 'tr_2']);
  assert.deepEqual(calls.separators[1], {
    runId: 'tr_2', n: 2, beforeMessageId: 'm3', status: 'running', startedAt: 300,
  });
  // Dir WS: workspace endpoint with the task's dirId, ticket attached.
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://multicc.test/ws/workspace?dirId=dir-9&ticket=once');
  sockets[0].onopen();
  assert.deepEqual(calls.status.at(-1), ['Connected', 'connected']);
  assert.ok(calls.wsOpen.at(-1) instanceof Object);
});

test('task_run_stream envelopes are unwrapped, run-scoped and fed to the shared event controller', async () => {
  const { mode, calls, sockets } = harness();
  await mode.boot();
  sockets[0].onopen();
  mode.handleWorkspaceMessage({ type: 'task_run_stream', taskId: 'tsk-1', runId: 'tr_2', dirId: 'dir-9', slotEvent: { type: 'part_delta', text: 'hi' } });
  mode.handleWorkspaceMessage({
    type: 'task_run_stream', taskId: 'tsk-1', runId: 'tr_2', dirId: 'dir-9',
    slotEvents: [{ type: 'part_delta', text: 'a' }, { type: 'result', text: 'done' }],
  });
  // Same-task envelopes only; other tasks and noise never reach the pipeline.
  mode.handleWorkspaceMessage({ type: 'task_run_stream', taskId: 'tsk-other', runId: 'tr_9', slotEvent: { type: 'part_delta', text: 'x' } });
  mode.handleWorkspaceMessage({ type: 'status', sessionId: 'slot-1', status: 'running' });
  assert.deepEqual(calls.events.map(e => e.event), [
    { type: 'part_delta', text: 'hi' },
    { type: 'part_delta', text: 'a' },
    { type: 'result', text: 'done' },
  ]);
  assert.ok(calls.events.every(e => e.generation === 7));
  // No separator churn: the run id matches the last rendered run.
  assert.equal(calls.separators.length, 2);
});

test('a new run id in the stream inserts a run separator before its first event', async () => {
  const { mode, calls, sockets } = harness();
  await mode.boot();
  sockets[0].onopen();
  mode.handleWorkspaceMessage({ type: 'task_run_stream', taskId: 'tsk-1', runId: 'tr_3', slotEvent: { type: 'part_delta', text: '新回合' } });
  assert.equal(calls.separators.length, 3);
  assert.deepEqual(calls.separators[2], {
    runId: 'tr_3', n: 3, beforeMessageId: null, status: 'running', startedAt: null,
  });
});

test('transportSend posts user messages with the idempotency key and goal fields', async () => {
  const { mode, calls } = harness();
  await mode.boot();
  const sent = mode.transportSend({
    type: 'user_message', text: '继续修', clientMsgId: 'client-9',
    goal: true, goalLimits: { maxRounds: 30 },
  });
  assert.equal(sent, true, 'composer treats truthy as sent');
  await new Promise(r => setImmediate(r));
  const post = calls.fetch.find(c => c.url.includes('/send'));
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), {
    text: '继续修', clientMsgId: 'client-9', goal: true, goalLimits: { maxRounds: 30 },
  });
  assert.equal(calls.system.length, 0, 'no error surface on success');
});

test('M4-T1 transportSend forwards the composer userInputRequestId so /send resolves the pending question', async () => {
  const { mode, calls } = harness();
  await mode.boot();
  const sent = mode.transportSend({
    type: 'user_message', text: '生产', clientMsgId: 'client-11',
    userInputRequestId: 'usrq-live-1',
  });
  assert.equal(sent, true);
  await new Promise(r => setImmediate(r));
  const post = calls.fetch.find(c => c.url.includes('/send'));
  assert.equal(JSON.parse(post.init.body).userInputRequestId, 'usrq-live-1',
    'the answer reaches the answer ingress, not the followup path');
});

test('transportSend surfaces send failures and unstages the bubble', async () => {
  const h = harness();
  // Re-stub: task DTO ok, first page unstubbed (boot must degrade, not reject),
  // send fails with the server's error code.
  h.deps.fetch = fetchStub([
    ['/api/task-board/tasks/tsk-1?', [200, { ok: true, task: h.taskDto }]],
    ['/send', [409, { error: 'target_busy' }]],
  ], h.calls.fetch = []);
  const mode = createTaskMode(h.deps);
  await mode.boot();
  const unstaged = [];
  h.deps.unstageUserMessage = id => unstaged.push(id);
  mode.transportSend({ type: 'user_message', text: 'x', clientMsgId: 'client-10' });
  await new Promise(r => setImmediate(r));
  assert.ok(h.calls.system.at(-1).includes('target_busy'));
  assert.deepEqual(unstaged, ['client-10']);
});

test('cancel stops the open run via cancel-run and never marks the card done', async () => {
  // A3 split: the chat view stop button must not POST {status:done} — that
  // lifecycle change belongs to the board's ✅ alone.
  const { mode, calls } = harness();
  await mode.boot();
  assert.equal(mode.transportSend({ type: 'typing' }), true);
  assert.equal(mode.transportSend({ type: 'clear_history' }), true);
  assert.deepEqual(calls.system.filter(t => t === '::reset-view').length, 1);
  mode.transportSend({ type: 'cancel' });
  await new Promise(r => setImmediate(r));
  assert.ok(calls.fetch.some(c => c.url.includes('/cancel-run')));
  assert.ok(!calls.fetch.some(c => c.url.includes('/status')));
});

test('older pages hit the task transcript endpoint with the store cursor', async () => {
  const { mode } = harness();
  await mode.boot();
  assert.equal(
    mode.historyPageUrl({ before: 'm3', limit: 20 }),
    '/api/task-board/tasks/tsk-1/messages?before=m3&limit=20',
  );
});

test('reconnect reconciles by re-fetching the task and first page', async () => {
  const { mode, sockets, calls, clock } = harness();
  await mode.boot();
  sockets[0].onopen();
  sockets[0].onclose();
  assert.ok(calls.status.some(([text]) => /重连|Reconnect/i.test(text)));
  clock.runOne(); // reconnect timer fires immediately (delay 0)
  await new Promise(r => setImmediate(r)); // the ticket promise is async
  assert.equal(sockets.length, 2, 'a replacement socket was created');
  sockets[1].onopen();
  // Reconcile re-read the task DTO and the first page after the reset.
  const taskFetches = calls.fetch.filter(c => c.url.includes('/api/task-board/tasks/tsk-1?')).length;
  const pageFetches = calls.fetch.filter(c => c.url.includes('/messages')).length;
  assert.equal(taskFetches, 2);
  assert.equal(pageFetches, 2);
  assert.ok(calls.system.includes('::reset-view'));
});

test('a task without dirIds still renders the transcript read-only', async () => {
  const h = harness({ task: { id: 'tsk-1', title: '无目录任务', status: 'active', dirIds: [], runs: [] } });
  await h.mode.boot();
  assert.equal(h.sockets.length, 0);
  assert.ok(h.calls.system.some(t => /无法订阅|实时/.test(t)));
  // Sending still works (it goes through HTTP, not the socket).
  h.mode.transportSend({ type: 'user_message', text: 'hi', clientMsgId: 'c' });
  await new Promise(r => setImmediate(r));
  assert.ok(h.calls.fetch.some(c => c.url.includes('/send')));
});

test('task_board_update refreshes the task DTO (debounced) and re-renders identity', async () => {
  const { mode, sockets, calls, clock } = harness();
  await mode.boot();
  sockets[0].onopen();
  mode.handleWorkspaceMessage({ type: 'task_board_update', taskIds: ['other-task'] });
  assert.equal(calls.identity.length, 1);
  mode.handleWorkspaceMessage({ type: 'task_board_update', taskIds: ['tsk-1'] });
  mode.handleWorkspaceMessage({ type: 'task_board_update', taskIds: ['tsk-1'] });
  clock.runOne();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.identity.length, 2, 'one debounced refresh, not two');
});

test('task-board rows open the unified chat view instead of the legacy modal', () => {
  const root = path.join(__dirname, '..');
  const tb = fs.readFileSync(path.join(root, 'public', 'manage-taskboard.js'), 'utf8');
  // Entry: row click opens chat.html?task= in a new tab (the same window.open
  // pattern manage.js uses for chat sessions).
  assert.match(tb, /function openTaskChatView\(/);
  assert.match(tb, /chat\.html\?task=/);
  // M4 (design D3): the legacy stacked modal is retired, not deprecated —
  // no handler chain, no markup, no task-side pending-question card (the
  // chat view's card is the only answer surface left).
  assert.doesNotMatch(tb, /openTaskBoardDetail|loadTaskBoardDetail|renderTaskBoardDetail|closeTaskBoardDetail|_tbEnsureTaskComposer/);
  const manageHtml = fs.readFileSync(path.join(root, 'public', 'manage.html'), 'utf8');
  assert.doesNotMatch(manageHtml, /tb-detail-modal|tb-detail-content|tb-task-composer/);
  const ui = fs.readFileSync(path.join(root, 'public', 'task-board-ui.js'), 'utf8');
  assert.doesNotMatch(ui, /renderPendingQuestion|bindPendingQuestionAnswers|renderTaskRunSummary|recentTaskRuns/);
  // Row-level actions keep the modal-only operations reachable.
  assert.match(tb, /cleanupTaskWorktree/);
  assert.match(tb, /setTaskBoardStatus/);
});

test('chat.html loads the task-mode scripts before chat.js and gates session-only chrome by body class', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'public', 'chat.js'), 'utf8');
  const modeSrc = fs.readFileSync(path.join(root, 'public', 'chat-task-mode.js'), 'utf8');
  const bootSrc = fs.readFileSync(path.join(root, 'public', 'chat-task-boot.js'), 'utf8');
  const chatAt = html.indexOf('<script src="chat.js"></script>');
  assert.ok(html.indexOf('<script src="chat-task-mode.js"></script>') >= 0);
  assert.ok(html.indexOf('<script src="chat-task-mode.js"></script>') < chatAt);
  assert.ok(html.indexOf('<script src="chat-task-boot.js"></script>') < chatAt);
  // The host boots task mode instead of the chat WS when ?task= is present;
  // the DOM-side adapters (and the createTaskMode wiring) live in the boot
  // file so chat.js stays inside its hard line budget.
  assert.match(chat, /TASK_MODE/);
  assert.match(chat, /bootTaskMode\(\)/);
  assert.match(bootSrc, /createTaskMode/);
  assert.match(modeSrc, /task_run_stream/);
  // Declarations only — the boot file loads before chat.js's top-level
  // lexical bindings exist, so it must not execute anything at load time.
  const topLevelStatements = bootSrc.split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line && !line.startsWith('//') && !line.startsWith('*'))
    .filter(line => !line.startsWith('function ') && !/^ /.test(line)
      && line !== "'use strict';" && line !== '}');
  assert.deepEqual(topLevelStatements, [], 'chat-task-boot.js must be declarations only');
  // Session-only chrome hides via a body-class stylesheet (external css keeps
  // chat.html inside the source-line budget), not per-element JS surgery.
  const css = fs.readFileSync(path.join(root, 'public', 'chat-task-mode.css'), 'utf8');
  assert.ok(html.indexOf('chat-task-mode.css') >= 0);
  assert.match(css, /body\.task-mode \.session-only/);
  assert.match(css, /\.run-separator/);
});

test('M3 the task diff dock and manage detail use the per-task worktree surface', () => {
  const root = path.join(__dirname, '..');
  const diff = fs.readFileSync(path.join(root, 'public', 'chat-diff.js'), 'utf8');
  const boot = fs.readFileSync(path.join(root, 'public', 'chat-task-boot.js'), 'utf8');
  const tb = fs.readFileSync(path.join(root, 'public', 'manage-taskboard.js'), 'utf8');
  // Diff dock: one base switch (task-board vs session endpoints), a task-mode
  // open flag, and a setTaskContext entry for the boot wiring. The two fetch
  // sites must go through the shared base — no session URL left inline.
  assert.match(diff, /'\/api\/task-board\/tasks\/' \+ id \+ '\/diff'/);
  assert.match(diff, /opts && opts\.task/);
  assert.match(diff, /setTaskContext: setTaskContext/);
  assert.match(diff, /open\(dock\.taskId, \{ task: true \}\)/);
  assert.equal(diff.split("'/api/sessions/' + encodeURIComponent(sessionId)").length, 1,
    'the one remaining literal session URL is diffBase() itself');
  // Boot: an identity DTO carrying a worktree turns on the task FAB.
  assert.match(boot, /dto\.worktreePath/);
  assert.match(boot, /setTaskContext\(_taskId\)/);
  // Manage: the one-click cleanup posts to the M3 endpoint and maps refusals.
  assert.match(tb, /\/cleanup-worktree/);
  assert.match(tb, /function cleanupTaskWorktree\(/);
  assert.match(tb, /run_active/);
});

test('task_run_stream envelope cli is handed to the host before the slot events', async () => {
  // The event controller folds deltas by state.currentCli (part_delta is a
  // no-op under claude; codex snapshots append) — a codex run folded as
  // claude loses live text. The envelope's cli must reach the host setter
  // BEFORE its first slot event is fed.
  const { mode, calls, sockets } = harness();
  await mode.boot();
  sockets[0].onopen();
  mode.handleWorkspaceMessage({
    type: 'task_run_stream', taskId: 'tsk-1', runId: 'tr_2', dirId: 'dir-9',
    cli: 'codex', slotEvent: { type: 'part_delta', text: 'hi' },
  });
  assert.deepEqual(calls.clis, ['codex']);
  // An envelope without cli leaves the host's engine untouched.
  mode.handleWorkspaceMessage({
    type: 'task_run_stream', taskId: 'tsk-1', runId: 'tr_2', dirId: 'dir-9',
    slotEvent: { type: 'part_delta', text: 'again' },
  });
  assert.deepEqual(calls.clis, ['codex']);
});

/* ── P2 · task chat = ordinary chat: hand off to the bound hidden session ── */

test('P2 resolveBoundSession get-or-creates the binding and returns the session id', async () => {
  const { resolveBoundSession } = require('../public/chat-task-mode');
  const calls = [];
  const fetch = fetchStub([
    ['/api/task-board/tasks/tsk-1/chat-session', [200, { ok: true, sessionId: 'sess-bound-1', created: false }]],
  ], calls);
  const id = await resolveBoundSession({ taskId: 'tsk-1', fetch, withToken: u => u + '?tok=1' });
  assert.equal(id, 'sess-bound-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/task-board\/tasks\/tsk-1\/chat-session\?tok=1/);
  assert.equal(calls[0].init.method, 'POST');
});

test('P2 resolveBoundSession fails soft: any error means the legacy projection', async () => {
  const { resolveBoundSession } = require('../public/chat-task-mode');
  // HTTP errors: 501 old server, 404 gone task, 409 no directory, 502 create failed.
  for (const status of [501, 404, 409, 502]) {
    const id = await resolveBoundSession({
      taskId: 'tsk-1',
      fetch: fetchStub([['/chat-session', [status, { error: 'x' }]]], []),
    });
    assert.equal(id, null, 'status ' + status);
  }
  // Network failure.
  assert.equal(await resolveBoundSession({
    taskId: 'tsk-1', fetch: async () => { throw new Error('down'); },
  }), null);
  // Malformed success body.
  assert.equal(await resolveBoundSession({
    taskId: 'tsk-1',
    fetch: fetchStub([['/chat-session', [200, { ok: true }]]], []),
  }), null);
});

test('P2 boot hands off to the plain session chat when a binding exists', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-task-boot.js'), 'utf8');
  assert.match(boot, /resolveBoundSession/);
  assert.match(boot, /location\.replace\('chat\.html\?session='/);
  // The legacy ledger projection stays as the fallback path.
  assert.match(boot, /createTaskMode/);
});

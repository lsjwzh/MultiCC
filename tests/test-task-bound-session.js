'use strict';

// P1-a · task-bound hidden session (design: 任务专属隐藏会话).
// Each task owns ONE chat session 1:1 — the task chat view then reuses the
// ordinary session chat wholesale (tool cards, usage, memory injection, resume
// continuity) instead of projecting the ledger. The record is hidden from
// fleet/session lists (like execution slots) but stays addressable through
// direct session APIs (UNLIKE execution slots, which 404 by design).
//
// This slice pins the infrastructure only: the marker round-trip, the query
// gate, the get-or-create endpoint, and the DTO surface. Send-path rewiring
// is P1-b.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/task-board/core');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { createSessionQueryService } = require('../src/session/query-service');

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskbound-'));
  const file = path.join(tmp, 'task_board.json');
  const deps = {
    file,
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue() { return new Promise(() => {}); },
    },
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
    ]),
    directories: new Map([
      ['dir-1', { id: 'dir-1', path: '/tmp/dir-1', baseBranch: 'main' }],
    ]),
    loadHistory: () => [],
    dispatchToSession: async target => ({ ok: true, chatId: target, operationId: 'op-1' }),
    routeCommanderTask: async () => ({ ok: true, targetSessionId: 'sess-1', operationId: 'op-1' }),
    sendSessionMessage: async sessionId => ({ ok: true, handled: false, chatId: sessionId }),
    workspaceBroadcast: () => {},
    atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    isSessionBusy: () => false,
    logger: { log: () => {} },
    ...overrides,
  };
  return { runtime: createTaskBoardRuntime(deps), deps, file };
}

function mkRoutes(runtime) {
  const routes = new Map();
  runtime.mountRoutes({
    get: (name, handler) => routes.set(`GET ${name}`, handler),
    post: (name, handler) => routes.set(`POST ${name}`, handler),
  });
  return routes;
}

const response = () => ({
  code: 200, headersSent: false,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; this.headersSent = true; return this; },
});

function seedTask(runtime, task) {
  // Mutate the live board (the runtime loads the file once at creation), then
  // persist so file assertions see the seeded state too.
  const board = runtime.getBoard();
  board.tasks[task.id] = core.normalizeBoard({ modules: {}, tasks: { [task.id]: task } }).tasks[task.id];
  runtime.save();
  return board.tasks[task.id];
}

/* ── 1 · the query gate: hidden from lists, addressable directly ── */

test('task-bound sessions are hidden by default but addressable with includeTaskBound', () => {
  const records = new Map([
    ['ordinary-1', { id: 'ordinary-1', kind: 'chat', dirId: 'dir-1' }],
    ['bound-1', { id: 'bound-1', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-1' }],
  ]);
  const query = createSessionQueryService({
    records: { list: () => records.values(), get: id => records.get(id) },
    runtime: { read: () => ({}) },
  });

  // Lists (fleet) never see the bound session.
  assert.deepEqual(query.list().map(dto => dto.id), ['ordinary-1']);
  // Direct lookup is hidden by default too — callers must opt in explicitly.
  assert.equal(query.get('bound-1'), null);
  // ...but unlike execution slots, the opt-in exists: the chat view resolves it.
  const direct = query.get('bound-1', { includeTaskBound: true });
  assert.equal(direct?.id, 'bound-1');
  // The opt-in never leaks execution slots (separate namespace, stays 404-grade).
  records.set('slot-1', { id: 'slot-1', kind: 'chat', dirId: 'dir-1', taskExecutionSlot: true });
  assert.equal(query.get('slot-1', { includeTaskBound: true }), null);
  // includeHidden/aux semantics untouched.
  assert.deepEqual(
    query.list({ includeTaskBound: true }).map(dto => dto.id).sort(),
    ['bound-1', 'ordinary-1'],
  );
});

/* ── 2 · marker round-trip through the board file ── */

test('chatSessionId survives the board normalize/persist round-trip', () => {
  const board = core.normalizeBoard({
    modules: {},
    tasks: {
      'task-1': {
        id: 'task-1', title: '任务一', status: 'active',
        chatSessionId: 'sess-bound-1',
      },
      'task-2': {
        id: 'task-2', title: '任务二', status: 'active',
        chatSessionId: 42, // non-strings are dropped, never persisted
      },
    },
  });
  assert.equal(board.tasks['task-1'].chatSessionId, 'sess-bound-1');
  assert.equal(board.tasks['task-2'].chatSessionId, undefined);

  // The DTO surfaces it so the web/App chat view can deep-link.
  const dto = core.buildBoardDto(board, () => 'idle');
  assert.equal(dto.tasks.find(t => t.id === 'task-1').chatSessionId, 'sess-bound-1');
  assert.equal(dto.tasks.find(t => t.id === 'task-2').chatSessionId, null);
});

/* ── 3 · the get-or-create endpoint ── */

test('chat-session endpoint creates a bound session inheriting the commander runtime', async () => {
  const created = [];
  const { runtime, deps, file } = mkRuntime({
    createSessionRecord: async input => {
      created.push(input);
      const session = { id: 'sess-new-1', ...input, dirId: input.dir.id };
      deps.records.set(session.id, session);
      return { ok: true, id: session.id, session };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '修复登录闪退', status: 'active',
    refs: [{ sessionId: 'sess-old', dirId: 'dir-1', ts: 1 }],
  });
  const routes = mkRoutes(runtime);
  const handler = routes.get('POST /api/task-board/tasks/:taskId/chat-session');
  assert.ok(handler, 'route registered');

  const res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, sessionId: 'sess-new-1', created: true });

  assert.equal(created.length, 1);
  const input = created[0];
  assert.equal(input.kind, 'chat');
  assert.equal(input.taskBoundTaskId, 'task-1');
  assert.equal(input.dir.id, 'dir-1');
  // Runtime inheritance mirrors the elastic worker: cli/model/provider from
  // the directory commander so the bound session runs what the fleet runs.
  assert.equal(input.cli, 'codex');
  assert.equal(input.model, 'gpt-5');
  assert.equal(input.provider, 'p-1');
  assert.match(input.label, /修复登录闪退/);
  // Required persistence: a bound session is a task asset, never best-effort.
  assert.equal(input.persistence, 'required');
  // Never an execution slot, never ephemeral.
  assert.notEqual(input.taskExecutionSlot, true);
  assert.notEqual(input.ephemeral, true);

  // The binding persisted into the board file.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.tasks['task-1'].chatSessionId, 'sess-new-1');
});

test('chat-session endpoint is idempotent and heals a dangling binding', async () => {
  let creates = 0;
  const { runtime, deps, file } = mkRuntime({
    createSessionRecord: async input => {
      creates += 1;
      const session = { id: `sess-new-${creates}`, dirId: input.dir.id, kind: 'chat' };
      deps.records.set(session.id, session);
      return { ok: true, id: session.id, session };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '任务', status: 'active',
    refs: [{ sessionId: 'sess-old', dirId: 'dir-1', ts: 1 }],
  });
  const routes = mkRoutes(runtime);
  const handler = routes.get('POST /api/task-board/tasks/:taskId/chat-session');

  // First call creates.
  let res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-new-1');
  assert.equal(creates, 1);

  // Second call reuses (record still exists) — no second worktree, no churn.
  res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.deepEqual(res.body, { ok: true, sessionId: 'sess-new-1', created: false });
  assert.equal(creates, 1);

  // Hibernation removes only the checkout. The durable record remains the
  // task's 1:1 binding and opening/viewing must neither thaw nor replace it.
  deps.records.get('sess-new-1').workspaceState = 'hibernated';
  res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.deepEqual(res.body, { ok: true, sessionId: 'sess-new-1', created: false });
  assert.equal(creates, 1);

  // The record disappears (manual cleanup / GC bug): the next call HEALS the
  // binding instead of 404ing forever.
  deps.records.delete('sess-new-1');
  res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-new-2');
  assert.equal(res.body.created, true);
  assert.equal(creates, 2);
});

test('chat-session adopts the origin session for a task born in an ordinary session', async () => {
  // The user's scenario: a task started inside their own normal session has
  // its whole conversation there. Clicking it must land in THAT session —
  // never fork a fresh hidden room that has never seen the work.
  let creates = 0;
  const { runtime, deps, file } = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
      ['sess-mine', { id: 'sess-mine', kind: 'chat', dirId: 'dir-1', label: '我的会话' }],
    ]),
    loadHistory: sid => (sid === 'sess-mine'
      ? [{ id: 'm-1', role: 'user', taskId: 'task-1', ts: 10, content: '开始任务' }]
      : []),
    createSessionRecord: async input => {
      creates += 1;
      deps.records.set(`sess-new-${creates}`, { id: `sess-new-${creates}`, kind: 'chat', dirId: input.dir.id });
      return { ok: true, id: `sess-new-${creates}` };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '普通会话里开始的任务', status: 'active',
    refs: [{ sessionId: 'sess-mine', dirId: 'dir-1', ts: 10 }],
  });
  const handler = mkRoutes(runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  const res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.deepEqual(res.body, { ok: true, sessionId: 'sess-mine', created: false, adopted: true });
  assert.equal(creates, 0, 'no hidden session forked for a task that already has a home');
  // Stateless by design: nothing is bound or persisted, the origin stays an
  // ordinary visible session, and archive-release stays a no-op for it.
  assert.ok(!runtime.getBoard().tasks['task-1'].chatSessionId);
  assert.equal(deps.records.get('sess-mine').taskBoundTaskId, undefined);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!saved.tasks['task-1'].chatSessionId);
});

test('adoption skips dead, slot and foreign-bound refs; the newest live ref wins', async () => {
  let creates = 0;
  const { runtime, deps } = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
      ['slot-1', { id: 'slot-1', kind: 'chat', dirId: 'dir-1', taskExecutionSlot: true }],
      ['other-bound', { id: 'other-bound', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-9' }],
      ['sess-a', { id: 'sess-a', kind: 'chat', dirId: 'dir-1' }],
      ['sess-b', { id: 'sess-b', kind: 'chat', dirId: 'dir-1' }],
    ]),
    loadHistory: sid => (sid === 'sess-a' || sid === 'sess-b'
      ? [{ id: `m-${sid}`, role: 'user', taskId: 'task-1', ts: 1, content: '任务轮次' }]
      : []),
    createSessionRecord: async input => {
      creates += 1;
      deps.records.set(`sess-new-${creates}`, { id: `sess-new-${creates}`, kind: 'chat', dirId: input.dir.id });
      return { ok: true, id: `sess-new-${creates}` };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '多来源任务', status: 'active',
    refs: [
      { sessionId: 'sess-dead', dirId: 'dir-1', ts: 99 },   // record gone
      { sessionId: 'slot-1', dirId: 'dir-1', ts: 90 },      // execution slot — never a home
      { sessionId: 'other-bound', dirId: 'dir-1', ts: 80 }, // another task's bound room
      { sessionId: 'sess-b', dirId: 'dir-1', ts: 30 },
      { sessionId: 'sess-a', dirId: 'dir-1', ts: 50 },      // newest live ordinary ref
    ],
  });
  const handler = mkRoutes(runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  let res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-a');
  assert.equal(res.body.adopted, true);
  assert.equal(creates, 0);
  // Stateless re-resolution: a home that dies falls to the next candidate on
  // the next click — no stale pointer to heal.
  deps.records.delete('sess-a');
  res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-b');
});

test('a cleared or moved-on origin transcript is no longer a home: fall back to create', async () => {
  // clear_history keeps the record but empties the transcript; a session
  // whose turns moved on to a newer task no longer contains this task's
  // conversation either. Both refs point at the wrong room, so adoption must
  // decline and the click degrades to create + seed skeleton instead of
  // opening an unrelated conversation.
  let creates = 0;
  const transcripts = {
    'sess-cleared': [],
    'sess-movedon': [{ id: 'm-b1', role: 'user', taskId: 'task-9', ts: 50, content: '别的任务' }],
  };
  const { runtime, deps } = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
      ['sess-cleared', { id: 'sess-cleared', kind: 'chat', dirId: 'dir-1' }],
      ['sess-movedon', { id: 'sess-movedon', kind: 'chat', dirId: 'dir-1' }],
    ]),
    loadHistory: sid => transcripts[sid] || [],
    createSessionRecord: async input => {
      creates += 1;
      deps.records.set(`sess-new-${creates}`, { id: `sess-new-${creates}`, kind: 'chat', dirId: input.dir.id });
      return { ok: true, id: `sess-new-${creates}` };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '清了历史的任务', status: 'active',
    refs: [
      { sessionId: 'sess-movedon', dirId: 'dir-1', ts: 50 },
      { sessionId: 'sess-cleared', dirId: 'dir-1', ts: 10 },
    ],
  });
  const handler = mkRoutes(runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  const res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.created, true);
  assert.match(res.body.sessionId, /^sess-new-/);
  assert.equal(creates, 1);
});

test("a session that still holds the task's turns keeps adopting even after new tasks moved in", async () => {
  // The mixed case: the origin conversation continued with a newer task, but
  // this task's turns are still in the transcript — its history lives there,
  // so it still opens there.
  let creates = 0;
  const { runtime } = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
      ['sess-mixed', { id: 'sess-mixed', kind: 'chat', dirId: 'dir-1' }],
    ]),
    loadHistory: sid => (sid === 'sess-mixed' ? [
      { id: 'm-a1', role: 'user', taskId: 'task-1', ts: 10, content: '任务一的轮次' },
      { id: 'm-b1', role: 'user', taskId: 'task-2', ts: 20, content: '任务二的轮次' },
    ] : []),
    // The create port must exist (the endpoint's 501 contract guards on it
    // before any resolution) but adoption must win without ever touching it.
    createSessionRecord: async () => { creates += 1; return { ok: false, error: 'must_not_create' }; },
  });
  seedTask(runtime, {
    id: 'task-1', title: '混住任务', status: 'active',
    refs: [{ sessionId: 'sess-mixed', dirId: 'dir-1', ts: 10 }],
  });
  const handler = mkRoutes(runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  const res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.deepEqual(res.body, { ok: true, sessionId: 'sess-mixed', created: false, adopted: true });
  assert.equal(creates, 0);
});

test('a live 1:1 binding outranks origin refs; all-dead refs still create', async () => {
  let creates = 0;
  const { runtime, deps } = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex', model: 'gpt-5', provider: 'p-1' }],
      ['sess-bound', { id: 'sess-bound', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-1' }],
      ['sess-mine', { id: 'sess-mine', kind: 'chat', dirId: 'dir-1' }],
    ]),
    createSessionRecord: async input => {
      creates += 1;
      deps.records.set(`sess-new-${creates}`, { id: `sess-new-${creates}`, kind: 'chat', dirId: input.dir.id });
      return { ok: true, id: `sess-new-${creates}` };
    },
  });
  seedTask(runtime, {
    id: 'task-1', title: '板建任务', status: 'active', chatSessionId: 'sess-bound',
    refs: [{ sessionId: 'sess-mine', dirId: 'dir-1', ts: 10 }],
  });
  seedTask(runtime, {
    id: 'task-2', title: '遗留任务', status: 'active',
    refs: [{ sessionId: 'sess-gone', dirId: 'dir-1', ts: 10 }],
  });
  const handler = mkRoutes(runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  let res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-bound');
  assert.equal(res.body.created, false);
  assert.equal(res.body.adopted, undefined);
  // A ledger-only legacy task (every ref dead) degrades to the bound-room
  // creation the cold-start seed knows how to wall.
  res = response();
  await handler({ params: { taskId: 'task-2' }, body: {} }, res);
  assert.equal(res.body.created, true);
  assert.equal(creates, 1);
});

test('chat-session endpoint surfaces failure modes honestly', async () => {
  // No createSessionRecord dep (reduced hosts/tests): explicit 501, no crash.
  const bare = mkRuntime();
  seedTask(bare.runtime, { id: 'task-1', title: '任务', status: 'active' });
  const bareHandler = mkRoutes(bare.runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  let res = response();
  await bareHandler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.code, 501);
  assert.equal(res.body.error, 'chat_session_unavailable');

  // Unknown task: 404.
  const withCreate = mkRuntime({ createSessionRecord: async () => ({ ok: true, id: 'x' }) });
  const handler = mkRoutes(withCreate.runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  res = response();
  await handler({ params: { taskId: 'nope' }, body: {} }, res);
  assert.equal(res.code, 404);

  // Creation failure (worktree conflict etc.) propagates, no binding written.
  const failing = mkRuntime({
    createSessionRecord: async () => ({ ok: false, error: 'worktree 创建失败: boom' }),
  });
  seedTask(failing.runtime, {
    id: 'task-2', title: '任务2', status: 'active',
    refs: [{ sessionId: 'sess-old', dirId: 'dir-1', ts: 1 }],
  });
  const failHandler = mkRoutes(failing.runtime).get('POST /api/task-board/tasks/:taskId/chat-session');
  res = response();
  await failHandler({ params: { taskId: 'task-2' }, body: {} }, res);
  assert.equal(res.code, 502);
  assert.match(res.body.error, /worktree/);
  const saved = JSON.parse(fs.readFileSync(failing.file, 'utf8'));
  assert.equal(saved.tasks['task-2'].chatSessionId, undefined);
});

/* ── 4 · P1-b1 · send 改道：follow-up 直投 bound session ── */

function mkBoundFixture(overrides = {}) {
  const calls = { sent: [], routed: [], runs: [] };
  const fixture = mkRuntime({
    records: new Map([
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander', cli: 'codex' }],
      ['bound-1', { id: 'bound-1', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-1' }],
    ]),
    sendSessionMessage: async (sessionId, text, options) => {
      calls.sent.push({ sessionId, text, options });
      return { handled: false, chatId: sessionId, queued: false };
    },
    routeCommanderTask: async input => {
      calls.routed.push(input);
      return { ok: true, targetSessionId: 'slot-1', operationId: 'op-1' };
    },
    ...(overrides.loadHistory ? { loadHistory: overrides.loadHistory } : {}),
    ...(overrides.runtimeOverrides || {}),
    ...(overrides.deps || {}),
  });
  seedTask(fixture.runtime, {
    id: 'task-1', title: '修复登录闪退', status: 'active',
    chatSessionId: 'bound-1',
    refs: [{ sessionId: 'sess-old', dirId: 'dir-1', ts: 1 }],
  });
  return { ...fixture, calls };
}

test('bound follow-up bypasses commander and posts straight to the bound session', async () => {
  const fixture = mkBoundFixture({
    loadHistory: () => [{ id: 'm1', role: 'user', content: 'previous turn' }],
  });
  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k1' });

  assert.equal(result.ok !== false, true);
  // Exactly one ordinary chat turn on the bound session, task attribution
  // riding the canonical turn options (the same keys the WS ingress uses).
  assert.equal(fixture.calls.sent.length, 1);
  const sent = fixture.calls.sent[0];
  assert.equal(sent.sessionId, 'bound-1');
  assert.equal(sent.text, '继续修'); // resume: bare text, the session IS the context
  assert.equal(sent.options.taskId, 'task-1');
  assert.equal(sent.options.clientMsgId, 'k1');
  // Zero commander routing, zero TaskRun ledger rows, zero slot involvement.
  assert.equal(fixture.calls.routed.length, 0);
  assert.equal(result.taskBound, true);
  assert.equal(result.targetSessionId, 'bound-1');
  // The routing receipt points at the bound session so the card's runState
  // aggregates its classify state (oneWay worker wins over legacy ref slots).
  const task = fixture.runtime.getBoard().tasks['task-1'];
  assert.equal(task.routing?.workerSessionId, 'bound-1');
  assert.equal(task.routing?.oneWay, true);
  const dto = core.buildBoardDto(fixture.runtime.getBoard(), sid => sid === 'bound-1' ? 'running' : 'idle');
  assert.equal(dto.tasks.find(t => t.id === 'task-1').runState, 'running');
});

// P4 · cold start. The task transcript reaches the MODEL as a prompt-only
// layer; what reaches the TRANSCRIPT is exactly what the user typed, so the
// task chat view is the ordinary chat view down to its very first bubble.
const TASK_HISTORY = [
  { id: 'mu1', role: 'user', content: '先复现闪退堆栈', ts: 1 },
  { id: 'ma1', role: 'assistant', content: '已定位到空指针', ts: 2 },
];

// Give the seeded task a resolvable historical ref so legacyImportMessages has
// something to project.
function seedTaskHistory(fixture) {
  const task = fixture.runtime.getBoard().tasks['task-1'];
  task.refs[0].userMsgId = 'mu1';
  task.refs[0].assistantMsgId = 'ma1';
}

test('cold start seeds the task transcript as prompt context, never as the user message', async () => {
  const fixture = mkBoundFixture({
    loadHistory: () => TASK_HISTORY, // bound session never spoke → cold start
  });
  seedTaskHistory(fixture);
  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k2' });

  assert.equal(result.taskBound, true);
  assert.equal(fixture.calls.sent.length, 1);
  const sent = fixture.calls.sent[0];
  // The turn text — the thing runChatTurn persists — is the bare user message.
  assert.equal(sent.text, '继续修');
  // The compiled wall rides the turn options as a prompt prefix instead.
  const seed = sent.options.taskContextSeed;
  assert.match(seed, /\[MultiCC task run context/);
  assert.match(seed, /先复现闪退堆栈/);
  assert.match(seed, /已定位到空指针/);
  // No 当前要求 section and no copy of the user text: composeMessage appends
  // the user message after the layer, so a copy here would duplicate it.
  assert.equal(seed.includes('Current request'), false);
  assert.equal(seed.includes('继续修'), false);
  // Layers concatenate with no separator — the seed carries its own.
  assert.equal(seed.endsWith('\n\n'), true);
  assert.equal(sent.options.taskId, 'task-1');
});

test('a warm native session sends no seed: the session IS the context', async () => {
  const fixture = mkBoundFixture({
    // A live native session: the CLI still remembers the task, so re-walling
    // it would be a reset even though the card carries history.
    loadHistory: () => TASK_HISTORY,
    runtimeOverrides: {
      records: new Map([
        ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', cli: 'codex' }],
        ['bound-1', {
          id: 'bound-1', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-1',
          cliSessionId: 'ca88a4d8-1234-5678-9abc-def012345678',
        }],
      ]),
    },
  });
  seedTaskHistory(fixture);
  await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k3' });

  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.sent[0].text, '继续修');
  assert.equal(fixture.calls.sent[0].options.taskContextSeed, undefined);
});

test('a persisted first turn that never reached the CLI still seeds', async () => {
  const fixture = mkBoundFixture({
    // The transcript already holds the turn (persist happens before the
    // provider runs), yet no native session exists — the previous attempt died
    // in between. Gating on the transcript would ship this turn contextless.
    loadHistory: () => TASK_HISTORY,
  });
  seedTaskHistory(fixture);
  await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k4' });

  assert.equal(fixture.calls.sent.length, 1);
  assert.match(fixture.calls.sent[0].options.taskContextSeed, /先复现闪退堆栈/);
});

test('a dangling binding heals by re-creating the bound session, not by pooling', async () => {
  const created = [];
  const fixture = mkBoundFixture({
    deps: {
      createSessionRecord: async input => {
        created.push(input);
        const session = { id: 'bound-reborn', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-1' };
        fixture.deps.records.set(session.id, session);
        return { ok: true, id: session.id, session };
      },
    },
  });
  fixture.deps.records.delete('bound-1'); // record gone, board still points at it
  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k4' });

  assert.equal(result.taskBound, true);
  assert.equal(created.length, 1, 'the binding heals onto a fresh 1:1 session');
  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.sent[0].sessionId, 'bound-reborn');
  assert.equal(fixture.calls.routed.length, 0, 'the pooled path no longer exists');
});

/* ── 5 · P1-b2 · task start 改道：新任务直接绑定，永不落池 ── */

function mkStartFixture(overrides = {}) {
  const calls = { created: [], sent: [], routed: [] };
  const fixture = mkRuntime({
    createSessionRecord: async input => {
      calls.created.push(input);
      const session = { id: 'sess-new-1', ...input, dirId: input.dir.id };
      fixture.deps.records.set(session.id, session);
      return { ok: true, id: session.id, session };
    },
    sendSessionMessage: async (sessionId, text, options) => {
      calls.sent.push({ sessionId, text, options });
      return { handled: false, chatId: sessionId, queued: false };
    },
    routeCommanderTask: async input => {
      calls.routed.push(input);
      return { ok: true, targetSessionId: 'slot-1', operationId: 'op-1' };
    },
    ...(overrides.deps || {}),
  });
  return { ...fixture, calls };
}

test('task start binds a hidden session and opens its first turn directly', async () => {
  const fixture = mkStartFixture();
  const result = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', {
    source: 'task-board', clientMsgId: 'ck1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskBound, true);
  assert.equal(result.routeMode, 'task-bound');
  assert.equal(result.targetSessionId, 'sess-new-1');
  const taskId = result.taskId;
  assert.ok(taskId);

  // The binding was created with the task marker and inherited runtime.
  assert.equal(fixture.calls.created.length, 1);
  assert.equal(fixture.calls.created[0].taskBoundTaskId, taskId);
  assert.equal(fixture.calls.created[0].cli, 'codex');

  // One canonical chat turn with task-start metadata; zero slot routing.
  assert.equal(fixture.calls.sent.length, 1);
  const sent = fixture.calls.sent[0];
  assert.equal(sent.sessionId, 'sess-new-1');
  assert.equal(sent.text, '新任务：做 X'); // no history → bare text, no wall
  assert.equal(sent.options.taskId, taskId);
  assert.equal(sent.options.taskStart, true);
  assert.equal(sent.options.taskText, '新任务：做 X');
  assert.equal(fixture.calls.routed.length, 0);

  // Board state: card bound and routing points at the bound session.
  const task = fixture.runtime.getBoard().tasks[taskId];
  assert.equal(task.chatSessionId, 'sess-new-1');
  assert.equal(task.routing?.workerSessionId, 'sess-new-1');
  assert.equal(task.routing?.oneWay, true);
});

test('replayed task start answers duplicate without a second turn or dispatch', async () => {
  const fixture = mkStartFixture();
  const options = { source: 'task-board', clientMsgId: 'ck1' };
  const first = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', options);
  const second = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', options);

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.routed.length, 0);
  assert.equal(fixture.calls.created.length, 1);
});

test('a failed session CREATE reports honestly — no silent pooled fallback', async () => {
  const fixture = mkStartFixture({
    deps: { createSessionRecord: async () => ({ ok: false, error: 'worktree 创建失败： boom' }) },
  });
  const result = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', {
    source: 'task-board', clientMsgId: 'ck1',
  });

  // The pooled path is retired (#38): a CREATE failure is surfaced to the
  // user instead of quietly dropping the task into a ledger where its messages
  // were invisible in the chat view (the empty-room incident).
  assert.equal(result.ok, false);
  assert.match(result.code, /worktree/);
  assert.equal(fixture.calls.routed.length, 0);
  assert.equal(fixture.calls.sent.length, 0);
  assert.equal(Object.keys(fixture.runtime.getBoard().tasks).length, 0,
    'a task that never opened its turn must not linger as a card');
});

test('a failed SEND on a live binding never falls through to the slots', async () => {
  const fixture = mkStartFixture({
    deps: {
      sendSessionMessage: async () => ({ ok: false, code: 'turn_rejected' }),
    },
  });
  const result = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', {
    source: 'task-board', clientMsgId: 'ck1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'turn_rejected');
  assert.equal(fixture.calls.routed.length, 0); // no dual executors, ever
});

test('a replay after a failed SEND reuses the already-bound session (no leak)', async () => {
  let failFirst = true;
  const fixture = mkStartFixture({
    deps: {
      sendSessionMessage: async (sessionId, text, options) => {
        if (failFirst) return { ok: false, code: 'turn_rejected' };
        fixture.calls.sent.push({ sessionId, text, options });
        return { handled: false, chatId: sessionId, queued: false };
      },
    },
  });
  const options = { source: 'task-board', clientMsgId: 'ck1' };
  const first = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', options);
  assert.equal(first.ok, false);
  failFirst = false;
  const second = await fixture.runtime.routeCommanderInput('commander-1', '新任务：做 X', options);

  assert.equal(second.ok, true);
  assert.equal(second.taskBound, true);
  // The retry healed onto the SAME session record — 1:1 holds across crashes.
  assert.equal(fixture.calls.created.length, 1);
  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.sent[0].sessionId, 'sess-new-1');
});

/* ── archive retains the bound session and history ── */

function mkReleaseFixture() {
  const records = new Map([
    ['bound-9', { id: 'bound-9', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-9' }],
  ]);
  const { runtime, file } = mkRuntime({ records });
  seedTask(runtime, {
    id: 'task-9', title: '归档释放', status: 'done',
    chatSessionId: 'bound-9',
    refs: [{ sessionId: 'bound-9', dirId: 'dir-1', ts: 1 }],
  });
  return { runtime, file, records, routes: mkRoutes(runtime) };
}

test('batch archive retains the archived task\'s bound session and history pointer', async () => {
  const { runtime, file } = mkReleaseFixture();
  const result = await runtime.archiveTasks(['task-9']);

  assert.equal(result.ok, true);
  assert.deepEqual(result.archived, ['task-9']);
  assert.equal(runtime.getBoard().tasks['task-9'].status, 'archived');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.tasks['task-9'].chatSessionId, 'bound-9',
    'the history pointer stays durable');
});

test('manual archived and done statuses both retain the bound session', async () => {
  const f1 = mkReleaseFixture();
  const t9a = f1.runtime.getBoard().tasks['task-9'];
  t9a.status = 'active';
  const res1 = response();
  await f1.routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-9' }, body: { status: 'archived' } }, res1);
  assert.equal(res1.code, 200);
  assert.equal(res1.body.releasedSession, false);
  assert.equal(res1.body.releasedSessions, 0);
  assert.equal(f1.runtime.getBoard().tasks['task-9'].chatSessionId, 'bound-9');
  const restored = response();
  await f1.routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-9' }, body: { status: 'active' } }, restored);
  assert.equal(restored.code, 200);
  assert.equal(restored.body.releasedSession, false);
  assert.equal(restored.body.releasedSessions, 0);
  assert.equal(restored.body.task.status, 'active');
  assert.ok(f1.records.has('bound-9'));
  assert.equal(JSON.parse(fs.readFileSync(f1.file, 'utf8')).tasks['task-9'].chatSessionId, 'bound-9');

  // done is mid-lifecycle: follow-ups are expected, the session must survive.
  const f2 = mkReleaseFixture();
  f2.runtime.getBoard().tasks['task-9'].status = 'active';
  const res2 = response();
  await f2.routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-9' }, body: { status: 'done' } }, res2);
  assert.equal(res2.code, 200);
  assert.equal(f2.runtime.getBoard().tasks['task-9'].chatSessionId, 'bound-9');
});

/* ── live board updates reach the directory sockets, not just Meta ── */

test('board notifications fan out to the task directory, not only the Meta channel', async () => {
  const broadcasts = [];
  const { runtime } = mkRuntime({
    workspaceBroadcast: (dirId, payload) => broadcasts.push({ dirId, payload }),
  });
  const routes = mkRoutes(runtime);
  seedTask(runtime, {
    id: 'task-n', title: '通知', status: 'active',
    refs: [{ sessionId: 'sess-x', dirId: 'dir-1', ts: 1 }],
  });

  const res = response();
  await routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-n' }, body: { status: 'done' } }, res);
  assert.equal(res.code, 200);

  const updates = broadcasts.filter(b => b.payload?.type === 'task_board_update');
  assert.ok(updates.length >= 1, 'a board update was broadcast');
  // broadcast(null, …) only ever reaches /ws/meta — manage.html and the task
  // chat view listen on /ws/workspace?dirId=…, so a null fan-out left the board
  // stale until a manual refresh.
  assert.ok(updates.some(u => u.dirId === 'dir-1'),
    'the update is addressed to the task directory');
  assert.ok(updates.every(u => u.payload.taskIds.includes('task-n')));
});

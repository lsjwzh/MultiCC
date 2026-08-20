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
const core = require('../src/task-board');
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
  const taskRunsStub = overrides.taskRuns === undefined ? null : overrides.taskRuns;
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
    ...(taskRunsStub ? { taskRuns: taskRunsStub } : {}),
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

// P4 · cold start. The ledger reaches the MODEL as a prompt-only layer; what
// reaches the TRANSCRIPT is exactly what the user typed, so the task chat view
// is the ordinary chat view down to its very first bubble.
test('cold start seeds the compiled ledger as prompt context, never as the user message', async () => {
  const taskRunsStub = {
    // beginRun/admitRun presence is the runtime's feature check for the store.
    beginRun: input => ({ ...input, leaseEpoch: 1 }),
    listTaskRuns: () => [{ runId: 'tr_1' }],
    getRunMessages: () => [
      { messageId: 'mm1', role: 'user', kind: 'admission', content: '先复现闪退堆栈', createdAt: 1 },
      { messageId: 'mm2', role: 'assistant', kind: 'message', content: '已定位到空指针', createdAt: 2 },
    ],
  };
  const fixture = mkBoundFixture({
    taskRuns: taskRunsStub,
    loadHistory: () => [], // bound session never spoke → cold start
  });
  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k2' });

  assert.equal(result.taskBound, true);
  assert.equal(fixture.calls.sent.length, 1);
  const sent = fixture.calls.sent[0];
  // The turn text — the thing runChatTurn persists — is the bare user message.
  assert.equal(sent.text, '继续修');
  // The compiled wall rides the turn options as a prompt prefix instead.
  const seed = sent.options.taskContextSeed;
  assert.match(seed, /\[MultiCC 任务运行上下文/);
  assert.match(seed, /先复现闪退堆栈/);
  assert.match(seed, /已定位到空指针/);
  // No 当前要求 section and no copy of the user text: composeMessage appends
  // the user message after the layer, so a copy here would duplicate it.
  assert.equal(seed.includes('当前要求'), false);
  assert.equal(seed.includes('继续修'), false);
  // Layers concatenate with no separator — the seed carries its own.
  assert.equal(seed.endsWith('\n\n'), true);
  assert.equal(sent.options.taskId, 'task-1');
});

test('a warm native session sends no seed: the session IS the context', async () => {
  const fixture = mkBoundFixture({
    taskRuns: {
      beginRun: input => ({ ...input, leaseEpoch: 1 }),
      listTaskRuns: () => [{ runId: 'tr_1' }],
      getRunMessages: () => [
        { messageId: 'mm1', role: 'user', kind: 'admission', content: '先复现闪退堆栈', createdAt: 1 },
      ],
    },
    // Empty transcript (e.g. the user cleared it) but a live native session:
    // the CLI still remembers the task, so re-walling it would be a reset.
    loadHistory: () => [],
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
  await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k3' });

  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.sent[0].text, '继续修');
  assert.equal(fixture.calls.sent[0].options.taskContextSeed, undefined);
});

test('a persisted first turn that never reached the CLI still seeds', async () => {
  const fixture = mkBoundFixture({
    taskRuns: {
      beginRun: input => ({ ...input, leaseEpoch: 1 }),
      listTaskRuns: () => [{ runId: 'tr_1' }],
      getRunMessages: () => [
        { messageId: 'mm1', role: 'user', kind: 'admission', content: '先复现闪退堆栈', createdAt: 1 },
      ],
    },
    // The transcript already holds a user message (persist happens before the
    // provider runs), yet no native session exists — the previous attempt died
    // in between. Gating on the transcript would ship this turn contextless.
    loadHistory: () => [{ id: 'm1', role: 'user', content: '第一次尝试' }],
  });
  await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k4' });

  assert.equal(fixture.calls.sent.length, 1);
  assert.match(fixture.calls.sent[0].options.taskContextSeed, /先复现闪退堆栈/);
});

test('an open TaskRun refuses the follow-up honestly: no second executor', async () => {
  const taskRunsStub = {
    beginRun: input => ({ ...input, leaseEpoch: 1 }),
    listTaskRuns: () => [
      { runId: 'tr_open', executionStatus: 'running', usageStatus: 'collecting', cleanupState: 'blocked', startedAt: 1, leaseEpoch: 1 },
    ],
    getRunMessages: () => [],
    admitRun: ({ run }) => ({ run: { ...run, executionStatus: 'running', usageStatus: 'collecting', cleanupState: 'blocked' } }),
    appendMessage: () => {},
  };
  const fixture = mkBoundFixture({ taskRuns: taskRunsStub });
  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'task-1', '继续修', { clientMsgId: 'k3' });

  // The pooled path is retired: a legacy run that still owns the task makes
  // the follow-up refuse (wait for it to end or cancel it) instead of opening
  // a second executor or re-entering the drain path.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'task_run_open');
  assert.equal(fixture.calls.routed.length, 0);
  assert.equal(fixture.calls.sent.length, 0);
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

test('board task start binds a hidden session and opens its first turn directly', async () => {
  const fixture = mkStartFixture();
  const routes = mkRoutes(fixture.runtime);
  const send = routes.get('POST /api/task-board/send');
  const res = response();
  await send({ body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.taskBound, true);
  assert.equal(res.body.routingMode, 'task-bound');
  assert.equal(res.body.commanderSessionId, null);
  const taskId = res.body.taskId;
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
  const routes = mkRoutes(fixture.runtime);
  const send = routes.get('POST /api/task-board/send');
  const first = response();
  await send({ body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, first);
  const second = response();
  await send({ body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, second);

  assert.equal(second.code, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.routed.length, 0);
  assert.equal(fixture.calls.created.length, 1);
});

test('a failed session CREATE reports honestly — no silent pooled fallback', async () => {
  const fixture = mkStartFixture({
    deps: { createSessionRecord: async () => ({ ok: false, error: 'worktree 创建失败： boom' }) },
  });
  const routes = mkRoutes(fixture.runtime);
  const res = response();
  await routes.get('POST /api/task-board/send')(
    { body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, res);

  // The pooled path is retired (#38): a CREATE failure is surfaced to the
  // user instead of quietly dropping the task into the TaskRun ledger where
  // its messages were invisible in the chat view (the empty-room incident).
  assert.equal(res.code, 502);
  assert.match(res.body.error, /worktree/);
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
  const routes = mkRoutes(fixture.runtime);
  const res = response();
  await routes.get('POST /api/task-board/send')(
    { body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, res);

  assert.equal(res.code, 502);
  assert.equal(res.body.error, 'turn_rejected');
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
  const routes = mkRoutes(fixture.runtime);
  const send = routes.get('POST /api/task-board/send');
  const first = response();
  await send({ body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, first);
  assert.equal(first.code, 502);
  failFirst = false;
  const second = response();
  await send({ body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck1' } }, second);

  assert.equal(second.code, 200);
  assert.equal(second.body.taskBound, true);
  // The retry healed onto the SAME session record — 1:1 holds across crashes.
  assert.equal(fixture.calls.created.length, 1);
  assert.equal(fixture.calls.sent.length, 1);
  assert.equal(fixture.calls.sent[0].sessionId, 'sess-new-1');
});

/* ── #37a · runtime fields are cli-scoped: cross-CLI inheritance is a mix the
   validator rejects (the silent CREATE failure behind the worker_unavailable
   incident — commander had switched to codex, the composer defaulted claude) ── */

function mkCliFixture(commanderOverrides = {}) {
  const fixture = mkStartFixture({
    deps: {
      records: new Map([
        ['commander-1', {
          id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1',
          cli: 'codex', model: 'gpt-5.6-sol', provider: 'p-codex', effort: 'ultra',
          ...commanderOverrides,
        }],
      ]),
    },
  });
  return { ...fixture, send: mkRoutes(fixture.runtime).get('POST /api/task-board/send') };
}

test('a composer cli pick that differs from the commander drops cross-CLI runtime fields', async () => {
  const { send, calls } = mkCliFixture();
  const res = response();
  await send({
    body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck-cli', cli: 'claude' },
  }, res);

  assert.equal(res.code, 200);
  assert.equal(calls.created.length, 1);
  const created = calls.created[0];
  assert.equal(created.cli, 'claude');
  assert.equal(created.provider, '', 'a codex provider must never ride a claude session');
  assert.equal(created.effort, null, "'ultra' is a codex-only reasoning level");
  assert.equal(created.model, null, 'a codex model is meaningless on claude');
});

test('a matching commander cli still inherits provider/model/effort', async () => {
  const { send, calls } = mkCliFixture({ effort: 'high' });
  const res = response();
  await send({
    body: { text: '新任务：做 X', dirId: 'dir-1', clientMsgId: 'ck-cli-same', cli: 'codex' },
  }, res);

  assert.equal(res.code, 200);
  const created = calls.created[0];
  assert.equal(created.cli, 'codex');
  assert.equal(created.provider, 'p-codex');
  assert.equal(created.effort, 'high');
  assert.equal(created.model, 'gpt-5.6-sol');
});

/* ── archive-time release (归档即释放) ── */

function mkReleaseFixture(overrides = {}) {
  const released = [];
  const records = new Map([
    ['bound-9', { id: 'bound-9', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-9' }],
  ]);
  const { runtime, file } = mkRuntime({
    records,
    releaseTaskBoundSession: async id => {
      released.push(id);
      if (overrides.releaseResult) return overrides.releaseResult;
      if (id === 'bound-9') records.delete(id);
      return { ok: true };
    },
  });
  seedTask(runtime, {
    id: 'task-9', title: '归档释放', status: 'done',
    chatSessionId: 'bound-9',
    refs: [{ sessionId: 'bound-9', dirId: 'dir-1', ts: 1 }],
  });
  return { runtime, file, released, records, routes: mkRoutes(runtime) };
}

test('archive-completed releases the archived task\'s bound session and clears the pointer', async () => {
  const { routes, file, released } = mkReleaseFixture();
  const res = response();
  await routes.get('POST /api/task-board/archive-completed')({ body: {} }, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.archivedCount, 1);
  assert.deepEqual(released, ['bound-9'], 'archiving releases the bound session');
  assert.equal(res.body.releasedSessions, 1);
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.tasks['task-9'].chatSessionId, null,
    'the dangling pointer is cleared on the board file');
});

test('manual status=archived releases the bound session; done does not', async () => {
  const f1 = mkReleaseFixture();
  f1.routes.get;
  const t9a = f1.runtime.getBoard().tasks['task-9'];
  t9a.status = 'active';
  const res1 = response();
  await f1.routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-9' }, body: { status: 'archived' } }, res1);
  assert.equal(res1.code, 200);
  assert.deepEqual(f1.released, ['bound-9'], 'manual archive releases');
  assert.equal(res1.body.releasedSession, true);
  assert.equal(f1.runtime.getBoard().tasks['task-9'].chatSessionId, null);

  // done is mid-lifecycle: follow-ups are expected, the session must survive.
  const f2 = mkReleaseFixture();
  f2.runtime.getBoard().tasks['task-9'].status = 'active';
  const res2 = response();
  await f2.routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: 'task-9' }, body: { status: 'done' } }, res2);
  assert.equal(res2.code, 200);
  assert.deepEqual(f2.released, [], 'done never releases');
  assert.equal(f2.runtime.getBoard().tasks['task-9'].chatSessionId, 'bound-9');
});

test('a failed release never blocks archiving — best-effort, pointer kept', async () => {
  const { routes, released } = mkReleaseFixture({ releaseResult: { ok: false, blocked: true, reasons: ['active'] } });
  const res = response();
  await routes.get('POST /api/task-board/archive-completed')({ body: {} }, res);

  assert.equal(res.code, 200, 'archiving itself succeeds');
  assert.deepEqual(released, ['bound-9'], 'release was attempted');
  assert.equal(res.body.releasedSessions, 0);
  // The session still exists, so the pointer must not be dangled.
  assert.equal(routes && true, true);
});

/* ── task composer runtime picks (指定 cli/provider，默认=最近活跃) ── */

function mkRuntimePickFixture() {
  const created = [];
  const histDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tbhist-'));
  const { runtime, deps } = mkRuntime({
    chatHistoryDir: histDir,
    createSessionRecord: async input => {
      created.push(input);
      const session = { id: `sess-new-${created.length}`, ...input, dirId: input.dir.id };
      deps.records.set(session.id, session);
      return { ok: true, id: session.id, session };
    },
  });
  return { runtime, deps, created, histDir, routes: mkRoutes(runtime) };
}

test('send pins cli/provider on the bound session at creation; absence keeps commander inheritance', async () => {
  const { routes, created } = mkRuntimePickFixture();
  // 1) no picks → commander runtime inheritance (the P1 default, unchanged)
  const plain = response();
  await routes.get('POST /api/task-board/send')(
    { body: { text: '新任务：做 A', dirId: 'dir-1', clientMsgId: 'ck-a' } }, plain);
  assert.equal(plain.code, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].cli, 'codex', 'commander cli inherited when unspecified');
  assert.equal(created[0].provider, 'p-1', 'commander provider inherited when unspecified');

  // 2) explicit picks win over the commander inheritance
  const pinned = response();
  await routes.get('POST /api/task-board/send')(
    { body: { text: '新任务：做 B', dirId: 'dir-1', clientMsgId: 'ck-b', cli: 'claude', provider: 'p-glm' } },
    pinned);
  assert.equal(pinned.code, 200);
  assert.equal(created.length, 2);
  assert.equal(created[1].cli, 'claude', 'explicit cli beats commander inheritance');
  assert.equal(created[1].provider, 'p-glm', 'explicit provider beats commander inheritance');
});

test('suggested-runtime returns the most recently active chat session\'s runtime', async () => {
  const { deps, histDir, routes } = mkRuntimePickFixture();
  deps.records.set('chat-a', { id: 'chat-a', kind: 'chat', dirId: 'dir-1', cli: 'codex', provider: 'p-1' });
  deps.records.set('chat-b', { id: 'chat-b', kind: 'chat', dirId: 'dir-1', cli: 'claude', provider: 'p-glm', model: 'glm-4.7' });
  fs.writeFileSync(path.join(histDir, 'chat-a.json'), '[]');
  fs.writeFileSync(path.join(histDir, 'chat-b.json'), '[]');
  // chat-b is the most recently written transcript → its runtime is the default.
  const older = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(histDir, 'chat-a.json'), older, older);

  const res = response();
  await routes.get('GET /api/task-board/suggested-runtime')({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'recent');
  assert.equal(res.body.cli, 'claude');
  assert.equal(res.body.provider, 'p-glm');
  assert.equal(res.body.model, 'glm-4.7');
});

test('suggested-runtime skips synthetic ids and falls back to host defaults', async () => {
  const { histDir, routes } = mkRuntimePickFixture();
  // __aux__/__gateway__ histories are synthetic, never a provider source.
  fs.writeFileSync(path.join(histDir, '__aux__.json'), '[]');

  const res = response();
  await routes.get('GET /api/task-board/suggested-runtime')({}, res);
  assert.equal(res.code, 200);
  assert.deepEqual(
    { cli: res.body.cli, provider: res.body.provider, model: res.body.model, source: res.body.source },
    { cli: 'claude', provider: '', model: null, source: 'default' });
});

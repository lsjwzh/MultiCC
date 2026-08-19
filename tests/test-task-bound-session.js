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

  // The record disappears (manual cleanup / GC bug): the next call HEALS the
  // binding instead of 404ing forever.
  deps.records.delete('sess-new-1');
  res = response();
  await handler({ params: { taskId: 'task-1' }, body: {} }, res);
  assert.equal(res.body.sessionId, 'sess-new-2');
  assert.equal(res.body.created, true);
  assert.equal(creates, 2);
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

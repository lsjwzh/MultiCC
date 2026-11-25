'use strict';

// 宿主端口（host port）：POST /api/__host/task-routes。
//
// 任务面 16 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/task_routes.rs，规则在 native/core/src/task_routes.rs，
// 集成测试在 native/gateway/tests/task_routes.rs）。路径匹配、参数解码、
// planning 的 `{ok,task,revision}` 信封与错误→状态码阶梯、保留策略排序、
// mark-achieved 的 eligibility 阶梯、`meta.durationMs` 插入都在 Rust。
// Node 只剩运行时事实与副作用，所以本文件只断言 op 映射、回环闸门与错误信封。

const test = require('node:test');
const assert = require('node:assert/strict');
const { responseStatus } = require('../src/routes/task-planning');

const { mountTaskRoutesHostRoute, HOST_PATH } = require('../src/routes/task-routes-host');

function fakeDeps(overrides = {}) {
  const calls = [];
  const record = (name, ...args) => { calls.push([name, ...args]); };
  // 退休处理器照旧写 `res.status(...).json(...)`；宿主端口只捕获，不取返回值。
  const render = (res, status, body) => { res.status(status).json(body); };
  const envelope = context => ({ ok: true, task: { id: context.taskId || 'tk-new' }, revision: 2 });
  const ports = {};
  for (const name of ['planningCreate', 'planningUpdate', 'planningRename', 'planningMove']) {
    ports[name] = (context, res) => { record(name, context); render(res, 200, envelope(context)); };
  }
  ports.retentionPreview = (context, res) => {
    record('retentionPreview', context);
    render(res, 200, { ok: true, limit: 100, count: 1, maxBatch: 100,
      tasks: [{ id: 'tk-1', title: 'Old', lastInteractionAt: 123 }] });
  };
  ports.retentionDelete = (context, res) => {
    record('retentionDelete', context);
    render(res, 200, { ok: true, deleted: ['tk-1'], skipped: [], count: 1, limit: 100 });
  };
  for (const name of ['status', 'delete', 'relocate', 'chatSession']) {
    ports[name] = (context, res) => {
      record(name, context);
      render(res, 200, { ok: true, ...context.body });
    };
  }
  const deps = {
    ports,
    search: {
      searchBoard: query => { record('searchBoard', query); return { status: 200, body: { results: [{ taskId: 't1' }] } }; },
      messageScope: () => { record('messageScope'); return { warming: false, scope: 'all' }; },
      findMessages: request => { record('findMessages', request); return [{ sessionId: 's1' }]; },
    },
    taskGoal: {
      facts: taskId => { record('facts', taskId); return { found: true, goalState: 'interact', classifyState: 'D', streaming: false, sessionId: 's1' }; },
      write: (taskId, sessionId) => { record('write', taskId, sessionId); return { ok: true, taskId }; },
    },
    taskGraph: {
      buildHostGraph: dirId => { record('buildHostGraph', dirId); return { graph: { nodes: [], edges: [] } }; },
    },
    attributionMode: () => { record('attributionMode'); return 'suggest'; },
    ...overrides,
  };
  return { deps, calls, render };
}

function createApp() {
  const routes = new Map();
  const app = {};
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return { app, routes };
}

function mount(options = {}) {
  const { deps, calls, render } = fakeDeps(options.deps);
  const { app, routes } = createApp();
  mountTaskRoutesHostRoute(app, { isLocal: () => true, ...deps, ...options.mount });
  const handler = routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing route POST ${HOST_PATH}`);
  return { handler, calls, deps, render };
}

function respond(handler, body) {
  let settle;
  const responded = new Promise(resolve => { settle = resolve; });
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; settle(this); return this; },
  };
  handler({ body }, res);
  return responded;
}

test('the host port rejects a request forwarded from a real client', async () => {
  const { app, routes } = createApp();
  mountTaskRoutesHostRoute(app, {
    isLocal: () => false, ...fakeDeps().deps,
  });
  const res = await respond(routes.get(`POST ${HOST_PATH}`), { op: 'attribution-mode' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not found' });
});

test('an unknown or malformed body is a 400, never a silent success', async () => {
  const { handler } = mount();
  for (const body of [{ op: 'nope' }, {}, null, []]) {
    const res = await respond(handler, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error: 'unknown host operation' });
  }
});

test('every op maps to exactly one Node fact and the front door keeps the envelope', async () => {
  const { handler, calls } = mount();
  const ok = async (body, value) => {
    calls.length = 0;
    const res = await respond(handler, body);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, value });
    return calls;
  };
  // planning：成功交 {task, revision}，Rust 装上 `{ok:true}` 信封。
  await ok({ op: 'planning-create', body: { title: 'New' } }, { task: { id: 'tk-new' }, revision: 2 });
  assert.deepEqual(calls, [['planningCreate', { body: { title: 'New' } }]]);
  await ok({ op: 'planning-update', taskId: 'tk-1', body: { title: 'x' } }, { task: { id: 'tk-1' }, revision: 2 });
  await ok({ op: 'planning-alias', taskId: 'tk-1', body: { title: 'x' } }, { task: { id: 'tk-1' }, revision: 2 });
  await ok({ op: 'planning-rename', taskId: 'tk-1', body: { title: 'x' } }, { task: { id: 'tk-1' }, revision: 2 });
  await ok({ op: 'planning-move', taskId: 'tk-1', body: { workflowStage: 'done' } }, { task: { id: 'tk-1' }, revision: 2 });

  // 保留策略：只交出 Rust 需要的字段，`at` 由 Rust 投影成 lastInteractionAt。
  await ok({ op: 'retention-preview', dirId: 'dir-1' },
    { limit: 100, count: 1, maxBatch: 100, entries: [{ id: 'tk-1', title: 'Old', at: 123 }], idOrder: ['tk-1'] });
  await ok({ op: 'retention-delete', dirId: 'dir-1', taskIds: ['tk-1'] },
    { deleted: ['tk-1'], skipped: [], count: 1, limit: 100 });

  // status/delete/relocate/chat-session 直接把渲染好的 reply 交给 Rust。
  await ok({ op: 'task-status', taskId: 'tk-1', body: { status: 'archived' } },
    { reply: { status: 200, body: { ok: true, status: 'archived' } } });
  await ok({ op: 'task-delete', taskId: 'tk-1', body: { revision: 2 } },
    { reply: { status: 200, body: { ok: true, revision: 2 } } });
  await ok({ op: 'task-relocate', taskId: 'tk-1', body: { dirId: 'dir-2' } },
    { reply: { status: 200, body: { ok: true, dirId: 'dir-2' } } });
  await ok({ op: 'task-chat-session', taskId: 'tk-1' },
    { reply: { status: 200, body: { ok: true } } });

  await ok({ op: 'search-board', query: 'q', limit: 5, minScore: null },
    { results: [{ taskId: 't1' }] });
  assert.deepEqual(calls, [['searchBoard', { query: 'q', limit: 5, dirId: null, dirIds: null, statuses: null, minScore: Infinity }]]);
  await ok({ op: 'search-messages-scope' }, { warming: false, scope: 'all' });
  await ok({ op: 'search-messages', query: 'q' }, { results: [{ sessionId: 's1' }] });

  // mark-achieved：事实与写入是两个 op，阶梯在 Rust。
  await ok({ op: 'mark-achieved-facts', taskId: 'tk-1' },
    { found: true, goalState: 'interact', classifyState: 'D', streaming: false, sessionId: 's1' });
  await ok({ op: 'mark-achieved-write', taskId: 'tk-1', sessionId: 's1' }, { ok: true, taskId: 'tk-1' });

  await ok({ op: 'task-graph', dirId: 'dir-1' }, { graph: { nodes: [], edges: [] } });
  await ok({ op: 'attribution-mode' }, { mode: 'suggest' });

  // 错误一律是 value，由 Rust 决定最终状态码与正文。
  const refusal = { status: 409, body: { error: 'task_busy' } };
  const refuse = (context, res) => { res.status(refusal.status).json(refusal.body); };
  const refused = mount({ deps: { ports: { ...fakeDeps().deps.ports, delete: refuse } } });
  const res = await respond(refused.handler, { op: 'task-delete', taskId: 'tk-1' });
  assert.deepEqual(res.body, { ok: true, value: { reply: refusal } });
});

test('a planning refusal on the ladder is an outcome, not a rendered reply', async () => {
  const { deps } = fakeDeps();
  // `task_not_found` → 404 由 responseStatus 决定；同一状态码的拒绝交 outcome，
  // 让 Rust 用同一阶梯重算，不把 Node 的口径搬过去。
  const refused = (context, res) => { res.status(404).json({ error: 'task_not_found', taskId: 'tk-ghost' }); };
  const { handler } = mount({
    deps: { ports: { ...deps.ports, planningUpdate: refused, planningCreate: refused,
      planningRename: refused, planningMove: refused } },
  });
  const res = await respond(handler, { op: 'planning-update', taskId: 'tk-ghost', body: {} });
  assert.deepEqual(res.body, { ok: true, value: { outcome: { error: 'task_not_found', taskId: 'tk-ghost' } } });
});

test('planning errors use exact string codes and preserve explicit host refusals', async () => {
  assert.equal(responseStatus('persistence_failed'), 500);
  assert.equal(responseStatus('revision_conflict'), 409);
  assert.equal(responseStatus('task_not_found'), 404);
  for (const code of [null, Symbol('task_not_found'), Object('task_not_found'),
    { toString() { throw new Error('unexpected conversion'); } }, 'task_not_found\0',
    'TASK_NOT_FOUND', '__proto__', 'constructor']) {
    assert.equal(responseStatus(code), 400);
  }
  const { deps } = fakeDeps();
  const { handler } = mount({ deps: { ports: { ...deps.ports,
    planningUpdate: (_ctx, res) => res.status(423).json({ error: 'task_not_found' }),
  } } });
  const res = await respond(handler, { op: 'planning-update', taskId: 'locked', body: {} });
  assert.deepEqual(res.body.value, { reply: { status: 423, body: { error: 'task_not_found' } } });
});

test('mark-achieved write failures keep the retired handler envelope', async () => {
  const { deps } = fakeDeps();
  const thrower = error => () => { throw error; };
  const notApplicable = mount({
    deps: { taskGoal: { ...deps.taskGoal, write: thrower(Object.assign(new Error('只有需要交互的任务才能标记达成目标'), { status: 409, code: 'mark_achieved_not_applicable' })) } },
  });
  let res = await respond(notApplicable.handler, { op: 'mark-achieved-write', taskId: 'tk-1', sessionId: 's1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, value: { reply: { status: 409, body: {
    ok: false, code: 'mark_achieved_not_applicable', message: '只有需要交互的任务才能标记达成目标',
  } } } });

  const internal = mount({
    deps: { taskGoal: { ...deps.taskGoal, write: thrower(new Error('setTaskState exploded')) } },
  });
  res = await respond(internal.handler, { op: 'mark-achieved-write', taskId: 'tk-1', sessionId: 's1' });
  assert.deepEqual(res.body, { ok: true, value: { reply: { status: 500, body: {
    ok: false, code: 'mark_achieved_failed', message: 'Request failed',
  } } } });
});

test('message search without a runtime is a 503 refusal and thrown ops are logged 500s', async () => {
  const { deps } = fakeDeps();
  const { handler } = mount({
    deps: { search: {
      ...deps.search,
      searchBoard: () => ({ status: 503, body: { error: 'message_search_unavailable' } }),
      findMessages: () => { throw new Error('index is closed'); },
    } },
  });
  let res = await respond(handler, { op: 'search-board', query: 'q' });
  assert.deepEqual(res.body, { ok: true, value: { reply: { status: 503, body: { error: 'message_search_unavailable' } } } });
  res = await respond(handler, { op: 'search-messages', query: 'q' });
  assert.deepEqual(res.body, { ok: true, value: { reply: { status: 503, body: { error: 'message_search_unavailable' } } } });

  const logged = [];
  const boom = mount({
    deps: { attributionMode: () => { throw new Error('settings unreadable'); } },
    mount: { logger: undefined },
  });
  // 端口内部抛错（而不是返回 reply）是真正的 bug：标准输出记一行，回 500。
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    res = await respond(boom.handler, { op: 'attribution-mode' });
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'internal_error' });
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /attribution-mode failed/);
});

test('dependencies are validated at mount time', () => {
  const { deps } = fakeDeps();
  assert.throws(() => mountTaskRoutesHostRoute(createApp().app, {}), /dependency missing: ports/);
  assert.throws(() => mountTaskRoutesHostRoute(createApp().app, { ports: {} }), /dependency missing: search/);
  assert.throws(() => mountTaskRoutesHostRoute(createApp().app, {
    ports: {}, search: { searchBoard() {} },
  }), /dependency missing: taskGoal/);
  assert.throws(() => mountTaskRoutesHostRoute(createApp().app, {
    ports: {}, search: { searchBoard() {} }, taskGoal: { facts() {} },
  }), /dependency missing: taskGraph/);
  assert.throws(() => mountTaskRoutesHostRoute(createApp().app, {
    ports: {}, search: { searchBoard() {} }, taskGoal: { facts() {} },
    taskGraph: { buildHostGraph() {} },
  }), /dependency missing: attributionMode/);
  assert.equal(typeof deps, 'object');
});

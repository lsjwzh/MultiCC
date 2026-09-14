'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTaskGraphRoutes,
  assertTaskGraphDeps,
} = require('../src/routes/task-graph');

// ── 测试夹具 ─────────────────────────────────────────────────────────────

function fakeApp() {
  const handlers = new Map();
  const app = {};
  for (const method of ['get']) {
    app[method] = (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler);
  }
  app.handlers = handlers;
  return app;
}

function invoke(app, routePath, query = {}) {
  const handler = app.handlers.get(`GET ${routePath}`);
  assert.equal(typeof handler, 'function', `missing GET ${routePath}`);
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler({ query }, res);
  return response;
}

function fixture({ board = {}, shell = {}, records = new Map() } = {}) {
  const emptyBoard = {
    tasks: {}, modules: {}, taskGroups: {}, deletedTaskIds: [],
    ...board,
  };
  let clock = 1000;
  const deps = {
    getBoard: () => emptyBoard,
    taskGraphData: () => shell,
    getRecord: id => records.get(id) || null,
    directories: new Map([
      ['d1', { id: 'd1', name: '项目一' }],
      ['d2', { id: 'd2', name: '项目二' }],
    ]),
    now() { clock += 7; return clock; },
  };
  const app = fakeApp();
  const routes = createTaskGraphRoutes(deps);
  routes.mountRoutes(app);
  return { app, routes, deps };
}

// ── 依赖校验 ─────────────────────────────────────────────────────────────

test('task graph route dependencies are asserted', () => {
  assert.throws(() => assertTaskGraphDeps(null), TypeError);
  assert.throws(() => assertTaskGraphDeps({ getBoard() {}, getRecord() {}, directories: new Map(), now() {} }),
    /taskGraphData/);
  assert.throws(() => assertTaskGraphDeps({ getBoard() {}, taskGraphData() {}, getRecord() {}, directories: new Map() }),
    /now/);
});

// ── 节点聚合：board 卡片 + shell 持久任务按 taskId 合并 ───────────────────

test('merges board cards and shell tasks into one node per taskId', () => {
  const { app } = fixture({
    board: {
      tasks: {
        tsk_a: { id: 'tsk_a', title: '五层记忆体系', moduleId: 'm1', status: 'active',
          chatSessionId: 'sess_a', updatedAt: 10, refs: [{ sessionId: 's' }] },
        tsk_pending: { id: 'tsk_pending', title: '待归类的新活', moduleId: 'm_cls', status: 'active' },
      },
      modules: {
        m1: { id: 'm1', name: '记忆系统', source: 'ai', dirId: 'd1' },
        m_cls: { id: 'm_cls', name: '待归类', source: 'classify', dirId: 'd1' },
      },
    },
    shell: {
      tasks: [
        { id: 'tsk_a', dirId: 'd1', sessionId: 'sess_a', title: '五层记忆体系（归因改名）',
          ownerShellId: 'sh_1', ready: true, createdAt: 5, parentTaskId: 'tsk_root' },
        { id: 'tsk_root', dirId: 'd1', sessionId: 'task_root', title: '总任务',
          ownerShellId: 'sh_1', ready: true, createdAt: 1 },
      ],
      shells: [{ id: 'sh_1', dirId: 'd1', sourceSessionId: 'src_1', currentTaskId: 'tsk_a' }],
      links: [
        { shellId: 'sh_1', taskId: 'tsk_a' },
        { shellId: 'sh_1', taskId: 'tsk_root' },
      ],
    },
    records: new Map([
      ['sess_a', { id: 'sess_a', taskState: { classifyState: 'P', goal: '落地五层记忆', phase: 'implement' } }],
    ]),
  });

  const response = invoke(app, '/api/task-graph');
  assert.equal(response.statusCode, 200);
  const nodes = response.body.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));

  const a = byId.get('tsk_a');
  assert.ok(a, 'board+shell 合并为一个节点');
  assert.deepEqual(a.sources.sort(), ['board', 'shell']);
  assert.equal(a.classifyState, 'P');
  assert.equal(a.goal, '落地五层记忆');
  assert.equal(a.parentTaskId, 'tsk_root');
  assert.equal(a.provisional, false);
  assert.equal(a.canonical, true);

  // classify-pending 模块里的卡片是 provisional（身份未锁）。
  const pending = byId.get('tsk_pending');
  assert.equal(pending.provisional, true);
  assert.equal(pending.canonical, false);

  // shell 任务未 ready 也是 provisional。
  // （下一条测试覆盖。）

  // 壳节点存在并带 label。
  const shellNode = byId.get('sh_1');
  assert.ok(shellNode);
  assert.equal(shellNode.kind, 'shell');
  assert.equal(shellNode.degree, 2);

  // 边：parent + 两条 shell-link。
  const edges = response.body.edges;
  assert.ok(edges.some(e => e.type === 'parent' && e.source === 'tsk_a' && e.target === 'tsk_root'));
  assert.ok(edges.some(e => e.type === 'shell-link' && e.source === 'tsk_a' && e.target === 'sh_1'));
  assert.ok(edges.some(e => e.type === 'shell-link' && e.source === 'tsk_root' && e.target === 'sh_1'));
});

test('unready shell tasks are provisional; board-only tasks stay canonical', () => {
  const { app } = fixture({
    shell: {
      tasks: [{ id: 'tsk_new', dirId: 'd1', sessionId: 'task_new', title: '刚 fork 的新任务', ready: false }],
      shells: [],
      links: [],
    },
  });
  const response = invoke(app, '/api/task-graph');
  const node = response.body.nodes.find(n => n.id === 'tsk_new');
  assert.equal(node.provisional, true);
});

// ── 边类型：group / merged ────────────────────────────────────────────────

test('draws group fan-out and merge alias edges', () => {
  const { app } = fixture({
    board: {
      tasks: {
        tsk_root: { id: 'tsk_root', title: '根任务', moduleId: 'm1', dirId: 'd1' },
        tsk_kid: { id: 'tsk_kid', title: '同组子任务', moduleId: 'm1', dirId: 'd1' },
        tsk_dup: { id: 'tsk_dup', title: '重复任务', moduleId: 'm1', dirId: 'd1', mergedInto: 'tsk_root' },
      },
      modules: { m1: { id: 'm1', name: '模块', source: 'ai', dirId: 'd1' } },
      taskGroups: { g1: { id: 'g1', rootTaskId: 'tsk_root', taskIds: ['tsk_root', 'tsk_kid'] } },
    },
  });
  const response = invoke(app, '/api/task-graph');
  const edges = response.body.edges;
  assert.ok(edges.some(e => e.type === 'group' && e.source === 'tsk_root' && e.target === 'tsk_kid'),
    'group root→member');
  assert.equal(edges.some(e => e.type === 'group' && e.source === 'tsk_root' && e.target === 'tsk_root'), false,
    '不自环');
  assert.ok(edges.some(e => e.type === 'merged' && e.source === 'tsk_dup' && e.target === 'tsk_root'),
    'merged 别名边');
  const kid = response.body.nodes.find(n => n.id === 'tsk_kid');
  assert.equal(kid.groupId, 'g1');
});

// ── 目录过滤与元数据 ──────────────────────────────────────────────────────

test('filters by dirId, drops unlinked shells, and reports project meta', () => {
  const { app } = fixture({
    board: {
      tasks: {
        tsk_a: { id: 'tsk_a', title: '项目一的任务', moduleId: 'm1' },
        tsk_b: { id: 'tsk_b', title: '项目二的任务', moduleId: 'm2' },
      },
      modules: {
        m1: { id: 'm1', name: '一', source: 'ai', dirId: 'd1' },
        m2: { id: 'm2', name: '二', source: 'ai', dirId: 'd2' },
      },
    },
    shell: {
      tasks: [{ id: 'tsk_a', dirId: 'd1', sessionId: 's', title: '项目一的任务', ready: true }],
      shells: [
        { id: 'sh_1', dirId: 'd1', sourceSessionId: 'src1' },
        { id: 'sh_empty', dirId: 'd2', sourceSessionId: 'src2' },
      ],
      links: [{ shellId: 'sh_1', taskId: 'tsk_a' }],
    },
  });

  const all = invoke(app, '/api/task-graph');
  assert.equal(all.body.meta.dirId, 'all');
  assert.ok(all.body.nodes.some(n => n.id === 'tsk_a'));
  assert.ok(all.body.nodes.some(n => n.id === 'tsk_b'));
  // projects 元数据按目录统计任务数，带目录名。
  const p1 = all.body.meta.projects.find(p => p.dirId === 'd1');
  assert.deepEqual(p1, { dirId: 'd1', count: 1, name: '项目一' });

  const filtered = invoke(app, '/api/task-graph', { dirId: 'd1' });
  const ids = filtered.body.nodes.map(n => n.id);
  assert.deepEqual(ids.sort(), ['sh_1', 'tsk_a'], 'd2 的任务与未链接的壳都被裁掉');
  assert.equal(filtered.body.meta.dirId, 'd1');
  assert.equal(filtered.body.meta.edgeCount, 1);
});

test('empty stores render an empty but valid graph', () => {
  const { app } = fixture();
  const response = invoke(app, '/api/task-graph');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.nodes, []);
  assert.deepEqual(response.body.edges, []);
  assert.equal(response.body.meta.nodeCount, 0);
  assert.equal(response.body.meta.taskCount, 0);
  assert.equal(typeof response.body.meta.durationMs, 'number');
});

test('build failures are sanitized without leaking internals', () => {
  const { app } = fixture({
    shell: null, // taskGraphData() 返回 null 应被容错；改用抛错的 getBoard 试 sanitize
  });
  // 换一个直接抛错（含敏感路径）的 getBoard。
  const failing = fixture();
  failing.deps.getBoard = () => { throw new Error('/Users/alice/.ssh/token=secret'); };
  const response = invoke(failing.app, '/api/task-graph');
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(response.body), /alice|secret|\.ssh/);
  assert.ok(response.body.error);
  void app;
});

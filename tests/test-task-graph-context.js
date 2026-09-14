'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTaskGraphContext,
  createTaskGraphContextService,
  lastAssistantText,
} = require('../src/task-shell/task-graph-context');

// ── lastAssistantText：content 优先，超长/缺失时退到 evidenceExcerpt ─────────

test('lastAssistantText prefers content and falls back to evidenceExcerpt', () => {
  assert.equal(lastAssistantText({ messages: [
    { role: 'user', content: '问' },
    { role: 'assistant', evidenceExcerpt: '证据摘录' },
  ] }), '证据摘录');
  // 倒序找最后一条助手消息：content 在最后一条上就用 content。
  assert.equal(lastAssistantText({ messages: [
    { role: 'assistant', evidenceExcerpt: '更早的' },
    { role: 'assistant', content: '完整结论' },
  ] }), '完整结论');
  assert.equal(lastAssistantText({ messages: [{ role: 'user', content: 'x' }] }), '');
  assert.equal(lastAssistantText(null), '');
});

// ── ports 校验与空输入 ─────────────────────────────────────────────────────

test('missing ports or taskId degrade to empty string', () => {
  assert.equal(buildTaskGraphContext(null, { taskId: 't1' }), '');
  assert.equal(buildTaskGraphContext({ task() {}, boardTask() {}, groupOf() {}, linkedTaskIds() {}, snapshot() {}, readTaskMemory() {} }, {}), '');
  // 缺一个 port 就整体降级，不半注入。
  assert.equal(buildTaskGraphContext({ task() {}, boardTask() {}, groupOf() {}, linkedTaskIds() {}, snapshot() {} }, { taskId: 't1' }), '');
});

// ── 父任务（≤2 跳）+ 任务级记忆 ────────────────────────────────────────────

function basePorts(overrides = {}) {
  const tasks = {
    tsk_self: { id: 'tsk_self', dirId: 'd1', title: '当前任务' },
    tsk_parent: { id: 'tsk_parent', dirId: 'd1', title: '父任务', parentTaskId: 'tsk_grand' },
    tsk_grand: { id: 'tsk_grand', dirId: 'd1', title: '祖父任务' },
    ...overrides.tasks,
  };
  return {
    task: id => tasks[id] || null,
    boardTask: id => (overrides.board || {})[id] || null,
    groupOf: id => (overrides.groups || {})[id] || null,
    linkedTaskIds: id => (overrides.links || {})[id] || [],
    snapshot: id => (overrides.snapshots || {})[id] || null,
    readTaskMemory: (dirId, id) => (overrides.memory || {})[id] || '',
  };
}

test('renders parent memory and grandparent title within two hops', () => {
  const ports = basePorts({
    tasks: { tsk_self: { id: 'tsk_self', dirId: 'd1', title: '当前任务', parentTaskId: 'tsk_parent' } },
    memory: { tsk_parent: '父任务里沉淀的结论：接口已对齐，分支 multicc/x。' },
  });
  const text = buildTaskGraphContext(ports, { taskId: 'tsk_self' });
  assert.match(text, /\[任务图谱上下文｜/);
  assert.match(text, /父任务 父任务/);
  assert.match(text, /父任务记忆（节选）：.*接口已对齐/);
  assert.match(text, /祖父任务 祖父任务（仅标题）/);
  assert.match(text, /\[任务图谱上下文结束\]/);
  // 祖父只有标题行，不展开记忆。
  assert.doesNotMatch(text, /祖父.*记忆/);
});

// ── 同组任务摘要 ───────────────────────────────────────────────────────────

test('summarizes group members from board description or last ref excerpt', () => {
  const ports = basePorts({
    board: {
      tsk_a: { id: 'tsk_a', title: '同组A', description: '做了登录改造' },
      tsk_b: { id: 'tsk_b', title: '同组B', refs: [{ excerpt: '最后一条引用摘录' }] },
    },
    groups: { tsk_self: { taskIds: ['tsk_self', 'tsk_a', 'tsk_b'] } },
  });
  const text = buildTaskGraphContext(ports, { taskId: 'tsk_self' });
  assert.match(text, /同组 同组A：做了登录改造/);
  assert.match(text, /同组 同组B：最后一条引用摘录/);
});

// ── 同壳前序任务：handoff 快照的最后结论 ────────────────────────────────────

test('surfaces sibling conclusions from the latest handoff snapshot', () => {
  const ports = basePorts({
    tasks: {
      // 快照按时间追加，末尾即最新：应取 snap2 的长结论（截断），不是 snap1。
      tsk_prev: { id: 'tsk_prev', dirId: 'd1', title: '前序任务', handoffSnapshotIds: ['snap1', 'snap2'] },
    },
    links: { tsk_self: ['tsk_self', 'tsk_prev'] },
    snapshots: {
      snap1: { messages: [{ role: 'assistant', content: '旧结论' }] },
      snap2: { messages: [
        { role: 'assistant', content: '过长的结论'.repeat(200) },
        { role: 'user', content: '继续' },
      ] },
    },
  });
  const text = buildTaskGraphContext(ports, { taskId: 'tsk_self' });
  assert.match(text, /同壳前序 前序任务：/);
  // 从最新的快照（snap2 在前）取，且被截断到 CONCLUSION_CHARS。
  const line = text.split('\n').find(l => l.includes('同壳前序'));
  assert.ok(line.length < 400, '结论行被裁剪');
  assert.match(line, /…$/);
});

// ── 预算裁剪 ───────────────────────────────────────────────────────────────

test('tiny budget falls back to title-only lines with truncation note', () => {
  const ports = basePorts({
    tasks: { tsk_self: { id: 'tsk_self', dirId: 'd1', title: '当前任务', parentTaskId: 'tsk_parent' } },
    memory: { tsk_parent: '长记忆'.repeat(400) },
    board: { tsk_a: { title: '同组A', description: '描述'.repeat(100) } },
    groups: { tsk_self: { taskIds: ['tsk_self', 'tsk_a'] } },
  });
  const text = buildTaskGraphContext(ports, { taskId: 'tsk_self', tokenBudget: 10 });
  assert.match(text, /超出 token 预算，已截断/);
  // 兜底只剩标题行（第一行）。
  assert.match(text, /· 父任务 父任务/);
  assert.doesNotMatch(text, /长记忆/);
});

test('no adjacency at all returns empty string', () => {
  assert.equal(buildTaskGraphContext(basePorts(), { taskId: 'tsk_self' }), '');
});

// ── service 层：board + shell store + 记忆读取的组装 ────────────────────────

test('service wires board, shell tables and memory into ports', () => {
  const deps = {
    getBoard: () => ({
      tasks: {
        tsk_member: { id: 'tsk_member', title: '看板同组成员', description: '看板侧摘要', moduleId: 'm1', dirId: 'd1' },
      },
      modules: { m1: { id: 'm1', dirId: 'd1' } },
      taskGroups: { g1: { id: 'g1', rootTaskId: 'tsk_root', taskIds: ['tsk_root', 'tsk_self', 'tsk_member'] } },
    }),
    taskGraphData: () => ({
      tasks: [
        { id: 'tsk_self', dirId: 'd1', title: '当前任务', ready: true },
        { id: 'tsk_prev', dirId: 'd1', title: '同壳前序', handoffSnapshotIds: ['snap1'] },
      ],
      links: [
        { shellId: 'sh_1', taskId: 'tsk_self' },
        { shellId: 'sh_1', taskId: 'tsk_prev' },
      ],
      shells: [{ id: 'sh_1', dirId: 'd1' }],
    }),
    getSnapshot: id => (id === 'snap1'
      ? { messages: [{ role: 'assistant', content: '前序任务交付了图谱 API' }] }
      : null),
    readTaskMemory: () => '',
  };
  // service 用的是 ../task-board/core 的 relatedTaskGroup 做组归属，这里拿真实
  // 实现跑一遍：g1 包含 tsk_self，所以同组摘要应来自 board 卡。
  const contextOf = createTaskGraphContextService(deps);
  const text = contextOf('tsk_self');
  assert.match(text, /同壳前序 同壳前序：前序任务交付了图谱 API/);
  assert.match(text, /当前任务/);
});

test('service tolerates missing deps and throwing getters', () => {
  const contextOf = createTaskGraphContextService({
    getBoard: () => { throw new Error('boom'); },
    taskGraphData: () => { throw new Error('boom'); },
  });
  assert.equal(contextOf('tsk_any'), '');
});

// ── runtime 侧降级：taskGraphContext 缺失/抛错不会挡投递 ────────────────────

test('runtime-style degradation: absent or throwing port yields empty context', async () => {
  // 直接构造 runtime 太重；这里验证 service 工厂产物在抛错 deps 下仍返回 ''，
  // 以及 buildTaskGraphContext 对非字符串 taskId 的防御。
  const contextOf = createTaskGraphContextService({});
  assert.equal(contextOf('tsk_x'), '');
  assert.equal(contextOf(null), '');
});

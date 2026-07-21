'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/task-board');
const { createTaskBoardRuntime, assertTaskBoardDeps } = require('../src/routes/task-board');

// ── parseTagResult ──────────────────────────────────────────────────────────

test('parseTagResult accepts clean JSON and sanitizes entries', () => {
  const out = core.parseTagResult(JSON.stringify({
    tasks: [
      { id: 'new', title: '实现任务板后端', module: '服务端', areas: ['src/task-board.js', ''] },
      { id: 'tsk-x', areas: 'not-an-array' },
    ],
  }));
  assert.equal(out.tasks.length, 2);
  assert.deepEqual(out.tasks[0], {
    id: 'new', title: '实现任务板后端', module: '服务端', areas: ['src/task-board.js'],
  });
  assert.deepEqual(out.tasks[1], { id: 'tsk-x', title: '', module: '', areas: [] });
});

test('parseTagResult strips thinking blocks and code fences', () => {
  const fenced = '```json\n{"tasks":[{"id":"new","title":"修复登录","module":"前端 UI","areas":[]}]}\n```';
  assert.equal(core.parseTagResult(fenced).tasks[0].title, '修复登录');
  const think = '<think>废话</think>前置噪声 {"tasks":[{"id":"new","title":"A","module":"B","areas":[]}]} 尾巴';
  assert.equal(core.parseTagResult(think).tasks[0].title, 'A');
  const dsThink = '推理…<｜end▁of▁thinking｜>{"tasks":[]}';
  assert.deepEqual(core.parseTagResult(dsThink).tasks, []);
});

test('parseTagResult returns empty task list on garbage and caps entries', () => {
  assert.deepEqual(core.parseTagResult('对不起我无法输出 JSON').tasks, []);
  assert.deepEqual(core.parseTagResult('').tasks, []);
  assert.deepEqual(core.parseTagResult(null).tasks, []);
  const many = { tasks: Array.from({ length: 9 }, (_, i) => ({ id: 'new', title: `T${i}`, module: 'M', areas: [] })) };
  assert.equal(core.parseTagResult(JSON.stringify(many)).tasks.length, core.MAX_TAGS_PER_TURN);
});

// ── applyTagResult / aggregation ────────────────────────────────────────────

function mkRef(overrides = {}) {
  return {
    sessionId: 's1', dirId: 'd1', dirLabel: 'multicc',
    userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 1000, excerpt: '做点事',
    ...overrides,
  };
}

test('applyTagResult creates module and task, attaches the turn ref', () => {
  const board = core.createEmptyBoard();
  const touched = core.applyTagResult(board, [
    { id: 'new', title: '实现任务板', module: '服务端', areas: ['src/task-board.js'] },
  ], mkRef(), 2000);
  assert.equal(touched.length, 1);
  const task = board.tasks[touched[0]];
  assert.equal(task.title, '实现任务板');
  assert.equal(task.refs.length, 1);
  assert.equal(task.refs[0].assistantMsgId, 'ma1');
  const mod = board.modules[task.moduleId];
  assert.equal(mod.name, '服务端');
  assert.equal(mod.dirId, 'd1');
});

test('applyTagResult reuses module by normalized name and task by title', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [{ id: 'new', title: '修复登录', module: '前端 UI', areas: [] }], mkRef(), 1);
  core.applyTagResult(board, [{ id: 'new', title: '修复 登录', module: '前端UI', areas: [] }],
    mkRef({ assistantMsgId: 'ma2', userMsgId: 'mu2' }), 2);
  assert.equal(Object.keys(board.modules).length, 1);
  assert.equal(Object.keys(board.tasks).length, 1);
  assert.equal(Object.values(board.tasks)[0].refs.length, 2);
});

test('task title canonicalization merges same intent but preserves opposite actions', () => {
  assert.equal(
    core.canonicalTaskTitle('删除 [TikTok] 会话 和 WorkTree'),
    core.canonicalTaskTitle('清理 tiktok 会话与 worktree'),
  );
  assert.ok(core.taskTitleSimilarity('实现达人营销全流程管理系统后端', '设计达人营销全流程管理系统核心后端') >= 0.78);
  assert.ok(core.taskTitleSimilarity('删除 tiktok 会话', '恢复 tiktok 会话') < 0.78);
  assert.equal(core.taskTitleSimilarity('删除 tiktok 会话及其全部 worktree 和分支', '恢复 tiktok 会话及其全部 worktree 和分支'), 0);
});

test('applyTagResult merges similar tasks across modules in one directory only', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [
    { id: 'new', title: '删除 [tiktok] 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef(), 1);
  core.applyTagResult(board, [
    { id: 'new', title: '清理 tiktok 会话与 worktree', module: '会话管理', areas: [] },
  ], mkRef({ sessionId: 's2', userMsgId: 'mu2', assistantMsgId: 'ma2' }), 2);
  assert.equal(Object.keys(board.tasks).length, 1);
  assert.deepEqual(Object.values(board.tasks)[0].refs.map(r => r.sessionId), ['s1', 's2']);

  core.applyTagResult(board, [
    { id: 'new', title: '删除 tiktok 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef({ dirId: 'd2', sessionId: 'other', userMsgId: 'mu3', assistantMsgId: 'ma3' }), 3);
  assert.equal(Object.keys(board.tasks).length, 2);
});

test('addRefToTask upgrades an in-flight user ref with the final assistant id', () => {
  const task = { status: 'active', updatedAt: 1, refs: [] };
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: null, ts: 10 }), 10), true);
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: 'ma-final', ts: 20 }), 20), true);
  assert.equal(task.refs.length, 1);
  assert.equal(task.refs[0].assistantMsgId, 'ma-final');
  assert.equal(task.refs[0].ts, 20);
});

test('applyTagResult routes by existing id and dedups refs by assistant msg id', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  const again = core.applyTagResult(board, [{ id: tid, title: '', module: '', areas: [] }], mkRef(), 2);
  assert.deepEqual(again, []);            // same assistantMsgId → no new ref, nothing touched
  assert.equal(board.tasks[tid].refs.length, 1);
  const more = core.applyTagResult(board, [{ id: tid, title: '', module: '', areas: [] }],
    mkRef({ assistantMsgId: 'ma9', userMsgId: 'mu9', sessionId: 's2' }), 3);
  assert.deepEqual(more, [tid]);
  assert.equal(board.tasks[tid].refs.length, 2);
});

test('one turn can be tagged into multiple tasks', () => {
  const board = core.createEmptyBoard();
  const touched = core.applyTagResult(board, [
    { id: 'new', title: 'A', module: 'M', areas: [] },
    { id: 'new', title: 'B', module: 'M', areas: [] },
  ], mkRef(), 1);
  assert.equal(touched.length, 2);
  assert.equal(Object.keys(board.modules).length, 1);
  for (const t of Object.values(board.tasks)) assert.equal(t.refs[0].assistantMsgId, 'ma1');
});

test('new conversation reactivates a done task', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  board.tasks[tid].status = 'done';
  core.applyTagResult(board, [{ id: tid }], mkRef({ assistantMsgId: 'ma2' }), 2);
  assert.equal(board.tasks[tid].status, 'active');
});

// ── backfill parse / apply ──────────────────────────────────────────────────

test('parseBackfillResult validates turn lists and drops entries without turns', () => {
  const out = core.parseBackfillResult(JSON.stringify({ tasks: [
    { id: 'new', title: '实现语音', module: '移动 App', areas: ['app/voice'], turns: [1, 2, 2, '3', -1, 'x'] },
    { id: 'new', title: '没有轮次', module: 'M', areas: [], turns: [] },
  ] }));
  assert.equal(out.tasks.length, 1);
  assert.deepEqual(out.tasks[0].turns, [1, 2, 3]);
});

test('applyBackfillResult attaches every listed turn and dedups the task by title', () => {
  const board = core.createEmptyBoard();
  const refByTurn = new Map([
    [1, mkRef({ userMsgId: 'u1', assistantMsgId: 'a1', ts: 10 })],
    [2, mkRef({ userMsgId: 'u2', assistantMsgId: 'a2', ts: 20 })],
    [3, mkRef({ userMsgId: 'u3', assistantMsgId: 'a3', ts: 30 })],
  ]);
  const touched = core.applyBackfillResult(board, [
    { id: 'new', title: '实现语音', module: '移动 App', areas: ['app/voice'], turns: [1, 3] },
    { id: 'new', title: '修复构建', module: '发布运维', areas: [], turns: [2, 9] },   // turn 9 unknown → skipped
  ], refByTurn, 100);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.equal(touched.length, 2);
  const voice = Object.values(board.tasks).find(t => t.title === '实现语音');
  assert.deepEqual(voice.refs.map(r => r.assistantMsgId), ['a1', 'a3']);
  const build = Object.values(board.tasks).find(t => t.title === '修复构建');
  assert.deepEqual(build.refs.map(r => r.assistantMsgId), ['a2']);
  // Re-running the same backfill is a no-op (ref dedup).
  const again = core.applyBackfillResult(board, [
    { id: 'new', title: '实现语音', module: '移动 App', areas: [], turns: [1, 3] },
  ], refByTurn, 200);
  assert.deepEqual(again, []);
  assert.equal(voice.refs.length, 2);
});

// ── normalizeBoard ──────────────────────────────────────────────────────────

test('normalizeBoard drops malformed entries and survives garbage', () => {
  assert.deepEqual(core.normalizeBoard(null), { modules: {}, tasks: {} });
  assert.deepEqual(core.normalizeBoard('junk'), { modules: {}, tasks: {} });
  const board = core.normalizeBoard({
    modules: { m1: { name: '服务端' }, bad: { nope: 1 } },
    tasks: {
      t1: { title: 'T', moduleId: 'm1', refs: [{ sessionId: 's1', ts: 5 }, { bad: true }] },
      bad: { refs: [] },
    },
  });
  assert.deepEqual(Object.keys(board.modules), ['m1']);
  assert.deepEqual(Object.keys(board.tasks), ['t1']);
  assert.equal(board.tasks.t1.refs.length, 1);
  assert.equal(board.tasks.t1.status, 'active');
});

// ── routing ─────────────────────────────────────────────────────────────────

function mkRecords(entries) {
  return new Map(Object.entries(entries));
}

test('pickRouteTarget prefers the most recent ref session that is routable', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    mkRef({ sessionId: 'old', assistantMsgId: 'a1' }), 1);
  core.applyTagResult(board, [{ id: tid }], mkRef({ sessionId: 'newer', userMsgId: 'u2', assistantMsgId: 'a2' }), 2);
  const records = mkRecords({
    old: { kind: 'chat', dirId: 'd1' },
    newer: { kind: 'chat', dirId: 'd1' },
  });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, null), 'newer');
});

test('pickRouteTarget skips aux/gateway/terminal/ephemeral and falls back to module dir', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    mkRef({ sessionId: 'gone', dirId: 'd1' }), 1);
  const records = mkRecords({
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1' },
    term1: { kind: 'term', dirId: 'd1' },
    eph: { kind: 'chat', ephemeral: true, dirId: 'd1' },
    otherdir: { kind: 'chat', dirId: 'd2' },
    good: { kind: 'chat', dirId: 'd1' },
  });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, null), 'good');
});

test('pickRouteTarget honors an explicit valid target and returns null when nothing fits', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  const records = mkRecords({ pick: { kind: 'chat', dirId: 'd9' } });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, 'pick'), 'pick');
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], mkRecords({}), null), null);
});

test('pickDirTarget picks the most recently active routable session in the dir', () => {
  const records = mkRecords({
    stale: { kind: 'chat', dirId: 'd1', lastActivity: '2026-07-01T00:00:00Z' },
    fresh: { kind: 'chat', dirId: 'd1', lastActivity: '2026-07-20T00:00:00Z' },
    otherdir: { kind: 'chat', dirId: 'd2', lastActivity: '2026-07-21T00:00:00Z' },
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1', lastActivity: '2026-07-21T00:00:00Z' },
  });
  assert.equal(core.pickDirTarget(records, 'd1', null), 'fresh');
  assert.equal(core.pickDirTarget(records, 'd1', 'stale'), 'stale');   // explicit wins
  assert.equal(core.pickDirTarget(records, 'd3', null), null);
  assert.equal(core.pickDirTarget(records, null, null), 'otherdir');   // no dir filter → global latest
});

// ── routed-message marker ───────────────────────────────────────────────────

test('routed message marker round-trips through extractTaskMarker', () => {
  const task = { id: 'tsk-abc_1', title: '实现任务板' };
  const msg = core.buildRoutedMessage(task, '继续加个删除按钮');
  assert.match(msg, /^【任务：实现任务板｜tb:tsk-abc_1】\n/);
  assert.equal(core.extractTaskMarker(msg), 'tsk-abc_1');
  assert.equal(core.extractTaskMarker('普通消息'), null);
});

// ── messageText / DTO ───────────────────────────────────────────────────────

test('messageText handles string and block-array content', () => {
  assert.equal(core.messageText({ content: 'hi' }), 'hi');
  assert.equal(core.messageText({ content: [
    { type: 'thinking', thinking: 'x' },
    { type: 'text', text: 'a' },
    { type: 'tool_use' },
    { type: 'text', text: 'b' },
  ] }), 'a\nb');
  assert.equal(core.messageText(null), '');
});

test('buildBoardDto aggregates counts, sessions and sorts by recency', () => {
  const board = core.createEmptyBoard();
  const [t1] = core.applyTagResult(board, [{ id: 'new', title: '旧任务', module: 'M', areas: [] }],
    mkRef({ ts: 100 }), 100);
  const [t2] = core.applyTagResult(board, [{ id: 'new', title: '新任务', module: 'M', areas: [] }],
    mkRef({ assistantMsgId: 'a2', sessionId: 's2', ts: 900 }), 900);
  const dto = core.buildBoardDto(board);
  assert.equal(dto.tasks[0].id, t2);
  assert.equal(dto.tasks[1].id, t1);
  assert.equal(dto.modules.length, 1);
  assert.equal(dto.modules[0].taskCount, 2);
  assert.deepEqual(dto.tasks[0].sessionIds, ['s2']);
});

// ── runtime (integration with fake deps) ────────────────────────────────────

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-'));
  const file = path.join(tmp, 'task_board.json');
  const auxCalls = [];
  const broadcasts = [];
  const dispatches = [];
  let auxResolve;
  const deps = {
    file,
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        return new Promise(resolve => { auxResolve = resolve; });
      },
    },
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', dirId: 'dir-1', label: '工程师1' }],
    ]),
    loadHistory: () => [
      { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
      { id: 'ma1', role: 'assistant', content: '已实现，改了 src/task-board.js', ts: 20 },
    ],
    dispatchToSession: async (target, message, opts) => {
      dispatches.push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-1', status: 'delivering' };
    },
    workspaceBroadcast: (dirId, payload) => broadcasts.push({ dirId, payload }),
    isLocalRequest: () => true,
    atomicWriteJson: (f, value) => fs.writeFileSync(f, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    logger: { log: () => {} },
    ...overrides,
  };
  const runtime = createTaskBoardRuntime(deps);
  return { runtime, deps, file, auxCalls, broadcasts, dispatches, resolveAux: v => auxResolve(v) };
}

test('assertTaskBoardDeps rejects missing deps', () => {
  assert.throws(() => assertTaskBoardDeps({}), /missing dep/);
});

test('onTurnEnd enqueues a task_tag aux call and applies the parsed result', async () => {
  const { runtime, file, auxCalls, broadcasts, resolveAux } = mkRuntime();
  runtime.onTurnEnd(
    { currentUserText: '实现任务板', currentAssistantText: '已实现，改了 src/task-board.js（超过三十个字的正式回复内容，保证通过长度门槛）' },
    'sess-1');
  assert.equal(auxCalls.length, 1);
  assert.equal(auxCalls[0].type, 'task_tag');
  assert.match(auxCalls[0].prompt, /实现任务板/);
  resolveAux({ text: '{"tasks":[{"id":"new","title":"实现任务板","module":"服务端","areas":["src/task-board.js"]}]}', cancelled: false });
  await new Promise(r => setImmediate(r));
  const board = runtime.getBoard();
  assert.equal(Object.keys(board.tasks).length, 1);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(saved.tasks).length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.type, 'task_board_update');
});

test('onClassifyGoal creates immediately, anchors the current user and merges peer sessions', () => {
  const histories = {
    'sess-1': [
      { id: 'u-old', role: 'user', content: '旧任务', ts: 1 },
      { id: 'a-old', role: 'assistant', content: '旧任务完成', ts: 2 },
      { id: 'u-live', role: 'user', content: '删除 [tiktok] 会话和 worktree', ts: 3 },
      { id: 'a-live', role: 'assistant', content: '正在核对', ts: 4, _interim: true },
    ],
    'sess-2': [
      { id: 'u-peer', role: 'user', content: '清理 tiktok 会话与 worktree', ts: 5 },
    ],
  };
  const records = new Map([
    ['sess-1', { id: 'sess-1', kind: 'chat', dirId: 'dir-1', label: '工程师1' }],
    ['sess-2', { id: 'sess-2', kind: 'chat', dirId: 'dir-1', label: '工程师2' }],
  ]);
  const { runtime, broadcasts } = mkRuntime({ records, loadHistory: sid => histories[sid] || [] });

  runtime.onClassifyGoal('sess-1', '删除 [tiktok] 会话和 worktree', 'planning', {
    currentUserText: '删除 [tiktok] 会话和 worktree',
  });
  runtime.onClassifyGoal('sess-2', '清理 tiktok 会话与 worktree', 'planning', {
    currentUserText: '清理 tiktok 会话与 worktree',
  });

  const tasks = Object.values(runtime.getBoard().tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'active');
  assert.deepEqual(tasks[0].refs.map(r => r.userMsgId), ['u-live', 'u-peer']);
  assert.deepEqual(tasks[0].refs.map(r => r.assistantMsgId), [null, null]);
  assert.equal(broadcasts[0].payload.kind, 'created');
  assert.equal(broadcasts[1].payload.kind, undefined);
});

test('turn-end tagging enriches and rehomes the immediate card instead of duplicating it', async () => {
  let history = [
    { id: 'u-live', role: 'user', content: '删除 [tiktok] 会话和 worktree', ts: 10 },
  ];
  const { runtime, resolveAux } = mkRuntime({ loadHistory: () => history });
  runtime.onClassifyGoal('sess-1', '删除 [tiktok] 会话和 worktree', 'planning', {
    currentUserText: '删除 [tiktok] 会话和 worktree',
  });
  const taskId = Object.keys(runtime.getBoard().tasks)[0];
  assert.equal(runtime.getBoard().modules[runtime.getBoard().tasks[taskId].moduleId].source, 'classify');

  history = [
    history[0],
    { id: 'a-final', role: 'assistant', content: '已经删除所有目标会话，并清理对应 worktree；同时核对分支与会话记录均已移除。', ts: 20 },
  ];
  runtime.onTurnEnd({
    currentUserText: '删除 [tiktok] 会话和 worktree',
    currentAssistantText: '已经删除所有目标会话，并清理对应 worktree；同时核对分支与会话记录均已移除。',
  }, 'sess-1');
  resolveAux({
    text: '{"tasks":[{"id":"new","title":"清理 tiktok 会话与 worktree","module":"发布运维","areas":["worktree"]}]}',
    cancelled: false,
  });
  await new Promise(r => setImmediate(r));

  const board = runtime.getBoard();
  assert.equal(Object.keys(board.tasks).length, 1);
  assert.equal(board.tasks[taskId].refs.length, 1);
  assert.equal(board.tasks[taskId].refs[0].assistantMsgId, 'a-final');
  assert.equal(board.modules[board.tasks[taskId].moduleId].name, '发布运维');
  assert.equal(Object.values(board.modules).some(m => m.source === 'classify'), false);
});

test('streaming classify path creates or merges the task-board card before returning', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /function recordTaskBoardGoal[\s\S]*?taskBoardRuntime\.onClassifyGoal/);
  const start = source.indexOf('function applyClassifyResult(');
  const end = source.indexOf('\nfunction scanAndReclassify()', start);
  const body = source.slice(start, end);
  const streaming = body.indexOf('if (cs && cs.isStreaming)');
  const create = body.indexOf('recordTaskBoardGoal(', streaming);
  const earlyReturn = body.indexOf('\n    return;', streaming);
  assert.ok(streaming >= 0 && create > streaming && earlyReturn > create);
});

test('onTurnEnd skips aux/gateway sessions, short replies and injected turns', () => {
  const { runtime, auxCalls, deps } = mkRuntime();
  runtime.onTurnEnd({ currentUserText: 'x', currentAssistantText: '短' }, 'sess-1');
  deps.records.set('__aux__', { kind: 'chat', type: 'aux', dirId: 'dir-1' });
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, '__aux__');
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, 'unknown-session');
  assert.equal(auxCalls.length, 0);
});

test('marker turns attach deterministically before the AI verdict', () => {
  const { runtime, auxCalls } = mkRuntime();
  const seeded = runtime.getBoard();
  seeded.tasks['tsk-seed'] = {
    id: 'tsk-seed', moduleId: null, title: '种子任务', status: 'active',
    areas: [], createdAt: 1, updatedAt: 1, refs: [],
  };
  runtime.onTurnEnd({
    currentUserText: '【任务：种子任务｜tb:tsk-seed】\n继续做',
    currentAssistantText: '好的，已经继续推进并完成了相应的修改内容，包括删除按钮与确认弹窗的实现细节说明。',
  }, 'sess-1');
  assert.equal(seeded.tasks['tsk-seed'].refs.length, 1);
  assert.equal(auxCalls.length, 1);   // AI tagging still runs for co-tags

  // Short-reply routed turn still attaches deterministically (no AI pass).
  runtime.onTurnEnd({
    currentUserText: '【任务：种子任务｜tb:tsk-seed】\n继续',
    currentAssistantText: '收到',
  }, 'sess-1');
  assert.equal(auxCalls.length, 1);
});

test('REST: board, messages, send and status flow', async () => {
  const { runtime, dispatches } = mkRuntime();
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
  runtime.mountRoutes(app);
  assert.deepEqual([...routes.keys()], [
    'GET /api/task-board',
    'GET /api/task-board/tasks/:taskId/messages',
    'POST /api/task-board/tasks/:taskId/send',
    'POST /api/task-board/tasks/:taskId/status',
    'POST /api/task-board/send',
    'POST /api/task-board/backfill',
  ]);

  // seed one task with a ref
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const tid = Object.keys(runtime.getBoard().tasks)[0];

  const res = () => {
    const r = { code: 200, body: null, headersSent: false };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; r.headersSent = true; return r; };
    return r;
  };

  const boardRes = res();
  routes.get('GET /api/task-board')({}, boardRes);
  assert.equal(boardRes.body.ok, true);
  assert.equal(boardRes.body.tasks.length, 1);
  assert.equal(boardRes.body.sessionLabels['sess-1'], '工程师1');

  const msgRes = res();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({ params: { taskId: tid } }, msgRes);
  assert.equal(msgRes.body.items.length, 2);
  assert.equal(msgRes.body.items[0].role, 'user');
  assert.equal(msgRes.body.items[0].sessionLabel, '工程师1');
  assert.equal(msgRes.body.items[1].role, 'assistant');

  const missRes = res();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({ params: { taskId: 'nope' } }, missRes);
  assert.equal(missRes.code, 404);

  const sendRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/send')(
    { params: { taskId: tid }, body: { text: '加个删除按钮' } }, sendRes);
  await new Promise(r => setImmediate(r));
  assert.equal(sendRes.body.ok, true);
  assert.equal(sendRes.body.target, 'sess-1');
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message, /tb:/);
  assert.match(dispatches[0].opts.idempotencyKey, /^taskboard:/);

  const stRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'done' } }, stRes);
  assert.equal(stRes.body.ok, true);
  assert.equal(runtime.getBoard().tasks[tid].status, 'done');

  const badRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'weird' } }, badRes);
  assert.equal(badRes.code, 400);
});

test('backfill scans dir sessions, tags turns via aux and reports progress', async () => {
  const auxCalls = [];
  const { runtime } = mkRuntime({
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        // Immediately resolve with a verdict putting turns 1+2 in one task.
        return Promise.resolve({
          cancelled: false,
          text: '{"tasks":[{"id":"new","title":"历史任务","module":"服务端","areas":["src/x.js"],"turns":[1,2]}]}',
        });
      },
    },
    loadHistory: () => [
      { id: 'u1', role: 'user', content: '做第一件事', ts: 10 },
      { id: 'a1', role: 'assistant', content: '第一件事完成', ts: 20 },
      { id: 'uSys', role: 'user', content: '[任务询问] 系统注入', ts: 25 },
      { id: 'aSys', role: 'assistant', content: '注入回复', ts: 26 },
      { id: 'u2', role: 'user', content: '继续第二步', ts: 30 },
      { id: 'aInt', role: 'assistant', content: '临时', ts: 31, _interim: true },
      { id: 'a2', role: 'assistant', content: '第二步完成', ts: 40 },
    ],
    isSystemInjected: (t) => t.startsWith('['),
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/backfill')({ body: { dirId: 'dir-1' } }, r);
  await new Promise(rr => setTimeout(rr, 10));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.queued, 1);
  assert.equal(auxCalls.length, 1);
  assert.equal(auxCalls[0].type, 'task_backfill');
  assert.match(auxCalls[0].prompt, /【轮次 1】/);
  assert.match(auxCalls[0].prompt, /【轮次 2】/);
  assert.doesNotMatch(auxCalls[0].prompt, /系统注入/);
  const board = runtime.getBoard();
  const task = Object.values(board.tasks).find(t => t.title === '历史任务');
  assert.ok(task);
  assert.deepEqual(task.refs.map(x => x.assistantMsgId), ['a1', 'a2']);
});

test('backfill refuses non-local, unhealthy aux and concurrent runs', async () => {
  let healthy = true;
  const { runtime } = mkRuntime({
    auxQueue: {
      isUnhealthy: () => !healthy,
      cancel: () => {},
      enqueue: () => new Promise(() => {}),   // hangs → keeps backfill running
    },
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const mk = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  healthy = false;
  const r1 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r1);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r1.code, 503);

  healthy = true;
  const r2 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r2);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r2.body.ok, true);

  const r3 = mk();
  routes.get('/api/task-board/backfill')({ body: {} }, r3);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r3.code, 409);
});

test('goal-flagged sends prepend the goal note; board-level send routes by dir', async () => {
  const { runtime, dispatches } = mkRuntime({
    resolveGoalLimits: (o) => ({ maxRounds: Number(o?.maxRounds) || 200, maxBudget: Number(o?.maxBudget) || 0 }),
    buildGoalLimitNote: (l) => `[Goal 模式限制]\nrounds=${l.maxRounds}\n[限制结束]\n\n`,
  });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 20, excerpt: 'x' }, 20);
  const tid = Object.keys(runtime.getBoard().tasks)[0];

  const r1 = res();
  routes.get('POST /api/task-board/tasks/:taskId/send')(
    { params: { taskId: tid }, body: { text: '继续', goal: true, goalLimits: { maxRounds: '50' } } }, r1);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r1.body.ok, true);
  assert.match(dispatches[0].message, /^\[Goal 模式限制\]\nrounds=50\n\[限制结束\]\n\n【任务：T｜tb:/);

  const r2 = res();
  routes.get('POST /api/task-board/send')(
    { body: { dirId: 'dir-1', text: '整体推进一下' } }, r2);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.target, 'sess-1');
  assert.equal(dispatches[1].message, '整体推进一下');   // no marker, no note
  assert.match(dispatches[1].opts.idempotencyKey, /^taskboard:dir:/);

  const r3 = res();
  routes.get('POST /api/task-board/send')({ body: { dirId: 'nope', text: 'x' } }, r3);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r3.code, 409);
});

test('goal flag is ignored gracefully when goal helpers are not wired', async () => {
  const { runtime, dispatches } = mkRuntime();
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(`GET ${p}`, h), post: (p, h) => routes.set(`POST ${p}`, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('POST /api/task-board/send')(
    { body: { dirId: 'dir-1', text: 'hi', goal: true, goalLimits: { maxRounds: 5 } } }, r);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r.body.ok, true);
  assert.equal(dispatches[0].message, 'hi');
});

test('send refuses non-local requests and empty text', async () => {
  const { runtime } = mkRuntime({ isLocalRequest: () => false });
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const r = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  routes.get('/api/task-board/tasks/:taskId/send')({ params: { taskId: 'x' }, body: { text: 'hi' } }, r);
  await new Promise(rr => setImmediate(rr));
  assert.equal(r.code, 403);
});

test('board persists across runtime restarts', () => {
  const { runtime, file, deps } = mkRuntime();
  core.applyTagResult(runtime.getBoard(), [{ id: 'new', title: '持久化', module: 'M', areas: [] }],
    { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'u', assistantMsgId: 'a', ts: 1, excerpt: 'x' }, 1);
  runtime.save();
  const rt2 = createTaskBoardRuntime(deps);
  assert.equal(Object.values(rt2.getBoard().tasks)[0].title, '持久化');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

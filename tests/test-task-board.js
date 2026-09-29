'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/task-board/core');
const planning = require('../src/task-board/planning');
const { createTaskBoardRuntime, assertTaskBoardDeps } = require('../src/routes/task-board');
const { mkRuntime } = require('./helpers/task-board-runtime');
require('./test-task-planning');

const EMPTY_BOARD = core.createEmptyBoard();

test('the session runState adapter follows the shared classify display and freeze maps', () => {
  const runStateAdapter = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'session-work', 'host.js'), 'utf8');
  assert.match(runStateAdapter, /classifyDisplay\(classifyState\)\.cardStatus/);
  // The phantom `classifyState === 'A'` branch is removed — no code ever wrote
  // 'A' (the D/C/W/B/E/P vocabulary never included it), so it was dead.
  assert.doesNotMatch(runStateAdapter, /classifyState === 'A'/);
  // Frozen sessions resolve their runState through the explicit reason map, not
  // the old `includes('error')` substring heuristic.
  assert.match(runStateAdapter, /runStateForFreezeReason\(state\.queueFreezeReason\)/);
  assert.doesNotMatch(runStateAdapter, /queueFreezeReason \|\| ''\)\.includes\('error'\)/);
  assert.doesNotMatch(runStateAdapter, /cardStatus === 'completed' \? 'done' : cardStatus/);
  assert.doesNotMatch(runStateAdapter, /classifyState === 'D' \|\| classifyState === 'C'/);
  // A task card must follow the session's persisted classify verdict, never a
  // momentary session-busy flag. The `if (sessionBusy(sid)) return 'running'`
  // short-circuit used to make every historical card light up as「进行中」
  // whenever its owning session ran any new turn — do not reintroduce it.
  assert.doesNotMatch(runStateAdapter, /Busy\(/);
});

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

test('applyTagResult reuses modules but preserves distinct task admissions with similar titles', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [{ id: 'new', title: '修复登录', module: '前端 UI', areas: [] }], mkRef(), 1);
  core.applyTagResult(board, [{ id: 'new', title: '修复 登录', module: '前端UI', areas: [] }],
    mkRef({ assistantMsgId: 'ma2', userMsgId: 'mu2' }), 2);
  assert.equal(Object.keys(board.modules).length, 1);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(Object.values(board.tasks).map(t => t.refs.length), [1, 1]);
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

test('title similarity is diagnostic only and never merges logical task identity', () => {
  const board = core.createEmptyBoard();
  core.applyTagResult(board, [
    { id: 'new', title: '删除 [tiktok] 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef(), 1);
  core.applyTagResult(board, [
    { id: 'new', title: '清理 tiktok 会话与 worktree', module: '会话管理', areas: [] },
  ], mkRef({ sessionId: 's2', userMsgId: 'mu2', assistantMsgId: 'ma2' }), 2);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(Object.values(board.tasks).map(t => t.refs[0].sessionId), ['s1', 's2']);

  core.applyTagResult(board, [
    { id: 'new', title: '删除 tiktok 会话和 worktree', module: '发布运维', areas: [] },
  ], mkRef({ dirId: 'd2', sessionId: 'other', userMsgId: 'mu3', assistantMsgId: 'ma3' }), 3);
  assert.equal(Object.keys(board.tasks).length, 3);
});

test('addRefToTask upgrades an in-flight user ref with the final assistant id', () => {
  const task = { status: 'active', updatedAt: 1, refs: [] };
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: null, ts: 10 }), 10), true);
  assert.equal(core.addRefToTask(task, mkRef({ assistantMsgId: 'ma-final', ts: 20 }), 20), true);
  assert.equal(task.refs.length, 1);
  assert.equal(task.refs[0].assistantMsgId, 'ma-final');
  assert.equal(task.refs[0].ts, 20);
});

test('pending tasks are unique placeholders and converge in place after classification', () => {
  const board = core.createEmptyBoard();
  const first = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '实现任务板手动重试', now: 10,
  });
  const second = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '修复另一件事', now: 11,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(Object.keys(board.modules).length, 1);
  assert.equal(first.title, '新任务');
  assert.equal(first.moduleAssignment.running, false);

  const result = core.applyTaskClassification(board, first.id, {
    id: first.id, title: '完善任务归类', module: '任务板', areas: ['src/task-board.js'],
  }, mkRef({ userMsgId: 'u-live', assistantMsgId: 'a-live' }), 20);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, first.id);
  assert.equal(board.tasks[first.id].title, '完善任务归类');
  assert.equal(board.modules[board.tasks[first.id].moduleId].name, '任务板');
  assert.equal(board.tasks[first.id].moduleAssignment, undefined);
  assert.equal(Object.keys(board.tasks).length, 2);
});

test('classification cannot merge a pending canonical task into another task id', () => {
  const board = core.createEmptyBoard();
  const [existingId] = core.applyTagResult(board, [
    { id: 'new', title: '修复登录', module: '前端 UI', areas: [] },
  ], mkRef({ userMsgId: 'u-old', assistantMsgId: 'a-old' }), 1);
  const pending = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 's1', seed: '继续修复登录', now: 2,
  });
  const result = core.applyTaskClassification(board, pending.id, {
    id: existingId, title: '', module: '', areas: ['public/login.js'],
  }, mkRef({ userMsgId: 'u-new', assistantMsgId: 'a-new' }), 3);
  assert.equal(result.ok, true);
  assert.equal(result.taskId, pending.id);
  assert.equal(Object.keys(board.tasks).length, 2);
  assert.deepEqual(board.tasks[existingId].refs.map(r => r.userMsgId), ['u-old']);
  assert.deepEqual(board.tasks[pending.id].refs.map(r => r.userMsgId), ['u-new']);
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

test('applyBackfillResult uses source-message identity and is replay-idempotent', () => {
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
  assert.deepEqual(core.normalizeBoard(null), EMPTY_BOARD);
  assert.deepEqual(core.normalizeBoard('junk'), EMPTY_BOARD);
  const board = core.normalizeBoard({
    modules: { m1: { name: '服务端' }, bad: { nope: 1 } },
    tasks: {
      t1: {
        title: 'T', moduleId: 'm1', refs: [{ sessionId: 's1', ts: 5 }, { bad: true }],
        runState: 'done',
        classification: { state: 'waiting_reply', lastError: '/tmp/private token=secret' },
      },
      bad: { refs: [] },
    },
  });
  assert.deepEqual(Object.keys(board.modules), ['m1']);
  assert.deepEqual(Object.keys(board.tasks), ['t1']);
  assert.equal(board.tasks.t1.refs.length, 1);
  assert.equal(board.tasks.t1.status, 'active');
  assert.equal(board.tasks.t1.runState, 'succeeded',
    'legacy turn done migrates without completing the active task lifecycle');
  assert.equal(board.tasks.t1.classification, undefined);
  assert.equal(board.tasks.t1.moduleAssignment.running, false);
  assert.equal(board.tasks.t1.moduleAssignment.lastError, 'classification_failed');
});

test('normalizeBoard migrates legacy classify module names to 待归类', () => {
  const dirId = '56783e84-80bb-49d2-89d4-6b412cdc9617';
  const board = core.normalizeBoard({
    modules: {
      legacyUuid: { name: dirId.slice(0, 20), source: 'classify', dirId },
      legacyUnclassified: { name: '未分类', source: 'classify', dirId: 'dir-2' },
    },
  });
  assert.equal(board.modules.legacyUuid.name, core.CLASSIFY_PENDING_MODULE_NAME);
  assert.equal(board.modules.legacyUnclassified.name, core.CLASSIFY_PENDING_MODULE_NAME);
});

// ── routing ─────────────────────────────────────────────────────────────────

function mkRecords(entries) {
  return new Map(Object.entries(entries));
}

test('pickRouteTarget keeps affinity with an available prior participant', () => {
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

test('pickRouteTarget skips invalid candidates and selects a relevant session in the module dir', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }],
    mkRef({ sessionId: 'gone', dirId: 'd1' }), 1);
  const records = mkRecords({
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1' },
    term1: { kind: 'term', dirId: 'd1' },
    eph: { kind: 'chat', ephemeral: true, dirId: 'd1' },
    otherdir: { kind: 'chat', dirId: 'd2' },
    good: { kind: 'chat', dirId: 'd1', label: '前端任务工程师' },
  });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, null, { queryText: '前端任务' }), 'good');
});

test('pickRouteTarget honors an explicit valid target and returns null when nothing fits', () => {
  const board = core.createEmptyBoard();
  const [tid] = core.applyTagResult(board, [{ id: 'new', title: 'T', module: 'M', areas: [] }], mkRef(), 1);
  const records = mkRecords({ pick: { kind: 'chat', dirId: 'd9' } });
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], records, 'pick'), 'pick');
  assert.equal(core.pickRouteTarget(board, board.tasks[tid], mkRecords({}), null), null);
});

test('pickDirTarget uses recency only to break equal relevance scores', () => {
  const records = mkRecords({
    stale: { kind: 'chat', dirId: 'd1', label: '前端消息', lastActivity: '2026-07-01T00:00:00Z' },
    fresh: { kind: 'chat', dirId: 'd1', label: '前端消息', lastActivity: '2026-07-20T00:00:00Z' },
    otherdir: { kind: 'chat', dirId: 'd2', label: '前端消息', lastActivity: '2026-07-21T00:00:00Z' },
    __aux__: { kind: 'chat', type: 'aux', dirId: 'd1', lastActivity: '2026-07-21T00:00:00Z' },
  });
  assert.equal(core.pickDirTarget(records, 'd1', null, { queryText: '前端消息' }), 'fresh');
  assert.equal(core.pickDirTarget(records, 'd1', 'stale'), 'stale');   // explicit wins
  assert.equal(core.pickDirTarget(records, 'd3', null), null);
  assert.equal(core.pickDirTarget(records, null, null, { queryText: '前端消息' }), 'otherdir');
});

// ── routed-message marker ───────────────────────────────────────────────────

test('new routed messages keep taskId out of user-visible text while legacy markers still parse', () => {
  const task = { id: 'tsk-abc_1', title: '实现任务板' };
  const msg = core.buildRoutedMessage(task, '继续加个删除按钮');
  assert.equal(msg, '【任务：实现任务板】\n继续加个删除按钮');
  assert.doesNotMatch(msg, /tsk-abc_1|tb:/);
  assert.equal(core.extractTaskMarker('【任务：旧任务｜tb:tsk-legacy】\n继续'), 'tsk-legacy');
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

test('a dispatch claim nobody ever admitted reads idle instead of 执行中 forever', () => {
  const board = core.createEmptyBoard();
  const now = 1_000_000_000;
  const [taskId] = core.applyTagResult(board, [{ id: 'new', title: '新任务', module: 'M', areas: [] }],
    mkRef({ sessionId: 'killed-shell', ts: now - 10 * 60 * 1000 }), now - 10 * 60 * 1000);
  const task = board.tasks[taskId];
  // 派发时卡片写下的乐观值（createPendingTask / onMessagePersisted 都会这么写）。
  task.runState = 'running';
  task.runStateAt = now - 10 * 60 * 1000;

  // 会话记录里从来没有过 taskState = 这一轮连受理都没发生过（烟测/被杀掉的会话）。
  const local = name => name === 'killed-shell' ? 'idle' : null;
  let dto = core.buildBoardDto(board, local, { sessionHasTurn: () => false, now }).tasks[0];
  assert.equal(dto.runState, 'idle', '证明这一轮从没被受理过 → 按空闲投影，不冒充执行中');

  // 会话有过 taskState（哪怕此刻是空闲）就说明受理过 —— 卡片自报什么就是什么。
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'running');

  // 派发竞态：卡片刚写完、第一个调度事件还没落地，宽限期内不许闪成空闲。
  task.runStateAt = now - 1000;
  task.updatedAt = now - 1000;
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => false, now }).tasks[0];
  assert.equal(dto.runState, 'running', '宽限期内保持派发时的乐观值');

  // 不传 sessionHasTurn（老调用方）时一枚字节都不改。
  dto = core.buildBoardDto(board, local, { now }).tasks[0];
  assert.equal(dto.runState, 'running');
});

test('a one-way card stuck 执行中 by another session reads its worker\'s real state', () => {
  const board = core.createEmptyBoard();
  const now = 1_000_000_000;
  const [taskId] = core.applyTagResult(board, [{ id: 'new', title: '派出去的任务', module: 'M', areas: [] }],
    mkRef({ sessionId: 'worker', ts: now - 30 * 60 * 1000 }), now - 30 * 60 * 1000);
  const task = board.tasks[taskId];
  task.routing = { mode: 'router-tool', targetSessionId: 'worker', workerSessionId: 'worker',
    operationId: 'op-1', status: 'running', oneWay: true };
  task.chatSessionId = 'worker';
  task.runState = 'running';
  task.runStateAt = now - 5 * 60 * 1000;

  assert.equal(core.foreignRunSession(task, 'dispatcher'), true);
  assert.equal(core.foreignRunSession(task, 'worker'), false);

  let workerState = 'succeeded';
  const local = sid => (sid === 'worker' ? workerState : 'running');
  let dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'succeeded', 'worker 已完成 → 不再冒充执行中');

  workerState = 'running';
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'running');

  workerState = 'succeeded';
  task.runStateAt = now - 1000;
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'running', '派发宽限期内保持卡片值');
});

test('attribution-only taskState never counts as proof of an admitted turn', () => {
  // 归因链路（annotateChatTurn / recordTaskBoardGoal）也会往空白记录里写 taskState：
  // goal/phase/taskId/lastSummaryAt 一应俱全，执行侧字段却全是默认值 —— 那是一份
  // 「标注」，不是一次调度。只有执行侧真正写下的字段才算受理物证。
  const attribution = { goal: '调查 400', taskId: 'tsk-x', phase: 'done', lastSummaryAt: 1,
    lastTurnEndedAt: null, classifyState: null, classifyUpdatedAt: null, startedAt: null,
    endedAt: null, classifyHistory: [] };
  for (const record of [null, { id: 'no-task-state' }, { taskState: 'garbage' }, { taskState: attribution }]) {
    assert.equal(core.sessionHasTurn(record), false, `${JSON.stringify(record)} 不是受理物证`);
  }
  for (const evidence of [{ queueState: 'running' }, { queueState: 'idle' }, { classifyState: 'D' },
    { classifyUpdatedAt: 1 }, { lastTurnEndedAt: 1 }, { startedAt: 1 }, { endedAt: 1 },
    { classifyHistory: [{ at: 1, state: 'D' }] }]) {
    assert.equal(core.sessionHasTurn({ taskState: { ...attribution, ...evidence } }), true,
      `${JSON.stringify(evidence)} 应当算受理过`);
  }
});

test('routing retries append attempts on one task and replayed operations stay idempotent', () => {
  const task = {
    id: 'tsk-stable', title: 'T', status: 'active', areas: [], refs: [],
    createdAt: 1, updatedAt: 1,
  };
  const first = {
    mode: 'router-tool', targetSessionId: 'worker-1', workerSessionId: 'worker-1',
    operationId: 'op-1', status: 'admitted', routedAt: 10,
  };
  core.setTaskRouting(task, first);
  core.setTaskRouting(task, first);
  core.setTaskRouting(task, {
    ...first, operationId: 'op-2', status: 'completed', routedAt: 20,
  });
  assert.deepEqual(task.routing.attempts.map(attempt => attempt.operationId), ['op-1', 'op-2']);
  const dto = core.buildBoardDto({
    modules: {},
    tasks: { [task.id]: task },
  }, () => 'idle');
  assert.equal(dto.tasks[0].attemptCount, 2);
});

test('Commander one-way card status follows the executing worker classify only', () => {
  const board = core.createEmptyBoard();
  const pending = core.createPendingTask(board, {
    dirId: 'd1', sessionId: 'commander-1', seed: '修复 URL 保存', now: 1,
  });
  core.setTaskRouting(pending, {
    mode: 'commander', targetSessionId: 'commander-1', workerSessionId: 'worker-1',
    status: 'admitted', oneWay: true, routedAt: 2,
  });
  delete pending.runState; // legacy cards fall back to session-level state
  const states = new Map([['commander-1', 'waiting'], ['worker-1', 'running']]);
  let dto = core.buildBoardDto(board, sid => states.get(sid) || null).tasks[0];
  assert.equal(dto.runState, 'running');
  assert.equal(dto.moduleAssignment.running, false);

  states.set('worker-1', 'succeeded');
  dto = core.buildBoardDto(board, sid => states.get(sid) || null).tasks[0];
  assert.equal(dto.runState, 'succeeded');
  assert.equal(dto.status, 'active', 'turn success cannot complete task lifecycle');
});

test('assertTaskBoardDeps rejects missing deps', () => {
  assert.throws(() => assertTaskBoardDeps({}), /missing dep/);
});

test('ordinary chat never creates a task or queues task tagging', () => {
  const { runtime, auxCalls } = mkRuntime();
  runtime.onTurnEnd({
    currentUserText: '实现任务板',
    currentAssistantText: '已实现完整功能。',
  }, 'sess-1');
  runtime.onClassifyGoal('sess-1', '实现任务板', 'planning', {
    currentUserText: '实现任务板',
    runState: 'running',
  });
  assert.equal(auxCalls.length, 0);
  assert.deepEqual(runtime.getBoard(), EMPTY_BOARD);
});

test('a released delivery claim returns its routed task card to queued', () => {
  const { runtime } = mkRuntime();
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: 'commander-1',
    targetSessionId: 'sess-1',
    taskId: 'tsk-release',
    taskText: 'release delivery',
    operationId: 'op-release',
    status: 'admitted',
  }), true);
  assert.equal(runtime.getBoard().tasks['tsk-release'].runState, 'queued');
  runtime.onQueueEvent({
    type: 'claimed', taskId: 'tsk-release', at: 20,
  });
  assert.equal(runtime.getBoard().tasks['tsk-release'].runState, 'running');
  runtime.onQueueEvent({
    type: 'claim_released', taskId: 'tsk-release', at: 21,
    reason: 'prelaunch_deferred', queued: 1, queuedItems: [{ entryId: 'e2' }],
  });
  assert.equal(runtime.getBoard().tasks['tsk-release'].runState, 'queued');
});

test('a released claim reads what the release left behind, not 排队 unconditionally', () => {
  // 2026-09-27 的真实事故：一条投不出去的消息让 delivery_deferred 每分钟
  // claimed → claim_released 各一次，每次 release 都把卡片刷成「排队中」，而事件
  // 自己写着 queued:0 / queuedItems:[]。重试停下之后卡片上只剩最后一笔「排队」，
  // 于是「外部卡片显示排队、内部 FIFO 一条都没有」。release 不是排队。
  const { runtime } = mkRuntime();
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: 'commander-1', targetSessionId: 'sess-1',
    taskId: 'tsk-drain', taskText: 'drain', operationId: 'op-drain', status: 'admitted',
  }), true);
  runtime.onQueueEvent({ type: 'claimed', taskId: 'tsk-drain', at: 20 });

  // 交还占用、队列一条不剩：卡片读会话落定的判定（D = 执行成功）。
  runtime.onQueueEvent({
    type: 'claim_released', taskId: 'tsk-drain', at: 21, reason: 'delivery_deferred',
    queued: 0, queuedItems: [],
    queueSummary: { sessionId: 'sess-1', depth: 0, state: 'idle', classifyState: 'D', updatedAt: 21 },
  });
  assert.equal(runtime.getBoard().tasks['tsk-drain'].runState, 'succeeded');

  // 释放之后真的还压着东西 —— 那才叫排队。
  runtime.onQueueEvent({
    type: 'claim_released', taskId: 'tsk-drain', at: 22, reason: 'prelaunch_deferred',
    queued: 1, queuedItems: [{ entryId: 'e2' }],
    queueSummary: { sessionId: 'sess-1', depth: 1, state: 'idle', classifyState: 'D', updatedAt: 22 },
  });
  assert.equal(runtime.getBoard().tasks['tsk-drain'].runState, 'queued');

  // 中途释放那一支是冻结而不是清空：调度器还会继续推，对 UI 就是执行中。
  runtime.onQueueEvent({
    type: 'claim_released', taskId: 'tsk-drain', at: 23, reason: 'delivery_error',
    freezeReason: 'incomplete_requires_resume', queued: 0, queuedItems: [],
    queueSummary: { sessionId: 'sess-1', depth: 0, state: 'frozen', classifyState: 'P', updatedAt: 23 },
  });
  assert.equal(runtime.getBoard().tasks['tsk-drain'].runState, 'running');
});

test('the scheduler hands claim_released the freeze reason its consumer projects from', () => {
  // task-board 只能从事件里读状态（emit 会把 schedule 换成 queueSummary），
  // 所以 route 2 的冻结原因必须随事件一起出来 —— 否则卡片会把一次「中途交还、
  // 还在推进」读成「排队」。
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'session-work', 'scheduler.js'), 'utf8');
  assert.match(source, /freezeReason: result\.schedule\.freezeReason,/);
});

test('a bound-session card stuck 排队 reads its own session, not the stale claim', () => {
  // 同一个事故的读侧：卡片绑定的隐藏会话（chatSessionId）整个生命周期只跑这一个
  // 任务，所以它的队列状态就是这张卡的真实状态。共用会话（一个会话名下压着很多
  // 张卡）没有声明执行者，不走这条路。
  const board = core.createEmptyBoard();
  const now = 1_000_000_000;
  const [taskId] = core.applyTagResult(board, [{ id: 'new', title: '提醒通道', module: 'M', areas: [] }],
    mkRef({ sessionId: 'task-bound-1', ts: now - 30 * 60 * 1000 }), now - 30 * 60 * 1000);
  const task = board.tasks[taskId];
  task.chatSessionId = 'task-bound-1';
  task.runState = 'queued';
  task.runStateAt = now - 10 * 60 * 1000;

  assert.equal(core.soleRunSessionId(task), 'task-bound-1', '绑定会话被认成执行者');

  let sessionState = 'succeeded';
  const local = sid => (sid === 'task-bound-1' ? sessionState : null);
  let dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'succeeded', '执行者已落地 → 不再冒充排队');

  // 会话自己在跑的时候一枚字节都不动（那一轮可能就是这张卡）。
  sessionState = 'running';
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'queued');

  // 派发宽限期内也不许闪。
  sessionState = 'succeeded';
  task.runStateAt = now - 1000;
  dto = core.buildBoardDto(board, local, { sessionHasTurn: () => true, now }).tasks[0];
  assert.equal(dto.runState, 'queued');

  // 没有声明执行者的卡片（只有一条 ref 的普通卡片）不走这条路：那条 ref 可能是
  // 一个压着很多张卡的共用会话。
  const plain = JSON.parse(JSON.stringify(task));
  delete plain.chatSessionId;
  delete plain.routing;
  assert.equal(core.soleRunSessionId(plain), '');
  assert.equal(core.staleWorkerClaim({ ...plain, runStateAt: now - 10 * 60 * 1000 }, local, now), null);
});

test('task cards record whether they were started on the board or inside a chat', async () => {
  const { runtime, sessionMessages } = mkRuntime({});
  const sent = await runtime.routeCommanderInput('commander-1', '独立任务', {
    source: 'task-board', clientMsgId: 'panel-origin',
  });
  const boardTaskId = sent.taskId;
  assert.equal(runtime.getBoard().tasks[boardTaskId].origin, 'board');
  assert.equal(sessionMessages[0].options.taskSource, 'task-board');

  // The same admission arriving through the persisted message reads the origin
  // off the trusted taskSource, so whichever side creates the card first
  // (the send indexes it only AFTER the message is persisted) agrees.
  const chatTask = {
    id: 'u9', role: 'user', content: '会话里冒出来的任务', ts: 30,
    taskId: 'tsk-from-chat', taskStart: true, taskSource: 'router-tool',
    taskText: '会话里冒出来的任务',
  };
  assert.equal(runtime.onMessagePersisted('sess-1', chatTask), true);
  assert.equal(runtime.getBoard().tasks['tsk-from-chat'].origin, 'session');

  const dto = core.buildBoardDto(runtime.getBoard(), () => 'idle');
  const byId = new Map(dto.tasks.map(task => [task.id, task]));
  assert.equal(byId.get(boardTaskId).origin, 'board');
  assert.equal(byId.get('tsk-from-chat').origin, 'session');
});

test('a board send owns the origin marker even when the persisted message indexes the card first', async () => {
  const { runtime } = mkRuntime({});
  // The race: onMessagePersisted lands before dispatchTaskStart's own
  // ensureTaskIndex. Both read the same taskSource, so the marker is stable.
  const boardMessage = {
    id: 'u1', role: 'user', content: '独立任务', ts: 5,
    taskId: 'tsk-race', taskStart: true, taskSource: 'commander', taskText: '独立任务',
  };
  assert.equal(runtime.onMessagePersisted('sess-1', boardMessage), true);
  assert.equal(runtime.getBoard().tasks['tsk-race'].origin, 'board');
});

test('cards written before the origin marker fall back to the id shape a board send mints', () => {
  const board = core.normalizeBoard({
    modules: { 'mod-1': { id: 'mod-1', name: '模块', source: 'ai', dirId: 'dir-1' } },
    tasks: {
      // stableTaskId(): sha256 digest, only ever minted by a board send.
      'tsk-0123456789abcdef0123456789abcdef': {
        id: 'tsk-0123456789abcdef0123456789abcdef', moduleId: 'mod-1', title: '旧独立任务', refs: [],
      },
      'tsk-router-0123456789abcdef01234567': {
        id: 'tsk-router-0123456789abcdef01234567', moduleId: 'mod-1', title: '旧路由任务', refs: [],
      },
      'tsk_0123456789abcdef0123456789abcdef': {
        id: 'tsk_0123456789abcdef0123456789abcdef', moduleId: 'mod-1', title: '旧会话任务', refs: [],
      },
      'tsk-mfk1s2-ab12cd': {
        id: 'tsk-mfk1s2-ab12cd', moduleId: 'mod-1', title: '旧归类任务', refs: [],
      },
      'tsk-explicit': {
        id: 'tsk-explicit', moduleId: 'mod-1', title: '已标记', refs: [], origin: 'board',
      },
    },
  });
  assert.equal(board.tasks['tsk-0123456789abcdef0123456789abcdef'].origin, 'board');
  assert.equal(board.tasks['tsk-router-0123456789abcdef01234567'].origin, 'session');
  assert.equal(board.tasks['tsk_0123456789abcdef0123456789abcdef'].origin, 'session');
  assert.equal(board.tasks['tsk-mfk1s2-ab12cd'].origin, 'session');
  assert.equal(board.tasks['tsk-explicit'].origin, 'board');
});

test('a task-bound session resumes its card after a cancel dropped the turn lineage', () => {
  // Observed on #A1N3: the user cancelled, classify recorded E and the card
  // went to error. The next turn was admitted with taskId null (schedule
  // lineage only survives a W/B verdict, not E), so its 'started' event no
  // longer named the task and the card stayed on error while the session was
  // visibly running again. The 1:1 task-bound binding is the authority.
  const records = new Map([
    ['worker-bound', {
      id: 'worker-bound', kind: 'chat', type: 'worker', dirId: 'dir-1',
      label: 'Worker', taskBoundTaskId: 'tsk-bound',
    }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
  ]);
  const { runtime } = mkRuntime({ records });
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: 'commander-1',
    targetSessionId: 'worker-bound',
    taskId: 'tsk-bound',
    taskText: 'align app ui',
    operationId: 'op-bound',
    status: 'admitted',
  }), true);
  runtime.getBoard().tasks['tsk-bound'].chatSessionId = 'worker-bound';

  runtime.onQueueEvent({ type: 'claimed', sessionId: 'worker-bound', taskId: 'tsk-bound', at: Date.now() });
  assert.equal(runtime.getBoard().tasks['tsk-bound'].runState, 'running');
  // reconcile stamps its own Date.now(); the continuation must be no older.
  runtime.reconcileRunState('tsk-bound', { classifyState: 'E', reason: 'manual_cancel' });
  assert.equal(runtime.getBoard().tasks['tsk-bound'].runState, 'error');

  // The continuation turn carries no taskId at all.
  runtime.onQueueEvent({ type: 'started', sessionId: 'worker-bound', taskId: null, at: Date.now() + 1000 });
  assert.equal(runtime.getBoard().tasks['tsk-bound'].runState, 'running');
});

test('an unbound session never borrows another task card through the binding fallback', () => {
  const records = new Map([
    ['sess-1', { id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1' }],
    ['half-released', {
      id: 'half-released', kind: 'chat', type: 'worker', dirId: 'dir-1',
      label: 'Stale', taskBoundTaskId: 'tsk-half',
    }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
  ]);
  const { runtime } = mkRuntime({ records });
  runtime.recordRouterAdmission({
    callerSessionId: 'commander-1', targetSessionId: 'sess-1', taskId: 'tsk-half',
    taskText: 'half released', operationId: 'op-half', status: 'admitted',
  });
  // Board side of the binding was released; only the record's marker remains.
  runtime.getBoard().tasks['tsk-half'].chatSessionId = null;
  assert.deepEqual(
    runtime.onQueueEvent({ type: 'started', sessionId: 'half-released', taskId: null, at: 40 }),
    { ok: false, code: 'task_not_found' },
  );
  assert.equal(
    runtime.onQueueEvent({ type: 'started', sessionId: 'sess-1', taskId: null, at: 41 }).ok,
    false,
  );
});

test('global gateway projects a cross-Fleet worker admission with the durable operation id', () => {
  const records = new Map([
    ['__voice_router__', {
      id: '__voice_router__', kind: 'chat', type: 'gateway', dirId: null,
      label: 'Realtime Voice Router',
    }],
    ['worker-1', {
      id: 'worker-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: 'Worker 1',
    }],
    ['worker-2', {
      id: 'worker-2', kind: 'chat', type: 'worker', dirId: 'dir-2', label: 'Worker 2',
    }],
  ]);
  const { runtime, broadcasts } = mkRuntime({ records });
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: '__voice_router__',
    targetSessionId: 'worker-2',
    taskId: 'tsk-voice-cross-fleet',
    taskText: '修复二号项目',
    operationId: 'op-durable-worker-2',
    status: 'admitted',
    resultMode: 'async',
  }), true);

  const board = runtime.getBoard();
  const task = board.tasks['tsk-voice-cross-fleet'];
  assert.equal(board.modules[task.moduleId].dirId, 'dir-2');
  assert.equal(task.refs[0].dirId, 'dir-2');
  assert.equal(task.refs[0].sessionId, 'worker-2');
  assert.equal(task.routing.mode, 'router-tool');
  assert.equal(task.routing.targetSessionId, 'worker-2');
  assert.equal(task.routing.workerSessionId, 'worker-2');
  assert.equal(task.routing.operationId, 'op-durable-worker-2');
  assert.equal(broadcasts.at(-1).dirId, 'dir-2',
    "the update is addressed to the worker's directory; broadcast mirrors it to meta clients");
});

test('only the real Voice Router may project a cross-Fleet admission', () => {
  const records = new Map([
    ['caller-1', {
      id: 'caller-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: 'Caller',
    }],
    ['worker-2', {
      id: 'worker-2', kind: 'chat', type: 'worker', dirId: 'dir-2', label: 'Worker',
    }],
    ['__gateway__', {
      id: '__gateway__', kind: 'chat', type: 'gateway', dirId: null, label: 'Other Gateway',
    }],
  ]);
  const { runtime } = mkRuntime({ records });
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: 'caller-1',
    targetSessionId: 'worker-2',
    taskId: 'tsk-cross-fleet-rejected',
    operationId: 'op-cross-fleet-rejected',
    status: 'admitted',
  }), false);
  assert.equal(runtime.getBoard().tasks['tsk-cross-fleet-rejected'], undefined);
  assert.equal(runtime.recordRouterAdmission({
    callerSessionId: '__gateway__',
    targetSessionId: 'worker-2',
    taskId: 'tsk-other-gateway-rejected',
    operationId: 'op-other-gateway-rejected',
    status: 'admitted',
  }), false);
  assert.equal(runtime.getBoard().tasks['tsk-other-gateway-rejected'], undefined);
});

test('canonical task messages create exactly one projection and classify updates it', () => {
  const history = [];
  const { runtime, broadcasts } = mkRuntime({ loadHistory: () => history });
  const taskId = 'tsk-canonical-1';
  const text = '第一行\n<script>alert(1)</script>\n最后一行';
  const user = {
    id: 'u1', role: 'user', content: '【任务：新任务】\n' + text, ts: 10,
    taskId, taskStart: true, taskSource: 'task-board', taskText: text,
  };
  history.push(user);
  assert.equal(runtime.onMessagePersisted('sess-1', user), true);
  assert.equal(runtime.onMessagePersisted('sess-1', user), true);
  assert.equal(Object.keys(runtime.getBoard().tasks).length, 1);
  assert.equal(runtime.getBoard().tasks[taskId].refs.length, 1);

  runtime.onClassifyGoal('sess-1', '统一任务链路', 'implementing', {
    currentUserText: user.content,
    taskId,
    runState: 'waiting',
  });
  assert.equal(runtime.getBoard().tasks[taskId].title, '第一行');
  assert.equal(runtime.getBoard().tasks[taskId].runState, 'waiting');
  assert.equal(broadcasts[0].payload.kind, 'created');
  assert.equal(JSON.stringify(runtime.getBoard()).includes(text), false,
    'task body must not be copied into task_board.json');
});

test('taskId boundaries keep intervening events on the current task and open a second card only for a new id', () => {
  const history = [];
  const { runtime } = mkRuntime({ loadHistory: () => history });
  const push = message => {
    history.push(message);
    runtime.onMessagePersisted('sess-1', message);
  };
  push({ id: 'u1', role: 'user', content: '任务一', taskText: '任务一', taskId: 'tsk-one', taskStart: true, taskSource: 'task-board', ts: 1 });
  push({ id: 'a1', role: 'assistant', content: '任务一回复', taskId: 'tsk-one', ts: 2 });
  push({ id: 'u2', role: 'user', content: '任务一后续', taskId: 'tsk-one', ts: 3 });
  push({ id: 'a2', role: 'assistant', content: '任务一后续回复', taskId: 'tsk-one', ts: 4 });
  push({ id: 'u3', role: 'user', content: '任务二', taskText: '任务二', taskId: 'tsk-two', taskStart: true, taskSource: 'commander', ts: 5 });
  assert.deepEqual(Object.keys(runtime.getBoard().tasks).sort(), ['tsk-one', 'tsk-two']);
  assert.equal(runtime.getBoard().tasks['tsk-one'].refs.length, 2);
  assert.equal(runtime.getBoard().tasks['tsk-two'].refs.length, 1);
});

test('streaming classify path creates or merges the task-board card before returning', () => {
  // recordTaskBoardGoal / applyClassifyResult / scanAndReclassify now live in the
  // extracted classify state machine.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'classify', 'state-machine.js'), 'utf8');
  const taskContextHostSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'task-context-host.js'), 'utf8');
  assert.match(source, /function recordTaskBoardGoal[\s\S]*?getTaskContextHost\(\)\.recordGoal/);
  assert.match(taskContextHostSource, /function recordGoal[\s\S]*?getTaskBoard\(\)\?\.onClassifyGoal/);
  const start = source.indexOf('function applyClassifyResult(');
  const end = source.indexOf('\n  function scanAndReclassify()', start);
  assert.ok(start >= 0 && end > start, 'applyClassifyResult slice anchors must resolve');
  const body = source.slice(start, end);
  const streaming = body.indexOf("if (liveness.state !== 'inactive')");
  const create = body.indexOf('recordTaskBoardGoal(', streaming);
  const earlyReturn = body.indexOf('\n      return;', streaming);
  assert.ok(streaming >= 0 && create > streaming && earlyReturn > create);
});

test('host task-board dispatch rejects busy targets before durable admission', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const gatewayHost = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'dispatch', 'gateway-host.js'),
    'utf8',
  );
  // Busy is a classify verdict plus the repo lease — see the liveness→classify
  // invariants in tests/test-architecture-boundaries.js. The gate is spelled out
  // as reason codes now (dispatchTargetBusyReasons) so the outbox skip log and
  // the insert-queued response can say WHICH veto fired; the boolean has to stay
  // derived from that one list, or the two presentations could disagree.
  // The retired pooled TaskRun slot check (isSlotUnavailable) is gone with the
  // run subsystem; the workspace/run/repo-lease vetoes are what remain.
  assert.match(source, /function dispatchTargetBusyReasons\(sid, item = null\)[\s\S]*?isRunActive\(sid\)[\s\S]*?isLeased\(sid\)/);
  assert.match(source, /function dispatchTargetBusy\(sid, item = null\)[\s\S]*?dispatchTargetBusyReasons\(sid, item\)\.length > 0/);
  // Retention also needs the same veto before deleting an old task. It may
  // consume this read-only verdict, but must not create a competing busy rule.
  assert.match(source, /createTaskBoardRuntime\([\s\S]*?isSessionBusy: sid => dispatchTargetBusy\(sid\)/);
  // The dispatch admission path lives in src/dispatch/gateway-host.js now.
  const start = gatewayHost.indexOf('async function dispatchToSession(');
  const end = gatewayHost.indexOf('\n  // ── Dispatch ↔', start);
  const body = gatewayHost.slice(start, end);
  const guard = body.indexOf('opts.requireIdle && isTargetBusy(chatId)');
  const admission = body.indexOf('getOrchestrationRuntime().admitDispatch(');
  assert.ok(guard >= 0 && admission > guard);
  assert.match(gatewayHost, /validateDispatchTarget\(targetId, fromSessionId = null, allowCommander = false\)/);
  assert.match(gatewayHost, /rec\.type === 'commander' && !allowCommander/);
  assert.match(source, /isBusy: dispatchTargetBusy/);
  assert.match(gatewayHost, /oneWay: !!opts\.oneWay/);
  assert.match(source, /replayRecoveredDispatchEffects: \(\) => \{\}/);
});

test('onTurnEnd skips aux/gateway sessions, short replies and injected turns', () => {
  const { runtime, auxCalls, deps } = mkRuntime();
  runtime.onTurnEnd({ currentUserText: 'x', currentAssistantText: '短' }, 'sess-1');
  deps.records.set('__aux__', { kind: 'chat', type: 'aux', dirId: 'dir-1' });
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, '__aux__');
  runtime.onTurnEnd({ currentUserText: '实现任务板', currentAssistantText: 'a'.repeat(50) }, 'unknown-session');
  assert.equal(auxCalls.length, 0);
});

test('legacy marker turns still attach without re-enabling AI task creation', () => {
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
  assert.equal(auxCalls.length, 0);

  // Short-reply routed turn still attaches deterministically (no AI pass).
  runtime.onTurnEnd({
    currentUserText: '【任务：种子任务｜tb:tsk-seed】\n继续',
    currentAssistantText: '收到',
  }, 'sess-1');
  assert.equal(auxCalls.length, 0);
});

test('REST: the surviving task-board endpoints register and keep working', async () => {
  const { runtime } = mkRuntime();
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
  runtime.mountRoutes(app);
  // Planning owns the card CRUD; the board runtime adds the lifecycle and
  // binding endpoints Air still drives. DELETE is optional-chained, so this
  // fake app (no delete) never registers it.
  assert.deepEqual([...routes.keys()], [
    'POST /api/task-board/tasks',
    'POST /api/task-board/tasks/:taskId/update',
    'POST /api/task-board/tasks/:taskId/title',
    'POST /api/task-board/tasks/:taskId/planning',
    'POST /api/task-board/tasks/:taskId/move',
    'POST /api/task-board/tasks/:taskId/status',
    // Air 任务「移动」：跨目录搬迁。
    'POST /api/task-board/tasks/:taskId/relocate',
    // P1 · get-or-create the task-bound hidden chat session (addressable, not fleet-listed).
    'POST /api/task-board/tasks/:taskId/chat-session',
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

  const renameRes = res();
  await routes.get('POST /api/task-board/tasks/:taskId/title')(
    { params: { taskId: tid }, body: { title: '人工命名的任务' } }, renameRes);
  assert.equal(renameRes.code, 200);
  assert.equal(renameRes.body.task.title, '人工命名的任务');
  assert.equal(runtime.getBoard().tasks[tid].titleSource, 'manual');

  const stRes = res();
  routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'done' } }, stRes);
  await new Promise(r => setImmediate(r));
  assert.equal(stRes.body.ok, true);
  assert.equal(runtime.getBoard().tasks[tid].status, 'done');

  const badRes = res();
  await routes.get('POST /api/task-board/tasks/:taskId/status')(
    { params: { taskId: tid }, body: { status: 'weird' } }, badRes);
  assert.equal(badRes.code, 400);
});

test('commander input binds a fresh task-bound session even with multiple active ordinary sessions', async () => {
  const workerCalls = [];
  const records = new Map([
    ['worker-newest', { id: 'worker-newest', kind: 'chat', dirId: 'dir-1', label: '最近活跃 worker', active: true, lastActivity: 999 }],
    ['worker-other', { id: 'worker-other', kind: 'chat', dirId: 'dir-1', label: '普通 worker', status: 'running' }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: '稳定角色 Commander' }],
  ]);
  const { runtime, sessionMessages, creates, dispatches } = mkRuntime({
    records,
    isSessionBusy: sid => sid !== 'commander-1',
    dispatchToSession: async (target, message, opts) => {
      workerCalls.push({ target, message, opts });
      return { ok: true, chatId: target, operationId: 'op-command', status: 'admitted' };
    },
  });
  const result = await runtime.routeCommanderInput('commander-1', '修复任务详情路由', {
    source: 'task-board', clientMsgId: 'panel-fresh-binding',
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskBound, true);
  assert.equal(result.routeMode, 'task-bound');
  assert.equal(result.targetSessionId, 'bound-1');
  assert.equal(creates.length, 1, 'the task lands in a fresh hidden session');
  assert.equal(sessionMessages.length, 1, 'the text enters the bound session turn directly');
  assert.equal(sessionMessages[0].sessionId, 'bound-1');
  assert.equal(sessionMessages[0].text, '修复任务详情路由');
  assert.equal(sessionMessages[0].options.taskStart, true);
  assert.equal(sessionMessages[0].options.taskSource, 'task-board');
  assert.equal(workerCalls.length, 0, 'task board must never pool work into an ordinary worker');
  assert.equal(dispatches.length, 0, 'the retired pooled router stays retired');
  assert.equal(result.workerSessionId, 'bound-1', 'the receipt points at the bound session');
});

test('same panel client id replays the bound receipt without a second send', async () => {
  const { runtime, sessionMessages, creates, dispatches } = mkRuntime({});
  const options = { source: 'task-board', clientMsgId: 'stable-client-message' };
  const first = await runtime.routeCommanderInput('commander-1', '幂等任务正文', options);
  const second = await runtime.routeCommanderInput('commander-1', '幂等任务正文', options);

  // #38: the first send bound the hidden session; a replay recognises the
  // recorded bound routing and answers duplicate — the chat FIFO owns the real
  // delivery idempotency for this clientMsgId, so no second turn ever opens.
  assert.ok(first.taskId);
  assert.equal(second.taskId, first.taskId);
  assert.equal(first.routeMode, 'task-bound');
  assert.equal(second.taskBound, true);
  assert.equal(creates.length, 1, 'replay re-binds nothing');
  assert.equal(sessionMessages.length, 1, 'replay never opens a second turn');
  assert.equal(sessionMessages[0].sessionId, 'bound-1');
  assert.equal(second.duplicate, true);
  assert.equal(dispatches.length, 0, 'neither attempt touches the retired pooled router');
});

test('panel routing sends the original user text verbatim into the bound session', async () => {
  const { runtime, sessionMessages, dispatches } = mkRuntime({});
  const result = await runtime.routeCommanderInput('commander-1', '让工程师改 README', {
    source: 'task-board', clientMsgId: 'panel-verbatim',
  });

  assert.equal(result.routeMode, 'task-bound');
  assert.equal(sessionMessages.length, 1, 'board sends enter the bound session turn');
  assert.equal(sessionMessages[0].sessionId, 'bound-1');
  assert.equal(sessionMessages[0].text, '让工程师改 README',
    'the user text is delivered verbatim — no wrapper envelope');
  assert.equal(sessionMessages[0].options.taskSource, 'task-board');
  assert.equal(dispatches.length, 0, 'the retired pooled router never fires');
  assert.ok(result.taskId, 'board send returns the created taskId');
  assert.equal(JSON.stringify(runtime.getBoard()).includes('让工程师改 README'), true,
    'card-first: the task lands on the board');
});

test('Commander busy state is irrelevant; the bound-session receipt survives refresh', async () => {
  const records = new Map([
    ['worker-idle', { id: 'worker-idle', kind: 'chat', dirId: 'dir-1', label: '空闲 worker' }],
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
  ]);
  const fixture = mkRuntime({
    records,
    isSessionBusy: sid => sid === 'commander-1',
  });
  const result = await fixture.runtime.routeCommanderInput('commander-1', '排队任务', {
    source: 'task-board', clientMsgId: 'panel-busy-commander',
  });

  assert.equal(result.ok, true);
  assert.equal(result.taskBound, true, 'the task turn lives in its own bound session');
  assert.equal(result.routeMode, 'task-bound');
  assert.equal(fixture.sessionMessages.length, 1, 'message enters the bound session, never the Commander chat turn');
  assert.equal(fixture.sessionMessages[0].text, '排队任务');
  assert.ok(result.taskId, 'task is created synchronously');
  assert.equal(JSON.stringify(fixture.runtime.getBoard()).includes('bound-1'), true,
    'the bound-session receipt is persisted on the board');
});

test('Commander chat input uses the same card-first bound-session route as the board composer', async () => {
  const { runtime, sessionMessages, creates, dispatches } = mkRuntime({});
  const result = await runtime.routeCommanderInput('commander-1', '实现新的路由入口', {
    idempotencyKey: 'client-message-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskBound, true);
  assert.equal(result.taskStart, true);
  assert.equal(creates.length, 1, 'the Commander input binds its own hidden session');
  assert.equal(sessionMessages.length, 1);
  assert.equal(sessionMessages[0].sessionId, 'bound-1');
  assert.equal(sessionMessages[0].text, '实现新的路由入口');
  assert.equal(sessionMessages[0].options.taskSource, 'commander');
  assert.equal(sessionMessages[0].options.taskStart, true);
  assert.equal(dispatches.length, 0, 'no pooled dispatch from the Commander input either');
  const task = runtime.getBoard().tasks[result.taskId];
  assert.equal(task.routing.workerSessionId, 'bound-1');
  assert.equal(task.routing.oneWay, true);
  assert.equal(task.chatSessionId, 'bound-1');
});

test('commander input never pools work; a failed send reports honestly with no card', async () => {
  const { runtime, sessionMessages, creates, dispatches } = mkRuntime({});

  const result = await runtime.routeCommanderInput('commander-1', '实现隔离运行池', {
    idempotencyKey: 'client-run-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskBound, true);
  assert.equal(result.taskStart, true);
  assert.equal(result.target, 'bound-1');
  assert.equal(creates.length, 1);
  assert.equal(sessionMessages.length, 1);
  assert.equal(sessionMessages[0].text, '实现隔离运行池');
  assert.equal(dispatches.length, 0, 'the retired pooled router never fires');

  const failedRuntime = mkRuntime({
    sendSessionMessage: async () => ({ ok: false, code: 'chat_ingress_down' }),
  }).runtime;
  const failed = await failedRuntime.routeCommanderInput('commander-1', '无法投递的输入', {
    idempotencyKey: 'client-run-failed',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'chat_ingress_down', 'a failed send surfaces its code — no fallback');
  assert.deepEqual(failedRuntime.getBoard(), EMPTY_BOARD,
    'the card is only indexed after a successful send');
});

test('a legacy task follow-up cold-start seeds its bound session from the transcript history', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-legacy-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardFile = path.join(dir, 'task-board.json');
  const history = [
    { id: 'legacy-user', role: 'user', content: '旧任务原文', ts: 10 },
    { id: 'legacy-assistant', role: 'assistant', content: '旧处理结果', ts: 20 },
  ];
  const fixture = mkRuntime({
    file: boardFile,
    loadHistory: sessionId => sessionId === 'sess-1' ? history : [],
  });
  const board = fixture.runtime.getBoard();
  board.modules['legacy-module'] = {
    id: 'legacy-module', name: '旧模块', source: 'ai', dirId: 'dir-1',
    createdAt: 1, updatedAt: 20,
  };
  board.tasks['legacy-task'] = {
    id: 'legacy-task', moduleId: 'legacy-module', title: '旧任务', status: 'active',
    areas: [], createdAt: 1, updatedAt: 20,
    refs: [{
      sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'legacy-user',
      assistantMsgId: 'legacy-assistant', ts: 20, excerpt: '旧任务原文',
    }],
  };
  fixture.runtime.save();

  const first = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'legacy-task', '继续处理', { clientMsgId: 'legacy-followup-1' },
  );
  assert.equal(first.ok, true);
  assert.equal(first.taskBound, true);
  assert.equal(first.taskStart, false);
  assert.equal(fixture.creates.length, 1, 'no live binding — a hidden session is created');
  const sent = fixture.sessionMessages[0];
  assert.equal(sent.sessionId, 'bound-1');
  assert.equal(sent.text, '继续处理', 'the transcript keeps exactly what the user typed');
  assert.match(sent.options.taskContextSeed, /旧任务原文/,
    'the transcript history rides as an invisible prompt layer');
  assert.match(sent.options.taskContextSeed, /旧处理结果/);
  assert.doesNotMatch(sent.text, /旧任务原文/, 'the seed never leaks into the persisted turn text');
  const task = fixture.runtime.getBoard().tasks['legacy-task'];
  assert.equal(task.routing.workerSessionId, 'bound-1',
    'the routing receipt points at the bound session');
  assert.equal(task.chatSessionId, 'bound-1');
});

test('settled task attribution automatically AI-classifies a board placeholder in place', async () => {
  let history = [];
  const { runtime, dispatches, auxCalls, resolveAux } = mkRuntime({
    loadHistory: () => history,
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', dirId: 'dir-1', label: '任务板重新归类工程师' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ]),
  });
  const sent = await runtime.routeCommanderInput('commander-1', '增加手动重新归类按钮', {
    source: 'task-board', clientMsgId: 'panel-attribution',
  });
  // #38: the bound-session dispatch creates the placeholder task synchronously
  // and returns its taskId.
  assert.ok(sent.taskId);
  assert.equal(sent.routeMode, 'task-bound');
  // Simulate the bound session's turn persisting its messages.
  const simTaskId = sent.taskId;
  history = [
    {
      id: 'u-new', role: 'user', content: '增加手动重新归类按钮', ts: 30,
      taskId: simTaskId, taskStart: true, taskSource: 'task-board',
      taskText: '增加手动重新归类按钮',
    },
    {
      id: 'a-new', role: 'assistant',
      content: '已经完成按钮、接口以及失败重试状态的实现。', ts: 40, taskId: simTaskId,
    },
  ];
  runtime.onMessagePersisted('bound-1', history[0]);
  runtime.onMessagePersisted('bound-1', history[1]);
  const queued = runtime.onTaskAttributionSettled('bound-1', simTaskId, history);
  await new Promise(rr => setImmediate(rr));
  let board = runtime.getBoard();
  let tasks = Object.values(board.tasks);
  assert.equal(queued.queued, true);
  assert.equal(auxCalls.length, 1);
  assert.equal(auxCalls[0].type, 'task_tag');
  assert.match(auxCalls[0].prompt, new RegExp(simTaskId));
  assert.match(auxCalls[0].prompt, /增加手动重新归类按钮/);
  assert.match(auxCalls[0].prompt, /已经完成按钮、接口以及失败重试状态/);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, simTaskId);
  assert.equal(tasks[0].moduleAssignment.running, true);
  assert.equal(tasks[0].moduleAssignment.attempts, 1);
  assert.equal(
    runtime.onTaskAttributionSettled('bound-1', simTaskId, history).error,
    'attribution_already_handled',
  );
  assert.equal(auxCalls.length, 1, 'duplicate settled events cannot enqueue twice');

  resolveAux({
    cancelled: false,
    text: `{"tasks":[{"id":"${simTaskId}","title":"自动归类任务板","module":"任务板","areas":["src/routes/task-board.js"]}]}`,
  });
  await new Promise(rr => setImmediate(rr));
  board = runtime.getBoard();
  tasks = Object.values(board.tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, simTaskId);
  assert.equal(tasks[0].title, '自动归类任务板');
  assert.equal(board.modules[tasks[0].moduleId].name, '任务板');
  assert.deepEqual(tasks[0].areas, ['src/routes/task-board.js']);
  assert.equal(tasks[0].moduleAssignment, undefined);
  assert.ok(tasks[0].refs.some(ref => ref.assistantMsgId === 'a-new'), '本轮 ref 已挂到占位卡');
});

test('new-task attribution archives the empty provisional card and classifies only the final id', () => {
  const history = [
    { id: 'u-switch', role: 'user', content: '开始全新的模块归类任务', ts: 10 },
    { id: 'a-switch', role: 'assistant', content: '已经完成全新的模块归类任务。', ts: 20 },
  ];
  const { runtime, auxCalls } = mkRuntime({ loadHistory: () => history });
  const board = runtime.getBoard();
  const provisional = core.createPendingTask(board, {
    taskId: 'task-provisional', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: '原临时任务', now: 1,
  });
  provisional.refs[0].userMsgId = 'u-switch';
  provisional.refs[0].assistantMsgId = 'a-switch';

  assert.equal(runtime.reassignTurnTask(
    'sess-1', provisional.id, 'task-final', history,
    { taskName: '全新的模块归类任务', taskText: '开始全新的模块归类任务' },
  ), true);
  assert.equal(provisional.status, 'archived');
  assert.equal(provisional.moduleAssignment.lastError, 'missing_context');
  assert.equal(board.tasks['task-final'].status, 'active');

  const result = runtime.onTaskAttributionSettled('sess-1', 'task-final', history);
  assert.equal(result.queued, true);
  assert.equal(auxCalls.length, 1);
  assert.match(auxCalls[0].prompt, /task-final/);
  assert.doesNotMatch(auxCalls[0].prompt, /task-provisional/);
});

test('startup scan does not flood untouched backlog or requeue interrupted work', async () => {
  const history = [
    { id: 'u1', role: 'user', content: '需要自动归类', ts: 1 },
    { id: 'a1', role: 'assistant', content: '已经完成这项任务的完整实现。', ts: 2 },
  ];
  const { runtime, auxCalls } = mkRuntime({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '需要自动归类', now: 1,
  });
  pending.refs[0].userMsgId = 'u1';
  pending.refs[0].assistantMsgId = 'a1';

  // The shared Aux lane is serial, so startup does not bulk-enqueue untouched
  // historical cards. Fresh turns use onTaskAttributionSettled instead.
  assert.equal(runtime.scanPendingClassifications(), 0);
  assert.equal(auxCalls.length, 0);
  assert.equal(pending.moduleAssignment.attempts, 0);
  assert.equal(pending.moduleAssignment.running, false);
  assert.equal(Object.values(runtime.getBoard().modules).some(m => m.source === 'classify'), true);

  // A persisted queued/in-flight assignment has no live Aux owner after
  // restart. Mark it interrupted, but do not refill the shared Aux FIFO with an
  // unbounded pre-restart batch.
  pending.moduleAssignment.running = true;
  assert.equal(runtime.scanPendingClassifications(99), 1);
  assert.equal(pending.moduleAssignment.running, false);
  assert.equal(pending.moduleAssignment.lastError, 'classification_interrupted');
  assert.equal(pending.moduleAssignment.attempts, 0);
  assert.equal(auxCalls.length, 0);
  assert.equal(runtime.scanPendingClassifications(100), 0);
  assert.equal(auxCalls.length, 0);
});

test('authenticated task-board mutations do not depend on transport locality', async () => {
  const { runtime } = mkRuntime();
  const routes = new Map();
  runtime.mountRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) });
  const task = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '允许远程归档', now: 1,
  });
  const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const remoteRequest = { socket: { remoteAddress: '203.0.113.10' }, headers: { host: 'dashboard.example.com' } };

  const status = response();
  await routes.get('/api/task-board/tasks/:taskId/status')({
    ...remoteRequest, params: { taskId: task.id }, body: { status: 'archived' },
  }, status);
  assert.equal(status.code, 200);
  assert.equal(status.body.task.status, 'archived');

  const completed = core.createPendingTask(runtime.getBoard(), {
    dirId: 'dir-1', sessionId: 'sess-1', seed: '允许远程批量归档', now: 2,
  });
  completed.status = 'done';
  // Batch archive has no route any more — it is the host's one-time migration
  // port (runtime.archiveTasks), which is equally transport-agnostic.
  const cleanup = await runtime.archiveTasks([completed.id]);
  assert.equal(cleanup.ok, true);
  assert.deepEqual(cleanup.archived, [completed.id]);
  assert.equal(completed.status, 'archived');
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

// ── per-task worktree ledger fields (M3) ────────────────────────────────────

test('task worktree fields survive board normalization and surface on the board DTO', () => {
  const normalized = core.normalizeBoard({
    tasks: {
      'tsk-wt': {
        title: '重构登录页',
        worktreePath: '/repo/.multicc-worktrees/task-abcd1234',
        branch: 'multicc/task-abcd1234',
      },
      'tsk-bad': { title: '脏数据', worktreePath: 42, branch: {} },
    },
  });
  assert.equal(normalized.tasks['tsk-wt'].worktreePath, '/repo/.multicc-worktrees/task-abcd1234');
  assert.equal(normalized.tasks['tsk-wt'].branch, 'multicc/task-abcd1234');
  assert.equal(normalized.tasks['tsk-bad'].worktreePath, undefined, 'non-string fields are dropped');

  // The projection is core-level now — no HTTP task detail route exists.
  const dto = core.buildBoardDto(normalized, () => null).tasks[0];
  assert.equal(dto.id, 'tsk-wt');
  assert.equal(dto.worktreePath, '/repo/.multicc-worktrees/task-abcd1234');
  assert.equal(dto.branch, 'multicc/task-abcd1234',
    'a task detail view learns the worktree from the board DTO (I3 additive)');
});

test('the board runtime exposes the task worktree service only when git deps are injected', () => {
  const bare = mkRuntime();
  assert.equal(bare.runtime.taskWorktree, null,
    'pure fake-deps composition (tests, reduced hosts) stays worktree-free');

  const added = [];
  const withGit = mkRuntime({
    directories: new Map([['dir-1', { id: 'dir-1', path: '/repo', baseBranch: 'main' }]]),
    gitWorktreeAdd: async (dirPath, token) => ({
      ok: true,
      worktreePath: `${dirPath}/.multicc-worktrees/${token}`,
      branch: `multicc/${token}`,
      existing: false,
    }),
    gitWorktreeRemove: async () => { added.push('remove'); return { ok: true, removed: true }; },
    gitMergeBack: async () => { added.push('merge'); return { ok: true, merged: true }; },
    existsSync: () => true,
  });
  const service = withGit.runtime.taskWorktree;
  assert.ok(service && typeof service.ensureForTask === 'function');
  assert.equal(typeof service.cleanupWorktree, 'function');
  assert.equal(typeof service.mergeTask, 'function');
  assert.deepEqual(added, [], 'constructing the service touches no git state');
});

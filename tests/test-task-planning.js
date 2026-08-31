'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/task-board');
const planning = require('../src/task-planning');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { mkRuntime } = require('./helpers/task-board-runtime');

const EMPTY_BOARD = core.createEmptyBoard();
// ── proactive planning layer ───────────────────────────────────────────────

function planningResponse() {
  return {
    code: 200, body: null, headersSent: false,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

function planningRoutes(runtime) {
  const routes = new Map();
  runtime.mountRoutes({
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  });
  return routes;
}

test('planning normalization migrates origin without guessing stage from runState and round-trips fields', () => {
  const board = core.normalizeBoard({
    schemaVersion: planning.TASK_BOARD_SCHEMA_VERSION,
    revision: 7,
    modules: {},
    tasks: {
      'tsk-0123456789abcdef0123456789abcdef': {
        title: '历史板任务', status: 'active', runState: 'running', refs: [],
      },
      observed: { title: '会话记录', status: 'active', runState: 'succeeded', refs: [] },
      explicit: {
        title: '计划卡', status: 'active', refs: [], origin: 'board', recordType: 'planned',
        dirId: 'dir-1', description: '完整描述', workflowStage: 'review', rank: 2048,
        priority: 'urgent', dueAt: '2026-09-03T10:00:00.000Z',
        acceptanceCriteria: '测试通过', planningRevision: 4,
      },
    },
  });
  assert.equal(board.revision, 7);
  assert.equal(board.tasks['tsk-0123456789abcdef0123456789abcdef'].recordType, 'planned');
  assert.equal(board.tasks['tsk-0123456789abcdef0123456789abcdef'].workflowStage, 'inbox');
  assert.equal(board.tasks.observed.recordType, 'observed');
  assert.equal(board.tasks.observed.workflowStage, undefined);
  assert.deepEqual(core.normalizeBoard(JSON.parse(JSON.stringify(board))).tasks.explicit,
    board.tasks.explicit);
  assert.equal(core.taskDirId(board, board.tasks.explicit), 'dir-1');
  const dto = core.buildBoardDto(board, () => 'idle');
  assert.equal(dto.schemaVersion, planning.TASK_BOARD_SCHEMA_VERSION);
  assert.equal(dto.revision, 7);
  assert.deepEqual(dto.tasks.find(task => task.id === 'explicit').dirIds, ['dir-1']);
});

test('new evidence and explicit merges reopen planned done cards without coupling to runState', () => {
  const board = core.createEmptyBoard();
  const target = planning.createPlannedTask(board, {
    title: '已完成', dirId: 'dir-1', workflowStage: 'done',
  }).task;
  core.addRefToTask(target, {
    sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'u1', ts: 2,
  }, 2);
  assert.equal(target.status, 'active');
  assert.equal(target.workflowStage, 'ready');
  assert.equal(target.planningRevision, 2);

  target.status = 'done';
  target.workflowStage = 'done';
  const source = planning.createPlannedTask(board, {
    title: '仍在推进', dirId: 'dir-1', workflowStage: 'ready',
  }).task;
  const merged = core.mergeTasks(board, {
    targetTaskId: target.id, sourceTaskIds: [source.id], now: 3,
  });
  assert.equal(merged.ok, true);
  assert.equal(target.status, 'active');
  assert.equal(target.workflowStage, 'ready');
  assert.equal(source.status, 'archived');
});

test('planning create, update and move are revisioned, preserve empty refs and persist DTO fields', async () => {
  const fixture = mkRuntime();
  const routes = planningRoutes(fixture.runtime);
  const create = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '实现看板', description: '先规划再执行', dirId: 'dir-1',
    workflowStage: 'inbox', priority: 'high', dueAt: '2026-09-05T12:00:00+08:00',
    acceptanceCriteria: '可以拖动卡片',
  } }, create);
  assert.equal(create.code, 200);
  assert.equal(create.body.revision, 1);
  assert.equal(create.body.task.recordType, 'planned');
  assert.equal(create.body.task.planningRevision, 1);
  assert.equal(create.body.task.refCount, 0);
  assert.equal(create.body.task.body, '先规划再执行');
  assert.equal(create.body.task.legacy, false);
  assert.equal(create.body.task.identityState, 'canonical');
  assert.deepEqual(fixture.runtime.getBoard().tasks[create.body.task.id].refs, []);
  assert.equal(fixture.creates.length, 0, 'saving an inbox card does not create a chat');
  assert.equal(fixture.sessionMessages.length, 0, 'saving an inbox card does not execute it');

  const update = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/update')({
    params: { taskId: create.body.task.id },
    body: { description: '补充后的描述', priority: 'urgent', expectedRevision: 1 },
  }, update);
  assert.equal(update.code, 200);
  assert.equal(update.body.revision, 2);
  assert.equal(update.body.task.description, '补充后的描述');
  assert.equal(update.body.task.priority, 'urgent');
  assert.equal(update.body.task.planningRevision, 2);

  const stale = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/update')({
    params: { taskId: create.body.task.id },
    body: { description: '不能覆盖', expectedRevision: 1 },
  }, stale);
  assert.equal(stale.code, 409);
  assert.equal(stale.body.error, 'revision_conflict');
  assert.equal(fixture.runtime.getBoard().revision, 2);
  assert.equal(fixture.runtime.getBoard().tasks[create.body.task.id].description, '补充后的描述');

  const move = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/move')({
    params: { taskId: create.body.task.id },
    body: { workflowStage: 'ready', expectedRevision: 2 },
  }, move);
  assert.equal(move.code, 200);
  assert.equal(move.body.task.workflowStage, 'ready');
  assert.equal(move.body.task.status, 'active');
  assert.equal(move.body.task.planningRevision, 3);
});

test('planning update atomically edits content and moves to the target Fleet stage tail', async () => {
  const fixture = mkRuntime();
  const routes = planningRoutes(fixture.runtime);
  const first = planningResponse();
  const tail = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '原卡', description: '旧文案', dirId: 'dir-1', workflowStage: 'inbox',
  } }, first);
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '已有待执行', dirId: 'dir-1', workflowStage: 'ready',
  } }, tail);
  const beforeBoardRevision = fixture.runtime.getBoard().revision;
  const updated = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/update')({
    params: { taskId: first.body.task.id },
    body: {
      description: '新文案', workflowStage: 'ready',
      expectedRevision: first.body.task.planningRevision,
    },
  }, updated);
  assert.equal(updated.code, 200);
  assert.equal(updated.body.revision, beforeBoardRevision + 1);
  assert.equal(updated.body.task.description, '新文案');
  assert.equal(updated.body.task.workflowStage, 'ready');
  assert.ok(updated.body.task.rank > tail.body.task.rank);
});

test('planning rank is Fleet-scoped and survives repeated midpoint exhaustion by renumbering', () => {
  const board = core.createEmptyBoard();
  const make = (title, dirId) => planning.createPlannedTask(board, {
    title, description: title, dirId, workflowStage: 'ready',
  }).task;
  const firstA = make('A', 'dir-a');
  const firstB = make('B', 'dir-a');
  const otherFleet = make('Other', 'dir-b');
  assert.equal(firstA.rank, planning.RANK_STEP);
  assert.equal(otherFleet.rank, planning.RANK_STEP);
  const crossFleet = planning.movePlannedTask(board, firstA.id, {
    workflowStage: 'ready', beforeTaskId: otherFleet.id,
  }, { expectedRevision: firstA.planningRevision });
  assert.equal(crossFleet.error, 'move_anchor_not_found');

  let lower = firstA;
  for (let index = 0; index < 60; index++) {
    const inserted = make(`I-${index}`, 'dir-a');
    const moved = planning.movePlannedTask(board, inserted.id, {
      workflowStage: 'ready', afterTaskId: lower.id, beforeTaskId: firstB.id,
    }, { expectedRevision: inserted.planningRevision });
    assert.equal(moved.ok, true, `midpoint insertion ${index} succeeds`);
    assert.ok(inserted.rank > lower.rank && inserted.rank < firstB.rank);
    lower = inserted;
  }
  const ranks = planning.plannedTasksInStage(board, 'ready', null, 'dir-a')
    .map(task => task.rank);
  assert.equal(new Set(ranks).size, ranks.length);
});

test('planned send lazily creates its bound chat and advances only to doing', async () => {
  const fixture = mkRuntime();
  const routes = planningRoutes(fixture.runtime);
  const created = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '待启动', description: '执行这项计划', dirId: 'dir-1', workflowStage: 'ready',
  } }, created);
  const sent = planningResponse();
  routes.get('POST /api/task-board/tasks/:taskId/send')({
    params: { taskId: created.body.task.id },
    body: {
      message: '执行这项计划', clientMsgId: 'plan-send-1',
      expectedRevision: created.body.task.planningRevision,
    },
  }, sent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.code, 200);
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.sessionMessages.length, 1);
  assert.equal(sent.body.task.workflowStage, 'doing');
  assert.equal(sent.body.task.status, 'active');
  assert.equal(sent.body.task.runState === 'succeeded', false,
    'a successful send does not infer review/done from runtime projection');
});

test('planned send rejects a stale revision before binding, delivery or stage mutation', async () => {
  const fixture = mkRuntime();
  const routes = planningRoutes(fixture.runtime);
  const created = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '版本已过期', dirId: 'dir-1', workflowStage: 'ready',
  } }, created);
  const sent = planningResponse();
  routes.get('POST /api/task-board/tasks/:taskId/send')({
    params: { taskId: created.body.task.id },
    body: { text: '不能启动', clientMsgId: 'stale-start', expectedRevision: 99 },
  }, sent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.code, 409);
  assert.equal(sent.body.error, 'revision_conflict');
  assert.equal(fixture.creates.length, 0);
  assert.equal(fixture.sessionMessages.length, 0);
  const task = fixture.runtime.getBoard().tasks[created.body.task.id];
  assert.equal(task.workflowStage, 'ready');
  assert.equal(task.planningRevision, 1);
});

test('status completion and reopening keep planned workflow stage aligned', async () => {
  const fixture = mkRuntime();
  const routes = planningRoutes(fixture.runtime);
  const created = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '验收任务', dirId: 'dir-1', workflowStage: 'review',
  } }, created);
  const doneTail = planning.createPlannedTask(fixture.runtime.getBoard(), {
    title: '已完成尾卡', dirId: 'dir-1', workflowStage: 'done',
  }).task;
  const done = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/status')({
    params: { taskId: created.body.task.id },
    body: { status: 'done', expectedRevision: created.body.task.planningRevision },
  }, done);
  assert.equal(done.body.task.status, 'done');
  assert.equal(done.body.task.workflowStage, 'done');
  assert.ok(done.body.task.rank > doneTail.rank);
  const readyTail = planning.createPlannedTask(fixture.runtime.getBoard(), {
    title: '待执行尾卡', dirId: 'dir-1', workflowStage: 'ready',
  }).task;
  const active = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/status')({
    params: { taskId: created.body.task.id },
    body: { status: 'active', expectedRevision: done.body.task.planningRevision },
  }, active);
  assert.equal(active.body.task.status, 'active');
  assert.equal(active.body.task.workflowStage, 'ready');
  assert.ok(active.body.task.rank > readyTail.rank);
  assert.equal(active.body.task.planningRevision, done.body.task.planningRevision + 1);
});

test('planned status rejects a stale revision before lifecycle mutation', async () => {
  const fixture = mkRuntime();
  const task = planning.createPlannedTask(fixture.runtime.getBoard(), {
    title: '待归档', dirId: 'dir-1', workflowStage: 'done',
  }).task;
  const routes = planningRoutes(fixture.runtime);
  const response = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/status')({
    params: { taskId: task.id }, body: { status: 'archived', expectedRevision: 99 },
  }, response);
  assert.equal(response.code, 409);
  assert.equal(response.body.error, 'revision_conflict');
  assert.equal(task.status, 'done');
  assert.equal(task.planningRevision, 1);
});

test('invalid or stale planning completion has no cancellation side effect', async () => {
  let queueResolutions = 0;
  const fixture = mkRuntime({
    resolveSessionQueue: async () => { queueResolutions++; return { ok: true }; },
  });
  const observed = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'observed-task', dirId: 'dir-1', sessionId: 'sess-1', origin: 'session', now: 1,
  });
  const planned = planning.createPlannedTask(fixture.runtime.getBoard(), {
    title: '计划任务', dirId: 'dir-1', workflowStage: 'doing',
  }).task;
  const routes = planningRoutes(fixture.runtime);
  const observedMove = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/move')({
    params: { taskId: observed.id }, body: { workflowStage: 'done', expectedRevision: 1 },
  }, observedMove);
  assert.equal(observedMove.code, 409);
  assert.equal(observedMove.body.error, 'task_not_planned');
  const staleMove = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/move')({
    params: { taskId: planned.id }, body: { workflowStage: 'done', expectedRevision: 99 },
  }, staleMove);
  assert.equal(staleMove.code, 409);
  assert.equal(staleMove.body.error, 'revision_conflict');
  assert.equal(queueResolutions, 0);
});

test('planning persistence failure returns 500 and leaves no phantom mutation', async () => {
  const fixture = mkRuntime({ atomicWriteJson: () => { throw new Error('disk full'); } });
  const routes = planningRoutes(fixture.runtime);
  const response = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '不能保存', dirId: 'dir-1', workflowStage: 'inbox',
  } }, response);
  assert.equal(response.code, 500);
  assert.equal(response.body.error, 'persistence_failed');
  assert.deepEqual(fixture.runtime.getBoard(), EMPTY_BOARD);
});

test('first planning write rolls back the primary file when recovery sidecar fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-planning-sidecar-'));
  const file = path.join(dir, 'task_board.json');
  const fixture = mkRuntime({
    file,
    atomicWriteJson: (target, value) => {
      if (target.endsWith('.planning-v2.json')) throw new Error('sidecar denied');
      fs.writeFileSync(target, JSON.stringify(value));
    },
  });
  const routes = planningRoutes(fixture.runtime);
  const response = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '不能半保存', dirId: 'dir-1', workflowStage: 'inbox',
  } }, response);
  assert.equal(response.code, 500);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fixture.runtime.getBoard(), EMPTY_BOARD);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a delivered planned send reports persistence failure and does not fake doing', async () => {
  let failWrites = false;
  const fixture = mkRuntime({
    atomicWriteJson: (file, value) => {
      if (failWrites) throw new Error('disk full');
      fs.writeFileSync(file, JSON.stringify(value));
    },
  });
  const routes = planningRoutes(fixture.runtime);
  const created = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '发送落盘失败', dirId: 'dir-1', workflowStage: 'ready',
  } }, created);
  failWrites = true;
  const sent = planningResponse();
  routes.get('POST /api/task-board/tasks/:taskId/send')({
    params: { taskId: created.body.task.id },
    body: { text: '开始执行', clientMsgId: 'persist-fail-send' },
  }, sent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.code, 500);
  assert.equal(sent.body.error, 'persistence_failed');
  assert.equal(fixture.sessionMessages.length, 1, 'delivery is surfaced honestly on retry');
  assert.equal(fixture.runtime.getBoard().tasks[created.body.task.id].workflowStage, 'ready');
});

test('status planning alignment rolls back and reports 500 when persistence fails', async () => {
  const fixture = mkRuntime({ atomicWriteJson: () => { throw new Error('read only'); } });
  const task = planning.createPlannedTask(fixture.runtime.getBoard(), {
    title: '不能完成', dirId: 'dir-1', workflowStage: 'review',
  }).task;
  const routes = planningRoutes(fixture.runtime);
  const response = planningResponse();
  await routes.get('POST /api/task-board/tasks/:taskId/status')({
    params: { taskId: task.id }, body: { status: 'done', expectedRevision: 1 },
  }, response);
  assert.equal(response.code, 500);
  assert.equal(response.body.error, 'persistence_failed');
  assert.equal(task.status, 'active');
  assert.equal(task.workflowStage, 'review');
  assert.equal(task.planningRevision, 1);
});

test('legacy board migration creates a non-overwriting pre-planning backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-planning-migrate-'));
  const file = path.join(dir, 'task_board.json');
  const legacy = { modules: {}, tasks: {
    legacy: { title: '旧任务', status: 'active', refs: [] },
  } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const fixture = mkRuntime({ file });
  assert.equal(fixture.runtime.getBoard().tasks.legacy.recordType, 'observed');
  const backup = path.join(dir, 'task_board.pre-planning-v1.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), legacy);
  fs.writeFileSync(backup, JSON.stringify({ sentinel: true }));
  const second = createTaskBoardRuntime(fixture.deps);
  assert.ok(second.getBoard().tasks.legacy);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), { sentinel: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the current v2 recovery sidecar restores planning data after a downgraded writer strips it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-planning-recover-'));
  const file = path.join(dir, 'task_board.json');
  const fixture = mkRuntime({ file });
  const routes = planningRoutes(fixture.runtime);
  const created = planningResponse();
  await routes.get('POST /api/task-board/tasks')({ body: {
    title: '必须恢复', description: '不能被旧版本剥掉', dirId: 'dir-1',
  } }, created);
  const recovery = path.join(dir, 'task_board.planning-v2.json');
  assert.equal(JSON.parse(fs.readFileSync(recovery, 'utf8')).tasks[created.body.task.id].description,
    '不能被旧版本剥掉');
  fs.writeFileSync(file, JSON.stringify({ modules: {}, tasks: {
    legacy: { title: '降级写入', status: 'active', refs: [] },
  } }));
  const restored = createTaskBoardRuntime(fixture.deps);
  assert.equal(restored.getBoard().tasks[created.body.task.id].description, '不能被旧版本剥掉');
  assert.equal(restored.getBoard().schemaVersion, planning.TASK_BOARD_SCHEMA_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
});

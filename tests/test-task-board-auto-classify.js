'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/task-board');
const { createTaskBoardRuntime } = require('../src/routes/task-board');

function fixture(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-auto-'));
  const auxCalls = [];
  let auxResolve = null;
  const records = overrides.records instanceof Map
    ? overrides.records
    : new Map([['sess-1', {
        id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1',
      }]]);
  const deps = {
    file: path.join(tmp, 'task_board.json'),
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue(task) {
        auxCalls.push(task);
        return new Promise(resolve => { auxResolve = resolve; });
      },
    },
    records,
    loadHistory: () => [],
    dispatchToSession: async () => ({ ok: true }),
    sendSessionMessage: async () => ({ ok: true }),
    workspaceBroadcast: () => {},
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'idle',
    logger: { log: () => {} },
    ...overrides,
  };
  const runtime = createTaskBoardRuntime(deps);
  return {
    runtime,
    auxCalls,
    resolveAux(value) {
      assert.equal(typeof auxResolve, 'function');
      auxResolve(value);
    },
  };
}

function mountRoutes(runtime) {
  const routes = new Map();
  runtime.mountRoutes({
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  });
  return routes;
}

function response() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('automatic classification recovers canonical taskId context from a partial annotation', () => {
  const history = [
    { id: 'u-canonical', role: 'user', content: '恢复 canonical 上下文', taskId: 'task-canonical', ts: 1 },
    { id: 'a-canonical', role: 'assistant', content: '已完成上下文恢复。', taskId: 'task-canonical', ts: 2 },
  ];
  const { runtime, auxCalls } = fixture({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-canonical', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: '恢复 canonical 上下文', now: 1,
  });
  pending.refs[0].userMsgId = 'stale-user-id';
  pending.refs[0].assistantMsgId = 'stale-assistant-id';

  const result = runtime.onTaskAttributionSettled('sess-1', pending.id, [history[1]], {
    runId: 'intent-partial',
  });
  assert.equal(result.queued, true);
  assert.equal(auxCalls.length, 1);
  assert.match(auxCalls[0].prompt, /恢复 canonical 上下文/);
  assert.equal(pending.status, 'active');
});

test('settled attribution classifies a user-only failed turn without archiving it', () => {
  const user = { id: 'u-only', role: 'user', content: '只根据用户请求自动归类', ts: 1 };
  const { runtime, auxCalls } = fixture({ loadHistory: () => [user] });
  const pending = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-user-only', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: user.content, now: 1,
  });
  pending.refs[0].userMsgId = user.id;

  const result = runtime.onTaskAttributionSettled('sess-1', pending.id, [user], {
    runId: 'intent-user-only',
  });
  assert.equal(result.queued, true);
  assert.equal(pending.status, 'active');
  assert.match(auxCalls[0].prompt, /尚无助手回复/);
});

test('automatic classification deduplicates one attribution and caps failed retries', async () => {
  const history = [
    { id: 'u-retry', role: 'user', content: '归类失败重试上限', ts: 1 },
    { id: 'a-retry', role: 'assistant', content: '完成。', ts: 2 },
  ];
  const { runtime, auxCalls, resolveAux } = fixture({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-auto-retry', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: history[0].content, now: 1,
  });
  pending.refs[0].userMsgId = history[0].id;
  pending.refs[0].assistantMsgId = history[1].id;

  assert.equal(runtime.onTaskAttributionSettled('sess-1', pending.id, history, {
    runId: 'intent-1',
  }).queued, true);
  resolveAux({ cancelled: false, text: '{"tasks":[]}' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.moduleAssignment.lastError, 'empty_classification');
  assert.equal(runtime.onTaskAttributionSettled('sess-1', pending.id, history, {
    runId: 'intent-1',
  }).error, 'attribution_already_handled');

  assert.equal(runtime.onTaskAttributionSettled('sess-1', pending.id, history, {
    runId: 'intent-2',
  }).queued, true);
  resolveAux({ cancelled: false, text: '{"tasks":[]}' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.onTaskAttributionSettled('sess-1', pending.id, history, {
    runId: 'intent-3',
  }).error, 'automatic_attempt_limit');
  assert.equal(auxCalls.length, 2);
});

test('task-bound attribution cannot split the explicit board task identity', () => {
  const history = [
    { id: 'u-bound', role: 'user', content: '继续显式任务', ts: 1 },
    { id: 'a-bound', role: 'assistant', content: '继续完成。', ts: 2 },
  ];
  const records = new Map([['bound-explicit', {
    id: 'bound-explicit', kind: 'chat', dirId: 'dir-1', taskBoundTaskId: 'task-explicit',
  }]]);
  const { runtime } = fixture({ records, loadHistory: () => history });
  const explicit = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-explicit', dirId: 'dir-1', sessionId: 'bound-explicit',
    taskText: '继续显式任务', origin: 'board', now: 1,
  });
  explicit.refs[0].userMsgId = history[0].id;
  explicit.refs[0].assistantMsgId = history[1].id;
  explicit.chatSessionId = 'bound-explicit';

  assert.equal(runtime.reassignTurnTask(
    'bound-explicit', explicit.id, 'task-invented', history,
    { taskName: '错误的新身份', taskText: history[0].content },
  ), false);
  assert.equal(runtime.getBoard().tasks['task-invented'], undefined);
  assert.equal(explicit.status, 'active');
  assert.equal(explicit.refs.length, 1);
  assert.equal(explicit.chatSessionId, 'bound-explicit');
});

test('startup rechecks a stale missing-context error before archiving', () => {
  const history = [
    { id: 'u-restored', role: 'user', content: '恢复后的正文', taskId: 'task-restored', ts: 1 },
    { id: 'a-restored', role: 'assistant', content: '恢复后的回复', taskId: 'task-restored', ts: 2 },
  ];
  const { runtime, auxCalls } = fixture({ loadHistory: () => history });
  const pending = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-restored', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: history[0].content, now: 1,
  });
  pending.refs[0].userMsgId = 'old-user-id';
  pending.refs[0].assistantMsgId = 'old-assistant-id';
  pending.moduleAssignment.lastError = 'missing_context';

  assert.equal(runtime.scanPendingClassifications(99), 1);
  assert.equal(pending.status, 'active');
  assert.equal(pending.moduleAssignment.lastError, '');
  assert.equal(auxCalls.length, 0);
});

test('an unreadable context store fails open instead of archiving the card', () => {
  const { runtime } = fixture({
    loadHistory: () => { throw new Error('temporary read failure'); },
  });
  const pending = core.createPendingTask(runtime.getBoard(), {
    taskId: 'task-unreadable', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: '上下文暂时不可读', now: 1,
  });
  const routes = mountRoutes(runtime);
  const res = response();

  routes.get('POST /api/task-board/tasks/:taskId/reclassify')({
    params: { taskId: pending.id }, body: {},
  }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'context_unavailable');
  assert.equal(pending.status, 'active');
  assert.equal(pending.moduleAssignment.lastError, '');
});

test('bulk cleanup still archives missing context while Aux is unhealthy', () => {
  const history = [
    { id: 'u-health', role: 'user', content: '有效但 Aux 不健康', ts: 1 },
    { id: 'a-health', role: 'assistant', content: '完成。', ts: 2 },
  ];
  const { runtime } = fixture({
    loadHistory: sessionId => sessionId === 'sess-1' ? history : [],
    auxQueue: {
      isUnhealthy: () => true,
      cancel: () => {},
      enqueue: () => { throw new Error('must not enqueue while unhealthy'); },
    },
  });
  const board = runtime.getBoard();
  const valid = core.createPendingTask(board, {
    taskId: 'task-health', dirId: 'dir-1', sessionId: 'sess-1',
    taskText: history[0].content, now: 1,
  });
  valid.refs[0].userMsgId = history[0].id;
  valid.refs[0].assistantMsgId = history[1].id;
  const missing = core.createPendingTask(board, {
    taskId: 'task-health-missing', dirId: 'dir-1', sessionId: 'gone',
    taskText: '已删除历史', now: 2,
  });
  const routes = mountRoutes(runtime);
  const res = response();

  routes.get('POST /api/task-board/reclassify-pending')({
    body: { dirId: 'dir-1' },
  }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(
    { queued: res.body.queued, archived: res.body.archived, skipped: res.body.skipped },
    { queued: 0, archived: 1, skipped: 1 },
  );
  assert.equal(valid.status, 'active');
  assert.equal(valid.moduleAssignment.lastError, 'aux_unhealthy');
  assert.equal(missing.status, 'archived');
});

'use strict';

// A3 split (follow-up to design D3): the unified chat view's stop button must
// NOT mark the task card done — it only stops the open run. The board's ✅
// keeps the lifecycle semantics. cancel-run therefore shares the done path's
// run-cancellation machinery and its exact 409 surface, but never writes
// task.status. These tests pin that contract against the real runtime.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const core = require('../src/task-board');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { createTaskRunStore } = require('../src/task-run-store');

function mkRuntime(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cancelrun-'));
  const file = path.join(tmp, 'task_board.json');
  const deps = {
    file,
    auxQueue: {
      isUnhealthy: () => false,
      cancel: () => {},
      enqueue() { return new Promise(() => {}); },
    },
    records: new Map([
      ['sess-1', { id: 'sess-1', kind: 'chat', type: 'worker', dirId: 'dir-1', label: '工程师1' }],
      ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
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
  return { runtime: createTaskBoardRuntime(deps), deps };
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

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('cancel-run stops the open TaskRun without touching task lifecycle', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cancelrun-bound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskRuns = createTaskRunStore({ file: path.join(dir, 'runs.sqlite'), Database });
  t.after(() => taskRuns.close());
  const run = taskRuns.beginRun({
    runId: 'run-open', taskId: 'task-open', attemptId: 'run-open', slotId: null,
    startedAt: 10, metadata: {},
  });
  taskRuns.bindRunSlot({ runId: run.runId, slotId: 'task-slot-1' });
  let allowTermination = false;
  const terminations = [];
  const fixture = mkRuntime({
    file: path.join(dir, 'board.json'), taskRuns,
    terminateTaskRun: async request => {
      terminations.push(request);
      return allowTermination
        ? { ok: true, duplicate: terminations.length > 1 }
        : { ok: false, code: 'task_run_busy' };
    },
  });
  const task = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'task-open', dirId: 'dir-1', sessionId: 'sess-1', taskText: '开放任务', now: 1,
  });
  delete task.moduleAssignment;
  const idle = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'task-idle', dirId: 'dir-1', sessionId: 'sess-1', taskText: '空闲任务', now: 2,
  });
  delete idle.moduleAssignment;
  const routes = mkRoutes(fixture.runtime);

  // Same failure surface as the done path: a refused termination is a 409 and
  // leaves both the run and the card alone.
  const blocked = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: task.id }, body: {},
  }, blocked);
  await settle();
  assert.equal(blocked.code, 409);
  assert.equal(blocked.body.error, 'task_run_busy');
  assert.equal(task.status, 'active');

  allowTermination = true;
  const stopped = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: task.id }, body: {},
  }, stopped);
  await settle();
  assert.equal(stopped.code, 200);
  assert.equal(stopped.body.ok, true);
  assert.equal(stopped.body.cancelled, true);
  assert.equal(stopped.body.runId, run.runId);
  // The lifecycle is untouched — that is the whole point of the split.
  assert.equal(task.status, 'active');
  assert.equal(stopped.body.task.status, 'active');
  assert.deepEqual(terminations.at(-1), {
    taskId: task.id, runId: run.runId, slotId: 'task-slot-1', leaseEpoch: run.leaseEpoch,
  });

  // No open run: idempotent success, nothing cancelled, card still active.
  const noop = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: idle.id }, body: {},
  }, noop);
  await settle();
  assert.equal(noop.code, 200);
  assert.equal(noop.body.ok, true);
  assert.equal(noop.body.cancelled, false);
  assert.equal(idle.status, 'active');

  const missing = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: 'task-nope' }, body: {},
  }, missing);
  await settle();
  assert.equal(missing.code, 404);
  assert.equal(missing.body.error, 'task_not_found');
});

test('cancel-run shares the done path’s 409 surface for unbound TaskRuns', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cancelrun-unbound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskRuns = createTaskRunStore({ file: path.join(dir, 'runs.sqlite'), Database });
  t.after(() => taskRuns.close());
  const run = taskRuns.beginRun({
    runId: 'run-queued', taskId: 'task-queued', attemptId: 'run-queued',
    slotId: null, startedAt: 10, metadata: {},
  });
  let neverDelivered = false;
  const cancellations = [];
  const terminations = [];
  const fixture = mkRuntime({
    file: path.join(dir, 'board.json'), taskRuns,
    cancelUndeliveredTaskRun: async (operationId, context) => {
      cancellations.push({ operationId, context });
      return neverDelivered
        ? { ok: true, neverDelivered: true }
        : { ok: false, code: 'dispatch_already_leased' };
    },
    terminateTaskRun: async request => {
      terminations.push(request);
      return { ok: true };
    },
  });
  const task = core.createPendingTask(fixture.runtime.getBoard(), {
    taskId: 'task-queued', dirId: 'dir-1', sessionId: 'commander-1',
    taskText: '尚未投递', now: 1,
  });
  delete task.moduleAssignment;
  task.routing = {
    mode: 'commander', targetSessionId: 'commander-1',
    operationId: run.runId, status: 'queued', oneWay: true, routedAt: 1,
  };
  const routes = mkRoutes(fixture.runtime);

  const leased = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: task.id }, body: {},
  }, leased);
  await settle();
  assert.equal(leased.code, 409);
  assert.equal(leased.body.error, 'dispatch_already_leased');
  assert.equal(task.status, 'active');
  assert.equal(terminations.length, 0);

  neverDelivered = true;
  const stopped = response();
  routes.get('POST /api/task-board/tasks/:taskId/cancel-run')({
    params: { taskId: task.id }, body: {},
  }, stopped);
  await settle();
  assert.equal(stopped.code, 200);
  assert.equal(stopped.body.cancelled, true);
  assert.equal(task.status, 'active');
  assert.deepEqual(cancellations.at(-1), {
    operationId: run.runId,
    context: { taskId: task.id, runId: run.runId },
  });
  assert.deepEqual(terminations, [{
    taskId: task.id, runId: run.runId, leaseEpoch: run.leaseEpoch,
    neverDelivered: true,
  }]);
});

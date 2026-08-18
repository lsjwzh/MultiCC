'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PUBLIC_TASK_RUN_ERROR,
  createTaskRunRoutes,
  decodeRouteId,
} = require('../src/routes/task-runs');

function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post() { throw new Error('task-run read runtime must not mount POST routes'); },
    put() { throw new Error('task-run read runtime must not mount PUT routes'); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    jsonCalls: 0,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.jsonCalls += 1; return this; },
  };
}

function invoke(handler, params) {
  const res = response();
  handler({ params }, res);
  assert.equal(res.jsonCalls, 1);
  return res;
}

function fixture(overrides = {}) {
  const calls = [];
  const logs = [];
  const store = {
    getRun(runId) {
      calls.push(['getRun', runId]);
      return {
        runId, taskId: 'task-1', executionStatus: 'succeeded',
        usageStatus: 'sealed', cleanupState: 'done', startedAt: 10, terminalAt: 20,
        slotId: 'private-slot', metadata: { nativeSessionId: 'secret-native-id' },
      };
    },
    getRunMessages(runId) {
      calls.push(['getRunMessages', runId]);
      return [{
        runId, messageId: 'message-1', role: 'assistant', kind: 'message', content: 'done',
        createdAt: 20, metadata: { leaseEpoch: 7, nativeSessionId: 'secret-native-id' },
      }];
    },
    getRunUsage(runId) {
      calls.push(['getRunUsage', runId]);
      return { runId, coverage: 'observed', tokens: { total: 12 } };
    },
    listTaskRuns(taskId) {
      calls.push(['listTaskRuns', taskId]);
      return [{
        runId: 'run-1', taskId, executionStatus: 'succeeded', usageStatus: 'sealed',
        cleanupState: 'done', startedAt: 10, terminalAt: 20,
        slotId: 'private-slot', metadata: { token: 'must-not-leak' },
      }];
    },
    getTaskUsage(taskId) {
      calls.push(['getTaskUsage', taskId]);
      return { taskId, runCount: 1, tokens: { total: 12 } };
    },
    ...overrides,
  };
  const runtime = createTaskRunRoutes({
    store,
    logger: { error(event, detail) { logs.push({ event, detail }); } },
  });
  const app = createApp();
  runtime.mountRoutes(app);
  return { app, calls, logs, runtime, store };
}

test('validates injected dependencies and mounts only the two GET routes', () => {
  assert.throws(() => createTaskRunRoutes(), /store/);
  assert.throws(
    () => createTaskRunRoutes({ store: { getRun() {} } }),
    /getRunMessages/,
  );
  const { app } = fixture();
  assert.deepEqual([...app.routes.keys()].sort(), [
    'GET /api/task-runs/:runId',
    'GET /api/tasks/:taskId/runs',
  ]);
});

test('decodes and strictly validates route ids', () => {
  assert.equal(decodeRouteId('%72un-1', 'run'), 'run-1');
  assert.equal(decodeRouteId('tsk-0123_ab.cd:ef', 'task'), 'tsk-0123_ab.cd:ef');
  for (const value of ['', '%2Fetc', '%252Fetc', '%00bad', '%E0%A4%A', '..', `x${'a'.repeat(128)}`]) {
    assert.throws(
      () => decodeRouteId(value, 'run'),
      error => error.code === 'INVALID_ROUTE_ID' && error.statusCode === 400,
      value,
    );
  }
});

test('GET task run returns the durable run, messages and usage in one DTO', () => {
  const { app, calls } = fixture();
  const res = invoke(app.routes.get('GET /api/task-runs/:runId'), { runId: '%72un-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    run: {
      runId: 'run-1', taskId: 'task-1', executionStatus: 'succeeded',
      usageStatus: 'sealed', cleanupState: 'done', startedAt: 10, terminalAt: 20,
    },
    messages: [{
      runId: 'run-1', messageId: 'message-1', role: 'assistant', kind: 'message',
      content: 'done', createdAt: 20,
    }],
    usage: { runId: 'run-1', coverage: 'observed', tokens: { total: 12 } },
  });
  assert.deepEqual(calls, [
    ['getRun', 'run-1'], ['getRunMessages', 'run-1'], ['getRunUsage', 'run-1'],
  ]);
});

test('GET task runs returns runs and aggregate usage', () => {
  const { app, calls } = fixture();
  const res = invoke(app.routes.get('GET /api/tasks/:taskId/runs'), { taskId: '%74ask-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    runs: [{
      runId: 'run-1', taskId: 'task-1', executionStatus: 'succeeded',
      usageStatus: 'sealed', cleanupState: 'done', startedAt: 10, terminalAt: 20,
    }],
    usage: { taskId: 'task-1', runCount: 1, tokens: { total: 12 } },
  });
  assert.deepEqual(calls, [
    ['listTaskRuns', 'task-1'], ['getTaskUsage', 'task-1'],
  ]);
});

test('invalid ids fail with 400 before touching storage', () => {
  const { app, calls } = fixture();
  let res = invoke(app.routes.get('GET /api/task-runs/:runId'), { runId: '%2Fprivate' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid run id' });
  res = invoke(app.routes.get('GET /api/tasks/:taskId/runs'), { taskId: '%E0%A4%A' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'invalid task id' });
  assert.deepEqual(calls, []);
});

test('unknown run and task return 404 without fabricating empty usage', () => {
  const missingRun = fixture({
    getRun() {
      const error = new Error('not found');
      error.code = 'TASK_RUN_NOT_FOUND';
      throw error;
    },
  });
  let res = invoke(missingRun.app.routes.get('GET /api/task-runs/:runId'), { runId: 'run-missing' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'task run not found' });

  const missingTask = fixture({ listTaskRuns() { return []; } });
  res = invoke(missingTask.app.routes.get('GET /api/tasks/:taskId/runs'), { taskId: 'task-missing' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'task not found' });
  assert.equal(missingTask.calls.some(call => call[0] === 'getTaskUsage'), false);
});

test('storage failures return a fixed 500 response and log only a safe code', () => {
  const secret = 'credential=top-secret /Users/private/task-execution.sqlite';
  const { app, logs } = fixture({
    getRun() {
      const error = new Error(secret);
      error.code = 'SQLITE_IOERR_READ';
      throw error;
    },
  });
  const res = invoke(app.routes.get('GET /api/task-runs/:runId'), { runId: 'run-1' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: PUBLIC_TASK_RUN_ERROR });
  assert.equal(JSON.stringify(res.body).includes('top-secret'), false);
  assert.equal(JSON.stringify(logs).includes('top-secret'), false);
  assert.deepEqual(logs, [{
    event: 'task_run_route_failed',
    detail: { route: 'run-detail', code: 'SQLITE_IOERR_READ' },
  }]);
});
test('GET task run surfaces the failure summary and the partial draft flag without leaking metadata', () => {
  const { app } = fixture({
    getRun(runId) {
      return {
        runId, taskId: 'task-1', executionStatus: 'failed',
        usageStatus: 'sealed', cleanupState: 'done', startedAt: 10, terminalAt: 20,
        slotId: 'private-slot', metadata: { nativeSessionId: 'secret-native-id' },
      };
    },
    getRunMessages(runId) {
      return [
        {
          runId, messageId: 'partial-1', role: 'assistant', kind: 'message',
          content: '半截输出', createdAt: 18,
          metadata: { leaseEpoch: 7, partial: true, nativeSessionId: 'secret-native-id' },
        },
        {
          runId, messageId: 'error:run-1', role: 'system', kind: 'error',
          content: '任务执行失败（触发服务端限流）：等待服务端限流窗口结束', createdAt: 19,
          metadata: { code: 'rate_limited', category: 'rate_limit', retryable: true },
        },
      ];
    },
  });
  const res = invoke(app.routes.get('GET /api/task-runs/:runId'), { runId: '%72un-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.run, {
    runId: 'run-1', taskId: 'task-1', executionStatus: 'failed',
    usageStatus: 'sealed', cleanupState: 'done', startedAt: 10, terminalAt: 20,
    error: {
      code: 'rate_limited',
      category: 'rate_limit',
      retryable: true,
      message: '任务执行失败（触发服务端限流）：等待服务端限流窗口结束',
    },
  });
  assert.deepEqual(res.body.messages, [
    {
      runId: 'run-1', messageId: 'partial-1', role: 'assistant', kind: 'message',
      content: '半截输出', createdAt: 18, partial: true,
    },
    {
      runId: 'run-1', messageId: 'error:run-1', role: 'system', kind: 'error',
      content: '任务执行失败（触发服务端限流）：等待服务端限流窗口结束', createdAt: 19,
    },
  ]);
  assert.equal(JSON.stringify(res.body).includes('secret-native-id'), false,
    'raw metadata never leaks into the public DTO');
});

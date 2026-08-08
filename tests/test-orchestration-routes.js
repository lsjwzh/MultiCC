'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createOrchestrationRoutes } = require('../src/routes/orchestration');

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

async function invoke(app, method, route, options = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  const headers = Object.fromEntries(Object.entries(options.headers || {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  const request = {
    params: options.params || {},
    query: options.query || {},
    body: options.body,
    headers,
    protocol: options.protocol || 'http',
    get(name) { return headers[String(name).toLowerCase()] || (name.toLowerCase() === 'host' ? 'localhost:3000' : undefined); },
    id: 'request-id',
  };
  const response = {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(request, response);
  return { request, response };
}

function fixture(options = {}) {
  const records = options.records || new Map([['s1', { id: 's1', cwd: '/repo' }]]);
  const calls = [];
  const runtime = {
    operations: {
      async list(query) {
        calls.push({ type: 'operations.list', query });
        return options.operations || [];
      },
      async listTasks(query) {
        calls.push({ type: 'operations.listTasks', query });
        if (options.listTasksError) throw options.listTasksError;
        return options.tasks || [];
      },
    },
    async register(input) {
      calls.push({ type: 'register', input });
      if (options.registerError) throw options.registerError;
      return options.registration || { id: 'w1', token: 'secret', status: 'pending' };
    },
    async resolveCallback(id, token, data) {
      calls.push({ type: 'resolve', id, token, data });
      if (options.resolveError) throw options.resolveError;
      return options.resolveResult || { ok: true, id, status: 'resolved' };
    },
    async listForSession(sessionId) {
      calls.push({ type: 'listForSession', sessionId });
      if (options.listError) throw options.listError;
      return options.durableWaits || [{ id: 'durable' }];
    },
    async stats() {
      calls.push({ type: 'stats' });
      return options.durableStats || { waits: 2, outbox: 1 };
    },
    async cancel(id) {
      calls.push({ type: 'cancel', id });
      if (options.cancelError) throw options.cancelError;
      return options.cancelResult || { ok: true, id };
    },
    async startDetached(input) {
      calls.push({ type: 'startDetached', input });
      if (options.startError) throw options.startError;
      return options.started || {
        operation: { id: 'op1', externalId: 'task1', pid: 7, status: 'running' },
        state: null,
        idempotent: false,
      };
    },
  };
  if (options.scheduler) {
    runtime.sessionScheduler = {
      async status(sessionId) {
        calls.push({ type: 'queue.status', sessionId });
        return options.queueStatus || {
          sessionId,
          state: 'frozen',
          freezeReason: 'awaiting_user_input',
          active: { entryId: 'entry-1', taskId: 'task-1' },
          queued: [{ entryId: 'entry-2', position: 1 }],
        };
      },
      async resolve(sessionId, input) {
        calls.push({ type: 'queue.resolve', sessionId, input });
        return options.queueResolve || { ok: true, action: input.action };
      },
      async cancelQueued(sessionId, entryId, input) {
        calls.push({ type: 'queue.cancel-queued', sessionId, entryId, input });
        return options.queueCancelQueued || {
          ok: true,
          cancelled: { entryId },
          schedule: { state: 'frozen', queued: [] },
        };
      },
      async insertQueued(sessionId, entryId, input) {
        calls.push({ type: 'queue.insert-queued', sessionId, entryId, input });
        return options.queueInsertQueued || {
          ok: true,
          inserted: { entryId },
          schedule: { state: 'frozen', queued: [{ entryId, position: 1 }] },
        };
      },
    };
    runtime.tick = async () => {
      calls.push({ type: 'queue.tick' });
      return { ok: true };
    };
  }
  const waitInjector = {
    listForSession(sessionId) {
      calls.push({ type: 'legacy.list', sessionId });
      return options.legacyWaits || [{ id: 'legacy' }];
    },
    stats() { return options.legacyStats || { waits: 3, timers: 1 }; },
    cancel(id) {
      calls.push({ type: 'legacy.cancel', id });
      return options.legacyCancel || { ok: false, error: 'not found' };
    },
  };
  const detached = {
    status(id) {
      calls.push({ type: 'detached.status', id });
      return options.detachedStates && Object.hasOwn(options.detachedStates, id)
        ? options.detachedStates[id]
        : null;
    },
  };
  const routes = createOrchestrationRoutes({
    records,
    runtime,
    waitInjector,
    detached,
    cwdForSession: session => `/cwd/${session.id}`,
    resolveCwd: (base, value) => `${base}/${value}`,
    toWaitDto: wait => ({ waitId: wait.id, status: wait.status || null }),
    withApiMeta: (payload, context) => ({ ...payload, apiVersion: '1', requestId: context.requestId }),
    requestContext: req => ({ requestId: req.id }),
    cancelActiveTurn: async sessionId => {
      calls.push({ type: 'queue.cancel-active', sessionId });
      return { ok: true };
    },
    v1Error(req, res, status, message, code) {
      return res.status(status).json({ ok: false, error: message, code, requestId: req.id });
    },
  });
  const app = fakeApp();
  routes.mountRoutes(app);
  return { app, calls, records, routes, runtime };
}

test('dependency and mount boundaries own exactly ten routes', () => {
  assert.throws(() => createOrchestrationRoutes({}), /records.get/);
  const current = fixture();
  assert.deepEqual([...current.app.routes.keys()].sort(), [
    'DELETE /api/wait/:wid',
    'GET /api/detached/:taskId',
    'GET /api/sessions/:id/detached',
    'GET /api/sessions/:id/dispatches',
    'GET /api/sessions/:id/tasks',
    'GET /api/sessions/:id/waits',
    'GET /api/v1/sessions/:id/waits',
    'POST /api/sessions/:id/run-detached',
    'POST /api/sessions/:id/wait',
    'POST /api/wait/:wid/resolve',
  ]);
  assert.throws(() => current.routes.mountRoutes(current.app), /already mounted/);
});

test('session FIFO status and explicit resolution require confirmation and remain idempotent', async () => {
  const current = fixture({ scheduler: true });
  assert.equal(current.app.routes.has('GET /api/sessions/:id/queue'), true);
  assert.equal(current.app.routes.has('POST /api/sessions/:id/queue/action'), true);

  const status = await invoke(current.app, 'GET', '/api/sessions/:id/queue', {
    params: { id: 's1' },
  });
  assert.equal(status.response.statusCode, 200);
  assert.equal(status.response.body.queue.state, 'frozen');
  assert.equal(status.response.body.queue.freezeReason, 'awaiting_user_input');

  const unconfirmed = await invoke(current.app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    body: { action: 'skip' },
  });
  assert.equal(unconfirmed.response.statusCode, 409);
  assert.equal(unconfirmed.response.body.error, 'confirmation_required');

  const resumed = await invoke(current.app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    headers: { 'idempotency-key': 'resume-once' },
    body: {
      action: 'resume',
      confirm: true,
      reason: 'operator verified state',
      text: '继续当前任务',
    },
  });
  assert.equal(resumed.response.statusCode, 200);
  assert.deepEqual(current.calls.find(call => call.type === 'queue.resolve'), {
    type: 'queue.resolve',
    sessionId: 's1',
    input: {
      action: 'resume',
      reason: 'operator verified state',
      actor: 'user',
      text: '继续当前任务',
      idempotencyKey: 'resume-once',
    },
  });
  assert.equal(current.calls.some(call => call.type === 'queue.tick'), true);

  const cancelled = await invoke(current.app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    body: { action: 'cancel', confirm: true },
  });
  assert.equal(cancelled.response.statusCode, 200);
  assert.equal(current.calls.some(call => call.type === 'queue.cancel-active'), true);

  const queuedCancelled = await invoke(current.app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    body: {
      action: 'cancel_queued',
      entryId: 'entry-2',
      confirm: true,
      reason: 'duplicate',
    },
  });
  assert.equal(queuedCancelled.response.statusCode, 200);
  assert.deepEqual(current.calls.find(call => call.type === 'queue.cancel-queued'), {
    type: 'queue.cancel-queued',
    sessionId: 's1',
    entryId: 'entry-2',
    input: { actor: 'user', reason: 'duplicate' },
  });

  const inserted = await invoke(current.app, 'POST', '/api/sessions/:id/queue/action', {
    params: { id: 's1' },
    body: {
      action: 'insert_queued',
      entryId: 'entry-3',
      confirm: true,
    },
  });
  assert.equal(inserted.response.statusCode, 200);
  assert.deepEqual(current.calls.find(call => call.type === 'queue.insert-queued'), {
    type: 'queue.insert-queued',
    sessionId: 's1',
    entryId: 'entry-3',
    input: { actor: 'user' },
  });
  assert.equal(
    current.calls.filter(call => call.type === 'queue.cancel-active').length,
    2,
    'insert now cancels/releases the current turn before ticking the selected entry',
  );
});

test('wait registration preserves validation payload, callback URL and errors', async () => {
  const missing = fixture({ records: new Map() });
  const notFound = await invoke(missing.app, 'POST', '/api/sessions/:id/wait', {
    params: { id: 'missing' }, body: {},
  });
  assert.equal(notFound.response.statusCode, 404);

  const current = fixture();
  const registered = await invoke(current.app, 'POST', '/api/sessions/:id/wait', {
    params: { id: 's1' },
    protocol: 'https',
    headers: { host: 'example.test' },
    body: {
      mode: 'poll', pollCmd: 'echo ok', pollUrl: 'https://probe',
      untilContains: 'DONE', untilRegex: 'D.NE', intervalSec: 4,
      maxChecks: 8, injectPrefix: 'prefix', timeoutSec: 20,
    },
  });
  assert.equal(registered.response.statusCode, 200);
  assert.equal(registered.response.body.callbackUrl,
    'https://example.test/api/wait/w1/resolve?token=secret');
  assert.deepEqual(current.calls[0].input, {
    session: 's1', mode: 'poll', cwd: '/cwd/s1', pollCmd: 'echo ok', pollUrl: 'https://probe',
    untilContains: 'DONE', untilRegex: 'D.NE', intervalSec: 4, maxChecks: 8,
    injectPrefix: 'prefix', timeoutSec: 20,
  });

  const failed = fixture({ registerError: new Error('invalid wait') });
  const response = await invoke(failed.app, 'POST', '/api/sessions/:id/wait', {
    params: { id: 's1' }, body: {},
  });
  assert.equal(response.response.statusCode, 400);
  assert.deepEqual(response.response.body, { error: 'invalid wait' });
});

test('callback strips body token and preserves success, duplicate and error mappings', async () => {
  const current = fixture({ resolveResult: { ok: true, idempotent: true } });
  const resolved = await invoke(current.app, 'POST', '/api/wait/:wid/resolve', {
    params: { wid: 'w1' }, body: { token: 'body-secret', answer: 42 },
  });
  assert.equal(resolved.response.statusCode, 200);
  assert.deepEqual(current.calls[0], {
    type: 'resolve', id: 'w1', token: 'body-secret', data: { answer: 42 },
  });
  assert.equal(resolved.response.body.duplicate, true);
  assert.equal(resolved.response.body.status, 'resolved');

  for (const [code, status, error] of [
    ['invalid_token', 403, 'bad token'],
    ['not_found', 404, 'wait not found'],
    ['payload_conflict', 409, 'callback payload conflicts with resolved wait'],
    ['invalid', 400, 'invalid'],
  ]) {
    const failure = fixture({ resolveResult: { ok: false, code } });
    const result = await invoke(failure.app, 'POST', '/api/wait/:wid/resolve', {
      params: { wid: 'w1' }, query: { token: 'query-token' }, body: { data: 'value' },
    });
    assert.equal(result.response.statusCode, status);
    assert.equal(result.response.body.error, error);
    assert.equal(failure.calls[0].token, 'query-token');
    assert.equal(failure.calls[0].data, 'value');
  }

  const thrown = fixture({ resolveError: Object.assign(new Error('bad callback'), { statusCode: 422 }) });
  const result = await invoke(thrown.app, 'POST', '/api/wait/:wid/resolve', {
    params: { wid: 'w1' }, headers: { 'x-wait-token': 'header-token' }, body: '',
  });
  assert.equal(result.response.statusCode, 422);
  assert.equal(thrown.calls[0].token, 'header-token');
});

test('legacy and v1 wait lists merge durable state without changing contracts', async () => {
  const current = fixture({
    durableWaits: [{ id: 'd1', status: 'resolved' }],
    legacyWaits: [{ id: 'l1', mode: 'poll' }],
    durableStats: { waits: 2, outbox: 4 },
    legacyStats: { waits: 3, timers: 5 },
  });
  const legacy = await invoke(current.app, 'GET', '/api/sessions/:id/waits', { params: { id: 's1' } });
  assert.deepEqual(legacy.response.body.waits, [
    { id: 'd1', status: 'resolved' },
    { id: 'l1', mode: 'poll', status: 'pending' },
  ]);
  assert.deepEqual(legacy.response.body.stats, {
    waits: 5, timers: 5, outbox: 4, legacyWaits: 3,
  });
  const v1 = await invoke(current.app, 'GET', '/api/v1/sessions/:id/waits', {
    params: { id: 's1' },
  });
  assert.equal(v1.response.body.apiVersion, '1');
  assert.deepEqual(v1.response.body.waits, [
    { waitId: 'd1', status: 'resolved' }, { waitId: 'l1', status: 'pending' },
  ]);
  assert.equal(v1.response.body.count, 2);

  const missing = fixture({ records: new Map() });
  const notFound = await invoke(missing.app, 'GET', '/api/v1/sessions/:id/waits', {
    params: { id: 'missing' },
  });
  assert.equal(notFound.response.statusCode, 404);
  assert.equal(notFound.response.body.code, 'session_not_found');

  const failed = fixture({ listError: new Error('disk') });
  const legacyFailure = await invoke(failed.app, 'GET', '/api/sessions/:id/waits', {
    params: { id: 's1' },
  });
  assert.equal(legacyFailure.response.statusCode, 500);
  const v1Failure = await invoke(failed.app, 'GET', '/api/v1/sessions/:id/waits', {
    params: { id: 's1' },
  });
  assert.equal(v1Failure.response.statusCode, 500);
  assert.equal(v1Failure.response.body.code, 'wait_list_failed');
});

test('wait cancellation falls back to legacy and keeps status mapping', async () => {
  const fallback = fixture({
    cancelResult: { ok: false, code: 'not_found' },
    legacyCancel: { ok: true, id: 'legacy' },
  });
  const cancelled = await invoke(fallback.app, 'DELETE', '/api/wait/:wid', {
    params: { wid: 'w1' },
  });
  assert.equal(cancelled.response.statusCode, 200);
  assert.deepEqual(cancelled.response.body, { ok: true, id: 'legacy', status: 'cancelled' });

  const conflict = fixture({ cancelResult: { ok: false, code: 'leased' } });
  assert.equal((await invoke(conflict.app, 'DELETE', '/api/wait/:wid', {
    params: { wid: 'w1' },
  })).response.statusCode, 409);
  const missing = fixture({ cancelResult: { ok: false, code: 'not_found' } });
  assert.equal((await invoke(missing.app, 'DELETE', '/api/wait/:wid', {
    params: { wid: 'w1' },
  })).response.statusCode, 404);
});

test('run-detached preserves cwd, idempotency, defaults, daemon and response DTO', async () => {
  const missing = fixture({ records: new Map() });
  assert.equal((await invoke(missing.app, 'POST', '/api/sessions/:id/run-detached', {
    params: { id: 'missing' }, body: { command: 'echo ok' },
  })).response.statusCode, 404);
  const empty = fixture();
  assert.equal((await invoke(empty.app, 'POST', '/api/sessions/:id/run-detached', {
    params: { id: 's1' }, body: {},
  })).response.statusCode, 400);

  const current = fixture({
    started: {
      operation: { id: 'op1', externalId: 'task1', pid: null, status: 'running' },
      state: { pid: 99, logPath: '/tmp/log' },
      idempotent: true,
    },
  });
  const started = await invoke(current.app, 'POST', '/api/sessions/:id/run-detached', {
    params: { id: 's1' },
    headers: { 'idempotency-key': 'header-key' },
    body: { cmd: '  npm   run build  ', cwd: 'sub', daemon: 'true', intervalSec: 1, maxChecks: 0 },
  });
  assert.equal(started.response.statusCode, 200);
  assert.deepEqual(current.calls[0].input, {
    sessionId: 's1',
    idempotencyKey: 'header-key',
    spec: {
      command: '  npm   run build  ', cwd: '/cwd/s1/sub', label: 'npm run build',
      daemon: true, intervalSec: 3, maxChecks: 360,
      injectPrefix: '[后台任务完成] npm run build',
    },
  });
  assert.deepEqual(started.response.body, {
    ok: true, executionKind: 'detached_process', workerDispatched: false,
    dispatchEndpoint: '/api/sessions/s1/dispatch',
    note: '已启动后台 shell 进程；这不会向 worker 会话派活。如需派活，请调用 POST /api/sessions/s1/dispatch。',
    taskId: 'task1', waitId: null, pid: 99, logPath: '/tmp/log',
    intervalSec: 3, maxChecks: 360, daemon: true, operationId: 'op1',
    status: 'running', duplicate: true,
  });

  const failed = fixture({ startError: Object.assign(new Error('duplicate key'), { statusCode: 409, operationId: 'op2' }) });
  const error = await invoke(failed.app, 'POST', '/api/sessions/:id/run-detached', {
    params: { id: 's1' }, body: { command: 'echo ok' },
  });
  assert.equal(error.response.statusCode, 409);
  assert.deepEqual(error.response.body, { error: 'duplicate key', operationId: 'op2' });
});

test('detached and task query routes preserve filtering and status enrichment', async () => {
  const operations = [
    { id: 'op1', externalId: 'task1', status: 'running' },
    { id: 'op2', externalId: 'missing', status: 'done' },
  ];
  const current = fixture({
    operations,
    detachedStates: { task1: { pid: 10, done: false } },
    tasks: [{ id: 'native1', status: 'interrupted' }],
  });
  const list = await invoke(current.app, 'GET', '/api/sessions/:id/detached', {
    params: { id: 's1' },
  });
  assert.deepEqual(list.response.body.tasks, [
    { pid: 10, done: false, operationId: 'op1', status: 'running' },
  ]);
  assert.deepEqual(current.calls[0].query, { kind: 'detached', ownerSessionId: 's1' });

  const tasks = await invoke(current.app, 'GET', '/api/sessions/:id/tasks', {
    params: { id: 's1' },
  });
  assert.deepEqual(tasks.response.body, {
    tasks: [{ id: 'native1', status: 'interrupted' }], count: 1,
  });
  const status = await invoke(current.app, 'GET', '/api/detached/:taskId', {
    params: { taskId: 'task1' },
  });
  assert.equal(status.response.body.operationId, 'op1');
  assert.equal(status.response.body.status, 'running');

  const missing = await invoke(current.app, 'GET', '/api/detached/:taskId', {
    params: { taskId: 'unknown' },
  });
  assert.equal(missing.response.statusCode, 404);
});

test('session dispatch query joins durable operations with authoritative FIFO state', async () => {
  const operations = [
    {
      id: 'op-running', kind: 'dispatch', ownerSessionId: 's1', status: 'admitted',
      requestOutboxId: 'operation:op-running:request', createdAt: 20, updatedAt: 21,
      spec: { targetId: 'worker', chatId: 'worker', taskId: 'task-live', resultMode: 'sync' },
    },
    {
      id: 'op-targeted', kind: 'dispatch', ownerSessionId: 'caller', status: 'completed',
      requestOutboxId: 'operation:op-targeted:request', createdAt: 10, completedAt: 15,
      spec: { targetId: 's1', chatId: 's1', taskId: 'task-old', resultMode: 'async' },
    },
    {
      id: 'op-unrelated', kind: 'dispatch', ownerSessionId: 'other', status: 'running',
      createdAt: 30, spec: { targetId: 'elsewhere', chatId: 'elsewhere' },
    },
  ];
  const current = fixture({
    scheduler: true,
    operations,
    queueStatus: {
      active: { entryId: 'operation:op-running:request' }, queued: [],
    },
  });
  const active = await invoke(current.app, 'GET', '/api/sessions/:id/dispatches', {
    params: { id: 's1' }, query: {},
  });
  assert.equal(active.response.statusCode, 200);
  assert.equal(active.response.body.authoritative, 'durable_operation_plus_target_fifo');
  assert.equal(active.response.body.count, 1);
  assert.deepEqual(active.response.body.dispatches[0], {
    operationId: 'op-running', status: 'admitted', terminal: false,
    relation: 'owner', ownerSessionId: 's1', targetSessionId: 'worker',
    executionSessionId: 'worker', taskId: 'task-live', mode: 'sync',
    queueState: 'started', createdAt: 20, startedAt: null,
    completedAt: null, updatedAt: 21,
  });
  assert.match(active.response.body.note, /not dispatch completion/);

  const allTargeted = await invoke(current.app, 'GET', '/api/sessions/:id/dispatches', {
    params: { id: 's1' }, query: { relation: 'target', activeOnly: 'false' },
  });
  assert.equal(allTargeted.response.body.count, 1);
  assert.equal(allTargeted.response.body.dispatches[0].operationId, 'op-targeted');
  assert.equal(allTargeted.response.body.dispatches[0].queueState, 'terminal');

  const invalid = await invoke(current.app, 'GET', '/api/sessions/:id/dispatches', {
    params: { id: 's1' }, query: { relation: 'invalid' },
  });
  assert.equal(invalid.response.statusCode, 400);
});

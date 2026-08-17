'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WORKER_TYPE,
  createCommanderRouter,
  isTrustedLegacyWorker,
} = require('../src/commander-router');

function commander() {
  return { id: 'commander', dirId: 'fleet', kind: 'chat', type: 'commander', label: '指挥' };
}

function worker(id, overrides = {}) {
  return {
    id, dirId: 'fleet', kind: 'chat', type: WORKER_TYPE,
    label: id, rolePrompt: '# 角色：全栈工程师\n执行工程任务',
    ...overrides,
  };
}

function harness({ initial = [], busy = new Set(), maxElasticWorkers = 4 } = {}) {
  const records = new Map([["commander", commander()], ...initial.map(record => [record.id, record])]);
  const stamps = [];
  const creates = [];
  const dispatches = [];
  const router = createCommanderRouter({
    records,
    isBusy: id => busy.has(id),
    maxElasticWorkers,
    stampWorker: id => {
      const record = records.get(id);
      record.type = WORKER_TYPE;
      stamps.push(id);
      return record;
    },
    createWorker: ({ commander: owner, template, ordinal, rolePrompt }) => {
      const record = worker(`elastic-${ordinal}`, {
        label: `弹性 Worker ${ordinal}`, elasticWorker: true, ephemeral: true,
        rolePrompt, workerTemplateId: template?.id || null, dirId: owner.dirId,
      });
      records.set(record.id, record);
      creates.push(record);
      return { ok: true, id: record.id, session: record };
    },
    dispatchOneWay: async (target, message, options) => {
      dispatches.push({ target, message, options });
      return { ok: true, operationId: `op-${dispatches.length}`, status: 'admitted' };
    },
    logger: { warn() {} },
  });
  return { records, router, stamps, creates, dispatches };
}

test('only stable worker metadata is auto-routable; specialist roles are ignored', async () => {
  const h = harness({ initial: [
    worker('backend', { label: '全栈工程师 1', rolePrompt: '# 角色：全栈工程师 1\n后端 API 数据安全' }),
    { id: 'architect', dirId: 'fleet', kind: 'chat', label: '架构师', rolePrompt: '系统架构' },
    { id: 'product', dirId: 'fleet', kind: 'chat', label: '产品 · UI · UX', rolePrompt: '产品设计' },
  ] });
  const result = await h.router.route({
    commanderId: 'commander',
    message: '修复后端 API',
    taskId: 'tsk-route',
    taskStart: true,
    taskSource: 'commander',
    taskText: '修复后端 API',
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetSessionId, 'backend');
  assert.deepEqual(h.dispatches.map(item => item.target), ['backend']);
  assert.equal(h.dispatches[0].options.commanderId, 'commander');
  assert.deepEqual(
    {
      taskId: h.dispatches[0].options.taskId,
      taskStart: h.dispatches[0].options.taskStart,
      taskSource: h.dispatches[0].options.taskSource,
      taskText: h.dispatches[0].options.taskText,
    },
    {
      taskId: 'tsk-route',
      taskStart: true,
      taskSource: 'commander',
      taskText: '修复后端 API',
    },
  );
});

test('trusted full-stack legacy sessions are stamped once before routing', async () => {
  const legacy = {
    id: 'legacy', dirId: 'fleet', kind: 'chat', label: '全栈工程师 2',
    rolePrompt: '# 角色：全栈工程师 2\n负责 Web 和 App',
  };
  assert.equal(isTrustedLegacyWorker(legacy, 'fleet'), true);
  assert.equal(isTrustedLegacyWorker({ ...legacy, label: '架构师' }, 'fleet'), false);
  const h = harness({ initial: [legacy] });
  const result = await h.router.route({ commanderId: 'commander', message: '修复 Web UI' });
  assert.equal(result.targetSessionId, 'legacy');
  assert.deepEqual(h.stamps, ['legacy']);
  assert.equal(h.records.get('legacy').type, WORKER_TYPE);
});

test('all workers busy creates one elastic worker and dispatches one-way', async () => {
  const h = harness({
    initial: [worker('w1'), worker('w2')],
    busy: new Set(['w1', 'w2']),
  });
  const result = await h.router.route({ commanderId: 'commander', message: '实现功能', idempotencyKey: 'route-1' });
  assert.equal(result.elasticWorkerCreated, true);
  assert.equal(result.targetSessionId, 'elastic-3');
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].elasticWorker, true);
  assert.equal(h.dispatches[0].options.idempotencyKey, 'route-1');
});

test('elastic cap queues on a worker instead of creating specialists or dropping work', async () => {
  const h = harness({
    initial: [
      worker('base'),
      worker('elastic', { elasticWorker: true, ephemeral: true }),
      { id: 'i18n', dirId: 'fleet', kind: 'chat', label: 'i18n 检查师' },
    ],
    busy: new Set(['base', 'elastic']),
    maxElasticWorkers: 1,
  });
  const result = await h.router.route({ commanderId: 'commander', message: '继续实现' });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(result.elasticWorkerCreated, false);
  assert.equal(h.creates.length, 0);
  assert.ok(['base', 'elastic'].includes(result.targetSessionId));
});

test('ordinary Commander routing never selects an internal TaskRun execution slot', async () => {
  const h = harness({
    initial: [
      worker('visible', { label: '可见 Worker' }),
      worker('task-slot', {
        label: '内部临时槽', ephemeral: true, elasticWorker: true,
        taskExecutionSlot: true,
      }),
    ],
    busy: new Set(['visible']),
    maxElasticWorkers: 1,
  });

  const result = await h.router.route({
    commanderId: 'commander',
    message: '这是普通 Commander 任务',
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetSessionId, 'elastic-2');
  assert.notEqual(result.targetSessionId, 'task-slot');
  assert.deepEqual(h.dispatches.map(item => item.target), ['elastic-2']);
});

test('missing Commander fails closed and simultaneous scale-out is serialized', async () => {
  const missing = harness({ initial: [worker('w')] });
  assert.deepEqual(await missing.router.route({ commanderId: 'nope', message: 'x' }), {
    ok: false, code: 'commander_not_found',
  });

  const h = harness({ initial: [worker('busy')], busy: new Set(['busy']) });
  const [a, b] = await Promise.all([
    h.router.route({ commanderId: 'commander', message: 'A' }),
    h.router.route({ commanderId: 'commander', message: 'B' }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.creates.length, 1, 'the second route reuses the freshly-created idle worker');
});

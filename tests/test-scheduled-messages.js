'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createOrchestrationRuntime } = require('../src/orchestration-runtime');

function createFixture(t, overrides = {}) {
  const dir = overrides.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-scheduled-message-'));
  if (!overrides.dir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = overrides.file || path.join(dir, 'orchestration.json');
  const clock = overrides.clock || { value: 10_000 };
  const history = overrides.history || new Map();
  const injections = overrides.injections || [];
  const schedulerEvents = overrides.schedulerEvents || [];
  const runtime = createOrchestrationRuntime({
    file,
    ...(overrides.databaseFile ? { databaseFile: overrides.databaseFile } : {}),
    now: () => clock.value,
    isBusy: overrides.isBusy || (() => false),
    onSchedulerEvent: event => schedulerEvents.push(event),
    runChatTurn: async (sessionId, text, options) => {
      injections.push({ sessionId, text, options });
      const delivered = history.get(sessionId) || new Set();
      delivered.add(options.deliveryId);
      history.set(sessionId, delivered);
      return true;
    },
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      history.get(sessionId)?.has(deliveryId) || false
    ),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    outboxOptions: { leaseMs: 100, maxAttempts: 4, backoff: () => 0 },
  });
  return { dir, file, clock, history, injections, schedulerEvents, runtime };
}

test('scheduled message stays durable without becoming a blocking wait, then delivers at its due time', async t => {
  const { runtime, clock, injections } = createFixture(t);
  const scheduled = await runtime.scheduleMessage({
    sessionId: 'session-A',
    message: '十秒后继续',
    delaySeconds: 10,
    clientScheduleId: 'schedule-a',
  });

  assert.equal(scheduled.status, 'pending');
  assert.equal(scheduled.dueAt, 20_000);
  assert.equal(runtime.hasPending('session-A'), false,
    'a future user message must not classify the current task as background waiting');
  assert.deepEqual((await runtime.listScheduledMessages('session-A')).map(item => item.id), [scheduled.id]);

  clock.value = 19_999;
  await runtime.tick();
  assert.equal(injections.length, 0);

  clock.value = 20_000;
  await runtime.tick();
  assert.equal(injections.length, 1);
  assert.equal(injections[0].sessionId, 'session-A');
  assert.equal(injections[0].text, '十秒后继续');
  assert.equal(injections[0].options.originContinue, false);
  assert.equal(injections[0].options.scheduledMessageId, scheduled.id);
  assert.equal(injections[0].options.clientMsgId, `wait:${scheduled.id}`);
  assert.equal((await runtime.listScheduledMessages('session-A')).length, 0);
  assert.equal((await runtime.outbox.get(`wait:${scheduled.id}`)).state, 'delivered');
  await runtime.stop();
});

test('a due message joins the ordinary FIFO while the session has an active turn', async t => {
  const { runtime, clock, injections, schedulerEvents } = createFixture(t);
  await runtime.admitSessionWork({
    sessionId: 'session-A', text: '正在执行的任务', idempotencyKey: 'active-turn',
  });
  assert.deepEqual(injections.map(item => item.text), ['正在执行的任务']);

  const scheduled = await runtime.scheduleMessage({
    sessionId: 'session-A', message: '到点后的追问', delaySeconds: 5,
    clientScheduleId: 'queued-schedule',
  });
  clock.value += 5_000;
  await runtime.tick();

  assert.deepEqual(injections.map(item => item.text), ['正在执行的任务']);
  const queue = await runtime.sessionScheduler.status('session-A');
  assert.equal(queue.state, 'running');
  assert.deepEqual(queue.queued.map(item => item.text), ['到点后的追问']);
  const queuedEvent = schedulerEvents.find(event => event.type === 'queued'
    && event.entryId === `wait:${scheduled.id}`);
  assert.ok(queuedEvent);
  assert.equal(queuedEvent.queued, true);

  await runtime.sessionScheduler.complete('session-A', { classifyState: 'D' });
  await runtime.tick();
  assert.deepEqual(injections.map(item => item.text), ['正在执行的任务', '到点后的追问']);
  await runtime.stop();
});

test('scheduled messages support cancellation and idempotent browser retries', async t => {
  const { runtime, clock, injections } = createFixture(t);
  const input = {
    sessionId: 'session-A', message: '稍后执行', delaySeconds: 30,
    clientScheduleId: 'stable-client-id',
  };
  const first = await runtime.scheduleMessage(input);
  const duplicate = await runtime.scheduleMessage(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    runtime.scheduleMessage({ ...input, message: '不同内容' }),
    error => error.code === 'SCHEDULED_MESSAGE_CONFLICT' && error.statusCode === 409,
  );

  const wrongSession = await runtime.cancelScheduledMessage('session-B', first.id);
  assert.deepEqual(wrongSession, { ok: false, code: 'not_found' });
  const cancelled = await runtime.cancelScheduledMessage('session-A', first.id);
  assert.equal(cancelled.ok, true);
  assert.equal((await runtime.listScheduledMessages('session-A')).length, 0);
  clock.value += 30_000;
  await runtime.tick();
  assert.equal(injections.length, 0);
  await runtime.stop();
});

test('a pending schedule survives process restart and is delivered exactly once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-scheduled-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const databaseFile = path.join(dir, 'orchestration.sqlite');
  const clock = { value: 1_000 };
  const history = new Map();
  const injections = [];
  const first = createFixture(t, { dir, file, databaseFile, clock, history, injections });
  const scheduled = await first.runtime.scheduleMessage({
    sessionId: 'session-R', message: '重启后投递', delaySeconds: 60,
    clientScheduleId: 'restart-safe',
  });
  await first.runtime.stop();

  clock.value = scheduled.dueAt;
  const rebuilt = createFixture(t, { dir, file, databaseFile, clock, history, injections });
  await rebuilt.runtime.start();
  assert.deepEqual(injections.map(item => item.text), ['重启后投递']);
  await rebuilt.runtime.tick();
  assert.deepEqual(injections.map(item => item.text), ['重启后投递']);
  assert.equal((await rebuilt.runtime.outbox.get(`wait:${scheduled.id}`)).state, 'delivered');
  await rebuilt.runtime.stop();
});

test('scheduled message validation bounds delay and payload size', async t => {
  const { runtime } = createFixture(t);
  await assert.rejects(runtime.scheduleMessage({ sessionId: 's', message: '', delaySeconds: 1 }), /message is required/);
  await assert.rejects(runtime.scheduleMessage({ sessionId: 's', message: 'x', delaySeconds: 0 }), /between 1 and 604800/);
  await assert.rejects(runtime.scheduleMessage({ sessionId: 's', message: 'x', delaySeconds: 604801 }), /between 1 and 604800/);
  await assert.rejects(runtime.scheduleMessage({
    sessionId: 's', message: 'x'.repeat(256 * 1024 + 1), delaySeconds: 1,
  }), /message is too long/);
  await runtime.stop();
});

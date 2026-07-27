'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationStore } = require('../src/orchestration-store');
const { createOutbox } = require('../src/outbox');
const { createSessionWorkScheduler } = require('../src/session-work-scheduler');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-user-input-answer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let pending = null;
  const events = [];
  const store = createOrchestrationStore({
    file: path.join(dir, 'orchestration.json'),
    now: () => 1_000,
  });
  const outbox = createOutbox({
    store,
    now: () => 1_000,
    leaseTokenFactory: (() => {
      let sequence = 0;
      return () => `answer-lease-${++sequence}`;
    })(),
  });
  const scheduler = createSessionWorkScheduler({
    store,
    now: () => 1_000,
    getClassifyState: () => pending ? (pending.running ? 'P' : 'W') : 'D',
    getPendingUserInput: () => pending,
    onEvent: event => events.push(event),
  });
  return {
    events,
    outbox,
    scheduler,
    setPending(value) { pending = value; },
  };
}

async function claimOne(h, sessionId = 's1') {
  const claims = await h.outbox.claim({
    workerId: 'answer-test-worker',
    limit: 8,
    selectSessionItem: h.scheduler.selectSessionItem,
  });
  const item = claims.find(candidate => candidate.sessionId === sessionId) || null;
  if (!item) return null;
  assert.equal((await h.scheduler.claim(item)).ok, true);
  return item;
}

async function startClaim(h, item) {
  assert.equal((await h.outbox.ack(item.id, item.leaseToken)).ok, true);
  assert.equal((await h.scheduler.started(item)).ok, true);
}

test('idle request_user_input option answer starts directly and never enters public staging', async t => {
  const h = fixture(t);
  h.setPending({
    requestId: 'usrq-idle-option',
    taskId: 'task-idle',
    resolved: false,
    running: false,
  });

  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: '选项 A',
    workKind: 'answer',
    requestId: 'usrq-idle-option',
    options: { taskId: 'task-idle', clientMsgId: 'client-idle-answer' },
    idempotencyKey: 'client-idle-answer',
  });

  assert.equal(answer.ok, true);
  assert.equal(answer.queued, false);
  assert.deepEqual(answer.schedule.queued, []);
  const queuedEvent = h.events.find(event => event.entryId === answer.entry.id);
  assert.equal(queuedEvent.queued, false);
  assert.deepEqual(queuedEvent.queuedItems, []);
  assert.equal((await claimOne(h)).id, answer.entry.id);
});

test('running request_user_input answer stays off staging and outranks ordinary FIFO after release', async t => {
  const h = fixture(t);
  const asking = await h.scheduler.admit({
    sessionId: 's1',
    text: '正在提问',
    options: { taskId: 'task-running' },
    idempotencyKey: 'asking-turn',
  });
  const askingClaim = await claimOne(h);
  assert.equal(askingClaim.id, asking.entry.id);
  await startClaim(h, askingClaim);

  const ordinary = await h.scheduler.admit({
    sessionId: 's1',
    text: '普通后续消息',
    source: 'direct',
    idempotencyKey: 'ordinary-message',
  });
  h.setPending({
    requestId: 'usrq-running-option',
    taskId: 'task-running',
    resolved: false,
    running: true,
  });
  const answer = await h.scheduler.admit({
    sessionId: 's1',
    text: '选项 B',
    workKind: 'answer',
    requestId: 'usrq-running-option',
    options: { taskId: 'task-running', clientMsgId: 'client-running-answer' },
    idempotencyKey: 'client-running-answer',
  });

  assert.equal(answer.queued, false);
  assert.deepEqual(
    answer.schedule.queued.map(item => item.entryId),
    [ordinary.entry.id],
    'only ordinary work appears in the waiting-message projection',
  );
  assert.equal(await claimOne(h), null, 'the answer never overlaps the live native process');

  h.setPending({
    requestId: 'usrq-running-option',
    taskId: 'task-running',
    resolved: true,
    running: false,
  });
  await h.scheduler.complete('s1', {
    classifyState: 'W',
    awaitingRequestId: 'usrq-running-option',
  });
  const answerClaim = await claimOne(h);
  assert.equal(answerClaim.id, answer.entry.id, 'the correlated answer wins over ordinary FIFO');
  assert.notEqual(answerClaim.id, ordinary.entry.id);
});

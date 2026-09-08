'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoProviderHandoff } = require('../src/chat/auto-provider-handoff');
const { normalizeTurnRequest } = require('../src/chat/turn-request');

function preparation() {
  return {
    fromProviderId: 'limited',
    fromProviderName: 'Limited',
    providerId: 'backup',
    providerName: 'Backup',
    reasonCode: 'provider_replay_fence_closed',
  };
}

test('handoff injects one new continuation turn and preserves dispatch lineage', () => {
  const injected = [];
  const runtime = createAutoProviderHandoff({
    inject: (...args) => injected.push(args),
    hasLiveBackgroundTasks: () => false,
  });
  const first = runtime.schedule({
    sessionId: 'session-1', turnId: 'turn-1', preparation: preparation(),
    lineage: { kind: 'dispatch', operationId: 'op-1' },
  });
  assert.equal(first.scheduled, true);
  assert.equal(injected.length, 1);
  const [sessionId, text, delayMs, metadata] = injected[0];
  assert.equal(sessionId, 'session-1');
  assert.equal(delayMs, 0);
  assert.match(text, /不要重复已经完成的操作/);
  assert.deepEqual(metadata, {
    originContinue: true,
    clientMsgId: 'auto-provider-handoff:turn-1',
    idempotencyKey: 'auto-provider-handoff:turn-1',
    taskSource: 'auto_provider_handoff',
    originDispatchId: 'op-1',
  });
  assert.equal(runtime.schedule({
    sessionId: 'session-1', turnId: 'turn-1', preparation: preparation(),
  }).reason, 'duplicate');
  assert.equal(injected.length, 1);
});

test('handoff preserves trigger lineage and refuses missing candidates or live background work', () => {
  const injected = [];
  let background = false;
  const runtime = createAutoProviderHandoff({
    inject: (...args) => injected.push(args),
    hasLiveBackgroundTasks: () => background,
  });
  assert.equal(runtime.schedule({
    sessionId: 'session-1', turnId: 'missing', preparation: null,
  }).reason, 'handoff_not_prepared');
  background = true;
  assert.equal(runtime.schedule({
    sessionId: 'session-1', turnId: 'blocked', preparation: preparation(),
  }).reason, 'background_tasks_active');
  background = false;
  assert.equal(runtime.schedule({
    sessionId: 'session-1', turnId: 'triggered', preparation: preparation(),
    lineage: { kind: 'trigger' },
  }).scheduled, true);
  assert.equal(injected[0][3].originTrigger, true);
});

test('injected handoff metadata survives turn-request normalization', () => {
  // The durable path is: inject → outbox session.work → deliveryOptions →
  // normalizeTurnRequest. A continuation label the normalizer rejects burned
  // all 20 outbox retries into dead-letter, so the reserved provider switch
  // never ran (multicc-claude-chat-27, 2026-09-08).
  const injected = [];
  const runtime = createAutoProviderHandoff({
    inject: (...args) => injected.push(args),
    hasLiveBackgroundTasks: () => false,
  });
  runtime.schedule({
    sessionId: 'session-1', turnId: 'turn-1', preparation: preparation(),
  });
  const [sessionId, , , metadata] = injected[0];
  assert.equal(sessionId, 'session-1');
  const request = normalizeTurnRequest({
    sessionId,
    text: '🔇' + 'Limited 因上游限额或接口错误中断。请由 Backup 继续剩余任务。',
    turnCount: 3,
    hasNativeSession: true,
    // deliveryOptions() enriches the payload with the outbox item's task id.
    taskId: 'tsk-current',
    ...metadata,
  });
  assert.equal(request.task.id, 'tsk-current');
  assert.equal(request.task.start, false);
  assert.equal(request.task.source, 'auto_provider_handoff');
  assert.equal(request.launch.reason, 'continue');
});


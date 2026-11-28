'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoProviderHandoff } = require('../src/native/binding');
const { normalizeTurnRequest } = require('../src/native/binding').turnRequestHost;

function preparation() {
  return {
    fromProviderId: 'limited',
    fromProviderName: 'Limited',
    providerId: 'backup',
    providerName: 'Backup',
    reasonCode: 'provider_replay_fence_closed',
  };
}

test('handoff injects one new continuation turn and preserves dispatch lineage', async () => {
  const injected = [];
  const runtime = createAutoProviderHandoff({
    inject: (...args) => { injected.push(args); return { ok: true }; },
    hasLiveBackgroundTasks: () => false,
  });
  const first = await runtime.schedule({
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
  assert.equal((await runtime.schedule({
    sessionId: 'session-1', turnId: 'turn-1', preparation: preparation(),
  })).reason, 'duplicate');
  assert.equal(injected.length, 1);
});

test('handoff preserves trigger lineage and refuses missing candidates or live background work', async () => {
  const injected = [];
  let background = false;
  const runtime = createAutoProviderHandoff({
    inject: (...args) => { injected.push(args); return { ok: true }; },
    hasLiveBackgroundTasks: () => background,
  });
  assert.equal((await runtime.schedule({
    sessionId: 'session-1', turnId: 'missing', preparation: null,
  })).reason, 'handoff_not_prepared');
  background = true;
  assert.equal((await runtime.schedule({
    sessionId: 'session-1', turnId: 'blocked', preparation: preparation(),
  })).reason, 'background_tasks_active');
  background = false;
  assert.equal((await runtime.schedule({
    sessionId: 'session-1', turnId: 'triggered', preparation: preparation(),
    lineage: { kind: 'trigger' },
  })).scheduled, true);
  assert.equal(injected[0][3].originTrigger, true);
});

test('injected handoff metadata survives turn-request normalization', async () => {
  // The durable path is: inject → outbox session.work → deliveryOptions →
  // normalizeTurnRequest. A continuation label the normalizer rejects burned
  // all 20 outbox retries into dead-letter, so the reserved provider switch
  // never ran (multicc-claude-chat-27, 2026-09-08).
  const injected = [];
  const runtime = createAutoProviderHandoff({
    inject: (...args) => { injected.push(args); return { ok: true }; },
    hasLiveBackgroundTasks: () => false,
  });
  await runtime.schedule({
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

test('a rejected durable admission is reported and can be retried', async () => {
  let calls = 0;
  const runtime = createAutoProviderHandoff({ inject: async () => (++calls === 1
    ? { ok: false, code: 'scheduler_not_ready' } : { ok: true }) });
  const input = { sessionId: 'session-1', turnId: 'turn-1', preparation: preparation() };
  assert.equal((await runtime.schedule(input)).reason, 'inject_failed');
  assert.equal((await runtime.schedule(input)).scheduled, true);
  assert.equal(calls, 2);
});


function frozenHandoff() {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-auto-provider-handoff.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '44bcd5533b9743554225c9e88ea7bc481dc54d179f7bf26c1759bb5edd486592');
  const legacy = new Module(__filename);
  legacy._compile(source, path.join(__dirname, 'helpers/legacy-auto-provider-handoff.js.txt'));
  return legacy.exports.createAutoProviderHandoff;
}

test('Rust handoff matches frozen admission, error, logger, lineage and UTF-16 behavior', async () => {
  const cases = ['ok', 'false', 'null', 'undefined', 'zero', 'reject', 'reject-code', 'empty-code', 'logger-error', 'background-error', 'logger-null', 'admitted-proxy', 'utf16'];
  for (const scenario of cases) {
    const run = async make => {
      const trace = [];
      const prep = { ...preparation(), cli: scenario === 'utf16' ? 'codex\ud800' : 'codex' };
      const options = {
        inject: function (...args) {
          assert.equal(this, undefined, 'inject remains a plain function call');
          trace.push(['inject', ...args]);
          if (scenario === 'reject' || scenario === 'reject-code') return Promise.reject(Object.assign(new Error('refused'), { code: scenario === 'reject-code' ? ' E ' : '' }));
          if (scenario === 'admitted-proxy') return new Proxy({}, { get(target, key, receiver) { if (key === 'ok') throw Object.assign(new Error('bad admission'), { code: 'bad_admission' }); return Reflect.get(target, key, receiver); } });
          if (scenario === 'false') return false;
          if (scenario === 'null') return null;
          if (scenario === 'undefined') return undefined;
          if (scenario === 'zero') return 0;
          if (scenario === 'empty-code') return { ok: false, code: ' ' };
          return { ok: true };
        },
        hasLiveBackgroundTasks() { trace.push(['background']); if (scenario === 'background-error') throw new Error('unknown state'); return false; },
        logger: {
          get info() { trace.push(['get-info']); return scenario === 'logger-null' ? null : function (event, fields) { trace.push(['info', event, fields]); if (scenario === 'logger-error') throw Object.assign(new Error('logger'), { code: 'logger_failed' }); }; },
          get warn() { trace.push(['get-warn']); return function (event, fields) { trace.push(['warn', event, fields]); }; },
        },
      };
      const runtime = make(options);
      const input = { sessionId: ' session-1 ', turnId: scenario === 'utf16' ? 'turn-\udfff' : 'turn-1', preparation: prep, lineage: { kind: 'dispatch', operationId: 'operation-1' } };
      const first = await runtime.schedule(input), second = await runtime.schedule(input);
      runtime.clearSession('session-1');
      const third = await runtime.schedule(input);
      return { first, second, third, trace };
    };
    assert.deepEqual(await run(createAutoProviderHandoff), await run(frozenHandoff()), scenario);
  }
});

test('Rust handoff reserves before await and keeps bounded insertion order across sessions', async () => {
  for (const make of [frozenHandoff(), createAutoProviderHandoff]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const runtime = make({ inject: () => held });
    const input = { sessionId: 's', turnId: 'pending', preparation: preparation() };
    const first = runtime.schedule(input);
    assert.equal((await runtime.schedule(input)).reason, 'duplicate');
    release({ ok: true });
    assert.equal((await first).scheduled, true);
    const bounded = make({ inject: () => ({ ok: true }) });
    for (let i = 0; i < 2049; i++) await bounded.schedule({ ...input, sessionId: i % 2 ? 'a' : 'b', turnId: `turn-${i}` });
    assert.equal((await bounded.schedule({ ...input, turnId: 'turn-1' })).reason, 'duplicate');
    assert.equal((await bounded.schedule({ ...input, turnId: 'turn-0' })).scheduled, true);
    bounded.clearSession('a');
    assert.equal((await bounded.schedule({ ...input, turnId: 'turn-2047' })).scheduled, true);
  }
});

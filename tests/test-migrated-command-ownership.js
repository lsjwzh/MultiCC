'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Exercise the public service methods and observe the real native port, rather
// than merely searching source text for native function names. This catches a
// working-looking Node fallback even when the Rust exports still exist.
test('migrated orchestration commands reach Rust for normal and unusual inputs', async t => {
  const runtime = require('../src/native/runtime');
  const original = runtime.getNative;
  const native = original();
  const calls = [];
  const commandNames = new Set([
    'scheduleClaimLive', 'scheduleLifecycleLive', 'scheduleFreezeLive',
    'scheduleResolveLive', 'scheduleSettleLive', 'scheduleCancelQueuedLive',
    'scheduleEditQueuedLive', 'scheduleInsertQueuedLive', 'scheduleNoteQueuedLive',
    'waitCancelLive', 'waitResolveLive', 'operationAdmitLive',
  ]);
  const NativeStore = new Proxy(native.RustOrchestrationStore, {
    construct(target, args) {
      const store = Reflect.construct(target, args);
      return new Proxy(store, {
        get(instance, key) {
          const value = Reflect.get(instance, key, instance);
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (key === 'request' || key === 'requestAdmissionAsync') calls.push(`${key}:${args[0]}`);
            return Reflect.apply(value, instance, args);
          };
        },
      });
    },
  });
  runtime.getNative = () => new Proxy(native, {
    get(target, key) {
      if (key === 'RustOrchestrationStore') return NativeStore;
      const value = Reflect.get(target, key, target);
      if (!commandNames.has(key) || typeof value !== 'function') return value;
      return (...args) => { calls.push(key); return Reflect.apply(value, target, args); };
    },
  });
  t.after(() => { runtime.getNative = original; });

  const { createWaitService } = require('../src/wait/service');
  const { createOperationService } = require('../src/operation-service');
  const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
  const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');
  const now = () => 1000;
  const item = () => ({ id: 'entry', sessionId: 'session', state: 'pending', sequence: 1,
    attempts: 1, createdAt: 2, payload: { type: 'session.work', workKind: 'task', message: 'queued' } });
  const schedule = () => ({ sessionId: 'session', state: 'starting', classifyState: 'P',
    freezeReason: null, awaitingRequestId: null, active: { entryId: 'entry', deliveryId: 'entry', taskId: 'task', startedAt: null } });
  function storeFor(draft) { return { mutate: async fn => fn(draft), read: async fn => fn(draft) }; }
  async function reaches(name, run) {
    const before = calls.length;
    await run();
    assert.ok(calls.slice(before).includes(name), `${name} was bypassed`);
  }
  function harness({ active = true, state = 'pending', hasSchedule = true } = {}) {
    const entry = item(); entry.state = state;
    const current = schedule(); if (!active) { current.active = null; current.state = 'idle'; current.classifyState = 'D'; }
    const draft = { waits: {}, operations: {}, tasks: {}, outbox: { entry }, sessionSchedules: hasSchedule ? { session: current } : {}, nextOutboxSequence: 2 };
    return { draft, scheduler: createSessionWorkScheduler({ store: storeFor(draft), now }) };
  }
  await reaches('scheduleClaimLive', async () => { const h = harness({ active: false, state: 'leased' }); await h.scheduler.claim(h.draft.outbox.entry); });
  for (const action of ['started', 'releaseClaim', 'turnEnded']) {
    await reaches('scheduleLifecycleLive', async () => { const h = harness(); await (action === 'turnEnded' ? h.scheduler.turnEnded('session') : h.scheduler[action](h.draft.outbox.entry)); });
  }
  await reaches('scheduleFreezeLive', async () => { const h = harness(); await h.scheduler.freeze('session', 'waiting'); });
  await reaches('scheduleResolveLive', async () => { const h = harness(); h.draft.sessionSchedules.session.state = 'frozen'; await h.scheduler.resolve('session', { action: 'skip' }); });
  await reaches('scheduleSettleLive', async () => { const h = harness({ active: false }); await h.scheduler.settleUserInput('session', 'request'); });
  await reaches('scheduleCancelQueuedLive', async () => { const h = harness({ active: false }); await h.scheduler.cancelQueued('session', 'entry'); });
  await reaches('scheduleEditQueuedLive', async () => { const h = harness({ active: false }); await h.scheduler.editQueued('session', 'entry', { text: 'edit' }); });
  await reaches('scheduleInsertQueuedLive', async () => { const h = harness({ active: false }); await h.scheduler.insertQueued('session', 'entry'); });
  await reaches('scheduleNoteQueuedLive', async () => { const h = harness({ active: false }); await h.scheduler.noteQueued('entry'); });

  const draft = { waits: { special: { status: 'pending' } }, operations: {}, tasks: {}, outbox: {}, sessionSchedules: {}, nextOutboxSequence: 1 };
  const waits = createWaitService({ store: storeFor(draft), now });
  const unusualKey = { [Symbol.toPrimitive]: () => 'special' };
  await reaches('waitResolveLive', () => waits.resolvePoll('missing', { value: 1 }));
  await reaches('waitCancelLive', () => waits.cancel(unusualKey));
  assert.equal(draft.waits.special.status, 'cancelled');
  const operation = createOperationService({ store: storeFor(draft), now });
  await reaches('operationAdmitLive', () => operation.admitDetached({ operationId: 'op_live', sessionId: 'session', spec: { command: 'test' } }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-command-ownership-'));
  const sqlite = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => { await sqlite.close({ exportRollback: false }); fs.rmSync(dir, { recursive: true, force: true }); });
  await sqlite.mutate(state => {
    state.waits.normal = { id: 'normal', status: 'pending' };
    state.waits.special = { id: 'special', status: 'pending' };
    state.sessionSchedules.normal = { sessionId: 'normal', active: null, state: 'idle', awaitingRequestId: 'request' };
    state.sessionSchedules.special = { sessionId: 'special', active: null, state: 'idle', awaitingRequestId: 'request' };
  });
  const sqliteWaits = createWaitService({ store: sqlite });
  await reaches('waitResolveLive', () => sqliteWaits.resolvePoll('missing', { value: 1 }));
  await reaches('request:waitCancelCheck', () => sqliteWaits.cancel('normal'));
  await reaches('waitCancelLive', () => sqliteWaits.cancel({ [Symbol.toPrimitive]: () => 'special' }));
  const sqliteScheduler = createSessionWorkScheduler({ store: sqlite, now });
  await reaches('request:scheduleSettlePlan', () => sqliteScheduler.settleUserInput('normal', 'request'));
  await reaches('scheduleSettleLive', () => sqliteScheduler.settleUserInput({ [Symbol.toPrimitive]: () => 'special' }, 'request'));
  const sqliteOperations = createOperationService({ store: sqlite });
  await reaches('requestAdmissionAsync:operationAdmit', () => sqliteOperations.admitDetached({ operationId: 'op_worker', sessionId: 'session', spec: { command: 'test' } }));
  const unusualOperation = createOperationService({ store: sqlite, now });
  await reaches('operationAdmitLive', () => unusualOperation.admitDetached({ operationId: 'op_live_sqlite', sessionId: 'session', spec: { command: 'test' } }));
});

test('migrated command entry points contain no JavaScript state machine', () => {
  const files = {
    scheduler: fs.readFileSync(path.join(__dirname, '../src/session-work/scheduler.js'), 'utf8'),
    operation: fs.readFileSync(path.join(__dirname, '../src/operation-service.js'), 'utf8'),
    wait: fs.readFileSync(path.join(__dirname, '../src/wait/service.js'), 'utf8'),
  };
  function body(source, name) {
    const start = source.indexOf(`  async function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const next = source.slice(start + 1).search(/\n  (?:async )?function \w+\(/);
    return source.slice(start, next < 0 ? source.length : start + next + 1);
  }
  const requirements = [
    ['scheduler', 'claim', 'scheduleClaimLive'],
    ['scheduler', 'started', 'scheduleLifecycleLive'],
    ['scheduler', 'releaseClaim', 'scheduleLifecycleLive'],
    ['scheduler', 'turnEnded', 'scheduleLifecycleLive'],
    ['scheduler', 'freeze', 'scheduleFreezeLive'],
    ['scheduler', 'resolve', 'scheduleResolveLive'],
    ['scheduler', 'settleUserInput', 'scheduleSettleLive'],
    ['scheduler', 'cancelQueued', 'scheduleCancelQueuedLive'],
    ['scheduler', 'editQueued', 'scheduleEditQueuedLive'],
    ['scheduler', 'insertQueued', 'scheduleInsertQueuedLive'],
    ['scheduler', 'noteQueued', 'scheduleNoteQueuedLive'],
    ['operation', 'admitDetached', 'operationAdmitLive'],
    ['operation', 'admitDispatch', 'operationAdmitLive'],
    ['wait', 'cancel', 'waitCancelLive'],
    ['wait', 'resolveInternal', 'waitResolveLive'],
  ];
  for (const [file, name, native] of requirements) {
    const command = body(files[file], name);
    assert.match(command, new RegExp(`getNative\\(\\)\\.${native}\\(`), `${file}.${name} must call Rust`);
    assert.doesNotMatch(command, /\b(?:draft|schedule|wait|item|operation)(?:\.[\w$]+|\[[^\]]+\])+\s*(?:=(?!=)|\+\+|--|\+=|-=)/,
      `${file}.${name} must not mutate state in JavaScript`);
    assert.doesNotMatch(command, /\b(?:admitOutboxItem|admitBase|findIdempotent|normalizeJson|hashPayload)\s*\(/,
      `${file}.${name} must not execute the retired JavaScript domain implementation`);
  }
  for (const [file, source] of Object.entries(files)) {
    assert.doesNotMatch(source, /require\s*\([^)]*(?:tests\/helpers|legacy-operation-admission)/,
      `${file} must not import a test-only legacy oracle`);
  }
});

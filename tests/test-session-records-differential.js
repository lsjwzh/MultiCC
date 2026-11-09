'use strict';

// Differential oracle: the native session-record owner must reproduce the Node
// implementation step for step — same table contents, same save payloads, same
// failure/status/event sequence. The legacy implementation is frozen under
// tests/helpers/legacy-session-records.js.
//
// The sequence is randomized but seeded, and covers create/update/delete,
// required mutate (including save failure), nested/async mutators, manual
// transactions, best-effort saves with an injected failing store, retry timers
// firing, stop(), and setTaskState variants (letter change, explicit stamp,
// {save:false}, unknown session).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createSessionPersistence } = require('../src/session/persistence');
const { createTaskStateStore } = require('../src/routes/task-state-store');
const { recordsOf, appendClassifyHistory } = require('./helpers/session-records');
const {
  createLegacySessionPersistence,
  createLegacyTaskStateStore,
  LEGACY_TASK_STATE_DEFAULTS,
} = require('./helpers/legacy-session-records');

// Deterministic PRNG (mulberry32) so a failure reproduces from the seed alone.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeFailure(failure) {
  if (!failure) return null;
  return { ...failure, at: failure.at ? '<at>' : failure.at };
}

function normalizeState(state) {
  return {
    dirty: state.dirty,
    retryAttempt: state.retryAttempt,
    retryScheduled: state.retryScheduled,
    lastFailure: normalizeFailure(state.lastFailure),
  };
}

function errorFacts(error) {
  return {
    name: error && error.name,
    code: error && error.code,
    status: error && error.status,
    source: error && error.source,
    message: error && error.message,
    hasCause: !!(error && error.cause),
  };
}

// One "world": a record table with a persistence service and a task-state
// store wired the way server.js wires them (the store's save goes through the
// same persistence best-effort path).
function makeWorld(kind, seedRecords, options) {
  const clock = options.clock;
  const writes = [];
  const failures = [];
  const states = [];
  const busLog = [];
  const chatLog = [];
  const workspaceLog = [];
  const timers = [];
  const store = {
    save(value) {
      writes.push(JSON.parse(JSON.stringify(value)));
      if (options.shouldFail()) throw new Error('injected disk failure');
    },
  };
  const ports = {
    store,
    onFailure: event => failures.push({
      mode: event.mode, source: event.source, attempt: event.attempt, dirty: event.dirty,
      message: event.error && event.error.message,
    }),
    onState: state => states.push(normalizeState({
      dirty: state.dirty,
      retryAttempt: state.retryAttempt,
      retryScheduled: state.retryScheduled,
      lastFailure: state.lastFailure && { ...state.lastFailure },
    })),
    // A real timer queue: a cleared timer never fires. (A no-op clear would let
    // the frozen legacy implementation run a stale retry, hiding real drift.)
    setTimeoutFn: callback => {
      const handle = { callback, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: handle => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    retryDelayMs: 7,
    maxRetries: options.maxRetries,
  };
  const bus = new EventEmitter();
  const records = kind === 'legacy'
    ? new Map(seedRecords.map(([id, record]) => [id, JSON.parse(JSON.stringify(record))]))
    : recordsOf(seedRecords.map(([id, record]) => [id, JSON.parse(JSON.stringify(record))]));
  let persistence;
  let taskStates;
  if (kind === 'legacy') {
    persistence = createLegacySessionPersistence({ records, ...ports });
    taskStates = createLegacyTaskStateStore({
      persistedSessions: records,
      saveBestEffort: source => persistence.bestEffort(source),
      chatBroadcast: (sessionId, payload) => chatLog.push([sessionId, payload]),
      workspaceBroadcast: (dirId, payload) => workspaceLog.push([dirId, payload]),
      bus,
      now: () => clock.now,
    });
  } else {
    persistence = createSessionPersistence({ records, ...ports });
    taskStates = createTaskStateStore({
      persistedSessions: records,
      chatBroadcast: (sessionId, payload) => chatLog.push([sessionId, payload]),
      workspaceBroadcast: (dirId, payload) => workspaceLog.push([dirId, payload]),
      bus,
      now: () => clock.now,
    });
  }
  bus.on('task:state-changed', (sessionId, prev, next) => {
    busLog.push([sessionId, JSON.parse(JSON.stringify(prev)), JSON.parse(JSON.stringify(next))]);
  });
  return {
    kind, records, persistence, taskStates, writes, failures, states, busLog, chatLog, workspaceLog, timers,
  };
}

function snapshot(world) {
  return JSON.parse(JSON.stringify([...world.records.entries()]));
}

function assertWorldsEqual(left, right, step) {
  assert.deepEqual(snapshot(right), snapshot(left), `${step}: record table`);
  assert.deepEqual(normalizeState(right.persistence.status()), normalizeState(left.persistence.status()), `${step}: status`);
  assert.deepEqual(right.writes, left.writes, `${step}: save payloads`);
  assert.deepEqual(
    right.persistence.status().lastFailure ? normalizeFailure(right.persistence.status().lastFailure) : null,
    left.persistence.status().lastFailure ? normalizeFailure(left.persistence.status().lastFailure) : null,
    `${step}: last failure`,
  );
}

const LETTERS = ['P', 'W', 'D', 'C', 'B', 'E', null];

test('randomized lifecycle: native owner matches the frozen Node implementation step for step', () => {
  for (const seed of [1, 4242, 90210]) {
    let failuresWanted = false;
    const random = prng(seed);
    const pick = list => list[Math.floor(random() * list.length)];
    const clock = { now: 1_000 };
    const ids = ['a', 'b', 'c', 'd'];
    const seedRecords = ids.map(id => [id, { id, dirId: 'dir-1', label: '' }]);
    const options = {
      clock,
      maxRetries: 2,
      // Failures are deterministic per world; both worlds flip together.
      shouldFail: () => failuresWanted,
    };
    const legacy = makeWorld('legacy', seedRecords, options);
    const native = makeWorld('native', seedRecords, options);
    const worlds = [legacy, native];

    for (const world of worlds) world.tasks = world.taskStates;

    const fireTimers = () => {
      for (const world of worlds) {
        while (world.timers.length) {
          world.timers.shift().callback();
        }
      }
    };

    for (let step = 0; step < 1200; step += 1) {
      const op = Math.floor(random() * 16);
      const id = pick(ids);
      const label = `v${step}`;
      // Every random draw happens here: the two worlds must run the same case.
      const letter = pick(LETTERS);
      const phase = pick(['idle', 'planning', 'done']);
      let thrown = null;
      let legacyError = null;
      let nativeError = null;
      failuresWanted = random() < 0.25;
      clock.now += 1 + Math.floor(random() * 5);

      const run = (world, action) => {
        try {
          return { value: action(world) };
        } catch (error) {
          const facts = errorFacts(error);
          return { threw: facts };
        }
      };

      let leftResult;
      let rightResult;
      const act = action => {
        leftResult = run(legacy, action);
        rightResult = run(native, action);
      };

      switch (op) {
        case 0: // create or overwrite
          act(world => {
            world.records.set(id, { id, dirId: 'dir-1', label });
            world.persistence.bestEffort('create');
          });
          break;
        case 1: // update through a required mutate
          act(world => world.persistence.mutate('http.update', map => {
            const record = map.get(id);
            if (record) record.label = label;
            return label;
          }));
          break;
        case 2: // delete through a required mutate
          act(world => world.persistence.mutate('http.delete', map => map.delete(id)));
          break;
        case 3: // best-effort save only
          act(world => world.persistence.bestEffort('runtime.tick'));
          break;
        case 4: // retry timer fires (may be a no-op when none is pending)
          act(() => {
            fireTimers();
            return null;
          });
          break;
        case 5: // letter change / same letter
          act(world => world.tasks.setTaskState(id, { classifyState: letter }));
          break;
        case 6: // explicit stamp wins
          act(world => world.tasks.setTaskState(id, { classifyState: letter, classifyUpdatedAt: clock.now }));
          break;
        case 7: // batching patch, no save
          act(world => world.tasks.setTaskState(id, { goal: label, phase }, { save: false }));
          break;
        case 8: // unknown session
          act(world => world.tasks.setTaskState('missing', { classifyState: 'D' }));
          break;
        case 9: // nested mutate
          act(world => world.persistence.mutate('http.inner', inner => {
            inner.set('nested', { id: 'nested' });
            return world.persistence.mutate('http.outer', outer => outer.delete('a'));
          }));
          break;
        case 10: // async mutator
          act(world => world.persistence.mutate('http.async', async () => 'later'));
          break;
        case 11: // manual transaction: rollback
          act(world => {
            const tx = world.persistence.begin('http.tx');
            world.records.get(id).label = `rolled-${label}`;
            tx.rollback();
            return null;
          });
          break;
        case 12: // manual transaction: commit (may fail and roll back)
          act(world => {
            const tx = world.persistence.begin('http.tx');
            const record = world.records.get(id);
            if (record) record.label = `committed-${label}`;
            tx.commit();
            return null;
          });
          break;
        case 13: // history append window
          act(world => {
            if (world.kind === 'native') return appendClassifyHistory(world.records, id, { at: clock.now, state: 'D', goal: label }, clock.now - 50);
            const record = world.records.get(id);
            if (!record) return false;
            const ts = record.taskState || {};
            const hist = (Array.isArray(ts.classifyHistory) ? ts.classifyHistory : []).filter(entry => entry.at > clock.now - 50);
            hist.push({ at: clock.now, state: 'D', goal: label });
            ts.classifyHistory = hist;
            record.taskState = ts;
            return true;
          });
          break;
        case 14: // task-state defaults read, including the missing record
          act(world => [world.tasks.getTaskState(world.records.get(id)), world.tasks.getTaskState(null)]);
          break;
        default: // stop() cancels a pending retry
          act(world => world.persistence.stop());
          break;
      }

      assert.deepEqual(rightResult, leftResult, `seed ${seed} step ${step} op ${op}: return/throw`);
      assertWorldsEqual(legacy, native, `seed ${seed} step ${step} op ${op}`);
      assert.deepEqual(native.failures, legacy.failures, `seed ${seed} step ${step} op ${op}: onFailure`);
      assert.deepEqual(native.states, legacy.states, `seed ${seed} step ${step} op ${op}: onState`);
      assert.deepEqual(native.busLog, legacy.busLog, `seed ${seed} step ${step} op ${op}: bus`);
      assert.deepEqual(native.chatLog, legacy.chatLog, `seed ${seed} step ${step} op ${op}: chat`);
      assert.deepEqual(native.workspaceLog, legacy.workspaceLog, `seed ${seed} step ${step} op ${op}: workspace`);
      assert.deepEqual(native.timers.length, legacy.timers.length, `seed ${seed} step ${step} op ${op}: timers`);
    }

    // Defaults table identity: the exported constant and the live merge agree.
    assert.deepEqual({ ...LEGACY_TASK_STATE_DEFAULTS }, { ...native.taskStates.TASK_STATE_DEFAULTS });
    assert.deepEqual(Object.keys(LEGACY_TASK_STATE_DEFAULTS), Object.keys(native.taskStates.TASK_STATE_DEFAULTS));
  }
});

test('differential harness actually exercises every mutation kind', () => {
  // Guard against a silent no-op sequence: the same run must have produced
  // saves, failures, retries, broadcasts and stamps.
  const clock = { now: 5 };
  const seedRecords = [['a', { id: 'a', dirId: 'dir-1', taskState: { classifyState: 'P' } }]];
  let failuresWanted = true;
  const world = makeWorld('native', seedRecords, { clock, maxRetries: 1, shouldFail: () => failuresWanted });
  assert.equal(world.persistence.bestEffort('test'), false);
  assert.equal(world.persistence.status().dirty, true);
  failuresWanted = false;
  world.persistence.bestEffort('test');
  assert.equal(world.persistence.status().dirty, false);
  assert.ok(world.writes.length >= 2);
  assert.ok(world.failures.length >= 1);
  assert.equal(world.failures[0].mode, 'best_effort');
  const stamped = world.taskStates.setTaskState('a', { classifyState: 'D' }, { save: false });
  assert.equal(stamped.classifyUpdatedAt, clock.now);
  assert.equal(world.busLog.length, 1);
  assert.equal(world.chatLog.length, 1);
  assert.equal(world.workspaceLog.length, 1);
});

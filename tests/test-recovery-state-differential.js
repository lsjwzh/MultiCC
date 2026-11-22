'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSessionWorkHost } = require('../src/session-work/host');
const { createUserInputSignalHost } = require('./helpers/legacy-user-input-signal');
const { createOrchestrationSqliteStore } = require('../src/orchestration/sqlite-store');

// Load the actual pre-migration host using its original import base. Its
// dependencies remain shared, so this freezes the host, not those modules.
function frozenHostFactory(mutate = source => source) {
  const filename = path.resolve(__dirname, '../src/session-work/host.js');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/session-work-host-before-recovery-migration.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),
    'b62b3f045f20f62bab63909bb731647f319ad2307a5df566c5dc83ac674b893a');
  const frozen = new Module(filename, module);
  frozen.filename = filename;
  frozen.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = frozen.require.bind(frozen);
  frozen.require = name => name === '../session/runtime-busy'
    ? require('./helpers/session-runtime-busy-oracle') : originalRequire(name);
  frozen._compile(mutate(source), filename);
  return frozen.exports.createSessionWorkHost;
}

function exercise(factory, input) {
  const trace = [];
  const record = input.missing ? null : { type: input.type, unattended: input.unattended, taskState: input.state || {} };
  const pending = input.pending || null;
  const noop = () => {};
  const host = factory({
    runtime: noop,
    getRecord: () => { trace.push('record'); return record; },
    getTaskState: value => { trace.push('state'); return value?.taskState || {}; },
    pendingUserInput: () => { trace.push('pending'); return pending; },
    getChatSession: () => { trace.push('chat'); return input.chat || null; },
    classifyDisplay: value => { trace.push(`display:${value}`); return { cardStatus: value === 'P' ? 'running' : 'idle' }; },
    recordUserInput: noop, resolveUserInput: noop, broadcast: noop, setTaskState: noop,
    onTaskBoardQueueEvent: noop, onWorkspaceQueueStatus: noop, cancelClassify: noop,
    assignKillReason: noop, finishProviderAttempt: noop, appendMessage: noop,
    cancelPreparation: noop, dispatchStateAction: noop,
    chatStream: { isAlive: () => false, cancel: noop },
  });
  return { result: host.recoveryState('s'), trace };
}

test('recoveryState matches frozen host for new sessions, unknown states and question correlation', () => {
  const frozen = frozenHostFactory();
  const cases = [
    { missing: true },
    {},
    { type: 'gateway', state: { classifyState: 'P', startedAt: 1, endedAt: 2 }, chat: { _currentTaskId: 't' } },
    { type: 'gateway', state: { classifyState: 'P', endedAt: 0 } },
    { type: 'worker', state: { classifyState: 'P', queueState: 'assessing', endedAt: 2 } },
    { state: { classifyState: 'future-state', queueState: 'running', userInputSignalTurnId: 'turn' },
      pending: { requestId: 'r', taskId: 't', turnId: 'turn', question: 'private', resolved: false } },
    { state: { queueState: 'queued' }, pending: { requestId: 'r', resolved: true } },
    { unattended: { status: 'paused' }, pending: { requestId: 'r', taskId: '', resolved: 1 } },
  ];
  for (const input of cases) assert.deepEqual(exercise(createSessionWorkHost, input), exercise(frozen, input), JSON.stringify(input));
});

test('recovery oracle detects losing the gateway durable-end rule', () => {
  const altered = frozenHostFactory(source => {
    const rule = "record?.type === 'gateway'";
    assert.ok(source.includes(rule));
    return source.replace(rule, 'false');
  });
  const input = { type: 'gateway', state: { classifyState: 'P', endedAt: 2 } };
  assert.notDeepEqual(exercise(createSessionWorkHost, input).result, exercise(altered, input).result);
});

function frozenInputFactory() {
  const filename = path.resolve(__dirname, '../src/classify/user-input-host.js');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/user-input-host-before-recovery-migration.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),
    '21f5421334d71df53651dc70dce94874f43752d79ad519e41638b2f50e73112a');
  const frozen = new Module(filename, module);
  frozen.filename = filename;
  frozen.paths = Module._nodeModulePaths(path.dirname(filename));
  frozen._compile(source, filename);
  return frozen.exports.createUserInputSignalHost;
}

function exerciseInput(factory) {
  const states = { source: {}, target: {} };
  const events = [];
  const host = factory({
    getSession: id => id === 'source' ? { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' } : null,
    getState: id => states[id],
    setState: (id, patch) => { states[id] = { ...states[id], ...patch }; events.push(['write', id, structuredClone(patch)]); },
    now: () => 123,
    onResolved: (...args) => events.push(['resolved', ...args]),
  });
  const results = [];
  results.push(host.beginTurn('source', { turnId: 'turn' }));
  results.push(host.record({ sessionId: 'source', turnId: 'unknown', requestId: 'wrong' }));
  results.push(host.record({ sessionId: 'source', turnId: 'turn', requestId: 'r', question: 'question', options: ['yes', 'no'] }));
  results.push(host.record({ sessionId: 'source', turnId: 'turn', requestId: 'r', question: 'question' }));
  results.push(host.move('source', 'target', { turnId: 'turn', taskId: 'other' }));
  results.push(host.resolve('target', 'wrong'));
  results.push(host.resolve('target', 'r'));
  results.push(host.resolve('target', 'r'));
  return { states, events, results };
}

test('question lifecycle matches the frozen host including move, duplicate and stale answers', () => {
  assert.deepEqual(exerciseInput(createUserInputSignalHost), exerciseInput(frozenInputFactory()));
});

test('Rust-owned question host keeps creation, replay, classification and moves on one owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-owned-input-host-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const states = { source: { goal: 'goal', phase: 'verifying' }, target: {} };
  const writes = [];
  const notifications = [];
  const activeTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' };
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123,
    liveTurn: id => id === 'source' ? activeTurn : null,
    initialState: id => ({ pendingQuestion: states[id]?.pendingUserInput || null,
      activeTurn: id === 'source' ? activeTurn : null, category: { ...states[id] } }) });
  const { createUserInputOwnedHost } = require('../src/session-work/host');
  const host = createUserInputOwnedHost({ owner, getState: id => states[id],
    setState: (id, patch) => { writes.push({ id, patch }); states[id] = { ...states[id], ...patch }; },
    onResolved: (...args) => notifications.push(args) });
  host.beginTurn('source', { turnId: 'turn' });
  assert.equal(host.record({ sessionId: 'source', turnId: 'wrong', requestId: 'bad' }).code, 'turn_not_active');
  assert.equal(host.record({ sessionId: 'source', turnId: 'turn', requestId: 'q', question: 'Q' }).ok, true);
  assert.equal(host.pending('source').requestId, 'q');
  assert.equal(host.apply('source', { state: 'D' }).state, 'W');
  assert.deepEqual(host.degradedResult('source', null), { state: 'W', goal: 'goal', phase: 'verifying', background: false, error: false });
  assert.equal(host.move('source', 'source').code, 'invalid_move');
  assert.equal(host.move('source', 'target', { turnId: 'turn', taskId: 'other' }).requestId, 'q');
  assert.equal(host.move('source', 'target').code, 'already_resolved');
  assert.equal(host.pending('target').taskId, 'other');
  assert.equal(host.resolve('target', 'wrong').code, 'request_id_mismatch');
  assert.equal(host.resolve('target', 'q').duplicate, false);
  assert.equal(host.resolve('target', 'q').duplicate, true);
  assert.equal(host.lastResolved('target').requestId, 'q');
  assert.equal(host.degradedResult('target', null), null);
  assert.deepEqual(notifications.map(event => [event[0], event[1], event[3]?.resolution || null]),
    [['source', 'q', 'moved'], ['target', 'q', null]]);
  for (const { patch } of writes) {
    assert.equal(Object.hasOwn(patch, 'pendingUserInput'), false);
    assert.equal(Object.hasOwn(patch, 'lastResolvedUserInput'), false);
    assert.equal(Object.hasOwn(patch, 'userInputSignalTurnId'), false);
  }
});

test('ordered question creation and answer keep their queue positions across first backfill', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-ordered-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 123 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  let backfills = 0;
  const liveTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' };
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123, liveTurn: () => liveTurn,
    initialState: () => { backfills++; return { pendingQuestion: null, activeTurn: liveTurn, category: null }; } });
  const notifications = [];
  const { createUserInputOwnedHost } = require('../src/session-work/host');
  const host = createUserInputOwnedHost({ owner, getState: () => ({}), setState: () => {},
    onResolved: (...args) => notifications.push(args) });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const trace = [];
  const draft = store.mutate(async state => {
    started();
    await gate;
    state.first = true;
    trace.push('first');
  });
  await ready;
  const queued = store.mutate(state => {
    assert.equal(store.sessionWorkStateSync('s').exists, false);
    state.second = true;
    trace.push('second');
  });
  const created = host.recordAsync({ sessionId: 's', turnId: 'turn', requestId: 'q', question: 'Q' })
    .then(result => { trace.push('created'); return result; });
  const answered = host.resolveAsync('s', 'q').then(result => { trace.push('answered'); return result; });
  const pendingAfterAnswer = host.pendingAsync('s').then(result => { trace.push('read'); return result; });
  await Promise.resolve();
  assert.deepEqual(trace, []);
  release();
  await draft;
  await queued;
  assert.equal((await created).ok, true);
  assert.equal((await answered).ok, true);
  assert.equal((await pendingAfterAnswer).resolved, true);
  assert.deepEqual(trace, ['first', 'second', 'created', 'answered', 'read']);
  assert.equal(backfills, 1);
  assert.equal(owner.read('s').pendingQuestion.resolved, true);
  assert.deepEqual(notifications.map(value => [value[0], value[1]]), [['s', 'q']]);
});

test('queued question creation checks the Rust active turn at execution time', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-ordered-turn-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 123 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const active = id => ({ _activeTurn: { turnId: id }, isStreaming: true });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: {
    pendingQuestion: null, activeTurn: active('old'), category: null,
  } });
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123,
    initialState: () => { throw new Error('initialized state must not be recopied'); },
    liveTurn: () => active('old') });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const draft = store.mutate(async state => { started(); await gate; state.marker = true; });
  await ready;
  const changed = owner.patchFactsAsync('s', { activeTurn: active('new') });
  const stale = owner.recordAsync({ sessionId: 's', turnId: 'old', requestId: 'stale', question: 'Q' });
  const current = owner.recordAsync({ sessionId: 's', turnId: 'new', requestId: 'current', question: 'Q' });
  release();
  await draft;
  await changed;
  assert.equal((await stale).result.code, 'turn_not_active');
  assert.equal((await current).result.ok, true);
  assert.equal(owner.read('s').pendingQuestion.requestId, 'current');
});

test('ordered first read backfills once and later reads never copy stale legacy data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-ordered-read-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  let old = { requestId: 'old', resolved: false };
  let backfills = 0;
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, liveTurn: () => null,
    initialState: () => { backfills++; return { pendingQuestion: old, activeTurn: null, category: null }; } });
  assert.equal((await owner.readAsync('s')).pendingQuestion.requestId, 'old');
  assert.equal((await owner.resolveAsync('s', 'old')).result.ok, true);
  old = { requestId: 'stale', resolved: false };
  const observed = await owner.readAsync('s');
  assert.equal(observed.pendingQuestion.requestId, 'old');
  assert.equal(observed.pendingQuestion.resolved, true);
  assert.equal(backfills, 1);
});

test('ordered move refuses a question replaced while the caller was waiting', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-ordered-move-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 123 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const activeTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true };
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 'source', initial: {
    pendingQuestion: { requestId: 'old', turnId: 'turn', resolved: false }, activeTurn, category: null,
  } });
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123, liveTurn: () => activeTurn,
    initialState: () => ({ pendingQuestion: null, activeTurn: null, category: null }) });
  const settled = owner.resolveAsync('source', 'old');
  const replacement = owner.recordAsync({ sessionId: 'source', turnId: 'turn', requestId: 'new', question: 'new' });
  const moved = owner.moveAsync('source', 'target', { turnId: 'turn', expectedRequestId: 'old' });
  assert.equal((await settled).result.ok, true);
  assert.equal((await replacement).result.ok, true);
  assert.equal((await moved).result.code, 'request_id_mismatch');
  assert.equal((await owner.readAsync('source')).pendingQuestion.requestId, 'new');
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'target' })).exists, false);
});

test('owned host admission backfills an old question and later answers its replacement', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-owned-host-admission-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 123 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const activeTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'new-task' };
  const record = { id: 's', taskState: { classifyState: 'W', pendingUserInput: {
    requestId: 'old', taskId: 'old-task', turnId: 'turn', question: 'old', resolved: false,
  } } };
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123, liveTurn: () => activeTurn,
    initialState: () => ({ pendingQuestion: record.taskState.pendingUserInput, activeTurn,
      category: { classifyState: record.taskState.classifyState } }) });
  const { createUserInputOwnedHost } = require('../src/session-work/host');
  const ownedHost = createUserInputOwnedHost({ owner, getState: () => record.taskState,
    setState: (_id, patch) => { record.taskState = { ...record.taskState, ...patch }; } });
  const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
  const scheduler = createSessionWorkScheduler({ store, now: () => 123, rustQuestionOwner: true });
  const runtime = { sessionScheduler: scheduler, admitSessionWork: input => scheduler.admit(input) };
  const events = [];
  const noop = () => {};
  const workHost = createSessionWorkHost({ runtime: () => runtime, getRecord: () => record,
    getChatSession: () => activeTurn, getTaskState: value => value.taskState,
    pendingUserInput: id => ownedHost.pending(id), userInputSignalHost: ownedHost,
    recordUserInput: signal => ownedHost.record(signal),
    resolveUserInput: (id, requestId, options) => ownedHost.resolve(id, requestId, options),
    broadcast: (_id, event) => events.push(event), setTaskState: noop,
    onTaskBoardQueueEvent: noop, onWorkspaceQueueStatus: noop, classifyDisplay: () => ({ cardStatus: 'idle' }),
    cancelClassify: noop, assignKillReason: noop, finishProviderAttempt: noop,
    appendMessage: noop, cancelPreparation: noop, dispatchStateAction: noop,
    chatStream: { isAlive: () => false, cancel: noop } });
  const first = await workHost.admit('s', 'first answer', { userInputRequestId: 'old', clientMsgId: 'a' });
  assert.equal(first.answerConsumed.requestId, 'old');
  assert.equal((await workHost.recordInputAsync({ sessionId: 's', turnId: 'turn', requestId: 'new', question: 'new' })).ok, true);
  const second = await workHost.admit('s', 'second answer', { userInputRequestId: 'new', clientMsgId: 'b' });
  assert.equal(second.answerConsumed.requestId, 'new');
  assert.equal(second.entry.payload.taskId, 'new-task');
  assert.equal(ownedHost.pending('s').resolved, true);
  assert.equal(record.taskState.pendingUserInput.resolved, false, 'the pre-migration snapshot is not rewritten');
  assert.deepEqual(events.filter(event => event.type === 'user_input_resolved').map(event => event.requestId), ['old', 'new']);
  record.taskState.userInputSignalTurnId = 'stale-turn';
  record.taskState.lastResolvedUserInput = { requestId: 'stale-answer' };
  ownedHost.beginTurn('s', { turnId: 'next-turn' });
  assert.equal(workHost.recoveryState('s').turnId, 'next-turn');
  const replay = [];
  workHost.replayState('s', event => replay.push(event));
  assert.equal(replay.find(event => event.type === 'user_input_resolved')?.requestId, 'new');
  // replayState also queues an asynchronous scheduler status lookup.
  await scheduler.status('s');
});

test('host admission rechecks the owned question after initialization and a concurrent replacement', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-admit-recheck-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 123 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const activeTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' };
  const record = { id: 's', taskState: { classifyState: 'W', pendingUserInput: {
    requestId: 'old', turnId: 'turn', taskId: 'task', resolved: true,
  } } };
  const { createQuestionOwner } = require('../src/orchestration/native-store-host');
  const owner = createQuestionOwner({ getStore: () => store, now: () => 123, liveTurn: () => activeTurn,
    initialState: () => ({ pendingQuestion: record.taskState.pendingUserInput, activeTurn,
      category: { classifyState: record.taskState.classifyState } }) });
  const { createUserInputOwnedHost } = require('../src/session-work/host');
  const ownedHost = createUserInputOwnedHost({ owner, getState: () => record.taskState, setState: () => {} });
  const { createSessionWorkScheduler } = require('../src/session-work/scheduler');
  const scheduler = createSessionWorkScheduler({ store, now: () => 123 });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const runtime = { sessionScheduler: scheduler, async admitSessionWork(input) {
    entered(); await gate; return scheduler.admit(input);
  } };
  const noop = () => {};
  const host = createSessionWorkHost({ runtime: () => runtime, getRecord: () => record,
    getChatSession: () => activeTurn, getTaskState: value => value.taskState,
    pendingUserInput: ownedHost.pending, userInputSignalHost: ownedHost,
    recordUserInput: ownedHost.record, resolveUserInput: ownedHost.resolve,
    broadcast: noop, setTaskState: noop, onTaskBoardQueueEvent: noop,
    onWorkspaceQueueStatus: noop, classifyDisplay: () => ({ cardStatus: 'idle' }),
    cancelClassify: noop, assignKillReason: noop, finishProviderAttempt: noop,
    appendMessage: noop, cancelPreparation: noop, dispatchStateAction: noop,
    chatStream: { isAlive: () => false, cancel: noop } });
  const admission = host.admit('s', 'answer', { userInputRequestId: 'new', clientMsgId: 'race' });
  await ready;
  try {
    assert.equal((await ownedHost.recordAsync({ sessionId: 's', turnId: 'turn', requestId: 'new', question: 'new' })).ok, true);
  } finally { release(); }
  const result = await admission;
  assert.equal(result.answerConsumed.requestId, 'new');
  assert.equal((await ownedHost.pendingAsync('s')).resolved, true);
});

test('versioned state preserves frozen recovery observations across competing writes and rollback', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-recovery-diff-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  const other = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await other.close({ exportRollback: false }); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const frozen = frozenHostFactory();
  const seed = { pendingQuestion: null, activeTurn: null, category: {} };
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial: seed });
  const build = (tag, category) => ({ sessionId: 's', expectedVersion: 1,
    pendingQuestion: { requestId: `r-${tag}`, taskId: `task-${tag}`, turnId: `turn-${tag}`, question: '\ud800' },
    activeTurn: { _currentTaskId: `task-${tag}` },
    category: { classifyState: category, userInputSignalTurnId: `turn-${tag}` } });
  const attempts = await Promise.allSettled(['P', 'future'].map((state, index) =>
    [store, other][index].sessionWorkState({ action: 'write', updates: [build(index, state)] })));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  const winner = attempts.find(attempt => attempt.status === 'fulfilled').value.snapshots[0];
  assert.equal(winner.version, 2);
  const expected = { state: winner.category, pending: winner.pendingQuestion, chat: winner.activeTurn };
  const observed = await other.sessionWorkState({ action: 'read', sessionId: 's' });
  assert.deepEqual(exercise(frozen, { state: observed.category, pending: observed.pendingQuestion,
    chat: observed.activeTurn }), exercise(frozen, expected));
  const conflicting = { sessionId: 'new', expectedVersion: 0, ...seed };
  await assert.rejects(store.sessionWorkState({ action: 'write', updates: [conflicting, build('stale', 'W')] }), /version conflict/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'new' })).version, 0);
  assert.deepEqual(await store.sessionWorkState({ action: 'read', sessionId: 's' }), winner);
});

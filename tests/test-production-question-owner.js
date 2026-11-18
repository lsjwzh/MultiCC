'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductionQuestionHost, createProductionWorkHost } = require('../src/session-work/production-question-host');
const { createOrchestrationRuntime } = require('../src/orchestration/runtime');

test('server uses the production question composition with the Rust scheduler', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /const productionQuestion = createProductionQuestionHost\(/);
  assert.match(server, /sessionWorkHost = createProductionWorkHost\(/);
  assert.match(server, /rustQuestionOwner: true/);
  assert.doesNotMatch(server, /createUserInputSignalHost\(/);
});

function fixture(t, pending) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-production-question-'));
  let work;
  const runtime = createOrchestrationRuntime({ file: path.join(dir, 'state.json'), databaseFile: path.join(dir, 'state.sqlite'), now: () => 123,
    runChatTurn: async () => false, rustQuestionOwner: true,
    getSessionRecoveryState: id => work.recoveryState(id), getSessionRecoveryFacts: id => work.recoveryFacts(id),
    getSessionRecoveryStateAsync: id => work.recoveryStateAsync(id),
    onSchedulerEvent: event => work.onSchedulerEvent(event), isBusy: () => true });
  const { store } = runtime;
  t.after(async () => { try { await runtime.dispose(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const record = { id: 's', taskState: { classifyState: 'W', pendingUserInput: pending } };
  const session = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' };
  const events = [];
  const getState = () => record.taskState;
  const setState = (_id, patch) => { record.taskState = { ...record.taskState, ...patch }; };
  const { host: input } = createProductionQuestionHost({ getStore: () => store,
    getSession: () => session, getRecord: () => record, getState, setState, now: () => 123,
    onResolved: (id, requestId) => events.push({ id, requestId }) });
  const noop = () => {};
  work = createProductionWorkHost({ runtime: () => runtime, getRecord: () => record,
    getChatSession: () => session, getTaskState: value => value.taskState, setTaskState: setState,
    broadcast: (_id, event) => events.push(event), onTaskBoardQueueEvent: noop, onWorkspaceQueueStatus: noop,
    classifyDisplay: () => ({ cardStatus: 'idle' }), cancelClassify: noop, assignKillReason: noop,
    finishProviderAttempt: noop, appendMessage: noop, cancelPreparation: noop, dispatchStateAction: noop,
    chatStream: { isAlive: () => false, cancel: noop } }, input);
  return { store, runtime, input, work, record, session, events };
}

test('production construction backfills and answers the first trusted question', async t => {
  const f = fixture(t, { requestId: 'old', taskId: 'task', turnId: 'turn', resolved: false });
  const result = await f.work.admit('s', 'answer', { userInputRequestId: 'old', clientMsgId: 'first' });
  assert.equal(result.answerConsumed.requestId, 'old');
  assert.equal((await f.input.pendingAsync('s')).resolved, true);
  assert.equal(f.record.taskState.pendingUserInput.resolved, false);
});

test('production construction answers a question replaced after initialization', async t => {
  const f = fixture(t, { requestId: 'old', taskId: 'task', turnId: 'turn', resolved: false });
  await f.work.admit('s', 'old answer', { userInputRequestId: 'old', clientMsgId: 'old' });
  assert.equal((await f.work.recordInput({ sessionId: 's', turnId: 'turn', requestId: 'new', question: 'new' })).ok, true);
  const result = await f.work.admit('s', 'new answer', { userInputRequestId: 'new', clientMsgId: 'new' });
  assert.equal(result.answerConsumed.requestId, 'new');
  assert.equal((await f.input.pendingAsync('s')).resolved, true);
});

test('production create and answer wait behind an async draft and a queued operation', async t => {
  const f = fixture(t, null);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const trace = [];
  const draft = f.store.mutate(async state => { entered(); await gate; state.first = true; trace.push('draft'); });
  await ready;
  const queued = f.store.mutate(state => { state.second = true; trace.push('queued'); });
  const created = f.work.recordInput({ sessionId: 's', turnId: 'turn', requestId: 'q', question: 'Q' })
    .then(value => { trace.push('create'); return value; });
  const classification = f.input.withSnapshotAsync('s', () => f.input.apply('s', { state: 'D' }))
    .then(value => { trace.push('classify'); return value; });
  const replayed = [];
  const replay = f.work.replayState('s', event => replayed.push(event))
    .then(() => trace.push('replay'));
  const answer = f.work.admit('s', 'answer', { userInputRequestId: 'q', clientMsgId: 'answer' })
    .then(value => { trace.push('answer'); return value; });
  try { await Promise.resolve(); assert.deepEqual(trace, []); }
  finally { release(); }
  await draft; await queued;
  assert.equal((await created).ok, true);
  assert.equal((await classification).state, 'W');
  await replay;
  assert.equal(replayed.find(event => event.type === 'user_input_required')?.requestId, 'q');
  assert.equal((await answer).answerConsumed.requestId, 'q');
  assert.deepEqual(trace, ['draft', 'queued', 'create', 'classify', 'replay', 'answer']);
  assert.equal((await f.input.pendingAsync('s')).resolved, true);
});

test('production completion exposes the latest classification to the next admission', async t => {
  const f = fixture(t, null);
  await f.input.beginTurnAsync('s', { turnId: 'turn' });
  await f.store.mutate(state => { state.sessionSchedules.s = {
    sessionId: 's', state: 'assessing', classifyState: 'P', active: { entryId: 'active', taskId: 'task' },
  }; });
  assert.equal((await f.runtime.sessionScheduler.complete('s', { expectedTaskId: 'task', classifyState: 'D' })).ok, true);
  assert.equal((await f.input.snapshotAsync('s')).category.classifyState, 'D');
});

test('admission reads the current unattended state without copying stale question fields', async t => {
  const f = fixture(t, { requestId: 'q', turnId: 'turn', taskId: 'task', resolved: false });
  await f.input.pendingAsync('s');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const draft = f.store.mutate(async state => { entered(); await gate; state.marker = true; });
  await ready;
  const admission = f.work.admit('s', 'queued work', { userInputRequestId: 'q', clientMsgId: 'auto' });
  f.record.unattended = { status: 'active' };
  release();
  await draft;
  const result = await admission;
  assert.equal(result.entry.payload.workKind, 'task');
  assert.equal((await f.input.pendingAsync('s')).resolved, false);
});

test('a finished turn cannot create a question after its active facts are cleared', async t => {
  const f = fixture(t, null);
  await f.input.activateTurnAsync('s');
  f.session.isStreaming = false;
  await f.input.activateTurnAsync('s');
  assert.equal((await f.work.recordInput({ sessionId: 's', turnId: 'turn', requestId: 'late', question: 'late' })).code, 'turn_not_active');
  assert.equal(await f.input.pendingAsync('s'), null);
});

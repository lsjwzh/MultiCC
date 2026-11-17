'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductionQuestionHost, createProductionWorkHost } = require('../src/session-work/production-question-host');
const { createOrchestrationRuntime } = require('../src/orchestration/runtime');
const { addonPath, getNative } = require('../src/native/runtime');

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

test('first production backfill records session type and retains the owned snapshot', async t => {
  const f = fixture(t, null);
  f.record.type = 'gateway';
  const initial = await f.input.snapshotAsync('s');
  assert.equal(initial.category.recoveryRecordType, 'gateway');
  assert.equal(initial.category.classifyState, 'W');
  assert.equal(initial.activeTurn._currentTaskId, 'task');
  f.record.type = 'worker';
  f.record.taskState.classifyState = 'D';
  const again = await f.input.snapshotAsync('s');
  assert.equal(again.version, initial.version);
  assert.equal(again.category.recoveryRecordType, 'gateway');
  assert.equal(again.category.classifyState, 'W');
});

test('an isolated Rust recovery can read the first production backfill', async t => {
  const f = fixture(t, null);
  f.record.type = 'gateway';
  await f.input.snapshotAsync('s');
  await f.store.mutate(draft => {
    draft.sessionSchedules.s = { sessionId: 's', state: 'running', classifyState: 'P',
      active: { entryId: 'active', taskId: 'task', startedAt: 50 }, updatedAt: 50 };
  });
  const binary = process.env.MULTICC_TEST_ORCHESTRATION_OWNER || path.join(path.dirname(addonPath()),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  const owner = new (getNative().RustIsolatedOrchestrationStore)(f.store.file, null, 123,
    { env: {}, policy: {} }, binary);
  try {
    const captured = await owner.requestAsync('scheduleRecoverOwnedSnapshotExperimental', {});
    await owner.requestAsync('scheduleRecoverOwnedCommitExperimental', {
      expectedRevision: captured.state.revision, expectedDataVersion: captured.dataVersion,
      at: 123, updatedAt: 123, facts: captured.facts,
    });
    const schedule = (await f.store.snapshot()).sessionSchedules.s;
    assert.equal(schedule.state, 'frozen');
    assert.equal(schedule.freezeReason, 'classify_waiting');
  } finally { owner.request('close', {}); }
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

test('beginning a production turn commits classification and current task in one version', async t => {
  const f = fixture(t, null);
  const before = await f.input.snapshotAsync('s');
  f.session._currentTaskId = 'new-task';
  await f.input.beginTurnAsync('s', { turnId: 'turn' });
  const after = await f.input.snapshotAsync('s');
  assert.equal(after.version, before.version + 1);
  assert.equal(after.category.classifyState, 'P');
  assert.equal(after.activeTurn._currentTaskId, 'new-task');
});

test('queued turn start reads the task only when its owner slot runs', async t => {
  const f = fixture(t, null);
  await f.input.snapshotAsync('s');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const draft = f.store.mutate(async state => { entered(); await gate; state.marker = true; });
  await ready;
  const begin = f.input.beginTurnAsync('s', { turnId: 'turn' });
  f.session._currentTaskId = 'queued-task';
  release();
  await draft;
  await begin;
  const saved = await f.input.snapshotAsync('s');
  assert.equal(saved.category.classifyState, 'P');
  assert.equal(saved.activeTurn._currentTaskId, 'queued-task');
});

test('first turn backfill refreshes task facts after the owner reports a missing row', async t => {
  const f = fixture(t, null);
  let taskId = 'before-backfill';
  let scheduled = false;
  Object.defineProperty(f.session, '_currentTaskId', { configurable: true, get() {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { taskId = 'after-backfill'; });
    }
    return taskId;
  } });
  await f.input.beginTurnAsync('s', { turnId: 'turn' });
  const saved = await f.input.snapshotAsync('s');
  assert.equal(saved.category.classifyState, 'P');
  assert.equal(saved.activeTurn._currentTaskId, 'after-backfill');
});

test('first unattended refresh retries with facts read after the missing-row response', async t => {
  const f = fixture(t, null);
  let status = 'before-backfill';
  let scheduled = false;
  Object.defineProperty(f.record, 'unattended', { configurable: true, get() {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { status = 'after-backfill'; });
    }
    return { status };
  } });
  await f.input.refreshAdmissionFactsAsync('s');
  const saved = await f.input.snapshotAsync('s');
  assert.equal(saved.category.unattended.status, 'after-backfill');
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

test('a queued turn refresh observes the active task when its owner slot runs', async t => {
  const f = fixture(t, null);
  const before = await f.input.snapshotAsync('s');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const draft = f.store.mutate(async state => { entered(); await gate; state.marker = true; });
  await ready;
  const refresh = f.input.activateTurnAsync('s');
  f.session._currentTaskId = 'new-task';
  f.session._activeTurn = { turnId: 'new-turn' };
  f.session.isStreaming = false;
  release();
  await draft;
  await refresh;
  const saved = await f.input.snapshotAsync('s');
  assert.equal(saved.version, before.version + 1);
  assert.deepEqual(saved.activeTurn, { _activeTurn: { turnId: 'new-turn' },
    isStreaming: false, _currentTaskId: 'new-task' });
});

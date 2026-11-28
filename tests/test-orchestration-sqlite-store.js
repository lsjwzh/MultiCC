'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createOperationService } = require('../src/native/binding').orchestrationServices;
const { createOrchestrationRuntime } = require('../src/orchestration/host');
const { createOrchestrationStore } = require('../src/native/binding').orchestrationJson;
const {
  OrchestrationSqliteConflictError,
  OrchestrationSqliteError,
  createOrchestrationSqliteStore,
} = require('../src/native/binding').orchestrationSqlite;
const { createWaitService } = require('../src/native/binding').orchestrationServices;
const { createSessionWorkScheduler } = require('../src/session-work');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempPaths(t, name = 'orchestration') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-orchestration-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    json: path.join(dir, `${name}.json`),
    sqlite: path.join(dir, `${name}.sqlite`),
  };
}

function waitRecord(id = 'wait-1') {
  return {
    id,
    sessionId: 'session-1',
    mode: 'poll',
    status: 'pending',
    metadata: { nextAt: 10, checks: 0, tags: ['a'] },
    createdAt: 1,
    updatedAt: 1,
  };
}

function outboxRecord(id = 'outbox-1', sequence = 1) {
  return {
    id,
    sessionId: 'session-1',
    sequence,
    state: 'pending',
    availableAt: 1,
    leasedUntil: null,
    updatedAt: 1,
  };
}

test('session work state transport backfills once and rolls back a conflicting batch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-state-'));
  let store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const initial = { pendingQuestion: { requestId: 'old' }, activeTurn: { turnId: 't' }, category: 'P' };
  const seeded = await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial });
  assert.equal(seeded.version, 1);
  const update = (sessionId, expectedVersion, category) => ({ sessionId, expectedVersion,
    pendingQuestion: null, activeTurn: null, category });
  const request = { action: 'write', updates: [update('s', 1, 'future')] };
  const pending = store.sessionWorkState(request);
  request.updates[0].category = 'mutated after call';
  const written = await pending;
  assert.equal(written.snapshots[0].category, 'future');
  assert.deepEqual(await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's', initial }), written.snapshots[0]);
  await assert.rejects(store.sessionWorkState({ action: 'write', updates: [update('new', 0, 'W'), update('s', 1, 'D')] }), /version conflict/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'new' })).version, 0);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).category, 'future');
  const batchRequest = { action: 'readOrInitializeBatch', entries: [
    { sessionId: 's', initial },
    { sessionId: 'batch', initial: { pendingQuestion: { requestId: 'initial' }, activeTurn: null, category: 'W' } },
  ] };
  const pendingBatch = store.sessionWorkState(batchRequest);
  batchRequest.entries[1].initial.pendingQuestion.requestId = 'changed-after-capture';
  const batch = await pendingBatch;
  assert.deepEqual(batch.snapshots[0], written.snapshots[0], 'existing canonical facts are never overwritten');
  assert.equal(batch.snapshots[1].pendingQuestion.requestId, 'initial');
  await assert.rejects(store.sessionWorkState({ action: 'readOrInitializeBatch', entries: [
    { sessionId: 'new-batch', initial }, { sessionId: 'new-batch', initial },
  ] }), /invalid session work state initialization batch/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'new-batch' })).version, 0);
  await assert.rejects(store.sessionWorkState({ action: 'readOrInitializeBatch', entries: [
    { sessionId: 'valid-batch', initial },
    { sessionId: 'invalid-batch', initial: { pendingQuestion: null, activeTurn: null } },
  ] }));
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'valid-batch' })).version, 0);
  const unicode = { question: '\ud800', ['\udc00']: 'value' };
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 'utf16',
    initial: { pendingQuestion: unicode, activeTurn: null, category: 'P' } });
  assert.deepEqual((await store.sessionWorkState({ action: 'read', sessionId: 'utf16' })).pendingQuestion, unicode);
  await store.close({ exportRollback: false });
  store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  assert.deepEqual((await store.sessionWorkState({ action: 'read', sessionId: 'utf16' })).pendingQuestion, unicode);
  const patched = await store.sessionWorkState({ action: 'patch', sessionId: 'utf16',
    patch: { expectedVersion: 1, category: 'W' } });
  assert.equal(patched.version, 2);
  assert.equal(patched.category, 'W');
  assert.deepEqual(patched.pendingQuestion, unicode);
  await assert.rejects(store.sessionWorkState({ action: 'patch', sessionId: 'utf16',
    patch: { expectedVersion: 1, activeTurn: { turnId: 'stale' } } }), /version conflict/);
  assert.deepEqual(await store.sessionWorkState({ action: 'read', sessionId: 'utf16' }), patched);
  await assert.rejects(store.sessionWorkState({ action: 'patch', sessionId: 'missing',
    patch: { expectedVersion: 0, category: null } }), /not initialized/);
  const firstPatch = await store.sessionWorkState({ action: 'patch', sessionId: 'lazy-patch',
    initial: { pendingQuestion: { requestId: 'first' }, activeTurn: { turnId: 'turn' }, category: 'P' },
    patch: { expectedVersion: 0, category: 'W' } });
  assert.equal(firstPatch.version, 1);
  assert.equal(firstPatch.category, 'W');
  assert.deepEqual(firstPatch.pendingQuestion, { requestId: 'first' });
  await assert.rejects(store.sessionWorkState({ action: 'patch', sessionId: 'incomplete-patch',
    initial: { pendingQuestion: null, activeTurn: null }, patch: { expectedVersion: 0, category: 'W' } }));
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'incomplete-patch' })).exists, false);
  const backup = path.join(dir, 'legacy.json');
  fs.writeFileSync(backup, 'previous backup');
  await store.mutate(draft => { draft.sessionWorkStateV1 = { legacy: true }; });
  await assert.rejects(store.exportLegacy(backup), /conflicts with legacy extra/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'previous backup');
  await store.mutate(draft => { delete draft.sessionWorkStateV1; });
  const expectedS = await store.sessionWorkState({ action: 'read', sessionId: 's' });
  const expectedUtf16 = await store.sessionWorkState({ action: 'read', sessionId: 'utf16' });
  const exported = await store.exportLegacy(backup);
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).schemaVersion, 4);
  assert.throws(() => createOrchestrationStore({ file: backup }), /unsupported orchestration state/);
  const restored = createOrchestrationSqliteStore({ file: path.join(dir, 'restored.sqlite'), legacyFile: backup });
  try {
    assert.equal(restored.migration.legacyDigest, exported.digest);
    assert.deepEqual(await restored.sessionWorkState({ action: 'read', sessionId: 's' }), expectedS);
    assert.deepEqual(await restored.sessionWorkState({ action: 'read', sessionId: 'utf16' }), expectedUtf16);
  } finally { await restored.close({ exportRollback: false }); }
  const broken = JSON.parse(fs.readFileSync(backup, 'utf8'));
  broken.sessionWorkStateV1.s.categoryJson = '{broken';
  const brokenBackup = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenBackup, JSON.stringify(broken));
  const brokenDb = path.join(dir, 'broken.sqlite');
  assert.throws(() => createOrchestrationSqliteStore({ file: brokenDb, legacyFile: brokenBackup }));
  assert.equal(fs.existsSync(brokenDb), false, 'invalid snapshots cannot publish a partial database');
});

test('Rust question lifecycle replaces a settled question before admission on one owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-owner-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file, now: () => 100 });
  const db = new Database(file);
  t.after(async () => {
    try { db.close(); await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const initialState = { pendingQuestion: null,
    activeTurn: { _activeTurn: { turnId: 'turn-1' }, isStreaming: true, _currentTaskId: 'task' },
    category: { classifyState: 'W' } };
  assert.deepEqual(store.sessionWorkStateSync('s'), { sessionId: 's', version: 0, exists: false,
    pendingQuestion: null, activeTurn: null, category: null });
  const syncInitial = store.sessionWorkStateSync('sync-initial', initialState);
  assert.equal(syncInitial.version, 1);
  assert.equal(syncInitial.exists, true);
  assert.deepEqual(store.sessionWorkStateSync('sync-initial', {
    pendingQuestion: { requestId: 'stale' }, activeTurn: null, category: null,
  }), syncInitial, 'a later snapshot cannot overwrite the initialized Rust row');
  const queuedRead = store.sessionWorkState({ action: 'read', sessionId: 'sync' });
  assert.throws(() => store.sessionWorkQuestionSync({}), /owner has pending operations/);
  assert.throws(() => store.sessionWorkStateSync('sync'), /owner has pending operations/);
  await queuedRead;
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const activeRead = store.read(async () => { markReadStarted(); await readGate; return null; });
  await readStarted;
  const orderedQuestion = store.sessionWorkQuestion({ action: 'record', sessionId: 'queued',
    expectedVersion: 0, at: 1, initialState,
    signal: { sessionId: 'queued', turnId: 'turn-1', requestId: 'queued-q', question: 'question' } });
  const orderedRead = store.sessionWorkState({ action: 'read', sessionId: 'queued' });
  try {
    assert.throws(() => store.sessionWorkStateSync('sync'), /owner has pending operations/);
    assert.throws(() => store.sessionWorkQuestionSync({}), /owner has pending operations/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM orchestration_session_work_state WHERE session_id = ?')
      .get('queued').n, 0, 'a queued write cannot overtake the active read transaction');
  } finally {
    releaseRead();
    await activeRead;
  }
  const orderedResult = await orderedQuestion;
  assert.equal(orderedResult.result.ok, true);
  assert.equal((await orderedRead).pendingQuestion.requestId, 'queued-q');
  const syncRecorded = store.sessionWorkQuestionSync({ action: 'record', sessionId: 'sync',
    expectedVersion: 0, at: 1, initialState,
    signal: { sessionId: 'sync', turnId: 'turn-1', requestId: 'sync-q', question: 'question' } });
  assert.equal(syncRecorded.result.ok, true);
  assert.equal(store.sessionWorkStateSync('sync').pendingQuestion.requestId, 'sync-q');
  const syncAnswer = store.executeScheduleAdmitSync({ sessionId: 'sync', text: 'answer', hostAdmission: true,
    options: { userInputRequestId: 'sync-q', clientMsgId: 'sync-client' } }, 7);
  assert.equal(syncAnswer.answerConsumed.requestId, 'sync-q');
  assert.equal(syncAnswer.entry.payload.taskId, 'task');
  assert.equal(store.sessionWorkStateSync('sync').pendingQuestion.resolved, true);
  // A previously initialized turn snapshot may predate the current live turn.
  // The question guard must use the caller's synchronous observation without
  // rewriting the independently owned active-turn snapshot.
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 'live-turn',
    initial: { ...initialState, activeTurn: null } });
  const liveTurn = await store.sessionWorkQuestion({ action: 'record', sessionId: 'live-turn',
    expectedVersion: 1, at: 1, liveActiveTurn: initialState.activeTurn,
    signal: { sessionId: 'live-turn', turnId: 'turn-1', requestId: 'live-q', question: 'question' } });
  assert.equal(liveTurn.result.ok, true);
  assert.equal(liveTurn.snapshot.pendingQuestion.taskId, 'task');
  assert.equal(liveTurn.snapshot.activeTurn, null);
  // Match the frozen host's String(secretName || '') conversion, including
  // numeric names and falsy values supplied by adapter callers.
  for (const [sessionId, secretName, expected] of [
    ['numeric-secret', 123, '123'], ['empty-secret', 0, undefined],
  ]) {
    const recorded = await store.sessionWorkQuestion({ action: 'record', sessionId, expectedVersion: 0,
      at: 1, initialState, signal: { sessionId, turnId: 'turn-1', requestId: 'q-secret',
        question: 'secret', inputType: 'secret', secretName } });
    assert.equal(recorded.snapshot.pendingQuestion.secretName, expected);
    assert.equal(recorded.snapshot.pendingQuestion.inputType, expected === undefined ? undefined : 'secret');
  }
  const inactive = await store.sessionWorkQuestion({ action: 'record', sessionId: 'inactive', expectedVersion: 0,
    at: 1, initialState: { ...initialState, activeTurn: null },
    signal: { sessionId: 'inactive', turnId: 'turn-1', requestId: 'q', question: 'question' } });
  assert.deepEqual(inactive.result, { ok: false, code: 'turn_not_active' });
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 'inactive' })).exists, false);
  const first = await store.sessionWorkQuestion({ action: 'record', sessionId: 's', expectedVersion: 0,
    at: 1, initialState, signal: { sessionId: 's', turnId: 'turn-1', requestId: 'q1', question: 'old' } });
  assert.deepEqual(first.result, { ok: true, duplicate: false });
  assert.equal(first.snapshot.version, 1);
  assert.equal(first.notification.requestId, 'q1');
  assert.deepEqual(store.sessionWorkStateSync('s'), first.snapshot);
  const duplicate = await store.sessionWorkQuestion({ action: 'record', sessionId: 's', expectedVersion: 1,
    at: 2, signal: { sessionId: 's', turnId: 'turn-1', requestId: 'q1', question: 'old' } });
  assert.deepEqual(duplicate.result, { ok: true, duplicate: true });
  const blocked = await store.sessionWorkQuestion({ action: 'record', sessionId: 's', expectedVersion: 1,
    at: 2, signal: { sessionId: 's', turnId: 'turn-1', requestId: 'q2', question: 'new' } });
  assert.deepEqual(blocked.result, { ok: false, code: 'user_input_already_pending' });
  const settled = await store.sessionWorkQuestion({ action: 'resolve', sessionId: 's', expectedVersion: 1,
    at: 3, lastResolvedAt: 4, requestId: 'q1' });
  assert.equal(settled.snapshot.version, 2);
  assert.deepEqual(settled.notification, { type: 'user_input_resolved', requestId: 'q1', taskId: 'task' });
  assert.deepEqual(settled.snapshot.pendingQuestion.resolvedNotification, settled.notification);
  const replaced = await store.sessionWorkQuestion({ action: 'record', sessionId: 's', expectedVersion: 2,
    at: 5, signal: { sessionId: 's', turnId: 'turn-1', requestId: 'q2', question: '\ud800' } });
  assert.equal(replaced.snapshot.version, 3);
  assert.equal(replaced.snapshot.pendingQuestion.question, '\ud800');
  assert.deepEqual(store.sessionWorkStateSync('s'), replaced.snapshot);
  await assert.rejects(store.sessionWorkQuestion({ action: 'resolve', sessionId: 's', expectedVersion: 2,
    at: 6, requestId: 'q2' }), /version conflict/);
  db.exec("CREATE TRIGGER reject_question BEFORE UPDATE ON orchestration_session_work_state BEGIN SELECT RAISE(ABORT, 'reject question transition'); END");
  await assert.rejects(store.sessionWorkQuestion({ action: 'resolve', sessionId: 's', expectedVersion: 3,
    at: 6, requestId: 'q2' }), /reject question transition/);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).pendingQuestion.resolved, false);
  db.exec('DROP TRIGGER reject_question');
  const scheduler = createSessionWorkScheduler({ store, now: () => 7 });
  const answer = await scheduler.admit({ sessionId: 's', text: 'answer', hostAdmission: true,
    options: { userInputRequestId: 'q2', clientMsgId: 'client-q2' } });
  assert.equal(answer.answerConsumed.requestId, 'q2');
  assert.equal(answer.entry.payload.taskId, 'task');
  const final = await store.sessionWorkState({ action: 'read', sessionId: 's' });
  assert.equal(final.pendingQuestion.requestId, 'q2');
  assert.equal(final.pendingQuestion.resolved, true);
  assert.equal(final.version, 4);
  assert.deepEqual(store.sessionWorkStateSync('s'), final);
  assert.deepEqual(final.category.lastResolvedUserInput, { requestId: 'q2', taskId: 'task', at: 7 });
  const begun = await store.sessionWorkQuestion({ action: 'beginTurn', sessionId: 's', expectedVersion: 4,
    at: 8, turnId: 'turn-2', originContinue: false });
  assert.equal(begun.snapshot.version, 5);
  assert.equal(begun.snapshot.pendingQuestion, null);
  assert.equal(begun.snapshot.category.classifyState, 'P');
  assert.equal(begun.snapshot.category.userInputSignalTurnId, 'turn-2');
  assert.equal(begun.snapshot.category.lastResolvedUserInput.requestId, 'q2');
});

test('question transfer updates both sessions in the isolated Rust owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-transfer-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.sessionWorkState({ action: 'readOrInitializeBatch', entries: [
    { sessionId: 'source', initial: { pendingQuestion: { requestId: 'q', taskId: 'old',
      turnId: 'turn', question: 'Q', resolved: false }, activeTurn: null, category: { classifyState: 'W' } } },
    { sessionId: 'target', initial: { pendingQuestion: null, activeTurn: null, category: null } },
  ] });
  const moved = store.sessionWorkQuestionSync({ action: 'move', sessionId: 'source', expectedVersion: 1,
    targetSessionId: 'target', targetExpectedVersion: 1, taskId: 'new', turnId: 'turn', at: 10 });
  assert.deepEqual(moved.notification, { type: 'user_input_resolved', requestId: 'q', taskId: 'old', resolution: 'moved' });
  assert.equal(moved.question.taskId, 'old');
  assert.equal(moved.snapshot.pendingQuestion.resolution, 'moved');
  assert.equal(moved.targetSnapshot.pendingQuestion.taskId, 'new');
  assert.equal(store.sessionWorkStateSync('target').pendingQuestion.requestId, 'q');
});

test('question owner bridge backfills once and answers a replacement from the same Rust owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-owner-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 10 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const activeTurn = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'new-task' };
  const legacy = { pendingQuestion: { requestId: 'old', taskId: 'old-task', turnId: 'turn',
    question: 'old', resolved: false }, activeTurn, category: { classifyState: 'W' } };
  const { createQuestionOwner } = require('../src/native/binding').orchestrationNativeStore;
  let legacyAvailable = true;
  const owner = createQuestionOwner({ getStore: () => store, initialState: () => {
    if (!legacyAvailable) throw new Error('legacy snapshot unavailable');
    return legacy;
  },
    liveTurn: () => activeTurn, now: () => 10 });
  assert.equal(owner.read('s').pendingQuestion.requestId, 'old');
  assert.equal(owner.resolve('s', 'old').result.ok, true);
  const replacement = owner.record({ sessionId: 's', turnId: 'turn', requestId: 'new', question: 'new' });
  assert.equal(replacement.result.ok, true);
  const facts = owner.patchFacts('s', { categoryPatch: { classifyState: 'P' }, activeTurn });
  assert.equal(facts.snapshot.pendingQuestion.requestId, 'new');
  assert.equal(facts.result.changed, true);
  assert.equal(owner.patchFacts('s', { categoryPatch: { classifyState: 'P' }, activeTurn }).result.changed, false);
  owner.patchFacts('s', { categoryPatch: { classifyState: 'W' } });
  assert.equal(owner.read('s').pendingQuestion.requestId, 'new', 'legacy backfill must not overwrite a replacement');
  const answer = store.executeScheduleAdmitSync({ sessionId: 's', text: 'yes', hostAdmission: true,
    options: { userInputRequestId: 'new', clientMsgId: 'new-answer' } }, 11);
  assert.equal(answer.answerConsumed.requestId, 'new');
  assert.equal(answer.entry.payload.taskId, 'new-task');
  legacyAvailable = false;
  assert.equal(owner.read('s').pendingQuestion.resolved, true, 'initialized reads no longer depend on legacy state');
  assert.equal(owner.resolve('s', 'new').result.duplicate, true, 'initialized transitions do not consult legacy state');
  assert.equal(legacy.pendingQuestion.resolved, false, 'the legacy object is not a second writer');
});

test('question owner bridge moves a question across two Rust-owned sessions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-owner-move-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite') });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const { createQuestionOwner } = require('../src/native/binding').orchestrationNativeStore;
  const owner = createQuestionOwner({ getStore: () => store, now: () => 10, liveTurn: () => null,
    initialState: id => ({ pendingQuestion: id === 'source'
      ? { requestId: 'q', turnId: 'turn', taskId: 'old', question: 'Q', resolved: false } : null,
    activeTurn: null, category: null }) });
  const moved = owner.move('source', 'target', { turnId: 'turn', taskId: 'new' });
  assert.equal(moved.result.ok, true);
  assert.equal(moved.snapshot.pendingQuestion.resolution, 'moved');
  assert.equal(moved.targetSnapshot.pendingQuestion.taskId, 'new');
  assert.equal(owner.read('target').pendingQuestion.requestId, 'q');
  assert.equal(owner.read('source').pendingQuestion.resolved, true);
});

test('detached mutation works with an unrelated database larger than 128 MiB', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-large-detached-draft-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  // A large unrelated table changes the database size without making the
  // draft's read/write footprint large. Do not put 129 MiB through Node.
  const db = new Database(file);
  try {
    db.exec('CREATE TABLE unrelated_large_data (payload BLOB)');
    db.prepare('INSERT INTO unrelated_large_data VALUES (zeroblob(?))').run(129 * 1024 * 1024);
  } finally { db.close(); }
  await store.mutate(async draft => {
    await Promise.resolve();
    draft.smallMarker = 'ok';
  });
  assert.equal(await store.read(state => state.smallMarker), 'ok');
});

test('tracked observations do not retain a second copy of a large record', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-large-draft-record-'));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  const db = new Database(file);
  try {
    db.prepare("INSERT INTO orchestration_extras(key,data_json) VALUES('large',json_quote(hex(zeroblob(?))))").run(9 * 1024 * 1024);
  } finally { db.close(); }
  await store.mutate(async draft => {
    assert.equal(draft.large.length, 18 * 1024 * 1024);
    await Promise.resolve();
    draft.smallMarker = true;
  });
  assert.equal(await store.read(state => state.smallMarker), true);
});

test('synchronous question creation and settlement survive an overlapping async transaction', t => {
  const files = tempPaths(t, 'question-overlap');
  // Use a child so a synchronous wait on a transaction whose JS continuation
  // is parked cannot hang the entire test runner.
  const script = `
    const assert = require('node:assert/strict');
    const { createOrchestrationSqliteStore } = require(${JSON.stringify(require.resolve('../src/native/binding'))}).orchestrationSqlite;
    (async () => {
      const store = createOrchestrationSqliteStore({ file: process.argv[1], now: () => 10 });
      await store.mutate(draft => {
        draft.waits.existing = { id: 'existing', sessionId: 's', mode: 'poll', status: 'pending',
          metadata: { nextAt: 10 }, createdAt: 1, updatedAt: 1 };
      });
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      const mutation = store.mutate(async draft => {
        assert.equal(draft.waits.existing.status, 'pending');
        draft.overlapMarker = 'before';
        started();
        await gate;
        assert.equal(draft.waits.existing.status, 'pending');
        draft.overlapMarker = 'after';
      });
      await ready;
      let settledCommitted = false;
      let admittedEntryId;
      try {
        const initialState = { pendingQuestion: null,
          activeTurn: { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' },
          category: { classifyState: 'W' } };
        const created = store.sessionWorkQuestionSync({ action: 'record', sessionId: 's', expectedVersion: 0,
          at: 1, initialState, signal: { sessionId: 's', turnId: 'turn', requestId: 'question', question: 'Q' } });
        assert.equal(created.result.ok, true);
        const settled = store.executeScheduleAdmitSync({ sessionId: 's', text: 'answer', hostAdmission: true,
          options: { userInputRequestId: 'question', clientMsgId: 'overlap-client' } }, 2);
        assert.equal(settled.answerConsumed.requestId, 'question');
        assert.equal(settled.entry.payload.taskId, 'task');
        admittedEntryId = settled.entry.id;
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.resolved, true);
        settledCommitted = true;
      } finally {
        release();
        try {
          await mutation;
          if (settledCommitted) {
            assert.equal(await store.read(state => state.overlapMarker), 'after');
            assert.equal((await store.read(state => state.outbox[admittedEntryId])).payload.requestId, 'question');
            assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'question');
            assert.equal(store.sessionWorkStateSync('s').pendingQuestion.resolved, true);
          }
        } finally { await store.close({ exportRollback: false }); }
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, files.sqlite], {
    encoding: 'utf8', timeout: 5000, env: process.env,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'question transaction child failed');
});

for (const variant of ['promise-returning callback', 'async callback with hooks', 'async read callback']) {
  test(`synchronous question creation does not wait on a ${variant}`, t => {
    const files = tempPaths(t, 'question-overlap-compat');
    // A separate process makes a SQLite lock regression fail with a timeout
    // instead of hanging the rest of the suite.
    const script = `
      const assert = require('node:assert/strict');
      const { createOrchestrationSqliteStore } = require(${JSON.stringify(require.resolve('../src/native/binding'))}).orchestrationSqlite;
      (async () => {
        const variant = process.argv[2];
        const store = createOrchestrationSqliteStore({ file: process.argv[1], now: () => 10,
          hooks: variant === 'async callback with hooks' ? { beforeCommit() {} } : {} });
        let release, started;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        const callback = variant === 'async read callback'
          ? async draft => { started(); await gate; assert.equal(draft.select('outbox', { where: { state: 'pending' } }).length, 0); }
          : variant === 'async callback with hooks'
            ? async draft => { started(); await gate; draft.marker = true; }
            : draft => { started(); return gate.then(() => { draft.marker = true; }); };
        const mutation = variant === 'async read callback' ? store.read(callback) : store.mutate(callback);
        await ready;
        try {
          const response = store.sessionWorkQuestionSync({ action: 'record', sessionId: 's', expectedVersion: 0,
            at: 1, initialState: { pendingQuestion: null,
              activeTurn: { _activeTurn: { turnId: 't' }, isStreaming: true }, category: null },
            signal: { sessionId: 's', turnId: 't', requestId: 'q', question: 'Q' } });
          assert.equal(response.result.ok, true);
          if (variant === 'async read callback') {
            const admitted = store.executeScheduleAdmitSync({ sessionId: 's', text: 'answer', hostAdmission: true,
              options: { userInputRequestId: 'q', clientMsgId: 'read-overlap' } }, 2);
            assert.equal(admitted.answerConsumed.requestId, 'q');
          }
        } finally {
          release();
          try { await mutation; } finally { await store.close({ exportRollback: false }); }
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawnSync(process.execPath, ['-e', script, files.sqlite, variant], {
      encoding: 'utf8', timeout: 5000, env: process.env,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || 'question transaction child failed');
  });
}

test('question creation waits behind a detached draft and an earlier queued operation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-overlap-queued-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 10 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const order = [];
  const first = store.mutate(async draft => {
    started();
    await gate;
    draft.firstMarker = true;
    order.push('first');
  });
  await ready;
  const second = store.mutate(draft => { draft.secondMarker = true; order.push('second'); });
  const input = { action: 'record', sessionId: 's', at: 1,
    initialState: { pendingQuestion: null,
      activeTurn: { _activeTurn: { turnId: 't' }, isStreaming: true }, category: null },
    signal: { sessionId: 's', turnId: 't', requestId: 'q', question: 'Q' } };
  let pending;
  try {
    assert.throws(() => store.sessionWorkQuestionSync(input), /owner has pending operations/);
    pending = store.sessionWorkQuestion(input).then(result => { order.push('question'); return result; });
    await Promise.resolve();
    assert.deepEqual(order, []);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  const created = await pending;
  assert.equal(created.result.ok, true);
  assert.deepEqual(order, ['first', 'second', 'question']);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).pendingQuestion.requestId, 'q');
  const answered = await store.sessionWorkQuestion({ action: 'resolve', sessionId: 's', requestId: 'q', at: 2 });
  assert.equal(answered.result.ok, true);
  assert.equal((await store.sessionWorkState({ action: 'read', sessionId: 's' })).pendingQuestion.resolved, true);
});

test('a queued question operation cannot be overtaken during a detached mutation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-ordered-queued-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 10 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const first = store.mutate(async draft => { started(); await gate; draft.firstMarker = true; });
  await ready;
  const queued = store.sessionWorkState({ action: 'read', sessionId: 's' });
  try {
    assert.throws(() => store.sessionWorkQuestionSync({}), /owner has pending operations/);
    assert.throws(() => store.sessionWorkStateSync('s'), /owner has pending operations/);
  } finally {
    release();
    await Promise.all([first, queued]);
  }
});

test('question writes cannot join a draft during its synchronous commit hook', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-question-commit-hook-'));
  let hookError;
  let store;
  store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), hooks: {
    beforeCommit() {
      try { store.sessionWorkQuestionSync({ action: 'record', sessionId: 's' }); }
      catch (error) { hookError = error; }
    },
  } });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.mutate(draft => { draft.marker = true; });
  assert.equal(hookError?.code, 'SESSION_WORK_OWNER_UNAVAILABLE');
  assert.equal(await store.read(draft => draft.marker), true);
  assert.equal(store.sessionWorkStateSync('s').exists, false);
});

test('detached async draft rejects a changed query observed after it resumes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-detached-query-'));
  const store = createOrchestrationSqliteStore({ file: path.join(dir, 'state.sqlite'), now: () => 10 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const draft = store.mutate(async state => {
    started();
    await gate;
    assert.equal(state.select('outbox', { where: { state: 'pending' } }).length, 0,
      'a resumed draft observes its original snapshot');
    state.detachedQueryMarker = true;
  });
  await ready;
  try {
    const created = store.sessionWorkQuestionSync({ action: 'record', sessionId: 's', expectedVersion: 0,
      at: 1, initialState: { pendingQuestion: null,
        activeTurn: { _activeTurn: { turnId: 't' }, isStreaming: true }, category: { classifyState: 'W' } },
      signal: { sessionId: 's', turnId: 't', requestId: 'q', question: 'Q' } });
    assert.equal(created.result.ok, true);
    const answer = store.executeScheduleAdmitSync({ sessionId: 's', text: 'answer', hostAdmission: true,
      options: { userInputRequestId: 'q', clientMsgId: 'query-conflict' } }, 2);
    assert.equal(answer.answerConsumed.requestId, 'q');
  } finally { release(); }
  await assert.rejects(draft, error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
  assert.equal((await store.read(state => state.detachedQueryMarker)), undefined);
  assert.equal(store.sessionWorkStateSync('s').pendingQuestion.resolved, true);
  await store.mutate(state => { state.afterDetachedConflict = true; });
  assert.equal(await store.read(state => state.afterDetachedConflict), true);
});

test('question reads inside a detached draft keep its snapshot and protect its writes', t => {
  const files = tempPaths(t, 'question-draft-footprint');
  const script = `
    const assert = require('node:assert/strict');
    const { createOrchestrationSqliteStore } = require(${JSON.stringify(require.resolve('../src/native/binding'))}).orchestrationSqlite;
    (async () => {
      const store = createOrchestrationSqliteStore({ file: process.argv[1], now: () => 10 });
      const active = { _activeTurn: { turnId: 'turn' }, isStreaming: true, _currentTaskId: 'task' };
      store.sessionWorkStateSync('s', { pendingQuestion: { requestId: 'old', resolved: false },
        activeTurn: active, category: 'W' });
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      const draft = store.mutate(async state => {
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'old');
        assert.throws(() => store.sessionWorkQuestionSync({}), /not allowed inside a draft callback/);
        started();
        await gate;
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'old');
        state.marker = true;
      });
      await ready;
      try {
        assert.equal(store.sessionWorkQuestionSync({ action: 'resolve', sessionId: 's', at: 1,
          requestId: 'old' }).result.ok, true);
        assert.equal(store.sessionWorkQuestionSync({ action: 'record', sessionId: 's', at: 2,
          liveActiveTurn: active, signal: { sessionId: 's', turnId: 'turn', requestId: 'new', question: 'Q' } }).result.ok, true);
      } finally { release(); }
      try {
        await assert.rejects(draft, error => error.code === 'ORCHESTRATION_SQLITE_CONFLICT');
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'new');
        assert.equal(await store.read(state => state.marker), undefined);
      } finally { await store.close({ exportRollback: false }); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, files.sqlite], {
    encoding: 'utf8', timeout: 5000, env: process.env,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'question draft child failed');
});

test('read-only asynchronous question observations retain the original Rust snapshot', t => {
  const files = tempPaths(t, 'question-read-footprint');
  const script = `
    const assert = require('node:assert/strict');
    const { createOrchestrationSqliteStore } = require(${JSON.stringify(require.resolve('../src/native/binding'))}).orchestrationSqlite;
    (async () => {
      const store = createOrchestrationSqliteStore({ file: process.argv[1] });
      const active = { _activeTurn: { turnId: 'turn' }, isStreaming: true };
      store.sessionWorkStateSync('s', { pendingQuestion: { requestId: 'old', resolved: false },
        activeTurn: active, category: 'W' });
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      const reading = store.read(async () => {
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'old');
        started(); await gate;
        return store.sessionWorkStateSync('s').pendingQuestion.requestId;
      });
      await ready;
      try {
        store.sessionWorkQuestionSync({ action: 'resolve', sessionId: 's', at: 1, requestId: 'old' });
        store.sessionWorkQuestionSync({ action: 'record', sessionId: 's', at: 2, liveActiveTurn: active,
          signal: { sessionId: 's', turnId: 'turn', requestId: 'new', question: 'Q' } });
      } finally { release(); }
      try {
        assert.equal(await reading, 'old');
        assert.equal(store.sessionWorkStateSync('s').pendingQuestion.requestId, 'new');
      } finally { await store.close({ exportRollback: false }); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script, files.sqlite], {
    encoding: 'utf8', timeout: 5000, env: process.env,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || 'question read child failed');
});

test('an initialized session work table cannot be silently recreated after loss', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-state-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite');
  const store = createOrchestrationSqliteStore({ file });
  await store.sessionWorkState({ action: 'readOrInitialize', sessionId: 's',
    initial: { pendingQuestion: { requestId: 'r' }, activeTurn: null, category: 'P' } });
  await store.close({ exportRollback: false });
  const db = new Database(file);
  db.exec('DROP TABLE orchestration_session_work_state');
  db.close();
  assert.throws(() => createOrchestrationSqliteStore({ file }), /session work state table/);
  const verify = new Database(file, { readonly: true });
  try { assert.equal(verify.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='orchestration_session_work_state'").get().count, 0); }
  finally { verify.close(); }
});

test('production owner survives foreign SQLite close and rejects a changed snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-production-owner-'));
  const files = { sqlite: path.join(dir, 'state.sqlite') };
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => 1000 });
  t.after(async () => {
    try { await store.close({ exportRollback: false }); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await store.mutate(draft => { draft.outbox.a = outboxRecord('a'); draft.nextOutboxSequence = 2; });
  // Closing a foreign SQLite library in the host must not release the Rust
  // process's WAL locks. Keep the external writer independent as well.
  new Database(files.sqlite).close();
  const source = `const D=require(process.argv[1]);const db=new D(process.argv[2]);
    db.prepare("UPDATE orchestration_outbox SET data_json=json_set(data_json,'$.external',7) WHERE id='a'").run();db.close();`;
  let calls = 0;
  await assert.rejects(store.mutate(draft => {
    calls++;
    const prior = draft.outbox.a;
    const child = spawnSync(process.execPath, ['-e', source, require.resolve('better-sqlite3'), files.sqlite],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    prior.state = 'leased';
  }), OrchestrationSqliteConflictError);
  assert.equal(calls, 1, 'a rejected mutation must not be replayed');
  const saved = await store.snapshot();
  assert.equal(saved.outbox.a.external, 7);
  assert.equal(saved.outbox.a.state, 'pending');
});

test('production store never falls back when the Rust owner executable is missing', t => {
  const files = tempPaths(t);
  assert.throws(() => createOrchestrationSqliteStore({ file: files.sqlite,
    ownerBinary: path.join(files.dir, 'missing-owner') }), /owner executable unavailable/);
  assert.equal(fs.existsSync(files.sqlite), false);
});

test('production store rejects an incompatible owner instead of opening SQLite locally', t => {
  const files = tempPaths(t);
  // This is a real executable, but cannot speak the private owner protocol.
  assert.throws(() => createOrchestrationSqliteStore({ file: files.sqlite,
    ownerBinary: process.execPath }), /owner transport failed/);
  assert.equal(fs.existsSync(files.sqlite), false);
});

test('migrates legacy JSON exactly into normalized private SQLite tables', async t => {
  const files = tempPaths(t);
  const legacy = createOrchestrationStore({ file: files.json, now: () => 10 });
  await legacy.mutate(draft => {
    draft.waits['wait-1'] = waitRecord();
    draft.outbox['outbox-1'] = outboxRecord();
    draft.operations['op-1'] = {
      id: 'op-1', kind: 'dispatch', ownerSessionId: 'owner', status: 'admitted', updatedAt: 1,
    };
    draft.tasks['task-1'] = {
      id: 'task-1', parentSessionId: 'session-1', status: 'running', updatedAt: 1,
    };
    draft.sessionSchedules['session-1'] = {
      sessionId: 'session-1', state: 'queued', updatedAt: 1,
    };
    draft.customMigrationMarker = { preserved: true };
    draft.nextOutboxSequence = 2;
  });
  const before = await legacy.snapshot();

  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
    now: () => 20,
  });
  assert.equal(store.backend, 'sqlite');
  assert.equal(store.migration.migrated, true);
  assert.equal(store.migration.legacyDigest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.deepEqual(await store.snapshot(), before);
  // Windows exposes synthetic POSIX mode bits; owner-only mode is a POSIX contract.
  if (process.platform !== 'win32') assert.equal(fs.statSync(files.sqlite).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(files.json), true, 'legacy snapshot remains as explicit rollback source');

  const db = new Database(files.sqlite, { readonly: true });
  for (const [table, count] of [
    ['orchestration_waits', 1],
    ['orchestration_outbox', 1],
    ['orchestration_operations', 1],
    ['orchestration_tasks', 1],
    ['orchestration_session_schedules', 1],
    ['orchestration_extras', 1],
  ]) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, count, table);
  }
  db.close();
  await store.close();

  const reopened = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
  });
  assert.equal(reopened.migration.migrated, false, 'existing SQLite never re-imports stale JSON');
  assert.deepEqual(await reopened.snapshot(), before);
  await reopened.close();
});

test('copy-on-write draft preserves aliases, nested operations and enumeration semantics', async t => {
  const files = tempPaths(t);
  let clock = 100;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => ++clock });
  let leakedProxy;

  const raw = {
    id: 'op-1',
    kind: 'dispatch',
    ownerSessionId: 'owner',
    status: 'admitted',
    spec: { message: 'secret', tags: ['one'] },
    updatedAt: 1,
  };
  const returned = await store.mutate(draft => {
    draft.waits['wait-1'] = waitRecord();
    draft.operations['op-1'] = raw;
    draft.extension = { nested: { count: 1 }, values: ['x', 'y'] };
    // Existing domain code relies on continuing through the raw reference
    // after insertion; this must update the row that will be committed.
    raw.status = 'running';
    raw.spec.message = 'changed after insert';
    return raw;
  });
  assert.equal(returned.status, 'running');
  assert.throws(() => { returned.status = 'bypass'; }, TypeError);

  const result = await store.mutate(draft => {
    const wait = draft.waits['wait-1'];
    leakedProxy = wait;
    const metadata = wait.metadata;
    metadata.checks += 1;
    metadata.tags.push('b');
    wait.metadata = metadata;
    delete draft.operations['op-1'].spec.message;
    assert.equal(Object.prototype.hasOwnProperty.call(draft.operations['op-1'].spec, 'message'), false);
    assert.deepEqual(Object.keys(draft.waits), ['wait-1']);
    assert.equal(Object.values(draft.operations)[0].status, 'running');
    draft.extension.nested.count += 1;
    assert.equal(Object.getOwnPropertyDescriptor(draft.extension.values, 'length').value, 2);
    draft.extension.values.push('z');
    assert.equal(Object.getOwnPropertyDescriptor(draft.extension.values, 'length').value, 3);
    return JSON.parse(JSON.stringify(wait));
  });
  assert.deepEqual(result.metadata, { nextAt: 10, checks: 1, tags: ['a', 'b'] });
  assert.throws(() => { leakedProxy.status = 'late write'; }, /no longer active/);

  const snapshot = await store.snapshot();
  assert.equal(snapshot.operations['op-1'].spec.message, undefined);
  assert.deepEqual(snapshot.waits['wait-1'].metadata.tags, ['a', 'b']);
  assert.deepEqual(snapshot.extension, { nested: { count: 2 }, values: ['x', 'y', 'z'] });
  await store.close();
});

test('assigning a spread of a draft record materialises nested proxies instead of leaking them', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => 100 });
  await store.mutate(draft => {
    draft.outbox['outbox-1'] = {
      ...outboxRecord(),
      payload: {
        type: 'session.work',
        message: 'old text',
        options: { clientMsgId: 'c-1', attachments: [{ name: 'a.txt' }] },
      },
    };
  });

  // Editing a queued message rebuilds the payload by spreading the draft record:
  // nested members arrive as draft proxies. Storing them used to wrap a proxy in
  // another proxy, and the next read recursed until "Maximum call stack size
  // exceeded" (the edit always failed while other queue actions still worked).
  const result = await store.mutate(draft => {
    const item = draft.outbox['outbox-1'];
    const payload = { ...item.payload, message: 'new text' };
    item.payload = payload;
    return payload;
  });
  assert.equal(result.message, 'new text');

  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.outbox['outbox-1'].payload, {
    type: 'session.work',
    message: 'new text',
    options: { clientMsgId: 'c-1', attachments: [{ name: 'a.txt' }] },
  });
  // A later mutation must be able to read and write the record again.
  await store.mutate(draft => { draft.outbox['outbox-1'].payload.message = 'newer text'; });
  assert.equal((await store.snapshot()).outbox['outbox-1'].payload.message, 'newer text');
  await store.close();
});

test('graceful close refreshes a current JSON rollback snapshot outside the hot path', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    legacyFile: files.json,
    now: () => 500,
  });
  await store.mutate(draft => { draft.waits.rollback = waitRecord('rollback'); });
  assert.equal(fs.existsSync(files.json), false, 'new installs do not dual-write every mutation');
  await store.close();

  const rollback = createOrchestrationStore({ file: files.json });
  const snapshot = await rollback.snapshot();
  assert.ok(snapshot.waits.rollback);
  assert.equal(snapshot.revision, 1);
  // Windows exposes synthetic POSIX mode bits; owner-only mode is a POSIX contract.
  if (process.platform !== 'win32') assert.equal(fs.statSync(files.json).mode & 0o777, 0o600);
});

test('runtime stop checkpoints but preserves post-stop reads until explicit dispose', async t => {
  const files = tempPaths(t);
  const runtime = createOrchestrationRuntime({
    file: files.json,
    databaseFile: files.sqlite,
    runChatTurn: async () => true,
    hasPersistedDelivery: async () => false,
  });
  await runtime.store.mutate(draft => { draft.waits.readable = waitRecord('readable'); });
  await runtime.stop();
  assert.ok((await runtime.store.snapshot()).waits.readable);
  assert.ok((await createOrchestrationStore({ file: files.json }).snapshot()).waits.readable);
  await runtime.dispose();
  await assert.rejects(runtime.store.snapshot(), /database is closed/);
});

test('async mutations serialize, rollback on failure, and same-value writes do not churn revision', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => { draft.customCounter = 0; });

  const failed = store.mutate(async draft => {
    draft.customCounter = 99;
    draft.waits.discarded = waitRecord('discarded');
    await delay(5);
    throw new Error('discard transaction');
  });
  const next = store.mutate(draft => {
    draft.customCounter += 1;
    draft.waits.kept = waitRecord('kept');
    return draft.customCounter;
  });
  await assert.rejects(failed, /discard transaction/);
  assert.equal(await next, 1);
  const committed = await store.snapshot();
  assert.equal(committed.customCounter, 1);
  assert.equal(committed.waits.discarded, undefined);
  assert.ok(committed.waits.kept);

  const revision = committed.revision;
  await store.mutate(draft => {
    draft.customCounter = 1;
    draft.waits.kept.status = 'pending';
  });
  assert.equal((await store.snapshot()).revision, revision);
  await store.close();
});

test('one IMMEDIATE transaction covers multiple collections and reloads both commit windows', async t => {
  const files = tempPaths(t);
  let beforeFail = false;
  let afterFail = false;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: {
      beforeCommit() { if (beforeFail) throw new Error('before commit'); },
      afterCommit() { if (afterFail) throw new Error('after commit'); },
    },
  });

  beforeFail = true;
  await assert.rejects(store.mutate(draft => {
    draft.waits.before = waitRecord('before');
    draft.outbox.before = outboxRecord('before', 1);
    draft.nextOutboxSequence = 2;
  }), /before commit/);
  beforeFail = false;
  let snapshot = await store.snapshot();
  assert.equal(snapshot.waits.before, undefined);
  assert.equal(snapshot.outbox.before, undefined);
  assert.equal(snapshot.nextOutboxSequence, 1);

  afterFail = true;
  await assert.rejects(store.mutate(draft => {
    draft.waits.after = waitRecord('after');
    draft.outbox.after = outboxRecord('after', 1);
    draft.nextOutboxSequence = 2;
  }), /after commit/);
  afterFail = false;
  snapshot = await store.snapshot();
  assert.ok(snapshot.waits.after, 'committed wait reloaded after ambiguous success');
  assert.ok(snapshot.outbox.after, 'committed outbox reloaded with wait');
  assert.equal(snapshot.nextOutboxSequence, 2);
  await store.close();
});

test('concurrent store snapshots fail on stale revision instead of losing rows', async t => {
  const files = tempPaths(t);
  const first = createOrchestrationSqliteStore({ file: files.sqlite });
  const second = createOrchestrationSqliteStore({ file: files.sqlite });
  await first.mutate(draft => { draft.waits.first = waitRecord('first'); });
  await assert.rejects(
    second.mutate(draft => { draft.waits.second = waitRecord('second'); }),
    error => error instanceof OrchestrationSqliteConflictError
      && error.expectedRevision === 0
      && error.actualRevision === 1,
  );
  assert.ok((await second.snapshot()).waits.first, 'conflicting store reloads committed authority');
  await second.mutate(draft => { draft.waits.second = waitRecord('second'); });
  await first.close();
  await second.close();

  const rebuilt = createOrchestrationSqliteStore({ file: files.sqlite });
  const snapshot = await rebuilt.snapshot();
  assert.ok(snapshot.waits.first);
  assert.ok(snapshot.waits.second);
  assert.equal(snapshot.revision, 2);
  await rebuilt.close();
});

test('existing wait and operation services retain their cross-row transactions on SQLite', async t => {
  const files = tempPaths(t);
  let clock = 1_000;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => ++clock });
  const waits = createWaitService({
    store,
    now: () => ++clock,
    idFactory: () => 'wait-service-1',
    callbackTokenFactory: () => 'callback-secret',
  });
  const operations = createOperationService({
    store,
    now: () => ++clock,
    idFactory: () => 'operation-service-1',
  });

  const registered = await waits.register({ sessionId: 'worker', mode: 'callback' });
  await waits.resolveCallback(registered.id, registered.token, { ok: true });
  const admitted = await operations.admitDispatch({
    ownerSessionId: 'commander',
    resultSessionId: 'commander',
    spec: {
      targetId: 'worker',
      chatId: 'worker',
      message: 'do the work',
      resultMode: 'async',
    },
  });
  await operations.completeDispatch(admitted.id, { status: 'completed', text: 'done' });

  const snapshot = await store.snapshot();
  assert.equal(snapshot.waits[registered.id].status, 'resolved');
  assert.ok(snapshot.outbox[`wait:${registered.id}`]);
  assert.equal(snapshot.operations[admitted.id].requestOutboxId,
    `operation:${admitted.id}:request`, 'raw operation alias update was persisted');
  assert.equal(snapshot.operations[admitted.id].status, 'completed');
  assert.ok(snapshot.outbox[`operation:${admitted.id}:request`]);
  assert.ok(snapshot.outbox[`operation:${admitted.id}:result`]);
  await store.close();
});

test('scrubbed task bodies are removed from both the database and truncated WAL', async t => {
  const files = tempPaths(t);
  const secret = 'SENSITIVE-DISPATCH-BODY-7ebf6c7d';
  let checkpoints = 0;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: { afterRedactionCheckpoint() { checkpoints += 1; } },
  });
  await store.mutate(draft => {
    draft.outbox.delivery = {
      id: 'delivery', sessionId: 'worker', sequence: 1, state: 'delivered',
      payload: { type: 'dispatch.request', message: secret }, updatedAt: 1,
    };
    draft.nextOutboxSequence = 2;
  });
  await store.mutate(draft => {
    delete draft.outbox.delivery.payload.message;
    draft.outbox.delivery.payload.messageRef = { sessionId: 'worker', deliveryId: 'delivery' };
  });
  assert.equal(checkpoints, 1);
  await store.mutate(draft => { draft.outbox.delivery.updatedAt = 2; });
  assert.equal(checkpoints, 1, 'later status changes do not repeat a redaction checkpoint');
  await store.flush();
  for (const file of [files.sqlite, `${files.sqlite}-wal`, `${files.sqlite}-shm`]) {
    if (!fs.existsSync(file)) continue;
    assert.equal(fs.readFileSync(file).includes(Buffer.from(secret)), false, file);
  }
  await store.close();
});

test('a bounded mutation serializes only its dirty row, not the full registry', async t => {
  const files = tempPaths(t);
  let observed = null;
  const store = createOrchestrationSqliteStore({
    file: files.sqlite,
    hooks: { beforeCommit({ change }) { observed = change; } },
  });
  await store.mutate(draft => {
    for (let index = 0; index < 2_000; index++) {
      draft.waits[`wait-${index}`] = waitRecord(`wait-${index}`);
    }
  });
  observed = null;
  await store.mutate(draft => { draft.waits['wait-1000'].status = 'resolved'; });
  assert.ok(observed);
  assert.equal(observed.expectedRevision, 1);
  assert.equal(observed.persisted.collections.waits.size, 1);
  assert.equal(observed.persisted.collections.outbox.size, 0);
  assert.equal(observed.persisted.collections.operations.size, 0);
  assert.equal(observed.persisted.collections.tasks.size, 0);
  assert.equal(observed.persisted.collections.sessionSchedules.size, 0);
  const metrics = store.metrics();
  assert.equal(metrics.multicc_orchestration_sqlite_mutations_total, 2);
  assert.equal(metrics.multicc_orchestration_sqlite_dirty_rows_total, 2_001);
  assert.ok(metrics.multicc_orchestration_sqlite_serialized_bytes_total > 0);
  assert.ok(metrics.multicc_orchestration_sqlite_commit_ms_max >= 0);
  await store.close();
});

test('corrupt SQLite fails closed and never falls back to legacy JSON', async t => {
  const files = tempPaths(t);
  fs.writeFileSync(files.json, JSON.stringify({ harmless: true }), { mode: 0o600 });
  fs.writeFileSync(files.sqlite, 'not a sqlite database', { mode: 0o600 });
  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite, legacyFile: files.json }),
    error => error instanceof OrchestrationSqliteError || error.code === 'ORCHESTRATION_STORE_CORRUPT',
  );
});

test('an existing database with a missing domain table fails closed instead of recreating it empty', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => { draft.tasks.proof = { id: 'proof', status: 'running' }; });
  await store.close();
  const db = new Database(files.sqlite);
  db.exec('DROP TABLE orchestration_tasks');
  db.close();

  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite }),
    error => error.code === 'ORCHESTRATION_STORE_CORRUPT'
      && /orchestration_tasks/.test(error.message),
  );
  const verify = new Database(files.sqlite, { readonly: true });
  const table = verify.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='orchestration_tasks'",
  ).get();
  verify.close();
  assert.equal(table, undefined, 'open did not silently heal data loss');
});

test('the outbox sequence uniqueness index is part of the validated schema contract', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.close();
  const db = new Database(files.sqlite);
  db.exec('DROP INDEX idx_orchestration_outbox_sequence');
  db.close();
  assert.throws(
    () => createOrchestrationSqliteStore({ file: files.sqlite }),
    error => error.code === 'ORCHESTRATION_STORE_CORRUPT'
      && /idx_orchestration_outbox_sequence/.test(error.message),
  );
});

test('native store rejects injected JavaScript database and filesystem ports', t => {
  const files = tempPaths(t);
  for (const [name, value] of [['Database', Database], ['fsImpl', fs], ['pathImpl', path]]) {
    assert.throws(
      () => createOrchestrationSqliteStore({ file: files.sqlite, [name]: value }),
      error => error instanceof TypeError && error.message.includes(name)
        && /unsupported by the Rust store/.test(error.message),
    );
  }
  assert.equal(fs.existsSync(files.sqlite), false);
});

test('native database creation fails closed when its directory is not writable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, t => {
  const files = tempPaths(t);
  fs.chmodSync(files.dir, 0o500);
  try {
    assert.throws(
      () => createOrchestrationSqliteStore({ file: files.sqlite }),
      error => error instanceof OrchestrationSqliteError && /permission denied/i.test(error.message),
    );
    assert.equal(fs.existsSync(files.sqlite), false);
  } finally { fs.chmodSync(files.dir, 0o700); }
});

test('storage uses the Rust driver; the npm addon remains a development oracle', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['better-sqlite3'], undefined,
    'a compiled addon must not be a production dependency: it is what forced every bundle to match an ABI');
  // Kept as a devDependency on purpose: tests/test-sqlite-driver.js runs the
  // same statements through both engines, so a behavior change in the built-in
  // SQLite shows up as a failure instead of as silently different data.
  assert.ok(manifest.devDependencies['better-sqlite3'], 'the cross-driver oracle must stay available to tests');

  const driver = fs.readFileSync(path.join(root, 'src/sqlite/driver.js'), 'utf8');
  assert.match(driver, /RustDatabase/);
  assert.match(driver, /ccSwitchDatabaseApi/);
  assert.doesNotMatch(driver, /require\('node:sqlite'\)/);
  for (const file of ['src/task-shell/store.js',
    'src/native/binding.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    // task-shell 仓储迁移后不再经 JS 打开 SQLite：整个 store 由原生
    // RustTaskStore 承载，同属“只用 Rust、绝不碰 npm addon”的边界。
    assert.match(source, /sqlite\/driver|RustTaskStore|createNativeStore/, `${file} must use the shared driver or the native Rust store`);
    assert.doesNotMatch(source, /require\('better-sqlite3'\)/, `${file} must not require the addon`);
  }
  for (const retired of ['src/orchestration/native-store-host.js', 'src/orchestration/draft-host.js', 'src/outbox.js']) {
    assert.equal(fs.existsSync(path.join(root, retired)), false, retired);
  }
  const readSource = file => fs.readFileSync(path.join(root, file), 'utf8');
  const factory = readSource('native/addon/src/orchestration_native_store/mod.rs');
  assert.match(factory, /"createNativeStore"[^;]*transport::create\(/s);
  const transport = readSource('native/addon/src/orchestration_native_store/transport.rs');
  const create = transport.match(/fn create\b[\s\S]*?\n\}/)?.[0];
  assert.ok(create, 'the registered factory must have an owner constructor');
  assert.match(create, /get\(c"RustIsolatedOrchestrationStore"\)\?\s*\.construct\(/);
  assert.doesNotMatch(create, /RustOrchestrationStore|Connection::open|better-sqlite3|node:sqlite/);
  const owner = readSource('native/addon/src/orchestration_owner.rs');
  assert.match(owner, /impl RustIsolatedOrchestrationStore\b[\s\S]*?OwnerSession::open\(&file, &owner_binary, &open\)/);
  const ownerClient = readSource('native/core/src/orchestration_owner.rs');
  assert.match(ownerClient, /if !binary\.is_absolute\(\)/);
  assert.match(ownerClient, /Command::new\(binary\)\s*\.arg\("orchestration-owner"\)[^;]*\.spawn\(\)/);

  // The retired quota facade must stay absent. The lifecycle adapter retains
  // its compatibility aliases and submits storage to Rust; a Node SQLite
  // fallback must not hide behind its exports.
  assert.equal(fs.existsSync(path.join(root, 'src/quota/provider-limit-cache.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/quota/provider-limit-cache-native-host.js')), false);
  const binding = fs.readFileSync(path.join(root, 'src/native/binding.js'), 'utf8');
  assert.match(binding, /createNativeStore: module\.exports\.orchestrationNativeStore\.createNativeStore/);
  const quotaHost = binding.slice(binding.indexOf("exposeHostApi('providerLimitCache'"), binding.indexOf("exposeHostApi('quotaHistory'"));
  const quotaExports = require('../src/native/binding').providerLimitCache;
  assert.equal(quotaExports.createProviderLimitCache, quotaExports.createNativeProviderLimitCache);
  assert.equal(quotaExports.STALE_MS_DEFAULT, 10 * 60 * 1000);
  assert.equal(quotaExports.DATABASE_SCHEMA_VERSION, 1);
  assert.match(quotaHost, /Owner: getNative\(\)\.RustProviderLimitStore/);
  assert.match(quotaHost, /handle\.requestAsync\s*\(\s*op\s*,\s*input\s*\)/);
  for (const source of [quotaHost]) {
    assert.doesNotMatch(source, /(?:node:sqlite|better-sqlite3|sqlite\/driver)/,
      'quota host must not use a Node SQLite driver');
  }
  const quotaAddon = fs.readFileSync(path.join(root, 'native/addon/src/provider_limit_store.rs'), 'utf8');
  const quotaCore = fs.readFileSync(path.join(root, 'native/core/src/provider_limit_store.rs'), 'utf8');
  assert.match(quotaAddon, /provider_limit_store::Store/);
  assert.match(quotaAddon, /Store::open\s*\(/);
  assert.match(quotaCore, /use\s+rusqlite::/);

  // install.sh and the ./multicc manager used to carry a "rebuild the native
  // binding" hatch. Nothing is compiled any more, so that repair path would
  // have been a lie told to whoever hit it.
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'multicc'), 'utf8');
  for (const [file, text] of [['install.sh', installer], ['multicc', manager]]) {
    assert.doesNotMatch(text, /npm rebuild better-sqlite3/,
      `${file} must not advertise a rebuild that cannot help`);
  }
  // The standalone installer only downloads a package containing its own Node
  // runtime. The installed manager is the component that actually executes the
  // SQLite capability probe, so it owns the actionable runtime diagnostic.
  assert.match(installer, /package carries its own Node runtime/);
  assert.match(manager, /cargo build --locked --release/, 'source manager builds the service with bundled SQLite');
  assert.doesNotMatch(manager, /check-sqlite-runtime\.js/);
  const sqliteCheck = fs.readFileSync(path.join(root, 'scripts/check-sqlite-runtime.js'), 'utf8');
  assert.match(sqliteCheck, /new Database\(':memory:'\)/);
});

test('native selectors preserve missing/null and numeric types, projection and read-your-writes', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => {
    draft.tasks.a = { id: 'a', status: 'running', n: 0, spec: { chatId: 's', message: 'not projected' } };
    draft.tasks.b = { id: 'b', status: null, n: '0' };
    draft.tasks.c = { id: 'c' };
    draft.tasks.done = { id: 'done', status: 'completed' };
  });
  assert.deepEqual(await store.select('tasks', { where: { status: null }, fields: ['id'] }), [{ id: 'b' }]);
  assert.deepEqual(await store.select('tasks', { where: { status: { $nin: [null, 'completed'] } }, fields: ['id'] }), [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(await store.select('tasks', { where: { n: { $lte: 0 } }, fields: ['id', 'spec.chatId'] }), [{ id: 'a', spec: { chatId: 's' } }]);
  assert.equal(await store.read(state => Object.getOwnPropertyDescriptor(state.tasks.a, 'status').value), 'running');
  let leaked;
  await store.mutate(draft => {
    assert.equal(Object.keys(draft).includes('select'), false);
    assert.equal(Object.keys(draft).includes('count'), false);
    const [row] = draft.select('tasks', { where: { status: 'running' } });
    leaked = row;
    row.status = 'completed';
    draft.tasks.new = { id: 'new', status: 'running' };
    delete draft.tasks.c;
    assert.equal(draft.count('tasks', { status: 'running' }), 1);
    assert.deepEqual(draft.select('tasks', { where: { status: 'running' } }).map(task => task.id), ['new']);
    assert.equal(draft.count('tasks', { status: 'completed' }), 2);
  });
  assert.throws(() => leaked.status, /no longer active/);
  assert.throws(() => Object.keys(leaked), /no longer active/);
  const snapshot = await store.snapshot();
  assert.equal(Object.hasOwn(snapshot, 'select'), false);
  assert.equal(Object.hasOwn(snapshot, 'count'), false);
  await store.close();
});

test('streaming native rollback export preserves metadata and refuses live database targets', async t => {
  const files = tempPaths(t);
  const store = createOrchestrationSqliteStore({ file: files.sqlite });
  await store.mutate(draft => {
    draft.tasks['10'] = { id: '10', status: 'completed', result: 'preserved result body', nested: { z: 2, a: 1 } };
    draft.tasks['2'] = { id: '2', status: 'running' };
    draft.extra = { '10': true, '2': false, z: 'last', a: ['first'] };
  });
  const before = await store.snapshot();
  await assert.rejects(store.exportLegacy(files.sqlite), /export target/);
  await assert.rejects(store.exportLegacy(`${files.sqlite}-wal`), /export target/);
  if (process.platform !== 'win32') {
    const link = path.join(files.dir, 'database-alias.json');
    fs.linkSync(files.sqlite, link);
    await assert.rejects(store.exportLegacy(link), /export target/);
    fs.unlinkSync(link);
  }
  const report = require('../scripts/export-orchestration-sqlite').exportSnapshot({
    databaseFile: files.sqlite, targetFile: files.json,
  });
  assert.equal(report.databaseFile, files.sqlite);
  assert.equal(report.targetFile, files.json);
  assert.equal(report.revision, before.revision);
  assert.equal(report.digest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), before);
  const oracle = new Database(files.sqlite, { readonly: true });
  try {
    assert.deepEqual(require('./helpers/orchestration-sqlite-oracle')._loadDatabaseState(oracle, files.sqlite), before);
  } finally { oracle.close(); }
  await store.close();
});

test('large terminal history opens and selects active candidates under a bounded Node heap', async t => {
  const files = tempPaths(t);
  const empty = createOrchestrationSqliteStore({ file: files.sqlite });
  await empty.close();
  // Seed outside the child process. No real database is read or modified.
  const seed = new Database(files.sqlite);
  const insert = seed.prepare('INSERT INTO orchestration_tasks(id,data_json,parent_session_id,status,updated_at) VALUES (?,?,?,?,?)');
  const payload = 'historical output '.repeat(1400);
  seed.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const id = `history-${i}`;
      insert.run(id, JSON.stringify({ id, status: 'completed', result: payload, updatedAt: 1 }), null, 'completed', 1);
    }
    insert.run('active', JSON.stringify({ id: 'active', status: 'running', updatedAt: 1 }), null, 'running', 1);
  })();
  seed.close();
  const script = String.raw`
    const assert = require('node:assert/strict');
    const { createOrchestrationSqliteStore } = require('./src/native/binding').orchestrationSqlite;
    (async () => {
      const store = createOrchestrationSqliteStore({ file: process.argv[1] });
      assert.equal(await store.count('tasks', {}), 6001);
      assert.deepEqual(await store.select('tasks', {
        where: { status: { $nin: ['completed', 'failed', 'cancelled'] } }, fields: ['id', 'status'],
      }), [{ id: 'active', status: 'running' }]);
      await store.mutate(draft => {
        const [row] = draft.select('tasks', { where: { status: 'running' } });
        row.status = 'completed';
      });
      assert.equal(await store.read(state => state.tasks.active.status), 'completed');
      assert.ok(store.metrics().multicc_orchestration_sqlite_materialized_bytes_total < 512 * 1024);
      await store.close();
      process.stdout.write('bounded-history-ok');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=80', '-e', script, files.sqlite], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 90_000,
    env: { ...process.env }, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /bounded-history-ok/);
});


test('native JSON boundaries preserve sliced UTF-16 strings and nested property names', async t => {
  const files = tempPaths(t);
  const legacy = createOrchestrationStore({ file: files.json, now: () => 10 });
  const high = '😀'.slice(0, 1);
  const low = '😀'.slice(1);
  const record = { id: 'utf16', status: 'running', lastLine: high,
    nested: { [low]: [high, low, '完整😀'], 'quoted"key': low, '10': high, '2': low } };
  await legacy.mutate(draft => { draft.tasks.utf16 = record; draft.extra = { [high]: low }; });
  const before = await legacy.snapshot();
  const store = createOrchestrationSqliteStore({ file: files.sqlite, legacyFile: files.json });
  assert.deepEqual(await store.snapshot(), before);
  assert.equal(store.migration.legacyDigest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(before));
  assert.equal(await store.read(state => state.tasks.utf16.nested[low][0]), high);
  assert.equal(await store.read(state => state.tasks.utf16.nested['quoted"key']), low);
  assert.deepEqual(await store.select('tasks', { fields: ['id', 'status', 'lastLine', 'nested'] }), [record]);
  assert.equal(await store.count('tasks', { lastLine: high }), 1);
  assert.equal(await store.count('tasks', { lastLine: '�' }), 0);
  await store.mutate(draft => {
    draft.tasks.utf16.lastLine = low;
    draft.tasks.utf16.nested[low].push(high);
    assert.equal(draft.count('tasks', { lastLine: low }), 1);
    assert.equal(draft.select('tasks', { fields: ['lastLine'] })[0].lastLine, low);
  });
  const expected = await store.snapshot();
  const exported = await store.exportLegacy(files.json);
  assert.equal(exported.digest, require('./helpers/orchestration-sqlite-oracle')._stateDigest(expected));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), expected);
  await store.close({ exportRollback: false });
  const reopened = createOrchestrationSqliteStore({ file: files.sqlite });
  assert.deepEqual(await reopened.snapshot(), expected);
  await reopened.close();
});


test('capacity maintenance runs early but preserves recent receipts until the retention horizon', async t => {
  const files = tempPaths(t);
  let clock = 1_800_000_000_000;
  const store = createOrchestrationSqliteStore({ file: files.sqlite, now: () => clock,
    retention: { maxRecords: 2 } });
  await store.mutate(draft => {
    for (const id of ['a', 'b']) draft.tasks[id] = { id, status: 'completed',
      completedAt: clock - 1, updatedAt: clock - 1 };
  });
  const first = await store.pruneRetained();
  assert.equal(first.deletedTasks, 0);
  assert.equal(first.capacityTriggered, false);
  clock += 1;
  await store.mutate(draft => { draft.tasks.newest = { id: 'newest', status: 'completed',
    completedAt: clock, updatedAt: clock }; });
  clock += 60_000; // Still well before the one-hour expiry interval.
  const capacity = await store.pruneRetained();
  assert.equal(capacity.capacityTriggered, true);
  assert.equal(capacity.deletedTasks, 0);
  assert.equal(await store.count('tasks'), 3);
  assert.equal(await store.read(state => state.tasks.newest.id), 'newest');
  clock += 1;
  await store.mutate(draft => { draft.tasks.newest.lastLine = 'revision refreshed after maintenance'; });
  clock += 31 * 24 * 60 * 60 * 1000;
  const expired = await store.pruneRetained();
  assert.equal(expired.capacityTriggered, true);
  assert.equal(expired.deletedTasks, 3, 'expiry cleanup is not limited to the one-row capacity excess');
  assert.equal(await store.count('tasks'), 0);
  await store.close();
});

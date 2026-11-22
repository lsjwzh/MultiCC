'use strict';

// Differential: the retired `src/session/task-history-retention.js` (frozen as
// tests/helpers/legacy-task-history-retention.js) versus the Rust owner behind
// `getNative().createTaskHistoryRetention` / `getNative().taskHistoryRefusal`,
// which server.js and the task board lifecycle now use.
//
// Both sides receive the same deps triple (getBoard / getRecord / loadHistory)
// over a corpus of boards, records and histories, and must agree on all five
// exported behaviours: canDeleteSession, isMessageProtected, referencingTasks,
// sessionDeletionFacts and the refusal body (including the byte-exact Chinese
// user-facing message). Cases where loadHistory throws cover both the ENOENT
// branch and the rethrow branch.
//
// Coverage is asserted per branch so an empty corpus cannot pass; the mutation
// block at the bottom tampers with the oracle and proves the comparison turns
// red. Hermetic: no io beyond in-memory fixtures, no clock.

const assert = require('node:assert/strict');
const test = require('node:test');

const { getNative } = require('../src/native/runtime');
const legacy = require('./helpers/legacy-task-history-retention');

function enoent() {
  const error = new Error('no such file');
  error.code = 'ENOENT';
  return error;
}

// Each case is a self-contained world: board, records and histories.
function worlds() {
  const linkedByChat = { id: 't1', title: 'Chat owner', chatSessionId: 's1' };
  const linkedByRouting = { id: 't2', title: 'Worker owner', routing: { workerSessionId: 's2' } };
  const linkedByRef = { id: 't3', refs: [{ sessionId: 's3' }] };
  const linkedByRefMsg = { id: 't4', title: 'Ref with ids', refs: [{ sessionId: 's4', userMsgId: 'u1' }] };
  const deletingOwner = { id: 't5', deleting: true, chatSessionId: 's5' };
  const refAssistant = { id: 't6', refs: [{ sessionId: 's6', assistantMsgId: 'a9' }] };
  return [
    ['empty board, no history file', {
      board: { tasks: {} }, records: {}, histories: {}, historyThrows: { s: 'ENOENT' },
      probes: [{ sessionId: 's' }],
    }],
    ['chatSessionId link blocks', {
      board: { tasks: { t1: linkedByChat } }, records: {}, histories: { s1: [] },
      probes: [{ sessionId: 's1' }],
    }],
    ['routing workerSessionId link blocks', {
      board: { tasks: { t2: linkedByRouting } }, records: {}, histories: { s2: [] },
      probes: [{ sessionId: 's2' }],
    }],
    ['refs session link blocks', {
      board: { tasks: { t3: linkedByRef } }, records: {}, histories: { s3: [] },
      probes: [{ sessionId: 's3' }],
    }],
    ['a deleting task no longer blocks', {
      board: { tasks: { t5: deletingOwner } }, records: {}, histories: { s5: [] },
      probes: [{ sessionId: 's5' }],
    }],
    ['execution slot is always disposable', {
      board: { tasks: { t1: linkedByChat } }, records: { s1: { taskExecutionSlot: true } },
      histories: { s1: [] }, probes: [{ sessionId: 's1' }],
    }],
    ['a message stamped with a live task blocks', {
      board: { tasks: { t9: { id: 't9', title: 'Stamped' } } }, records: {},
      histories: { s7: [{ id: 'm1', taskId: 't9' }] }, probes: [{ sessionId: 's7' }],
    }],
    ['a stamp whose task is in deletedTaskIds is an orphan and does not block', {
      board: { tasks: {}, deletedTaskIds: ['tGone'] }, records: {},
      histories: { s8: [{ id: 'm1', taskId: 'tGone' }] }, probes: [{ sessionId: 's8' }],
    }],
    ['a stamp absent from both board and deletedTaskIds stays protected', {
      board: { tasks: {} }, records: {},
      histories: { s9: [{ id: 'm1', taskId: 'tProvisional' }] }, probes: [{ sessionId: 's9' }],
    }],
    ['loadHistory rethrow (non-ENOENT) surfaces from canDeleteSession', {
      board: { tasks: {} }, records: {}, histories: {}, historyThrows: { s10: 'EACCES' },
      probes: [{ sessionId: 's10' }],
    }],
    ['message protection: bare ref protects every message of the session', {
      board: { tasks: { t3: linkedByRef } }, records: {}, histories: { s3: [] },
      probes: [{ sessionId: 's3', messages: [{ id: 'mX' }, { id: 'u1' }] }],
    }],
    ['message protection: ref with ids protects only the matching message', {
      board: { tasks: { t4: linkedByRefMsg, t6: refAssistant } }, records: {},
      histories: { s4: [], s6: [] },
      probes: [
        { sessionId: 's4', messages: [{ id: 'u1' }, { id: 'other' }] },
        { sessionId: 's6', messages: [{ id: 'a9' }, { id: 'u1' }] },
      ],
    }],
    ['message protection: taskId stamp on a deleting task falls through to refs', {
      board: { tasks: { t5: deletingOwner, t7: { id: 't7', refs: [{ sessionId: 's5', userMsgId: 'keep' }] } } },
      records: {}, histories: { s5: [] },
      probes: [{ sessionId: 's5', messages: [{ id: 'keep', taskId: 't5' }, { id: 'drop', taskId: 't5' }] }],
    }],
    ['facts: session and routing links split, message links dedupe', {
      board: { tasks: {
        t1: linkedByChat, t2: { ...linkedByRouting, routing: { workerSessionId: 's1' } },
        t9: { id: 't9', title: 'Stamped' },
      } },
      records: {}, histories: { s1: [{ id: 'm1', taskId: 't9' }, { id: 'm2', taskId: 't9' }, { id: 'm3' }] },
      probes: [{ sessionId: 's1' }],
    }],
  ];
}

function depsFor(world) {
  return {
    getBoard: () => world.board,
    getRecord: sessionId => world.records[sessionId],
    loadHistory: sessionId => {
      const code = (world.historyThrows || {})[sessionId];
      if (code === 'ENOENT') throw enoent();
      if (code) { const error = new Error(code); error.code = code; throw error; }
      return world.histories[sessionId] || [];
    },
  };
}

function outcome(fn) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, code: error.code || error.message }; }
}

test('task history retention: native matches the frozen Node oracle on every world', () => {
  const native = getNative();
  const covered = { canDelete: 0, protect: 0, references: 0, facts: 0, refusal: 0 };
  for (const [label, world] of worlds()) {
    const legacyService = legacy.createTaskHistoryRetention(depsFor(world));
    const nativeService = native.createTaskHistoryRetention(depsFor(world));
    for (const probe of world.probes) {
      covered.canDelete += 1;
      assert.deepEqual(
        outcome(() => nativeService.canDeleteSession(probe.sessionId)),
        outcome(() => legacyService.canDeleteSession(probe.sessionId)),
        `${label}: canDeleteSession diverged`);
      covered.references += 1;
      assert.deepEqual(
        outcome(() => nativeService.referencingTasks(probe.sessionId)),
        outcome(() => legacyService.referencingTasks(probe.sessionId)),
        `${label}: referencingTasks diverged`);
      covered.facts += 1;
      assert.deepEqual(
        outcome(() => nativeService.sessionDeletionFacts(probe.sessionId)),
        outcome(() => legacyService.sessionDeletionFacts(probe.sessionId)),
        `${label}: sessionDeletionFacts diverged`);
      for (const message of probe.messages || []) {
        covered.protect += 1;
        assert.equal(nativeService.isMessageProtected(probe.sessionId, message),
          legacyService.isMessageProtected(probe.sessionId, message),
          `${label}: isMessageProtected diverged for ${JSON.stringify(message)}`);
      }
    }
  }
  for (const refusalInput of [
    {}, { code: 'custom_code' },
    { tasks: [{ id: 't1', title: '外部任务', via: 'session' }, { id: 't2', via: 'messages' }] },
    { tasks: [{ id: 't3', title: '', via: 'routing' }, { via: 'messages' }] },
    { tasks: 'not-an-array' },
  ]) {
    covered.refusal += 1;
    const before = legacy.taskHistoryRefusal(refusalInput);
    const after = native.taskHistoryRefusal(refusalInput);
    assert.deepEqual(after, before, `taskHistoryRefusal diverged for ${JSON.stringify(refusalInput)}`);
    assert.equal(after.error, before.error, 'the user-facing message must be byte-identical');
  }
  assert.ok(covered.canDelete >= 10 && covered.protect >= 6 && covered.references >= 10
    && covered.facts >= 10 && covered.refusal >= 5, `coverage hole: ${JSON.stringify(covered)}`);
});

test('the differential turns red when the oracle is tampered with', () => {
  const world = worlds()[1][1]; // chatSessionId link blocks
  const nativeService = getNative().createTaskHistoryRetention(depsFor(world));
  // A tampered oracle that ignores the chatSessionId link must diverge.
  const tampered = legacy.createTaskHistoryRetention({
    ...depsFor(world),
    getBoard: () => ({ tasks: {} }),
  });
  assert.notEqual(nativeService.canDeleteSession('s1'), tampered.canDeleteSession('s1'),
    'a link-blind oracle must be caught');
  assert.equal(nativeService.canDeleteSession('s1'),
    legacy.createTaskHistoryRetention(depsFor(world)).canDeleteSession('s1'),
    'the untampered oracle still agrees, so the red above is attributable');
});

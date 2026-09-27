'use strict';

// M4-T4 · Shared DTO golden (docs/chat-view-unification-design.md §3-M4,
// invariant I7's enforcement): this suite used to pin the session transcript
// (src/routes/chat-history.js) and the task ledger projection
// (src/task-run/transcript-repository.js) to one golden page DTO, because both
// fed the same front-end history pipeline (chat.js applyHistoryPlan). The
// ledger producer went away with the dead task-run subsystem, so the session
// producer's page contract is what remains pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatHistoryRuntime,
} = require('../src/routes/chat-history');

// ── Minimal chat-history runtime fixture (trimmed from the harness in
// tests/test-chat-history-routes.js — only what assertChatHistoryDeps needs).
function createMemoryHistory(initial) {
  const records = new Map(Object.entries(initial));
  return {
    read: sessionId => JSON.parse(JSON.stringify(records.get(String(sessionId)) || [])),
    write(sessionId, messages) { records.set(String(sessionId), JSON.parse(JSON.stringify(messages))); },
    deleteSession: sessionId => records.delete(String(sessionId)),
    hasPersistedDelivery: () => false,
  };
}

function createRuntimeFixture(initial, { historyPageSize = 5 } = {}) {
  const noop = () => {};
  return createChatHistoryRuntime({
    history: createMemoryHistory(initial),
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    chatSessions: new Map([['s1', { cli: 'claude' }]]),
    idFactory: () => 'id-x',
    now: () => 5000,
    historyPageSize,
    chatBroadcast: noop,
    distillHistoryIntoMemory: async () => ({}),
    maybeSchedulePeriodicMemoryReview: noop,
    cliSwitchGitSnapshot: async () => ({ branch: 'main', head: 'abc', changes: [] }),
    clearAllNativeCliStates: () => 0,
    buildHandoffCheckpoint: input => ({ createdAt: 1, history: input.history }),
    rememberActiveCliState: noop,
    saveBestEffort: noop,
    trackPendingMemoryDistill: (sessionId, promise) => promise,
    chatStream: { close: noop },
  });
}

// ── Pagination golden ──────────────────────────────────────────────────────
//
// The paginator implements the wire contract: tail page by default, `before`
// pages strictly older, `around` centres a window and reports found/hasNewer,
// cursors are message ids, size clamps to 1..100.

function paginationMatrix(paginate, label, { size = 7 } = {}) {
  const ids = Array.from({ length: size }, (_, i) => `m${i + 1}`);

  test(`${label}: tail page honours the limit`, () => {
    assert.deepEqual(paginate({ limit: 3 }), {
      messages: ['m5', 'm6', 'm7'],
      hasMore: true,
      before: 'm5',
    });
  });

  test(`${label}: before pages strictly older than the cursor`, () => {
    assert.deepEqual(paginate({ before: 'm3', limit: 3 }), {
      messages: ['m1', 'm2'],
      hasMore: false,
      before: null,
    });
  });

  test(`${label}: around centres a window and reports found/hasNewer`, () => {
    assert.deepEqual(paginate({ around: 'm2', limit: 3 }), {
      messages: ['m1', 'm2', 'm3'],
      hasMore: false,
      before: null,
      found: true,
      hasNewer: true,
    });
  });

  test(`${label}: unknown around and before cursors return empty pages`, () => {
    assert.deepEqual(paginate({ around: 'nope', limit: 3 }), {
      messages: [],
      hasMore: false,
      before: null,
      found: false,
      hasNewer: false,
    });
    assert.deepEqual(paginate({ before: 'nope', limit: 3 }), {
      messages: [],
      hasMore: false,
      before: null,
    });
  });

  test(`${label}: limit clamps to 100 and junk falls back to the default size`, () => {
    const clamped = paginate({ limit: 1000, size: 105 });
    assert.equal(clamped.messages.length, 100);
    assert.equal(clamped.hasMore, true);

    const junk = paginate({ limit: 'zero-ish' });
    assert.equal(junk.messages.length, 5);
  });
}

// The matrix asserts on ids, not full objects.
function idsOnly(page) {
  return { ...page, messages: page.messages.map(message => message.id) };
}

function sessionPaginate({ size = 7, ...query }) {
  const ids = Array.from({ length: size }, (_, i) => `m${i + 1}`);
  const runtime = createRuntimeFixture({
    s1: ids.map((id, i) => ({ id, role: 'user', content: id, ts: 1000 + i })),
  });
  return idsOnly(JSON.parse(JSON.stringify(runtime.paginate('s1', query))));
}

paginationMatrix(sessionPaginate, 'session paginate');

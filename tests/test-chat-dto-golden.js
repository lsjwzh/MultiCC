'use strict';

// M4-T4 · Shared DTO golden (docs/chat-view-unification-design.md §3-M4,
// invariant I7's enforcement): the session transcript (src/routes/chat-history.js)
// and the task ledger projection (src/task-transcript-repository.js) feed the
// SAME front-end history pipeline (chat.js applyHistoryPlan). One renderer
// means one contract — this suite pins both producers to a single golden so
// renaming a field, reshaping a page, or changing cursor semantics on one side
// without the other fails HERE, not in a rendered view.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HISTORY_PAGE_SIZE,
  createChatHistoryRuntime,
} = require('../src/routes/chat-history');
const {
  DEFAULT_PAGE_SIZE,
  ledgerRowToChatMessage,
  paginateTranscript,
} = require('../src/task-transcript-repository');

// The default page sizes must agree: one controller requests "a page" without
// knowing which producer sits behind the endpoint.
test('both producers default to the same page size', () => {
  assert.equal(DEFAULT_PAGE_SIZE, DEFAULT_HISTORY_PAGE_SIZE);
});

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

// ── Message DTO golden ─────────────────────────────────────────────────────

// The canonical turn every producer must render identically. Shared
// vocabulary only: a field both sides may emit, under one name and one type.
const CANONICAL_USER = {
  id: 'u1', role: 'user', content: '继续任务', ts: 1724000001000,
  clientMsgId: 'cm-1',
};
const CANONICAL_ASSISTANT = {
  id: 'a1', role: 'assistant', content: '已继续', ts: 1724000004000,
  tools: [{ id: 'tool-1', name: 'Read', status: 'done' }],
  durationMs: 2500,
  usage: { inputTokens: 120, outputTokens: 30 },
  cost: 0.012,
  clientMsgId: 'cm-2',
};

test('a canonical turn projects to one golden DTO from both producers', () => {
  // Session side: history storage is passthrough — the page DTO is the stored
  // message. Task side: the ledger row is whitelisted into the same shape.
  const runtime = createRuntimeFixture({ s1: [CANONICAL_USER, CANONICAL_ASSISTANT] });
  const sessionPage = runtime.paginate('s1', { limit: 10 });

  const taskMessages = [CANONICAL_USER, CANONICAL_ASSISTANT].map(message => ledgerRowToChatMessage({
    messageId: message.id,
    role: message.role,
    content_text: message.content,
    createdAt: message.ts,
    metadata: message,
  }));

  assert.deepEqual(sessionPage.messages, [CANONICAL_USER, CANONICAL_ASSISTANT]);
  assert.deepEqual(taskMessages, [CANONICAL_USER, CANONICAL_ASSISTANT]);
  assert.deepEqual(sessionPage.messages, taskMessages);
});

test('the task projection whitelists — ledger internals never reach a client', () => {
  const projected = ledgerRowToChatMessage({
    messageId: 'a9',
    role: 'assistant',
    content_text: 'text',
    createdAt: '1724000009000',
    kind: 'summary',
    metadata: {
      clientMsgId: 'cm-9',
      tools: [{ id: 't', name: 'Bash' }],
      usage: { inputTokens: 1 },
      cost: 0.5,
      durationMs: 42,
      partial: true,
      // Internal write-path fields — must not cross the boundary.
      leaseEpoch: 3,
      retryable: true,
      error: 'boom',
      deliveryId: 'dlv-1',
    },
  }, 'run-9');

  assert.deepEqual(projected, {
    id: 'a9',
    role: 'assistant',
    content: 'text',
    ts: 1724000009000,
    kind: 'summary',
    taskRunId: 'run-9',
    tools: [{ id: 't', name: 'Bash' }],
    clientMsgId: 'cm-9',
    usage: { inputTokens: 1 },
    cost: 0.5,
    durationMs: 42,
    partial: true,
  });
  assert.equal(projected.leaseEpoch, undefined);
  assert.equal(projected.error, undefined);
  assert.equal(projected.deliveryId, undefined);
});

// ── Pagination golden ──────────────────────────────────────────────────────
//
// Both paginators implement the same wire contract: tail page by default,
// `before` pages strictly older, `around` centres a window and reports
// found/hasNewer, cursors are message ids, size clamps to 1..100.

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

// The matrix asserts on ids, not full objects — the page-for-page agreement
// test below compares the complete DTOs.
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

function taskPaginate({ size = 7, ...query }) {
  const ids = Array.from({ length: size }, (_, i) => `m${i + 1}`);
  const page = paginateTranscript(
    ids.map((id, i) => ({ id, role: 'user', content: id, ts: 1000 + i })),
    query,
  );
  return idsOnly(JSON.parse(JSON.stringify(page)));
}

paginationMatrix(sessionPaginate, 'session paginate');
paginationMatrix(taskPaginate, 'task paginateTranscript');

test('both paginators agree page-for-page on a shared transcript', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `m${i + 1}`);
  const queries = [
    {},
    { limit: 4 },
    { before: 'm5', limit: 4 },
    { before: 'm2', limit: 4 },
    { around: 'm5', limit: 4 },
    { around: 'm1', limit: 4 },
    { around: 'm9', limit: 4 },
    { around: 'absent', limit: 4 },
    { before: 'absent', limit: 4 },
    { limit: 0 },
    { limit: '-2' },
    { limit: 1000 },
  ];
  const runtime = createRuntimeFixture({
    s1: ids.map((id, i) => ({ id, role: 'user', content: id, ts: 2000 + i })),
  });
  const transcript = ids.map((id, i) => ({ id, role: 'user', content: id, ts: 2000 + i }));
  for (const query of queries) {
    const sessionPage = JSON.parse(JSON.stringify(runtime.paginate('s1', query)));
    const taskPage = JSON.parse(JSON.stringify(paginateTranscript(transcript, query)));
    assert.deepEqual(taskPage, sessionPage, `page mismatch for query ${JSON.stringify(query)}`);
  }
});

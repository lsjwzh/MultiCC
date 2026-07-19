'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  DEFAULT_PAGE_SIZE,
  createHistoryStore,
  historyPlan,
  initialPlan,
} = require('../public/chat-history-store');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'chat-history-store.js'), 'utf8');

test('initial plan prefers authoritative totals and reconstructs the latest context window', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'older', usage: { input_tokens: 10, output_tokens: 3 } },
    {
      id: 'a2', role: 'assistant', content: 'streaming', streaming: true,
      usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    },
  ];
  const plan = initialPlan({ messages, tokenUsage: { inputTokens: 900, outputTokens: 80 }, hasMore: true });

  assert.deepEqual(plan.sessionTokens, { input: 900, output: 80 });
  assert.equal(plan.hasAuthoritativeUsage, true);
  assert.equal(plan.usedTokens, 31);
  assert.deepEqual(plan.streamingTail, { id: 'a2', content: 'streaming' });
  assert.deepEqual(plan.operations.map(operation => operation.kind), ['append', 'append', 'append']);
  assert.equal(plan.oldestMessageId, 'u1');
  assert.equal(Object.isFrozen(plan.operations), true);
});

test('a streaming tail without usage resets current context usage to zero', () => {
  const plan = initialPlan({ messages: [
    { id: 'a1', role: 'assistant', usage: { input_tokens: 800, output_tokens: 40 } },
    { id: 'a2', role: 'assistant', content: 'still running', streaming: true },
  ] });
  assert.equal(plan.usedTokens, 0);
  assert.deepEqual(plan.streamingTail, { id: 'a2', content: 'still running' });
});

test('initial plan falls back to safe assistant usage sums without mutating input', () => {
  const messages = [
    null,
    { role: 'user', usage: { input_tokens: 1000 } },
    { role: 'assistant', usage: { input_tokens: 8, output_tokens: 3 } },
    { role: 'assistant', usage: { input_tokens: '4', output_tokens: -9 } },
  ];
  const before = JSON.stringify(messages);
  const plan = initialPlan({ messages });
  assert.deepEqual(plan.sessionTokens, { input: 12, output: 3 });
  assert.equal(plan.usedTokens, 4);
  assert.equal(JSON.stringify(messages), before);
});

test('reconcile plan updates ids, drops unprovable id-less entries and owns one streaming tail', () => {
  const plan = historyPlan({ messages: [
    { id: 'm1', role: 'assistant', content: 'authoritative update' },
    { id: 'm2', role: 'user', content: 'arrived while offline' },
    { role: 'assistant', content: 'cannot dedupe this' },
    { role: 'assistant', content: 'authoritative stream tail', streaming: true },
  ] }, { mode: 'reconcile', visibleIds: ['m1'] });

  assert.equal(plan.mode, 'reconcile');
  assert.deepEqual(plan.operations.map(operation => [operation.kind, operation.id]), [
    ['update', 'm1'], ['append', 'm2'], ['stream-tail', null],
  ]);
  assert.equal(plan.usedTokens, 0);
});

test('a repeated persisted id produces one authoritative DOM operation', () => {
  const plan = historyPlan({ messages: [
    { id: 'same', role: 'assistant', content: 'stale' },
    { id: 'same', role: 'assistant', content: 'latest' },
  ] }, { mode: 'reconcile', visibleIds: [] });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].message.content, 'latest');
});

test('store accepts every reconnect and invalidates an older in-flight page', () => {
  const store = createHistoryStore();
  const first = store.acceptHistory({ messages: [{ id: 'm1' }], hasMore: true });
  const request = store.beginOlder();
  const reconnect = store.acceptHistory({ messages: [{ id: 'm1' }, { id: 'm2' }], hasMore: true }, ['m1']);

  assert.equal(first.mode, 'initial');
  assert.equal(reconnect.mode, 'reconcile');
  assert.deepEqual(reconnect.operations.map(operation => operation.kind), ['update', 'append']);
  assert.ok(reconnect.generation > request.generation);
  assert.equal(store.completeOlder(request, { messages: [{ id: 'old' }], hasMore: true }).stale, true);
  assert.equal(store.snapshot().oldestMessageId, 'm1');
});

test('pagination serializes requests, advances cursor and exhausts on empty or repeated pages', () => {
  const store = createHistoryStore({ pageSize: 12 });
  store.acceptHistory({ messages: [{ id: 'newest-page-start' }], hasMore: true });
  const firstRequest = store.beginOlder();
  assert.equal(store.beginOlder(), null);
  const completed = store.completeOlder(firstRequest, {
    messages: [{ id: 'older-page-start' }, { id: 'older-page-end' }], hasMore: true,
  });
  assert.equal(completed.stale, false);
  assert.equal(completed.oldestMessageId, 'older-page-start');
  assert.equal(completed.exhausted, false);

  const repeatedRequest = store.beginOlder();
  const repeated = store.completeOlder(repeatedRequest, {
    messages: [{ id: 'older-page-start' }], hasMore: true,
  });
  assert.equal(repeated.exhausted, true, 'a non-progressing cursor must stop auto pagination');
  assert.equal(store.beginOlder(), null);
});

test('transient failure unlocks retry while stale failure cannot unlock a new generation', () => {
  const store = createHistoryStore();
  store.acceptHistory({ messages: [{ id: 'cursor-1' }], hasMore: true });
  const oldRequest = store.beginOlder();
  const failed = store.rejectOlder(oldRequest);
  assert.equal(failed.loading, false);
  const retry = store.beginOlder();
  store.reset();
  store.rejectOlder(retry);
  assert.equal(store.snapshot().initialAccepted, false);
  assert.equal(store.snapshot().loading, false);
});

test('clear and oldest deletion invalidate requests; deletion advances to a safe visible cursor', () => {
  const store = createHistoryStore();
  store.acceptHistory({ messages: [{ id: 'oldest' }, { id: 'next' }], hasMore: true });
  const deleteRace = store.beginOlder();
  const deleted = store.deleteMessage('oldest', 'next');
  assert.equal(deleted.oldestMessageId, 'next');
  assert.equal(store.completeOlder(deleteRace, { messages: [{ id: 'stale' }] }).stale, true);

  const clearRace = store.beginOlder();
  const reset = store.reset();
  assert.equal(reset.initialAccepted, false);
  assert.equal(reset.oldestMessageId, null);
  assert.equal(store.completeOlder(clearRace, { messages: [{ id: 'stale-again' }] }).stale, true);
});

test('missing cursors fail closed even when a malformed page claims more history', () => {
  const store = createHistoryStore();
  store.acceptHistory({ messages: [{ role: 'user', content: 'no id' }], hasMore: true });
  assert.equal(store.beginOlder(), null);
});

test('classic script exports the narrow state API without DOM, network or credentials', () => {
  const window = {};
  vm.runInNewContext(SOURCE, { window, globalThis: window, Object, Number, Set }, {
    filename: 'chat-history-store.js',
  });
  assert.equal(typeof window.MultiCCChatHistoryStore.createHistoryStore, 'function');
  assert.doesNotMatch(SOURCE, /\bfetch\s*\(|XMLHttpRequest|WebSocket|document\.|innerHTML/);
  assert.doesNotMatch(SOURCE, /authorization|access_token|api[_-]?key|location\.search/i);
});

test('chat host uses reconcile/upsert, generation-aware paging and bounded initial fill', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'public', 'chat-event-controller.js'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'public', 'chat-history-view.js'), 'utf8');
  const storeTag = '<script src="chat-history-store.js"></script>';
  const viewTag = '<script src="chat-history-view.js"></script>';
  assert.ok(html.indexOf(storeTag) < html.indexOf('<script src="chat.js"></script>'));
  assert.ok(html.indexOf(storeTag) < html.indexOf(viewTag));
  assert.ok(html.indexOf(viewTag) < html.indexOf('<script src="chat.js"></script>'));
  assert.match(events, /historyStore\.acceptHistory\(message, historyView\.visibleIds\(\)\)/);
  assert.match(view, /operation\.id \? findById\(operation\.id\)/);
  assert.match(view, /existing\.replaceWith\(node\)/);
  assert.match(view, /operation\.kind === 'stream-tail'/);
  assert.match(view, /toolCards: hydrateStreamingTools\(message, element\)/);
  assert.match(chat, /isStreaming = true;\s+currentMsgEl = tail\.element/);
  assert.match(chat, /chatHistoryStore\.completeOlder\(request, d\)/);
  assert.match(chat, /if \(pagePlan\.stale\) return 0/);
  assert.match(chat, /autofillHistory\(4\)/);
  assert.match(chat, /chatHistoryStore\.reset\(\)/);
  assert.doesNotMatch(chat, /chatHistoryStore\.acceptInitial\(msg\)/);
  assert.doesNotMatch(chat, /_historyLoaded|_historyLoading|_historyExhausted|_historyHasMore|_oldestLoadedMsgId/);
});

test('page size remains stable and immutable snapshots expose request generation', () => {
  assert.equal(DEFAULT_PAGE_SIZE, 5);
  const store = createHistoryStore();
  store.acceptHistory({ messages: [{ id: 'm1' }], hasMore: true });
  const request = store.beginOlder();
  assert.equal(request.limit, DEFAULT_PAGE_SIZE);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(store.snapshot()), true);
  assert.equal(store.snapshot().activeRequestId, request.requestId);
});

test('durable history reset broadcasts an authoritative page and invalidates every client cursor', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const historyRuntime = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'chat-history.js'), 'utf8');
  const events = fs.readFileSync(path.join(ROOT, 'public', 'chat-event-controller.js'), 'utf8');

  assert.match(server, /await chatHistoryRuntime\.clearHistory\(sessionName, msg, cs\)/,
    'the WebSocket host must delegate clear ownership to the history runtime');
  assert.match(historyRuntime,
    /afterCommit:\s*\(\)\s*=>\s*\{[\s\S]*service\.paginate\(key,[\s\S]*type:\s*'chat_history_reset'/,
    'reset must be broadcast only from the post-persist commit boundary');
  assert.match(historyRuntime, /removedCount:\s*removed\.length/);
  assert.match(historyRuntime, /retainedCount:\s*retained\.length/);

  const resetHandler = events.match(/function handleHistoryReset\(message\)\s*\{([\s\S]*?)\n\s*function handleEvent/);
  assert.ok(resetHandler, 'event controller must handle authoritative reset broadcasts');
  assert.match(resetHandler[1], /host\.resetHistoryPagination\?\.\(\)/);
  assert.match(resetHandler[1], /historyView\.clearMessages\(\)/);
  assert.match(resetHandler[1], /historyStore\.acceptHistory\(/);
  assert.match(resetHandler[1], /host\.applyHistoryPlan\?\.\(plan\)/);
  assert.ok(
    resetHandler[1].indexOf('resetHistoryPagination') < resetHandler[1].indexOf('acceptHistory('),
    'stale pagination must be invalidated before the committed page is accepted',
  );
});

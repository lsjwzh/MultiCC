'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SESSION_MEMORY_MAX,
  createMemoryRuntime,
  getMemoryEntries,
  memorySimilarity,
  mergeMemoryEntries,
  normalizeManualMemory,
  parseMemoryEntries,
  trimMemoryEntries,
} = require('../src/memory/runtime');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  const record = options.record || { id: 's1', dirId: 'd1', kind: 'chat' };
  const records = options.records || new Map([[record.id, record]]);
  const calls = [];
  let unhealthy = !!options.unhealthy;
  let enqueue = options.enqueue || (request => Promise.resolve({ text: '-' }));
  const history = options.history || [];
  const runtime = createMemoryRuntime({
    records,
    auxQueue: {
      isUnhealthy: () => unhealthy,
      enqueue(request) {
        calls.push({ type: 'enqueue', request });
        return enqueue(request);
      },
    },
    loadHistory: sessionId => {
      calls.push({ type: 'load', sessionId });
      return history;
    },
    writeAutoFile(persisted, entries) {
      calls.push({ type: 'write', persisted, entries });
      if (options.writeError) throw options.writeError;
    },
    saveBestEffort(source) { calls.push({ type: 'save', source }); },
    scanContent: options.scanContent || (() => false),
    appendEvent(dirId, type, detail, sessionId) {
      calls.push({ type: 'event', dirId, eventType: type, detail, sessionId });
    },
    workspaceBroadcast(dirId, payload) { calls.push({ type: 'broadcast', dirId, payload }); },
    reviewInterval: options.reviewInterval ?? 3,
    reviewMaxMessages: options.reviewMaxMessages,
    memoryMaxLength: options.memoryMaxLength,
    recordApiError: options.recordApiError === undefined ? undefined : function (raw, context) {
      calls.push({ type: 'apiError', raw, context });
    },
    now: options.now || (() => 1234),
    logger: {
      log(message) { calls.push({ type: 'log', message }); },
      warn(message) { calls.push({ type: 'warn', message }); },
    },
  });
  return {
    calls,
    record,
    records,
    runtime,
    setEnqueue: value => { enqueue = value; },
    setUnhealthy: value => { unhealthy = value; },
  };
}

test('normalization preserves legacy formats, limits and type fallback', () => {
  assert.deepEqual(getMemoryEntries({ memory: '  legacy fact  ' }), [
    { type: 'fact', text: 'legacy fact', ts: 0 },
  ]);
  const original = [{ type: 'unknown', text: '  kept as-is  ', ts: 1 }, { type: 'fact', text: '  ' }];
  assert.equal(getMemoryEntries({ memory: original })[0], original[0]);

  let clock = 40;
  assert.deepEqual(normalizeManualMemory([
    { type: 'decision', text: '  chosen  ', ts: 2 },
    { type: 'unknown', text: 'fallback' },
    { type: 'fact', text: ' ' },
  ], { now: () => ++clock }), {
    entries: [
      { type: 'decision', text: 'chosen', ts: 2 },
      { type: 'fact', text: 'fallback', ts: 41 },
    ],
  });
  assert.deepEqual(normalizeManualMemory('  legacy  '), {
    entries: [{ type: 'fact', text: 'legacy', ts: 0 }],
  });
  assert.deepEqual(normalizeManualMemory(null), { entries: null });
  assert.equal(normalizeManualMemory('x'.repeat(SESSION_MEMORY_MAX + 1)).error,
    `memory too long (max ${SESSION_MEMORY_MAX})`);
  assert.equal(normalizeManualMemory([{ text: 'x'.repeat(SESSION_MEMORY_MAX + 1) }]).error,
    `memory too long (max ${SESSION_MEMORY_MAX} chars)`);
});

test('parser strips fences, filters unsafe lines and stamps each accepted entry', () => {
  let clock = 10;
  const entries = parseMemoryEntries(
    '```text\n[decision] keep\n[unknown] fallback\nplain fact\n[gotcha] reject me\n```',
    { scanContent: text => text.includes('reject'), now: () => ++clock },
  );
  assert.deepEqual(entries, [
    { type: 'decision', text: 'keep', ts: 11 },
    { type: 'fact', text: 'fallback', ts: 12 },
    { type: 'fact', text: 'plain fact', ts: 13 },
  ]);
  assert.deepEqual(parseMemoryEntries('-'), []);
  assert.deepEqual(parseMemoryEntries('—'), []);
});

test('dedup and eviction preserve the legacy threshold and survivor ordering', () => {
  assert.equal(memorySimilarity('short fact', 'prefix short fact suffix'), 0.7);
  assert.equal(memorySimilarity('same', 'same'), 1);
  const prior = [
    { type: 'fact', text: 'short fact', ts: 1 },
    { type: 'decision', text: 'different', ts: 2 },
  ];
  const fresh = [
    { type: 'gotcha', text: 'prefix short fact suffix', ts: 3 },
    { type: 'preference', text: 'new item', ts: 4 },
  ];
  assert.deepEqual(mergeMemoryEntries(prior, fresh), [fresh[0], prior[1], fresh[1]]);

  const within = [{ type: 'fact', text: 'abc', ts: 1 }];
  assert.equal(trimMemoryEntries(within, 3), within);
  const entries = [
    { type: 'unknown', text: 'uu', ts: 0 },
    { type: 'preference', text: 'pp', ts: 1 },
    { type: 'decision', text: 'dd', ts: 1 },
    { type: 'todo', text: 'tt', ts: 2 },
    { type: 'todo', text: 'oo', ts: 1 },
  ];
  // The old implementation contradicts its comment: unknown rank=5, so it is
  // more durable than preference. Characterize that behavior during extraction.
  assert.deepEqual(trimMemoryEntries(entries, 6), [
    entries[2], entries[1], entries[0],
  ]);
});

test('distill skips unsupported, short and unhealthy work without enqueueing', async () => {
  const missing = fixture({ records: new Map() });
  assert.deepEqual(await missing.runtime.distillHistoryIntoMemory('missing', []), { updated: false });

  for (const type of ['aux', 'gateway']) {
    const current = fixture({ record: { id: 's1', dirId: 'd1', type } });
    assert.deepEqual(await current.runtime.distillHistoryIntoMemory('s1', [
      { role: 'user', content: 'x'.repeat(80) },
    ]), { updated: false });
    assert.equal(current.calls.length, 0);
  }

  const short = fixture();
  assert.deepEqual(await short.runtime.distillHistoryIntoMemory('s1', [
    { role: 'system', content: 'x'.repeat(100) },
    { role: 'user', content: 'short' },
  ]), { updated: false });
  assert.equal(short.calls.length, 0);

  const unhealthy = fixture({ unhealthy: true });
  assert.deepEqual(await unhealthy.runtime.distillHistoryIntoMemory('s1', [
    { role: 'assistant', content: 'a'.repeat(80) },
  ]), { updated: false, skipped: 'aux unhealthy' });
  assert.equal(unhealthy.calls.length, 0);
});

test('distill commits memory before durable save, event and broadcast', async () => {
  const current = fixture({
    record: { id: 's1', dirId: 'd1', kind: 'chat', memory: [{ type: 'todo', text: 'old', ts: 1 }] },
    enqueue: () => Promise.resolve({ text: '[decision] chosen' }),
  });
  const result = await current.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'u'.repeat(50) },
    { role: 'assistant', content: 'a'.repeat(50) },
  ]);
  assert.equal(result.updated, true);
  assert.deepEqual(current.record.memory.map(entry => entry.text), ['old', 'chosen']);
  assert.deepEqual(current.calls.map(call => call.type), [
    'enqueue', 'write', 'save', 'event', 'broadcast', 'log',
  ]);
  assert.equal(current.calls[2].source, 'runtime.memory-distill');
  assert.equal(current.calls[3].detail, '已提炼会话记忆（2 条，9 字）');
  assert.deepEqual(current.calls[4].payload, { type: 'memory', sessionId: 's1' });
});

test('distill failures remain best-effort and empty output has no side effects', async () => {
  const rejected = fixture({ enqueue: () => Promise.reject(new Error('offline')) });
  assert.deepEqual(await rejected.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'x'.repeat(80) },
  ]), { updated: false, error: 'offline' });
  assert.equal(rejected.record.memory, undefined);
  assert.deepEqual(rejected.calls.map(call => call.type), ['enqueue', 'warn']);

  const writeFailure = fixture({
    enqueue: () => Promise.resolve({ text: '[fact] assigned before write' }),
    writeError: new Error('disk full'),
  });
  assert.deepEqual(await writeFailure.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'x'.repeat(80) },
  ]), { updated: false, error: 'disk full' });
  assert.equal(writeFailure.record.memory[0].text, 'assigned before write');
  assert.deepEqual(writeFailure.calls.map(call => call.type), ['enqueue', 'write', 'warn']);

  const empty = fixture({ enqueue: () => Promise.resolve({ text: '-' }) });
  const result = await empty.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'x'.repeat(80) },
  ]);
  assert.deepEqual(result, { updated: false, entries: [] });
  assert.deepEqual(empty.calls.map(call => call.type), ['enqueue']);
});

test('aux transport failures route through the centralized API error policy', async () => {
  const reported = fixture({
    recordApiError: true,
    enqueue: () => Promise.reject(new Error('read ECONNRESET')),
  });
  assert.deepEqual(await reported.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'x'.repeat(80) },
  ]), { updated: false, error: 'read ECONNRESET' });
  const report = reported.calls.find(call => call.type === 'apiError');
  assert.ok(report, 'failure must be reported to recordApiError');
  assert.equal(report.raw.source, 'aux_http');
  assert.equal(report.raw.provider, 'aux');
  assert.equal(report.raw.message, 'read ECONNRESET');
  assert.equal(report.context.sessionId, 's1');
  // Without the optional dependency (test composition, older hosts) the same
  // failure path stays best-effort and never throws.
  const quiet = fixture({ enqueue: () => Promise.reject(new Error('timeout')) });
  assert.deepEqual(await quiet.runtime.distillHistoryIntoMemory('s1', [
    { role: 'user', content: 'x'.repeat(80) },
  ]), { updated: false, error: 'timeout' });
  assert.equal(quiet.calls.find(call => call.type === 'apiError'), undefined);
});

test('review advances the last eligible cursor after memory side effects', async () => {
  const history = [
    { id: 'old', role: 'user', content: 'before cursor' },
    { id: 'cursor', role: 'assistant', content: 'cursor' },
    { id: 'skip', role: 'system', content: 'ignored' },
    { id: 'u2', role: 'user', content: 'stable preference' },
    { id: 'a2', role: 'assistant', content: 'confirmed decision' },
    { id: 'tool', role: 'assistant', content: { text: 'ignored' } },
  ];
  const current = fixture({
    record: { id: 's1', dirId: 'd1', kind: 'chat', memoryReviewCursorId: 'cursor' },
    history,
    enqueue: () => Promise.resolve({ text: '[preference] concise replies' }),
    now: () => 4567,
  });
  const result = await current.runtime.reviewConversationIntoMemory('s1');
  assert.equal(result.updated, true);
  assert.equal(current.record.memoryReviewCursorId, 'a2');
  assert.equal(current.record.memoryReviewAt, 4567);
  assert.deepEqual(current.calls.map(call => call.type), [
    'load', 'enqueue', 'write', 'save', 'event', 'broadcast', 'save',
  ]);
  assert.deepEqual(current.calls.filter(call => call.type === 'save').map(call => call.source), [
    'runtime.memory-distill', 'runtime.memory-review-cursor',
  ]);

  const noMemory = fixture({ history, enqueue: () => Promise.resolve({ text: '-' }) });
  const empty = await noMemory.runtime.reviewConversationIntoMemory('s1');
  assert.equal(empty.updated, false);
  assert.equal(noMemory.record.memoryReviewCursorId, 'a2');
  assert.deepEqual(noMemory.calls.map(call => call.type), ['load', 'enqueue', 'save']);
});

test('review is single-flight and failure schedules a prompt retry', async () => {
  const gate = deferred();
  const current = fixture({
    history: [{ id: 'm1', role: 'user', content: 'remember this stable preference' }],
    enqueue: () => gate.promise,
    reviewInterval: 4,
  });
  const first = current.runtime.reviewConversationIntoMemory('s1');
  const second = current.runtime.reviewConversationIntoMemory('s1');
  assert.equal(first, second);
  assert.equal(current.calls.filter(call => call.type === 'enqueue').length, 1);
  gate.reject(new Error('temporary'));
  assert.deepEqual(await first, { updated: false, error: 'temporary' });
  assert.equal(current.record.memoryReviewTurnCount, 3);
  assert.equal(current.record.memoryReviewCursorId, undefined);
  assert.equal(current.calls.find(call => call.type === 'save').source, 'runtime.memory-review-retry');
});

test('scheduler persists counter, deferred retry and healthy start transitions', async () => {
  const current = fixture({
    history: [{ id: 'm1', role: 'user', content: 'remember this stable preference' }],
    reviewInterval: 3,
  });
  current.runtime.maybeSchedulePeriodicMemoryReview('s1');
  assert.equal(current.record.memoryReviewTurnCount, 1);
  assert.equal(current.calls.at(-1).source, 'runtime.memory-review-counter');

  current.record.memoryReviewTurnCount = 2;
  current.setUnhealthy(true);
  current.runtime.maybeSchedulePeriodicMemoryReview('s1');
  assert.equal(current.record.memoryReviewTurnCount, 2);
  assert.equal(current.calls.at(-1).source, 'runtime.memory-review-deferred');

  current.setUnhealthy(false);
  current.runtime.maybeSchedulePeriodicMemoryReview('s1');
  assert.equal(current.record.memoryReviewTurnCount, 0);
  const start = current.calls.findIndex(call => call.type === 'save' && call.source === 'runtime.memory-review-start');
  const enqueue = current.calls.findIndex(call => call.type === 'enqueue');
  assert.equal(start >= 0 && enqueue > start, true);
  await new Promise(resolve => setImmediate(resolve));

  const disabled = fixture({ reviewInterval: 0 });
  disabled.runtime.maybeSchedulePeriodicMemoryReview('s1');
  assert.equal(disabled.record.memoryReviewTurnCount, undefined);
  assert.equal(disabled.calls.length, 0);
});

test('pending gate wraps rejection and an older completion cannot erase a newer promise', async () => {
  const current = fixture();
  const firstGate = deferred();
  const secondGate = deferred();
  const first = current.runtime.trackPendingDistill('s1', firstGate.promise);
  assert.equal(current.runtime.getPendingDistill('s1'), first);
  const second = current.runtime.trackPendingDistill('s1', secondGate.promise);
  assert.equal(current.runtime.getPendingDistill('s1'), second);
  firstGate.resolve({ updated: true });
  await first;
  assert.equal(current.runtime.getPendingDistill('s1'), second);
  secondGate.reject(new Error('failed safely'));
  assert.deepEqual(await second, { updated: false, error: 'failed safely' });
  assert.equal(current.runtime.getPendingDistill('s1'), undefined);
  assert.equal(current.calls.at(-1).type, 'warn');
});

test('host composition resolves history and rebound workspace broadcasting lazily', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const turnEngine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'),
    'utf8',
  );
  assert.match(server, /loadHistory:\s*sessionId\s*=>\s*chatHistoryRuntime\.load\(sessionId\)/);
  assert.match(server,
    /workspaceBroadcast:\s*\(dirId, payload\)\s*=>\s*workspaceBroadcast\(dirId, payload\)/);
  assert.match(server, /const memoryRuntime = createMemoryRuntime[\s\S]*chatHistoryRuntime = createChatHistoryRuntime/);
  assert.match(turnEngine,
    /pendingMemory = getPendingMemoryDistill\(sessionName\);[\s\S]*const deliver = \(\) => taskContextHost\.deliverSessionMessage[\s\S]*deliverAfterPendingMemory\([\s\S]*type: 'message_admission_progress'/);
});

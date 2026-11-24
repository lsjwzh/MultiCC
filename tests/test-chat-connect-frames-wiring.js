'use strict';

// Wiring regression for the /ws/chat connect-time frames that Rust now owns:
// the chat_history byte budget, the task_state seed gate and payload, and the
// ordered connect plan.
//
// The kernels are pinned to the frozen Node implementations by their own
// corpus tests (cargo test -p multicc-core). This file pins the OTHER end: the
// JavaScript faces production actually calls, going through the real native
// addon, against the very same frozen corpora and the frozen oracles in
// tests/helpers/legacy-chat-*.js. A kernel that is right while its face reads
// the wrong napi export, forwards the wrong option, loses the array identity
// the retired function guaranteed or narrows a value on the way in is invisible
// to the Rust tests and caught here.
//
//   frozen Node oracle  ==(corpus)==  Rust kernel
//   frozen Node oracle  ==(this file)==  the JS face + the real addon
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const frozenHistory = require('./helpers/legacy-chat-history-frame');
const frozenTaskState = require('./helpers/legacy-chat-task-state-frame');
const historyCorpus = require('../docs/rust-migration/differential/chat-history-frame-corpus.json');
const taskStateCorpus = require('../docs/rust-migration/differential/chat-task-state-frame-corpus.json');
const connectCorpus = require('../docs/rust-migration/differential/chat-connect-replay-golden.json');
const { getNative, installAuxHealthProvider, auxVerdictStaleness, taskStateSeed, taskStatePayload } = require('../src/native/runtime');

// The task-short-code registry mints into a persisted file on first use, which
// is exactly the side effect the connect path must not trigger needlessly, so
// the faces are loaded against a stub whose answer the test controls. Only the
// registry is stubbed; the Aux health reading stays the real module.
const SHORT_CODE_MODULE = path.join(__dirname, '..', 'src', 'classify', 'task-short-code.js');
let shortCode = '';
const shortCodeCalls = [];
require.cache[SHORT_CODE_MODULE] = {
  id: SHORT_CODE_MODULE, filename: SHORT_CODE_MODULE, loaded: true, children: [], paths: [],
  exports: { taskShortCode: taskId => { shortCodeCalls.push(taskId); return shortCode; } },
};
const { fitHistoryFrame, DEFAULT_MAX_BYTES, messageBytes } = require('../src/chat/history-frame-budget');

// JSON cannot carry `undefined`, so the corpus marks those slots and both
// sides rehydrate them (see chat-history-frame-oracle.js).
function rehydrate(value) {
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object') {
    if (value.__corpusUndefined === true) return undefined;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrate(v)]));
  }
  return value;
}

// ── chat_history byte budget ────────────────────────────────────────────────

test('the history face reproduces every frozen budget case through the real addon', () => {
  assert.equal(historyCorpus.cases.length, 144, 'the corpus lost cases');
  for (const entry of historyCorpus.cases) {
    const messages = rehydrate(entry.input.messages);
    const got = fitHistoryFrame(messages, entry.input.hasMore, entry.input.options);
    const label = `${entry.sweep} / ${entry.name}`;
    // The wire is the contract: an `undefined` the retired code kept in the
    // array is a null on the wire on both sides.
    assert.equal(JSON.stringify(got.messages), JSON.stringify(entry.expected.messages), `messages: ${label}`);
    assert.equal(got.hasMore, entry.expected.hasMore, `hasMore: ${label}`);
    assert.equal(got.dropped, entry.expected.dropped, `dropped: ${label}`);
    assert.equal(got.clipped, entry.expected.clipped, `clipped: ${label}`);
    // The retired function returned the SAME array when it dropped and clipped
    // nothing: a page under budget is the common case and must not be copied.
    if (Array.isArray(messages) && entry.expected.dropped === 0 && !entry.expected.clipped) {
      assert.equal(got.messages, messages, `identity: ${label}`);
    }
  }
});

test('the history face and the frozen implementation agree on the same input, message for message', () => {
  // Driven on the live module as well as the corpus, so the comparison does not
  // rest only on what the generator chose to write down.
  const page = Array.from({ length: 40 }, (_, i) => (i % 3 === 0
    ? { id: `a${i}`, role: 'assistant', content: 'text '.repeat(30),
      tools: [{ name: 'Bash', input: { command: 'c'.repeat(300) }, result: { stdout: 'o'.repeat(900 * (i + 1)) } }] }
    : { id: `u${i}`, role: 'user', content: `question ${i} `.repeat(10) }));
  for (const options of [{}, { maxBytes: 20_000 }, { maxBytes: 5_000, toolStringChars: 50 },
    { maxBytes: 0 }, { maxBytes: 0, toolStringChars: 0 }, { maxBytes: DEFAULT_MAX_BYTES }]) {
    for (const hasMore of [false, true]) {
      assert.deepEqual(fitHistoryFrame(page, hasMore, options),
        frozenHistory.fitHistoryFrame(page, hasMore, options),
        `options ${JSON.stringify(options)} hasMore=${hasMore}`);
    }
  }
  const pageWithPrototypeKey = JSON.parse('[{"tools":[{"input":{"__proto__":{"hidden":"long"},"shown":"long"}}]}]');
  const clipOptions = { maxBytes: 0, toolStringChars: 3 };
  assert.equal(JSON.stringify(fitHistoryFrame(pageWithPrototypeKey, false, clipOptions)),
    JSON.stringify(frozenHistory.fitHistoryFrame(pageWithPrototypeKey, false, clipOptions)));
});

test('an Infinity limit means "no limit", as it did before the budget moved to Rust', () => {
  // JSON writes Infinity as null, which the kernel would read as a budget of 0
  // and so drop the whole page to its last message.
  const page = [{ id: 'a', t: 'x'.repeat(600) }, { id: 'b', t: 'y'.repeat(600) }, { id: 'c', t: 'z' }];
  for (const options of [{ maxBytes: Infinity }, { maxBytes: Infinity, toolStringChars: 3 },
    { maxBytes: 0, toolStringChars: Infinity }]) {
    assert.deepEqual(fitHistoryFrame(page, false, options),
      frozenHistory.fitHistoryFrame(page, false, options), JSON.stringify({
        maxBytes: String(options.maxBytes), toolStringChars: String(options.toolStringChars) }));
  }
  assert.equal(fitHistoryFrame(page, false, { maxBytes: Infinity }).dropped, 0);
});

test('the default budget holds at the exact boundaries of the 2026-10-01 fix', () => {
  // The decision depends on message sizes only, so the pages are built to the
  // exact byte count from the corpus rather than stored in it.
  const shell = JSON.stringify({ id: 'm0', t: '' }).length;
  for (const entry of historyCorpus.planCases) {
    const page = entry.input.sizes.map((size, i) => ({ id: `m${i}`, t: 'x'.repeat(size - shell) }));
    assert.deepEqual(page.map(messageBytes), entry.input.sizes, `${entry.name}: the page is not the size the case names`);
    const got = fitHistoryFrame(page, entry.input.hasMore);
    assert.deepEqual({ hasMore: got.hasMore, dropped: got.dropped, clipped: got.clipped },
      entry.expected, entry.name);
  }
  assert.equal(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
});

// ── task_state seed gate and payload ────────────────────────────────────────

function withFacts(facts, run) {
  shortCode = facts.taskShortCode;
  installAuxHealthProvider(() => ({ unhealthy: facts.auxUnhealthy, sinceAt: facts.auxUnhealthySince }));
  try { return run(); } finally { installAuxHealthProvider(null); }
}

test('the task_state faces reproduce every frozen case through the real addon', () => {
  assert.equal(taskStateCorpus.cases.length, 678, 'the corpus lost cases');
  for (const entry of taskStateCorpus.cases) {
    const { task, facts } = entry.input;
    const label = `${entry.sweep} / ${entry.name}`;
    withFacts(facts, () => {
      // What production's two impure readings actually produce for these
      // facts. They are NOT the raw corpus facts: `auxVerdictStaleness` yields
      // `sinceAt || null` and nothing at all while healthy, so the oracle is
      // fed what the real function says, not what the corpus wrote down.
      const effective = { taskShortCode: facts.taskShortCode, ...auxVerdictStaleness() };
      const expectedSeed = frozenTaskState.taskStateSeed(task, effective);
      assert.equal(JSON.stringify(taskStateSeed(task)), JSON.stringify(expectedSeed), `seed: ${label}`);
      assert.equal(JSON.stringify(taskStatePayload(task)),
        JSON.stringify(frozenTaskState.taskStatePayload(task, effective)), `payload: ${label}`);
    });
  }
});

test('the live Aux reading is a number in production and reaches the page as one', () => {
  // `health.sinceAt` is Date.now() (src/routes/aux-goal.js). The first kernel
  // accepted only a string and would have sent null for every real reading.
  const since = Date.now();
  const frame = withFacts({ taskShortCode: 'WX12', auxUnhealthy: true, auxUnhealthySince: since },
    () => taskStateSeed({ goal: 'ship it' }));
  assert.equal(frame.auxUnhealthy, true);
  assert.equal(frame.auxUnhealthySince, since);
  assert.equal(typeof frame.auxUnhealthySince, 'number');
  const healthy = withFacts({ taskShortCode: 'WX12', auxUnhealthy: false, auxUnhealthySince: since },
    () => taskStateSeed({ goal: 'ship it' }));
  assert.deepEqual([healthy.auxUnhealthy, healthy.auxUnhealthySince], [false, null]);
});

test('the seed resolves the short code from the task id and from nothing else', () => {
  shortCodeCalls.length = 0;
  withFacts({ taskShortCode: 'AB12', auxUnhealthy: false, auxUnhealthySince: null }, () => {
    assert.equal(taskStateSeed({ phase: 'idle', taskId: 'idle-task' }), null);
    assert.equal(taskStateSeed({ goal: 'g', taskId: 'task-123' }).taskShortCode, 'AB12');
    // A record with no task id still asks, with `undefined`, exactly as the
    // retired payload did (`taskShortCode(next.taskId)`).
    assert.equal(taskStateSeed({ goal: 'g' }).taskShortCode, 'AB12');
  });
  assert.deepEqual(shortCodeCalls, ['task-123', undefined]);
});

// The legacy connect gate serializes before reading either live fact. Both
// producers return the original error envelope even when toJSON changes it.
test('task state keeps the order of live reads, the error identity and serialization failures', () => {
  for (const build of [taskStateSeed, taskStatePayload]) {
    const events = [];
    shortCodeCalls.length = 0;
    const error = { code: 'persisted' };
    const task = {
      get taskId() { events.push('id'); return 't'; },
      get apiError() { events.push('error'); return error; },
      toJSON() { events.push('json'); return { apiError: { code: 'serialized' } }; },
    };
    installAuxHealthProvider(() => { events.push('health'); return null; });
    try {
      assert.equal(build(task).apiError, error);
      const gate = build === taskStateSeed ? ['json'] : [];
      assert.deepEqual(events, [...gate, 'id', 'health', 'json', 'error']);
      assert.deepEqual(shortCodeCalls, ['t']);
      events.length = shortCodeCalls.length = 0;
      const cyclic = {};
      cyclic.self = cyclic;
      assert.throws(() => build(cyclic), TypeError);
      assert.deepEqual(events, build === taskStateSeed ? [] : ['health']);
      assert.deepEqual(shortCodeCalls, build === taskStateSeed ? [] : [undefined]);
    } finally {
      installAuxHealthProvider(null);
    }
  }
});

// ── the connect plan ────────────────────────────────────────────────────────

test('the connect plan export the turn engine calls reproduces the frozen plan', () => {
  const native = getNative();
  assert.equal(typeof native.chatConnectReplayPlan, 'function', 'the turn engine calls this export by name');
  const names = { chatHistory: 'chat_history', taskStateSeed: 'task_state_seed',
    clearBuffer: 'clear_buffer', replayBurst: 'replay_burst' };
  assert.equal(connectCorpus.cases.length, 144, 'the corpus lost cases');
  for (const [index, entry] of connectCorpus.cases.entries()) {
    const plan = JSON.parse(native.chatConnectReplayPlan(JSON.stringify(entry.facts)));
    const steps = plan.steps.map(step => (step.op === 'replayBurst'
      ? { type: names[step.op], frames: step.frames } : { type: names[step.op] }));
    assert.deepEqual(steps, entry.steps, `case ${index}: ${JSON.stringify(entry.facts)}`);
    assert.equal(plan.bufferAfter, entry.bufferAfter, `case ${index}: bufferAfter`);
    // The seed is only resolved when the plan can use it, so it is asked for
    // exactly when a history frame goes out.
    const consulted = entry.steps.some(step => step.type === 'chat_history');
    assert.equal(plan.needsTaskStateSeed, consulted, `case ${index}: needs`);
    const { hasTaskStateSeed, ...connectFacts } = entry.facts;
    const pending = JSON.parse(native.chatConnectReplayPlan(JSON.stringify(connectFacts)));
    if (consulted) {
      assert.deepEqual(pending.steps.slice(0, 2), [{ op: 'chatHistory' }, { op: 'taskStateSeed' }]);
    } else {
      assert.ok(pending.steps.every(step => step.op !== 'taskStateSeed'));
    }
  }
});

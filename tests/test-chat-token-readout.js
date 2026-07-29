'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readout = require('../public/chat-token-readout.js');
const historyStore = require('../public/chat-history-store.js');

const WINDOW = 1_000_000;
const publicDir = path.join(__dirname, '..', 'public');
const readPublic = name => fs.readFileSync(path.join(publicDir, name), 'utf8');

// One Claude request: cache reads are what actually sat in the window.
const claudeTurn = {
  input_tokens: 12_000,
  cache_read_input_tokens: 180_000,
  cache_creation_input_tokens: 4_000,
  output_tokens: 900,
};

// Verbatim from chat_history/4-codex-chat-01.json — the turn that rendered as
// 「本轮 14829.9k/1000k (100.0%)」 while the session's real context was ~0.5M.
const codexTurn = {
  input_tokens: 370_584,
  cached_input_tokens: 14_401_280,
  cache_write_input_tokens: 0,
  output_tokens: 58_022,
  reasoning_output_tokens: 18_868,
  cache_read_input_tokens: 14_401_280,
  cache_creation_input_tokens: 0,
  total_tokens: 14_829_886,
};

test('a single-request block keeps every bucket it reported', () => {
  const ctx = readout.turnContext(claudeTurn, WINDOW);
  assert.equal(ctx.aggregated, false);
  assert.equal(ctx.input, 196_000);
  assert.equal(ctx.output, 900);
  assert.equal(ctx.total, 196_900);
  assert.equal(ctx.billed, 196_900);
  assert.equal(ctx.withinWindow, true);
});

test('a turn that sums several requests drops the repeated cache buckets', () => {
  const ctx = readout.turnContext(codexTurn, WINDOW);
  assert.equal(ctx.aggregated, true, '14.8M cannot have come from one request');
  assert.equal(ctx.input, 370_584, 'fresh input is counted once per request');
  assert.equal(ctx.output, 58_022);
  assert.equal(ctx.total, 428_606);
  assert.equal(ctx.billed, 14_829_886, 'the billed figure is still available');
  assert.equal(ctx.withinWindow, true);
  // The bug this replaces: 1482.9% clamped to a flat, alarming 100%.
  const pct = (ctx.total / WINDOW) * 100;
  assert.ok(pct > 42 && pct < 43, `expected ~42.9%, got ${pct}`);
});

test('an opencode-shaped block is left alone even though it names cached input', () => {
  // Same key set the codex path writes, but the whole turn fits in the window,
  // so nothing proves it is an aggregate and the readout must not change.
  const ctx = readout.turnContext({
    input_tokens: 20_454,
    cached_input_tokens: 2_048,
    cache_read_input_tokens: 2_048,
    cache_creation_input_tokens: 0,
    output_tokens: 35,
    reasoning_output_tokens: 0,
    total_tokens: 22_537,
  }, WINDOW);
  assert.equal(ctx.aggregated, false);
  assert.equal(ctx.total, 22_537);
});

test('an aggregate still above the window refuses to fake a percentage', () => {
  const ctx = readout.turnContext({
    input_tokens: 3_000_000,
    cache_read_input_tokens: 40_000_000,
    output_tokens: 90_000,
  }, WINDOW);
  assert.equal(ctx.aggregated, true);
  assert.equal(ctx.total, 3_090_000);
  assert.equal(ctx.withinWindow, false);
});

test('an unknown context window never reclassifies a block as aggregated', () => {
  const ctx = readout.turnContext(codexTurn, 0);
  assert.equal(ctx.aggregated, false);
  assert.equal(ctx.total, 14_829_886);
});

test('a missing or malformed usage block reads as zero, not NaN', () => {
  for (const value of [null, undefined, 'nope', 42]) {
    const ctx = readout.turnContext(value, WINDOW);
    assert.equal(ctx.total, 0);
    assert.equal(ctx.aggregated, false);
  }
  const negative = readout.turnContext({ input_tokens: -5, output_tokens: 'x' }, WINDOW);
  assert.equal(negative.total, 0);
});

test('the history plan hands the host the raw block, not a pre-summed number', () => {
  const plan = historyStore.initialPlan({
    messages: [
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', content: 'done', usage: codexTurn },
    ],
  });
  assert.deepEqual(plan.lastTurnUsage, codexTurn);
  // The unfiltered sum stays on the plan for anything that still wants it.
  assert.equal(plan.usedTokens, 14_829_886);
  assert.equal(readout.turnContext(plan.lastTurnUsage, WINDOW).total, 428_606);
});

test('a streaming tail with no usage clears the readout instead of inheriting', () => {
  const plan = historyStore.initialPlan({
    messages: [
      { id: 'a1', role: 'assistant', content: 'old', usage: claudeTurn },
      { id: 'a2', role: 'assistant', content: '', streaming: true },
    ],
  });
  assert.equal(plan.lastTurnUsage, null);
  assert.equal(readout.turnContext(plan.lastTurnUsage, WINDOW).total, 0);
});

test('the chat host loads the readout before the store that feeds it', () => {
  const html = readPublic('chat.html');
  const readoutTag = html.indexOf('<script src="chat-token-readout.js"></script>');
  const storeTag = html.indexOf('<script src="chat-history-store.js"></script>');
  const chatTag = html.indexOf('<script src="chat.js"></script>');
  assert.ok(readoutTag > 0, 'chat.html must ship chat-token-readout.js');
  assert.ok(readoutTag < storeTag && storeTag < chatTag, 'readout must load first');
});

test('the context bar renders through the readout and labels the cumulative line', () => {
  const chat = readPublic('chat.js');
  assert.ok(
    chat.includes('window.MultiCCChatTokenReadout?.turnContext(_turnUsage, _contextWindow)'),
    'the bar must not re-sum usage buckets on its own',
  );
  assert.ok(chat.includes('本轮 in ${k(ctx.input)}k / out ${k(ctx.output)}k'),
    'an aggregated turn shows input and output separately');
  assert.ok(chat.includes('会话累计 ${fmt(total)} tokens'), 'the cumulative line stays labelled 累计');
  assert.ok(/title="[^"]*不是当前上下文占用[^"]*"[^>]*>会话累计/.test(chat),
    'the cumulative line explains it is not context occupancy');
});

'use strict';

// Pins the JS-value differences that the JSON FFI used to erase. Each block
// corresponds to one migrated kernel and fails if the lossless bridge ever
// falls back to JSON.stringify/JSON.parse (or to a lossy UTF-8 string):
//   * turn-request: NaN/Infinity turn counts, -0, explicit undefined;
//   * usage-observed: nested non-finite token counts, undefined properties,
//     Date.parse natural-language timestamps, stableStringify identity;
//   * cli-switch: a surrogate pair split by the 1800-unit truncation;
//   * events: lone surrogates in redact/clip;
//   * selection: lone surrogates in clipTokens/selectContext.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { normalizeTurnRequest } = require('../src/chat/turn-request');
const {
  createUsageObserved, stableUsageEventId,
} = require('../src/usage-observed');
const {
  messageText, buildHandoffCheckpoint, renderHandoffPrompt,
} = require('../src/cli-switch');
const { redactText, clipText } = require('../src/events/envelope');
const { clipTokens, selectContext } = require('../src/context/selection');

const LONE = '\ud83d';

test('turn-request: non-finite turn counts are rejected, not folded to 0', () => {
  for (const turnCount of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => normalizeTurnRequest({ sessionId: 's', text: 'x', turnCount }),
      error => error.code === 'invalid_request'
        && error.message === 'turnCount must be a non-negative integer',
      `turnCount ${turnCount}`,
    );
  }
});

test('turn-request: -0 survives as a number, and undefined keeps old semantics', () => {
  const negativeZero = normalizeTurnRequest({
    sessionId: 's', text: 'x', goalLimits: { maxRounds: -0 },
  });
  assert.ok(Object.is(negativeZero.goalLimits.maxRounds, -0));

  // The bridge passes every projected field; missing ones are `undefined`.
  const implicit = normalizeTurnRequest({
    sessionId: 's', text: 'x', turnCount: undefined, cli: undefined,
  });
  assert.equal(implicit.execution.historyIntent, 'first');
  assert.throws(
    () => normalizeTurnRequest({ sessionId: 's', text: undefined }),
    error => error.code === 'empty_text',
  );
});

const USAGE_BASE = Object.freeze({
  occurredAt: 1700000000000,
  sessionId: 's',
  providerId: 'p',
  roleKind: 'main',
  source: 'exact',
  coverage: 'observed',
  status: 'success',
  protocol: 'p',
  tokens: { input: 1, output: 2 },
  sourceEventId: 'upstream-1',
});

test('usage-observed: nested non-finite counts are rejected, not read as 0', () => {
  assert.throws(
    () => createUsageObserved({ ...USAGE_BASE, tokens: { input: NaN, output: 2 } }),
    error => error.message === 'tokens.input must be a non-negative number',
  );
  assert.throws(
    () => createUsageObserved({ ...USAGE_BASE, tokens: { input: 1, output: Infinity } }),
    error => error.message === 'tokens.output must be a non-negative number',
  );
  assert.throws(
    () => createUsageObserved({ ...USAGE_BASE, latencyMs: NaN }),
    error => error.message === 'latencyMs must be a non-negative number',
  );
});

test('usage-observed: Date.parse natural-language timestamps stay in JS', () => {
  const natural = 'January 2, 2026 03:04:05 UTC';
  const parsed = Date.parse(natural);
  assert.ok(Number.isFinite(parsed));
  const event = createUsageObserved({ ...USAGE_BASE, occurredAt: natural });
  assert.equal(event.occurredAt, parsed);
  // Same instant, same stable event id: the timestamp is inside the identity.
  assert.equal(
    event.eventId,
    createUsageObserved({ ...USAGE_BASE, occurredAt: parsed }).eventId,
  );
});

test('usage-observed: undefined properties keep their JS meaning', () => {
  const event = createUsageObserved({
    ...USAGE_BASE,
    providerName: undefined,
    tokens: { input: undefined, output: 2 },
  });
  assert.equal(event.providerName, '');
  assert.equal(event.tokens.input, 0);
  assert.equal(event.tokens.total, 2);
});

const stableStringify = value => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const referenceEventId = identity => `uo_${crypto.createHash('sha256')
  .update(stableStringify(identity)).digest('hex').slice(0, 32)}`;

test('usage-observed: stableStringify keeps undefined, NaN, Infinity and -0', () => {
  const identity = {
    z: -0,
    n: NaN,
    i: Infinity,
    m: -Infinity,
    u: undefined,
    list: [1, undefined, NaN],
    nested: { b: -Infinity },
  };
  assert.equal(stableUsageEventId(identity), referenceEventId(identity));
});

test('cli-switch: a split surrogate pair survives the 1800-unit truncation', () => {
  assert.equal(messageText({ content: `a${LONE}b` }), `a${LONE}b`);

  const history = [{ role: 'user', content: `${'a'.repeat(1799)}😀b` }];
  const built = buildHandoffCheckpoint({ history, now: 0 });
  const text = built.transcript[0].text;
  assert.equal(text[1799], LONE);
  assert.equal(text.length, 1800 + '\n...(message truncated)'.length);

  const prompt = renderHandoffPrompt({
    id: 'h',
    checkpoint: { transcript: [{ role: 'user', text: LONE, ts: null }] },
  });
  assert.ok(prompt.includes('{"role":"user","text":"\\ud83d","ts":null}'));
});

test('events: lone surrogates survive redactText and clipText', () => {
  assert.equal(redactText(`a${LONE}b`), `a${LONE}b`);
  const clipped = clipText(`${'a'.repeat(1799)}😀b`, 1800);
  assert.equal(clipped.length, 1801);
  assert.equal(clipped[1799], LONE);
  assert.equal(clipped[1800], '…');
});

test('selection: lone surrogates survive clipTokens and selectContext', () => {
  assert.equal(clipTokens(`x${LONE}y`, 8000), `x${LONE}y`);

  const selected = selectContext([{ id: 'a', excerpt: `x${LONE}y`, priority: 1 }]);
  assert.equal(selected.sources.length, 1);
  assert.equal(selected.sources[0].excerpt, `x${LONE}y`);
  assert.ok(selected.text.includes(`x${LONE}y`));
});

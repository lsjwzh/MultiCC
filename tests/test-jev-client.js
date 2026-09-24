'use strict';

// Jev client: wire contract, tolerant parsing, conservative escalation policy and
// the fail-open paths that keep a dead gateway from ever producing a verdict.
// The live endpoint needs a Vercel account with a card on file, so every case
// here drives a stub fetch; the shapes asserted are the ones the AI Gateway
// documents, and the readers are deliberately tolerant of the variants the
// Gateway / AI SDK / TypeSafe-direct backends disagree about.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildQuestions,
  createJevClient,
  escalationPolicy,
  normalizeTiers,
  bandForTier,
  TIER_BANDS,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
} = require('../src/providers/jev-client');

const TIERS = Object.freeze([
  Object.freeze({ key: 'weak', label: 'Weak' }),
  Object.freeze({ key: 'strong', label: 'Strong' }),
]);
const THREE_TIERS = normalizeTiers(['weak', 'mid', 'strong']);

function answerPayload({ choice, probabilities, score, scoreProbabilities, confidence } = {}) {
  const payload = {
    answers: {
      tier: { type: 'choice', choice, probabilities },
      complexity: { type: 'score', score, probabilities: scoreProbabilities },
    },
  };
  if (confidence !== undefined) {
    payload.providerMetadata = { typesafe: { confidence: { tier: confidence, complexity: confidence } } };
  }
  return payload;
}

function stubFetch({ payload, status = 200, body, reject, onCall } = {}) {
  return async (url, init) => {
    if (onCall) onCall(url, init);
    if (reject) throw reject;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body !== undefined ? body : JSON.stringify(payload)),
    };
  };
}

function client(overrides = {}) {
  const logs = [];
  const instance = createJevClient({
    fetchImpl: stubFetch(overrides),
    resolveApiKey: () => 'vck_test_key_value',
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    now: () => 1_000,
    ...overrides.client,
  });
  return { instance, logs };
}

test('questions describe the work, and choice and score share one axis', () => {
  const questions = buildQuestions(THREE_TIERS);
  assert.deepEqual(Object.keys(questions.tier.criteria), ['weak', 'mid', 'strong']);
  assert.equal(questions.complexity.type, 'score');
  assert.equal(questions.complexity.criteria.length, 3);
  // The score's criteria are the choice's, one entry per tier, so Jev's `score`
  // is an index into the ladder rather than a length-dependent fraction.
  assert.deepEqual(questions.complexity.criteria, Object.values(questions.tier.criteria));
  // Every criterion names work, not a position in the pool: a self-referential
  // rubric ("the cheapest tier") measured 0.97 for the weak tier on a medium task.
  for (const text of Object.values(questions.tier.criteria)) {
    assert.doesNotMatch(text, /tier in this pool/i);
    assert.ok(text.length > 60, text);
  }
  // The gateway rejects `noul` outright, and a `boolean` question measured as
  // noise (0.67 "needs planning" for a one-line typo), so only two types ship.
  assert.deepEqual(
    Object.values(questions).map(question => question.type).sort(),
    ['choice', 'score'],
  );
});

test('the four capability bands are spread over the ladder, weakest first', () => {
  const bandOf = count => buildQuestions(normalizeTiers(
    Array.from({ length: count }, (_, index) => `t${index}`),
  )).complexity.criteria;
  assert.deepEqual(bandOf(2), [TIER_BANDS[0], TIER_BANDS[3]]);
  assert.deepEqual(bandOf(3), [TIER_BANDS[0], TIER_BANDS[2], TIER_BANDS[3]]);
  assert.deepEqual(bandOf(4), [...TIER_BANDS]);
  // More tiers than bands never unmaps the ends of the ladder.
  assert.equal(bandOf(6)[0], TIER_BANDS[0]);
  assert.equal(bandOf(6)[5], TIER_BANDS[3]);
  assert.equal(bandForTier(0, 1), 0);
});

test('classify sends the documented evaluate request and returns the chosen tier', async () => {
  let seen = null;
  const { instance } = client({
    payload: answerPayload({
      choice: 'weak', probabilities: { weak: 0.9, strong: 0.1 },
      score: 0.2, confidence: 0.85,
    }),
    onCall: (url, init) => { seen = { url, init }; },
  });
  const verdict = await instance.classify({ text: '把 README 里的 typo 改一下', tiers: THREE_TIERS });
  assert.equal(seen.url, DEFAULT_ENDPOINT);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer vck_test_key_value');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.state.request, '把 README 里的 typo 改一下');
  assert.deepEqual(Object.keys(body.questions), ['tier', 'complexity']);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tier, 'weak');
  assert.equal(verdict.reasonCode, 'jev_choice');
  assert.equal(verdict.escalated, false);
  assert.equal(verdict.confidence, 0.85);
});

test('escalation only ever moves up the ladder', () => {
  const policy = (answers, payload, tiers = THREE_TIERS) => escalationPolicy(
    { tiers, escalation: { minConfidence: 0.5, minTierProbability: 0.5 } },
    answers,
    { answers, ...payload },
  );
  // A confident low answer stays where Jev put it.
  assert.equal(policy(
    { tier: { choice: 'weak', probabilities: { weak: 0.9 } }, complexity: { score: 0 } },
    { providerMetadata: { typesafe: { confidence: { tier: 0.9 } } } },
  ).tier, 'weak');
  // Complexity above the choice raises it one step. The live gateway returns the
  // score as an index over the criteria array, so it rounds instead of rescaling:
  // 1.4 is "between the middle tier and the top one", never "1.4 of 3".
  const complex = policy(
    { tier: { choice: 'weak', probabilities: { weak: 0.8 } }, complexity: { score: 1.4 } },
    { providerMetadata: { typesafe: { confidence: { tier: 0.9 } } } },
  );
  assert.equal(complex.tier, 'mid');
  assert.equal(complex.reasonCode, 'jev_complexity_escalation');
  assert.equal(complex.complexityIndex, 1);
  // Low confidence means "strongest tier in the pool".
  const unsure = policy(
    { tier: { choice: 'weak', probabilities: { weak: 0.35 } }, complexity: { score: 0 } },
    { providerMetadata: { typesafe: { confidence: { tier: 0.2 } } } },
  );
  assert.equal(unsure.tier, 'strong');
  assert.equal(unsure.reasonCode, 'jev_low_confidence');
  // A missing confidence field is not evidence of a confident answer.
  assert.equal(policy(
    { tier: { choice: 'weak', probabilities: { weak: 0.9 } }, complexity: { score: 0 } },
    {},
  ).tier, 'strong');
  // A weak margin steps exactly one tier, even at the top of a flat distribution.
  assert.equal(policy(
    { tier: { choice: 'weak', probabilities: { weak: 0.45 } }, complexity: { score: 0 } },
    { providerMetadata: { typesafe: { confidence: { tier: 0.9 } } } },
  ).tier, 'mid');
});

test('any signal without a usable answer is an unknown, not a weak verdict', () => {
  const result = escalationPolicy(
    { tiers: THREE_TIERS, escalation: {} },
    { tier: {}, complexity: {} },
    { answers: {} },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'jev_unreadable_answers');
});

test('answers are read from the envelopes the three backends disagree about', async () => {
  const { instance } = client({
    payload: {
      result: {
        answers: {
          tier: { type: 'choice', value: 'strong', probabilities: { weak: 0.2, strong: 0.8 } },
          complexity: { type: 'score', value: 2 },
        },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.7 } } },
    },
  });
  const verdict = await instance.classify({ text: '重构整个 provider 层', tiers: TIERS });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tier, 'strong');
  assert.equal(verdict.confidence, 0.7);
});

test('a missing vault entry fails closed without touching the network', async () => {
  let called = 0;
  const instance = createJevClient({
    fetchImpl: stubFetch({ payload: answerPayload({ choice: 'weak' }), onCall: () => { called += 1; } }),
    resolveApiKey: () => null,
  });
  const verdict = await instance.classify({ text: 'hi', tiers: TIERS, apiKeyName: 'vercel-api-key' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'jev_key_missing');
  assert.equal(called, 0);
});

test('a rejected request reports its status and Vercel detail, never the key', async () => {
  const logs = [];
  const instance = createJevClient({
    fetchImpl: stubFetch({
      status: 403,
      body: JSON.stringify({
        error: {
          message: 'AI Gateway requires a valid credit card on file to service requests.',
          type: 'customer_verification_required',
        },
      }),
    }),
    resolveApiKey: () => 'vck_test_key_value',
    logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
  });
  const verdict = await instance.classify({ text: 'hi', tiers: TIERS });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'jev_http_403');
  assert.equal(verdict.status, 403);
  assert.match(verdict.detail, /credit card/);
  // The key is a vault value: it must never reach a log line, an event or an error.
  assert.doesNotMatch(JSON.stringify(logs), /vck_test_key_value/);
  assert.doesNotMatch(JSON.stringify(verdict), /vck_test_key_value/);
});

test('transport failures degrade to a code instead of throwing', async () => {
  const network = createJevClient({
    fetchImpl: stubFetch({ reject: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) }),
    resolveApiKey: () => 'k',
  });
  assert.equal((await network.classify({ text: 'hi', tiers: TIERS })).code, 'jev_network');
  const aborted = createJevClient({
    fetchImpl: stubFetch({ reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) }),
    resolveApiKey: () => 'k',
  });
  assert.equal((await aborted.classify({ text: 'hi', tiers: TIERS })).code, 'jev_timeout');
  for (const body of ['not json', JSON.stringify({ ok: true }), '']) {
    const broken = createJevClient({ fetchImpl: stubFetch({ body }), resolveApiKey: () => 'k' });
    const verdict = await broken.classify({ text: 'hi', tiers: TIERS });
    assert.equal(verdict.ok, false);
    assert.ok(['jev_bad_payload', 'jev_unreadable_answers'].includes(verdict.code), verdict.code);
  }
});

test('an empty tier ladder is refused before any request is made', async () => {
  let called = 0;
  const instance = createJevClient({
    fetchImpl: stubFetch({ payload: {}, onCall: () => { called += 1; } }),
    resolveApiKey: () => 'k',
  });
  assert.equal((await instance.classify({ text: 'hi', tiers: [] })).code, 'jev_no_tiers');
  assert.equal(called, 0);
});

// A pool configures timeoutMs / model / escalation and those are validated as
// meaningful, so an evaluation that ignored them would route by defaults the user
// never chose — the pool would believe it was tuned while nothing moved.
test('a pool\'s own timeout, model and escalation reach the wire', async () => {
  let body = null;
  let signal = null;
  const { instance } = client({
    payload: answerPayload({
      choice: 'weak', probabilities: { weak: 0.55, strong: 0.45 },
      score: 0, confidence: 0.9,
    }),
    onCall: (_url, init) => { body = JSON.parse(init.body); signal = init.signal; },
  });
  // chosen probability 0.55 clears the default 0.5 but not this pool's 0.7, so an
  // ignored override would leave the turn on the weak tier.
  const verdict = await instance.classify({
    text: '改个 typo', tiers: TIERS,
    model: 'typesafe-ai/jev-preview',
    timeoutMs: 9_000,
    escalation: { minTierProbability: 0.7 },
  });
  assert.equal(body.model, 'typesafe-ai/jev-preview');
  assert.equal(verdict.tier, 'strong');
  assert.equal(verdict.reasonCode, 'jev_low_tier_probability');
  assert.ok(signal, 'the overridden timeout still arms an abort');
});

test('an unreadable override degrades to this client\'s own value, never throws', async () => {
  let body = null;
  const { instance } = client({
    payload: answerPayload({ choice: 'weak', probabilities: { weak: 0.9 }, score: 0, confidence: 0.9 }),
    onCall: (_url, init) => { body = JSON.parse(init.body); },
  });
  const verdict = await instance.classify({
    text: 'hi', tiers: TIERS,
    model: '   ',
    timeoutMs: 'not-a-number',
    escalation: null,
  });
  // A blank model and a nonsense timeout keep this client's own values, and a
  // null escalation block leaves the construction-time policy untouched.
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tier, 'weak');
  assert.equal(verdict.reasonCode, 'jev_choice');
});

test('an out-of-range ratio is clamped exactly as the construction-time reader does', async () => {
  const { instance } = client({
    payload: answerPayload({ choice: 'weak', probabilities: { weak: 0.9 }, score: 0, confidence: 0.9 }),
  });
  // The config layer rejects out-of-range ratios outright (validateRouting); a
  // direct caller gets the same clamp the client already applies to
  // options.escalation, so the two readers cannot disagree about one value.
  const verdict = await instance.classify({
    text: 'hi', tiers: TIERS,
    escalation: { minConfidence: null, minTierProbability: 2 },
  });
  assert.equal(verdict.tier, 'strong');
  assert.equal(verdict.reasonCode, 'jev_low_tier_probability');
});

test('state carries the request and only scalar host hints', async () => {
  let body = null;
  const { instance } = client({
    payload: answerPayload({ choice: 'weak', probabilities: { weak: 0.9 }, score: 0, confidence: 0.9 }),
    onCall: (_url, init) => { body = JSON.parse(init.body); },
  });
  await instance.classify({
    text: '继续',
    tiers: TIERS,
    context: { cli: 'claude', taskBound: true, nested: { secret: 'x' }, big: 'y'.repeat(900) },
  });
  assert.equal(body.state.request, '继续');
  assert.equal(body.state.cli, 'claude');
  assert.equal(body.state.taskBound, true);
  assert.equal(body.state.nested, undefined);
  assert.equal(body.state.big.length, 500);
});

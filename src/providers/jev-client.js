'use strict';

// ── Jev（TypeSafe 决策模型）· 评估接口 ───────────────────────────────────────
//
// Jev is not a chat model: it accepts one `state` and a set of typed `questions`
// and answers them in a single parallel-batched call (choice / score). It never
// generates prose, so it cannot be reached through the OpenAI-compatible chat
// endpoints — the evaluation API is its own route.
//
// Three hosted gateways resell that same evaluation call (see JEV_GATEWAYS), and
// a pool may also point at its own deployment, so only the endpoint, the model
// id and the vault entry holding the key ever differ:
//
//   POST <endpoint>                                 (JEV_GATEWAYS[gateway].endpoint)
//   Authorization: Bearer <gateway key>             (vault entry <apiKeyName>)
//   { model, state, questions }                     (Vercel ignores `model`)
//
// This module owns the wire contract and the *escalation policy*: which tier the
// pool should use for one user request. It deliberately owns no session state,
// no vault access and no transport fallback — callers inject the key resolver
// and the window in which the verdict is consumed.
//
// The policy is conservative on purpose (see escalationPolicy): every signal can
// only move the answer *up* the tier ladder, and anything uncertain resolves to
// the strongest tier. Silently handing a hard request to a weak model is the one
// failure this feature must not have; over-provisioning a trivial one is the
// cheap, self-correcting mistake.

const DEFAULT_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const DEFAULT_MODEL = 'typesafe-ai/jev';

// The same `{ model, state, questions }` + Bearer call, sold by three gateways.
// Each one only has its own host, its own model id and its own vault entry, so
// this table is the single source every layer reads: the pool config resolves a
// gateway name through it, the runtime hands the endpoint to classify(), and the
// editor's "test" route uses the same names.
const JEV_GATEWAYS = Object.freeze({
  vercel: Object.freeze({
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    apiKeyName: 'vercel-api-key',
  }),
  openrouter: Object.freeze({
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    // OpenRouter namespaces community models with `~`; the id is opaque here.
    model: '~typesafe/jev-latest',
    apiKeyName: 'openrouter-api-key',
  }),
  typesafe: Object.freeze({
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKeyName: 'typesafe-api-key',
  }),
});
const GATEWAY_NAMES = Object.freeze(Object.keys(JEV_GATEWAYS));
const DEFAULT_GATEWAY = 'vercel';
// A pool may also point at its own deployment ("自定义"). Its key is read from a
// `jev-`-prefixed vault entry only: the endpoint is user-supplied, so the entry
// name must not be able to name an unrelated secret (a GitHub token, say).
const CUSTOM_GATEWAY = 'custom';
const CUSTOM_API_KEY_NAME = 'jev-custom-api-key';
const CUSTOM_MODEL = 'jev-latest';
const MAX_ENDPOINT_CHARS = 300;
const DEFAULT_TIMEOUT_MS = 2_500;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;
const MAX_TIERS = 6;
const MAX_STATE_CHARS = 8_000;
const MAX_DETAIL_CHARS = 200;
const TIER_KEY_RE = /^[A-Za-z0-9_-]{1,24}$/;

// Thresholds are starting points, not calibrated defaults: they are exposed as
// config so a pool can be tuned against its own traffic without a code change.
const DEFAULT_ESCALATION = Object.freeze({
  // Below this the answer distribution is too flat to trust — go strongest.
  minConfidence: 0.5,
  // The chosen option must beat this or we step one tier up.
  minTierProbability: 0.5,
});

// Capability bands, weakest first. A tier is described by the *work* it may be
// trusted with rather than by where it sits in its pool. A self-referential
// rubric ("the cheapest tier") reads as a coin flip to the model: measured live,
// a medium task scored 0.97 for the weak tier. Task-shaped criteria rate the same
// sample tasks correctly and repeatably.
const TIER_BANDS = Object.freeze([
  'Mechanical change whose exact edit is already known: a typo, a rename, a version bump, a one-line fix, or re-running a known command. No design decisions and no investigation.',
  'Small, well-understood change: one or two files, the approach already clear from the request. Light reasoning, but nothing has to be designed.',
  'Multi-file change that needs real reasoning: a new small feature, a behaviour fix with an unknown cause, or wiring across modules. The approach has to be chosen first.',
  'Architecture-level work: refactors across layers, provider or protocol changes, concurrency or migration work, or a request whose scope must be designed before any code is written.',
]);

// A missing field must stay missing. `Number(null)` and `Number('')` are both 0,
// which would silently read an absent score as "trivial" — the one direction this
// policy must never fail in.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return Math.min(1, Math.max(0, number));
}

// Tiers are supplied weakest-first by the pool config; index order IS the
// capability ladder, so every policy step is expressed as an index.
function normalizeTiers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const tiers = [];
  const seen = new Set();
  for (const item of list) {
    const key = String(item && typeof item === 'object' ? item.key : item || '').trim();
    if (!TIER_KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    tiers.push(Object.freeze({
      key,
      label: String(item && typeof item === 'object' && item.label ? item.label : key).slice(0, 48),
    }));
    if (tiers.length >= MAX_TIERS) break;
  }
  return Object.freeze(tiers);
}

function tierIndex(tiers, key) {
  const clean = String(key || '').trim().toLowerCase();
  if (!clean) return -1;
  for (let index = 0; index < tiers.length; index += 1) {
    if (tiers[index].key.toLowerCase() === clean) return index;
  }
  return -1;
}

// Spread the ladder over the bands so every pool, whatever its length, is asked
// about the same four kinds of work.
function bandForTier(index, count) {
  const top = TIER_BANDS.length - 1;
  if (count <= 1) return 0;
  return Math.min(top, Math.round((index / (count - 1)) * top));
}

// One `choice` question decides the tier; one `score` question rates the same
// axis a second time, so a request the choice under-reads can still escalate.
// The score's criteria are the same bands, one entry per tier, which makes Jev's
// `score` the *expected band index* over that array — measured 0 / 0.71 / 1 for a
// two-tier ladder and 0 / 1 / 2 for a three-tier one. That is why the policy
// rounds it instead of rescaling by the ladder length.
//
// A `boolean` question was tried here ("does this need a plan first?") and
// removed: live it answered 0.67 for a one-line typo, so an escalation on that
// signal fired on exactly the requests this feature exists to send to a cheap
// model. The choice criteria already carry the same distinction.
function buildQuestions(tiers) {
  const criteria = {};
  const levels = [];
  tiers.forEach((tier, index) => {
    const band = TIER_BANDS[bandForTier(index, tiers.length)];
    criteria[tier.key] = band;
    levels.push(band);
  });
  return {
    tier: {
      type: 'choice',
      instructions: 'Pick the cheapest model tier that can still carry out this request well. Judge it by the work the request actually requires, not by how important it sounds or how long the message is.',
      criteria,
    },
    complexity: {
      type: 'score',
      instructions: 'Rate how much engineering work this request really requires, from a mechanical edit to architecture-level design.',
      criteria: levels,
    },
  };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

// Tolerant readers: the gateway, the AI SDK and the TypeSafe-direct backend do
// not agree on a single envelope, and probabilities/confidence are optional per
// provider. Every reader degrades to null instead of throwing, and a missing
// distribution is treated as low confidence by the policy rather than as zero.
function readAnswers(payload) {
  const candidates = [
    payload && payload.answers,
    payload && payload.result && payload.result.answers,
    payload && payload.output && payload.output.answers,
    payload && payload.data && payload.data.answers,
  ];
  for (const value of candidates) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

// Three envelopes carry the same number. An answer-scoped
// `answers.<id>.confidence` describes that one answer, so it wins; the two
// response-wide maps (`providerMetadata.typesafe.confidence`, then the plain
// `confidence` map) are the older Vercel shapes and stay as fallbacks. Reading
// only the maps — as this did before OpenRouter/TypeSafe were supported — made
// every verdict look confidence-less, and a missing confidence escalates to the
// pool's strongest tier, so a working gateway routed every request to the most
// expensive line.
function readConfidence(payload, questionId) {
  const nested = payload && payload.providerMetadata && payload.providerMetadata.typesafe
    && payload.providerMetadata.typesafe.confidence;
  const direct = payload && payload.confidence;
  const answers = readAnswers(payload);
  const scoped = answers && answers[questionId];
  return clamp01(firstDefined(
    scoped && typeof scoped === 'object' ? scoped.confidence : null,
    nested && typeof nested === 'object' ? nested[questionId] : null,
    direct && typeof direct === 'object' ? direct[questionId] : null,
  ));
}

function readChoice(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const choice = firstDefined(answer.choice, answer.value, answer.answer, answer.label);
  if (choice == null || typeof choice === 'object') return null;
  return String(choice).trim();
}

function readProbabilityMap(answer) {
  const raw = firstDefined(answer && answer.probabilities, answer && answer.probability);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const map = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const probability = clamp01(value);
    if (probability != null) map.set(String(key).toLowerCase(), probability);
  }
  return map.size ? map : null;
}

function readScore(answer) {
  if (!answer || typeof answer !== 'object') return null;
  return numberOrNull(firstDefined(answer.score, answer.value));
}

// Conservative union of every signal. Each step can only raise the answer:
//   choice/index  →  score/index  →  low confidence  →  weak margin.
function escalationPolicy({ tiers, escalation }, answers, payload) {
  if (!tiers.length) return Object.freeze({ ok: false, code: 'jev_no_tiers' });
  const top = tiers.length - 1;
  const chosen = readChoice(answers.tier);
  const chosenIndex = tierIndex(tiers, chosen);
  const tierProbabilities = chosenIndex >= 0 ? readProbabilityMap(answers.tier) : null;
  const chosenProbability = tierProbabilities
    ? (tierProbabilities.get(tiers[chosenIndex].key.toLowerCase()) ?? null)
    : null;
  const confidence = readConfidence(payload, 'tier') ?? readConfidence(payload, 'complexity');
  const score = readScore(answers.complexity);
  const complexityIndex = score == null ? null
    : Math.min(top, Math.max(0, Math.round(score)));

  // No usable answer at all: the gateway answered 200 with a shape we cannot
  // read. That is an unknown, not a "weak" verdict.
  if (chosenIndex < 0 && complexityIndex == null) {
    return Object.freeze({ ok: false, code: 'jev_unreadable_answers' });
  }

  let index = Math.max(chosenIndex, complexityIndex == null ? 0 : complexityIndex);
  let reasonCode = complexityIndex != null && complexityIndex > chosenIndex
    ? 'jev_complexity_escalation'
    : 'jev_choice';
  if (confidence != null && confidence < escalation.minConfidence) {
    if (top > index) reasonCode = 'jev_low_confidence';
    index = top;
  } else if (confidence == null && top > index) {
    // A missing confidence field is not evidence of a confident answer.
    reasonCode = 'jev_confidence_missing';
    index = top;
  }
  if (chosenProbability != null && chosenProbability < escalation.minTierProbability
      && index < top) {
    reasonCode = 'jev_low_tier_probability';
    index += 1;
  }
  return Object.freeze({
    ok: true,
    tierIndex: index,
    tier: tiers[index].key,
    reasonCode,
    escalated: index > chosenIndex,
    chosenTier: chosenIndex >= 0 ? tiers[chosenIndex].key : null,
    chosenProbability,
    tierProbabilities: tierProbabilities ? Object.freeze(Object.fromEntries(tierProbabilities)) : null,
    complexityScore: score,
    complexityIndex,
    confidence,
  });
}

function detailOf(payload) {
  const message = firstDefined(
    payload && payload.error && payload.error.message,
    payload && payload.error,
    payload && payload.message,
  );
  if (message == null || typeof message === 'object') return null;
  return String(message).slice(0, MAX_DETAIL_CHARS);
}

function stateFor(text, context) {
  const request = String(text == null ? '' : text).slice(0, MAX_STATE_CHARS);
  const state = { request };
  if (context && typeof context === 'object') {
    // Only scalar hints travel: the request text plus whatever the host already
    // knows for free (session cli, whether a plan already exists, ...).
    for (const [key, value] of Object.entries(context)) {
      if (key === 'request') continue;
      if (typeof value === 'string') state[key] = value.slice(0, 500);
      else if (typeof value === 'number' || typeof value === 'boolean') state[key] = value;
    }
  }
  return state;
}

// ── per-call overrides ──────────────────────────────────────────────────────
//
// A pool may tune the endpoint (which gateway), the timeout, the model and the
// escalation thresholds in its own config (see auto-provider-config →
// validateRouting), and it validates them because they are supposed to have an
// effect: a knob that is accepted and then ignored is worse than one that is
// rejected, since the pool believes it is tuned. The store therefore hands each
// evaluation its session's values, and these readers fold them over this
// client's own defaults. Every one degrades to the default rather than throwing,
// because a malformed override must not cost the turn its verdict.
function clampTimeout(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(number)));
}

function usableModel(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, 100) : null;
}

function usableEndpoint(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, MAX_ENDPOINT_CHARS) : null;
}

// Only the two signals the policy actually reads may be overridden; anything
// else in the object is ignored here and rejected upstream by validateRouting.
function escalationWith(base, override) {
  if (!override || typeof override !== 'object') return base;
  return Object.freeze({
    minConfidence: clamp01(override.minConfidence) ?? base.minConfidence,
    minTierProbability: clamp01(override.minTierProbability) ?? base.minTierProbability,
  });
}

function createJevClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('[jev] fetch is required');
  const resolveApiKey = typeof options.resolveApiKey === 'function' ? options.resolveApiKey : null;
  const endpoint = String(options.endpoint || DEFAULT_ENDPOINT);
  const model = String(options.model || DEFAULT_MODEL);
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const escalation = Object.freeze({
    minConfidence: clamp01(options.escalation?.minConfidence) ?? DEFAULT_ESCALATION.minConfidence,
    minTierProbability: clamp01(options.escalation?.minTierProbability)
      ?? DEFAULT_ESCALATION.minTierProbability,
  });
  const logger = options.logger || { info() {}, warn() {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function readApiKey(apiKeyName) {
    if (!resolveApiKey) return null;
    try {
      const resolved = resolveApiKey(apiKeyName);
      return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : null;
    } catch (error) {
      logger.warn?.('jev_api_key_unavailable', { code: error && error.code || 'key_read_failed' });
      return null;
    }
  }

  async function classify({
    text, tiers, apiKeyName, context,
    escalation: escalationOverride, timeoutMs: timeoutOverride, model: modelOverride,
    endpoint: endpointOverride,
  } = {}) {
    const startedAt = now();
    const elapsed = () => Math.max(0, Number(now()) - startedAt);
    const ladder = normalizeTiers(tiers);
    if (!ladder.length) return Object.freeze({ ok: false, code: 'jev_no_tiers', latencyMs: elapsed() });
    const key = readApiKey(apiKeyName);
    if (!key) return Object.freeze({ ok: false, code: 'jev_key_missing', latencyMs: elapsed() });
    const budget = clampTimeout(timeoutOverride) ?? timeoutMs;
    const effectiveEscalation = escalationWith(escalation, escalationOverride);
    const effectiveModel = usableModel(modelOverride) || model;
    const effectiveEndpoint = usableEndpoint(endpointOverride) || endpoint;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), budget) : null;
    let response;
    try {
      response = await fetchImpl(effectiveEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: effectiveModel,
          state: stateFor(text, context),
          questions: buildQuestions(ladder),
        }),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      const code = aborted ? 'jev_timeout' : 'jev_network';
      logger.warn?.('jev_request_failed', { code, latencyMs: elapsed() });
      return Object.freeze({ ok: false, code, latencyMs: elapsed() });
    }
    try {
      const raw = await response.text();
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch (_) { payload = null; }
      if (!response.ok) {
        const code = `jev_http_${Number(response.status) || 0}`;
        logger.warn?.('jev_request_rejected', {
          code,
          status: Number(response.status) || 0,
          // Vercel's own error text is safe to record; request headers are not.
          detail: detailOf(payload),
          latencyMs: elapsed(),
        });
        return Object.freeze({
          ok: false, code, status: Number(response.status) || 0,
          detail: detailOf(payload), latencyMs: elapsed(),
        });
      }
      const answers = readAnswers(payload);
      if (!answers) {
        logger.warn?.('jev_bad_payload', { latencyMs: elapsed() });
        return Object.freeze({ ok: false, code: 'jev_bad_payload', latencyMs: elapsed() });
      }
      const verdict = escalationPolicy({ tiers: ladder, escalation: effectiveEscalation }, answers, payload);
      if (!verdict.ok) {
        logger.warn?.('jev_unreadable_answers', { code: verdict.code, latencyMs: elapsed() });
        return Object.freeze({ ok: false, code: verdict.code, latencyMs: elapsed() });
      }
      const result = Object.freeze({
        ...verdict,
        ok: true,
        source: 'jev',
        // What was actually asked, which is the pool's model when it set one:
        // the verdict is audited against the model it came from.
        model: effectiveModel,
        latencyMs: elapsed(),
      });
      logger.info?.('jev_verdict', {
        tier: result.tier, reasonCode: result.reasonCode, escalated: result.escalated,
        confidence: result.confidence, complexityScore: result.complexityScore,
        latencyMs: result.latencyMs,
      });
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return Object.freeze({ classify, endpoint, model, timeoutMs, escalation });
}

module.exports = {
  CUSTOM_API_KEY_NAME,
  CUSTOM_GATEWAY,
  CUSTOM_MODEL,
  DEFAULT_ENDPOINT,
  DEFAULT_ESCALATION,
  DEFAULT_GATEWAY,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  GATEWAY_NAMES,
  JEV_GATEWAYS,
  MAX_ENDPOINT_CHARS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIERS,
  TIER_BANDS,
  bandForTier,
  buildQuestions,
  createJevClient,
  escalationPolicy,
  normalizeTiers,
  readAnswers,
  readConfidence,
  tierIndex,
};

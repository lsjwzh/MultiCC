'use strict';

// ── Auto Provider difficulty routing store ──────────────────────────────────
//
// The tier verdict has to be true *before* the turn starts. `runChatTurn` is a
// synchronous function that resolves the initial provider route inline, so it
// cannot await a network call; the WebSocket `user_message` handler above it is
// async and already has an admission-progress phase (memory distill). Routing
// rides that same window:
//
//   1. the WS handler calls prepareTurn() — one Jev evaluation of THIS message,
//      awaited before the message is admitted, with a progress frame so the
//      user's bubble appears immediately;
//   2. the turn engine calls consume() synchronously at beginTurn and hands the
//      tier to the candidate chooser.
//
// Two invariants hold the whole path together:
//   * prepareTurn never rejects. Routing is an optimisation layer; a dead
//     gateway, a missing key or a malformed answer must degrade to the
//     configured onUnknown tier, never to a lost message.
//   * consume is text-keyed and idempotent. A turn may be replayed or retried;
//     the verdict stays valid for its own message only, so a retry cannot
//     inherit a stale tier and a fresh message cannot inherit the previous
//     one's. Verdicts are kept per message, not per session: a message queued
//     behind a busy turn keeps its verdict when the next one is judged.

const { validateProviderSelection } = require('../providers/auto-provider-config');
const { createJevClient } = require('../providers/jev-client');

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 256;

function textHash(text) {
  const source = String(text == null ? '' : text);
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash * 33) ^ source.charCodeAt(index)) >>> 0;
  }
  return `${source.length}:${hash.toString(36)}`;
}

// Vault-backed default so the feature works from a session's config alone: the
// value is read in-process and never crosses a log line, an event or the wire.
function defaultApiKeyResolver(name) {
  const vault = require('../secrets-vault');
  const result = vault.reveal(name);
  return result && result.entry ? result.entry.value : null;
}

function unknownTier(routing, verdict) {
  const tiers = routing && Array.isArray(routing.tiers) ? routing.tiers : [];
  const code = verdict && verdict.code ? verdict.code : 'jev_not_prepared';
  if (!tiers.length) return Object.freeze({ tier: null, source: 'unavailable', code });
  const mode = routing.onUnknown || 'strong';
  if (mode === 'priority') return Object.freeze({ tier: null, source: 'fallback', code });
  return Object.freeze({
    tier: mode === 'weak' ? tiers[0] : tiers[tiers.length - 1],
    source: 'fallback',
    code,
  });
}

function createAutoProviderRouting(options = {}) {
  const logger = options.logger || { info() {}, warn() {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const maxEntries = Math.max(8, Number(options.maxEntries) || MAX_ENTRIES);
  const jev = options.jev || createJevClient({
    fetchImpl: options.fetchImpl,
    resolveApiKey: options.resolveApiKey || defaultApiKeyResolver,
    logger,
  });
  const prepared = new Map(); // `${sessionId}\n${hash}` -> { sessionId, verdict, at }
  const inflight = new Map(); // sessionId -> { hash, promise }

  function remember(sessionId, hash, verdict) {
    const key = `${sessionId}\n${hash}`;
    prepared.delete(key); // re-insert so eviction stays oldest-first
    prepared.set(key, { sessionId, verdict, at: Number(now()) });
    while (prepared.size > maxEntries) prepared.delete(prepared.keys().next().value);
  }

  // Synchronous, cheap, and safe on a hot path: it validates the persisted
  // selection exactly like the runtime will, so prepare and consume can never
  // disagree about whether routing is on.
  function routingFor(session, providers) {
    const raw = session && session.providerSelection;
    if (!raw || raw.mode !== 'auto' || !raw.routing) return null;
    const validated = validateProviderSelection(raw, {
      cli: (session && session.cli) || 'claude',
      providers: providers || undefined,
    });
    if (!validated.ok || !validated.value.routing) return null;
    return { selection: validated.value, routing: validated.value.routing };
  }

  function prepareTurn({ session, text, providers, context } = {}) {
    let scope = null;
    try { scope = routingFor(session, providers); } catch (error) {
      logger.warn?.('auto_provider_routing_prepare_failed', {
        sessionId: session && session.id || null,
        code: error && error.code || 'routing_prepare_failed',
      });
      return null;
    }
    if (!scope || !String(text == null ? '' : text).trim()) return null;
    const sessionId = session.id;
    const hash = textHash(text);
    const existing = inflight.get(sessionId);
    if (existing && existing.hash === hash) return existing.promise;
    const { routing } = scope;
    const promise = jev.classify({
      text,
      tiers: routing.tiers,
      apiKeyName: routing.apiKeyName,
      // The pool's own tuned knobs travel with the call: they were validated as
      // meaningful (see validateRouting), so an ignored one would silently route
      // by defaults the user never chose.
      escalation: routing.escalation,
      timeoutMs: routing.timeoutMs,
      model: routing.model,
      context,
    }).then((verdict) => {
      remember(sessionId, hash, verdict);
      return verdict;
    }).catch((error) => {
      // jev.classify already fails open; this is the last net before delivery.
      const verdict = Object.freeze({
        ok: false,
        code: 'jev_client_failed',
        detail: String(error && error.message || '').slice(0, 200),
      });
      remember(sessionId, hash, verdict);
      return verdict;
    }).finally(() => {
      const current = inflight.get(sessionId);
      if (current && current.promise === promise) inflight.delete(sessionId);
    });
    inflight.set(sessionId, { hash, promise });
    while (inflight.size > maxEntries) inflight.delete(inflight.keys().next().value);
    return promise;
  }

  // Never destructive: a verdict is only reported for the message it was made
  // for, and expiry is the only thing that removes it.
  function consume({ sessionId, text } = {}) {
    const key = `${sessionId}\n${textHash(text)}`;
    const entry = prepared.get(key);
    if (!entry) return null;
    if (Number(now()) - entry.at > ttlMs) {
      prepared.delete(key);
      return null;
    }
    return entry.verdict;
  }

  // The tier a turn should use, together with where it came from. `source` is
  // what the UI and the ledger report: 'jev' means Jev decided, 'fallback'
  // means it was unavailable and the conservative default was applied.
  function resolveTier({ selection, verdict } = {}) {
    const routing = selection && selection.routing;
    if (!routing) return null;
    // Where the tier sits on the ladder, so a chat note can say "simple" or
    // "complex" without knowing the pool's tier keys.
    const ladder = Array.isArray(routing.tiers) ? routing.tiers : [];
    const position = (tier) => {
      const at = tier == null ? -1 : ladder.indexOf(tier);
      return { tierIndex: at >= 0 ? at : null, tierCount: ladder.length };
    };
    if (verdict && verdict.ok) {
      return Object.freeze({
        tier: verdict.tier,
        ...position(verdict.tier),
        source: 'jev',
        code: verdict.reasonCode || 'jev_choice',
        escalated: verdict.escalated === true,
        confidence: verdict.confidence == null ? null : verdict.confidence,
        complexityScore: verdict.complexityScore == null ? null : verdict.complexityScore,
        chosenTier: verdict.chosenTier || null,
        // The margin the choice was made with: the audit trail a pool needs to
        // re-tune minConfidence/minTierProbability against its own traffic.
        chosenProbability: verdict.chosenProbability == null ? null : verdict.chosenProbability,
        latencyMs: verdict.latencyMs == null ? null : verdict.latencyMs,
      });
    }
    const fallback = unknownTier(routing, verdict);
    return Object.freeze({
      tier: fallback.tier,
      ...position(fallback.tier),
      onUnknown: routing.onUnknown || 'strong',
      source: fallback.source,
      code: fallback.code,
      escalated: false,
      confidence: null,
      complexityScore: null,
      chosenTier: null,
      chosenProbability: null,
      latencyMs: verdict && verdict.latencyMs != null ? verdict.latencyMs : null,
    });
  }

  function clearSession(sessionId) {
    for (const [key, entry] of prepared) if (entry.sessionId === sessionId) prepared.delete(key);
    inflight.delete(sessionId);
  }

  return Object.freeze({
    prepareTurn,
    consume,
    resolveTier,
    clearSession,
    jev,
    size: () => prepared.size,
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  createAutoProviderRouting,
  defaultApiKeyResolver,
  textHash,
  unknownTier,
};

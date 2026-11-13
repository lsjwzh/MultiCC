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
//
// The decisions (hash, unknown tier, tier resolution) and the verdict store
// (TTL, oldest-first eviction, per-session clearing) live in
// `native/core/src/auto_provider_routing.rs`. This file owns only what cannot
// move: the Jev call itself, the single-flight promise map, and the host
// wiring. Node is frozen — no decision may return here.

const { jevTarget, validateProviderSelection } = require('../providers/auto-provider-config');
const { createJevClient } = require('../providers/jev-client');
const secretAudit = require('../secret-audit');
const { getNative } = require('../native/runtime');

const DEFAULTS = JSON.parse(getNative().autoProviderRoutingDefaults());
const DEFAULT_TTL_MS = DEFAULTS.defaultTtlMs;
const MAX_ENTRIES = DEFAULTS.maxEntries;

function textHash(text) {
  return getNative().autoProviderTextHash(text == null ? null : text);
}

// Vault-backed default so the feature works from a session's config alone: the
// value is read in-process and never crosses a log line, an event or the wire.
function defaultApiKeyResolver(name) {
  const vault = require('../secrets-vault');
  const result = vault.reveal(name, { source: 'auto_provider_routing' });
  return result && result.entry ? result.entry.value : null;
}

function unknownTier(routing, verdict) {
  const answer = JSON.parse(getNative().autoProviderUnknownTier(routing ?? null, verdict ?? null));
  return Object.freeze(answer);
}

function createAutoProviderRouting(options = {}) {
  const logger = options.logger || { info() {}, warn() {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const store = new (getNative().RustAutoProviderRouting)({
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
  });
  const maxEntries = store.maxEntries;
  const jev = options.jev || createJevClient({
    fetchImpl: options.fetchImpl,
    resolveApiKey: options.resolveApiKey || defaultApiKeyResolver,
    logger,
  });
  // A price-tiered pool has no stored ladder: the owner (the runtime) derives it
  // from the price table, and both prepare and resolve must ask for the same one.
  const resolveLadder = typeof options.resolveLadder === 'function' ? options.resolveLadder : null;
  const inflight = new Map(); // sessionId -> { hash, promise }

  function remember(sessionId, hash, verdict) {
    store.remember({ sessionId, hash, verdict, now: Number(now()) });
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

  function prepareTurn({ session, text, providers, context, limitEntries = null } = {}) {
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
    let tiers = routing.tiers;
    if (routing.tiering === 'price') {
      try {
        tiers = resolveLadder ? resolveLadder({ session, selection: scope.selection, providers, limitEntries }) : [];
      } catch (_) { tiers = []; }
      // Fewer than two price tiers: nothing to decide, so no call is spent on
      // it; resolveTier reports price_tiers_unavailable.
      if (!Array.isArray(tiers) || tiers.length < 2) return null;
    }
    // Which gateway this pool evaluates through — resolved in one place, shared
    // with the editor's "test" route so both reach the same host and model.
    const target = jevTarget(routing);
    const promise = secretAudit.withContext({ sessionId, taskId: session.taskBoundTaskId }, () => jev.classify({
      text,
      tiers,
      apiKeyName: target.apiKeyName,
      endpoint: target.endpoint,
      // The pool's own tuned knobs travel with the call: they were validated as
      // meaningful (see validateRouting), so an ignored one would silently route
      // by defaults the user never chose.
      escalation: routing.escalation,
      timeoutMs: routing.timeoutMs,
      model: target.model,
      context,
    })).then((verdict) => {
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
    const answer = JSON.parse(store.consume({ sessionId, text: text ?? null, now: Number(now()) }));
    return answer == null ? null : answer;
  }

  // The tier a turn should use, together with where it came from. `source` is
  // what the UI and the ledger report: 'jev' means Jev decided, 'fallback'
  // means it was unavailable and the conservative default was applied.
  // A price-tiered pool passes this turn's ladder as `tiers`; a verdict for a
  // tier that ladder no longer has (the table refreshed in between) is treated
  // as no verdict at all.
  function resolveTier({ selection, verdict, tiers } = {}) {
    const answer = JSON.parse(getNative().autoProviderResolveTier({
      selection: selection ?? null,
      verdict: verdict ?? null,
      tiers: tiers ?? null,
    }));
    return answer == null ? null : Object.freeze(answer);
  }

  function clearSession(sessionId) {
    store.clearSession(sessionId);
    inflight.delete(sessionId);
  }

  return Object.freeze({
    prepareTurn,
    consume,
    resolveTier,
    clearSession,
    jev,
    size: () => store.size,
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  createAutoProviderRouting,
  defaultApiKeyResolver,
  textHash,
  unknownTier,
};

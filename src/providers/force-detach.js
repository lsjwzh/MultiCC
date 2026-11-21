'use strict';

// Force-delete support for DELETE /api/providers/:appType/:id?force=1.
//
// findProviderReferences() lists every place a provider id is still wired in;
// this unwires them before the provider record goes away, so nothing is left
// pointing at an id that no longer resolves:
//   - session main route / Auto candidate / subagent route → go through the
//     ordinary PATCH /api/sessions/:id path (applySessionPatch), so validation,
//     codex rollout sync, warm-stream teardown and the busy-session "applies
//     next turn" staging all behave exactly like a user edit in the AI dialog;
//   - CLI default route → cleared back to the native login;
//   - Aux → provider cleared (the user re-picks one in Aux settings).
// A session that cannot be detached is reported as failed and the provider is
// NOT deleted; the caller answers 409 with what is still left.
//
// Every rule now lives in Rust: the walk order (defaults and Aux in reference
// order, then each distinct session once in first-appearance order), the
// per-session patch body, the trimmed-Auto-pool decision
// (`multicc_core::provider_registry::detach_keeps_auto` / `detach_max_attempts`),
// the manual-fallback retry and the 200-unit error slice. See
// `provider_detach_request` in native/addon/src/provider_registry.rs.
//
// The host executes the planned effects on the live session table and feeds
// each settled response back to Rust before proceeding.
//
// Behaviour is pinned against the frozen pre-migration implementation in
// tests/helpers/legacy-provider-force-detach.js, which the big providers
// differential (docs/rust-migration/differential/providers.js) runs as its
// oracle while the live path runs this one.
const { getNative } = require('../native/runtime');
const { desiredSession } = require('../session/pending-configuration');

async function detachProviderReferences({
  providerId, references, sessions, applySessionPatch, clearDefault, clearAuxProvider,
  currentReferences,
} = {}) {
  const request = (op, input) => getNative().providerDetachRequest(op, input);
  const planSession = sessionId => request('session', {
    sessionId, session: sessions.get(sessionId), providerId, desiredSession,
  });
  const { effects, sessionIds } = request('scope', references);
  const detached = [];
  const failed = [];
  let waited = false;
  for (const effect of effects) {
    if (effect.kind === 'default') clearDefault(effect.cli);
    else clearAuxProvider(providerId);
    detached.push(effect);
  }
  for (const sessionId of sessionIds) {
    const plan = planSession(sessionId);
    if (!plan) continue;
    const { sessionName, patch, fallback } = plan;
    let result = applySessionPatch(sessionId, patch);
    if (typeof result?.then === 'function') {
      waited = true;
      result = await result;
    }
    let outcome = request('response', { sessionId, sessionName, result, fallback });
    if (outcome.retry) {
      result = applySessionPatch(sessionId, outcome.retry);
      if (typeof result?.then === 'function') {
        waited = true;
        result = await result;
      }
      outcome = request('response', { sessionId, sessionName, result });
    }
    if (outcome.failed) failed.push(outcome.failed);
    else detached.push(outcome.detached);
  }
  if (waited && !failed.length && currentReferences) {
    // An unrelated route may have attached to this provider during the scan.
    // The planner reads pending configuration when a live binding is deferred.
    const remaining = request('scope', currentReferences());
    if (remaining.effects.length || remaining.sessionIds.some(planSession)) {
      throw new Error('provider references changed during detachment');
    }
  }
  return { detached, failed };
}

module.exports = { detachProviderReferences };

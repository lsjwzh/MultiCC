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
// `provider_detach_references` in native/addon/src/provider_registry.rs.
//
// This file is the transport only. The session table and the patch/clear
// effects stay in the Node process and are handed to the addon as callbacks, so
// there is no second copy of the session state behind the front door.
//
// Behaviour is pinned against the frozen pre-migration implementation in
// tests/helpers/legacy-provider-force-detach.js, which the big providers
// differential (docs/rust-migration/differential/providers.js) runs as its
// oracle while the live path runs this one.
const { getNative } = require('../native/runtime');
const { desiredSession } = require('../session/pending-configuration');

function detachProviderReferences(input = {}) {
  return getNative().providerDetachReferences({ ...input, desiredSession });
}

module.exports = { detachProviderReferences };

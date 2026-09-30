'use strict';

const { desiredSession } = require('../session/pending-configuration');

// Force-delete support for DELETE /api/providers/:appType/:id?force=1.
//
// findProviderReferences() lists every place a provider id is still wired in;
// this module unwires them before the provider record goes away, so nothing is
// left pointing at an id that no longer resolves:
//   - session main route / Auto candidate / subagent route → go through the
//     ordinary PATCH /api/sessions/:id path (applySessionPatch), so validation,
//     codex rollout sync, warm-stream teardown and the busy-session "applies
//     next turn" staging all behave exactly like a user edit in the AI dialog;
//   - CLI default route → cleared back to the native login;
//   - Aux → provider cleared (the user re-picks one in Aux settings).
// A session that cannot be detached is reported as failed and the provider is
// NOT deleted; the caller answers 409 with what is still left.

function withoutCandidate(selection, providerId) {
  const candidates = (selection.candidates || []).filter(item => item && item.providerId !== providerId);
  const enabled = candidates.filter(item => item.enabled !== false);
  return { candidates, enabled };
}

// The patch body that removes `providerId` from one session. Reads the desired
// state (pending configuration included) so a staged edit is not resurrected.
function sessionDetachPlan(session, providerId) {
  const view = session.pendingConfiguration ? desiredSession(session) : session;
  const body = {};
  let fallback = null;
  const selection = view.providerSelection;
  const auto = selection && selection.mode === 'auto';
  if (auto && (selection.candidates || []).some(item => item && item.providerId === providerId)) {
    const { candidates, enabled } = withoutCandidate(selection, providerId);
    const manual = { providerSelection: null, provider: enabled[0] ? enabled[0].providerId : null };
    if (enabled.length >= 2) {
      body.providerSelection = {
        ...selection,
        candidates,
        maxAttempts: Math.max(2, Math.min(Number(selection.maxAttempts) || 2, enabled.length, 4)),
      };
      // Routing tiers can name the removed candidate; if the trimmed pool no
      // longer validates, drop to manual on the next remaining candidate.
      fallback = manual;
    } else {
      Object.assign(body, manual);
    }
  } else if (view.provider === providerId) {
    body.provider = null;
  }
  if (view.subagent && view.subagent.providerId === providerId) body.subagent = null;
  return { body, fallback };
}

function detachProviderReferences({
  providerId,
  references,
  sessions,
  applySessionPatch,
  clearDefault,
  clearAuxProvider,
}) {
  const detached = [];
  const failed = [];
  const sessionIds = new Set();
  for (const ref of references) {
    if (ref.kind === 'default') {
      clearDefault(ref.cli);
      detached.push({ kind: 'default', cli: ref.cli });
    } else if (ref.kind === 'aux') {
      clearAuxProvider(providerId);
      detached.push({ kind: 'aux', protocol: ref.protocol });
    } else if (ref.sessionId) {
      sessionIds.add(ref.sessionId);
    }
  }
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    const sessionName = String((session && (session.name || session.label)) || sessionId);
    if (!session) continue; // Deleted meanwhile — nothing left to unwire.
    const { body, fallback } = sessionDetachPlan(session, providerId);
    if (!Object.keys(body).length) continue;
    let result = applySessionPatch(sessionId, body);
    if (result.status !== 200 && fallback) {
      result = applySessionPatch(sessionId, { ...fallback, ...(body.subagent === null ? { subagent: null } : {}) });
    }
    if (result.status === 200) {
      detached.push({ kind: 'session', sessionId, sessionName, deferred: !!(result.body && result.body.deferred) });
    } else {
      failed.push({
        kind: 'session',
        sessionId,
        sessionName,
        error: String((result.body && result.body.error) || `HTTP ${result.status}`).slice(0, 200),
      });
    }
  }
  return { detached, failed };
}

module.exports = { detachProviderReferences, sessionDetachPlan };

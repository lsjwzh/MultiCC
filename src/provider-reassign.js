'use strict';

const { sanitizePublicText } = require('./http/public-safety');

// Batch provider reassignment — `POST /api/providers/:appType/:id/reassign-sessions`
// (Air/App: 「批量迁移会话…」).
//
// Why this module is thin on purpose: every session is moved through the SAME
// in-process PATCH the per-session AI-config dialog uses
// (`applySessionPatch`, src/routes/session-profile.js). That is not just
// convenience — it is the whole contract we want to inherit verbatim:
//
//   · provider ids are re-validated per session (`validProviderId`, which also
//     applies `providerSupportsCli`), so a CLI that cannot speak the target
//     line is rejected instead of being pointed at it;
//   · a stale `model` from the previous provider is replaced by the target's
//     default through `modelValidForProvider` — the fix for the incident where
//     a carried-over relay model 400'd against the next upstream;
//   · Codex sessions get their native rollout hand-off
//     (`synchronizeCodexSessionRoute`) when the provider authority changes;
//   · claude streaming sessions are torn down so the next turn respawns with
//     the new env;
//   · BUSY sessions are not interrupted: the PATCH stages the change in
//     `pendingConfiguration` and it applies on the next turn. We report those
//     as `deferred` rather than skipping them, because that IS what a manual
//     single-session switch does;
//   · the audit event and both broadcasts (workspace + chat) fire exactly once
//     per moved session.
//
// What we deliberately do NOT touch, and report instead:
//   · Auto-selection sessions. A `provider` patch leaves Auto
//     (`patchSession` nulls `providerSelection`), and silently dismantling a
//     user's Auto pool is a far bigger change than "point these at X".
//   · Sub-agent routes and the CLI default/aux provider. They are counted in
//     `otherReferences` so the caller can say what stayed behind.
//
// Dry runs never call `applySessionPatch`; they go through
// `previewSessionPatch`, which runs the identical validation on a detached
// desired-state draft and writes nothing.

// A response is a UI payload, not an export: bound it so a 400-session fleet
// cannot turn one dialog into a multi-megabyte frame.
const MAX_RESULTS = 200;
const MAX_LABEL = 120;

const REASON = Object.freeze({
  SYSTEM_SESSION: 'system_session',
  AUTO_SELECTION: 'auto_selection',
  CLI_INCOMPATIBLE: 'cli_incompatible',
  PATCH_REJECTED: 'patch_rejected',
});

function cleanLabel(value, fallback) {
  const raw = typeof value === 'string' ? value : (value == null ? '' : String(value));
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL) : fallback;
}

function cleanModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lookupSession(sessions, id) {
  if (sessions instanceof Map) return sessions.get(id) || null;
  if (Array.isArray(sessions)) return sessions.find(item => item && item.id === id) || null;
  return null;
}

// Sessions whose MAIN route currently points at the source provider. Auto
// candidates / sub-agent routes / the CLI default are separate kinds and are
// only counted (see `otherReferences`).
function collectBoundSessions(references, sessions) {
  const seen = new Set();
  const bound = [];
  for (const reference of references || []) {
    if (!reference || reference.kind !== 'main' || !reference.sessionId) continue;
    if (seen.has(reference.sessionId)) continue;
    seen.add(reference.sessionId);
    const session = lookupSession(sessions, reference.sessionId);
    if (!session) continue; // Deleted between listing and moving.
    bound.push(session);
  }
  return bound;
}

function countOtherReferences(references) {
  const counts = { auto_candidate: 0, subagent: 0, default: 0, aux: 0 };
  for (const reference of references || []) {
    if (reference && Object.prototype.hasOwnProperty.call(counts, reference.kind)) {
      counts[reference.kind] += 1;
    }
  }
  return counts;
}

function isSystemSession(session) {
  return session.type === 'aux' || session.type === 'gateway';
}

function isAutoSession(session) {
  return !!(session.providerSelection && session.providerSelection.mode === 'auto');
}

// The one place a session's fate is decided — shared by the dry run and the
// apply path so the preview cannot promise something the apply won't do.
function skipReason(session, { targetProviderId, validProviderId }) {
  if (isSystemSession(session)) return REASON.SYSTEM_SESSION;
  if (isAutoSession(session)) return REASON.AUTO_SELECTION;
  const cli = session.cli || 'claude';
  let compat = null;
  try { compat = validProviderId(cli, targetProviderId); } catch (_) { compat = null; }
  if (!compat || compat.ok !== true) return REASON.CLI_INCOMPATIBLE;
  return null;
}

function summarizeTargets({ bound, sourceId, listProviders, validProviderId }) {
  const seen = new Set();
  const targets = [];
  for (const provider of listProviders() || []) {
    const id = cleanLabel(provider && provider.id, '');
    if (!id || id === sourceId || seen.has(id)) continue;
    seen.add(id);
    let compatible = 0;
    let skipped = 0;
    for (const session of bound) {
      if (skipReason(session, { targetProviderId: id, validProviderId })) skipped += 1;
      else compatible += 1;
    }
    // A target nobody in the selection can use is noise, not a choice.
    if (!compatible) continue;
    targets.push({
      id,
      appType: provider.appType || null,
      name: cleanLabel(provider.name, id),
      apiFormat: provider.apiFormat || provider.protocol || null,
      compatibleSessions: compatible,
      skippedSessions: skipped,
    });
  }
  targets.sort((a, b) => b.compatibleSessions - a.compatibleSessions
    || a.name.localeCompare(b.name));
  return targets;
}

function moveOne(session, deps) {
  const sessionId = String(session.id || '');
  const cli = session.cli || 'claude';
  const base = {
    sessionId,
    label: cleanLabel(session.label || session.name, sessionId),
    cli,
  };
  const reason = skipReason(session, deps);
  if (reason) return Object.freeze({ ...base, status: 'skipped', reason });

  const modelBefore = cleanModel(session.model);
  const patch = { provider: deps.targetProviderId };
  if (deps.dryRun && typeof deps.previewSessionPatch !== 'function') {
    // Compatibility-only prediction: the CLI check above already passed, but
    // without the preview entry point the model reset cannot be shown.
    return Object.freeze({
      ...base,
      status: 'switched',
      deferred: !!session.pendingConfiguration,
      modelBefore,
      modelAfter: null,
      modelReset: null,
    });
  }
  const result = deps.dryRun
    ? deps.previewSessionPatch(sessionId, patch)
    : deps.applySessionPatch(sessionId, patch);
  if (!result || result.status !== 200) {
    return Object.freeze({
      ...base,
      status: 'skipped',
      reason: REASON.PATCH_REJECTED,
      detail: sanitizePublicText(result && result.body && result.body.error, 'session patch rejected'),
      modelBefore,
    });
  }
  const applied = (result.body && typeof result.body === 'object') ? result.body : {};
  const modelAfter = cleanModel(applied.model);
  // Busy sessions: the single-session PATCH stages the change for the next turn
  // and answers `deferred`. A dry run cannot ask the runtime, so it reports the
  // one case that is knowable offline — an already-staged configuration.
  const deferred = deps.dryRun
    ? !!session.pendingConfiguration
    : applied.deferred === true;
  return Object.freeze({
    ...base,
    status: 'switched',
    deferred,
    modelBefore,
    modelAfter,
    modelReset: modelBefore !== modelAfter,
  });
}

/**
 * @param {object} input
 * @param {string} input.appType            source pool ('claude' | 'codex')
 * @param {string} input.providerId         source provider id
 * @param {string|null} input.targetProviderId  target provider id (required to apply)
 * @param {boolean} input.dryRun            plan only, never writes
 * @param {Map|Array} input.sessions        persisted sessions
 * @param {Array} input.references          findProviderReferences() output
 * @param {object} input.sourceProvider     source provider summary (for the label)
 * @param {object|null} input.targetProvider target provider summary
 * @param {Function} input.listProviders    () => provider summaries (all pools)
 * @param {Function} input.validProviderId  (cli, id) => {ok, value}
 * @param {Function} input.applySessionPatch  (sessionId, body) => {status, body}
 * @param {Function} input.previewSessionPatch (sessionId, body) => {status, body}
 */
function reassignProviderSessions(input) {
  const deps = input || {};
  const bound = collectBoundSessions(deps.references, deps.sessions);
  const source = {
    appType: deps.appType || null,
    id: deps.providerId || null,
    name: cleanLabel(deps.sourceProvider && deps.sourceProvider.name, deps.providerId || ''),
  };
  const base = {
    ok: true,
    dryRun: !!deps.dryRun,
    source,
    total: bound.length,
    otherReferences: countOtherReferences(deps.references),
  };

  if (!deps.targetProviderId) {
    // Listing mode: the bound sessions plus every target at least one of them
    // can actually move to. `reason` here only carries the two skips that are
    // knowable without a target (system sessions, Auto-selection sessions).
    return {
      ...base,
      target: null,
      targets: summarizeTargets({
        bound,
        sourceId: deps.providerId,
        listProviders: deps.listProviders,
        validProviderId: deps.validProviderId,
      }),
      sessions: bound.slice(0, MAX_RESULTS).map(session => Object.freeze({
        sessionId: String(session.id || ''),
        label: cleanLabel(session.label || session.name, String(session.id || '')),
        cli: session.cli || 'claude',
        model: cleanModel(session.model),
        reason: isSystemSession(session)
          ? REASON.SYSTEM_SESSION
          : (isAutoSession(session) ? REASON.AUTO_SELECTION : null),
      })),
      switched: 0,
      skipped: 0,
      deferred: 0,
      truncated: bound.length > MAX_RESULTS,
      results: [],
    };
  }

  const target = {
    id: deps.targetProviderId,
    appType: (deps.targetProvider && deps.targetProvider.appType) || null,
    name: cleanLabel(deps.targetProvider && deps.targetProvider.name, deps.targetProviderId),
  };
  const results = [];
  for (const session of bound.slice(0, MAX_RESULTS)) {
    results.push(moveOne(session, {
      dryRun: !!deps.dryRun,
      targetProviderId: deps.targetProviderId,
      validProviderId: deps.validProviderId,
      applySessionPatch: deps.applySessionPatch,
      previewSessionPatch: deps.previewSessionPatch,
    }));
  }
  const switched = results.filter(item => item.status === 'switched');
  return {
    ...base,
    target,
    switched: switched.length,
    skipped: results.length - switched.length,
    deferred: switched.filter(item => item.deferred === true).length,
    truncated: bound.length > results.length,
    results,
  };
}

module.exports = {
  MAX_RESULTS,
  REASON,
  reassignProviderSessions,
};

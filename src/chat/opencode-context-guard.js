'use strict';

// Pre-turn admission guard for OpenCode native context (mirrors
// codex-rollout-guard): when the CURRENT native session's water level has
// crossed a safe fraction of the model's REAL context limit, the turn rotates
// to a fresh native session via a bounded handoff checkpoint, so a long-lived
// session cannot silently walk into "Prompt is too long".
//
// Decision only — the caller (turn-engine) performs the rotation with the
// shared pendingCliHandoff machinery. The guard never touches the user's
// OpenCode database (the reader is read-only) and fails open: any error means
// "don't rotate this turn", never a blocked turn.
//
// A rotation additionally requires the limit to come from the models.dev
// catalog (reader.wouldRotate). A guessed/fallback limit never triggers
// rotation — an unknown model degrades safely instead of rotating on a
// fabricated window.

const { createOpencodeContextReader } = require('./opencode-context');

function createOpencodeContextGuard(deps = {}) {
  const logger = deps.logger || console;
  const reader = deps.contextReader
    || createOpencodeContextReader({ logger, env: deps.env });

  function enforce(record) {
    const base = { action: 'skipped' };
    try {
      const persisted = record || {};
      if (persisted.kind && persisted.kind !== 'chat') {
        return Object.freeze({ ...base, reason: 'not_chat_session' });
      }
      const handoff = persisted.pendingCliHandoff;
      if (handoff && handoff.status === 'pending') {
        // A checkpoint is already queued for the next turn — rotating again
        // would stack checkpoints and re-clear state for no benefit.
        return Object.freeze({ ...base, reason: 'handoff_pending' });
      }
      const cliSessionId = persisted._streamSessionId || persisted.cliSessionId || null;
      if (!cliSessionId) {
        return Object.freeze({ ...base, reason: 'no_native_session' });
      }
      const usage = reader.read(cliSessionId, persisted.model || null);
      if (!usage || usage.found !== true) {
        return Object.freeze({ ...base, reason: (usage && usage.reason) || 'usage_unavailable' });
      }
      const metrics = {
        cliSessionId,
        tokensTotal: usage.tokens.total,
        contextLimit: usage.limit.context,
        limitSource: usage.limit.source,
        threshold: usage.threshold,
        ratio: usage.ratio,
      };
      if (usage.limit.source !== 'models.dev') {
        // Unknown model: never rotate on a guessed window.
        return Object.freeze({ ...base, reason: 'limit_unknown', ...metrics });
      }
      if (usage.wouldRotate !== true) {
        return Object.freeze({ ...base, reason: 'below_threshold', ...metrics });
      }
      return Object.freeze({ action: 'rotate', reason: 'context_water_level_exceeded', ...metrics });
    } catch (error) {
      try { logger.warn('opencode_context_guard_failed', { reason: error && error.message }); } catch (_) {}
      return Object.freeze({ ...base, reason: 'error' });
    }
  }

  return Object.freeze({ enforce });
}

module.exports = { createOpencodeContextGuard };

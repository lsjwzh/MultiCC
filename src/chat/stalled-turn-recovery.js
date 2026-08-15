'use strict';

// Stalled-turn recovery: the missing EXECUTOR for the liveness runtime's
// `stalled` verdict.
//
// The liveness runtime (src/liveness/runtime.js) fuses silence + absence of
// outbound connections + a non-growing rollout into a `stalled` verdict, but
// nothing ever consumed it: the HTTP endpoint displayed it, classify's
// ownership() (fail-closed by design) never sees it, and the processing
// watchdog only catches DEAD runners — a live-but-wedged process sails
// through as 'alive'. The result was sessions spinning forever with a new
// message unable to get in.
//
// This component periodically re-assesses in-flight chat sessions. A `stalled`
// verdict is useful operational evidence, but it is built entirely from the
// ABSENCE of observable activity. That cannot prove a live runner is wedged:
// long local reasoning, an upstream request owned by a proxy process, or a
// provider that emits no intermediate bytes all look identical. Therefore the
// default policy is OBSERVE ONLY. It logs a confirmed suspect but never ends the
// turn. Destructive recovery is retained behind an explicit opt-in for operators
// who accept that tradeoff.
//
// Detection noise protection is layered:
//   • sessions must be in classifyState P with an in-flight runner;
//   • silence opens suspicion only: the full liveness assess() must also see
//     NO outbound HTTPS connection and NO rollout growth (a long tool call
//     that is still talking to an upstream or writing its rollout stays
//     `working`); the resulting negative evidence is observe-only by default;
//   • the verdict must persist for `confirmations` consecutive sweeps
//     (default 2 × 30s on top of the existing 180s silence threshold — no
//     new silence standard is invented, stallSilentMs is reused verbatim);
//   • the `starting` phase (spawn → MCP handshake → rollout load → first
//     token) legitimately runs longer than an established turn's silence
//     budget, so while the turn-progress heartbeat reports phase=starting the
//     silence threshold is extended by `startingGraceMs` (default +120s,
//     covering the 60s MCP startup_timeout_sec plus rollout load);
//   • after a confirmed observation (or an opt-in recovery), a cooldown avoids
//     repeating the same report while the turn remains quiet.
//
// Truly actionable failures use positive evidence elsewhere: the processing
// watchdog handles a dead runner, and provider-log watchdogs handle a current-
// turn correlated provider error. Neither relies on silence alone.
//
// Note on the opt-in cancelled kill landing: stopRunner detaches cs.claudeProc
// BEFORE the process dies, so the turn-engine close handler sees a stale
// proc and skips close-time classification entirely — the E verdict comes
// solely from runCancel's structured result. clearErrorFlagsForSucceededTurn
// (b2dced7) is never on this path, so a recovered turn cannot be
// misclassified as an API error; a reply that was already persisted stays
// persisted.

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_COOLDOWN_MS = 120_000;
const DEFAULT_STARTING_GRACE_MS = 120_000;

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[stalled-turn-recovery] ${name} must be a function`);
  }
}

function createStalledTurnRecovery(deps = {}) {
  for (const name of [
    'listRecords', 'getTaskState', 'getChatSession', 'getStreamStatus',
    'assessLiveness', 'cancelTurn',
  ]) assertFunction(deps[name], name);
  if (deps.getTurnStatus != null) assertFunction(deps.getTurnStatus, 'getTurnStatus');

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  // Reuse the liveness runtime's existing silence standard; never invent one.
  const stallSilentMs = Number.isFinite(Number(deps.stallSilentMs)) && Number(deps.stallSilentMs) > 0
    ? Number(deps.stallSilentMs)
    : 180_000;
  const startingGraceMs = Math.max(0, Number.isFinite(Number(deps.startingGraceMs))
    ? Number(deps.startingGraceMs) : DEFAULT_STARTING_GRACE_MS);
  const confirmations = Math.max(1, Number(deps.confirmations) || DEFAULT_CONFIRMATIONS);
  const cooldownMs = Math.max(0, Number(deps.cooldownMs) || DEFAULT_COOLDOWN_MS);
  // Safety default: negative evidence (silence + no observed traffic/growth) is
  // never sufficient authority to kill a live turn.
  const autoCancel = deps.autoCancel === true;
  const logger = deps.logger || console;

  // sessionId -> { count, reason, firstAt }
  const suspects = new Map();
  // sessionId -> earliest timestamp at which recovery may fire again
  const cooldowns = new Map();
  let sweeping = false;

  function clearSuspect(sessionId) {
    suspects.delete(sessionId);
  }

  async function inspect(sessionId, record, at) {
    const cooldownUntil = cooldowns.get(sessionId);
    if (cooldownUntil != null) {
      if (at < cooldownUntil) {
        return { sessionId, action: 'skip', reason: 'recovery_cooldown' };
      }
      cooldowns.delete(sessionId);
    }

    const task = deps.getTaskState(record) || {};
    if (task.classifyState !== 'P') {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'not_processing' };
    }
    if (task.cancelledAt) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'already_cancelled' };
    }

    const cs = deps.getChatSession(sessionId) || null;
    const stream = deps.getStreamStatus(sessionId) || null;
    const inFlight = !!(cs && cs.isStreaming) || !!(stream && stream.busy);
    if (!inFlight) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'no_inflight_turn' };
    }

    // Cheap pre-filter: no point paying for a process probe (lsof) until the
    // silence alone already crosses the EXISTING stall threshold. This does
    // not judge anything — only the full assess() below can say `stalled`.
    // The `starting` phase gets extra grace (MCP handshake / rollout load /
    // first token legitimately take longer than an established turn's budget).
    const turnStatus = (() => {
      if (typeof deps.getTurnStatus !== 'function') return null;
      try { return deps.getTurnStatus(sessionId) || null; } catch (_) { return null; }
    })();
    const turnPhase = turnStatus && turnStatus.phase ? turnStatus.phase : null;
    const threshold = turnPhase === 'starting' ? stallSilentMs + startingGraceMs : stallSilentMs;
    const lastStreamAt = cs && Number.isFinite(cs.lastStreamAt) ? cs.lastStreamAt : null;
    const silentMs = lastStreamAt != null ? Math.max(0, at - lastStreamAt) : null;
    if (silentMs == null || silentMs < threshold) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: turnPhase === 'starting' ? 'starting_grace' : 'below_stall_threshold' };
    }

    let verdict;
    try {
      verdict = await deps.assessLiveness(sessionId);
    } catch (error) {
      logger.warn?.('stalled_recovery_assess_failed', {
        sessionId, error: error?.message || String(error),
      });
      return { sessionId, action: 'skip', reason: 'assess_failed' };
    }
    if (!verdict || verdict.state !== 'stalled') {
      // Any corroborating activity (outbound connection, rollout growth, fresh
      // proxy traffic) keeps the turn alive and resets the confirmation count.
      clearSuspect(sessionId);
      return { sessionId, action: 'watching', reason: verdict?.state || 'unknown' };
    }

    const suspect = suspects.get(sessionId);
    const count = suspect ? suspect.count + 1 : 1;
    suspects.set(sessionId, { count, reason: verdict.reason, firstAt: suspect?.firstAt ?? at });
    if (count < confirmations) {
      return { sessionId, action: 'confirming', reason: verdict.reason, count };
    }

    suspects.delete(sessionId);
    cooldowns.set(sessionId, at + cooldownMs);
    if (!autoCancel) {
      logger.warn?.('stalled_turn_observed', {
        sessionId,
        silentMs,
        phase: turnPhase,
        reason: verdict.reason,
        confirmations: count,
        action: 'observe_only',
      });
      return {
        sessionId,
        action: 'observed',
        reason: verdict.reason,
        autoCancel: false,
      };
    }

    const result = await deps.cancelTurn(sessionId, {
      reason: `stalled_${verdict.reason}`,
      killReason: 'stalled_recovery',
      // Not a manual cancel: same canonical E transition as user cancel and
      // the dead-runner watchdog, different attribution.
      source: 'stalled_recovery',
    });
    logger.warn?.('stalled_turn_recovered', {
      sessionId,
      silentMs,
      phase: turnPhase,
      reason: verdict.reason,
      confirmations: count,
      result: result?.code || (result?.ok ? 'ok' : 'unknown'),
    });
    return { sessionId, action: 'cancelled', reason: verdict.reason, result };
  }

  async function sweep() {
    if (sweeping) return { ok: false, code: 'sweep_in_progress', results: [] };
    sweeping = true;
    const at = now();
    const results = [];
    try {
      for (const [sessionId, record] of deps.listRecords()) {
        if (!record || record.kind !== 'chat' || record.type === 'aux' || record.type === 'gateway') {
          clearSuspect(sessionId);
          continue;
        }
        try {
          results.push(await inspect(sessionId, record, at));
        } catch (error) {
          logger.warn?.('stalled_recovery_session_failed', {
            sessionId, error: error?.message || String(error),
          });
          results.push({ sessionId, action: 'error', reason: 'inspection_failed' });
        }
      }
      return { ok: true, results };
    } finally {
      sweeping = false;
    }
  }

  return Object.freeze({ sweep, inspect, clearSuspect });
}

module.exports = {
  createStalledTurnRecovery,
  STALLED_RECOVERY_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  STALLED_RECOVERY_CONFIRMATIONS: DEFAULT_CONFIRMATIONS,
  STALLED_RECOVERY_COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
};

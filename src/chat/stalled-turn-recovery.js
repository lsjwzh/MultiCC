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
// This component periodically re-assesses in-flight chat sessions and, when
// the authoritative `stalled` verdict persists across consecutive sweeps,
// ends the turn through the SAME path a manual cancel uses
// (sessionWorkHost.cancelActiveTurn): SIGTERM→SIGKILL the runner, submit the
// canonical E verdict through classify (single writer), release the scheduler
// slot so the next user message is admitted again.
//
// False-positive protection is layered, mirroring b2dced7's "never fail a
// succeeded turn" direction from the opposite side:
//   • sessions must be in classifyState P with an in-flight runner;
//   • silence alone never kills: the cheap pre-filter only opens the door,
//     the full liveness assess() must say `stalled`, which additionally
//     requires NO outbound HTTPS connection and NO rollout growth (a long
//     tool call that is still talking to an upstream or writing its rollout
//     stays `working`);
//   • the verdict must persist for `confirmations` consecutive sweeps
//     (default 2 × 30s on top of the existing 180s silence threshold — no
//     new silence standard is invented, stallSilentMs is reused verbatim);
//   • after a recovery fires, a cooldown keeps the executor out while the
//     cancel machinery (5s stop budget + classify transition) settles.
//
// Note on the cancelled kill landing: stopRunner detaches cs.claudeProc
// BEFORE the process dies, so the turn-engine close handler sees a stale
// proc and skips close-time classification entirely — the E verdict comes
// solely from runCancel's structured result. clearErrorFlagsForSucceededTurn
// (b2dced7) is never on this path, so a recovered turn cannot be
// misclassified as an API error; a reply that was already persisted stays
// persisted.

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_COOLDOWN_MS = 120_000;

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

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  // Reuse the liveness runtime's existing silence standard; never invent one.
  const stallSilentMs = Number.isFinite(Number(deps.stallSilentMs)) && Number(deps.stallSilentMs) > 0
    ? Number(deps.stallSilentMs)
    : 180_000;
  const confirmations = Math.max(1, Number(deps.confirmations) || DEFAULT_CONFIRMATIONS);
  const cooldownMs = Math.max(0, Number(deps.cooldownMs) || DEFAULT_COOLDOWN_MS);
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
    const lastStreamAt = cs && Number.isFinite(cs.lastStreamAt) ? cs.lastStreamAt : null;
    const silentMs = lastStreamAt != null ? Math.max(0, at - lastStreamAt) : null;
    if (silentMs == null || silentMs < stallSilentMs) {
      clearSuspect(sessionId);
      return { sessionId, action: 'skip', reason: 'below_stall_threshold' };
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

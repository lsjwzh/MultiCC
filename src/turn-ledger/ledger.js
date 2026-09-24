'use strict';

// TurnLedger (status plan v4 §1): per-session turn bookkeeping built only from
// structured lifecycle facts, projected through the same resolveTurnState the
// chat path uses. Pure apart from injected clock/scheduler/evidence reader.
//
// Invariants:
// - A Stop hook is a *candidate*. The turn is only "completed" once a second,
//   independent fact agrees (see evidence.js); until then the state stays P and
//   nothing is announced. Better late than a false "done".
// - Events from an older CLI instance (lower epoch) or an older turn never
//   mutate the current one.
// - The ledger never invents an E from silence. No evidence for a long time is
//   surfaced as needsReview, not as an error.

const { resolveTurnState } = require('../classify/turn-state');
const {
  OWNERSHIP, SILENT_E_REASONS, transitionId, projectLiveness,
} = require('./contract');

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input']);
const WAIT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);
const DEFAULT_CONFIRM_DELAYS_MS = [200, 1000, 3000, 10000];
const DEFAULT_STALL_MS = 10 * 60 * 1000;
const SEEN_LIMIT = 256;

function createTurnLedger(deps = {}) {
  const {
    now = Date.now,
    schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    confirmTurnEnd = async () => 'pending',
    onTransition = () => {},
    logger = null,
    confirmDelaysMs = DEFAULT_CONFIRM_DELAYS_MS,
    stallMs = DEFAULT_STALL_MS,
  } = deps;

  const records = new Map();

  function blank(sessionId, epoch) {
    return {
      sessionId, epoch, cli: null, cliSessionId: null, cliPid: null,
      ownership: null, turnId: null, turnSeq: 0, boundary: null,
      pendingUserInput: false, backgroundPending: false, stop: null,
      promptHead: null, lastEventAt: 0, needsReview: false,
      state: null, evidence: null, transitionSeq: 0, lastTransitionId: null,
      seen: [], seenSet: new Set(), stopToken: 0,
    };
  }

  function remember(rec, eventId) {
    rec.seen.push(eventId);
    rec.seenSet.add(eventId);
    if (rec.seen.length > SEEN_LIMIT) rec.seenSet.delete(rec.seen.shift());
  }

  function compute(rec) {
    if (!rec.turnId) return { state: null, evidence: 'no_turn_yet' };
    if (rec.stop) return { state: 'P', evidence: 'stop_unconfirmed' };
    return resolveTurnState({
      liveness: projectLiveness(rec.ownership),
      boundary: rec.boundary || (rec.ownership === OWNERSHIP.ENDED ? 'unknown-interruption' : undefined),
      pendingUserInput: rec.pendingUserInput,
      backgroundPending: rec.backgroundPending,
    });
  }

  function publish(rec) {
    const next = compute(rec);
    rec.evidence = next.evidence;
    if (next.state === rec.state) return null;
    const from = rec.state;
    rec.state = next.state;
    if (!next.state) return null;
    rec.transitionSeq += 1;
    const id = transitionId({
      sessionId: rec.sessionId, epoch: rec.epoch, turnId: rec.turnId,
      seq: rec.transitionSeq, state: next.state,
    });
    rec.lastTransitionId = id;
    const reason = next.state === 'E' ? (rec.boundary || 'unknown-interruption') : null;
    const transition = {
      transitionId: id, sessionId: rec.sessionId, epoch: rec.epoch, turnId: rec.turnId,
      from, to: next.state, evidence: next.evidence, reason,
      silent: next.state === 'P' || SILENT_E_REASONS.has(reason),
      at: now(),
    };
    try { onTransition(transition); } catch (e) { logger?.warn?.(`[turn-ledger] onTransition failed: ${e.message}`); }
    return transition;
  }

  function markWaiting(rec) {
    if (!rec.turnId || rec.ownership === OWNERSHIP.ENDED) return;
    rec.ownership = OWNERSHIP.YIELDING;
    rec.pendingUserInput = true;
  }

  function settle(rec, patch) {
    rec.stop = null;
    Object.assign(rec, patch);
  }

  function confirm(rec) {
    const stop = rec.stop;
    if (!stop) return;
    const token = stop.token;
    Promise.resolve()
      .then(() => confirmTurnEnd({
        cli: rec.cli, turnId: stop.turnId, cliSessionId: rec.cliSessionId,
        transcriptPath: stop.transcriptPath, at: stop.at,
      }))
      .catch(() => 'pending')
      .then(verdict => {
        const cur = records.get(rec.sessionId);
        if (cur !== rec || !rec.stop || rec.stop.token !== token) return;  // superseded
        if (verdict === 'confirmed') {
          settle(rec, {
            boundary: 'completed',
            backgroundPending: stop.backgroundTasks > 0,
            ownership: rec.ownership === OWNERSHIP.ENDED ? OWNERSHIP.ENDED : OWNERSHIP.YIELDING,
          });
        } else if (verdict === 'continued') {
          settle(rec, { ownership: rec.ownership === OWNERSHIP.ENDED ? OWNERSHIP.ENDED : OWNERSHIP.RUNNING });
        } else if (verdict === 'interrupted') {
          settle(rec, {
            boundary: 'interrupted',
            ownership: rec.ownership === OWNERSHIP.ENDED ? OWNERSHIP.ENDED : OWNERSHIP.YIELDING,
          });
        } else {
          stop.attempts += 1;
          if (stop.attempts < confirmDelaysMs.length) schedule(() => confirm(rec), confirmDelaysMs[stop.attempts]);
          return;
        }
        publish(rec);
      });
  }

  // Returns a short outcome string (for tests/diagnostics) — never throws.
  function apply(env) {
    if (!env || !env.sessionId) return 'invalid';
    let rec = records.get(env.sessionId);
    if (!rec) { rec = blank(env.sessionId, env.epoch); records.set(env.sessionId, rec); }
    if (rec.seenSet.has(env.eventId)) return 'duplicate';
    if (env.epoch < rec.epoch) return 'stale_epoch';
    if (env.epoch > rec.epoch) {
      const head = rec.promptHead;
      rec = blank(env.sessionId, env.epoch);
      rec.promptHead = head;  // the title survives a CLI restart
      records.set(env.sessionId, rec);
    }
    remember(rec, env.eventId);
    rec.lastEventAt = env.ts;
    rec.needsReview = false;
    if (env.cli) rec.cli = env.cli;
    if (env.cliSessionId) rec.cliSessionId = env.cliSessionId;
    if (env.cliPid) rec.cliPid = env.cliPid;

    const sameTurn = !env.turnId || !rec.turnId || env.turnId === rec.turnId;
    switch (env.event) {
      case 'SessionStart':
        if (!rec.ownership || rec.ownership === OWNERSHIP.ENDED) rec.ownership = OWNERSHIP.YIELDING;
        break;
      case 'UserPromptSubmit':
        rec.turnSeq += 1;
        rec.turnId = env.turnId || `host-${rec.epoch}-${rec.turnSeq}`;
        settle(rec, {
          ownership: OWNERSHIP.RUNNING, boundary: null,
          pendingUserInput: false, backgroundPending: false,
        });
        if (env.promptHead) rec.promptHead = env.promptHead;
        break;
      case 'PreToolUse':
        if (!sameTurn) return 'stale_turn';
        if (QUESTION_TOOLS.has(env.toolName)) markWaiting(rec);
        break;
      case 'PermissionRequest':
        if (!sameTurn) return 'stale_turn';
        markWaiting(rec);
        break;
      case 'Notification':
        if (WAIT_NOTIFICATIONS.has(env.notificationType)) markWaiting(rec);
        break;
      case 'PostToolUse':
        if (!sameTurn) return 'stale_turn';
        if (rec.pendingUserInput && rec.ownership === OWNERSHIP.YIELDING && !rec.stop) {
          rec.pendingUserInput = false;
          rec.ownership = OWNERSHIP.RUNNING;
        }
        break;
      case 'Stop':
        if (!sameTurn) return 'stale_turn';
        if (!rec.turnId) return 'no_turn';
        rec.stopToken += 1;
        rec.stop = {
          token: rec.stopToken, turnId: rec.turnId, at: env.ts, attempts: 0,
          transcriptPath: env.transcriptPath, backgroundTasks: env.backgroundTasks || 0,
        };
        rec.pendingUserInput = false;
        if (rec.ownership !== OWNERSHIP.ENDED) rec.ownership = OWNERSHIP.RUNNING;
        publish(rec);
        schedule(() => confirm(rec), confirmDelaysMs[0]);
        return 'stop_candidate';
      case 'StopFailure':
        if (!sameTurn) return 'stale_turn';
        settle(rec, { boundary: 'api-error', ownership: OWNERSHIP.YIELDING, pendingUserInput: false });
        break;
      case 'Interrupt':
        if (!sameTurn) return 'stale_turn';
        settle(rec, { boundary: 'interrupted', ownership: OWNERSHIP.YIELDING, pendingUserInput: false });
        break;
      case 'SessionEnd':
        if (rec.stop) {
          // Exit right after Stop is normal (-p, /exit). Let evidence decide.
          rec.ownership = OWNERSHIP.ENDED;
          schedule(() => confirm(rec), 0);
          break;
        }
        if (rec.ownership === OWNERSHIP.RUNNING) rec.boundary = 'unknown-interruption';
        rec.ownership = OWNERSHIP.ENDED;
        rec.pendingUserInput = false;
        break;
      default:
        return 'ignored';
    }
    publish(rec);
    return 'applied';
  }

  // Periodic sweep: a turn with no lifecycle fact for stallMs is flagged for
  // review. It stays P — silence proves nothing either way.
  function tick() {
    const t = now();
    for (const rec of records.values()) {
      if (rec.state === 'P' && rec.lastEventAt && t - rec.lastEventAt > stallMs) rec.needsReview = true;
    }
  }

  function snapshot(sessionId) {
    const rec = records.get(sessionId);
    if (!rec) return null;
    return {
      sessionId, epoch: rec.epoch, cli: rec.cli, cliSessionId: rec.cliSessionId, cliPid: rec.cliPid,
      ownership: rec.ownership, liveness: projectLiveness(rec.ownership),
      turnId: rec.turnId, state: rec.state, evidence: rec.evidence,
      reason: rec.state === 'E' ? (rec.boundary || 'unknown-interruption') : null,
      boundary: rec.boundary, pendingUserInput: rec.pendingUserInput,
      backgroundPending: rec.backgroundPending, stopPending: !!rec.stop,
      promptHead: rec.promptHead, needsReview: rec.needsReview,
      lastEventAt: rec.lastEventAt || null, lastTransitionId: rec.lastTransitionId,
    };
  }

  return {
    apply, tick, snapshot,
    ownership: sessionId => projectLiveness(records.get(sessionId)?.ownership),
    forget: sessionId => records.delete(sessionId),
    sessions: () => [...records.keys()],
  };
}

module.exports = { createTurnLedger, QUESTION_TOOLS, DEFAULT_CONFIRM_DELAYS_MS };

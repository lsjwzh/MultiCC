'use strict';

// Frozen session question rules used as a differential oracle.
const { applyUserInputEvidence } = require('../../src/classify/vocab');
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function createUserInputSignalHost({
  getSession,
  getState,
  setState,
  now = Date.now,
  log = () => {},
  // Fired once when a wait_user request is actually consumed (resolved). The
  // server wires this to a session-wide broadcast so EVERY open window tears down
  // its prompt — not just the one that answered. Duplicate resolves do not fire.
  onResolved = () => {},
} = {}) {
  for (const [name, value] of Object.entries({ getSession, getState, setState })) {
    if (typeof value !== 'function') {
      throw new TypeError(`[user-input-signal] ${name} port is required`);
    }
  }

  function pending(sessionId) {
    return getState(sessionId)?.pendingUserInput || null;
  }

  function lastResolved(sessionId) {
    return getState(sessionId)?.lastResolvedUserInput || null;
  }

  function turnId(sessionId) {
    return getState(sessionId)?.userInputSignalTurnId || null;
  }

  function record(signal = {}) {
    const sessionId = String(signal.sessionId || '');
    const turnId = String(signal.turnId || '');
    const session = getSession(sessionId);
    if (!session?._activeTurn || session._activeTurn.turnId !== turnId || !session.isStreaming) {
      return { ok: false, code: 'turn_not_active' };
    }
    const existing = pending(sessionId);
    if (existing?.requestId === signal.requestId) return { ok: true, duplicate: true };
    if (existing && existing.resolved !== true) {
      return { ok: false, code: 'user_input_already_pending' };
    }
    setState(sessionId, {
      pendingUserInput: {
        requestId: signal.requestId,
        turnId,
        taskId: session._currentTaskId || null,
        question: signal.question,
        reason: signal.reason || '',
        options: Array.isArray(signal.options) ? signal.options : [],
        allowMultiple: signal.allowMultiple === true,
        // Secret-mode requests render a password input in the client and the
        // answer is stored via POST /api/secrets — the value never becomes a
        // chat message. Non-secret requests keep inputType absent for backward
        // compatibility with older clients.
        ...(signal.inputType === 'secret' && SECRET_NAME_RE.test(String(signal.secretName || ''))
          ? { inputType: 'secret', secretName: String(signal.secretName) }
          : {}),
        createdAt: now(),
        resolved: false,
      },
      userInputSignalVersion: 1,
    });
    log(`[multicc/classify] ${sessionId} request_user_input recorded request=${signal.requestId} turn=${turnId}`);
    return { ok: true, duplicate: false };
  }

  function beginTurn(sessionId, { originContinue = false, turnId } = {}) {
    const current = getState(sessionId) || {};
    const stale = current.pendingUserInput;
    // A fresh turn supersedes an unanswered question: the user chose to drive
    // on. Fire the same broadcast a resolve fires so every open window tears
    // the card down instead of inviting an answer to a question that no longer
    // exists — flagged superseded so clients can render the difference.
    if (!originContinue && stale && stale.resolved !== true && stale.requestId) {
      log(`[multicc/classify] ${sessionId} request_user_input superseded by new turn request=${stale.requestId}`);
      onResolved(sessionId, stale.requestId, stale.taskId ?? null, { superseded: true });
    }
    const supersededNow = !originContinue && stale && stale.resolved !== true && stale.requestId;
    return setState(sessionId, {
      pendingUserInput: originContinue ? current.pendingUserInput || null : null,
      // Survives the nulling above: replayState uses it to tell a
      // late-reconnecting client that its stale card was already settled.
      lastResolvedUserInput: supersededNow
        ? { requestId: stale.requestId, at: now(), superseded: true }
        : current.lastResolvedUserInput || null,
      userInputSignalVersion: 1,
      userInputSignalTurnId: turnId || null,
      classifyState: 'P',
      // 同上：问出去的那一刻，上一次 D 判定的「达成目标/需要交互」已经不成立了。
      goalState: null,
    });
  }

  function apply(sessionId, result) {
    return applyUserInputEvidence(result, pending(sessionId));
  }

  function resolve(sessionId, requestId, { dismissed = false } = {}) {
    const current = pending(sessionId);
    if (!current || current.requestId !== requestId) {
      return { ok: false, code: current ? 'request_id_mismatch' : 'no_pending_request' };
    }
    if (current.resolved === true) return { ok: true, duplicate: true };
    setState(sessionId, {
      pendingUserInput: {
        ...current,
        resolved: true,
        resolvedAt: now(),
        ...(dismissed ? { resolution: 'dismissed', resolvedBy: 'user' } : {}),
      },
      lastResolvedUserInput: { requestId, at: now(), taskId: current.taskId ?? null,
        ...(dismissed ? { resolution: 'dismissed', resolvedBy: 'user' } : {}) },
      userInputSignalVersion: 1,
    });
    log(`[multicc/classify] ${sessionId} request_user_input resolved request=${requestId}`);
    onResolved(sessionId, requestId, current.taskId ?? null, dismissed ? { resolution: 'dismissed' } : undefined);
    return { ok: true, duplicate: false };
  }

  // Task separation moves the judged turn's open question to the task the turn
  // now lives in. The source settles as resolved(resolution:'moved') — the same
  // broadcast a normal resolve fires, so every open source window tears the
  // card down — and the target session adopts the still-unanswered request
  // verbatim (same requestId, same turnId), so its replay shows the card and
  // admission correlates the answer as the continuation of the asking turn.
  // record()'s active-turn guard is bypassed deliberately: the target has no
  // live turn yet; the unanswered question itself is the durable artifact
  // being transferred. turnId is also mirrored into userInputSignalTurnId so
  // the scheduler's getTurnId (which reads recoveryState.turnId) correlates
  // the shell answer path on a session that has not run a turn of its own yet.
  function move(sourceId, targetId, { turnId, taskId } = {}) {
    if (!sourceId || !targetId || sourceId === targetId) return { ok: false, code: 'invalid_move' };
    const current = pending(sourceId);
    if (!current || current.resolved === true) {
      return { ok: false, code: current ? 'already_resolved' : 'no_pending_request' };
    }
    if (turnId && current.turnId && current.turnId !== turnId) return { ok: false, code: 'turn_mismatch' };
    const targetPending = pending(targetId);
    if (targetPending && targetPending.resolved !== true) return { ok: false, code: 'target_already_pending' };
    setState(sourceId, {
      pendingUserInput: { ...current, resolved: true, resolvedAt: now(),
        resolution: 'moved', movedToSessionId: String(targetId) },
      lastResolvedUserInput: { requestId: current.requestId, at: now(),
        taskId: current.taskId ?? null, resolution: 'moved' },
      userInputSignalVersion: 1,
    });
    log(`[multicc/classify] ${sourceId} request_user_input moved to ${targetId} request=${current.requestId}`);
    onResolved(sourceId, current.requestId, current.taskId ?? null, { resolution: 'moved' });
    setState(targetId, {
      pendingUserInput: {
        requestId: current.requestId,
        turnId: current.turnId || null,
        taskId: taskId || current.taskId || null,
        question: current.question,
        reason: current.reason || '',
        options: Array.isArray(current.options) ? current.options : [],
        allowMultiple: current.allowMultiple === true,
        ...(current.inputType === 'secret' && current.secretName
          ? { inputType: 'secret', secretName: String(current.secretName) } : {}),
        createdAt: current.createdAt || now(),
        resolved: false,
        movedFromSessionId: String(sourceId),
      },
      ...(current.turnId ? { userInputSignalTurnId: current.turnId } : {}),
      userInputSignalVersion: 1,
      classifyState: 'W',
    });
    return { ok: true, requestId: current.requestId, question: current };
  }

  function degradedResult(sessionId, currentTask) {
    if (!pending(sessionId) || pending(sessionId).resolved === true) return null;
    const state = getState(sessionId) || {};
    return {
      state: 'W',
      goal: currentTask?.goal || state.goal || '',
      phase: currentTask?.phase || state.phase || 'planning',
      background: false,
      error: false,
    };
  }

  return Object.freeze({ apply, beginTurn, degradedResult, lastResolved, move, pending, record, resolve, turnId });
}

module.exports = { createUserInputSignalHost };

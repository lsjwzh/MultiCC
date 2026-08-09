'use strict';

const crypto = require('crypto');
const { applyUserInputEvidence } = require('./vocab');

// Bounds mirror the MCP request_user_input tool (router-tool-runtime) so a signal
// synthesized from a CLI's built-in ask tool is sanitized identically.
const MAX_QUESTION_LENGTH = 16 * 1024;
const MAX_REASON_LENGTH = 4 * 1024;
const MAX_OPTION_LENGTH = 512;
const MAX_OPTIONS = 12;

function sanitizeOptions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const text = String(raw == null ? '' : raw).trim().slice(0, MAX_OPTION_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

// Build a request_user_input signal from an adapter-decoded ask event (e.g.
// codex's built-in AskUserQuestion). This lands a non-MCP ask on the SAME
// structured waiting path (pendingUserInput → waiting → interactive options) as
// the MCP tool, instead of silently degrading to plain text. Returns null when
// there is no usable question text. requestId shape ("usrq-<hash>") matches the
// MCP path so dedup/resolve behave identically.
function buildAdapterUserInputSignal(
  { sessionId, turnId, question, reason, options, allowMultiple } = {},
  cryptoImpl = crypto,
) {
  const q = String(question == null ? '' : question).trim().slice(0, MAX_QUESTION_LENGTH);
  if (!q) return null;
  const r = String(reason == null ? '' : reason).trim().slice(0, MAX_REASON_LENGTH);
  const opts = sanitizeOptions(options);
  const multi = allowMultiple === true && opts.length >= 2;
  const requestId = `usrq-${cryptoImpl.createHash('sha256')
    .update([sessionId, turnId, q, r, opts.join('\0'), multi]
      .map((v) => String(v == null ? '' : v)).join('\0'), 'utf8')
    .digest('hex').slice(0, 24)}`;
  return {
    requestId,
    sessionId: String(sessionId || ''),
    turnId: String(turnId || ''),
    question: q,
    reason: r,
    options: opts,
    allowMultiple: multi,
  };
}

// Record an adapter ask event as a structured waiting signal via the provided
// recordInput port (server wires it to sessionWorkHost.recordInput, the same
// port the MCP tool uses). On any failure it returns the event's fallbackText so
// the caller can degrade to a plain-text passthrough — the question is never lost.
function recordAdapterUserInput({ evt, sessionId, turnId, recordInput } = {}) {
  const signal = buildAdapterUserInputSignal({
    sessionId,
    turnId,
    question: evt?.question,
    reason: evt?.reason,
    options: evt?.options,
    allowMultiple: evt?.allowMultiple,
  });
  const rec = signal && typeof recordInput === 'function' ? recordInput(signal) : null;
  const ok = !!(rec && rec.ok === true);
  return {
    ok,
    requestId: ok ? signal.requestId : null,
    fallbackText: ok ? '' : (evt?.fallbackText || ''),
  };
}

const USER_INPUT_SIGNAL_PROMPT = Object.freeze([
  '【等待用户回答】当你准备以阻塞性问题结束本轮（缺少用户决定、确认、选择或必要信息，导致任务无法安全继续）时，必须先调用 MultiCC MCP 的 wait_for_user_answer 工具；旧名 request_user_input 仅用于兼容。',
  '该工具有时显示为 multicc_router.wait_for_user_answer 或 mcp__multicc_router__wait_for_user_answer。调用成功后，把同一问题和选项作为本轮最终回复展示给用户，然后结束本轮，不再执行其他工具。',
  '如果你可以基于现有信息合理继续，就不要调用。普通建议、可选后续工作或礼貌性反问不属于必须等待用户。',
]);

function buildCodexUserInputConstraint(enabled = true) {
  if (!enabled) return '';
  return [
    '[MultiCC 环境约束]',
    '- Codex 内置 request_user_input / AskUserQuestion 在非交互执行环境中不可用。',
    '- 准备以阻塞性问题结束本轮时，必须先调用 MultiCC MCP 的 wait_for_user_answer（可能显示为 mcp__multicc_router__wait_for_user_answer）；不要调用 Codex 内置同名工具。',
    '- 工具返回后，把同一问题作为最终回复并结束本轮；能够安全合理继续时不要调用。',
    '[MultiCC 环境约束结束]',
  ].join('\n');
}

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
    });
  }

  function apply(sessionId, result) {
    return applyUserInputEvidence(result, pending(sessionId));
  }

  function resolve(sessionId, requestId) {
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
      },
      lastResolvedUserInput: { requestId, at: now(), taskId: current.taskId ?? null },
      userInputSignalVersion: 1,
    });
    log(`[multicc/classify] ${sessionId} request_user_input resolved request=${requestId}`);
    onResolved(sessionId, requestId, current.taskId ?? null);
    return { ok: true, duplicate: false };
  }

  function degradedResult(sessionId, currentTask) {
    if (!pending(sessionId)) return null;
    const state = getState(sessionId) || {};
    return {
      state: 'W',
      goal: currentTask?.goal || state.goal || '',
      phase: currentTask?.phase || state.phase || 'planning',
      background: false,
      error: false,
    };
  }

  return Object.freeze({ apply, beginTurn, degradedResult, lastResolved, pending, record, resolve });
}

module.exports = {
  USER_INPUT_SIGNAL_PROMPT,
  buildCodexUserInputConstraint,
  buildAdapterUserInputSignal,
  recordAdapterUserInput,
  createUserInputSignalHost,
};

'use strict';

const { applyUserInputEvidence } = require('./vocab');

const USER_INPUT_SIGNAL_PROMPT = Object.freeze([
  '【等待用户输入信号】仅当缺少用户决定、确认、选择或必要信息，导致当前任务无法安全继续时，调用 MultiCC MCP 的 request_user_input 工具记录结构化等待信号。',
  '该工具不会弹出终端交互，也不会代替你的正常回复；调用成功后，把问题和选项作为本轮最终回复展示给用户，然后结束本轮，不再执行其他工具。',
  '如果你可以基于现有信息合理继续，就不要调用。普通建议、可选后续工作或礼貌性反问不属于必须等待用户。',
]);

function buildCodexUserInputConstraint(enabled = true) {
  if (!enabled) return '';
  return [
    '[MultiCC 环境约束]',
    '- Codex 内置 request_user_input / AskUserQuestion 在非交互执行环境中不可用。',
    '- 需要用户决定、确认或补充必要信息且无法继续时，调用 MultiCC MCP 的 request_user_input；不要调用 Codex 内置同名工具。',
    '[MultiCC 环境约束结束]',
  ].join('\n');
}

function createUserInputSignalHost({
  getSession,
  getState,
  setState,
  now = Date.now,
  log = () => {},
} = {}) {
  for (const [name, value] of Object.entries({ getSession, getState, setState })) {
    if (typeof value !== 'function') {
      throw new TypeError(`[user-input-signal] ${name} port is required`);
    }
  }

  function pending(sessionId) {
    return getState(sessionId)?.pendingUserInput || null;
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
    return setState(sessionId, {
      pendingUserInput: originContinue ? current.pendingUserInput || null : null,
      userInputSignalVersion: 1,
      userInputSignalTurnId: turnId || null,
      classifyState: 'P',
    });
  }

  function apply(sessionId, result) {
    return applyUserInputEvidence(result, pending(sessionId));
  }

  function degradedResult(sessionId, currentTask) {
    if (!pending(sessionId)) return null;
    const state = getState(sessionId) || {};
    return {
      state: 'waiting',
      goal: currentTask?.goal || state.goal || '',
      phase: currentTask?.phase || state.phase || 'planning',
      background: false,
      error: false,
    };
  }

  return Object.freeze({ apply, beginTurn, degradedResult, pending, record });
}

module.exports = {
  USER_INPUT_SIGNAL_PROMPT,
  buildCodexUserInputConstraint,
  createUserInputSignalHost,
};

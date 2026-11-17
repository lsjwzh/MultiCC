'use strict';

// The native adapter reducer is synchronous. Acknowledge only the hand-off;
// the turn's finalization barrier waits for the owner and emits fallback text
// if the durable transition is rejected.
function recordAdapterQuestion({ evt, sessionId, turnId, work, recordAdapterUserInput,
  chatSessions, isCurrentTurnRunner, forwardFallback, logger }) {
  if (!work) return null;
  const result = recordAdapterUserInput({ evt, sessionId, turnId, recordInput: signal => work.recordInput(signal) });
  if (!result || typeof result.then !== 'function') return result;
  const cs = chatSessions.get(sessionId), turn = cs?._activeTurn, runner = cs?._activeRunner;
  const pending = Promise.resolve(result).catch(error => {
    logger.warn?.('user_input_record_failed', { sessionId, code: error?.code || 'unknown' });
    return { ok: false, fallbackText: evt?.fallbackText || '' };
  }).then(outcome => {
    if (!outcome.ok && outcome.fallbackText && turn && runner && isCurrentTurnRunner(cs, turn, runner)) {
      forwardFallback(sessionId, cs, turn, runner, outcome.fallbackText);
    }
  });
  if (runner) (runner.pendingUserInputRecords ||= []).push(pending);
  return { ok: true };
}

async function prepareQuestionReplay({ ws, input, sessionId, persisted, sendWs, cleanup }) {
  const earlyMessages = [];
  const bufferMessage = (...args) => earlyMessages.push(args);
  ws.on('message', bufferMessage);
  let closed = false;
  ws.on('close', () => { closed = true; cleanup(); });
  let turnId;
  try {
    turnId = typeof input.turnIdAsync === 'function' ? await input.turnIdAsync(sessionId)
      : typeof input.turnId === 'function' ? input.turnId(sessionId) : persisted.taskState?.userInputSignalTurnId || null;
  } catch (_) {
    ws.off('message', bufferMessage);
    sendWs(ws, { type: 'error', code: 'session_work_owner_unavailable', error: '无法读取会话问题状态，请重试。' });
    ws.close();
    return null;
  }
  if (closed) { ws.off('message', bufferMessage); return null; }
  return { turnId, finish() {
    ws.off('message', bufferMessage);
    if (!closed) for (const args of earlyMessages) ws.emit('message', ...args);
  } };
}

module.exports = { recordAdapterQuestion, prepareQuestionReplay };

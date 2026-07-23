'use strict';

function createTaskContextHost(options = {}) {
  const {
    getState,
    append,
    emitClients,
    getTaskBoard,
    containsDelivery,
    classifyDisplay,
    randomUUID,
  } = options;
  for (const [name, value] of Object.entries({
    getState, append, emitClients, getTaskBoard,
    containsDelivery, classifyDisplay, randomUUID,
  })) {
    if (typeof value !== 'function') throw new TypeError(`[task-context-host] ${name} port required`);
  }

  function restore(history) {
    if (!Array.isArray(history)) return null;
    return [...history].reverse().find(message => message?.taskId)?.taskId || null;
  }

  function dispatchSpec(opts = {}) {
    return {
      taskId: opts.taskId || null,
      taskStart: opts.taskStart === true,
      taskSource: opts.taskSource || null,
      taskText: opts.taskStart === true ? String(opts.taskText || '') : null,
    };
  }

  function turnOptions(opts = {}) {
    return {
      taskId: opts.taskId,
      taskStart: opts.taskStart,
      taskSource: opts.taskSource,
      taskText: opts.taskText,
    };
  }

  function beginTurn(state, requested = {}) {
    const previous = state?._currentTaskId || null;
    const taskId = requested.id || previous;
    const boundaryChanged = !!requested.id
      && (requested.start === true || requested.id !== previous);
    if (state) state._currentTaskId = taskId || null;
    return { taskId, boundaryChanged };
  }

  function messageMetadata(requested = {}, taskId = null) {
    return {
      taskId: taskId || undefined,
      taskStart: requested.start || undefined,
      taskSource: requested.source || undefined,
      taskText: requested.start ? requested.text : undefined,
    };
  }

  function appendMessage(sessionId, message) {
    const state = getState(sessionId);
    if (!message.taskId && state?._currentTaskId) message.taskId = state._currentTaskId;
    const saved = append(sessionId, message);
    const board = getTaskBoard();
    if (saved && board?.onMessagePersisted) board.onMessagePersisted(sessionId, message);
    return saved;
  }

  function broadcast(sessionId, payload) {
    const state = getState(sessionId);
    if (!state) return;
    const event = state._currentTaskId && payload?.taskId == null
      ? { ...payload, taskId: state._currentTaskId }
      : payload;
    emitClients(state.clients, event);
  }

  function runState(classifyState) {
    if (classifyState === 'A') return 'running';
    const cardStatus = classifyDisplay(classifyState || 'P').cardStatus;
    return cardStatus === 'completed' ? 'done' : cardStatus;
  }

  function recordGoal(sessionName, goal, phase, state, classifyState = 'P') {
    if (!sessionName || !state?._currentTaskId) return;
    getTaskBoard()?.onClassifyGoal(sessionName, goal, phase, {
      currentUserText: state.currentUserText || '',
      taskId: state._currentTaskId,
      runState: runState(classifyState),
    });
  }

  function continues(state, previous, forceNew, now = Date.now()) {
    if (state?._currentTaskId && !forceNew && previous) return true;
    return !!(!forceNew && previous && previous.phase !== 'done'
      && previous.startedAt && now - previous.startedAt < 10 * 60 * 1000);
  }

  async function handleCommander({
    persisted,
    sessionName,
    message,
    state,
  }) {
    if (persisted?.type !== 'commander') return false;
    const clientMsgId = typeof message.clientMsgId === 'string' && message.clientMsgId.trim()
      ? message.clientMsgId.trim().slice(0, 128)
      : `commander-${randomUUID()}`;
    const routed = await getTaskBoard().routeCommanderInput(sessionName, message.text, {
      clientMsgId,
      idempotencyKey: `commander-input:${sessionName}:${clientMsgId}`,
    });
    if (!routed.ok) {
      broadcast(sessionName, {
        type: 'error',
        error: `Commander 路由失败：${routed.code || routed.error || 'dispatch_failed'}`,
      });
      return true;
    }
    state._currentTaskId = routed.taskId;
    if (!containsDelivery(sessionName, clientMsgId)) {
      appendMessage(sessionName, {
        role: 'user',
        content: message.text,
        ts: Date.now(),
        clientMsgId,
        taskId: routed.taskId,
        taskStart: true,
        taskSource: 'commander',
        taskText: message.text,
      });
    }
    broadcast(sessionName, {
      type: 'result',
      commanderRoute: true,
      targetSessionId: routed.workerSessionId || routed.targetSessionId || null,
      operationId: routed.operationId || null,
    });
    return true;
  }

  return Object.freeze({
    appendMessage,
    beginTurn,
    broadcast,
    continues,
    dispatchSpec,
    handleCommander,
    messageMetadata,
    recordGoal,
    restore,
    turnOptions,
  });
}

module.exports = { createTaskContextHost };

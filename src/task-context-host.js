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
    getRecord,
    runTurn,
  } = options;
  for (const [name, value] of Object.entries({
    getState, append, emitClients, getTaskBoard,
    containsDelivery, classifyDisplay, randomUUID, getRecord, runTurn,
  })) {
    if (typeof value !== 'function') throw new TypeError(`[task-context-host] ${name} port required`);
  }

  function restore(history) {
    if (!Array.isArray(history)) return null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.taskDetached === true) return null;
      if (message?.taskId) return message.taskId;
    }
    return null;
  }

  function dispatchSpec(opts = {}) {
    return {
      taskId: opts.taskId || null,
      taskStart: opts.taskStart === true,
      taskSource: opts.taskSource || null,
      taskText: opts.taskStart === true ? String(opts.taskText || '') : null,
      resultMode: opts.resultMode || null,
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

  function beginTurn(state, requested = {}, options = {}) {
    const previous = state?._currentTaskId || null;
    const detached = options.detach === true;
    const generated = !detached && !requested.id && !previous;
    const taskId = detached ? null : requested.id || previous
      || `tsk_${String(randomUUID()).replace(/-/g, '')}`;
    const boundaryChanged = detached || generated || (!!requested.id
      && (requested.start === true || requested.id !== previous));
    if (state) state._currentTaskId = taskId || null;
    return { taskId, boundaryChanged, detached };
  }

  function messageMetadata(requested = {}, taskId = null, options = {}) {
    return {
      taskId: taskId || undefined,
      taskStart: requested.start || undefined,
      taskSource: requested.source || undefined,
      taskText: requested.start ? requested.text : undefined,
      taskDetached: options.detached === true || undefined,
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

  function recordCommanderRoute({
    sessionName,
    text,
    clientMsgId,
    taskId,
    taskStart = true,
    taskSource = 'commander',
    taskText,
    workerSessionId,
    operationId,
  } = {}) {
    const state = getState(sessionName);
    if (state && taskId) state._currentTaskId = taskId;
    const deliveryKey = typeof clientMsgId === 'string' ? clientMsgId.trim().slice(0, 128) : '';
    const deduplicated = !!deliveryKey && containsDelivery(sessionName, deliveryKey);
    if (!deduplicated) {
      const saved = appendMessage(sessionName, {
        role: 'user',
        content: String(text || ''),
        ts: Date.now(),
        clientMsgId: deliveryKey || undefined,
        taskId: taskId || undefined,
        taskStart: taskStart || undefined,
        taskSource: taskSource || undefined,
        taskText: taskStart ? String(taskText == null ? text || '' : taskText) : undefined,
      });
      if (!saved) return { ok: false, code: 'commander_history_not_persisted' };
    }
    broadcast(sessionName, {
      type: 'result',
      commanderRoute: true,
      targetSessionId: workerSessionId || null,
      operationId: operationId || null,
    });
    return { ok: true, deduplicated };
  }

  function continues(state, previous, forceNew, now = Date.now()) {
    if (state?._currentTaskId && !forceNew && previous) return true;
    return !!(!forceNew && previous && previous.phase !== 'done'
      && previous.startedAt && now - previous.startedAt < 10 * 60 * 1000);
  }

  async function routeCommanderMessage({
    persisted,
    sessionName,
    message,
  }) {
    if (persisted?.type !== 'commander') return { handled: false };
    const clientMsgId = typeof message.clientMsgId === 'string' && message.clientMsgId.trim()
      ? message.clientMsgId.trim().slice(0, 128)
      : `commander-${randomUUID()}`;
    const source = message.taskSource === 'task-board' ? 'task-board' : 'commander';
    const board = getTaskBoard();
    const routed = message.taskId && message.taskStart !== true
      ? await board.routeCommanderFollowup(sessionName, message.taskId, message.text, {
          clientMsgId,
          source,
          goalNote: message.goalNote,
        })
      : await board.routeCommanderInput(sessionName, message.text, {
          clientMsgId,
          source,
          goalNote: message.goalNote,
        });
    if (!routed.ok) {
      broadcast(sessionName, {
        type: 'error',
        error: `Commander 路由失败：${routed.code || routed.error || 'dispatch_failed'}`,
      });
      return { handled: true, ...routed };
    }
    const recorded = recordCommanderRoute({
      sessionName,
      text: message.text,
      clientMsgId,
      taskId: routed.taskId,
      taskStart: routed.taskStart !== false,
      taskSource: source,
      taskText: routed.taskStart === false ? undefined : message.text,
      workerSessionId: routed.workerSessionId || routed.targetSessionId,
      operationId: routed.operationId,
    });
    if (!recorded.ok) {
      broadcast(sessionName, {
        type: 'error',
        error: 'Commander 已完成路由，但源消息未能持久化；使用相同消息重试不会重复执行。',
      });
      return { handled: true, ...routed, ...recorded };
    }
    return { handled: true, ...routed, commanderRecorded: true };
  }

  async function handleCommander(input) {
    const routed = await routeCommanderMessage(input);
    return routed.handled === true;
  }

  async function deliverSessionMessage(sessionName, text, options = {}) {
    const persisted = getRecord(sessionName);
    if (!persisted) return { ok: false, code: 'session_not_found' };
    // Turn-timing t0: every chat-send route (WS user_message, task-board HTTP
    // sends) funnels through here. The stamp survives the durable outbox
    // (payload.options) so runChatTurn can measure from true receipt, FIFO
    // wait included. Callers may pre-stamp an earlier instant.
    if (!Number.isFinite(options.receivedAt)) options.receivedAt = Date.now();
    const started = await runTurn(sessionName, text, options);
    if (started && typeof started === 'object') {
      return {
        handled: false,
        chatId: sessionName,
        ...started,
      };
    }
    return {
      ok: started !== false,
      code: started === false ? 'turn_rejected' : undefined,
      handled: false,
      chatId: sessionName,
    };
  }

  return Object.freeze({
    appendMessage,
    beginTurn,
    broadcast,
    continues,
    deliverSessionMessage,
    dispatchSpec,
    handleCommander,
    messageMetadata,
    recordCommanderRoute,
    recordGoal,
    routeCommanderMessage,
    restore,
    turnOptions,
  });
}

module.exports = { createTaskContextHost };

'use strict';

const { scopeHostProviderEvent } = require('./chat/provider-attempt-runtime');
const { SYSTEM_PREFIX } = require('./session/delivery');
const unattendedKernel = require('./unattended/kernel');

// "Real user" = a message a human typed. Host-authored deliveries all carry one
// of the markers below (or the 🔇 system prefix the delivery boundary stamps),
// so they must never pause the unattended supervisor.
function isRealUserMessage(text, options = {}) {
  if (options.unattendedSystem === true || options.system === true) return false;
  if (options.originTrigger === true || options.originContinue === true) return false;
  const value = typeof text === 'string' ? text : '';
  if (value.trimStart().startsWith(SYSTEM_PREFIX)) return false;
  let marker = '';
  try { marker = unattendedKernel.tag(); } catch (_) { marker = ''; }
  if (marker && value.includes(marker)) return false;
  return true;
}

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
    getTaskShells = () => null,
    // Unattended mode: `options.unattended` on the first message arms the
    // supervisor; every real user message only resets its stall counters.
    armUnattended = null,
    noteUnattendedUserMessage = null,
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
      ...(opts.taskShellReceiptId ? { taskShellReceiptId: opts.taskShellReceiptId,
        clientMsgId: opts.clientMsgId, receivedAt: opts.receivedAt } : {}),
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
    // Every new user/dispatch admission gets its own candidate identity even
    // when the previous task is unfinished. Classification may later re-point
    // it to an older canonical task, but persistence and the first UI frame must
    // never borrow that older task's title/id merely because it is still live.
    const generated = !detached && !requested.id
      && (options.provisional === true || !previous);
    const taskId = detached ? null : requested.id || (generated ? null : previous)
      || `tsk_${String(randomUUID()).replace(/-/g, '')}`;
    const boundaryChanged = detached || generated || (!!requested.id
      && (requested.start === true || requested.id !== previous));
    if (state) {
      state._currentTaskId = taskId || null;
    }
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

  function stampTask(sessionId, message) {
    const state = getState(sessionId);
    if (!message.taskId && state?._currentTaskId) message.taskId = state._currentTaskId;
    return state;
  }
  function projectSaved(sessionId, message, saved) {
    try {
      const board = getTaskBoard();
      if (saved && board?.onMessagePersisted) board.onMessagePersisted(sessionId, message);
    } catch (_) {
      // History was already persisted; an observer failure must not turn it
      // into a failed append and cause the caller to write the message again.
      try { console.warn('[multicc/task-context] message projection failed after append'); } catch (_) {}
    }
  }
  async function appendMessage(sessionId, message) {
    stampTask(sessionId, message);
    const saved = await append(sessionId, message);
    projectSaved(sessionId, message, saved);
    return saved;
  }

  function broadcast(sessionId, payload) {
    const state = getState(sessionId);
    if (!state) return;
    const scoped = scopeHostProviderEvent(payload);
    const event = state._currentTaskId && scoped?.taskId == null
      ? { ...scoped, taskId: state._currentTaskId }
      : scoped;
    emitClients(state.clients, event);
  }

  function runState(classifyState) {
    if (classifyState === 'A') return 'running';
    return classifyDisplay(classifyState || 'P').cardStatus;
  }

  function recordGoal(sessionName, goal, phase, state, classifyState = 'P') {
    if (!sessionName || !state?._currentTaskId) return;
    getTaskBoard()?.onClassifyGoal(sessionName, goal, phase, {
      currentUserText: state.currentUserText || '',
      taskId: state._currentTaskId,
      runState: runState(classifyState),
    });
  }

  async function recordCommanderRoute({
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
    if (state && taskId) {
      state._currentTaskId = taskId;
    }
    const deliveryKey = typeof clientMsgId === 'string' ? clientMsgId.trim().slice(0, 128) : '';
    const deduplicated = !!deliveryKey && containsDelivery(sessionName, deliveryKey);
    if (!deduplicated) {
      const saved = await appendMessage(sessionName, {
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
    const recorded = await recordCommanderRoute({
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
    if (options.unattended && typeof armUnattended === 'function') {
      // Arm before routing: the very first turn is the one whose end must be
      // judged, and shell receipt retries are idempotent (same config → no-op).
      try { armUnattended(sessionName, options.unattended, text); } catch (_) {}
    }
    // The message that carries `options.unattended` IS the start instruction
    // (the goal itself), so it must not pause the supervisor it just armed. This
    // also covers shell receipt retries, which replay the same options.
    if (!options.unattended && typeof noteUnattendedUserMessage === 'function'
        && isRealUserMessage(text, options)) {
      // Human takeover: pause the supervisor BEFORE the message is delivered, so
      // a verdict already in flight cannot answer over the human's head.
      try { noteUnattendedUserMessage(sessionName); } catch (_) {}
    }
    // `system: true` marks a supervisor-authored delivery: stamp the same 🔇
    // prefix the session-delivery boundary uses so classify/history agree that
    // this is not a user message. Never double-prefix.
    const rawText = typeof text === 'string' ? text : String(text == null ? '' : text);
    const outbound = options.system === true && !rawText.trimStart().startsWith(SYSTEM_PREFIX)
      ? `${SYSTEM_PREFIX}${rawText}`
      : rawText;
    const shells = getTaskShells();
    if (shells?.accepts?.(sessionName) && !options.taskShellReceiptId && !options.originContinue) {
      return shells.sendFromSession(sessionName, outbound, options);
    }
    // Turn-timing t0: every chat-send route (WS user_message, task-board HTTP
    // sends) funnels through here. The stamp survives the durable outbox
    // (payload.options) so runChatTurn can measure from true receipt, FIFO
    // wait included. Callers may pre-stamp an earlier instant.
    if (!Number.isFinite(options.receivedAt)) options.receivedAt = Date.now();
    const started = await runTurn(sessionName, outbound, options);
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
    guardAdmission: (...args) => getTaskShells()?.guardAdmission(...args),
    ownsTaskShell: id => getTaskShells()?.owns(id),
    requiresTaskShell: id => getTaskShells()?.accepts(id),
    dispatchTaskShell: (...args) => getTaskShells().dispatchFromSession(...args),
    sendTaskShellInput: (id, message, shellId) => getTaskShells().sendClientInput(id, message, shellId),
    taskShellChatScope: (id, sessionId) => getTaskShells().chatScope(id, sessionId),
    taskShellChatHistory: (id, options) => getTaskShells().chatHistory(id, options),
    clearTaskShellHistory: (id, sessionId, keep, options) => getTaskShells().clearChatHistory(id, sessionId, keep, options),
    watchTaskShellChat: (id, sessionId, emit) => getTaskShells().watchChatHistory(id, sessionId, emit),
    taskShellContextSeed: (id, fallback, first) => getTaskShells()?.contextSeed(id, fallback, first) ?? fallback,
    prepareTaskContext: (id, options) => getTaskShells()?.prepareContext(id, options),
    taskContextSent: (...args) => getTaskShells()?.contextSent(...args),
    taskContextComplete: (...args) => getTaskShells()?.contextComplete(...args),
    taskShellRecentTasks: (id, receiptId) => getTaskShells()?.recentTasks(id, receiptId) || [],
    taskShellContextTrace: (id, receiptId, options) => receiptId
      ? getTaskShells()?.contextTrace(id, receiptId, options) || null
      : null,
    proposeTaskSeparation: (id, receiptId, result) => getTaskShells()?.proposeSeparation(id, receiptId, result) || null,
    proposeTaskShellAttribution: (id, receiptId, result) => getTaskShells()?.proposeAttribution(id, receiptId, result) || null,
    settleTaskShellAttribution: (id, receiptId, result) => getTaskShells()?.settleAttribution(id, receiptId, result) || null,
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

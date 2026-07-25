'use strict';

const { runStateForFreezeReason } = require('./session-work-scheduler');

function requireFunction(deps, name) {
  if (typeof deps?.[name] !== 'function') {
    throw new TypeError(`[session-work-host] ${name} port is required`);
  }
}

function createSessionWorkHost(deps = {}) {
  for (const name of [
    'runtime', 'getRecord', 'getChatSession', 'getTaskState',
    'pendingUserInput', 'recordUserInput', 'broadcast', 'setTaskState',
    'onTaskBoardQueueEvent', 'classifyDisplay', 'cancelClassify',
    'assignKillReason', 'appendMessage',
  ]) requireFunction(deps, name);
  if (!deps.chatStream || typeof deps.chatStream.isAlive !== 'function'
      || typeof deps.chatStream.cancel !== 'function') {
    throw new TypeError('[session-work-host] chatStream port is required');
  }
  const log = deps.log || console;
  const turnClosures = new Map();

  function schedulerRuntime() {
    return deps.runtime();
  }

  function scheduler() {
    return schedulerRuntime()?.sessionScheduler || null;
  }

  async function admit(sessionId, text, options = {}) {
    if (!deps.getRecord(sessionId)) return { ok: false, code: 'session_not_found' };
    const closing = turnClosures.get(sessionId);
    if (closing) await closing;
    const runtime = schedulerRuntime();
    if (!runtime?.admitSessionWork || !runtime.sessionScheduler) {
      return { ok: false, code: 'scheduler_not_ready' };
    }
    const requestId = typeof options.userInputRequestId === 'string'
      ? options.userInputRequestId.trim() : '';
    const pending = requestId ? deps.pendingUserInput(sessionId) : null;
    if (requestId && (!pending || pending.requestId !== requestId || pending.resolved === true)) {
      return { ok: false, code: pending ? 'request_id_mismatch' : 'no_pending_request' };
    }
    const status = await runtime.sessionScheduler.status(sessionId);
    const source = options.taskSource
      || (options.originTrigger === true ? 'trigger'
        : options.originContinue === true ? 'continuation' : 'direct');
    const classifyState = deps.getTaskState(deps.getRecord(sessionId))?.classifyState || null;
    const waitingContinuation = !requestId
      && source === 'direct'
      && classifyState === 'W'
      && !!status?.active;
    const admitted = await runtime.admitSessionWork({
      sessionId,
      text,
      options,
      source,
      workKind: requestId ? 'answer' : waitingContinuation ? 'continuation' : null,
      requestId: requestId || null,
      activeEntryId: requestId || waitingContinuation ? status?.active?.entryId || null : null,
      idempotencyKey: options.idempotencyKey
        || options.clientMsgId || options.deliveryId || null,
    });
    if (!admitted.ok) {
      deps.broadcast(sessionId, {
        type: 'error',
        error: admitted.code === 'request_id_mismatch'
          ? '这条回答不属于当前待确认问题，未执行。'
          : `消息入队失败：${admitted.code || 'scheduler_rejected'}`,
      });
    }
    return admitted;
  }

  async function resolveTask(sessionId, taskId) {
    const runtime = schedulerRuntime();
    if (!runtime?.sessionScheduler) return { ok: false, code: 'scheduler_not_ready' };
    const queue = await runtime.sessionScheduler.status(sessionId);
    if (!queue.active) return { ok: false, code: 'no_active_task' };
    if (queue.active.taskId && queue.active.taskId !== taskId) {
      return { ok: false, code: 'active_task_mismatch' };
    }
    const result = await runtime.sessionScheduler.resolve(sessionId, {
      action: 'resolve',
      reason: 'task board explicitly marked completed',
      actor: 'user',
    });
    if (result.ok) await runtime.tick();
    return result;
  }

  function getRunState(sessionId) {
    const record = deps.getRecord(sessionId);
    if (!record) return null;
    const state = record.taskState;
    const classifyState = state?.classifyState;
    if (classifyState) {
      const cardStatus = deps.classifyDisplay(classifyState).cardStatus;
      return cardStatus === 'completed' ? 'done' : cardStatus;
    }
    if (state?.queueState === 'queued') return 'queued';
    if (state?.queueState === 'running') return 'running';
    if (state?.queueState === 'frozen') {
      // Explicit reason→state map (session-work-scheduler) — never the old
      // substring heuristic that mislabelled interruption/recovery as "waiting".
      return runStateForFreezeReason(state.queueFreezeReason);
    }
    return 'idle';
  }

  function closeTurnForClassify(sessionId, failureReason = null) {
    const operation = (async () => {
      const runtime = schedulerRuntime();
      const target = runtime?.sessionScheduler;
      if (!target || !sessionId) return { ok: false, code: 'scheduler_not_ready' };
      if (failureReason) {
        log.warn?.('session_scheduler_turn_failed_awaiting_classify', {
          sessionId,
          reason: failureReason,
        });
      }
      const current = await target.status(sessionId);
      if (!current?.active) return { ok: false, code: 'no_active_task' };
      // A durable turn boundary only asks classify for a verdict. D/W/B/E/P is
      // the sole semantic gate; transport completion must never advance FIFO.
      const result = await target.turnEnded(sessionId);
      return result;
    })();
    turnClosures.set(sessionId, operation);
    const clear = () => {
      if (turnClosures.get(sessionId) === operation) turnClosures.delete(sessionId);
    };
    operation.then(clear, clear);
    return operation;
  }

  function turnSucceeded(sessionId) {
    return closeTurnForClassify(sessionId);
  }

  function turnFailed(sessionId, reason = 'unknown_interruption') {
    return closeTurnForClassify(sessionId, reason);
  }

  // Classify is the only semantic gate for the interaction FIFO. The scheduler
  // persists ordering and active correlation, then applies exactly one of
  // D/W/B/E/P here. No delivery, liveness or process status may complete work.
  async function classifyTransition(sessionId, taskId, result = {}) {
    const runtime = schedulerRuntime();
    const target = runtime?.sessionScheduler;
    if (!target || !sessionId) return { ok: false, code: 'scheduler_not_ready' };
    try {
      const closing = turnClosures.get(sessionId);
      if (closing) await closing;
      const current = await target.status(sessionId);
      if (!current?.active || !['assessing', 'frozen'].includes(current.state)) {
        return { ok: false, code: 'stale_classification' };
      }
      const expectedTaskId = taskId || current.active.taskId || null;
      const pending = deps.pendingUserInput(sessionId);
      const classifyState = result.error ? 'E'
        : result.state === 'completed' ? 'D'
          : result.background || runtime.hasPending(sessionId) ? 'B'
            : result.state === 'waiting' ? 'W' : 'P';
      const transition = classifyState === 'D'
        ? await target.complete(sessionId, {
            expectedTaskId,
            reason: 'classified_complete',
          })
        : await target.freeze(
            sessionId,
            classifyState === 'W' ? 'classify_waiting'
              : classifyState === 'B' ? 'classify_background'
                : classifyState === 'E' ? 'classify_error' : 'classify_running',
            {
              expectedTaskId,
              classifyState,
              requestId: classifyState === 'W' && pending?.resolved !== true
                ? pending?.requestId || null : null,
            },
          );
      if (transition?.ok) await runtime.tick();
      return transition;
    } catch (error) {
      log.warn?.('session_scheduler_classification_transition_failed', {
        sessionId,
        error: error.message,
      });
      return { ok: false, code: 'classification_transition_failed' };
    }
  }

  async function classifyUnavailable(sessionId, taskId, reason) {
    log.warn?.('session_scheduler_classification_unavailable', { sessionId, reason });
    // Keep the active entry in assessing. The periodic classify loop retries P;
    // inventing a scheduler error state here would create a second authority.
    return { ok: true, deferred: true, code: 'classification_deferred', taskId: taskId || null };
  }

  function recoveryState(sessionId) {
    const state = deps.getTaskState(deps.getRecord(sessionId));
    return {
      classifyState: state.classifyState,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      taskId: deps.getChatSession(sessionId)?._currentTaskId || null,
    };
  }

  function onSchedulerEvent(event) {
    const state = event.type === 'queued'
      ? event.schedulerState === 'idle' ? 'queued' : event.schedulerState || 'queued'
      : ['started', 'claimed', 'resumed'].includes(event.type) ? 'running'
        : event.type === 'frozen' ? 'frozen'
          : event.type === 'assessing' ? 'assessing' : event.type;
    const queueState = ['queued_cancelled', 'queued_inserted'].includes(event.type)
      ? event.schedulerState || 'idle'
      : state;
    deps.broadcast(event.sessionId, {
      type: 'session_queue',
      event: event.type,
      state: queueState,
      entryId: event.entryId || null,
      taskId: event.taskId || null,
      queuePosition: event.queuePosition || null,
      workKind: event.workKind || null,
      queued: event.queued == null ? null : event.queued,
      items: Array.isArray(event.queuedItems) ? event.queuedItems : [],
      freezeReason: event.freezeReason || null,
      at: event.at,
    });
    deps.setTaskState(event.sessionId, {
      queueState,
      queueFreezeReason: event.freezeReason || null,
      queueUpdatedAt: event.at,
    });
    deps.onTaskBoardQueueEvent(event);
  }

  function recordInput(signal) {
    const recorded = deps.recordUserInput(signal);
    if (recorded.ok) {
      deps.broadcast(signal.sessionId, {
        type: 'user_input_required',
        requestId: signal.requestId,
        taskId: deps.getChatSession(signal.sessionId)?._currentTaskId || null,
        question: signal.question,
        reason: signal.reason || '',
        options: Array.isArray(signal.options) ? signal.options : [],
        allowMultiple: signal.allowMultiple === true,
      });
    }
    return recorded;
  }

  function replayState(sessionId, send) {
    const pending = deps.pendingUserInput(sessionId);
    if (pending && pending.resolved !== true) {
      send({
        type: 'user_input_required',
        requestId: pending.requestId,
        taskId: pending.taskId || null,
        question: pending.question,
        reason: pending.reason || '',
        options: pending.options || [],
        allowMultiple: pending.allowMultiple === true,
      });
    }
    Promise.resolve(scheduler()?.status(sessionId)).then(queue => {
      if (!queue) return;
      send({
        type: 'session_queue',
        event: 'snapshot',
        state: queue.state,
        queued: queue.queued.length,
        items: queue.queued,
        freezeReason: queue.freezeReason,
        active: queue.active,
      });
    }).catch(() => {});
  }

  async function cancelActiveTurn(sessionId, { resolveQueue = false } = {}) {
    const state = deps.getChatSession(sessionId);
    if (!state) return { ok: false, code: 'chat_state_not_found' };
    deps.cancelClassify(state);
    if (state.cli === 'claude' && deps.chatStream.isAlive(sessionId)) {
      log.log?.(`[multicc/chat] [${sessionId}] (streaming) cancel requested by user`);
      deps.assignKillReason(state._activeRunner, 'user_cancel');
      deps.chatStream.cancel(sessionId);
      state.isStreaming = false;
      state.streamReplay = [];
    }
    if (state.claudeProc) {
      log.log?.(`[multicc/chat] [${sessionId}] Cancel requested by user, killing child process`);
      deps.assignKillReason(state._activeRunner, 'user_cancel');
      try { state.claudeProc.kill('SIGTERM'); } catch (_) {}
      state.claudeProc = null;
      state.lineBuf = '';
      state.isStreaming = false;
      state.streamReplay = [];
    }
    if (state.currentAssistantText || state.currentToolCalls.length) {
      deps.appendMessage(sessionId, {
        role: 'assistant',
        content: state.currentAssistantText,
        tools: state.currentToolCalls.length ? state.currentToolCalls : undefined,
        ts: Date.now(),
        cancelled: true,
      });
      state.currentAssistantText = '';
      state.currentToolCalls = [];
    }
    if (!resolveQueue || !scheduler()) return { ok: true };
    const runtime = schedulerRuntime();
    const resolved = await runtime.sessionScheduler.resolve(sessionId, {
      action: 'cancel',
      reason: 'explicit user cancellation',
      actor: 'user',
    });
    if (resolved.ok) await runtime.tick();
    return resolved;
  }

  return Object.freeze({
    admit,
    cancelActiveTurn,
    classifyTransition,
    classifyUnavailable,
    getRunState,
    onSchedulerEvent,
    recordInput,
    recoveryState,
    replayState,
    resolveTask,
    turnFailed,
    turnSucceeded,
  });
}

module.exports = { createSessionWorkHost };

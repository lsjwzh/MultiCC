'use strict';

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

  function schedulerRuntime() {
    return deps.runtime();
  }

  function scheduler() {
    return schedulerRuntime()?.sessionScheduler || null;
  }

  async function admit(sessionId, text, options = {}) {
    if (!deps.getRecord(sessionId)) return { ok: false, code: 'session_not_found' };
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
    const admitted = await runtime.admitSessionWork({
      sessionId,
      text,
      options,
      source: options.taskSource
        || (options.originTrigger === true ? 'trigger'
          : options.originContinue === true ? 'continuation' : 'direct'),
      workKind: requestId ? 'answer' : null,
      requestId: requestId || null,
      activeEntryId: requestId ? status?.active?.entryId || null : null,
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
    if (state?.queueState === 'queued') return 'queued';
    if (state?.queueState === 'running') return 'running';
    if (state?.queueState === 'frozen') {
      return String(state.queueFreezeReason || '').includes('error') ? 'error' : 'waiting';
    }
    const classifyState = state?.classifyState;
    if (!classifyState) return 'idle';
    if (classifyState === 'A') return 'running';
    const cardStatus = deps.classifyDisplay(classifyState).cardStatus;
    return cardStatus === 'completed' ? 'done' : cardStatus;
  }

  async function turnSucceeded(sessionId) {
    const runtime = schedulerRuntime();
    const target = runtime?.sessionScheduler;
    if (!target || !sessionId) return { ok: false, code: 'scheduler_not_ready' };
    const current = await target.status(sessionId);
    if (!current?.active) return { ok: false, code: 'no_active_task' };
    const pending = deps.pendingUserInput(sessionId);
    const result = pending && pending.resolved !== true
      ? await target.freeze(sessionId, 'awaiting_user_input', {
          requestId: pending.requestId,
        })
      : runtime.hasPending(sessionId)
        ? await target.freeze(sessionId, 'awaiting_callback')
        : await target.complete(sessionId, { reason: 'durable_turn_completed' });
    if (result?.ok) await runtime.tick();
    return result;
  }

  async function turnFailed(sessionId, reason = 'unknown_interruption') {
    const target = scheduler();
    if (!target || !sessionId) return { ok: false, code: 'scheduler_not_ready' };
    return target.freeze(sessionId, reason);
  }

  // Aux classification owns task/card semantics only. It must never gate the
  // interaction FIFO: W means the provider turn already ended and is waiting
  // for the next user message, which is exactly the queue head we must deliver.
  function classifyTransition() {}

  function classifyUnavailable(sessionId, _taskId, reason) {
    log.warn?.('session_scheduler_classification_unavailable', { sessionId, reason });
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
        : event.type === 'frozen' ? 'frozen' : event.type;
    deps.broadcast(event.sessionId, {
      type: 'session_queue',
      event: event.type,
      state,
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
      queueState: state,
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

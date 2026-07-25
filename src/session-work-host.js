'use strict';

const { runStateForFreezeReason } = require('./session-work-scheduler');
const zcodeAuth = require('./cli-adapters/zcode-auth');

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
    'assignKillReason', 'appendMessage', 'cancelPreparation',
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
    // Force-insert ("强行插入"): interrupt the active turn first — it ends as E
    // (abnormal termination), releasing the slot. This admit then lands on a
    // non-P session and runs immediately via directRun. Silent per design (the
    // interrupted turn just shows E in the status bar).
    if (options.interrupt) {
      const rt = schedulerRuntime();
      if (rt?.sessionScheduler && (await rt.sessionScheduler.status(sessionId))?.active) {
        await cancelActiveTurn(sessionId);
      }
    }
    // L4: ZCode auth pre-check -- if the session is a zcode session and auth
    // is not configured (and can't be auto-synced from desktop), reject with
    // configuration_required instead of letting the turn fail with a cryptic
    // API error. This is a user-actionable state, not a transient fault.
    const sessionRecord = deps.getRecord(sessionId);
    if (sessionRecord && sessionRecord.cli === 'zcode') {
      const authCheck = zcodeAuth.ensureZcodeAuth();
      if (!authCheck.ok) {
        deps.broadcast(sessionId, {
          type: 'error',
          error: authCheck.message || 'ZCode 尚未配置 API Key。',
          code: 'configuration_required',
        });
        return { ok: false, code: 'configuration_required', message: authCheck.message };
      }
    }
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
    // Only PROCESS (P) stages typed chat input behind the active turn. In every
    // other classify state a typed message is an immediate, correlated
    // continuation of the current native conversation.
    const directContinuation = !requestId
      && source === 'direct'
      && classifyState !== 'P'
      && !!status?.active;
    const admission = {
      sessionId,
      text,
      options,
      source,
      workKind: requestId ? 'answer' : directContinuation ? 'continuation' : null,
      requestId: requestId || null,
      activeEntryId: requestId || directContinuation ? status?.active?.entryId || null : null,
      idempotencyKey: options.idempotencyKey
        || options.clientMsgId || options.deliveryId || null,
    };
    let admitted = await runtime.admitSessionWork(admission);
    // D may clear the active pointer between status() and admission. Nothing was
    // persisted on this rejection, so retry once as fresh immediate work.
    if (!admitted.ok && directContinuation && admitted.code === 'no_active_task') {
      admitted = await runtime.admitSessionWork({
        ...admission,
        workKind: null,
        activeEntryId: null,
      });
    }
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
      // result.state is the letter (D/W/B/E/P) — single source. hasPending can
      // still force B (an unresolved structured question waits on callback).
      const resultLetter = result?.state || 'W';
      const classifyState = resultLetter === 'E' ? 'E'
        : resultLetter === 'D' ? 'D'
          : resultLetter === 'B' || runtime.hasPending(sessionId) ? 'B'
            : 'W';   // W, or P-misjudged-at-turn-end → at-rest
      // Queue rule: P enqueues, D drains, W/B/E leave the FIFO alone. Every
      // turn-end verdict releases the active slot via complete(); FIFO draining
      // is gated by classifyState==='D' inside selectSessionItem. No classify freeze.
      const transition = await target.complete(sessionId, {
        expectedTaskId,
        reason: `classified_${classifyState}`,
        classifyState,
      });
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

  async function cancelActiveTurn(sessionId, {
    resolveQueue = false,
    reason = 'user_cancelled',
    killReason = 'user_cancel',
  } = {}) {
    const record = deps.getRecord(sessionId);
    if (!record) return { ok: false, code: 'session_not_found' };
    // This write is deliberately the first mutation: setTaskState persists and
    // broadcasts synchronously, so every cancel surface flips the classify bar
    // to E before process shutdown or scheduler I/O can delay the response.
    deps.setTaskState(sessionId, {
      classifyState: 'E',
      endedAt: Date.now(),
      cancelledAt: Date.now(),
      cancelReason: reason,
    });
    const state = deps.getChatSession(sessionId);
    deps.cancelPreparation(sessionId, reason);
    if (state) {
      deps.cancelClassify(state);
      deps.assignKillReason(state._activeRunner, killReason);
      if (state.cli === 'claude' && deps.chatStream.isAlive(sessionId)) {
        log.log?.(`[multicc/chat] [${sessionId}] (streaming) cancel requested (${reason})`);
        deps.chatStream.cancel(sessionId);
      }
      if (state.claudeProc) {
        log.log?.(`[multicc/chat] [${sessionId}] Cancel requested (${reason}), killing child process`);
        try { state.claudeProc.kill('SIGTERM'); } catch (_) {}
        state.claudeProc = null;
        state.lineBuf = '';
      }
      state.isStreaming = false;
      state.streamReplay = [];
      const tools = Array.isArray(state.currentToolCalls) ? state.currentToolCalls : [];
      if (state.currentAssistantText || tools.length) {
        deps.appendMessage(sessionId, {
          role: 'assistant',
          content: state.currentAssistantText || '',
          tools: tools.length ? tools : undefined,
          ts: Date.now(),
          cancelled: true,
        });
        state.currentAssistantText = '';
        state.currentToolCalls = [];
      }
    }
    if (!scheduler()) return { ok: true };
    const runtime = schedulerRuntime();
    // User cancellation is an abnormal termination → verdict E, active slot
    // released. FIFO is left untouched (E doesn't drain, per the state machine).
    // The killed proc's close handler later finds no active entry and no-ops, so
    // this E verdict is the one that sticks (LLM classify is bypassed).
    const completed = await runtime.sessionScheduler.complete(sessionId, {
      reason,
      classifyState: 'E',
    });
    if (completed.ok) await runtime.tick();
    // A stale persisted P can have no active scheduler entry. The synchronous E
    // write above still repaired it, so cancellation is successful/idempotent.
    if (!completed.ok && completed.code === 'no_active_task') {
      return { ok: true, alreadyIdle: true };
    }
    return completed.ok ? { ok: true } : completed;
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

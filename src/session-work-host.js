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
    // classify owns every business-state transition, including cancellation.
    'dispatchStateAction',
  ]) requireFunction(deps, name);
  if (!deps.chatStream || typeof deps.chatStream.isAlive !== 'function'
      || typeof deps.chatStream.cancel !== 'function') {
    throw new TypeError('[session-work-host] chatStream port is required');
  }
  const log = deps.log || console;
  const zcodeAuthRuntime = deps.zcodeAuth || zcodeAuth;
  if (typeof zcodeAuthRuntime.ensureZcodeAuth !== 'function') {
    throw new TypeError('[session-work-host] zcodeAuth.ensureZcodeAuth is required');
  }
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
        await cancelActiveTurn(sessionId, { source: 'force_insert', reason: 'force_insert' });
      }
    }
    // ZCode native auth pre-check. A selected MultiCC Provider materializes its
    // own isolated config and bypasses this gate; provider-less sessions follow
    // ZCode's official/native Coding Plan or API-key config.
    const sessionRecord = deps.getRecord(sessionId);
    if (sessionRecord && sessionRecord.cli === 'zcode') {
      const authCheck = zcodeAuthRuntime.ensureZcodeAuth(sessionRecord);
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
    const admissionOptions = requestId && pending?.taskId && !options.taskId
      ? { ...options, taskId: pending.taskId }
      : options;
    const admission = {
      sessionId,
      text,
      options: admissionOptions,
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

  // Admission asks one question: is this session's work still in flight? The
  // answer is a classify verdict qualified by the scheduler queue — never a
  // liveness observation (isStreaming / claudeProc / proxy activity). Liveness
  // may only be read by the shutdown drain, which cannot wait on classify
  // because classify is produced by the very Aux queue the drain is draining.
  //
  // The 'assessing' carve-out is load-bearing: a turn that ends while Aux is
  // unhealthy keeps classifyState 'P' forever (classifyUnavailable defers by
  // design, scanAndReclassify bails on an unhealthy Aux, and the process
  // watchdog deliberately skips 'assessing'). Reading that stuck P as busy
  // would wedge every dispatch for the whole outage. 'assessing' means the
  // runner is already gone and only the verdict is outstanding, so it is not
  // busy — and a fresh turn always moves the queue off 'assessing' first.
  function isRunActive(sessionId) {
    const state = deps.getRecord(sessionId)?.taskState;
    if (!state) return false;
    if (state.queueState === 'assessing') return false;
    const runState = getRunState(sessionId);
    // `queued` is admission state, not native-run liveness. Treating it as
    // busy deadlocks the outbox item that produced the queued projection: the
    // delivery worker sees its own queue row and defers forever. A claimed or
    // started entry emits `running`, which remains the actual busy boundary.
    return runState === 'running';
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

  // classify's dispatchStateAction is synchronous and starts the transition
  // without awaiting it. Keeping the in-flight promise here lets the cancel path
  // await the *same* transition, so a cancel never replies (or reconciles the
  // projection) while the scheduler mutation is still half-applied.
  const pendingTransitions = new Map();

  // Classify is the only semantic gate for the interaction FIFO. The scheduler
  // persists ordering and active correlation, then applies exactly one of
  // D/W/B/E/P here. No delivery, liveness or process status may complete work.
  function classifyTransition(sessionId, taskId, result = {}) {
    const operation = runClassifyTransition(sessionId, taskId, result);
    if (sessionId) {
      pendingTransitions.set(sessionId, operation);
      const clear = () => {
        if (pendingTransitions.get(sessionId) === operation) pendingTransitions.delete(sessionId);
      };
      operation.then(clear, clear);
    }
    return operation;
  }

  async function runClassifyTransition(sessionId, taskId, result = {}) {
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
      const pendingInput = deps.pendingUserInput(sessionId);
      // Queue rule: P enqueues, D drains, W/B/E leave the FIFO alone. Every
      // turn-end verdict releases the active slot via complete(); FIFO draining
      // is gated by classifyState==='D' inside selectSessionItem. No classify freeze.
      const completeOptions = {
        expectedTaskId,
        reason: `classified_${classifyState}`,
        classifyState,
      };
      if (pendingInput && pendingInput.resolved !== true) {
        completeOptions.awaitingRequestId = pendingInput.requestId;
      }
      const transition = await target.complete(sessionId, completeOptions);
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

  // ── Cancellation ──────────────────────────────────────────────────────────
  // A cancel is an *intent*, not a state write. This function may do exactly two
  // things: stop the real runner (process / stream / preparation), and submit a
  // structured result to classify. classify is the sole writer of the session's
  // business state, so there is one transition, one persistence point and one
  // broadcast chain — the same ones a normal turn end uses.
  //
  // The pre-2026-07 shape wrote `setTaskState({classifyState:'E'})` here AND
  // called scheduler.complete(). Two writers, two fan-outs: the chat bar saw the
  // task_state broadcast while the task board only learned about it through the
  // scheduler event — and when there was no active entry, not at all. That is
  // where 「内部 error / 外部 running」 came from.

  const RUNNER_STOP_TIMEOUT_MS = Number.isFinite(deps.runnerStopTimeoutMs)
    ? Number(deps.runnerStopTimeoutMs)
    : 5_000;
  const RUNNER_STOP_POLL_MS = 25;
  // In-flight + recently-settled cancels, keyed by sessionId. Repeated clicks,
  // HTTP retries and simultaneous Web/App cancels all join the same operation
  // instead of killing twice or writing history twice.
  const cancelOperations = new Map();

  function runnerStopped(sessionId) {
    const state = deps.getChatSession(sessionId);
    if (!state) return true;
    if (state.isStreaming) return false;
    if (state.claudeProc) return false;
    if (state.cli === 'claude' && deps.chatStream.isAlive(sessionId)) return false;
    return true;
  }

  async function awaitRunnerStop(sessionId, timeoutMs = RUNNER_STOP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!runnerStopped(sessionId)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, RUNNER_STOP_POLL_MS));
    }
    return true;
  }

  // Ask the runner to stop. Side effects here are process/transport only — no
  // business state is touched.
  function stopRunner(sessionId, reason, killReason) {
    const state = deps.getChatSession(sessionId);
    deps.cancelPreparation(sessionId, reason);
    if (!state) return;
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
    // Persisting the partial reply is transcript bookkeeping, not status, and it
    // is guarded by the in-flight map above so a double cancel cannot write the
    // same partial twice.
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

  // Already terminal *because of a cancel* — a repeat click has nothing left to
  // transition. It still gets a projection re-publish (see below) so a card that
  // drifted out of sync is repaired rather than left stale.
  function alreadyCancelled(sessionId) {
    const taskState = deps.getTaskState(deps.getRecord(sessionId)) || {};
    return taskState.classifyState === 'E' && !!taskState.cancelledAt;
  }

  async function runCancel(sessionId, intent) {
    const { reason, killReason, source, operationId, requestedAt } = intent;
    stopRunner(sessionId, reason, killReason);
    const stopped = await awaitRunnerStop(sessionId);
    if (!stopped) {
      log.warn?.('session_cancel_runner_stop_timeout', { sessionId, source, operationId });
    }
    // Park the scheduler entry on the same boundary a normal turn end uses, so
    // classifyTransition sees `assessing` and can apply its verdict. Absent an
    // active entry this is a no-op and classify still repairs the persisted state.
    let closed = { ok: false, code: 'no_active_task' };
    if (scheduler()) {
      try { closed = await closeTurnForClassify(sessionId, reason); }
      catch (_) { closed = { ok: false, code: 'turn_close_failed' }; }
    }
    const state = deps.getChatSession(sessionId);
    const taskState = deps.getTaskState(deps.getRecord(sessionId)) || {};
    const taskId = state?._currentTaskId || null;
    // The structured cancel result. `state: 'E'` is the existing canonical
    // abnormal-end letter — a cancel does not get a private terminal value, and
    // a failed stop is an error for the same reason (the turn did not end
    // cleanly), distinguished by cancelReason rather than by a new enum member.
    const result = {
      state: 'E',
      goal: taskState.goal || '',
      phase: taskState.phase || '',
      cancel: {
        source,
        operationId,
        requestedAt,
        at: Date.now(),
        taskId,
        reason: stopped ? reason : 'cancel_stop_timeout',
        runnerStopped: stopped,
      },
    };
    deps.dispatchStateAction(result, {
      sessionName: sessionId,
      sessionId: deps.getRecord(sessionId)?.id || sessionId,
      cs: state || null,
      isTerminal: deps.getRecord(sessionId)?.kind !== 'chat',
    });
    // dispatchStateAction returns before the scheduler transition it started has
    // settled. Awaiting it here is what makes the cancel reply, the reconcile
    // below and every projection observe one finished transition instead of a
    // race between the verdict and the slot release.
    try { await pendingTransitions.get(sessionId); } catch (_) {}
    // Requirement: re-publish the canonical snapshot even when the computed
    // terminal state equals the persisted one — a cancel that found no active
    // entry produces no scheduler event, and that silence is exactly how a card
    // stayed on `running`. Goes through the board's own reducer, not a
    // hand-assembled second broadcast.
    if (taskId && typeof deps.reconcileTaskProjection === 'function') {
      try { deps.reconcileTaskProjection(taskId, { classifyState: 'E', reason: result.cancel.reason }); }
      catch (error) { log.warn?.('session_cancel_reconcile_failed', { sessionId, error: error.message }); }
    }
    if (!stopped) {
      return {
        ok: false,
        code: 'runner_stop_timeout',
        classifyState: 'E',
        operationId,
        cancelReason: result.cancel.reason,
      };
    }
    return {
      ok: true,
      classifyState: 'E',
      operationId,
      alreadyIdle: !closed.ok && closed.code === 'no_active_task',
    };
  }

  async function cancelActiveTurn(sessionId, {
    // Kept for call-site compatibility. Queue policy is unchanged by a cancel:
    // the E verdict releases the active slot and, per the state machine, only D
    // drains the FIFO. A cancel never advances the next queued item.
    resolveQueue = false,          // eslint-disable-line no-unused-vars
    reason = 'user_cancelled',
    killReason = 'user_cancel',
    source = 'manual_cancel',
    operationId = null,
  } = {}) {
    const record = deps.getRecord(sessionId);
    if (!record) return { ok: false, code: 'session_not_found' };
    const inFlight = cancelOperations.get(sessionId);
    // Idempotency: a second intent while one is running is the same effective
    // transition. It joins the running one — no second kill, no second history
    // write, no second verdict.
    if (inFlight) return inFlight.promise.then(result => ({ ...result, deduplicated: true }));
    if (alreadyCancelled(sessionId) && runnerStopped(sessionId)) {
      const taskId = deps.getChatSession(sessionId)?._currentTaskId || null;
      if (taskId && typeof deps.reconcileTaskProjection === 'function') {
        try { deps.reconcileTaskProjection(taskId, { classifyState: 'E', reason: 'cancel_repeat' }); }
        catch (_) {}
      }
      return { ok: true, alreadyCancelled: true, classifyState: 'E', operationId };
    }
    const intent = {
      reason,
      killReason,
      source: String(source || 'manual_cancel'),
      operationId: operationId ? String(operationId).slice(0, 128) : null,
      requestedAt: Date.now(),
    };
    const promise = runCancel(sessionId, intent);
    cancelOperations.set(sessionId, { promise, intent });
    const clear = () => {
      if (cancelOperations.get(sessionId)?.promise === promise) cancelOperations.delete(sessionId);
    };
    promise.then(clear, clear);
    return promise;
  }

  return Object.freeze({
    admit,
    cancelActiveTurn,
    classifyTransition,
    classifyUnavailable,
    getRunState,
    isRunActive,
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

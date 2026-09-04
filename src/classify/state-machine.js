'use strict';

const { SYSTEM_PREFIX } = require('../session-delivery');

// Classify state machine: the unified classify loop that decides goal/phase and
// the D/C/W/B/E/P letter for every chat session. Owns the turn-end hook, the
// 60s periodic scan (with its decision history ring), the current-task model,
// and the user-facing notify/outcome broadcasts.
//
// Extracted verbatim from server.js. Behaviour is preserved exactly; host state
// is reached through injected getters or function wrappers only — auxQueue,
// sessionWorkHost, taskContextHost, taskBoardRuntime, userInputSignalHost and
// the push/broadcast helpers are all host bindings resolved after this factory
// runs (getters) or functions that resolve their own late-bound dependencies
// per call (wrappers). TASK_STATE_DEFAULTS / getTaskState / setTaskState stay
// in server.js (shared with the chat turn engine) and arrive here by reference.

const crypto = require('crypto');
const {
  classifyDisplay,
  phaseLabel,
} = require('./vocab');
const { taskShortCode } = require('./task-short-code');
const { deriveTaskTitle, PENDING_TASK_TITLE } = require('../task-board');
const {
  buildTaskAttributionConversation,
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  recentTaskContext,
} = require('./task-attribution');
const { resolveTurnState } = require('./turn-state');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[classify-state-machine] ${name} must be a function`);
  }
}

function completionVoiceMessage(shortCode, goal) {
  const code = String(shortCode || '').trim();
  const taskGoal = String(goal || '').trim();
  const identity = [code ? `任务 ${code}` : '', taskGoal].filter(Boolean).join('，');
  return identity ? `${identity}，本轮执行成功` : '本轮执行成功';
}

function createClassifyStateMachine(rawDeps) {
  const deps = rawDeps || {};
  const {
    persistedSessions,
    chatSessions,
    getSessionSummaries,
    logger,
    getAuxQueue,
    getSessionWorkHost,
    getLivenessRuntime,
    getTaskContextHost,
    getTaskBoardRuntime,
    getUserInputSignalHost,
    getApiErrorHost,
    getWaitInjector,
    setTaskState,
    getTaskState,
    setSessionSummary,
    setSessionStatus,
    chatBroadcast,
    workspaceBroadcast,
    terminalBroadcast,
    triggerPush,
    evaluateTurnApiError,
    turnHasSideEffects,
    retryNotice,
    loadChatHistory,
    // Classify only ever reads the transcript — it pulls the last assistant
    // reply and builds a prompt string out of recent turns. Cloning every
    // session's history once per scan, purely to read a few fields off the end
    // of it, is the most expensive thing the scan does. Defaults to
    // loadChatHistory so an older host composition still works.
    viewChatHistory = loadChatHistory,
    appendChatMessage,
    // Atomically stamps the messages belonging to one completed turn with the
    // canonical task identity and the Aux run that attributed them.
    annotateChatTurn = () => [],
    // Aux evidence sink. Defaults to a no-op so a host composition that predates
    // provenance still builds and every test stays off the real filesystem; the
    // server wires the JSONL-backed log in explicitly. Recording is diagnostic,
    // so a missing sink degrades observability and nothing else.
    getAuxRunLog = () => ({ record: () => null }),
    // Structured background-task ownership. Optional for older hosts/tests;
    // production wires the authoritative background runtime.
    hasBackgroundPending = () => false,
  } = deps;

  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[classify-state-machine] persistedSessions map is required');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[classify-state-machine] chatSessions map is required');
  }
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('[classify-state-machine] logger.info is required');
  }
  for (const [fn, name] of [
    [getAuxQueue, 'getAuxQueue'], [getSessionWorkHost, 'getSessionWorkHost'],
    [getLivenessRuntime, 'getLivenessRuntime'],
    [getTaskContextHost, 'getTaskContextHost'], [getTaskBoardRuntime, 'getTaskBoardRuntime'],
    [getUserInputSignalHost, 'getUserInputSignalHost'], [getApiErrorHost, 'getApiErrorHost'],
    [getWaitInjector, 'getWaitInjector'], [setTaskState, 'setTaskState'],
    [getTaskState, 'getTaskState'], [setSessionSummary, 'setSessionSummary'],
    [setSessionStatus, 'setSessionStatus'], [chatBroadcast, 'chatBroadcast'],
    [workspaceBroadcast, 'workspaceBroadcast'], [terminalBroadcast, 'terminalBroadcast'],
    [triggerPush, 'triggerPush'], [evaluateTurnApiError, 'evaluateTurnApiError'],
    [turnHasSideEffects, 'turnHasSideEffects'], [retryNotice, 'retryNotice'],
    [loadChatHistory, 'loadChatHistory'], [appendChatMessage, 'appendChatMessage'],
    [getSessionSummaries, 'getSessionSummaries'],
  ]) assertFunction(fn, name);

  // Map rule-resolved turn states to their runtime actions.

  function recordTaskBoardGoal(sessionName, goal, phase, cs, classifyState = 'P') {
    getTaskContextHost().recordGoal(sessionName, goal, phase, cs, classifyState);
  }

  // Structured turn rules own the letter; liveness validates whether that
  // verdict may commit. The shared runtime returns active/inactive/unknown so
  // missing or contradictory ownership facts fail closed instead of masquerading
  // as an ended turn.
  function turnLivenessForClassify(sessionName) {
    try {
      const value = getLivenessRuntime().ownership(sessionName);
      if (value && ['active', 'inactive', 'unknown'].includes(value.state)) return value;
    } catch (_) {}
    return { state: 'unknown', reason: 'liveness_unavailable' };
  }

  function dispatchStateAction(result, ctx) {
    const { state, goal, phase } = result;
    // The letter IS the state (single source). Derive the legacy error/background
    // flags locally so the W/B/E branches below read naturally; future tranches
    // drop them entirely. No other module derives these from a word+flags shape.
    const error = state === 'E';
    const background = state === 'B';
    // An explicit cancellation arrives here as a structured result rather than a
    // ordinary rule verdict: same letter, same transition, same writer — the extra
    // envelope only records who asked and whether the runner actually stopped.
    const cancel = result.cancel && typeof result.cancel === 'object' ? result.cancel : null;
    const { sessionName, sessionId, cs, isTerminal, source } = ctx;
    const liveness = ctx.liveness || turnLivenessForClassify(sessionName);

    // ── Classify history (persisted, last 7 days) ────────────────────────
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    // Turn-state history contains only structured rule evidence. Aux provenance
    // lives on messages and in aux-run-log, never on a state transition.
    const persisted = persistedSessions.get(sessionName);
    // Carry the task identity onto the history row so any surface (e.g. the
    // Commander roster) can render this past task's stable `#CODE` handle.
    const entryTaskId = Object.prototype.hasOwnProperty.call(ctx, 'taskId')
      ? ctx.taskId || null
      : cs?._currentTaskId || persisted?.taskState?.taskId || null;
    const entry = { at: now, goal: goal || '', taskId: entryTaskId,
      phase: phase || '', state, error: !!error, evidence: result.evidence || undefined };
    if (persisted) {
      const ts = persisted.taskState || {};
      const hist = (Array.isArray(ts.classifyHistory) ? ts.classifyHistory : [])
        .filter(e => e.at > now - SEVEN_DAYS_MS);
      hist.push(entry);
      ts.classifyHistory = hist;
      persisted.taskState = ts;
    }

    // ── Common: persist goal + phase ────────────────────────────────────
    if (cs && cs.currentTask) {
      cs.currentTask.goal = (goal && goal !== '—') ? goal : '';
      if (phase) cs.currentTask.phase = phase;
    }
    const finalGoal = (cs && cs.currentTask) ? cs.currentTask.goal : goal;
    const finalPhase = (cs && cs.currentTask) ? cs.currentTask.phase : phase;
    // Persist BOTH goal and phase (was goal-only, leaving phase stale).
    if (sessionName) setTaskState(sessionName, finalPhase ? { goal: finalGoal || '', phase: finalPhase } : { goal: finalGoal || '' });
    if (sessionId && finalGoal) setSessionSummary(sessionId, finalGoal);

    recordTaskBoardGoal(sessionName, finalGoal, finalPhase, cs, state);

    // An active/unknown owner holds a stale close candidate. Turn-end owns state
    // and side effects; persisting it early would poison scheduler guards.
    // A cancel is exempt: it *is* the turn boundary, and the runner it stopped
    // may not have flipped isStreaming yet on every adapter.
    if (liveness.state !== 'inactive' && state !== 'P' && !cancel) {
      console.log(`[multicc/scan] ${sessionName} classify candidate held: state=${state}, liveness=${liveness.state}/${liveness.reason || 'unknown'}`);
      return;
    }

    // ── Dispatch per state ──────────────────────────────────────────────
    if (state === 'P') {
      // P — still processing. Two sub-cases:
      if (cs && cs.isStreaming) {
        // (1) Genuinely mid-turn (a turn IS in flight) — just refresh labels.
        const ph = phaseLabel(phase);
        const label = finalGoal ? `处理中：${finalGoal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
        emitRunningNotify(sessionName, label);
        return;
      }
      // (2) P but no turn in flight. The runner boundary owns the sole bounded
      // unknown-error retry. Classify only reflects the exhausted/waiting state;
      // it must not open a second resume loop.
      logger.info('api_error_classifier_interrupted_observed', {
        sessionId: sessionName,
        provider: persisted?.cli || 'unknown',
        policyAction: cs?._lastApiErrorDecision?.action || 'fail_fast',
      });
      // Fall through to the waiting broadcast.
    }

    const transitionTaskId = Object.prototype.hasOwnProperty.call(ctx, 'taskId')
      ? ctx.taskId || null
      : cs?._currentTaskId || null;
    const transition = getSessionWorkHost().classifyTransition(
      sessionName,
      transitionTaskId,
      result,
      {
        recoverMissingBoundary: source === 'multicc/scan' && liveness.state === 'inactive',
        livenessReason: liveness.reason || null,
      },
    );
    Promise.resolve(transition).then(outcome => {
      if (outcome?.ok !== false || outcome.code === 'stale_classification') return;
      logger.warn?.('session_scheduler_classification_rejected', {
        sessionId: sessionName,
        taskId: transitionTaskId,
        code: outcome.code || 'unknown',
      });
    }, error => {
      logger.warn?.('session_scheduler_classification_rejected', {
        sessionId: sessionName,
        taskId: transitionTaskId,
        code: 'transition_rejected',
        error: error?.message || String(error || ''),
      });
    });
    if (state === 'D') {
      // D — this turn executed successfully. TaskBoard completion is a separate
      // user-owned lifecycle action and is never inferred here.
      const msg = finalGoal ? `执行成功：${finalGoal}` : '执行成功';
      const completionTaskId = transitionTaskId || entryTaskId;
      const completionTaskShortCode = taskShortCode(completionTaskId);
      const completionNotice = {
        type: 'notify', state: 'succeeded', classifyState: 'D', message: msg,
        taskShortCode: completionTaskShortCode,
        taskGoal: finalGoal || '',
        voiceMessage: completionVoiceMessage(completionTaskShortCode, finalGoal),
      };
      if (isTerminal) {
        triggerPush(sessionId, 'succeeded', msg);
        terminalBroadcast(sessionId, completionNotice);
      } else {
        triggerPush(sessionId, 'succeeded', `[Chat] ${msg}`);
        chatBroadcast(sessionName, completionNotice);
      }
      const dirId = persistedSessions.get(sessionName)?.dirId;
      if (dirId) workspaceBroadcast(dirId, { ...completionNotice, sessionId });
      setSessionStatus(sessionName, { status: 'succeeded' });
      // D triggers no later state write, so persist it immediately. Otherwise a
      // crash before the next durable operation restores a stale P/W/E snapshot.
      setTaskState(sessionName, { classifyState: 'D', endedAt: Date.now() });
      getWaitInjector().resetAuto(sessionName);
      // Clear the resume-interrupted counter so any future P-misclassify restarts from
      // count=1 rather than compounding on this concluded task. (Note: this clears the
      // counter only — it can't cancel an already-scheduled inject setTimeout; that
      // window is tiny and separate.)
      getWaitInjector().resetInterrupted(sessionName);
      return;
    }

    // C (Continue) is RETIRED: parseClassifyResult now collapses C→W, so
    // state === 'continue' can no longer occur. The old branch persisted C +
    // parked the CLI idle while showing a phantom "running" card that scan could
    // never flush. A C-judged turn now falls straight through to the W path below
    // (cls = 'W'), which is exactly the 2026-07-12 "C rests as W" design intent.

    // ── W / B / E (plus exhausted P recovery) → waiting (user-facing) ───────

    // E is now display/classification only. The runner boundary already called
    // the centralized API policy, which either scheduled one bounded safe retry
    // or failed fast. Classify must never create a second retry channel.
    // A user pressing Cancel is not an API fault: running the API-error policy
    // would log a phantom provider failure and offer a retry for something the
    // user deliberately stopped.
    if (error && !cancel) {
      if (!cs?._lastApiErrorDecision) {
        evaluateTurnApiError({
          sessionName,
          cs,
          persisted,
          turn: cs?._activeTurn,
          runner: cs?._activeRunner,
          raw: {
            source: 'classifier_legacy',
            provider: persisted?.cli || 'unknown',
            code: 'classifier_api_error',
            message: 'classifier reported an API error without structured provider evidence',
          },
          attempt: cs?._apiRetryAttempt || 0,
          phase: 'stream',
          partialOutput: true,
          sideEffects: turnHasSideEffects(cs),
        });
      }
      logger.info('api_error_classifier_observed', {
        sessionId: sessionName,
        provider: persisted?.cli || 'unknown',
        policyAction: cs?._lastApiErrorDecision?.action || 'fail_fast',
      });
    }

    // Common waiting-state broadcast — driven by classifyState letter.
    // state is already the letter (W/B/E, or P falling through when exhausted);
    // preserve the old P-fallthrough→W rendering to avoid a behavior shift here.
    const cls = state === 'P' ? 'W' : state;
    const disp = classifyDisplay(cls);
    const pushType = disp.pushType || 'waiting';  // C/P have null pushType → default 'waiting'
    const policyMessage = error && cs?._lastApiErrorDecision
      ? retryNotice(cs._lastApiErrorDecision) : '';
    const cancelMsg = !cancel ? ''
      : cancel.runnerStopped === false ? '取消失败：任务未能停止'
        : cancel.superseded === true ? '已切换到立即发送的消息'
        : finalGoal ? `已取消：${finalGoal}` : '任务已取消';
    const waitMsg = cancelMsg || (error ? (policyMessage || 'API 异常，未自动重试')
      : finalGoal ? `等待：${finalGoal}` : '等待交互');
    // The user just pressed Cancel — they are looking at the screen. Broadcast
    // (drives the bar and every card) but no lock-screen push.
    if (isTerminal) {
      if (!cancel) triggerPush(sessionId, pushType, waitMsg);
      terminalBroadcast(sessionId, { type: 'notify', state: pushType, classifyState: cls, message: waitMsg });
    } else {
      if (!cancel) triggerPush(sessionId, pushType, `[Chat] ${waitMsg}`);
      chatBroadcast(sessionName, { type: 'notify', state: pushType, classifyState: cls, message: waitMsg });
    }
    const dirId2 = persistedSessions.get(sessionName)?.dirId;
    if (dirId2) workspaceBroadcast(dirId2, { type: 'notify', sessionId, state: pushType, classifyState: cls, message: waitMsg });
    setSessionStatus(sessionName, { status: 'waiting' });
    // Persist the accurate rule letter. Cancellation metadata remains the guard
    // against stale finalizers and late task-attribution work.
    setTaskState(sessionName, cancel
      ? {
        classifyState: cls,
        endedAt: Date.now(),
        cancelledAt: cancel.at || Date.now(),
        cancelReason: cancel.reason || 'user_cancelled',
        cancelSource: cancel.source || 'manual_cancel',
        cancelOperationId: cancel.operationId || null,
        cancelSuperseded: cancel.superseded === true,
        supersededByEntryId: cancel.supersededByEntryId || null,
      }
      : { classifyState: cls, endedAt: Date.now() });
    // Reset auto-continue guard on a plain W (user is in charge now). B/E keep their own flow.
    if (state === 'W') {
      getWaitInjector().resetAuto(sessionName);
    }
  }

  // ── Periodic task-attribution backstop ────────────────────────────────────
  // Every minute, sweep sessions whose task name is still unresolved. This is a
  // naming/grouping retry only; it never re-judges turn state.
  const SCAN_INTERVAL_MS = 60 * 1000;
  const SCAN_MAX_QUEUE = 20;        // skip the whole sweep if the queue is already this long
  const SCAN_RETHROTTLE_MS = 2 * 60 * 1000;  // skip a session judged < 2min ago
  // Bounded in-memory ring of recent scanAndReclassify passes, for debugging
  // "when did a scan run, what did it see, and which sessions did it enqueue vs
  // skip (and why)". Queryable via GET /api/scan/history. Never persisted — no fs
  // write on the 60s scan hot path; cleared on restart. Follows the networkHealth
  // in-memory diagnostic-state pattern (not chat_history/__aux__.json, which uses
  // synchronous fs writes and renders as chat bubbles).
  const SCAN_HISTORY_MAX_PASSES = 100;       // ~100 min of passes at 60s cadence
  const SCAN_HISTORY_MAX_DECISIONS = 400;    // per-pass cap on per-session records
  const scanHistory = {
    seq: 0,
    passes: [],
    push(record) {
      record.pass = ++this.seq;
      if (record.decisions && record.decisions.length > SCAN_HISTORY_MAX_DECISIONS) {
        record.decisions = record.decisions.slice(0, SCAN_HISTORY_MAX_DECISIONS);
        record.decisionsTruncated = true;
      }
      this.passes.unshift(record);
      if (this.passes.length > SCAN_HISTORY_MAX_PASSES) this.passes.pop();
    },
  };

  // A goal is junk if it's empty (classify never ran or failed) or is really a
  // system-injected message / raw tool payload rather than a user-authored goal.
  function isInjectedOrJunkGoal(goal) {
    const g = String(goal || '').trim();
    if (!g) return true;  // empty goal is junk — classify never ran or failed
    return g.startsWith(SYSTEM_PREFIX) || g.startsWith('<') || g.startsWith('"<');
  }

  // Whether a user message is system-injected (autoContinue / apiRetry / bgCheck).
  function isSystemInjectedMsg(msg) {
    return String(msg || '').trim().startsWith(SYSTEM_PREFIX);
  }

  // Whether classify has produced a real goal for this session. False for the
  // ensureCurrentTask placeholder ('新任务'), empty, or injected/junk goals -
  // i.e. classify hasn't named the task yet. scan uses this to decide whether a
  // streaming session still needs an in-progress classify (to extract the goal).
  function isGoalResolved(goal) {
    const g = String(goal || '').trim();
    if (!g || g === '新任务') return false;
    return !isInjectedOrJunkGoal(g);
  }

  // Shared structured-verdict applier. Only an inactive owned turn may commit.
  function applyClassifyResult(cs, sessionName, sessionId, res, options = {}) {
    const { cwd, source } = options;
    const liveness = turnLivenessForClassify(sessionName);
    const currentState = getTaskState(persistedSessions.get(sessionName));
    // Explicit user/watchdog cancellation owns the turn boundary. An Aux job
    // already in flight may finish later; never let that stale verdict replace
    // the immediate E. The next real user turn clears cancelledAt before spawn.
    if (currentState.classifyState === 'E' && currentState.cancelledAt) {
      logger.info('classify_result_ignored_after_cancel', { sessionId: sessionName, source });
      return;
    }
    const userInputHost = getUserInputSignalHost();
    if (typeof userInputHost.apply === 'function') res = userInputHost.apply(sessionName, res);
    if (liveness.state !== 'inactive') {
      if (cs?.currentTask) {
        cs.currentTask.goal = (res.goal && res.goal !== '-') ? res.goal : '';
        if (res.phase) cs.currentTask.phase = res.phase;
      }
      // Persist BOTH goal and phase - persisting goal alone left phase stuck at
      // the ensureCurrentTask placeholder ('planning'), so the card showed
      // "新任务 规划中" even after classify judged the real goal/phase.
      setTaskState(sessionName, { goal: cs.currentTask?.goal || '', phase: cs.currentTask?.phase || 'planning' });
      const ph = phaseLabel(cs.currentTask?.phase);
      const goal = cs.currentTask?.goal || '';
      // Create/merge immediately; turn-end enriches the ref with assistant id.
      recordTaskBoardGoal(sessionName, goal, cs.currentTask?.phase, cs);
      const label = goal ? `处理中：${goal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
      emitRunningNotify(sessionName, label);
      console.log(`[${source}] Classify observational for ${sessionName}: liveness=${liveness.state}/${liveness.reason || 'unknown'} goal="${goal}" phase=${cs.currentTask?.phase || '?'}`);
      return;
    }
    // Liveness independently proved the structured verdict may commit.
    const actionContext = {
      sessionName, sessionId, cs, isTerminal: false, cwd, source, liveness,
    };
    if (Object.prototype.hasOwnProperty.call(options, 'taskId')) {
      actionContext.taskId = options.taskId;
    }
    dispatchStateAction(res, actionContext);
    console.log(`[${source}] Classify RESULT for ${sessionName}: state=${res.state} goal="${res.goal}" phase=${res.phase || '?'}${res.state === 'E' ? ' (API error)' : ''}${res.evidence ? ` evidence=${res.evidence}` : ''}`);
  }

  // Aux owns task identity only. It may rename/re-group the turn and attach its
  // replay provenance, but it never calls dispatchStateAction and therefore can
  // neither finish a turn nor keep one stuck in processing.
  function taskAttributionAnchorStatus(sessionName, expectedAnchorMessageId) {
    const observedAnchorMessageId = classifyAnchorMessageId(sessionName);
    return {
      observedAnchorMessageId,
      // null -> id and id -> null are changes too. The former is especially
      // important for a legacy transcript whose old tail had no id but whose
      // next message does: that late result must not acquire the new turn.
      changed: observedAnchorMessageId !== expectedAnchorMessageId,
    };
  }

  function applyTaskAttributionResult(cs, sessionName, result, context = {}) {
    if (!cs) return null;
    const previousTaskId = Object.prototype.hasOwnProperty.call(context, 'taskId')
      ? context.taskId || null
      : cs._currentTaskId || null;
    const anchor = context.anchorStatus
      || taskAttributionAnchorStatus(sessionName, context.anchorMessageId || null);
    const supersededReason = context.supersededReason
      || (anchor.changed ? 'anchor_changed' : null);
    if (supersededReason) {
      let annotated = [];
      try {
        annotated = annotateChatTurn(sessionName, context.turnId, {
          taskId: previousTaskId || undefined,
          auxRunId: context.runId || null,
        }, { anchorMessageId: context.anchorMessageId || null });
      } catch (error) {
        logger.warn?.('aux_message_annotation_failed', { sessionId: sessionName, error: error.message });
      }
      logger.info?.('task_attribution_superseded', {
        sessionId: sessionName,
        runId: context.runId || null,
        reason: supersededReason,
        anchorMessageId: context.anchorMessageId || null,
        observedAnchorMessageId: anchor.observedAnchorMessageId || null,
      });
      return {
        taskId: previousTaskId,
        superseded: true,
        supersededReason,
        observedAnchorMessageId: anchor.observedAnchorMessageId || null,
        annotated,
      };
    }
    const boundTaskId = persistedSessions.get(sessionName)?.taskBoundTaskId || null;
    const sameTaskId = result.relation === 'same' ? (result.taskId || previousTaskId) : null;
    const taskId = boundTaskId || context.resolvedTaskId || sameTaskId
      || `tsk_${crypto.randomUUID().replace(/-/g, '')}`;
    const taskName = result.taskName || cs.currentTask?.goal || '新任务';
    const phase = result.phase || cs.currentTask?.phase || 'planning';
    const changedIdentity = taskId !== previousTaskId;

    cs._currentTaskId = taskId;
    if (!cs.currentTask) cs.currentTask = newCurrentTask(taskName);
    cs.currentTask.goal = taskName;
    cs.currentTask.phase = phase;
    const persisted = persistedSessions.get(sessionName);
    const currentState = getTaskState(persisted);
    const taskStartedAt = Number(cs.currentTask.startedAt || currentState.startedAt || 0);
    const historyTaskIds = new Set([
      previousTaskId,
      context.admittedTaskId || null,
    ].filter(Boolean));
    const classifyHistory = Array.isArray(currentState.classifyHistory)
      ? currentState.classifyHistory.map(entry => {
        if (!entry || !historyTaskIds.has(entry.taskId)
            || Number(entry.at || 0) < taskStartedAt) return entry;
        // Identity attribution refines only identity/name/phase. Preserve the
        // rule-owned D/W/B/E state and its evidence byte-for-byte.
        return { ...entry, taskId, goal: taskName, phase };
      })
      : [];
    setTaskState(sessionName, {
      goal: taskName,
      phase,
      taskId,
      auxRunId: context.runId || null,
      taskIdentityState: 'canonical',
      taskIdentityPending: false,
      taskIdentityAnchorMessageId: context.anchorMessageId || null,
      classifyHistory,
    });

    let annotated = [];
    try {
      annotated = annotateChatTurn(sessionName, context.turnId, {
        taskId,
        taskName,
        auxRunId: context.runId || null,
        taskStart: result.relation === 'new' ? true : undefined,
        taskSource: result.relation === 'new' ? 'aux' : undefined,
        taskText: result.relation === 'new' ? String(cs.currentUserText || '') : undefined,
      }, { anchorMessageId: context.anchorMessageId || null });
    } catch (error) {
      logger.warn?.('aux_message_annotation_failed', { sessionId: sessionName, error: error.message });
    }

    const board = getTaskBoardRuntime();
    if (changedIdentity && typeof board.reassignTurnTask === 'function') {
      board.reassignTurnTask(sessionName, previousTaskId, taskId, annotated, {
        taskName,
        taskText: String(cs.currentUserText || ''),
      });
    } else if (typeof board.onMessagePersisted === 'function') {
      for (const message of annotated) board.onMessagePersisted(sessionName, message);
    }

    const currentClassifyState = getTaskState(persistedSessions.get(sessionName)).classifyState || 'P';
    recordTaskBoardGoal(sessionName, taskName, phase, cs, currentClassifyState);
    if (typeof board.onTaskAttributionSettled === 'function') {
      try {
        Promise.resolve(board.onTaskAttributionSettled(sessionName, taskId, annotated, {
          taskName, phase, runId: context.runId || null,
        })).catch(error => {
          logger.warn?.('task_module_classification_failed', {
            sessionId: sessionName, taskId, error: error?.message || String(error || ''),
          });
        });
      } catch (error) {
        logger.warn?.('task_module_classification_failed', {
          sessionId: sessionName, taskId, error: error?.message || String(error || ''),
        });
      }
    }
    if (taskName) setSessionSummary(persisted?.id || sessionName, taskName);
    if (turnLivenessForClassify(sessionName).state === 'active') {
      const ph = phaseLabel(phase);
      emitRunningNotify(sessionName, `处理中：${taskName}${ph ? ` · ${ph}` : ''}`);
    }
    return {
      taskId, taskName, phase, changedIdentity, annotated,
      superseded: false,
      observedAnchorMessageId: anchor.observedAnchorMessageId || null,
    };
  }

  function scanAndReclassify() {
    if (getAuxQueue().isUnhealthy()) return;
    // Debug observability: record this pass (time, queue state, and every
    // per-session enqueue/skip decision + reason) into the scanHistory ring.
    const passRecord = {
      ts: Date.now(),
      queueLen: getAuxQueue().queue.length,
      maxQueue: SCAN_MAX_QUEUE,
      fullSkip: false,
      considered: 0,
      enqueued: 0,
      decisions: [],
    };
    const note = (sid, cls, decision, reason) => passRecord.decisions.push(
      reason ? { sid, classifyState: cls ?? null, decision, reason }
             : { sid, classifyState: cls ?? null, decision });
    if (getAuxQueue().queue.length >= SCAN_MAX_QUEUE) {
      passRecord.fullSkip = true;
      scanHistory.push(passRecord);
      console.log(`[multicc/scan] queue backed up (${getAuxQueue().queue.length}) - skip this round`);
      return;
    }
    const now = Date.now();
    // Collect candidates first, then sort newest-first before enqueueing so
    // active sessions get judged before stale ones.
    const candidates = [];
    for (const [sid, p] of persistedSessions) {
      if (!p || p.type === 'aux' || p.type === 'gateway' || p.kind !== 'chat') continue;
      const ts = getTaskState(p);

      if (ts.classifyState === 'E' && ts.cancelledAt) {
        note(sid, ts.classifyState, 'skipped-cancelled', 'explicit cancellation remains authoritative until next user turn');
        continue;
      }
      // Skip sessions parked by the degrade防线 (held for API recovery). Re-judging a
      // held session every 60s is pure waste — its history hasn't changed (no new turn
      // ran while held), so the verdict can't self-correct. Worse, a fresh classify
      // nudge here would re-hit the chokepoint and overwrite the stashed pendingText
      // with boilerplate, losing any real dispatch/bg payload held for replay on
      // recovery. resumeHeldSessions owns these; leave them alone.
      if (getApiErrorHost().isHeld(sid)) {
        note(sid, ts.classifyState, 'skipped-held', 'held by degrade防线 (API recovery)');
        continue;
      }

      // An owned provider turn waits for its close/finalize boundary. Stream
      // silence is not a terminal fact: OpenCode (and other one-shot CLIs) can
      // spend a long time inside a tool without emitting JSONL. The dedicated
      // processing watchdog checks actual child/stream liveness and cancels a
      // genuinely missing runner; classify must never clear isStreaming or
      // publish W/D while that runner is still alive.
      const liveCs = chatSessions.get(sid);
      const liveness = turnLivenessForClassify(sid);
      if (liveness.state === 'unknown') {
        note(sid, ts.classifyState, 'skipped-unknown-liveness', liveness.reason);
        continue;
      }
      if (liveness.state === 'active') {
        if (isGoalResolved(ts.goal) && ts.taskIdentityPending !== true) {
          note(sid, ts.classifyState, 'skipped-live-runner', 'owned provider turn + goal already resolved');
          continue;
        }
        // Unresolved goal falls through to the in-progress classify path.
      }

      // throttle: don't re-run attribution in the last SCAN_RETHROTTLE_MS,
      // BUT only within the same task. lastAt comes from classifyHistory (the prior
      // verdict), which may belong to the PREVIOUS task; a brand-new task writes a
      // later ts.startedAt via ensureCurrentTask. So gate the throttle on
      // lastAt >= startedAt: same-task redundant attribution → still throttled;
      // cross-task boundary (lastAt < startedAt) → fall through, classify immediately so
      // the goal card refreshes from "新任务" to the real name within seconds instead of
      // waiting up to SCAN_RETHROTTLE_MS. startedAt null/0 (legacy) → lastAt >= 0 always
      // true → degrades to the old wall-clock behaviour, zero regression.
      const hist = Array.isArray(ts.classifyHistory) ? ts.classifyHistory : [];
      const lastAt = hist.length ? hist[hist.length - 1].at : 0;
      if (lastAt && (now - lastAt) < SCAN_RETHROTTLE_MS && lastAt >= (ts.startedAt || 0)) {
        note(sid, ts.classifyState, 'skipped-throttle', `judged ${((now - lastAt) / 1000).toFixed(0)}s ago (< ${SCAN_RETHROTTLE_MS / 1000}s)`);
        continue;
      }

      // dedup: already queued or in-flight
      if (getAuxQueue().hasPendingFor(sid)) {
        note(sid, ts.classifyState, 'skipped-dedup', 'already queued or in-flight');
        continue;
      }

      // Pull last assistant reply from chat history to classify against
      let reply = '';
      try {
        const history = viewChatHistory(sid);
        for (let i = history.length - 1; i >= 0; i--) {
          const m = history[i];
          if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length >= 20) {
            reply = m.content; break;
          }
        }
      } catch (_) {}
      if (reply.length < 20) {
        note(sid, ts.classifyState, 'skipped-no-reply', 'no assistant reply ≥ 20 chars');
        continue;
      }

      // last activity time - used to order newest-first
      const ref = ts.lastTurnEndedAt || ts.lastSummaryAt
        || (p.lastActivity ? new Date(p.lastActivity).getTime() : 0) || lastAt || 0;
      // The scan is now only a naming backstop. A resolved name cannot improve
      // without a new user message, and turn state is never re-judged by Aux.
      if (isGoalResolved(ts.goal) && ts.taskIdentityPending !== true) {
        note(sid, ts.classifyState, 'skipped-goal-resolved', 'task identity already resolved');
        continue;
      }
      candidates.push({ sid, reply, ref, classifyState: ts.classifyState });
    }
    // Newest first: most recently active sessions are judged before stale ones.
    candidates.sort((a, b) => (b.ref || 0) - (a.ref || 0));
    passRecord.considered = candidates.length;

    let enqueued = 0;
    for (const c of candidates) {
      if (getAuxQueue().queue.length >= SCAN_MAX_QUEUE) {
        note(c.sid, c.classifyState, 'skipped-queue-full', `SCAN_MAX_QUEUE (${SCAN_MAX_QUEUE}) reached mid-loop`);
        continue;
      }
      const { sid, reply } = c;
      const runId = crypto.randomUUID();
      const history = viewChatHistory(sid);
      const csAtStart = chatSessions.get(sid);
      const taskId = csAtStart?._currentTaskId || null;
      const stateAtStart = getTaskState(persistedSessions.get(sid));
      const provisionalTaskId = stateAtStart.taskIdentityPending === true ? taskId : null;
      const recentTasks = recentTaskContext(history);
      const systemPrompt = buildTaskAttributionSystemPrompt({
        recentTasks, currentTaskId: taskId, provisionalTaskId,
      });
      const prompt = buildClassifyConversation(sid, reply);
      const anchorMessageId = classifyAnchorMessageId(sid);
      const startedAt = Date.now();
      getAuxQueue().enqueue({
        type: 'intent_classify',
        systemPrompt,
        prompt,
        // Persist the exact transcript/task view owned by this operation in the
        // queue record itself, not only in this promise closure. Aux events and
        // history can therefore prove which message the delayed result judged.
        meta: { sid, startup: true, runId, anchorMessageId, taskId },
      }).then(result => {
        if (result.cancelled) {
          recordAuxRun(sid, { runId, anchorMessageId, cancelled: true, source: 'scan' });
          return;
        }
        const res = parseTaskAttribution(result.text, {
          fallbackTaskId: taskId,
          allowedTaskIds: recentTasks.map(task => task.taskId),
        });
        const boundTaskId = persistedSessions.get(sid)?.taskBoundTaskId || null;
        const resolvedTaskId = boundTaskId || (res.relation === 'same'
          ? (res.taskId || taskId)
          : provisionalTaskId || `tsk_${crypto.randomUUID().replace(/-/g, '')}`);
        const cs = chatSessions.get(sid);
        const anchorStatus = taskAttributionAnchorStatus(sid, anchorMessageId);
        const supersededReason = anchorStatus.changed ? 'anchor_changed' : null;
        recordAuxRun(sid, {
          runId, anchorMessageId, systemPrompt, prompt,
          taskId: supersededReason ? taskId : resolvedTaskId, priorTaskId: taskId,
          observedAnchorMessageId: anchorStatus.observedAnchorMessageId,
          rawText: result.text, parsed: res, source: 'scan',
          superseded: !!supersededReason,
          supersededReason,
          latencyMs: Date.now() - startedAt,
        });
        applyTaskAttributionResult(cs, sid, res, {
          source: 'multicc/scan', runId, taskId,
          admittedTaskId: provisionalTaskId, resolvedTaskId, anchorMessageId,
          anchorStatus, supersededReason,
        });
      }).catch(e => {
        if (e && e.cancelled) return;
        recordAuxRun(sid, { runId, anchorMessageId, error: e.message, source: 'scan' });
        console.warn(`[multicc/scan] classify ${sid} failed: ${e.message}`);
      });
      note(sid, c.classifyState, 'enqueued');
      enqueued++;
    }
    passRecord.enqueued = enqueued;
    scanHistory.push(passRecord);
    if (enqueued) console.log(`[multicc/scan] enqueued ${enqueued} session(s) for task attribution (newest first)`);
  }

  function cancelClassify(cs) {
    if (cs._classifyTimer) { clearTimeout(cs._classifyTimer); cs._classifyTimer = null; }
    // In-flight work may still finish for audit/provenance. Its captured message
    // anchor is checked before any live task identity can be changed.
  }

  // Compatibility name retained for route composition; the content is now the
  // task-attribution conversation and carries task ids/names with each message.
  function buildClassifyConversation(sessionName, reply) {
    const history = viewChatHistory(sessionName)
      .filter(message => !isSystemInjectedMsg(message?.content));
    return buildTaskAttributionConversation(history, reply);
  }

  // The newest message the classifier will actually see — same filter as
  // buildClassifyConversation's walk, so the anchor is always a message that
  // was really in the prompt. Recording it is what lets a rendered message be
  // traced back to the verdict that judged it (aux-run-log.byAnchor).
  //
  // Kept separate from buildClassifyConversation rather than folded into its
  // return value: that function is exported and three other call sites depend
  // on it returning a plain string.
  function classifyAnchorMessageId(sessionName) {
    try {
      const history = viewChatHistory(sessionName);
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (!m || !m.content) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        if (isSystemInjectedMsg(m.content)) continue;
        return m.id || null;
      }
    } catch (_) {}
    return null;
  }

  // Evidence recording is best-effort by construction: a classify verdict must
  // never fail because its audit trail could not be written.
  function recordAuxRun(sessionName, run) {
    try {
      return getAuxRunLog().record(sessionName, run);
    } catch (error) {
      logger.warn?.('aux_run_record_failed', { sessionId: sessionName, error: error.message });
      return null;
    }
  }

  function runClassifyNow(cs, sessionName, {
    turnId = null,
    skipCancel = false,
    manual = false,
    source = null,
    identityLocked = false,
    admittedTaskId = null,
  } = {}) {
    const reply = cs.currentAssistantText || '';
    const userMsg = cs.currentUserText || '';
    // Need at least a user message (turn-start) or some AI reply (mid/end) to work with.
    if (userMsg.length < 1 && reply.length < 20) return;

    const sessionId = persistedSessions.get(sessionName)?.id || sessionName;
    // A cancelled turn has already reached its verdict. The runner's close
    // handler still runs finalize → classifyTurnEnd after the kill, so without
    // this guard every cancel queued one more Aux judgement whose result
    // applyClassifyResult was only going to throw away. ensureCurrentTask clears
    // cancelledAt when the next real user turn starts, so this never sticks.
    const cancelledState = getTaskState(persistedSessions.get(sessionName));
    if (cancelledState.classifyState === 'E' && cancelledState.cancelledAt) {
      logger.info('classify_skipped_after_cancel', { sessionId: sessionName });
      return;
    }
    const history = viewChatHistory(sessionName);
    const currentTaskId = cs._currentTaskId || null;
    const recentTasks = recentTaskContext(history);
    const identityState = getTaskState(persistedSessions.get(sessionName));
    const provisionalTaskId = identityState.taskIdentityPending === true
      ? currentTaskId : null;
    const admissionTaskId = admittedTaskId || null;
    const requestId = crypto.randomUUID();
    const runId = requestId;
    const runSource = source || (manual ? 'manual' : 'turn-end');
    const systemPrompt = buildTaskAttributionSystemPrompt({
      recentTasks, currentTaskId, provisionalTaskId, identityLocked,
    });
    const prompt = buildClassifyConversation(sessionName, reply);
    const anchorMessageId = classifyAnchorMessageId(sessionName);
    const startedAt = Date.now();
    // State has already been committed by resolveTurnState. Aux degradation now
    // costs naming/attribution only and cannot hold scheduler progress. Still
    // record the attempt and stamp its run id on the turn: "unavailable" is
    // provenance too, and must be inspectable from every affected message.
    if (getAuxQueue().isUnhealthy()) {
      recordAuxRun(sessionName, {
        runId, turnId, anchorMessageId, systemPrompt, prompt,
        taskId: currentTaskId, error: 'aux_unhealthy', source: runSource,
      });
      annotateChatTurn(sessionName, turnId, {
        taskId: currentTaskId || undefined,
        auxRunId: runId,
      }, { anchorMessageId });
      logger.warn?.('task_attribution_unavailable', { sessionId: sessionName, turnId });
      return;
    }
    // Dedup: drop this session's older queued/in-flight classify before enqueuing
    // the fresh one — a session only needs its single latest judgement. Without
    // this, rapid turns pile up near-duplicate classifies that then supersede each
    // other's .then() and drop the real verdict (goal/state never persist).
    if (!skipCancel) getAuxQueue().cancelClassifyFor(sessionName);
    // Note: this id names the *classify request*, not the business task. The
    // business task is cs._currentTaskId, recorded separately on every run so
    // verdicts can be grouped by the task they judged.
    cs._classifyTaskId = requestId;

    getAuxQueue().enqueue({
      id: requestId,
      type: 'intent_classify',
      systemPrompt,
      prompt,
      meta: {
        sessionName, sessionId, runId, turnId, manual, identityLocked,
        anchorMessageId, taskId: currentTaskId,
      },
    }).then(result => {
      const requestSuperseded = cs._classifyTaskId !== requestId;
      if (!requestSuperseded) cs._classifyTaskId = null;
      if (result.cancelled) {
        recordAuxRun(sessionName, {
          runId, turnId, anchorMessageId, cancelled: true, source: runSource,
          taskId: currentTaskId,
        });
        annotateChatTurn(sessionName, turnId, {
          taskId: currentTaskId || undefined,
          auxRunId: runId,
        }, { anchorMessageId });
        return;
      }
      const res = parseTaskAttribution(result.text, {
        fallbackTaskId: currentTaskId,
        allowedTaskIds: recentTasks.map(task => task.taskId),
      });
      const boundTaskId = persistedSessions.get(sessionName)?.taskBoundTaskId || null;
      // `new` promotes the admission's provisional id; it must never mint a
      // second id after that candidate has already been persisted and rendered.
      // Explicit task-card/#CODE continuations are identity-locked evidence.
      const resolvedTaskId = boundTaskId || (identityLocked
        ? currentTaskId
        : res.relation === 'same'
          ? (res.taskId || currentTaskId)
          : admissionTaskId)
        || `tsk_${crypto.randomUUID().replace(/-/g, '')}`;
      const anchorStatus = taskAttributionAnchorStatus(sessionName, anchorMessageId);
      const supersededReason = anchorStatus.changed
        ? 'anchor_changed'
        : requestSuperseded ? 'newer_aux_request' : null;
      recordAuxRun(sessionName, {
        runId, turnId, anchorMessageId, systemPrompt, prompt,
        taskId: supersededReason ? currentTaskId : resolvedTaskId,
        priorTaskId: currentTaskId,
        observedAnchorMessageId: anchorStatus.observedAnchorMessageId,
        rawText: result.text, parsed: res, source: runSource, identityLocked,
        admittedTaskId: admissionTaskId,
        superseded: !!supersededReason,
        supersededReason,
        latencyMs: Date.now() - startedAt,
      });
      applyTaskAttributionResult(cs, sessionName, res, {
        source: 'multicc/aux', runId, turnId,
        taskId: currentTaskId, admittedTaskId: admissionTaskId,
        resolvedTaskId, anchorMessageId,
        anchorStatus, supersededReason,
      });
    }).catch((e) => {
      if (cs._classifyTaskId === requestId) cs._classifyTaskId = null;
      // A cancelled task (new turn started / user typing) rejects with {cancelled:true}
      // and no .message — that's normal churn, not a failure. Don't log it as FAILED.
      if (e && e.cancelled) {
        recordAuxRun(sessionName, {
          runId, turnId, anchorMessageId, systemPrompt, prompt,
          taskId: currentTaskId, cancelled: true, source: runSource,
        });
        annotateChatTurn(sessionName, turnId, {
          taskId: currentTaskId || undefined,
          auxRunId: runId,
        }, { anchorMessageId });
        return;
      }
      recordAuxRun(sessionName, {
        runId, turnId, anchorMessageId, systemPrompt, prompt,
        error: e.message, source: runSource, taskId: currentTaskId,
      });
      annotateChatTurn(sessionName, turnId, {
        taskId: currentTaskId || undefined,
        auxRunId: runId,
      }, { anchorMessageId });
      console.log(`[multicc/aux] Classify FAILED for ${sessionName}: ${e.message}`);
      // Route the failure through the centralized API error policy so Aux
      // transport errors (ECONNRESET/timeout/5xx) land in the same taxonomy,
      // metrics and provider circuit as every other aux/upstream failure —
      // before this they were only a console line (1397 occurrences in one
      // production log window). This is observability only: task attribution
      // may degrade, but rule-based turn state has already committed and must
      // never be rewritten by Aux availability.
      try {
        getApiErrorHost().recordApiError(
          { source: 'aux_http', provider: 'aux', message: String(e && e.message || 'classify failed') },
          { source: 'aux_http', provider: 'aux', sessionId: sessionName },
        );
      } catch (_) {}
      logger.warn?.('task_attribution_failed', { sessionId: sessionName, turnId, error: e.message });
    });
  }

  // Commit the rule verdict first, then enqueue best-effort task attribution.
  // The two paths deliberately share no state writer.
  function classifyTurnEnd(cs, sessionName, options = {}) {
    const { classification, turnId = null, identityLocked = false } = options;
    cancelClassify(cs);
    const persisted = persistedSessions.get(sessionName);
    getAuxQueue().cancelClassifyFor(sessionName);
    if (cs) cs._classifyTaskId = null;
    const sessionId = persisted?.id || sessionName;
    const liveness = turnLivenessForClassify(sessionName);
    const userInputHost = getUserInputSignalHost();
    let backgroundPending = false;
    try { backgroundPending = hasBackgroundPending(sessionName) === true; }
    catch (error) {
      logger.warn?.('background_state_unavailable', { sessionId: sessionName, error: error.message });
    }
    const verdict = resolveTurnState({
      liveness,
      boundary: classification || 'unknown-interruption',
      sessionType: persisted?.type || null,
      pendingUserInput: typeof userInputHost.pending === 'function'
        && !!userInputHost.pending(sessionName),
      backgroundPending,
    });
    const applyOptions = { cwd: cs?.cwd, source: 'multicc/turn-rules' };
    // The scheduler verdict belongs to the task admitted for this turn, not to
    // the mutable task pointer that Aux may update later. An explicit null is
    // still meaningful: session-work-host then correlates against its own
    // active FIFO entry instead of consulting live chat state.
    if (Object.prototype.hasOwnProperty.call(options, 'taskId')) {
      applyOptions.taskId = options.taskId || null;
    }
    applyClassifyResult(cs, sessionName, sessionId, {
      ...verdict,
      goal: cs?.currentTask?.goal || getTaskState(persisted).goal || '',
      phase: verdict.state === 'D'
        ? 'done' : cs?.currentTask?.phase || getTaskState(persisted).phase || 'planning',
    }, applyOptions);

    // Gateway turns are routing transactions and do not participate in task
    // naming. Every other turn gets best-effort Aux attribution after state has
    // already committed.
    if (persisted?.type !== 'gateway') {
      runClassifyNow(cs, sessionName, {
        turnId,
        skipCancel: true,
        identityLocked,
        admittedTaskId: Object.prototype.hasOwnProperty.call(options, 'taskId')
          ? options.taskId || null : null,
      });
    }
    getTaskBoardRuntime().onTurnEnd(cs, sessionName);
  }

  // to know "what task is running" and "what's the current status" WHILE the
  // agent is still working. This does exactly that:
  // ── Closed-loop task model ─────────────────────────────────────────────────
  // Admission derives an honest provisional title from the new task message;
  // the classify loop refines it and decides canonical identity.
  function newCurrentTask(goal) {
    return {
      goal: goal || '新任务',    // placeholder until the first classify fills it in
      startedAt: Date.now(),
      phase: 'planning',         // planning | implementing | verifying | wrapping | done
      steps: [],
      pendingDispatches: [],     // dispatched worker runs awaiting回流 (see dispatch hooks)
      turnSeq: 0,                // bumped each turn that belongs to this task
    };
  }

  function knownTaskGoal(sessionName, taskId) {
    if (!taskId) return '';
    const state = getTaskState(persistedSessions.get(sessionName));
    if (state.taskId === taskId && state.goal) return state.goal;
    const classified = Array.isArray(state.classifyHistory) ? state.classifyHistory : [];
    for (let index = classified.length - 1; index >= 0; index -= 1) {
      if (classified[index]?.taskId === taskId && classified[index].goal) {
        return classified[index].goal;
      }
    }
    try {
      const history = viewChatHistory(sessionName);
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.taskId !== taskId) continue;
        const goal = message.taskName || (message.taskText && deriveTaskTitle(message.taskText));
        if (goal && goal !== PENDING_TASK_TITLE) return goal;
      }
    } catch (_) {}
    return '';
  }

  // taskId is the authoritative boundary; legacy turns retain the 10-minute heuristic.
  function ensureCurrentTask(cs, sessionName, userText, forceNew = false, identity = {}) {
    if (!cs) return;
    const now = Date.now();
    const prev = cs.currentTask;
    const canonicalContinuation = !!cs._currentTaskId && !forceNew && !!prev;
    if (getTaskContextHost().continues(cs, prev, forceNew, now)) {
      prev.turnSeq = (prev.turnSeq || 0) + 1;
      if (canonicalContinuation && prev.phase === 'done') prev.phase = 'planning';
      // Refresh persisted state: a continued turn means the closed-loop task
      // is still running (classify will refine shortly).
      setTaskState(sessionName, {
        classifyState: 'P',
        cancelledAt: null,
        cancelReason: null,
        cancelSuperseded: false,
        supersededByEntryId: null,
      });
      return prev;
    }
    const explicitContinuation = identity.explicitContinuation === true;
    const taskId = identity.taskId || cs._currentTaskId || null;
    const explicitGoal = explicitContinuation ? knownTaskGoal(sessionName, taskId) : '';
    const candidateGoal = explicitGoal || deriveTaskTitle(identity.taskText || userText);
    // A changed boundary never carries the prior live goal. Until Aux settles,
    // the new message's own title is the only honest first-frame description.
    cs.currentTask = newCurrentTask(candidateGoal);
    cs.currentTask.turnSeq = 1;
    cs._currentTaskId = taskId;
    const anchorMessageId = identity.anchorMessageId || classifyAnchorMessageId(sessionName);
    // Persist the new task snapshot so a mid-task restart can reconcile it (②).
    setTaskState(sessionName, {
      goal: cs.currentTask.goal, phase: cs.currentTask.phase,
      startedAt: cs.currentTask.startedAt, endedAt: null,
      taskId,
      taskIdentityState: explicitContinuation ? 'canonical' : 'provisional',
      taskIdentityPending: !explicitContinuation,
      taskIdentityAnchorMessageId: anchorMessageId,
      classifyState: 'P', cancelledAt: null, cancelReason: null,
      cancelSuperseded: false, supersededByEntryId: null,
    });
    recordTaskBoardGoal(sessionName, cs.currentTask.goal, cs.currentTask.phase, cs, 'P');
    emitRunningNotify(sessionName, explicitContinuation
      ? `处理中：${cs.currentTask.goal}`
      : `归类中：${cs.currentTask.goal}`);
    return cs.currentTask;
  }

  function emitRunningNotify(sessionName, message) {
    const persisted = persistedSessions.get(sessionName);
    if (!persisted) return;
    const sessionId = persisted.id || sessionName;
    setSessionSummary(sessionId, message);
    chatBroadcast(sessionName, { type: 'notify', state: 'running', message });
    const dirId = persisted.dirId;
    if (dirId) {
      workspaceBroadcast(dirId, { type: 'notify', sessionId, state: 'running', message });
    }
  }

  // Terminal outcome of a chat turn. Fired immediately at turn end so the card
  // moves from the in-progress "处理中：xxx" to the turn-outcome label:
  //   • status badge → succeeded / error  (status event)
  //   • summary line → the outcome label   (summary event) — replaces 处理中：xxx
  // Both are display-only (no user-facing alert). The lock-screen push / voice /
  // app notification (the `notify` event) only fires when `alert` is set — true
  // for errors; false for a plain completion, which the 30s intent_classify
  // reports once (and which then refines this summary to the actual content).
  function emitTurnOutcome(sessionName, { status, notifyState, message, alert }) {
    const persisted = persistedSessions.get(sessionName);
    if (!persisted) return;
    const sessionId = persisted.id || sessionName;
    if (getUserInputSignalHost().pending(sessionName)) { setTaskState(sessionName, { lastTurnEndedAt: Date.now(), endedAt: Date.now() }); return; }
    // Enrich bare "执行成功" with the stable task name so the dashboard / chat
    // shows "执行成功：memo图片更换" instead of a dry "执行成功".
    // Prefer the current turn's stored task name; fall back to the last
    // session summary (from a prior intent_classify).
    if (message === '执行成功') {
      const cs = chatSessions.get(sessionName);
      // Prefer the closed-loop task goal (noun-phrase, model-generated); fall
      // back to the legacy currentTaskName, then to the last session summary.
      const goal = cs?.currentTask?.goal || cs?.currentTaskName || '';
      // Mark the closed-loop task done so ensureCurrentTask starts a fresh task
      // next turn (rather than continuing a finished one).
      if (cs?.currentTask) cs.currentTask.phase = 'done';
      if (goal) {
        message = `执行成功：${goal}`;
      } else {
        const sm = getSessionSummaries().get(sessionId);
        const raw = sm?.summary || '';
        // Strip any status label prefix plus optional " · subAction" / " — subAction" suffix
        const clean = raw.replace(/^(正在处理：|处理中：|执行成功：|任务完成：)/, '').replace(/\s*[·—]\s*.+$/, '').trim();
        if (clean) message = `执行成功：${clean}`;
      }
    }

    setSessionStatus(sessionName, { status, currentFile: null });
    // Record turn-end timestamp. classifyTurnEnd / classify loop owns the
    // C/W/B/P decision — we don't set classifyState here.
    {
      // Don't set classifyState here — classifyTurnEnd / classify loop owns the C/W/B/P decision.
      setTaskState(sessionName, { lastTurnEndedAt: Date.now(), endedAt: Date.now() }, { save: false });
    }
    setSessionSummary(sessionId, message);
    if (alert) {
      triggerPush(sessionId, notifyState, `[Chat] ${message}`);
      chatBroadcast(sessionName, { type: 'notify', state: notifyState, message });
      if (persisted.dirId) {
        workspaceBroadcast(persisted.dirId, { type: 'notify', sessionId, state: notifyState, message });
      }
    }
  }
  return {
    recordTaskBoardGoal,
    dispatchStateAction,
    isInjectedOrJunkGoal,
    isSystemInjectedMsg,
    isGoalResolved,
    applyClassifyResult,
    applyTaskAttributionResult,
    scanAndReclassify,
    cancelClassify,
    buildClassifyConversation,
    runClassifyNow,
    classifyTurnEnd,
    newCurrentTask,
    ensureCurrentTask,
    emitRunningNotify,
    emitTurnOutcome,
    scanHistory,
    SCAN_INTERVAL_MS,
    SCAN_MAX_QUEUE,
    SCAN_RETHROTTLE_MS,
    // Backward-compatible diagnostics field. Silence no longer changes state;
    // the processing watchdog owns dead-runner detection from structured facts.
    STUCK_STREAM_MS: null,
    SCAN_HISTORY_MAX_PASSES,
    SCAN_HISTORY_MAX_DECISIONS,
  };
}

module.exports = { createClassifyStateMachine };

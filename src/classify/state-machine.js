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
  parseClassifyResult,
  buildClassifySystemPrompt,
  classifyDisplay,
  phaseLabel,
  isSettledLetter,
} = require('./vocab');

function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[classify-state-machine] ${name} must be a function`);
  }
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
    appendChatMessage,
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

  // Map classifier states to their runtime actions; D/W are scan-terminal states.

  function recordTaskBoardGoal(sessionName, goal, phase, cs, classifyState = 'P') {
    getTaskContextHost().recordGoal(sessionName, goal, phase, cs, classifyState);
  }

  // Classify owns the semantic letter; liveness only validates whether that
  // candidate may commit. The shared runtime returns active/inactive/unknown so
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
    // classifier verdict: same letter, same transition, same writer — the extra
    // envelope only records who asked and whether the runner actually stopped.
    const cancel = result.cancel && typeof result.cancel === 'object' ? result.cancel : null;
    const { sessionName, sessionId, cs, isTerminal, source } = ctx;
    const liveness = ctx.liveness || turnLivenessForClassify(sessionName);

    // ── Classify history (persisted, last 7 days) ────────────────────────
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const entry = { at: now, goal: goal || '', phase: phase || '', state,
      error: !!error, evidence: result.evidence || undefined };
    const persisted = persistedSessions.get(sessionName);
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

    // Mid-stream reclassify only observes goal/phase. Turn-end owns state and
    // side effects; persisting a provisional classifyState poisons scan guards.
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

    getSessionWorkHost().classifyTransition(
      sessionName,
      cs?._currentTaskId || null,
      result,
      {
        recoverMissingBoundary: source === 'multicc/scan' && liveness.state === 'inactive',
        livenessReason: liveness.reason || null,
      },
    );
    if (state === 'D') {
      // D — task genuinely finished. This is the ONLY terminal state.
      const msg = finalGoal ? `任务完成：${finalGoal}` : '任务完成';
      if (isTerminal) {
        triggerPush(sessionId, 'completed', msg);
        terminalBroadcast(sessionId, { type: 'notify', state: 'completed', classifyState: 'D', message: msg });
      } else {
        triggerPush(sessionId, 'completed', `[Chat] ${msg}`);
        chatBroadcast(sessionName, { type: 'notify', state: 'completed', classifyState: 'D', message: msg });
      }
      const dirId = persistedSessions.get(sessionName)?.dirId;
      if (dirId) workspaceBroadcast(dirId, { type: 'notify', sessionId, state: 'completed', classifyState: 'D', message: msg });
      setSessionStatus(sessionName, { status: 'completed' });
      // D is the ONLY terminal state and triggers no follow-up action to persist it
      // later — so it must flush to disk NOW. Otherwise a crash before the next
      // save:true op loses the D; restart hydrates a stale non-D letter and scan
      // (L7407 only skips D/W) re-judges it → possible false wake. save:true (default).
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
    // Persist the accurate letter for observability. scan re-judges C/B/E/P and
    // skips D/W; C never reaches this branch merely because auto-inject is off.
    // cancelledAt/cancelReason are written HERE, by classify, and nowhere else —
    // they are what applyClassifyResult and scanAndReclassify read to stop a late
    // Aux verdict from resurrecting a cancelled turn.
    setTaskState(sessionName, cancel
      ? {
        classifyState: cls,
        endedAt: Date.now(),
        cancelledAt: cancel.at || Date.now(),
        cancelReason: cancel.reason || 'user_cancelled',
        cancelSource: cancel.source || 'manual_cancel',
        cancelOperationId: cancel.operationId || null,
      }
      : { classifyState: cls, endedAt: Date.now() });
    // Reset auto-continue guard on a plain W (user is in charge now). B/E keep their own flow.
    if (state === 'W') {
      getWaitInjector().resetAuto(sessionName);
    }
  }

  // ── Periodic scan (replaces the old startup-only reconcile) ────────────────
  // Every minute, sweep sessions whose classifyState is not D or W (i.e. still
  // C/B/E/P or never classified). D=terminal (done), W=waiting on user — both are
  // scan-skipped. Dedup against the queue, throttle recently-judged
  // sessions, and bail if the queue is backed up. On restart the first tick picks
  // up everything that isn't definitively done — no special boot logic needed.
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

  // Shared turn-end/scan classify handler. Mid-stream only goal/phase is trusted;
  // once the turn ends dispatchStateAction owns the definitive state verdict.
  function applyClassifyResult(cs, sessionName, sessionId, res, { cwd, source } = {}) {
    res = getUserInputSignalHost().apply(sessionName, res);
    const liveness = turnLivenessForClassify(sessionName);
    const currentState = getTaskState(persistedSessions.get(sessionName));
    // Explicit user/watchdog cancellation owns the turn boundary. An Aux job
    // already in flight may finish later; never let that stale verdict replace
    // the immediate E. The next real user turn clears cancelledAt before spawn.
    if (currentState.classifyState === 'E' && currentState.cancelledAt) {
      logger.info('classify_result_ignored_after_cancel', { sessionId: sessionName, source });
      return;
    }
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
    // Classify supplied the semantic candidate and liveness independently proved
    // the owned runner inactive. The scan path may now repair a lost turn_end.
    dispatchStateAction(res, {
      sessionName, sessionId, cs, isTerminal: false, cwd, source, liveness,
    });
    console.log(`[${source}] Classify RESULT for ${sessionName}: state=${res.state} goal="${res.goal}" phase=${res.phase || '?'}${res.state === 'E' ? ' (API error)' : ''}${res.evidence ? ` evidence=${res.evidence}` : ''}`);
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

      // Skip states that only change on NEW USER INPUT — re-judging the same
      // history just re-derives the same verdict (waste, and can't self-correct):
      //   D = done (terminal)      W = waiting on user
      // A real user message flips classifyState to 'P' (ensureCurrentTask) and
      // re-enters the turn flow, so W naturally leaves without scan's help.
      // Only C/B/E/P/null need re-judging — those advance on SYSTEM-side events
      // (auto-continue, background done, API recovered, interrupted resume).
      if (isSettledLetter(ts.classifyState)) {
        note(sid, ts.classifyState, 'skipped-DW-guard', ts.classifyState === 'D' ? 'done (terminal)' : 'waiting on user');
        continue;
      }
      if (ts.classifyState === 'E' && ts.cancelledAt) {
        note(sid, ts.classifyState, 'skipped-cancelled', 'explicit cancellation remains authoritative until next user turn');
        continue;
      }
      // Same reasoning for an E the API-error policy decided: `fail_fast` means
      // the boundary already ruled out an automatic retry, so no system-side
      // event is coming and the transcript the scan would judge has not changed.
      // Without this the 60s sweep re-judged the failed turn, Aux saw an empty
      // reply, answered P, and the P-fallthrough below republished it as W —
      // silently converting「异常」back into「等待用户操作」one minute later.
      // ensureCurrentTask flips the letter to P on the next real user turn,
      // which is what lets a session leave this state.
      if (ts.classifyState === 'E' && ts.apiError && ts.apiError.action === 'fail_fast') {
        note(sid, ts.classifyState, 'skipped-api-error', 'API 策略已判定 fail_fast，等待用户手动处理');
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
        if (isGoalResolved(ts.goal)) {
          note(sid, ts.classifyState, 'skipped-live-runner', 'owned provider turn + goal already resolved');
          continue;
        }
        // Unresolved goal falls through to the in-progress classify path.
      }

      // throttle: don't re-judge a session judged in the last SCAN_RETHROTTLE_MS,
      // BUT only within the same task. lastAt comes from classifyHistory (the prior
      // verdict), which may belong to the PREVIOUS task; a brand-new task writes a
      // later ts.startedAt via ensureCurrentTask. So gate the throttle on
      // lastAt >= startedAt: same-task redundant re-judge → still throttled (anti-flush);
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
        const history = loadChatHistory(sid);
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
      const cleanPrior = isInjectedOrJunkGoal(ts.goal) ? '' : (ts.goal || '');
      candidates.push({ sid, cleanPrior, reply, ref, classifyState: ts.classifyState });
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
      const { sid, cleanPrior, reply } = c;
      getAuxQueue().enqueue({
        type: 'intent_classify',
        systemPrompt: buildClassifySystemPrompt(cleanPrior),
        prompt: buildClassifyConversation(sid, reply),
        meta: { sid, startup: true }
      }).then(result => {
        if (result.cancelled) return;
        const res = parseClassifyResult(result.text);
        const cs = chatSessions.get(sid);
        const sessionId = persistedSessions.get(sid)?.id || sid;
        applyClassifyResult(cs, sid, sessionId, res, { source: 'multicc/scan' });
      }).catch(e => {
        if (e && e.cancelled) return;
        console.warn(`[multicc/scan] classify ${sid} failed: ${e.message}`);
      });
      note(sid, c.classifyState, 'enqueued');
      enqueued++;
    }
    passRecord.enqueued = enqueued;
    scanHistory.push(passRecord);
    if (enqueued) console.log(`[multicc/scan] enqueued ${enqueued} session(s) for re-judge (newest first)`);
  }

  function cancelClassify(cs) {
    if (cs._classifyTimer) { clearTimeout(cs._classifyTimer); cs._classifyTimer = null; }
    // Don't cancel an in-flight classify — let it finish so its result lands.
    // The .then() handler now always applies the latest result unconditionally.
  }

  // Build the CHAT classify prompt (system + conversation). Output is the same
  // unified 3-line format parsed by parseClassifyResult above (shared with the
  // terminal path).
  // Line 1: goal — noun-phrase in the conversation's language (中文 ≤20 字 / EN ≤10 words)
  // Line 2: phase ∈ 规划中|实现中|验证中|收尾中|已完成 (Chinese codes; EN synonyms tolerated)
  // Line 3: D(done) | C(continue) | W(wait user) | E(api error) | P(processing)  (chat prompt does not emit B)
  // Tolerant of blank lines, prefixes, and model cruft.
  // Build the classify user prompt (conversation data only, no instructions).
  // Returns the conversation block as a plain string of labelled turns.
  function buildClassifyConversation(sessionName, reply) {
    const history = loadChatHistory(sessionName);
    const MAX_TURNS = 20;
    const MAX_PER_MSG = 400;
    const RECENT_NO_TRUNC = 5;  // keep the most recent N messages in full
    const parts = [];

    // Walk backwards, collect up to MAX_TURNS user+assistant messages.
    // Skip consecutive duplicates (chat_history may have _interim + final copies
    // of the same assistant message from incremental saves).
    let count = 0;
    let lastContent = '';
    for (let i = history.length - 1; i >= 0 && count < MAX_TURNS; i--) {
      const m = history[i];
      if (!m || !m.content) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (isSystemInjectedMsg(m.content)) continue;
      // Don't truncate the most recent few messages - the model needs the full
      // latest reply to judge state. A truncated reply looks mid-sentence and
      // gets misjudged as P (still processing).
      const snippet = count < RECENT_NO_TRUNC
        ? String(m.content)
        : String(m.content).slice(0, MAX_PER_MSG);
      if (m.role === 'assistant' && snippet === lastContent) continue;
      lastContent = snippet;
      const label = m.role === 'user' ? '用户' : '助手';
      parts.unshift(`${label}：${snippet}`);
      count++;
    }

    // Live assistant output not yet in chat_history (the newest - keep full).
    if (reply) {
      const liveSnippet = String(reply);
      if (liveSnippet !== lastContent) {
        parts.push(`助手：${liveSnippet}`);
      }
    }

    return `对话记录：\n${parts.join('\n\n')}`;
  }

  function runClassifyNow(cs, sessionName) {
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
    const priorGoal = cs.currentTask?.goal || '';
    // Structured W remains available while Aux is degraded.
    if (getAuxQueue().isUnhealthy()) {
      const structured = getUserInputSignalHost().degradedResult(sessionName, cs.currentTask);
      if (structured) applyClassifyResult(cs, sessionName, sessionId, structured,
        { cwd: cs.cwd, source: 'multicc/structured' });
      else getSessionWorkHost().classifyUnavailable(
        sessionName, cs._currentTaskId || null, 'classification_unavailable');
      return;
    }
    // Dedup: drop this session's older queued/in-flight classify before enqueuing
    // the fresh one — a session only needs its single latest judgement. Without
    // this, rapid turns pile up near-duplicate classifies that then supersede each
    // other's .then() and drop the real verdict (goal/state never persist).
    getAuxQueue().cancelClassifyFor(sessionName);
    const taskId = crypto.randomUUID();
    cs._classifyTaskId = taskId;

    getAuxQueue().enqueue({
      id: taskId,
      type: 'intent_classify',
      systemPrompt: buildClassifySystemPrompt(priorGoal),
      prompt: buildClassifyConversation(sessionName, reply),
      meta: { sessionName, sessionId },
    }).then(result => {
      if (cs._classifyTaskId !== taskId) return; // superseded by a newer classify
      cs._classifyTaskId = null;
      if (result.cancelled) return;
      const res = parseClassifyResult(result.text);
      applyClassifyResult(cs, sessionName, sessionId, res, { cwd: cs.cwd, source: 'multicc/aux' });
    }).catch((e) => {
      if (cs._classifyTaskId === taskId) cs._classifyTaskId = null;
      // A cancelled task (new turn started / user typing) rejects with {cancelled:true}
      // and no .message — that's normal churn, not a failure. Don't log it as FAILED.
      if (e && e.cancelled) return;
      console.log(`[multicc/aux] Classify FAILED for ${sessionName}: ${e.message}`);
      getSessionWorkHost().classifyUnavailable(
        sessionName, cs._currentTaskId || null, 'classification_error');
    });
  }

  // A turn that ended on an exhausted API failure has a KNOWN outcome: the
  // runner boundary already ran the centralized policy and chose fail_fast (a
  // planned retry never reaches finalize). Asking Aux to re-derive that from the
  // transcript is both wasteful and wrong — such a turn usually died before its
  // first token, and the classify prompt's own rule ("回复为空判 P") then answers
  // P, which dispatchStateAction's waiting branch renders as W. That is how an
  // API error surfaced to the dispatcher as「等待用户操作」instead of「异常」.
  //
  // So build the verdict from the structured decision and hand it to the SAME
  // central applier every other verdict goes through: liveness admission, cancel
  // precedence, the pending-user-input override, history, persistence and the
  // notify fan-out all stay in one place. This is a new *source* of a classify
  // result, not a new writer of classifyState.
  function apiErrorResult(cs, sessionName) {
    const ts = getTaskState(persistedSessions.get(sessionName));
    return {
      state: 'E',
      goal: cs?.currentTask?.goal || ts.goal || '',
      phase: cs?.currentTask?.phase || ts.phase || 'planning',
      evidence: 'api_error_policy',
    };
  }

  // Fire classify immediately after a turn ends — classify is the ONLY decider of
  // C/W/E/P/D. No in-turn loop: while streaming the output is still changing so a
  // mid-turn verdict would be judged against an incomplete reply. We judge once at
  // turn end (definitive) and the periodic scan re-judges anything not yet D/W.
  // runClassifyNow handles the empty-reply case itself (falls back to user msg).
  // `classification` is the turn boundary's own verdict when it has one; today
  // only 'api-error' short-circuits the Aux judgement.
  function classifyTurnEnd(cs, sessionName, { classification } = {}) {
    cancelClassify(cs);
    const persisted = persistedSessions.get(sessionName);
    const gatewayCompleted = persisted?.type === 'gateway'
      && (!classification || classification === 'completed');
    if (gatewayCompleted) {
      // Gateway turns are independent message-routing transactions. Their
      // authoritative outcome is the post-turn gateway/voice admission effect;
      // they have no semantic P/W/B lifecycle for Aux to infer. Sending them to
      // Aux created a permanent FIFO deadlock whenever classification was
      // unavailable, because the periodic scanner intentionally skips gateways.
      getAuxQueue().cancelClassifyFor(sessionName);
      if (cs) cs._classifyTaskId = null;
      const sessionId = persisted.id || sessionName;
      applyClassifyResult(cs, sessionName, sessionId, {
        state: 'D',
        goal: cs?.currentTask?.goal || '',
        phase: 'done',
        evidence: 'gateway_turn_completed',
      }, { cwd: cs?.cwd, source: 'multicc/gateway-turn' });
    } else if (classification === 'api-error') {
      // Drop this session's queued/in-flight classify. Whatever it was judging
      // is now superseded, and letting it resolve would overwrite the
      // deterministic E with the guess this branch exists to avoid.
      getAuxQueue().cancelClassifyFor(sessionName);
      if (cs) cs._classifyTaskId = null;
      const sessionId = persisted?.id || sessionName;
      applyClassifyResult(cs, sessionName, sessionId, apiErrorResult(cs, sessionName),
        { cwd: cs?.cwd, source: 'multicc/api-error' });
    } else {
      runClassifyNow(cs, sessionName);
    }
    getTaskBoardRuntime().onTurnEnd(cs, sessionName);
  }

  // to know "what task is running" and "what's the current status" WHILE the
  // agent is still working. This does exactly that:
  // ── Closed-loop task model ─────────────────────────────────────────────────
  // The goal is produced solely by the classify loop (turn-start + every 60s).
  // No rule-based fallback from the raw user message — that path used to turn
  // greetings ("hi") and injected recovery text into bogus goals.
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

  // taskId is the authoritative boundary; legacy turns retain the 10-minute heuristic.
  function ensureCurrentTask(cs, sessionName, userText, forceNew = false) {
    if (!cs) return;
    const now = Date.now();
    const prev = cs.currentTask;
    const canonicalContinuation = !!cs._currentTaskId && !forceNew && !!prev;
    if (getTaskContextHost().continues(cs, prev, forceNew, now)) {
      prev.turnSeq = (prev.turnSeq || 0) + 1;
      if (canonicalContinuation && prev.phase === 'done') prev.phase = 'planning';
      // Refresh persisted state: a continued turn means the closed-loop task
      // is still running (classify will refine shortly).
      setTaskState(sessionName, { classifyState: 'P', cancelledAt: null, cancelReason: null });
      return prev;
    }
    // Preserve only an unfinished classify-refined legacy goal.
    const carryGoal = (prev && prev.phase !== 'done' && prev.goal && prev.goal !== '新任务' && !isInjectedOrJunkGoal(prev.goal)) ? prev.goal : '';
    cs.currentTask = newCurrentTask(carryGoal);
    cs.currentTask.turnSeq = 1;
    // Persist the new task snapshot so a mid-task restart can reconcile it (②).
    setTaskState(sessionName, {
      goal: cs.currentTask.goal, phase: cs.currentTask.phase,
      startedAt: cs.currentTask.startedAt, endedAt: null,
      classifyState: 'P', cancelledAt: null, cancelReason: null,
    });
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
  // moves from the in-progress "处理中：xxx" to the completed label:
  //   • status badge → completed / error  (status event)
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
    // Enrich bare "任务完成" with the stable task name so the
    // dashboard / chat shows "任务完成：memo图片更换" instead of a dry "任务完成".
    // Prefer the current turn's stored task name; fall back to the last
    // session summary (from a prior intent_classify).
    if (message === '任务完成') {
      const cs = chatSessions.get(sessionName);
      // Prefer the closed-loop task goal (noun-phrase, model-generated); fall
      // back to the legacy currentTaskName, then to the last session summary.
      const goal = cs?.currentTask?.goal || cs?.currentTaskName || '';
      // Mark the closed-loop task done so ensureCurrentTask starts a fresh task
      // next turn (rather than continuing a finished one).
      if (cs?.currentTask) cs.currentTask.phase = 'done';
      if (goal) {
        message = `任务完成：${goal}`;
      } else {
        const sm = getSessionSummaries().get(sessionId);
        const raw = sm?.summary || '';
        // Strip any status label prefix plus optional " · subAction" / " — subAction" suffix
        const clean = raw.replace(/^(正在处理：|处理中：|任务完成：)/, '').replace(/\s*[·—]\s*.+$/, '').trim();
        if (clean) message = `任务完成：${clean}`;
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

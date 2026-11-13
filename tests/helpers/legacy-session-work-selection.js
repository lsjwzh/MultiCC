'use strict';

const crypto = require('crypto');
const {
  admitOutboxItem,
  normalizeJson,
} = require('../../src/outbox');
const {
  turnOutcomeForClassify, runStateForClassify, CLASSIFY_STATES,
  isProcessingLetter, isWaitForUserLetter, isTerminalLetter, isAbnormalLetter,
  isOutcomeLetter,
} = require('../../src/classify/vocab');
const { isUserTypedWork } = require('../../src/session-work/user-input');
const unattendedKernel = require('../../src/unattended/kernel');

const ACTIVE_STATES = new Set(['starting', 'running', 'assessing', 'frozen']);
const CONTROL_KINDS = new Set(['answer', 'approval', 'callback', 'continuation', 'retry', 'resume']);
const RESOLUTION_ACTIONS = new Set(['skip', 'cancel', 'resolve']);
const RETRY_ACTIONS = new Set(['retry', 'resume']);
// CLASSIFY_STATES (the live-letter membership set) comes from classify/vocab —
// the letters are declared once, there.

// freezeReason → classify letter. The ONE table for what a freeze means: the
// display run state below and classifyStateForReason both read it, and a
// letter-backed reason therefore renders exactly like its letter (vocab
// CLASSIFY_DISPLAY), so a frozen B slot can never draw differently from a
// settled B verdict.
//
// This replaced a hand-copied reason → runState table which had to be kept in
// sync with the classify letters by hand, and an older
// `String(reason).includes('error') ? 'error' : 'waiting'` substring heuristic,
// which collapsed EVERY non-"error" freeze into "Waiting for user" — falsely
// telling the user to act when the session was actually mid-recovery, settling a
// durable ack, or (with B) idling on a background job.
const FREEZE_REASON_CLASSIFY = Object.freeze({
  awaiting_user_input: 'W',
  waiting: 'W',
  classify_waiting: 'W',
  // External hand-off: a callback is outstanding, nothing is asked of the user.
  awaiting_callback: 'B',
  classify_background: 'B',
  // Faults / interruptions — surface as an attention state, NOT "waiting on you".
  error: 'E',
  classification_error: 'E',
  unknown_interruption: 'E',
  classify_error: 'E',
  // Live work the scheduler will drive forward — not user-blocked.
  incomplete_requires_resume: 'P',
  classify_running: 'P',
});

// Freezes with no classify letter. runState vocabulary is vocab TURN_RUN_STATES.
const FREEZE_REASON_EXTRA_RUN_STATE = Object.freeze({
  legacy_unresolved: 'error',
  delivery_recovery: 'running',
  continuation_ready: 'running',
  // Claim released; work is pending re-run.
  prelaunch_deferred: 'queued',
  // Auth/config not set up -- user must act, not a transient error. Stays
  // `waiting` here; the display layer refines it to `blocked` (go fix a
  // prerequisite, not answer in the conversation).
  configuration_required: 'waiting',
});

// Explicit freezeReason → display runState map. A reason not listed here falls
// back to a substring heuristic so a future scheduler reason never crashes the UI.
const FREEZE_REASON_RUN_STATE = Object.freeze({
  ...Object.fromEntries(Object.entries(FREEZE_REASON_CLASSIFY)
    .map(([reason, letter]) => [reason, runStateForClassify(letter)])),
  ...FREEZE_REASON_EXTRA_RUN_STATE,
});

function runStateForFreezeReason(reason) {
  const key = String(reason || '');
  if (Object.prototype.hasOwnProperty.call(FREEZE_REASON_RUN_STATE, key)) {
    return FREEZE_REASON_RUN_STATE[key];
  }
  // Backstop for any future/unknown reason: preserve the legacy heuristic so a
  // reason literally containing "error" still reads as a fault, else wait.
  return key.includes('error') ? 'error' : 'waiting';
}

const MAX_PUBLIC_MESSAGE_LENGTH = 20_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactJson(value) {
  const out = {};
  for (const [key, child] of Object.entries(value || {})) {
    if (child !== undefined) out[key] = child;
  }
  return normalizeJson(out);
}

function workKind(item) {
  const transferredKind = item?.turnLineage?.workKind;
  if (transferredKind) return transferredKind;
  const payload = item?.payload || {};
  if (payload.type === 'session.work') return payload.workKind || 'task';
  if (payload.type === 'dispatch.request') {
    return payload.taskStart === false && payload.taskId ? 'continuation' : 'task';
  }
  if (payload.type === 'wait.result' || payload.type === 'wait.callback'
      || payload.type === 'wait.resolved'
      || payload.type === 'detached.result' || payload.type === 'dispatch.result'
      || payload.type === 'task.interrupted') {
    return 'callback';
  }
  return payload.originContinue === true ? 'continuation' : 'task';
}

// A dispatch.result payload's taskId names the DISPATCHED task (the worker's),
// not the turn it wakes in the result session. Read as lineage it pinned the
// owner's active slot to the worker's task: every owner turn then projected
// 「执行中」 onto the worker's card, and the owner's own turn-end verdict hit
// active_task_mismatch and never released the slot.
function ownPayload(item) {
  return item?.payload?.type === 'dispatch.result' ? null : item?.payload;
}

function taskIdForItem(item) {
  return item?.turnLineage?.taskId || ownPayload(item)?.taskId || null;
}

function originDispatchIdForItem(item) {
  return item?.turnLineage?.originDispatchId
    || item?.payload?.originDispatchId
    || (item?.payload?.type === 'dispatch.request' ? item.payload.operationId : null)
    || null;
}

// The sender's own correlation id, when the entry came from a client send.
// Deliveries without one (cron, dispatch, auto-continue) are not somebody's
// typed message, and clients must not invent a bubble for them.
function clientMsgIdForItem(item) {
  const value = item?.payload?.options?.clientMsgId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function isControlItem(item) {
  return CONTROL_KINDS.has(workKind(item));
}

function isUserInputAnswer(item) {
  const payload = item?.payload || {};
  return payload.type === 'session.work'
    && workKind(item) === 'answer'
    && typeof payload.requestId === 'string'
    && payload.requestId.length > 0;
}

// The FIFO order can be rearranged by hand (reorderQueued). A hand-set order is
// a plain number on the outbox item and it outranks the admission sequence —
// and it is the ONLY field a reorder writes, so swapping two entries can never
// collide with another row's UNIQUE sequence in the store, and renumbering one
// session's queue cannot push it behind another session's work.
// An item without one (a message admitted after the rearrangement, or an answer
// to a pending question) keeps the admission sequence it was given, which sorts
// it after everything the user arranged — exactly where a new message belongs.
function queueRank(item) {
  const order = item?.queueOrder;
  return typeof order === 'number' && Number.isFinite(order)
    ? order
    : Number.POSITIVE_INFINITY;
}

function compareQueued(priorityEntryId) {
  return (a, b) => {
    if (a.id === priorityEntryId && b.id !== priorityEntryId) return -1;
    if (b.id === priorityEntryId && a.id !== priorityEntryId) return 1;
    const rankA = queueRank(a);
    const rankB = queueRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return a.sequence - b.sequence;
  };
}

// What the queue dock shows, in the order it shows it. publicSchedule and the
// reorder route both derive their notion of "position N" from this, so a
// client-supplied index means the same entry on both sides of the wire.
function visibleQueue(queue) {
  return queue.filter(item => !isUserInputAnswer(item));
}

function activeTaskId(schedule) {
  return schedule?.active?.taskId || null;
}

function classifyStateForSchedule(schedule) {
  if (CLASSIFY_STATES.has(schedule?.classifyState)) return schedule.classifyState;
  const letter = classifyStateForReason(schedule?.freezeReason);
  // A processing reason means "the scheduler is still driving this", which the
  // active slot answers better than the reason does; D is the settled default.
  if (letter && !isProcessingLetter(letter)) return letter;
  if (schedule?.active) return 'P';
  return 'D';
}

// The letter of a freeze → the freezeReason that records it. A lookup, not a
// decision: the two directions of this map must stay exact inverses of
// FREEZE_REASON_CLASSIFY (the W/B/E entries above), and a letter missing here
// (D, and the retired C) means "still being driven" → classify_running.
const FREEZE_REASON_BY_CLASSIFY = Object.freeze({
  W: 'classify_waiting',
  B: 'classify_background',
  E: 'classify_error',
});

function freezeReasonForClassify(classifyState) {
  return FREEZE_REASON_BY_CLASSIFY[classifyState] || 'classify_running';
}

function classifyStateForReason(reason) {
  const key = String(reason || '');
  return Object.prototype.hasOwnProperty.call(FREEZE_REASON_CLASSIFY, key)
    ? FREEZE_REASON_CLASSIFY[key]
    : null;
}

// Which control kinds may start a fresh native turn in each at-rest letter. The
// letters' meaning is vocab's; this table only says what kind of user move each
// parked/ended turn still accepts. Everything not listed (P mid-turn, and the
// retired C) accepts nothing here.
const CONTROL_KINDS_BY_CLASSIFY = Object.freeze({
  W: Object.freeze(['answer', 'approval', 'continuation']),
  B: Object.freeze(['callback', 'continuation']),
  E: Object.freeze(['retry', 'resume']),
});

function controlAllowedByClassify(item, classifyState) {
  const kind = workKind(item);
  // Every session.work payload is ultimately one native conversation message.
  // Classify P is the only staging gate; W/B/E/D may start a fresh CLI turn
  // even when the previous -p process and its physical active slot are gone.
  // E is an outcome label for that prior turn, never a queue gate.
  if (item?.payload?.type === 'session.work') return !isProcessingLetter(classifyState);
  // An async dispatch result is a new conversation message, not a background
  // wait state. It must never interrupt an active P turn, but once that turn
  // ends it wakes the Master from D/W/E just like direct chat input. No B state
  // is required (or manufactured) for this path.
  if (item?.payload?.type === 'dispatch.result') return !isProcessingLetter(classifyState);
  return (CONTROL_KINDS_BY_CLASSIFY[classifyState] || []).includes(kind);
}

function recoveredSuccessProven(schedule, recoveredState = {}) {
  if (!schedule?.active) return false;
  const activeStartedAt = Number(schedule.active.startedAt || schedule.active.claimedAt);
  const recoveredEndedAt = Number(recoveredState.endedAt);
  const taskMatches = !schedule.active.taskId || !recoveredState.taskId
    || schedule.active.taskId === recoveredState.taskId;
  return isTerminalLetter(recoveredState.classifyState)
    && Number.isFinite(activeStartedAt) && activeStartedAt > 0
    && Number.isFinite(recoveredEndedAt) && recoveredEndedAt >= activeStartedAt
    && taskMatches;
}

function newSchedule(sessionId, at) {
  return {
    sessionId,
    state: 'idle',
    freezeReason: null,
    awaitingRequestId: null,
    classifyState: null,
    // Wall-clock of the last classify verdict write, retained for diagnostics.
    classifyStateAt: null,
    priorityEntryId: null,
    active: null,
    lastDecision: null,
    updatedAt: at,
  };
}

function queuedText(item) {
  const payload = item?.payload || {};
  const value = payload.message || payload.taskText || payload.deliveryText || '';
  return String(value).slice(0, MAX_PUBLIC_MESSAGE_LENGTH);
}

function publicSchedule(schedule, queue = [], draft = null) {
  if (!schedule) return null;
  // A correlated request_user_input answer is a durable control hand-off, not
  // future user work. It must survive a crash while the asking process releases,
  // but exposing it in the ordinary FIFO makes the picker answer look "staged"
  // and lets reconnect snapshots resurrect that false queue card.
  const shown = visibleQueue(queue);
  return {
    sessionId: schedule.sessionId,
    state: schedule.state,
    freezeReason: schedule.freezeReason || null,
    awaitingRequestId: schedule.awaitingRequestId || null,
    classifyState: classifyStateForSchedule(schedule),
    active: withActiveInput(
      schedule.active ? clone(schedule.active) : null,
      draft ? activeItemForDraft(draft, schedule) : null,
    ),
    queued: shown.map((item, index) => ({
      entryId: item.id,
      taskId: taskIdForItem(item),
      source: item.payload?.source || item.source?.type || 'legacy',
      sequence: item.sequence,
      state: item.state,
      workKind: workKind(item),
      priority: item.id === schedule.priorityEntryId,
      position: index + 1,
      admittedAt: item.createdAt,
      clientMsgId: clientMsgIdForItem(item),
      text: queuedText(item),
      // A pending item with attempts > 0 is mid-failure (retry backoff), not
      // merely waiting its turn. The queue card is the only place that state is
      // visible — the report's complaint was a queue that looked healthy while
      // every attempt failed in private. The data lives on the outbox entry
      // itself (draft.outbox), so this is a projection, not a new source.
      // lastError stays one short line: the full multi-line remedy belongs to
      // the dead-letter notice, the card only has to say "failing, and why".
      attempts: Number(item.attempts) || 0,
      lastError: item.lastError
        ? String(item.lastError).split('\n')[0].trim().slice(0, 160)
        : null,
    })),
    lastDecision: schedule.lastDecision ? clone(schedule.lastDecision) : null,
    updatedAt: schedule.updatedAt,
  };
}

function activeItemForDraft(draft, schedule) {
  const key = schedule?.active?.deliveryId || schedule?.active?.entryId;
  return key ? draft.outbox[key] || null : null;
}

// A claimed entry has already left `queued`, so from claim until the turn starts
// the accepted input is renderable nowhere: the transcript only gains the user
// record when the turn appends it, and the sending page's own bubble dies with
// any reload or navigation. Carry it on the snapshot's `active` for exactly that
// window; once `startedAt` is set the turn owns the message and history is the
// only source, so the (up to 20KB) text stops travelling on every status read.
function withActiveInput(active, item) {
  if (!active || active.startedAt || !item) return active;
  const clientMsgId = clientMsgIdForItem(item);
  if (!clientMsgId) return active;
  return { ...active, clientMsgId, text: queuedText(item) };
}

function createSessionWorkScheduler({
  store,
  now = Date.now,
  cryptoImpl = crypto,
  onEvent = () => {},
  getClassifyState = null,
  getPendingUserInput = null,
  getTurnId = null,
  getUnattendedState = null,
  log = () => {},
} = {}) {
  if (!store || typeof store.mutate !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('[session-scheduler] orchestration store is required');
  }
  function safeQueueSummary(schedule, classifyState = null) {
    if (!schedule?.sessionId) return null;
    return {
      sessionId: schedule.sessionId,
      depth: Array.isArray(schedule.queued) ? schedule.queued.length : 0,
      state: ACTIVE_STATES.has(schedule.state) || schedule.state === 'idle'
        ? schedule.state : 'idle',
      classifyState: CLASSIFY_STATES.has(classifyState)
        ? classifyState : classifyStateForSchedule(schedule),
      updatedAt: Number(schedule.updatedAt) || 0,
    };
  }

  function emit(type, fields = {}) {
    const { schedule = null, ...publicFields } = fields;
    const event = { type, at: Number(now()), ...publicFields };
    if (schedule) event.queueSummary = safeQueueSummary(schedule);
    try { onEvent(event); } catch (_) {}
    try { log(`[session-scheduler] ${type} ${JSON.stringify(publicFields)}`); } catch (_) {}
    return event;
  }

  function ensure(draft, sessionId, at = Number(now())) {
    if (!draft.sessionSchedules[sessionId]) {
      draft.sessionSchedules[sessionId] = newSchedule(sessionId, at);
    }
    return draft.sessionSchedules[sessionId];
  }

  function queueForDraft(draft, sessionId) {
    const schedule = draft.sessionSchedules[sessionId];
    const activeDeliveryId = schedule?.active?.deliveryId || schedule?.active?.entryId || null;
    const priorityEntryId = schedule?.priorityEntryId || null;
    const candidates = typeof draft.select === 'function'
      ? draft.select('outbox', { where: { sessionId, state: ['pending', 'leased'] } })
      : Object.values(draft.outbox);
    return candidates
      .filter(item => item.sessionId === sessionId)
      .filter(item => item.state === 'pending' || item.state === 'leased')
      .filter(item => !activeDeliveryId || item.id !== activeDeliveryId)
      .sort(compareQueued(priorityEntryId));
  }

  function canonicalClassifyState(sessionId, schedule) {
    if (typeof getClassifyState === 'function') {
      try {
        const state = getClassifyState(sessionId);
        return CLASSIFY_STATES.has(state) ? state : null;
      } catch (error) {
        log(`[session-work] classify read failed for ${sessionId}: ${error.message}`);
        return null;
      }
    }
    // Standalone/legacy callers without the canonical classify port retain the
    // persisted recovery fallback. Production always supplies the port.
    return classifyStateForSchedule(schedule);
  }

  function canonicalPendingUserInput(sessionId) {
    if (typeof getPendingUserInput !== 'function') return null;
    try {
      const pending = getPendingUserInput(sessionId);
      if (!pending || pending.resolved === true || !pending.requestId) return null;
      return {
        requestId: String(pending.requestId),
        taskId: pending.taskId ? String(pending.taskId) : null,
        turnId: pending.turnId ? String(pending.turnId) : null,
        createdAt: Number(pending.createdAt) || null,
      };
    } catch (error) {
      log(`[session-work] pending user input read failed for ${sessionId}: ${error.message}`);
      return null;
    }
  }

  function relatedControl(schedule, item) {
    if (!schedule?.active || !isControlItem(item)) return false;
    const payload = item.payload || {};
    // User/control input is a self-contained conversation message. Correlation
    // metadata helps preserve task lineage but must never make input impossible.
    if (payload.type === 'session.work') return true;
    if (payload.activeEntryId && payload.activeEntryId !== schedule.active.entryId) return false;
    // task.interrupted.taskId names the child Task/Agent, not the parent
    // session task. Its durable same-session origin is the correlation proof.
    if (payload.type !== 'task.interrupted' && payload.type !== 'dispatch.result'
        && payload.taskId && activeTaskId(schedule)
        && payload.taskId !== activeTaskId(schedule)) return false;
    if (workKind(item) === 'answer' && schedule.awaitingRequestId
        && payload.requestId !== schedule.awaitingRequestId) return false;
    return true;
  }

  function isActiveReplay(schedule, item) {
    if (!schedule?.active || !item) return false;
    const activeDeliveryId = schedule.active.deliveryId || schedule.active.entryId;
    return !!activeDeliveryId && item.id === activeDeliveryId;
  }

  // A control entry's lineage is already fixed at admission/claim time (see the
  // turnLineage written by admit/claim/insertQueued). The delivery selector
  // still asks for a projection, so this stays a pass-through rather than
  // disappearing from the scheduler's contract.
  function projectItemLineage(item) {
    return item;
  }

  // Classify is the sole semantic gate. Only P stages typed chat input. A direct
  // continuation in every non-P state is immediately selectable; queued work
  // accumulated during P still advances only after classify D completes active.
  function selectSessionItem(items, draft, at) {
    if (!items.length) return null;
    const schedule = draft.sessionSchedules[items[0].sessionId];
    const priorityEntryId = schedule?.priorityEntryId || null;
    const pending = canonicalPendingUserInput(items[0].sessionId);
    // Node 只收集调度事实；FIFO 对无人值守消息的优先级由 Rust 决定。
    if (typeof getUnattendedState === 'function') {
      const selection = unattendedKernel.selectQueued({
        state: getUnattendedState(items[0].sessionId),
        now: at,
        hasActive: !!schedule?.active && schedule.state !== 'idle',
        classifyState: canonicalClassifyState(items[0].sessionId, schedule),
        pendingRequestId: pending?.requestId || null,
        items: [...items].sort(compareQueued(priorityEntryId)).map(item => ({
          id: item.id,
          workKind: workKind(item),
          requestId: item.payload?.requestId,
          unattendedSystem: item.payload?.options?.unattendedSystem,
          unattendedRecovery: item.payload?.options?.unattendedRecovery,
          taskSource: item.payload?.options?.taskSource || item.payload?.source,
          message: String(item.payload?.message || '').slice(0, 160),
        })),
      });
      if (selection.handled) return items.find(item => item.id === selection.entryId) || null;
    }
    const ordered = items.filter(item => {
      if (!pending || isActiveReplay(schedule, item)) return true;
      if (isUserInputAnswer(item) && item.payload.requestId === pending.requestId) return true;
      // Explicitly promoting an entry is a new user decision about this wait.
      if (item.userInputOverrideId === pending.requestId) return true;
      if (item.blockedByUserInput === pending.requestId) return false;
      if (schedule?.active && ['starting', 'running', 'assessing'].includes(schedule.state)) return false;
      // Also cover recovery and the gap between publishing W and complete().
      // A continuation queued before the question is not an answer to it.
      return !pending.createdAt || Number(item.createdAt) > pending.createdAt;
    }).sort(compareQueued(priorityEntryId));
    if (!schedule || !schedule.active || schedule.state === 'idle') {
      const cls = schedule
        ? (canonicalClassifyState(schedule.sessionId, schedule)
          || classifyStateForSchedule(schedule))
        : 'D';
      // P is the sole input staging state. Once classify leaves P, a typed or
      // control message may start a fresh native turn even if it was admitted
      // before the previous process exited. E describes the previous turn's
      // outcome only: it never gates this typed/control request, but ordinary
      // FIFO work stays staged behind it until a D verdict or an explicit
      // insert_queued/retry/resume releases it.
      if (!isProcessingLetter(cls)) {
        const direct = ordered.find(it => it.directRun);
        if (direct) return direct;
        const control = ordered.find(item => isControlItem(item)
          && controlAllowedByClassify(item, cls));
        if (control) return control;
      }
      // Only D drains the FIFO automatically: the queue advances on a turn that
      // finished successfully. W/B are real waits, P still has an owned turn,
      // and E is the previous request's fault — releasing the queue behind it
      // would auto-start work the user staged behind a turn that never succeeded.
      if (!isTerminalLetter(cls)) return null;
      return ordered[0];
    }
    const replay = ordered.find(item => isActiveReplay(schedule, item));
    if (replay) return replay;
    const classifyState = canonicalClassifyState(schedule.sessionId, schedule);
    const control = ordered.find(item => relatedControl(schedule, item)
      && controlAllowedByClassify(item, classifyState)) || null;
    return control;
  }

  return { selectSessionItem };
}

module.exports = { createSessionWorkScheduler };

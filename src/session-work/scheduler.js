'use strict';

const {
  turnOutcomeForClassify, runStateForClassify, CLASSIFY_STATES,
  isProcessingLetter, isWaitForUserLetter, isTerminalLetter, isAbnormalLetter,
  isOutcomeLetter,
} = require('../classify/vocab');
const { getNative } = require('../native/runtime');

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
  onEvent = () => {},
  getClassifyState = null,
  getPendingUserInput = null,
  getUnattendedState = null,
  getRunActive = null,
  ensureSessionWorkState = null,
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
        if (error?.code === 'SESSION_WORK_OWNER_UNAVAILABLE') throw error;
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
      if (error?.code === 'SESSION_WORK_OWNER_UNAVAILABLE') throw error;
      log(`[session-work] pending user input read failed for ${sessionId}: ${error.message}`);
      return null;
    }
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
    const priority = schedule?.priorityEntryId || null;
    const pending = canonicalPendingUserInput(items[0].sessionId);
    // `runActive` is the native selector's dead-letter proof: only an actual
    // boolean reaches the core, so unwired callers and unknown records fail
    // closed instead of asserting "no run" without knowledge.
    const runActiveRaw = typeof getRunActive === 'function'
      ? getRunActive(items[0].sessionId)
      : undefined;
    const runActive = typeof runActiveRaw === 'boolean' ? runActiveRaw : undefined;
    return getNative().sessionWorkSelect({ items, schedule, priority, pending, now: at, runActive,
      classify: id => canonicalClassifyState(id, schedule), unattended: getUnattendedState });
  }

  async function admit(input = {}) {
    if (ensureSessionWorkState) await ensureSessionWorkState(input.sessionId);
    if (typeof store.executeScheduleAdmit !== 'function') {
      throw new Error('session_work_admission_owner_unavailable');
    }
    const result = await store.executeScheduleAdmit(input, Number(now()));
    if (result.ok && !result.shellReplay) {
      const queuedItems = result.queued
        ? result.schedule.queued
        : result.schedule.queued.filter(item => item.entryId !== result.entry.id);
      emit('queued', {
        message: result.entry.payload?.message || null,
        clientMsgId: result.entry.payload?.options?.clientMsgId || null,
        sessionId: result.entry.sessionId,
        entryId: result.entry.id,
        taskId: result.entry.payload?.taskId || null,
        source: result.entry.payload?.source || 'direct',
        workKind: result.entry.payload?.workKind || 'task',
        duplicate: result.duplicate,
        queued: result.queued,
        queuePosition: result.queued ? result.position || null : null,
        schedulerState: result.schedule.state,
        freezeReason: result.schedule.freezeReason,
        queuedItems,
        schedule: result.schedule,
      });
    }
    return result;
  }

  async function claim(item) {
    if (ensureSessionWorkState) await ensureSessionWorkState(item.sessionId);
    const result = await store.mutate(draft => getNative().scheduleClaimLive(
      draft, item, now, schedule => publicSchedule(schedule, queueForDraft(draft, item.sessionId), draft)));
    if (result.ok) emit('claimed', {
      sessionId: item.sessionId,
      entryId: item.id,
      taskId: result.schedule.active?.taskId || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function started(item) {
    const result = await store.mutate(draft => getNative().scheduleLifecycleLive(
      draft, 'started', item, now, schedule => publicSchedule(schedule, queueForDraft(draft, item.sessionId), draft)));
    if (result.ok) emit('started', {
      sessionId: item.sessionId,
      entryId: result.schedule.active?.entryId,
      deliveryId: item.id,
      taskId: result.schedule.active?.taskId || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function releaseClaim(item, reason = 'prelaunch_deferred') {
    const result = await store.mutate(draft => getNative().scheduleLifecycleLive(
      draft, 'releaseClaim', item, now, schedule => publicSchedule(schedule, queueForDraft(draft, item.sessionId), draft)));
    if (result.ok) emit('claim_released', {
      sessionId: item.sessionId,
      entryId: item.id,
      taskId: result.schedule.active?.taskId || taskIdForItem(item),
      reason,
      // The mid-flight branch freezes the slot instead of emptying it, and the
      // two outcomes read as different states. Carried here for the same reason
      // the `queued` event carries it: the consumer projects a run state from
      // this event, and `emit` drops the schedule it would otherwise read.
      freezeReason: result.schedule.freezeReason,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function turnEnded(sessionId) {
    const result = await store.mutate(draft => getNative().scheduleLifecycleLive(
      draft, 'turnEnded', sessionId, now, schedule => publicSchedule(schedule, queueForDraft(draft, sessionId), draft)));
    if (result.ok) emit('assessing', {
      sessionId,
      entryId: result.schedule.active?.entryId || null,
      taskId: result.schedule.active?.taskId || null,
      schedulerState: 'assessing',
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function freeze(sessionId, reason, {
    requestId = null,
    expectedTaskId = null,
    classifyState = null,
  } = {}) {
    const result = await store.mutate(draft => getNative().scheduleFreezeLive(
      draft, sessionId, reason, requestId, expectedTaskId, classifyState, now,
      schedule => publicSchedule(schedule, queueForDraft(draft, sessionId), draft)));
    if (result.ok) emit('frozen', {
      sessionId,
      entryId: result.schedule.active?.entryId,
      taskId: result.schedule.active?.taskId || null,
      freezeReason: result.schedule.freezeReason,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function complete(sessionId, {
    expectedTaskId = null,
    reason = 'successful',
    classifyState = 'D',
    awaitingRequestId = null,
  } = {}) {
    if (typeof store.executeScheduleComplete !== 'function') {
      throw new Error('session_work_completion_owner_unavailable');
    }
    const result = await store.executeScheduleComplete({
      sessionId, expectedTaskId, reason, classifyState, awaitingRequestId, clock: now,
    });
    // The explicit turn outcome travels WITH the scheduler bookkeeping event.
    // `completed` means only that the active slot was released; it is never a
    // TaskBoard lifecycle decision. Projections may render `succeeded`, while
    // only a user action may write task.status = done.
    if (result.ok) emit('completed', {
      sessionId,
      entryId: result.completed.entryId,
      taskId: result.completed.taskId || null,
      classifyState: result.schedule.classifyState || null,
      turnOutcome: turnOutcomeForClassify(result.schedule.classifyState),
      reason,
      attemptOutcome: result.completed.supersededByEntryId ? 'superseded' : null,
      supersededByEntryId: result.completed.supersededByEntryId || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function settlePersistedDelivery(item, recoveredState = {}) {
    const current = await status(item.sessionId);
    if (!current?.active || current.active.deliveryId !== item.id) {
      return { ok: false, code: 'active_delivery_mismatch' };
    }
    if (recoveredSuccessProven(current, recoveredState)) {
      return complete(item.sessionId, {
        expectedTaskId: taskIdForItem(item),
        reason: 'recovered-success',
      });
    }
    const recoveredClassify = CLASSIFY_STATES.has(recoveredState.classifyState)
      ? recoveredState.classifyState : null;
    // Recovery follows the same rule as the live path (T1): every verdict
    // releases the active slot via complete(). D drains the FIFO; W/B/E leave
    // it. No classify-driven freeze on restart either.
    if (recoveredClassify) {
      return complete(item.sessionId, {
        expectedTaskId: taskIdForItem(item),
        reason: `recovered_${recoveredClassify}`,
        classifyState: recoveredClassify,
      });
    }
    // Delivery durability only settles the outbox lease. Without a correlated
    // classify verdict, park the active entry for a fresh classify pass.
    return turnEnded(item.sessionId);
  }

  async function resolve(sessionId, {
    action,
    reason = '',
    actor = 'user',
    text = '',
    idempotencyKey = null,
  } = {}) {
    if (RETRY_ACTIONS.has(action)) {
      const current = await status(sessionId);
      if (!isAbnormalLetter(current.classifyState)) {
        return { ok: false, code: 'active_task_not_retryable' };
      }
      const lineage = current.active || current.lastDecision || {};
      return admit({
        sessionId,
        text: String(text || '').trim() || '请继续刚才未完成的任务。',
        source: 'manual-resolution',
        workKind: action,
        activeEntryId: current.active?.entryId || null,
        idempotencyKey: idempotencyKey || `${action}:${lineage.entryId || sessionId}:${Date.now()}`,
        options: {
          originContinue: true,
          taskId: lineage.taskId || undefined,
          originDispatchId: lineage.originDispatchId || undefined,
          clientMsgId: idempotencyKey || undefined,
        },
      });
    }
    if (!RESOLUTION_ACTIONS.has(action)) throw new TypeError(`invalid resolution action: ${action}`);
    const result = await store.mutate(draft => getNative().scheduleResolveLive(
      draft, sessionId, action, reason, actor, now,
      schedule => publicSchedule(schedule, queueForDraft(draft, sessionId), draft)));
    // taskId was missing here, so every resolution event reached the task board
    // as `task_not_found` and left the card on its previous run state.
    if (result.ok) emit(action === 'cancel' ? 'cancelled' : 'skipped', {
      sessionId,
      entryId: result.resolved.entryId,
      taskId: result.resolved.taskId || null,
      action,
      actor,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  // Bookkeeping for an explicitly dismissed question after W released the slot.
  // The classify host owns the D verdict; this never admits or runs new work.
  async function settleUserInput(sessionId, requestId) {
    const mutate = draft => getNative().scheduleSettleLive(draft, sessionId, requestId, now);
    if (typeof store.settleScheduleInput === 'function') {
      return store.settleScheduleInput(sessionId, requestId, now, mutate);
    }
    return store.mutate(mutate);
  }

  async function status(sessionId) {
    return store.read(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      const current = schedule || newSchedule(sessionId, 0);
      const result = publicSchedule(current, queueForDraft(draft, sessionId), draft);
      result.classifyState = canonicalClassifyState(sessionId, current);
      return result;
    });
  }

  async function cancelQueued(sessionId, entryId, {
    actor = 'user',
    reason = 'cancelled before start',
  } = {}) {
    const cleanEntryId = String(entryId || '').trim();
    if (!cleanEntryId) throw new TypeError('queued cancellation requires entryId');
    const result = await store.mutate(draft => getNative().scheduleCancelQueuedLive(
      draft, sessionId, cleanEntryId, actor, reason, now,
      schedule => publicSchedule(schedule, queueForDraft(draft, sessionId), draft)));
    if (result.ok) emit('queued_cancelled', {
      sessionId,
      entryId: result.cancelled.entryId,
      actor,
      schedulerState: result.schedule.state,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      freezeReason: result.schedule.freezeReason,
      schedule: result.schedule,
    });
    return result;
  }

  async function insertQueued(sessionId, entryId, { actor = 'user' } = {}) {
    const cleanEntryId = String(entryId || '').trim();
    if (!cleanEntryId) throw new TypeError('queued insertion requires entryId');
    const result = await store.mutate(draft => getNative().scheduleInsertQueuedLive(
      draft, sessionId, cleanEntryId, actor, now, () => canonicalPendingUserInput(sessionId),
      schedule => publicSchedule(schedule, queueForDraft(draft, sessionId), draft)));
    if (result.ok) emit('queued_inserted', {
      sessionId,
      entryId: result.inserted.entryId,
      actor,
      schedulerState: result.schedule.state,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      freezeReason: result.schedule.freezeReason,
      schedule: result.schedule,
    });
    return result;
  }

  // Moving a staged message is an ordering decision, not a scheduling one: it
  // never claims a slot, never cancels the active turn and never rewrites the
  // admission sequence. The whole visible queue is renumbered 0..n-1 in the
  // requested order, so a second move means the same thing as the first and
  // there are never gaps to run out of. Positions are counted over exactly what
  // the queue dock shows (publicSchedule), so an index from a client means the
  // same entry on both sides of the wire.
  async function reorderQueued(sessionId, entryId, {
    toIndex = null,
    direction = null,
    actor = 'user',
  } = {}) {
    const cleanEntryId = String(entryId || '').trim();
    if (!cleanEntryId) throw new TypeError('queued reorder requires entryId');
    const result = await store.mutateSync('scheduleReorder', {
      sessionId, entryId: cleanEntryId, toIndex, direction, actor, now,
    });
    if (result.ok && !result.unchanged) {
      emit('queued_reordered', {
        sessionId,
        entryId: result.reordered.entryId,
        actor,
        from: result.reordered.from,
        to: result.reordered.to,
        schedulerState: result.schedule.state,
        queued: result.schedule.queued.length,
        queuedItems: result.schedule.queued,
        freezeReason: result.schedule.freezeReason,
        schedule: result.schedule,
      });
    }
    return result;
  }

  /// 改一条还没开始执行的暂存消息的正文。和 cancel/reorder 同一套守卫：已被
  /// 领取的条目在跑了，正文不再是用户说了算。改的是 payload.message（所有
  /// session.work 输入都落在这里），顺序、idempotency、clientMsgId 一律不动。
  async function editQueued(sessionId, entryId, {
    text = '',
    actor = 'user',
  } = {}) {
    const cleanEntryId = String(entryId || '').trim();
    if (!cleanEntryId) throw new TypeError('queued edit requires entryId');
    const cleanText = String(text || '').trim();
    if (!cleanText) return { ok: false, code: 'queued_entry_text_required' };
    const result = await store.mutate(draft => getNative().scheduleEditQueuedLive(
      draft, sessionId, cleanEntryId, cleanText, actor, now,
      () => queueForDraft(draft, sessionId), (schedule, queue) => publicSchedule(schedule, queue, draft)));
    if (result.ok) {
      emit('queued_edited', {
        sessionId,
        entryId: result.edited.entryId,
        actor,
        schedulerState: result.schedule.state,
        queued: result.schedule.queued.length,
        queuedItems: result.schedule.queued,
        freezeReason: result.schedule.freezeReason,
        schedule: result.schedule,
      });
    }
    return result;
  }

  async function noteQueued(entryId) {
    const info = await store.mutate(draft => getNative().scheduleNoteQueuedLive(
      draft, entryId, now, session => queueForDraft(draft, session),
      (queue, at) => selectSessionItem(queue, draft, at),
      (schedule, queue) => publicSchedule(schedule, queue, draft)));
    if (!info) return { ok: false, code: 'entry_not_found' };
    emit('queued', {
      sessionId: info.item.sessionId,
      entryId: info.item.id,
      taskId: taskIdForItem(info.item),
      source: info.item.payload?.taskSource || info.item.source?.type || 'dispatch',
      workKind: workKind(info.item),
      message: queuedText(info.item),
      clientMsgId: info.item.payload?.options?.clientMsgId || null,
      duplicate: false,
      queued: info.queued,
      queuePosition: info.position || null,
      schedulerState: info.schedulerState,
      freezeReason: info.schedule.freezeReason,
      queuedItems: info.schedule.queued,
      schedule: info.schedule,
    });
    return { ok: true, position: info.position || null };
  }

  async function list() {
    return store.read(draft => Object.keys(draft.sessionSchedules).sort()
      .map(sessionId => publicSchedule(
        draft.sessionSchedules[sessionId],
        queueForDraft(draft, sessionId),
        draft,
      )));
  }

  async function queueSummaries(sessionIds = null) {
    const requested = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.map(value => String(value || '').trim()).filter(Boolean))]
      : null;
    return store.read(draft => {
      const ids = requested || [...new Set([
        ...Object.keys(draft.sessionSchedules),
        ...(typeof draft.select === 'function'
          ? draft.select('outbox', { where: { state: ['pending', 'leased'] } })
          : Object.values(draft.outbox))
          .filter(item => item.state === 'pending' || item.state === 'leased')
          .map(item => item.sessionId),
      ])].sort();
      return ids.map((sessionId) => {
        const schedule = draft.sessionSchedules[sessionId] || newSchedule(sessionId, 0);
        const projected = publicSchedule(schedule, queueForDraft(draft, sessionId), draft);
        return safeQueueSummary(
          projected,
          canonicalClassifyState(sessionId, schedule) || projected.classifyState,
        );
      });
    });
  }

  async function recover({
    stateForSession = () => null,
  } = {}) {
    const events = await store.mutate(draft => {
      const at = Number(now());
      const changes = [];
      const sessionIds = new Set([
        ...Object.keys(draft.sessionSchedules),
        ...(typeof draft.select === 'function'
          ? draft.select('outbox', { where: { state: ['pending', 'leased'] } })
          : Object.values(draft.outbox))
          .filter(item => item.state === 'pending' || item.state === 'leased')
          .map(item => item.sessionId),
      ]);
      for (const sessionId of sessionIds) {
        let schedule = draft.sessionSchedules[sessionId];
        const recoveredState = stateForSession(sessionId) || {};
        const recoveredClassify = CLASSIFY_STATES.has(recoveredState.classifyState)
          ? recoveredState.classifyState
          : null;
        if (!schedule) {
          schedule = ensure(draft, sessionId, at);
          schedule.classifyState = recoveredClassify;
          // Recovery cannot reconstruct the original verdict wall-clock; keep
          // the recovery time only as diagnostic metadata.
          schedule.classifyStateAt = at;
          // A pending outbox item is not evidence of an active task. This is
          // especially important now that the public FIFO includes callbacks:
          // a lone task.interrupted notification must remain deliverable.
          // Rebuild a legacy active pointer only from an explicit non-D
          // classify fact.
          // Rebuild a legacy active pointer only from an explicit non-outcome
          // classify fact: a parked or mid-turn verdict still owns the slot, a
          // finished one (D/E) does not.
          if (recoveredClassify && !isOutcomeLetter(recoveredClassify)) {
            schedule.active = {
              entryId: `legacy-active:${sessionId}`,
              deliveryId: null,
              taskId: recoveredState.taskId || null,
              originDispatchId: recoveredState.originDispatchId || null,
              source: 'legacy',
              workKind: 'task',
              admittedAt: recoveredState.startedAt || at,
              startedAt: recoveredState.startedAt || null,
              attempt: 0,
              legacy: true,
            };
            schedule.state = recoveredClassify ? 'frozen' : 'assessing';
            schedule.freezeReason = recoveredClassify
              ? freezeReasonForClassify(recoveredClassify) : null;
            schedule.updatedAt = at;
            changes.push({
              type: 'frozen',
              sessionId,
              reason: schedule.freezeReason,
            });
          }
          continue;
        }
        if (recoveredClassify) {
          schedule.classifyState = recoveredClassify;
          schedule.classifyStateAt = at;
        }
        const classifyState = classifyStateForSchedule(schedule);
        if (!schedule.active) {
          schedule.state = 'idle';
          schedule.freezeReason = null;
          schedule.awaitingRequestId = null;
          schedule.updatedAt = at;
          continue;
        }
        const activeDelivery = schedule.active.deliveryId
          ? draft.outbox[schedule.active.deliveryId]
          : null;
        const deliveryNeedsAck = activeDelivery
          && (activeDelivery.state === 'pending' || activeDelivery.state === 'leased');
        if (isAbnormalLetter(classifyState)) {
          const completed = clone(schedule.active);
          schedule.active = null;
          schedule.state = 'idle';
          schedule.freezeReason = null;
          schedule.awaitingRequestId = null;
          schedule.lastDecision = {
            action: completed.supersededByEntryId ? 'superseded' : 'complete',
            reason: completed.supersededByEntryId
              ? 'superseded_by_immediate_insert' : 'recovered-classify-E',
            entryId: completed.entryId,
            taskId: completed.taskId || null,
            originDispatchId: completed.originDispatchId || null,
            supersededByEntryId: completed.supersededByEntryId || null,
            at,
          };
          schedule.updatedAt = at;
          changes.push({
            type: 'completed',
            sessionId,
            entryId: completed.entryId,
            taskId: completed.taskId || null,
            classifyState: 'E',
            turnOutcome: 'failed',
            queued: queueForDraft(draft, sessionId).length,
            queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId), draft).queued,
          });
          continue;
        }
        if (isTerminalLetter(classifyState)) {
          if (!recoveredSuccessProven(schedule, recoveredState)) {
            schedule.classifyState = 'P';
            schedule.state = 'assessing';
            schedule.freezeReason = null;
            schedule.updatedAt = at;
            changes.push({
              type: 'assessing',
              sessionId,
              entryId: schedule.active.entryId,
              taskId: schedule.active.taskId || null,
              queued: queueForDraft(draft, sessionId).length,
              queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId), draft).queued,
            });
            continue;
          }
          if (deliveryNeedsAck) {
            schedule.state = 'frozen';
            schedule.freezeReason = 'delivery_recovery';
            schedule.updatedAt = at;
            changes.push({
              type: 'frozen',
              sessionId,
              entryId: schedule.active.entryId,
              taskId: schedule.active.taskId || null,
              reason: schedule.freezeReason,
              queued: queueForDraft(draft, sessionId).length,
              queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId), draft).queued,
            });
            continue;
          }
          const completed = clone(schedule.active);
          schedule.active = null;
          schedule.state = 'idle';
          schedule.freezeReason = null;
          schedule.awaitingRequestId = null;
          schedule.lastDecision = {
            action: completed.supersededByEntryId ? 'superseded' : 'complete',
            reason: completed.supersededByEntryId
              ? 'superseded_by_immediate_insert' : 'recovered-classify-D',
            entryId: completed.entryId,
            taskId: completed.taskId || null,
            originDispatchId: completed.originDispatchId || null,
            supersededByEntryId: completed.supersededByEntryId || null,
            at,
          };
          schedule.updatedAt = at;
          changes.push({
            type: 'completed',
            sessionId,
            entryId: completed.entryId,
            taskId: completed.taskId || null,
            classifyState: 'D',
            turnOutcome: 'succeeded',
            queued: queueForDraft(draft, sessionId).length,
            queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId), draft).queued,
          });
          continue;
        }
        if (CLASSIFY_STATES.has(classifyState)) {
          schedule.state = 'frozen';
          schedule.freezeReason = freezeReasonForClassify(classifyState);
          schedule.updatedAt = at;
          changes.push({
            type: 'frozen',
            sessionId,
            entryId: schedule.active.entryId,
            taskId: schedule.active.taskId || null,
            reason: schedule.freezeReason,
            queued: queueForDraft(draft, sessionId).length,
            queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId), draft).queued,
          });
          continue;
        }
        // Process liveness is not a FIFO semantic. An unknown legacy state must
        // wait for classify instead of inventing a running/frozen decision.
        schedule.state = 'assessing';
        schedule.freezeReason = null;
        schedule.updatedAt = at;
      }
      return changes;
    });
    const summaries = new Map((await queueSummaries(events.map(event => event.sessionId)))
      .map(summary => [summary.sessionId, summary]));
    for (const event of events) emit(event.type, {
      sessionId: event.sessionId,
      entryId: event.entryId || null,
      taskId: event.taskId || null,
      queued: event.queued == null ? null : event.queued,
      queuedItems: event.queuedItems || [],
      freezeReason: event.type === 'frozen' ? event.reason : null,
      classifyState: event.classifyState || null,
      turnOutcome: event.turnOutcome || null,
      queueSummary: summaries.get(event.sessionId) || null,
      recovered: true,
    });
    return { ok: true, changes: events.length };
  }

  return Object.freeze({
    admit,
    claim,
    started,
    releaseClaim,
    turnEnded,
    freeze,
    complete,
    resolve,
    settleUserInput,
    cancelQueued,
    insertQueued,
    reorderQueued,
    editQueued,
    status,
    queueSummaries,
    noteQueued,
    list,
    recover,
    settlePersistedDelivery,
    selectSessionItem,
    projectItemLineage,
    isControlItem,
  });
}

module.exports = {
  ACTIVE_STATES,
  CONTROL_KINDS,
  FREEZE_REASON_CLASSIFY,
  FREEZE_REASON_RUN_STATE,
  createSessionWorkScheduler,
  isControlItem,
  runStateForFreezeReason,
  workKind,
};

'use strict';

const crypto = require('crypto');
const {
  admitOutboxItem,
  normalizeJson,
} = require('./outbox');
const { turnOutcomeForClassify } = require('./classify/vocab');

const ACTIVE_STATES = new Set(['starting', 'running', 'assessing', 'frozen']);
const CONTROL_KINDS = new Set(['answer', 'approval', 'callback', 'continuation', 'retry', 'resume']);
const RESOLUTION_ACTIONS = new Set(['skip', 'cancel', 'resolve']);
const RETRY_ACTIONS = new Set(['retry', 'resume']);
const CLASSIFY_STATES = new Set(['P', 'D', 'W', 'B', 'E']);

// Explicit freezeReason → display runState map. Replaces the old
// `String(reason).includes('error') ? 'error' : 'waiting'` substring heuristic,
// which collapsed EVERY non-"error" freeze into "Waiting for user" — falsely
// telling the user to act when the session was actually mid-recovery, settling a
// durable ack, or interrupted. runState vocabulary is the fixed renderable set
// {queued, running, waiting, error, succeeded, idle}. A reason not listed here falls
// back to the old heuristic so a future scheduler reason never crashes the UI.
const FREEZE_REASON_RUN_STATE = Object.freeze({
  // Genuinely handed back to the user / an external party.
  awaiting_user_input: 'waiting',
  awaiting_callback: 'waiting',
  waiting: 'waiting',
  // Faults / interruptions — surface as an attention state, NOT "waiting on you".
  error: 'error',
  classification_error: 'error',
  unknown_interruption: 'error',
  legacy_unresolved: 'error',
  // Live work the scheduler will drive forward — not user-blocked.
  delivery_recovery: 'running',
  continuation_ready: 'running',
  incomplete_requires_resume: 'running',
  // Claim released; work is pending re-run.
  prelaunch_deferred: 'queued',
  classify_waiting: 'waiting',
  classify_background: 'waiting',
  classify_error: 'error',
  classify_running: 'running',
  // Auth/config not set up -- user must act, not a transient error.
  configuration_required: 'waiting',
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

function taskIdForItem(item) {
  return item?.turnLineage?.taskId || item?.payload?.taskId || null;
}

function taskRunIdForItem(item) {
  return item?.turnLineage?.taskRunId
    || item?.payload?.taskRunId
    || item?.payload?.options?.taskRunId
    || null;
}

function leaseEpochForItem(item) {
  const value = item?.turnLineage?.leaseEpoch
    ?? item?.payload?.leaseEpoch
    ?? item?.payload?.options?.leaseEpoch;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function originDispatchIdForItem(item) {
  return item?.turnLineage?.originDispatchId
    || item?.payload?.originDispatchId
    || (item?.payload?.type === 'dispatch.request' ? item.payload.operationId : null)
    || null;
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

function activeTaskId(schedule) {
  return schedule?.active?.taskId || null;
}

function classifyStateForSchedule(schedule) {
  if (CLASSIFY_STATES.has(schedule?.classifyState)) return schedule.classifyState;
  if (schedule?.freezeReason === 'awaiting_user_input' || schedule?.freezeReason === 'waiting') return 'W';
  if (schedule?.freezeReason === 'awaiting_callback') return 'B';
  if (schedule?.freezeReason === 'error' || schedule?.freezeReason === 'classification_error'
      || schedule?.freezeReason === 'unknown_interruption') return 'E';
  if (schedule?.active) return 'P';
  return 'D';
}

function freezeReasonForClassify(classifyState) {
  if (classifyState === 'W') return 'classify_waiting';
  if (classifyState === 'B') return 'classify_background';
  if (classifyState === 'E') return 'classify_error';
  return 'classify_running';
}

function classifyStateForReason(reason) {
  const key = String(reason || '');
  if (key === 'awaiting_user_input' || key === 'waiting' || key === 'classify_waiting') return 'W';
  if (key === 'awaiting_callback' || key === 'classify_background') return 'B';
  if (key === 'error' || key === 'classification_error' || key === 'unknown_interruption'
      || key === 'classify_error') return 'E';
  if (key === 'incomplete_requires_resume' || key === 'classify_running') return 'P';
  return null;
}

function controlAllowedByClassify(item, classifyState) {
  const kind = workKind(item);
  // Every session.work payload is ultimately one native conversation message.
  // Classify P is the only staging gate; W/B/E/D may start a fresh CLI turn
  // even when the previous -p process and its physical active slot are gone.
  if (item?.payload?.type === 'session.work') return classifyState !== 'P';
  // An async dispatch result is a new conversation message, not a background
  // wait state. It must never interrupt an active P turn, but once that turn
  // ends it wakes the Master from D/W/E just like direct chat input. No B state
  // is required (or manufactured) for this path.
  if (item?.payload?.type === 'dispatch.result') return classifyState !== 'P';
  if (classifyState === 'W') return kind === 'answer' || kind === 'approval' || kind === 'continuation';
  if (classifyState === 'B') return kind === 'callback' || kind === 'continuation';
  if (classifyState === 'E') return kind === 'retry' || kind === 'resume';
  return false;
}

function recoveredSuccessProven(schedule, recoveredState = {}) {
  if (!schedule?.active) return false;
  const activeStartedAt = Number(schedule.active.startedAt || schedule.active.claimedAt);
  const recoveredEndedAt = Number(recoveredState.endedAt);
  const taskMatches = !schedule.active.taskId || !recoveredState.taskId
    || schedule.active.taskId === recoveredState.taskId;
  return recoveredState.classifyState === 'D'
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

function publicSchedule(schedule, queue = []) {
  if (!schedule) return null;
  // A correlated request_user_input answer is a durable control hand-off, not
  // future user work. It must survive a crash while the asking process releases,
  // but exposing it in the ordinary FIFO makes the picker answer look "staged"
  // and lets reconnect snapshots resurrect that false queue card.
  const visibleQueue = queue.filter(item => !isUserInputAnswer(item));
  return {
    sessionId: schedule.sessionId,
    state: schedule.state,
    freezeReason: schedule.freezeReason || null,
    awaitingRequestId: schedule.awaitingRequestId || null,
    classifyState: classifyStateForSchedule(schedule),
    active: schedule.active ? clone(schedule.active) : null,
    queued: visibleQueue.map((item, index) => ({
      entryId: item.id,
      taskId: taskIdForItem(item),
      taskRunId: taskRunIdForItem(item),
      leaseEpoch: leaseEpochForItem(item),
      source: item.payload?.source || item.source?.type || 'legacy',
      sequence: item.sequence,
      state: item.state,
      workKind: workKind(item),
      priority: item.id === schedule.priorityEntryId,
      position: index + 1,
      admittedAt: item.createdAt,
      text: queuedText(item),
    })),
    lastDecision: schedule.lastDecision ? clone(schedule.lastDecision) : null,
    updatedAt: schedule.updatedAt,
  };
}

function createSessionWorkScheduler({
  store,
  now = Date.now,
  cryptoImpl = crypto,
  onEvent = () => {},
  getClassifyState = null,
  getPendingUserInput = null,
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
    return Object.values(draft.outbox)
      .filter(item => item.sessionId === sessionId)
      .filter(item => item.state === 'pending' || item.state === 'leased')
      .filter(item => !activeDeliveryId || item.id !== activeDeliveryId)
      .sort((a, b) => {
        if (a.id === priorityEntryId && b.id !== priorityEntryId) return -1;
        if (b.id === priorityEntryId && a.id !== priorityEntryId) return 1;
        return a.sequence - b.sequence;
      });
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
    if (payload.type !== 'task.interrupted'
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

  function projectControlLineage(schedule, item) {
    if (!item || !isControlItem(item)) return item;
    const incomingTaskId = taskIdForItem(item);
    const incomingRunId = taskRunIdForItem(item);
    const candidate = schedule?.active?.taskRunId
      ? schedule.active
      : ['W', 'B'].includes(classifyStateForSchedule(schedule))
        ? schedule?.lastDecision
        : null;
    if (!candidate?.taskRunId
        || (incomingTaskId && candidate.taskId && incomingTaskId !== candidate.taskId)
        || (incomingRunId && incomingRunId !== candidate.taskRunId)) return item;
    return {
      ...item,
      turnLineage: {
      ...(item.turnLineage || {}),
      taskId: incomingTaskId || candidate.taskId || null,
      taskRunId: incomingRunId || candidate.taskRunId,
      leaseEpoch: leaseEpochForItem(item) || candidate.leaseEpoch || null,
      originDispatchId: originDispatchIdForItem(item)
        || candidate.originDispatchId || null,
      workKind: item.turnLineage?.workKind || workKind(item),
      inheritedBy: item.turnLineage?.inheritedBy || 'retained_task_run_boundary',
      },
    };
  }

  function projectItemLineage(item, draft) {
    const schedule = draft?.sessionSchedules?.[item?.sessionId];
    return projectControlLineage(schedule, item);
  }

  // Classify is the sole semantic gate. Only P stages typed chat input. A direct
  // continuation in every non-P state is immediately selectable; queued work
  // accumulated during P still advances only after classify D completes active.
  function selectSessionItem(items, draft, at) {
    if (!items.length) return null;
    const schedule = draft.sessionSchedules[items[0].sessionId];
    const priorityEntryId = schedule?.priorityEntryId || null;
    const ordered = [...items].sort((a, b) => {
      if (a.id === priorityEntryId && b.id !== priorityEntryId) return -1;
      if (b.id === priorityEntryId && a.id !== priorityEntryId) return 1;
      return a.sequence - b.sequence;
    });
    if (!schedule || !schedule.active || schedule.state === 'idle') {
      const cls = schedule
        ? (canonicalClassifyState(schedule.sessionId, schedule)
          || classifyStateForSchedule(schedule))
        : 'D';
      // P is the sole input staging state. Once classify leaves P, a typed or
      // control message may start a fresh native turn even if it was admitted
      // before the previous process exited.
      if (cls !== 'P') {
        const direct = ordered.find(it => it.directRun);
        if (direct) return direct;
        const control = ordered.find(item => isControlItem(item)
          && controlAllowedByClassify(item, cls));
        if (control) return control;
      }
      // At-rest verdicts (W/B) leave stale FIFO items untouched — the queue
      // does nothing until the user's next direct admit or a D verdict. Every
      // other state (D succeeded, never-classified, P exhausted) drains FIFO.
      if (cls === 'W' || cls === 'B') return null;
      if (cls === 'E') {
        // E parks the queue for a human decision, and a hidden task execution
        // slot has no human: Task Board owns the failed run's lifecycle (the
        // error ledger entry and the bounded retry already consumed the E
        // verdict), so its own re-engagement — any delivery carrying task-run
        // lineage — IS that decision. Unlock the oldest lineage item; ordinary
        // deliveries stay parked exactly as before.
        const reengagement = ordered.find(item => taskRunIdForItem(item) != null);
        if (reengagement) return reengagement;
        return null;
      }
      if (cls === 'P') return null;
      return ordered[0];
    }
    const replay = ordered.find(item => isActiveReplay(schedule, item));
    if (replay) return replay;
    const classifyState = canonicalClassifyState(schedule.sessionId, schedule);
    const control = ordered.find(item => relatedControl(schedule, item)
      && controlAllowedByClassify(item, classifyState)) || null;
    return control;
  }

  function stableEntryId(sessionId, key, payload) {
    const identity = key
      ? `key:${key}`
      : `new:${cryptoImpl.randomUUID()}:${JSON.stringify(payload).length}`;
    const suffix = cryptoImpl.createHash('sha256')
      .update(`${sessionId}\0${identity}`, 'utf8')
      .digest('hex')
      .slice(0, 40);
    return `session-work:${suffix}`;
  }

  async function admit({
    sessionId,
    text,
    options = {},
    source = null,
    workKind: requestedKind = null,
    requestId = null,
    activeEntryId = null,
    idempotencyKey = null,
  } = {}) {
    const cleanSessionId = String(sessionId || '').trim();
    const cleanText = String(text || '').trim();
    if (!cleanSessionId) throw new TypeError('session work requires sessionId');
    if (!cleanText) throw new TypeError('session work requires text');
    const inferredKind = requestedKind
      || (requestId ? 'answer'
        : options.retry ? 'retry'
          : options.originContinue === true ? 'continuation' : 'task');
    if (inferredKind !== 'task' && !CONTROL_KINDS.has(inferredKind)) {
      throw new TypeError(`invalid session work kind: ${inferredKind}`);
    }
    const normalizedOptions = compactJson(options);
    const payload = compactJson({
      type: 'session.work',
      workKind: inferredKind,
      message: cleanText,
      options: normalizedOptions,
      source: source || options.taskSource || (options.originTrigger ? 'trigger' : 'direct'),
      taskId: options.taskId || null,
      taskRunId: options.taskRunId || null,
      leaseEpoch: Number.isSafeInteger(Number(options.leaseEpoch))
        && Number(options.leaseEpoch) > 0 ? Number(options.leaseEpoch) : null,
      // Omit the empty compatibility field so a pre-upgrade admission replay
      // with the same idempotency key keeps the exact historical payload hash.
      originDispatchId: options.originDispatchId || undefined,
      requestId: requestId || null,
      activeEntryId: activeEntryId || null,
    });
    const key = idempotencyKey
      || options.deliveryId || options.clientMsgId || options.requestId || null;
    const id = stableEntryId(cleanSessionId, key, payload);
    const result = await store.mutate(draft => {
      const at = Number(now());
      const schedule = ensure(draft, cleanSessionId, at);
      const pendingInput = inferredKind === 'answer'
        ? canonicalPendingUserInput(cleanSessionId) : null;
      // An unresolved structured request is the authoritative correlation
      // proof for an answer. The asking provider turn may already have released
      // its physical active slot, and a legacy/recovery window may not yet have
      // copied requestId into the scheduler mirror. Do not confuse that missing
      // execution slot with "no logical task": the pending request owns the
      // continuation. Standalone legacy callers without the canonical port keep
      // the old classify/awaitingRequestId fallback.
      const pendingAnswerMatches = typeof getPendingUserInput === 'function'
        ? pendingInput?.requestId === requestId
        : classifyStateForSchedule(schedule) !== 'D'
          && (!schedule.awaitingRequestId || schedule.awaitingRequestId === requestId);
      const correlatedAnswer = inferredKind === 'answer'
        && !!requestId
        && pendingAnswerMatches;
      if (CONTROL_KINDS.has(inferredKind)) {
        // active is an execution lease, not an admission permission. Control
        // inputs remain valid messages after the previous -p process exits.
        // Exact request/task correlation is retained when available, but stale
        // correlation never rejects or drops user input.
        if (schedule.active) {
          // An answer is its own control turn even when submitted before the
          // asking turn finishes; do not inherit that entry into ownership.
          payload.activeEntryId = inferredKind === 'answer'
            ? null
            : schedule.active.entryId;
          if (!payload.taskId && schedule.active.taskId) payload.taskId = schedule.active.taskId;
          if (!payload.taskRunId && schedule.active.taskRunId) {
            payload.taskRunId = schedule.active.taskRunId;
            payload.leaseEpoch = schedule.active.leaseEpoch || null;
          }
          if (!payload.originDispatchId && schedule.active.originDispatchId) {
            payload.originDispatchId = schedule.active.originDispatchId;
          }
        } else {
          if (correlatedAnswer) {
            // Repair correlation metadata only. Classify remains the sole owner
            // of business state; this input simply starts the next native turn.
            schedule.awaitingRequestId = requestId;
            if (!payload.taskId && pendingInput?.taskId) payload.taskId = pendingInput.taskId;
          }
          const previous = schedule.lastDecision || {};
          const retainedRun = ['W', 'B'].includes(classifyStateForSchedule(schedule))
            && previous.taskRunId
            && (!payload.taskId || !previous.taskId || payload.taskId === previous.taskId);
          if (retainedRun) {
            if (!payload.taskId) payload.taskId = previous.taskId || null;
            payload.taskRunId = previous.taskRunId;
            payload.leaseEpoch = previous.leaseEpoch || null;
            if (!payload.originDispatchId && previous.originDispatchId) {
              payload.originDispatchId = previous.originDispatchId;
            }
          }
        }
      }
      const admitted = admitOutboxItem(draft, {
        id,
        sessionId: cleanSessionId,
        payload,
        source: { type: 'session-admission', kind: inferredKind },
        now: at,
      });
      // Typed/control inputs carry directRun across the P boundary. Selection
      // still blocks them while classify is P, then starts the oldest one as
      // soon as classify leaves P. The tag does not rewrite FIFO sequence.
      const directMessage = payload.type === 'session.work'
        && (payload.source === 'direct' || CONTROL_KINDS.has(inferredKind));
      if (draft.outbox[admitted.item.id]
          && directMessage) {
        draft.outbox[admitted.item.id].directRun = true;
      }
      const specialAnswer = isUserInputAnswer(admitted.item);
      if (specialAnswer && draft.outbox[admitted.item.id]?.state === 'pending') {
        // The answer resumes the currently waiting interaction and therefore
        // outranks unrelated user work already staged behind that interaction.
        schedule.priorityEntryId = admitted.item.id;
      }
      schedule.updatedAt = at;
      const queue = queueForDraft(draft, cleanSessionId);
      const selected = selectSessionItem(queue, draft, at);
      return {
        ok: true,
        duplicate: admitted.idempotent,
        entry: clone(admitted.item),
        // While the asking native process is still releasing, the answer can be
        // pending internally for crash safety. Product/API semantics remain a
        // direct structured response: it never enters the ordinary waiting FIFO.
        queued: specialAnswer ? false : selected?.id !== admitted.item.id,
        position: specialAnswer
          ? 0
          : queue.findIndex(item => item.id === admitted.item.id) + 1,
        schedule: publicSchedule(schedule, queue),
      };
    });
    if (result.ok) {
      const queuedItems = result.queued
        ? result.schedule.queued
        : result.schedule.queued.filter(item => item.entryId !== result.entry.id);
      emit('queued', {
        message: result.entry.payload?.message || null,
        clientMsgId: result.entry.payload?.options?.clientMsgId || null,
        sessionId: cleanSessionId,
        entryId: result.entry.id,
        taskId: result.entry.payload?.taskId || null,
        taskRunId: result.entry.payload?.taskRunId || null,
        leaseEpoch: leaseEpochForItem(result.entry),
        source: result.entry.payload?.source || 'direct',
        workKind: inferredKind,
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
    const result = await store.mutate(draft => {
      const current = draft.outbox[item.id];
      if (!current || current.state !== 'leased') return { ok: false, code: 'delivery_not_leased' };
      const at = Number(now());
      const schedule = ensure(draft, item.sessionId, at);
      if (!schedule.active || schedule.state === 'idle') {
        const previous = schedule.lastDecision || {};
        const incomingTaskId = taskIdForItem(item);
        const incomingRunId = taskRunIdForItem(item);
        const retainedRun = isControlItem(item)
          && ['W', 'B'].includes(classifyStateForSchedule(schedule))
          && previous.taskRunId
          && (!incomingTaskId || !previous.taskId || incomingTaskId === previous.taskId)
          && (!incomingRunId || incomingRunId === previous.taskRunId)
          ? previous
          : null;
        schedule.active = {
          entryId: item.id,
          deliveryId: item.id,
          taskId: incomingTaskId || retainedRun?.taskId || null,
          taskRunId: incomingRunId || retainedRun?.taskRunId || null,
          leaseEpoch: leaseEpochForItem(item) || retainedRun?.leaseEpoch || null,
          originDispatchId: originDispatchIdForItem(item)
            || retainedRun?.originDispatchId || null,
          source: item.payload?.source || item.source?.type || 'legacy',
          workKind: workKind(item),
          admittedAt: item.createdAt,
          // Starting admission is the earliest trustworthy boundary for this
          // work. A recovered D must be newer than this timestamp, so a stale
          // success from the previous task cannot advance the queue.
          claimedAt: at,
          startedAt: null,
          attempt: item.attempts,
        };
        if (schedule.priorityEntryId === item.id) schedule.priorityEntryId = null;
      } else if (isActiveReplay(schedule, item) || relatedControl(schedule, item)) {
        schedule.active.deliveryId = item.id;
        schedule.active.workKind = workKind(item);
        schedule.active.attempt = item.attempts;
        if (!schedule.active.taskId && taskIdForItem(item)) {
          schedule.active.taskId = taskIdForItem(item);
        }
        if (!schedule.active.taskRunId && taskRunIdForItem(item)) {
          schedule.active.taskRunId = taskRunIdForItem(item);
          schedule.active.leaseEpoch = leaseEpochForItem(item);
        }
        if (!schedule.active.originDispatchId && originDispatchIdForItem(item)) {
          schedule.active.originDispatchId = originDispatchIdForItem(item);
        }
      } else {
        return { ok: false, code: 'session_gate_closed' };
      }
      schedule.state = 'starting';
      schedule.freezeReason = null;
      schedule.updatedAt = at;
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, item.sessionId)) };
    });
    if (result.ok) emit('claimed', {
      sessionId: item.sessionId,
      entryId: item.id,
      taskId: result.schedule.active?.taskId || null,
      taskRunId: result.schedule.active?.taskRunId || null,
      leaseEpoch: result.schedule.active?.leaseEpoch || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function started(item) {
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[item.sessionId];
      if (!schedule?.active || schedule.active.deliveryId !== item.id) {
        return { ok: false, code: 'active_delivery_mismatch' };
      }
      const at = Number(now());
      schedule.state = 'running';
      schedule.freezeReason = null;
      schedule.awaitingRequestId = null;
      schedule.classifyState = 'P';
      schedule.active.startedAt = schedule.active.startedAt || at;
      schedule.active.attempt = item.attempts;
      schedule.updatedAt = at;
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, item.sessionId)) };
    });
    if (result.ok) emit('started', {
      sessionId: item.sessionId,
      entryId: result.schedule.active?.entryId,
      deliveryId: item.id,
      taskId: result.schedule.active?.taskId || null,
      taskRunId: result.schedule.active?.taskRunId || null,
      leaseEpoch: result.schedule.active?.leaseEpoch || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function releaseClaim(item, reason = 'prelaunch_deferred') {
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[item.sessionId];
      if (!schedule?.active || schedule.active.deliveryId !== item.id) {
        return { ok: false, code: 'active_delivery_mismatch' };
      }
      const at = Number(now());
      if (schedule.active.entryId === item.id && !schedule.active.startedAt) {
        schedule.active = null;
        schedule.state = 'idle';
        schedule.freezeReason = null;
        schedule.awaitingRequestId = null;
        schedule.classifyState = schedule.classifyState || 'D';
        if (schedule.priorityEntryId === item.id) schedule.priorityEntryId = null;
      } else {
        schedule.active.deliveryId = schedule.active.entryId;
        schedule.active.workKind = 'task';
        schedule.state = 'frozen';
        // Delivery-protection freeze (the active delivery was released mid-flight),
        // NOT a classify freeze — classify no longer freezes the queue. The
        // scheduler drives this forward, so it reads as 'running' to the UI.
        schedule.freezeReason = 'incomplete_requires_resume';
      }
      schedule.updatedAt = at;
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, item.sessionId)) };
    });
    if (result.ok) emit('claim_released', {
      sessionId: item.sessionId,
      entryId: item.id,
      taskId: result.schedule.active?.taskId || item.payload?.taskId || null,
      taskRunId: result.schedule.active?.taskRunId || taskRunIdForItem(item),
      leaseEpoch: result.schedule.active?.leaseEpoch || leaseEpochForItem(item),
      reason,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
      schedule: result.schedule,
    });
    return result;
  }

  async function turnEnded(sessionId) {
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      if (!schedule?.active || !ACTIVE_STATES.has(schedule.state)) return { ok: false, code: 'no_active_task' };
      schedule.state = 'assessing';
      // P is classify's non-terminal "still processing / awaiting verdict"
      // state. Resetting a stale recovered D here prevents display or recovery
      // from treating an uncorrelated prior success as the current verdict.
      schedule.classifyState = 'P';
      schedule.freezeReason = null;
      schedule.awaitingRequestId = null;
      schedule.updatedAt = Number(now());
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)) };
    });
    if (result.ok) emit('assessing', {
      sessionId,
      entryId: result.schedule.active?.entryId || null,
      taskId: result.schedule.active?.taskId || null,
      taskRunId: result.schedule.active?.taskRunId || null,
      leaseEpoch: result.schedule.active?.leaseEpoch || null,
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
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      if (!schedule?.active) return { ok: false, code: 'no_active_task' };
      if (expectedTaskId && activeTaskId(schedule) && expectedTaskId !== activeTaskId(schedule)) {
        return { ok: false, code: 'active_task_mismatch' };
      }
      const at = Number(now());
      schedule.state = 'frozen';
      schedule.freezeReason = String(reason || 'unknown_interruption').slice(0, 160);
      schedule.awaitingRequestId = requestId || null;
      const classified = CLASSIFY_STATES.has(classifyState)
        ? classifyState : classifyStateForReason(reason);
      if (classified) schedule.classifyState = classified;
      schedule.updatedAt = at;
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)) };
    });
    if (result.ok) emit('frozen', {
      sessionId,
      entryId: result.schedule.active?.entryId,
      taskId: result.schedule.active?.taskId || null,
      taskRunId: result.schedule.active?.taskRunId || null,
      leaseEpoch: result.schedule.active?.leaseEpoch || null,
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
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      if (!schedule?.active) return { ok: false, code: 'no_active_task' };
      if (expectedTaskId && activeTaskId(schedule) && expectedTaskId !== activeTaskId(schedule)) {
        return { ok: false, code: 'active_task_mismatch' };
      }
      const at = Number(now());
      const completed = clone(schedule.active);
      schedule.active = null;
      schedule.state = 'idle';
      schedule.freezeReason = null;
      schedule.awaitingRequestId = classifyState !== 'D' && awaitingRequestId
        ? String(awaitingRequestId)
        : null;
      if (schedule.priorityEntryId === completed.entryId) schedule.priorityEntryId = null;
      // classifyState is the LETTER (D/W/B/E). D = turn succeeded (drains FIFO);
      // W/B/E = released but at-rest (FIFO only drains on D, see selectSessionItem).
      schedule.classifyState = CLASSIFY_STATES.has(classifyState) ? classifyState : 'D';
      // A turn ending on an unanswered question must not let work staged while
      // it ran fire ahead of the user's answer. directRun exists for messages
      // admitted while the session is ALREADY at rest; items that merely headed
      // the FIFO when the question landed hold at rest until the user acts.
      // Control kinds (the answer itself) keep their own selection path.
      if (schedule.classifyState === 'W' && canonicalPendingUserInput(sessionId)) {
        for (const item of Object.values(draft.outbox || {})) {
          if (item && item.sessionId === sessionId && item.state === 'pending'
              && !isControlItem(item)) item.directRun = false;
        }
      }
      schedule.lastDecision = {
        action: completed.supersededByEntryId ? 'superseded' : 'complete',
        reason: completed.supersededByEntryId ? 'superseded_by_immediate_insert' : reason,
        entryId: completed.entryId,
        taskId: completed.taskId || null,
        taskRunId: completed.taskRunId || null,
        leaseEpoch: completed.leaseEpoch || null,
        originDispatchId: completed.originDispatchId || null,
        supersededByEntryId: completed.supersededByEntryId || null,
        at,
      };
      schedule.updatedAt = at;
      return {
        ok: true,
        advanced: true,
        completed,
        schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)),
      };
    });
    // The explicit turn outcome travels WITH the scheduler bookkeeping event.
    // `completed` means only that the active slot was released; it is never a
    // TaskBoard lifecycle decision. Projections may render `succeeded`, while
    // only a user action may write task.status = done.
    if (result.ok) emit('completed', {
      sessionId,
      entryId: result.completed.entryId,
      taskId: result.completed.taskId || null,
      taskRunId: result.completed.taskRunId || null,
      leaseEpoch: result.completed.leaseEpoch || null,
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
        expectedTaskId: item.payload?.taskId || null,
        reason: 'recovered-success',
      });
    }
    const recoveredClassify = CLASSIFY_STATES.has(recoveredState.classifyState)
      ? recoveredState.classifyState : null;
    // Recovery follows the same rule as the live path (T1): every verdict
    // releases the active slot via complete(). D drains FIFO; W/B/E leave it.
    // No classify-driven freeze on restart either.
    if (recoveredClassify) {
      return complete(item.sessionId, {
        expectedTaskId: item.payload?.taskId || null,
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
      if (current.classifyState !== 'E') {
        return { ok: false, code: 'active_task_not_retryable' };
      }
      const lineage = current.active || current.lastDecision || {};
      // E is terminal for a headless TaskRun: its usage/transcript may already
      // be sealed and its slot scrubbed.  Retrying that physical session would
      // resume a deleted native context.  Task Board retry must admit a new
      // TaskRun (new lease/fresh context) instead.
      if (lineage.taskRunId) {
        return { ok: false, code: 'task_run_retry_requires_new_run' };
      }
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
    const result = await store.mutate(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      if (!schedule?.active) return { ok: false, code: 'no_active_task' };
      if (action !== 'cancel' && schedule.state !== 'frozen') {
        return { ok: false, code: 'active_task_not_frozen' };
      }
      const at = Number(now());
      const resolved = clone(schedule.active);
      schedule.active = null;
      schedule.state = 'idle';
      schedule.freezeReason = null;
      schedule.awaitingRequestId = null;
      schedule.classifyState = 'D';
      schedule.lastDecision = {
        action,
        reason: String(reason || '').slice(0, 500),
        actor: String(actor || 'user').slice(0, 80),
        entryId: resolved.entryId,
        taskId: resolved.taskId || null,
        originDispatchId: resolved.originDispatchId || null,
        at,
      };
      schedule.updatedAt = at;
      return {
        ok: true,
        resolved,
        schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)),
      };
    });
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

  async function status(sessionId) {
    return store.read(draft => {
      const schedule = draft.sessionSchedules[sessionId];
      const current = schedule || newSchedule(sessionId, 0);
      const result = publicSchedule(current, queueForDraft(draft, sessionId));
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
    const result = await store.mutate(draft => {
      const item = draft.outbox[cleanEntryId];
      if (!item || item.sessionId !== sessionId) {
        return { ok: false, code: 'queued_entry_not_found' };
      }
      const schedule = ensure(draft, sessionId, Number(now()));
      const activeIds = new Set([
        schedule.active?.entryId,
        schedule.active?.deliveryId,
      ].filter(Boolean));
      if (activeIds.has(cleanEntryId) || item.state === 'leased') {
        return { ok: false, code: 'queued_entry_already_claimed' };
      }
      if (item.state !== 'pending') {
        return { ok: false, code: 'queued_entry_not_pending' };
      }
      const at = Number(now());
      item.state = 'cancelled';
      item.cancelledAt = at;
      item.updatedAt = at;
      item.lastError = String(reason || 'cancelled before start').slice(0, 500);
      if (schedule.priorityEntryId === cleanEntryId) schedule.priorityEntryId = null;
      schedule.updatedAt = at;
      return {
        ok: true,
        cancelled: {
          entryId: cleanEntryId,
          actor: String(actor || 'user').slice(0, 80),
          at,
        },
        schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)),
      };
    });
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
    const result = await store.mutate(draft => {
      const item = draft.outbox[cleanEntryId];
      if (!item || item.sessionId !== sessionId) {
        return { ok: false, code: 'queued_entry_not_found' };
      }
      const schedule = ensure(draft, sessionId, Number(now()));
      if (schedule.active?.supersededByEntryId
          && schedule.active.supersededByEntryId !== cleanEntryId) {
        return {
          ok: false,
          code: 'active_supersession_in_progress',
          supersededByEntryId: schedule.active.supersededByEntryId,
        };
      }
      const activeIds = new Set([
        schedule.active?.entryId,
        schedule.active?.deliveryId,
      ].filter(Boolean));
      if (activeIds.has(cleanEntryId) || item.state === 'leased') {
        return { ok: false, code: 'queued_entry_already_claimed' };
      }
      if (item.state !== 'pending') {
        return { ok: false, code: 'queued_entry_not_pending' };
      }
      const at = Number(now());
      const active = schedule.active;
      // "Insert now" replaces the currently running attempt with this exact
      // user message.  The durable dispatch belongs to the logical task, not to
      // one provider process, so a replacement of the same task must retain the
      // complete lineage.  Keep this metadata outside payload/payloadHash: the
      // original client idempotency key must continue to compare against the
      // body that was admitted, while turnLineage records the later scheduling
      // decision that promoted it.
      const payloadTaskId = item.payload?.taskId || null;
      const explicitTaskStart = item.payload?.options?.taskStart === true
        || item.payload?.taskStart === true;
      const existingOriginDispatchId = originDispatchIdForItem(item);
      const sameTask = !!active
        && item.payload?.type === 'session.work'
        && !explicitTaskStart
        && (!payloadTaskId || (!!active.taskId && payloadTaskId === active.taskId))
        && (!existingOriginDispatchId
          || !active.originDispatchId
          || existingOriginDispatchId === active.originDispatchId);
      if (sameTask) {
        item.turnLineage = compactJson({
          ...(item.turnLineage || {}),
          taskId: payloadTaskId || active.taskId || null,
          originDispatchId: existingOriginDispatchId || active.originDispatchId || null,
          workKind: 'continuation',
          activeEntryId: active.entryId,
          inheritedBy: 'insert_queued',
          inheritedAt: at,
        });
      }
      if (active) {
        active.supersededByEntryId = cleanEntryId;
        active.supersededAt = at;
        active.supersededLineageTransferred = sameTask;
        active.supersededOriginTransferred = !!(
          sameTask
          && active.originDispatchId
          && originDispatchIdForItem(item) === active.originDispatchId
        );
      }
      // A user-selected "insert now" item is not merely FIFO priority. Once
      // the route cancels/releases the active slot, directRun makes this exact
      // pending entry immediately selectable even when the prior verdict is E.
      item.directRun = true;
      schedule.priorityEntryId = cleanEntryId;
      schedule.updatedAt = at;
      return {
        ok: true,
        inserted: {
          entryId: cleanEntryId,
          actor: String(actor || 'user').slice(0, 80),
          taskId: taskIdForItem(item),
          originDispatchId: originDispatchIdForItem(item),
          inheritedLineage: sameTask,
          at,
        },
        schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)),
      };
    });
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

  async function noteQueued(entryId) {
    const info = await store.mutate(draft => {
      const item = draft.outbox[entryId];
      if (!item) return null;
      const schedule = ensure(draft, item.sessionId, Number(now()));
      const queue = queueForDraft(draft, item.sessionId);
      return {
        item: clone(item),
        position: queue.findIndex(candidate => candidate.id === item.id) + 1,
        schedulerState: schedule.state,
        schedule: publicSchedule(schedule, queue),
      };
    });
    if (!info) return { ok: false, code: 'entry_not_found' };
    emit('queued', {
      sessionId: info.item.sessionId,
      entryId: info.item.id,
      taskId: taskIdForItem(info.item),
      source: info.item.payload?.taskSource || info.item.source?.type || 'dispatch',
      workKind: workKind(info.item),
      duplicate: false,
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
      )));
  }

  async function queueSummaries(sessionIds = null) {
    const requested = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.map(value => String(value || '').trim()).filter(Boolean))]
      : null;
    return store.read(draft => {
      const ids = requested || [...new Set([
        ...Object.keys(draft.sessionSchedules),
        ...Object.values(draft.outbox)
          .filter(item => item.state === 'pending' || item.state === 'leased')
          .map(item => item.sessionId),
      ])].sort();
      return ids.map((sessionId) => {
        const schedule = draft.sessionSchedules[sessionId] || newSchedule(sessionId, 0);
        const projected = publicSchedule(schedule, queueForDraft(draft, sessionId));
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
        ...Object.values(draft.outbox)
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
          // A pending outbox item is not evidence of an active task. This is
          // especially important now that the public FIFO includes callbacks:
          // a lone task.interrupted notification must remain deliverable.
          // Rebuild a legacy active pointer only from an explicit non-D
          // classify fact.
          if (recoveredClassify && recoveredClassify !== 'D') {
            schedule.active = {
              entryId: `legacy-active:${sessionId}`,
              deliveryId: null,
              taskId: recoveredState.taskId || null,
              taskRunId: recoveredState.taskRunId || null,
              leaseEpoch: leaseEpochForItem({ payload: recoveredState }),
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
        if (recoveredClassify) schedule.classifyState = recoveredClassify;
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
        if (classifyState === 'D') {
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
              queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId)).queued,
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
              queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId)).queued,
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
            taskRunId: completed.taskRunId || null,
            leaseEpoch: completed.leaseEpoch || null,
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
            taskRunId: completed.taskRunId || null,
            leaseEpoch: completed.leaseEpoch || null,
            classifyState: 'D',
            turnOutcome: 'succeeded',
            queued: queueForDraft(draft, sessionId).length,
            queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId)).queued,
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
            queuedItems: publicSchedule(schedule, queueForDraft(draft, sessionId)).queued,
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
      taskRunId: event.taskRunId || null,
      leaseEpoch: event.leaseEpoch || null,
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
    cancelQueued,
    insertQueued,
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
  FREEZE_REASON_RUN_STATE,
  createSessionWorkScheduler,
  isControlItem,
  runStateForFreezeReason,
  workKind,
};

'use strict';

const crypto = require('crypto');
const {
  admitOutboxItem,
  normalizeJson,
} = require('./outbox');

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
// {queued, running, waiting, error, done, idle}. A reason not listed here falls
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

function isControlItem(item) {
  return CONTROL_KINDS.has(workKind(item));
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
  const directContinuation = item?.payload?.type === 'session.work'
    && item.payload.source === 'direct'
    && kind === 'continuation';
  if (directContinuation) return classifyState !== 'P';
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
  return {
    sessionId: schedule.sessionId,
    state: schedule.state,
    freezeReason: schedule.freezeReason || null,
    awaitingRequestId: schedule.awaitingRequestId || null,
    classifyState: classifyStateForSchedule(schedule),
    active: schedule.active ? clone(schedule.active) : null,
    queued: queue.map((item, index) => ({
      entryId: item.id,
      taskId: item.payload?.taskId || null,
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
  log = () => {},
} = {}) {
  if (!store || typeof store.mutate !== 'function' || typeof store.read !== 'function') {
    throw new TypeError('[session-scheduler] orchestration store is required');
  }

  function emit(type, fields = {}) {
    const event = { type, at: Number(now()), ...fields };
    try { onEvent(event); } catch (_) {}
    try { log(`[session-scheduler] ${type} ${JSON.stringify(fields)}`); } catch (_) {}
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

  function relatedControl(schedule, item) {
    if (!schedule?.active || !isControlItem(item)) return false;
    const payload = item.payload || {};
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
      return ordered[0];
    }
    const replay = ordered.find(item => isActiveReplay(schedule, item));
    if (replay) return replay;
    const classifyState = canonicalClassifyState(schedule.sessionId, schedule);
    return ordered.find(item => relatedControl(schedule, item)
      && controlAllowedByClassify(item, classifyState)) || null;
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
      requestId: requestId || null,
      activeEntryId: activeEntryId || null,
    });
    const key = idempotencyKey
      || options.deliveryId || options.clientMsgId || options.requestId || null;
    const id = stableEntryId(cleanSessionId, key, payload);
    const result = await store.mutate(draft => {
      const at = Number(now());
      const schedule = ensure(draft, cleanSessionId, at);
      if (CONTROL_KINDS.has(inferredKind)) {
        if (!schedule.active) {
          return { ok: false, code: 'no_active_task', schedule: publicSchedule(schedule) };
        }
        if (activeEntryId && activeEntryId !== schedule.active.entryId) {
          return { ok: false, code: 'active_task_mismatch', schedule: publicSchedule(schedule) };
        }
        if (inferredKind === 'answer' && schedule.awaitingRequestId
            && requestId !== schedule.awaitingRequestId) {
          return { ok: false, code: 'request_id_mismatch', schedule: publicSchedule(schedule) };
        }
        payload.activeEntryId = schedule.active.entryId;
        if (!payload.taskId && schedule.active.taskId) payload.taskId = schedule.active.taskId;
      }
      const admitted = admitOutboxItem(draft, {
        id,
        sessionId: cleanSessionId,
        payload,
        source: { type: 'session-admission', kind: inferredKind },
        now: at,
      });
      schedule.updatedAt = at;
      const queue = queueForDraft(draft, cleanSessionId);
      const selected = selectSessionItem(queue, draft, at);
      return {
        ok: true,
        duplicate: admitted.idempotent,
        entry: clone(admitted.item),
        queued: selected?.id !== admitted.item.id,
        position: queue.findIndex(item => item.id === admitted.item.id) + 1,
        schedule: publicSchedule(schedule, queue),
      };
    });
    if (result.ok) {
      emit('queued', {
        sessionId: cleanSessionId,
        entryId: result.entry.id,
        taskId: result.entry.payload?.taskId || null,
        source: result.entry.payload?.source || 'direct',
        workKind: inferredKind,
        duplicate: result.duplicate,
        queued: result.queued,
        queuePosition: result.position || null,
        schedulerState: result.schedule.state,
        freezeReason: result.schedule.freezeReason,
        queuedItems: result.schedule.queued,
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
        schedule.active = {
          entryId: item.id,
          deliveryId: item.id,
          taskId: item.payload?.taskId || null,
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
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
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
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
    });
    return result;
  }

  async function releaseClaim(item, reason = 'prelaunch_deferred') {
    return store.mutate(draft => {
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
        schedule.freezeReason = freezeReasonForClassify(classifyStateForSchedule(schedule));
      }
      schedule.updatedAt = at;
      return { ok: true, schedule: publicSchedule(schedule, queueForDraft(draft, item.sessionId)) };
    });
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
      schedulerState: 'assessing',
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
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
      freezeReason: result.schedule.freezeReason,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
    });
    return result;
  }

  async function complete(sessionId, { expectedTaskId = null, reason = 'successful' } = {}) {
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
      schedule.awaitingRequestId = null;
      schedule.classifyState = 'D';
      schedule.lastDecision = {
        action: 'complete',
        reason,
        entryId: completed.entryId,
        taskId: completed.taskId || null,
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
    if (result.ok) emit('completed', {
      sessionId,
      entryId: result.completed.entryId,
      taskId: result.completed.taskId || null,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
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
    if (recoveredClassify && recoveredClassify !== 'D') {
      return freeze(
        item.sessionId,
        freezeReasonForClassify(recoveredClassify),
        {
          expectedTaskId: item.payload?.taskId || null,
          classifyState: recoveredClassify,
        },
      );
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
      if (!current?.active) return { ok: false, code: 'no_active_task' };
      if (current.state !== 'frozen') return { ok: false, code: 'active_task_not_frozen' };
      if (current.classifyState !== 'E') {
        return { ok: false, code: 'active_task_not_retryable' };
      }
      return admit({
        sessionId,
        text: String(text || '').trim() || '请继续刚才未完成的任务。',
        source: 'manual-resolution',
        workKind: action,
        activeEntryId: current.active.entryId,
        idempotencyKey: idempotencyKey || `${action}:${current.active.entryId}:${Date.now()}`,
        options: {
          originContinue: true,
          taskId: current.active.taskId || undefined,
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
        at,
      };
      schedule.updatedAt = at;
      return {
        ok: true,
        resolved,
        schedule: publicSchedule(schedule, queueForDraft(draft, sessionId)),
      };
    });
    if (result.ok) emit(action === 'cancel' ? 'cancelled' : 'skipped', {
      sessionId,
      entryId: result.resolved.entryId,
      action,
      actor,
      queued: result.schedule.queued.length,
      queuedItems: result.schedule.queued,
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
      schedule.priorityEntryId = cleanEntryId;
      schedule.updatedAt = at;
      return {
        ok: true,
        inserted: {
          entryId: cleanEntryId,
          actor: String(actor || 'user').slice(0, 80),
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
      taskId: info.item.payload?.taskId || null,
      source: info.item.payload?.taskSource || info.item.source?.type || 'dispatch',
      workKind: workKind(info.item),
      duplicate: false,
      queuePosition: info.position || null,
      schedulerState: info.schedulerState,
      freezeReason: info.schedule.freezeReason,
      queuedItems: info.schedule.queued,
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
            action: 'complete',
            reason: 'recovered-classify-D',
            entryId: completed.entryId,
            taskId: completed.taskId || null,
            at,
          };
          schedule.updatedAt = at;
          changes.push({
            type: 'completed',
            sessionId,
            entryId: completed.entryId,
            taskId: completed.taskId || null,
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
    for (const event of events) emit(event.type, {
      sessionId: event.sessionId,
      entryId: event.entryId || null,
      taskId: event.taskId || null,
      queued: event.queued == null ? null : event.queued,
      queuedItems: event.queuedItems || [],
      freezeReason: event.type === 'frozen' ? event.reason : null,
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
    noteQueued,
    list,
    recover,
    settlePersistedDelivery,
    selectSessionItem,
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

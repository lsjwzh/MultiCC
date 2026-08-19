'use strict';

// M1 · task_run_stream envelope forwarding (docs/chat-view-unification-design.md §3-M1).
//
// Execution-slot turn events stop at the slot's own WS boundary — its client
// set is empty by design, which is why a task detail page has never been able
// to stream a run live. This forwarder mirrors those events onto the
// workspace/dir channel so a task-mode chat view can. Invariants:
//   · envelope only — slot events are forwarded byte-identical, never
//     translated (I8: one event vocabulary, one frontend controller);
//   · the internal slot session id never crosses the envelope;
//   · delta-class events (text deltas) coalesce within the throttle window
//     into a batch envelope; every other event forwards immediately and
//     flushes any pending batch first, so ordering is preserved.
// The gate is strict: execution-slot sessions with an active task run only.
// Non-slot sessions pay one Map lookup and nothing else.

const DEFAULT_THROTTLE_MS = 100;

function defaultIsDeltaEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'part_delta') return true;
  if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner && typeof inner === 'object' && inner.type === 'content_block_delta') return true;
  }
  return false;
}

function createTaskRunStreamEmitter(emitClients, chatSessions, records, workspaceBroadcast,
  options = {}) {
  if (typeof emitClients !== 'function') {
    throw new TypeError('task-run-stream: emitClients must be a function');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('task-run-stream: chatSessions map is required');
  }
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('task-run-stream: records map is required');
  }
  if (typeof workspaceBroadcast !== 'function') {
    throw new TypeError('task-run-stream: workspaceBroadcast is required');
  }
  const throttleMs = Number.isFinite(Number(options.throttleMs)) && options.throttleMs >= 0
    ? Number(options.throttleMs) : DEFAULT_THROTTLE_MS;
  const isDeltaEvent = typeof options.isDeltaEvent === 'function'
    ? options.isDeltaEvent : defaultIsDeltaEvent;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;

  // sessionId -> { events, context, timer }. The context (task/run/dir ids) is
  // captured when the batch opens, so a flush after run state moved on still
  // attributes the buffered deltas to the run that produced them.
  const pending = new Map();

  function emitEnvelope(context, events) {
    if (events.length === 1) {
      workspaceBroadcast(context.dirId, {
        type: 'task_run_stream', taskId: context.taskId, runId: context.runId,
        dirId: context.dirId, slotEvent: events[0],
      });
      return;
    }
    workspaceBroadcast(context.dirId, {
      type: 'task_run_stream', taskId: context.taskId, runId: context.runId,
      dirId: context.dirId, slotEvents: events,
    });
  }

  function flush(sessionId) {
    const entry = pending.get(sessionId);
    pending.delete(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeoutFn(entry.timer);
    if (entry.events.length) emitEnvelope(entry.context, entry.events);
  }

  function forwardContext(sessionId) {
    const record = records.get(sessionId);
    if (!record || record.taskExecutionSlot !== true || !record.dirId) return null;
    const state = chatSessions.get(sessionId);
    const taskId = state?._currentTaskId;
    const runId = state?._currentTaskRunId;
    if (!taskId || !runId) return null;
    return { taskId, runId, dirId: record.dirId };
  }

  // Drop-in replacement for the task-context-host emitClients port. The third
  // argument (session id) is supplied by the host's broadcast(); older hosts
  // that do not pass it simply never forward.
  return function emitClientsWithTaskRunStream(clients, event, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      emitClients(clients, event);
      return;
    }
    const context = forwardContext(sessionId);
    if (!context) {
      emitClients(clients, event);
      return;
    }
    if (!isDeltaEvent(event)) {
      flush(sessionId);
      emitEnvelope(context, [event]);
      emitClients(clients, event);
      return;
    }
    let entry = pending.get(sessionId);
    if (!entry) {
      entry = { events: [], context, timer: null };
      pending.set(sessionId, entry);
      entry.timer = setTimeoutFn(() => flush(sessionId), throttleMs);
    }
    entry.events.push(event);
    emitClients(clients, event);
  };
}

module.exports = {
  DEFAULT_THROTTLE_MS,
  createTaskRunStreamEmitter,
  defaultIsDeltaEvent,
};

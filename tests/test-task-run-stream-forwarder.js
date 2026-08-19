'use strict';

// M1 · task_run_stream envelope forwarding (docs/chat-view-unification-design.md §3-M1).
// Execution-slot turn events stop at the slot's own WS boundary (its client set
// is empty by design). These tests pin the mirror onto the workspace/dir
// channel: envelope-only wrapping (byte-identical events), delta coalescing,
// ordering, and the slot/active-run gate.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTaskRunStreamEmitter } = require('../src/task-run-stream-forwarder');
const { createTaskContextHost } = require('../src/task-context-host');

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    flushAll() { while (timers.length) timers.shift()(); },
    flushOne() { const fn = timers.shift(); if (fn) fn(); },
  };
}

function harness({ slot = true, runId = 'tr_1', taskId = 'tsk_1' } = {}) {
  const clock = fakeClock();
  const workspace = [];
  const emitted = [];
  const chatSessions = new Map([
    ['slot-1', taskId && runId ? { _currentTaskId: taskId, _currentTaskRunId: runId } : {}],
  ]);
  const records = new Map([
    ['slot-1', { id: 'slot-1', dirId: 'dir-9', taskExecutionSlot: slot === true }],
    ['chat-1', { id: 'chat-1', dirId: 'dir-9', taskExecutionSlot: false }],
  ]);
  const emitClients = (clients, event) => emitted.push({ clients, event });
  const emit = createTaskRunStreamEmitter(emitClients, chatSessions, records,
    (dirId, payload) => workspace.push({ dirId, payload }), {
      throttleMs: 100,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
  return { clock, workspace, emitted, emit };
}

test('slot turn events are mirrored onto the workspace channel, envelope only', () => {
  const { workspace, emitted, emit } = harness();
  const clients = new Set();
  emit(clients, { type: 'result', text: 'ok' }, 'slot-1');
  // Envelope: task identity + dir scope + the untouched slot event.
  assert.deepEqual(workspace, [{
    dirId: 'dir-9',
    payload: {
      type: 'task_run_stream', taskId: 'tsk_1', runId: 'tr_1', dirId: 'dir-9',
      slotEvent: { type: 'result', text: 'ok' },
    },
  }]);
  // The slot's own (empty) client fan-out is untouched.
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].event, { type: 'result', text: 'ok' });
  // The internal slot session id never crosses the envelope.
  assert.equal('sessionId' in workspace[0].payload, false);
  assert.equal('sessionName' in workspace[0].payload, false);
});

test('non-slot sessions and runless slots never forward', () => {
  const { workspace, emit } = harness();
  emit(new Set(), { type: 'result' }, 'chat-1');
  assert.equal(workspace.length, 0);
  const runless = harness({ runId: null });
  runless.emit(new Set(), { type: 'result' }, 'slot-1');
  assert.equal(runless.workspace.length, 0);
});

test('M4-T1 user_input_required and user_input_resolved forward immediately, byte-identical', () => {
  const { clock, workspace, emit } = harness();
  // The unified chat view renders its pending-question card from these two
  // events; they are not delta-class, so they must bypass the coalescing
  // window entirely (no flush needed) and keep every field.
  emit(new Set(), {
    type: 'user_input_required', requestId: 'usrq-1', taskId: 'tsk_1',
    question: '选择环境', reason: '部署前确认', options: ['生产', '预发'],
    allowMultiple: false,
  }, 'slot-1');
  assert.equal(clock.timers.length, 0, 'never buffered');
  assert.deepEqual(workspace[0].payload.slotEvent, {
    type: 'user_input_required', requestId: 'usrq-1', taskId: 'tsk_1',
    question: '选择环境', reason: '部署前确认', options: ['生产', '预发'],
    allowMultiple: false,
  });
  emit(new Set(), { type: 'user_input_resolved', requestId: 'usrq-1', taskId: 'tsk_1' }, 'slot-1');
  assert.equal(workspace.length, 2);
  assert.deepEqual(workspace[1].payload.slotEvent,
    { type: 'user_input_resolved', requestId: 'usrq-1', taskId: 'tsk_1' });
});

test('delta-class events coalesce within the throttle window', () => {
  const { clock, workspace, emit } = harness();
  emit(new Set(), { type: 'part_delta', text: 'hel' }, 'slot-1');
  emit(new Set(), { type: 'part_delta', text: 'lo' }, 'slot-1');
  assert.equal(workspace.length, 0, 'deltas buffer until the window closes');
  clock.flushOne();
  assert.equal(workspace.length, 1);
  const envelope = workspace[0].payload;
  assert.equal(envelope.type, 'task_run_stream');
  assert.deepEqual(envelope.slotEvents, [
    { type: 'part_delta', text: 'hel' },
    { type: 'part_delta', text: 'lo' },
  ]);
});

test('non-delta events flush pending deltas first and keep ordering', () => {
  const { clock, workspace, emit } = harness();
  emit(new Set(), { type: 'part_delta', text: 'a' }, 'slot-1');
  emit(new Set(), { type: 'part_delta', text: 'b' }, 'slot-1');
  emit(new Set(), { type: 'result', text: 'done' }, 'slot-1');
  // The result event is never delayed by the throttle: it flushes the buffer
  // synchronously (batch of two → slotEvents), then forwards itself.
  assert.equal(workspace.length, 2);
  assert.deepEqual(workspace[0].payload.slotEvents, [{ type: 'part_delta', text: 'a' }, { type: 'part_delta', text: 'b' }]);
  assert.deepEqual(workspace[1].payload.slotEvent, { type: 'result', text: 'done' });
  clock.flushAll();
  assert.equal(workspace.length, 2, 'timer flush after explicit flush is a no-op');
});

test('stream_event content_block_delta is delta-class; message_start is not', () => {
  const { clock, workspace, emit } = harness();
  emit(new Set(), { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x' } } }, 'slot-1');
  emit(new Set(), { type: 'stream_event', event: { type: 'message_start' } }, 'slot-1');
  // message_start is not delta-class, so it flushes the pending delta first
  // (batch of one collapses to the singular slotEvent form) and then forwards
  // itself — same ordering rule as the result event above.
  assert.equal(workspace.length, 2);
  assert.deepEqual(workspace[0].payload.slotEvent,
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x' } } });
  assert.deepEqual(workspace[1].payload.slotEvent, { type: 'stream_event', event: { type: 'message_start' } });
  clock.flushAll();
  assert.equal(workspace.length, 2, 'nothing left pending after the flush-on-forward');
});

test('task-context-host broadcast passes the session id through to emitClients', () => {
  const calls = [];
  const host = createTaskContextHost({
    getState: () => ({ _currentTaskId: 'tsk_1', clients: new Set() }),
    emitClients: (clients, event, sessionId) => calls.push({ clients, event, sessionId }),
    append: () => true,
    getTaskBoard: () => null,
    containsDelivery: () => false,
    classifyDisplay: () => ({ cardStatus: 'idle' }),
    randomUUID: () => 'u',
    getRecord: () => ({}),
    runTurn: () => false,
  });
  host.broadcast('slot-1', { type: 'result' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'slot-1');
  // Existing behaviour: taskId is stamped onto the event when missing.
  assert.equal(calls[0].event.taskId, 'tsk_1');
});

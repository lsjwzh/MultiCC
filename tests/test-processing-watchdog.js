'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProcessingWatchdog } = require('../src/chat/process-watchdog');

function fixture(options = {}) {
  let at = options.at ?? 100_000;
  const record = {
    id: 's1',
    kind: 'chat',
    type: 'chat',
    taskState: {
      classifyState: 'P',
      classifyUpdatedAt: options.classifyUpdatedAt ?? 1,
    },
  };
  const calls = [];
  const child = options.child || null;
  const watchdog = createProcessingWatchdog({
    listRecords: () => new Map([['s1', record]]).entries(),
    getTaskState: value => value.taskState,
    getChatSession: () => options.chat === null ? null : { claudeProc: child, isStreaming: true },
    getStreamStatus: () => options.stream || null,
    getPreparation: () => options.preparation || { phase: 'idle' },
    getSchedulerStatus: async () => options.scheduler || {
      state: 'running',
      active: { entryId: 'entry-1' },
    },
    isPidAlive: pid => options.livePids?.includes(pid) || false,
    cancelTurn: async (id, cancelOptions) => {
      calls.push([id, cancelOptions]);
      return { ok: true };
    },
    now: () => at,
    startGraceMs: options.startGraceMs ?? 10_000,
    deadConfirmMs: options.deadConfirmMs ?? 5_000,
    logger: { warn() {} },
  });
  return {
    watchdog,
    calls,
    record,
    advance(ms) { at += ms; },
  };
}

test('processing watchdog observes the spawn grace period before probing', async () => {
  const h = fixture({ at: 5_000, classifyUpdatedAt: 1_000 });
  const result = await h.watchdog.sweep();
  assert.equal(result.results[0].reason, 'start_grace');
  assert.deepEqual(h.calls, []);
});

test('processing watchdog accepts a live child or busy persistent stream', async () => {
  const child = { pid: 42, exitCode: null, signalCode: null, killed: false };
  const processHost = fixture({ child, livePids: [42] });
  let result = await processHost.watchdog.sweep();
  assert.equal(result.results[0].reason, 'child_process');

  const streamHost = fixture({
    stream: { pid: 43, alive: true, busy: true },
    livePids: [43],
  });
  result = await streamHost.watchdog.sweep();
  assert.equal(result.results[0].reason, 'persistent_stream');
  assert.deepEqual(processHost.calls, []);
  assert.deepEqual(streamHost.calls, []);
});

test('processing watchdog confirms a dead P runner before forcing E cancellation', async () => {
  const h = fixture();
  let result = await h.watchdog.sweep();
  assert.equal(result.results[0].action, 'suspect');
  assert.deepEqual(h.calls, []);

  h.advance(5_001);
  result = await h.watchdog.sweep();
  assert.equal(result.results[0].action, 'cancelled');
  assert.deepEqual(h.calls, [[
    's1',
    { reason: 'process_watchdog', killReason: 'process_watchdog' },
  ]]);
});

test('processing watchdog does not expect a process while scheduler awaits classify', async () => {
  const h = fixture({ scheduler: { state: 'assessing', active: { entryId: 'entry-1' } } });
  const result = await h.watchdog.sweep();
  assert.equal(result.results[0].reason, 'awaiting_classify');
  assert.deepEqual(h.calls, []);
});

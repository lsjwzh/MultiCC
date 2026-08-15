'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { deriveToolTiming, diffToolTiming, deriveOpenTasks } = require('../src/chat/turn-event-replay');

// Journal-line helpers: the derivation consumes {seq, ts, event} records.
const line = (seq, ts, event) => ({ seq, ts, event });
const toolUse = (id, name, input) => line(0, 0, {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input: input || {} }] },
});
const toolResult = (id, isError) => line(0, 0, {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: !!isError }] },
});

test('derives measured timing for opened-and-closed tools from line timestamps', () => {
  const tools = deriveToolTiming([
    toolUse('t1', 'Bash'),
    line(2, 5_000, { type: 'assistant', message: { content: [] } }),
    toolResult('t1'),
  ].map((r, i) => ({ ...r, seq: i + 1, ts: (i + 1) * 1000 })));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Bash');
  assert.equal(tools[0].startedAt, 1000);
  assert.equal(tools[0].endedAt, 3000);
  assert.equal(tools[0].isError, false);
});

test('a tool without a result derives as running (endedAt null), never fabricated', () => {
  const tools = deriveToolTiming([
    { ...toolUse('t1', 'Read'), ts: 1_000 },
    { ...toolUse('t2', 'Bash'), ts: 2_000 },
    { ...toolResult('t1'), ts: 5_000 },
  ]);
  assert.equal(tools[1].endedAt, null);
  assert.equal(tools[1].isError, false);
});

test('error flags and duplicate blocks collapse to the first sighting', () => {
  const tools = deriveToolTiming([
    { ...toolUse('t1', 'Bash'), ts: 1_000 },
    { ...toolUse('t1', 'Bash'), ts: 9_000 }, // replay/duplicate broadcast
    { ...toolResult('t1', true), ts: 4_000 },
    { ...toolResult('t1', true), ts: 8_000 },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].startedAt, 1_000);
  assert.equal(tools[0].endedAt, 4_000);
  assert.equal(tools[0].isError, true);
});

test('orphan tool_results (no journal witness of the tool_use) are ignored', () => {
  const tools = deriveToolTiming([{ ...toolResult('ghost'), ts: 1_000 }]);
  assert.deepEqual(tools, []);
});

test('stub lines (oversized payloads journaled as type-only) do not crash derivation', () => {
  const tools = deriveToolTiming([
    { seq: 1, ts: 1_000, event: { type: 'assistant', journaled: 'stub', payloadBytes: 40_000 } },
    { ...toolUse('t1', 'Read'), seq: 2, ts: 2_000 },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
});

test('diffToolTiming reports empty for a faithful blob within tolerance', () => {
  const derived = [
    { id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 4_000, isError: false },
    { id: 't2', name: 'Read', startedAt: 5_000, endedAt: null, isError: false },
  ];
  const blob = [
    { id: 't1', name: 'Bash', startedAt: 1_010, endedAt: 3_990, is_error: false },
    { id: 't2', name: 'Read', startedAt: 5_010 },
  ];
  assert.deepEqual(diffToolTiming(derived, blob), []);
});

test('diffToolTiming flags drift, fabrication, loss, and error mismatch', () => {
  const derived = [
    { id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 4_000, isError: true },
    { id: 't2', name: 'Read', startedAt: 5_000, endedAt: null, isError: false }, // missing from blob
  ];
  const blob = [
    { id: 't1', name: 'bash', startedAt: 90_000, endedAt: 4_000, is_error: false }, // name+start drift
    { id: 't2x', name: 'Ghost', startedAt: 1_000 }, // never journaled
    // t2 missing entirely
  ];
  const kinds = diffToolTiming(derived, blob).map(m => m.kind).sort();
  assert.deepEqual(kinds, [
    'isError_mismatch',
    'missing_from_blob',
    'missing_from_journal',
    'name_mismatch',
    'startedAt_drift',
  ].sort());
});

test('diffToolTiming flags a blob end for a tool the journal still shows running', () => {
  const derived = [{ id: 't1', name: 'Bash', startedAt: 1_000, endedAt: null, isError: false }];
  const blob = [{ id: 't1', name: 'Bash', startedAt: 1_000, endedAt: 2_000 }];
  assert.deepEqual(diffToolTiming(derived, blob).map(m => m.kind), ['endedAt_fabricated_in_blob']);
});

test('derivation covers the adapter path too (same normalized broadcast shape)', () => {
  // codex/opencode/zcode tool_start/tool_result are normalized to the same
  // assistant.tool_use / user.tool_result broadcasts before chatBroadcast.
  const tools = deriveToolTiming([
    { seq: 1, ts: 100, event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: { cmd: 'ls' } }] } } },
    { seq: 2, ts: 900, event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'files', is_error: false }] } } },
  ]);
  assert.deepEqual(tools, [
    { id: 'call_1', name: 'shell', startedAt: 100, endedAt: 900, isError: false },
  ]);
});

test('deriveOpenTasks returns tasks with no terminal event, latest witness ts', () => {
  const open = deriveOpenTasks([
    { seq: 1, ts: 1_000, event: { type: 'monitor_started', task_id: 'a', description: '子任务 A', background: true } },
    { seq: 2, ts: 2_000, event: { type: 'monitor_started', task_id: 'b', description: 'Monitor x', background: true } },
    { seq: 3, ts: 3_000, event: { type: 'monitor_progress', task_id: 'a', status: 'running', background: true } },
    { seq: 4, ts: 4_000, event: { type: 'monitor_done', task_id: 'b', status: 'completed', background: true } },
    { seq: 5, ts: 5_000, event: { type: 'background_tasks', tasks: [{ task_id: 'a', status: 'running' }] } },
  ]);
  // b closed; a survived to the journal cutoff — exactly what a restart killed.
  assert.deepEqual(open, [
    { task_id: 'a', description: '子任务 A', lastTs: 5_000 },
  ]);
});

test('deriveOpenTasks is robust to repeats, orphans, and empty input', () => {
  assert.deepEqual(deriveOpenTasks([]), []);
  assert.deepEqual(deriveOpenTasks(null), []);
  // Replayed started/progress must not duplicate; an orphan progress (start
  // line rotated away) is not fabricated into a task.
  const open = deriveOpenTasks([
    { seq: 1, ts: 1_000, event: { type: 'monitor_started', task_id: 'a', description: 'A' } },
    { seq: 2, ts: 9_000, event: { type: 'monitor_started', task_id: 'a', description: 'A' } },
    { seq: 3, ts: 5_000, event: { type: 'monitor_progress', task_id: 'ghost', status: 'running' } },
  ]);
  assert.deepEqual(open, [{ task_id: 'a', description: 'A', lastTs: 9_000 }]);
});

test('turn-engine replays journal open tasks on reconnect only when the live set is empty', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.match(source, /deriveOpenTasks\(turnEventJournal\.readAll\(sessionName\)\)/,
    'reconnect path derives open tasks from the journal');
  assert.match(source, /activeTasks\.length === 0 && turnEventJournal/,
    'replay only when the in-memory runtime knows nothing (post-restart)');
  assert.match(source, /RECONNECT_REPLAY_WINDOW_MS/, 'replay is time-bounded');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /sendWs,\s*\n\s*turnEventJournal,/, 'server wires the journal into the turn engine');
});

'use strict';

// Isolated tests for the chat turn-timing instrumentation (src/chat/turn-timing.js
// + the chat-stream streaming hooks). No real CLI processes: the recorder runs
// against an injected clock/emitter, and chat-stream runs against a fake
// child_process.spawn installed via require.cache before first require.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createTurnTimingRecorder } = require('../src/chat/turn-timing');

function makeRecorder(startTs = 1_700_000_000_000) {
  const lines = [];
  let clock = startTs;
  const recorder = createTurnTimingRecorder({
    now: () => clock,
    emit: (line) => lines.push(line),
    advance: (ms) => { clock += ms; },
  });
  return { recorder, lines, advance: (ms) => { clock += ms; } };
}

test('recorder records all four instants in order and logs one structured line', () => {
  const { recorder, lines, advance } = makeRecorder();
  recorder.begin('sess-1', 'turn_1', { t0: undefined, cli: 'codex' });
  advance(120); // queue + preparation
  recorder.markSpawned('sess-1', 'turn_1');
  advance(5);   // stdin flush / argv hand-off
  recorder.markSent('sess-1', 'turn_1');
  advance(800); // upstream latency inside the CLI
  const record = recorder.markFirstByte('sess-1', 'turn_1');

  assert.ok(record, 'first byte returns the record');
  assert.strictEqual(lines.length, 1, 'exactly one log line per turn');
  assert.ok(lines[0].startsWith('[turn-timing] '), 'stable prefix');
  const payload = JSON.parse(lines[0].slice('[turn-timing] '.length));
  assert.strictEqual(payload.sessionId, 'sess-1');
  assert.strictEqual(payload.turnId, 'turn_1');
  assert.strictEqual(payload.cli, 'codex');
  for (const k of ['t0', 't1', 't2', 't3']) {
    assert.ok(!Number.isNaN(Date.parse(payload[k])), `${k} is an ISO timestamp`);
  }
  assert.ok(Date.parse(payload.t0) <= Date.parse(payload.t1));
  assert.ok(Date.parse(payload.t1) <= Date.parse(payload.t2));
  assert.ok(Date.parse(payload.t2) <= Date.parse(payload.t3));
  assert.deepStrictEqual(payload.ms, { spawn: 120, send: 5, firstByte: 800, total: 925 });
});

test('recorder honors a pre-stamped t0 (route-entry receivedAt, FIFO wait included)', () => {
  const startTs = 1_700_000_000_000;
  const { recorder, lines, advance } = makeRecorder(startTs);
  const receivedAt = startTs - 30_000; // message sat in the FIFO for 30s
  recorder.begin('sess-2', 'turn_2', { t0: receivedAt, cli: 'claude' });
  advance(1);
  recorder.markSpawned('sess-2', 'turn_2');
  recorder.markSent('sess-2', 'turn_2');
  advance(1);
  recorder.markFirstByte('sess-2', 'turn_2');
  const payload = JSON.parse(lines[0].slice('[turn-timing] '.length));
  assert.strictEqual(Date.parse(payload.t0), receivedAt);
  assert.ok(payload.ms.total >= 30_000, 'total includes the queue wait');
});

test('first byte is counted once: repeated marks and aborts never log twice', () => {
  const { recorder, lines } = makeRecorder();
  recorder.begin('sess-3', 'turn_3', {});
  recorder.markSpawned('sess-3', 'turn_3');
  recorder.markSent('sess-3', 'turn_3');
  recorder.markFirstByte('sess-3', 'turn_3');
  recorder.markFirstByte('sess-3', 'turn_3'); // duplicate chunk
  recorder.abort('sess-3', 'turn_3', 'late_close'); // after success log
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].startsWith('[turn-timing] '));
});

test('marks before begin are dropped silently', () => {
  const { recorder, lines } = makeRecorder();
  assert.strictEqual(recorder.markSpawned('nope', 'turn_x'), null);
  assert.strictEqual(recorder.markSent('nope', 'turn_x'), null);
  assert.strictEqual(recorder.markFirstByte('nope', 'turn_x'), null);
  assert.strictEqual(recorder.abort('nope', 'turn_x', 'x'), null);
  assert.strictEqual(lines.length, 0);
});

test('abort path (spawn failure / timeout without first byte) logs one partial line', () => {
  const { recorder, lines, advance } = makeRecorder();
  recorder.begin('sess-4', 'turn_4', { cli: 'opencode' });
  advance(40);
  recorder.markSpawned('sess-4', 'turn_4');
  recorder.markSent('sess-4', 'turn_4');
  // No first byte ever arrives (process hangs, then closes / spawn errors).
  const record = recorder.abort('sess-4', 'turn_4', 'closed_before_first_byte:code=null');
  assert.ok(record);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].startsWith('[turn-timing-abort] '), 'abort prefix');
  const payload = JSON.parse(lines[0].slice('[turn-timing-abort] '.length));
  assert.strictEqual(payload.reason, 'closed_before_first_byte:code=null');
  assert.strictEqual(payload.t3, null);
  assert.strictEqual(payload.ms.firstByte, null);
  assert.strictEqual(payload.ms.total, null);
  assert.strictEqual(payload.ms.spawn, 40);
  // A second abort (e.g. close firing after error) stays silent.
  assert.strictEqual(recorder.abort('sess-4', 'turn_4', 'again'), null);
  assert.strictEqual(lines.length, 1);
});

test('preparation failure abort before any runner marks', () => {
  const { recorder, lines } = makeRecorder();
  recorder.begin('sess-5', 'turn_5', {});
  recorder.abort('sess-5', 'turn_5', 'preparation:message-compose-failed');
  const payload = JSON.parse(lines[0].slice('[turn-timing-abort] '.length));
  assert.strictEqual(payload.t1, null);
  assert.strictEqual(payload.t2, null);
  assert.strictEqual(payload.ms.spawn, null);
});

// ── Streaming path (chat-stream) with a fake child_process.spawn ────────────
// Install the mock BEFORE requiring src/chat-stream, which binds spawn at
// module load. Fresh test process, so no prior require exists.
const spawned = [];
function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.stdin = new PassThrough();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.killed = true; };
  proc.writes = [];
  const realWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = (data) => { proc.writes.push(String(data)); return realWrite(data); };
  return proc;
}
const cpPath = require.resolve('child_process');
require.cache[cpPath] = {
  id: cpPath, filename: cpPath, loaded: true,
  exports: { spawn: (cmd, args, opts) => { const p = fakeProc(); spawned.push({ cmd, args, opts, proc: p }); return p; } },
};
const chatStream = require('../src/chat-stream');

test('streaming path: spawned → sent → firstByte phases fire in order, first byte once', async () => {
  const phases = [];
  const events = [];
  chatStream.ensure('timing-stream-1', {
    cmd: 'claude', cwd: process.cwd(), sessionId: 'uuid-1', baseArgs: ['-p'],
  });
  const sendPromise = chatStream.send('timing-stream-1', '你好', (evt) => events.push(evt), {
    onTiming: (phase) => phases.push(phase),
  });

  assert.strictEqual(spawned.length, 1, 'first send lazily spawns');
  const { proc } = spawned[0];
  assert.strictEqual(proc.writes.length, 1, 'prompt written to stdin');
  const written = JSON.parse(proc.writes[0]);
  assert.strictEqual(written.type, 'user');

  // First stdout chunk: two events in one chunk, then a second chunk.
  proc.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'system', subtype: 'init' }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n'));
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));

  await sendPromise;
  assert.deepStrictEqual(phases, ['spawned', 'sent', 'firstByte'],
    'exactly one firstByte for multiple chunks');
  assert.strictEqual(events.length, 3);
});

test('streaming path: warm process reuse still reports spawned+sent for the next turn', async () => {
  const phases = [];
  const sendPromise = chatStream.send('timing-stream-1', '第二轮', () => {}, {
    onTiming: (phase) => phases.push(phase),
  });
  assert.strictEqual(spawned.length, 1, 'no second spawn for a warm process');
  const { proc } = spawned[0];
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));
  await sendPromise;
  assert.deepStrictEqual(phases.filter(p => p !== 'firstByte'), ['spawned', 'sent']);
});

test('streaming path: exit before any output rejects the turn (abort boundary)', async () => {
  const phases = [];
  const sendPromise = chatStream.send('timing-stream-1', '第三轮', () => {}, {
    onTiming: (phase) => phases.push(phase),
  });
  const { proc } = spawned[0];
  proc.exitCode = 1;
  proc.emit('exit', 1, null); // no stdout ever arrived → turn-engine logs the abort line
  await assert.rejects(sendPromise, /exited code=1/);
  assert.ok(!phases.includes('firstByte'), 'no first byte was ever reported');
});

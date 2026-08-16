'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuxRunLog, safeSessionName } = require('../src/classify/aux-run-log');

function tempLog(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-aux-run-log-'));
  return { dir, log: createAuxRunLog({ dir, ...options }) };
}

test('records a run and reads it back verbatim', () => {
  const { log } = tempLog();
  log.record('s1', {
    runId: 'run-1',
    taskId: 'tsk-1',
    priorTaskId: 'tsk-old',
    anchorMessageId: 'msg-9',
    observedAnchorMessageId: 'msg-10',
    source: 'turn-end',
    turnId: 'turn-7',
    model: 'aux-model',
    latencyMs: 812,
    systemPrompt: 'SYS',
    prompt: 'CONVERSATION',
    rawText: '<think>…</think>\n改图标\n实现中\nW',
    parsed: { taskName: '改图标', phase: 'implementing', relation: 'same', taskId: 'tsk-1' },
    superseded: true,
    supersededReason: 'anchor_changed',
  });

  const stored = log.get('s1', 'run-1');
  assert.equal(stored.runId, 'run-1');
  assert.equal(stored.taskId, 'tsk-1');
  assert.equal(stored.priorTaskId, 'tsk-old');
  assert.equal(stored.anchorMessageId, 'msg-9');
  assert.equal(stored.observedAnchorMessageId, 'msg-10');
  assert.equal(stored.superseded, true);
  assert.equal(stored.supersededReason, 'anchor_changed');
  assert.equal(stored.source, 'turn-end');
  assert.equal(stored.turnId, 'turn-7');
  assert.equal(stored.latencyMs, 812);
  // Raw text must survive untouched — a parser backtest is meaningless against
  // text the log already normalised.
  assert.equal(stored.rawText, '<think>…</think>\n改图标\n实现中\nW');
  assert.equal(stored.parsed.taskName, '改图标');
});

test('missing session reads as empty rather than throwing', () => {
  const { log } = tempLog();
  assert.deepEqual(log.list('never-classified'), []);
  assert.equal(log.get('never-classified', 'run-1'), null);
  assert.deepEqual(log.byAnchor('never-classified', 'msg-1'), []);
});

test('byAnchor returns every verdict for one message in order', () => {
  const { log } = tempLog();
  log.record('s1', { runId: 'r1', anchorMessageId: 'm1', parsed: { taskName: '任务甲' } });
  log.record('s1', { runId: 'r2', anchorMessageId: 'm2', parsed: { taskName: '任务乙' } });
  // Same message re-judged by the periodic scan: the sequence is the evidence a
  // flapping state needs, so both entries must survive.
  log.record('s1', { runId: 'r3', anchorMessageId: 'm1', parsed: { taskName: '任务甲（修订）' } });

  const runs = log.byAnchor('s1', 'm1');
  assert.deepEqual(runs.map(r => r.runId), ['r1', 'r3']);
  assert.deepEqual(runs.map(r => r.parsed.taskName), ['任务甲', '任务甲（修订）']);
});

test('byTask groups runs belonging to one task', () => {
  const { log } = tempLog();
  log.record('s1', { runId: 'r1', taskId: 'tsk-a' });
  log.record('s1', { runId: 'r2', taskId: 'tsk-b' });
  log.record('s1', { runId: 'r3', taskId: 'tsk-a' });

  assert.deepEqual(log.byTask('s1', 'tsk-a').map(r => r.runId), ['r1', 'r3']);
  assert.deepEqual(log.byTask('s1', 'missing'), []);
});

test('sessions() lists every session with recorded runs', () => {
  const { log } = tempLog();
  log.record('alpha', { runId: 'r1' });
  log.record('beta', { runId: 'r2' });
  assert.deepEqual(log.sessions().sort(), ['alpha', 'beta']);
});

test('rotation keeps the newest runs and drops the oldest', () => {
  const { log } = tempLog({ maxRunsPerSession: 5 });
  for (let index = 0; index < 40; index += 1) {
    log.record('s1', { runId: `r${index}`, prompt: 'x'.repeat(600) });
  }
  const runs = log.list('s1');
  assert.ok(runs.length <= 6, `expected rotation to bound the file, saw ${runs.length}`);
  // Whatever survives must be the tail: dropping recent evidence would defeat
  // the point of keeping any.
  assert.equal(runs[runs.length - 1].runId, 'r39');
});

test('oversized fields are clipped and marked', () => {
  const { log } = tempLog({ maxFieldChars: 50 });
  log.record('s1', { runId: 'r1', prompt: 'y'.repeat(500) });
  const stored = log.get('s1', 'r1');
  assert.ok(stored.prompt.length < 200);
  assert.match(stored.prompt, /truncated 450 chars/);
});

test('a torn trailing line is skipped, not fatal', () => {
  const { dir, log } = tempLog();
  log.record('s1', { runId: 'r1', parsed: { state: 'W' } });
  fs.appendFileSync(log.fileFor('s1'), '{"runId":"r2","parse');

  const runs = log.list('s1');
  assert.deepEqual(runs.map(r => r.runId), ['r1']);
  assert.ok(fs.existsSync(dir));
});

test('append failures never throw at the call site', () => {
  const failing = {
    mkdirSync() {},
    appendFileSync() { throw new Error('disk full'); },
    statSync() { throw new Error('nope'); },
    readFileSync() { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
    readdirSync() { return []; },
    writeFileSync() {}, renameSync() {}, unlinkSync() {},
  };
  const messages = [];
  const log = createAuxRunLog({
    dir: '/tmp/multicc-aux-run-log-unwritable',
    fileSystem: failing,
    log: (event) => messages.push(event),
  });

  // Evidence is diagnostic. Losing it must not fail the turn that produced it.
  const entry = log.record('s1', { runId: 'r1' });
  assert.equal(entry.runId, 'r1');
  assert.ok(messages.includes('aux_run_log_append_failed'));
});

test('session ids are sanitised into a single flat filename', () => {
  assert.equal(safeSessionName('multicc/claude-chat-10'), 'multicc_claude-chat-10');
  assert.equal(safeSessionName('../../etc/passwd'), '______etc_passwd');
  assert.equal(safeSessionName(''), '_default');
});

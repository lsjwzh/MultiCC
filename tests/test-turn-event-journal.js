'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createTurnEventJournal } = require('../src/chat/turn-event-journal');

// note() is fire-and-forget by contract, so tests poll read() until the disk
// catches up instead of poking at the internal append queue.
async function until(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + label);
    await new Promise(r => setTimeout(r, 10));
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'turn-event-journal-'));
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

test('journal appends client-visible events in note() order with seq and ts', async () => {
  const dir = tmpDir();
  const journal = createTurnEventJournal({ dir: () => dir });
  let clock = 1_000;
  const stamp = () => { clock += 5; return clock; };
  const timed = createTurnEventJournal({ dir: () => dir, now: stamp });

  journal.note('s1', { type: 'assistant', text: 'hello' });
  journal.note('s1', { type: 'user', content: [{ type: 'tool_result', id: 't1' }] });
  timed.note('s2', { type: 'result', subtype: 'success' });

  await until(() => journal.read('s1').length === 2 && timed.read('s2').length === 1, 'appends land');

  const s1 = journal.read('s1');
  assert.equal(s1[0].seq, 1);
  assert.equal(s1[0].event.type, 'assistant');
  assert.equal(s1[1].seq, 2);
  assert.equal(s1[1].event.type, 'user');
  assert.ok(Number.isFinite(s1[0].ts));

  // Sessions are isolated files with independent seq counters.
  const s2 = timed.read('s2');
  assert.equal(s2[0].seq, 1);
  assert.equal(s2[0].ts, 1005);

  // Session ids are sanitized into filenames, never path fragments.
  journal.note('../evil/../s3', { type: 'assistant' });
  await until(() => journal.read('../evil/../s3').length === 1, 'sanitized id append');
  const files = fs.readdirSync(dir).map(f => f);
  assert.ok(files.every(f => /^[\w.-]+\.events\.jsonl(\.\d)?$/.test(f)), 'no path escapes: ' + files.join(','));
});

test('part_delta previews are skipped; other high-frequency events are kept', async () => {
  const dir = tmpDir();
  const journal = createTurnEventJournal({ dir: () => dir });

  journal.note('s', { type: 'part_delta', delta: { type: 'text', text: 'to' } });
  journal.note('s', { type: 'assistant', text: 'done' });
  await until(() => journal.read('s').length === 1, 'non-delta append');

  const entries = journal.read('s');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event.type, 'assistant');
});

test('oversized payloads become type-only stubs, never sliced JSON', async () => {
  const dir = tmpDir();
  const journal = createTurnEventJournal({ dir: () => dir });

  const huge = 'x'.repeat(64 * 1024);
  journal.note('s', { type: 'assistant', text: huge });
  journal.note('s', { type: 'assistant', text: 'after' });
  await until(() => journal.read('s').length === 2, 'stub + next append');

  const entries = journal.read('s');
  assert.equal(entries[0].event.type, 'assistant');
  assert.equal(entries[0].event.journaled, 'stub');
  assert.ok(entries[0].event.payloadBytes > 64 * 1024);
  assert.ok(!('text' in entries[0].event), 'payload fully dropped');
  assert.equal(entries[1].event.text, 'after');
  // Every line parses — no half-JSON poison anywhere in the file.
  const raw = fs.readFileSync(path.join(dir, 's.events.jsonl'), 'utf8');
  for (const line of raw.trimEnd().split('\n')) JSON.parse(line);
});

test('files rotate at maxFileBytes and keep the configured generations', async () => {
  const dir = tmpDir();
  // Tiny budget so rotation triggers after a handful of appends.
  const journal = createTurnEventJournal({ dir: () => dir, maxFileBytes: 300, keep: 2 });

  for (let i = 0; i < 12; i++) {
    journal.note('s', { type: 'assistant', text: 'event-' + i + '-' + 'p'.repeat(20) });
  }
  await until(() => fs.existsSync(path.join(dir, 's.events.jsonl.1')), 'first rotation');

  // Keep appending until the .1 generation is pushed to .2.
  for (let i = 12; i < 40; i++) {
    journal.note('s', { type: 'assistant', text: 'event-' + i + '-' + 'p'.repeat(20) });
  }
  await until(() => fs.existsSync(path.join(dir, 's.events.jsonl.2')), 'second rotation');

  // The rename chain is async: wait until the directory settles (two equal
  // consecutive snapshots) before asserting on generations.
  const snapshot = () => fs.readdirSync(dir).map(f => f + ':' + fs.statSync(path.join(dir, f)).size).sort().join('|');
  await new Promise(r => setTimeout(r, 30));
  let prev = snapshot();
  await until(() => {
    const cur = snapshot();
    if (cur === prev) return true;
    prev = cur;
    return false;
  }, 'rotation quiescence', 3000);

  // seq is monotonic across generations (a rotation never rewinds it mid-queue),
  // the newest event is still readable, and the active file stays bounded.
  const active = journal.read('s');
  const gen1 = readJsonl(path.join(dir, 's.events.jsonl.1'));
  const gen2 = readJsonl(path.join(dir, 's.events.jsonl.2'));
  const timeline = gen2.concat(gen1, active);
  assert.ok(timeline.length > 0);
  // The newest event is in the active file, or in .1 when its own append was
  // what pushed the file over budget and triggered the rotation.
  const allText = timeline.map(e => e.event.text).join('|');
  assert.ok(allText.includes('event-39'), 'newest event preserved across generations');
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(timeline[i].seq > timeline[i - 1].seq, 'seq monotonic across generations at ' + i);
  }
  // Active file is bounded — or momentarily absent when the last append was
  // itself the rotation trigger.
  const activePath = path.join(dir, 's.events.jsonl');
  if (fs.existsSync(activePath)) {
    const activeBytes = fs.statSync(activePath).size;
    assert.ok(activeBytes < 300 * 3, 'active file bounded: ' + activeBytes);
  }
});

test('missing parent dir is created lazily instead of dropping every event', async () => {
  // First boot after upgrade: chat_history exists, turn-events does not.
  // appendFile ENOENTs into the missing parent; the journal must recover.
  const dir = tmpDir();
  const nested = path.join(dir, 'turn-events');
  const journal = createTurnEventJournal({ dir: () => nested });

  journal.note('s', { type: 'assistant', text: 'first' });
  journal.note('s', { type: 'result' });
  await until(() => journal.read('s').length === 2, 'lazy dir creation');
  assert.ok(fs.statSync(nested).isDirectory());
  assert.equal(journal.stats().dropped, 0);
});

test('fs failures are swallowed and counted, note() never throws', async () => {
  // Point the journal at a path occupied by a regular file: every append
  // fails with ENOTDIR, but the broadcast path must stay unaffected.
  const blocker = path.join(os.tmpdir(), 'turn-event-journal-blocker-' + process.pid);
  fs.writeFileSync(blocker, 'not a dir');
  const journal = createTurnEventJournal({ dir: () => path.join(blocker, 'turn-events') });

  assert.doesNotThrow(() => {
    journal.note('s', { type: 'assistant', text: 'drop me' });
    journal.note('s', { type: 'result' });
  });
  await until(() => journal.stats().dropped >= 2, 'drops counted');
  assert.deepEqual(journal.read('s'), []);
  fs.rmSync(blocker, { force: true });
});

test('journal without a dir (or with junk events) is a silent no-op', () => {
  const journal = createTurnEventJournal({});
  assert.doesNotThrow(() => {
    journal.note('s', { type: 'assistant' });
    journal.note('s', null);
    journal.note('s', 'string-event');
  });
  assert.deepEqual(journal.read('s'), []);
});

test('server.js wires the journal into the single chatBroadcast funnel', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /sharedTurnEventJournal\(MULTICC_PATHS\)/, 'singleton bound to package paths');
  const broadcast = source.slice(
    source.indexOf('function chatBroadcast(sessionName, payload)'),
    source.indexOf('function chatBroadcast(sessionName, payload)') + 700
  );
  const noteIdx = broadcast.indexOf('turnEventJournal.note(sessionName, payload)');
  const emitIdx = broadcast.indexOf("bus.emit('chat:stream-progress'");
  const hostIdx = broadcast.indexOf('taskContextHost.broadcast');
  assert.ok(noteIdx !== -1, 'journal note() present in chatBroadcast');
  assert.ok(emitIdx > noteIdx, 'journaled before bus fan-out');
  assert.ok(hostIdx > noteIdx, 'journaled before taskContextHost fan-out (subagent/monitor events)');
});

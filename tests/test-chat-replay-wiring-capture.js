'use strict';

// Wiring regression for the native /ws/chat replay buffer and client registry.
//
// Re-runs the real-event capture (real gateway + Node server + fake Claude CLI
// on an isolated data root, docs/rust-migration/differential/capture-replay-buffer.js)
// against the CURRENT code and compares what clients actually receive with the
// frozen golden capture taken from the retired Node-owned buffer. Nothing in
// the golden is rewritten: the harness is pointed at a temp file.
//
// Volatile values (ids, paths, timestamps) are masked; what must match is the
// replayed delta text and order, the shape (ordered keys and value types) of
// every replayed frame, the burst's contiguity and position, and the live
// stream the first socket saw through the native fan-out.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'docs/rust-migration/differential/capture-replay-buffer.js');
const GOLDEN = path.join(ROOT, 'docs/rust-migration/differential/chat-replay-buffer-golden.json');
// Values whose content is part of the contract, not an identifier.
const KEEP = new Set(['type', 'subtype', 'text', 'cli', 'role', 'stop_reason', 'apiVersion']);

function decode(wire) {
  return JSON.parse(Buffer.from(wire.base64, 'base64').toString('utf8'));
}

function shape(value, key = '') {
  if (Array.isArray(value)) return value.map(item => shape(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, k)]));
  }
  if (typeof value === 'string') return KEEP.has(key) ? value : 'S';
  if (typeof value === 'number') return 'N';
  return value;
}

function liveStream(scenario) {
  return scenario.liveFrameBytes.map(decode)
    .filter(frame => frame.type === 'stream_event')
    .map(frame => shape(frame));
}

test('the native replay buffer and fan-out reproduce the retired Node-owned behaviour', { timeout: 480_000 }, t => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-replay-wiring-')), 'fresh.json');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [HARNESS, '--out', out], {
    cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 450_000,
  });
  assert.equal(run.status, 0, `capture failed:\n${run.stdout}\n${run.stderr}`);

  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const fresh = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(fresh.scenarios.map(s => s.name), golden.scenarios.map(s => s.name));
  assert.equal(fresh.cap, golden.cap);

  for (const want of golden.scenarios) {
    const got = fresh.scenarios.find(s => s.name === want.name);
    assert.deepEqual(got.replayed, want.replayed, `${want.name}: replayed deltas`);
    assert.equal(got.emitted, want.emitted, `${want.name}: emitted`);
    // What a reconnecting client is handed besides the burst (session_queue,
    // notify, chat_history_annotation, the post-burst background_tasks ...) is
    // broadcast by async turn machinery and lands in a timing-dependent order,
    // in the retired implementation as much as now. The buffer's contract is
    // narrower and fully deterministic, so that is what is compared:
    //   - the replayed stream_event frames, in order, shape by shape;
    //   - the burst is one contiguous run (a synchronous loop, nothing between);
    //   - the connect preamble (system, chat_history) precedes the burst.
    const bursts = scenario => scenario.frameBytes.map(decode).filter(frame => frame.type === 'stream_event');
    assert.deepEqual(bursts(got).map(frame => shape(frame)), bursts(want).map(frame => shape(frame)),
      `${want.name}: replayed frame shapes`);
    const types = got.frameBytes.map(wire => decode(wire).type);
    const burstIndexes = types.flatMap((type, index) => (type === 'stream_event' ? [index] : []));
    if (burstIndexes.length > 0) {
      assert.equal(burstIndexes.at(-1) - burstIndexes[0] + 1, burstIndexes.length,
        `${want.name}: the burst must be one contiguous run, got ${types.join(',')}`);
      assert.ok(types.indexOf('system') < burstIndexes[0], `${want.name}: system before the burst`);
      assert.ok(types.indexOf('chat_history') < burstIndexes[0], `${want.name}: chat_history before the burst`);
    } else {
      assert.ok(types.includes('system') && types.includes('chat_history'), `${want.name}: connect preamble`);
    }
    assert.deepEqual(liveStream(got), liveStream(want), `${want.name}: live stream through the native fan-out`);
  }

  // The replayed stream_event frames are the buffered, pre-enveloped bytes:
  // each must carry the envelope tail the retired burst-time encode produced.
  for (const scenario of fresh.scenarios) {
    for (const wire of scenario.frameBytes) {
      const text = Buffer.from(wire.base64, 'base64').toString('utf8');
      if (JSON.parse(text).type !== 'stream_event') continue;
      assert.ok(text.endsWith(',"apiVersion":"v1"}'), `${scenario.name}: replayed frame lacks the envelope tail`);
    }
  }
});

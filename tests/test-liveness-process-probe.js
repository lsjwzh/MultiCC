'use strict';

// Unit tests for the process-level liveness probe (src/liveness/process-probe.js).
// execFile (lsof) and the mtime stat are faked so the ESTABLISHED-connection
// parse and the rollout-growth bookkeeping are exercised without touching the OS.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessProbe } = require('../src/liveness/process-probe');

function fakeExec(output, err = null) {
  return (cmd, args, opts, cb) => cb(err, output, '');
}

const LSOF_ACTIVE = [
  'COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME',
  'node    4242 me   30u  IPv4  0x1234      0t0  TCP 10.0.0.2:52000->160.79.104.10:443 (ESTABLISHED)',
].join('\n');

const LSOF_IDLE = [
  'COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME',
  'node    4242 me   20u  IPv4  0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)',
  'node    4242 me   31u  IPv4  0x5678      0t0  TCP 10.0.0.2:52050->160.79.104.10:443 (CLOSE_WAIT)',
].join('\n');

test('detects an ESTABLISHED outbound :443 connection', async () => {
  const probe = createProcessProbe({ execFile: fakeExec(LSOF_ACTIVE), statMtimeMs: () => null });
  assert.equal(await probe.outboundHttps(4242), true);
});

test('a listening socket or CLOSE_WAIT is not an active outbound connection', async () => {
  const probe = createProcessProbe({ execFile: fakeExec(LSOF_IDLE), statMtimeMs: () => null });
  assert.equal(await probe.outboundHttps(4242), false);
});

test('invalid pid short-circuits to false without calling lsof', async () => {
  let called = false;
  const probe = createProcessProbe({
    execFile: () => { called = true; },
    statMtimeMs: () => null,
  });
  assert.equal(await probe.outboundHttps(0), false);
  assert.equal(await probe.outboundHttps(null), false);
  assert.equal(called, false);
});

test('lsof error with no output resolves false (never throws)', async () => {
  const probe = createProcessProbe({
    execFile: fakeExec('', new Error('lsof: not permitted')),
    statMtimeMs: () => null,
  });
  assert.equal(await probe.outboundHttps(4242), false);
});

test('rollout growth: advancing mtime across probes counts as growing', () => {
  let mtime = 1_000_000;
  let t = 1_000_000;
  const probe = createProcessProbe({
    execFile: fakeExec(''),
    statMtimeMs: () => mtime,
    now: () => t,
  });
  // First observation with a very recent mtime => growing
  assert.equal(probe.rolloutGrew('/x/roll.jsonl'), true);
  // Same mtime => not growing
  assert.equal(probe.rolloutGrew('/x/roll.jsonl'), false);
  // Advanced mtime => growing
  mtime += 500;
  assert.equal(probe.rolloutGrew('/x/roll.jsonl'), true);
});

test('rollout first-seen but stale mtime is not counted as growing', () => {
  const t = 10_000_000;
  const probe = createProcessProbe({
    execFile: fakeExec(''),
    statMtimeMs: () => t - 60_000, // a minute old
    now: () => t,
    rolloutWindowMs: 15_000,
  });
  assert.equal(probe.rolloutGrew('/x/roll.jsonl'), false);
});

test('missing rollout path / stat failure => not growing', () => {
  const probe = createProcessProbe({
    execFile: fakeExec(''),
    statMtimeMs: () => { throw new Error('ENOENT'); },
  });
  assert.equal(probe.rolloutGrew(null), false);
  assert.equal(probe.rolloutGrew('/nope'), false);
});

test('probe() combines both signals into one result', async () => {
  let mtime = 5_000_000;
  const t = 5_000_000;
  const probe = createProcessProbe({
    execFile: fakeExec(LSOF_ACTIVE),
    statMtimeMs: () => mtime,
    now: () => t,
  });
  const r = await probe.probe(4242, '/x/roll.jsonl');
  assert.equal(r.hasOutboundConnection, true);
  assert.equal(r.rolloutGrowing, true);
  assert.equal(r.pid, 4242);
});

test('createProcessProbe validates its deps', () => {
  assert.throws(() => createProcessProbe({}), /execFile is required/);
  assert.throws(() => createProcessProbe({ execFile: () => {} }), /statMtimeMs is required/);
});

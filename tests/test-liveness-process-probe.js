'use strict';

// Unit tests for the process-level liveness probe.
// execFile (lsof) and the mtime stat are faked so the ESTABLISHED-connection
// parse and the rollout-growth bookkeeping are exercised without touching the OS.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessProbe, createSystemProcessProbe } = require('../src/native/binding').processProbe;

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

test('8a259312 differential: port boundaries, promise identity, clock expiry and stat failures', async () => {
  const before = require('./helpers/frozen-host-leaves/process-probe').createProcessProbe;
  async function trace(factory, line) {
    const calls = [];
    let time = 5, mtime = 1;
    const api = factory({ now: () => time, outboundTtlMs: 4, rolloutWindowMs: 4,
      execFile(cmd, args, options, done) { calls.push([cmd, args, options]); done(Error(), line); },
      statMtimeMs(key) { calls.push(key); if (mtime === null) throw Error(); return mtime; },
    });
    const first = api.outboundHttps(42);
    const result = [first === api.outboundHttps(42), await first, api.rolloutGrew('x')];
    time = 9; result.push(first === api.outboundHttps(42));
    time = 10; result.push(first === api.outboundHttps(42));
    mtime = 2; result.push(await api.probe(43, 'x'));
    mtime = null; result.push(await api.probe(null, 'missing'));
    return { result, calls };
  }
  for (const line of ['', 'ESTABLISHED ->host:80', 'ESTABLISHED ->host:443_',
    'ESTABLISHED ->host:443中', 'ESTABLISHED ->x\r:443', 'ESTABLISHED\r->x:80',
    '->x:80\nESTABLISHED', 'ESTABLISHED ->x:8080 ->y:443.', '->\u2028x:443 ESTABLISHED']) {
    assert.deepEqual(await trace(createProcessProbe, line), await trace(before, line), line);
  }
});

test('8a259312 differential: an invalid clock throws synchronously on outbound and rejects probe', async () => {
  async function errors(factory) {
    const p = factory({ now: 1, statMtimeMs: () => null, execFile() {} });
    let sync;
    try { p.outboundHttps(1); } catch (e) { sync = [e.name, e.message]; }
    try { await p.probe(1, ''); } catch (e) { return [sync, e.name, e.message]; }
  }
  const before = require('./helpers/frozen-host-leaves/process-probe').createProcessProbe;
  assert.deepEqual(await errors(createProcessProbe), await errors(before));
});

test('system probe shares a real subprocess and uses rollout file mtimes', { skip: process.platform === 'win32' }, async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-process-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'lsof');
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, '');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    'echo "$@" >> "$(dirname "$0")/calls"',
    'echo "node TCP local:1234->remote:443 (ESTABLISHED)"',
    'exit 1',
  ].join('\n'), { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });

  const probe = createSystemProcessProbe();
  const first = probe.outboundHttps(4242);
  assert.equal(first, probe.outboundHttps(4242));
  assert.equal(await first, true, 'a nonzero exit can still supply a connection');
  assert.deepEqual(await probe.probe(4242, rollout), {
    hasOutboundConnection: true, rolloutGrowing: true, pid: 4242,
  });
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), '-nP -p 4242\n');
  assert.equal(probe.rolloutGrew(rollout), false);
  const next = new Date(Date.now() + 1000);
  fs.utimesSync(rollout, next, next);
  assert.equal(probe.rolloutGrew(rollout), true);
  assert.equal(probe.rolloutGrew(path.join(dir, 'absent')), false);
});

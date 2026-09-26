'use strict';

// keep-awake: the caffeinate assertion service (运行期防锁). Pure runtime test
// with an injected spawn so no real process is ever started in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createKeepAwake } = require('../src/keep-awake');

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => { child.signal = signal; return true; };
  child.unref = () => {};
  return child;
}

function harness(overrides = {}) {
  const spawned = [];
  const spawnFn = (file, args, opts) => {
    const child = fakeChild();
    spawned.push({ file, args, opts, child });
    return child;
  };
  const make = (o = {}) => createKeepAwake({ platform: 'darwin', spawnFn, watcherPid: 4242, log: () => {}, ...o });
  return { spawned, spawnFn, make };
}

test('keep-awake is mac-only and starts/stops caffeinate with the watcher pid', async () => {
  const h = harness();
  const linux = createKeepAwake({ platform: 'linux', spawnFn: h.spawnFn });
  assert.equal(linux.isAvailable(), false);
  assert.deepEqual(linux.getStatus(), { available: false, enabled: false, error: null });
  await assert.rejects(() => linux.setEnabled(true), /only available on macOS/);

  const ka = h.make();
  assert.equal(ka.isAvailable(), true);
  assert.deepEqual(ka.getStatus(), { available: true, enabled: false, error: null });

  await ka.setEnabled(true);
  assert.equal(ka.getStatus().enabled, true);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].file, '/usr/bin/caffeinate');
  assert.deepEqual(h.spawned[0].args, ['-d', '-i', '-u', '-w', '4242']);

  // 幂等：已经在跑就不重复 spawn。
  await ka.setEnabled(true);
  assert.equal(h.spawned.length, 1);

  await ka.setEnabled(false);
  assert.equal(ka.getStatus().enabled, false);
  assert.equal(h.spawned[0].child.signal, 'SIGTERM');
});

test('keep-awake reports a crashed caffeinate and starts a fresh one on re-enable', async () => {
  const h = harness();
  const ka = h.make();
  await ka.setEnabled(true);
  h.spawned[0].child.emit('exit', 1, null);
  assert.equal(ka.getStatus().enabled, false);
  assert.match(ka.getStatus().error, /caffeinate exited/);

  await ka.setEnabled(true);
  assert.equal(h.spawned.length, 2);
  assert.equal(ka.getStatus().enabled, true);
});

test('keep-awake surfaces a spawn failure without throwing', async () => {
  const spawnFn = () => { throw new Error('spawn EACCES'); };
  const ka = createKeepAwake({ platform: 'darwin', spawnFn });
  await ka.setEnabled(true);
  assert.equal(ka.getStatus().enabled, false);
  assert.match(ka.getStatus().error, /spawn EACCES/);
});
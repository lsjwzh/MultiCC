'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createDetached, DONE_MARKER } = require('../src/detached');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-detached-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const killed = [];
  const adapter = createDetached({
    baseDir: path.join(dataDir, 'detached'),
    now: () => 1_700_000_000_000,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, options });
      return { pid: 43210, unref() {} };
    },
    isProcessAlive: pid => pid === 43210,
    killImpl(pid, signal) { killed.push({ pid, signal }); },
  });
  return { dataDir, adapter, spawned, killed };
}

test('fixed detached id is launch-idempotent and every durable artifact is private', t => {
  const { adapter, spawned } = fixture(t);
  const first = adapter.launch({
    id: 'd_fixed_1234', command: 'printf done', cwd: os.tmpdir(), label: 'fixture',
  });
  const paths = adapter.jobPaths(first.id);
  assert.equal(spawned.length, 1);
  assert.equal(fs.statSync(adapter.BASE_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.metaPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.logPath).mode & 0o777, 0o600);

  // Emulate the wrapper's exclusive start claim. A replacement server sees
  // this file and never launches the command body a second time.
  fs.writeFileSync(paths.startedPath, '', { mode: 0o600 });
  fs.writeFileSync(paths.pidPath, '43210\n', { mode: 0o600 });
  const duplicate = adapter.launch({
    id: 'd_fixed_1234', command: 'printf done', cwd: os.tmpdir(), label: 'fixture',
  });
  assert.equal(duplicate.reused, true);
  assert.equal(spawned.length, 1);

  assert.throws(
    () => adapter.launch({ id: 'd_fixed_1234', command: 'different', cwd: os.tmpdir() }),
    error => error.code === 'DETACHED_ID_CONFLICT' && error.statusCode === 409,
  );
});

test('completion marker and process ownership are reconstructed from disk', t => {
  const { adapter, killed } = fixture(t);
  const job = adapter.launch({
    id: 'd_recover_1234', command: 'build', cwd: os.tmpdir(), label: 'recover',
  });
  const paths = adapter.jobPaths(job.id);
  fs.writeFileSync(paths.startedPath, '', { mode: 0o600 });
  fs.writeFileSync(paths.pidPath, '43210\n', { mode: 0o600 });
  assert.equal(adapter.status(job.id).running, true);

  const cancelled = adapter.cancel(job.id);
  assert.equal(cancelled.ok, true);
  assert.deepEqual(killed, [{ pid: -43210, signal: 'SIGTERM' }]);

  fs.writeFileSync(paths.logPath, 'line one\nfinal output\n', { mode: 0o600 });
  fs.writeFileSync(paths.donePath, `${DONE_MARKER} exit=7\n`, { mode: 0o600 });
  const rebuilt = createDetached({
    baseDir: adapter.BASE_DIR,
    isProcessAlive: () => false,
  });
  const status = rebuilt.status(job.id);
  assert.equal(status.done, true);
  assert.equal(status.exitCode, 7);
  assert.equal(status.running, false);
  assert.match(status.logTail, /final output/);
  assert.equal(fs.statSync(paths.donePath).mode & 0o777, 0o600);
});

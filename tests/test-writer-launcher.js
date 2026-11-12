'use strict';
// End-to-end contract of the fail-closed `multicc-writer` launcher: the lease
// is acquired in the task-shell SQLite store BEFORE the wrapped CLI may run,
// and released only after the child's whole process group is gone. The Rust
// workspace tests cover the store semantics; this suite proves the shipped
// binary honours them from the host's own Node runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getNative } = require('../src/native/runtime');

function locateBinary() {
  if (process.env.MULTICC_WRITER_BIN) return process.env.MULTICC_WRITER_BIN;
  const name = process.platform === 'win32' ? 'multicc-writer.exe' : 'multicc-writer';
  const candidates = [
    path.join(__dirname, '..', 'native', 'prebuilt', `${process.platform}-${process.arch}`, name),
    path.join(__dirname, '..', 'native', 'target', 'release', name),
    path.join(__dirname, '..', 'native', 'target', 'debug', name),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const binary = locateBinary();
// The docker regression image stages the launcher next to the other kernels;
// there a missing binary is a packaging bug, never a skip.
const dockerGate = fs.existsSync('/.dockerenv') && !!process.env.MULTICC_DATA_DIR;
if (!binary) assert.ok(!dockerGate, 'docker regression image must ship multicc-writer');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-writer-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.sqlite');
  const addon = getNative();
  const store = new addon.RustTaskStore(file);
  const run = command => JSON.parse(store.run(JSON.stringify(command)));
  const lease = { id: 'lease', workspaceId: 'w', sessionId: 's', epoch: 'e', generation: 1, state: 'running', operationId: 'op' };
  run({ op: 'set', kind: 'workspace:lease', id: 'w', body: JSON.stringify(lease) });
  const fence = JSON.stringify({ workspaceId: 'w', leaseId: 'lease', epoch: 'e', generation: 1, sessionId: 's' });
  return { dir, file, run, fence };
}

function launch(f, args, env = {}) {
  return spawnSync(binary, ['exec', '--', ...args], {
    env: {
      ...process.env,
      MULTICC_TASK_STORE: f.file,
      MULTICC_WRITER_FENCE: f.fence,
      MULTICC_WRITER_KIND: 'background',
      ...env,
    },
    encoding: 'utf8',
  });
}

// Cross-platform command helpers: the negative tests must refuse before the
// command could ever run, and the happy path asserts on the marker file.
const touchCommand = marker => (process.platform === 'win32'
  ? ['cmd', '/c', 'type', 'nul', '>', marker]
  : ['touch', marker]);
const exit42Command = () => (process.platform === 'win32'
  ? ['cmd', '/c', 'exit', '42']
  : ['sh', '-c', 'exit 42']);

test('refuses to spawn without the fence env', { skip: !binary }, t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'marker');
  const result = spawnSync(binary, ['exec', ...touchCommand(marker)], {
    env: { ...process.env, MULTICC_TASK_STORE: f.file, MULTICC_WRITER_FENCE: '', MULTICC_WRITER_KIND: 'background' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.ok(!fs.existsSync(marker));
});

test('refuses a stale fence identity', { skip: !binary }, t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'marker');
  const result = launch(f, touchCommand(marker), {
    MULTICC_WRITER_FENCE: JSON.stringify({ workspaceId: 'w', leaseId: 'lease', epoch: 'other', generation: 1, sessionId: 's' }),
  });
  assert.equal(result.status, 75);
  assert.ok(!fs.existsSync(marker));
  assert.equal(f.run({ op: 'writerLeaseList', workspaceId: 'w' }), null);
});

test('acquires, annotates, runs and releases', { skip: !binary }, t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'marker');
  const result = launch(f, touchCommand(marker), { MULTICC_WRITER_ID: 'ext-1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(marker));
  const record = f.run({ op: 'writerLeaseList', workspaceId: 'w' });
  assert.equal(record.writers['ext-1'].state, 'released');
  assert.equal(record.writers['ext-1'].kind, 'background');
  assert.ok(record.writers['ext-1'].pid > 0);
});

test('passes the child exit status through', { skip: !binary }, t => {
  const f = fixture(t);
  const result = launch(f, exit42Command());
  assert.equal(result.status, 42);
});

// A CLI that exits while its detached descendant keeps writing must hold the
// lease until the descendant is gone — the launcher releases on process-group
// emptiness, not on the direct child's exit.
test('group lifetime covers detached descendants', { skip: !binary || process.platform === 'win32' }, t => {
  const f = fixture(t);
  const started = Date.now();
  const result = launch(f, ['sh', '-c', 'sleep 1 & exit 0'], { MULTICC_WRITER_ID: 'ext-group' });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsed >= 900, `launcher left after ${elapsed}ms with the group still alive`);
  assert.equal(f.run({ op: 'writerLeaseList', workspaceId: 'w' }).writers['ext-group'].state, 'released');
});

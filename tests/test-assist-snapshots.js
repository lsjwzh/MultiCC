'use strict';

// Frozen behavior of human-assist screenshot retention: per-file 7-day
// sweep under <assistDir>/<session>/, empty session dirs dropped, symlinks left alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssistSweep, DEFAULT_MAX_AGE_MS } = require('./helpers/legacy-assist-snapshots');
const { createPaths } = require('../src/paths');

const DAY = 24 * 3600 * 1000;

function touch(file, ageMs, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const t = new Date(now - ageMs);
  fs.utimesSync(file, t, t);
}

test('removes only files past the window and drops emptied session dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-sweep-'));
  const now = Date.now();
  try {
    touch(path.join(root, 's1', 'old.png'), 8 * DAY, now);
    touch(path.join(root, 's1', 'fresh.png'), 1 * DAY, now);
    touch(path.join(root, 's2', 'old-a.png'), 9 * DAY, now);
    touch(path.join(root, 's2', 'old-b.png'), 30 * DAY, now);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-outside-'));
    touch(path.join(outside, 'keep.png'), 30 * DAY, now);
    fs.symlinkSync(outside, path.join(root, 'link'));
    const logs = [];
    const removed = createAssistSweep({ assistDir: root, now: () => now, log: (m) => logs.push(m) })();
    assert.equal(removed, 3);
    assert.deepEqual(fs.readdirSync(path.join(root, 's1')), ['fresh.png']);
    assert.equal(fs.existsSync(path.join(root, 's2')), false);
    assert.equal(fs.existsSync(path.join(outside, 'keep.png')), true);
    assert.equal(logs.length, 1);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing dir is a no-op and unbounded roots are refused', () => {
  assert.equal(createAssistSweep({ assistDir: path.join(os.tmpdir(), 'assist-none-' + process.pid), log: () => {} })(), 0);
  assert.throws(() => createAssistSweep({ assistDir: '/' }), TypeError);
  assert.throws(() => createAssistSweep({ assistDir: 'relative/dir' }), TypeError);
  assert.equal(DEFAULT_MAX_AGE_MS, 7 * DAY);
});

test('assist dir follows the data-dir isolation rule', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-paths-'));
  try {
    assert.equal(createPaths({ dataDir }).assistDir, path.join(dataDir, 'assist'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function seedTree(root) {
  const now = Date.now();
  for (const [file, days] of [
    ['current/old.png', 9], ['current/fresh.png', 1], ['expired/frame', 9],
    ['current/old-tree/inner.png', 1], ['loose-file', 10], ['keep-loose', 2],
  ]) touch(path.join(root, file), days * DAY, now);
  const old = new Date(now - 10 * DAY);
  fs.utimesSync(path.join(root, 'current/old-tree'), old, old);
  fs.mkdirSync(path.join(root, 'empty'));
  if (process.platform !== 'win32') {
    const outside = path.join(root, '..', 'outside');
    touch(path.join(outside, 'untouched'), 30 * DAY, now);
    fs.symlinkSync(outside, path.join(root, 'link'));
    const nestedLink = path.join(root, 'current', 'expired-link');
    fs.symlinkSync(outside, nestedLink);
    fs.lutimesSync(nestedLink, old, old);
  }
}

function tree(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap(entry => entry.isDirectory()
    ? [entry.name + '/', ...tree(path.join(root, entry.name)).map(item => entry.name + '/' + item)]
    : [entry.name]).sort();
}

async function until(check, diagnostic) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(diagnostic());
}

for (const mode of ['--no-node', '--node', 'direct']) {
  test(`screenshot cleanup matches the frozen directory tree (${mode})`, async t => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-differential-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const expected = path.join(root, 'oracle', 'assist');
    const actual = path.join(root, 'data', 'assist');
    seedTree(expected);
    seedTree(actual);
    const removed = createAssistSweep({ assistDir: expected, log() {} })();
    if (mode === 'direct') {
      const { AssistSnapshotRetention } = require('../src/native/binding').getNative();
      assert.throws(() => new AssistSnapshotRetention('relative/dir'), /bounded absolute/);
      const worker = new AssistSnapshotRetention(actual);
      try {
        await until(() => !fs.existsSync(path.join(actual, 'loose-file')), () => 'worker did not sweep');
      } finally {
        await worker.stop();
      }
    } else if (mode === '--node') {
      const { start } = require('./helpers/external-workspace-gateway');
      const gateway = await start(t, true, { dir: path.dirname(actual) });
      try {
        await until(() => tree(actual).join('\n') === tree(expected).join('\n'),
          () => 'gateway with Node did not finish the startup sweep');
      } finally {
        await gateway.close();
      }
    } else {
      const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR ||
        path.resolve(__dirname, '../native/prebuilt'), process.platform + '-' + process.arch, 'multicc_core.node');
      const gateway = path.join(path.dirname(addon), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
      const args = ['serve', '--cwd', root, '--ephemeral-loopback', '--stdin-lifeline', mode];
      const env = { ...process.env, HOME: root, USERPROFILE: root, HOST: '127.0.0.1',
        ACCESS_TOKEN: 'assist-fixture', MULTICC_DATA_DIR: path.dirname(actual) };
      const child = spawn(gateway, args, { cwd: root, env, stdio: ['pipe', 'ignore', 'pipe'] });
      const closed = once(child, 'close');
      let log = '';
      child.stderr.on('data', chunk => { log += chunk; });
      try {
        await until(() => {
          if (child.exitCode !== null || child.signalCode) assert.fail(log);
          return log.includes(`cleaned up ${removed} expired assist screenshot(s)`);
        }, () => log);
        const port = /listening on 127\.0\.0\.1:(\d+)/.exec(log)[1];
        const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
        assert.equal(health.status, 200);
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { assert.deepEqual(await closed, [0, null]); } finally { clearTimeout(timer); }
      }
    }
    assert.deepEqual(tree(actual), tree(expected));
    if (process.platform !== 'win32') assert.equal(fs.readFileSync(path.join(root, 'data/outside/untouched'), 'utf8'), 'x');
  });
}

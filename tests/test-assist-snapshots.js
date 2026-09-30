'use strict';

// Human-assist screenshot retention (src/assist-snapshots.js): per-file 7-day
// sweep under <assistDir>/<session>/, empty session dirs dropped, symlinks left alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssistSweep, DEFAULT_MAX_AGE_MS } = require('../src/assist-snapshots');
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

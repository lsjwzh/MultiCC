'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLogHousekeeping,
  LOG_HOUSEKEEPING_ACTIVE_FILES,
} = require('../src/log-housekeeping');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T12:00:00Z');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-log-housekeeping-'));
  const logs = [];
  const housekeeping = options => createLogHousekeeping({
    logsDir: dir,
    now: () => NOW,
    logger: { info: (event, fields) => logs.push([event, fields]) },
    ...options,
  });
  const write = (name, content, ageDays = 0) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const past = new Date(NOW - ageDays * DAY_MS);
    fs.utimesSync(file, past, past);
    return file;
  };
  return {
    dir, logs, housekeeping, write,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('legacy logs older than the retention window are deleted, recent ones kept', async () => {
  const h = setup();
  try {
    h.write('pm2-out.log', 'old pm2 output', 10);
    h.write('verify-2026-06.log', 'old verify', 48);
    h.write('webcc.log', 'recent webcc', 1);
    const summary = await h.housekeeping().runOnce();
    assert.equal(fs.existsSync(path.join(h.dir, 'pm2-out.log')), false);
    assert.equal(fs.existsSync(path.join(h.dir, 'verify-2026-06.log')), false);
    assert.equal(fs.existsSync(path.join(h.dir, 'webcc.log')), true);
    assert.deepEqual(summary.deleted.map(item => item.file).sort(), ['pm2-out.log', 'verify-2026-06.log']);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0][0], 'log_housekeeping');
  } finally { h.cleanup(); }
});

test('active multicc.log is copy-truncated in place, never renamed or deleted', async () => {
  const h = setup();
  try {
    const head = 'H'.repeat(9000);
    const tail = 'T'.repeat(1000);
    const file = h.write('multicc.log', head + tail);
    const inoBefore = fs.statSync(file).ino;
    const summary = await h.housekeeping({ keepTailBytes: 1000 }).runOnce();
    const stat = fs.statSync(file);
    assert.equal(stat.size, 1000);
    assert.equal(stat.ino, inoBefore); // same inode: the O_APPEND writer keeps working
    assert.equal(fs.readFileSync(file, 'utf8'), tail);
    assert.equal(fs.existsSync(`${file}.housekeep.tmp`), false);
    assert.deepEqual(summary.truncated, [{ file: 'multicc.log', before: 10000, after: 1000 }]);
    assert.deepEqual(summary.deleted, []);
  } finally { h.cleanup(); }
});

test('active files are never deleted even when ancient', async () => {
  const h = setup();
  try {
    const file = h.write('multicc-error.log', 'small error log', 400); // far past retention
    const summary = await h.housekeeping({ retainDays: 3 }).runOnce();
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'small error log');
    assert.deepEqual(summary.deleted, []);
    assert.deepEqual(summary.truncated, []); // under keepTailBytes → untouched
  } finally { h.cleanup(); }
});

test('active files under the tail threshold are left byte-for-byte untouched', async () => {
  const h = setup();
  try {
    const file = h.write('multicc.log', 'tiny', 0);
    const before = fs.statSync(file);
    await h.housekeeping({ keepTailBytes: 1024 }).runOnce();
    assert.equal(fs.readFileSync(file, 'utf8'), 'tiny');
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  } finally { h.cleanup(); }
});

test('retention and tail thresholds are configurable', async () => {
  const h = setup();
  try {
    h.write('webcc.log', 'two days old', 2);
    const file = h.write('multicc.log', 'A'.repeat(500) + 'B'.repeat(500));
    const summary = await h.housekeeping({ retainDays: 1, keepTailBytes: 500 }).runOnce();
    assert.equal(fs.existsSync(path.join(h.dir, 'webcc.log')), false); // 2d > 1d window
    assert.equal(fs.readFileSync(file, 'utf8'), 'B'.repeat(500));
    assert.equal(summary.truncated.length, 1);
  } finally { h.cleanup(); }
});

test('missing logs dir is a no-op; non-log files are ignored', async () => {
  const h = setup();
  try {
    h.write('notes.txt', 'not a log', 99);
    const missing = h.housekeeping({ logsDir: path.join(h.dir, 'does-not-exist') });
    const summary = await missing.runOnce();
    assert.deepEqual(summary.deleted, []);
    assert.equal(fs.existsSync(path.join(h.dir, 'notes.txt')), true); // .txt never touched
  } finally { h.cleanup(); }
});

test('defaults cover the two redirect targets', () => {
  assert.deepEqual([...LOG_HOUSEKEEPING_ACTIVE_FILES].sort(), ['multicc-error.log', 'multicc.log']);
});

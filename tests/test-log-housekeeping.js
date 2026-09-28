'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLogHousekeeping,
  LOG_HOUSEKEEPING_ACTIVE_FILES,
  LOG_HOUSEKEEPING_INTERVAL_MS,
} = require('../src/log-housekeeping');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T12:00:00Z');

// observability.write() 的行形状：ts 是第一个字段。
const line = (ageDays, event) => JSON.stringify({
  ts: new Date(NOW - ageDays * DAY_MS).toISOString(), level: 'info', service: 'multicc', event,
});

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

// —— 保留期对两个活跃文件同样生效 ——
// 旧实现只按字节截断：stdout 一天写 ~90MB，所以 5MB 的阈值实际只留了最近 1 小时，
// 「只留 N 天」这句对它们从来不成立（错误日志的 5MB 尾部横跨 8 天），而且字节切口
// 落在行中间，每次截断都留下解析不了的残行（实测一次开机后 2034 条）。
test('active log drops whole lines older than the window, cutting on a line boundary', async () => {
  const h = setup();
  try {
    const old = [4, 3.5, 3.1].map((age, i) => line(age, `old_${i}`));
    const fresh = [0.01, 0.005, 0.001].map((age, i) => line(age, `new_${i}`));
    const body = [...old, ...fresh].join('\n') + '\n';
    const file = h.write('multicc.log', body);
    const summary = await h.housekeeping({ retainDays: 3 }).runOnce();
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(kept.map(l => JSON.parse(l).event), ['new_0', 'new_1', 'new_2'],
      '切口必须落在行首：残行让整行 JSON 都解析不了');
    assert.equal(summary.truncated.length, 1);
    assert.equal(summary.truncated[0].file, 'multicc.log');
    assert.equal(summary.truncated[0].after, kept.join('\n').length + 1);
    assert.equal(summary.truncated[0].before, Buffer.byteLength(body));
  } finally { h.cleanup(); }
});

test('the window is what decides: a 5-day-old line survives a 7-day window', async () => {
  const h = setup();
  try {
    const file = h.write('multicc-error.log', [line(5, 'five_days'), line(0.5, 'recent')].join('\n') + '\n');
    await h.housekeeping({ retainDays: 7 }).runOnce();
    assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).event),
      ['five_days', 'recent']);
  } finally { h.cleanup(); }
});

// 空闲超过保留期时错误日志必须真的瘦下来，而不是把一周前的行一直钉在 5MB 尾部里。
test('when nothing in the window is recent enough, an active log keeps only its newest line', async () => {
  const h = setup();
  try {
    const file = h.write('multicc-error.log', [line(30, 'a'), line(20, 'b'), line(10, 'c')].join('\n') + '\n');
    await h.housekeeping({ retainDays: 3 }).runOnce();
    assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).event), ['c']);
  } finally { h.cleanup(); }
});

test('a small active log with no timestamps at all is left alone, never emptied', async () => {
  const h = setup();
  try {
    const content = 'not json at all\nsecond line\n';
    const file = h.write('multicc-error.log', content, 400);
    await h.housekeeping({ retainDays: 3 }).runOnce();
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally { h.cleanup(); }
});

// —— logs/restart-*/：重启路由 mkdtempSync 造的目录，restart.sh 最多活 2 秒，之后没人回收 ——
test('logs/restart-* dirs past the window are removed wholesale; recent and foreign dirs stay', async () => {
  const h = setup();
  try {
    const mkdir = (name, ageDays) => {
      const dir = path.join(h.dir, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'restart.sh'), '#!/bin/sh\n/bin/sleep 2\n');
      fs.writeFileSync(path.join(dir, 'restart.log'), 'restart\n');
      const past = new Date(NOW - ageDays * DAY_MS);
      fs.utimesSync(dir, past, past);
      return dir;
    };
    const stale = mkdir('restart-AbC123', 5);
    const fresh = mkdir('restart-ZzZ999', 1);
    const foreign = mkdir('keepme', 90); // 不叫 restart-*：绝不碰
    const summary = await h.housekeeping({ retainDays: 3 }).runOnce();
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(foreign), true);
    assert.deepEqual(summary.dirsRemoved, [{ dir: 'restart-AbC123', ageDays: 5 }]);
  } finally { h.cleanup(); }
});

// 巡检频率本身就是上限：一天 90MB 的 stdout，阈值再小，日巡检也等于没有上限。
test('the sweep is hourly, not daily', () => {
  assert.equal(LOG_HOUSEKEEPING_INTERVAL_MS, 60 * 60 * 1000);
});

test('defaults cover the two redirect targets', () => {
  assert.deepEqual([...LOG_HOUSEKEEPING_ACTIVE_FILES].sort(), ['multicc-error.log', 'multicc.log']);
});

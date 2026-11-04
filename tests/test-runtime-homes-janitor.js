'use strict';

// Stale CLI session-home retention (src/runtime-homes-janitor.js): homes under
// ~/.multicc/{codex-session-homes,codex-homes,codex-attempt-homes,zcode-homes}
// whose newest top-level entry is older than the TTL are removed; fresh homes,
// symlinks, files and anything outside the whitelist survive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeHomesJanitor, DEFAULT_TTL_DAYS, HOME_DIR_NAMES } = require('../src/runtime-homes-janitor');

const DAY = 24 * 3600 * 1000;

function makeHome(root, collection, id, ages) {
  const dir = path.join(root, collection, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  ages.forEach((ageMs, index) => {
    const file = path.join(dir, `entry-${index}`);
    fs.writeFileSync(file, 'x');
    const t = new Date(now - ageMs);
    fs.utimesSync(file, t, t);
  });
  // The directory's own mtime counts as an activity signal; age it to the
  // oldest entry so only genuinely stale homes look stale.
  const oldest = new Date(now - Math.max(...ages));
  fs.utimesSync(dir, oldest, oldest);
  return dir;
}

test('removes stale homes in whitelisted collections, keeps fresh and unknown ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homes-janitor-'));
  const now = Date.now();
  try {
    const stale = makeHome(root, 'codex-session-homes', 'task-old-abc', [20 * DAY, 30 * DAY]);
    const fresh = makeHome(root, 'codex-session-homes', 'task-new-abc', [1 * DAY]);
    const rewrittenOldDir = makeHome(root, 'codex-homes', 'uuid-dir', [30 * DAY]);
    // A home with an old dir mtime but one fresh top-level entry stays.
    fs.utimesSync(rewrittenOldDir, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    const freshFile = path.join(rewrittenOldDir, 'late-credential.json');
    fs.writeFileSync(freshFile, 'x');
    const freshTime = new Date(now - 2 * DAY);
    fs.utimesSync(freshFile, freshTime, freshTime);
    const staleZcode = makeHome(root, 'zcode-homes', 'z-old', [40 * DAY]);
    makeHome(root, 'codex-attempt-homes', 'att-old', [40 * DAY]);
    // Unknown sibling collections and stray files are never touched.
    const unknown = makeHome(root, 'quota-browser-profile', 'keep-me', [90 * DAY]);
    const strayFile = path.join(root, 'codex-session-homes', 'stray.json');
    fs.mkdirSync(path.dirname(strayFile), { recursive: true });
    fs.writeFileSync(strayFile, 'x');
    fs.utimesSync(strayFile, new Date(now - 90 * DAY), new Date(now - 90 * DAY));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'homes-outside-'));
    const linkTarget = path.join(outside, 'real-home');
    fs.mkdirSync(linkTarget, { recursive: true });
    fs.symlinkSync(linkTarget, path.join(root, 'codex-session-homes', 'link-home'));

    const logs = [];
    const removed = createRuntimeHomesJanitor({ homesRoot: root, now: () => now, log: (m) => logs.push(m) })();

    assert.equal(removed, 3); // stale, staleZcode, att-old
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(staleZcode), false);
    assert.equal(fs.existsSync(path.join(root, 'codex-attempt-homes', 'att-old')), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(rewrittenOldDir), true); // fresh entry beats old dir mtime
    assert.equal(fs.existsSync(unknown), true);
    assert.equal(fs.existsSync(strayFile), true); // files are not homes
    assert.equal(fs.readlinkSync(path.join(root, 'codex-session-homes', 'link-home')), linkTarget); // symlink untouched
    assert.equal(logs.length, 1);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing root/collections are a no-op, unbounded roots refused, ttl<=0 disables', () => {
  assert.equal(createRuntimeHomesJanitor({ homesRoot: path.join(os.tmpdir(), 'homes-none-' + process.pid), log: () => {} })(), 0);
  assert.throws(() => createRuntimeHomesJanitor({ homesRoot: '/' }), TypeError);
  assert.throws(() => createRuntimeHomesJanitor({ homesRoot: 'relative/dir' }), TypeError);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homes-disabled-'));
  try {
    const stale = makeHome(root, 'codex-homes', 'old', [90 * DAY]);
    assert.equal(createRuntimeHomesJanitor({ homesRoot: root, ttlDays: 0, log: () => {} })(), 0);
    assert.equal(fs.existsSync(stale), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(DEFAULT_TTL_DAYS, 14);
  assert.ok(HOME_DIR_NAMES.includes('codex-session-homes'));
  assert.ok(!HOME_DIR_NAMES.includes('assist'));
});

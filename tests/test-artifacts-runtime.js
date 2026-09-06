'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCleanup } = require('../src/artifacts');

const DAY_MS = 24 * 60 * 60 * 1000;

function artifactDir(root, id, mtimeMs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), id);
  const at = new Date(mtimeMs);
  fs.utimesSync(dir, at, at);
  return dir;
}

test('artifact cleanup keeps exact live pins and still removes unreferenced entries after seven days', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 18);
  const old = now - 8 * DAY_MS;
  const fresh = now - 6 * DAY_MS;
  artifactDir(root, 'pinned_exact-1', old);
  artifactDir(root, 'pinned_exact-1-copy', old);
  artifactDir(root, 'stale_unreferenced-1', old);
  artifactDir(root, 'fresh_unreferenced-1', fresh);

  const cleanup = createCleanup({ artifactsDir: root, now: () => now, log() {} });
  assert.equal(cleanup(7 * DAY_MS, [
    'pinned_exact-1', '../stale_unreferenced-1', 'bad/id',
  ]), 2);
  assert.equal(fs.existsSync(path.join(root, 'pinned_exact-1')), true);
  assert.equal(fs.existsSync(path.join(root, 'pinned_exact-1-copy')), false,
    'similar prefixes are not pins');
  assert.equal(fs.existsSync(path.join(root, 'stale_unreferenced-1')), false);
  assert.equal(fs.existsSync(path.join(root, 'fresh_unreferenced-1')), true);
});

test('artifact cleanup refuses a symlinked root instead of deleting through it', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outside = path.join(parent, 'outside');
  const linkedRoot = path.join(parent, 'artifacts-link');
  fs.mkdirSync(outside);
  const victim = artifactDir(outside, 'must_survive-1', 1);
  fs.symlinkSync(outside, linkedRoot, 'dir');

  const cleanup = createCleanup({ artifactsDir: linkedRoot, now: () => 10 * DAY_MS, log() {} });
  assert.equal(cleanup(DAY_MS), 0);
  assert.equal(fs.existsSync(victim), true);
});

test('server resolves pins from TaskRun storage and docs registry for every artifact cleanup tick', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Contract: every cleanup tick merges pins from both stores, and a pin-read
  // failure only warns + skips (never crashes the server). Match the pin
  // sources and the failure sentinel rather than the full statement shape so
  // formatting/line-budget merges don't break this test again.
  assert.match(source,
    /artifacts\.cleanup\(undefined, \[\.\.\.taskRunStore\.listPinnedArtifactIds\(\), \.\.\.docsRegistry\.listPinnedArtifactIds\(\)\]\)/);
  assert.match(source, /artifact_cleanup_pin_read_failed/);
  assert.match(source, /cleanupArtifacts\(\);/);
  assert.match(source, /setInterval\(\(\) => cleanupArtifacts\(\), 6 \* 3600 \* 1000\)/);
});

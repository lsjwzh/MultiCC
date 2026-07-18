'use strict';
// Regression coverage for src/path-safety.js — the single source of truth that
// src/paths.js and src/directories.js both delegate to. Guards the exact fork we
// just collapsed: directories.js used to carry a bare fs.realpathSync that threw
// for not-yet-existing paths and did NOT collapse ancestor symlinks, so the same
// physical dir could be judged differently by the two modules.
//
// No real user state is touched: everything runs inside an fs.mkdtemp scratch
// dir under os.tmpdir(), removed on exit.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pathSafety = require('../src/path-safety');
const paths = require('../src/paths');
const directories = require('../src/directories');

const { realPathOf, isHomeOrAbove } = pathSafety;

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      → ${e.message}`); process.exitCode = 1; }
}

// Scratch dir under the OS tmpdir. os.tmpdir() itself is a symlink on macOS
// (/var -> /private/var), which is exactly the ancestor-symlink case we test.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-path-safety-'));

try {
  /* ── fork elimination: both modules share one implementation ─────────── */
  check('paths.js and directories.js export the SAME realPathOf instance', () => {
    assert.strictEqual(paths.realPathOf, directories.realPathOf);
    assert.strictEqual(paths.realPathOf, realPathOf);
  });
  check('paths.js and directories.js export the SAME isHomeOrAbove instance', () => {
    assert.strictEqual(paths.isHomeOrAbove, directories.isHomeOrAbove);
    assert.strictEqual(paths.isHomeOrAbove, isHomeOrAbove);
  });

  /* ── realPathOf: never throws, resolves relative, handles root ───────── */
  check('realPathOf resolves a relative path against cwd (absolute out)', () => {
    const out = realPathOf('some/relative/thing-that-does-not-exist');
    assert.ok(path.isAbsolute(out), `expected absolute, got ${out}`);
  });
  check('realPathOf never throws for a deeply-missing path', () => {
    const deep = path.join(scratch, 'a', 'b', 'c', 'd', 'e', 'nope');
    const out = realPathOf(deep);
    assert.strictEqual(typeof out, 'string');
    assert.ok(out.endsWith(path.join('a', 'b', 'c', 'd', 'e', 'nope')));
  });
  check('realPathOf of the filesystem root is the root', () => {
    const root = path.parse(scratch).root;
    assert.strictEqual(realPathOf(root), root);
  });

  /* ── the core fork bug: ancestor symlink + not-yet-existing child ────── */
  check('realPathOf collapses an ancestor symlink for a not-yet-existing child', () => {
    const realTarget = path.join(scratch, 'real-target');
    fs.mkdirSync(realTarget);
    const link = path.join(scratch, 'via-link');
    fs.symlinkSync(realTarget, link);                 // via-link -> real-target
    const probe = path.join(link, 'sub', 'not-created-yet');  // does NOT exist
    const expected = path.join(fs.realpathSync(realTarget), 'sub', 'not-created-yet');
    assert.strictEqual(realPathOf(probe), expected);
    // And a bare fs.realpathSync (the old directories.js behaviour) would throw
    // here — proving the robust path is doing real work, not a no-op.
    assert.throws(() => fs.realpathSync(probe));
  });
  check('realPathOf collapses macOS /var -> /private/var for os.tmpdir children', () => {
    // scratch lives under os.tmpdir(); its realpath must not start with the
    // symlinked form when the two differ (they do on macOS).
    const notYet = path.join(scratch, 'child-not-made');
    const resolvedTmp = fs.realpathSync(os.tmpdir());
    assert.ok(realPathOf(notYet).startsWith(resolvedTmp + path.sep),
      `expected ${realPathOf(notYet)} under ${resolvedTmp}`);
  });

  /* ── isHomeOrAbove: HOME, ancestors, root are dangerous; children safe ─ */
  check('isHomeOrAbove is true for $HOME itself', () => {
    assert.strictEqual(isHomeOrAbove(os.homedir()), true);
  });
  check('isHomeOrAbove is true for an ancestor of $HOME', () => {
    assert.strictEqual(isHomeOrAbove(path.dirname(os.homedir())), true);
  });
  check('isHomeOrAbove is true for the filesystem root', () => {
    assert.strictEqual(isHomeOrAbove(path.parse(os.homedir()).root), true);
  });
  check('isHomeOrAbove is false for a scratch dir under tmp', () => {
    assert.strictEqual(isHomeOrAbove(scratch), false);
  });
  check('isHomeOrAbove is false for a not-yet-existing child of scratch', () => {
    assert.strictEqual(isHomeOrAbove(path.join(scratch, 'future', 'leaf')), false);
  });
  check('isHomeOrAbove follows a symlink that points at $HOME', () => {
    const link = path.join(scratch, 'home-link');
    fs.symlinkSync(os.homedir(), link);
    assert.strictEqual(isHomeOrAbove(link), true);
  });

  /* ── assertTestDir: the destructive-test guard built on the above ────── */
  check('assertTestDir accepts a fresh mkdtemp under os.tmpdir()', () => {
    const ok = paths.assertTestDir(scratch);
    assert.strictEqual(ok, path.resolve(scratch));
  });
  check('assertTestDir refuses $HOME', () => {
    assert.throws(() => paths.assertTestDir(os.homedir()), /\$HOME or above/);
  });
  check('assertTestDir refuses the package root', () => {
    assert.throws(() => paths.assertTestDir(paths.PKG_ROOT), /package root|\$HOME or above/);
  });
  check('assertTestDir refuses a dir outside os.tmpdir()', () => {
    assert.throws(() => paths.assertTestDir(os.homedir() + '/multicc-not-a-tmp-dir'),
      /not under os\.tmpdir|\$HOME or above/);
  });
  check('assertTestDir refuses non-string input', () => {
    assert.throws(() => paths.assertTestDir(null), /non-empty string/);
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nPath-safety regression FAILED');
} else {
  console.log(`\nPath-safety regression passed (${passed} checks)`);
}

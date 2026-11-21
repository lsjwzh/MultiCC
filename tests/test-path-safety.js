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

const { pathSafety } = require('../src/native/runtime');
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
  check('default workspace stays below the writable data root', () => {
    const isolated = paths.createPaths({ dataDir: scratch });
    assert.strictEqual(isolated.defaultWorkspacePath, path.join(scratch, 'workspaces', 'default'));
    assert.ok(isolated.defaultWorkspacePath.startsWith(scratch + path.sep));
    assert.ok(!/(?:Desktop|Documents|Downloads)(?:[\\/]|$)/.test(isolated.defaultWorkspacePath));
  });

  const frozenFile = path.join(__dirname, 'helpers/legacy-path-safety.js');
  const frozenSource = fs.readFileSync(frozenFile, 'utf8');
  const oracle = require(frozenFile);
  const { getNative } = require('../src/native/runtime');
  const native = getNative();

  function oracleWithPorts(ports) {
    const module = { exports: {} };
    require('node:vm').runInNewContext(frozenSource, { module,
      require: name => ({ fs: ports.fs, path: ports.path, os: ports.os })[name] });
    return module.exports;
  }
  function scriptedPorts({ platform = path.posix, fail = null, error = new Error('path sentinel'), home = '/home/user' } = {}) {
    const trace = [];
    const invoke = (name, args, fn) => {
      trace.push([name, ...args]);
      if (name === fail) throw error;
      return fn();
    };
    const pathPort = {};
    for (const name of ['resolve', 'dirname', 'basename', 'parse']) {
      pathPort[name] = (...args) => invoke(name, args, () => platform[name](...args));
    }
    Object.defineProperty(pathPort, 'join', { get() {
      trace.push(['get-join']);
      return (...args) => invoke('join', args, () => platform.join(...args));
    } });
    Object.defineProperty(pathPort, 'sep', { get() { trace.push(['sep']); return platform.sep; } });
    const fsPort = {
      existsSync: value => invoke('exists', [value], () => platform.dirname(value) === value),
      realpathSync: value => invoke('realpath', [value], () => value),
    };
    const osPort = { homedir: () => invoke('homedir', [], () => home) };
    return { fs: fsPort, path: pathPort, os: osPort, trace };
  }
  function comparePorts(value, operation, options) {
    function run(useNative) {
      const ports = scriptedPorts(options);
      const expected = oracleWithPorts(ports);
      let result;
      let thrown;
      try {
        result = useNative
          ? (operation === 'realPathOf'
            ? native.pathSafetyRealPath(value, ports.fs, ports.path)
            : native.pathSafetyHomeOrAbove(value, ports.fs, ports.path, ports.os))
          : expected[operation](value);
      } catch (error) { thrown = error; }
      return { result, thrown, trace: ports.trace };
    }
    assert.deepStrictEqual(run(true), run(false));
  }

  check('native path oracle is byte-frozen and the production module is retired', () => {
    const hash = require('node:crypto').createHash('sha256').update(frozenSource).digest('hex');
    assert.strictEqual(hash, 'cfa3149f36076b5fd09bc7bee35336ea90e79e0086a67980e52705c16f4e7ea7');
    assert.strictEqual(fs.existsSync(path.join(__dirname, '../src/path-safety.js')), false);
  });
  check('native path and HOME guards match the frozen real-filesystem matrix', () => {
    for (const value of [scratch, '', '.', '..', '/', os.homedir(), path.dirname(os.homedir()),
      path.join(os.homedir(), 'future-child'), path.join(scratch, 'unmade/deep/child'),
      path.join(scratch, '../' + path.basename(scratch), 'unicode-目录')]) {
      assert.strictEqual(realPathOf(value), oracle.realPathOf(value));
      assert.strictEqual(isHomeOrAbove(value), oracle.isHomeOrAbove(value));
    }
  });
  check('native paths preserve invalid-input exception types and messages', () => {
    for (const value of [null, undefined, false, 42, {}, [], Symbol('path'), Buffer.from('path')]) {
      for (const operation of ['realPathOf', 'isHomeOrAbove']) {
        const outcome = fn => { try { return fn(); } catch (e) { return [e.name, e.message]; } };
        assert.deepStrictEqual(outcome(() => pathSafety[operation](value)), outcome(() => oracle[operation](value)));
      }
    }
  });
  check('native paths preserve dangling symlinks, link chains and file ancestors', () => {
    const base = path.join(scratch, 'native-differential');
    fs.mkdirSync(base);
    fs.mkdirSync(path.join(base, 'actual'));
    fs.writeFileSync(path.join(base, 'plain-file'), 'test');
    fs.symlinkSync(path.join(base, 'actual'), path.join(base, 'first'));
    fs.symlinkSync(path.join(base, 'first'), path.join(base, 'second'));
    fs.symlinkSync(path.join(base, 'missing-target'), path.join(base, 'dangling'));
    for (const value of ['second/child', 'dangling/child', 'plain-file/child', 'actual/../second/future']) {
      const input = path.join(base, value);
      assert.strictEqual(realPathOf(input), oracle.realPathOf(input));
      assert.strictEqual(isHomeOrAbove(input), oracle.isHomeOrAbove(input));
    }
  });
  check('native ancestry preserves live platform-call and join-getter order', () => {
    for (const value of ['/', '/home', '/home/user', '/home/user/child', '/other/deep/leaf']) {
      comparePorts(value, 'realPathOf');
      comparePorts(value, 'isHomeOrAbove');
    }
  });
  check('native path errors retain identity outside the exact best-effort boundary', () => {
    const error = new Error('same opaque failure');
    for (const fail of ['resolve', 'exists', 'dirname', 'basename', 'realpath', 'join', 'homedir', 'parse']) {
      comparePorts('/other/deep/leaf', 'realPathOf', { fail, error });
      comparePorts('/other/deep/leaf', 'isHomeOrAbove', { fail, error });
    }
  });
  check('native guard matches Windows drive, UNC and separator semantics through the platform port', () => {
    for (const value of ['C:\\', 'C:\\Users', 'C:\\Users\\dev', 'C:\\Users\\dev\\child',
      'C:\\Users\\developer', 'D:\\other\\leaf', '\\\\server\\share\\', '\\\\server\\share\\folder']) {
      comparePorts(value, 'realPathOf', { platform: path.win32, home: 'C:\\Users\\dev' });
      comparePorts(value, 'isHomeOrAbove', { platform: path.win32, home: 'C:\\Users\\dev' });
    }
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('\nPath-safety regression FAILED');
} else {
  console.log(`\nPath-safety regression passed (${passed} checks)`);
}

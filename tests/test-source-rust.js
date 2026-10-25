'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourcePaths, sourceFingerprint, probeAddon, writeProvenance, builtFromSource } = require('../scripts/rust-source-cache');
const { ensureSourceRust } = require('../scripts/ensure-source-rust');
const ROOT = path.resolve(__dirname, '..');
const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR
  || path.join(ROOT, 'native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return file;
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-source rust-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  for (const name of ['ensure-source-rust.js', 'rust-source-cache.js', 'build-rust-kernels.js', 'native-arch.js']) {
    write(root, `scripts/${name}`, fs.readFileSync(path.join(ROOT, 'scripts', name)));
  }
  write(root, 'native/Cargo.toml', '[workspace]\nmembers = ["core"]\n');
  write(root, 'native/Cargo.lock', 'version = 4\n');
  write(root, 'native/core/Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n');
  write(root, 'native/core/src/lib.rs', '// isolated compiler fixture\n');
  // Exercise the real build script, cache paths and addon probes. Only the
  // compiler is replaced: it copies a real addon without downloading/building.
  const cargo = write(root, 'bin/cargo', `#!/usr/bin/env node
    const fs=require('fs'),path=require('path');
    fs.appendFileSync(process.env.TEST_RUST_BUILDS,'build\\n');
    if(process.env.TEST_RUST_BUILD_FAIL==='1') process.exit(2);
    const target=process.argv[process.argv.indexOf('--target')+1];
    const library=process.platform==='win32'?'multicc_addon.dll':process.platform==='darwin'?'libmulticc_addon.dylib':'libmulticc_addon.so';
    const dest=path.join(process.env.CARGO_TARGET_DIR,target,'release',library);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(process.env.TEST_RUST_ADDON,dest);
    if(process.env.TEST_RUST_EDIT_SOURCE==='1')fs.appendFileSync(path.join(process.cwd(),'native/core/src/lib.rs'),'// edit during build\\n');
  `);
  fs.chmodSync(cargo, 0o755);
  const env = { ...process.env, MULTICC_RUST_ADDON: '', MULTICC_RUST_PREBUILT_DIR: '', MULTICC_SQLITE_BACKEND: 'rust',
    CARGO_TARGET_DIR: path.join(root, 'cargo-target'), MULTICC_NODE: process.execPath, PORT: '0',
    TEST_RUST_ADDON: path.resolve(addon), TEST_RUST_BUILDS: path.join(root, 'builds'),
    PATH: [path.join(root, 'bin'), path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/ensure-source-rust.js')],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
  const count = () => fs.existsSync(env.TEST_RUST_BUILDS) ? fs.readFileSync(env.TEST_RUST_BUILDS, 'utf8').trim().split('\n').length : 0;
  return { root, env, run, count };
}

test('source cache lives in the primary worktree and fingerprints source/config changes', t => {
  const { root, env } = fixture(t);
  const initial = sourcePaths(root, env);
  assert.ok(initial.prebuiltDir.startsWith(path.join(root, 'data/rust-source') + path.sep));
  write(root, 'native/target/ignored.rs', '// compiler output');
  assert.equal(sourceFingerprint(root, env), initial.fingerprint);
  assert.notEqual(sourceFingerprint(root, { ...env, RUSTFLAGS: '-C opt-level=2' }), initial.fingerprint);
  const worktree = path.join(root, 'sibling');
  assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture']).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree]).status, 0);
  const { cacheRoot } = require('../scripts/rust-source-cache');
  assert.equal(cacheRoot(worktree), path.join(root, 'data/rust-source'));
});

test('explicit emergency Node mode for both SQLite and CPR never builds Rust', () => {
  assert.equal(ensureSourceRust({ env: { MULTICC_SQLITE_BACKEND: 'node', MULTICC_CPR_BACKEND: 'node' },
    paths() { throw Error('unexpected cache access'); } }), null);
});

test('Rust CPR still requires the source addon when SQLite uses emergency Node mode', () => {
  for (const backend of [undefined, 'rust']) {
    assert.throws(() => ensureSourceRust({ env: { MULTICC_SQLITE_BACKEND: 'node', MULTICC_CPR_BACKEND: backend },
      paths() { throw Error('CPR requires addon'); } }), /CPR requires addon/);
  }
});

const nativeTest = (name, fn) => test(name, { skip: process.platform === 'win32' && 'source manager uses a POSIX shell' }, fn);

nativeTest('first source boot builds once; a new process reuses it and source changes select a new addon', t => {
  const { root, run, count } = fixture(t);
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const file = first.stdout.trim(); assert.equal(probeAddon(file), true); assert.equal(count(), 1);
  assert.match(first.stderr, /自动编译/);
  const again = run(); assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), file); assert.equal(count(), 1);
  write(root, 'native/core/src/lib.rs', '// changed source\n');
  // This also covers a manager checking again after git pull with its previous
  // automatically exported addon still in the environment.
  const changed = run({ MULTICC_RUST_ADDON: file }); assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.stdout.trim(), file); assert.equal(count(), 2);
  assert.equal(probeAddon(file), true, 'old running processes retain their immutable artifact');
});

nativeTest('explicit addon/directory overrides built from this source are reused without a build', t => {
  const { root, env, run, count } = fixture(t);
  const external = path.join(root, 'external');
  const proven = write(external, `${process.platform}-${process.arch}/multicc_core.node`, fs.readFileSync(addon));
  writeProvenance(proven, sourcePaths(root, env).fingerprint);
  const directory = run({ MULTICC_RUST_PREBUILT_DIR: external });
  assert.equal(directory.status, 0, directory.stderr); assert.equal(directory.stdout.trim(), proven);
  const direct = run({ MULTICC_RUST_ADDON: proven });
  assert.equal(direct.status, 0, direct.stderr); assert.equal(direct.stdout.trim(), proven);
  assert.equal(count(), 0);
});
// A restart inherits the old server's MULTICC_RUST_ADDON, and a shared output
// directory can be rebuilt by another checkout: neither may pin older native APIs.
nativeTest('overrides not provably built from this source rebuild; invalid ones too', t => {
  const { root, env, run, count } = fixture(t);
  const unproven = run({ MULTICC_RUST_ADDON: path.resolve(addon) });
  assert.equal(unproven.status, 0, unproven.stderr); assert.match(unproven.stderr, /不是由当前源码构建/);
  const file = unproven.stdout.trim();
  assert.notEqual(file, path.resolve(addon)); assert.equal(probeAddon(file), true); assert.equal(count(), 1);
  assert.equal(builtFromSource(file, sourcePaths(root, env).fingerprint), true, 'own builds carry a provenance record');
  const external = path.join(root, 'external');
  const other = write(external, `${process.platform}-${process.arch}/multicc_core.node`, fs.readFileSync(addon));
  writeProvenance(other, 'another-source');
  const stale = run({ MULTICC_RUST_PREBUILT_DIR: external });
  assert.equal(stale.status, 0, stale.stderr); assert.equal(stale.stdout.trim(), file);
  writeProvenance(other, sourcePaths(root, env).fingerprint);
  fs.appendFileSync(other, Buffer.from([0]));
  const swapped = run({ MULTICC_RUST_ADDON: other });
  assert.equal(swapped.status, 0, swapped.stderr); assert.equal(swapped.stdout.trim(), file, 'record must describe these bytes');
  assert.equal(count(), 1);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const bad = write(root, 'bad.node', 'not a native module');
  const repaired = run({ MULTICC_RUST_ADDON: bad });
  assert.equal(repaired.status, 0, repaired.stderr); assert.equal(probeAddon(repaired.stdout.trim()), true); assert.equal(count(), 2);
});
nativeTest('a failed build falls back to a loadable unproven override but never to an invalid one', t => {
  const { root, run, count } = fixture(t);
  const fallback = run({ MULTICC_RUST_ADDON: path.resolve(addon), TEST_RUST_BUILD_FAIL: '1' });
  assert.equal(fallback.status, 0, fallback.stderr); assert.equal(fallback.stdout.trim(), path.resolve(addon));
  assert.match(fallback.stderr, /暂时沿用指定的模块/); assert.equal(count(), 1);
  const bad = write(root, 'bad.node', 'not a native module');
  const failed = run({ MULTICC_RUST_ADDON: bad, TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failed.status, 0); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /自动编译失败/);
});

nativeTest('compiler failure emits no addon path and does not publish a partial cache', t => {
  const { root, env, run, count } = fixture(t);
  const failed = run({ TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failed.status, 0); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /自动编译失败.*服务尚未启动/);
  assert.equal(count(), 1);
  assert.equal(fs.existsSync(path.join(sourcePaths(root, env).prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`)), false);
  const recovered = run(); assert.equal(recovered.status, 0, recovered.stderr); assert.equal(count(), 2);
});

nativeTest('cached invalid addon is rebuilt; a failed rebuild never replaces an existing output', t => {
  const { root, env, run, count } = fixture(t);
  const file = write(sourcePaths(root, env).prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`, 'broken');
  const repaired = run(); assert.equal(repaired.status, 0, repaired.stderr); assert.equal(count(), 1); assert.equal(probeAddon(file), true);
  const original = fs.readFileSync(file);
  const invalid = write(root, 'invalid.node', 'broken compiler output');
  const failed = spawnSync(process.execPath, [path.join(root, 'scripts/build-rust-kernels.js'),
    '--out', sourcePaths(root, env).prebuiltDir, '--target-dir', env.CARGO_TARGET_DIR], {
    cwd: root, env: { ...env, TEST_RUST_ADDON: invalid }, encoding: 'utf8',
  });
  assert.notEqual(failed.status, 0); assert.deepEqual(fs.readFileSync(file), original);
});

nativeTest('edits made during compilation discard the output instead of caching it under an old fingerprint', t => {
  const { root, env, run } = fixture(t);
  const before = sourcePaths(root, env);
  const result = run({ TEST_RUST_EDIT_SOURCE: '1' });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /源码发生变化/);
  assert.equal(fs.existsSync(path.join(before.prebuiltDir, `${process.platform}-${process.arch}/multicc_core.node`)), false);
});

nativeTest('real source manager exports the selected addon before preflight and never starts after build failure', t => {
  const { root, env, count } = fixture(t);
  write(root, 'multicc', fs.readFileSync(path.join(ROOT, 'multicc')));
  write(root, 'src/server-processes.js', '// fixture: no server is running\n');
  write(root, 'scripts/check-runtime-deps.js', `require('fs').writeFileSync('preflight-addon',process.env.MULTICC_RUST_ADDON||'');process.exit(57);`);
  const run = extra => spawnSync('/bin/bash', [path.join(root, 'multicc'), 'start'], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000,
  });
  const first = run({}); assert.notEqual(first.status, 0); assert.equal(count(), 1);
  assert.equal(probeAddon(fs.readFileSync(path.join(root, 'preflight-addon'), 'utf8')), true);
  fs.rmSync(path.join(root, 'preflight-addon'));
  const again = run({}); assert.notEqual(again.status, 0); assert.equal(count(), 1);
  fs.rmSync(path.join(root, 'preflight-addon'));
  write(root, 'native/core/src/lib.rs', '// new source\n');
  const failure = run({ TEST_RUST_BUILD_FAIL: '1' });
  assert.notEqual(failure.status, 0); assert.match(failure.stderr, /服务尚未启动/);
  assert.equal(fs.existsSync(path.join(root, 'preflight-addon')), false);
  assert.equal(fs.existsSync(path.join(root, '.multicc.pid')), false);
});

nativeTest('source start boots an isolated server with the built addon and a repeated start never rebuilds', async t => {
  const { root, env, count } = fixture(t);
  let pid;
  t.after(async () => {
    if (!pid) return;
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (_) { return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  });
  write(root, 'multicc', fs.readFileSync(path.join(ROOT, 'multicc')));
  write(root, 'src/server-processes.js', `if(process.argv[2]==='list'){
    try{const id=Number(require('fs').readFileSync('.multicc.pid','utf8'));process.kill(id,0);console.log(id)}catch{}}`);
  write(root, 'scripts/check-runtime-deps.js', 'process.exit(0);');
  write(root, 'server.js', `const db=new (require(process.env.MULTICC_RUST_ADDON).RustDatabase)(':memory:',false,false,5000);
    db.exec('CREATE TABLE booted(x)');db.close();require('fs').writeFileSync('booted-addon',process.env.MULTICC_RUST_ADDON);
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  const run = () => spawnSync('/bin/bash', [path.join(root, 'multicc'), 'start'], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
  const first = run();
  const pidFile = path.join(root, '.multicc.pid');
  if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.ok(pid > 1); assert.equal(count(), 1);
  assert.equal(probeAddon(fs.readFileSync(path.join(root, 'booted-addon'), 'utf8')), true);
  const repeated = run();
  assert.notEqual(repeated.status, 0); assert.match(repeated.stdout, /already running/); assert.equal(count(), 1);
});

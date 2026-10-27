'use strict';
// MultiCC's portable git for Macs without the Command Line Tools: install-git.sh
// unpacks GitHub Desktop's git into ~/.multicc/git behind a wrapper, and the
// server puts <dir>/bin on PATH (src/portable-git.js). Locked here, offline:
//   - PATH placement: before the /usr/bin shim, after Homebrew; idempotent;
//     nothing added while the directory is absent;
//   - the script, run against a fake release archive: the wrapper points git
//     at its own helpers (the real release otherwise looks in //libexec and
//     every https remote fails), a second run is a no-op, a checksum mismatch
//     fails, and a failed reinstall leaves the previous git in place.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const portableGit = require('../src/portable-git');

const SCRIPT = path.join(__dirname, '..', 'install-git.sh');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-portable-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeInstall(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'git'), '#!/bin/sh\n', { mode: 0o755 });
}

test('PATH gains the portable git right before the /usr/bin shim, once', (t) => {
  const dir = path.join(tmp(t), 'git');
  const env = { MULTICC_PORTABLE_GIT_DIR: dir, PATH: '/node/bin:/opt/homebrew/bin:/usr/bin:/bin' };
  assert.equal(portableGit.addToPath(env), false, 'nothing to add before it is installed');
  assert.equal(env.PATH, '/node/bin:/opt/homebrew/bin:/usr/bin:/bin');

  fakeInstall(dir);
  assert.equal(portableGit.isInstalled(env), true);
  assert.equal(portableGit.addToPath(env), true);
  assert.equal(env.PATH, `/node/bin:/opt/homebrew/bin:${dir}/bin:/usr/bin:/bin`,
    'a Homebrew git still wins; only the shim is shadowed');
  assert.equal(portableGit.addToPath(env), false);
  assert.equal(env.PATH.split(':').filter(d => d === `${dir}/bin`).length, 1);

  const bare = { MULTICC_PORTABLE_GIT_DIR: dir, PATH: '/custom/bin' };
  portableGit.addToPath(bare);
  assert.equal(bare.PATH, `${dir}/bin:/custom/bin`, 'no /usr/bin entry: goes first');
});

test('the install script ships at the server root, executable', () => {
  assert.equal(portableGit.installScriptPath(), SCRIPT);
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'install-git.sh must keep its exec bit');
});

// A stand-in release: bin/git reports the helper directory the wrapper chose,
// which is exactly what the real release gets wrong without the wrapper.
function fakeArchive(root, version) {
  const src = path.join(root, `src-${version}`);
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'libexec', 'git-core'), { recursive: true });
  fs.mkdirSync(path.join(src, 'share', 'git-core', 'templates'), { recursive: true });
  fs.writeFileSync(path.join(src, 'bin', 'git'),
    `#!/bin/sh\necho "git version ${version} exec=$GIT_EXEC_PATH templates=$GIT_TEMPLATE_DIR"\n`, { mode: 0o755 });
  const archive = path.join(root, `git-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', src, '.']);
  return archive;
}

const runScript = (args, env = {}) => spawnSync('/bin/sh', [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, MULTICC_GIT_SKIP_VERIFY: '1', ...env },
});

test('install-git.sh installs a working wrapper, idempotently and atomically', { skip: process.platform !== 'darwin' && 'macOS-only installer' }, (t) => {
  const root = tmp(t);
  const dir = path.join(root, 'home', '.multicc', 'git');
  const first = runScript(['--dir', dir, '--archive', fakeArchive(root, '2.0.0')]);
  assert.equal(first.status, 0, first.stderr);

  const wrapper = path.join(dir, 'bin', 'git');
  const out = execFileSync(wrapper, ['--version'], { encoding: 'utf8' });
  const dist = fs.realpathSync(path.join(dir, 'dist'));
  assert.match(out, /git version 2\.0\.0/);
  assert.ok(out.includes(`exec=${dist}/libexec/git-core`), out);
  assert.ok(out.includes(`templates=${dist}/share/git-core/templates`), out);

  // Reached through a symlink (e.g. ~/bin/git -> wrapper) it still finds dist/.
  const link = path.join(root, 'linked-git');
  fs.symlinkSync(wrapper, link);
  assert.match(execFileSync(link, [], { encoding: 'utf8' }), /exec=.*\/dist\/libexec\/git-core/);

  const second = runScript(['--dir', dir, '--archive', fakeArchive(root, '3.0.0')]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assert.match(execFileSync(wrapper, [], { encoding: 'utf8' }), /2\.0\.0/, 'second run is a no-op');

  // The pinned checksum is enforced, and a failed reinstall keeps the old git.
  const bad = runScript(['--dir', dir, '--force', '--archive', fakeArchive(root, '4.0.0')], { MULTICC_GIT_SKIP_VERIFY: '' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /checksum mismatch/);
  assert.match(execFileSync(wrapper, [], { encoding: 'utf8' }), /2\.0\.0/, 'previous git survives a failed install');
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter(n => n.includes('.installing.')), [], 'no staging debris');

  const forced = runScript(['--dir', dir, '--force', '--archive', fakeArchive(root, '5.0.0')]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(execFileSync(wrapper, [], { encoding: 'utf8' }), /5\.0\.0/);
});

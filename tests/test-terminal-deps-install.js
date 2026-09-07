'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/install-terminal-deps.sh');

function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-terminal-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + body, { mode: 0o755 });
  write('uname', `echo ${platform}`);
  write('dirname', 'exec /usr/bin/dirname "$@"');
  write('sudo', 'exec "$@"');
  fs.writeFileSync(path.join(root, 'tmux-fixture'), '#!/bin/bash\necho "tmux fixture"\n', { mode: 0o755 });
  const install = '/bin/cp "$FIXTURE_ROOT/tmux-fixture" "$FIXTURE_ROOT/bin/tmux"';
  const run = () => spawnSync('/bin/bash', [script], {
    env: { PATH: bin, FIXTURE_ROOT: root }, encoding: 'utf8', timeout: 5000,
  });
  return { root, write, install, run };
}

test('existing tmux needs no package manager', t => {
  const f = fixture(t, 'Darwin');
  f.write('tmux', 'echo "tmux existing"');
  f.write('brew', 'exit 99');
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tmux existing/);
});

test('macOS installs tmux once through brew and verifies the executable', t => {
  const f = fixture(t, 'Darwin');
  f.write('brew', '[[ "$1" == install && "$2" == tmux ]] || exit 9\n' + f.install);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tmux fixture/);
});

test('Linux installs tmux through apt and stops if package setup fails', t => {
  const f = fixture(t, 'Linux');
  f.write('apt-get', '[[ "$1" == update ]] && exit 0\n[[ "$*" == "install -y tmux" ]] || exit 9\n' + f.install);
  assert.equal(f.run().status, 0);
  fs.unlinkSync(path.join(f.root, 'bin', 'tmux'));
  f.write('apt-get', 'exit 17');
  assert.equal(f.run().status, 17);
  assert.equal(fs.existsSync(path.join(f.root, 'bin', 'tmux')), false);
});

test('successful package-manager exit without tmux does not report success', t => {
  const f = fixture(t, 'Darwin');
  f.write('brew', 'exit 0');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not produce an executable/);
});

'use strict';
// Regression for the one-click "install macOS Command Line Tools" endpoint.
// The point of the route is that a user who cannot use git never has to open a
// terminal, so three things are worth locking: it probes with `xcode-select -p`
// (which does NOT pop a dialog) and never runs the /usr/bin/git shim (which
// does); it offers the tools only when they are genuinely the answer, i.e. the
// host has no other working git; and every already-handled state answers
// success instead of a scary error.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createDeveloperToolsRoutes: createRoutes } = require('../src/routes/developer-tools');

// The portable git lives in ~/.multicc/git on a real machine; every test gets an
// in-memory stand-in so the developer's own install never leaks into a result.
function fakePortableGit(installed = false) {
  const state = { installed, pathAdds: 0 };
  return Object.assign(state, {
    isInstalled: () => state.installed,
    addToPath: () => { state.pathAdds += 1; return true; },
    installScriptPath: () => '/pkg/install-git.sh',
  });
}
const createDeveloperToolsRoutes = (options) => createRoutes({ portableGit: fakePortableGit(), childEnv: async () => ({}), ...options });

const silent = { log() {}, warn() {}, error() {} };
const fail = (code = 1) => ({ error: Object.assign(new Error('x'), { code }) });

// Minimal execFile stand-in: answers each (file, argv) from `script`, recording
// calls. The recorded shape is [file, ...args] so a test can assert on exactly
// which binary was spawned, not just on the arguments.
function fakeRun(script, calls) {
  return (file, args, options, cb) => {
    calls.push([file, ...args]);
    const reply = script(file, args) || {};
    cb(reply.error || null, reply.stdout || '', reply.stderr || '');
  };
}

// A host where the tools are absent and `command -v git` resolves to `gitPath`
// ('' meaning no git at all). Every resolved git except the shim runs fine.
const hostWithoutTools = (gitPath) => (file, args) => {
  if (file === 'xcode-select' && args[0] === '-p') return fail(2);
  if (file === '/bin/sh') return gitPath ? { stdout: `${gitPath}\n` } : fail(1);
  if (file === gitPath) return { stdout: 'git version 2.43.0' };
  return {};
};

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('probe never runs a command that pops the install dialog', async () => {
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent,
    run: fakeRun((file, args) => (args[0] === '-p' ? { stdout: '/Library/Developer/CommandLineTools' } : {}), calls),
  });
  const res = fakeRes();
  await routes.statusHandler({}, res);
  assert.deepEqual(res.body, { ok: true, platform: 'darwin', applicable: false, gitWorks: true, installed: true, portableGit: false });
  assert.ok(calls.every(c => c[0] === 'xcode-select' && c[1] === '-p'), 'only the dialog-free probe is used');
  assert.ok(!calls.some(c => c[0] === '/usr/bin/git'), 'running the shim would raise the dialog');
});

test('a git that is not the shim makes the tools irrelevant', async () => {
  // The regression this guards: equating "no Command Line Tools" with "no git"
  // nags every Homebrew / MacPorts / git-scm.com user to install something they
  // already have a working substitute for.
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent, run: fakeRun(hostWithoutTools('/opt/homebrew/bin/git'), calls),
  });
  const res = fakeRes();
  await routes.statusHandler({}, res);
  assert.equal(res.body.gitWorks, true);
  assert.equal(res.body.applicable, false, 'no button on a host whose git already works');
  assert.equal(res.body.installed, false, 'the tools really are absent — that is just not a problem here');
  assert.ok(calls.some(c => c[0] === '/opt/homebrew/bin/git' && c[1] === '--version'), 'the real git is verified, not assumed');
  assert.ok(!calls.some(c => c[0] === '/usr/bin/git'), 'the shim is never executed');
});

test('the shim alone is not a working git', async () => {
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent, run: fakeRun(hostWithoutTools('/usr/bin/git'), calls),
  });
  const res = fakeRes();
  await routes.statusHandler({}, res);
  assert.equal(res.body.gitWorks, false);
  assert.equal(res.body.applicable, true);
  assert.ok(!calls.some(c => c[0] === '/usr/bin/git'), 'it is ruled out by path, never by running it');
});

test('missing tools are reported, and installing requests the system dialog', async () => {
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent,
    run: fakeRun((file, args) => {
      if (file === 'xcode-select') return args[0] === '-p' ? fail(2) : { stdout: 'install requested' };
      if (file === '/bin/sh') return fail(1);
      return {};
    }, calls),
  });
  const status = fakeRes();
  await routes.statusHandler({}, status);
  assert.equal(status.body.installed, false);
  assert.equal(status.body.applicable, true);

  const res = fakeRes();
  await routes.installHandler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'requested');
  assert.ok(calls.some(c => c[1] === '--install'), 'the repair command is actually run');
});

test('already-installed short-circuits before spawning the installer', async () => {
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent,
    run: fakeRun(() => ({ stdout: '/Library/Developer/CommandLineTools' }), calls),
  });
  const res = fakeRes();
  await routes.installHandler({}, res);
  assert.deepEqual(res.body, { ok: true, status: 'already-installed' });
  assert.deepEqual(calls, [['xcode-select', '-p']], 'no --install when the tools are already there');
});

test('a queued or redundant request is success, not an error the user must decode', async () => {
  for (const [text, expected] of [
    ['xcode-select: error: command line tools are already installed, use "Software Update" to install updates', 'already-installed'],
    ['xcode-select: note: install requested for command line developer tools', 'already-requested'],
  ]) {
    const routes = createDeveloperToolsRoutes({
      platform: 'darwin', log: silent,
      run: fakeRun((file, args) => (args[0] === '-p'
        ? fail(2)
        : { error: Object.assign(new Error('x'), { code: 1 }), stderr: text }), []),
    });
    const res = fakeRes();
    await routes.installHandler({}, res);
    assert.equal(res.statusCode, 200, text);
    assert.equal(res.body.status, expected);
  }
});

test('a real failure names the manual command instead of claiming success', async () => {
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent,
    run: fakeRun((file, args) => (args[0] === '-p'
      ? fail(2)
      : { error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Can’t install the software because it is not currently available' }), []),
  });
  const res = fakeRes();
  await routes.installHandler({}, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.command, 'xcode-select --install');
});

test('non-macOS hosts are told plainly that this is not their fix', async () => {
  const calls = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'linux', log: silent, run: fakeRun(hostWithoutTools('/usr/bin/git'), calls),
  });
  const status = fakeRes();
  await routes.statusHandler({}, status);
  // /usr/bin/git is an ordinary binary off macOS — no shim, nothing to install.
  assert.deepEqual(status.body, { ok: true, platform: 'linux', applicable: false, gitWorks: true, installed: true, portableGit: false });
  assert.ok(!calls.some(c => c[0] === 'xcode-select'), 'xcode-select is never spawned off macOS');
  const res = fakeRes();
  await routes.installHandler({}, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NOT_APPLICABLE');
});

// ── Portable git (install-git.sh as a background job) ─────────────────────────

// A child process stand-in the test finishes by hand, so "running" is observable.
function fakeSpawn(spawned) {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    spawned.push({ file, args, options, child });
    return child;
  };
}

test('portable git installs as a job, then joins PATH without a restart', async () => {
  const spawned = [];
  const portableGit = fakePortableGit(false);
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent, portableGit,
    childEnv: async () => ({ HTTPS_PROXY: 'http://proxy:1' }),
    run: fakeRun(hostWithoutTools('/usr/bin/git'), []),
    spawnProcess: fakeSpawn(spawned),
  });
  const start = fakeRes();
  await routes.installGitHandler({}, start);
  assert.equal(start.statusCode, 202);
  assert.equal(start.body.state, 'running');
  assert.deepEqual([spawned[0].file, ...spawned[0].args], ['/bin/sh', '/pkg/install-git.sh']);
  assert.equal(spawned[0].options.env.HTTPS_PROXY, 'http://proxy:1', 'the download follows the user proxy');

  // A second click while it runs must not start a racing second install.
  const again = fakeRes();
  await routes.installGitHandler({}, again);
  assert.equal(again.body.status, 'running');
  assert.equal(spawned.length, 1);

  spawned[0].child.stderr.emit('data', '##########  45.0%');
  const mid = fakeRes();
  routes.installGitStatusHandler({}, mid);
  assert.equal(mid.body.state, 'running');
  assert.match(mid.body.logTail, /45\.0%/, 'progress is visible while downloading');
  assert.equal(portableGit.pathAdds, 0);

  spawned[0].child.emit('close', 0);
  const done = fakeRes();
  routes.installGitStatusHandler({}, done);
  assert.equal(done.body.state, 'done');
  assert.equal(portableGit.pathAdds, 1, 'the running server uses the new git right away');
});

test('a failed portable install reports its last line and can be retried', async () => {
  const spawned = [];
  const portableGit = fakePortableGit(false);
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent, portableGit,
    run: fakeRun(hostWithoutTools('/usr/bin/git'), []), spawnProcess: fakeSpawn(spawned),
  });
  await routes.installGitHandler({}, fakeRes());
  spawned[0].child.stderr.emit('data', '[install-git] error: checksum mismatch\n');
  spawned[0].child.emit('close', 1);
  const res = fakeRes();
  routes.installGitStatusHandler({}, res);
  assert.equal(res.body.state, 'failed');
  assert.match(res.body.error, /checksum mismatch/);
  assert.equal(portableGit.pathAdds, 0, 'a broken install never lands on PATH');
  await routes.installGitHandler({}, fakeRes());
  assert.equal(spawned.length, 2, 'a failure does not block the next attempt');
});

test('portable git already in place is not downloaded again', async () => {
  const spawned = [];
  const portableGit = fakePortableGit(true);
  const routes = createDeveloperToolsRoutes({
    platform: 'darwin', log: silent, portableGit,
    run: fakeRun(hostWithoutTools('/Users/me/.multicc/git/bin/git'), []), spawnProcess: fakeSpawn(spawned),
  });
  const res = fakeRes();
  await routes.installGitHandler({}, res);
  assert.equal(res.body.status, 'already-installed');
  assert.equal(spawned.length, 0);
});

test('the portable git is a macOS remedy only', async () => {
  const spawned = [];
  const routes = createDeveloperToolsRoutes({
    platform: 'linux', log: silent, run: fakeRun(hostWithoutTools(''), []), spawnProcess: fakeSpawn(spawned),
  });
  const res = fakeRes();
  await routes.installGitHandler({}, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NOT_APPLICABLE');
  assert.equal(spawned.length, 0);
});

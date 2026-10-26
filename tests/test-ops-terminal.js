'use strict';
// Ops terminal regression. The panel exists for exactly two failures the
// directory dialog can name — git missing on a bare VM, commit identity unset
// on a fresh service account — so the tests lock: the env probe classifies
// those states (and never runs the macOS shim that pops a system dialog), the
// suggested install command matches the host's package manager, the run
// endpoint refuses junk and overlaps, and the audit log records metadata
// only, never the command text a user may have pasted a credential into.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createOpsTerminalRoutes,
  keepTail,
  MAX_COMMAND_LENGTH,
} = require('../src/routes/ops-terminal');
const { dirReasonFix } = require('../src/directories');

const ok = (out = '') => ({ code: 0, stdout: out, stderr: '', timedOut: false });
const fail = (code = 1, err = '') => ({ code, stdout: '', stderr: err, timedOut: false });

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

// script(command) → result; every command is recorded for call-order asserts.
function fakeRun(script, calls = []) {
  return async (command) => {
    calls.push(command);
    return script(command);
  };
}

// A healthy Linux host: git + identity present, dnf as the package manager.
const healthyLinux = (command) => {
  if (command === 'command -v git') return ok('/usr/bin/git\n');
  if (command === 'git --version') return ok('git version 2.43.0\n');
  if (command === 'git config --get user.name') return ok('multicc\n');
  if (command === 'git config --get user.email') return ok('multicc@local\n');
  if (command.startsWith('for c in')) return ok('dnf\n');
  return fail(127);
};

test('env probe reports a healthy host and dnf install advice', async () => {
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: { warn() {} }, run: fakeRun(healthyLinux) });
  const res = fakeRes();
  await routes.envHandler({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.git, { available: true, version: '2.43.0' });
  assert.deepEqual(res.body.identity, { name: 'multicc', email: 'multicc@local' });
  assert.equal(res.body.packageManager, 'dnf');
  assert.equal(res.body.suggestions.gitInstall, 'dnf install -y git');
  assert.equal(res.body.suggestions.identityName, 'git config --global user.name "multicc"');
});

test('env probe on a bare VM: no git, apt advised even though git is absent', async () => {
  const script = (command) => {
    if (command === 'command -v git') return fail(1);
    if (command.startsWith('for c in')) return ok('apt-get\n');
    return fail(127);
  };
  const calls = [];
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: { warn() {} }, run: fakeRun(script, calls) });
  const res = fakeRes();
  await routes.envHandler({}, res);
  assert.deepEqual(res.body.git, { available: false, version: null });
  // No git binary → identity probing is skipped entirely, not faked.
  assert.deepEqual(res.body.identity, { name: null, email: null });
  assert.equal(res.body.suggestions.gitInstall, 'apt-get update && apt-get install -y git');
  assert.ok(!calls.some(c => c.startsWith('git config')), 'identity is not probed without git');
});

test('env probe: git present but identity unset', async () => {
  const script = (command) => {
    if (command === 'command -v git') return ok('/usr/bin/git\n');
    if (command === 'git --version') return ok('git version 2.39.5\n');
    if (command === 'git config --get user.name') return fail(1);
    if (command === 'git config --get user.email') return ok('ops@example.com\n');
    if (command.startsWith('for c in')) return fail(1); // no package manager
    return fail(127);
  };
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: { warn() {} }, run: fakeRun(script) });
  const res = fakeRes();
  await routes.envHandler({}, res);
  assert.deepEqual(res.body.identity, { name: null, email: 'ops@example.com' });
  assert.equal(res.body.packageManager, null);
  assert.equal(res.body.suggestions.gitInstall, null, 'no advice without a package manager');
});

test('the macOS shim is probed without ever being run', async () => {
  // /usr/bin/git + missing Command Line Tools: executing it would raise the
  // system install dialog (same rule as developer-tools routes).
  const script = (command) => {
    if (command === 'command -v git') return ok('/usr/bin/git\n');
    if (command === 'xcode-select -p') return fail(2);
    return fail(127);
  };
  const calls = [];
  const routes = createOpsTerminalRoutes({ platform: 'darwin', log: { warn() {} }, run: fakeRun(script, calls) });
  const res = fakeRes();
  await routes.envHandler({}, res);
  assert.deepEqual(res.body.git, { available: false, version: null });
  assert.ok(!calls.includes('git --version'), 'the shim is ruled out by probe, never executed');
  assert.ok(!calls.some(c => c.startsWith('git config')));
});

test('run endpoint executes and reports a non-zero exit as success-shaped data', async () => {
  const events = [];
  const routes = createOpsTerminalRoutes({
    platform: 'linux',
    log: { warn: (name, meta) => events.push([name, meta]) },
    run: fakeRun(() => ({ code: 3, stdout: 'building\n', stderr: 'no space left on device\n', timedOut: false })),
  });
  const res = fakeRes();
  await routes.runHandler({ body: { command: 'make' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.exitCode, 3);
  assert.equal(res.body.stderr, 'no space left on device\n');
  // Audit metadata only — the command text must never reach the log.
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'ops_terminal_run');
  assert.ok(!JSON.stringify(events[0][1]).includes('make'), 'command text is absent from the audit record');
});

test('run endpoint rejects empty, non-string and oversized commands', async () => {
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: { warn() {} }, run: fakeRun(healthyLinux) });
  for (const body of [{ command: '' }, { command: '   ' }, {}, { command: 42 }, { command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) }]) {
    const res = fakeRes();
    await routes.runHandler({ body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(res.body.code, 'INVALID_COMMAND');
  }
});

test('run endpoint is single-flight: a second command while one runs gets 409', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const script = (command) => (command === 'long' ? gate : ok('quick\n'));
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: { warn() {} }, run: fakeRun(script) });
  const first = routes.runHandler({ body: { command: 'long' } }, fakeRes());
  const busy = fakeRes();
  await routes.runHandler({ body: { command: 'quick' } }, busy);
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.code, 'OPS_BUSY');
  release(ok('done\n'));
  const done = await first;
  assert.equal(done.body.exitCode, 0);
  // Freed after completion: the next command runs normally.
  const after = fakeRes();
  await routes.runHandler({ body: { command: 'quick' } }, after);
  assert.equal(after.statusCode, 200);
});

test('keepTail drops the head, not the tail — resolution errors live at the end', () => {
  const text = `${'a'.repeat(128 * 1024 + 64)}ERROR: nothing provides git`;
  const kept = keepTail(text);
  assert.ok(kept.endsWith('ERROR: nothing provides git'));
  assert.ok(kept.startsWith('…['));
  assert.equal(keepTail('short'), 'short');
  assert.equal(keepTail(undefined), '');
});

test('dirReasonFix maps both environment failures to the ops terminal codes', () => {
  assert.equal(dirReasonFix('git-error: spawn git ENOENT'), 'fix-git-missing');
  assert.equal(
    dirReasonFix('git-error: 无法读取 Git 提交身份配置，请设置 user.name 和 user.email'),
    'fix-git-identity',
  );
  // No regression in the pre-existing codes.
  assert.equal(dirReasonFix('xcode-select: error: command line tools are missing'), 'install-developer-tools');
  assert.equal(dirReasonFix('git-error: unable to get current working directory: Operation not permitted'), 'open-disk-access');
  assert.equal(dirReasonFix('git-error: something else'), null);
  assert.equal(dirReasonFix(''), null);
});

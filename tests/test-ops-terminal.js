'use strict';
// Ops terminal regression. The panel exists for the failures the add-directory
// dialog can name — git missing on a bare VM, commit identity unset or invalid
// on a fresh service account — so the tests lock: the env probe classifies
// those states the way the Rust commit gate does (and never runs the macOS
// shim that pops a system dialog); install advice matches the package manager
// AND the privileges of the account the commands run as; commands run as
// polled background jobs that survive long installs, can be stopped, and never
// wait on stdin; and the audit log records metadata only, never the command
// text a user may have pasted a credential into.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createOpsTerminalRoutes,
  startShell,
  MAX_COMMAND_LENGTH,
  MAX_OUTPUT_CHARS,
} = require('../src/routes/ops-terminal');
const { dirReasonFix } = require('../src/directories');

const ok = (out = '') => ({ code: 0, stdout: out });
const fail = (code = 1) => ({ code, stdout: '' });
const silent = { warn() {} };

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function fakeExec(script, calls = []) {
  return async (command) => { calls.push(command); return script(command) || fail(127); };
}

// A Linux host; each field overrides one probe answer.
function linuxHost({ git = true, name = 'multicc', email = 'multicc@local', pm = 'dnf', uid = 0, sudo = false } = {}) {
  return (command) => {
    if (command === 'command -v git') return git ? ok('/usr/bin/git\n') : fail(1);
    if (command === 'git --version') return ok('git version 2.43.0\n');
    if (command === 'git config --get user.name') return name ? ok(`${name}\n`) : fail(1);
    if (command === 'git config --get user.email') return email ? ok(`${email}\n`) : fail(1);
    if (command === 'id -un') return ok(uid === 0 ? 'root\n' : 'multicc\n');
    if (command === 'id -u') return ok(`${uid}\n`);
    if (command === 'sudo -n true') return sudo ? ok() : fail(1);
    if (command.startsWith('for c in')) return pm ? ok(`${pm}\n`) : fail(1);
    return null;
  };
}

async function env(host, platform = 'linux', calls) {
  const routes = createOpsTerminalRoutes({ platform, log: silent, exec: fakeExec(host, calls) });
  const res = fakeRes();
  await routes.envHandler({}, res, (error) => { throw error; });
  return res.body;
}

test('a healthy root host needs nothing', async () => {
  const body = await env(linuxHost());
  assert.deepEqual(body.git, { available: true, version: '2.43.0' });
  assert.deepEqual(body.identity, { name: 'multicc', email: 'multicc@local', valid: true });
  assert.deepEqual(body.account, { user: 'root', uid: 0, sudo: false });
  assert.equal(body.suggestions.gitInstall, 'dnf install -y git');
  assert.equal(body.suggestions.gitInstallRunnable, true);
  assert.equal(body.suggestions.identity, null);
});

test('a bare VM run by an unprivileged account is told to use SSH, not offered a doomed button', async () => {
  // The documented VPS layout: MultiCC runs as `multicc`, which cannot dnf/apt.
  const calls = [];
  const body = await env(linuxHost({ git: false, pm: 'apt-get', uid: 994 }), 'linux', calls);
  assert.deepEqual(body.git, { available: false, version: null });
  assert.deepEqual(body.identity, { name: null, email: null, valid: false });
  assert.ok(!calls.some(c => c.startsWith('git config')), 'identity is not probed without git');
  assert.deepEqual(body.account, { user: 'multicc', uid: 994, sudo: false });
  assert.equal(body.suggestions.gitInstall, 'apt-get update && apt-get install -y git');
  assert.equal(body.suggestions.gitInstallRunnable, false);
  assert.equal(body.suggestions.identity,
    'git config --global user.name "multicc" && git config --global user.email "multicc@local"',
    'both identity halves are set in one command');
});

test('passwordless sudo turns the install into a runnable non-interactive command', async () => {
  const dnf = await env(linuxHost({ git: false, uid: 994, sudo: true }));
  assert.equal(dnf.suggestions.gitInstall, 'sudo -n dnf install -y git');
  assert.equal(dnf.suggestions.gitInstallRunnable, true);
  const apt = await env(linuxHost({ git: false, pm: 'apt-get', uid: 994, sudo: true }));
  assert.equal(apt.suggestions.gitInstall, 'sudo -n apt-get update && sudo -n apt-get install -y git',
    'every step of a chained install is elevated');
});

test('identity validity mirrors the Rust commit gate, not mere presence', async () => {
  const noAt = await env(linuxHost({ email: 'ops' }));
  assert.equal(noAt.identity.valid, false, 'an email without @ is rejected by publication_identity.rs');
  assert.equal(noAt.suggestions.identity, 'git config --global user.email "multicc@local"', 'only the bad half is replaced');
  const angle = await env(linuxHost({ name: 'ops <bot>' }));
  assert.equal(angle.identity.valid, false);
  assert.equal(angle.suggestions.identity, 'git config --global user.name "multicc"');
  const unset = await env(linuxHost({ name: null }));
  assert.equal(unset.identity.valid, false);
});

test('the macOS shim is ruled out by probe, never executed', async () => {
  const calls = [];
  const host = (command) => {
    if (command === 'command -v git') return ok('/usr/bin/git\n');
    if (command === 'xcode-select -p') return fail(2);
    if (command === 'id -un') return ok('me\n');
    if (command === 'id -u') return ok('501\n');
    if (command === 'command -v brew') return ok('/opt/homebrew/bin/brew\n');
    return null;
  };
  const body = await env(host, 'darwin', calls);
  assert.deepEqual(body.git, { available: false, version: null });
  assert.ok(!calls.includes('git --version'));
  assert.ok(!calls.includes('sudo -n true'), 'sudo is only probed for Linux package managers');
  assert.equal(body.suggestions.gitInstall, 'brew install git');
  assert.equal(body.suggestions.gitInstallRunnable, true, 'brew runs as the user, no root needed');
});

// A controllable job: the test pushes output and decides when it ends.
function fakeStart() {
  const jobs = [];
  const start = (command, { onOutput }) => {
    let finish;
    const job = { command, onOutput, stopped: 0, done: new Promise((resolve) => { finish = resolve; }) };
    job.finish = (result) => finish(result);
    jobs.push(job);
    return { done: job.done, stop: () => { job.stopped += 1; } };
  };
  return { jobs, start };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a command runs as a polled job: incremental output, exit code, metadata-only audit', async () => {
  const events = [];
  let clock = 1000;
  const fake = fakeStart();
  const routes = createOpsTerminalRoutes({
    platform: 'linux', exec: fakeExec(linuxHost()), start: fake.start, now: () => clock,
    log: { warn: (name, meta) => events.push([name, meta]) },
  });
  const started = fakeRes();
  routes.startHandler({ body: { command: 'dnf install -y git' } }, started);
  assert.equal(started.body.job.running, true);
  assert.equal(started.body.job.command, 'dnf install -y git');

  fake.jobs[0].onOutput('Resolving…\n');
  clock += 1500;
  const first = fakeRes();
  routes.statusHandler({ query: { from: '0' } }, first);
  assert.equal(first.body.job.chunk, 'Resolving…\n');
  assert.equal(first.body.job.durationMs, 1500);

  fake.jobs[0].onOutput('Complete!\n');
  const second = fakeRes();
  routes.statusHandler({ query: { from: String(first.body.job.total) } }, second);
  assert.equal(second.body.job.chunk, 'Complete!\n', 'only output after the client offset is sent');

  fake.jobs[0].finish({ code: 0, timedOut: false });
  await tick(); await tick();
  const done = fakeRes();
  routes.statusHandler({ query: { from: String(first.body.job.total + 'Complete!\n'.length) } }, done);
  assert.equal(done.body.job.running, false);
  assert.equal(done.body.job.exitCode, 0);
  assert.equal(done.body.job.chunk, '');

  assert.deepEqual(events.map(e => e[0]), ['ops_terminal_start', 'ops_terminal_run']);
  assert.ok(!JSON.stringify(events).includes('dnf'), 'the command text never reaches the audit log');
});

test('a second command while one runs gets 409 with the running job to attach to', async () => {
  const fake = fakeStart();
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: silent, exec: fakeExec(linuxHost()), start: fake.start });
  routes.startHandler({ body: { command: 'long' } }, fakeRes());
  fake.jobs[0].onOutput('half way\n');
  const busy = fakeRes();
  routes.startHandler({ body: { command: 'quick' } }, busy);
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.code, 'OPS_BUSY');
  assert.equal(busy.body.job.command, 'long');
  assert.equal(busy.body.job.chunk, 'half way\n', 'the reopened panel gets the output so far');
  fake.jobs[0].finish({ code: 0 });
  await tick(); await tick();
  const next = fakeRes();
  routes.startHandler({ body: { command: 'quick' } }, next);
  assert.equal(next.statusCode, 200);
  assert.equal(fake.jobs.length, 2);
});

test('stop marks the job and signals it; a spawn error reaches the output', async () => {
  const fake = fakeStart();
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: silent, exec: fakeExec(linuxHost()), start: fake.start });
  routes.startHandler({ body: { command: 'tail -f /var/log/messages' } }, fakeRes());
  const stopped = fakeRes();
  routes.stopHandler({ body: {} }, stopped);
  assert.equal(fake.jobs[0].stopped, 1);
  assert.equal(stopped.body.job.stopped, true);
  fake.jobs[0].finish({ code: null, error: 'spawn /bin/sh EACCES' });
  await tick(); await tick();
  const res = fakeRes();
  routes.statusHandler({ query: {} }, res);
  assert.equal(res.body.job.exitCode, null);
  assert.ok(res.body.job.chunk.includes('spawn /bin/sh EACCES'), 'the reason is shown, not just a missing exit code');
});

test('oversized output keeps its tail and reports what was dropped', async () => {
  const fake = fakeStart();
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: silent, exec: fakeExec(linuxHost()), start: fake.start });
  routes.startHandler({ body: { command: 'noisy' } }, fakeRes());
  fake.jobs[0].onOutput('a'.repeat(MAX_OUTPUT_CHARS + 100));
  fake.jobs[0].onOutput('ERROR: nothing provides git\n');
  const res = fakeRes();
  routes.statusHandler({ query: { from: '0' } }, res);
  assert.ok(res.body.job.chunk.endsWith('ERROR: nothing provides git\n'));
  assert.equal(res.body.job.chunk.length, MAX_OUTPUT_CHARS);
  assert.equal(res.body.job.skipped, 100 + 'ERROR: nothing provides git\n'.length);
});

test('junk commands are refused before anything runs', async () => {
  const fake = fakeStart();
  const routes = createOpsTerminalRoutes({ platform: 'linux', log: silent, exec: fakeExec(linuxHost()), start: fake.start });
  for (const body of [{ command: '' }, { command: '   ' }, {}, { command: 42 }, { command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) }]) {
    const res = fakeRes();
    routes.startHandler({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_COMMAND');
  }
  assert.equal(fake.jobs.length, 0);
});

test('dirReasonFix tells the three Rust identity messages apart', () => {
  assert.equal(dirReasonFix('git-error: spawn git ENOENT'), 'fix-git-missing');
  assert.equal(dirReasonFix('git-error: 无法读取 Git 提交身份配置，请设置 user.name 和 user.email'), 'fix-git-identity');
  assert.equal(dirReasonFix('git-error: Git 提交身份配置无效，请设置有效的姓名与邮箱'), 'fix-git-identity');
  // Bare form: Command::new("git").output() itself failed — git is missing.
  assert.equal(dirReasonFix('git-error: 无法读取 Git 提交身份配置'), 'fix-git-missing');
  // The shared vocabulary still gives an unknown git failure no code; only the
  // add-directory endpoint adds the generic terminal entry (directory/service.js).
  assert.equal(dirReasonFix('git-error: something else'), null);
  assert.equal(dirReasonFix('xcode-select: error: command line tools are missing'), 'install-developer-tools');
  assert.equal(dirReasonFix('git-error: unable to get current working directory: Operation not permitted'), 'open-disk-access');
});

// The real shell runner, on hosts that have one.
const posix = process.platform !== 'win32';

test('a command that reads stdin gets EOF at once instead of waiting out the deadline', { skip: !posix }, async () => {
  let output = '';
  const startedAt = Date.now();
  const result = await startShell('read answer; echo "got:[$answer]"', { timeoutMs: 5000, onOutput: (c) => { output += c; } }).done;
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 3000, 'stdin is closed, not left open');
  assert.equal(output, 'got:[]\n');
});

test('stop() brings down the whole command tree, stdout and stderr both stream', { skip: !posix }, async () => {
  let output = '';
  const handle = startShell('echo out; echo err >&2; sleep 30 & sleep 30', { timeoutMs: 60000, onOutput: (c) => { output += c; } });
  await new Promise(resolve => setTimeout(resolve, 300));
  const startedAt = Date.now();
  handle.stop();
  const result = await handle.done;
  assert.ok(Date.now() - startedAt < 4000, 'the background sleep does not keep the job alive');
  assert.notEqual(result.code, 0);
  assert.ok(output.includes('out\n') && output.includes('err\n'));
});

test('the deadline stops a job and says so', { skip: !posix }, async () => {
  const result = await startShell('sleep 30', { timeoutMs: 200 }).done;
  assert.equal(result.timedOut, true);
});

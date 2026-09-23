'use strict';
// Installing the helper is the one moment a password is asked for, and the one
// moment a mistake grants standing root. What is locked here: the elevated
// command is the repo's own script with no caller-influenced part, declining
// the prompt is not an error, and success is confirmed by re-probing sudo
// rather than by trusting an exit code.
const { test } = require('node:test');
const assert = require('node:assert');
const { createPrivilegedHelperRoutes } = require('../src/routes/privileged-helper');

const silent = { log() {}, warn() {}, error() {} };

function fakeRun(reply, calls = []) {
  const run = (file, args, options, cb) => {
    calls.push([file, ...args]);
    const r = (typeof reply === 'function' ? reply(file, args) : reply) || {};
    cb(r.error || null, r.stdout || '', r.stderr || '');
  };
  run.calls = calls;
  return run;
}

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

const helperStub = (installed) => ({
  status: async () => ({ platform: 'darwin', applicable: true, installed, actions: { 'lid-sleep-on': installed, 'lid-sleep-off': installed } }),
  run: async () => null,
});

test('install elevates the repo script, not a caller-supplied command', async () => {
  const run = fakeRun({});
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'darwin', run, log: silent, helper: helperStub(true), user: 'green',
    scriptPath: '/opt/multicc/scripts/install-privileged-helper.sh',
  }).installHandler({}, res);
  assert.equal(res.body.status, 'installed');
  const [file, flag, script] = run.calls[0];
  assert.equal(file, '/usr/bin/osascript');
  assert.equal(flag, '-e');
  // A fixed script path plus a username the script itself re-validates — there
  // is no place for a caller to inject a command into the elevated shell.
  assert.equal(script,
    'do shell script "\'/opt/multicc/scripts/install-privileged-helper.sh\' \'install\' \'green\'" with administrator privileges');
});

test('uninstall is offered and takes no username', async () => {
  const run = fakeRun({});
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'darwin', run, log: silent, helper: helperStub(false), user: 'green', scriptPath: '/s.sh',
  }).uninstallHandler({}, res);
  assert.equal(res.body.status, 'removed');
  assert.match(run.calls[0][2], /'uninstall'/);
  assert.ok(!run.calls[0][2].includes('green'));
});

test('declining the password prompt is a choice, not a failure', async () => {
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'darwin', log: silent, helper: helperStub(false), user: 'green', scriptPath: '/s.sh',
    run: fakeRun({ error: Object.assign(new Error('User canceled. (-128)'), { code: 1 }) }),
  }).installHandler({}, res);
  assert.equal(res.statusCode, 200, 'a red error for a deliberate choice would be wrong');
  assert.equal(res.body.status, 'canceled');
});

test('a written-but-ignored drop-in is reported as a failure', async () => {
  // sudo silently ignores a drop-in with the wrong mode or owner, so the script
  // exiting 0 does not prove the grant is live. Only the re-probe does.
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'darwin', run: fakeRun({}), log: silent, helper: helperStub(false), user: 'green', scriptPath: '/s.sh',
  }).installHandler({}, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /sudoers\.d\/multicc/);
});

test('a path with a quote cannot break out of the AppleScript string', async () => {
  const run = fakeRun({});
  await createPrivilegedHelperRoutes({
    platform: 'darwin', run, log: silent, helper: helperStub(true), user: 'green',
    scriptPath: '/tmp/a"b\\c/install.sh',
  }).installHandler({}, fakeRes());
  const script = run.calls[0][2];
  assert.ok(script.includes('\\"'), 'the quote is escaped for AppleScript');
  assert.ok(script.endsWith('" with administrator privileges'), 'the string still terminates exactly once');
});

test('status reports who the grant would be for', async () => {
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'darwin', run: fakeRun({}), log: silent, helper: helperStub(true), user: 'green',
  }).statusHandler({}, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.installed, true);
  assert.equal(res.body.user, 'green');
});

test('off macOS there is nothing to install', async () => {
  const run = fakeRun({});
  const res = fakeRes();
  await createPrivilegedHelperRoutes({
    platform: 'linux', run, log: silent, helper: helperStub(false), user: 'green',
  }).installHandler({}, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NOT_APPLICABLE');
  assert.deepEqual(run.calls, [], 'osascript is never spawned off macOS');
});

test('the routes mount under /api/system and require both verbs', () => {
  const mounted = [];
  const app = { get: (p) => mounted.push(['GET', p]), post: (p) => mounted.push(['POST', p]) };
  createPrivilegedHelperRoutes({ platform: 'darwin', run: fakeRun({}), log: silent, helper: helperStub(true) }).mountRoutes(app);
  assert.deepEqual(mounted, [
    ['GET', '/api/system/privileged-helper'],
    ['POST', '/api/system/privileged-helper/install'],
    ['POST', '/api/system/privileged-helper/uninstall'],
  ]);
  assert.throws(() => createPrivilegedHelperRoutes({ platform: 'darwin', run: fakeRun({}), log: silent, helper: helperStub(true) })
    .mountRoutes({ get() {} }), /app\.get and app\.post/);
});

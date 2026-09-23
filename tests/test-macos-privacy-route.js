'use strict';
// macOS TCC cannot be granted from code — only the user, in System Settings,
// can do it. So this route is judged on the two things it can get wrong: which
// pane it opens, and which program it tells the user to add (that depends on
// how MultiCC was started, and getting it wrong wastes the user's time on a
// grant that does nothing).
const { test } = require('node:test');
const assert = require('node:assert');
const { createMacosPrivacyRoutes, FULL_DISK_ACCESS_URL } = require('../src/routes/macos-privacy');

const silent = { log() {}, warn() {}, error() {} };

function fakeRun(reply, calls = []) {
  const run = (file, args, options, cb) => {
    calls.push([file, ...args]);
    const r = reply || {};
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

const targets = (over) => () => ({
  execPath: '/usr/local/bin/node', appBundle: null, desktop: false, service: false, translocated: false, ...over,
});

test('opening the pane uses the Full Disk Access URL', async () => {
  const run = fakeRun({});
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', run, log: silent, permissionTargets: targets() });
  const res = fakeRes();
  await routes.openHandler({}, res);
  assert.equal(res.body.status, 'opened');
  assert.deepEqual(run.calls, [['/usr/bin/open', FULL_DISK_ACCESS_URL]]);
  assert.match(FULL_DISK_ACCESS_URL, /Privacy_AllFiles/);
});

test('the program to add follows how MultiCC was started', async () => {
  const cases = [
    // launchd has no GUI session to attribute a grant to, so the binary itself
    // is the only thing that can be added.
    [{ service: true, appBundle: '/Applications/MultiCC.app' }, '/usr/local/bin/node'],
    [{ appBundle: '/Applications/MultiCC.app' }, '/Applications/MultiCC.app'],
    [{}, '/usr/local/bin/node'],
  ];
  for (const [over, expected] of cases) {
    const routes = createMacosPrivacyRoutes({
      platform: 'darwin', run: fakeRun({}), log: silent, permissionTargets: targets(over),
    });
    const res = fakeRes();
    await routes.targetHandler({}, res);
    assert.equal(res.body.target, expected, JSON.stringify(over));
    assert.equal(res.body.applicable, true);
  }
});

test('a translocated copy is reported, because a grant there is worthless', async () => {
  // AppTranslocation runs the app from a randomised read-only path that will
  // not exist next launch, so any authorization recorded against it is lost.
  const routes = createMacosPrivacyRoutes({
    platform: 'darwin', run: fakeRun({}), log: silent, permissionTargets: targets({ translocated: true }),
  });
  const res = fakeRes();
  await routes.targetHandler({}, res);
  assert.equal(res.body.translocated, true);
});

test('a failure to open names the pane instead of claiming success', async () => {
  const routes = createMacosPrivacyRoutes({
    platform: 'darwin', log: silent, permissionTargets: targets(),
    run: fakeRun({ error: Object.assign(new Error('no GUI session'), { code: 1 }) }),
  });
  const res = fakeRes();
  await routes.openHandler({}, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.url, FULL_DISK_ACCESS_URL);
});

test('off macOS there is nothing to open', async () => {
  const run = fakeRun({});
  const routes = createMacosPrivacyRoutes({ platform: 'linux', run, log: silent, permissionTargets: targets() });
  const info = fakeRes();
  await routes.targetHandler({}, info);
  assert.deepEqual(info.body, { ok: true, platform: 'linux', applicable: false, target: null });
  const res = fakeRes();
  await routes.openHandler({}, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NOT_APPLICABLE');
  assert.deepEqual(run.calls, [], 'nothing is spawned off macOS');
});

test('the permission-denied failure actually routes to this button', () => {
  // The fix code is the contract between src/directories.js and both frontends;
  // if it stops matching, the button silently disappears from the error dialog.
  const { dirReasonFix } = require('../src/directories');
  assert.equal(dirReasonFix('permission-denied: fatal: unable to get current working directory: Operation not permitted'),
    'open-disk-access');
  assert.equal(dirReasonFix('git init: Operation not permitted'), 'open-disk-access');
  // A missing toolchain wins: the denial is downstream noise in that case.
  assert.equal(dirReasonFix('git init xcode-select: note: No developer tools were found, requesting install'),
    'install-developer-tools');
  assert.equal(dirReasonFix('home-or-above'), null);
});

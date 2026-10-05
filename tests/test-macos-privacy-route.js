'use strict';
// macOS TCC cannot be granted from code — only the user, in System Settings,
// can do it. So this route is judged on the two things it can get wrong: which
// pane it opens, and which program it tells the user to add (that depends on
// how MultiCC was started, and getting it wrong wastes the user's time on a
// grant that does nothing).
const { test } = require('node:test');
const assert = require('node:assert');
const { createMacosPrivacyRoutes, FULL_DISK_ACCESS_URL, AGENT_PERMISSION_URLS } = require('../src/routes/macos-privacy');

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
    statusCode: 200, body: null, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
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

test('Agent permissions whitelist grants and mark legacy Esc status as unknown', async () => {
  const run = fakeRun({ stdout: JSON.stringify({ ok: true, accessibility: false, screenRecording: true,
    unlockPassword: true, platform: { os: '15.3' } }) });
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', run, agentBin: '/agent',
    resolveAgentApp: () => '/Users/test/Applications/MultiCC Agent.app' });
  const res = fakeRes();
  await routes.agentPermissionsHandler({ socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.deepEqual(res.body, { ok: true, applicable: true, local: true,
    agentApp: '/Users/test/Applications/MultiCC Agent.app',
    accessibility: false, screenRecording: true, listenAccess: null, escMonitorEnabled: null });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(run.calls, [['/agent', 'status']]);
});

test('Esc status uses enabled taps, independently of the input monitoring grant', async () => {
  for (const [fields, expected] of [
    [{ listenAccess: false, escMonitor: false, escTaps: { hid: { enabled: false }, session: { enabled: false } } }, false],
    [{ listenAccess: true, escMonitor: true, escTaps: { hid: { enabled: false }, session: { enabled: false } } }, false],
    [{ listenAccess: true, escTaps: { hid: { enabled: false }, session: { enabled: true } } }, true],
    [{ listenAccess: false, escTaps: { hid: { enabled: true }, session: { enabled: false } } }, true],
    [{ listenAccess: true, escMonitor: true }, null],
    [{ listenAccess: 'true', escTaps: { hid: { enabled: false } } }, null],
    [{ escTaps: { hid: { enabled: 'true' }, session: { enabled: false } } }, null],
  ]) {
    const routes = createMacosPrivacyRoutes({ platform: 'darwin', run: fakeRun({ stdout: JSON.stringify({
      ok: true, accessibility: true, screenRecording: true, ...fields,
    }) }) });
    const res = fakeRes();
    await routes.agentPermissionsHandler({}, res);
    assert.equal(res.body.escMonitorEnabled, expected);
    assert.equal(res.body.listenAccess, typeof fields.listenAccess === 'boolean' ? fields.listenAccess : null);
    assert.equal(res.body.escTaps, undefined, 'raw event counts stay inside Agent');
  }
});

test('missing or malformed Agent fields are unknown, never denied grants', async () => {
  for (const stdout of ['bad JSON', 'null', '{"ok":true}', '{"ok":true,"accessibility":"true","screenRecording":true}']) {
    const run = fakeRun({ stdout });
    const routes = createMacosPrivacyRoutes({ platform: 'darwin', run });
    const res = fakeRes();
    await routes.agentPermissionsHandler({ socket: { remoteAddress: '192.168.1.2' } }, res);
    assert.deepEqual(res.body, { ok: false, applicable: true, local: false, error: 'agent-unavailable' });
    assert.equal(run.calls.length, 1, 'reading status must never restart or prompt');
  }
});

test('permission target follows the installed client symlink and stays local', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Other location', 'MultiCC Agent.app');
  const binary = path.join(app, 'Contents/MacOS/MultiCCAgent');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '');
  const link = path.join(root, 'multicc-agent');
  fs.symlinkSync(binary, link);
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', agentBin: link,
    run: fakeRun({ stdout: JSON.stringify({ ok: true, accessibility: true, screenRecording: true }) }) });
  const local = fakeRes();
  await routes.agentPermissionsHandler({ socket: { remoteAddress: '::1' } }, local);
  assert.equal(local.body.agentApp, fs.realpathSync(app));
  const remote = fakeRes();
  await routes.agentPermissionsHandler({ socket: { remoteAddress: '192.168.1.2' } }, remote);
  assert.equal(remote.body.agentApp, undefined);
});

test('explicit Agent restart is local, macOS-only and targets the current GUI user', async () => {
  for (const [platform, address, code] of [['linux', '::1', 400], ['darwin', '192.168.1.2', 403]]) {
    const run = fakeRun({});
    const routes = createMacosPrivacyRoutes({ platform, run });
    const res = fakeRes();
    await routes.restartAgentPermissionHandler({ socket: { remoteAddress: address } }, res);
    assert.equal(res.statusCode, code);
    assert.equal(run.calls.length, 0);
  }
  const run = fakeRun({ stdout: JSON.stringify({ ok: true, accessibility: true, screenRecording: false }) });
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', run, uid: 502, agentBin: '/agent', resolveAgentApp: () => null });
  const res = fakeRes();
  await routes.restartAgentPermissionHandler({ socket: { remoteAddress: '::1' }, body: { uid: 0, label: 'other' } }, res);
  assert.deepEqual(run.calls, [['/bin/launchctl', 'kickstart', '-k', 'gui/502/com.multicc.agent'], ['/agent', 'status']]);
  assert.equal(res.body.accessibility, true);
  assert.equal(res.body.screenRecording, false, 'restart does not manufacture a grant');
});

test('concurrent restarts coalesce and wait for Agent readiness', async () => {
  const calls = [];
  let probes = 0;
  const run = (file, args, options, cb) => {
    calls.push([file, ...args]);
    if (file === '/bin/launchctl') return setImmediate(() => cb(null));
    if (++probes === 1) return cb(new Error('socket not ready'));
    cb(null, JSON.stringify({ ok: true, accessibility: true, screenRecording: true }));
  };
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', run, uid: 501, agentBin: '/agent', delay: async () => {} });
  const req = { socket: { remoteAddress: '127.0.0.1' } };
  const a = fakeRes(), b = fakeRes();
  await Promise.all([routes.restartAgentPermissionHandler(req, a), routes.restartAgentPermissionHandler(req, b)]);
  assert.equal(calls.filter(call => call[0] === '/bin/launchctl').length, 1);
  assert.equal(probes, 2);
  assert.equal(a.body.screenRecording, true);
  assert.deepEqual(a.body, b.body);
});

test('restart failures and readiness timeouts are bounded and remain unknown', async () => {
  for (const launchFails of [true, false]) {
    let probes = 0;
    const run = (file, args, options, cb) => {
      if (file === '/bin/launchctl') return cb(launchFails ? new Error('job missing') : null);
      probes++;
      cb(new Error('unavailable'));
    };
    const routes = createMacosPrivacyRoutes({ platform: 'darwin', run, uid: 501, delay: async () => {} });
    const res = fakeRes();
    await routes.restartAgentPermissionHandler({ socket: { remoteAddress: '::1' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.accessibility, undefined);
    assert.equal(probes, launchFails ? 0 : 6);
  }
});

test('opening an Agent permission selects its exact pane and requires a local request', async () => {
  const run = fakeRun({});
  const routes = createMacosPrivacyRoutes({ platform: 'darwin', run });
  const remote = fakeRes();
  await routes.openAgentPermissionHandler({ socket: { remoteAddress: '192.168.1.2' },
    body: { permission: 'accessibility' } }, remote);
  assert.equal(remote.statusCode, 403);
  const local = { socket: { remoteAddress: '::1' }, body: { permission: 'screenRecording' } };
  const opened = fakeRes();
  await routes.openAgentPermissionHandler(local, opened);
  assert.equal(opened.body.status, 'opened');
  assert.deepEqual(run.calls, [['/usr/bin/open', AGENT_PERMISSION_URLS.screenRecording]]);
  const input = fakeRes();
  await routes.openAgentPermissionHandler({ ...local, body: { permission: 'listenAccess' } }, input);
  assert.equal(input.body.status, 'opened');
  assert.deepEqual(run.calls[1], ['/usr/bin/open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent']);
  const invalid = fakeRes();
  await routes.openAgentPermissionHandler({ ...local, body: { permission: 'other' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const inherited = fakeRes();
  await routes.openAgentPermissionHandler({ ...local, body: { permission: 'toString' } }, inherited);
  assert.equal(inherited.statusCode, 400);
  assert.equal(run.calls.length, 2);
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

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  EXIT_MARKER,
  START_MARKER,
  UPDATE_LOG_RELATIVE,
  buildUpdateShellCommand,
  preflightUpdate,
  STEP_MARKER,
  PLAN_MARKER,
  UPDATE_STEPS,
  detectStandaloneUpdate,
  buildInstallScriptShellCommand,
  shellQuote,
  parseUpdateLog,
  parseUpdateSteps,
  readUpdateStatus,
  startDetachedUpdate,
} = require('../src/update-runner');
const { createUpdateRoute } = require('../src/routes/update-route');

// The directory name contains a space and a quote on purpose: the shell command
// is assembled as a string, so a naive concatenation would write the log
// somewhere else entirely (or run the wrong command) on a path like this.
function createFixture({ managerBody = '#!/bin/bash\necho "manager ran: $*"\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multicc up'date-"));
  fs.writeFileSync(path.join(root, 'multicc'), managerBody, { mode: 0o600 });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function runUpdateSynchronously(root, { force = false } = {}) {
  const command = buildUpdateShellCommand({ rootDir: root, force });
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function createChild() {
  const child = new EventEmitter();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  return child;
}

function createFakeApp() {
  const routes = { get: new Map(), post: new Map() };
  return {
    routes,
    get(routePath, handler) { routes.get.set(routePath, handler); },
    post(routePath, handler) { routes.post.set(routePath, handler); },
  };
}

function createRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

test('the update runs through bash without an executable bit and its outcome survives on disk', () => {
  const root = createFixture();
  assert.equal((fs.statSync(path.join(root, 'multicc')).mode & 0o111), 0, 'fixture intentionally has no executable bit');
  runUpdateSynchronously(root);

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'succeeded');
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 0);
  assert.equal(status.force, false);
  assert.match(status.tail, /manager ran: update$/m);
  // The markers are bookkeeping, not output the user should read.
  assert.equal(status.tail.includes(EXIT_MARKER), false);
  assert.equal(status.tail.includes(START_MARKER), false);
  assert.match(status.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(status.logPath, path.join(root, UPDATE_LOG_RELATIVE));
});

test('--force reaches the manager as a flag and is reported back in the status', () => {
  const root = createFixture();
  runUpdateSynchronously(root, { force: true });

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'succeeded');
  assert.equal(status.force, true);
  assert.match(status.tail, /manager ran: update --force$/m);
});

test('a failing update is reported as failed with the manager exit code, not as merely finished', () => {
  const root = createFixture({ managerBody: '#!/bin/bash\necho "conflict in working tree" >&2\nexit 3\n' });
  runUpdateSynchronously(root);

  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'failed');
  assert.equal(status.running, false);
  assert.equal(status.exitCode, 3);
  // stderr is captured too — the reason a force update is needed is usually there.
  assert.match(status.tail, /conflict in working tree/);
});

test('each run truncates the log so a previous run cannot be read as this one', () => {
  const root = createFixture({ managerBody: '#!/bin/bash\necho "FIRST RUN OUTPUT"\n' });
  runUpdateSynchronously(root);
  assert.match(readUpdateStatus({ rootDir: root }).tail, /FIRST RUN OUTPUT/);

  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\necho "SECOND RUN OUTPUT"\nexit 1\n', { mode: 0o600 });
  runUpdateSynchronously(root);
  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.exitCode, 1, 'the second run owns the exit code');
  assert.equal(status.tail.includes('FIRST RUN OUTPUT'), false);
  assert.match(status.tail, /SECOND RUN OUTPUT/);
});

test('status is idle before any update and running while one is in flight', () => {
  const root = createFixture();
  const idle = readUpdateStatus({ rootDir: root });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.running, false);
  assert.equal(idle.exitCode, null);

  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, UPDATE_LOG_RELATIVE), `${START_MARKER} 2026-08-03T10:00:00Z force=0\nUpdating MultiCC...\n`);
  const running = readUpdateStatus({ rootDir: root });
  assert.equal(running.state, 'running');
  assert.equal(running.running, true);
  assert.equal(running.exitCode, null);
  assert.match(running.tail, /Updating MultiCC/);
});

test('a run that dies without writing its marker goes stale instead of running forever', () => {
  const root = createFixture();
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const logPath = path.join(root, UPDATE_LOG_RELATIVE);
  fs.writeFileSync(logPath, `${START_MARKER} 2026-08-03T10:00:00Z force=1\nhalf a log\n`);
  const mtime = fs.statSync(logPath).mtimeMs;

  // Silence is measured from the last write: a quiet npm install must stay
  // "running", but a run silent past the threshold is gone for good.
  const nearlyStale = readUpdateStatus({ rootDir: root, now: () => mtime + (14 * 60 * 1000) });
  assert.equal(nearlyStale.state, 'running');
  assert.equal(nearlyStale.running, true);

  const stale = readUpdateStatus({ rootDir: root, now: () => mtime + (16 * 60 * 1000) });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.running, false, 'a stale run must not block a retry');
  assert.equal(stale.force, true);
});

test('the log parser takes the newest exit marker and never a truncated number', () => {
  const parsed = parseUpdateLog(`${START_MARKER} 2026-08-03T10:00:00Z force=0\nfirst\n${EXIT_MARKER} 1\nsecond\n${EXIT_MARKER} 0\n`);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.startedAt, '2026-08-03T10:00:00Z');
  assert.equal(parsed.force, false);
  assert.equal(parseUpdateLog('').exitCode, null);
  assert.equal(parseUpdateLog(null).exitCode, null);
});

test('step markers become a per-step checklist and never leak into the visible tail', () => {
  const log = [
    `${START_MARKER} 2026-08-03T10:00:00Z force=0`,
    `${STEP_MARKER} deps start 1000`,
    `${STEP_MARKER} deps done 1002`,
    `${STEP_MARKER} check start 1002`,
    'Checking for updates...',
    `${STEP_MARKER} check done 1005 v2.1.0`,
    `${STEP_MARKER} fetch start 1005`,
    'Receiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.',
    '',
  ].join('\n');
  const steps = parseUpdateSteps(log);
  assert.deepEqual(steps.map(step => step.id), UPDATE_STEPS);
  const byId = Object.fromEntries(steps.map(step => [step.id, step]));
  assert.equal(byId.deps.state, 'done');
  assert.equal(byId.deps.startedAt, new Date(1000 * 1000).toISOString());
  assert.equal(byId.deps.endedAt, new Date(1002 * 1000).toISOString());
  assert.equal(byId.check.note, 'v2.1.0');
  assert.equal(byId.fetch.state, 'running');
  assert.equal(byId.install.state, 'pending');

  const parsed = parseUpdateLog(log);
  assert.doesNotMatch(parsed.tail, new RegExp(STEP_MARKER));
  assert.doesNotMatch(parsed.tail, /10% \(1\/10\)/, 'git progress frames collapse to the last one');
  assert.match(parsed.tail, /100% \(10\/10\)/);

  const skipped = parseUpdateSteps(`${STEP_MARKER} install skip 1010 unchanged\n`);
  assert.equal(skipped.find(step => step.id === 'install').state, 'skipped');
});

test('steps are read from the whole log, not just the tail window', () => {
  const root = createFixture();
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const noise = 'x'.repeat(200) + '\n';
  fs.writeFileSync(path.join(root, UPDATE_LOG_RELATIVE), [
    `${START_MARKER} 2026-08-03T10:00:00Z force=0\n`,
    `${STEP_MARKER} deps start 1000\n`,
    `${STEP_MARKER} deps done 1001\n`,
    `${STEP_MARKER} install start 1001\n`,
    noise.repeat(400),
  ].join(''));
  const status = readUpdateStatus({ rootDir: root });
  assert.equal(status.state, 'running');
  const byId = Object.fromEntries(status.steps.map(step => [step.id, step]));
  assert.equal(byId.deps.state, 'done');
  assert.equal(byId.install.state, 'running');
  assert.deepEqual(readUpdateStatus({ rootDir: createFixture() }).steps, []);
});

test('the manager emits a marker for every step the UI knows about', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'multicc'), 'utf8');
  const declared = /UPDATE_STEPS="([^"]+)"/.exec(manager);
  assert.ok(declared, 'multicc declares UPDATE_STEPS');
  assert.deepEqual(declared[1].split(' '), UPDATE_STEPS);
  assert.ok(manager.includes(`UPDATE_STEP_MARKER="${STEP_MARKER}"`));
  for (const id of UPDATE_STEPS) {
    assert.match(manager, new RegExp(`update_step ${id} (start|skip)`), `${id} is started somewhere`);
  }
});

// ── Standalone package ──
function createStandaloneFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "multicc standalone'-"));
  const resources = path.join(base, 'MultiCC.app', 'Contents', 'Resources');
  const rootDir = path.join(resources, 'app-server');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(path.join(resources, 'launcher'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'runtime', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'launcher', 'standalone-cli.js'), '');
  fs.writeFileSync(path.join(resources, 'runtime', 'bin', 'node'), '', { mode: 0o755 });
  const env = { MULTICC_DESKTOP: '1', MULTICC_DATA_DIR: dataDir, PATH: process.env.PATH };
  return { base, resources, rootDir, dataDir, env };
}

test('a standalone install is recognised, and its log lives outside the bundle it replaces', () => {
  const fixture = createStandaloneFixture();
  const standalone = detectStandaloneUpdate({ rootDir: fixture.rootDir, env: fixture.env, platform: 'darwin' });
  assert.ok(standalone);
  assert.equal(standalone.logPath, path.join(fixture.dataDir, UPDATE_LOG_RELATIVE));
  assert.ok(!standalone.logPath.startsWith(fixture.resources), 'the swap would take the log with it');

  // The Electron desktop app and a plain checkout are not standalone installs.
  assert.equal(detectStandaloneUpdate({ rootDir: fixture.rootDir, env: { ...fixture.env, ELECTRON_RUN_AS_NODE: '1' } }), null);
  // A packaged desktop app carries the very same launcher/runtime tree, so the
  // layout check alone would call it standalone and point install.sh at the
  // directory that holds MultiCC.app. Its backend says which it is.
  assert.equal(detectStandaloneUpdate({ rootDir: fixture.rootDir, env: { ...fixture.env, MULTICC_DESKTOP_SHELL: '1' } }), null);
  assert.equal(detectStandaloneUpdate({ rootDir: fixture.rootDir, env: { MULTICC_DATA_DIR: fixture.dataDir } }), null);
  assert.equal(detectStandaloneUpdate({ rootDir: createFixture(), env: fixture.env }), null);
});

test('Windows 网页升级从包目录外启动 PowerShell 并保留目标版本和端口配置', async t => {
  const fixture = createStandaloneFixture();
  t.after(() => fs.rmSync(fixture.base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.resources, 'runtime', 'node.exe'), '');
  let invoked = false;
  await startDetachedUpdate({
    rootDir: fixture.rootDir, platform: 'win32', targetVersion: '2.24.0', port: 4321,
    env: { ...fixture.env, PORT: '4321', MULTICC_STANDALONE_DETACHED: '1' },
    getChildProxyEnv: async env => env,
    spawn(command, args, options) {
      invoked = true;
      assert.equal(command, 'powershell.exe');
      const worker = args[args.indexOf('-File') + 1];
      const workspace = path.dirname(worker);
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      assert.equal(args.at(-1), '-Launch');
      assert.equal(options.cwd, os.tmpdir());
      assert.equal(options.env.PORT, undefined);
      assert.equal(options.env.MULTICC_STANDALONE_DETACHED, undefined);
      const request = JSON.parse(fs.readFileSync(path.join(workspace, 'request.json'), 'utf8'));
      assert.equal(request.bundleRoot, fixture.base);
      assert.equal(request.targetVersion, '2.24.0');
      assert.equal(parseUpdateLog(fs.readFileSync(request.logPath, 'utf8')).targetVersion, '2.24.0');
      const child = createChild();
      process.nextTick(() => child.emit('exit', 0));
      return child;
    },
  });
  assert.equal(invoked, true);
});

test('PowerShell 把安装器的完成状态写回升级日志', t => {
  const command = 'powershell.exe';
  const probe = spawnSync(command, ['-NoProfile', '-Command', 'exit 0']);
  if (probe.error?.code === 'ENOENT' && process.platform !== 'win32') return t.skip('未安装 PowerShell');
  assert.equal(probe.status, 0);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "MultiCC update test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const bundleRoot = path.join(fixture, 'my MultiCC');
  const expectedVersion = 'v2.24.0';
  const stub = path.join(fixture, 'fixture-installer.ps1');
  fs.writeFileSync(stub, `param($InstallDir, $Version, [switch]$Yes, [switch]$NoOpen, [switch]$NoShortcut, [switch]$NoService)
if ($InstallDir -ne $env:TEST_BUNDLE -or $Version -ne $env:TEST_VERSION) { exit 79 }
Write-Output "fixture installer ran"
exit ([int]$env:TEST_EXIT)
`);
  const entry = `function Invoke-WebRequest($Uri, $OutFile, [switch]$UseBasicParsing) {
    if ($Uri -ne 'https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.ps1') { throw 'wrong installer URL' }
    if ($env:TEST_EMPTY -eq '1') { [IO.File]::WriteAllText($OutFile, '') }
    else { Copy-Item -LiteralPath $env:TEST_STUB -Destination $OutFile }
  }
  & $env:TEST_WORKER
  exit $LASTEXITCODE`;
  for (const expected of [0, 37, 1]) {
    const workspace = fs.mkdtempSync(path.join(fixture, 'worker-'));
    const worker = path.join(workspace, 'update.ps1');
    const logPath = path.join(fixture, `update-${expected}.log`);
    fs.copyFileSync(path.join(__dirname, '../src/windows-standalone-update.ps1'), worker);
    fs.writeFileSync(path.join(workspace, 'request.json'), JSON.stringify({ bundleRoot, logPath, targetVersion: expectedVersion }));
    const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', entry], {
      env: { ...process.env, TEST_STUB: stub, TEST_WORKER: worker, TEST_VERSION: expectedVersion,
        TEST_BUNDLE: bundleRoot, TEST_EXIT: String(expected), TEST_EMPTY: expected === 1 ? '1' : '0' },
      encoding: 'utf8', timeout: 30000,
    });
    const log = fs.readFileSync(logPath, 'utf8').trimEnd();
    assert.equal(result.status, expected, result.stderr + log);
    assert.ok(log.endsWith(`${EXIT_MARKER} ${expected}`), log);
    assert.equal(log.includes('fixture installer ran'), expected !== 1, log);
  }
});

test('a standalone update fetches install.sh and points it at the bundle root, and is admitted in desktop mode', async () => {
  const fixture = createStandaloneFixture();
  const spawned = [];
  const spawn = (command, args, options) => { spawned.push({ command, args, options }); return createChild(); };
  const app = createFakeApp();
  createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions: new Map(), spawn, rootDir: fixture.rootDir, log: { log() {}, error() {} },
    isDesktopMode: () => true,
    isStandalone: () => Boolean(detectStandaloneUpdate({ rootDir: fixture.rootDir, env: fixture.env })),
    getPort: () => 4242,
  }).mountRoutes(app);

  const status = createRes();
  app.routes.get.get('/api/update/status')({}, status);
  assert.equal(status.body.kind, 'standalone');

  const previousEnv = { ...process.env };
  Object.assign(process.env, fixture.env);
  try {
    const res = createRes();
    // No fs/path/https/gitRun deps supplied — resolveVersionInfo is skipped and
    // the handler only awaits proxy preparation (see server.js's real wiring for the
    // version-resolving case, covered separately by the update-route tests).
    await app.routes.post.get('/api/update')({ body: {} }, res);
    assert.equal(res.statusCode, 202, JSON.stringify(res.body));
    assert.equal(res.body.targetVersion, null);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  assert.equal(spawned.length, 1);
  const script = spawned[0].args[1];
  // Unknown target version: the installer is fetched off `main` and told to
  // resolve `latest` itself, exactly as install.sh's own one-liner would.
  assert.match(script, /curl -fsSL 'https:\/\/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/main\/install\.sh' -o "\$TMP"/);
  // install.sh is a bash script (arrays, process substitution): invoking it
  // through /bin/sh aborted with "syntax error near unexpected token '<'".
  assert.doesNotMatch(script, /\/bin\/sh "\$TMP"/);
  assert.match(script, /BASH_BIN="\$\(command -v bash 2>\/dev\/null \|\| echo \/bin\/bash\)"/);
  assert.match(script, /"\$BASH_BIN" "\$TMP" --dir '.*' --version 'latest' --port '4242' --no-open/);
  assert.ok(script.includes(shellQuote(fixture.base)), 'install.sh is pointed at the true bundle root, not Resources');
  assert.ok(script.includes(shellQuote(path.join(fixture.dataDir, 'logs', 'update.log'))), 'the log path survives shell quoting');
  assert.equal(spawned[0].options.cwd, fixture.base);
  assert.equal(spawned[0].options.detached, true);
});

test('指定目标版本时，从 main 下载安装器并用版本参数选择发布包', () => {
  const fixture = createStandaloneFixture();
  const standalone = detectStandaloneUpdate({ rootDir: fixture.rootDir, env: fixture.env, platform: 'darwin' });
  const script = buildInstallScriptShellCommand({ standalone, targetVersion: '1.4.2', port: 3000 });
  assert.match(script, /curl -fsSL 'https:\/\/raw\.githubusercontent\.com\/lsjwzh\/MultiCC\/main\/install\.sh' -o "\$TMP"/);
  assert.match(script, /--version 'v1\.4\.2'/);
  assert.ok(script.includes('target=1.4.2'), 'the run records the version it is installing for later reattachment');
});

test('a declared plan replaces the default steps and download progress rides on the running step', () => {
  const log = [
    `${PLAN_MARKER} check download checksum extract restart ready`,
    `${STEP_MARKER} check start 1000`,
    `${STEP_MARKER} check done 1001 v2.2.0`,
    `${STEP_MARKER} download start 1001 multicc-standalone.tar.gz`,
    `${STEP_MARKER} download progress 1002 3.0 / 48.0 MB · 6% · 3.0 MB/s`,
    `${STEP_MARKER} download progress 1004 12.0 / 48.0 MB · 25% · 4.5 MB/s`,
    '',
  ].join('\n');
  const steps = parseUpdateSteps(log);
  assert.deepEqual(steps.map(step => step.id), ['check', 'download', 'checksum', 'extract', 'restart', 'ready']);
  const download = steps.find(step => step.id === 'download');
  assert.equal(download.state, 'running');
  assert.equal(download.progress.percent, 25);
  assert.match(download.progress.text, /12\.0 \/ 48\.0 MB/);
  assert.equal(parseUpdateLog(log).tail, '', 'plan and progress markers never reach the visible log');

  const finished = parseUpdateSteps(`${log}${STEP_MARKER} download done 1010 48.0 MB\n`);
  assert.equal(finished.find(step => step.id === 'download').progress, null);
});

test('preflight refuses an install the update cannot possibly work on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-preflight-'));
  assert.throws(
    () => preflightUpdate({ rootDir: root }),
    error => error && error.code === 'UPDATE_MANAGER_MISSING',
  );

  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\n', { mode: 0o600 });
  assert.throws(
    () => preflightUpdate({ rootDir: root }),
    error => error && error.code === 'UPDATE_NOT_A_GIT_CHECKOUT',
  );

  fs.mkdirSync(path.join(root, '.git'));
  assert.deepEqual(preflightUpdate({ rootDir: root }), Object.freeze({
    managerPath: path.join(root, 'multicc'),
    bashPath: '/bin/bash',
  }));
  assert.ok(fs.statSync(path.join(root, 'logs')).isDirectory(), 'preflight creates the log directory it checks');
});

// A `>` redirect that cannot be opened makes /bin/sh skip the whole block: the
// update never runs and never writes a log, so status would read `idle` until the
// client gives up minutes later. Preflight has to turn that into an error at the
// HTTP boundary instead.
test('an unwritable log directory is refused up front, not discovered by timeout', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores mode bits

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-update-logdir-'));
  fs.writeFileSync(path.join(root, 'multicc'), '#!/bin/bash\n', { mode: 0o600 });
  fs.mkdirSync(path.join(root, '.git'));

  // logs/ exists but cannot be written into.
  fs.mkdirSync(path.join(root, 'logs'), { mode: 0o500 });
  try {
    assert.throws(
      () => preflightUpdate({ rootDir: root }),
      error => error && error.code === 'UPDATE_LOG_UNWRITABLE',
    );
  } finally {
    fs.chmodSync(path.join(root, 'logs'), 0o700);
  }

  // logs/ missing, and the root it would be created in is read-only.
  fs.rmSync(path.join(root, 'logs'), { recursive: true });
  fs.chmodSync(root, 0o500);
  try {
    assert.throws(
      () => preflightUpdate({ rootDir: root }),
      error => error && error.code === 'UPDATE_LOG_UNWRITABLE',
    );
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

test('the update child is detached so the restart it performs cannot kill it', async () => {
  const root = createFixture();
  const calls = [];
  const child = createChild();
  const result = await startDetachedUpdate({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    rootDir: root,
    force: true,
    env: { MARKER: 'yes' },
    log: { log() {}, error() {} },
  });
  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/bin/sh');
  assert.equal(calls[0].options.detached, true, 'do_stop kills the server process group');
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.deepEqual(calls[0].options.env, { MARKER: 'yes', http_proxy: 'http://proxy.test:8080' });
  assert.match(calls[0].args[1], /multicc update --force/);
  assert.equal(child.unrefCount, 1);
});

test('the update child never inherits the old standalone launcher background marker', async () => {
  // A server started by `multicc start` under a launcher <= 2.10.0 carries
  // MULTICC_STANDALONE_DETACHED=1. Handed on, install.sh's final `multicc start`
  // stayed in the foreground forever: the new version ran, but the update never
  // finished and the old directory was never removed.
  const root = createFixture();
  const calls = [];
  await startDetachedUpdate({
    getChildProxyEnv: async env => env,
    spawn(command, args, options) { calls.push(options); return createChild(); },
    rootDir: root,
    env: { MARKER: 'yes', MULTICC_STANDALONE_DETACHED: '1' },
    log: { log() {}, error() {} },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].env, { MARKER: 'yes' });
});

test('install.sh drops the leaked launcher marker before it runs anything', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  const unset = script.indexOf('unset MULTICC_STANDALONE_DETACHED');
  assert.ok(unset > 0, 'install.sh must unset MULTICC_STANDALONE_DETACHED');
  // Older servers fetch the installer of the target release and run it with
  // their own environment, so the unset has to precede every start/stop call.
  assert.ok(unset < script.indexOf('MULTICC_CMD='), 'the unset must come before the launcher is resolved');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'standalone-cli.js'), 'utf8');
  assert.match(cli, /function runLauncher[\s\S]{0,600}delete env\.MULTICC_STANDALONE_DETACHED/,
    'the CLI must not hand an inherited marker to the launcher it starts');
});

test('a synchronous spawn failure reaches the HTTP boundary as 503 with a code, and frees the flag', async () => {
  const root = createFixture();
  const route = createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions: new Map(),
    spawn() { const error = new Error('nope'); error.code = 'EAGAIN'; throw error; },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  await app.routes.post.get('/api/update')({ body: {}, id: 'req-1' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'UPDATE_START_FAILED');

  // The failed attempt must not leave the route 409-ing forever.
  const second = createRes();
  await app.routes.post.get('/api/update')({ body: {}, id: 'req-2' }, second);
  assert.equal(second.statusCode, 503);
});

test('the route starts one update, reports the turns it will interrupt, and rejects a second', async () => {
  const root = createFixture();
  const spawned = [];
  const chatSessions = new Map([
    ['a', { isStreaming: true, lastStreamAt: Date.now() }],
    ['b', { isStreaming: true, lastStreamAt: Date.now() - (20 * 60 * 1000) }],
    ['c', { isStreaming: false, lastStreamAt: Date.now() }],
  ]);
  const route = createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions,
    spawn(command, args, options) { spawned.push({ command, args, options }); return createChild(); },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  await app.routes.post.get('/api/update')({ body: { force: true }, id: 'req-1' }, res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, status: 'started', force: true, activeStreaming: 1, targetVersion: null });
  assert.match(spawned[0].args[1], /multicc update --force/);

  // Second call within the debounce window: the log does not exist yet, so only
  // the in-memory flag can catch this.
  const second = createRes();
  await app.routes.post.get('/api/update')({ body: {}, id: 'req-2' }, second);
  assert.equal(second.statusCode, 409);
  assert.equal(spawned.length, 1, 'a concurrent update must never be spawned');
});

test('the update route has no coupling to the retired on-demand APK builder', async () => {
  const root = createFixture();
  let obsoleteProbeCalls = 0;
  const route = createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions: new Map(),
    spawn() { return createChild(); },
    rootDir: root,
    getApkBuildStatus() {
      obsoleteProbeCalls += 1;
      throw new Error('a retired dependency must never be read');
    },
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const response = createRes();
  await app.routes.post.get('/api/update')({ body: {} }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(obsoleteProbeCalls, 0);
});

test('a running update on disk blocks a new one even in a server that never started it', async () => {
  // This is the restart case: the process that answers the second request is
  // not the one that started the update, so its in-memory flag is false.
  const root = createFixture();
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, UPDATE_LOG_RELATIVE), `${START_MARKER} 2026-08-03T10:00:00Z force=0\nrunning\n`);

  const route = createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions: new Map(),
    spawn() { throw new Error('must not spawn'); },
    rootDir: root,
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);

  const res = createRes();
  await app.routes.post.get('/api/update')({ body: {}, id: 'req-1' }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.status.state, 'running');

  const status = createRes();
  app.routes.get.get('/api/update/status')({}, status);
  assert.equal(status.body.state, 'running');
});

test('the status route survives an unreadable root instead of failing the page', () => {
  const route = createUpdateRoute({
    getChildProxyEnv: async env => ({ ...env, http_proxy: 'http://proxy.test:8080' }),
    chatSessions: new Map(),
    spawn() {},
    rootDir: path.join(os.tmpdir(), 'multicc-does-not-exist-' + process.pid),
    log: { log() {}, error() {} },
  });
  const app = createFakeApp();
  route.mountRoutes(app);
  const res = createRes();
  app.routes.get.get('/api/update/status')({}, res);
  assert.equal(res.body.state, 'idle');
  assert.equal(res.body.running, false);
});

test('server.js wires the update route with the package root and keeps it auth-gated', () => {
  const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.match(hostSrc, /createUpdateRoute\(\{[\s\S]*?rootDir:\s*__dirname/);
  assert.equal(authSrc.includes('/api/update'), false, 'the update route must not be in the auth bypass list');
  const nativeAuth = fs.readFileSync(path.join(__dirname, '..', 'native', 'core', 'src', 'http_entry.rs'), 'utf8');
  assert.equal(nativeAuth.includes('/api/update'), false, 'Rust must keep updates behind authentication');
});

test('代理准备失败阻止更新派生并释放路由占用', async () => {
  const rootDir = createFixture();
  let spawned = false;
  const app = createFakeApp();
  createUpdateRoute({
    rootDir,
    spawn() { spawned = true; return createChild(); },
    getChildProxyEnv: async () => { throw new Error('proxy discovery failed'); },
    log: { log() {}, error() {} },
  }).mountRoutes(app);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = createRes();
    await app.routes.post.get('/api/update')({ body: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'UPDATE_START_FAILED');
  }
  assert.equal(spawned, false);
});

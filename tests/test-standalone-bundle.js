'use strict';

// Standalone bundle suite (scripts/standalone-bundle.js, scripts/standalone-launcher.js,
// scripts/native-arch.js).
//
//   unit        runtime pinning + SHASUMS parsing, .app/plist generation,
//               launcher path/arg/env resolution, native-binary arch parsing
//   integration the real launcher started against tests/fixtures/desktop-fixture-server.js:
//               bundled-runtime layout → free port → readiness gate → pid bookkeeping
//               → `--stop` drain → nothing left behind
//   gates       the native-module architecture check that keeps a build host's
//               arm64 addon out of an x64 bundle
//
// Offline by design: no bundle is downloaded or built here, and the network is
// never used. The launcher runs under the test's own Node (its spawn target is
// process.execPath), exactly like it does under Resources/runtime/bin/node.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'standalone-launcher.js');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'desktop-fixture-server.js');

const bundleScript = require(path.join(ROOT, 'scripts', 'standalone-bundle.js'));
const launcherScript = require(path.join(ROOT, 'scripts', 'standalone-launcher.js'));
const cliScript = require(path.join(ROOT, 'scripts', 'standalone-cli.js'));
const nativeArch = require(path.join(ROOT, 'scripts', 'native-arch.js'));

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

async function httpStatus(url, { timeoutMs = 2_000 } = {}) {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    try { await res.arrayBuffer(); } catch (_) {}
    return res.status;
  } catch (_) { return 0; }
}

function readPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

// A minimal bundle: only Resources/app-server/server.js is needed to drive the
// launcher end to end; the fixture replaces the real server.
function stageFakeServer(resourcesDir) {
  const appServer = path.join(resourcesDir, 'app-server');
  fs.mkdirSync(appServer, { recursive: true });
  fs.writeFileSync(path.join(appServer, 'server.js'), `require(${JSON.stringify(FIXTURE)});\n`);
  return appServer;
}

test('runtime pinning: SHASUMS parsing, dist names and the macOS floor', () => {
  const name = 'node-v22.23.2-darwin-x64.tar.gz';
  const text = `aaaa  other-file.tar.gz\n${'b'.repeat(64)}  *${name}\n`;
  assert.equal(bundleScript.nodeDistFileName('22.23.2', 'darwin', 'x64'), name);
  assert.equal(bundleScript.nodeDistFileName('22.23.2', 'win32', 'x64'), 'node-v22.23.2-win-x64.zip');
  assert.equal(bundleScript.nodeDistUrl('22.23.2', 'linux', 'arm64'),
    'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.gz');
  assert.equal(bundleScript.parseShasums(text, name), 'b'.repeat(64));
  assert.equal(bundleScript.parseShasums(text, 'node-v24.0.0-darwin-x64.tar.gz'), null,
    'a missing checksum entry must be reported, never guessed');

  assert.deepEqual(bundleScript.assertNodeVersionSupported('22.23.2'), { major: 22, minor: 23 });
  assert.throws(() => bundleScript.assertNodeVersionSupported('20.19.0'), /below the server floor/);
  assert.throws(() => bundleScript.assertNodeVersionSupported('22.15.0'), /below the server floor/);

  // The floor is the whole point of pinning: Node 24+ builds need macOS 13.5.
  assert.equal(bundleScript.macosFloorForNode('22.23.2'), '11.0');
  assert.equal(bundleScript.macosFloorForNode('24.9.0'), '13.5');
  assert.equal(bundleScript.MACOS_FLOOR, '11.0');
});

test('standalone updater compares SemVer and never mistakes an older release for an upgrade', () => {
  assert.equal(cliScript.compareVersions('2.0.4', '2.0.3'), 1);
  assert.equal(cliScript.compareVersions('v2.0.4', '2.0.4'), 0);
  assert.equal(cliScript.compareVersions('2.0.3', '2.0.4'), -1);
  assert.equal(cliScript.compareVersions('2.0.4-beta.2', '2.0.4-beta.1'), 1);
  assert.equal(cliScript.compareVersions('2.0.4-beta.1', '2.0.4'), -1);
  assert.equal(cliScript.compareVersions('2.0.4+build.7', '2.0.4+build.2'), 0);
  assert.equal(cliScript.compareVersions('not-a-version', '2.0.4'), null);
});

test('macOS shell: app layout, plist floor and wrapper indirection', () => {
  const plist = bundleScript.macosInfoPlist({ version: '2.0.2', resourcesName: 'Resources' });
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>MultiCC<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>io\.github\.lsjwzh\.multicc\.standalone<\/string>/);
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>11\.0<\/string>/,
    'the .app must declare the Node 22 floor, not whatever the build host runs');
  assert.match(plist, /<string>2\.0\.2<\/string>/);

  const entry = bundleScript.macosLauncherScript();
  assert.match(entry, /exec "\$RESOURCES\/runtime\/bin\/node" "\$RESOURCES\/launcher\/standalone-launcher\.js" --start/,
    'the .app must always run the BUNDLED runtime');
  assert.doesNotMatch(entry, /\bnode\b(?!.*RESOURCES)/s, 'never fall back to a host node');

  // Every double-click wrapper is a thin shell over the one documented command,
  // so a wrapper can never drift from what `multicc` itself does.
  assert.match(bundleScript.macosCommandScript({ subcommand: 'start' }), /"\$HERE\/multicc" start/,
    'the double-click wrapper must go through the multicc command');
  assert.doesNotMatch(bundleScript.posixScript({ subcommand: 'stop' }), /standalone-launcher\.js/,
    'wrappers must not call the launcher behind the CLI\'s back');

  const cliWrapper = bundleScript.multiccWrapper({ platform: 'darwin' });
  assert.match(cliWrapper, /exec "\$RESOURCES\/runtime\/bin\/node" "\$RESOURCES\/launcher\/standalone-cli\.js" "\$@"/,
    'the multicc command must run the BUNDLED runtime and the CLI, not a host node');
  assert.match(cliWrapper, /MultiCC\.app\/Contents\/Resources/,
    'on macOS the command has to reach through the .app');

  if (process.platform === 'darwin') {
    const dir = tmpdir('multicc-standalone-plist-');
    const plistPath = path.join(dir, 'Info.plist');
    fs.writeFileSync(plistPath, plist);
    const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(lint.status, 0, `plutil rejected the generated Info.plist: ${lint.stdout}${lint.stderr}`);
  }
});

test('launcher paths and env: platform data dirs, bundled runtime, loopback child env', () => {
  assert.equal(launcherScript.standaloneDataDir({ platform: 'darwin', env: {}, homedir: '/Users/x' }),
    '/Users/x/Library/Application Support/MultiCCStandalone');
  assert.equal(launcherScript.standaloneDataDir({ platform: 'linux', env: {}, homedir: '/home/x' }),
    '/home/x/.config/MultiCCStandalone');
  assert.equal(launcherScript.standaloneDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Roaming' }, homedir: 'C:\\Users\\x' }),
    path.join('C:\\Roaming', 'MultiCCStandalone'));
  assert.equal(launcherScript.standaloneDataDir({ platform: 'darwin', env: { MULTICC_STANDALONE_HOME: '/tmp/x' }, homedir: '/Users/x' }),
    '/tmp/x', 'MULTICC_STANDALONE_HOME wins everywhere (tests, USB installs)');

  const resources = '/bundle/MultiCC.app/Contents/Resources';
  const paths = launcherScript.resolveStandalonePaths({
    resources, platform: 'darwin', env: { MULTICC_STANDALONE_HOME: '/tmp/data' }, homedir: '/Users/x',
  });
  assert.equal(paths.runtimeNode, path.join(resources, 'runtime', 'bin', 'node'));
  assert.equal(paths.launcherPath, path.join(resources, 'launcher', 'standalone-launcher.js'));
  assert.equal(paths.desktopEnv.serverEntry, path.join(resources, 'app-server', 'server.js'));
  assert.equal(paths.desktopEnv.dataRoot, path.join('/tmp/data', 'data'));
  assert.equal(paths.desktopEnv.logsDir, path.join('/tmp/data', 'logs'));
  assert.equal(paths.desktopEnv.runtimeInfoFile, path.join('/tmp/data', 'desktop-runtime.json'));

  const desktopEnv = paths.desktopEnv;
  const env = launcherScript.buildStandaloneChildEnv({
    port: 4123,
    desktopEnv,
    baseEnv: { PATH: '/usr/bin:/bin', PORT: '9999', HOST: '0.0.0.0' },
    dotenv: { HOST: '0.0.0.0', CUSTOM_TOKEN: 'from-dotenv', PATH: '/dotenv/bin' },
    runtimeNode: paths.runtimeNode,
  });
  assert.equal(env.PORT, '4123');
  assert.equal(env.HOST, '127.0.0.1', 'a stale .env must never widen the loopback bind');
  assert.equal(env.MULTICC_DATA_DIR, path.join('/tmp/data', 'data'));
  assert.equal(env.MULTICC_DESKTOP, '1');
  assert.equal(env.CUSTOM_TOKEN, 'from-dotenv', 'dotenv fills gaps only');
  assert.ok(env.PATH.startsWith(`${path.join(resources, 'runtime', 'bin')}${path.delimiter}`),
    'the bundled runtime must come first so session CLIs use Node 22 too');
  assert.match(env.PATH, /:\/usr\/bin:\/bin$/, 'the host PATH must be kept, just demoted');

  assert.deepEqual(launcherScript.parseArgs(['--stop']), {
    mode: 'stop', open: true, detach: false, detachedChild: false,
    port: null, data: null, resources: null, help: false,
  });
  assert.equal(launcherScript.parseArgs(['--start', '--no-open', '--detach', '--port', '3210']).port, 3210);
  assert.equal(launcherScript.browserCommand('http://127.0.0.1:3000', 'darwin').command, 'open');
  assert.equal(launcherScript.browserCommand('http://127.0.0.1:3000', 'linux').command, 'xdg-open');
});

test('auto-start has one CLI contract across launchd, systemd and Windows Startup', () => {
  assert.equal(cliScript.serviceUnitPath('darwin', '/Users/x', {}),
    path.join('/Users/x', 'Library', 'LaunchAgents', 'com.multicc.server.plist'));
  assert.equal(cliScript.serviceUnitPath('linux', '/home/x', { XDG_CONFIG_HOME: '/cfg' }),
    path.join('/cfg', 'systemd', 'user', 'multicc.service'));
  assert.equal(cliScript.serviceUnitPath('win32', 'C:\\Users\\x', { APPDATA: 'C:\\Roaming' }),
    path.join('C:\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'MultiCC.vbs'));

  const startup = cliScript.windowsStartupScript(
    'C:\\Program Files\\MultiCC\\Resources\\runtime\\node.exe',
    'C:\\Program Files\\MultiCC\\Resources\\launcher\\standalone-launcher.js',
  );
  assert.match(startup, /WScript\.Shell/);
  assert.match(startup, /MULTICC_SERVICE/);
  assert.match(startup, /--start --no-open/);
  assert.match(startup, /shell\.Run .*?, 0, False/,
    'the Startup entry must run invisibly and must not block Windows login');
  assert.match(startup, /Program Files/,
    'paths containing spaces must remain quoted inside the generated VBS');
});

test('native arch: Mach-O, ELF, PE and universal headers are read, mismatches are fatal', () => {
  const macho = Buffer.alloc(32);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(0x01000007, 4); // x86_64
  assert.equal(nativeArch.machoArch(macho), 'x64');
  macho.writeUInt32LE(0x0100000c, 4);
  assert.equal(nativeArch.machoArch(macho), 'arm64');
  macho.writeUInt32LE(0xbebafeca, 0);
  assert.equal(nativeArch.machoArch(macho), 'universal');

  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]).copy(elf, 0);
  elf.writeUInt16LE(0xb7, 18);
  assert.equal(nativeArch.elfArch(elf), 'arm64');
  elf.writeUInt16LE(0x3e, 18);
  assert.equal(nativeArch.elfArch(elf), 'x64');

  const pe = Buffer.alloc(0x80);
  pe.write('MZ', 0);
  pe.writeUInt32LE(0x40, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x40); // 'PE\0\0'
  pe.writeUInt16LE(0x8664, 0x44);
  assert.equal(nativeArch.peArch(pe), 'x64');
  pe.writeUInt16LE(0xaa64, 0x44);
  assert.equal(nativeArch.peArch(pe), 'arm64');
  assert.equal(nativeArch.nativeBinaryArch(__filename), 'unknown', 'plain JS must not look like a binary');
  assert.equal(nativeArch.nativeBinaryPlatform(__filename), null, 'plain JS belongs to no platform');

  const dir = tmpdir('multicc-native-arch-');
  const armDir = path.join(dir, 'node_modules', 'addon', 'build', 'Release');
  fs.mkdirSync(armDir, { recursive: true });
  // A real arm64 addon: the "universal" mutation above must not leak into it.
  const arm64Addon = Buffer.alloc(32);
  arm64Addon.writeUInt32LE(0xfeedfacf, 0);
  arm64Addon.writeUInt32LE(0x0100000c, 4);
  assert.equal(nativeArch.machoArch(arm64Addon), 'arm64');
  fs.writeFileSync(path.join(armDir, 'addon.node'), arm64Addon);
  fs.mkdirSync(path.join(dir, 'node_modules', 'addon', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'addon', 'src', 'ignored.node'), arm64Addon);
  const found = nativeArch.collectNativeBinaries(path.join(dir, 'node_modules'));
  assert.equal(found.length, 1, 'build inputs under src/ must not be counted as loadable addons');

  const silent = { log() {}, error() {} };
  // The x64 dmg shipped from an arm64 runner: this is what must fail the build.
  assert.throws(() => nativeArch.verifyNativeArch({ root: dir, arch: 'x64', platform: 'darwin', logger: silent }),
    /expected darwin\/x64 native binaries, found: .*addon\.node \(arm64\)/);
  assert.equal(nativeArch.verifyNativeArch({ root: dir, arch: 'arm64', logger: silent }).count, 1);
  assert.throws(() => nativeArch.verifyNativeArch({ root: tmpdir('multicc-native-empty-'), arch: 'x64', logger: silent }),
    /no native binaries/);
  assert.equal(nativeArch.verifyNativeArch({ root: tmpdir('multicc-native-empty-'), arch: 'x64', logger: silent, allowNone: true }).count, 0);

  // Right arch, wrong OS: a linux-x64 addon inside a darwin-x64 tree installs
  // cleanly and only fails on the user's machine, exactly like the arm64 one.
  const wrongOs = tmpdir('multicc-native-wrong-os-');
  const elfDir = path.join(wrongOs, 'node_modules', 'addon', 'build', 'Release');
  fs.mkdirSync(elfDir, { recursive: true });
  const elfX64 = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]).copy(elfX64, 0);
  elfX64.writeUInt16LE(0x3e, 18); // x86_64
  const elfAddon = path.join(elfDir, 'addon.node');
  fs.writeFileSync(elfAddon, elfX64);
  assert.equal(nativeArch.nativeBinaryPlatform(elfAddon), 'linux');
  assert.throws(() => nativeArch.verifyNativeArch({ root: wrongOs, arch: 'x64', platform: 'darwin', logger: silent }),
    /expected darwin\/x64 native binaries, found: .*addon\.node \(linux file\)/);
  assert.equal(nativeArch.verifyNativeArch({ root: wrongOs, arch: 'x64', platform: 'linux', logger: silent }).count, 1);
});

test('launcher supervises the server end to end and --stop leaves nothing behind', { timeout: 180_000 }, async () => {
  const scratch = tmpdir('multicc-standalone-e2e-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  const port = await reservePort();

  const launcherArgs = ['--resources', resources, '--data', dataDir, '--port', String(port), '--no-open'];
  const child = spawn(process.execPath, [LAUNCHER, '--start', ...launcherArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  let stopRun = null;
  try {
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 200,
      { timeoutMs: 60_000, what: 'the supervised server to answer /readyz' });

    const runtimeInfoFile = path.join(dataDir, 'desktop-runtime.json');
    const info = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(runtimeInfoFile, 'utf8')); } catch (_) { return null; }
    }, { timeoutMs: 10_000, what: 'desktop-runtime.json' });
    assert.equal(info.port, port);
    assert.equal(info.origin, `http://127.0.0.1:${port}`);
    assert.ok(readPidAlive(info.pid), 'the server pid from runtime info must be alive');

    const pidFile = path.join(dataDir, 'standalone-launcher.pid');
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), child.pid,
      'the supervising launcher must record itself so --stop can drain instead of yanking the child');

    const status = spawnSync(process.execPath, [LAUNCHER, '--status', ...launcherArgs.slice(0, 4)], { encoding: 'utf8' });
    assert.match(`${status.stdout}${status.stderr}`, new RegExp(`running at http://127\\.0\\.0\\.1:${port}`));

    // A second start must reuse the running instance rather than fight it.
    const secondStart = spawnSync(process.execPath, [LAUNCHER, '--start', ...launcherArgs], { encoding: 'utf8' });
    assert.match(`${secondStart.stdout}${secondStart.stderr}`, /already running/);

    stopRun = spawnSync(process.execPath, [LAUNCHER, '--stop', ...launcherArgs.slice(0, 4)], { encoding: 'utf8' });
    assert.match(`${stopRun.stdout}${stopRun.stderr}`, /stopped \(launcher signal\)/,
      'stopping must go through the supervisor, otherwise it just respawns the server');
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 0,
      { timeoutMs: 30_000, what: 'the server to go away' });
    assert.equal(fs.existsSync(pidFile), false, 'the pid file must be cleaned up');
    assert.equal(readPidAlive(info.pid), false, 'no orphaned server may survive --stop');
    await waitFor(() => child.exitCode !== null, { timeoutMs: 20_000, what: 'the launcher to exit' });
    assert.equal(child.exitCode, 0, `launcher exited ${child.exitCode}\n${output}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// The app's own configuration: MultiCC.app execs the launcher in the
// FOREGROUND (no --detach), so the launcher process *is* the app — if it exits,
// the app is gone, and with it any chance of bringing the server back. A server
// that exits on its own (a crash, or the graceful exit /api/restart performs in
// desktop mode) must therefore be respawned by a launcher that is still there,
// long after its readiness probe's sockets are gone. It was not: the app
// vanished inside the restart backoff and standalone.log ended at
// "server exited (code=0); restarting", which is exactly what the reporting
// user saw. Six seconds past readiness is the point of the test — a short delay
// hides the bug behind leftover probe handles.
test('a foreground launcher outlives a dead server and brings it back', { timeout: 180_000 }, async () => {
  const scratch = tmpdir('multicc-standalone-respawn-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  const port = await reservePort();
  const launcherArgs = ['--resources', resources, '--data', dataDir, '--port', String(port), '--no-open'];
  const child = spawn(process.execPath, [LAUNCHER, '--start', ...launcherArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, READY_DELAY_MS: '50', EXIT_AFTER_READY_MS: '6000', EXIT_CODE: '1' },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitFor(() => (output.match(/server ready at/g) || []).length >= 2, {
      timeoutMs: 90_000,
      what: 'the supervised server to be brought back after it exited',
    });
    assert.equal(child.exitCode, null,
      `the foreground launcher (the app itself) must still be running\n${output}`);

    // And it is still a well-behaved supervisor: --stop is how the app quits.
    // Note the async spawn: spawnSync would block this process's event loop for
    // the whole call, so the launcher's exit could not be reaped here and
    // pidAlive() would keep reporting a zombie as alive — --stop then waits out
    // its full 20s window and tree-kills a process that already exited.
    const stopChild = spawn(process.execPath, [LAUNCHER, '--stop', ...launcherArgs.slice(0, 4)]);
    let stopOutput = '';
    stopChild.stdout.on('data', chunk => { stopOutput += chunk; });
    stopChild.stderr.on('data', chunk => { stopOutput += chunk; });
    await waitFor(() => stopChild.exitCode !== null, { timeoutMs: 60_000, what: '--stop to return' });
    assert.match(stopOutput, /stopped \(launcher signal\)/,
      'a launcher that just respawned still has to drain on --stop');
    await waitFor(() => child.exitCode !== null, { timeoutMs: 30_000, what: 'the launcher to exit' });
    assert.equal(child.exitCode, 0, `launcher exited ${child.exitCode}\n${output}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// One data directory, one launcher. Two launchers there is the state that wedged
// the reporting user's tasks: the second one starts because the first is still
// booting (/readyz is not 200 yet and desktop-runtime.json does not exist yet, so
// "is anything running?" answers no), reclaim finds no orphan, and it walks to
// the next free port — after which two servers write the same SQLite files and
// the same workspace lease registry, and the newcomer's recovery pass rewrites
// the first one's live lease to `uncertain` until it expires.
test('a second launcher refuses to start while the first is still booting', { timeout: 180_000 }, async () => {
  const scratch = tmpdir('multicc-standalone-single-instance-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  const port = await reservePort();
  const launcherArgs = ['--resources', resources, '--data', dataDir, '--port', String(port), '--no-open'];
  const pidFile = path.join(dataDir, 'standalone-launcher.pid');

  // Hold the first launcher inside its boot window: the fixture answers 503 on
  // /readyz for this long, so nothing about the running server is discoverable.
  const first = spawn(process.execPath, [LAUNCHER, '--start', ...launcherArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, READY_DELAY_MS: '8000' },
  });
  let firstOutput = '';
  first.stdout.on('data', chunk => { firstOutput += chunk; });
  first.stderr.on('data', chunk => { firstOutput += chunk; });
  try {
    await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) === first.pid; } catch (_) { return false; }
    }, { timeoutMs: 20_000, what: 'the first launcher to record itself' });
    assert.equal(fs.existsSync(path.join(dataDir, 'desktop-runtime.json')), false,
      'the boot window is the point: the server is spawned but nothing is ready yet');

    const second = spawnSync(process.execPath, [LAUNCHER, '--start', ...launcherArgs], { encoding: 'utf8' });
    const secondOutput = `${second.stdout}${second.stderr}`;
    assert.equal(second.status, 1, `a duplicate start must fail, not start a second server\n${secondOutput}`);
    assert.match(secondOutput, /another launcher \(pid \d+\) already owns/);
    assert.match(secondOutput, /multicc stop/, 'and say how to get out of it');
    assert.doesNotMatch(secondOutput, /server ready at/, 'no second server may have been started');
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), first.pid,
      'the refusal must leave the owner and its pid file untouched');
    assert.equal(await httpStatus(`http://127.0.0.1:${port + 1}/readyz`), 0,
      'and must not have walked on to the next port');
  } finally {
    // Async, never spawnSync: this process is the launcher's parent, so blocking
    // its loop would leave the launcher unreaped (a zombie answers pidAlive) and
    // --stop would spend its whole 20s window before tree-killing a dead process.
    // A launcher killed in the boot window dies by signal, so `exitCode` stays
    // null — the exit is visible as `signalCode`.
    const stopChild = spawn(process.execPath, [LAUNCHER, '--stop', ...launcherArgs.slice(0, 4)]);
    let stopOutput = '';
    stopChild.stdout.on('data', chunk => { stopOutput += chunk; });
    stopChild.stderr.on('data', chunk => { stopOutput += chunk; });
    await waitFor(() => stopChild.exitCode !== null, { timeoutMs: 60_000, what: '--stop to return' });
    assert.match(stopOutput, /stopped/, `--stop must drain the booting launcher\n${stopOutput}`);
    await waitFor(() => first.exitCode !== null || first.signalCode !== null,
      { timeoutMs: 30_000, what: 'the first launcher to exit' });
    // And the server it had already spawned is not left behind: nothing answers on
    // its port, and the data directory holds no claim on it any more.
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 0,
      { timeoutMs: 30_000, what: 'the boot-window server to go away' });
    assert.equal(fs.existsSync(pidFile), false, 'the pid file must not outlive the launcher');
    if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL');
  }
});

// The pid file is the single-instance lock, but it is also what a launcher that
// was SIGKILLed or lost power leaves behind. Pids get recycled, so liveness alone
// cannot mean ownership: refusing a start on a stranger's pid would send the user
// to `multicc stop`, which signals whatever wears the number. Ownership is
// decided by asking the process what it is, and a file nobody owns is taken over.
test('ownership of the data directory is proved, and a stale pid file is taken over', async () => {
  const scratch = tmpdir('multicc-standalone-stale-pid-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  fs.mkdirSync(dataDir, { recursive: true });
  const pidFile = path.join(dataDir, 'standalone-launcher.pid');
  const paths = launcherScript.resolveStandalonePaths({
    resources, env: { ...process.env, MULTICC_STANDALONE_HOME: dataDir },
  });
  const silent = { log() {}, error() {} };
  // Alive, and never us: the pid file's number can belong to anyone.
  const recycled = process.ppid;
  const LAUNCHER_CMD = `${process.execPath} /opt/MultiCC/Resources/launcher/standalone-launcher.js --start\n`;
  const build = (readProcessCommandLine, extra = {}) => launcherScript.createLauncher({
    paths,
    logger: silent,
    readProcessCommandLine,
    reclaimImpl: async () => ({ reclaimed: false }),
    findFreePortImpl: async () => 45678,
    ...extra,
  });

  const stranger = build(() => '/usr/bin/some-unrelated-daemon --foo\n');
  fs.writeFileSync(pidFile, `${recycled}\n`);
  assert.equal(stranger.otherLauncher(), null, 'a recycled pid is not an owner');
  // Unidentifiable is not ownership either: this is the Windows shape (and `ps`
  // missing elsewhere). Treating it as an owner would refuse the start and point
  // the user at `multicc stop`, which signals whatever holds the number.
  assert.equal(build(() => null).otherLauncher(), null,
    'a pid whose process cannot be asked is not an owner');

  const real = build(() => LAUNCHER_CMD);
  assert.equal(real.otherLauncher()?.pid, recycled, 'a launcher command line is');
  assert.equal(real.otherLauncher(process.pid), null, 'and a launcher never counts itself');
  assert.equal(real.otherLauncher(999_999), null, 'a dead pid neither');

  // Ownership is taken, not assumed: the lock is created with O_EXCL, so two
  // starts arriving in the same instant cannot both win.
  let pidFileWhenSpawning = null;
  const claiming = build(() => '/usr/bin/some-unrelated-daemon --foo\n', {
    createSupervisor: ({ onPhase }) => ({
      async start() {
        pidFileWhenSpawning = fs.readFileSync(pidFile, 'utf8').trim();
        onPhase('failed', { reason: 'test-only' });
      },
      getState: () => ({ childPid: null }),
      async stop() {},
    }),
  });
  await assert.rejects(claiming.start({}), /server failed: test-only/);
  assert.equal(pidFileWhenSpawning, String(process.pid),
    'the stale file is replaced by ours before anything is spawned');
  assert.equal(fs.existsSync(pidFile), false, 'and a launcher that failed clears its own claim');

  // A live launcher, on the other hand, is left alone.
  fs.writeFileSync(pidFile, `${recycled}\n`);
  const refused = await real.start({});
  assert.equal(refused.refused, 'launcher-owned');
  assert.equal(refused.started, false);
  assert.equal(refused.pid, recycled);
  assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), recycled,
    'a refusal never rewrites the owner pid');
  fs.rmSync(pidFile, { force: true });
});

test('--detach hands off to a background launcher that --stop can still drain', { timeout: 180_000 }, async () => {
  const scratch = tmpdir('multicc-standalone-detach-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  const port = await reservePort();
  const launcherArgs = ['--resources', resources, '--data', dataDir, '--port', String(port), '--no-open'];

  // What "启动 MultiCC.command" (and any double-click wrapper) does: the
  // launcher spawns the real supervisor detached and exits. That child used to
  // die on an unrecognized internal flag, with stdio ignored — a start that
  // looked successful and did nothing.
  const parent = spawnSync(process.execPath, [LAUNCHER, '--start', '--detach', ...launcherArgs], { encoding: 'utf8' });
  assert.match(`${parent.stdout}${parent.stderr}`, /starting in the background/);

  const pidFile = path.join(dataDir, 'standalone-launcher.pid');
  let owner = null;
  let serverPid = null;
  // A failing assertion must not leave a detached supervisor and its server
  // behind: SIGKILLing the supervisor alone orphans the child (that is exactly
  // why --stop asks it to drain). Read the server pid defensively instead.
  const serverPidFromDisk = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-runtime.json'), 'utf8')).pid || null; }
    catch (_) { return null; }
  };
  try {
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 200,
      { timeoutMs: 60_000, what: 'the detached launcher to bring the server up' });
    owner = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const info = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-runtime.json'), 'utf8')); }
      catch (_) { return null; }
    }, { timeoutMs: 10_000, what: 'desktop-runtime.json of the detached supervisor' });
    serverPid = info.pid;
    assert.ok(readPidAlive(owner), 'the detached supervisor must be alive');
    assert.notEqual(owner, process.pid, 'the pid file must name the detached child, not this process');
    assert.equal(readPidAlive(serverPid), true, 'the detached supervisor must own the server');

    const stopRun = spawnSync(process.execPath, [LAUNCHER, '--stop', ...launcherArgs.slice(0, 4)], { encoding: 'utf8' });
    assert.match(`${stopRun.stdout}${stopRun.stderr}`, /stopped/);
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 0,
      { timeoutMs: 30_000, what: 'the detached server to go away' });
    await waitFor(() => !readPidAlive(owner) && !readPidAlive(serverPid),
      { timeoutMs: 30_000, what: 'no detached process to survive --stop' });
    assert.equal(fs.existsSync(pidFile), false, 'the detached launcher must clean its pid file up');
  } finally {
    for (const pid of [serverPid, serverPidFromDisk(), owner]) {
      if (pid && readPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  }
});

// Windows has no signals: `process.kill(pid, 'SIGTERM')` there terminates the
// supervising launcher outright and leaves the server it was supervising
// orphaned — the supervisor only drains on request. So the stop request goes
// through a marker file the supervisor polls. That path is exercised here with
// platform forced to win32, on a real detached supervisor, because it cannot be
// reached by running the CLI on macOS.
test('--stop on Windows asks the supervisor through the stop marker, not a signal', { timeout: 180_000 }, async () => {
  const scratch = tmpdir('multicc-standalone-win-stop-');
  const resources = path.join(scratch, 'Resources');
  const dataDir = path.join(scratch, 'userdata');
  stageFakeServer(resources);
  const port = await reservePort();
  const launcherArgs = ['--resources', resources, '--data', dataDir, '--port', String(port), '--no-open'];

  let owner = null;
  let serverPid = null;
  const serverPidFromDisk = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-runtime.json'), 'utf8')).pid || null; }
    catch (_) { return null; }
  };
  try {
    const parent = spawnSync(process.execPath, [LAUNCHER, '--start', '--detach', ...launcherArgs], { encoding: 'utf8' });
    assert.match(`${parent.stdout}${parent.stderr}`, /starting in the background/);
    await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/readyz`)) === 200,
      { timeoutMs: 60_000, what: 'the detached supervisor to bring the server up' });
    owner = Number(fs.readFileSync(path.join(dataDir, 'standalone-launcher.pid'), 'utf8').trim());
    serverPid = await waitFor(serverPidFromDisk, { timeoutMs: 10_000, what: 'the server pid' });

    const paths = launcherScript.resolveStandalonePaths({
      resources, env: { ...process.env, MULTICC_STANDALONE_HOME: dataDir },
    });
    const { createLauncher } = launcherScript;
    const windowsLauncher = createLauncher({
      paths,
      platform: 'win32',
      logger: { log() {}, error() {} },
      spawnImpl: spawn,
    });
    const result = await windowsLauncher.stop();

    assert.equal(result.ownerSignalled, true, 'the supervisor must be asked to stop, not killed');
    const markerFile = path.join(dataDir, 'standalone-launcher.stop');
    assert.equal(fs.existsSync(markerFile), false, 'the consumed stop request must not be left behind');
    await waitFor(() => !readPidAlive(serverPid) && !readPidAlive(owner),
      { timeoutMs: 30_000, what: 'both the supervisor and its server to exit' });
    assert.equal(await httpStatus(`http://127.0.0.1:${port}/readyz`), 0, 'the port must be free again');
  } finally {
    for (const pid of [serverPid, serverPidFromDisk(), owner]) {
      if (pid && readPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
  }
});

test('the runtime binary sits where each platform\'s official archive puts it', () => {
  // The win-x64 zip has node.exe at the runtime root; the unix tarballs have
  // bin/node. Writing the Windows bundle died on this ("runtime archive has no
  // bin/node.exe") the first time it was ever built.
  assert.equal(bundleScript.runtimeNodePath('/b/Resources', 'win32'), path.join('/b/Resources', 'runtime', 'node.exe'));
  assert.equal(bundleScript.runtimeNodePath('/b/Resources', 'darwin'), path.join('/b/Resources', 'runtime', 'bin', 'node'));
  assert.equal(bundleScript.runtimeNodePath('/b/Resources', 'linux'), path.join('/b/Resources', 'runtime', 'bin', 'node'));

  const launcherSource = fs.readFileSync(LAUNCHER, 'utf8');
  assert.match(launcherSource, /platform === 'win32'\s*\n\s*\? path\.join\(resources, 'runtime', 'node\.exe'\)/,
    'the launcher must resolve the same path the builder writes');
  assert.match(bundleScript.multiccWrapperWindows(), /%RESOURCES%\\runtime\\node\.exe/,
    'the Windows multicc.cmd must call the bundled node.exe');
  assert.match(bundleScript.multiccWrapperWindows(), /launcher\\standalone-cli\.js/,
    'the Windows multicc.cmd must run the CLI, not only the launcher');
  assert.doesNotMatch(bundleScript.multiccWrapperWindows(), /Resources\\runtime\\bin\\node\.exe/,
    'no bin/ level exists on Windows');
  assert.doesNotMatch(bundleScript.multiccWrapper({ platform: 'linux' }), /node\.exe/,
    'the POSIX wrapper must not look for a Windows binary');
});

test('every Windows script is written with CRLF line endings', () => {
  // v2.0.5 shipped an LF-only multicc.cmd. cmd.exe advances through a batch
  // file by byte offset assuming CRLF, so the offset drifted one byte per line
  // until it resumed mid-token, and the Windows smoke test failed with
  // `'m' is not recognized as an internal or external command` — line 2's
  // `rem` split into `re` + `m`. The bundle is built on macOS and Linux, so
  // nothing but this conversion can keep the endings right.
  const win = bundleScript.windowsScript(bundleScript.multiccWrapperWindows());
  assert.ok(!/(^|[^\r])\n/.test(win), 'no bare LF may survive in a .cmd');
  assert.ok(win.includes('\r\n'), 'the .cmd must use CRLF');
  assert.ok(!win.split('\r\n').some(line => line.includes('\n')), 'CRLF only');

  // A .cmd written for win32 must be CRLF; the POSIX wrappers must not be.
  const scratch = tmpdir('multicc-win-eol-');
  const bundleDir = path.join(scratch, 'bundle');
  const resourcesDir = path.join(bundleDir, 'Resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  bundleScript.writePlatformShell({
    bundleDir, resourcesDir, version: '1.0.0', platform: 'win32', nodeVersion: '22.0.0',
    logger: { log() {} },
  });
  for (const name of ['multicc.cmd', 'Start-MultiCC.cmd', 'Stop-MultiCC.cmd', 'Status-MultiCC.cmd']) {
    const written = fs.readFileSync(path.join(bundleDir, name), 'utf8');
    assert.ok(!/(^|[^\r])\n/.test(written), `${name} must be CRLF`);
  }
  // The guard is deliberately a single physical line: multi-line `if (` blocks
  // are what cmd.exe's offset drift corrupts first.
  assert.equal(bundleScript.multiccWrapperWindows().split('\n').filter(l => l.trim().startsWith('if not exist')).length, 1,
    'the runtime guard must be one line');
  assert.doesNotMatch(bundleScript.multiccWrapperWindows(), /\n\s*(echo|exit \/b)/,
    'no multi-line construct in the Windows wrapper');
});

test('the Windows bundle is zipped by us, not by a platform-specific tool', async () => {
  const { createZipArchive, collectEntries } = require(path.join(ROOT, 'scripts', 'zip-archive.js'));
  const { readZip } = require(path.join(ROOT, 'src', 'session', 'handoff-zip.js'));
  const scratch = tmpdir('multicc-zip-archive-');
  const root = path.join(scratch, 'multicc-standalone-1.0.0-win32-x64');
  fs.mkdirSync(path.join(root, 'Resources', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Resources', '使用说明.txt'), 'standalone\n');
  fs.mkdirSync(path.join(root, 'Resources', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Resources', 'runtime', 'node.exe'), 'MZ');
  fs.writeFileSync(path.join(root, 'Resources', 'big.bin'), Buffer.alloc(4096, 7));

  const entries = collectEntries(root, { logger: { log() {} } });
  assert.ok(entries.some(entry => entry.name === 'Resources/使用说明.txt'));
  assert.ok(entries.some(entry => entry.name === 'Resources/empty/'), 'empty directories must survive the round trip');

  const out = path.join(scratch, 'bundle.zip');
  const result = createZipArchive({ rootDir: root, out, logger: { log() {} } });
  assert.equal(result.entries, entries.length);
  assert.ok(fs.statSync(out).size > 0);

  // Reading it back with the repo's own reader proves structure and CRCs; the
  // same writer feeds users, so a corrupt archive would be a shipped artifact.
  const read = readZip(fs.readFileSync(out));
  const byName = new Map(read.map(entry => [entry.name, entry.data]));
  assert.equal(byName.get('multicc-standalone-1.0.0-win32-x64/Resources/使用说明.txt').toString('utf8'), 'standalone\n');
  assert.equal(byName.get('multicc-standalone-1.0.0-win32-x64/Resources/runtime/node.exe').toString('utf8'), 'MZ');
  assert.equal(byName.get('multicc-standalone-1.0.0-win32-x64/Resources/big.bin').length, 4096);
  assert.equal(byName.has('multicc-standalone-1.0.0-win32-x64/Resources/empty/'), false,
    'directory entries carry no data and the reader drops them');
});

test('standalone build wiring: lifecycle lib is shared with the desktop shell, not forked', () => {
  assert.deepEqual(bundleScript.LAUNCHER_LIB_FILES, [
    'port-chooser.js', 'health-probe.js', 'backend-supervisor.js', 'orphan-reclaim.js', 'desktop-env.js',
  ]);
  for (const file of bundleScript.LAUNCHER_LIB_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'desktop', 'lib', file)), `${file} must exist in desktop/lib`);
  }
  const source = fs.readFileSync(LAUNCHER, 'utf8');
  assert.match(source, /require\(path\.join\(LIB_DIR, 'backend-supervisor'\)\)/,
    'the launcher must reuse the shared supervisor, never a copy');
  assert.doesNotMatch(source, /require\('\.\/lib\//,
    'no literal ./lib require: in the repo those modules live in desktop/lib');

  // The build must pin the runtime target, or a prebuilt binary is fetched for
  // the BUILD HOST (ABI 147 on a Node 26 box) instead of the bundled Node 22's.
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'standalone-bundle.js'), 'utf8');
  assert.match(build, /npm_config_target: nodeVersion/);
  assert.match(build, /npm_config_arch: arch/);
  // Storage must be proved against the bundled runtime itself: this is the
  // check that would catch a pinned runtime without a working node:sqlite.
  assert.match(build, /verifyRuntimeSqlite\(\{/);
  assert.match(build, /node:sqlite/);
});

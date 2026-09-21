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

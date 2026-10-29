'use strict';

// desktop/lib/desktop-updater.js — the in-app desktop updater. No electron and
// no real network or OS: fetch, spawn, the app pid and the clock are all
// injected, so the whole download → verify → install → relaunch pipeline runs
// under plain Node. What matters here is that the release asset for this host
// is chosen correctly, that the digest is computed while streaming and checked
// against the published sidecar, that the install hand-off carries the real
// platform operations (hdiutil/ditto/open, the appimage swap), and that the
// state machine ends in the shape public/air-ops.js paints (the same step
// object /api/update/status returns).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updater = require('../desktop/lib/desktop-updater.js');

const SILENT = { log() {}, error() {}, warn() {} };

const RELEASE = {
  tag_name: 'v2.13.0',
  assets: [
    { name: 'multicc-desktop-2.13.0-macos-arm64.dmg', browser_download_url: 'https://ex/d/macos-arm64.dmg', size: 11 },
    { name: 'multicc-desktop-2.13.0-macos-arm64.dmg.sha256', browser_download_url: 'https://ex/d/macos-arm64.dmg.sha256', size: 65 },
    { name: 'multicc-desktop-2.13.0-windows-x64.exe', browser_download_url: 'https://ex/d/win.exe', size: 11 },
    { name: 'multicc-desktop-2.13.0-windows-x64.exe.sha256', browser_download_url: 'https://ex/d/win.exe.sha256', size: 65 },
    { name: 'multicc-desktop-2.13.0-linux-x64.AppImage', browser_download_url: 'https://ex/d/linux.AppImage', size: 11 },
    { name: 'multicc-desktop-2.13.0-linux-x64.AppImage.sha256', browser_download_url: 'https://ex/d/linux.AppImage.sha256', size: 65 },
  ],
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-desktop-updater-'));
}

function bodyOf(chunks) {
  let index = 0;
  return {
    getReader() {
      return { read: async () => (index < chunks.length ? { done: false, value: Buffer.from(chunks[index++]) } : { done: true, value: undefined }) };
    },
  };
}

function response({ status = 200, json = null, text = null, chunks = null, contentLength = undefined }) {
  const headers = { get: name => (String(name).toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) };
  return { ok: status >= 200 && status < 300, status, headers, json: async () => json, text: async () => text, body: chunks ? bodyOf(chunks) : null };
}

// Routes by URL so a run's release lookup, installer download and sidecar fetch
// each answer with what the test scripted.
function scriptedFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const entry = routes[url];
    if (!entry) throw new Error(`unscripted fetch: ${url}`);
    return typeof entry === 'function' ? entry() : entry;
  };
  impl.calls = calls;
  return impl;
}

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {}, on() {} };
  };
  spawn.calls = calls;
  return spawn;
}

test('installer names and selection follow the release naming convention', () => {
  assert.equal(updater.installerNameFor({ version: '2.13.0', platform: 'darwin', arch: 'arm64' }), 'multicc-desktop-2.13.0-macos-arm64.dmg');
  assert.equal(updater.installerNameFor({ version: '2.13.0', platform: 'win32', arch: 'x64' }), 'multicc-desktop-2.13.0-windows-x64.exe');
  assert.equal(updater.installerNameFor({ version: '2.13.0', platform: 'linux', arch: 'x64' }), 'multicc-desktop-2.13.0-linux-x64.AppImage');
  // aarch64 is Node's other spelling of arm64.
  assert.equal(updater.normalizeArch('aarch64'), 'arm64');

  const release = updater.parseRelease(RELEASE);
  assert.equal(release.version, '2.13.0');
  const mac = updater.selectInstaller(release, { platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.installer.name, 'multicc-desktop-2.13.0-macos-arm64.dmg');
  assert.equal(mac.sidecar.name, 'multicc-desktop-2.13.0-macos-arm64.dmg.sha256');
  const win = updater.selectInstaller(release, { platform: 'win32', arch: 'x64' });
  assert.equal(win.installer.name, 'multicc-desktop-2.13.0-windows-x64.exe');
  // A release with no matching asset yields nothing to install.
  assert.equal(updater.selectInstaller({ version: '2.13.0', assets: [] }, { platform: 'darwin', arch: 'arm64' }), null);
});

test('the install target is the .app, the install dir, or the AppImage — a .deb has none', () => {
  assert.deepEqual(
    updater.resolveInstallTarget({ platform: 'darwin', bundlePath: '/Applications/MultiCC.app', env: {} }),
    { kind: 'mac', bundlePath: '/Applications/MultiCC.app' });
  assert.equal(updater.resolveInstallTarget({ platform: 'win32', bundlePath: 'C:/MultiCC', env: {} }).kind, 'win');
  assert.equal(updater.resolveInstallTarget({ platform: 'linux', bundlePath: '/x/MultiCC.AppImage', env: {} }).kind, 'appimage');
  // AppImage runtime exports its own path.
  assert.equal(updater.resolveInstallTarget({ platform: 'linux', bundlePath: '/usr/share/x', env: { APPIMAGE: '/apps/MultiCC.AppImage' } }).kind, 'appimage');
  assert.equal(updater.resolveInstallTarget({ platform: 'linux', bundlePath: '/usr/share/x', env: {} }).kind, 'unsupported');
});

test('downloadToFile streams to disk, hashes, and reports progress', async () => {
  const dir = tempDir();
  const dest = path.join(dir, 'installer.AppImage');
  const chunks = [Buffer.from('hello '), Buffer.from('world')];
  const fetchImpl = scriptedFetch({ 'https://ex/linux.AppImage': response({ chunks, contentLength: 11 }) });
  const seen = [];
  const result = await updater.downloadToFile({
    url: 'https://ex/linux.AppImage', destPath: dest, fetchImpl,
    onProgress: progress => seen.push(progress),
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello world');
  assert.equal(result.received, 11);
  assert.equal(result.digest, crypto.createHash('sha256').update('hello world').digest('hex'));
  assert.equal(seen.at(-1).percent, 100);
  assert.ok(seen.length >= 1, 'progress fired at least once');
});

test('the mac install script mounts, swaps after the app exits and reopens', () => {
  const script = updater.buildMacInstallCommand({
    bundlePath: '/Applications/MultiCC.app', dmgPath: '/tmp/x.dmg', mountDir: '/tmp/mnt', waitPid: 4242,
  });
  assert.match(script, /hdiutil attach/);
  assert.match(script, /\/usr\/bin\/ditto/);
  assert.match(script, /kill -0 4242/);
  assert.match(script, /mv "\$BUNDLE" "\$BUNDLE\.old"/);
  assert.match(script, /xattr -dr com\.apple\.quarantine/);
  assert.match(script, /\/usr\/bin\/open "\$BUNDLE"/);
});

test('the linux install script waits for the app, swaps the file and relaunches', () => {
  const script = updater.buildLinuxInstallCommand({ appImagePath: '/apps/MultiCC.AppImage', downloadedPath: '/tmp/x.AppImage', waitPid: 7 });
  assert.match(script, /kill -0 7/);
  assert.match(script, /chmod \+x "\$SRC"/);
  assert.match(script, /mv "\$SRC" "\$TARGET"/);
  assert.match(script, /nohup "\$TARGET"/);
});

test('a full mac run walks check → download → checksum → install → relaunch and quits', async () => {
  const dir = tempDir();
  const bytes = Buffer.from('fake-dmg-bytes');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = scriptedFetch({
    [updater.RELEASES_API]: response({ json: RELEASE }),
    'https://ex/d/macos-arm64.dmg': response({ chunks: [bytes], contentLength: bytes.length }),
    'https://ex/d/macos-arm64.dmg.sha256': response({ text: `${digest}\n` }),
  });
  const spawn = fakeSpawn();
  const snaps = [];
  let quit = 0;
  const app = updater.createDesktopUpdater({
    fetchImpl, spawn, platform: 'darwin', arch: 'arm64',
    currentVersion: '2.12.0', bundlePath: '/Applications/MultiCC.app', workDir: dir,
    appPid: 999, quitDelayMs: 0, logger: SILENT,
    onProgress: state => snaps.push(state),
    onQuit: () => { quit += 1; },
  });

  const final = await app.start({ version: '2.13.0' });
  assert.equal(final.state, 'succeeded');
  assert.equal(final.targetVersion, '2.13.0');
  assert.deepEqual(final.steps.map(s => [s.id, s.state]), [
    ['check', 'done'], ['download', 'done'], ['checksum', 'done'], ['install-app', 'done'],
    // relaunch stays running: the app quits here and the new build takes over,
    // exactly like the server flow's final step. The UI renders a succeeded run
    // with its running step as done.
    ['relaunch', 'running'],
  ]);
  // The installer ran through a detached shell that will replace the bundle.
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, '/bin/sh');
  assert.match(spawn.calls[0].args[1], /hdiutil attach/);
  assert.equal(spawn.calls[0].options.detached, true);
  // The download step reported its percentage at least once.
  const downloadRunning = snaps.find(s => (s.steps || []).some(x => x.id === 'download' && x.state === 'running' && x.progress));
  assert.ok(downloadRunning, 'the download step carried progress');
  // Quit is deferred a tick so the final snapshot flushes first.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(quit, 1, 'the shell quits so the installer can swap the bundle');
});

test('a checksum mismatch fails the run before anything is installed', async () => {
  const dir = tempDir();
  const fetchImpl = scriptedFetch({
    [updater.RELEASES_API]: response({ json: RELEASE }),
    'https://ex/d/macos-arm64.dmg': response({ chunks: [Buffer.from('bytes')], contentLength: 5 }),
    'https://ex/d/macos-arm64.dmg.sha256': response({ text: `${'0'.repeat(64)}\n` }),
  });
  const spawn = fakeSpawn();
  const app = updater.createDesktopUpdater({
    fetchImpl, spawn, platform: 'darwin', arch: 'arm64',
    currentVersion: '2.12.0', bundlePath: '/Applications/MultiCC.app', workDir: dir,
    logger: SILENT,
  });
  await assert.rejects(() => app.start({}), error => error.code === 'DESKTOP_CHECKSUM_MISMATCH');
  assert.equal(spawn.calls.length, 0, 'nothing is installed when the digest does not match');
  const state = app.getState();
  assert.equal(state.state, 'failed');
  assert.equal(state.steps.find(s => s.id === 'checksum').state, 'failed');
  assert.equal(state.steps.find(s => s.id === 'install-app').state, 'pending');
});

test('an already-current release succeeds without downloading anything', async () => {
  const dir = tempDir();
  const fetchImpl = scriptedFetch({ [updater.RELEASES_API]: response({ json: RELEASE }) });
  const spawn = fakeSpawn();
  const app = updater.createDesktopUpdater({
    fetchImpl, spawn, platform: 'darwin', arch: 'arm64',
    currentVersion: '2.13.0', bundlePath: '/Applications/MultiCC.app', workDir: dir,
    logger: SILENT,
  });
  const final = await app.start({});
  assert.equal(final.state, 'succeeded');
  assert.deepEqual(fetchImpl.calls, [updater.RELEASES_API], 'no download when there is nothing to install');
  assert.equal(spawn.calls.length, 0);
  assert.equal(final.steps.find(s => s.id === 'download').state, 'skipped');
});

test('a build that cannot self-update refuses instead of pretending to run', async () => {
  const app = updater.createDesktopUpdater({
    fetchImpl: async () => response({}), spawn: fakeSpawn(), platform: 'linux', arch: 'x64',
    currentVersion: '2.12.0', bundlePath: '/usr/share/MultiCC', workDir: tempDir(),
  });
  await assert.rejects(() => app.start({}), error => error.code === 'DESKTOP_UPDATE_UNSUPPORTED');
  assert.equal(app.getState().state, 'idle');
});

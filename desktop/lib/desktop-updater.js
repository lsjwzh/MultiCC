'use strict';

// Desktop self-update: download the platform installer for the running app,
// verify it, install it in place and relaunch — all without ever showing the
// user a browser download page.
//
// Why this lives in the Electron shell and not the server: the thing being
// replaced is the app bundle the shell itself is running from (MultiCC.app on
// macOS, the installed directory on Windows, the AppImage on Linux). Only the
// shell knows that path, only the shell can quit and relaunch itself, and the
// swap is inherently OS-specific (hdiutil/ditto/open, an NSIS welcome wizard,
// swapping a running AppImage's file). That is the Node/Electron-specific
// adapter the project's Rust-by-default rule explicitly exempts; there is no
// server-side business logic hidden here, and the server keeps refusing
// /api/update with DESKTOP_UPDATE_UNSUPPORTED exactly as before.
//
// No electron import: every OS-touching dependency is injected (spawn, fetch,
// fs, path, the app bundle path, the pid to wait on) so this runs — and is
// tested — under plain Node, same rule as the rest of desktop/lib.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELEASES_API = 'https://api.github.com/repos/lsjwzh/MultiCC/releases/latest';
// Listed in the order the web UI's progress panel expects them; the panel
// renders whatever plan the run reports, and this is the plan a desktop run
// reports (see public/air-ops.js STEP_LABEL_KEYS for the matching labels).
// `install-app` is deliberately not the git manager's `install` id: the two
// mean different things ("swap in the new build" vs "reinstall dependencies")
// and the label lookup is keyed by id, so they cannot share one.
const DESKTOP_STEPS = Object.freeze(['check', 'download', 'checksum', 'install-app', 'relaunch']);
// A release asset's digest sidecar, byte-for-byte the convention
// desktop/lib/release-artifacts.js writes and the release workflow verifies.
const SIDECAR_SUFFIX = '.sha256';

class DesktopUpdateError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DesktopUpdateError';
    this.code = code;
  }
}

// ── Release assets ─────────────────────────────────────────────────────────
// process.arch reports 'arm64' | 'x64' on the platforms we ship; the release
// artifacts use those same spellings (desktop/lib/release-artifacts.js
// ARTIFACT_NAME_RE), so no translation table is needed beyond normalizing the
// odd Node spelling.
function normalizeArch(arch) {
  return arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64';
}

// The three spellings an artifact name uses, keyed by Node's process.platform.
function platformSpelling(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

function installerExtension(platform) {
  if (platform === 'darwin') return 'dmg';
  if (platform === 'win32') return 'exe';
  return 'AppImage';
}

function installerNameFor({ version, platform, arch }) {
  const p = platformSpelling(platform);
  const a = normalizeArch(arch);
  return `multicc-desktop-${version}-${p}-${a}.${installerExtension(platform)}`;
}

// The release JSON we consume from GitHub: tag_name + assets[]. name/url/size
// only; nothing else in that payload is trusted or stored.
function parseRelease(payload) {
  const tag = String((payload && payload.tag_name) || '').trim();
  const version = tag.replace(/^v/, '');
  const rawAssets = Array.isArray(payload && payload.assets) ? payload.assets : [];
  const assets = rawAssets.map(asset => ({
    name: String(asset && asset.name || ''),
    url: String(asset && (asset.browser_download_url || asset.url) || ''),
    size: Number(asset && asset.size) || 0,
  })).filter(asset => asset.name && asset.url);
  return { version, tag, assets };
}

// The installer this host should run, by exact name when the version is known,
// else by pattern (the newest matching asset the release carries). Returns the
// installer and its digest sidecar, or null when the release has neither.
function selectInstaller(release, { platform, arch }) {
  const p = platformSpelling(platform);
  const a = normalizeArch(arch);
  const ext = installerExtension(platform);
  const exact = release.version ? installerNameFor({ version: release.version, platform, arch }) : null;
  const pattern = new RegExp(`^multicc-desktop-.+-${p}-${a}\\.${ext}$`);
  const installer = (exact && release.assets.find(asset => asset.name === exact))
    || release.assets.find(asset => pattern.test(asset.name))
    || null;
  if (!installer) return null;
  const sidecar = release.assets.find(asset => asset.name === `${installer.name}${SIDECAR_SUFFIX}`) || null;
  return { installer, sidecar };
}

// ── Download + verify ──────────────────────────────────────────────────────
// Stream to disk while hashing, so a 200 MB dmg never sits in memory and the
// digest costs no second pass. Progress is reported per chunk against
// content-length; a server that omits the length still gets byte counts, just
// no percentage.
async function downloadToFile({ url, destPath, fetchImpl, onProgress = () => {}, logger = null }) {
  const response = await fetchImpl(url, { redirect: 'follow', headers: { Accept: 'application/octet-stream' } });
  if (!response || !response.ok) {
    throw new DesktopUpdateError('DESKTOP_DOWNLOAD_FAILED', `download failed (HTTP ${response ? response.status : 'no response'})`);
  }
  const total = Number(response.headers && response.headers.get && response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destPath);
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) throw new DesktopUpdateError('DESKTOP_DOWNLOAD_FAILED', 'response has no readable body');

  let received = 0;
  const write = chunk => new Promise((resolve, reject) => {
    out.write(chunk, error => (error ? reject(error) : resolve()));
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      const chunk = Buffer.from(value);
      received += chunk.length;
      hash.update(chunk);
      await write(chunk);
      onProgress({
        received,
        total,
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
      });
    }
  } catch (error) {
    out.destroy();
    throw error instanceof DesktopUpdateError ? error : new DesktopUpdateError('DESKTOP_DOWNLOAD_FAILED', error.message, error);
  }
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on('error', reject);
  });
  return { received, digest: hash.digest('hex') };
}

// GitHub hosts a bare `<digest>\n` sidecar next to every installer; compare
// case-insensitively and only against the leading hex run so a trailing
// filename (sha256sum format) still parses.
async function fetchExpectedDigest(sidecar, { fetchImpl }) {
  if (!sidecar) return null;
  const response = await fetchImpl(sidecar.url, { redirect: 'follow', headers: { Accept: 'text/plain' } });
  if (!response || !response.ok) return null;
  const text = await response.text();
  const match = /[0-9a-f]{64}/i.exec(text || '');
  return match ? match[0].toLowerCase() : null;
}

// ── Platform install commands ──────────────────────────────────────────────
// Each builder returns a shell command (or a spawn spec) that runs *after* the
// app has quit, so it can replace the running program. They are plain strings
// on purpose: a test can assert the exact operations without executing them.

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// macOS: mount the dmg, wait for the app to exit, copy the new bundle into
// place with ditto (which preserves the code signature/resources), clear the
// quarantine flag so Gatekeeper does not run it from a random read-only copy,
// and open it again. Every step is idempotent enough to be interrupted safely.
function buildMacInstallCommand({ bundlePath, dmgPath, mountDir, waitPid }) {
  return [
    'set -e',
    `MOUNT=${quote(mountDir)}`,
    `DMG=${quote(dmgPath)}`,
    `BUNDLE=${quote(bundlePath)}`,
    'mkdir -p "$MOUNT"',
    'hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"',
    'SRC="$(/bin/ls -d "$MOUNT"/*.app 2>/dev/null | head -n 1)"',
    '[ -n "$SRC" ] || { echo "no application bundle in the downloaded image" >&2; hdiutil detach "$MOUNT" -quiet || true; exit 1; }',
    // The app just asked itself to quit; wait for the pid to disappear before
    // touching the bundle it is running from.
    `while /bin/kill -0 ${Number(waitPid)} 2>/dev/null; do /bin/sleep 0.3; done`,
    'rm -rf "$BUNDLE.updating" "$BUNDLE.old"',
    '/usr/bin/ditto "$SRC" "$BUNDLE.updating"',
    'hdiutil detach "$MOUNT" -quiet || true',
    'mv "$BUNDLE" "$BUNDLE.old"',
    'mv "$BUNDLE.updating" "$BUNDLE"',
    'rm -rf "$BUNDLE.old"',
    '/usr/bin/xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true',
    '/usr/bin/open "$BUNDLE"',
  ].join('\n');
}

// Linux AppImage: the running image is an ordinary file that can be unlinked
// while it runs, so replace it in place, restore the executable bit and start
// the new one detached from this shell.
function buildLinuxInstallCommand({ appImagePath, downloadedPath, waitPid }) {
  return [
    'set -e',
    `TARGET=${quote(appImagePath)}`,
    `SRC=${quote(downloadedPath)}`,
    `while /bin/kill -0 ${Number(waitPid)} 2>/dev/null; do /bin/sleep 0.3; done`,
    'chmod +x "$SRC"',
    'mv "$SRC" "$TARGET"',
    'chmod +x "$TARGET"',
    'nohup "$TARGET" >/dev/null 2>&1 &',
  ].join('\n');
}

// Whether this host can replace its own program. Windows and Linux-AppImage
// can; a Linux .deb install cannot (that needs the package manager), and a
// macOS app not in a writable location is caught at install time by the shell
// script itself.
function resolveInstallTarget({ platform, bundlePath, env = process.env }) {
  if (platform === 'darwin') return { kind: 'mac', bundlePath };
  if (platform === 'win32') return { kind: 'win', bundlePath };
  const appImage = env.APPIMAGE || (bundlePath && /\.AppImage$/i.test(bundlePath) ? bundlePath : null);
  if (appImage) return { kind: 'appimage', appImagePath: appImage };
  return { kind: 'unsupported', reason: 'linux-deb' };
}

// ── Steps / state ──────────────────────────────────────────────────────────
function initialSteps(ids) {
  return ids.map(id => ({ id, state: 'pending', startedAt: null, endedAt: null, note: null, progress: null }));
}

function isoOf(now, ms) {
  return new Date(ms).toISOString();
}

// ── The updater ────────────────────────────────────────────────────────────
// A single run at a time. getState() always returns a snapshot in the same
// shape src/update-runner.js readUpdateStatus emits, so the web UI's progress
// panel (public/air-ops.js) renders a desktop run with no extra code.
function createDesktopUpdater(rawDeps = {}) {
  const {
    fetchImpl = fetch,
    spawn,
    platform = process.platform,
    arch = process.arch,
    currentVersion = '0.0.0',
    bundlePath,
    workDir,
    appPid = process.pid,
    env = process.env,
    fsImpl = fs,
    pathImpl = path,
    now = Date.now,
    logger = console,
    onProgress = () => {},
    onQuit = () => {},
    supported = true,
    quitDelayMs = 400,
  } = rawDeps;
  if (typeof spawn !== 'function') throw new TypeError('[desktop-updater] spawn is required');
  if (!workDir) throw new TypeError('[desktop-updater] workDir is required');

  let steps = initialSteps(DESKTOP_STEPS);
  let state = 'idle';
  let running = false;
  let exitCode = null;
  let startedAt = null;
  let updatedAt = isoOf(now, now());
  let targetVersion = null;
  let tail = [];

  function snapshot() {
    return {
      state,
      running,
      exitCode,
      startedAt,
      updatedAt,
      targetVersion,
      steps: steps.map(step => ({ ...step })),
      tail: tail.join('\n'),
      desktop: true,
    };
  }

  function emit() {
    updatedAt = isoOf(now, now());
    try { onProgress(snapshot()); } catch (_) { /* a renderer-side throw must not abort the run */ }
  }

  function log(line) {
    if (line) tail.push(String(line));
    logger.log(`[desktop-updater] ${line}`);
  }

  function step(id) { return steps.find(entry => entry.id === id); }

  function begin(id, note = null) {
    const entry = step(id);
    if (!entry) return;
    entry.state = 'running';
    entry.startedAt = isoOf(now, now());
    if (note) { entry.note = note; log(note); }
    emit();
  }

  function progress(id, text, percent) {
    const entry = step(id);
    if (!entry || entry.state !== 'running') return;
    entry.progress = { text: String(text || '').slice(0, 80), percent: percent == null ? null : Math.min(100, Number(percent)) };
    emit();
  }

  function finish(id, note = null) {
    const entry = step(id);
    if (!entry) return;
    entry.state = 'done';
    entry.endedAt = isoOf(now, now());
    entry.progress = null;
    if (note) entry.note = String(note).slice(0, 80);
    emit();
  }

  function skipPending() {
    for (const entry of steps) {
      if (entry.state === 'pending') { entry.state = 'skipped'; entry.endedAt = isoOf(now, now()); }
    }
  }

  function fail(id, code, message) {
    const entry = step(id);
    if (entry) {
      entry.state = 'failed';
      entry.endedAt = isoOf(now, now());
      entry.note = String(code);
    }
    state = 'failed';
    running = false;
    exitCode = 1;
    log(message);
    emit();
    return new DesktopUpdateError(code, message);
  }

  async function resolveRelease() {
    const response = await fetchImpl(RELEASES_API, {
      redirect: 'follow',
      // GitHub's API rejects a request with no User-Agent.
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MultiCC-Desktop' },
    });
    if (!response || !response.ok) {
      throw new DesktopUpdateError('DESKTOP_RELEASE_LOOKUP_FAILED', `could not reach the release feed (HTTP ${response ? response.status : 'no response'})`);
    }
    return parseRelease(await response.json());
  }

  // Spawn the post-quit installer detached so it survives this process exiting.
  // mac/Linux go through /bin/sh -c with a supplied script; Windows runs the
  // downloaded NSIS installer, which closes the running app and relaunches.
  function spawnInstaller({ target, downloadedPath }) {
    const logFile = pathImpl.join(workDir, 'install.log');
    const child = (() => {
      if (target.kind === 'win') {
        log(`running installer ${downloadedPath}`);
        return spawn(downloadedPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      }
      const command = target.kind === 'mac'
        ? buildMacInstallCommand({ bundlePath: target.bundlePath, dmgPath: downloadedPath, mountDir: pathImpl.join(workDir, 'mnt'), waitPid: appPid })
        : buildLinuxInstallCommand({ appImagePath: target.appImagePath, downloadedPath, waitPid: appPid });
      log(`installing ${downloadedPath} into ${target.bundlePath || target.appImagePath}`);
      return spawn('/bin/sh', ['-c', `${command} >> ${quote(logFile)} 2>&1`], { detached: true, stdio: 'ignore' });
    })();
    if (!child || typeof child.unref !== 'function') {
      throw new DesktopUpdateError('DESKTOP_INSTALL_SPAWN_FAILED', 'could not start the installer');
    }
    child.unref();
    return child;
  }

  async function start({ version = null } = {}) {
    if (running) throw new DesktopUpdateError('DESKTOP_UPDATE_IN_PROGRESS', 'an update is already running');
    if (!supported) throw new DesktopUpdateError('DESKTOP_UPDATE_UNSUPPORTED', 'this build cannot update itself');
    const target = resolveInstallTarget({ platform, bundlePath, env });
    if (target.kind === 'unsupported') {
      throw new DesktopUpdateError('DESKTOP_UPDATE_UNSUPPORTED', 'run the package manager to update this install');
    }

    steps = initialSteps(DESKTOP_STEPS);
    state = 'running';
    running = true;
    exitCode = null;
    startedAt = isoOf(now, now());
    tail = [];
    targetVersion = version;
    emit();

    try {
      // 1) Resolve the release and pick this host's installer.
      begin('check', version ? `target ${version}` : null);
      let release;
      try {
        release = await resolveRelease();
      } catch (error) {
        throw fail('check', error.code || 'DESKTOP_RELEASE_LOOKUP_FAILED', error.message);
      }
      const selected = selectInstaller(release, { platform, arch });
      if (!selected) throw fail('check', 'DESKTOP_ASSET_MISSING', `release ${release.version || '?'} has no installer for ${platform}/${normalizeArch(arch)}`);
      if (release.version && release.version === String(currentVersion)) {
        finish('check', `already ${release.version}`);
        skipPending();
        state = 'succeeded';
        running = false;
        exitCode = 0;
        log(`already up to date at ${currentVersion}`);
        emit();
        return snapshot();
      }
      targetVersion = release.version || version || null;
      finish('check', targetVersion || null);
      const { installer, sidecar } = selected;

      // 2) Download with progress.
      begin('download', installer.name);
      const downloadedPath = pathImpl.join(workDir, installer.name);
      let digest = null;
      try {
        const result = await downloadToFile({
          url: installer.url,
          destPath: downloadedPath,
          fetchImpl,
          logger,
          onProgress: ({ received, total, percent }) => progress('download', `${Math.round(received / 1048576)} MB${total ? ` / ${Math.round(total / 1048576)} MB` : ''}`, percent),
        });
        digest = result.digest;
      } catch (error) {
        throw fail('download', error.code || 'DESKTOP_DOWNLOAD_FAILED', error.message);
      }
      finish('download', installer.name);

      // 3) Verify the digest against the release sidecar.
      begin('checksum');
      let expected = null;
      try {
        expected = await fetchExpectedDigest(sidecar, { fetchImpl });
      } catch (_) { expected = null; }
      if (expected && expected !== digest) {
        throw fail('checksum', 'DESKTOP_CHECKSUM_MISMATCH', 'the downloaded installer does not match its published digest');
      }
      finish('checksum', expected ? 'sha256 ok' : 'no published digest');

      // 4) Hand off to the post-quit installer, then quit so it can swap.
      begin('install-app', target.kind);
      try {
        spawnInstaller({ target, downloadedPath });
      } catch (error) {
        throw fail('install-app', error.code || 'DESKTOP_INSTALL_SPAWN_FAILED', error.message);
      }
      finish('install-app', target.kind);

      // 5) Relaunch: the installer script restarts the new app once we are gone.
      begin('relaunch');
      state = 'succeeded';
      running = false;
      exitCode = 0;
      log(`update to ${targetVersion || currentVersion} scheduled; restarting`);
      emit();
      // Give the final snapshot a tick to reach the renderer before the window
      // disappears, then quit; the detached script does the rest.
      setTimeout(() => { try { onQuit(); } catch (error) { logger.error(`[desktop-updater] quit failed: ${error.message}`); } }, quitDelayMs);
      return snapshot();
    } catch (error) {
      if (state !== 'failed') {
        state = 'failed';
        running = false;
        exitCode = exitCode == null ? 1 : exitCode;
        log(error && error.message);
        emit();
      }
      throw error;
    }
  }

  return { start, getState() { return snapshot(); } };
}

module.exports = {
  RELEASES_API,
  DESKTOP_STEPS,
  SIDECAR_SUFFIX,
  DesktopUpdateError,
  normalizeArch,
  platformSpelling,
  installerExtension,
  installerNameFor,
  parseRelease,
  selectInstaller,
  downloadToFile,
  fetchExpectedDigest,
  buildMacInstallCommand,
  buildLinuxInstallCommand,
  resolveInstallTarget,
  createDesktopUpdater,
};

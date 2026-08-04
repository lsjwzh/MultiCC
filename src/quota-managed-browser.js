'use strict';

// A Chrome that multicc owns, so quota scraping no longer depends on the user
// keeping a debug-enabled browser open.
//
// The vendor quota routes (qoder / opencode / kimi subscription) all need a
// browser that holds the user's login. Before this module, that meant asking
// the user to launch Chrome with --remote-debugging-port and never close it.
// Now multicc keeps one shared, headless Chrome of its own with a dedicated
// profile directory under DATA_DIR: the user logs into each vendor once in a
// visible window we open for them, the session persists in that profile, and
// every later quota fetch runs headless against the stored cookies.
//
// Lifecycle:
//   attachManaged()  — connect to whatever Chrome is already using the managed
//                      profile (ours or a login window), launching a headless
//                      one if nothing is there.
//   openVisibleLogin(url) — stop our headless instance (same profile cannot be
//                      open twice), then open a visible window at the vendor's
//                      login page for the user to type into. The window is the
//                      user's from then on; we never kill it on a timer.
//   stopManaged()    — kill only the instance this module spawned.
//
// An idle timer retires the headless instance after a quiet period
// (QUOTA_BROWSER_IDLE_MS, default 5 min, 0 = keep forever). Startup is
// serialized: concurrent quota fetches must not race two launches against the
// profile's SingletonLock.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const { createChromeCdp } = require('./chrome-cdp');

const DATA_DIR = process.env.MULTICC_DATA_DIR || path.join(os.homedir(), '.multicc');
const PROFILE_DIR = path.join(DATA_DIR, 'quota-browser-profile');
const IDLE_MS = Number(process.env.QUOTA_BROWSER_IDLE_MS != null ? process.env.QUOTA_BROWSER_IDLE_MS : 5 * 60 * 1000);
const STARTUP_TIMEOUT_MS = Number(process.env.QUOTA_BROWSER_STARTUP_MS || 12000);
const VISIBLE_READY_MS = Number(process.env.QUOTA_BROWSER_VISIBLE_READY_MS || 8000);
const CONNECT_TIMEOUT_MS = 2500;

// --- Profile cleanup -------------------------------------------------------
// Chrome only allows one process per user-data-dir. If the quota profile is
// already held (an orphaned headless from before a restart, or an instance we
// attached to instead of spawning), a second launch does not fail loudly:
// Chrome's singleton handoff forwards the URL to the existing process and the
// new one exits with code 0. A "visible login window" then opens nowhere while
// the route happily reports success. So before opening a visible window we
// clear every process that holds THIS profile — matched by the exact
// --user-data-dir path, never the user's daily Chrome.

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when a process command line claims this exact profile directory.
// Handles bare, single-quoted and double-quoted forms, and refuses prefix
// collisions like /a/profile matching /a/profile-backup.
function commandLineOwnsProfile(commandLine, profileDir) {
  if (typeof commandLine !== 'string' || !commandLine.includes('--user-data-dir=')) return false;
  const pattern = new RegExp(`--user-data-dir=(["']?)${escapeRegExp(profileDir)}\\1(?:\\s|$)`);
  return pattern.test(commandLine);
}

function execFileAsync(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Pids of every process whose command line holds the given profile dir.
async function listChromeProfilePids(profileDir, platform = process.platform) {
  const pids = [];
  if (platform === 'win32') {
    const script = "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--user-data-dir*' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }) | ConvertTo-Json -Compress";
    const out = await execFileAsync('powershell', ['-NoProfile', '-Command', script], 8000);
    const parsed = JSON.parse(out.trim() || '[]');
    for (const line of (Array.isArray(parsed) ? parsed : [parsed])) {
      const idx = String(line).indexOf('|');
      if (idx <= 0) continue;
      if (commandLineOwnsProfile(String(line).slice(idx + 1), profileDir)) pids.push(Number(String(line).slice(0, idx)));
    }
    return pids;
  }
  const out = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=,args='], 5000);
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue; // paranoia: never match ourselves
    if (commandLineOwnsProfile(match[2], profileDir)) pids.push(pid);
  }
  return pids;
}

// Kill every process holding the profile, confirm they are gone, then clear
// stale Singleton* markers. Throws profile_busy if holders refuse to die.
async function releaseProfileDir(profileDir, options = {}) {
  const {
    listPids = () => listChromeProfilePids(profileDir),
    pidIsAlive = pidAlive,
    pollIntervalMs = 150,
    termGraceMs = 2500,
    deadlineMs = 6000,
    sleep = delay,
    now = () => Date.now(),
  } = options;
  let holders = [];
  try { holders = await listPids(); } catch (_) { holders = []; }
  const killed = [];
  if (holders.length) {
    for (const pid of holders) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
    const termDeadline = now() + termGraceMs;
    let remaining = holders.filter(pidIsAlive);
    while (remaining.length && now() < termDeadline) { await sleep(pollIntervalMs); remaining = holders.filter(pidIsAlive); }
    for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    const hardDeadline = now() + deadlineMs;
    remaining = holders.filter(pidIsAlive);
    while (remaining.length && now() < hardDeadline) { await sleep(pollIntervalMs); remaining = holders.filter(pidIsAlive); }
    if (remaining.length) {
      const err = new Error(`could not free the browser profile: pids ${remaining.join(',')} still hold it`);
      err.code = 'profile_busy';
      throw err;
    }
    killed.push(...holders);
  }
  // With every holder gone, confirm via the process table one more time.
  try {
    const stragglers = await listPids();
    if (stragglers.length) {
      const err = new Error(`could not free the browser profile: new holders appeared (${stragglers.join(',')})`);
      err.code = 'profile_busy';
      throw err;
    }
  } catch (err) { if (err && err.code === 'profile_busy') throw err; }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, name)); } catch (_) { /* absent is fine */ }
  }
  return { killed };
}

// Known install locations per platform. No PATH scan: shell lookups would need
// a synchronous exec, which src/ is not allowed to use, and the defaults cover
// every mainstream Chromium build on these OSes. MULTICC_CHROME_BIN overrides.
function findChromeBinary(platform = process.platform, env = process.env) {
  const override = String(env.MULTICC_CHROME_BIN || '').trim();
  const candidates = override
    ? [override]
    : platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
      : platform === 'win32'
        ? [
          path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
        : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
          '/usr/bin/microsoft-edge',
        ];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch (_) { /* try next */ }
  }
  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createManagedQuotaBrowser(options = {}) {
  const {
    profileDir = PROFILE_DIR,
    idleMs = IDLE_MS,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    binary = findChromeBinary(options.platform, options.env || process.env),
    spawnChrome = (bin, args) => spawn(bin, args, {
      stdio: 'ignore',
      detached: false,
      env: process.env,
    }),
    releaseProfile = (dir) => releaseProfileDir(dir),
    visibleReadyMs = VISIBLE_READY_MS,
    now = () => Date.now(),
  } = options;

  const cdp = createChromeCdp({
    ports: [],
    profileDirs: [profileDir],
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });

  let child = null;        // process this module spawned (headless or visible)
  let childMode = null;    // 'headless' | 'visible'
  let starting = null;     // in-flight launch promise (serialization)
  let idleTimer = null;
  let lastUseAt = 0;

  function cdpAvailable() {
    // attach() resolves only after a real Browser.getVersion handshake, so a
    // stale DevToolsActivePort from a dead browser never counts as running.
    return cdp.attach().then(
      (browser) => { browser.close(); return true; },
      () => false,
    );
  }

  function clearIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!idleMs || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Never retire a window the user is typing into.
      if (child && childMode === 'headless' && now() - lastUseAt >= idleMs) stopManaged();
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function stopManaged() {
    clearIdleTimer();
    if (!child) return false;
    const proc = child;
    child = null;
    childMode = null;
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000).unref?.();
    return true;
  }

  function baseArgs(headless, extra = []) {
    return [
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      ...extra,
    ];
  }

  async function launchHeadless() {
    if (!binary) {
      const err = new Error('no Chrome binary found (set MULTICC_CHROME_BIN)');
      err.code = 'chrome_unavailable';
      throw err;
    }
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnChrome(binary, baseArgs(true, ['about:blank']));
    child = proc;
    childMode = 'headless';
    proc.on('exit', () => {
      if (child === proc) { child = null; childMode = null; clearIdleTimer(); }
    });
    // Poll until Chrome writes DevToolsActivePort and answers a handshake.
    const deadline = now() + startupTimeoutMs;
    for (;;) {
      if (await cdpAvailable()) { lastUseAt = now(); armIdleTimer(); return; }
      if (proc.exitCode !== null) {
        child = null; childMode = null;
        let holders = [];
        try { holders = await listChromeProfilePids(profileDir); } catch (_) { /* best effort */ }
        const err = holders.length
          ? new Error(`managed Chrome handed the profile off to an existing browser (pids ${holders.join(',')}) that exposes no DevTools port`)
          : new Error(`managed Chrome exited early (code ${proc.exitCode})`);
        err.code = holders.length ? 'profile_busy' : 'chrome_unavailable';
        throw err;
      }
      if (now() >= deadline) {
        stopManaged();
        const err = new Error('managed Chrome did not expose DevTools in time');
        err.code = 'chrome_unavailable';
        throw err;
      }
      await delay(250);
    }
  }

  async function attachManaged() {
    lastUseAt = now();
    // Something already owns the profile — ours, or the user's login window.
    // Either way it speaks CDP and holds the cookies we came for.
    try { return await cdp.attach(); } catch (_) { /* launch our own */ }
    if (starting) { await starting; return cdp.attach(); }
    starting = launchHeadless().finally(() => { starting = null; });
    await starting;
    return cdp.attach();
  }

  function touch() {
    lastUseAt = now();
    if (child && childMode === 'headless') armIdleTimer();
  }

  // Open the vendor login page where the user can actually type. First clears
  // EVERY process holding the profile — not just ones this module spawned —
  // because a leftover holder makes Chrome hand the URL off to itself and the
  // new process exits silently with code 0 (window opens nowhere). Then we
  // verify the new window is really there before reporting success.
  async function openVisibleLogin(url) {
    if (!binary) {
      const err = new Error('no Chrome binary found (set MULTICC_CHROME_BIN)');
      err.code = 'chrome_unavailable';
      throw err;
    }
    if (child && childMode === 'visible') {
      return { ok: true, reused: true, pid: child.pid };
    }
    stopManaged();
    const release = await releaseProfile(profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnChrome(binary, baseArgs(false, [String(url)]));
    child = proc;
    childMode = 'visible';
    proc.on('exit', () => {
      if (child === proc) { child = null; childMode = null; }
    });
    // Proof of a real window: still alive (delegation exits almost instantly,
    // usually code 0) AND answering CDP on the profile we cleared.
    const deadline = now() + visibleReadyMs;
    for (;;) {
      if (proc.exitCode !== null) {
        child = null; childMode = null;
        const err = new Error(`login window exited immediately (code ${proc.exitCode}); the profile was likely still locked by another Chrome`);
        err.code = 'login_window_failed';
        throw err;
      }
      if (await cdpAvailable()) {
        return { ok: true, reused: false, pid: proc.pid, cleared: release.killed.length };
      }
      if (now() >= deadline) {
        stopManaged();
        const err = new Error('login window did not become reachable in time');
        err.code = 'login_window_failed';
        throw err;
      }
      await delay(150);
    }
  }

  function status() {
    return {
      binary,
      profileDir,
      running: Boolean(child),
      mode: childMode,
      pid: child ? child.pid : null,
      idleMs,
    };
  }

  return {
    attachManaged,
    openVisibleLogin,
    stopManaged,
    touch,
    status,
    getCookies: (site, opts) => cdp.getCookies(site, opts),
    withPage: (fn, opts) => cdp.withPage(fn, opts),
  };
}

let singleton = null;
function getManagedQuotaBrowser() {
  if (!singleton) singleton = createManagedQuotaBrowser();
  return singleton;
}

module.exports = {
  createManagedQuotaBrowser,
  getManagedQuotaBrowser,
  findChromeBinary,
  commandLineOwnsProfile,
  listChromeProfilePids,
  releaseProfileDir,
  PROFILE_DIR,
};

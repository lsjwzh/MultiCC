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
const { spawn } = require('child_process');

const { createChromeCdp } = require('./chrome-cdp');

const DATA_DIR = process.env.MULTICC_DATA_DIR || path.join(os.homedir(), '.multicc');
const PROFILE_DIR = path.join(DATA_DIR, 'quota-browser-profile');
const IDLE_MS = Number(process.env.QUOTA_BROWSER_IDLE_MS != null ? process.env.QUOTA_BROWSER_IDLE_MS : 5 * 60 * 1000);
const STARTUP_TIMEOUT_MS = Number(process.env.QUOTA_BROWSER_STARTUP_MS || 12000);
const CONNECT_TIMEOUT_MS = 2500;

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
        const err = new Error(`managed Chrome exited early (code ${proc.exitCode})`);
        err.code = 'chrome_unavailable';
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

  // Open the vendor login page where the user can actually type. Stops our
  // headless instance first — Chrome refuses a second process on the same
  // profile — and leaves the window to the user.
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
    // Give the profile lock a moment to release before the second process
    // claims it; a SingletonLock collision exits Chrome immediately.
    await delay(600);
    fs.mkdirSync(profileDir, { recursive: true });
    const proc = spawnChrome(binary, baseArgs(false, [String(url)]));
    child = proc;
    childMode = 'visible';
    proc.on('exit', () => {
      if (child === proc) { child = null; childMode = null; }
    });
    return { ok: true, reused: false, pid: proc.pid };
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
  PROFILE_DIR,
};

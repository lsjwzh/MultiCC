'use strict';

// The user's everyday Chrome — profile name `main`, mbrowser's default.
//
// It is never launched with --remote-debugging-port (Chrome 136+ ignores that
// flag for the default user-data-dir) and never connected to directly: its
// debugging is the runtime switch at chrome://inspect/#remote-debugging, which
// Chrome persists in Local State (devtools.remote_debugging.user-enabled), so a
// plain launch comes back debuggable. Every connection goes through the
// MultiCC gateway (gateway.js).
//
// mbrowser may *start* the main Chrome when it is not running — in the
// background (`open -g` on macOS) and with no flags, exactly as the user would
// — but it never stops, restarts or activates it.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const P = require('./paths');
const CH = require('./chrome');

const { MbError } = P;

const MAIN_NAME = 'main';
const LAUNCH_TIMEOUT_MS = 30000;

const ENABLE_HINT =
  'Ask the user to open chrome://inspect/#remote-debugging in their everyday Chrome and tick ' +
  '"Allow remote debugging for this browser instance" — once; Chrome remembers it across restarts. ' +
  'Only if the user says not to use their everyday browser, use a dedicated profile instead (-p NAME).';

function isMainName(name) {
  return name === MAIN_NAME;
}

function mainUserDataDir(env = process.env, platform = process.platform) {
  if (env.MBROWSER_MAIN_USER_DATA_DIR) return path.resolve(env.MBROWSER_MAIN_USER_DATA_DIR);
  const home = env.HOME || os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || home, 'AppData', 'Local');
    return path.win32.join(local, 'Google', 'Chrome', 'User Data');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome');
}

function mainExecutable(env = process.env, platform = process.platform) {
  if (env.MBROWSER_MAIN_CHROME) return fs.existsSync(env.MBROWSER_MAIN_CHROME) ? env.MBROWSER_MAIN_CHROME : null;
  const home = env.HOME || os.homedir();
  const candidates = platform === 'darwin'
    ? ['/Applications/Google Chrome.app', path.join(home, 'Applications', 'Google Chrome.app')]
    : platform === 'win32'
      ? [
        path.win32.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return candidates.find(file => fs.existsSync(file)) || null;
}

function portOpen(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host });
    const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

// Windows has no SingletonLock symlink to read; any chrome.exe counts as
// "running", which errs on the side of never launching a second window.
function windowsChromeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return /chrome\.exe/i.test(out);
  } catch (_) {
    return null;
  }
}

// running: a live process holds the profile; debuggable: its DevToolsActivePort
// names a port that answers. DevToolsActivePort outlives a crashed Chrome, so
// the file alone proves nothing.
async function inspect({ dir = mainUserDataDir(), platform = process.platform } = {}) {
  const pid = platform === 'win32' ? null : CH.singletonLockHolder(dir);
  const running = platform === 'win32' ? windowsChromeRunning() : Boolean(pid);
  const activePort = CH.readsDevToolsActivePort(dir);
  const listening = activePort ? await portOpen(activePort.port) : false;
  return {
    dir,
    exists: fs.existsSync(path.join(dir, 'Local State')),
    running: running || listening,
    pid: pid || null,
    port: listening ? activePort.port : null,
    debuggable: listening,
    remoteDebuggingRemembered: rememberedSwitch(dir),
  };
}

// chrome://inspect's switch, as Chrome stored it. null = cannot tell.
function rememberedSwitch(dir) {
  const state = P.readJson(path.join(dir, 'Local State'), null);
  if (!state) return null;
  const value = state.devtools && state.devtools.remote_debugging
    && state.devtools.remote_debugging['user-enabled'];
  return value === true;
}

function launchMain({ env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  const exe = mainExecutable(env, platform);
  if (!exe) throw new MbError('main_missing', 'Google Chrome is not installed in the usual place; set MBROWSER_MAIN_CHROME');
  let child;
  if (platform === 'darwin' && exe.endsWith('.app')) {
    // -g: launch without bringing Chrome to the front.
    child = spawnImpl('open', ['-g', '-a', exe], { detached: true, stdio: 'ignore' });
  } else {
    child = spawnImpl(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
  }
  // A failed spawn surfaces as "did not start" from ensureMain's wait, not as
  // an unhandled 'error' event that kills the daemon.
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return exe;
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// A debuggable main Chrome, starting it (in the background) when it is not
// running. A running Chrome with debugging off is not ours to restart.
async function ensureMain({
  dir = mainUserDataDir(),
  allowLaunch = true,
  launch = launchMain,
  timeoutMs = LAUNCH_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const before = await inspect({ dir });
  if (before.debuggable) return { ...before, launched: false };
  if (before.running) {
    throw new MbError('main_not_debuggable',
      `the everyday Chrome is running but remote debugging is off. ${ENABLE_HINT}`);
  }
  if (!allowLaunch) throw new MbError('main_not_running', 'the everyday Chrome is not running');
  const exe = launch();
  log(`main chrome was not running; launched ${exe} in the background`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(300);
    const now = await inspect({ dir });
    if (now.debuggable) return { ...now, launched: true };
    if (Date.now() > deadline) {
      if (now.running) {
        throw new MbError('main_not_debuggable',
          `started the everyday Chrome, but it did not open remote debugging within ${timeoutMs / 1000}s. ${ENABLE_HINT}`);
      }
      throw new MbError('main_launch_failed', `the everyday Chrome did not start within ${timeoutMs / 1000}s (${exe})`);
    }
  }
}

module.exports = {
  MAIN_NAME,
  ENABLE_HINT,
  LAUNCH_TIMEOUT_MS,
  isMainName,
  mainUserDataDir,
  mainExecutable,
  portOpen,
  inspect,
  rememberedSwitch,
  launchMain,
  ensureMain,
};

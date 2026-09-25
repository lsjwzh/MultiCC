'use strict';

// Chrome discovery, compatibility, launch, readiness, stop, and the keychain
// markers that keep a profile's at-rest encryption mode from changing silently.
//
// Nothing here downloads anything: an incompatible browser is reported with a
// reason, never replaced.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const {
  MbError,
  MOCK_KEYCHAIN_MARKER,
  SEEDED_MARKER,
  ensureDir,
  homeDir,
} = require('./paths');
const { CDP, fetchVersion } = require('./cdp');

const MOCK_KEYCHAIN_NOTE =
  'This profile is pinned to Chrome\'s --use-mock-keychain: at-rest cookie encryption uses a fixed key ' +
  'instead of the macOS login keychain. Removing this file is a keychain-mode change; existing logins ' +
  'stored under the fixed key will not decrypt.\n';
const SEEDED_NOTE =
  'Copied once from a personal Chrome profile. Decrypting the copied cookies still needs the login ' +
  'keychain key, so this executor refuses --mock-keychain for this profile.\n';

const STOP_GRACE_MS = 5000;

const MAIN_CANDIDATES = [
  '/Applications/Google Chrome.app',
  '~/Applications/Google Chrome.app',
  '/Applications/Chromium.app',
  '~/Applications/Chromium.app',
  '/Applications/Google Chrome for Testing.app',
  '~/Applications/Google Chrome for Testing.app',
  '/Applications/Microsoft Edge.app',
  '~/Applications/Microsoft Edge.app',
  '/Applications/Brave Browser.app',
  '~/Applications/Brave Browser.app',
];

const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
const WINDOWS_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function runSync(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options.timeout || 5000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

function osProductVersion() {
  if (process.platform === 'darwin') {
    try { return runSync('sw_vers', ['-productVersion']); } catch (_) { return null; }
  }
  return os.release();
}

function versionTuple(text) {
  const parts = String(text || '').match(/\d+/g);
  return parts ? parts.slice(0, 3).map(Number) : [];
}

function compareVersions(a, b) {
  const left = versionTuple(a);
  const right = versionTuple(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// macOS 11-12 legacy, 13 transitional, 14+ current. Used by doctor and by the
// skill's routing guidance, not as a hard gate for a browser that reports its
// own LSMinimumSystemVersion.
function macosTier(productVersion) {
  const major = versionTuple(productVersion)[0];
  if (!major) return 'unknown';
  if (major < 11) return 'unsupported';
  if (major < 13) return 'legacy';
  if (major < 14) return 'transitional';
  return 'current';
}

function parseInfoPlist(text) {
  const pick = key => {
    const match = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return match ? match[1].trim() : null;
  };
  return {
    minimumSystemVersion: pick('LSMinimumSystemVersion'),
    shortVersion: pick('CFBundleShortVersionString'),
    executable: pick('CFBundleExecutable'),
  };
}

function appBundleFor(exePath) {
  let dir = path.resolve(exePath);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    dir = path.join(dir, 'Contents', 'MacOS');
  } else {
    dir = path.dirname(dir);
  }
  while (dir && dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const CPU_TYPES = new Map([
  [0x01000007, 'x86_64'],
  [0x0100000c, 'arm64'],
  [0x00000007, 'i386'],
  [0x0000000c, 'arm'],
]);

// Pure-JS Mach-O header read so we never shell out to `lipo`/`file`.
function machOArchitectures(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (_) {
    return [];
  }
  try {
    const buf = Buffer.alloc(256);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (read < 8) return [];
    const beMagic = buf.readUInt32BE(0);
    if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
      const count = Math.min(buf.readUInt32BE(4) || 0, 12);
      const archs = [];
      for (let i = 0; i < count; i += 1) {
        const offset = 8 + i * 20;
        if (offset + 4 > read) break;
        const name = CPU_TYPES.get(buf.readUInt32BE(offset));
        if (name && !archs.includes(name)) archs.push(name);
      }
      return archs;
    }
    const leMagic = buf.readUInt32LE(0);
    if (leMagic === 0xfeedfacf || leMagic === 0xfeedface) {
      const name = CPU_TYPES.get(buf.readUInt32LE(4));
      return name ? [name] : [];
    }
    return [];
  } catch (_) {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

// Launching the executable directly is deliberate: `open -a` would hand the URL
// to the user's already-running Chrome, which is exactly the takeover we forbid.
function executableIn(app) {
  const plistPath = path.join(app, 'Contents', 'Info.plist');
  let plist = null;
  try { plist = parseInfoPlist(fs.readFileSync(plistPath, 'utf8')); } catch (_) { plist = null; }
  const name = (plist && plist.executable) || `${path.basename(app, '.app')}`;
  return path.join(app, 'Contents', 'MacOS', name);
}

function describeApp(app) {
  const entry = {
    app,
    path: executableIn(app),
    version: null,
    minimumSystemVersion: null,
    archs: [],
    compatible: true,
    why: null,
    note: null,
  };
  try {
    const plist = parseInfoPlist(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));
    entry.version = plist.shortVersion;
    entry.minimumSystemVersion = plist.minimumSystemVersion;
  } catch (_) { /* a bundle without a readable plist is still launchable */ }
  entry.archs = machOArchitectures(entry.path);
  evaluateCompatibility(entry, { osVersion: osProductVersion(), arch: process.arch });
  return entry;
}

function evaluateCompatibility(entry, { osVersion, arch }) {
  entry.compatible = true;
  entry.why = null;
  entry.note = null;
  const host = versionTuple(osVersion);
  if (entry.minimumSystemVersion && host.length) {
    const wanted = versionTuple(entry.minimumSystemVersion);
    if (wanted.length && compareVersions(osVersion, entry.minimumSystemVersion) < 0) {
      entry.compatible = false;
      entry.why = `requires macOS ${entry.minimumSystemVersion}, this machine runs ${osVersion}`;
      return entry;
    }
  }
  const archs = entry.archs || [];
  if (!archs.length) return entry;
  if (arch === 'arm64') {
    if (archs.includes('arm64')) return entry;
    if (archs.includes('x86_64')) {
      entry.note = 'x86_64-only build; runs under Rosetta, so the first start can take ~30s';
      return entry;
    }
    entry.compatible = false;
    entry.why = `built for ${archs.join('/')}, this machine is arm64`;
    return entry;
  }
  if (arch === 'x64' || arch === 'x86_64') {
    if (archs.includes('x86_64')) return entry;
    entry.compatible = false;
    entry.why = `built for ${archs.join('/')}, this machine is x86_64`;
    return entry;
  }
  return entry;
}

function legacyKitCandidates() {
  const root = path.join(homeDir(), '.multicc', 'legacy-chrome');
  let kits;
  try { kits = fs.readdirSync(root); } catch (_) { return []; }
  const found = [];
  for (const kit of kits) {
    const kitDir = path.join(root, kit);
    let flavours;
    try { flavours = fs.readdirSync(kitDir); } catch (_) { continue; }
    for (const flavour of flavours) {
      if (!flavour.startsWith('chrome-mac')) continue;
      const dir = path.join(kitDir, flavour);
      let apps;
      try { apps = fs.readdirSync(dir); } catch (_) { continue; }
      for (const app of apps) {
        if (app.endsWith('.app')) found.push(path.join(dir, app));
      }
    }
  }
  // Newest kit first: prefer the highest Chrome build that still runs here.
  // Versions are read once per candidate — describeApp parses a Mach-O header.
  return found
    .map(app => ({ app, version: describeApp(app).version || '' }))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(entry => entry.app);
}

function pathCandidates() {
  if (process.platform === 'darwin') {
    return [...MAIN_CANDIDATES.map(entry => path.join(entry.startsWith('~/') ? homeDir() : '/', entry.replace(/^~\//, ''))),
      ...legacyKitCandidates()];
  }
  if (process.platform === 'win32') return WINDOWS_PATHS.slice();
  const found = [];
  for (const name of LINUX_NAMES) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        found.push(candidate);
        break;
      } catch (_) { /* keep looking */ }
    }
    if (found.length) break;
  }
  return found;
}

function describePath(candidate) {
  const app = process.platform === 'darwin' ? appBundleFor(candidate) : null;
  if (app && fs.existsSync(app)) return describeApp(app);
  const entry = {
    app: null,
    path: candidate,
    version: null,
    minimumSystemVersion: null,
    archs: machOArchitectures(candidate),
    compatible: fs.existsSync(candidate),
    why: null,
    note: null,
  };
  if (!entry.compatible) entry.why = 'not found or not executable';
  return entry;
}

function listCandidates() {
  const seen = new Set();
  const out = [];
  for (const candidate of pathCandidates()) {
    const entry = describePath(candidate);
    if (!entry.path || seen.has(entry.path)) continue;
    if (!fs.existsSync(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  return out;
}

// Precedence: explicit flag, profile config, env, then the first compatible
// candidate in platform order.
function chooseBrowser({ explicit, configured, env } = {}) {
  const sources = [
    ['--browser', explicit],
    ['profile config', configured],
    ['MBROWSER_CHROME', env || process.env.MBROWSER_CHROME],
  ];
  for (const [source, value] of sources) {
    if (!value) continue;
    const resolved = path.resolve(String(value).replace(/^~(?=\/)/, homeDir()));
    if (!fs.existsSync(resolved)) {
      throw new MbError('browser_missing', `${source} points at ${resolved}, which does not exist`);
    }
    const entry = describePath(resolved);
    if (!entry.compatible) {
      throw new MbError('browser_incompatible', `${resolved} cannot run here: ${entry.why || 'unknown reason'}`);
    }
    return { ...entry, source };
  }
  const candidates = listCandidates();
  const usable = candidates.filter(entry => entry.compatible);
  if (!usable.length) {
    const detail = candidates.length
      ? candidates.map(entry => `${entry.path} (${entry.why || 'incompatible'})`).join('; ')
      : 'no Chrome/Chromium/Edge/Brave bundle found in /Applications, ~/Applications or ~/.multicc/legacy-chrome';
    throw new MbError('browser_missing', `no compatible Chromium-family browser here: ${detail}`);
  }
  return { ...usable[0], source: 'auto' };
}

function chromeArgs({ userDataDir, headless, mockKeychain, extraArgs = [] }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    // Pinning the debug listener to loopback keeps CDP off the LAN even when a
    // corporate profile turns on remote debugging elsewhere.
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,ChromeSigninIntercept',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--noerrdialogs',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
  ];
  if (headless) args.push('--headless=new', '--window-size=1440,900');
  if (mockKeychain) args.push('--use-mock-keychain');
  if (process.platform === 'linux') args.push('--password-store=basic');
  args.push(...extraArgs);
  args.push('about:blank');
  return args;
}

function patchPreferences(userDataDir) {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  let data;
  try { data = JSON.parse(raw); } catch (_) { return false; }
  if (!data || typeof data !== 'object') return false;
  const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
  // Only rewrite what we need: a stale "exited uncleanly" makes Chrome show the
  // restore bubble, which can steal the focus we are trying to keep on the page.
  if (profile.exit_type === 'Normal' && profile.exited_cleanly === true) return false;
  profile.exit_type = 'Normal';
  profile.exited_cleanly = true;
  data.profile = profile;
  try {
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch (_) {
    return false;
  }
}

function isProfileEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (_) {
    return true;
  }
}

// Mirrors skills/multicc-browser/scripts/local_browser_use.py: a profile that
// was seeded from a personal Chrome must keep the real keychain key, and any
// profile that already holds logins keeps whatever mode it was pinned to.
function resolveMockKeychain(profilePath, requested) {
  const seeded = fs.existsSync(path.join(profilePath, SEEDED_MARKER));
  const pinned = fs.existsSync(path.join(profilePath, MOCK_KEYCHAIN_MARKER));
  if (seeded) {
    if (requested) {
      throw new MbError('keychain_mode',
        `${profilePath} was seeded from a personal Chrome profile; --mock-keychain would make the copied ` +
        'cookies undecryptable');
    }
    return { mockKeychain: false, note: null };
  }
  if (requested) {
    if (pinned) return { mockKeychain: true, note: null };
    if (fs.existsSync(profilePath) && !isProfileEmpty(profilePath)) {
      throw new MbError('keychain_mode',
        `${profilePath} already holds a profile and no ${MOCK_KEYCHAIN_MARKER} marker; changing keychain ` +
        'mode would make its existing logins undecryptable');
    }
    return { mockKeychain: true, note: null };
  }
  if (pinned) {
    return {
      mockKeychain: true,
      note: `note: ${MOCK_KEYCHAIN_MARKER} pins this profile to --use-mock-keychain; applying it`,
    };
  }
  return { mockKeychain: false, note: null };
}

function pinMockKeychain(profilePath) {
  const marker = path.join(profilePath, MOCK_KEYCHAIN_MARKER);
  if (fs.existsSync(marker)) return false;
  ensureDir(profilePath, 0o700);
  fs.writeFileSync(marker, MOCK_KEYCHAIN_NOTE, { mode: 0o600 });
  return true;
}

function securityAgentRunning() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('pgrep', ['-x', 'SecurityAgent'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function readyHint() {
  const base = 'a macOS Keychain prompt ("Chrome Safe Storage") may be waiting behind SecurityAgent: ' +
    'answer it in the GUI and retry, or use --mock-keychain on a fresh profile; a first Rosetta (x86_64) ' +
    'start can also take ~30s, so raise --startup-timeout';
  return securityAgentRunning() ? `SecurityAgent is running, so that prompt is likely up; ${base}` : base;
}

function processAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function pidCommand(pid) {
  if (process.platform === 'win32') return null;
  try {
    return runSync('ps', ['-o', 'command=', '-p', String(pid)]);
  } catch (_) {
    return null;
  }
}

// A profile directory is single-owner: Chrome links SingletonLock to
// <hostname>-<pid>. If that pid is alive we are looking at a browser we did not
// start and must not fight over the directory.
function singletonLockHolder(userDataDir) {
  const lock = path.join(userDataDir, 'SingletonLock');
  let target;
  try { target = fs.readlinkSync(lock); } catch (_) { return null; }
  const match = String(target).match(/-(\d+)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return processAlive(pid) ? pid : null;
}

function readsDevToolsActivePort(userDataDir) {
  try {
    const text = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [portLine, pathLine] = text.split('\n');
    const port = Number(String(portLine).trim());
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, wsPath: (pathLine || '').trim() || '/devtools/browser' };
  } catch (_) {
    return null;
  }
}

function spawnChrome({ exe, userDataDir, headless, mockKeychain, logFd, extraArgs }) {
  ensureDir(userDataDir, 0o700);
  patchPreferences(userDataDir);
  const args = chromeArgs({ userDataDir, headless, mockKeychain, extraArgs });
  const stdio = logFd === undefined || logFd === null
    ? ['ignore', 'ignore', 'ignore']
    : ['ignore', logFd, logFd];
  // Detached + unref: Chrome must outlive the daemon so a daemon upgrade or
  // restart re-attaches instead of dropping the user's logged-in tabs.
  const proc = spawn(exe, args, { detached: true, stdio });
  proc.unref();
  return { proc, args };
}

async function waitForReady({ userDataDir, timeoutMs = 60000, proc = null, required = true }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    if (proc && proc.exitCode !== null && proc.exitCode !== undefined) {
      throw new MbError('chrome_exit', `browser exited before CDP was ready (code ${proc.exitCode})`);
    }
    const active = readsDevToolsActivePort(userDataDir);
    if (active) {
      try {
        const version = await fetchVersion(active.port, { timeout: 2000 });
        return { port: active.port, wsPath: active.wsPath, version, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
      } catch (error) {
        lastError = error;
      }
    }
    if (Date.now() > deadline) {
      if (!required) return null;
      const why = lastError ? ` (last probe: ${lastError.message})` : '';
      throw new MbError('chrome_timeout',
        `CDP did not become ready within ${timeoutMs}ms in ${userDataDir}${why}; ${readyHint()}`);
    }
    await new Promise(resolve => { setTimeout(resolve, 200); });
  }
}

// Only ever a Chrome we launched, and only one whose command line still names
// the exact user-data-dir we own — a recycled pid must never be signalled.
async function stopChrome({ pid, userDataDir, port, wsUrl }) {
  const owned = pid && processAlive(pid) && (!userDataDir || isOurChrome(pid, userDataDir));
  if (!owned) return { stopped: false, reason: 'not our chrome' };
  const wait = async ms => { await new Promise(resolve => { setTimeout(resolve, ms); }); };
  const waitGone = async ms => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && processAlive(pid)) {
      if (Date.now() + 100 > deadline) break;
      await wait(100);
    }
    return !processAlive(pid);
  };
  const socket = wsUrl || (port ? `ws://127.0.0.1:${port}/devtools/browser` : null);
  if (socket) {
    try {
      const client = await CDP.connect(socket, { timeout: 5000 });
      await client.send('Browser.close', {}, undefined, { timeout: 5000 });
      client.close();
      // Graceful: give Chrome a moment to flush the profile before signalling.
      if (await waitGone(STOP_GRACE_MS)) return { stopped: true, pid, via: 'Browser.close' };
    } catch (_) { /* fall back to signals below */ }
  }
  if (processAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) { /* already gone */ }
    if (!(await waitGone(STOP_GRACE_MS))) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ignore */ }
      await waitGone(1000);
    }
  }
  return { stopped: !processAlive(pid), pid };
}

// Last line of defence before a signal: only ever a Chrome whose command line
// carries the exact user-data-dir we own.
function isOurChrome(pid, userDataDir) {
  const command = pidCommand(pid);
  if (command === null) return process.platform === 'win32';
  return command.includes(`--user-data-dir=${userDataDir}`);
}

function attachUrlFromVersion(version) {
  return version.webSocketDebuggerUrl;
}

module.exports = {
  MOCK_KEYCHAIN_NOTE,
  SEEDED_NOTE,
  MAIN_CANDIDATES,
  runSync,
  osProductVersion,
  versionTuple,
  compareVersions,
  macosTier,
  parseInfoPlist,
  appBundleFor,
  machOArchitectures,
  executableIn,
  describeApp,
  describePath,
  evaluateCompatibility,
  legacyKitCandidates,
  pathCandidates,
  listCandidates,
  chooseBrowser,
  chromeArgs,
  patchPreferences,
  isProfileEmpty,
  resolveMockKeychain,
  pinMockKeychain,
  securityAgentRunning,
  readyHint,
  processAlive,
  pidCommand,
  isOurChrome,
  singletonLockHolder,
  readsDevToolsActivePort,
  spawnChrome,
  waitForReady,
  stopChrome,
  attachUrlFromVersion,
};

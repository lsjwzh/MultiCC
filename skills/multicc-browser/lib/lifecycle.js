'use strict';

// Lifecycle commands that run entirely in the CLI process: they inspect the
// machine, write profile config, and start/stop daemons. Page commands never
// live here — those go to the resident daemon.

const fs = require('fs');
const path = require('path');

const P = require('./paths');
const CH = require('./chrome');
const G = require('./gateway');
const M = require('./main-chrome');
const seed = require('./seed');
const client = require('./client');
const { VERSION } = require('./version');

const { MbError } = P;

function profileNames() {
  const names = new Set();
  for (const dir of [P.profileConfigDir(), P.defaultProfileRoot()]) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const name = entry.endsWith('.json') ? entry.slice(0, -5) : entry;
      if (P.isValidName(name)) names.add(name);
    }
  }
  names.delete(M.MAIN_NAME);
  return [M.MAIN_NAME, ...[...names].sort()];
}

function runtimeState(name) {
  const state = P.readJson(P.statePath(name), null);
  if (!state) return null;
  return { ...state, chromeAlive: CH.processAlive(Number(state.chromePid)) };
}

function profileConfig(name) {
  return P.readJson(P.configPath(name), null);
}

// A profile exists once it has a config file (written by start/attach) or a
// user-data-dir on disk (a profile seeded by the older Browser Use tooling).
// Everything that would start Chrome has to ask this first.
function profileExists(name) {
  if (M.isMainName(name)) return true;
  const config = profileConfig(name);
  return Boolean(config) || fs.existsSync((config && config.userDataDir) || P.profileDir(name));
}

// The everyday Chrome: not ours, never counted as one of our windows.
function describeMain() {
  const name = M.MAIN_NAME;
  const state = runtimeState(name);
  const dir = M.mainUserDataDir();
  const holder = CH.singletonLockHolder(dir);
  return {
    name,
    kind: 'main',
    exists: true,
    mode: 'main',
    headed: false,
    live: Boolean(holder),
    browser: null,
    attachOnly: false,
    cdpUrl: null,
    mockKeychain: false,
    userDataDir: dir,
    chromePid: holder || null,
    chromeAlive: Boolean(holder),
    daemonVersion: state ? state.version : null,
    socket: fs.existsSync(P.socketPath(name)),
  };
}

function describeProfiles() {
  return profileNames().map(name => {
    if (M.isMainName(name)) return describeMain();
    const config = profileConfig(name) || {};
    const state = runtimeState(name);
    const userDataDir = config.userDataDir || P.profileDir(name);
    // Only a live browser can put a window on the user's screen, so live state
    // beats the saved config: a profile whose last login was headed is still
    // background-only while it actually runs headless. A profile with no live
    // browser reports headless because that is what its next start does.
    const live = Boolean(state && state.chromeAlive);
    const headed = live && state.headed === true;
    // An attach-only profile mirrors an external browser mbrowser never opened
    // and never hands back, so it keeps the configured mode and is never
    // counted as one of our windows.
    const attachOnly = Boolean(config.attachOnly);
    return {
      name,
      kind: attachOnly ? 'attach' : 'managed',
      exists: Boolean(profileConfig(name)) || fs.existsSync(userDataDir),
      mode: attachOnly ? (config.headed ? 'headed' : 'headless') : (headed ? 'headed' : 'headless'),
      // A window on screen right now that we opened — the only thing that can
      // steal focus. It is reported so callers keep away from it, not so they
      // close it: an idle window does not disturb anyone, activation does.
      headed: attachOnly ? false : headed,
      live,
      browser: config.browser || null,
      attachOnly,
      cdpUrl: config.cdpUrl || null,
      mockKeychain: Boolean(config.mockKeychain) || fs.existsSync(path.join(userDataDir, P.MOCK_KEYCHAIN_MARKER)),
      userDataDir,
      chromePid: state ? state.chromePid : null,
      chromeAlive: Boolean(state && state.chromeAlive),
      daemonVersion: state ? state.version : null,
      socket: fs.existsSync(P.socketPath(name)),
    };
  });
}

// A window on screen is the one thing in this executor that can interrupt the
// user, so every listing names those profiles. It is a keep-away list, not a
// cleanup list: working a headed browser from the background needs no mode
// change and no restart, and closing a window nobody is touching gains nothing.
function headedWindowNote(profiles) {
  const open = profiles.filter(profile => profile.headed);
  if (!open.length) return [];
  return [
    `headed windows (${open.length}): ${open.map(profile => profile.name).join(', ')}`,
    '  a window is on screen for these; reuse them in place — never activate, move, ' +
    'restart or close them (background work needs no focus, an idle window harms nothing)',
  ];
}

async function doctor(args) {
  const osVersion = CH.osProductVersion();
  const tier = CH.macosTier(osVersion);
  const candidates = CH.listCandidates().map(entry => ({
    path: entry.path,
    app: entry.app,
    version: entry.version,
    minimumSystemVersion: entry.minimumSystemVersion,
    archs: entry.archs,
    compatible: entry.compatible,
    why: entry.why,
    note: entry.note,
  }));
  let chosen = null;
  let chosenError = null;
  try {
    const pick = CH.chooseBrowser({ explicit: args.browser, configured: null });
    chosen = { path: pick.path, version: pick.version, source: pick.source, note: pick.note };
  } catch (error) {
    chosenError = error.message;
  }
  const profiles = describeProfiles();
  const main = await M.inspect();
  const gateway = await G.status();
  const lines = [
    `os: ${process.platform} ${osVersion || '?'} (${tier}) arch=${process.arch}`,
    `node: ${process.version}`,
    `mbrowser: version ${VERSION} skill=${path.resolve(__dirname, '..')}`,
    `state: ${P.stateDir()}  profiles-root: ${P.defaultProfileRoot()}`,
    `socket dir: ${P.shortSocketDir()} (used when a socket path would exceed ${P.SOCKET_PATH_MAX} bytes)`,
    `main chrome (profile main, the default): ${mainLine(main)}`,
    `cdp gateway: ${gateway.running
      ? `running pid ${gateway.pid} version ${gateway.version}${gateway.compatible ? '' : ' (INCOMPATIBLE protocol)'}`
      : `not running — ${gateway.binary ? `will start ${gateway.binary} on demand` : 'binary not found (set MULTICC_CDP_BIN)'}`}`,
    'candidates (for dedicated profiles):',
  ];
  if (!candidates.length) lines.push('  (none found)');
  for (const entry of candidates) {
    const verdict = entry.compatible ? 'ok' : `NO (${entry.why})`;
    const note = entry.note ? ` — ${entry.note}` : '';
    lines.push(`  ${verdict} ${entry.path} ${entry.version || '?'}` +
      ` minOS=${entry.minimumSystemVersion || '?'} arch=${(entry.archs || []).join('+') || '?'}${note}`);
  }
  lines.push(chosen
    ? `chosen: ${chosen.path} (${chosen.source})${chosen.note ? ` — ${chosen.note}` : ''}`
    : `chosen: none — ${chosenError}`);
  lines.push(`profiles (${profiles.length}):`);
  for (const profile of profiles) {
    if (profile.kind === 'main') {
      lines.push(`  main: everyday Chrome via the gateway daemon=${profile.socket ? 'up' : 'down'} dir=${profile.userDataDir}`);
      continue;
    }
    lines.push(`  ${profile.name}: ${profile.mode}${profile.attachOnly ? ' attach-only' : ''}` +
      ` chrome=${profile.chromePid || '-'}${profile.chromeAlive ? ' alive' : ''}` +
      `${profile.headed ? ' [window on screen]' : ''}` +
      ` daemon=${profile.socket ? 'up' : 'down'} dir=${profile.userDataDir}`);
  }
  if (!profiles.length) lines.push('  (none)');
  lines.push(...headedWindowNote(profiles));
  return {
    text: lines.join('\n'),
    os: { platform: process.platform, version: osVersion, tier, arch: process.arch },
    node: process.version,
    version: VERSION,
    candidates,
    chosen,
    chosenError,
    profiles,
    main,
    gateway,
  };
}

function mainLine(main) {
  if (!main.exists) return `no Chrome profile at ${main.dir}`;
  if (main.debuggable) return `running pid ${main.pid || '?'}, remote debugging on (port ${main.port})`;
  if (main.running) return `running, remote debugging OFF — ${M.ENABLE_HINT}`;
  return `not running; mbrowser starts it in the background on first use` +
    `${main.remoteDebuggingRemembered === false ? ` (remote debugging is not switched on: ${M.ENABLE_HINT})` : ''}`;
}

function profiles() {
  const list = describeProfiles();
  const lines = list.length
    ? list.map(profile => profile.kind === 'main'
      ? `main: everyday Chrome (default; via the MultiCC gateway) daemon=${profile.socket ? 'up' : 'down'}` +
        ` chrome=${profile.chromePid || '-'}${profile.chromeAlive ? ' (alive)' : ''} ${profile.userDataDir}`
      : `${profile.name}: ${profile.mode}${profile.attachOnly ? ' attach-only' : ''}` +
      ` daemon=${profile.socket ? 'up' : 'down'} chrome=${profile.chromePid || '-'}` +
      `${profile.chromeAlive ? ' (alive)' : ''}${profile.headed ? ' [window on screen]' : ''}` +
      ` ${profile.userDataDir}`)
    : ['(no profiles yet; create one with `mbrowser start NAME --create`)'];
  lines.push(...headedWindowNote(list));
  return { text: lines.join('\n'), profiles: list };
}

// The main profile has no config and no mode: it is whatever the user's own
// Chrome is. Starting it means connecting (starting Chrome in the background
// only if it is not running).
async function startMain(args) {
  for (const flag of ['headed', 'headless', 'browser', 'mockKeychain', 'blank']) {
    if (args[flag]) {
      throw new MbError('usage',
        `--${flag.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} does not apply to main, the user's everyday Chrome; ` +
        'use a dedicated profile (start NAME --create) for that');
    }
  }
  P.ensureStateDirs();
  const ping = await client.ensureDaemon(M.MAIN_NAME, {});
  const status = await client.call(M.MAIN_NAME, 'status', {});
  const lines = [
    `profile main: the user's everyday Chrome (pid ${status.chromePid || '?'}, port ${status.port || '-'}) ` +
      `via the MultiCC CDP gateway; daemon pid ${ping.pid} version ${ping.version}`,
    `user-data-dir: ${status.userDataDir}`,
    `tabs in that Chrome: ${(status.tabs || []).length} — pages you open are background tabs; ` +
      'nothing is activated, and stopping mbrowser never closes this browser',
  ];
  return { text: lines.join('\n'), ping, status, restarted: null, config: null };
}

async function start(args) {
  const name = args.name;
  P.requireName(name);
  if (M.isMainName(name)) return startMain(args);
  P.ensureStateDirs();
  const configPath = P.configPath(name);
  const existing = profileConfig(name);
  const exists = profileExists(name);
  if (!exists && !args.create) {
    throw new MbError('not_created',
      `profile ${name} does not exist; create it with \`mbrowser start ${name} --create\``);
  }
  // A new browser starts with the user's login unless they said otherwise.
  // Read it before anything is created, so a main Chrome that cannot be
  // reached leaves no half-made profile behind.
  const seeding = !exists && !args.blank;
  const cookies = seeding ? await seed.exportMainCookies() : null;
  if (args.headed && args.headless) {
    throw new MbError('usage', '--headed and --headless cannot be used together');
  }
  const explicitMode = args.headed === true || args.headless === true;
  const headed = explicitMode ? args.headed === true : undefined;
  const config = {
    name,
    ...(existing || {}),
    ...(explicitMode ? { headed } : {}),
    attachOnly: Boolean(existing && existing.attachOnly),
    updatedAt: Date.now(),
  };
  if (!config.createdAt) config.createdAt = Date.now();
  if (!exists) config.seed = seeding ? { from: 'main', status: 'pending' } : { from: 'blank' };
  if (args.browser) config.browser = args.browser;
  if (args.mockKeychain) config.mockKeychain = true;
  if (args.startupTimeout !== undefined) config.startupTimeout = Number(args.startupTimeout);
  P.writeJson(configPath, config);
  const daemonOptions = {
    ...(explicitMode ? { headed } : {}),
    browser: config.browser,
    mockKeychain: config.mockKeychain,
    startupTimeout: config.startupTimeout,
  };
  const ping = await client.ensureDaemon(name, { daemonOptions });
  let seeded = null;
  if (seeding) {
    seeded = await client.call(name, 'import-cookies', { cookies }, { timeoutMs: 300000 });
    seed.markSeeded(config.userDataDir || P.profileDir(name));
    config.seed = { from: 'main', status: 'done', cookies: seeded.imported, failed: seeded.failed, at: Date.now() };
    P.writeJson(configPath, config);
  }
  let restarted = null;
  if (explicitMode && Boolean(ping.headed) !== headed) {
    restarted = await client.call(name, 'set-mode',
      { headed, force: Boolean(args.force), owner: client.ownerFromEnv() });
  }
  const status = await client.call(name, 'status', {});
  const mode = `Chrome ${status.headed ? 'headed' : 'headless'}${restarted ? ' (restarted)' : ''}`;
  const lines = [
    `profile ${name}: daemon pid ${ping.pid} version ${ping.version}, ${mode}, chrome pid ${status.chromePid || '-'} port ${status.port || '-'}`,
    `user-data-dir: ${status.userDataDir}`,
    `browser: ${status.browser || '-'}`,
    `socket: ${status.socket}`,
  ];
  if (status.attachOnly) lines.push(`attach-only: ${status.cdpUrl}`);
  if (seeded) {
    lines.push(`login: imported ${seeded.imported} cookies from the everyday Chrome` +
      `${seeded.failed ? ` (${seeded.failed} rejected)` : ''}; check the site still shows the account ` +
      '(localStorage logins and Google sessions do not carry over)');
  } else if (!exists) {
    lines.push('login: none — created blank (--blank), as requested');
  }
  return { text: lines.join('\n'), ping, status, restarted, config, seeded };
}

// Interactive login: headed Chrome; the user switches to its background tab.
async function login(args) {
  const name = args.name;
  if (M.isMainName(name)) {
    // The user's own Chrome needs no mode change: open the page in a
    // background tab and let the user switch to it themselves.
    const started = await startMain({});
    const opened = args.url ? await client.call(name, 'open', { url: args.url, newTab: true }) : null;
    return {
      text: [
        started.text,
        opened ? `opened ${args.url} in background tab ${opened.shortId} of the everyday Chrome; ` +
          'ask the user to switch to that tab and log in — mbrowser does not activate it'
          : 'ask the user to log in in their everyday Chrome; mbrowser does not activate it',
      ].join('\n'),
      started,
      opened,
    };
  }
  const started = await start({ ...args, headed: true, headless: false });
  let opened = null;
  if (args.url) {
    opened = await client.call(name, 'open', { url: args.url, newTab: true });
  }
  const url = args.url || '(no URL given; use `mbrowser open` or the address bar)';
  const lines = [
    started.text,
    opened ? `opened ${args.url} in background tab ${opened.shortId}; switch to that browser window and tab to log in`
      : `switch to the browser window to log in: ${url}`,
    `this window sits where it is and mbrowser never activates it; once the manual step ` +
      `is done, keep working in this same window — no mode change, no restart, no need to close it.`,
    'If other sessions hold tabs on this profile, do not restart or close this browser — tell the user instead.',
    'If the browser exits on its own, the next page command cold-starts it headless (a cold start opens no window).',
  ];
  return { text: lines.join('\n'), started, opened };
}

async function attach(args) {
  const name = args.name;
  P.requireName(name);
  if (!args.cdpUrl) throw new MbError('usage', 'attach needs --cdp-url http://127.0.0.1:PORT');
  let parsed;
  try {
    parsed = new URL(args.cdpUrl);
  } catch (_) {
    throw new MbError('usage', `--cdp-url ${args.cdpUrl} is not a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if (!loopback.includes(parsed.hostname)) {
    throw new MbError('usage',
      `attach only accepts a loopback --cdp-url (got ${parsed.hostname}); exposing CDP remotely is not supported`);
  }
  const config = {
    name,
    ...(profileConfig(name) || {}),
    attachOnly: true,
    cdpUrl: args.cdpUrl,
    headed: true,
    updatedAt: Date.now(),
  };
  if (!config.createdAt) config.createdAt = Date.now();
  P.writeJson(P.configPath(name), config);
  // A running daemon holds the endpoint it booted with, so re-attaching a
  // profile to a *different* browser has to retire it: otherwise the command
  // reports success while every later call still talks to the old browser.
  const running = await client.pingOnce(name);
  let retired = null;
  if (running && (running.cdpUrl !== args.cdpUrl || !running.attachOnly)) {
    // An attached daemon never owned its Chrome, so it must leave it alone; a
    // daemon that launched one would leave that Chrome orphaned — and the new
    // attach-only config removes every handle on it — so it stops it.
    const keepChrome = Boolean(running.attachOnly);
    await client.requestOnce(P.socketPath(name), { id: 1, cmd: 'shutdown', args: { keepChrome } },
      { timeout: 15000 }).catch(() => {});
    await client.waitForSocketGone(P.socketPath(name), 5000);
    retired = { pid: running.pid, cdpUrl: running.cdpUrl || null, keepChrome };
  }
  const ping = await client.ensureDaemon(name, { daemonOptions: { headed: true } });
  const status = await client.call(name, 'status', {});
  return {
    text: `profile ${name}: attached to ${args.cdpUrl} (never launched or killed by mbrowser)\n` +
      (retired
        ? `retired the previous daemon (pid ${retired.pid}, ${retired.cdpUrl || 'no endpoint'})` +
          `${retired.keepChrome ? ', its chrome left as it was' : ', the chrome it had launched was stopped'}\n`
        : '') +
      `daemon pid ${ping.pid}, port ${status.port || '-'}, tabs ${(status.tabs || []).length}`,
    ping,
    status,
    retired,
  };
}

async function status(args) {
  const name = args.name;
  P.requireName(name);
  const ping = await client.pingOnce(name);
  const config = profileConfig(name);
  const state = runtimeState(name);
  if (ping) {
    const detail = await client.call(name, 'status', {});
    const tabs = (detail.tabs || []).map(tab =>
      `  ${tab.shortId} ${tab.title || '(untitled)'} — ${tab.url}${tab.owner ? ` [${tab.owner}]` : ''}`);
    const text = [
      `profile ${name}: daemon up (pid ${ping.pid}, version ${ping.version})`,
      `chrome: pid ${ping.chromePid || '-'} port ${ping.port || '-'} ${ping.headed ? 'headed' : 'headless'}` +
        `${ping.owned ? ' (owned by mbrowser)' : ' (not owned)'}`,
      `state: ${ping.state}${ping.reason ? ` (${ping.reason})` : ''} uptime ${Math.round(ping.uptime / 1000)}s restarts ${ping.restarts}`,
      `owners: ${(ping.owners || []).join(', ') || '-'}`,
      `tabs (${(detail.tabs || []).length}):`, ...tabs,
    ].join('\n');
    return { text, running: true, ping, status: detail, config, state };
  }
  if (M.isMainName(name)) {
    const main = await M.inspect();
    return {
      text: `profile main: daemon down\nmain chrome: ${mainLine(main)}\nnext command: connects through the MultiCC gateway`,
      running: false, ping: null, config: null, state, main,
    };
  }
  const lines = [`profile ${name}: daemon down`];
  if (config) lines.push(`config: ${config.headed ? 'headed was last requested (e.g. a manual login)' : 'headless'}` +
    `${config.attachOnly ? ` attach-only=${config.cdpUrl}` : ''}` +
    `${config.browser ? ` browser=${config.browser}` : ''}`);
  else lines.push('config: (none)');
  // A cold start is always headless, whatever the config last asked for: no
  // window opens unless someone passes --headed on purpose.
  lines.push(`next start: ${config && config.attachOnly ? 'the attached browser, untouched' : 'headless (background, no window)'}`);
  if (state) {
    lines.push(`last chrome pid ${state.chromePid || '-'}${state.chromeAlive ? ' (still alive)' : ' (gone)'}` +
      ` port ${state.port || '-'}`);
  }
  return { text: lines.join('\n'), running: false, ping: null, config, state };
}

// The daemon drops <name>.json only once the browser stop has landed, so the
// file still sitting there means Chrome is on its way out. `stop` must not
// return while a browser the user asked to stop is still running.
async function waitForStopLanded(name, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = P.readJson(P.statePath(name), null);
    if (!state || !CH.processAlive(Number(state.chromePid))) return true;
    if (Date.now() > deadline) return false;
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
}

async function stopProfile(name, { keepChrome }) {
  if (M.isMainName(name)) keepChrome = true;
  const ping = await client.pingOnce(name);
  if (ping) {
    await client.requestOnce(P.socketPath(name), { id: 1, cmd: 'shutdown', args: { keepChrome } },
      { timeout: 15000 });
    await client.waitForSocketGone(P.socketPath(name), 5000);
    const landed = keepChrome || await waitForStopLanded(name);
    return `profile ${name}: daemon stopped${M.isMainName(name) ? ', the everyday Chrome is untouched'
      : (keepChrome ? ', chrome kept running' : '')}` +
      `${landed ? '' : ' (browser stop is still in flight)'}`;
  }
  const state = runtimeState(name);
  if (state && state.chromeAlive && !keepChrome) {
    // No daemon to ask, so read the browser endpoint straight off disk: a
    // DevToolsActivePort hit lets us send Browser.close instead of a signal.
    const active = CH.readsDevToolsActivePort(state.userDataDir || P.profileDir(name));
    const stopped = await CH.stopChrome({
      pid: Number(state.chromePid),
      userDataDir: state.userDataDir,
      port: state.port || (active && active.port),
      wsUrl: active ? `ws://127.0.0.1:${active.port}${active.wsPath}` : undefined,
    });
    if (stopped.stopped) {
      P.removeFile(P.statePath(name));
      return `profile ${name}: no daemon, stopped the orphaned chrome pid ${state.chromePid}`;
    }
    return `profile ${name}: no daemon, chrome pid ${state.chromePid} could not be stopped`;
  }
  return `profile ${name}: already stopped`;
}

async function stop(args) {
  const keepChrome = Boolean(args.keepChrome);
  if (args.all) {
    const names = profileNames();
    const lines = [];
    for (const name of names) lines.push(await stopProfile(name, { keepChrome }));
    return { text: lines.join('\n') || '(no profiles)', stopped: names };
  }
  const line = await stopProfile(args.name, { keepChrome });
  return { text: line, stopped: [args.name] };
}

module.exports = {
  profileNames,
  describeProfiles,
  runtimeState,
  profileConfig,
  profileExists,
  doctor,
  profiles,
  start,
  login,
  attach,
  status,
  stop,
  stopProfile,
};

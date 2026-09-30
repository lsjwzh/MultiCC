'use strict';

// Lifecycle commands that run entirely in the CLI process: they inspect the
// machine, write profile config, and start/stop daemons. Page commands never
// live here — those go to the resident daemon.

const fs = require('fs');
const path = require('path');

const P = require('./paths');
const CH = require('./chrome');
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
  return [...names].sort();
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
  const config = profileConfig(name);
  return Boolean(config) || fs.existsSync((config && config.userDataDir) || P.profileDir(name));
}

function describeProfiles() {
  return profileNames().map(name => {
    const config = profileConfig(name) || {};
    const state = runtimeState(name);
    const userDataDir = config.userDataDir || P.profileDir(name);
    return {
      name,
      exists: Boolean(profileConfig(name)) || fs.existsSync(userDataDir),
      mode: config.headed ? 'headed' : 'headless',
      browser: config.browser || null,
      attachOnly: Boolean(config.attachOnly),
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
  const lines = [
    `os: ${process.platform} ${osVersion || '?'} (${tier}) arch=${process.arch}`,
    `node: ${process.version}`,
    `mbrowser: version ${VERSION} skill=${path.resolve(__dirname, '..')}`,
    `state: ${P.stateDir()}  profiles-root: ${P.defaultProfileRoot()}`,
    `socket dir: ${P.shortSocketDir()} (used when a socket path would exceed ${P.SOCKET_PATH_MAX} bytes)`,
    'candidates:',
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
    lines.push(`  ${profile.name}: ${profile.mode}${profile.attachOnly ? ' attach-only' : ''}` +
      ` chrome=${profile.chromePid || '-'}${profile.chromeAlive ? ' alive' : ''}` +
      ` daemon=${profile.socket ? 'up' : 'down'} dir=${profile.userDataDir}`);
  }
  if (!profiles.length) lines.push('  (none)');
  return {
    text: lines.join('\n'),
    os: { platform: process.platform, version: osVersion, tier, arch: process.arch },
    node: process.version,
    version: VERSION,
    candidates,
    chosen,
    chosenError,
    profiles,
  };
}

function profiles() {
  const list = describeProfiles();
  const lines = list.length
    ? list.map(profile => `${profile.name}: ${profile.mode}${profile.attachOnly ? ' attach-only' : ''}` +
      ` daemon=${profile.socket ? 'up' : 'down'} chrome=${profile.chromePid || '-'}` +
      `${profile.chromeAlive ? ' (alive)' : ''} ${profile.userDataDir}`)
    : ['(no profiles yet; create one with `mbrowser start NAME --create`)'];
  return { text: lines.join('\n'), profiles: list };
}

async function start(args) {
  const name = args.name;
  P.requireName(name);
  P.ensureStateDirs();
  const configPath = P.configPath(name);
  const existing = profileConfig(name);
  const exists = profileExists(name);
  if (!exists && !args.create) {
    throw new MbError('not_created',
      `profile ${name} does not exist; create it with \`mbrowser start ${name} --create\``);
  }
  const headed = args.headed === true
    ? true
    : (args.headless === true ? false : Boolean(existing && existing.headed));
  const config = {
    name,
    ...(existing || {}),
    headed,
    attachOnly: Boolean(existing && existing.attachOnly),
    updatedAt: Date.now(),
  };
  if (!config.createdAt) config.createdAt = Date.now();
  if (args.browser) config.browser = args.browser;
  if (args.mockKeychain) config.mockKeychain = true;
  if (args.startupTimeout !== undefined) config.startupTimeout = Number(args.startupTimeout);
  P.writeJson(configPath, config);
  const daemonOptions = {
    headed,
    browser: config.browser,
    mockKeychain: config.mockKeychain,
    startupTimeout: config.startupTimeout,
  };
  const ping = await client.ensureDaemon(name, { daemonOptions });
  let restarted = null;
  if (Boolean(ping.headed) !== headed) {
    restarted = await client.call(name, 'set-mode',
      { headed, force: Boolean(args.force), owner: client.ownerFromEnv() });
  }
  const status = await client.call(name, 'status', {});
  const mode = `Chrome ${ping.headed ? 'headed' : 'headless'}${restarted ? ' (restarted)' : ''}`;
  const lines = [
    `profile ${name}: daemon pid ${ping.pid} version ${ping.version}, ${mode}, chrome pid ${status.chromePid || '-'} port ${status.port || '-'}`,
    `user-data-dir: ${status.userDataDir}`,
    `browser: ${status.browser || '-'}`,
    `socket: ${status.socket}`,
  ];
  if (status.attachOnly) lines.push(`attach-only: ${status.cdpUrl}`);
  return { text: lines.join('\n'), ping, status, restarted, config };
}

// Interactive login: headed Chrome plus a visible tab the user can drive.
async function login(args) {
  const name = args.name;
  const started = await start({ ...args, headed: true, headless: false });
  let opened = null;
  if (args.url) {
    opened = await client.call(name, 'open', { url: args.url, newTab: true });
  }
  const url = args.url || '(no URL given; use `mbrowser open` or the address bar)';
  const lines = [
    started.text,
    opened ? `opened ${args.url} in a visible tab ${opened.shortId}` : `open this in the window: ${url}`,
    `Log in there, then run \`mbrowser start ${name} --headless\` to continue headless.`,
    'The daemon keeps this Chrome alive: closing the window only stops your view, not the session.',
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
  const lines = [`profile ${name}: daemon down`];
  if (config) lines.push(`config: ${config.headed ? 'headed' : 'headless'}` +
    `${config.browser ? ` browser=${config.browser}` : ''}${config.attachOnly ? ` attach-only=${config.cdpUrl}` : ''}`);
  else lines.push('config: (none)');
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
  const ping = await client.pingOnce(name);
  if (ping) {
    await client.requestOnce(P.socketPath(name), { id: 1, cmd: 'shutdown', args: { keepChrome } },
      { timeout: 15000 });
    await client.waitForSocketGone(P.socketPath(name), 5000);
    const landed = keepChrome || await waitForStopLanded(name);
    return `profile ${name}: daemon stopped${keepChrome ? ', chrome kept running' : ''}` +
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

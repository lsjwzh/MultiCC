'use strict';

// CLI side of the daemon IPC: connect, ping, auto-start, and retire a daemon
// whose code version no longer matches this CLI.
//
// A version mismatch is not an error the user should ever see: the old daemon
// is asked to exit *keeping Chrome*, so the replacement re-attaches to the same
// browser and the tabs they are logged into survive the skill upgrade.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const P = require('./paths');
const CH = require('./chrome');
const { VERSION } = require('./version');

const { MbError } = P;

const PING_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 120000;
const STARTUP_GRACE_MS = 10000;

// Deliberately NOT unref'd: while the CLI waits for a daemon to come up, this
// timer is often the only thing keeping the event loop alive, and an unref'd
// one lets the process exit 0 before the daemon has even answered.
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function daemonScript() {
  return path.join(__dirname, 'daemon.js');
}

function ownerFromEnv() {
  return process.env.MULTICC_SESSION_ID || 'cli';
}

function requestOnce(socketPath, request, { timeout = PING_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new MbError('timeout', `no answer from ${socketPath} within ${timeout}ms`));
    }, timeout);
    socket.on('connect', () => {
      try { socket.write(`${JSON.stringify(request)}\n`); } catch (error) { finish(new MbError('ipc', error.message)); }
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, index)));
      } catch (_) {
        finish(new MbError('ipc', 'daemon sent malformed JSON'));
      }
    });
    socket.on('error', error => {
      finish(new MbError('ipc', error.code === 'ENOENT'
        ? `no daemon socket at ${socketPath}`
        : `${socketPath}: ${error.message}`));
    });
    socket.on('close', () => finish(new MbError('ipc', 'daemon closed the connection without answering')));
  });
}

async function pingOnce(name) {
  try {
    const response = await requestOnce(P.socketPath(name), { id: 1, cmd: 'ping' }, { timeout: PING_TIMEOUT_MS });
    return response && response.ok ? response.result : null;
  } catch (_) {
    return null;
  }
}

function spawnDaemon(name, options = {}) {
  const child = spawn(process.execPath, [daemonScript(), name], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MBROWSER_DAEMON_OPTIONS: JSON.stringify(options) },
  });
  child.unref();
  return child.pid;
}

async function waitForSocketGone(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gone = await new Promise(resolve => {
      const probe = net.createConnection(socketPath);
      probe.on('connect', () => { probe.destroy(); resolve(false); });
      probe.on('error', () => resolve(true));
    });
    if (gone) return true;
    await sleep(100);
  }
  return false;
}

// A daemon that dies during startup has already written the actual reason to
// its log ("boot failed: <code>: <message>"). Re-reporting it as a generic
// "daemon exited" makes the user open a file to learn their --browser path was
// wrong, so dig the reason out and rethrow it as this CLI's own error.
function startupFailureFromLog(name) {
  let text = '';
  try { text = fs.readFileSync(P.logPath(name), 'utf8'); } catch (_) { return null; }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  // Only the current boot counts: an old failure left in the log must not be
  // re-reported as the reason this brand-new daemon died.
  let from = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/daemon start pid=\d+/.test(lines[index])) { from = index; break; }
  }
  for (let index = lines.length - 1; index >= from; index -= 1) {
    const match = /boot failed: ([a-z0-9_]+): (.*)$/.exec(lines[index]);
    if (match) return { code: match[1], message: match[2] };
  }
  return null;
}

function daemonGoneError(name) {
  const failure = startupFailureFromLog(name);
  if (failure) {
    return new MbError(failure.code, `${failure.message} (daemon log: ${P.logPath(name)})`);
  }
  return new MbError('daemon_died', `daemon exited during startup; see ${P.logPath(name)}`);
}

async function waitForDaemon(name, { timeoutMs, pid }) {
  const socketPath = P.socketPath(name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pingOnce(name);
    if (result) return result;
    if (pid && !CH.processAlive(pid)) throw daemonGoneError(name);
    if (Date.now() > deadline) {
      throw new MbError('daemon_timeout',
        `daemon did not answer within ${timeoutMs}ms; see ${P.logPath(name)}`);
    }
    await sleep(250);
  }
}

// Returns the ping payload of a daemon this CLI can talk to, starting one if
// needed and replacing one whose code version is stale.
async function ensureDaemon(name, options = {}) {
  P.requireName(name);
  P.ensureStateDirs();
  const version = options.version || VERSION;
  const socketPath = P.socketPath(name);
  let ping = await pingOnce(name);
  if (ping && ping.version !== version) {
    await requestOnce(socketPath, { id: 1, cmd: 'shutdown', args: { keepChrome: true } }, { timeout: 10000 })
      .catch(() => {});
    await waitForSocketGone(socketPath, 5000);
    ping = null;
  }
  if (ping) return ping;
  const spawnImpl = options.spawn || spawnDaemon;
  const daemonOptions = options.daemonOptions || {};
  const pid = spawnImpl(name, daemonOptions);
  const timeoutMs = (Number(daemonOptions.startupTimeout) || 60) * 1000 + STARTUP_GRACE_MS;
  return waitForDaemon(name, { timeoutMs, pid });
}

async function call(name, cmd, args = {}, options = {}) {
  // ensureDaemon already guarantees the daemon we talk to runs this CLI's code
  // version (a stale one is retired with keepChrome), so no drift check is due.
  await ensureDaemon(name, options);
  const socketPath = P.socketPath(name);
  const response = await requestOnce(socketPath, {
    id: Date.now() % 1000000000,
    cmd,
    args,
    owner: options.owner || ownerFromEnv(),
    tab: options.tab || undefined,
  }, { timeout: options.timeoutMs || CALL_TIMEOUT_MS });
  if (!response) throw new MbError('ipc', 'daemon returned nothing');
  if (!response.ok) {
    const error = response.error || {};
    throw new MbError(error.code || 'error', error.message || 'daemon error');
  }
  return response.result;
}

// A lifecycle probe that must never start a daemon (status, stop).
async function callIfRunning(name, cmd, args = {}, options = {}) {
  const ping = await pingOnce(name);
  if (!ping) return null;
  return call(name, cmd, args, options);
}

module.exports = {
  PING_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  daemonScript,
  ownerFromEnv,
  requestOnce,
  pingOnce,
  spawnDaemon,
  waitForDaemon,
  waitForSocketGone,
  ensureDaemon,
  call,
  callIfRunning,
};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Thin host bridge: the independent Rust executable owns the restart policy.
function scheduleRustRestart({ spawn, rootDir, dataDir, port, host = '127.0.0.1', env = process.env }) {
  const addon = env.MULTICC_RUST_ADDON || path.join(env.MULTICC_RUST_PREBUILT_DIR || path.join(rootDir, 'native', 'prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
  const oldPid = Number(env.MULTICC_GATEWAY_PID);
  if (!addon || env.MULTICC_GATEWAY_CHILD !== '1' || oldPid !== process.ppid || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('restart requires a verified gateway parent'), { code: 'RESTART_GATEWAY_INVALID' });
  }
  const probeHost = host === '::1' || host === '::' ? '::1' : host === '127.0.0.1' || host === '0.0.0.0' ? '127.0.0.1' : null;
  if (!probeHost) throw Object.assign(new Error('restart cannot safely verify this bind address'), { code: 'RESTART_BIND_UNSUPPORTED' });
  const dir = path.dirname(path.resolve(addon));
  const binary = path.join(dir, process.platform === 'win32' ? 'restart-supervisor.exe' : 'restart-supervisor');
  const gateway = path.join(dir, process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  fs.accessSync(binary, fs.constants.X_OK);
  const mode = env.MULTICC_DESKTOP === '1' ? (env.MULTICC_DESKTOP_SHELL === '1' ? 'desktop' : 'standalone')
    : env.MULTICC_SOURCE_FOREGROUND === '1' ? 'source' : 'background';
  const generation = crypto.randomBytes(24).toString('hex');
  const logs = path.join(dataDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const logPath = path.join(logs, 'restart-supervisor.log');
  const config = { mode, old_pid: oldPid, port, probe_host: probeHost, generation,
    generation_file: path.join(dataDir, '.restart-generation'), lock_file: path.join(dataDir, '.restart-supervisor.lock'),
    cwd: rootDir, gateway, node: process.execPath, log_path: logPath };
  const output = fs.openSync(logPath, 'a', 0o600);
  let child;
  try { child = spawn(binary, [], { detached: true, cwd: rootDir, windowsHide: true,
    stdio: ['ignore', 'pipe', output], env: { ...env, MULTICC_RESTART_CONFIG: JSON.stringify(config) } }); }
  finally { fs.closeSync(output); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error('restart supervisor handshake timed out')), 10000);
    function done(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { child.kill(); } catch (_) {}
        try { if (fs.readFileSync(config.generation_file, 'utf8') === generation) fs.unlinkSync(config.generation_file); } catch (_) {}
        return reject(error);
      }
      child.stdout.destroy();
      child.unref();
      resolve({ mode, logPath });
    }
    let message = '';
    child.stdout.on('data', chunk => {
      message += chunk.toString();
      if (message.includes('\n')) done(message.trim() === 'READY' ? null : new Error('invalid restart supervisor handshake'));
      if (message.length > 256) done(new Error('invalid restart supervisor handshake'));
    });
    child.once('error', done);
    child.once('exit', code => done(new Error(`restart supervisor exited before handshake: ${code}`)));
  });
}

// Use the same ./multicc restart entry as a manual restart, with a bash fallback
// for source/archive installs that did not preserve the executable bit.
const BASH_PATH = '/bin/bash';
const MANAGER_NAME = 'multicc';
const RESTART_EXEC_COMMAND = `if [ -x ./${MANAGER_NAME} ]; then exec ./${MANAGER_NAME} restart; else exec ${BASH_PATH} ./${MANAGER_NAME} restart; fi`;
const RESTART_SHELL_COMMAND = `sleep 2 && ${RESTART_EXEC_COMMAND}`;
const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

function writeRestartScript(rootDir, fsImpl = fs) {
  const logs = path.join(rootDir, 'logs');
  fsImpl.mkdirSync(logs, { recursive: true });
  const directory = fsImpl.mkdtempSync(path.join(logs, 'restart-'));
  fsImpl.chmodSync(directory, 0o700);
  const scriptPath = path.join(directory, 'restart.sh');
  // Materialize a real detached script, preserving the manual manager entry.
  // Absolute cwd + shell quoting work with spaces, quotes and shell metacharacters.
  fsImpl.writeFileSync(scriptPath, `#!/bin/sh\ntrap '' HUP\n/bin/sleep 2\ncd ${shellQuote(rootDir)} || exit 1\n${RESTART_EXEC_COMMAND}\n`, { mode: 0o700 });
  return { scriptPath, logPath: path.join(directory, 'restart.log') };
}

class RestartPreflightError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RestartPreflightError';
    this.code = code;
  }
}

function preflightRestart(options = {}) {
  const {
    rootDir,
    fsImpl = fs,
    pathImpl = path,
    bashPath = BASH_PATH,
    managerName = MANAGER_NAME,
  } = options;
  if (!rootDir) throw new TypeError('restart preflight requires rootDir');

  const managerPath = pathImpl.join(rootDir, managerName);
  let managerStat;
  try {
    managerStat = fsImpl.statSync(managerPath);
  } catch (error) {
    throw new RestartPreflightError('RESTART_MANAGER_MISSING', 'restart manager is unavailable', error);
  }
  if (!managerStat.isFile()) {
    throw new RestartPreflightError('RESTART_MANAGER_INVALID', 'restart manager is not a regular file');
  }
  try {
    fsImpl.accessSync(managerPath, fsImpl.constants.R_OK);
  } catch (error) {
    throw new RestartPreflightError('RESTART_MANAGER_UNREADABLE', 'restart manager is not readable', error);
  }

  let bashStat;
  try {
    bashStat = fsImpl.statSync(bashPath);
  } catch (error) {
    throw new RestartPreflightError('RESTART_BASH_MISSING', 'bash is unavailable', error);
  }
  if (!bashStat.isFile()) {
    throw new RestartPreflightError('RESTART_BASH_INVALID', 'bash is not a regular file');
  }
  try {
    fsImpl.accessSync(bashPath, fsImpl.constants.X_OK);
  } catch (error) {
    throw new RestartPreflightError('RESTART_BASH_UNUSABLE', 'bash is not executable', error);
  }

  return Object.freeze({ managerPath, bashPath });
}

function scheduleDetachedRestart(options = {}) {
  const {
    spawn,
    rootDir,
    env = process.env,
    log = console,
    onFailure = () => {},
    fsImpl,
    pathImpl,
  } = options;
  if (typeof spawn !== 'function') throw new TypeError('restart scheduler requires spawn');
  if (!rootDir) throw new TypeError('restart scheduler requires rootDir');
  if (typeof onFailure !== 'function') throw new TypeError('restart scheduler requires onFailure function');

  // Keep this synchronous: the HTTP route must not acknowledge scheduling when
  // the manager cannot even be read or the shell cannot be executed.
  preflightRestart({ rootDir, fsImpl, pathImpl });

  const files = fsImpl || fs;
  const { scriptPath, logPath } = writeRestartScript(rootDir, files);
  const output = files.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn('/bin/sh', [scriptPath], {
      cwd: rootDir, detached: true, stdio: ['ignore', output, output],
      env: { ...env, MULTICC_NODE: process.execPath },
    });
  } finally { files.closeSync(output); }
  if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
    throw new TypeError('restart scheduler received an invalid child process');
  }

  let failureReported = false;
  const reportFailure = (code, error) => {
    if (failureReported) return;
    failureReported = true;
    const failure = error instanceof Error ? error : new Error(code);
    failure.code = failure.code || code;
    log.error('[multicc] /api/restart: detached restart failed', failure.message);
    try { onFailure(failure); } catch (callbackError) {
      log.error('[multicc] /api/restart: failure callback failed', callbackError && callbackError.message);
    }
  };

  child.once('error', error => reportFailure('RESTART_CHILD_ERROR', error));
  child.once('exit', (code, signal) => {
    if (code === 0) return;
    const detail = code == null ? `signal ${signal || 'unknown'}` : `exit ${code}`;
    const error = new Error(`restart manager terminated with ${detail}`);
    error.code = 'RESTART_CHILD_EXIT';
    error.exitCode = code;
    error.signal = signal || null;
    reportFailure('RESTART_CHILD_EXIT', error);
  });
  child.unref();
  log.log('[multicc] /api/restart: detached graceful restart scheduled');
  return child;
}

module.exports = {
  scheduleRustRestart,
  BASH_PATH,
  MANAGER_NAME,
  RESTART_EXEC_COMMAND,
  RESTART_SHELL_COMMAND,
  RestartPreflightError,
  preflightRestart,
  writeRestartScript,
  scheduleDetachedRestart,
};

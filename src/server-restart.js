'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Invoke the manager through bash instead of executing ./multicc directly.
// Source/archive installs do not reliably preserve the executable bit; direct
// execution then exits 126 after the API has already reported success.
const BASH_PATH = '/bin/bash';
const MANAGER_NAME = 'multicc';
const RESTART_EXEC_COMMAND = `exec ${BASH_PATH} ./${MANAGER_NAME} restart`;
const RESTART_SHELL_COMMAND = `sleep 2 && ${RESTART_EXEC_COMMAND}`;

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

  const child = spawn('/bin/sh', ['-c', RESTART_SHELL_COMMAND], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    env,
  });
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
  BASH_PATH,
  MANAGER_NAME,
  RESTART_EXEC_COMMAND,
  RESTART_SHELL_COMMAND,
  RestartPreflightError,
  preflightRestart,
  scheduleDetachedRestart,
};

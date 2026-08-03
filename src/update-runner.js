'use strict';

// ── Run `./multicc update` from the web UI ──
//
// The hard constraint here is that the update restarts the server: the process
// that starts the run is not the process that can report how it ended. So the
// run's state lives on disk, not in memory. The detached child writes one log
// file and terminates it with an exit marker; status is read back from that
// file by whichever server process happens to be alive when the client asks.
//
// Everything else follows from that. The child is spawned detached with its own
// process group so `do_stop`'s kill of the server PID cannot take it down
// mid-update. The log is truncated (not appended) at the start of each run, so
// a status read can never mistake the previous run's exit marker for this one's.

const fs = require('node:fs');
const path = require('node:path');

const BASH_PATH = '/bin/bash';
const MANAGER_NAME = 'multicc';
const UPDATE_LOG_RELATIVE = path.join('logs', 'update.log');
// Distinctive enough that update output can never counterfeit it by accident.
const EXIT_MARKER = '__MULTICC_UPDATE_EXIT__';
const START_MARKER = '__MULTICC_UPDATE_START__';
// npm install on a cold cache is the slow case; anything past this is a run
// that died without writing its marker (host reboot, SIGKILL, disk full).
const STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_TAIL_BYTES = 8192;

class UpdatePreflightError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpdatePreflightError';
    this.code = code;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The command runs under /bin/sh but invokes the manager through bash, for the
// same reason the restart path does: source/archive installs do not reliably
// preserve the executable bit, and a direct exec would exit 126 after the API
// has already reported the run as started.
function buildUpdateShellCommand(options = {}) {
  const { rootDir, force = false, logPath, bashPath = BASH_PATH, managerName = MANAGER_NAME } = options;
  if (!rootDir) throw new TypeError('update command requires rootDir');
  const resolvedLog = logPath || path.join(rootDir, UPDATE_LOG_RELATIVE);
  const quotedLog = shellQuote(resolvedLog);
  const quotedLogDir = shellQuote(path.dirname(resolvedLog));
  const args = force ? 'update --force' : 'update';
  // `>` truncates: one log per run, so the parser below cannot read a stale
  // marker. The whole block is redirected once rather than per-echo so the
  // marker cannot land in a different file than the output it terminates.
  return [
    `mkdir -p ${quotedLogDir}`,
    `{ echo "${START_MARKER} $(date -u +%Y-%m-%dT%H:%M:%SZ) force=${force ? 1 : 0}";`,
    `  sleep 1;`,
    `  ${bashPath} ./${managerName} ${args};`,
    `  echo "${EXIT_MARKER} $?"; } > ${quotedLog} 2>&1`,
  ].join('\n');
}

function preflightUpdate(options = {}) {
  const {
    rootDir,
    fsImpl = fs,
    pathImpl = path,
    bashPath = BASH_PATH,
    managerName = MANAGER_NAME,
  } = options;
  if (!rootDir) throw new TypeError('update preflight requires rootDir');

  const managerPath = pathImpl.join(rootDir, managerName);
  let managerStat;
  try {
    managerStat = fsImpl.statSync(managerPath);
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_MANAGER_MISSING', 'update manager is unavailable', error);
  }
  if (!managerStat.isFile()) {
    throw new UpdatePreflightError('UPDATE_MANAGER_INVALID', 'update manager is not a regular file');
  }
  try {
    fsImpl.accessSync(managerPath, fsImpl.constants.R_OK);
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_MANAGER_UNREADABLE', 'update manager is not readable', error);
  }

  // A git checkout is what `update` operates on. Without one the manager exits
  // with a message the user would only see in a log they have no reason to
  // open, so fail here where the failure reaches the HTTP response.
  try {
    fsImpl.statSync(pathImpl.join(rootDir, '.git'));
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_NOT_A_GIT_CHECKOUT', 'this install is not a git checkout', error);
  }

  let bashStat;
  try {
    bashStat = fsImpl.statSync(bashPath);
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_BASH_MISSING', 'bash is unavailable', error);
  }
  if (!bashStat.isFile()) {
    throw new UpdatePreflightError('UPDATE_BASH_INVALID', 'bash is not a regular file');
  }
  try {
    fsImpl.accessSync(bashPath, fsImpl.constants.X_OK);
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_BASH_UNUSABLE', 'bash is not executable', error);
  }

  // The entire run is redirected into logs/update.log with a single `>`. If that
  // redirect cannot be opened, the shell never executes the block at all: no
  // update happens, no log is written, and status reads `idle` forever — the
  // client would sit through its whole timeout before reporting a run that never
  // started. Fail here instead, where it becomes an error the user can act on.
  const logDir = pathImpl.dirname(pathImpl.join(rootDir, UPDATE_LOG_RELATIVE));
  try {
    fsImpl.mkdirSync(logDir, { recursive: true });
    fsImpl.accessSync(logDir, fsImpl.constants.W_OK);
  } catch (error) {
    throw new UpdatePreflightError('UPDATE_LOG_UNWRITABLE', 'the update log directory is not writable', error);
  }

  return Object.freeze({ managerPath, bashPath });
}

function parseUpdateLog(content) {
  const text = String(content == null ? '' : content);
  let startedAt = null;
  let force = false;
  const startMatch = text.match(new RegExp(`${START_MARKER} (\\S+) force=(\\d)`));
  if (startMatch) {
    startedAt = startMatch[1];
    force = startMatch[2] === '1';
  }
  // Last match wins: the manager itself can never emit this line, but a future
  // caller appending to the log would, and the newest terminator is the true one.
  let exitCode = null;
  const exitPattern = new RegExp(`${EXIT_MARKER} (\\d+)`, 'g');
  let exitMatch = exitPattern.exec(text);
  while (exitMatch) {
    exitCode = Number(exitMatch[1]);
    exitMatch = exitPattern.exec(text);
  }
  const tail = text.replace(new RegExp(`^${START_MARKER}.*\\n?`, 'm'), '')
    .replace(new RegExp(`${EXIT_MARKER} \\d+\\n?`, 'g'), '')
    .trim();
  return { startedAt, force, exitCode, tail };
}

// State is a pure function of (log file, clock). No in-memory run handle is
// consulted, because after the update restarts the server there is none.
function readUpdateStatus(options = {}) {
  const {
    rootDir,
    fsImpl = fs,
    pathImpl = path,
    now = Date.now,
    tailBytes = DEFAULT_TAIL_BYTES,
    staleAfterMs = STALE_AFTER_MS,
  } = options;
  if (!rootDir) throw new TypeError('update status requires rootDir');
  const logPath = pathImpl.join(rootDir, UPDATE_LOG_RELATIVE);

  let stat;
  try {
    stat = fsImpl.statSync(logPath);
  } catch (_) {
    return { state: 'idle', running: false, exitCode: null, startedAt: null, updatedAt: null, force: false, tail: '', logPath };
  }

  let content = '';
  try {
    const buffer = fsImpl.readFileSync(logPath);
    const text = buffer.toString('utf8');
    content = text.length > tailBytes * 4 ? text.slice(-tailBytes * 4) : text;
  } catch (_) {
    content = '';
  }

  const parsed = parseUpdateLog(content);
  const updatedAt = new Date(stat.mtimeMs || stat.mtime || 0).toISOString();
  const tail = parsed.tail.length > tailBytes ? parsed.tail.slice(-tailBytes) : parsed.tail;

  if (parsed.exitCode != null) {
    return {
      state: parsed.exitCode === 0 ? 'succeeded' : 'failed',
      running: false,
      exitCode: parsed.exitCode,
      startedAt: parsed.startedAt,
      updatedAt,
      force: parsed.force,
      tail,
      logPath,
    };
  }

  // No marker: either still running, or died without writing one. Silence is
  // measured from the last write, not from the start — npm install is quiet for
  // minutes at a time and must not be declared dead for it.
  const silentMs = Math.max(0, now() - (stat.mtimeMs || 0));
  const stale = silentMs > staleAfterMs;
  return {
    state: stale ? 'stale' : 'running',
    running: !stale,
    exitCode: null,
    startedAt: parsed.startedAt,
    updatedAt,
    force: parsed.force,
    silentMs,
    tail,
    logPath,
  };
}

function startDetachedUpdate(options = {}) {
  const {
    spawn,
    rootDir,
    force = false,
    env = process.env,
    log = console,
    onFailure = () => {},
    fsImpl,
    pathImpl,
  } = options;
  if (typeof spawn !== 'function') throw new TypeError('update runner requires spawn');
  if (!rootDir) throw new TypeError('update runner requires rootDir');
  if (typeof onFailure !== 'function') throw new TypeError('update runner requires onFailure function');

  // Synchronous, before the route acknowledges: a run that cannot even read the
  // manager must not be reported as started.
  preflightUpdate({ rootDir, fsImpl, pathImpl });

  const command = buildUpdateShellCommand({ rootDir, force });
  const child = spawn('/bin/sh', ['-c', command], {
    cwd: rootDir,
    // Detached is load-bearing, not hygiene: `./multicc update` restarts the
    // server, and do_stop kills the server's process group. Sharing that group
    // would have the update kill itself halfway through.
    detached: true,
    stdio: 'ignore',
    env,
  });
  if (!child || typeof child.once !== 'function' || typeof child.unref !== 'function') {
    throw new TypeError('update runner received an invalid child process');
  }

  let failureReported = false;
  const reportFailure = (code, error) => {
    if (failureReported) return;
    failureReported = true;
    const failure = error instanceof Error ? error : new Error(code);
    failure.code = failure.code || code;
    log.error('[multicc] /api/update: detached update failed', failure.message);
    try { onFailure(failure); } catch (callbackError) {
      log.error('[multicc] /api/update: failure callback failed', callbackError && callbackError.message);
    }
  };

  child.once('error', error => reportFailure('UPDATE_CHILD_ERROR', error));
  child.unref();
  log.log(`[multicc] /api/update: detached update scheduled (force=${force ? 1 : 0})`);
  return child;
}

module.exports = {
  BASH_PATH,
  MANAGER_NAME,
  UPDATE_LOG_RELATIVE,
  EXIT_MARKER,
  START_MARKER,
  STALE_AFTER_MS,
  UpdatePreflightError,
  shellQuote,
  buildUpdateShellCommand,
  preflightUpdate,
  parseUpdateLog,
  readUpdateStatus,
  startDetachedUpdate,
};

'use strict';

// Detached shell jobs are externally durable: a POSIX session leader writes
// output and completion markers under a private job directory.  The
// orchestration runtime owns the logical operation; this module owns only the
// OS process and its evidence files.

const childProcess = require('child_process');
const nodeFs = require('fs');
const nodePath = require('path');
const os = require('os');
const crypto = require('crypto');

const LEGACY_BASE_DIR = nodePath.join(os.homedir(), '.multicc', 'detached');
const DONE_MARKER = '__MULTICC_DETACHED_DONE__';

function shq(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function defaultId() {
  return `d_${crypto.randomBytes(10).toString('hex')}`;
}

function validId(value) {
  const id = String(value || '');
  if (!/^d_[A-Za-z0-9_-]{4,80}$/.test(id)) throw new Error('invalid detached task id');
  return id;
}

function createDetached({
  baseDir = LEGACY_BASE_DIR,
  fsImpl = nodeFs,
  pathImpl = nodePath,
  spawnImpl = childProcess.spawn,
  now = Date.now,
  isProcessAlive = pid => {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
    try { process.kill(Number(pid), 0); return true; }
    catch (_) { return false; }
  },
} = {}) {
  const root = pathImpl.resolve(baseDir);

  function ensurePrivateDir(dir) {
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fsImpl.chmodSync(dir, 0o700);
  }

  function jobPaths(rawId) {
    const id = validId(rawId);
    const dir = pathImpl.join(root, id);
    return {
      id,
      dir,
      logPath: pathImpl.join(dir, 'output.log'),
      donePath: pathImpl.join(dir, 'done'),
      metaPath: pathImpl.join(dir, 'meta.json'),
      startedPath: pathImpl.join(dir, 'started'),
      pidPath: pathImpl.join(dir, 'pid'),
    };
  }

  function buildPollCmd(logPath, donePath) {
    return `if [ -f ${shq(donePath)} ]; then cat ${shq(donePath)}; echo '----- output tail -----'; tail -c 3000 ${shq(logPath)} 2>/dev/null; fi`;
  }

  function readMeta(metaPath) {
    try { return JSON.parse(fsImpl.readFileSync(metaPath, 'utf8')); }
    catch (_) { return null; }
  }

  function readPid(pidPath) {
    try {
      const pid = Number(fsImpl.readFileSync(pidPath, 'utf8').trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch (_) { return null; }
  }

  function status(rawId) {
    const paths = jobPaths(rawId);
    const meta = readMeta(paths.metaPath);
    if (!meta) return null;
    const started = fsImpl.existsSync(paths.startedPath);
    const pid = readPid(paths.pidPath) || (Number.isSafeInteger(meta.pid) ? meta.pid : null);
    let done = false;
    let exitCode = null;
    try {
      const content = fsImpl.readFileSync(paths.donePath, 'utf8');
      done = content.includes(DONE_MARKER);
      const match = content.match(/exit=(-?\d+)/);
      if (match) exitCode = Number(match[1]);
    } catch (_) {}
    let logTail = '';
    try { logTail = fsImpl.readFileSync(paths.logPath, 'utf8').slice(-3000); }
    catch (_) {}
    const running = !!(!done && started && pid && isProcessAlive(pid));
    return {
      id: paths.id,
      label: meta.label || null,
      command: meta.command,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      started,
      pid,
      running,
      done,
      exitCode,
      logPath: paths.logPath,
      logTail,
    };
  }

  function writeMeta(paths, requested) {
    ensurePrivateDir(root);
    ensurePrivateDir(paths.dir);
    const existing = readMeta(paths.metaPath);
    if (existing) {
      if (existing.command !== requested.command || existing.cwd !== requested.cwd) {
        const error = new Error(`detached task ${paths.id} already exists with different content`);
        error.code = 'DETACHED_ID_CONFLICT';
        error.statusCode = 409;
        throw error;
      }
      fsImpl.chmodSync(paths.metaPath, 0o600);
      return existing;
    }
    const fd = fsImpl.openSync(paths.metaPath, 'wx', 0o600);
    try { fsImpl.writeFileSync(fd, `${JSON.stringify(requested, null, 2)}\n`, 'utf8'); }
    finally { fsImpl.closeSync(fd); }
    fsImpl.chmodSync(paths.metaPath, 0o600);
    return requested;
  }

  function launch({ id = defaultId(), command, cwd, label } = {}) {
    id = validId(id);
    const cmd = String(command == null ? '' : command).trim();
    if (!cmd) throw new Error('command required');
    const workdir = cwd || os.homedir();
    const paths = jobPaths(id);
    const meta = writeMeta(paths, {
      id,
      label: label || null,
      command: cmd,
      cwd: workdir,
      startedAt: Number(now()),
    });
    const existing = status(id);
    if (existing && (existing.started || existing.done)) {
      return { ...paths, ...existing, pollCmd: buildPollCmd(paths.logPath, paths.donePath), doneMarker: DONE_MARKER, reused: true };
    }

    // The wrapper, not the parent, claims `started`.  A replacement server may
    // safely launch the same fixed id after a crash before spawn; if an earlier
    // wrapper did start, O_EXCL-style noclobber permits only one command body.
    const wrapper = [
      'umask 077',
      `if ( set -C; : > ${shq(paths.startedPath)} ) 2>/dev/null; then`,
      `  printf '%s\\n' "$$" > ${shq(paths.pidPath)}`,
      `  (\n${cmd}\n)`,
      '  __mc_code=$?',
      `  __mc_tmp=${shq(paths.donePath)}.tmp.$$`,
      `  printf '%s exit=%s\\n' ${shq(DONE_MARKER)} "$__mc_code" > "$__mc_tmp"`,
      `  mv -f "$__mc_tmp" ${shq(paths.donePath)}`,
      'fi',
      '',
    ].join('\n');

    const fd = fsImpl.openSync(paths.logPath, 'a', 0o600);
    let child;
    try {
      child = spawnImpl('/bin/sh', ['-c', wrapper], {
        cwd: workdir,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      });
    } finally {
      try { fsImpl.closeSync(fd); } catch (_) {}
    }
    if (child && typeof child.unref === 'function') child.unref();
    return {
      ...paths,
      label: meta.label,
      command: meta.command,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      pid: child && child.pid,
      started: true,
      running: true,
      done: false,
      pollCmd: buildPollCmd(paths.logPath, paths.donePath),
      doneMarker: DONE_MARKER,
      reused: false,
    };
  }

  function cancel(rawId) {
    const current = status(rawId);
    if (!current) return { ok: false, code: 'not_found' };
    if (!current.running || !current.pid) return { ok: true, idempotent: true };
    try { process.kill(-current.pid, 'SIGTERM'); }
    catch (_) {
      try { process.kill(current.pid, 'SIGTERM'); } catch (_) {}
    }
    return { ok: true, idempotent: false, pid: current.pid };
  }

  function list(limit = 50) {
    let ids = [];
    try { ids = fsImpl.readdirSync(root).filter(name => name.startsWith('d_')); }
    catch (_) { return []; }
    return ids.map(id => {
      try { return status(id); } catch (_) { return null; }
    }).filter(Boolean)
      .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0))
      .slice(0, limit)
      .map(({ logTail, ...entry }) => entry);
  }

  return Object.freeze({
    BASE_DIR: root,
    DONE_MARKER,
    launch,
    status,
    list,
    cancel,
    buildPollCmd,
    jobPaths,
  });
}

const legacy = createDetached({ baseDir: LEGACY_BASE_DIR });

module.exports = {
  ...legacy,
  BASE_DIR: LEGACY_BASE_DIR,
  DONE_MARKER,
  createDetached,
};

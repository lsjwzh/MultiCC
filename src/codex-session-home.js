'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensurePrivateDir, secureFile } = require('./runtime-security');

const MAX_SCAN_ENTRIES = 100_000;

function requiredIdentity(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    const error = new Error(`${label} is required`);
    error.code = 'CODEX_SESSION_IDENTITY_INVALID';
    throw error;
  }
  return text;
}

function safePrefix(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
}

function assertPrivateDirectory(directory, code = 'CODEX_SESSION_HOME_INVALID') {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const error = new Error('Codex session home must be a real directory');
      error.code = code;
      throw error;
    }
  }
  ensurePrivateDir(directory);
  return directory;
}

function createCodexSessionHomeRuntime(options = {}) {
  const sessionHomesDir = path.resolve(options.sessionHomesDir
    || path.join(os.homedir(), '.multicc', 'codex-session-homes'));
  const codexHomesDir = path.resolve(options.codexHomesDir
    || path.join(os.homedir(), '.multicc', 'codex-homes'));
  const globalCodexHome = path.resolve(options.globalCodexHome
    || path.join(os.homedir(), '.codex'));

  function codexSessionHome(logicalSessionId) {
    const identity = requiredIdentity(logicalSessionId, 'logical Codex session id');
    return path.join(sessionHomesDir, `${safePrefix(identity)}-${fingerprint(identity)}`);
  }

  function matchingRollouts(sessionsDir, nativeSessionId, state) {
    if (!fs.existsSync(sessionsDir)) return [];
    const rootStat = fs.lstatSync(sessionsDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
    const suffix = `-${nativeSessionId}.jsonl`;
    const found = [];
    const stack = [sessionsDir];
    while (stack.length) {
      const directory = stack.pop();
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
      catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        state.inspected += 1;
        if (state.inspected > MAX_SCAN_ENTRIES) {
          const error = new Error('Codex legacy rollout scan limit exceeded');
          error.code = 'CODEX_SESSION_ROLLOUT_SCAN_LIMIT';
          throw error;
        }
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(target);
        else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(target);
      }
    }
    return found;
  }

  function legacySessionRoots() {
    const roots = [];
    const seen = new Set();
    const append = home => {
      const sessions = path.join(home, 'sessions');
      let real;
      try {
        const stat = fs.lstatSync(sessions);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        real = fs.realpathSync(sessions);
      } catch (_) { return; }
      if (seen.has(real)) return;
      seen.add(real);
      roots.push({ home, sessions, real });
    };
    append(globalCodexHome);
    let entries = [];
    try { entries = fs.readdirSync(codexHomesDir, { withFileTypes: true }); } catch (_) {}
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      append(path.join(codexHomesDir, entry.name));
    }
    return roots;
  }

  function ambiguousError(nativeSessionId, matches) {
    const error = new Error(`Codex native session ${nativeSessionId} has multiple rollout sources`);
    error.code = 'CODEX_SESSION_ROLLOUT_AMBIGUOUS';
    error.sources = matches.map(match => match.file);
    return error;
  }

  function copyRolloutAtomic(source, destination) {
    assertPrivateDirectory(path.dirname(destination));
    const temporary = `${destination}.migrate.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    let fd = null;
    let dirFd = null;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      secureFile(temporary);
      fd = fs.openSync(temporary, 'r');
      try { fs.fdatasyncSync(fd); } catch (error) {
        if (!error || (error.code !== 'ENOTSUP' && error.code !== 'EINVAL')) throw error;
      }
      fs.closeSync(fd);
      fd = null;
      // link(2), unlike rename(2), is an atomic create-if-absent operation.
      // It closes the exists+rename overwrite race while staying on the same
      // filesystem as the destination. The temporary link is removed below.
      try { fs.linkSync(temporary, destination); }
      catch (cause) {
        if (!cause || cause.code !== 'EEXIST') throw cause;
        const error = new Error('Codex canonical rollout appeared during migration');
        error.code = 'CODEX_SESSION_ROLLOUT_RACE';
        error.cause = cause;
        throw error;
      }
      secureFile(destination);
      try {
        dirFd = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY);
        fs.fsyncSync(dirFd);
      } catch (error) {
        if (!error || !['EISDIR', 'EBADF', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
      }
      return true;
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      if (dirFd !== null) try { fs.closeSync(dirFd); } catch (_) {}
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    }
  }

  function fileVersion(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error('Codex rollout must be a real file');
      error.code = 'CODEX_SESSION_ROLLOUT_PATH_INVALID';
      throw error;
    }
    return {
      dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    };
  }

  function sameVersion(left, right) {
    return !!(left && right && left.dev === right.dev && left.ino === right.ino
      && left.size === right.size && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs);
  }

  function syncRolloutAtomic(source, destination) {
    assertPrivateDirectory(path.dirname(destination));
    const sourceBefore = fileVersion(source);
    const destinationBefore = fs.existsSync(destination) ? fileVersion(destination) : null;
    const temporary = `${destination}.sync.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    let fd = null;
    let dirFd = null;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      secureFile(temporary);
      fd = fs.openSync(temporary, 'r');
      try { fs.fdatasyncSync(fd); } catch (error) {
        if (!error || (error.code !== 'ENOTSUP' && error.code !== 'EINVAL')) throw error;
      }
      fs.closeSync(fd);
      fd = null;
      if (!sameVersion(sourceBefore, fileVersion(source))) {
        const error = new Error('Codex route source changed during synchronization');
        error.code = 'CODEX_SESSION_ROUTE_SOURCE_CHANGED';
        throw error;
      }
      const destinationNow = fs.existsSync(destination) ? fileVersion(destination) : null;
      if ((destinationBefore || destinationNow)
          && !sameVersion(destinationBefore, destinationNow)) {
        const error = new Error('Codex route destination changed during synchronization');
        error.code = 'CODEX_SESSION_ROUTE_DESTINATION_CHANGED';
        throw error;
      }
      fs.renameSync(temporary, destination);
      secureFile(destination);
      try {
        dirFd = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY);
        fs.fsyncSync(dirFd);
      } catch (error) {
        if (!error || !['EISDIR', 'EBADF', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
      }
      return destination;
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
      if (dirFd !== null) try { fs.closeSync(dirFd); } catch (_) {}
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    }
  }

  function oneRollout(sessionsDir, nativeSessionId, state, label, { required = true } = {}) {
    const matches = matchingRollouts(sessionsDir, nativeSessionId, state);
    if (matches.length > 1) throw ambiguousError(nativeSessionId,
      matches.map(file => ({ file, sessions: sessionsDir })));
    if (matches.length === 1) return matches[0];
    if (!required) return null;
    const error = new Error(`Codex ${label} rollout ${nativeSessionId} was not found`);
    error.code = 'CODEX_SESSION_ROUTE_SOURCE_NOT_FOUND';
    throw error;
  }

  function prepareCodexSessionHome(input = {}) {
    const logicalSessionId = requiredIdentity(input.logicalSessionId, 'logical Codex session id');
    const nativeSessionId = String(input.nativeSessionId == null ? '' : input.nativeSessionId).trim();
    if (nativeSessionId) requiredIdentity(nativeSessionId, 'native Codex session id');
    assertPrivateDirectory(sessionHomesDir);
    const home = codexSessionHome(logicalSessionId);
    assertPrivateDirectory(home);
    const sessionsDir = path.join(home, 'sessions');
    assertPrivateDirectory(sessionsDir);
    if (!nativeSessionId) return Object.freeze({ home, sessionsDir, migratedFrom: null });

    const state = { inspected: 0 };
    const canonical = matchingRollouts(sessionsDir, nativeSessionId, state);
    if (canonical.length > 1) throw ambiguousError(nativeSessionId,
      canonical.map(file => ({ file, sessions: sessionsDir })));
    if (canonical.length === 1) {
      return Object.freeze({ home, sessionsDir, rollout: canonical[0], migratedFrom: null });
    }

    const legacy = [];
    for (const root of legacySessionRoots()) {
      for (const file of matchingRollouts(root.sessions, nativeSessionId, state)) {
        legacy.push({ file, sessions: root.sessions });
      }
    }
    if (legacy.length > 1) throw ambiguousError(nativeSessionId, legacy);
    if (!legacy.length) {
      if (input.allowMissingNativeSession === true) {
        return Object.freeze({ home, sessionsDir, rollout: null, migratedFrom: null });
      }
      const error = new Error(`Codex native session ${nativeSessionId} rollout was not found`);
      error.code = 'CODEX_SESSION_ROLLOUT_NOT_FOUND';
      throw error;
    }
    const source = legacy[0];
    const relative = path.relative(source.sessions, source.file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('Codex rollout migration path escaped its sessions root');
      error.code = 'CODEX_SESSION_ROLLOUT_PATH_INVALID';
      throw error;
    }
    const destination = path.join(sessionsDir, relative);
    copyRolloutAtomic(source.file, destination);
    return Object.freeze({
      home, sessionsDir, rollout: destination, migratedFrom: source.file,
    });
  }

  // Providerless Codex must keep using the real ~/.codex so OAuth refresh-token
  // rotation remains durable. When a stopped session crosses the manual
  // managed/default boundary, synchronize only its exact native rollout between
  // the current authority and the canonical managed root. Both source copies
  // remain recoverable; destination replacement is version-checked + atomic.
  function synchronizeCodexSessionRoute(input = {}) {
    const logicalSessionId = requiredIdentity(input.logicalSessionId, 'logical Codex session id');
    const nativeSessionId = requiredIdentity(input.nativeSessionId, 'native Codex session id');
    const fromManaged = !!String(input.fromProviderId || '').trim();
    const toManaged = !!String(input.toProviderId || '').trim();
    if (fromManaged === toManaged) {
      return fromManaged
        ? prepareCodexSessionHome({ logicalSessionId, nativeSessionId })
        : Object.freeze({ synchronized: false, direction: 'providerless' });
    }
    const canonical = prepareCodexSessionHome({
      logicalSessionId,
      ...(fromManaged ? { nativeSessionId } : {}),
    });
    const globalSessions = path.join(globalCodexHome, 'sessions');
    assertPrivateDirectory(globalSessions);
    const state = { inspected: 0 };
    const sourceRoot = fromManaged ? canonical.sessionsDir : globalSessions;
    const destinationRoot = fromManaged ? globalSessions : canonical.sessionsDir;
    const source = oneRollout(sourceRoot, nativeSessionId, state,
      fromManaged ? 'canonical' : 'providerless');
    const existingDestination = oneRollout(destinationRoot, nativeSessionId, state,
      fromManaged ? 'providerless destination' : 'canonical destination', { required: false });
    const relative = path.relative(sourceRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('Codex route synchronization path escaped its sessions root');
      error.code = 'CODEX_SESSION_ROLLOUT_PATH_INVALID';
      throw error;
    }
    const destination = existingDestination || path.join(destinationRoot, relative);
    syncRolloutAtomic(source, destination);
    return Object.freeze({
      synchronized: true,
      direction: fromManaged ? 'managed-to-providerless' : 'providerless-to-managed',
      source,
      destination,
    });
  }

  return Object.freeze({
    codexSessionHome, prepareCodexSessionHome, synchronizeCodexSessionRoute, sessionHomesDir,
  });
}

module.exports = { createCodexSessionHomeRuntime, MAX_SCAN_ENTRIES };

'use strict';

const path = require('path');
const {
  DOMAIN_KINDS,
  DomainError,
  InfrastructureError,
} = require('../http');

// The memo used to be written into the project itself, as
// `<project>/multicc.memo.md`. That put a multicc-owned scratch file inside
// user repositories: it showed up as an untracked entry in `git status`, which
// `src/git.js`'s merge guard reads as `base-dirty` and refuses to merge on — a
// note could silently block a session's merge. Memos now live under multicc's
// own memory store (`<memoRoot>/<directoryId>/memo.md`), next to that
// directory's folder memory, and never touch the project tree.
// src/memo/migrate.js moves pre-existing project memos onto this layout.
const MEMO_FILENAME = 'memo.md';
const LEGACY_PROJECT_MEMO_FILENAME = 'multicc.memo.md';
const MEMO_MAX_BYTES = 5 * 1024 * 1024;

function requireFunction(owner, name) {
  if (!owner || typeof owner[name] !== 'function') {
    throw new TypeError(`memo controller requires ${name}()`);
  }
}

function domain(kind, message, code) {
  throw new DomainError(kind, message, { code, publicMessage: message });
}

function infrastructure(message, cause) {
  throw new InfrastructureError(message, { cause });
}

function createMemoController({ directories, sessions, runtime, files, memoRoot, pathPort = path } = {}) {
  requireFunction(directories, 'get');
  requireFunction(sessions, 'get');
  requireFunction(runtime, 'getChatSession');
  requireFunction(runtime, 'runTurn');
  requireFunction(files, 'readText');
  requireFunction(files, 'stat');
  requireFunction(files, 'exists');
  requireFunction(files, 'ensureDir');
  requireFunction(files, 'writeAtomic');
  requireFunction(pathPort, 'join');
  if (typeof memoRoot !== 'string' || !memoRoot) {
    throw new TypeError('memo controller requires memoRoot');
  }

  function directory(directoryId) {
    const value = directories.get(directoryId);
    if (!value) domain(DOMAIN_KINDS.NOT_FOUND, 'directory not found', 'memo_directory_not_found');
    return value;
  }

  // Directory ids are multicc-generated uuids. Reject anything that could climb
  // out of the store rather than trusting the caller's registry.
  function memoDir(value) {
    const id = String(value && value.id || '');
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      infrastructure('memo directory id is not path safe');
    }
    try {
      return pathPort.join(memoRoot, id);
    } catch (error) {
      infrastructure('memo path resolution failed', error);
    }
  }

  function memoPath(value) {
    try {
      return pathPort.join(memoDir(value), MEMO_FILENAME);
    } catch (error) {
      infrastructure('memo path resolution failed', error);
    }
  }

  function read({ directoryId } = {}) {
    const value = directory(directoryId);
    const file = memoPath(value);
    try {
      const text = files.readText(file);
      return { path: file, text, mtime: files.stat(file).mtimeMs, exists: true };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { path: file, text: '', mtime: 0, exists: false };
      }
      infrastructure('memo read failed', error);
    }
  }

  function write({ directoryId, text } = {}) {
    const value = directory(directoryId);
    if (typeof text !== 'string') {
      domain(DOMAIN_KINDS.BAD_REQUEST, 'text must be a string', 'memo_text_invalid');
    }
    if (Buffer.byteLength(text, 'utf8') > MEMO_MAX_BYTES) {
      domain(DOMAIN_KINDS.PAYLOAD_TOO_LARGE, 'memo too large (>5MB)', 'memo_too_large');
    }
    // The memo no longer lives in the project, but a registration whose folder
    // has vanished is still a dead registration — refuse rather than accrue
    // memos for directories the user can no longer open.
    if (!files.exists(value.path)) {
      domain(DOMAIN_KINDS.BAD_REQUEST, 'directory path missing', 'memo_directory_path_missing');
    }
    const file = memoPath(value);
    try {
      files.ensureDir(memoDir(value));
      files.writeAtomic(file, text);
      return { path: file, mtime: files.stat(file).mtimeMs };
    } catch (error) {
      infrastructure('memo write failed', error);
    }
  }

  async function send({ directoryId, text: rawText, sessionId: rawSessionId } = {}) {
    const value = directory(directoryId);
    const text = String(rawText || '').trim();
    const sessionId = String(rawSessionId || '').trim();
    if (!text) domain(DOMAIN_KINDS.BAD_REQUEST, 'text required', 'memo_text_required');
    if (!sessionId) domain(DOMAIN_KINDS.BAD_REQUEST, 'sessionId required', 'memo_session_required');

    const target = sessions.get(sessionId);
    if (!target) domain(DOMAIN_KINDS.NOT_FOUND, 'session not found', 'memo_session_not_found');
    if (target.dirId !== value.id) {
      domain(DOMAIN_KINDS.BAD_REQUEST, 'session is not in this directory', 'memo_session_mismatch');
    }
    if (target.kind !== 'chat') {
      domain(DOMAIN_KINDS.BAD_REQUEST, '只能发送到 chat 类型的会话', 'memo_session_kind_invalid');
    }
    let started;
    try {
      started = await runtime.runTurn(sessionId, text, {});
    } catch (error) {
      infrastructure('memo turn start failed', error);
    }
    if (started === false) infrastructure('memo turn start failed');
    return { ok: true, sentTo: sessionId };
  }

  return Object.freeze({ read, write, send });
}

module.exports = {
  MEMO_FILENAME,
  LEGACY_PROJECT_MEMO_FILENAME,
  MEMO_MAX_BYTES,
  createMemoController,
};

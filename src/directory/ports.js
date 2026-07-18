'use strict';
// Directory-domain port contracts (interfaces). JavaScript has no `interface`
// keyword, so each port is declared as a method-name list and enforced at
// composition time: assertPort() throws if an implementation misses a method.
// The service layer programs against these contracts only — every fs / git /
// session / event effect crosses one of them, which is what lets unit tests
// substitute in-memory fakes for the real adapters composed in server.js.

function assertPort(portName, impl, methods) {
  if (!impl || typeof impl !== 'object') {
    throw new TypeError(`[directory] ${portName} implementation missing`);
  }
  for (const m of methods) {
    if (typeof impl[m] !== 'function') {
      throw new TypeError(`[directory] ${portName}.${m}() not implemented`);
    }
  }
  return impl;
}

// Registry of directory records, persisted to directories.json.
// `snapshot()` returns the raw payload array — used by cross-file transactions
// (see src/state-tx.js) so directories.json and sessions.json land in a
// single journal entry rather than as two independent atomic writes.
const REPOSITORY_PORT = ['get', 'list', 'add', 'remove', 'findByPath', 'save', 'map', 'snapshot'];

// Git effects on a directory's main working tree (push state, quick-commit,
// repo-readiness). Backed by plugins/utils/git-push + src/git-queue + the
// stateful ensureDirGitReady() in server.js.
const GIT_PORT = ['baseBranch', 'pushState', 'push', 'invalidatePushCache',
  'statusPorcelain', 'stageAll', 'commit', 'ensureReady', 'unmarkReady'];

// Session lifecycle owned by the session domain: enumerate a directory's
// sessions, seed the default Agent Commander chat, tear a session down
// (tmux/chat proc/worktree/triggers/notes/records) when its directory dies.
// `snapshotRecords()` returns the raw persisted-sessions payload — required
// alongside the directory snapshot for cross-file delete transactions.
const SESSION_PORT = ['listByDir', 'seedCommander', 'destroyCascade', 'persistRecords', 'snapshotRecords'];

// Append to the per-directory event feed.
const EVENT_PORT = ['append'];

// Filesystem access used by path validation and the fs/list browser.
const FS_PORT = ['homedir', 'exists', 'isDirectory', 'mkdirp', 'readDirents'];

// Pure(ish) path helpers shared with the wider codebase (src/directories.js).
const HELPER_PORT = ['resolveCwd', 'isHomeOrAbove', 'realPathOf', 'friendlyDirReason'];

module.exports = { assertPort, REPOSITORY_PORT, GIT_PORT, SESSION_PORT, EVENT_PORT, FS_PORT, HELPER_PORT };

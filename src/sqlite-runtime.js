'use strict';

const fs = require('fs');

const REBUILD_COMMAND = 'npm rebuild better-sqlite3 --foreground-scripts';

function nativeRuntimeMessage() {
  return 'SQLite native runtime is unavailable. Run `' + REBUILD_COMMAND +
    '` in the MultiCC directory, then retry.';
}

function makeError(message, code, reason, cause) {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  if (cause) error.cause = cause;
  return error;
}

// `require("better-sqlite3")` only loads its JavaScript constructor. The native
// addon is loaded lazily by the first `new Database(...)`, so a successful
// require is not a sufficient health check. This adapter always opens and closes
// an in-memory database before reporting the runtime as ready.
//
// Failed probes are deliberately not cached. If an administrator rebuilds the
// addon while MultiCC is running, the next status/import request can recover
// without restarting the server.
function createSqliteRuntime({
  loadDatabase = () => require('better-sqlite3'),
  existsSync = fs.existsSync,
} = {}) {
  function probe() {
    let Database;
    try {
      Database = loadDatabase();
    } catch (cause) {
      return { available: false, reason: 'native-runtime-unavailable', cause };
    }

    let db;
    try {
      db = new Database(':memory:');
      db.close();
      db = null;
      return { available: true, reason: null, Database };
    } catch (cause) {
      try { if (db) db.close(); } catch (_) {}
      return { available: false, reason: 'native-runtime-unavailable', cause };
    }
  }

  function getStatus(dbPath) {
    const normalizedPath = String(dbPath || '');
    const dbFound = !!normalizedPath && existsSync(normalizedPath);
    if (!dbFound) {
      return {
        available: false,
        dbFound: false,
        dbPath: normalizedPath,
        reason: 'database-not-found',
        message: 'CC-Switch database was not found at ' + normalizedPath + '.',
      };
    }

    const runtime = probe();
    if (!runtime.available) {
      return {
        available: false,
        dbFound: true,
        dbPath: normalizedPath,
        reason: runtime.reason,
        message: nativeRuntimeMessage(),
      };
    }

    return {
      available: true,
      dbFound: true,
      dbPath: normalizedPath,
      reason: null,
      message: '',
    };
  }

  function openReadonly(dbPath, options = {}) {
    const status = getStatus(dbPath);
    if (!status.available) {
      const code = status.reason === 'database-not-found'
        ? 'CC_SWITCH_DB_NOT_FOUND'
        : 'SQLITE_NATIVE_RUNTIME_UNAVAILABLE';
      throw makeError(status.message, code, status.reason);
    }

    // Probe again to obtain the constructor without keeping failed state. The
    // second probe is cheap and keeps getStatus() free of hidden mutable state.
    const runtime = probe();
    if (!runtime.available) {
      throw makeError(
        nativeRuntimeMessage(),
        'SQLITE_NATIVE_RUNTIME_UNAVAILABLE',
        'native-runtime-unavailable',
        runtime.cause,
      );
    }

    try {
      return new runtime.Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 4000,
        ...options,
      });
    } catch (cause) {
      throw makeError(
        'Could not open the CC-Switch database. Check that the file is readable, then retry.',
        'CC_SWITCH_DB_OPEN_FAILED',
        'database-open-failed',
        cause,
      );
    }
  }

  return { getStatus, openReadonly, probe };
}

module.exports = {
  REBUILD_COMMAND,
  createSqliteRuntime,
  nativeRuntimeMessage,
};

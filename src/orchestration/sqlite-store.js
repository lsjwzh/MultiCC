'use strict';

// RustOrchestrationStore is the only SQLite implementation. The JS adapter
// retains callbacks and Proxy identity required by existing domain callers.
const {
  OrchestrationStoreCorruptError, _cloneJson: cloneJson, _deepFreeze: deepFreeze,
} = require('./store');
const { createDraft, COLLECTIONS } = require('./draft-host');

const DATABASE_SCHEMA_VERSION = 2;

class OrchestrationSqliteError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OrchestrationSqliteError';
    this.code = 'ORCHESTRATION_SQLITE_ERROR';
    Object.assign(this, meta);
  }
}

class OrchestrationSqliteConflictError extends OrchestrationSqliteError {
  constructor(file, expectedRevision, actualRevision) {
    super(
      `orchestration SQLite revision changed concurrently in ${file} (expected ${expectedRevision}, found ${actualRevision})`,
      { file, expectedRevision, actualRevision },
    );
    this.name = 'OrchestrationSqliteConflictError';
    this.code = 'ORCHESTRATION_SQLITE_CONFLICT';
    this.retryable = true;
  }
}

function createOrchestrationSqliteStore(options = {}) {
  for (const name of ['Database', 'fsImpl', 'pathImpl']) {
    if (options[name] != null) {
      throw new TypeError(
        `[orchestration-sqlite-store] ${name} injection is unsupported by the Rust store`,
      );
    }
  }
  return require('./native-store-host').createNativeStore(options, {
    createDraft, cloneJson, deepFreeze, OrchestrationStoreCorruptError,
    OrchestrationSqliteError, OrchestrationSqliteConflictError, COLLECTIONS,
  });
}

module.exports = {
  DATABASE_SCHEMA_VERSION, OrchestrationSqliteConflictError, OrchestrationSqliteError,
  createOrchestrationSqliteStore,
};

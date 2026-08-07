#!/usr/bin/env node
'use strict';

// Explicit rollback/export utility. It takes one consistent read transaction
// from the live SQLite authority and atomically refreshes the legacy JSON file.
// The runtime also performs this export once during graceful shutdown; this
// command covers crash recovery before intentionally starting an older build.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const paths = require('../src/paths');
const { _writeAtomic } = require('../src/orchestration-store');
const { _loadDatabaseState, _stateDigest } = require('../src/orchestration-sqlite-store');

function exportSnapshot({
  databaseFile,
  targetFile,
  DatabaseImpl = Database,
  fsImpl = fs,
  now = Date.now,
} = {}) {
  if (!databaseFile || !targetFile) throw new TypeError('databaseFile and targetFile are required');
  if (!fsImpl.existsSync(databaseFile)) throw new Error(`orchestration database not found: ${databaseFile}`);
  const db = new DatabaseImpl(databaseFile, { readonly: true, fileMustExist: true });
  let state;
  try {
    db.exec('BEGIN');
    state = _loadDatabaseState(db, databaseFile);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* best effort */ }
    throw error;
  } finally {
    db.close();
  }
  _writeAtomic({
    fsImpl,
    pathImpl: path,
    file: targetFile,
    state,
    now,
    hooks: {},
  });
  return { databaseFile, targetFile, revision: state.revision, digest: _stateDigest(state) };
}

function main(argv = process.argv.slice(2)) {
  const databaseFile = path.resolve(argv[0] || paths.createPaths().orchestrationDbFile);
  const targetFile = path.resolve(argv[1] || paths.createPaths().orchestrationFile);
  const result = exportSnapshot({ databaseFile, targetFile });
  console.log(`Exported orchestration revision ${result.revision} to ${result.targetFile}`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Orchestration export failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { exportSnapshot, main };

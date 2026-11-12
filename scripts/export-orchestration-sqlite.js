#!/usr/bin/env node
'use strict';

// Explicit rollback/export utility. It takes one consistent read transaction
// from the live SQLite authority and atomically refreshes the legacy JSON file.
// The runtime also performs this export once during graceful shutdown; this
// command covers crash recovery before intentionally starting an older build.

const path = require('path');
const paths = require('../src/paths');

// Rust streams one consistent read transaction directly into the atomic file.
// No snapshot or database driver crosses the JavaScript boundary.
function exportSnapshot({ databaseFile, targetFile, ...options } = {}) {
  if (!databaseFile || !targetFile) throw new TypeError('databaseFile and targetFile are required');
  if (Object.keys(options).length) {
    throw new TypeError('orchestration export does not support injected JavaScript ports');
  }
  const { getNative } = require('../src/native/runtime');
  return getNative().orchestrationStoreExport(databaseFile, targetFile);
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

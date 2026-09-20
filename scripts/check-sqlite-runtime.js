#!/usr/bin/env node
'use strict';

// MultiCC stores its durable state (task runs, task shells, orchestration,
// provider quota cache) in SQLite, and SQLite now comes from Node itself:
// `node:sqlite` has been in core since Node 22.5 and flag-free since 22.13.
//
// That replaced a compiled `better-sqlite3` addon, which was the only reason a
// MultiCC install ever needed a compiler, a matching prebuild or a matching
// ABI. There is nothing left to rebuild — so this probe answers exactly one
// question, and `install.sh` / `./multicc` turn a failure into "your Node is
// too old" instead of a stack trace at the first write.

const path = require('path');
const { databaseConstructor } = require('../src/sqlite/driver');

const EXIT_OK = 0;
const EXIT_SQLITE_UNAVAILABLE = 10;
const REQUIREMENT = 'Node 22.16 or newer';

function runtimeDetails(runtime = process) {
  return {
    node: runtime.version,
    abi: runtime.versions && runtime.versions.modules,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  return String(error.message || error).split('\n')[0];
}

// Loading the module is not a health check: the built-in SQLite can fail on the
// first statement (or be missing entirely on an older Node). Open and close a
// real in-memory database, exactly like the CC-Switch import does.
function checkSqliteRuntime({
  loadDatabase = () => databaseConstructor(),
  runtime = process,
} = {}) {
  const failures = [];
  try {
    const Database = loadDatabase();
    let database;
    try {
      database = new Database(':memory:');
    } finally {
      if (database && typeof database.close === 'function') database.close();
    }
  } catch (error) {
    failures.push({ dependency: 'node:sqlite', message: errorMessage(error) });
  }

  return {
    ok: failures.length === 0,
    failures,
    requirement: REQUIREMENT,
    exitCode: failures.length === 0
      ? EXIT_OK
      : EXIT_SQLITE_UNAVAILABLE,
    runtime: runtimeDetails(runtime),
  };
}

function formatReport(result) {
  const r = result.runtime;
  if (result.ok) {
    return `SQLite runtime OK (Node ${r.node}, ${r.platform}/${r.arch}) — storage needs no compiled dependency`;
  }
  return [
    'SQLite runtime check failed.',
    `Runtime: Node ${r.node}, ABI ${r.abi}, ${r.platform}/${r.arch}`,
    ...result.failures.map(failure => `- ${failure.dependency}: ${failure.message}`),
    `Repair: run MultiCC on ${result.requirement} (the same floor package.json declares).`,
  ].join('\n');
}

function main(options) {
  const result = checkSqliteRuntime(options);
  const output = formatReport(result);
  (result.ok ? console.log : console.error)(output);
  return result.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EXIT_OK,
  EXIT_SQLITE_UNAVAILABLE,
  REQUIREMENT,
  checkSqliteRuntime,
  formatReport,
  main,
  runtimeDetails,
};

#!/usr/bin/env node
'use strict';

const path = require('path');

const EXIT_OK = 0;
const EXIT_BETTER_SQLITE_ONLY = 10;
const EXIT_OTHER_FAILURE = 1;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

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

function checkNativeDeps({
  requireFn = require,
  runtime = process,
  cwd = path.join(__dirname, '..'),
} = {}) {
  const failures = [];

  try {
    const Database = requireFn('better-sqlite3');
    let database;
    try {
      database = new Database(':memory:');
    } finally {
      if (database && typeof database.close === 'function') database.close();
    }
  } catch (error) {
    failures.push({ dependency: 'better-sqlite3', message: errorMessage(error) });
  }

  const onlyBetterSqlite = failures.length === 1
    && failures[0].dependency === 'better-sqlite3';

  return {
    ok: failures.length === 0,
    failures,
    onlyBetterSqlite,
    exitCode: failures.length === 0
      ? EXIT_OK
      : (onlyBetterSqlite ? EXIT_BETTER_SQLITE_ONLY : EXIT_OTHER_FAILURE),
    runtime: runtimeDetails(runtime),
    rebuildCommands: {
      'better-sqlite3': `cd ${shellQuote(cwd)} && npm rebuild better-sqlite3 --foreground-scripts`,
    },
  };
}

function formatReport(result) {
  const r = result.runtime;
  if (result.ok) {
    return `Native dependencies OK (Node ${r.node}, ABI ${r.abi}, ${r.platform}/${r.arch})`;
  }

  const lines = [
    'Native dependency check failed.',
    `Runtime: Node ${r.node}, ABI ${r.abi}, ${r.platform}/${r.arch}`,
  ];
  for (const failure of result.failures) {
    lines.push(`- ${failure.dependency}: ${failure.message}`);
    lines.push(`  Repair: ${result.rebuildCommands[failure.dependency]}`);
  }
  return lines.join('\n');
}

function main(options) {
  const result = checkNativeDeps(options);
  const output = formatReport(result);
  (result.ok ? console.log : console.error)(output);
  return result.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EXIT_BETTER_SQLITE_ONLY,
  EXIT_OK,
  EXIT_OTHER_FAILURE,
  checkNativeDeps,
  formatReport,
  main,
  runtimeDetails,
  shellQuote,
};

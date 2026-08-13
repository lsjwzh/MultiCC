#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  EXIT_BETTER_SQLITE_ONLY,
  EXIT_OK,
  checkNativeDeps,
  runtimeDetails,
} = require('./check-native-deps');

const EXIT_RUNTIME_FAILURE = 1;
const REQUIRED_CPR_API_MAJOR = 1;

function errorMessage(error) {
  if (!error) return 'unknown error';
  return String(error.message || error).split('\n')[0];
}

function parseMajor(value) {
  const match = String(value || '').match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function checkProviderRouter({ requireFn = require } = {}) {
  try {
    const router = requireFn('cli-provider-router');
    const manifest = requireFn('cli-provider-router/package.json');
    const apiMajor = parseMajor(router && router.API_VERSION);
    if (apiMajor !== REQUIRED_CPR_API_MAJOR) {
      return {
        ok: false,
        failure: {
          dependency: 'cli-provider-router',
          message: `expected CPR API major ${REQUIRED_CPR_API_MAJOR}, received ${router && router.API_VERSION ? router.API_VERSION : 'missing'}`,
        },
      };
    }
    return {
      ok: true,
      version: String(manifest && manifest.version || ''),
      apiVersion: String(router.API_VERSION),
    };
  } catch (error) {
    return {
      ok: false,
      failure: { dependency: 'cli-provider-router', message: errorMessage(error) },
    };
  }
}

function checkLanDiscovery({ requireFn = require } = {}) {
  try {
    const ciao = requireFn('@homebridge/ciao');
    const manifest = requireFn('@homebridge/ciao/package.json');
    if (!ciao || typeof ciao.getResponder !== 'function') {
      throw new Error('expected getResponder function');
    }
    return { ok: true, version: String(manifest && manifest.version || '') };
  } catch (error) {
    return {
      ok: false,
      failure: { dependency: '@homebridge/ciao', message: errorMessage(error) },
    };
  }
}

function checkRuntimeDeps({
  requireFn = require,
  runtime = process,
  cwd = path.join(__dirname, '..'),
} = {}) {
  const native = checkNativeDeps({ requireFn, runtime, cwd });
  const providerRouter = checkProviderRouter({ requireFn });
  const lanDiscovery = checkLanDiscovery({ requireFn });
  const failures = native.failures.slice();
  if (!providerRouter.ok) failures.push(providerRouter.failure);
  if (!lanDiscovery.ok) failures.push(lanDiscovery.failure);
  const onlyBetterSqlite = failures.length === 1
    && failures[0].dependency === 'better-sqlite3';
  return {
    ok: failures.length === 0,
    failures,
    onlyBetterSqlite,
    exitCode: failures.length === 0
      ? EXIT_OK
      : (onlyBetterSqlite ? EXIT_BETTER_SQLITE_ONLY : EXIT_RUNTIME_FAILURE),
    runtime: runtimeDetails(runtime),
    providerRouter: providerRouter.ok ? providerRouter : null,
    lanDiscovery: lanDiscovery.ok ? lanDiscovery : null,
  };
}

function formatReport(result) {
  const runtime = result.runtime;
  if (result.ok) {
    return `Runtime dependencies OK (Node ${runtime.node}, CPR ${result.providerRouter.version} / API ${result.providerRouter.apiVersion}, mDNS ciao ${result.lanDiscovery.version}, ${runtime.platform}/${runtime.arch})`;
  }
  const lines = [
    'Runtime dependency check failed.',
    `Runtime: Node ${runtime.node}, ABI ${runtime.abi}, ${runtime.platform}/${runtime.arch}`,
  ];
  for (const failure of result.failures) {
    lines.push(`- ${failure.dependency}: ${failure.message}`);
  }
  lines.push(`Repair: cd '${String(path.join(__dirname, '..')).replace(/'/g, `'"'"'`)}' && npm install`);
  return lines.join('\n');
}

function main(options) {
  const result = checkRuntimeDeps(options);
  (result.ok ? console.log : console.error)(formatReport(result));
  return result.exitCode;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  EXIT_RUNTIME_FAILURE,
  REQUIRED_CPR_API_MAJOR,
  checkLanDiscovery,
  checkProviderRouter,
  checkRuntimeDeps,
  formatReport,
  main,
  parseMajor,
};

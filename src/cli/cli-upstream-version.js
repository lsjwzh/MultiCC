'use strict';

// Rust owns registry/semver policy, npmrc IO and the request state machine.
// The host supplies the CLI catalog, home-directory and Node's public CA roots.
const os = require('node:os');
const path = require('node:path');
const { getNative } = require('../native/runtime');
const { npmPackages } = require('./cli-capability');
const NPM_PACKAGES = Object.freeze(npmPackages());
const request = (op, input) => getNative().cliUpstreamVersionRequest(op, input);
const { DEFAULT_REGISTRY, FALLBACK_REGISTRIES, FETCH_TIMEOUT_MS } = request('constants', {});
Object.freeze(FALLBACK_REGISTRIES);

function registryInput(env, options = {}, forceRead = false) {
  const input = {
    // Never marshal process.env: only public registry discovery inputs belong here.
    env: env && {
      npm_config_registry: env.npm_config_registry, NPM_CONFIG_REGISTRY: env.NPM_CONFIG_REGISTRY,
      NPM_CONFIG_USERCONFIG: env.NPM_CONFIG_USERCONFIG, npm_config_userconfig: env.npm_config_userconfig,
      MULTICC_CLI_REGISTRY_FALLBACKS: env.MULTICC_CLI_REGISTRY_FALLBACKS,
    },
    options: { npmrcPath: options.npmrcPath },
    forceRead,
  };
  if (request('registryNeedsHome', input)) input.defaultNpmrcPath = path.join(options.homeDir || os.homedir(), '.npmrc');
  return input;
}
const parseSemver = value => request('parseSemver', { value });
const compareSemver = (left, right) => request('compareSemver', { left, right });
const normalizeRegistry = value => request('normalizeRegistry', { value });
const readNpmrcRegistry = (env = process.env, options = {}) => request('readNpmrcRegistry', registryInput(env, options, true));
const resolveRegistryBase = (env = process.env, options = {}) => request('resolveRegistryBase', registryInput(env, options));
const resolveRegistryCandidates = (env = process.env, options = {}) => request('resolveRegistryCandidates', registryInput(env, options));
const latestUrl = (pkg, registryBase) => request('latestUrl', { pkg, registryBase });
const classifyUpdate = (installed, latest) => request('classifyUpdate', { installed, latest });
const npmPackageFor = cli => request('npmPackageFor', { cli, packages: NPM_PACKAGES });

// Keep the historical injected transport contract. It executes requests only:
// status/redirect/body limits/fallbacks/version acceptance all live in Rust.
async function fetchInjected(input, transport) {
  const state = new (getNative().RustCliUpstreamFetch)(input);
  for (;;) {
    const plan = state.request('plan', null);
    if (plan.done) return plan.result;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const fail = () => { if (!settled) { state.request('fail', null); finish(); } };
      let req;
      try { req = transport.get(plan.url, plan.options); } catch (_) { fail(); return; }
      req.on('timeout', () => { if (!settled) { fail(); try { req.destroy(); } catch (_) {} } });
      req.on('error', fail);
      req.on('response', response => {
        try {
        if (settled) { try { response.resume(); } catch (_) {} return; }
        const read = state.request('response', { status: response.statusCode, location: response.headers && response.headers.location });
        if (!read) { try { response.resume(); } catch (_) {} finish(); return; }
        response.setEncoding('utf8');
        response.on('data', chunk => {
          if (!settled && !state.request('chunk', chunk)) { finish(); try { response.destroy(); } catch (_) {} }
        });
        response.on('end', () => { if (!settled) { state.request('end', null); finish(); } });
        response.on('error', fail);
        } catch (_) { fail(); }
      });
    }).catch(() => { state.request('fail', null); });
  }
}
let transportConfigured = false;
async function fetchLatestVersionWithSource(pkg, options = {}) {
  const { registryBase, env = process.env, timeoutMs, httpsImpl } = options;
  // npmrcPath/homeDir were historically ignored by fetch; preserve that contract.
  const input = { pkg, registryBase, timeoutMs };
  if (request('fetchNeedsRegistry', input)) Object.assign(input, registryInput(env));
  if (httpsImpl !== undefined) return fetchInjected(input, httpsImpl);
  if (!transportConfigured) {
    const tls = require('node:tls');
    const roots = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : tls.rootCertificates;
    transportConfigured = request('configureTransport', { roots });
  }
  return getNative().cliUpstreamVersionFetch(input);
}
async function fetchLatestVersion(pkg, options = {}) {
  return (await fetchLatestVersionWithSource(pkg, options)).version;
}
module.exports = {
  NPM_PACKAGES, DEFAULT_REGISTRY, FETCH_TIMEOUT_MS, parseSemver, compareSemver,
  FALLBACK_REGISTRIES, normalizeRegistry, resolveRegistryBase, resolveRegistryCandidates,
  readNpmrcRegistry, latestUrl, fetchLatestVersion, fetchLatestVersionWithSource,
  classifyUpdate, npmPackageFor,
};

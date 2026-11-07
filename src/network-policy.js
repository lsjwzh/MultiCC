'use strict';

// Bind address / port policy. The only implementation lives in
// native/core/src/network_policy.rs (shared with the Rust front door); this
// module is a thin bridge that keeps the JS export surface, the error types
// and the error texts exactly as they were.
const { getNative } = require('./native/runtime');

function envEnabled(value) {
  return getNative().networkPolicyEnvEnabled(String(value || ''));
}

function isLoopbackHost(host) {
  return getNative().networkPolicyIsLoopbackHost(String(host || ''));
}

function resolveNetworkPolicy(env = process.env) {
  return JSON.parse(getNative().networkPolicyResolve(JSON.stringify(env)));
}

function findAvailablePort(startPort, host, { maxTries = 100 } = {}) {
  // The probe itself is synchronous in Rust; the promise keeps the old async
  // contract, including turning a bind error into a rejection.
  return Promise.resolve().then(() => getNative().networkPolicyFindAvailablePort(startPort, host, maxTries));
}

async function selectListenPort(policy, finder = findAvailablePort) {
  if (!policy || !policy.development) return policy.port;
  return finder(policy.port, policy.host);
}

module.exports = { envEnabled, isLoopbackHost, resolveNetworkPolicy, findAvailablePort, selectListenPort };

'use strict';

// The host supplies only the request budget inputs; Rust owns the policy.
// Timers remain in Node until the request lifecycle itself moves to Rust.
const { getNative } = require('../native/runtime');
// The shared bridge cannot carry BigInt; its decimal spelling preserves the
// policy's String/Number coercions without losing integer precision in transit.
const bridgeValue = value => typeof value === 'bigint' ? value.toString() : value;

function resolveModelRequestPolicy(session = {}, env = process.env) {
  const effort = session.effort;
  const mode = session.providerSelection?.mode;
  const legacy = mode === 'auto' ? env.MULTICC_AUTO_STALL_TIMEOUT_MS : undefined;
  return Object.freeze(getNative().modelRequestPolicyValue({
    effort: bridgeValue(effort), mode: bridgeValue(mode), legacy: bridgeValue(legacy),
    idle: bridgeValue(env.MULTICC_MODEL_IDLE_TIMEOUT_MS),
    request: bridgeValue(env.MULTICC_MODEL_REQUEST_TIMEOUT_MS),
    connect: bridgeValue(env.MULTICC_MODEL_CONNECT_TIMEOUT_MS),
  }));
}

module.exports = { resolveModelRequestPolicy };

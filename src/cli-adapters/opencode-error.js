'use strict';

// ACP/legacy JSON compatibility bridge. Rust owns the diagnosis and recovery
// wording; Node only projects bounded error metadata across the native ABI.
// This bridge can go away when the provider event host moves to Rust.
const { getNative } = require('../native/runtime');

function errorFields(raw, depth = 0) {
  if (!raw || typeof raw !== 'object' || depth > 4) return {};
  const out = {};
  for (const key of ['message', 'code', 'name', 'errorName']) {
    if (typeof raw[key] === 'string') out[key] = raw[key].slice(-65536);
  }
  for (const key of ['error', 'data']) {
    if (raw[key] && typeof raw[key] === 'object') out[key] = errorFields(raw[key], depth + 1);
  }
  return out;
}

function describeOpencodeContextError(raw) {
  // Older packaged addons retain the existing generic error handling until
  // upgraded; diagnosis must never throw and hide the original CLI failure.
  try {
    const native = getNative('opencode_error');
    if (typeof native?.describeOpencodeContextError !== 'function') return null;
    return JSON.parse(native.describeOpencodeContextError(JSON.stringify(errorFields(raw))));
  } catch (_) { return null; }
}

function opencodeProcessError(cli, raw, stderr) {
  // A lost RPC response can leave only agent_exited on stdout. Inspect stderr
  // before the host truncates it, but never replace a substantive RPC error.
  if (cli !== 'opencode' || (raw && raw.code !== 'agent_exited')) return null;
  const detail = describeOpencodeContextError({ message: stderr });
  return detail ? { source: 'process_stderr', provider: cli, ...detail } : null;
}

module.exports = { describeOpencodeContextError, opencodeProcessError };

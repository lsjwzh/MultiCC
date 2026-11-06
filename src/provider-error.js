'use strict';

// Migration bridge only: bound wire metadata and call Rust. Classification,
// evidence precedence and recovery live in Rust. Remove this bridge when the
// provider event host moves there; do not add policy or text matching here.
const { getNative } = require('./native/runtime');

function errorFields(raw, depth = 0, budget = { nodes: 24, chars: 65536 }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || depth > 6 || budget.nodes-- <= 0) return {};
  const out = {};
  for (const key of ['message', 'code', 'name', 'type', 'errorName', 'category', 'httpStatus', 'statusCode', 'status']) {
    if (typeof raw[key] === 'string') {
      out[key] = raw[key].slice(0, key === 'message' ? budget.chars : 128);
      if (key === 'message') budget.chars -= out[key].length;
    } else if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key];
  }
  for (const key of ['rpcError', 'error', 'data']) {
    if (raw[key] && typeof raw[key] === 'object') out[key] = errorFields(raw[key], depth + 1, budget);
  }
  if (raw.response?.error) out.response = { error: errorFields(raw.response.error, depth + 1, budget) };
  return out;
}

function classifyProviderError(raw, { provider, source } = {}) {
  // OpenCode is the first migrated protocol. Other adapters retain their
  // existing classifier until their wire contracts have compatibility tests.
  if (provider !== 'opencode') return null;
  try {
    const native = getNative();
    return JSON.parse(native.classifyProviderError(JSON.stringify({ provider, source, error: errorFields(raw) })));
  } catch (_) { return null; } // Missing/older addon must not hide the CLI fault.
}

module.exports = { errorFields, classifyProviderError };

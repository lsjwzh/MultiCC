'use strict';

// Migration bridge only: parsing, window identity, expiry and merging live in Rust.
// Older installations keep their existing 5h path until the addon is rebuilt.
const { getNative } = require('../native/runtime');

function claudeQuota(op, input) {
  try {
    const native = getNative('claude_quota');
    if (typeof native?.cprClaudeQuota !== 'function') return undefined;
    return JSON.parse(native.cprClaudeQuota(JSON.stringify({ ...input, op })));
  } catch (_) { return undefined; } // Quota observations must never break a stream.
}

module.exports = { claudeQuota };

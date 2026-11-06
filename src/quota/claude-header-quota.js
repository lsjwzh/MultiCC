'use strict';

// Parsing, window identity, expiry and merging live in Rust.
const { getNative } = require('../native/runtime');

function claudeQuota(op, input) {
  try {
    return JSON.parse(getNative().cprClaudeQuota(JSON.stringify({ ...input, op })));
  } catch (_) { return undefined; } // Quota observations must never break a stream.
}

module.exports = { claudeQuota };

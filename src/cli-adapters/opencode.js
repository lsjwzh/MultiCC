'use strict';

const { createOpencodeLikeAdapter } = require('./opencode-like');

function createOpencodeAdapter({ cmd }) {
  return createOpencodeLikeAdapter({
    name: 'opencode', label: 'OpenCode', cmd, supportsAgentVariant: true,
  });
}

module.exports = { createOpencodeAdapter };

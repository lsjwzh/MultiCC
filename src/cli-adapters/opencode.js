'use strict';

const { createOpencodeLikeAdapter } = require('./opencode-like');

function createOpencodeAdapter({ cmd, userInputReminder = '' }) {
  return createOpencodeLikeAdapter({
    name: 'opencode', label: 'OpenCode', cmd, supportsAgentVariant: true,
    includeThinking: true, userInputReminder,
  });
}

module.exports = { createOpencodeAdapter };

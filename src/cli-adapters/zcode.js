'use strict';

const { createOpencodeLikeAdapter } = require('./opencode-like');

function createZcodeAdapter({ cmd }) {
  return createOpencodeLikeAdapter({ name: 'zcode', label: 'ZCode', cmd });
}

module.exports = { createZcodeAdapter };

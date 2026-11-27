'use strict';

const { createWorktreeOrphanScanner, getNative } = require('../native/binding');
function parseWorktreeList(porcelain) {
  return getNative().parseOrphanWorktrees(String(porcelain || ''));
}
module.exports = { createWorktreeOrphanScanner, parseWorktreeList };

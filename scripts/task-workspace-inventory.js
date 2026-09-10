#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { inventoryWorkspaces } = require('../src/workspace/inventory');

// Explicit input only: do not discover or mutate the running server's data root.
function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--input') {
    throw new Error('Usage: node scripts/task-workspace-inventory.js --input snapshot.json');
  }
  const input = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  if (!input || !Array.isArray(input.sessions) || !Array.isArray(input.directories)) {
    throw new Error('snapshot requires sessions[] and directories[]');
  }
  process.stdout.write(JSON.stringify(inventoryWorkspaces(input), null, 2) + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { main };

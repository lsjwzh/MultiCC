'use strict';
// Test-only shim: records the argv/env the native lane spawned, then replaces
// itself with the real `claude` binary via execve. Because execve keeps the
// PID, assertions about "one resident child" and "the old child exited" stay
// meaningful; a wrapper that spawned a grandchild would hide both.
const fs = require('node:fs');

const ledger = process.env.MULTICC_LANE_LEDGER;
const real = process.env.MULTICC_LANE_REAL_BINARY;
const args = process.argv.slice(2);

if (ledger) {
  const env = { ...process.env };
  delete env.MULTICC_LANE_LEDGER;
  delete env.MULTICC_LANE_REAL_BINARY;
  fs.appendFileSync(ledger, `${JSON.stringify({ pid: process.pid, argv: args, env })}\n`);
}

if (!real) {
  process.stderr.write('claude-lane-wrapper: MULTICC_LANE_REAL_BINARY is not set\n');
  process.exit(127);
}

const env = { ...process.env };
delete env.MULTICC_LANE_LEDGER;
delete env.MULTICC_LANE_REAL_BINARY;
process.execve(real, [real, ...args], env);

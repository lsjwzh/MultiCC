'use strict';
// Read the spawn ledger written by claude-lane-wrapper.js.
const fs = require('node:fs');

function rows(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (_) { return []; }
}

async function waitForRows(file, count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = rows(file);
    if (list.length >= count) return list;
    if (Date.now() > deadline) throw new Error(`lane ledger has ${list.length} spawns, expected ${count}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitExited(pid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not exit`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function kill(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (_) { /* already gone */ }
}

module.exports = { rows, waitForRows, alive, waitExited, kill };

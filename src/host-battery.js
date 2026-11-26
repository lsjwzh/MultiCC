'use strict';

const { getNative } = require('./native/binding');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

// The battery belongs to the machine running MultiCC, not to whichever device
// opens the page, so remote clients see the host laptop's charge.
const CACHE_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
const UNAVAILABLE = Object.freeze({ available: false });

// `pmset -g batt` prints e.g. "-InternalBattery-0 (id=1)\t25%; discharging; 1:26 remaining present: true".
// Desktops answer with no InternalBattery line at all, which is "no battery", not an error.
function parsePmset(text) {
  return getNative().hostPmsetReading(String(text || ''), UNAVAILABLE);
}

async function readLinux(readFile) {
  for (const name of ['BAT0', 'BAT1']) {
    try {
      const base = `/sys/class/power_supply/${name}`;
      const percent = Number(String(await readFile(`${base}/capacity`, 'utf8')).trim());
      if (!getNative().hostBatteryCapacity(percent)) continue;
      const status = String(await readFile(`${base}/status`, 'utf8').catch(() => '')).trim();
      return getNative().hostLinuxReading(percent, status);
    } catch (_) { /* try the next battery node */ }
  }
  return UNAVAILABLE;
}

function createBatteryReader({
  platform = process.platform,
  run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => (error ? reject(error) : resolve(stdout)))),
  readFile = fs.readFile,
  now = Date.now,
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function probe() {
    if (platform === 'darwin') return parsePmset(await run('/usr/bin/pmset', ['-g', 'batt']));
    if (platform === 'linux') return readLinux(readFile);
    return UNAVAILABLE;
  }

  return async function readBattery() {
    if (cached && now() - cachedAt < CACHE_MS) return cached;
    // Concurrent sidebars (Web + App) share one probe instead of spawning one each.
    if (!inflight) {
      inflight = probe().catch(() => UNAVAILABLE).then(value => {
        cached = value;
        cachedAt = now();
        return value;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };
}

module.exports = { parsePmset, createBatteryReader, UNAVAILABLE };

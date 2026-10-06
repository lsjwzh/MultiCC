'use strict';

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
  const source = String(text || '');
  const line = source.split('\n').find(row => /InternalBattery/.test(row));
  if (!line) return UNAVAILABLE;
  const percent = Number((line.match(/(\d{1,3})\s*%/) || [])[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return UNAVAILABLE;
  const state = (line.match(/%;\s*([^;]+);/) || [])[1] || '';
  const remaining = line.match(/(\d+):(\d{2}) remaining/);
  const pluggedIn = /AC Power/.test(source);
  return {
    available: true,
    percent,
    charging: /^(charging|finishing charge)$/i.test(state.trim()),
    pluggedIn,
    remainingMinutes: remaining ? Number(remaining[1]) * 60 + Number(remaining[2]) : null,
  };
}

async function readLinux(readFile) {
  for (const name of ['BAT0', 'BAT1']) {
    try {
      const base = `/sys/class/power_supply/${name}`;
      const percent = Number(String(await readFile(`${base}/capacity`, 'utf8')).trim());
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
      const status = String(await readFile(`${base}/status`, 'utf8').catch(() => '')).trim();
      return {
        available: true,
        percent,
        charging: /^charging$/i.test(status),
        pluggedIn: /^(charging|full)$/i.test(status),
        remainingMinutes: null,
      };
    } catch (_) { /* try the next battery node */ }
  }
  return UNAVAILABLE;
}

function createBatteryReader({
  platform = process.platform,
  run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
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

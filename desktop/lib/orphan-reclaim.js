'use strict';

// Reclaim an orphaned backend from a previous desktop run. If the desktop app
// itself is force-killed, the detached server group survives and keeps serving
// the user's data dir. The next launch reads desktop-runtime.json, asks that
// server to drain over HTTP, and only falls back to a tree kill — guaranteeing
// one server per data dir instead of two instances fighting over SQLite.

const fs = require('fs');
const { killProcessTree } = require('./backend-supervisor');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function readRuntimeInfo(infoFile) {
  try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); }
  catch (_) { return null; }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitGone(pid, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !pidAlive(pid);
}

// deps (all injectable for tests):
//   infoFile    desktop-runtime.json path
//   fetchImpl   what it says (default global fetch)
//   spawn       child_process.spawn (forwarded to killProcessTree for Windows)
//   logger      console-like
//   drainMs     how long to wait after the HTTP drain request
async function reclaimOrphan({
  infoFile,
  fetchImpl = fetch,
  spawn,
  logger = console,
  postTimeoutMs = 6_000,
  drainMs = 20_000,
  killWaitMs = 5_000,
} = {}) {
  if (!infoFile) return { reclaimed: false, reason: 'no-info-file' };
  const info = readRuntimeInfo(infoFile);
  if (!info || !info.pid) {
    try { fs.unlinkSync(infoFile); } catch (_) {}
    return { reclaimed: false, reason: 'stale' };
  }
  if (!pidAlive(info.pid)) {
    try { fs.unlinkSync(infoFile); } catch (_) {}
    return { reclaimed: false, reason: 'stale' };
  }

  logger.log(`[desktop] previous backend still running (pid ${info.pid}, ${info.origin || 'origin unknown'}) — reclaiming`);
  // 1) Graceful drain. The orphan is in desktop mode, so the route exists;
  //    a connection error just means it is mid-boot — fall through to kill.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), postTimeoutMs);
    if (timer.unref) timer.unref();
    await fetchImpl(`${info.origin}/api/desktop-shutdown`, { method: 'POST', signal: controller.signal })
      .then(async res => { try { await res.arrayBuffer(); } catch (_) {} });
    clearTimeout(timer);
  } catch (_) { /* not reachable / not ready — the kill below still applies */ }
  if (await waitGone(info.pid, drainMs)) {
    try { fs.unlinkSync(infoFile); } catch (_) {}
    return { reclaimed: true, method: 'http-drain' };
  }
  // 2) Hard kill the whole tree.
  killProcessTree(info.pid, { spawn });
  await waitGone(info.pid, killWaitMs);
  try { fs.unlinkSync(infoFile); } catch (_) {}
  if (pidAlive(info.pid)) {
    logger.error(`[desktop] could not stop orphaned backend pid ${info.pid}`);
    return { reclaimed: false, reason: 'unkillable', pid: info.pid };
  }
  return { reclaimed: true, method: 'kill-tree' };
}

module.exports = { reclaimOrphan, pidAlive, readRuntimeInfo };

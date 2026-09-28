'use strict';

// Log housekeeping: keep logs/ bounded without owning the write side.
//
// Write chain (verified): src/observability.js createLogger({sink: console})
// emits JSON lines to stdout/stderr only; the FILES come from external
// redirection — `multicc start` runs `nohup node server.js >> logs/multicc.log
// 2>> logs/multicc-error.log`, and `multicc install` points the launchd plist
// StandardOutPath/StandardErrorPath at the same two files. Either way the fd
// is opened O_APPEND by the shell/launchd, NOT by the server, so the server
// can never reopen a rotated file: rename-and-recreate would leave the writer
// appending to a ghost inode (disk space never freed, new log invisible).
//
// Therefore:
//  • ACTIVE files (multicc.log, multicc-error.log) are copy-truncated: the
//    surviving tail is copied to a temp file first (crash-safe), then
//    ftruncate(0)+single pwrite back into the SAME inode so the O_APPEND fd
//    keeps writing at the new EOF. Never rm'd, never renamed away. Two rules
//    decide how much survives — whichever keeps LESS:
//      – age: drop every complete line whose `ts` is older than retainDays;
//      – size: never keep more than keepTailBytes.
//    Both cut on a LINE boundary, so the file stays parseable JSONL. The old
//    byte-offset cut tore a line in half on every pass (stdout runs at ~90MB
//    per day, so several passes a day), leaving thousands of unparseable
//    fragments that also defeat `ts`-based greps.
//  • Every other *.log in logs/ (pm2-*, webcc*, verify-*, …) is only deleted
//    once its mtime is older than the retention window — live child-process
//    logs stay fresh and are left alone.
//  • logs/restart-*/ — the mkdtempSync dirs the restart route materializes
//    (restart.sh is executed at most 2s later, then nothing ever reads them
//    again) — are removed wholesale once the directory is older than the
//    window. They are the only directories we own under logs/, so nothing
//    else is touched.
//  • Each pass emits one `log_housekeeping` line with kept/removed bytes.
//
// The sweep runs at boot and HOURLY, not daily: the active files grow far
// faster than the retention window, so the interval — not the threshold — is
// what actually bounds them. A daily pass would let stdout reach ~90MB before
// the first cut (observed live: the file sat at 6MB one hour after a restart).

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RETAIN_DAYS = 3;
const DEFAULT_KEEP_TAIL_BYTES = 5 * 1024 * 1024;
const ACTIVE_LOG_FILES = Object.freeze(['multicc.log', 'multicc-error.log']);
const COPY_CHUNK = 1024 * 1024;
// Only dirs we created ourselves (server-restart.js writeRestartScript).
const EPHEMERAL_DIR_PREFIX = 'restart-';
// `{"ts":"2026-09-28T04:33:53.069Z"` is 32 bytes; the head also carries the
// ts for every line observability.write() emits.
const TS_PREFIX_BYTES = 48;

function copyTailToTemp(file, tmp, startOffset, size) {
  const src = fs.openSync(file, 'r');
  const out = fs.openSync(tmp, 'w');
  try {
    const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(1, size - startOffset)));
    let offset = startOffset;
    while (offset < size) {
      const read = fs.readSync(src, buf, 0, Math.min(buf.length, size - offset), offset);
      if (read <= 0) break;
      fs.writeSync(out, buf, 0, read);
      offset += read;
    }
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(src);
    fs.closeSync(out);
  }
}

function writeBackInPlace(file, tmp) {
  const tail = fs.readFileSync(tmp);
  const target = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(target, 0);
    // Single pwrite: the O_APPEND writer (shell/launchd fd) resumes at the new
    // EOF; at worst a few bytes appended during the swap are lost or land after
    // the tail — logrotate's copytruncate makes the same trade.
    if (tail.length > 0) fs.writeSync(target, tail, 0, tail.length, 0);
    fs.fsyncSync(target);
  } finally {
    fs.closeSync(target);
  }
}

function readRange(file, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, 'r');
  try {
    let filled = 0;
    while (filled < length) {
      const read = fs.readSync(fd, buf, filled, length - filled, offset + filled);
      if (read <= 0) break;
      filled += read;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}

// The ts is the first field of every line observability.write() emits. Non-JSON
// lines (stack traces, `[cpr] …`, `[multicc/wait] …`) carry no time of their
// own, so they can only be kept or dropped together with their neighbours.
function lineTimestamp(buf, start, end) {
  const head = buf.toString('utf8', start, Math.min(end, start + TS_PREFIX_BYTES));
  const match = /^\{"ts":"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/.exec(head);
  if (!match) return null;
  const at = Date.parse(match[1]);
  return Number.isFinite(at) ? at : null;
}

// Byte offset to keep from; 0 means "leave the file alone". Everything before
// the tail window would be dropped by the size rule anyway, so only the window
// is scanned — a 90MB stdout costs the same as a 5MB one.
function keepFromOffset(file, size, keepTailBytes, cutoffMs) {
  const window = Math.min(size, Math.max(1, keepTailBytes));
  if (window <= 0 || size <= 0) return 0;
  const from = size - window;
  const buf = readRange(file, from, window);
  let start = 0;
  let lastLineStart = 0;
  let sawTimestamp = false;
  while (start < buf.length) {
    const newline = buf.indexOf(0x0a, start);
    const end = newline < 0 ? buf.length : newline;
    lastLineStart = start;
    const at = lineTimestamp(buf, start, end);
    if (at !== null) {
      sawTimestamp = true;
      if (at >= cutoffMs) return from + start; // line-aligned start of the kept region
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  // No line in the window is recent enough to keep. When the window holds
  // timestamps at all, the age rule wins outright and only the newest line
  // survives (an idle error log must not pin a week of history). A file with no
  // timestamps whatsoever is left to the size rule alone — never emptied.
  if (sawTimestamp) return from + lastLineStart;
  return from;
}

function createLogHousekeeping(deps = {}) {
  if (!deps.logsDir || typeof deps.logsDir !== 'string') {
    throw new TypeError('[log-housekeeping] logsDir is required');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.logger || console;
  const retainDays = Number.isFinite(Number(deps.retainDays)) && Number(deps.retainDays) >= 0
    ? Number(deps.retainDays) : DEFAULT_RETAIN_DAYS;
  const keepTailBytes = Number.isFinite(Number(deps.keepTailBytes)) && Number(deps.keepTailBytes) >= 0
    ? Number(deps.keepTailBytes) : DEFAULT_KEEP_TAIL_BYTES;
  const activeFiles = new Set(deps.activeFiles || ACTIVE_LOG_FILES);

  function pruneEphemeralDir(name, at, summary) {
    const dir = path.join(deps.logsDir, name);
    const stat = fs.statSync(dir);
    if (at - stat.mtimeMs <= retainDays * DAY_MS) return;
    fs.rmSync(dir, { recursive: true, force: true });
    summary.dirsRemoved.push({ dir: name, ageDays: Math.floor((at - stat.mtimeMs) / DAY_MS) });
  }

  function trimActiveFile(name, size, cutoffMs, summary) {
    const file = path.join(deps.logsDir, name);
    const start = keepFromOffset(file, size, keepTailBytes, cutoffMs);
    if (start <= 0) return;
    const tmp = `${file}.housekeep.tmp`;
    copyTailToTemp(file, tmp, start, size);
    try {
      writeBackInPlace(file, tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    summary.truncated.push({ file: name, before: size, after: size - start });
  }

  async function runOnce() {
    const at = now();
    const cutoffMs = at - retainDays * DAY_MS;
    const summary = { logsDir: deps.logsDir, retainDays, keptTailBytes: keepTailBytes, truncated: [], deleted: [], dirsRemoved: [], errors: [] };
    let entries;
    try {
      entries = fs.readdirSync(deps.logsDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return summary; // no logs dir yet
      throw error;
    }
    for (const entry of entries) {
      try {
        if (entry.isDirectory()) {
          if (entry.name.startsWith(EPHEMERAL_DIR_PREFIX)) pruneEphemeralDir(entry.name, at, summary);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        const stat = fs.statSync(path.join(deps.logsDir, entry.name));
        if (activeFiles.has(entry.name)) {
          trimActiveFile(entry.name, stat.size, cutoffMs, summary);
          continue; // active files are never deleted, even when ancient
        }
        if (at - stat.mtimeMs > retainDays * DAY_MS) {
          fs.unlinkSync(path.join(deps.logsDir, entry.name));
          summary.deleted.push({ file: entry.name, bytes: stat.size, ageDays: Math.floor((at - stat.mtimeMs) / DAY_MS) });
        }
      } catch (error) {
        summary.errors.push({ file: entry.name, error: error?.message || String(error) });
      }
    }
    logger.info?.('log_housekeeping', {
      truncated: summary.truncated,
      deleted: summary.deleted.map(item => `${item.file}(${item.ageDays}d,${item.bytes}B)`),
      dirsRemoved: summary.dirsRemoved.map(item => `${item.dir}(${item.ageDays}d)`),
      errors: summary.errors.length || undefined,
    });
    return summary;
  }

  return Object.freeze({ runOnce, ACTIVE_LOG_FILES: activeFiles });
}

module.exports = {
  createLogHousekeeping,
  LOG_HOUSEKEEPING_INTERVAL_MS: HOUR_MS,
  LOG_HOUSEKEEPING_ACTIVE_FILES: ACTIVE_LOG_FILES,
  DEFAULT_LOG_RETAIN_DAYS: DEFAULT_RETAIN_DAYS,
  DEFAULT_LOG_KEEP_TAIL_BYTES: DEFAULT_KEEP_TAIL_BYTES,
};

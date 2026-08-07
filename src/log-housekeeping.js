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
//    last `keepTailBytes` are copied to a temp file first (crash-safe), then
//    ftruncate(0)+single pwrite back into the SAME inode so the O_APPEND fd
//    keeps writing at the new EOF. Never rm'd, never renamed away.
//  • Every other *.log in logs/ (pm2-*, webcc*, verify-*, …) is only deleted
//    once its mtime is older than the retention window — live child-process
//    logs stay fresh and are left alone.
//  • Each pass emits one `log_housekeeping` line with kept/removed bytes.

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETAIN_DAYS = 3;
const DEFAULT_KEEP_TAIL_BYTES = 5 * 1024 * 1024;
const ACTIVE_LOG_FILES = Object.freeze(['multicc.log', 'multicc-error.log']);
const COPY_CHUNK = 1024 * 1024;

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

  async function runOnce() {
    const at = now();
    const summary = { logsDir: deps.logsDir, retainDays, keptTailBytes: keepTailBytes, truncated: [], deleted: [], errors: [] };
    let entries;
    try {
      entries = fs.readdirSync(deps.logsDir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.log'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return summary; // no logs dir yet
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(deps.logsDir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (activeFiles.has(entry.name)) {
          if (stat.size > keepTailBytes) {
            const tmp = `${file}.housekeep.tmp`;
            copyTailToTemp(file, tmp, stat.size - keepTailBytes, stat.size);
            try {
              writeBackInPlace(file, tmp);
            } finally {
              fs.rmSync(tmp, { force: true });
            }
            summary.truncated.push({ file: entry.name, before: stat.size, after: keepTailBytes });
          }
          continue; // active files are never deleted, even when ancient
        }
        if (at - stat.mtimeMs > retainDays * DAY_MS) {
          fs.unlinkSync(file);
          summary.deleted.push({ file: entry.name, bytes: stat.size, ageDays: Math.floor((at - stat.mtimeMs) / DAY_MS) });
        }
      } catch (error) {
        summary.errors.push({ file: entry.name, error: error?.message || String(error) });
      }
    }
    logger.info?.('log_housekeeping', {
      truncated: summary.truncated,
      deleted: summary.deleted.map(item => `${item.file}(${item.ageDays}d,${item.bytes}B)`),
      errors: summary.errors.length || undefined,
    });
    return summary;
  }

  return Object.freeze({ runOnce, ACTIVE_LOG_FILES: activeFiles });
}

module.exports = {
  createLogHousekeeping,
  LOG_HOUSEKEEPING_INTERVAL_MS: DAY_MS,
  LOG_HOUSEKEEPING_ACTIVE_FILES: ACTIVE_LOG_FILES,
  DEFAULT_LOG_RETAIN_DAYS: DEFAULT_RETAIN_DAYS,
  DEFAULT_LOG_KEEP_TAIL_BYTES: DEFAULT_KEEP_TAIL_BYTES,
};

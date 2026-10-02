'use strict';

// Pre-resume size guard for the resume-capable CLI lanes beyond codex:
// zcode, kimi, codebuddy, qoder and dsh all take a native session id on
// their resume flag and replay that native history before the first
// upstream request. Like the codex rollout those stores are append-only
// and grow without bound (observed in the wild: zcode rollouts at 17.7MB
// with no gate at all), so an oversized native session makes every resume
// slower and can eventually wedge startup the way the 181MB codex rollout
// did (state-DB backfill outliving the bridge's initialize timeout).
//
// The contract mirrors codex-rollout-guard: when the native history
// backing record.cliSessionId exceeds maxBytes (default 10MB), move it out
// of the vendor's store into a sibling multicc archive dir (never delete)
// and let the caller clear cliSessionId so the turn starts a fresh native
// session. MultiCC's own context layers are recomposed every turn, so only
// the vendor-native history is sacrificed. Fail-open: any filesystem error
// returns action 'error' and the turn proceeds exactly as before.
//
// Store layouts (verified on disk 2026-10 unless noted):
//   zcode     <zcodeSessionHome>/.zcode/cli/rollout/model-io-sess_<id>.jsonl
//             — the filename embeds the native session id
//   kimi      provider lane: <kimiSessionHome>; providerless: $KIMI_CODE_HOME
//             or ~/.kimi-code. No local sample yet; kimi-code is
//             Claude-Code-like so the id should appear in the transcript
//             filename — a layout miss degrades to 'not_found', never harm
//   codebuddy ~/.codebuddy/projects/<cwd-slug>/<id>.jsonl (byte-compatible
//             with Claude Code's layout; verified: 8.8MB transcripts)
//   qoder     ~/.qoder (Claude-compatible; no local sample yet, same
//             degrade-safe matching as kimi)
//   dsh       ~/.dsh/sessions/<cwd-slug>/<id>/session*.jsonl.zstd — the id
//             is the DIRECTORY name, so dsh matches directories, not files
//
// gemini/grok are deliberately not covered: both are ACP lanes whose bridge
// drops the replayed history, and their on-disk session format is
// unverified. Archived entries older than the TTL
// (MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS, default 30, 0 disables) are
// swept on each successful archive, throttled to one pass per 6h.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_DIRNAME = 'multicc-archived-sessions';
const DEFAULT_ARCHIVE_TTL_DAYS = 30;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_SCAN_ENTRIES = 100_000;

function toPositiveBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toArchiveTtlMs(value, fallbackDays) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackDays * 24 * 60 * 60 * 1000;
  return n <= 0 ? 0 : n * 24 * 60 * 60 * 1000;
}

function createNativeSessionGuard(deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const homeDir = deps.homeDir || os.homedir();
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const maxBytes = toPositiveBytes(
    deps.maxBytes !== undefined ? deps.maxBytes : env.MULTICC_NATIVE_SESSION_MAX_BYTES,
    DEFAULT_MAX_BYTES,
  );
  const archiveTtlMs = toArchiveTtlMs(
    deps.archiveTtlDays !== undefined ? deps.archiveTtlDays : env.MULTICC_NATIVE_SESSION_ARCHIVE_TTL_DAYS,
    DEFAULT_ARCHIVE_TTL_DAYS,
  );
  const zcodeSessionHomeFor = typeof deps.zcodeSessionHomeFor === 'function'
    ? deps.zcodeSessionHomeFor : null;
  const kimiSessionHomeFor = typeof deps.kimiSessionHomeFor === 'function'
    ? deps.kimiSessionHomeFor : null;

  // 'files': archive every file under a root whose NAME embeds the native id.
  // 'dirs':  archive the whole directory whose name IS the native id (dsh).
  const STORES = {
    zcode: { kind: 'files', suffix: '.jsonl' },
    kimi: { kind: 'files', suffix: '.jsonl' },
    codebuddy: { kind: 'files', suffix: '.jsonl' },
    qoder: { kind: 'files', suffix: '.jsonl' },
    dsh: { kind: 'dirs' },
  };

  function rootsFor(cli, record) {
    switch (cli) {
      case 'zcode':
        // The engine's store (rollout + db) lives under <home>/.zcode; the
        // home itself also holds unrelated trees (.dartServer), so scan only
        // the .zcode subtree.
        return zcodeSessionHomeFor && record.id
          ? [path.join(zcodeSessionHomeFor(String(record.id)), '.zcode')] : [];
      case 'kimi':
        if (record.provider && kimiSessionHomeFor && record.id) {
          return [kimiSessionHomeFor(String(record.id))];
        }
        return [env.KIMI_CODE_HOME || path.join(homeDir, '.kimi-code')];
      case 'codebuddy': return [path.join(homeDir, '.codebuddy')];
      case 'qoder': return [path.join(homeDir, '.qoder')];
      case 'dsh': return [path.join(homeDir, '.dsh', 'sessions')];
      default: return [];
    }
  }

  function existsSafe(p) {
    try { return fsImpl.existsSync(p); } catch (_) { return false; }
  }

  // Bounded recursive walk. Returns matching paths; silently skips
  // unreadable directories (fail-open per store, never per turn).
  function walkMatches(root, id, store) {
    const found = [];
    let inspected = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (++inspected > MAX_SCAN_ENTRIES) return found;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (store.kind === 'dirs' && entry.name === id) found.push(full);
          else if (entry.name !== ARCHIVE_DIRNAME) stack.push(full);
        } else if (store.kind === 'files' && entry.isFile()
          && entry.name.includes(id) && entry.name.endsWith(store.suffix)) {
          found.push(full);
        }
      }
    }
    return found;
  }

  function sizeOf(p, isDir) {
    if (!isDir) {
      try { return fsImpl.statSync(p).size; } catch (_) { return 0; }
    }
    let total = 0;
    const stack = [p];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else { try { total += fsImpl.statSync(full).size; } catch (_) { /* skip */ } }
      }
    }
    return total;
  }

  function moveTree(fsImpl2, from, to) {
    fsImpl2.mkdirSync(path.dirname(to), { recursive: true });
    fsImpl2.renameSync(from, to);
  }

  function listSubdirs(dir) {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
  }

  function allArchiveDirs() {
    const dirs = [];
    for (const cli of ['codebuddy', 'qoder', 'dsh']) {
      dirs.push(path.join(archiveRootFor(cli, {}, ''), ARCHIVE_DIRNAME));
    }
    dirs.push(path.join(env.KIMI_CODE_HOME || path.join(homeDir, '.kimi-code'), ARCHIVE_DIRNAME));
    const zcodeHomes = deps.zcodeHomesDir || path.join(homeDir, '.multicc', 'zcode-homes');
    const kimiHomes = deps.kimiHomesDir || path.join(homeDir, '.multicc', 'kimi-homes');
    for (const home of listSubdirs(zcodeHomes)) dirs.push(path.join(home, '.zcode', ARCHIVE_DIRNAME));
    for (const home of listSubdirs(kimiHomes)) dirs.push(path.join(home, ARCHIVE_DIRNAME));
    return dirs;
  }

  let lastSweepAt = 0;
  function sweepExpiredArchives(options = {}) {
    if (archiveTtlMs <= 0) return Object.freeze({ deleted: [], freedBytes: 0, disabled: true });
    const nowMs = options.nowMs !== undefined ? options.nowMs : Date.now();
    if (!options.force && nowMs - lastSweepAt < SWEEP_INTERVAL_MS) {
      return Object.freeze({ deleted: [], freedBytes: 0, throttled: true });
    }
    lastSweepAt = nowMs;
    const deleted = [];
    let freedBytes = 0;
    for (const archiveDir of allArchiveDirs()) {
      let entries;
      try { entries = fsImpl.readdirSync(archiveDir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const full = path.join(archiveDir, entry.name);
        try {
          const stats = fsImpl.statSync(full);
          if (nowMs - stats.mtimeMs <= archiveTtlMs) continue;
          if (entry.isDirectory()) {
            freedBytes += sizeOf(full, true);
            fsImpl.rmSync(full, { recursive: true, force: true });
          } else {
            freedBytes += stats.size;
            fsImpl.unlinkSync(full);
          }
          deleted.push(full);
        } catch (_) { /* one bad entry must not stop the sweep */ }
      }
    }
    if (deleted.length) {
      try { logger.info?.('native_session_archive_cleanup', { deleted: deleted.length, freedBytes, ttlDays: archiveTtlMs / 86400000 }); } catch (_) {}
    }
    return Object.freeze({ deleted, freedBytes });
  }

  // Inspect the native history backing record.cliSessionId and archive it.
  //   action: 'skipped'  — unhandled cli / no cliSessionId
  //   action: 'not_found'— no native file matched (layout miss is harmless)
  //   action: 'ok'       — within budget
  //   action: 'archived' — moved; caller must clear cliSessionId (+ resident
  //                        _streamSessionId) so the next spawn starts fresh
  //   action: 'error'    — guard failed; the turn must proceed unchanged
  function enforce(record, options = {}) {
    const cli = record && record.cli;
    const store = STORES[cli];
    if (!store || !record.cliSessionId) return Object.freeze({ action: 'skipped' });
    const id = String(record.cliSessionId);
    const force = options.force === true;
    try {
      const matches = [];
      for (const root of rootsFor(cli, record)) {
        if (!existsSafe(root)) continue;
        for (const hit of walkMatches(root, id, store)) matches.push(hit);
      }
      if (!matches.length) return Object.freeze({ action: 'not_found', maxBytes });
      const isDir = store.kind === 'dirs';
      const sized = matches.map(file => ({ file, sizeBytes: sizeOf(file, isDir) }));
      const totalBytes = sized.reduce((sum, item) => sum + item.sizeBytes, 0);
      if (!force && totalBytes <= maxBytes) {
        return Object.freeze({ action: 'ok', maxBytes, totalBytes, files: matches.length });
      }
      const archived = sized.map(item => {
        const archiveDir = path.join(archiveRootFor(cli, record, item.file), ARCHIVE_DIRNAME);
        const target = path.join(archiveDir, `${String(record.id || 'session').slice(0, 32)}-${path.basename(item.file)}`);
        moveTree(fsImpl, item.file, target);
        return { file: item.file, sizeBytes: item.sizeBytes, archivedTo: target };
      });
      try { sweepExpiredArchives(); } catch (_) {}
      return Object.freeze({
        action: 'archived', maxBytes, totalBytes, files: matches.length,
        cliSessionId: id, archived,
      });
    } catch (error) {
      try { logger.warn?.('native_session_guard_error', { sessionId: record.id, cli, error: String(error && error.message || error) }); } catch (_) {}
      return Object.freeze({ action: 'error', error: String(error && error.message || error) });
    }
  }

  // The archive lives in a sibling of the matched store subtree: for per-
  // session homes (zcode/kimi provider lane) that is the home itself; for
  // shared vendor homes it is the vendor root. Deriving it from the match
  // keeps codebuddy transcripts under ~/.codebuddy rather than scattering.
  function archiveRootFor(cli, record, matchedFile) {
    if (cli === 'zcode' || (cli === 'kimi' && record.provider)) {
      const roots = rootsFor(cli, record);
      if (roots.length && matchedFile.startsWith(roots[0] + path.sep)) return roots[0];
    }
    if (cli === 'kimi') return env.KIMI_CODE_HOME || path.join(homeDir, '.kimi-code');
    if (cli === 'dsh') return path.join(homeDir, '.dsh');
    return path.join(homeDir, `.${cli}`);
  }

  function handles(cli) { return Object.prototype.hasOwnProperty.call(STORES, cli); }

  return Object.freeze({ enforce, handles, sweepExpiredArchives, maxBytes, archiveTtlMs });
}

module.exports = {
  createNativeSessionGuard,
  DEFAULT_MAX_BYTES,
  DEFAULT_ARCHIVE_TTL_DAYS,
  ARCHIVE_DIRNAME,
};

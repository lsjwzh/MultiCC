'use strict';

// Pre-resume size guard for codex native sessions.
//
// A codex rollout (~/.codex/sessions/…/rollout-*-<thread_id>.jsonl) is an
// append-only log: raw tool outputs and base64 image_generation payloads make
// it grow without bound while codex's context-window compaction only governs
// the request payload, never the file. On `codex exec resume <thread_id>` the
// CLI loads and rebuilds history from that file BEFORE any compaction runs,
// and with an oversized rollout it hangs internally (observed: 440MB rollout,
// five deterministic zero-output hangs, no outbound request ever sent).
//
// The guard runs at chat-turn admission, before the spawn decision: if the
// rollout backing the persisted cliSessionId exceeds maxBytes (default 10MB),
// the file is moved out of codex's sessions tree (archived, not deleted) and
// the caller drops cliSessionId so the turn starts a fresh thread instead of
// resuming. MultiCC's own context layers (system prompt, memory, notes) are
// recomposed every turn, so the rebuilt conversation keeps its grounding; only
// the native codex history is sacrificed.
//
// Archived files accumulate disk weight (hundreds of MB per pathological
// thread), so the guard also sweeps the archive dir: entries older than the
// TTL (MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS, default 30, 0 disables) are
// deleted on each successful archive, throttled to one sweep per 6h.
//
// Fail-open by design: any filesystem error returns action 'error' and the
// turn proceeds exactly as before — a guard hiccup must never block a turn.
// restart-spawn calls enforce(record, { force: true }) to archive the rollout
// unconditionally: a manual process restart is an explicit context rebuild.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_ROLLOUT_BYTES = 10 * 1024 * 1024;
const ARCHIVE_DIRNAME = 'multicc-archived-rollouts';
const DEFAULT_ARCHIVE_TTL_DAYS = 30;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function toPositiveBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Days → ms. Invalid input falls back to the default; <= 0 disables cleanup.
function toArchiveTtlMs(value, fallbackDays) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackDays * 24 * 60 * 60 * 1000;
  return n <= 0 ? 0 : n * 24 * 60 * 60 * 1000;
}

function createCodexRolloutGuard(deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const homeDir = deps.homeDir || os.homedir();
  const codexHomesDir = deps.codexHomesDir || path.join(homeDir, '.multicc', 'codex-homes');
  const codexSessionHomesDir = deps.codexSessionHomesDir
    || path.join(homeDir, '.multicc', 'codex-session-homes');
  const codexSessionHomeFor = typeof deps.codexSessionHomeFor === 'function'
    ? deps.codexSessionHomeFor : null;
  const prepareCodexSessionHome = typeof deps.prepareCodexSessionHome === 'function'
    ? deps.prepareCodexSessionHome : null;
  const maxBytes = toPositiveBytes(
    deps.maxBytes !== undefined ? deps.maxBytes : process.env.MULTICC_CODEX_ROLLOUT_MAX_BYTES,
    DEFAULT_MAX_ROLLOUT_BYTES,
  );
  const logger = deps.logger || console;

  function codexHome(record) {
    if (record.provider && codexSessionHomeFor && record.id) {
      return codexSessionHomeFor(String(record.id));
    }
    return record.provider
      ? path.join(codexHomesDir, String(record.provider))
      : path.join(homeDir, '.codex');
  }

  // Same discovery walk as server.js livenessRolloutPath: recursive scan for a
  // .jsonl whose name embeds the native thread id.
  function findRollouts(sessionsDir, id) {
    const entriesExist = fsImpl.existsSync(sessionsDir);
    if (!entriesExist) return [];
    const found = [];
    const stack = [sessionsDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.includes(id) && entry.name.endsWith('.jsonl')) {
          found.push(full);
        }
      }
    }
    return found;
  }

  // Move oversized rollouts out of codex's sessions tree. Renaming in place is
  // NOT safe: codex resolves rollouts by scanning for the thread id, so the
  // archive lives in a sibling of sessions/ that codex never reads.
  function archiveRollout(file, sessionsDir) {
    const archiveDir = path.join(path.dirname(sessionsDir), ARCHIVE_DIRNAME);
    fsImpl.mkdirSync(archiveDir, { recursive: true });
    const target = path.join(archiveDir, path.basename(file));
    fsImpl.renameSync(file, target);
    return target;
  }

  const archiveTtlMs = toArchiveTtlMs(
    deps.archiveTtlDays !== undefined
      ? deps.archiveTtlDays
      : process.env.MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS,
    DEFAULT_ARCHIVE_TTL_DAYS,
  );

  // Every codex home that can hold an archive dir: the default ~/.codex plus
  // one per routed provider under codexHomesDir.
  function candidateArchiveDirs() {
    const homes = [path.join(homeDir, '.codex')];
    let entries = [];
    try { entries = fsImpl.readdirSync(codexHomesDir, { withFileTypes: true }); } catch (_) { entries = []; }
    for (const entry of entries) {
      if (entry.isDirectory()) homes.push(path.join(codexHomesDir, entry.name));
    }
    try { entries = fsImpl.readdirSync(codexSessionHomesDir, { withFileTypes: true }); }
    catch (_) { entries = []; }
    for (const entry of entries) {
      if (entry.isDirectory()) homes.push(path.join(codexSessionHomesDir, entry.name));
    }
    return homes.map(home => path.join(home, ARCHIVE_DIRNAME));
  }

  // Delete archived rollouts older than the TTL. Throttled (one pass per
  // SWEEP_INTERVAL_MS unless options.force) and fail-open per file: cleanup
  // is housekeeping, never a turn blocker.
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
    for (const archiveDir of candidateArchiveDirs()) {
      let entries;
      try { entries = fsImpl.readdirSync(archiveDir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(archiveDir, entry.name);
        try {
          const stats = fsImpl.statSync(full);
          if (nowMs - stats.mtimeMs <= archiveTtlMs) continue;
          fsImpl.unlinkSync(full);
          deleted.push(full);
          freedBytes += stats.size;
        } catch (_) { /* one bad file must not stop the sweep */ }
      }
    }
    if (deleted.length) {
      try { logger.info?.('codex_rollout_archive_cleanup', { deleted: deleted.length, freedBytes, ttlDays: archiveTtlMs / 86400000 }); } catch (_) {}
    }
    return Object.freeze({ deleted, freedBytes });
  }

  // Inspect the rollout backing record.cliSessionId and archive it. Returns a
  // frozen summary for logging/notification:
  //   action: 'skipped'  — not a codex record / no cliSessionId
  //   action: 'ok'       — rollout within budget
  //   action: 'not_found' — 历史已缺失；调用方清除旧线程引用并重建上下文
  //   action: 'archived' — rollout(s) moved; caller must clear
  //                        record.cliSessionId so the next spawn starts fresh
  //   action: 'error'    — guard failed; turn must proceed unchanged
  // options.force (used by restart-spawn): archive EVERY rollout of the thread
  // regardless of size — the user explicitly asked to rebuild the context.
  function enforce(record, options = {}) {
    if (!record || !['codex', 'codex-exp'].includes(record.cli) || !record.cliSessionId) {
      return Object.freeze({ action: 'skipped' });
    }
    const force = options.force === true;
    try {
      const prepared = record.provider && prepareCodexSessionHome && record.id
        ? prepareCodexSessionHome({
          logicalSessionId: record.id,
          nativeSessionId: record.cliSessionId,
        }) : null;
      const sessionsDir = prepared && prepared.sessionsDir
        ? prepared.sessionsDir : path.join(codexHome(record), 'sessions');
      const files = findRollouts(sessionsDir, String(record.cliSessionId));
      if (!files.length) return Object.freeze({ action: 'not_found', maxBytes });
      const archived = [];
      let totalBytes = 0;
      for (const file of files) {
        let sizeBytes = 0;
        try { sizeBytes = fsImpl.statSync(file).size; } catch (_) { sizeBytes = 0; }
        totalBytes += sizeBytes;
        if (force || sizeBytes > maxBytes) archived.push({ file, sizeBytes, archivedTo: archiveRollout(file, sessionsDir) });
      }
      if (!archived.length) {
        return Object.freeze({ action: 'ok', maxBytes, totalBytes, files: files.length });
      }
      // Housekeeping: an archive just grew, so opportunist prune expired
      // entries (throttled; failures here are swallowed inside the sweep).
      try { sweepExpiredArchives(); } catch (_) {}
      return Object.freeze({
        action: 'archived', maxBytes, totalBytes, files: files.length,
        cliSessionId: String(record.cliSessionId), archived,
      });
    } catch (error) {
      if (error && error.code === 'CODEX_SESSION_ROLLOUT_NOT_FOUND') {
        return Object.freeze({ action: 'not_found', maxBytes });
      }
      if (error && /^CODEX_SESSION_/.test(String(error.code || ''))) {
        try { logger.warn?.('codex_rollout_guard_blocked', { sessionId: record.id, code: error.code }); } catch (_) {}
        return Object.freeze({
          action: 'blocked', code: error.code,
          error: String(error && error.message || error),
        });
      }
      try { logger.warn?.('codex_rollout_guard_error', { sessionId: record.id, error: String(error && error.message || error) }); } catch (_) {}
      return Object.freeze({ action: 'error', error: String(error && error.message || error) });
    }
  }

  return Object.freeze({ enforce, sweepExpiredArchives, maxBytes, archiveTtlMs });
}


// 准入检查与重建通知集中在守卫模块，避免回合引擎继续增长。
function enforceCodexRolloutForTurn({ guard, persisted, sessionName, logger,
  rememberActiveCliState, savePersistedSessionsBestEffort, chatBroadcast, appendEvent }) {
  const guardResult = guard.enforce(persisted);
  if (guardResult.action === 'blocked') {
    logger.error('codex_rollout_guard_blocked', { sessionId: sessionName, code: guardResult.code });
    chatBroadcast(sessionName, { type: 'error', code: guardResult.code,
      error: 'Codex 原生会话历史无法唯一定位；为避免恢复到错误上下文，本轮已阻止。请检查重复的 rollout 文件。' });
    return guardResult;
  }
  if (guardResult.action === 'not_found') {
    persisted.cliSessionId = null;
    persisted._streamSessionId = null;
    rememberActiveCliState(persisted);
    savePersistedSessionsBestEffort('runtime.codex-history-missing');
    logger.warn('codex_rollout_missing_recovered', { sessionId: sessionName });
    chatBroadcast(sessionName, { type: 'system', subtype: 'warning',
      message: 'Codex 原生历史文件已缺失，已自动新建会话上下文并继续本条消息。' });
  }
  if (guardResult.action === 'archived') {
    persisted.cliSessionId = null;
    savePersistedSessionsBestEffort();
    logger.warn('codex_rollout_archived', { sessionId: sessionName,
      archivedCliSessionId: guardResult.cliSessionId, maxBytes: guardResult.maxBytes,
      archived: guardResult.archived.map(item => ({ file: item.file, sizeBytes: item.sizeBytes, archivedTo: item.archivedTo })) });
    appendEvent(persisted.dirId, 'codex_rollout_archived',
      `codex rollout 超过 ${(guardResult.maxBytes / 1048576).toFixed(0)}MB 已归档，本轮将重建上下文`, sessionName);
    chatBroadcast(sessionName, { type: 'system', subtype: 'rollout_archived',
      message: `codex 原生会话历史过大（rollout > ${Math.round(guardResult.maxBytes / 1048576)}MB），已归档并重建上下文；旧历史文件保留在归档目录，未删除。` });
  }
  return guardResult;
}

module.exports = {
  enforceCodexRolloutForTurn,
  createCodexRolloutGuard,
  DEFAULT_MAX_ROLLOUT_BYTES,
  DEFAULT_ARCHIVE_TTL_DAYS,
  ARCHIVE_DIRNAME,
};

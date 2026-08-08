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
// the file is moved out of codex's sessions tree (archived, never deleted) and
// the caller drops cliSessionId so the turn starts a fresh thread instead of
// resuming. MultiCC's own context layers (system prompt, memory, notes) are
// recomposed every turn, so the rebuilt conversation keeps its grounding; only
// the native codex history is sacrificed.
//
// Fail-open by design: any filesystem error returns action 'error' and the
// turn proceeds exactly as before — a guard hiccup must never block a turn.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_ROLLOUT_BYTES = 10 * 1024 * 1024;
const ARCHIVE_DIRNAME = 'multicc-archived-rollouts';

function toPositiveBytes(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createCodexRolloutGuard(deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const homeDir = deps.homeDir || os.homedir();
  const codexHomesDir = deps.codexHomesDir || path.join(homeDir, '.multicc', 'codex-homes');
  const maxBytes = toPositiveBytes(
    deps.maxBytes !== undefined ? deps.maxBytes : process.env.MULTICC_CODEX_ROLLOUT_MAX_BYTES,
    DEFAULT_MAX_ROLLOUT_BYTES,
  );
  const logger = deps.logger || console;

  function codexHome(record) {
    return record.provider
      ? path.join(codexHomesDir, String(record.provider))
      : path.join(homeDir, '.codex');
  }

  // Same discovery walk as server.js livenessRolloutPath: recursive scan for a
  // .jsonl whose name embeds the native thread id.
  function findRollouts(sessionsDir, id) {
    let entriesExist = false;
    try { entriesExist = fsImpl.existsSync(sessionsDir); } catch (_) { entriesExist = false; }
    if (!entriesExist) return [];
    const found = [];
    const stack = [sessionsDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
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

  // Inspect the rollout backing record.cliSessionId and archive it when it
  // exceeds maxBytes. Returns a frozen summary for logging/notification:
  //   action: 'skipped'  — not a codex record / no cliSessionId
  //   action: 'ok'       — rollout within budget (or none found: 'not_found')
  //   action: 'archived' — oversized rollout(s) moved; caller must clear
  //                        record.cliSessionId so the next spawn starts fresh
  //   action: 'error'    — guard failed; turn must proceed unchanged
  function enforce(record) {
    if (!record || record.cli !== 'codex' || !record.cliSessionId) {
      return Object.freeze({ action: 'skipped' });
    }
    try {
      const sessionsDir = path.join(codexHome(record), 'sessions');
      const files = findRollouts(sessionsDir, String(record.cliSessionId));
      if (!files.length) return Object.freeze({ action: 'not_found', maxBytes });
      const archived = [];
      let totalBytes = 0;
      for (const file of files) {
        let sizeBytes = 0;
        try { sizeBytes = fsImpl.statSync(file).size; } catch (_) { sizeBytes = 0; }
        totalBytes += sizeBytes;
        if (sizeBytes > maxBytes) archived.push({ file, sizeBytes, archivedTo: archiveRollout(file, sessionsDir) });
      }
      if (!archived.length) {
        return Object.freeze({ action: 'ok', maxBytes, totalBytes, files: files.length });
      }
      return Object.freeze({
        action: 'archived', maxBytes, totalBytes, files: files.length,
        cliSessionId: String(record.cliSessionId), archived,
      });
    } catch (error) {
      try { logger.warn?.('codex_rollout_guard_error', { sessionId: record.id, error: String(error && error.message || error) }); } catch (_) {}
      return Object.freeze({ action: 'error', error: String(error && error.message || error) });
    }
  }

  return Object.freeze({ enforce, maxBytes });
}

module.exports = { createCodexRolloutGuard, DEFAULT_MAX_ROLLOUT_BYTES, ARCHIVE_DIRNAME };

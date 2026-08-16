'use strict';
// Provider limit/usage cache — the durable complement to usage-limit-poller's
// in-memory TTL cache.
//
// The poller keeps the last-fetched window/balance DTO for a few minutes in
// memory, but the moment the server restarts that freshness is gone: quota bars
// render from "no data" until the next poll/route fetch happens to land. This
// module gives every provider identity a last-known-good limit snapshot that
// survives restarts, so the Web/App provider pickers can show a comparable
// summary + "last updated" even before the first live fetch of a fresh boot.
//
// Contract:
//   - key = `<appType>:<providerId>` (stable provider identity) → idempotent
//     upsert; renames create a new key and the old entry is pruned on the next
//     snapshot sweep (see prune()).
//   - A SUCCESSFUL fetch overwrites the entry. A FAILED fetch never overwrites
//     the last good data — it only records a diagnostic `lastError` /
//     `lastErrorAt` / `lastAttemptAt` alongside the still-valid summary.
//   - No credentials, API keys, or raw token values are ever stored — only the
//     normalized window/balance summary and its compact bar text.
//   - Persistence reuses state-store's createStore: atomic write + rolling
//     backups + fail-closed load, so a corrupt file throws rather than silently
//     dropping state.

const { createStore } = require('../state-store');

const STALE_MS_DEFAULT = 10 * 60 * 1000; // bar freshness threshold for "过期" UI

function createProviderLimitCache({ file, now = Date.now, logger = console } = {}) {
  if (!file) throw new TypeError('[provider-limit-cache] requires { file }');
  const store = createStore({ file, kind: 'provider-limit-cache', schemaVersion: 1, legacyIsArray: false });
  let state = loadInitial();
  let dirty = false;

  function loadInitial() {
    let data = null;
    try {
      const r = store.loadOrRecover();
      if (r.present) data = r.data;
    } catch (e) {
      logger.warn && logger.warn(`[multicc/provider-limit-cache] load failed, starting empty: ${e.message}`);
    }
    const entries = (data && typeof data.entries === 'object' && data.entries) || {};
    return { entries, updatedAt: typeof data === 'object' && data && data.updatedAt ? data.updatedAt : 0 };
  }

  function key(appType, id) {
    return `${String(appType)}:${String(id)}`;
  }

  function persist() {
    if (!dirty) return;
    dirty = false;
    try {
      store.save({ entries: state.entries, updatedAt: state.updatedAt });
    } catch (e) {
      logger.warn && logger.warn(`[multicc/provider-limit-cache] save failed: ${e.message}`);
      dirty = true; // retry on the next mutation
    }
  }

  // Record a successful limit fetch. Idempotent upsert; entry.fetchedAt is the
  // time the data was actually produced (may differ from now when replaying a
  // DTO that carries its own observedAt).
  function record(appType, id, entry) {
    if (!entry || typeof entry !== 'object') return null;
    const k = key(appType, id);
    const prev = state.entries[k] || null;
    const nowMs = now();
    const next = {
      appType: String(appType),
      providerId: String(id),
      kind: entry.kind || (prev ? prev.kind : 'quota'),
      status: 'ok',
      summary: entry.summary != null ? entry.summary : (prev ? prev.summary : null),
      summaryText: typeof entry.summaryText === 'string' ? entry.summaryText : (prev ? prev.summaryText : ''),
      barText: typeof entry.barText === 'string' ? entry.barText : (prev ? prev.barText : null),
      fetchedAt: entry.fetchedAt != null ? Math.trunc(entry.fetchedAt) : nowMs,
      updatedAt: nowMs,
      lastError: null,
      lastErrorAt: null,
      lastAttemptAt: nowMs,
    };
    state.entries[k] = next;
    state.updatedAt = nowMs;
    dirty = true;
    persist();
    return next;
  }

  // Record that a fetch failed. Never touches an existing successful entry —
  // it only stamps diagnostics so the UI can distinguish "stale but last known
  // good" from "never fetched".
  function recordFailure(appType, id, meta = {}) {
    const k = key(appType, id);
    const prev = state.entries[k] || null;
    const nowMs = now();
    const next = prev || {
      appType: String(appType),
      providerId: String(id),
      kind: 'unknown',
      status: 'error',
      summary: null,
      summaryText: '',
      barText: null,
      fetchedAt: null,
      updatedAt: nowMs,
    };
    next.lastError = meta.error ? String(meta.error) : null;
    next.lastErrorCode = meta.code ? String(meta.code) : null;
    next.lastErrorAt = nowMs;
    next.lastAttemptAt = nowMs;
    state.entries[k] = next;
    state.updatedAt = nowMs;
    dirty = true;
    persist();
    return next;
  }

  function get(appType, id) {
    const e = state.entries[key(appType, id)];
    return e ? e : null;
  }

  // Copy-on-read snapshot for API/UI. The shape stays stable across versions so
  // old clients ignore extra fields.
  function snapshot() {
    const entries = {};
    for (const k of Object.keys(state.entries)) entries[k] = { ...state.entries[k] };
    return { entries, updatedAt: state.updatedAt };
  }

  // Drop entries whose provider identity no longer exists (deleted / renamed
  // provider). Called on /api/providers so the file doesn't grow orphans.
  function prune(liveKeys) {
    if (!liveKeys || !liveKeys.size) return 0;
    let removed = 0;
    for (const k of Object.keys(state.entries)) {
      if (!liveKeys.has(k)) {
        delete state.entries[k];
        removed += 1;
      }
    }
    if (removed) {
      dirty = true;
      persist();
    }
    return removed;
  }

  return Object.freeze({
    record,
    recordFailure,
    get,
    snapshot,
    prune,
    key,
    file: store.file,
  });
}

module.exports = { createProviderLimitCache, STALE_MS_DEFAULT };

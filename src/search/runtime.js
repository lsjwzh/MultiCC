'use strict';

const path = require('node:path');
const { resolveDataDir, createPaths } = require('../paths');
const { createSearchIndex } = require('./index-store');
const { createMessageCorpus, MESSAGE_SCOPE } = require('./message-corpus');
const { createChatHistoryFileRepository } = require('../session/adapters/chat-history-file-repository');

// The message index as a running service, rather than a CLI over a file.
//
// scripts/search-index.js builds and reads the index by hand; this module is what
// the server itself owns. Three jobs, in the order they matter:
//
//   1. Warm the index. A cold build over the real corpus is seconds of CPU (314
//      sessions / 124MB / 3.6s measured), so the first sweep is sliced by session
//      and yields between slices instead of blocking the event loop: no single
//      tick pays more than one session's parse (worst observed 6.7ms). Once warm,
//      a sweep is a Map lookup per session — 16ms for the whole corpus — so the
//      60s interval below is what keeps the index current without a per-turn
//      dependency on it.
//   2. Serve searches: the same bigram/bm25 query semantics as the board search,
//      over message text instead of task excerpts.
//   3. Accept a per-turn nudge (syncSession) so the session that just spoke is
//      searchable immediately rather than up to a minute later. Measured at ~7ms
//      for a live session, which is why it may sit on the turn-end path.
//
// Everything here is best-effort and never throws at its caller: a missing FTS5,
// a vanished history directory or a closed database all degrade to "no results",
// because the consumers (task association, an HTTP route) both have their own
// fallback and neither should fail because a derived index did.
//
// `getSharedSearchRuntime` memoizes one runtime per data directory. It exists so
// that the route and the classify path — which are wired in different places and
// must not each open their own handle on the same SQLite file — reach the same
// instance without threading a port through server.js.

const DEFAULT_INTERVAL_MS = 60000;
// Sessions per event-loop turn during the first sweep. Small on purpose: the cost
// of a slice is the slowest single session it contains, not the average.
const FIRST_SWEEP_BATCH = 8;
// One search's worth of hits when the caller does not say. The index clamps its
// own limit too; this is the default the port advertises.
const DEFAULT_HITS = 10;
const MAX_FAILURE_LOGS = 3;

function createSearchRuntime({
  dataDir = resolveDataDir(),
  logger = console,
  intervalMs = DEFAULT_INTERVAL_MS,
  firstSweepBatch = FIRST_SWEEP_BATCH,
  setImmediateImpl = setImmediate,
  dbFile = null,
  index = null,
  history = null,
  now = Date.now,
} = {}) {
  const paths = createPaths({ dataDir });
  const opened = index || createSearchIndex({ dbFile: dbFile || paths.searchIndexDbFile, logger });
  const repo = history || createChatHistoryFileRepository({ dataDir });
  const corpus = opened.available ? createMessageCorpus({ index: opened, history: repo, logger }) : null;
  const defer = typeof setImmediateImpl === 'function' ? setImmediateImpl : setImmediate;
  const state = {
    started: false,
    firstSweepScheduled: false,
    firstSweepDone: false,
    sweeps: 0,
    lastSweep: null,
    indexedAt: 0,
    timer: null,
    failures: 0,
  };

  // Failures are logged a bounded number of times: this port sits on the turn-end
  // path, so a database that is permanently unavailable would otherwise write one
  // line per turn forever. The count stays visible in status() either way.
  function noteFailure(event, error, context = {}) {
    state.failures += 1;
    if (state.failures > MAX_FAILURE_LOGS) return;
    logger?.warn?.(`search_index_${event}: ${error?.message || error}`, context);
  }

  function syncSession(sessionId) {
    if (!corpus || !sessionId) return null;
    try {
      return corpus.syncSession(String(sessionId));
    } catch (error) {
      noteFailure('sync_failed', error, { sessionId: String(sessionId) });
      return null;
    }
  }

  // One sweep, synchronously. Only the 60s interval and tests call this: on the
  // real corpus a sweep with nothing to do is ~16ms, and one that picks up a turn
  // pays only for the sessions whose file moved.
  function sweep({ force = false } = {}) {
    if (!corpus) return null;
    // A sweep during the sliced first pass would fight it for the same rows and
    // could prune against a half-built ref list.
    if (state.firstSweepScheduled && !state.firstSweepDone) return { skipped: 'warming' };
    try {
      const summary = corpus.syncAll({ force });
      state.sweeps += 1;
      state.lastSweep = summary;
      state.indexedAt = now();
      return summary;
    } catch (error) {
      noteFailure('sweep_failed', error);
      return null;
    }
  }

  // The cold path, sliced. Sessions are synced in batches with an event-loop turn
  // between them, and the plain sweep at the end is what prunes sessions history
  // no longer has — by then every live session fast-paths skipped, so it is cheap
  // and the prune rules stay in exactly one place (corpus.syncAll).
  function scheduleFirstSweep() {
    if (state.firstSweepScheduled || !corpus) return;
    state.firstSweepScheduled = true;
    const started = now();
    let ids = [];
    try {
      ids = corpus.listSessions();
    } catch (error) {
      noteFailure('list_failed', error);
    }
    // One ref snapshot for the whole pass: the per-session fast path would
    // otherwise re-read the ref table for every session (O(sessions²)), and a
    // linear pass never revisits an id, so a snapshot cannot go stale under it.
    let refs = new Map();
    try {
      refs = new Map(opened.listRefs(MESSAGE_SCOPE).map(ref => [ref.refId, ref]));
    } catch (error) {
      noteFailure('list_refs_failed', error);
    }
    let cursor = 0;
    let synced = 0;
    let skipped = 0;
    const step = () => {
      const until = Math.min(ids.length, cursor + Math.max(1, firstSweepBatch));
      for (; cursor < until; cursor += 1) {
        try {
          const result = corpus.syncSession(ids[cursor], { refs });
          if (result?.sessionSkipped) skipped += 1;
          else synced += 1;
        } catch (error) {
          noteFailure('sync_failed', error, { sessionId: ids[cursor] });
        }
      }
      if (cursor < ids.length) { defer(step); return; }
      state.firstSweepDone = true;
      const summary = sweep();
      logger?.log?.(`search_index_ready: ${ids.length} 个会话（新增 ${synced}、未变 ${skipped}）、`
        + `${summary?.chunks || 0} 块、耗时 ${now() - started}ms`);
    };
    defer(step);
  }

  function start() {
    if (state.started) return api;
    state.started = true;
    if (!corpus) return api;
    if (intervalMs > 0) {
      state.timer = setInterval(() => sweep(), intervalMs);
      // The index is derived data: it must never be the reason the process stays
      // alive at shutdown.
      if (typeof state.timer?.unref === 'function') state.timer.unref();
    }
    scheduleFirstSweep();
    return api;
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    return api;
  }

  function search(options = {}) {
    if (!corpus) {
      return { mode: 'unavailable', terms: [], results: [], reason: opened.reason || 'unavailable' };
    }
    try {
      return corpus.search(options);
    } catch (error) {
      noteFailure('search_failed', error);
      return { mode: 'error', terms: [], results: [], reason: error?.message || 'search failed' };
    }
  }

  // The hits other subsystems consume: one object per matching message chunk, with
  // `sessionId` spelled out (the index's own column name is `refId`, which means
  // nothing outside this layer) and the snippet left as the index built it — a
  // window with highlight ranges — so a prompt can quote its text and a browser
  // can render its marks.
  function findMessages({
    text = '', limit = DEFAULT_HITS, kinds = ['user', 'assistant'], refIds = null, excludeRefIds = null,
  } = {}) {
    const result = search({
      text,
      limit,
      kinds,
      refIds: refIds || undefined,
      excludeRefIds: excludeRefIds || undefined,
    });
    return (result.results || []).map(hit => ({
      sessionId: String(hit.refId || ''),
      messageId: hit.itemId || '',
      kind: hit.kind || '',
      updatedAt: Number(hit.updatedAt) || 0,
      score: Number(hit.score) || 0,
      text: String(hit.text || ''),
      snippet: hit.snippet || { text: '', ranges: [] },
    })).filter(hit => hit.sessionId);
  }

  function stats() {
    if (!opened.available) return { available: false, reason: opened.reason, dbFile: opened.dbFile, scopes: [] };
    try {
      return opened.stats();
    } catch (error) {
      noteFailure('stats_failed', error);
      return { available: false, reason: 'stats failed', dbFile: opened.dbFile, scopes: [] };
    }
  }

  // What a route or a health check can report without reaching into the index.
  function status() {
    return {
      available: !!corpus,
      reason: opened.reason || '',
      dbFile: opened.dbFile,
      dataDir: paths.root,
      started: state.started,
      // `warming` is the honest answer to "why did my search miss": the first
      // sweep is still walking the corpus, so hits are partial for a few hundred ms.
      warming: state.firstSweepScheduled && !state.firstSweepDone,
      sweeps: state.sweeps,
      indexedAt: state.indexedAt,
      failures: state.failures,
      lastSweep: state.lastSweep,
    };
  }

  const api = {
    available: !!corpus,
    reason: opened.reason || '',
    dbFile: opened.dbFile,
    dataDir: paths.root,
    MESSAGE_SCOPE,
    start,
    stop,
    sweep,
    syncSession,
    search,
    findMessages,
    stats,
    status,
    close: () => { stop(); try { opened.close(); } catch (error) { /* closing twice is fine */ } },
  };
  return api;
}

// One runtime per data directory. Two handles on the same SQLite file would mean
// two sweepers racing over the same rows for no benefit, and the two consumers
// (the HTTP route, the classify turn) are wired in different places — this is what
// lets them share one instance without a new port threaded through server.js.
const SHARED = new Map();

function getSharedSearchRuntime(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || resolveDataDir()));
  let runtime = SHARED.get(dataDir);
  if (!runtime) {
    runtime = createSearchRuntime({ ...options, dataDir });
    SHARED.set(dataDir, runtime);
    runtime.start();
  }
  return runtime;
}

// Tests only: drop the memoized instances (and their file handles) so the next
// getSharedSearchRuntime starts clean against a fresh fixture directory.
function resetSharedSearchRuntimes() {
  for (const runtime of SHARED.values()) runtime.close();
  SHARED.clear();
}

module.exports = {
  DEFAULT_HITS,
  DEFAULT_INTERVAL_MS,
  FIRST_SWEEP_BATCH,
  createSearchRuntime,
  getSharedSearchRuntime,
  resetSharedSearchRuntimes,
};

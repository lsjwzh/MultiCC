'use strict';

const path = require('node:path');
const { resolveDataDir, createPaths } = require('../paths');
const { createSearchIndex, MAX_LIMIT } = require('./index-store');
const { rerank } = require('./diversity');
const { createMessageCorpus, MESSAGE_SCOPE } = require('./message-corpus');
const { createSliceRunner, DEFAULT_SLICE_MS, DEFAULT_DUTY } = require('./slice-runner');
const { createChatHistoryFileRepository } = require('../session/adapters/chat-history-file-repository');

// The message index as a running service, rather than a CLI over a file.
//
// scripts/search-index.js builds and reads the index by hand; this module is what
// the server itself owns. Three jobs, in the order they matter:
//
//   1. Keep the index current without ever being felt. Everything that touches
//      chat_history runs as a job on a slice runner (slice-runner.js): at most
//      ~8ms of work per slice, then a pause sized so the work averages out to
//      ~10% of one core. Within a session the pass is incremental — it parses only
//      what was appended since the last one — so a 100MB conversation that gained a
//      turn costs a turn, and a cold build of the whole corpus is spread over
//      seconds instead of held in one. The safety-net sweep is every few minutes,
//      not every minute: the per-turn nudge below is what keeps the conversation
//      that just spoke fresh, the sweep only has to catch whatever missed it.
//   2. Serve searches: the same bigram/bm25 query semantics as the board search,
//      over message text instead of task excerpts.
//   3. Accept a per-turn nudge (syncSession) so the session that just spoke is
//      searchable immediately rather than minutes later. It sits on the turn-end
//      path, so it is only done inline when it is small (the appended tail); a
//      session with a lot to catch up on is queued at the front of the runner.
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

// A safety net, not the freshness mechanism (see the header): an idle sweep is a
// stat per session, so this could be shorter, but there is nothing for it to catch
// that the per-turn nudge has not already indexed.
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
// A file written this recently is still being written. Leave it to the turn-end
// nudge and the next sweep instead of chasing it mid-stream.
const QUIET_MS = 20 * 1000;
// What the turn-end nudge may read inline. Past this the work moves to the runner.
const INLINE_MAX_BYTES = 4 * 1024 * 1024;
// One search's worth of hits when the caller does not say. The index clamps its
// own limit too; this is the default the port advertises.
const DEFAULT_HITS = 10;
const MAX_FAILURE_LOGS = 3;
// How many chunks one conversation may contribute to the first pass of a result.
// Without a cap a long conversation occupies the whole answer: measured on the real
// corpus, a 20-hit query returned 13 chunks from one session.
const DEFAULT_PER_REF_QUOTA = 3;
// The SQL side is asked for more rows than the caller wants, because a diversity
// pass can only promote another session if that session's rows are in the candidate
// pool at all. Four pages is enough to fill a page after a quota demotion, and the
// index's own MAX_LIMIT bounds it.
const DIVERSITY_POOL_FACTOR = 4;

function createSearchRuntime({
  dataDir = resolveDataDir(),
  logger = console,
  intervalMs = DEFAULT_INTERVAL_MS,
  // Called as (fn, delayMs): delayMs is 0 for "next turn of the loop", positive for
  // the duty-cycle pause between slices.
  setImmediateImpl = null,
  sliceMs = DEFAULT_SLICE_MS,
  duty = DEFAULT_DUTY,
  quietMs = QUIET_MS,
  inlineMaxBytes = INLINE_MAX_BYTES,
  blockBytes = undefined,
  fsImpl = undefined,
  // Which directory a conversation belongs to. The session records own that
  // mapping; chat_history does not carry it. Read through the shared state registry
  // at call time (server.js fills it during bootstrap) so the runtime needs no new
  // port threaded through the host, and a test can replace it with a plain function.
  resolveDirId = defaultResolveDirId,
  dbFile = null,
  index = null,
  history = null,
  now = Date.now,
} = {}) {
  const paths = createPaths({ dataDir });
  const opened = index || createSearchIndex({ dbFile: dbFile || paths.searchIndexDbFile, logger });
  const repo = history || createChatHistoryFileRepository({ dataDir });
  const corpus = opened.available
    ? createMessageCorpus({
      index: opened, history: repo, logger, resolveDirId,
      ...(fsImpl ? { fsImpl } : {}), ...(blockBytes ? { blockBytes } : {}),
    })
    : null;
  const runner = createSliceRunner({
    now,
    sliceMs,
    duty,
    ...(typeof setImmediateImpl === 'function' ? { defer: (fn, delayMs) => setImmediateImpl(fn, delayMs) } : {}),
  });
  const state = {
    started: false,
    firstSweepScheduled: false,
    firstSweepDone: false,
    sweepQueued: false,
    queued: new Set(),
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

  // Queue a session behind nothing but the job already running. Used when the
  // turn-end nudge finds more to catch up on than it may do inline.
  function queueSession(id) {
    if (!corpus || state.queued.has(id)) return;
    state.queued.add(id);
    runner.enqueue(corpus.syncSessionSteps(id), {
      front: true,
      onDone: () => { state.queued.delete(id); },
      onError: error => { state.queued.delete(id); noteFailure('sync_failed', error, { sessionId: id }); },
    });
  }

  // The per-turn nudge. Cheap by construction: a session that only grew costs the
  // appended tail, and one that would cost more than `inlineMaxBytes` (first sight
  // of a huge transcript, or one that was rewritten) is handed to the runner and
  // reported as `deferred` rather than held on the turn-end path.
  function syncSession(sessionId) {
    if (!corpus || !sessionId) return null;
    const id = String(sessionId);
    try {
      const result = corpus.syncSession(id, { maxBytes: inlineMaxBytes });
      if (result?.deferred) queueSession(id);
      return result;
    } catch (error) {
      noteFailure('sync_failed', error, { sessionId: id });
      return null;
    }
  }

  // One sweep, synchronously, with no pacing. Tests and tools call this; the server
  // never does (it would hold the loop for as long as the sweep takes).
  function sweep({ force = false } = {}) {
    if (!corpus) return null;
    // A sweep during the first pass would fight it for the same rows and could
    // prune against a half-built ref list.
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

  // The sweep as a paced job: the interval timer's work, and the cold build. One at
  // a time — a tick that lands while the previous sweep is still being worked off
  // is dropped rather than stacked.
  function queueSweep({ first = false } = {}) {
    if (!corpus || state.sweepQueued) return false;
    state.sweepQueued = true;
    const started = now();
    runner.enqueue(corpus.syncAllSteps({ quietMs }), {
      onDone: summary => {
        state.sweepQueued = false;
        state.sweeps += 1;
        state.lastSweep = summary;
        state.indexedAt = now();
        if (first) {
          state.firstSweepDone = true;
          logger?.log?.(`search_index_ready: ${summary.sessions} 个会话（新增 ${summary.synced}、未变 ${summary.skipped}）、`
            + `${summary.chunks} 块、耗时 ${now() - started}ms`);
        }
      },
      onError: error => {
        state.sweepQueued = false;
        // A failed cold build must not leave the runtime "warming" forever.
        if (first) state.firstSweepDone = true;
        noteFailure('sweep_failed', error);
      },
    });
    return true;
  }

  function sweepInBackground() {
    if (state.firstSweepScheduled && !state.firstSweepDone) return false;
    return queueSweep();
  }

  function scheduleFirstSweep() {
    if (state.firstSweepScheduled || !corpus) return;
    state.firstSweepScheduled = true;
    queueSweep({ first: true });
  }

  function start() {
    if (state.started) return api;
    state.started = true;
    if (!corpus) return api;
    if (intervalMs > 0) {
      state.timer = setInterval(() => sweepInBackground(), intervalMs);
      // The index is derived data: it must never be the reason the process stays
      // alive at shutdown.
      if (typeof state.timer?.unref === 'function') state.timer.unref();
    }
    scheduleFirstSweep();
    return api;
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    runner.clear();
    state.sweepQueued = false;
    state.queued.clear();
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
  // `dirId` / `taskId` are SQL filters, not post-filters: narrowing after the fact
  // would return fewer rows than asked for and waste the ranking on chunks the
  // caller cannot use. Both are optional and independent of each other.
  //
  // The rows come back in relevance order and are then handed to the Rust diversity
  // kernel (native/core/src/search_diversity.rs), which folds the same paragraph
  // quoted across conversations and caps how much one session may contribute while
  // keeping relevance as the primary order. The SQL query deliberately over-fetches
  // so that cap can promote a session that would otherwise sit below the cut.
  function findMessages({
    text = '', limit = DEFAULT_HITS, kinds = ['user', 'assistant'], refIds = null, excludeRefIds = null,
    dirId = null, taskId = null, perRefQuota = DEFAULT_PER_REF_QUOTA, dedupeContentHash = true,
  } = {}) {
    const wanted = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || DEFAULT_HITS));
    const pool = Math.min(MAX_LIMIT, wanted * DIVERSITY_POOL_FACTOR);
    const result = search({
      text,
      limit: pool,
      kinds,
      refIds: refIds || undefined,
      excludeRefIds: excludeRefIds || undefined,
      dirId: dirId ? String(dirId) : undefined,
      taskId: taskId ? String(taskId) : undefined,
    });
    const hits = (result.results || []).map(hit => ({
      sessionId: String(hit.refId || ''),
      messageId: hit.itemId || '',
      kind: hit.kind || '',
      dirId: String(hit.dirId || ''),
      taskId: String(hit.taskId || ''),
      contentHash: String(hit.contentHash || ''),
      updatedAt: Number(hit.updatedAt) || 0,
      score: Number(hit.score) || 0,
      text: String(hit.text || ''),
      snippet: hit.snippet || { text: '', ranges: [] },
    })).filter(hit => hit.sessionId);
    try {
      return rerank(hits, { limit: wanted, perRefQuota, dedupeContentHash });
    } catch (error) {
      // The addon is the only implementation of the rule, and without it the index
      // itself could not have been opened. Still: a search answer the caller cannot
      // get because post-processing failed would be worse than a relevance-only
      // answer, so the raw order is returned and the failure is counted.
      noteFailure('rerank_failed', error);
      return hits.slice(0, wanted);
    }
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
      queued: runner.pending(),
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
    sweepInBackground,
    syncSession,
    search,
    findMessages,
    stats,
    status,
    close: () => { stop(); runner.stop(); try { opened.close(); } catch (error) { /* closing twice is fine */ } },
  };
  return api;
}

// server.js publishes the session records into the shared state registry at
// bootstrap; reading them here (rather than holding a reference) keeps the runtime
// free of a new port and makes the default a no-op in tests, which never populate
// the registry.
function defaultResolveDirId(sessionId) {
  const state = require('../state/container');
  const records = state.persistedSessions;
  if (!records || typeof records.get !== 'function') return '';
  const record = records.get(String(sessionId));
  return record && record.dirId ? String(record.dirId) : '';
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
  INLINE_MAX_BYTES,
  QUIET_MS,
  createSearchRuntime,
  getSharedSearchRuntime,
  resetSharedSearchRuntimes,
};

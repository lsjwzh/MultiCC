'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { databaseConstructor } = require('../sqlite/driver');
const { indexTokens, matchExpression, tokenize } = require('./tokenize');

// Durable full-text index for corpora too large to rank in memory.
//
// The task board ranks a few hundred KB with pure in-memory BM25, which is the
// right shape there (src/task-board/search.js). Message bodies are three orders of
// magnitude bigger — chat_history is hundreds of MB of JSONL — so the searchable
// slice of it needs an index that survives a restart and accepts incremental
// appends. That is what this module is.
//
// SQLite supplies it, through the driver that already backs every other store
// (src/sqlite/driver.js → node:sqlite): FTS5 is compiled into the SQLite Node
// ships, so this costs no dependency, no native build and no second process.
//
// Tokenisation is the *same* bigram scheme the board ranks with (./tokenize.js),
// fed in as pre-split tokens — FTS5 only stores and matches them. The postings
// live in a contentless table (`content=''`), so the index holds terms and rowids
// and nothing else; the original text is stored once, in search_chunk.
//
// Three properties are load-bearing, and each was measured rather than assumed:
//   - `detail=full`, not `detail=none`. Ranking is bm25, and bm25 needs the term
//     frequencies that `detail=none` throws away: measured, every row then comes
//     back with bm25 = 0, so ORDER BY degenerates to the tie-breaker and results
//     are effectively unsorted. `detail=column` measured the same way. The 21%
//     smaller file is not worth an index that returns the right rows in the wrong
//     order (27.25MB vs 21.44MB over 21k real chunks).
//   - A lone CJK character is not an index term — the bigram scheme never emits
//     one — so a one-character query is answered by a LIKE scan instead. Measured
//     at ~19ms over 21k chunks; the alternative is roughly doubling the index for
//     terms that carry almost no ranking signal.
//   - Every token is quoted in the MATCH expression (see ./tokenize.js): unquoted,
//     FTS5 reads `air.js` as a syntax error and `provider-router` as
//     `provider NOT router`.
//
// bm25 has one property that shapes what an index this size can do: a term present
// in half the corpus or more has an IDF of zero, so it contributes nothing to the
// ordering. Ties fall through to updated_at DESC — which is the behaviour worth
// having anyway for a term too common to discriminate.
//
// Everything in this file is derived data. It can be deleted at any time and
// rebuilt from the source corpora, so nothing authoritative may be stored here —
// and a schema or tokenizer change is handled by dropping and rebuilding, never by
// migrating rows.

const SCHEMA_VERSION = 1;
// Bump when the token scheme changes; stored in search_meta so a stale index
// rebuilds itself instead of silently answering queries in the old scheme.
const TOKENIZER_SIGNATURE = 'bigram-v1';
// `tokenchars` must keep `-` `.` `$` `+` attached, so `provider-router`, `air.js`
// and `3.53.2` stay one term exactly as ./tokenize.js splits them.
const TOKENIZE_OPTION = "unicode61 tokenchars '_-.\$+'";
// Namespace for the per-ref markers in `search_meta`, kept clear of the schema keys
// ('signature' and friends) that live in the same table.
const MARKER_PREFIX = 'ref:';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 200;
const SNIPPET_RADIUS = 40;
const SNIPPET_MAX = 200;

const MATCH_SQL = `SELECT c.scope, c.ref_id AS refId, c.ord, c.item_id AS itemId, c.kind, c.dir_id AS dirId,
    c.text, c.updated_at AS updatedAt, bm25(search_fts) AS rank
  FROM search_fts JOIN search_chunk c ON c.id = search_fts.rowid
  WHERE search_fts MATCH ? AND c.scope = ?__FILTERS__
  ORDER BY rank ASC, c.updated_at DESC LIMIT ?`;
// LIKE cannot use an index, so this scans search_chunk for the scope. It exists
// only for queries the inverted index cannot answer (a lone CJK character) and is
// bounded by the limit; measured ~19ms over 21k chunks.
const LIKE_SQL = `SELECT c.scope, c.ref_id AS refId, c.ord, c.item_id AS itemId, c.kind, c.dir_id AS dirId,
    c.text, c.updated_at AS updatedAt
  FROM search_chunk c
  WHERE c.scope = ? AND c.text LIKE ? ESCAPE '\\'__FILTERS__
  ORDER BY c.updated_at DESC LIMIT ?`;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function hashOf(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
}

// FTS5 is present in every official Node build, but the standalone bundle can run
// under a Node whose SQLite was compiled differently — so the capability is probed
// with a real create/insert/match instead of assumed. Cached per process: the
// answer cannot change while we run.
let probedFts5 = null;
function probeFts5(Database) {
  if (probedFts5 !== null) return probedFts5;
  let db = null;
  try {
    db = new Database(':memory:');
    // contentless_delete is part of the probe on purpose: an older SQLite that has
    // FTS5 but not that option must fail here rather than at the first delete.
    db.exec(`CREATE VIRTUAL TABLE probe USING fts5(tokens, content='', contentless_delete=1, detail=full, tokenize="${TOKENIZE_OPTION}")`);
    db.prepare('INSERT INTO probe(rowid, tokens) VALUES (?, ?)').run(1, '全文 文检 检索');
    const hit = db.prepare('SELECT count(*) AS c FROM probe WHERE probe MATCH ?').get('"检索"');
    probedFts5 = Number(hit?.c) === 1;
  } catch (error) {
    probedFts5 = false;
  } finally {
    try { db?.close(); } catch (error) { /* probe only */ }
  }
  return probedFts5;
}

// Terms the client should highlight, mirroring the board's highlighter: real words
// when the query has any, otherwise the bare characters it was made of.
function highlightTerms(query) {
  const strong = indexTokens(query);
  if (strong.length) return strong;
  return [...tokenize(query).keys()];
}

// Highlight offsets are relative to the window we return, so the client renders
// them without any index arithmetic — same contract as the board's snippet.
function buildSnippet(text, terms) {
  const body = String(text == null ? '' : text);
  const lower = body.toLowerCase();
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const needle = String(term).toLowerCase();
    if (!needle || needle.length <= length) continue;
    const found = lower.indexOf(needle);
    if (found >= 0) { at = found; length = needle.length; }
  }
  let windowText;
  if (at < 0) {
    windowText = body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
  } else {
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(body.length, at + length + SNIPPET_RADIUS);
    windowText = body.slice(start, end).replace(/\s+/g, ' ').trim();
  }
  const windowLower = windowText.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    const needle = String(term).toLowerCase();
    if (!needle) continue;
    let from = windowLower.indexOf(needle);
    while (from >= 0) {
      ranges.push([from, from + needle.length]);
      from = windowLower.indexOf(needle, from + needle.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { text: windowText, ranges: merged };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

function normalizeRow(row) {
  const scope = String(row?.scope || '').trim();
  const refId = String(row?.refId || '').trim();
  const text = String(row?.text == null ? '' : row.text);
  if (!scope) throw new TypeError('search index row requires a scope');
  if (!refId) throw new TypeError('search index row requires a refId');
  if (!text.trim()) return null;
  return {
    scope,
    refId,
    ord: Math.max(0, Math.floor(Number(row?.ord) || 0)),
    itemId: String(row?.itemId || ''),
    kind: String(row?.kind || ''),
    dirId: String(row?.dirId || ''),
    text,
    updatedAt: Math.max(0, Math.floor(Number(row?.updatedAt) || 0)),
  };
}

function unavailableIndex({ dbFile, reason, logger }) {
  logger?.warn?.(`search_index_unavailable: ${reason}`);
  return Object.freeze({
    available: false,
    reason,
    dbFile,
    upsert: () => ({ inserted: 0, updated: 0, skipped: 0 }),
    removeRefs: () => 0,
    pruneRef: () => 0,
    readMarker: () => null,
    writeMarker: () => {},
    listMarkers: () => [],
    dropMarkers: () => 0,
    listRefs: () => [],
    search: () => ({ mode: 'unavailable', terms: [], results: [] }),
    stats: () => ({ available: false, reason, dbFile, scopes: [], emptyRefs: 0 }),
    close: () => {},
  });
}

function createSearchIndex({
  dbFile,
  logger = console,
  Database = null,
  probe = null,
} = {}) {
  if (typeof dbFile !== 'string' || !dbFile) throw new TypeError('search index requires a dbFile');
  const Impl = Database || databaseConstructor();
  const hasFts5 = (probe || probeFts5)(Impl);
  if (!hasFts5) return unavailableIndex({ dbFile, reason: 'fts5_unavailable', logger });

  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  let db;
  try {
    db = new Impl(dbFile, { timeout: 5000 });
    // WAL + NORMAL: this is a rebuildable index, so the extra fsync of FULL would
    // buy durability of something we can always regenerate.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const signature = `${TOKENIZER_SIGNATURE}|${TOKENIZE_OPTION}`;
    const version = Number(db.pragma('user_version', { simple: true })) || 0;
    let storedSignature = '';
    if (version) {
      try {
        storedSignature = String(db.prepare("SELECT value FROM search_meta WHERE key = 'signature'").get()?.value || '');
      } catch (error) { storedSignature = ''; }
    }
    // A mismatch means the postings were built by different rules than the ones we
    // are about to query with. Every row is derived, so dropping is the whole fix.
    if (version > SCHEMA_VERSION || (version && storedSignature !== signature)) {
      logger?.warn?.(`search_index_rebuild: schema or tokenizer changed (was ${version}/${storedSignature || 'none'})`);
      db.exec('DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_chunk; DROP TABLE IF EXISTS search_meta;');
    }
    db.exec('CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(`CREATE TABLE IF NOT EXISTS search_chunk (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      ord INTEGER NOT NULL DEFAULT 0,
      item_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      dir_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS search_chunk_unit ON search_chunk(scope, ref_id, ord)');
    db.exec('CREATE INDEX IF NOT EXISTS search_chunk_ref ON search_chunk(scope, ref_id)');
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(tokens, content='', contentless_delete=1, detail=full, tokenize="${TOKENIZE_OPTION}")`);
    db.prepare('INSERT OR REPLACE INTO search_meta(key, value) VALUES (?, ?)').all('signature', signature);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    if (dbFile !== ':memory:') for (const suffix of ['', '-wal', '-shm']) {
      try { fs.chmodSync(dbFile + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    try { db?.close(); } catch (closeError) { /* already failing */ }
    return unavailableIndex({ dbFile, reason: `open_failed: ${error.message}`, logger });
  }

  // Statements that need no result are called with .all(), never .run(), and that is
  // deliberate: node:sqlite converts a statement's lastInsertRowid to a Number and
  // throws RangeError when it exceeds MAX_SAFE_INTEGER. FTS5's shadow tables move
  // that value to arbitrary 64-bit numbers while a contentless delete runs, so a
  // single `DELETE FROM search_fts` is enough to make the *next* .run() throw — here
  // or in any other store sharing the connection. Measured: it surfaces as a
  // RangeError from a DELETE that had already executed, i.e. the operation fails
  // while having done its work. .all() never reports lastInsertRowid, so it cannot
  // hit this; RETURNING is not an option on the virtual table itself ("DELETE
  // RETURNING is not available on virtual tables").
  const findChunk = db.prepare('SELECT id, content_hash FROM search_chunk WHERE scope = ? AND ref_id = ? AND ord = ?');
  const insertChunk = db.prepare(`INSERT INTO search_chunk (scope, ref_id, ord, item_id, kind, dir_id, text, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
  const updateChunk = db.prepare(`UPDATE search_chunk SET item_id = ?, kind = ?, dir_id = ?, text = ?, content_hash = ?, updated_at = ?
    WHERE id = ?`);
  const upsertPostings = db.prepare('INSERT OR REPLACE INTO search_fts(rowid, tokens) VALUES (?, ?)');
  const deletePostings = db.prepare('DELETE FROM search_fts WHERE rowid = ?');
  const deleteChunk = db.prepare('DELETE FROM search_chunk WHERE id = ?');
  // A ref that produced no chunks still needs to be remembered, or every sweep
  // re-reads its file to rediscover that it has nothing to index. Measured on the
  // real corpus: 78 such sessions holding 124MB of tool-heavy JSONL, re-read and
  // re-parsed on every sweep. The marker is keyed by ref and holds its mtime, the
  // same signal the chunk fast path uses. `ref:` keeps it clear of the schema keys.
  const readMarkerStmt = db.prepare('SELECT value FROM search_meta WHERE key = ?');
  const writeMarkerStmt = db.prepare('INSERT OR REPLACE INTO search_meta(key, value) VALUES (?, ?)');
  const dropMarkerStmt = db.prepare('DELETE FROM search_meta WHERE key = ? RETURNING key');
  const countMarkersStmt = db.prepare('SELECT count(*) AS n FROM search_meta WHERE substr(key, 1, ?) = ?');
  function markerKey(scope, refId) { return `${MARKER_PREFIX}${scope}:${refId}`; }
  function readMarker(scope, refId) {
    const row = readMarkerStmt.get(markerKey(scope, refId));
    return row ? String(row.value) : null;
  }
  function writeMarker(scope, refId, value) { writeMarkerStmt.all(markerKey(scope, refId), String(value)); }
  // `substr` rather than `LIKE`: the key embeds a caller-supplied ref, and `_`/`%`
  // in it would otherwise be wildcards.
  const listMarkersStmt = db.prepare('SELECT key FROM search_meta WHERE substr(key, 1, ?) = ? ORDER BY key');
  function listMarkers(scope) {
    const prefix = markerKey(scope, '');
    return listMarkersStmt.all(prefix.length, prefix).map(row => String(row.key).slice(prefix.length));
  }
  function dropMarkers(scope, refIds) {
    if (!refIds.length) return 0;
    let dropped = 0;
    for (const refId of refIds) dropped += dropMarkerStmt.all(markerKey(scope, refId)).length;
    return dropped;
  }
  const chunkIdsOfRef = db.prepare('SELECT id FROM search_chunk WHERE scope = ? AND ref_id = ?');
  const tailIdsOfRef = db.prepare('SELECT id FROM search_chunk WHERE scope = ? AND ref_id = ? AND ord > ?');
  const refList = db.prepare(`SELECT ref_id AS refId, count(*) AS chunks, max(updated_at) AS updatedAt
    FROM search_chunk WHERE scope = ? GROUP BY ref_id ORDER BY ref_id`);
  // `chars` is a character count and `bytes` is the UTF-8 size of the same text.
  // Both are reported because they differ by ~3x on Chinese text, and only `bytes`
  // is comparable against the database size that `volume` prints.
  const statsByScope = db.prepare(`SELECT scope, count(*) AS chunks, count(DISTINCT ref_id) AS refs,
    sum(length(text)) AS chars, sum(length(CAST(text AS BLOB))) AS bytes
    FROM search_chunk GROUP BY scope ORDER BY scope`);

  // Unchanged text is skipped rather than rewritten: the sync layer re-pushes a
  // session's chunks whenever that session changes, and only the tail chunk of a
  // growing message actually differs. Same content hash ⇒ the postings are already
  // right, so the write is a no-op.
  const upsertRows = db.transaction(rows => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const raw of rows) {
      const row = normalizeRow(raw);
      if (!row) { skipped += 1; continue; }
      const hash = hashOf(row.text);
      const existing = findChunk.get(row.scope, row.refId, row.ord);
      if (existing && existing.content_hash === hash) { skipped += 1; continue; }
      let id;
      if (existing) {
        id = Number(existing.id);
        updateChunk.all(row.itemId, row.kind, row.dirId, row.text, hash, row.updatedAt, id);
        updated += 1;
      } else {
        const created = insertChunk.get(row.scope, row.refId, row.ord, row.itemId, row.kind, row.dirId, row.text, hash, row.updatedAt);
        id = Number(created.id);
        inserted += 1;
      }
      const tokens = indexTokens(row.text).join(' ');
      // A chunk with no indexable token (punctuation only, a lone character) still
      // belongs in search_chunk — a LIKE query has to be able to reach it.
      if (tokens) upsertPostings.all(id, tokens);
      else deletePostings.all(id);
    }
    return { inserted, updated, skipped };
  });

  function upsert(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { inserted: 0, updated: 0, skipped: 0 };
    return upsertRows(list);
  }

  // Dropping a whole sync unit (a deleted session) is one statement per chunk, and
  // the postings must go with them: deleting from search_chunk does not reach a
  // contentless FTS row.
  const removeRefsTxn = db.transaction((scope, refIds) => {
    let removed = 0;
    for (const refId of refIds) {
      for (const row of chunkIdsOfRef.all(scope, refId)) {
        deletePostings.all(row.id);
        deleteChunk.all(row.id);
        removed += 1;
      }
    }
    return removed;
  });

  function removeRefs(scope, refIds) {
    const list = (Array.isArray(refIds) ? refIds : []).map(String).filter(Boolean);
    if (!list.length) return 0;
    return removeRefsTxn(String(scope), list);
  }

  // Drop a unit's chunks past `maxOrd`. A source that shrank (a pruned or edited
  // transcript) would otherwise keep answering with text that no longer exists —
  // its stale tail is never overwritten by an upsert, only left behind.
  const pruneRefTxn = db.transaction((scope, refId, maxOrd) => {
    let removed = 0;
    for (const row of tailIdsOfRef.all(scope, refId, Math.floor(maxOrd))) {
      deletePostings.all(row.id);
      deleteChunk.all(row.id);
      removed += 1;
    }
    return removed;
  });

  function pruneRef(scope, refId, maxOrd) {
    const id = String(refId || '');
    if (!id) return 0;
    return pruneRefTxn(String(scope), id, Number(maxOrd));
  }

  function listRefs(scope) {
    return refList.all(String(scope)).map(row => ({
      refId: row.refId,
      chunks: Number(row.chunks) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    }));
  }

  // Filters shared by both query modes. Every value is bound, never interpolated;
  // only the *shape* of the clause list is interpolated, from a fixed set of
  // fragments, and that shape is what caches the prepared statement.
  function filtersFor({ kinds, dirId, refIds, excludeRefIds }) {
    const clauses = [];
    const params = [];
    const inClause = (column, values, negate) => {
      clauses.push(`${column} ${negate ? 'NOT IN' : 'IN'} (${values.map(() => '?').join(',')})`);
      params.push(...values);
    };
    const kindsList = (Array.isArray(kinds) ? kinds : []).map(String).filter(Boolean);
    if (kindsList.length) inClause('c.kind', kindsList);
    if (dirId) { clauses.push('c.dir_id = ?'); params.push(String(dirId)); }
    const ids = (Array.isArray(refIds) ? refIds : []).map(String).filter(Boolean);
    if (ids.length) inClause('c.ref_id', ids);
    const excluded = (Array.isArray(excludeRefIds) ? excludeRefIds : []).map(String).filter(Boolean);
    if (excluded.length) inClause('c.ref_id', excluded, true);
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
  }

  const stmtCache = new Map();
  function prepared(template, filterSql) {
    const sql = template.replace('__FILTERS__', filterSql);
    let stmt = stmtCache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); stmtCache.set(sql, stmt); }
    return stmt;
  }

  function search(options = {}) {
    const raw = String(options.text == null ? '' : options.text).trim();
    const scope = String(options.scope || '').trim();
    if (!scope) throw new TypeError('search index requires a scope');
    if (!raw) return { mode: 'empty', terms: [], results: [] };
    if (raw.length > MAX_QUERY_CHARS) return { mode: 'rejected', terms: [], results: [] };
    const limit = clampLimit(options.limit);
    const filters = filtersFor(options);
    const terms = highlightTerms(raw);
    const expression = matchExpression(raw);

    if (expression) {
      // bm25() is negative and lower is better; we flip it so callers read "bigger
      // is better", the same direction as the board's scores.
      const rows = prepared(MATCH_SQL, filters.sql).all(expression, scope, ...filters.params, limit);
      return {
        mode: 'fts',
        terms,
        results: rows.map(row => ({
          scope: row.scope,
          refId: row.refId,
          ord: Number(row.ord) || 0,
          itemId: row.itemId,
          kind: row.kind,
          dirId: row.dirId,
          updatedAt: Number(row.updatedAt) || 0,
          score: Math.round(-Number(row.rank) * 1000) / 1000,
          text: row.text,
          snippet: buildSnippet(row.text, terms),
        })),
      };
    }

    const rows = prepared(LIKE_SQL, filters.sql).all(scope, `%${escapeLike(raw)}%`, ...filters.params, limit);
    const needle = raw.toLowerCase();
    return {
      mode: 'like',
      terms,
      results: rows.map(row => {
        const body = String(row.text);
        const haystack = body.toLowerCase();
        let occurrences = 0;
        let at = haystack.indexOf(needle);
        while (at >= 0) { occurrences += 1; at = haystack.indexOf(needle, at + needle.length); }
        return {
          scope: row.scope,
          refId: row.refId,
          ord: Number(row.ord) || 0,
          itemId: row.itemId,
          kind: row.kind,
          dirId: row.dirId,
          updatedAt: Number(row.updatedAt) || 0,
          // No bm25 for a substring scan: rank by how often the substring occurs,
          // breaking ties toward the less diluted (shorter) chunk.
          score: Math.round((occurrences * 100 + 10000 / (body.length + 100)) * 1000) / 1000,
          text: body,
          snippet: buildSnippet(body, terms),
        };
      }).sort((a, b) => b.score - a.score),
    };
  }

  function stats() {
    let bytes = 0;
    let pageSize = 0;
    try {
      pageSize = Number(db.pragma('page_size', { simple: true })) || 0;
      bytes = (Number(db.pragma('page_count', { simple: true })) || 0) * pageSize;
    } catch (error) { /* stats are best-effort */ }
    return {
      available: true,
      dbFile,
      bytes,
      pageSize,
      tokenizer: `${TOKENIZER_SIGNATURE}|${TOKENIZE_OPTION}`,
      // Counted by prefix rather than by scope: this module must not know the name
      // of any scope, because the corpus that owns 'message' requires this one.
      emptyRefs: Number(countMarkersStmt.get(MARKER_PREFIX.length, MARKER_PREFIX)?.n) || 0,
      scopes: statsByScope.all().map(row => ({
        scope: row.scope,
        chunks: Number(row.chunks) || 0,
        refs: Number(row.refs) || 0,
        chars: Number(row.chars) || 0,
        bytes: Number(row.bytes) || 0,
      })),
    };
  }

  return Object.freeze({
    available: true,
    reason: '',
    dbFile,
    upsert,
    removeRefs,
    pruneRef,
    readMarker,
    writeMarker,
    listMarkers,
    dropMarkers,
    listRefs,
    search,
    stats,
    close: () => { try { db.close(); } catch (error) { /* closing twice is fine */ } },
  });
}

module.exports = {
  DEFAULT_LIMIT,
  LIKE_SQL,
  MATCH_SQL,
  MAX_LIMIT,
  MAX_QUERY_CHARS,
  SCHEMA_VERSION,
  TOKENIZER_SIGNATURE,
  TOKENIZE_OPTION,
  buildSnippet,
  createSearchIndex,
  escapeLike,
  hashOf,
  highlightTerms,
  probeFts5,
};

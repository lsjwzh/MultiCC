'use strict';

const fs = require('node:fs');
const { hashOf } = require('./index-store');

// Turns chat history into indexable chunks — the corpus side of the message index.
//
// Only the conversation itself is indexed: a message's `content` string, nothing
// else. The same rows carry `tools` (full tool inputs *and* results, by far the
// largest field), `usage`, `cost`, `turnTimings` and the task-attribution metadata;
// none of it is read here, deliberately. Tool output is machine noise that would
// swamp a relevance ranking (it is where most of the 1.2GB lives), and the
// attribution fields already have their own index in the board.
//
// `system` messages are excluded too: they are the harness's own instructions and
// notices, not something the user wrote or read.
//
// Chunks are 400 characters with 60 of overlap, so a term landing exactly on a
// boundary is still inside one whole chunk. Duplicate chunks within a session are
// dropped — a resent message or a copied quote would otherwise return twice as
// several separate hits.

const MESSAGE_SCOPE = 'message';
const CHUNK_CHARS = 400;
const CHUNK_OVERLAP = 60;
// Deliberately low. The floor exists to drop acknowledgements and punctuation
// ("好的" / "继续" / "—"), not to require length: Chinese is dense enough that a
// nine-character message is a complete question, and that question is exactly the
// kind of thing someone later searches for.
const MIN_CHUNK_CHARS = 6;
const INDEXED_ROLES = new Set(['user', 'assistant']);
// Synthetic session ids that hold harness traffic rather than a conversation.
const SYNTHETIC_SESSION_IDS = new Set(['__aux__', '__gateway__']);

function isSearchableSession(sessionId) {
  const id = String(sessionId || '');
  return !!id && !SYNTHETIC_SESSION_IDS.has(id) && !id.includes('__aux__');
}

// A message's indexable text: the conversation body, or '' for anything else.
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (!INDEXED_ROLES.has(message.role)) return '';
  return typeof message.content === 'string' ? message.content : '';
}

// Fixed-window chunks with overlap. A piece shorter than MIN_CHUNK_CHARS is
// dropped here rather than by the caller: it is an acknowledgement, not content.
function chunkText(text) {
  const body = String(text == null ? '' : text);
  const pieces = [];
  if (!body) return pieces;
  const step = CHUNK_CHARS - CHUNK_OVERLAP;
  for (let start = 0; start < body.length; start += step) {
    const piece = body.slice(start, start + CHUNK_CHARS);
    if (piece.trim().length >= MIN_CHUNK_CHARS) pieces.push(piece);
    if (start + CHUNK_CHARS >= body.length) break;
  }
  return pieces;
}

// Rows for one session, ready for index.upsert().
//
// `ord` counts every chunk *candidate* rather than every stored one, so dropping a
// duplicate (or a too-short tail) cannot renumber the chunks after it: renumbering
// would invalidate their content hashes and turn the next incremental sync into a
// full rewrite of the session. `candidates` is the resulting high-water mark, which
// the caller hands back as the prune bound.
//
// `updatedAt` is the history file's mtime, not the message's timestamp. It is what
// the sync fast-path compares against, and it moves exactly when the file changes.
function sessionChunkRows(sessionId, messages, { updatedAt = 0 } = {}) {
  const rows = [];
  const seen = new Set();
  let cursor = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageText(message);
    if (!text) continue;
    const itemId = String(message.id || message.messageId || '');
    for (const piece of chunkText(text)) {
      const ord = cursor;
      cursor += 1;
      const hash = hashOf(piece);
      if (seen.has(hash)) continue;
      seen.add(hash);
      rows.push({
        scope: MESSAGE_SCOPE,
        refId: String(sessionId),
        ord,
        itemId,
        kind: message.role,
        dirId: '',
        text: piece,
        updatedAt,
      });
    }
  }
  return { rows, candidates: cursor };
}

// The sync layer: walks chat_history and keeps the index in step.
//
// It is incremental in two directions. Per session, the file's mtime is compared
// with what the index already records for that session — an unchanged file is
// skipped without being read or parsed at all, which is what makes a sync over
// hundreds of sessions cheap. Per chunk, unchanged text is skipped by content
// hash, so appending one turn rewrites only that turn's chunks.
//
// mtime equality is treated as proof of identical content: every write path for
// these files touches the file when it changes anything (append or full rewrite).
function createMessageCorpus({ index, history, fsImpl = fs, logger = console, now = Date.now } = {}) {
  if (!index || typeof index.upsert !== 'function') throw new TypeError('message corpus requires a search index');
  if (!history || typeof history.listSessionIds !== 'function') throw new TypeError('message corpus requires a chat history repository');

  function mtimeOf(sessionId) {
    try {
      return Math.floor(fsImpl.statSync(history.fileFor(sessionId)).mtimeMs);
    } catch (error) {
      // A vanished file is not an error here: the caller treats it as "nothing to
      // index" and the ref gets removed on the next sweep.
      return 0;
    }
  }

  // An empty sweep means one of two worlds, and they call for opposite actions: a
  // directory with no history because it is the wrong one (or one that was just
  // moved), where pruning would silently empty the whole index; or a history root
  // that really is empty because every session was deleted, where pruning is right.
  // The discriminator is whether the root exists at all — `listSessionIds` returns
  // [] for both, but only the wrong directory is missing.
  function historyRootMissing() {
    const root = history.root;
    if (!root || typeof fsImpl.existsSync !== 'function') return false;
    try { return !fsImpl.existsSync(root); } catch (error) { return true; }
  }

  // Refs this sweep marked as content-less whose session no longer exists. Nothing
  // else revisits a marker, so without this they accumulate for the life of the index.
  function deadMarkers(live) {
    if (typeof index.listMarkers !== 'function') return [];
    return index.listMarkers(MESSAGE_SCOPE).filter(refId => !live.has(refId));
  }

  // The sessions this corpus is willing to index, in history order. Exposed
  // because a caller that syncs in slices (so a cold build does not block the
  // event loop for seconds) must enumerate exactly the same set a sweep would.
  function listSessions() {
    return (typeof history.listSessionIds === 'function' ? history.listSessionIds() : [])
      .filter(isSearchableSession);
  }

  // `refs` lets a sweep hand in the ref list it already read: without it every
  // session in the sweep re-queries the whole ref table, which is O(sessions²).
  function syncSession(sessionId, { force = false, refs = null } = {}) {
    const id = String(sessionId || '');
    // The synthetic guard lives here rather than only in syncAll because a server
    // syncing one session on turn end calls straight into this function: without it
    // the gateway's own bookkeeping would become searchable conversation text.
    if (!id || !isSearchableSession(id) || !index.available) {
      return { sessionId: id, sessionSkipped: true, chunks: 0 };
    }
    const mtime = mtimeOf(id);
    if (!mtime) return { sessionId: id, sessionSkipped: true, chunks: 0 };
    if (!force) {
      const known = refs ? refs.get(id) : index.listRefs(MESSAGE_SCOPE).find(ref => ref.refId === id);
      // Equality, not `>=`: a file restored from backup with an older mtime must
      // still be re-read rather than trusted.
      //
      // The second condition covers the one window where mtimes cannot be told
      // apart: a write that landed in the same millisecond we are now in. The file
      // may have changed again since we indexed it, so that case re-reads instead of
      // trusting the comparison — it costs one parse and cannot loop.
      if (known && known.updatedAt === mtime && now() - mtime > 1) {
        return { sessionId: id, sessionSkipped: true, chunks: known.chunks };
      }
      // A session that produced no chunks has no ref row, so the fast path above can
      // never see it — the marker is the only memory that its emptiness was already
      // established, and without it those files are re-read and re-parsed forever.
      if (!known && index.readMarker(MESSAGE_SCOPE, id) === String(mtime) && now() - mtime > 1) {
        return { sessionId: id, sessionSkipped: true, chunks: 0 };
      }
    }
    // No wipe before re-pushing: the per-chunk content hash is what keeps this
    // incremental. Clearing the ref first would invalidate every hash and rewrite
    // the whole session on every turn.
    const messages = history.read(id);
    const { rows, candidates } = sessionChunkRows(id, messages, { updatedAt: mtime });
    const written = index.upsert(rows);
    // Only the tail beyond what the re-parse produced is stale — that is where a
    // shortened transcript's leftovers live.
    const pruned = index.pruneRef(MESSAGE_SCOPE, id, candidates - 1);
    if (rows.length) index.dropMarkers(MESSAGE_SCOPE, [id]);
    else index.writeMarker(MESSAGE_SCOPE, id, mtime);
    // `sessionSkipped` says whether the file was read; `skipped` (inside `written`)
    // counts chunks the content hash let us leave alone. Different questions.
    return { sessionId: id, sessionSkipped: false, chunks: rows.length, pruned, ...written };
  }

  // One sweep. Sessions the index still holds but chat_history no longer has are
  // dropped, so a deleted conversation stops being searchable.
  function syncAll({ force = false } = {}) {
    const started = now();
    const ids = listSessions();
    const live = new Set(ids);
    let synced = 0;
    let skipped = 0;
    let chunks = 0;
    const known = index.listRefs(MESSAGE_SCOPE);
    const refs = new Map(known.map(ref => [ref.refId, ref]));
    for (const id of ids) {
      const result = syncSession(id, { force, refs });
      if (result.sessionSkipped) skipped += 1;
      else { synced += 1; chunks += result.chunks || 0; }
    }
    const emptySweep = !force && ids.length === 0 && known.length > 0 && historyRootMissing();
    const stale = emptySweep ? [] : known.map(ref => ref.refId).filter(refId => !live.has(refId));
    let removed = 0;
    // A marker outlives the chunks it was written for, so every session that lost its
    // ref loses its marker in the same sweep — otherwise markers pile up for the life
    // of the index, since nothing else ever revisits one. Skipped on an empty sweep for
    // the same reason the chunks are: `live` being empty there says nothing about which
    // sessions actually died.
    if (!emptySweep) index.dropMarkers(MESSAGE_SCOPE, deadMarkers(live));
    if (stale.length) removed = index.removeRefs(MESSAGE_SCOPE, stale);
    const summary = { sessions: ids.length, synced, skipped, chunks, removedRefs: stale.length, removedChunks: removed, tookMs: now() - started };
    if (emptySweep) {
      summary.pruneSkipped = known.length;
      summary.pruneSkippedReason = 'no-sources-discovered';
      logger?.warn?.(`search_index_prune_skipped: 0 个来源被发现，保留已有的 ${known.length} 个来源（确认要清空请加 --force）`);
    }
    logger?.log?.(`search_index_sync: ${JSON.stringify(summary)}`);
    return summary;
  }

  return Object.freeze({
    listSessions,
    syncAll,
    syncSession,
    search: options => index.search({ ...options, scope: MESSAGE_SCOPE }),
    stats: () => index.stats(),
  });
}

module.exports = {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  INDEXED_ROLES,
  MESSAGE_SCOPE,
  MIN_CHUNK_CHARS,
  SYNTHETIC_SESSION_IDS,
  chunkText,
  createMessageCorpus,
  isSearchableSession,
  messageText,
  sessionChunkRows,
};

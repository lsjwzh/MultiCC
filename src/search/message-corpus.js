'use strict';

const crypto = require('node:crypto');
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
//
// A chunk never spans two messages: `chunkText` runs inside the per-message loop,
// so every chunk belongs to exactly one message line. That is what lets a chunk
// carry that message's own `taskId` and `ts` — and a chunk is only ever written
// from a message, never from a concatenation of several.

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

// Resume state for the streaming sync, kept as markers under its own scope so it can
// never be mistaken for the emptiness marker above.
const TAIL_SCOPE = 'message-tail';
const TAIL_STATE_VERSION = 1;
// One read, one parse, one yield. 512KB of JSONL is a few milliseconds of JSON.parse,
// which is the longest the event loop is held between two resumable points.
const BLOCK_BYTES = 512 * 1024;
// How many trailing messages are re-read on every resume. A streaming reply is saved
// as an interim line and later truncated away and rewritten (see appendAt in the
// chat-history repository), so the last line can legitimately change after it was
// indexed; re-reading a few lines absorbs that without falling back to a full pass.
const LAG_LINES = 3;
// The resume point is trusted only if the bytes around it are the ones indexed: the
// head of the file plus the stretch just before the resume offset. Anything that
// inserts or removes bytes ahead of the offset (a deleted message, a rewritten
// transcript) moves that stretch and forces a full pass. What this cannot see is an
// edit of exactly the same length far from the end; FULL_RECHECK_MS covers that.
// The digest is taken twice per pass (to verify, then for the new resume point), so
// the window is kept small.
const HEAD_BYTES = 4096;
const WINDOW_BYTES = 16 * 1024;
// Belt and braces: even a state that keeps verifying is rebuilt from scratch this
// often, which also retires any duplicate the incremental dedupe could have missed.
const FULL_RECHECK_MS = 24 * 60 * 60 * 1000;

function isSearchableSession(sessionId) {
  const id = String(sessionId || '');
  return !!id && !SYNTHETIC_SESSION_IDS.has(id) && !id.includes('__aux__');
}

// A stored message's own time, in epoch milliseconds, or 0 when it has none.
// Real transcripts carry `ts` on every line (measured 189/189), either as a number
// or as an ISO string; anything unparseable answers 0 and the caller falls back to
// the history file's mtime, so ordering never collapses to 0.
function messageTime(message) {
  const raw = message && typeof message === 'object' ? message.ts : null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  return 0;
}

// A message's task attribution, or '' when it has none (the field is set by
// annotateTurn after the turn finishes, so older lines may lack it).
function messageTaskId(message) {
  if (!message || typeof message !== 'object') return '';
  const id = message.taskId;
  return typeof id === 'string' ? id : (typeof id === 'number' && Number.isFinite(id) ? String(id) : '');
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
// `updatedAt` is the history file's mtime and is only a fallback: a message with a
// `ts` stores that instead, because the mtime of the file is one value shared by
// every chunk in the session and says nothing about when a message was written.
// `sourceMtime` always carries the file mtime, which is what the sync fast-path
// compares against (see listRefs in ./index-store.js), so freshness and message
// time are separate signals and neither is derived from the other.
function sessionChunkRows(sessionId, messages, { updatedAt = 0, dirId = '' } = {}) {
  const rows = [];
  const seen = new Set();
  let cursor = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageText(message);
    if (!text) continue;
    const itemId = String(message.id || message.messageId || '');
    const taskId = messageTaskId(message);
    const messageTs = messageTime(message);
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
        dirId,
        taskId,
        text: piece,
        updatedAt: messageTs || updatedAt,
        sourceMtime: updatedAt,
      });
    }
  }
  return { rows, candidates: cursor };
}

// The sync layer: walks chat_history and keeps the index in step.
//
// It is incremental in three directions.
//   * Per session, the file's mtime is compared with what the index already records
//     for it — an unchanged file is skipped without being opened.
//   * Per file, chat_history is append-only JSONL, so a changed file is not re-read:
//     the sync remembers the byte offset (and chunk ordinal) it reached and the next
//     one parses only what was appended after it. A transcript that was cut, edited
//     or replaced fails the check on the bytes around that offset and is rebuilt from
//     the start instead. A 100MB conversation that gained one turn costs one turn.
//   * Per chunk, unchanged text is skipped by content hash.
//
// Every pass is a generator that yields at each block of a file and after each
// session. Driven synchronously (`syncSession`, `syncAll`) it runs straight through;
// driven by a slice runner (src/search/slice-runner.js) it can be paused anywhere, so
// no single call holds the event loop for more than one block.
//
// mtime equality is treated as proof of identical content: every write path for
// these files touches the file when it changes anything (append or full rewrite).
// `resolveDirId(sessionId)` is the host's answer to "which project directory does
// this conversation belong to". chat_history does not record it (the mapping lives
// in the session records), so the corpus cannot derive it — without the callback
// every chunk stores '' and a directory filter simply matches nothing. An empty
// answer means "unknown" and never clears a value the index already has.
function createMessageCorpus({
  index, history, fsImpl = fs, logger = console, now = Date.now, blockBytes = BLOCK_BYTES,
  resolveDirId = null,
} = {}) {
  if (!index || typeof index.upsert !== 'function') throw new TypeError('message corpus requires a search index');
  if (!history || typeof history.listSessionIds !== 'function') throw new TypeError('message corpus requires a chat history repository');

  const canStream = typeof history.fileFor === 'function'
    && ['openSync', 'readSync', 'closeSync', 'fstatSync'].every(name => typeof fsImpl[name] === 'function');
  const block = Math.max(1, Math.floor(Number(blockBytes)) || BLOCK_BYTES);

  function dirOf(sessionId) {
    if (typeof resolveDirId !== 'function') return '';
    try { return String(resolveDirId(sessionId) || ''); } catch (error) { return ''; }
  }

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
  function deadMarkers(live, scope = MESSAGE_SCOPE) {
    if (typeof index.listMarkers !== 'function') return [];
    return index.listMarkers(scope).filter(refId => !live.has(refId));
  }

  // The sessions this corpus is willing to index, in history order. Exposed
  // because a caller that syncs in slices (so a cold build does not block the
  // event loop for seconds) must enumerate exactly the same set a sweep would.
  function listSessions() {
    return (typeof history.listSessionIds === 'function' ? history.listSessionIds() : [])
      .filter(isSearchableSession);
  }

  function drain(generator) {
    for (;;) {
      const step = generator.next();
      if (step.done) return step.value;
    }
  }

  // ── resume state ──────────────────────────────────────────────────────────
  function readTail(id) {
    if (typeof index.readMarker !== 'function') return null;
    let state;
    try {
      const raw = index.readMarker(TAIL_SCOPE, id);
      state = raw ? JSON.parse(raw) : null;
    } catch (error) { return null; }
    if (!state || state.v !== TAIL_STATE_VERSION || typeof state.win !== 'string') return null;
    for (const key of ['off', 'ord', 'at', 'full']) {
      if (!Number.isSafeInteger(state[key]) || state[key] < 0) return null;
    }
    return state;
  }

  function readFully(fd, buffer, length, position) {
    let got = 0;
    while (got < length) {
      const n = fsImpl.readSync(fd, buffer, got, length - got, position + got);
      if (n <= 0) break;
      got += n;
    }
    return got;
  }

  // Fingerprint of the bytes the resume offset stands on. Cheap (<=20KB of reads), and
  // it is what makes "append-only" something we check rather than something we assume.
  function windowDigest(fd, offset) {
    const hash = crypto.createHash('sha1');
    const head = Math.min(HEAD_BYTES, offset);
    const tailStart = Math.max(0, offset - WINDOW_BYTES);
    const tailLength = offset - tailStart;
    const buffer = Buffer.allocUnsafe(Math.max(head, tailLength, 1));
    hash.update(buffer.subarray(0, readFully(fd, buffer, head, 0)));
    hash.update(buffer.subarray(0, readFully(fd, buffer, tailLength, tailStart)));
    return hash.digest('hex').slice(0, 16);
  }

  // The pre-JSONL format is one JSON array over the whole file; it cannot be parsed
  // line by line, so it takes the whole-file path below.
  function looksLikeArray(fd) {
    const probe = Buffer.allocUnsafe(64);
    const n = readFully(fd, probe, probe.length, 0);
    let i = n >= 3 && probe[0] === 0xEF && probe[1] === 0xBB && probe[2] === 0xBF ? 3 : 0;
    while (i < n && (probe[i] === 0x20 || probe[i] === 0x0A || probe[i] === 0x0D || probe[i] === 0x09)) i += 1;
    return i < n && probe[i] === 0x5B;
  }

  // The original whole-file pass, kept for what cannot be streamed: the legacy array
  // format, or a filesystem handle without positional reads.
  function syncWhole(id, mtime, dirId) {
    // No wipe before re-pushing: the per-chunk content hash is what keeps this
    // incremental. Clearing the ref first would invalidate every hash and rewrite
    // the whole session on every turn.
    const messages = history.read(id);
    const { rows, candidates } = sessionChunkRows(id, messages, { updatedAt: mtime, dirId });
    const written = index.upsert(rows);
    // Only the tail beyond what the re-parse produced is stale — that is where a
    // shortened transcript's leftovers live.
    const pruned = index.pruneRef(MESSAGE_SCOPE, id, candidates - 1);
    if (rows.length) index.dropMarkers(MESSAGE_SCOPE, [id]);
    else index.writeMarker(MESSAGE_SCOPE, id, mtime);
    // No streaming state describes this file, and a stale one must not survive it.
    index.dropMarkers(TAIL_SCOPE, [id]);
    // `sessionSkipped` says whether the file was read; `skipped` (inside `written`)
    // counts chunks the content hash let us leave alone. Different questions.
    return { sessionId: id, sessionSkipped: false, chunks: rows.length, pruned, ...written };
  }

  // `refs` lets a sweep hand in the ref list it already read: without it every
  // session in the sweep re-queries the whole ref table, which is O(sessions²).
  //
  // `quietMs` leaves a file alone while it is still being written (its mtime is that
  // recent): the turn-end nudge and the next sweep pick it up once it settles.
  // `maxBytes` refuses a pass that would have to read more than that many bytes and
  // answers `deferred: true` instead, for callers that must stay cheap and can hand
  // the real work to a background job.
  function* syncSessionSteps(sessionId, { force = false, refs = null, quietMs = 0, maxBytes = Infinity } = {}) {
    const id = String(sessionId || '');
    const skipped = (extra = {}) => ({ sessionId: id, sessionSkipped: true, chunks: 0, ...extra });
    // The synthetic guard lives here rather than only in syncAll because a server
    // syncing one session on turn end calls straight into this function: without it
    // the gateway's own bookkeeping would become searchable conversation text.
    if (!id || !isSearchableSession(id) || !index.available) return skipped();
    const mtime = mtimeOf(id);
    if (!mtime) return skipped();
    const known = refs ? refs.get(id) : index.listRefs(MESSAGE_SCOPE).find(ref => ref.refId === id);
    // The host answers '' when it does not know (a session record that is gone, a
    // lookup that failed). '' is "unknown", not "no directory": with `force` the
    // whole file is re-parsed and writing '' would erase an attribution the index
    // already has, so the previous answer is kept instead.
    const resolvedDirId = dirOf(id);
    const dirId = resolvedDirId || (known && known.dirId) || '';
    const tail = force ? null : readTail(id);
    if (!force) {
      const chunks = known ? known.chunks : 0;
      // A relocated session keeps its transcript, so its chunks are skipped for
      // being unchanged and would keep answering under the old directory. The
      // correction is one UPDATE per moved session, not a re-read of the file.
      if (known && resolvedDirId && known.dirId !== resolvedDirId && typeof index.updateRefDirId === 'function') {
        index.updateRefDirId(MESSAGE_SCOPE, id, resolvedDirId);
        known.dirId = resolvedDirId;
      }
      // Equality, not `>=`: a file restored from backup with an older mtime must
      // still be re-read rather than trusted.
      //
      // The `settled` condition covers the one window where mtimes cannot be told
      // apart: a write that landed in the same millisecond we are now in. The file
      // may have changed again since we indexed it, so that case re-reads instead of
      // trusting the comparison — it costs one parse and cannot loop.
      const settled = now() - mtime > 1;
      if (known && known.updatedAt === mtime && settled) return skipped({ chunks });
      // A session that produced no chunks has no ref row, so the fast path above can
      // never see it — the marker is the only memory that its emptiness was already
      // established, and without it those files are re-read and re-parsed forever.
      if (!known && index.readMarker(MESSAGE_SCOPE, id) === String(mtime) && settled) return skipped();
      // `updated_at` only moves when a chunk's text does, so a session that gained
      // nothing but tool output never matches the check above. The streaming state
      // carries the mtime it last saw, which closes that gap.
      if (tail && tail.at === mtime && settled) return skipped({ chunks });
      if (quietMs > 0 && now() - mtime < quietMs) return skipped({ chunks, hot: true });
    }
    if (!canStream) return syncWhole(id, mtime, dirId);

    let fd;
    try {
      fd = fsImpl.openSync(history.fileFor(id), 'r');
    } catch (error) {
      if (error && error.code === 'ENOENT') return skipped();
      throw error;
    }
    try {
      const size = fsImpl.fstatSync(fd).size;
      let start = 0;
      let ord = 0;
      let fullAt = now();
      let incremental = false;
      if (tail && tail.off > 0 && size >= tail.off && typeof index.hashesBefore === 'function'
          && now() - tail.full < FULL_RECHECK_MS && windowDigest(fd, tail.off) === tail.win) {
        start = tail.off;
        ord = tail.ord;
        fullAt = tail.full;
        incremental = true;
      }
      if (!incremental && looksLikeArray(fd)) return syncWhole(id, mtime, dirId);
      if (size - start > maxBytes) return skipped({ deferred: true });

      // Seed the duplicate filter with what is already stored below the resume
      // ordinal, so the chunks added now are deduplicated exactly as a pass from the
      // start would have deduplicated them.
      const seen = new Set(incremental ? index.hashesBefore(MESSAGE_SCOPE, id, ord) : []);
      const totals = { inserted: 0, updated: 0, skipped: 0 };
      const ring = [];
      let rows = [];
      let emitted = 0;
      let cursor = ord;
      let lineStart = start;

      const flush = () => {
        if (!rows.length) return;
        const written = index.upsert(rows);
        totals.inserted += written.inserted || 0;
        totals.updated += written.updated || 0;
        totals.skipped += written.skipped || 0;
        emitted += rows.length;
        rows = [];
      };
      const handleLine = (bytes, offset) => {
        if (!bytes.length) return;
        let text = bytes.toString('utf8');
        if (offset === 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        let message;
        // The index is derived data: a line that does not parse is skipped, not fatal.
        // (A torn final line from a crashed append is the usual case, and it is
        // re-read next time because the resume point never moves past it.)
        try { message = JSON.parse(text); } catch (error) { return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        ring.push({ start: offset, cursor });
        if (ring.length > LAG_LINES) ring.shift();
        const body = messageText(message);
        if (!body) return;
        const itemId = String(message.id || message.messageId || '');
        const taskId = messageTaskId(message);
        const messageTs = messageTime(message);
        for (const piece of chunkText(body)) {
          const pieceOrd = cursor;
          cursor += 1;
          const hash = hashOf(piece);
          if (seen.has(hash)) continue;
          seen.add(hash);
          rows.push({
            scope: MESSAGE_SCOPE,
            refId: id,
            ord: pieceOrd,
            itemId,
            kind: message.role,
            dirId,
            taskId,
            text: piece,
            updatedAt: messageTs || mtime,
            sourceMtime: mtime,
          });
        }
      };

      const buffer = Buffer.allocUnsafe(Math.min(block, Math.max(1, size - start)));
      let parts = [];
      let position = start;
      while (position < size) {
        const got = fsImpl.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
        if (got <= 0) break;
        position += got;
        const data = buffer.subarray(0, got);
        let from = 0;
        for (let nl = data.indexOf(10, from); nl !== -1; nl = data.indexOf(10, from)) {
          const line = parts.length ? Buffer.concat([...parts, data.subarray(from, nl)]) : data.subarray(from, nl);
          parts = [];
          handleLine(line, lineStart);
          lineStart += line.length + 1;
          from = nl + 1;
        }
        // The block buffer is reused, so a partial line has to be copied out of it.
        if (from < data.length) parts.push(Buffer.from(data.subarray(from)));
        flush();
        if (position < size) yield;
      }
      // An unterminated last line is indexed only if it parses: a half-written append
      // does not, and the resume point stays in front of it either way.
      if (parts.length) handleLine(Buffer.concat(parts), lineStart);
      flush();

      const pruned = index.pruneRef(MESSAGE_SCOPE, id, cursor - 1);
      if (seen.size) index.dropMarkers(MESSAGE_SCOPE, [id]);
      else index.writeMarker(MESSAGE_SCOPE, id, mtime);
      // Resume a few messages back, not at the end (see LAG_LINES).
      const resume = ring.length ? ring[0] : { start, cursor: ord };
      index.writeMarker(TAIL_SCOPE, id, JSON.stringify({
        v: TAIL_STATE_VERSION,
        off: resume.start,
        ord: resume.cursor,
        win: resume.start > 0 ? windowDigest(fd, resume.start) : '',
        at: mtime,
        full: fullAt,
      }));
      return {
        sessionId: id, sessionSkipped: false, chunks: emitted, pruned, incremental, bytes: size - start, ...totals,
      };
    } finally {
      try { fsImpl.closeSync(fd); } catch (error) { /* already closed */ }
    }
  }

  function syncSession(sessionId, options) {
    return drain(syncSessionSteps(sessionId, options));
  }

  // Drop what the index still holds for sessions chat_history no longer has, so a
  // deleted conversation stops being searchable. A sweep prunes once at its end.
  function pruneDead(ids, known, { force = false } = {}) {
    const live = new Set(ids);
    const emptySweep = !force && ids.length === 0 && known.length > 0 && historyRootMissing();
    const stale = emptySweep ? [] : known.map(ref => ref.refId).filter(refId => !live.has(refId));
    let removed = 0;
    // A marker outlives the chunks it was written for, so every session that lost its
    // ref loses its marker in the same sweep — otherwise markers pile up for the life
    // of the index, since nothing else ever revisits one. Skipped on an empty sweep for
    // the same reason the chunks are: `live` being empty there says nothing about which
    // sessions actually died.
    if (!emptySweep) {
      index.dropMarkers(MESSAGE_SCOPE, deadMarkers(live));
      index.dropMarkers(TAIL_SCOPE, deadMarkers(live, TAIL_SCOPE));
    }
    if (stale.length) removed = index.removeRefs(MESSAGE_SCOPE, stale);
    return { emptySweep, stale, removed };
  }

  function pruneSummary(pruned, known) {
    const summary = { removedRefs: pruned.stale.length, removedChunks: pruned.removed };
    if (pruned.emptySweep) {
      summary.pruneSkipped = known.length;
      summary.pruneSkippedReason = 'no-sources-discovered';
      logger?.warn?.(`search_index_prune_skipped: 0 个来源被发现，保留已有的 ${known.length} 个来源（确认要清空请加 --force）`);
    }
    return summary;
  }

  // Prune only — no session is read.
  function prune() {
    const ids = listSessions();
    const known = index.listRefs(MESSAGE_SCOPE);
    return pruneSummary(pruneDead(ids, known), known);
  }

  // One sweep. Sessions the index still holds but chat_history no longer has are
  // dropped, so a deleted conversation stops being searchable.
  function* syncAllSteps({ force = false, quietMs = 0, maxBytes = Infinity } = {}) {
    const started = now();
    const ids = listSessions();
    let synced = 0;
    let skipped = 0;
    let hot = 0;
    let chunks = 0;
    let bytes = 0;
    const known = index.listRefs(MESSAGE_SCOPE);
    const refs = new Map(known.map(ref => [ref.refId, ref]));
    for (const id of ids) {
      let result;
      try {
        result = yield* syncSessionSteps(id, { force, refs, quietMs, maxBytes });
      } catch (error) {
        // One unreadable session must not abandon the sweep (or its prune step).
        logger?.warn?.(`search_index_session_failed: ${id}: ${error?.message || error}`);
        skipped += 1;
        continue;
      }
      if (result.sessionSkipped) { skipped += 1; if (result.hot) hot += 1; }
      else { synced += 1; chunks += result.chunks || 0; bytes += result.bytes || 0; }
      yield;
    }
    const pruned = pruneDead(ids, known, { force });
    const summary = {
      sessions: ids.length, synced, skipped, hot, chunks, bytes,
      ...pruneSummary(pruned, known), tookMs: now() - started,
    };
    logger?.log?.(`search_index_sync: ${JSON.stringify(summary)}`);
    return summary;
  }

  function syncAll(options) {
    return drain(syncAllSteps(options));
  }

  return Object.freeze({
    listSessions,
    syncAll,
    syncAllSteps,
    prune,
    syncSession,
    syncSessionSteps,
    search: options => index.search({ ...options, scope: MESSAGE_SCOPE }),
    stats: () => index.stats(),
  });
}

module.exports = {
  BLOCK_BYTES,
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  INDEXED_ROLES,
  MESSAGE_SCOPE,
  MIN_CHUNK_CHARS,
  SYNTHETIC_SESSION_IDS,
  TAIL_SCOPE,
  chunkText,
  createMessageCorpus,
  isSearchableSession,
  messageTaskId,
  messageText,
  messageTime,
  sessionChunkRows,
};

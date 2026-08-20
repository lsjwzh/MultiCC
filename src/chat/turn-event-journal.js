'use strict';

// Append-only per-session turn event journal (#110, tranche 3+4).
//
// Every event a chat client can see — stream events, tool calls/results,
// result frames, and the background/subagent monitor events — flows through
// one broadcast funnel. The journal records that funnel verbatim, one JSONL
// line per event with a per-session sequence number and wall-clock stamp, so:
//
//   - a duplicate-bubble / lost-turn incident has replayable ground truth
//     (today the final blob is all that survives, and debugging is inference);
//   - subagent/background trajectories (danmaku) survive restarts — the live
//     events were broadcast-and-forgotten before this;
//   - a later tranche can verify blob-derivation parity against the journal
//     and eventually derive the persisted blob from it.
//
// Contract rules the whole module is built around:
//   - the journal must NEVER affect the broadcast: every error is swallowed
//     and counted, nothing throws out of note();
//   - `part_delta` events are skipped — they are pure-UX token previews, the
//     authoritative blocks arrive via the events that are journaled;
//   - one line is capped (oversized payloads — cumulative text snapshots —
//     are recorded as a type-only stub, never sliced mid-JSON);
//   - files rotate at maxFileBytes down to `keep` generations, so a chatty
//     session can never grow the journal without bound.

const fs = require('fs');
const path = require('path');

const MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP = 2;

function createTurnEventJournal(deps = {}) {
  const dirFor = typeof deps.dir === 'function' ? deps.dir : null;
  const maxFileBytes = Number(deps.maxFileBytes) > 0 ? Number(deps.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const keep = Number(deps.keep) > 0 ? Number(deps.keep) : DEFAULT_KEEP;
  const skip = typeof deps.skip === 'function' ? deps.skip
    : (type) => type === 'part_delta';
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  // sessionId → { queue, seq, bytes }
  const sessions = new Map();
  let dropped = 0;
  // Corrupt lines skipped during read/readAll (a partial write used to retire
  // every event after it in the same file).
  let corruptLines = 0;

  function fileFor(sessionId, suffix) {
    const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(dirFor(), safe + '.events.jsonl' + (suffix || ''));
  }

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { queue: Promise.resolve(), seq: 0, bytes: 0 };
      sessions.set(sessionId, state);
    }
    return state;
  }

  // Serialized per session: appends keep their note() order on disk even when
  // the fs callbacks interleave across turns.
  function enqueue(sessionId, task) {
    const state = stateFor(sessionId);
    state.queue = state.queue.then(task, task);
    return state.queue;
  }

  // Rotation decisions run inside the per-session queue, on the byte counter
  // the appends themselves maintain — never on a counter that note() callers
  // bumped ahead of the queue (a burst of notes would otherwise desync the
  // estimate from disk and stop rotations from firing).
  function rotateIfNeeded(sessionId, state) {
    if (state.bytes < maxFileBytes) return Promise.resolve();
    const file = fileFor(sessionId);
    return fs.promises.stat(file).then(st => st.size, () => 0)
      .then(size => {
        state.bytes = size; // re-sync the estimate with the real file
        if (size < maxFileBytes) return;
        const renames = [];
        for (let i = keep - 1; i >= 1; i--) {
          renames.push(fs.promises.rename(fileFor(sessionId, '.' + i), fileFor(sessionId, '.' + (i + 1))).catch(() => {}));
        }
        return Promise.all(renames).then(() => fs.promises.rename(file, fileFor(sessionId, '.1')).catch(() => {}))
          .then(() => { state.bytes = 0; });
      })
      .catch(() => {});
  }

  // Append with lazy directory creation: the turn-events dir does not exist
  // on first boot after upgrade, and an appendFile into a missing parent
  // ENOENTs — without this recovery the journal would silently drop every
  // event of a session forever. One retry after mkdir, then it's a real drop.
  function appendLine(sessionId, line) {
    const attempt = () => fs.promises.appendFile(fileFor(sessionId), line + '\n');
    return attempt().catch(err => {
      if (err && err.code === 'ENOENT') {
        return fs.promises.mkdir(dirFor(), { recursive: true }).then(attempt);
      }
      throw err;
    });
  }

  function note(sessionId, event) {
    if (!dirFor || !event || typeof event !== 'object') return;
    if (skip(event.type)) return;
    const state = stateFor(sessionId);
    state.seq += 1;
    const seq = state.seq;
    let record = { seq, ts: now(), event };
    let line = JSON.stringify(record);
    if (line.length > MAX_LINE_BYTES) {
      // Oversized payload (cumulative snapshot, huge tool result): keep the
      // identity and the shape marker, drop the payload. Never slice the
      // JSON — a half-line is unparseable and poisons the whole file.
      record = { seq, ts: now(), event: { type: event.type, journaled: 'stub', payloadBytes: line.length } };
      line = JSON.stringify(record);
      if (line.length > MAX_LINE_BYTES) return;
    }
    enqueue(sessionId, () => appendLine(sessionId, line)
      .catch(() => { dropped += 1; })
      .then(() => {
        // Byte accounting lives with the appends that cause it, inside the
        // queue, so the counter tracks what is actually on disk.
        state.bytes += line.length + 1;
        return rotateIfNeeded(sessionId, state);
      }));
  }

  // Synchronous read for tests and future debug tooling. Returns [] when the
  // session has never been journaled; skips any trailing partial line.
  function read(sessionId) {
    if (!dirFor) return [];
    const file = fileFor(sessionId);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // A single corrupt line (partial write, disk hiccup) must not retire the
      // rest of the file's events - skip it, count it, keep replaying.
      try { out.push(JSON.parse(line)); } catch (_) { corruptLines += 1; }
    }
    return out;
  }

  function stats() {
    return { sessions: sessions.size, dropped, corruptLines };
  }

  // All generations, oldest first, so seq is ascending across files — the
  // full-history view derivation (open tasks at cutoff) needs. Same parse
  // rules as read(); a corrupt line is skipped but never stops the rest.
  function readAll(sessionId) {
    if (!dirFor) return [];
    const suffixes = [];
    for (let i = keep; i >= 1; i--) suffixes.push('.' + i);
    suffixes.push('');
    const out = [];
    for (const suffix of suffixes) {
      let raw;
      try { raw = fs.readFileSync(fileFor(sessionId, suffix), 'utf8'); } catch (_) { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch (_) { corruptLines += 1; }
      }
    }
    return out;
  }

  return Object.freeze({ note, read, readAll, stats });
}

let shared = null;

// Process-wide journal bound to the package data dir (chat_history/turn-events).
// The singleton keeps server.js wiring to one line; tests build their own
// instance against a temp dir instead.
function sharedTurnEventJournal(paths) {
  if (!shared) {
    const base = paths && paths.chatHistoryDir
      ? paths.chatHistoryDir
      : path.join(process.cwd(), 'chat_history');
    shared = createTurnEventJournal({ dir: () => path.join(base, 'turn-events') });
  }
  return shared;
}

module.exports = Object.freeze({ createTurnEventJournal, sharedTurnEventJournal });

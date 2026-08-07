'use strict';

// Turn timing recorder: the four lifecycle instants of a chat turn, shared by
// EVERY CLI adapter path (claude persistent stream + per-turn spawn for
// codex/opencode/zcode/qoder/kimi). Centralized here so adapters never carry
// their own copies of the instrumentation.
//
//   t0 received   — the server accepted the user message (route entry stamps
//                   opts.receivedAt; runChatTurn begins the record)
//   t1 spawned    — the CLI child process is ready for this turn's prompt
//   t2 sent       — the prompt left the server. Streaming path: written to the
//                   warm process's stdin. Per-turn path: the prompt travels as
//                   argv at spawn time (stdin is 'ignore'), so t2 == t1. The
//                   real upstream HTTP request happens INSIDE the CLI process
//                   and is not observable from here — t2 is our boundary.
//   t3 firstByte  — the earliest observable reply signal: first stdout chunk
//                   (per-turn) or first decoded stream event (streaming).
//
// Logging budget: lifecycle events only, at most 2 lines per turn — one
// `[turn-timing]` line when t3 lands (all four instants known), one
// `[turn-timing-abort]` line on an abnormal end before the first byte.

function createTurnTimingRecorder(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const emit = typeof deps.emit === 'function'
    ? deps.emit
    : (line) => { try { console.log(line); } catch (_) {} };
  const records = new Map();

  function key(sessionId, turnId) {
    return `${sessionId}\u0000${turnId || ''}`;
  }

  function get(sessionId, turnId) {
    return records.get(key(sessionId, turnId)) || null;
  }

  function begin(sessionId, turnId, { t0 = null, cli = null } = {}) {
    if (!sessionId || !turnId) return null;
    // Bounded growth: one record per turn on a long-running server. Evict the
    // oldest already-LOGGED record first; an unlogged one may still emit.
    if (records.size >= 512) {
      for (const [k, r] of records) {
        if (r.logged) { records.delete(k); break; }
      }
    }
    const record = {
      sessionId,
      turnId,
      cli: cli || null,
      t0: Number.isFinite(t0) ? t0 : now(),
      t1: null,
      t2: null,
      t3: null,
      logged: false,
    };
    records.set(key(sessionId, turnId), record);
    return record;
  }

  function setInstant(sessionId, turnId, field, ts) {
    const record = get(sessionId, turnId);
    if (!record || record[field] !== null) return null; // first mark wins
    record[field] = Number.isFinite(ts) ? ts : now();
    return record;
  }

  const markSpawned = (sessionId, turnId, ts) => setInstant(sessionId, turnId, 't1', ts);
  const markSent = (sessionId, turnId, ts) => setInstant(sessionId, turnId, 't2', ts);

  function summary(record) {
    return {
      sessionId: record.sessionId,
      turnId: record.turnId,
      cli: record.cli,
      t0: new Date(record.t0).toISOString(),
      t1: record.t1 === null ? null : new Date(record.t1).toISOString(),
      t2: record.t2 === null ? null : new Date(record.t2).toISOString(),
      t3: record.t3 === null ? null : new Date(record.t3).toISOString(),
      ms: {
        spawn: record.t1 === null ? null : record.t1 - record.t0,
        send: record.t2 === null || record.t1 === null ? null : record.t2 - record.t1,
        firstByte: record.t3 === null || record.t2 === null ? null : record.t3 - record.t2,
        total: record.t3 === null ? null : record.t3 - record.t0,
      },
    };
  }

  function markFirstByte(sessionId, turnId, ts) {
    const record = get(sessionId, turnId);
    if (!record || record.t3 !== null) return null; // the first byte counts once
    record.t3 = Number.isFinite(ts) ? ts : now();
    if (!record.logged) {
      record.logged = true;
      emit(`[turn-timing] ${JSON.stringify(summary(record))}`);
    }
    return record;
  }

  function abort(sessionId, turnId, reason) {
    const record = get(sessionId, turnId);
    if (!record || record.logged) return null;
    record.logged = true;
    emit(`[turn-timing-abort] ${JSON.stringify({ reason: String(reason || 'unknown'), ...summary(record) })}`);
    return record;
  }

  function drop(sessionId, turnId) {
    records.delete(key(sessionId, turnId));
  }

  return Object.freeze({ begin, get, markSpawned, markSent, markFirstByte, abort, drop });
}

module.exports = { createTurnTimingRecorder };

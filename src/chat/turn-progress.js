'use strict';

// Turn progress — JavaScript facade.
//
// One Rust owner (`native/addon/src/turn_progress.rs` over
// `multicc_core::turn_progress`) holds all four turn-progress state machines:
//
//   heartbeat  silent-period heartbeat cadence of the in-flight turn
//              (was src/chat/progress-heartbeat.js)
//   timing     the four lifecycle instants of a turn and its two log lines
//              (was src/chat/turn-timing.js)
//   timeline   the per-turn model timeline, keyed by session name inside Rust
//              (was src/chat/turn-timeline.js)
//   probe      in-memory delivery-handoff facts (was src/chat/delivery-probe.js)
//
// This file only:
//   * validates the constructor/id arguments with the legacy TypeErrors,
//   * owns the ONE unref'd timer armed from the owner's `nextDue()`,
//   * freezes the objects the legacy code froze,
//   * formats the timing lines (ISO timestamps + JSON, as before),
//   * forwards every call and resolves the clock where the legacy module read
//     it at entry (timeline/timing defaults).
//
// No bookkeeping state comes back to Node: `cs.turnTimeline` no longer exists,
// and timeline state is cleared by `forgetSession()` from the chat-session
// delete path.

const { getNative } = require('../native/runtime');

const DEFAULT_INTERVAL_MS = 8_000;
const MERGE_GAP_MS = 1500;
const DEFAULT_MAX_IDENTITIES = 64;

function nativeOwner(options = {}) {
  const intervalMs = options.intervalMs == null ? DEFAULT_INTERVAL_MS : Number(options.intervalMs);
  const maxIdentities = options.maxIdentities == null ? DEFAULT_MAX_IDENTITIES : Number(options.maxIdentities);
  return new (getNative().RustTurnProgress)(intervalMs, maxIdentities);
}

// Module-level default owner for the direct timeline/timing/probe functions.
// Created on first use so a test that never touches turn progress does not need
// the addon; production wiring passes an explicit owner everywhere.
let sharedOwner = null;
function ownerFor(owner) {
  if (owner) return owner;
  if (!sharedOwner) sharedOwner = nativeOwner();
  return sharedOwner;
}

// ── heartbeat ───────────────────────────────────────────────────────────────

function cleanId(value, name) {
  const cleaned = value == null ? '' : String(value).trim();
  if (!cleaned) throw new TypeError(`${name} is required`);
  return cleaned;
}

class TurnProgressHeartbeat {
  constructor(options = {}) {
    if (typeof options.onHeartbeat !== 'function') {
      throw new TypeError('onHeartbeat is required');
    }
    const intervalMs = options.intervalMs == null
      ? DEFAULT_INTERVAL_MS
      : Number(options.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('intervalMs must be a positive finite number');
    }

    this.intervalMs = intervalMs;
    this._onHeartbeat = options.onHeartbeat;
    this._now = options.now || Date.now;
    this._setInterval = options.setInterval || globalThis.setInterval;
    this._clearInterval = options.clearInterval || globalThis.clearInterval;
    if (typeof this._now !== 'function'
      || typeof this._setInterval !== 'function'
      || typeof this._clearInterval !== 'function') {
      throw new TypeError('now, setInterval, and clearInterval must be functions');
    }
    // A heartbeat instance owns its owner unless the process shares one.
    this._owner = options.owner || nativeOwner({ intervalMs });
    this._timer = null;
    this._timerDue = null;
    this._logWarn = typeof options.logWarn === 'function' ? options.logWarn : null;
    this._ports = {
      now: () => this._now(),
      onHeartbeat: event => this._onHeartbeat(Object.freeze(event)),
      logWarn: (message, error) => {
        if (!this._logWarn) return;
        try { this._logWarn(message, error); } catch (_) {}
      },
    };
  }

  start(sessionId, turnId, update = {}) {
    const session = cleanId(sessionId, 'sessionId');
    const turn = cleanId(turnId, 'turnId');
    const snapshot = this._owner.heartbeatStart(session, turn, update, this._ports);
    this._arm();
    return Object.freeze(snapshot);
  }

  touchVisible(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    const result = this._owner.heartbeatTouchVisible(found.session, found.turn, this._ports);
    this._arm();
    return result;
  }

  touchActivity(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    return this._owner.heartbeatTouchActivity(found.session, found.turn, this._ports);
  }

  updatePhase(sessionId, turnId, phaseOrUpdate, safeToolKind) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    return this._owner.heartbeatUpdatePhase(
      found.session, found.turn, phaseOrUpdate, safeToolKind, this._ports);
  }

  stop(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    const stopped = this._owner.heartbeatStop(found.session, found.turn);
    if (stopped) this._arm();
    return stopped;
  }

  // Live snapshot of this session's active turn-progress entry (phase/silentMs).
  status(sessionId) {
    const session = sessionId == null ? '' : String(sessionId).trim();
    if (!session) return null;
    const status = this._owner.heartbeatStatus(session, this._ports);
    return status ? Object.freeze(status) : null;
  }

  stopAll() {
    const count = this._owner.heartbeatStopAll();
    this._disarm();
    return count;
  }

  _find(sessionId, turnId) {
    const session = sessionId == null ? '' : String(sessionId).trim();
    const turn = turnId == null ? '' : String(turnId).trim();
    if (!session || !turn) return null;
    return { session, turn };
  }

  _timestamp() {
    const timestamp = Number(this._now());
    if (!Number.isFinite(timestamp)) throw new TypeError('now must return a finite number');
    return timestamp;
  }

  _clearTimer() {
    if (this._timer == null) return;
    this._clearInterval(this._timer);
    this._timer = null;
    this._timerDue = null;
  }

  /// Keep one timer armed for the earliest deadline. An already-armed earlier
  /// deadline stays (an extra wake-up is harmless; the owner re-checks).
  _arm() {
    const due = this._owner.heartbeatNextDue();
    if (due == null) {
      this._clearTimer();
      return;
    }
    if (this._timer != null && this._timerDue != null && this._timerDue <= due) return;
    this._clearTimer();
    const delay = Math.max(0, due - Number(this._now()));
    this._timerDue = due;
    const timer = this._setInterval(() => this._tick(), delay);
    this._timer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  _disarm() {
    this._clearTimer();
  }

  _tick() {
    this._clearTimer();
    try {
      const at = this._timestamp();
      this._owner.heartbeatDue(at, this._ports);
    } finally {
      this._arm();
    }
  }
}

// ── turn timing ─────────────────────────────────────────────────────────────

function iso(value) {
  return new Date(value).toISOString();
}

function timingSummary(plan) {
  return {
    sessionId: plan.sessionId,
    turnId: plan.turnId,
    cli: plan.cli,
    t0: iso(plan.t0),
    t1: plan.t1 === null ? null : iso(plan.t1),
    t2: plan.t2 === null ? null : iso(plan.t2),
    t3: plan.t3 === null ? null : iso(plan.t3),
    ms: {
      spawn: plan.ms.spawn,
      send: plan.ms.send,
      firstByte: plan.ms.firstByte,
      total: plan.ms.total,
    },
  };
}

function createTurnTimingRecorder(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const emit = typeof deps.emit === 'function'
    ? deps.emit
    : (line) => { try { console.log(line); } catch (_) {} };
  let owner = deps.owner || null;
  function ownerOf() {
    if (!owner) owner = nativeOwner();
    return owner;
  }
  const ports = {
    now: () => now(),
    emitTiming: (plan) => emit(`[turn-timing] ${JSON.stringify(timingSummary(plan))}`),
    emitAbort: (plan) => {
      const { reason, ...summary } = timingSummary(plan);
      emit(`[turn-timing-abort] ${JSON.stringify({ reason: plan.reason, ...summary })}`);
    },
  };

  function begin(sessionId, turnId, options) {
    const opts = options === undefined ? {} : options;
    const { t0 = null, cli = null } = opts;
    return ownerOf().timingBegin(sessionId, turnId, { t0, cli }, ports);
  }

  function get(sessionId, turnId) {
    return ownerOf().timingGet(sessionId, turnId);
  }

  function setInstant(sessionId, turnId, field, ts) {
    return ownerOf().timingMark(sessionId, turnId, field, ts, ports);
  }

  const markSpawned = (sessionId, turnId, ts) => setInstant(sessionId, turnId, 't1', ts);
  const markSent = (sessionId, turnId, ts) => setInstant(sessionId, turnId, 't2', ts);

  function markFirstByte(sessionId, turnId, ts) {
    return ownerOf().timingMarkFirstByte(sessionId, turnId, ts, ports);
  }

  function abort(sessionId, turnId, reason) {
    return ownerOf().timingAbort(sessionId, turnId, reason, ports);
  }

  function drop(sessionId, turnId) {
    ownerOf().timingDrop(sessionId, turnId);
  }

  // Additive: the persisted `turnTimings` field (see the engine's
  // turnTimingsField). The seven legacy methods above are unchanged.
  function field(sessionId, turnId) {
    return ownerOf().timingField(sessionId, turnId);
  }

  return Object.freeze({
    begin, get, markSpawned, markSent, markFirstByte, abort, drop, field,
  });
}

// ── turn timeline ───────────────────────────────────────────────────────────

function createTurnTimelinePort(owner = null) {
  const ownerOf = () => ownerFor(owner);

  function startTurn(sessionName, cs, now) {
    const at = now === undefined ? Date.now() : now;
    return ownerOf().timelineStart(sessionName, cs, at);
  }

  function observeClaude(sessionName, cs, evt, now) {
    const at = now === undefined ? Date.now() : now;
    return ownerOf().timelineObserveClaude(sessionName, cs, evt, at);
  }

  function observeAdapter(sessionName, cs, evt, now) {
    const at = now === undefined ? Date.now() : now;
    return ownerOf().timelineObserveAdapter(sessionName, cs, evt, at);
  }

  function currentStage(sessionName, cs, now) {
    const at = now === undefined ? Date.now() : now;
    return ownerOf().timelineCurrentStage(sessionName, cs, at);
  }

  function snapshot(sessionName, cs, now) {
    const at = now === undefined ? Date.now() : now;
    return ownerOf().timelineSnapshot(sessionName, cs, at);
  }

  function field(sessionName, cs, now) {
    const timeline = snapshot(sessionName, cs, now);
    return timeline ? { timeline } : {};
  }

  function forget(sessionName) {
    return ownerOf().timelineForget(sessionName);
  }

  return Object.freeze({
    startTurn, observeClaude, observeAdapter, currentStage, snapshot, field, forget,
  });
}

const defaultTimelinePort = createTurnTimelinePort();

// ── delivery-handoff probe ──────────────────────────────────────────────────

function createDeliveryProbeRegistry(deps = {}) {
  const maxIdentities = deps.maxIdentities == null
    ? DEFAULT_MAX_IDENTITIES
    : Number(deps.maxIdentities);
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let owner = deps.owner || null;
  function ownerOf() {
    if (!owner) owner = nativeOwner({ maxIdentities });
    return owner;
  }
  const ports = { now: () => now() };

  function record(sessionName, clientMsgId, deliveryId, facts = {}) {
    return ownerOf().probeRecord(sessionName, clientMsgId, deliveryId, facts, ports);
  }

  function lookup(sessionName, identity) {
    return ownerOf().probeLookup(sessionName, identity);
  }

  return Object.freeze({ record, lookup });
}

function shouldReexecutePersistedDelivery(duplicateSeen, duplicatePersisted, probe) {
  return getNative().turnProgressShouldReexecute(duplicateSeen, duplicatePersisted, probe);
}

// ── sanitizers (frozen module surface of the old heartbeat module) ──────────

function sanitizePhase(value) {
  return getNative().turnProgressSanitizePhase(value);
}

function sanitizeToolKind(value) {
  return getNative().turnProgressSanitizeToolKind(value);
}

// ── one owner for the whole process ─────────────────────────────────────────

/// `owner` plus facades bound to it. The server creates exactly one and wires
/// every reader; `forgetSession` is the chat-session delete hook.
function createTurnProgress(options = {}) {
  const owner = nativeOwner(options);
  return {
    owner,
    heartbeat: heartbeatOptions => new TurnProgressHeartbeat({ ...heartbeatOptions, owner }),
    timeline: createTurnTimelinePort(owner),
    timing: timingOptions => createTurnTimingRecorder({ ...timingOptions, owner }),
    deliveryProbe: probeOptions => createDeliveryProbeRegistry({ ...probeOptions, owner }),
    forgetSession(sessionName) {
      owner.timelineForget(sessionName);
      owner.probeForget(sessionName);
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MERGE_GAP_MS,
  TurnProgressHeartbeat,
  createTurnTimingRecorder,
  createDeliveryProbeRegistry,
  createTurnProgress,
  createTurnTimelinePort,
  shouldReexecutePersistedDelivery,
  sanitizePhase,
  sanitizeToolKind,
  // Direct (shared-owner) timeline surface; production passes a bound port.
  startTurn: defaultTimelinePort.startTurn,
  observeClaude: defaultTimelinePort.observeClaude,
  observeAdapter: defaultTimelinePort.observeAdapter,
  currentStage: defaultTimelinePort.currentStage,
  snapshot: defaultTimelinePort.snapshot,
  field: defaultTimelinePort.field,
  forget: defaultTimelinePort.forget,
};

'use strict';

const DEFAULT_INTERVAL_MS = 30_000;

const PHASE_ALIASES = Object.freeze({
  starting: 'starting',
  preparing: 'starting',
  running: 'running',
  thinking: 'thinking',
  reasoning: 'thinking',
  tool: 'tool',
  executing: 'tool',
  waiting: 'waiting',
  monitoring: 'waiting',
  finalizing: 'finalizing',
  recovering: 'recovering',
});

const TOOL_KIND_ALIASES = Object.freeze({
  bash: 'process',
  command: 'process',
  exec: 'process',
  process: 'process',
  shell: 'process',
  edit: 'filesystem',
  file: 'filesystem',
  filesystem: 'filesystem',
  patch: 'filesystem',
  read: 'filesystem',
  write: 'filesystem',
  find: 'search',
  search: 'search',
  browser: 'browser',
  fetch: 'network',
  http: 'network',
  network: 'network',
  web: 'network',
  monitor: 'monitor',
  wait: 'monitor',
  agent: 'subagent',
  subagent: 'subagent',
  task: 'subagent',
  integration: 'integration',
  mcp: 'integration',
  other: 'other',
});

function cleanId(value, name) {
  const cleaned = value == null ? '' : String(value).trim();
  if (!cleaned) throw new TypeError(`${name} is required`);
  return cleaned;
}

function sanitizePhase(value) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  return PHASE_ALIASES[normalized] || 'running';
}

function sanitizeToolKind(value) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  if (TOOL_KIND_ALIASES[normalized]) return TOOL_KIND_ALIASES[normalized];
  if (/agent|task|collab/.test(normalized)) return 'subagent';
  if (/wait|monitor|poll/.test(normalized)) return 'monitor';
  if (/exec|bash|command|shell|process/.test(normalized)) return 'process';
  if (/read|write|edit|patch|file/.test(normalized)) return 'filesystem';
  if (/find|search/.test(normalized)) return 'search';
  if (/fetch|http|network|web/.test(normalized)) return 'network';
  return normalized ? 'other' : null;
}

function readPhaseUpdate(phaseOrUpdate, safeToolKind) {
  if (phaseOrUpdate && typeof phaseOrUpdate === 'object') {
    return {
      phase: sanitizePhase(phaseOrUpdate.phase),
      toolKind: sanitizeToolKind(
        Object.prototype.hasOwnProperty.call(phaseOrUpdate, 'safeToolKind')
          ? phaseOrUpdate.safeToolKind
          : phaseOrUpdate.toolKind
      ),
    };
  }
  return {
    phase: sanitizePhase(phaseOrUpdate),
    toolKind: sanitizeToolKind(safeToolKind),
  };
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
    this._turns = new Map();
  }

  start(sessionId, turnId, update = {}) {
    const session = cleanId(sessionId, 'sessionId');
    const turn = cleanId(turnId, 'turnId');
    // One host session can own only one active turn. Clear a stale predecessor
    // defensively so a restart/interrupt gap cannot keep emitting heartbeats for
    // a turn that no longer has a runner.
    for (const [activeKey, active] of this._turns) {
      if (active.sessionId !== session) continue;
      this._turns.delete(activeKey);
      this._clearTimer(active);
    }
    const key = this._key(session, turn);

    const timestamp = this._timestamp();
    const normalized = readPhaseUpdate(update);
    const entry = {
      sessionId: session,
      turnId: turn,
      startedAt: timestamp,
      lastUserVisibleAt: timestamp,
      lastActivityAt: timestamp,
      phase: normalized.phase,
      safeToolKind: normalized.phase === 'tool' ? normalized.toolKind : null,
      lastHeartbeatPeriod: 0,
      timer: null,
    };
    this._turns.set(key, entry);
    this._armTimer(key, entry);
    return this._snapshot(entry);
  }

  touchVisible(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    const timestamp = this._timestamp();
    found.entry.lastUserVisibleAt = timestamp;
    found.entry.lastActivityAt = timestamp;
    found.entry.lastHeartbeatPeriod = 0;
    this._clearTimer(found.entry);
    this._armTimer(found.key, found.entry);
    return true;
  }

  touchActivity(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    found.entry.lastActivityAt = this._timestamp();
    return true;
  }

  updatePhase(sessionId, turnId, phaseOrUpdate, safeToolKind) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    const update = readPhaseUpdate(phaseOrUpdate, safeToolKind);
    found.entry.phase = update.phase;
    found.entry.safeToolKind = update.phase === 'tool' ? update.toolKind : null;
    found.entry.lastActivityAt = this._timestamp();
    return true;
  }

  stop(sessionId, turnId) {
    const found = this._find(sessionId, turnId);
    if (!found) return false;
    this._turns.delete(found.key);
    this._clearTimer(found.entry);
    return true;
  }

  stopAll() {
    const count = this._turns.size;
    for (const entry of this._turns.values()) this._clearTimer(entry);
    this._turns.clear();
    return count;
  }

  _key(sessionId, turnId) {
    return `${sessionId.length}:${sessionId}${turnId}`;
  }

  _find(sessionId, turnId) {
    const session = sessionId == null ? '' : String(sessionId).trim();
    const turn = turnId == null ? '' : String(turnId).trim();
    if (!session || !turn) return null;
    const key = this._key(session, turn);
    const entry = this._turns.get(key);
    return entry ? { key, entry } : null;
  }

  _timestamp() {
    const timestamp = Number(this._now());
    if (!Number.isFinite(timestamp)) throw new TypeError('now must return a finite number');
    return timestamp;
  }

  _armTimer(key, entry) {
    const timer = this._setInterval(() => this._tick(key, entry), this.intervalMs);
    entry.timer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  _clearTimer(entry) {
    if (entry.timer == null) return;
    this._clearInterval(entry.timer);
    entry.timer = null;
  }

  _tick(key, entry) {
    if (this._turns.get(key) !== entry) return;
    const timestamp = this._timestamp();
    const silentMs = Math.max(0, timestamp - entry.lastUserVisibleAt);
    if (silentMs < this.intervalMs) return;
    const heartbeatPeriod = Math.floor(silentMs / this.intervalMs);
    if (heartbeatPeriod <= entry.lastHeartbeatPeriod) return;
    entry.lastHeartbeatPeriod = heartbeatPeriod;

    this._onHeartbeat(Object.freeze({
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      elapsedMs: Math.max(0, timestamp - entry.startedAt),
      silentMs,
      phase: entry.phase,
      toolKind: entry.safeToolKind,
      activityAgeMs: Math.max(0, timestamp - entry.lastActivityAt),
    }));
  }

  _snapshot(entry) {
    return Object.freeze({
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      startedAt: entry.startedAt,
      lastUserVisibleAt: entry.lastUserVisibleAt,
      lastActivityAt: entry.lastActivityAt,
      phase: entry.phase,
      safeToolKind: entry.safeToolKind,
    });
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  TurnProgressHeartbeat,
  sanitizePhase,
  sanitizeToolKind,
};

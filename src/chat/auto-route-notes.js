'use strict';

// Auto-provider route events used to be live-only: the Jev note under a
// message and the "which line answered" labels existed only for a client that
// happened to be connected when the turn picked its line. A task created from
// the new-task composer starts its first turn before the chat socket opens, and
// every page refresh replays history without them — so the note vanished and
// the labels fell back to the first candidate's model.
//
// This wrapper sits between the runtime and the broadcast. For a routed pick
// it persists (1) a display-only system history record carrying the structured
// event, rendered by the same formatter the live note uses, and (2) the line
// actually picked on the session record, so labels survive a restart.

const NOTE_KIND = 'auto_route';
const ROUTE_PHASES = new Set(['selected', 'switched']);
const { selectionKey } = require('./auto-provider-selection-key');

function clean(value, max = 256) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

// Only what the formatter reads; never the candidate pool or skip reasons.
function noteRoute(event) {
  const routing = event.routing && typeof event.routing === 'object' ? event.routing : null;
  return {
    routePhase: 'selected',
    protocol: clean(event.protocol, 64),
    providerId: clean(event.providerId),
    providerName: clean(event.providerName),
    model: clean(event.model),
    tier: clean(event.tier, 64),
    preferredTier: clean(event.preferredTier, 64),
    routing: routing && {
      source: clean(routing.source, 32),
      code: clean(routing.code, 64),
      tierIndex: Number.isInteger(routing.tierIndex) ? routing.tierIndex : null,
      tierCount: Number.isInteger(routing.tierCount) ? routing.tierCount : null,
      latencyMs: Number.isFinite(Number(routing.latencyMs)) ? Number(routing.latencyMs) : null,
      onUnknown: clean(routing.onUnknown, 32),
    },
  };
}

// Mirrors the live handler: only a turn Jev was asked about has a note. A
// verdict that was never prepared (continuations, nudges) stays silent.
function wantsNote(event) {
  return event.routePhase === 'selected' && !!event.routing
    && event.routing.code !== 'jev_not_prepared' && !!clean(event.providerName);
}

function noteClientMsgId(event) {
  const turn = clean(event.turnId, 128) || String(event.ts || Date.now());
  return `auto-route-${turn}-${Number(event.attemptNo) || 1}`;
}

function createAutoRouteNotes({ broadcast, append, records, save, now = Date.now } = {}) {
  if (typeof broadcast !== 'function') throw new TypeError('[auto-route-notes] broadcast is required');

  function rememberLine(sessionId, event) {
    const record = records?.get?.(sessionId);
    if (!record || !clean(event.providerId)) return;
    record.autoProviderLastRoute = {
      selectionKey: selectionKey(record.providerSelection),
      cli: clean(event.cli || record.cli || 'claude', 64),
      providerId: clean(event.providerId),
      providerName: clean(event.providerName),
      model: clean(event.model),
      tier: clean(event.tier, 64),
      at: Number(now()),
    };
    try { save?.('runtime.auto-provider-route'); } catch (_) {}
  }

  // A line that finished a turn is the one a new session with the same pool
  // should start on (see lastGoodRoute). Selection alone proves nothing.
  function rememberSuccess(sessionId, event) {
    const record = records?.get?.(sessionId);
    const last = record && record.autoProviderLastRoute;
    if (!last || last.providerId !== clean(event.providerId)
        || last.selectionKey !== selectionKey(record.providerSelection)) return;
    last.succeededAt = Number(now());
    try { save?.('runtime.auto-provider-route'); } catch (_) {}
  }

  function persistNote(sessionId, event) {
    if (typeof append !== 'function' || !wantsNote(event)) return null;
    const route = noteRoute(event);
    const clientMsgId = noteClientMsgId(event);
    try {
      const saved = append(sessionId, {
        role: 'system',
        kind: NOTE_KIND,
        // Plain fallback for readers that do not know `autoRoute`.
        content: `Auto → ${route.providerName}${route.model ? ` · ${route.model}` : ''}`,
        ts: Number(now()),
        clientMsgId,
        autoRoute: route,
      });
      return saved ? clientMsgId : null;
    } catch (_) {
      return null;
    }
  }

  function emit(sessionId, event) {
    if (event && event.type === 'provider_auto_route' && event.routePhase === 'succeeded') {
      rememberSuccess(sessionId, event);
    }
    if (!event || event.type !== 'provider_auto_route' || !ROUTE_PHASES.has(event.routePhase)) {
      return broadcast(sessionId, event);
    }
    rememberLine(sessionId, event);
    const noteId = persistNote(sessionId, event);
    // The live note adopts the persisted record's clientMsgId so a history
    // replay (reconnect) reconciles onto it instead of drawing a second line.
    return broadcast(sessionId, noteId ? { ...event, noteClientMsgId: noteId } : event);
  }
  // The records these notes write are also what answers "which line did this
  // pool last finish a turn on"; the auto runtime reads it off its emitter.
  emit.lastGoodRoute = createLastGoodRouteLookup(records);
  return emit;
}

// The most recent line, across every session, that finished a turn under this
// exact pool (same selectionKey) — what a fresh session of that pool (e.g. one
// more session from the same preset) starts on instead of priority #1.
function createLastGoodRouteLookup(records) {
  return function lastGoodRoute(key, excludeSessionId = null) {
    if (!key || !records || typeof records.entries !== 'function') return null;
    let best = null;
    for (const [id, record] of records.entries()) {
      if (id === excludeSessionId) continue;
      const route = record && record.autoProviderLastRoute;
      if (!route || route.selectionKey !== key || !route.providerId) continue;
      const at = Number(route.succeededAt);
      if (!Number.isFinite(at) || (best && at <= best.succeededAt)) continue;
      best = { cli: route.cli || null, providerId: route.providerId, model: route.model || null, succeededAt: at };
    }
    return best;
  };
}

module.exports = { createAutoRouteNotes, createLastGoodRouteLookup, NOTE_KIND, noteRoute, wantsNote };

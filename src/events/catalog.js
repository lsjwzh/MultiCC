'use strict';

// Standard event catalog. The single source of truth for event names, the
// aliases rules may subscribe to, and pattern matching. Pure: no I/O.
//
// Naming: `domain.verb`. Task events mirror the classify letter
// (src/classify/vocab.js) and never invent a second state source.
//
// The tables and the matcher live in native/core/src/events.rs; this module
// snapshots the tables at load and forwards. Only strings carry meaning as a
// pattern or event type, so anything else crosses the bridge as null.

const { getNative } = require('../native/runtime');

const native = getNative();
const CATALOG = JSON.parse(native.eventsCatalog());
const request = (op, input) => JSON.parse(native.eventsRequest(op, JSON.stringify(input)));
const str = value => (typeof value === 'string' ? value : null);

const TASK_EVENTS = Object.freeze(CATALOG.taskEvents);
const TURN_EVENTS = Object.freeze(CATALOG.turnEvents);
const EVENT_TYPES = Object.freeze(CATALOG.eventTypes);
// Aliases expand only at match time; they are never emitted themselves.
const ALIASES = Object.freeze(CATALOG.aliases);

function isKnownPattern(pattern) {
  return request('isKnownPattern', { pattern: str(pattern) });
}

function matchesPattern(pattern, type) {
  return request('matchesPattern', { pattern: str(pattern), type: str(type) });
}

function matchesAny(patterns, type) {
  return request('matchesAny', {
    patterns: Array.isArray(patterns) ? Array.from(patterns, str) : null,
    type: str(type),
  });
}

module.exports = { TASK_EVENTS, TURN_EVENTS, EVENT_TYPES, ALIASES, isKnownPattern, matchesPattern, matchesAny };

'use strict';

// Event hub: wraps the central bus so every standard event shares one envelope
// {eventId, seq, ts, type, sessionId, dirId, data, depth, origin}.
//
// - observeTaskState() is the single bridge from setTaskState transitions.
// - Idempotency: a goal event fires once per (task segment, goalState) until
//   the session leaves D; a manual or refine write of the same value is a no-op.
// - Subscribers are isolated: a throwing subscriber never breaks the emitter
//   or its siblings.

const { deriveTaskEvents, segmentKey, letterOf } = require('./task-transitions');
const { EVENT_TYPES } = require('./catalog');
const { isTerminalLetter } = require('../classify/vocab');
const { CONCLUSION_EVENTS, summaryOf } = require('./envelope');

const MAX_RECENT = 200;

function createEventHub(deps = {}) {
  const bus = deps.bus;
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    throw new TypeError('event hub dependency missing: bus');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const randomUUID = deps.randomUUID || require('crypto').randomUUID;
  const logger = deps.logger || console;
  const resolveDir = typeof deps.dirIdOf === 'function' ? deps.dirIdOf : () => null;
  const readConclusion = typeof deps.conclusionOf === 'function' ? deps.conclusionOf : () => '';

  const subscribers = new Set();
  const goalMemory = new Map(); // sessionId -> `${segment}:${goalState}`
  const recent = [];
  let seq = 0;
  let started = false;

  function allowed(guard) {
    if (!guard) return true;
    try { return !!guard(); } catch (_) { return false; }
  }

  function dispatch(event, guard) {
    if (!allowed(guard)) return false;
    recent.push(event);
    if (recent.length > MAX_RECENT) recent.shift();
    for (const listener of [...subscribers]) {
      if (!allowed(guard)) break;
      try { listener(event); }
      catch (error) {
        try { logger.warn && logger.warn('event_subscriber_failed', { type: event.type, error: String(error && error.message || error).slice(0, 120) }); } catch (_) {}
      }
    }
    return true;
  }

  function emit(type, sessionId, data = {}, meta = {}) {
    return emitGuarded(type, sessionId, data, meta, null);
  }

  function emitGuarded(type, sessionId, data, meta, guard) {
    if (!EVENT_TYPES.includes(type)) return null;
    if (!allowed(guard)) return null;
    const event = Object.freeze({
      eventId: randomUUID(),
      seq: ++seq,
      ts: now(),
      type,
      sessionId: sessionId || null,
      dirId: resolveDir(sessionId) || null,
      data: Object.freeze({ ...data }),
      // depth/origin let rule actions that cause new work be traced and capped.
      depth: Number.isInteger(meta.depth) ? meta.depth : 0,
      origin: meta.origin || null,
    });
    if (!dispatch(event, guard)) return null;
    return event;
  }

  function observeTaskState(sessionId, prev, next) {
    const emitted = [];
    let derived;
    try { derived = deriveTaskEvents(prev, next); }
    catch (error) { return emitted; }
    const after = letterOf(next);
    if (!isTerminalLetter(after)) goalMemory.delete(sessionId);
    let conclusion = null; // read the history at most once per transition
    for (const item of derived) {
      if (item.type === 'task.goal_resolved' || item.type === 'task.achieved' || item.type === 'task.needs_interaction') {
        const key = `${segmentKey(next)}:${item.type}:${item.data.to}`;
        const memo = goalMemory.get(sessionId) || new Set();
        if (memo.has(key)) continue;
        memo.add(key);
        goalMemory.set(sessionId, memo);
      }
      let data = item.data;
      if (CONCLUSION_EVENTS.has(item.type)) {
        if (conclusion === null) {
          try { conclusion = readConclusion(sessionId) || ''; } catch (_) { conclusion = ''; }
        }
        data = { ...data, conclusion, summary: summaryOf(next) };
      }
      const event = emit(item.type, sessionId, data);
      if (event) emitted.push(event);
    }
    return emitted;
  }

  function onStateChanged(sessionId, prev, next) {
    try { observeTaskState(sessionId, prev, next); }
    catch (_) {}
  }

  function onTurnComplete(sessionId, _chat, completion) {
    if (!completion || completion.resultDurable !== true) return;
    let guard = null;
    try {
      const check = completion.isCurrentRunner;
      if (typeof check === 'function') guard = () => check.call(completion);
    } catch (_) { return; }
    emitGuarded('turn.completed', sessionId,
      { turnId: completion.turnId || null, lineageKind: completion.lineage && completion.lineage.kind || null }, {}, guard);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function start() {
    if (started) return false;
    started = true;
    bus.on('task:state-changed', onStateChanged);
    bus.on('chat:turn-complete', onTurnComplete);
    return true;
  }

  function stop() {
    if (!started) return;
    started = false;
    bus.off('task:state-changed', onStateChanged);
    bus.off('chat:turn-complete', onTurnComplete);
    subscribers.clear();
    goalMemory.clear();
  }

  function forgetSession(sessionId) { goalMemory.delete(sessionId); }

  return Object.freeze({
    emit, observeTaskState, subscribe, start, stop, forgetSession,
    recent: (limit = 50) => recent.slice(-Math.max(1, Math.min(limit, MAX_RECENT))),
  });
}

module.exports = { createEventHub };

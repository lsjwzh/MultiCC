'use strict';

// Scripted world for the events & triggers differential
// (docs/rust-migration/differential/event-routes.js).
//
// One JSON scenario describes everything the retired routes could observe:
//
//   { case, now, ids, store: {rules, chains}, sessions: [{id, dirId, label,
//     triggers}], chats: {id: {isStreaming}}, channels: {plugin/target:
//     problem|null}, crons: {expression: false} }
//
// `buildDeps` returns stable `deps` objects that both sides share: the frozen
// Node handlers (tests/helpers/legacy-event-routes.js) over this bag, and the
// real host composition (src/routes/events-host.js) in the Rust side's stub
// child. The hub, rule engine and trigger runtime are the production modules,
// rebuilt per scenario so cases cannot bleed into each other; the deps handed
// to a route are stable proxies onto the current instance.
//
// Every business effect is appended to `effects.calls` in call order:
// hub.emit, rule-store writes, channel-recipient checks, cron validation,
// session-persistence mutations, appendEvent and the chat broadcast/run. A
// route that answers the same bytes but asks Node for the wrong thing (or
// twice) makes the two effect sequences differ and fails the differential.

const fs = require('node:fs');
const path = require('node:path');

const { createEventHub } = require('../../src/events/hub');
const { createEventRuleEngine } = require('../../src/events/engine');
const { createSessionTriggers } = require('../../src/triggers');

const quiet = { warn() {}, info() {}, error() {} };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildDeps(initialWorld = {}) {
  const effects = { calls: [] };
  const state = { world: initialWorld, hub: null, engine: null, nextId: () => 'id-0' };
  const persistedSessions = new Map();
  const chatSessions = new Map();

  function record(entry) {
    effects.calls.push(entry);
  }

  function currentWorld() {
    return state.world || {};
  }

  // ── stable deps shared by both compositions ─────────────────────────────
  const bus = {
    on() {},
    off() {},
    emit(...args) {
      record({ op: 'bus-emit', args: clone(args) });
    },
  };

  const cron = {
    validate(expression) {
      record({ op: 'cron', expression: String(expression) });
      const table = currentWorld().crons || {};
      return table[expression] !== false;
    },
    schedule() {
      return { start() {}, stop() {} };
    },
  };

  const sessionPersistence = {
    mutate(reason, fn) {
      record({ op: 'mutate', reason });
      return fn();
    },
  };

  const checkChannelTarget = (plugin, target) => {
    record({ op: 'check-channel', plugin, target });
    const table = currentWorld().channels || {};
    const key = `${plugin}/${target}`;
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  };

  const deps = {
    persistedSessions,
    chatSessions,
    // Stable proxies: the routes capture these once, the instances behind them
    // are rebuilt for every scenario.
    hub: {
      emit(...args) {
        record({
          op: 'hub-emit',
          type: args[0],
          sessionId: args[1] === undefined ? null : args[1],
          data: clone(args[2]),
          meta: clone(args[3]),
        });
        return state.hub.emit(...args);
      },
      recent(limit) {
        return state.hub.recent(limit);
      },
      subscribe(listener) {
        return state.hub.subscribe(listener);
      },
    },
    engine: {
      listGlobal: () => state.engine.listGlobal(),
      listAll: () => state.engine.listAll(),
      recentResults: () => state.engine.recentResults(),
      pendingChains: () => state.engine.pendingChains(),
      addGlobal: body => state.engine.addGlobal(body),
      updateGlobal: (id, body) => state.engine.updateGlobal(id, body),
      removeGlobal: id => state.engine.removeGlobal(id),
      insertGlobal: rule => state.engine.insertGlobal(rule),
      findGlobal: id => state.engine.findGlobal(id),
      replaceGlobal: (id, rule) => state.engine.replaceGlobal(id, rule),
    },
    bus,
    cron,
    sessionPersistence,
    checkChannelTarget,
    saveBestEffort(reason) {
      record({ op: 'save', reason });
    },
    cwdForSession() {
      return currentWorld().cwd || '/tmp';
    },
    appendEvent(dirId, kind, label, sessionId) {
      record({
        op: 'append',
        dirId: dirId === undefined ? null : dirId,
        kind,
        label,
        sessionId: sessionId === undefined ? null : sessionId,
      });
    },
    chatBroadcast(sessionId, payload) {
      record({ op: 'broadcast', sessionId, payload: clone(payload) });
    },
    crypto: { randomUUID: () => state.nextId() },
    // The host port's own identity (src/routes/events-host.js) draws from the
    // same stable id so the front door and the retired handler agree.
    randomUUID: () => state.nextId(),
    now: () => currentWorld().now,
    chokidar: { watch: () => ({ on() { return this; }, close() {} }) },
    fs,
    path,
    logger: quiet,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  };

  // The host composition asks the runtime it was built with; the frozen Node
  // handlers build their own instance over the same deps.
  deps.triggerRuntime = createSessionTriggers(deps);

  // ── scenario switching ─────────────────────────────────────────────────
  function apply(world) {
    state.world = world || {};
    effects.calls.length = 0;

    persistedSessions.clear();
    for (const session of state.world.sessions || []) {
      persistedSessions.set(session.id, clone(session));
    }
    chatSessions.clear();
    for (const [id, chat] of Object.entries(state.world.chats || {})) {
      chatSessions.set(id, clone(chat));
    }

    // One stable id per scenario: a case creates at most one rule / trigger /
    // event, but the Rust side draws twice (the host's rules-state count probe
    // then identity) where the Node side draws once, so a cursor would drift.
    const ids = Array.isArray(state.world.ids) ? state.world.ids.slice() : [];
    state.nextId = () => (ids.length ? ids[0] : `id-${state.world.case || '0'}`);

    const hub = createEventHub({
      bus,
      now: () => currentWorld().now,
      randomUUID: () => state.nextId(),
      logger: quiet,
    });
    const store = {
      read: () => clone(currentWorld().store || { version: 1, rules: [], chains: [] }),
      write: data => record({
        op: 'persist',
        rules: clone(data.rules || []),
        chains: clone(data.chains || []),
      }),
    };
    const engine = createEventRuleEngine({
      hub,
      persistedSessions,
      store,
      now: () => currentWorld().now,
      idFactory: () => state.nextId(),
      checkChannelTarget,
      logger: quiet,
    });
    // start() loads the scripted rule table/chains and subscribes to this
    // hub; stop() is never called, so pendingChains stays observable.
    engine.start();

    state.hub = hub;
    state.engine = engine;
    return state;
  }

  apply(initialWorld);

  return {
    deps,
    effects,
    apply,
    world: currentWorld,
  };
}

module.exports = { buildDeps };

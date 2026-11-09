'use strict';

const { getNative } = require('../native/runtime');
const { createWsEnvelope } = require('../api-contract');
const { DEFAULTS: BACKPRESSURE_DEFAULTS, byteLength, coalesceKey } = require('../ws-backpressure');

const initial = getNative().sessionStateInitial();
const EMPTY_STATUS = Object.freeze({ status: initial.status, currentFile: null,
  lastActivity: initial.lastActivity, runStartedAt: initial.runStartedAt, runEndedAt: initial.runEndedAt });

function assertMap(name, value) {
  if (!value || typeof value.get !== 'function' || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`[workspace] ${name} map is required`);
  }
}

function assertDependencies(options) {
  if (!options || typeof options !== 'object') throw new TypeError('[workspace] options are required');
  for (const name of ['records', 'directories', 'chatSessions']) assertMap(name, options[name]);
  for (const name of [
    'workspaceSnapshot', 'recentEvents', 'mergeState', 'setTaskState', 'saveBestEffort',
  ]) {
    if (typeof options[name] !== 'function') throw new TypeError(`[workspace] missing dependency: ${name}`);
  }
}

// Encoded once per broadcast, exactly like `sendWs` did. Everything after this
// point is native queueing and fan-out.
function prepareFrame(payload) {
  const data = JSON.stringify(createWsEnvelope(payload));
  return { data, bytes: byteLength(data), key: coalesceKey(data) };
}

function createWorkspaceRuntime(options) {
  assertDependencies(options);
  const {
    records,
    directories,
    chatSessions,
    workspaceSnapshot,
    recentEvents,
    mergeState,
    setTaskState,
    saveBestEffort,
  } = options;
  const clock = options.clock || Date.now;
  if (typeof clock !== 'function') throw new TypeError('[workspace] clock must be a function');
  const metrics = options.metrics || null;
  const logger = options.logger || null;

  const stateAnchor = {};
  const stateOwner = new (getNative().RustWorkspaceState)(stateAnchor);
  Object.defineProperty(stateOwner, Symbol('workspace host references'), { value: stateAnchor });
  const statePorts = { records, directories, chatSessions, clock, mergeState, setTaskState, saveBestEffort, broadcast };
  const status = Object.freeze({
    get: id => stateOwner.status(id), has: id => stateOwner.has('status', id),
    delete: id => stateOwner.delete('status', id), get size() { return stateOwner.size('status'); },
  });
  const summaries = Object.freeze({
    get: id => stateOwner.summary(id), has: id => stateOwner.has('summary', id),
    delete: id => stateOwner.delete('summary', id), get size() { return stateOwner.size('summary'); },
  });
  const queueOwner = new (getNative().RustWorkspaceQueues)();
  // Read-only compatibility view; there is no second queue table in Node.
  const queueStatuses = Object.freeze({
    get: id => queueOwner.get(id),
    has: id => queueOwner.has(id),
    get size() { return queueOwner.size; },
  });

  const socketsAnchor = {};
  const sockets = new (getNative().RustWorkspaceSockets)(socketsAnchor);
  Object.defineProperty(sockets, Symbol('workspace socket host references'), { value: socketsAnchor });

  function queueSnapshot(dirId) {
    return [...records.values()].filter(record => record.dirId === dirId).flatMap(record => {
      const target = options.resolveStateTarget?.(record.id);
      const targetId = target?.executionSessionId || record.id;
      if (target) return [queueOwner.view(record.id, targetId, target, clock)];
      const queue = queueOwner.get(targetId);
      return queue ? [{ ...queue, sessionId: record.id }] : [];
    });
  }

  // The one host port the native owner drives. Every call is stateless except
  // `schedule`, whose timer handle the owner keeps and cancels.
  const socketPorts = {
    prepare: prepareFrame,
    sendFrame(socket, data, id) {
      try {
        socket.send(data, undefined, error => {
          try { sockets.backpressureResult(id, error || null, socketPorts); } catch (_) {}
        });
      } catch (error) {
        try { sockets.backpressureResult(id, error, socketPorts); } catch (_) {}
      }
    },
    schedule(id) {
      const timer = setTimeout(() => {
        try { sockets.flushClient(id, socketPorts); } catch (_) {}
      }, BACKPRESSURE_DEFAULTS.retryMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    cancelSchedule(timer) { clearTimeout(timer); },
    disconnect(socket) {
      try { socket.close(1013, 'slow client; reconnect to resync'); }
      catch (_) { try { socket.terminate(); } catch (_) {} }
    },
    metric(name, value, op) {
      if (!metrics) return;
      if (op === 'set') metrics.set(name, value); else metrics.inc(name, value);
    },
    backpressureLog(socket, reason, queueBytes, queueMessages) {
      logger?.warn?.('ws_backpressure_disconnect', { reason, queueBytes, queueMessages,
        bufferedAmount: socket.bufferedAmount || 0, correlationId: socket._correlationId });
    },
    heartbeatTimeout(fields, socket, missedPongs) {
      logger?.warn?.('ws_pong_timeout', { ...fields, correlationId: socket._correlationId, missedPongs });
    },
    ping(socket) { socket.ping(); },
    terminate(socket) { socket.terminate(); },
    close(socket) { socket.close(); },
    directoriesHas: dirId => directories.has(dirId),
    workspaceSnapshot: dirId => workspaceSnapshot(dirId),
    queueSnapshot: dirId => queueSnapshot(dirId),
    events: dirId => recentEvents(dirId),
    directoriesEntries: () => [...directories],
    notify: (observer, dirId, payload) => observer(dirId, payload),
    now: () => clock(),
  };

  function broadcastRaw(dirId, payload) {
    sockets.publish(dirId, payload, socketPorts);
  }

  const STATE_EVENTS = new Set(['status', 'summary', 'task_state', 'session_queue_status']);
  function publishSessionView(sessionId) {
    const view = options.sessionView?.(sessionId);
    const record = records.get(sessionId);
    if (!view || !record) return;
    const envelope = { sessionId, stateSource: view.stateSource };
    broadcastRaw(record.dirId, { type: 'task_state', ...envelope,
      classifyState: view.classifyState, goal: view.goal, phase: view.phase, taskShortCode: view.taskShortCode,
      // Fleet cards show judgements Aux may no longer be revising; the card has
      // to be able to say so. See src/classify/aux-verdict-health.js.
      auxUnhealthy: view.auxUnhealthy === true,
      auxUnhealthySince: view.auxUnhealthySince || null });
    broadcastRaw(record.dirId, { type: 'status', ...envelope,
      status: view.status,
      currentFile: view.currentFile, lastActivity: view.lastActivity,
      runStartedAt: view.runStartedAt, runEndedAt: view.runEndedAt });
    broadcastRaw(record.dirId, { type: 'summary', ...envelope,
      summary: view.goal || view.summary || '', ts: view.summaryAt || null });
    const executionId = view.stateSource?.executionSessionId || sessionId;
    broadcastRaw(record.dirId, { type: 'session_queue_status',
      ...queueOwner.view(sessionId, executionId, view.stateSource, clock), ...envelope });
  }
  function broadcast(dirId, payload) {
    if (!STATE_EVENTS.has(payload.type) || !payload.sessionId || !options.resolveStateTarget) {
      broadcastRaw(dirId, payload); return;
    }
    const target = options.resolveStateTarget(payload.sessionId);
    // Workspace events are view projections. Never write a child's state into
    // its source record, and never project an old source event over its cursor.
    if (target.executionSessionId === payload.sessionId) broadcastRaw(dirId,
      payload.type === 'session_queue_status'
        ? { ...payload, ...queueOwner.project(payload.sessionId, payload, target, clock) } : payload);
    const sources = new Set(options.stateSources?.(payload.sessionId) || []);
    if (target.executionSessionId !== payload.sessionId) sources.add(payload.sessionId);
    for (const id of sources) if (id !== payload.sessionId || target.executionSessionId !== id) publishSessionView(id);
  }

  const setSummary = (sessionId, summary) => stateOwner.setSummary(sessionId, summary, statePorts);
  const setStatus = (sessionId, patch) => stateOwner.setStatus(sessionId, patch, statePorts);

  function setQueueStatus(sessionId, input, { broadcast: shouldBroadcast = true } = {}) {
    const record = records.get(sessionId);
    if (!record || record.type === 'aux' || record.type === 'gateway') return null;
    const { value, changed } = queueOwner.update(sessionId, input);
    if (shouldBroadcast && changed) {
      broadcast(record.dirId, { type: 'session_queue_status', ...value });
    }
    return value;
  }

  function hydrateQueueStatuses(items) {
    let count = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.sessionId) continue;
      if (setQueueStatus(item.sessionId, item, { broadcast: false })) count += 1;
    }
    return count;
  }

  function watch(socket, id) {
    socket._multiccWorkspaceClientId = id;
    socket.on('pong', () => sockets.onPong(id));
    socket.on('close', () => sockets.detach(id, socketPorts));
  }

  function attachWorkspace(socket, url, fields) {
    const dirId = url.searchParams.get('dirId') || '';
    const id = sockets.attachWorkspace(socket, dirId, fields || {}, socketPorts);
    if (!id) return false;
    watch(socket, id);
    return true;
  }

  let airSync = null;
  function attachMeta(socket, url, fields) {
    if (url?.searchParams.get('air') === '1' && airSync) return airSync.attach(socket, url);
    const id = sockets.attachMeta(socket, fields || {}, socketPorts);
    if (!id) return false;
    watch(socket, id);
    return true;
  }

  // Whether the two workspace hosts are terminated by the native owner. `air=1`
  // stays on its own protocol (and therefore on the shared router's heartbeat
  // and backpressure).
  function ownsSocket(url) {
    if (!url) return false;
    if (url.pathname === '/ws/workspace') return true;
    if (url.pathname === '/ws/meta') return !(url.searchParams.get('air') === '1' && airSync);
    return false;
  }

  function socketStats(socket) {
    const id = socket?._multiccWorkspaceClientId;
    if (!id) return null;
    return sockets.socketStats(id);
  }

  // Read-only native-backed views. `push/runtime.js` only asks for the number of
  // live subscribers of a directory; tests can ask whether one socket is there.
  const clients = Object.freeze({
    get(dirId) {
      const size = sockets.clientCount(dirId);
      if (!size) return undefined;
      return Object.freeze({ size, has: socket => sockets.hasClient(dirId, socket) });
    },
    has: dirId => sockets.clientCount(dirId) > 0,
    get size() { return sockets.directoryCount(); },
  });
  const metaClients = Object.freeze({ get size() { return sockets.fleetLen(); } });

  // Owned by the same native owner so the ring is written and replayed in one
  // place; notes-store keeps only the JSONL adapter.
  const events = Object.freeze({
    has: dirId => sockets.hasEvents(dirId),
    recent: dirId => sockets.recentEvents(dirId),
    hydrate: (dirId, list) => sockets.hydrateEvents(dirId, list),
    append: (dirId, event) => sockets.appendEvent(dirId, event),
  });

  stateOwner.hydrate(statePorts);

  return Object.freeze({
    status,
    clients,
    summaries,
    queueStatuses,
    metaClients,
    events,
    broadcast,
    publishSessionView,
    setSummary,
    setStatus,
    setQueueStatus,
    hydrateQueueStatuses,
    attachWorkspace,
    attachMeta,
    ownsSocket,
    socketStats,
    tickHeartbeat: () => { sockets.tickHeartbeat(socketPorts); },
    subscribe: listener => {
      const id = sockets.subscribe(listener);
      return () => sockets.unsubscribe(id);
    },
    setAirSync: runtime => { airSync = runtime; },
    close: () => { const drained = airSync?.close(); sockets.close(socketPorts); return drained; },
  });
}

module.exports = {
  EMPTY_STATUS,
  createWorkspaceRuntime,
  prepareFrame,
};

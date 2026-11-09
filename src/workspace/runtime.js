'use strict';

const { getNative } = require('../native/runtime');

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
    'workspaceSnapshot', 'recentEvents', 'mergeState', 'send', 'broadcastClients',
    'setTaskState', 'saveBestEffort',
  ]) {
    if (typeof options[name] !== 'function') throw new TypeError(`[workspace] missing dependency: ${name}`);
  }
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
    send,
    broadcastClients,
    setTaskState,
    saveBestEffort,
  } = options;
  const clock = options.clock || Date.now;
  if (typeof clock !== 'function') throw new TypeError('[workspace] clock must be a function');

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
  const clients = new Map();
  const queueOwner = new (getNative().RustWorkspaceQueues)();
  // Read-only compatibility view; there is no second queue table in Node.
  const queueStatuses = Object.freeze({
    get: id => queueOwner.get(id),
    has: id => queueOwner.has(id),
    get size() { return queueOwner.size; },
  });
  const metaClients = new Set();
  const observers = new Set();
  let airSync = null;

  function broadcastRaw(dirId, payload) {
    for (const observer of observers) { try { observer(dirId, payload); } catch (_) {} }
    const scoped = clients.get(dirId);
    if (scoped) broadcastClients(scoped, payload);
    if (metaClients.size > 0) broadcastClients(metaClients, { ...payload, dirId });
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

  function queueSnapshot(dirId) {
    return [...records.values()].filter(record => record.dirId === dirId).flatMap(record => {
      const target = options.resolveStateTarget?.(record.id);
      const targetId = target?.executionSessionId || record.id;
      if (target) return [queueOwner.view(record.id, targetId, target, clock)];
      const queue = queueOwner.get(targetId);
      return queue ? [{ ...queue, sessionId: record.id }] : [];
    });
  }

  function attachWorkspace(socket, url) {
    const dirId = url.searchParams.get('dirId') || '';
    if (!directories.has(dirId)) {
      send(socket, { type: 'error', error: 'unknown directory' });
      socket.close();
      return false;
    }
    let scoped = clients.get(dirId);
    if (!scoped) {
      scoped = new Set();
      clients.set(dirId, scoped);
    }
    scoped.add(socket);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    send(socket, {
      type: 'snapshot',
      dirId,
      sessions: workspaceSnapshot(dirId),
      events: recentEvents(dirId),
      queues: queueSnapshot(dirId),
    });
    socket.on('close', () => {
      scoped.delete(socket);
      if (scoped.size === 0) clients.delete(dirId);
    });
    return true;
  }

  function attachMeta(socket, url) {
    if (url?.searchParams.get('air') === '1' && airSync) return airSync.attach(socket, url);
    metaClients.add(socket);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const fleet = [];
    for (const [dirId, directory] of directories) {
      fleet.push({
        dirId,
        dirLabel: directory.label || null,
        sessions: workspaceSnapshot(dirId),
        events: recentEvents(dirId),
        queues: queueSnapshot(dirId),
      });
    }
    send(socket, { type: 'meta_snapshot', fleet });
    socket.on('close', () => { metaClients.delete(socket); });
    return true;
  }

  stateOwner.hydrate(statePorts);

  return Object.freeze({
    status,
    clients,
    summaries,
    queueStatuses,
    metaClients,
    broadcast,
    publishSessionView,
    setSummary,
    setStatus,
    setQueueStatus,
    hydrateQueueStatuses,
    attachWorkspace,
    attachMeta,
    subscribe: listener => { observers.add(listener); return () => observers.delete(listener); },
    setAirSync: runtime => { airSync = runtime; },
    close: () => { const drained = airSync?.close(); observers.clear(); return drained; },
  });
}

module.exports = {
  EMPTY_STATUS,
  createWorkspaceRuntime,
};

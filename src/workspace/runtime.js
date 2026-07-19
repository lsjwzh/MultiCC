'use strict';

const { createSessionStateService } = require('../session');

const EMPTY_STATUS = Object.freeze({
  status: 'idle',
  currentFile: null,
  lastActivity: 0,
  runStartedAt: null,
  runEndedAt: null,
});

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

  const status = new Map();
  const clients = new Map();
  const summaries = new Map();
  const metaClients = new Set();

  const sessionState = createSessionStateService({
    clock,
    hasPendingWork: sessionId => {
      const pending = chatSessions.get(sessionId)?.currentTask?.pendingDispatches;
      return !!(pending && pending.length > 0);
    },
  });

  function hydrate() {
    for (const [sessionId, record] of records) {
      if (!record) continue;
      if (record.summary) {
        summaries.set(sessionId, {
          summary: record.summary,
          ts: record.summaryTs || clock(),
        });
      }
      if (record.type === 'aux' || record.type === 'gateway') continue;
      const classifyState = record.taskState && record.taskState.classifyState;
      if (!classifyState) continue;
      status.set(sessionId, {
        ...EMPTY_STATUS,
        status: classifyState === 'D' ? 'completed' : 'waiting',
      });
    }
  }

  function broadcast(dirId, payload) {
    const scoped = clients.get(dirId);
    if (scoped) broadcastClients(scoped, payload);
    if (metaClients.size > 0) broadcastClients(metaClients, { ...payload, dirId });
  }

  function setSummary(sessionId, summary) {
    if (!summary) return false;
    const record = records.get(sessionId);
    if (!record || record.type === 'aux' || record.type === 'gateway') return false;
    const ts = clock();
    summaries.set(sessionId, { summary, ts });
    const changed = record.summary !== summary;
    if (changed) record.summary = summary;
    if (changed || record.taskState?.lastSummary !== summary) {
      setTaskState(sessionId, { lastSummary: summary, lastSummaryAt: ts }, { save: false });
      saveBestEffort('runtime.session-summary');
    }
    broadcast(record.dirId, { type: 'summary', sessionId, summary, ts });
    return true;
  }

  function setStatus(sessionId, patch) {
    const record = records.get(sessionId);
    if (!record || record.type === 'aux') return null;
    const previous = status.get(sessionId) || EMPTY_STATUS;
    const transition = sessionState.transition(sessionId, previous, patch);
    const next = {
      ...transition.state,
      currentFile: patch.currentFile !== undefined ? patch.currentFile : previous.currentFile,
    };
    status.set(sessionId, next);
    if (next.status === previous.status && next.currentFile === previous.currentFile) return next;
    broadcast(record.dirId, {
      type: 'status',
      sessionId,
      status: next.status,
      currentFile: next.currentFile,
      lastActivity: next.lastActivity,
      runStartedAt: next.runStartedAt,
      runEndedAt: next.runEndedAt,
      mergeState: mergeState(directories.get(record.dirId), record),
    });
    return next;
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
    });
    socket.on('close', () => {
      scoped.delete(socket);
      if (scoped.size === 0) clients.delete(dirId);
    });
    return true;
  }

  function attachMeta(socket) {
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
      });
    }
    send(socket, { type: 'meta_snapshot', fleet });
    socket.on('close', () => { metaClients.delete(socket); });
    return true;
  }

  hydrate();

  return Object.freeze({
    status,
    clients,
    summaries,
    metaClients,
    broadcast,
    setSummary,
    setStatus,
    attachWorkspace,
    attachMeta,
  });
}

module.exports = {
  EMPTY_STATUS,
  createWorkspaceRuntime,
};

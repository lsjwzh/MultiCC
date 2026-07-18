'use strict';

const { assertDtoSafe } = require('../session-dto');
const { assertDirectoryRecordsPort, assertWorkspaceFactsPort } = require('./ports');

const WORKSPACE_STATUSES = new Set([
  'idle', 'thinking', 'editing', 'running', 'waiting', 'completed', 'error',
]);

function boundedString(value, max, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).slice(0, max);
}

function isoTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function workspaceEntry(session, facts = {}) {
  const status = WORKSPACE_STATUSES.has(facts.status) ? facts.status : 'idle';
  return assertDtoSafe({
    ...session,
    status,
    statusUpdatedAt: isoTimestamp(facts.lastActivity),
    runStartedAt: isoTimestamp(facts.runStartedAt),
    runEndedAt: isoTimestamp(facts.runEndedAt),
    pendingNotes: Math.max(0, Math.floor(Number(facts.pendingNotes) || 0)),
    summary: boundedString(facts.summary, 1000),
    summaryAt: isoTimestamp(facts.summaryAt),
    classifyState: boundedString(facts.classifyState, 40),
    goal: boundedString(facts.goal, 1000, ''),
    phase: boundedString(facts.phase, 80, 'idle'),
  });
}

function directoryDto(directory) {
  if (!directory || !directory.id) return null;
  return assertDtoSafe({
    id: String(directory.id),
    label: boundedString(directory.label || directory.name, 160),
  });
}

function createWorkspaceService({ sessionQuery, directories, workspaceFacts } = {}) {
  if (!sessionQuery || typeof sessionQuery.list !== 'function') {
    throw new TypeError('[session] sessionQuery.list must be a function');
  }
  assertDirectoryRecordsPort(directories);
  assertWorkspaceFactsPort(workspaceFacts);

  function snapshot(dirId) {
    const directory = directoryDto(directories.get(dirId));
    if (!directory) return null;
    const sessions = sessionQuery.list({ dirId }).map((session) => {
      const facts = workspaceFacts.read(session.id, session);
      return workspaceEntry(session, facts && typeof facts === 'object' ? facts : {});
    });
    return assertDtoSafe({ directory, sessions, count: sessions.length });
  }

  function fleet() {
    const source = directories.list();
    if (!source || typeof source[Symbol.iterator] !== 'function') {
      throw new TypeError('[session] directories.list() must return an iterable');
    }
    const workspaces = [];
    for (const directory of source) {
      const item = directory && snapshot(directory.id);
      if (item) workspaces.push(item);
    }
    return assertDtoSafe({ workspaces, count: workspaces.length });
  }

  return Object.freeze({ fleet, snapshot });
}

module.exports = { WORKSPACE_STATUSES, createWorkspaceService, workspaceEntry };

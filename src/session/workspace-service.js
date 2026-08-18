'use strict';

const { assertDtoSafe, sanitizePublicText } = require('../session-dto');
const { assertDirectoryRecordsPort, assertWorkspaceFactsPort } = require('./ports');

const WORKSPACE_STATUSES = new Set([
  'idle', 'thinking', 'editing', 'running', 'waiting', 'succeeded', 'completed', 'error',
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
    summary: sanitizePublicText(facts.summary, 1000),
    summaryAt: isoTimestamp(facts.summaryAt),
    classifyState: boundedString(facts.classifyState, 40),
    goal: sanitizePublicText(facts.goal, 1000) || '',
    taskShortCode: boundedString(facts.taskShortCode, 8, ''),
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
  if (!sessionQuery || typeof sessionQuery.listContexts !== 'function'
      || typeof sessionQuery.presentContext !== 'function') {
    throw new TypeError('[session] sessionQuery canonical context methods are required');
  }
  assertDirectoryRecordsPort(directories);
  assertWorkspaceFactsPort(workspaceFacts);

  function snapshot(dirId, { presenter } = {}) {
    const directory = directoryDto(directories.get(dirId));
    if (!directory) return null;
    const contexts = sessionQuery.listContexts({ dirId });
    const sessions = contexts.map((sessionContext) => {
      const facts = workspaceFacts.read(sessionContext.record.id, sessionContext.record);
      const safeFacts = facts && typeof facts === 'object' ? facts : {};
      if (presenter !== undefined) {
        if (typeof presenter !== 'function') {
          throw new TypeError('[session] workspace presenter must be a function');
        }
        return presenter(Object.freeze({
          directory,
          facts: safeFacts,
          session: sessionContext,
        }));
      }
      return workspaceEntry(sessionQuery.presentContext(sessionContext), safeFacts);
    });
    const result = { directory, sessions, count: sessions.length };
    return presenter === undefined ? assertDtoSafe(result) : result;
  }

  function fleet(options = {}) {
    const source = directories.list();
    if (!source || typeof source[Symbol.iterator] !== 'function') {
      throw new TypeError('[session] directories.list() must return an iterable');
    }
    const workspaces = [];
    for (const directory of source) {
      const item = directory && snapshot(directory.id, options);
      if (item) workspaces.push(item);
    }
    const result = { workspaces, count: workspaces.length };
    return options.presenter === undefined ? assertDtoSafe(result) : result;
  }

  return Object.freeze({ fleet, snapshot });
}

module.exports = {
  WORKSPACE_STATUSES,
  createWorkspaceService,
  workspaceEntry,
};

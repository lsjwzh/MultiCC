'use strict';

const { assertDtoSafe, sanitizePublicText } = require('../session-dto');
const { assertDirectoryRecordsPort, assertWorkspaceFactsPort } = require('./ports');

const WORKSPACE_STATUSES = new Set([
  'idle', 'thinking', 'editing', 'running', 'waiting', 'completed', 'error',
]);
const MAX_WORKSPACE_DIFFS = 100;

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

function snapshotSessionList(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  return snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
}

function safeDiffSessionId(value) {
  const id = String(value || '');
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : 'invalid-session-id';
}

function normalizedTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 'invalid';
}

function normalizedInteger(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizedString(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function normalizedMergeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ahead: Math.max(0, Number(source.ahead) || 0),
    behind: Math.max(0, Number(source.behind) || 0),
    dirty: !!source.dirty,
    mergeReady: !!source.mergeReady,
    rebaseInProgress: !!source.rebaseInProgress,
  };
}

// Shadow comparator used while the legacy workspace payload and the bounded
// projection coexist. Diffs deliberately report only an allowlisted field and
// public session id — never the mismatched values — because summaries and old
// workspace records may contain paths, credentials, or error details.
function compareWorkspaceSnapshots(legacy, boundedSnapshot) {
  const legacySessions = snapshotSessionList(legacy);
  const boundedSessions = snapshotSessionList(boundedSnapshot);
  const legacyById = new Map();
  const boundedById = new Map();
  for (const session of legacySessions) {
    if (session && session.id !== undefined && session.id !== null) {
      legacyById.set(String(session.id), session);
    }
  }
  for (const session of boundedSessions) {
    if (session && session.id !== undefined && session.id !== null) {
      boundedById.set(String(session.id), session);
    }
  }

  const diffs = [];
  let hasDifference = false;
  function addDiff(sessionId, field, reason = 'mismatch') {
    hasDifference = true;
    if (diffs.length >= MAX_WORKSPACE_DIFFS) return;
    diffs.push(Object.freeze({ sessionId: safeDiffSessionId(sessionId), field, reason }));
  }

  const ids = [...new Set([...legacyById.keys(), ...boundedById.keys()])].sort();
  for (const id of ids) {
    const left = legacyById.get(id);
    const right = boundedById.get(id);
    if (!left) {
      addDiff(id, 'session', 'missing_legacy');
      continue;
    }
    if (!right) {
      addDiff(id, 'session', 'missing_bounded');
      continue;
    }

    const fields = [
      ['status', normalizedString(left.status, 'idle'), normalizedString(right.status, 'idle')],
      ['clients', normalizedInteger(left.clients), normalizedInteger(right.clients)],
      ['pendingNotes', normalizedInteger(left.pendingNotes), normalizedInteger(right.pendingNotes)],
      ['summary', normalizedString(left.summary), normalizedString(right.summary)],
      ['classifyState', normalizedString(left.classifyState), normalizedString(right.classifyState)],
      ['goal', normalizedString(left.goal, ''), normalizedString(right.goal, '')],
      ['phase', normalizedString(left.phase, 'idle'), normalizedString(right.phase, 'idle')],
      // Legacy `lastActivity` means "workspace status updated". The bounded
      // DTO keeps session lastActivity separately and names this fact explicitly.
      ['statusUpdatedAt', normalizedTimestamp(left.lastActivity), normalizedTimestamp(right.statusUpdatedAt)],
      ['runStartedAt', normalizedTimestamp(left.runStartedAt), normalizedTimestamp(right.runStartedAt)],
      ['runEndedAt', normalizedTimestamp(left.runEndedAt), normalizedTimestamp(right.runEndedAt)],
      ['summaryAt', normalizedTimestamp(left.summaryTs), normalizedTimestamp(right.summaryAt)],
    ];
    for (const [field, legacyValue, boundedValue] of fields) {
      if (!Object.is(legacyValue, boundedValue)) addDiff(id, field);
    }

    const legacyMerge = normalizedMergeState(left.mergeState);
    const boundedMerge = normalizedMergeState(right.mergeState);
    for (const field of ['ahead', 'behind', 'dirty', 'mergeReady', 'rebaseInProgress']) {
      if (!Object.is(legacyMerge[field], boundedMerge[field])) addDiff(id, `mergeState.${field}`);
    }
  }

  return Object.freeze({ equal: !hasDifference, diffs: Object.freeze(diffs) });
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

module.exports = {
  MAX_WORKSPACE_DIFFS,
  WORKSPACE_STATUSES,
  compareWorkspaceSnapshots,
  createWorkspaceService,
  workspaceEntry,
};

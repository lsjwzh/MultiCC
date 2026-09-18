'use strict';

const { hash } = require('./context');
const { projectShellMessages } = require('./chat-history');

// The index is a metadata-only directory of a shell's conversation: which
// logical tasks appear, in which order, and where their message segments start
// and end. It never returns message bodies, never triggers routing, and never
// changes attribution — loading it is a read.
const MAX_TASKS = 400;
const MAX_SEGMENTS_PER_TASK = 200;
const SHORT_CODE_RE = /^[0-9A-Z]{4}$/;

function identifier(value, limit = 200) {
  return typeof value === 'string' && value ? value.slice(0, limit) : null;
}

function messageRef(message) {
  return {
    id: identifier(message?.id),
    sourceSessionId: identifier(message?.sourceSessionId),
    sourceMessageId: identifier(message?.sourceMessageId),
    ts: Number(message?.ts) || null,
  };
}

function segmentOf(first, last, count, firstTs, lastTs) {
  return { firstMessageRef: first, lastMessageRef: last, messageCount: count, firstTs, lastTs };
}

function taskTitle(task, entry) {
  const fromRecord = identifier(task?.title, 160);
  if (fromRecord) return fromRecord;
  return identifier(entry.taskName, 160) || '';
}

// status is display-only: it says whether the index should offer an entry, not
// whether the underlying execution is running. Execution state stays on turns.
function buildTaskIndex({ shellId, messages, tasks = [], codeFor, capabilitiesOf, includeEmpty = false, now = Date.now() }) {
  const list = (Array.isArray(messages) ? messages : []).filter(message => message && typeof message === 'object');
  const byId = new Map();
  const ordered = [];
  const records = new Map((Array.isArray(tasks) ? tasks : [])
    .filter(task => task && typeof task.id === 'string')
    .map(task => [task.id, task]));
  let unassignedCount = 0, unassignedFirst = null, unassignedLast = null;
  let truncated = false;
  let previousTaskId = null;

  for (const message of list) {
    const taskId = identifier(message.taskId);
    if (!taskId) {
      const ref = messageRef(message);
      unassignedCount += 1;
      unassignedFirst = unassignedFirst || ref;
      unassignedLast = ref;
      previousTaskId = null;
      continue;
    }
    let entry = byId.get(taskId);
    if (!entry) {
      if (ordered.length >= MAX_TASKS) { truncated = true; previousTaskId = null; continue; }
      entry = { taskId, taskName: null, segments: [], turnIds: new Set(), messageCount: 0,
        userMessageCount: 0, firstMessageRef: null, lastMessageRef: null, segmentTruncated: false };
      byId.set(taskId, entry);
      ordered.push(entry);
    }
    const ref = messageRef(message);
    const last = entry.segments[entry.segments.length - 1];
    if (last && previousTaskId === taskId) {
      last.lastMessageRef = ref;
      last.lastTs = ref.ts;
      last.messageCount += 1;
    } else if (entry.segments.length >= MAX_SEGMENTS_PER_TASK) {
      entry.segmentTruncated = true;
    } else {
      entry.segments.push(segmentOf(ref, ref, 1, ref.ts, ref.ts));
    }
    if (typeof message.turnId === 'string' && message.turnId) entry.turnIds.add(message.turnId);
    if (message.role === 'user') entry.userMessageCount += 1;
    entry.messageCount += 1;
    entry.firstMessageRef = entry.firstMessageRef || ref;
    entry.lastMessageRef = ref;
    if (!entry.taskName && typeof message.taskName === 'string' && message.taskName) entry.taskName = message.taskName;
    previousTaskId = taskId;
  }

  const entries = ordered.map(entry => {
    const task = records.get(entry.taskId) || null;
    const code = typeof codeFor === 'function' ? String(codeFor(entry.taskId) || '').trim().toUpperCase() : '';
    const capabilities = typeof capabilitiesOf === 'function'
      ? capabilitiesOf(task, entry.taskId) || {} : {};
    return {
      taskId: entry.taskId,
      shortCode: SHORT_CODE_RE.test(code) ? code : '',
      title: taskTitle(task, entry),
      status: identifier(task?.status, 40) || 'active',
      state: identifier(task?.state, 40) || null,
      turnCount: entry.turnIds.size || entry.userMessageCount,
      messageCount: entry.messageCount,
      firstMessageRef: entry.firstMessageRef,
      lastMessageRef: entry.lastMessageRef,
      truncated: entry.segmentTruncated === true,
      segments: entry.segments,
      capabilities: {
        canDetach: capabilities.canDetach === true,
        canSelectTarget: capabilities.canSelectTarget === true,
      },
    };
  });
  // A task linked to this conversation can keep its directory row even when
  // every turn currently belongs to another task; it then has no anchor to jump
  // to. Manager views ask for those rows explicitly, the in-chat index does not
  // (an empty row would be a code that jumps nowhere).
  for (const [taskId, task] of includeEmpty ? records : []) {
    if (byId.has(taskId) || entries.length >= MAX_TASKS) continue;
    const code = typeof codeFor === 'function' ? String(codeFor(taskId) || '').trim().toUpperCase() : '';
    const capabilities = (typeof capabilitiesOf === 'function' ? capabilitiesOf(task, taskId) : null) || {};
    entries.push({
      taskId, shortCode: SHORT_CODE_RE.test(code) ? code : '', title: taskTitle(task, { taskName: null }),
      status: identifier(task?.status, 40) || 'active', state: identifier(task?.state, 40) || null,
      turnCount: 0, messageCount: 0, empty: true, firstMessageRef: null, lastMessageRef: null,
      truncated: false, segments: [],
      capabilities: { canDetach: capabilities.canDetach === true, canSelectTarget: capabilities.canSelectTarget === true },
    });
  }

  const revision = hash(JSON.stringify({
    shellId: shellId || null,
    unassignedCount,
    tasks: entries.map(entry => [entry.taskId, entry.turnCount, entry.messageCount,
      entry.segments.map(segment => [segment.firstMessageRef?.id, segment.lastMessageRef?.id, segment.messageCount])]),
  }));
  return {
    version: 1,
    shellId: identifier(shellId) || null,
    scopeRevision: revision,
    generatedAt: Number(now) || Date.now(),
    truncated,
    taskCount: entries.length,
    unassigned: { messageCount: unassignedCount, firstMessageRef: unassignedFirst, lastMessageRef: unassignedLast },
    tasks: entries,
  };
}

// Read-only shell projection: the same message ordering and identity rules the
// chat view uses, projected into task segments instead of pages.
function collectTaskIndex(scope, readMessages, getState, options = {}) {
  const messages = projectShellMessages(scope, readMessages, getState,
    { includeHidden: true, overlay: options.overlay });
  return buildTaskIndex({ shellId: scope?.shellId || scope?.id, messages, now: options.now,
    tasks: options.tasks, codeFor: options.codeFor, capabilitiesOf: options.capabilitiesOf,
    includeEmpty: options.includeEmpty === true });
}

module.exports = { buildTaskIndex, collectTaskIndex, MAX_TASKS, MAX_SEGMENTS_PER_TASK };

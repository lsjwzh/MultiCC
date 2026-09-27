'use strict';

// "This task has a result you have not looked at yet" — kept on the task
// record, so every client (Air tabs, PWA windows, the App) reads one answer.
//
//   task.attention = { kind: 'completed'|'error'|'waiting', at }
//       written when the run state moves INTO one of those outcomes (from a
//       different one). `at` is the server clock at that moment.
//   task.seenAt
//       written when someone opens the task (GET /api/air/tasks/:id/open,
//       which Web and App both call when a task is put on screen).
//
// The reminder is pending while attention.at > seenAt. A question that got
// answered (run state leaves `waiting`) no longer needs you, so that one is
// dropped outright; a finished or failed run stays until it is opened.
// Clients only decide how loudly to announce it — never whether it is unseen.

const RUN_STATE_KIND = Object.freeze({ succeeded: 'completed', error: 'error', waiting: 'waiting' });
const KINDS = new Set(Object.values(RUN_STATE_KIND));

function attentionKind(runState) {
  return RUN_STATE_KIND[String(runState || '')] || null;
}

/** Apply a run-state change to the task's attention mark. Returns true if it changed. */
function noteRunState(task, prevRunState, nextRunState, at = Date.now()) {
  if (!task) return false;
  const next = attentionKind(nextRunState);
  if (next && next !== attentionKind(prevRunState)) {
    task.attention = { kind: next, at: Math.max(Number(at) || 0, (Number(task.seenAt) || 0) + 1) };
    return true;
  }
  if (!next && task.attention?.kind === 'waiting') {
    delete task.attention;
    return true;
  }
  return false;
}

/** Record that the task was opened. Returns true only if that cleared a pending mark. */
function markSeen(task, at = Date.now()) {
  if (!pendingAttention(task)) return false;
  task.seenAt = Math.max(Number(at) || 0, Number(task.attention.at) || 0);
  return true;
}

/** The mark clients should show, or null. Archived tasks never ask for attention. */
function pendingAttention(task) {
  const mark = task?.attention;
  if (!mark || !KINDS.has(mark.kind) || task.status === 'archived') return null;
  const at = Number(mark.at) || 0;
  if (!(at > (Number(task.seenAt) || 0))) return null;
  return { kind: mark.kind, at };
}

/** Keep only well-formed fields when a persisted board is loaded. */
function normalizeAttention(source, task) {
  const mark = source?.attention;
  if (mark && KINDS.has(mark.kind) && Number(mark.at) > 0) {
    task.attention = { kind: mark.kind, at: Number(mark.at) };
  }
  if (Number(source?.seenAt) > 0) task.seenAt = Number(source.seenAt);
}

module.exports = { attentionKind, noteRunState, markSeen, pendingAttention, normalizeAttention };

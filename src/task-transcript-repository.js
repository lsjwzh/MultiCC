'use strict';

// M0 · Task transcript read-side projection (docs/chat-view-unification-design.md §3-M0).
//
// The task-run ledger (task-runs.sqlite) is the only durable source for a task
// virtual session: execution-slot chat history is destroyed on slot reset, so
// every reader — the task-mode chat view, the context compiler — must project
// from `task_run_messages`. This module is that projection, shaped as the
// chat-history message DTO so the session and task views share one contract.
// Pure and stateless: nothing here writes, and no ledger internals (lease,
// delivery ids, error codes) cross the boundary.

const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 100;

function assertTranscriptDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('task transcript dependencies are required');
  }
  if (!deps.taskRuns || typeof deps.taskRuns.listTaskRuns !== 'function'
      || typeof deps.taskRuns.getRunMessages !== 'function') {
    throw new TypeError('task transcript dependency missing: taskRuns');
  }
  for (const name of ['messageText', 'isWrapperText']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`task transcript dependency missing: ${name}`);
    }
  }
}

// Transport wrappers (compiled context wall / routed scaffold) are not
// conversation. The write-time metadata flag is the structural signal; the
// text predicate catches rows written before the flag existed. Assistant rows
// never count: the flag marks injected user transport, not model output.
function isWrapperLedgerMessage(message, messageText, isWrapperText) {
  if (!message || message.role !== 'user') return false;
  if (message.metadata?.wrapper === true) return true;
  return isWrapperText(messageText({ content: message.content }));
}

// Ledger row → chat DTO. Whitelist only: metadata carries internal fields
// (leaseEpoch, delivery ids, error codes) that must never reach a client.
function ledgerRowToChatMessage(message, taskRunId) {
  const projected = {
    id: message.messageId,
    role: message.role,
    content: message.content_text,
    ts: Number.isFinite(Number(message.createdAt)) ? Number(message.createdAt) : 0,
  };
  if (message.kind && message.kind !== 'message') projected.kind = message.kind;
  if (taskRunId) projected.taskRunId = taskRunId;
  const metadata = message.metadata || {};
  if (Array.isArray(metadata.tools) && metadata.tools.length) projected.tools = metadata.tools;
  // The sender's idempotency key: the front-end's staged-bubble commit loop
  // matches by clientMsgId, exactly like chat_msg_meta in session mode.
  if (metadata.clientMsgId) projected.clientMsgId = String(metadata.clientMsgId);
  if (metadata.usage && typeof metadata.usage === 'object') projected.usage = metadata.usage;
  if (metadata.cost != null) projected.cost = metadata.cost;
  if (Number.isFinite(Number(metadata.durationMs))) projected.durationMs = Number(metadata.durationMs);
  if (metadata.partial === true) projected.partial = true;
  return projected;
}

// Full transcript for one task: every ledger row across every run, wrappers
// dropped, oldest first (listTaskRuns is started_at-ascending, getRunMessages
// is sequence-ascending; the final ts sort makes cross-run interleaving safe).
function taskTranscriptMessages(deps, taskId) {
  assertTranscriptDeps(deps);
  const { taskRuns, messageText, isWrapperText } = deps;
  const projected = [];
  for (const run of taskRuns.listTaskRuns(taskId)) {
    for (const message of taskRuns.getRunMessages(run.runId)) {
      if (isWrapperLedgerMessage(message, messageText, isWrapperText)) continue;
      projected.push(ledgerRowToChatMessage({
        ...message,
        content_text: messageText({ content: message.content }),
      }, run.runId));
    }
  }
  projected.sort((left, right) => (left.ts || 0) - (right.ts || 0));
  return projected;
}

// Pagination with the exact semantics of the session history route
// (src/routes/chat-history.js paginate): tail page by default, `before` pages
// strictly older, `around` centres a window on one id, size clamped to
// 1..100. Kept shape-compatible so one frontend drives both views.
function paginateTranscript(messages, { before, around, limit } = {}) {
  const pageSize = Math.max(1, Math.min(
    MAX_PAGE_SIZE, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  if (around) {
    const targetId = String(around).slice(0, 160);
    const targetIndex = messages.findIndex(message => message.id === targetId);
    if (targetIndex < 0) {
      return { messages: [], hasMore: false, before: null, found: false, hasNewer: false };
    }
    const halfWindow = Math.floor((pageSize - 1) / 2);
    let start = Math.max(0, targetIndex - halfWindow);
    const end = Math.min(messages.length, start + pageSize);
    start = Math.max(0, end - pageSize);
    return {
      messages: messages.slice(start, end),
      hasMore: start > 0,
      before: start > 0 ? messages[start].id : null,
      found: true,
      hasNewer: end < messages.length,
    };
  }
  let end = messages.length;
  if (before) {
    const index = messages.findIndex(message => message.id === String(before).slice(0, 160));
    if (index < 0) return { messages: [], hasMore: false, before: null };
    end = index;
  }
  const start = Math.max(0, end - pageSize);
  return {
    messages: messages.slice(start, end),
    hasMore: start > 0,
    before: start > 0 ? messages[start].id : null,
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  isWrapperLedgerMessage,
  ledgerRowToChatMessage,
  paginateTranscript,
  taskTranscriptMessages,
};

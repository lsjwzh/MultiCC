'use strict';

const { hash } = require('./context');

// Canonical history stays on the execution that produced it. Task ownership is
// an annotation, so a task's evidence can span several execution transcripts.
function shellRecords(scope, read, getState) {
  return scope.sessionIds.flatMap(sourceSessionId => {
    const records = read(sourceSessionId);
    const activeStart = getState?.(sourceSessionId)?.isStreaming
      ? records.findLastIndex(m => m.role === 'user') : -1;
    return records.map((m, index) => ({ ...m, sourceSessionId, sourceMessageId: m.id,
      contextMessageId: `${sourceSessionId}:${m.id}`,
      ...(activeStart >= 0 && index >= activeStart ? { inProgress: true } : {}),
    }));
  }).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

function excerpt(message, maxChars) {
  const fields = ['id', 'role', 'taskId', 'turnId', 'ts', 'partial', 'error', 'cancelled', '_interim', 'inProgress',
    'sourceSessionId', 'sourceMessageId', 'contextMessageId', 'sourceWorkspace'];
  const result = Object.fromEntries(fields.filter(k => message[k] !== undefined).map(k => [k, message[k]]));
  const text = JSON.stringify({ content: message.content, tools: message.tools });
  if (text.length <= maxChars) return { ...result, content: message.content, tools: message.tools };
  return { ...result, evidenceExcerpt: text.slice(0, maxChars), truncated: true,
    nextOffset: maxChars, totalChars: text.length };
}

function historySnapshot(taskId, records) {
  const selected = records.slice(-10);
  if (selected.length && !selected.some(m => m.role === 'user')) {
    const request = records.findLast(m => m.role === 'user');
    if (request) selected[0] = request;
  }
  const maxChars = Math.floor(12000 / Math.max(1, selected.length));
  const value = { version: 2, taskId, messages: selected.map(m => excerpt(m, maxChars)),
    omittedMessages: records.length - selected.length };
  return { ...value, hash: hash(value) };
}

function handoffSnapshot(taskId, history, { turnId, anchorMessageId, sessionId, sourceWorkspace, receipt }) {
  const end = history.findIndex(m => m.id === anchorMessageId);
  const candidates = end >= 0 ? history.slice(0, end + 1) : history;
  let selected = candidates.filter(m => turnId ? m.turnId === turnId : m.clientMsgId === receipt.id);
  if (!selected.length && end >= 0 && !history[end].turnId) {
    const start = candidates.findLastIndex(m => m.role === 'user');
    selected = candidates.slice(Math.max(0, start));
  }
  const records = selected
    .map(m => ({ ...m, taskId, sourceSessionId: sessionId, sourceWorkspace, sourceMessageId: m.id,
      contextMessageId: `${sessionId}:${m.id}` }));
  // A failed turn may have no assistant record. Its admitted request is still
  // real context and must never be replaced with an unrelated older exchange.
  if (!records.some(m => m.role === 'user')) records.unshift({ role: 'user', content: receipt.payload.text,
    taskId, turnId, sourceSessionId: sessionId, receiptId: receipt.id });
  return historySnapshot(taskId, records);
}

function contextPage(records, { task_id, before, message_id, offset = 0, limit = 5 } = {}) {
  const selected = task_id ? records.filter(m => m.taskId === task_id) : records;
  if (message_id) {
    const message = selected.find(m => m.contextMessageId === message_id);
    if (!message) return { found: false, messages: [] };
    const text = JSON.stringify({ content: message.content, tools: message.tools });
    const end = Math.min(text.length, offset + 12000);
    return { found: true, message: { ...excerpt(message, 0), evidenceExcerpt: text.slice(offset, end),
      offset, nextOffset: end < text.length ? end : null, truncated: end < text.length } };
  }
  const end = before ? selected.findIndex(m => m.contextMessageId === before) : selected.length;
  if (end < 0) return { found: false, messages: [] };
  const start = Math.max(0, end - limit);
  return { found: true, messages: selected.slice(start, end).map(m => excerpt(m, Math.floor(24000 / limit))),
    hasMore: start > 0, before: selected[start]?.contextMessageId || null };
}

function pageSnapshots(page) {
  const groups = new Map();
  for (const message of page.messages || (page.message ? [page.message] : [])) {
    const id = message.taskId || null;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(message);
  }
  return [...groups].map(([taskId, messages]) => {
    const value = { version: 2, taskId, messages };
    return { ...value, hash: hash(value) };
  });
}

module.exports = { shellRecords, historySnapshot, handoffSnapshot, contextPage, pageSnapshots };

'use strict';

const { buildReplayMessages } = require('../routes/chat-history');

// A shell is a display projection, not another transcript writer. Canonical
// messages, visibility decisions and native contexts remain owned by executions.
function projectShellMessages(scope, readMessages, getState, options = {}) {
  const messages = [];
  const now = Date.now();
  for (const sessionId of scope.sessionIds) {
    const state = getState?.(sessionId);
    const records = readMessages(sessionId, options.includeHidden === true);
    const replay = state?.isStreaming ? buildReplayMessages(records, state, () => now) : records;
    for (let index = 0; index < replay.length; index += 1) {
      const m = replay[index];
      const sourceMessageId = m.id || `live-${state?._currentTaskId || 'turn'}`;
      messages.push({ ...m, id: `${sessionId}:${sourceMessageId}`, sourceSessionId: sessionId,
        sourceMessageId, streaming: sessionId === options.activeSessionId && m.streaming === true });
    }
  }
  messages.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0)
    || Number(a.streaming) - Number(b.streaming));
  // Effective attribution (manual re-attribution overlay) is applied here so
  // every projection — page, index, task detail — agrees on which task a turn
  // currently answers to. The canonical transcript is never rewritten.
  return typeof options.overlay === 'function' ? options.overlay(messages) : messages;
}

function shellHistoryPage(scope, readMessages, getState, options = {}) {
  const messages = projectShellMessages(scope, readMessages, getState, options);
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 5));
  const target = options.around || options.before;
  const cursor = target ? messages.findIndex(m => m.id === target || m.sourceMessageId === target) : -1;
  if (target && cursor < 0) return { messages: [], hasMore: false, found: false };
  const end = options.around ? Math.min(messages.length, cursor + Math.ceil(limit / 2))
    : options.before ? cursor : messages.length;
  const start = Math.max(0, end - limit);
  return { messages: JSON.parse(JSON.stringify(messages.slice(start, end))), hasMore: start > 0,
    ...(options.around ? { found: true, hasNewer: end < messages.length } : {}) };
}

// "Keep the latest N" in a shell means the latest N of the merged timeline the
// user is looking at, not N per execution. Each source still owns its own
// visibility record, so the cut is written back per source session. `hide` is
// the durable history mutation: it resolves only after that session's queue has
// persisted the batch, so the counts below are the committed ones.
async function clearShellHistory(scope, readMessages, hide, keep = 0) {
  const visible = projectShellMessages(scope, readMessages, null)
    .filter(m => !m._interim && m.sourceMessageId && !String(m.sourceMessageId).startsWith('live-'));
  const removed = visible.slice(0, Math.max(0, visible.length - Math.max(0, keep)));
  const bySession = new Map();
  for (const m of removed) {
    if (!bySession.has(m.sourceSessionId)) bySession.set(m.sourceSessionId, []);
    bySession.get(m.sourceSessionId).push(m.sourceMessageId);
  }
  let removedCount = 0;
  for (const [sessionId, ids] of bySession) removedCount += Number(await hide(sessionId, ids)) || 0;
  return { keep, removedCount, retainedCount: visible.length - removedCount };
}

function watchShellHistory(scope, activeSessionId, { subscribe, readMessages, getState, emit }) {
  if (!subscribe) return () => {};
  const pending = new Set();
  let timer = null;
  const unsubscribe = subscribe((id, event) => {
    if (id === activeSessionId || !scope.sessionIds.includes(id)
        || ['progress_heartbeat', 'typing', 'task_state'].includes(event.type)) return;
    if (event.type === 'chat_msg_deleted') {
      emit({ ...event, sourceSessionId: id }); return;
    }
    pending.add(id);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const sessionId of pending) {
        try {
          const page = shellHistoryPage({ sessionIds: [sessionId] }, readMessages, getState, { limit: 5 });
          emit({ type: 'shell_history_update', sourceSessionId: sessionId, messages: page.messages });
        } catch (_) { /* Reconnect replays durable history if a session was removed. */ }
      }
      pending.clear();
    }, 250);
    timer.unref?.();
  });
  return () => { unsubscribe(); clearTimeout(timer); pending.clear(); };
}

module.exports = { clearShellHistory, projectShellMessages, shellHistoryPage, watchShellHistory };

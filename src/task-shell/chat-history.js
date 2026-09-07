'use strict';

const { buildReplayMessages } = require('../routes/chat-history');

// A shell is a display projection, not another transcript writer. Canonical
// messages, visibility decisions and native contexts remain owned by executions.
function shellHistoryPage(scope, readMessages, getState, options = {}) {
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

module.exports = { shellHistoryPage, watchShellHistory };

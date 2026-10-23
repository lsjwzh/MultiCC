'use strict';
const { shellRecords } = require('./history-context');
const { getNative } = require('../native/runtime');
const fail = (code, status = 403) => Object.assign(new Error(code), { code, status });

// Compatibility bridge: task-shell storage and history ports are still Node-owned.
// Keep only port I/O and result reattachment here until Rust owns those stores;
// Rust already plans and selects every explicit read.
// Reading history never grants task ownership or changes a shell cursor.
function relatedHistory({ store, targetId, getTask, getRecord, getHistory, getLiveState, isDeletedTask }) {
  if (isDeletedTask?.(targetId)) throw fail('task_not_found', 404);
  const target = store.get('task', targetId) || getTask(targetId);
  if (!target) throw fail('task_not_found', 404);
  const addon = getNative('task_context', 'rust');
  const plan = JSON.parse(addon.planTaskContextRead(JSON.stringify({
    target: { id: target.id, sessionId: target.sessionId, chatSessionId: target.chatSessionId,
      historySessionIds: target.historySessionIds, refs: target.refs?.map(ref => ({ sessionId: ref.sessionId })) },
    links: store.list('link').map(({ shellId, taskId }) => ({ shellId, taskId })),
    shells: store.list('shell').map(({ id, sourceSessionId }) => ({ id, sourceSessionId })),
    tasks: store.list('task').map(({ id, sessionId }) => ({ id, sessionId })),
  })));
  const sessionIds = plan.sessionIds.filter(id => getRecord(id));
  const records = shellRecords({ sessionIds }, getHistory, getLiveState);
  const bindings = sessionIds.map(sessionId => ({ sessionId, taskBoundTaskId: getRecord(sessionId).taskBoundTaskId }));
  // Send only ownership metadata across NAPI, not potentially large transcripts.
  const selected = JSON.parse(addon.selectTaskContextRecords(JSON.stringify({ targetId, bindings,
    records: records.map(({ taskId, sourceSessionId }, index) => ({ index, taskId, sourceSessionId })),
  })));
  return selected.map(({ index, taskId }) => ({ ...records[index], taskId }));
}
module.exports = { relatedHistory };

'use strict';
const { verifySnapshot } = require('./context');
const { shellRecords } = require('./history-context');
const fail = (code, status = 403) => Object.assign(new Error(code), { code, status });

// Related-history reads confer no ownership/link and never move a shell cursor.
function relatedHistory({ store, task, targetId, getTask, getRecord, getHistory, getLiveState, graph, taskDirectory, isDeletedTask }) {
  if (isDeletedTask?.(targetId)) throw fail('task_not_found', 404);
  const target = store.get('task', targetId) || getTask(targetId);
  const dirId = target?.dirId || (target && taskDirectory?.(target));
  if (!target || dirId !== task.dirId) throw fail('project_mismatch');
  const snapshots = (task.snapshotIds || []).map(id => {
    const snapshot = store.get('snapshot', id);
    if (!verifySnapshot(snapshot, id)) throw fail('snapshot_unverified');
    return snapshot;
  });
  if (task.separatedFromTaskId === targetId) {
    // Separation imported only the judged exchange, not the source task's archive.
    return snapshots.flatMap(snapshot => snapshot.messages).flatMap(m => {
      const record = getRecord(m.sourceSessionId);
      if (record?.dirId !== task.dirId || !m.sourceMessageId) return [];
      const original = getHistory(m.sourceSessionId).find(row => row.id === m.sourceMessageId);
      return original ? [{ ...original, taskId: targetId, sourceSessionId: m.sourceSessionId,
        sourceMessageId: original.id, contextMessageId: `${m.sourceSessionId}:${original.id}` }] : [];
    });
  }
  const allowed = targetId === task.parentTaskId || targetId === task.forkedFromTaskId
    || snapshots.some(s => s.taskId === targetId)
    || (graph?.candidates || graph?.sources || []).some(s => s.taskId === targetId && ['parent', 'grandparent', 'group', 'shell'].includes(s.kind));
  if (!allowed) throw fail('task_not_linked');
  const links = store.list('link'), ownerIds = new Set(links.filter(l => l.taskId === targetId).map(l => l.shellId));
  const scopeTaskIds = new Set(links.filter(l => ownerIds.has(l.shellId)).map(l => l.taskId));
  const sessionIds = [...new Set([target.sessionId, target.chatSessionId, ...(target.historySessionIds || []),
    ...(target.refs || []).map(r => r.sessionId),
    ...store.list('shell').filter(s => ownerIds.has(s.id)).map(s => s.sourceSessionId),
    ...store.list('task').filter(t => scopeTaskIds.has(t.id)).map(t => t.sessionId),
  ])].filter(id => id && getRecord(id)?.dirId === task.dirId);
  return shellRecords({ sessionIds }, getHistory, getLiveState).filter(m => m.taskId === targetId
    || (!m.taskId && getRecord(m.sourceSessionId)?.taskBoundTaskId === targetId));
}
module.exports = { relatedHistory };

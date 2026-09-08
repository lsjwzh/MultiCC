'use strict';

const { hash } = require('./context');
const { historySnapshot, shellRecords } = require('./history-context');
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });

// A board entry is a read capability. Only an independent task has a writable
// board entry; opening a conversation task never changes its shell cursor.
function createTaskActions({ store, getRecord, getTask, getHistory, getExecution, createExecution, indexTask, ports, shell, open, chatScope }) {
  const forks = new Map();
  function findTask(id) {
    const task = store.get('task', id) || getTask(id);
    if (!task) throw fail('task_not_found', 'Task not found', 404);
    return task;
  }
  function ownerOf(task) {
    if (task.ownerShellId) return shell(task.ownerShellId);
    const link = store.list('link').find(l => l.taskId === task.id);
    if (link) return shell(link.shellId);
    const sid = task.sessionId || task.chatSessionId || task.refs?.find(r => getRecord(r.sessionId))?.sessionId;
    const record = sid && getRecord(sid);
    // Historical board tasks may reference reusable execution slots or legacy
    // experiments. They have no ordinary chat shell; never call open() for them
    // during a board read, where one unsupported source would abort every row.
    if (!record || record.kind !== 'chat' || record.taskExecutionSlot || record.experimentalMode
      || ['commander', 'gateway', 'aux'].includes(record.type)) return null;
    return open(sid);
  }
  function access(taskOrId) {
    const task = typeof taskOrId === 'string' ? findTask(taskOrId) : store.get('task', taskOrId.id) || taskOrId;
    const owner = ownerOf(task);
    return { readOnly: owner ? !owner.standalone : task.origin !== 'board', ownerShellId: owner?.id || null,
      sourceSessionId: owner?.sourceSessionId || null, forkedFromTaskId: task.forkedFromTaskId || null };
  }
  async function taskEntry(id) {
    const task = findTask(id), a = access(task), owner = a.ownerShellId && shell(a.ownerShellId);
    const sid = [task.sessionId, task.chatSessionId, a.sourceSessionId].find(id => id && getRecord(id)) || null;
    const scope = owner ? chatScope(owner.id) : { sessionIds: [...new Set((task.refs || []).map(r => r.sessionId))] };
    if (sid && !scope.sessionIds.includes(sid)) scope.sessionIds.push(sid);
    const inherited = task.forkedFromTaskId ? (task.snapshotIds || []).flatMap(id => store.get('snapshot', id)?.messages || []).map(m => ({ ...m, inherited: true, content: m.content || m.evidenceExcerpt || '' })) : [];
    const messages = inherited.concat(shellRecords(scope, getHistory, ports.getLiveState)
      .filter(m => m.taskId === id || (!m.taskId && m.sourceSessionId === sid)));
    const execution = sid && getRecord(sid) ? await getExecution(sid) : { busy: false, status: 'idle' };
    return { ok: true, task: { id, title: task.title, ...a }, messages, execution,
      sessionId: sid, ...a, url: `/task-shell.html?task=${encodeURIComponent(id)}&board=1`,
      returnUrl: a.sourceSessionId ? `/chat.html?session=${encodeURIComponent(a.sourceSessionId)}` : null };
  }
  function assertBoardWritable(id) {
    if (access(id).readOnly) throw fail('task_board_read_only', 'Return to the original conversation or fork an independent task');
  }
  async function forkTask(id, input = {}) {
    if (typeof input.clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(input.clientMsgId)) throw fail('invalid_input', 'clientMsgId required', 400);
    const key = `fork_${hash([id, input.clientMsgId]).slice(0, 40)}`;
    if (forks.has(key)) return forks.get(key);
    const operation = (async () => {
      let receipt = store.get('fork', key);
      if (receipt?.result) return receipt.result;
      const source = findTask(id), owner = ownerOf(source);
      if (!owner) throw fail('source_session_missing');
      let task = receipt && store.get('task', receipt.taskId);
      if (!task) {
        if (store.list('task').filter(t => t.dirId === owner.dirId).length >= 200) throw fail('task_shell_task_limit');
        const entry = await taskEntry(id);
        if (entry.execution.busy !== false) throw fail('fork_source_busy', 'Wait for the source task to finish before forking');
        if (!ports.captureForkBaseline) throw fail('fork_unavailable');
        const captured = await ports.captureForkBaseline(source, owner, async () => historySnapshot(id, (await taskEntry(id)).messages));
        const { history, ...baseline } = captured;
        const snapshot = history || historySnapshot(id, entry.messages);
        const taskId = `tsk_${hash(key).slice(0, 32)}`, sessionId = `task-${taskId.slice(4)}`;
        const shellId = `sh_${hash(sessionId).slice(0, 24)}`;
        const record = [source.sessionId, source.chatSessionId, owner.sourceSessionId].map(id => getRecord(id)).find(Boolean);
        task = { id: taskId, dirId: owner.dirId, sessionId, ownerShellId: shellId,
          title: source.title || id, forkedFromTaskId: id, parentTaskId: id,
          ready: false, createdAt: Date.now(), snapshotIds: [snapshot.hash], forkBaseline: baseline,
          runtime: Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent'].filter(k => record?.[k] !== undefined).map(k => [k, record[k]])) };
        store.transaction(() => {
          store.set('snapshot', snapshot.hash, snapshot);
          store.set('task', task.id, task);
          store.set('shell', shellId, { id: shellId, sourceSessionId: sessionId, dirId: owner.dirId,
            standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: task.createdAt });
          store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
          receipt = { id: key, taskId: task.id, sourceTaskId: id, status: 'creating' };
          store.set('fork', key, receipt);
        });
      }
      try {
        if (!task.ready) {
          const created = await createExecution(task, task.runtime);
          if (!created?.ok) throw fail(created?.code || 'execution_create_failed');
          task.ready = true; task.baseline = created.baseline; store.set('task', task.id, task);
        }
        const indexed = await indexTask(task);
        if (!indexed?.ok) throw fail('task_index_failed');
        receipt.status = 'ready';
        receipt.result = { ok: true, taskId: task.id, sessionId: task.sessionId, shellId: task.ownerShellId,
          url: `/task-shell.html?task=${encodeURIComponent(task.id)}&board=1` };
        store.set('fork', key, receipt);
        return receipt.result;
      } catch (error) {
        receipt.status = 'failed'; receipt.code = error.code || 'fork_failed'; store.set('fork', key, receipt);
        throw error;
      }
    })();
    forks.set(key, operation);
    try { return await operation; } finally { forks.delete(key); }
  }
  return { ownerOf, taskEntry, taskAccess: access, assertBoardWritable, forkTask };
}
module.exports = { createTaskActions };

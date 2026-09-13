'use strict';

const { hash } = require('./context');
const { historySnapshot, shellRecords } = require('./history-context');
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });

// Explicit task entry preserves identity; it never follows a conversation cursor.
function createTaskActions({ store, getRecord, getTask, getHistory, getExecution, createExecution, indexTask, ports, shell, open, chatScope }) {
  const forks = new Map();
  function findTask(id) {
    if (ports.isDeletedTask?.(id)) throw fail('task_not_found', 'Task not found', 404);
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
      || ['gateway', 'aux'].includes(record.type) || (record.type === 'commander' && !ports.taskFirst)) return null;
    return open(sid);
  }
  function access(taskOrId) {
    const task = typeof taskOrId === 'string' ? findTask(taskOrId) : store.get('task', taskOrId.id) || taskOrId;
    const owner = ownerOf(task);
    const lifecycle = getTask(task.id) || task;
    return { status: lifecycle.status || 'active', readOnly: lifecycle.status === 'archived' || lifecycle.deleting === true || (owner ? !owner.standalone && !task.taskFirst : task.origin !== 'board'), ownerShellId: owner?.id || null,
      sourceSessionId: owner?.sourceSessionId || null, forkedFromTaskId: task.forkedFromTaskId || null };
  }
  async function taskEntry(id) {
    const task = findTask(id), lifecycle = getTask(id) || task;
    const a = access(task), owner = a.ownerShellId && shell(a.ownerShellId);
    const sid = [task.sessionId, task.chatSessionId, a.sourceSessionId].find(id => id && getRecord(id)) || null;
    const scope = owner ? chatScope(owner.id) : { sessionIds: [...new Set((task.refs || []).map(r => r.sessionId))] };
    if (sid && !scope.sessionIds.includes(sid)) scope.sessionIds.push(sid);
    for (const source of task.historySessionIds || []) if (!scope.sessionIds.includes(source)) scope.sessionIds.push(source);
    const inherited = task.forkedFromTaskId ? (task.snapshotIds || []).flatMap(id => store.get('snapshot', id)?.messages || []).map(m => ({ ...m, inherited: true, content: m.content || m.evidenceExcerpt || '' })) : [];
    const messages = inherited.concat(shellRecords(scope, getHistory, ports.getLiveState)
      .filter(m => m.taskId === id || (!m.taskId && m.sourceSessionId === sid)));
    const execution = sid && getRecord(sid) ? await getExecution(sid) : { busy: false, status: 'idle' };
    return { ok: true, task: { id, title: lifecycle.title || task.title,
      recordType: lifecycle.recordType || task.recordType || null,
      description: lifecycle.description || task.description || '',
      acceptanceCriteria: lifecycle.acceptanceCriteria || task.acceptanceCriteria || '',
      workflowStage: lifecycle.workflowStage || task.workflowStage || null,
      planningRevision: lifecycle.planningRevision ?? task.planningRevision ?? null,
      priority: lifecycle.priority || task.priority || null, dueAt: lifecycle.dueAt || task.dueAt || null,
      ...a }, messages, execution,
      sessionId: sid, ...a, url: `/task-shell.html?task=${encodeURIComponent(id)}&board=1`,
      returnUrl: a.sourceSessionId ? `/chat.html?session=${encodeURIComponent(a.sourceSessionId)}` : null };
  }
  async function bindPlannedTask(id) {
    const existing = store.get('task', id), indexed = findTask(id), lifecycle = getTask(id) || indexed;
    if ((existing?.ready && !existing.bindingPending) || lifecycle.status === 'archived' || lifecycle.deleting) return taskEntry(id);
    // A historical task with an existing execution cannot be rebound by a read.
    if (!existing && indexed.chatSessionId) return taskEntry(id);
    const dirId = existing?.dirId || ports.taskDirectory?.(indexed) || indexed.dirId;
    if (!dirId || !ports.getDirectory?.(dirId)) return taskEntry(id);
    const key = `task-bind:${id}`;
    if (forks.has(key)) return forks.get(key);
    const operation = (async () => {
      let task = store.get('task', id);
      if (!task) {
        const history = await taskEntry(id), snapshot = historySnapshot(id, history.messages);
        const sessionId = `task-${id.replace(/^tsk_/, '')}`, shellId = `sh_${hash(sessionId).slice(0, 24)}`;
        if (getRecord(sessionId)) throw fail('task_identity_mismatch');
        task = { id, dirId, title: indexed.title || id, sessionId, ownerShellId: shellId,
          taskFirst: true, ready: false, bindingPending: true, createdAt: indexed.createdAt || Date.now(),
          historySessionIds: [...new Set((indexed.refs || []).map(r => r.sessionId))],
          snapshotIds: snapshot.messages.length ? [snapshot.hash] : [], runtime: ports.defaultTaskRuntime?.(indexed) || { cli: 'claude' } };
        store.transaction(() => {
          if (snapshot.messages.length) store.set('snapshot', snapshot.hash, snapshot);
          store.set('task', id, task);
          store.set('shell', shellId, { id: shellId, sourceSessionId: sessionId, dirId,
            standalone: true, currentTaskId: id, defaultTaskId: id, cursorVersion: 0, createdAt: task.createdAt });
          store.set('link', `${shellId}:${id}`, { shellId, taskId: id });
        });
      }
      if (!task.ready) {
        const created = await createExecution(task, task.runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed');
        task.ready = true; task.baseline = created.baseline; store.set('task', id, task);
      }
      if (!(await indexTask(task))?.ok) throw fail('task_index_failed');
      delete task.bindingPending; store.set('task', id, task);
      return taskEntry(id);
    })();
    forks.set(key, operation);
    try { return await operation; } finally { forks.delete(key); }
  }
  function assertBoardWritable(id) {
    if (access(id).readOnly) throw fail('task_board_read_only', 'Return to the original conversation or fork an independent task');
  }
  async function forkTask(id, input = {}) {
    if (ports.isTaskLifecycleBusy?.(id)) throw fail('task_busy');
    if (getTask(id)?.status === 'archived' || getTask(id)?.deleting) throw fail('task_archived');
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
        task = { id: taskId, dirId: owner.dirId, sessionId, ownerShellId: shellId, taskFirst: true,
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
  async function createStandalone(input = {}) {
    if (typeof input.clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(input.clientMsgId)
        || typeof input.dirId !== 'string' || !ports.getDirectory?.(input.dirId)
        || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120) throw fail('invalid_input', 'Directory, title and clientMsgId required', 400);
    const runtime = Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent', 'subagent', 'rolePrompt', 'rolePresetId']
      .filter(k => input[k] !== undefined).map(k => [k, input[k]]));
    if (!runtime.cli) runtime.cli = 'claude';
    const checked = await ports.validateTaskRuntime?.(input.dirId, runtime);
    if (checked?.ok === false) throw fail('invalid_configuration', checked.error || 'Invalid AI configuration', 400);
    const key = `create_${hash([input.dirId, input.clientMsgId]).slice(0, 40)}`;
    const fingerprint = hash([input.title.trim(), runtime]);
    if (forks.has(key)) { await forks.get(key); return createStandalone(input); }
    const operation = (async () => {
      let receipt = store.get('task-create', key);
      if (receipt && receipt.fingerprint !== fingerprint) throw fail('idempotency_conflict');
      if (receipt?.result) return receipt.result;
      let task = receipt && store.get('task', receipt.taskId);
      if (!task) store.transaction(() => {
        if (store.list('task').filter(t => t.dirId === input.dirId).length >= 200) throw fail('task_shell_task_limit');
        const taskId = `tsk_${hash(key).slice(0, 32)}`, sessionId = `task-${taskId.slice(4)}`, shellId = `sh_${hash(sessionId).slice(0, 24)}`;
        task = { id: taskId, dirId: input.dirId, title: input.title.trim(), sessionId, ownerShellId: shellId, taskFirst: true,
          snapshotIds: [], ready: false, createdAt: Date.now(), runtime };
        store.set('task', task.id, task);
        store.set('shell', shellId, { id: shellId, sourceSessionId: sessionId, dirId: task.dirId,
          standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: task.createdAt });
        store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
        receipt = { taskId: task.id, fingerprint }; store.set('task-create', key, receipt);
      });
      // This creates execution metadata only; its workspace remains planned.
      if (!task.ready) {
        const created = await createExecution(task, runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed', created?.error || 'Invalid AI configuration', 400);
        task.ready = true; task.baseline = created.baseline; store.set('task', task.id, task);
      }
      if (!(await indexTask(task))?.ok) throw fail('task_index_failed');
      receipt.result = { ok: true, taskId: task.id, sessionId: task.sessionId, shellId: task.ownerShellId,
        url: `/air?task=${encodeURIComponent(task.id)}&dir=${encodeURIComponent(task.dirId)}` };
      store.set('task-create', key, receipt); return receipt.result;
    })();
    forks.set(key, operation);
    try { return await operation; } finally { forks.delete(key); }
  }
  return { ownerOf, taskEntry, bindPlannedTask, taskAccess: access, assertBoardWritable, forkTask, createStandalone };
}
module.exports = { createTaskActions };

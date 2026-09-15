'use strict';
const { hash } = require('./context');
const { handoffSnapshot } = require('./history-context');
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });

// A suggestion never changes attribution, the shell cursor, or execution state.
// Confirmation creates an independent continuation with only the judged turn.
function createTaskSeparation({ store, getRecord, getHistory, getExecution, createExecution, indexTask, ports, ownerOf }) {
  const flights = new Map();
  function changed(sessionId) {
    try { ports.onSeparationChanged?.(sessionId); } catch (error) { console.warn('[task-separation] notification failed', error.message); }
  }
  function sourceOf(sessionId, receiptId) {
    const receipt = store.get('receipt', receiptId);
    const source = receipt && store.get('task', receipt.taskId);
    if (!source || source.sessionId !== sessionId) throw fail('separation_not_found', 'Separation suggestion not found', 404);
    return { receipt, source, shell: store.get('shell', receipt.shellId) };
  }
  function current(suggestion) {
    const { receipt, source, shell } = sourceOf(suggestion.sessionId, suggestion.receiptId);
    if (ports.isDeletedTask?.(source.id) || ports.getTask?.(source.id)?.status === 'archived'
        || shell?.currentTaskId !== source.id || shell?.cursorReceiptId !== receipt.id
        || shell?.cursorVersion !== suggestion.cursorVersion) return false;
    const last = getHistory(source.sessionId).findLast(m => ['user', 'assistant'].includes(m.role) && m.content);
    return !!last && last.id === suggestion.anchorMessageId;
  }
  function propose(sessionId, receiptId, input) {
    if (!input.separation?.title || !input.turnId || !input.anchorMessageId) return null;
    const { receipt, source, shell } = sourceOf(sessionId, receiptId);
    const history = getHistory(sessionId);
    const start = history.findIndex(m => m.role === 'user' && (m.clientMsgId === receipt.id || m.turnId === input.turnId));
    // First turns have no previous work to separate from. System injections do
    // not count as a preceding user goal.
    if (start <= 0 || !history.slice(0, start).some(m => m.role === 'user' && !m.displayOnly && m.content)) return null;
    const id = `sep_${hash([sessionId, receiptId, input.turnId]).slice(0, 32)}`;
    const old = store.get('task-separation', id);
    if (old) return old;
    const title = String(input.separation.title).trim().slice(0, 120);
    if (store.list('task-separation').some(s => s.sourceTaskId === source.id && s.title === title && s.state === 'kept')) return { state: 'kept' };
    const suggestion = { id, sessionId, receiptId, sourceTaskId: source.id, sourceTitle: source.title,
      title, reason: String(input.separation.reason || '').slice(0, 240), turnId: input.turnId,
      anchorMessageId: input.anchorMessageId, cursorVersion: shell?.cursorVersion,
      state: 'pending', createdAt: Date.now() };
    if (!current(suggestion)) return null;
    store.set('task-separation', id, suggestion);
    changed(sessionId);
    return suggestion;
  }
  function latest(sessionId) {
    const suggestion = store.list('task-separation').filter(s => s.sessionId === sessionId).at(-1);
    if (!suggestion || suggestion.state !== 'pending' || (!suggestion.taskId && !current(suggestion))) return null;
    return suggestion;
  }
  async function decide(sessionId, id, decision) {
    if (!['separate', 'keep'].includes(decision)) throw fail('invalid_input', 'decision must be separate or keep', 400);
    const suggestion = store.get('task-separation', id);
    if (!suggestion || suggestion.sessionId !== sessionId) throw fail('separation_not_found', 'Separation suggestion not found', 404);
    if (flights.has(id)) { await flights.get(id); return decide(sessionId, id, decision); }
    if (suggestion.state === 'separated') {
      if (decision !== 'separate') throw fail('separation_already_resolved');
      return suggestion.result;
    }
    if (suggestion.state === 'kept') {
      if (decision !== 'keep') throw fail('separation_already_resolved');
      return { ok: true, decision: 'keep' };
    }
    if (!suggestion.taskId && !current(suggestion)) throw fail('separation_stale', 'The conversation has advanced; this suggestion has expired');
    if (decision === 'keep') {
      if (suggestion.taskId) throw fail('separation_already_confirmed', 'Separation was already confirmed; retry to finish creating the task');
      store.set('task-separation', id, { ...suggestion, state: 'kept', resolvedAt: Date.now() });
      changed(sessionId);
      return { ok: true, decision };
    }
    const operation = (async () => {
      const { receipt, source } = sourceOf(sessionId, suggestion.receiptId);
      if (ports.isTaskLifecycleBusy?.(source.id) || (await getExecution(sessionId)).busy !== false) throw fail('fork_source_busy', 'Wait for this task to finish before separating');
      let task = suggestion.taskId && store.get('task', suggestion.taskId);
      if (!task) {
        if (store.list('task').filter(t => t.dirId === source.dirId).length >= 200) throw fail('task_shell_task_limit');
        if (!ports.captureForkBaseline) throw fail('fork_unavailable');
        const taskId = `tsk_${hash(id).slice(0, 32)}`, nextSessionId = `task-${taskId.slice(4)}`, shellId = `sh_${hash(nextSessionId).slice(0, 24)}`;
        const captured = await ports.captureForkBaseline(source, ownerOf(source), () => {
          if (!current(suggestion)) throw fail('separation_stale');
          return handoffSnapshot(taskId, getHistory(sessionId), { ...suggestion, receipt,
            sourceWorkspace: getRecord(sessionId)?.worktreePath });
        });
        if (!current(suggestion)) throw fail('separation_stale');
        const { history: snapshot, ...baseline } = captured;
        if (!snapshot) throw fail('separation_context_missing');
        const record = getRecord(sessionId);
        task = { id: taskId, dirId: source.dirId, sessionId: nextSessionId, ownerShellId: shellId,
          title: suggestion.title, taskFirst: true, separatedFromTaskId: source.id,
          ready: false, snapshotIds: [snapshot.hash], forkBaseline: baseline, createdAt: Date.now(),
          runtime: { ...source.runtime, ...Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent']
            .filter(k => record?.[k] !== undefined).map(k => [k, record[k]])) } };
        store.transaction(() => {
          store.set('snapshot', snapshot.hash, snapshot);
          store.set('task', task.id, task);
          store.set('shell', shellId, { id: shellId, sourceSessionId: nextSessionId, dirId: task.dirId,
            standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: task.createdAt });
          store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
          suggestion.taskId = task.id;
          store.set('task-separation', id, suggestion);
        });
      }
      if (!task.ready) {
        const created = await createExecution(task, task.runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed', created?.error || 'Execution creation failed');
        task.ready = true; task.baseline = created.baseline; store.set('task', task.id, task);
      }
      if (!(await indexTask(task))?.ok) throw fail('task_index_failed');
      const result = { ok: true, decision, taskId: task.id, sessionId: task.sessionId,
        url: `/air?dir=${encodeURIComponent(task.dirId)}&task=${encodeURIComponent(task.id)}` };
      store.set('task-separation', id, { ...suggestion, state: 'separated', resolvedAt: Date.now(), result });
      changed(sessionId);
      return result;
    })();
    flights.set(id, operation);
    try { return await operation; } finally { flights.delete(id); }
  }
  return { propose, latest, decide };
}
module.exports = { createTaskSeparation };

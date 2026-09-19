'use strict';
const { hash } = require('./context');
const { handoffSnapshot } = require('./history-context');
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const safeErrorCode = error => /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(String(error?.code || ''))
  ? String(error.code) : 'separation_failed';

// A suggestion never changes attribution, the shell cursor, or execution state.
// Confirmation creates an independent continuation with only the judged turn.
function createTaskSeparation({ store, getRecord, getHistory, getExecution, createExecution, indexTask, ports, ownerOf, roles }) {
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
  // current() 的尾锚检查要求建议仍指着对话尾巴。但被瞬时拒绝（fork_source_busy
  // 「等本轮结束再分离」、交付凭证尚未落库等）而卡在 blocked 的建议，若只因对话
  // 又前进了一轮就永不可重试，错误文案给出的承诺就落空了。重试只要求锚点轮仍在
  // 历史里、壳路由没动 —— 分离内容按 turnId 提取，与是否对话尾巴无关。
  function anchored(suggestion) {
    const { receipt, source, shell } = sourceOf(suggestion.sessionId, suggestion.receiptId);
    if (ports.isDeletedTask?.(source.id) || ports.getTask?.(source.id)?.status === 'archived'
        || shell?.currentTaskId !== source.id || shell?.cursorReceiptId !== receipt.id
        || shell?.cursorVersion !== suggestion.cursorVersion) return false;
    return getHistory(source.sessionId).some(m => m.id === suggestion.anchorMessageId);
  }
  function usable(suggestion) {
    return current(suggestion) || (suggestion.phase === 'blocked' && anchored(suggestion));
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
    if (!suggestion || suggestion.state !== 'pending') return null;
    // The normal pending shape stays byte-identical for existing clients; only
    // the deferred/stale states add fields.
    if (suggestion.taskId) return suggestion.deferredAt ? { ...suggestion, deferred: true, stale: false } : suggestion;
    const valid = current(suggestion);
    // 瞬时失败（blocked）但锚点轮仍可重试的建议：以挂起卡形式留在托盘里，
    // 展开后接受路径会按 usable() 放行，而不是永远消失。
    if (!valid && suggestion.phase === 'blocked' && anchored(suggestion)) {
      return { ...suggestion, deferred: true, stale: false };
    }
    // An explicitly deferred suggestion stays in the durable tray even after
    // the conversation moves on, but it is then only dismissible: the accept
    // path still revalidates and rejects a stale source.
    if (!valid) return suggestion.deferredAt ? { ...suggestion, deferred: true, stale: true } : null;
    return suggestion.deferredAt ? { ...suggestion, deferred: true, stale: false } : suggestion;
  }
  function forTask(taskId) {
    return store.list('task-separation').filter(s => s.sourceTaskId === taskId || s.taskId === taskId).at(-1) || null;
  }
  async function verifiedDelivery(suggestion) {
    if (typeof ports.deliveryEvidence !== 'function') throw fail('delivery_evidence_unavailable');
    const evidence = ports.deliveryEvidence(suggestion.sessionId, suggestion.turnId) || {};
    const run = evidence.run;
    if (!run) throw fail('final_run_result_required', 'The final run result has not been recorded');
    if (run.outcome !== 'succeeded' || run.pendingInput) throw fail('run_not_succeeded', 'The source turn did not finish successfully');
    if (!run.endCodeRevision) throw fail('code_observation_required', 'The final code version was not observed');
    const codeChanged = !run.startCodeRevision || run.startCodeRevision !== run.endCodeRevision;
    let baseline = null;
    if (codeChanged) {
      if (!evidence.integration) throw fail('integration_receipt_required', 'Merge this turn before separating it');
      baseline = await ports.verifyDeliveryBaseline?.(evidence.integration, suggestion.sessionId);
      if (baseline?.effectValid !== true) throw fail('baseline_revalidation_required', 'The merge receipt is no longer current');
    }
    return { ...evidence, baseline, codeChanged };
  }
  async function decide(sessionId, id, decision) {
    if (!['separate', 'keep', 'defer'].includes(decision)) throw fail('invalid_input', 'decision must be separate, keep or defer', 400);
    let suggestion = store.get('task-separation', id);
    if (!suggestion || suggestion.sessionId !== sessionId) throw fail('separation_not_found', 'Separation suggestion not found', 404);
    if (flights.has(id)) { await flights.get(id); return decide(sessionId, id, decision); }
    // "Later" is a durable deferral, not a decision: the suggestion stays
    // pending for every device and the conversation is never blocked by it.
    if (decision === 'defer') {
      store.set('task-separation', id, { ...suggestion, deferredAt: suggestion.deferredAt || Date.now(),
        deferCount: (suggestion.deferCount || 0) + 1 });
      changed(sessionId);
      return { ok: true, decision: 'defer', id, deferred: true };
    }
    if (suggestion.state === 'separated') {
      if (decision !== 'separate') throw fail('separation_already_resolved');
      return suggestion.result;
    }
    if (suggestion.state === 'kept') {
      if (decision !== 'keep') throw fail('separation_already_resolved');
      return { ok: true, decision: 'keep' };
    }
    // Only accepting is blocked by a stale source. Dismissing (keep) a stale or
    // deferred entry stays available: it resolves the suggestion without
    // creating, moving or re-routing anything. A transiently blocked suggestion
    // (busy source, missing delivery evidence at click time) stays retryable as
    // long as its judged turn is still anchored in history.
    if (decision === 'separate' && !suggestion.taskId
        && !usable(suggestion)) throw fail('separation_stale', 'The conversation has advanced; this suggestion has expired');
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
        if (typeof ports.withSeparationBarrier !== 'function') throw fail('separation_barrier_unavailable');
        if (typeof ports.recordSeparationApplication !== 'function') throw fail('separation_application_unavailable');
        let delivery = await verifiedDelivery(suggestion);
        const taskId = `tsk_${hash(id).slice(0, 32)}`, nextSessionId = `task-${taskId.slice(4)}`, shellId = `sh_${hash(nextSessionId).slice(0, 24)}`;
        await ports.withSeparationBarrier({ sessionId, turnId: suggestion.turnId, separationId: suggestion.id }, async ({ barrier, code }) => {
          // Revalidate after the writer lease is held. A pre-barrier delivery
          // check can race a new source turn or a changed integration head.
          delivery = await verifiedDelivery(suggestion);
          if (!usable(suggestion)) throw fail('separation_stale');
          if (code.dirty) throw fail('fork_source_dirty', 'Commit and merge the source changes before separating');
          const snapshot = handoffSnapshot(taskId, getHistory(sessionId), { ...suggestion, receipt,
            sourceWorkspace: getRecord(sessionId)?.worktreePath });
          if (!snapshot) throw fail('separation_context_missing');
          const record = getRecord(sessionId);
          const baseline = { commit: delivery.codeChanged ? delivery.integration.integrationHead : code.head,
            branch: record?.branch || null, sourceSessionId: sessionId,
            sourceWorkspace: record?.worktreePath || null };
          task = { id: taskId, dirId: source.dirId, sessionId: nextSessionId, ownerShellId: shellId,
            title: suggestion.title, taskFirst: true, separatedFromTaskId: source.id,
            ready: false, snapshotIds: [snapshot.hash], forkBaseline: baseline, createdAt: Date.now(),
            runtime: { ...source.runtime, ...Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent', 'subagent']
              .filter(k => record?.[k] !== undefined).map(k => [k, record[k]])) } };
          store.transaction(() => {
            if (!usable(suggestion)) throw fail('separation_stale');
            store.set('snapshot', snapshot.hash, snapshot);
            store.set('task', task.id, task);
            store.set('shell', shellId, { id: shellId, sourceSessionId: nextSessionId, dirId: task.dirId,
              standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: task.createdAt });
            store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
            roles?.inherit(source.id, task.id);
            suggestion = { ...suggestion, taskId: task.id, barrierId: barrier.id,
              deliveryKind: delivery.codeChanged ? 'integration' : 'no_code_change',
              integrationId: delivery.integration?.id || null, phase: 'target_recorded', lastError: null };
            store.set('task-separation', id, suggestion);
          });
        });
      }
      if (!task.ready) {
        store.set('task-separation', id, { ...suggestion, phase: 'creating_execution', lastError: null });
        const created = await createExecution(task, task.runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed', created?.error || 'Execution creation failed');
        task.ready = true; task.baseline = created.baseline; store.set('task', task.id, task);
      }
      store.set('task-separation', id, { ...suggestion, phase: 'indexing_task', lastError: null });
      if (!(await indexTask(task))?.ok) throw fail('task_index_failed');
      const application = ports.recordSeparationApplication({ separationId: suggestion.id,
        sourceSessionId: sessionId, sourceTaskId: source.id, targetTaskId: task.id,
        targetSessionId: task.sessionId, targetShellId: task.ownerShellId,
        turnId: suggestion.turnId, barrierId: suggestion.barrierId });
      const result = { ok: true, decision, taskId: task.id, sessionId: task.sessionId,
        url: `/air?dir=${encodeURIComponent(task.dirId)}&task=${encodeURIComponent(task.id)}` };
      store.set('task-separation', id, { ...suggestion, state: 'separated', phase: 'applied',
        applicationId: application.id, resolvedAt: Date.now(), lastError: null, result });
      changed(sessionId);
      return result;
    })().catch(error => {
      const saved = store.get('task-separation', id);
      if (saved?.state === 'pending') store.set('task-separation', id, { ...saved, phase: 'blocked',
        lastError: { code: safeErrorCode(error) } });
      changed(sessionId);
      throw error;
    });
    flights.set(id, operation);
    try { return await operation; } finally { flights.delete(id); }
  }
  return { propose, latest, forTask, decide };
}
module.exports = { createTaskSeparation };

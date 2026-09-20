'use strict';
const { hash } = require('./context');
const { handoffSnapshot } = require('./history-context');
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const safeErrorCode = error => /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(String(error?.code || ''))
  ? String(error.code) : 'separation_failed';

// The task identity is split when the suggestion appears, not when it is
// accepted: the popup only decides the shell. Declining keeps the new task
// linked to this conversation as a relative (separatedFromTaskId is the
// derived edge) and work continues on the shared execution; accepting — now
// or any time later, even after a "keep" — gives that already-existing task
// its own execution and shell. Accepting therefore never creates the task,
// it only switches where the task runs.
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
  function usableShell(suggestion, source, shell) {
    return !ports.isDeletedTask?.(source.id) && ports.getTask?.(source.id)?.status !== 'archived'
      && shell?.currentTaskId === source.id && shell?.cursorReceiptId === suggestion.receiptId
      && shell?.cursorVersion === suggestion.cursorVersion;
  }
  function current(suggestion) {
    const { source, shell } = sourceOf(suggestion.sessionId, suggestion.receiptId);
    if (!usableShell(suggestion, source, shell)) return false;
    const last = getHistory(source.sessionId).findLast(m => ['user', 'assistant'].includes(m.role) && m.content);
    return !!last && last.id === suggestion.anchorMessageId;
  }
  // current() 的尾锚检查要求建议仍指着对话尾巴。但被瞬时拒绝（fork_source_busy
  // 「等本轮结束再分离」、交付凭证尚未落库等）而卡在 blocked 的建议，若只因对话
  // 又前进了一轮就永不可重试，错误文案给出的承诺就落空了。重试只要求锚点轮仍在
  // 历史里、壳路由没动 —— 分离内容按 turnId 提取，与是否对话尾巴无关。
  function anchored(suggestion) {
    const { source, shell } = sourceOf(suggestion.sessionId, suggestion.receiptId);
    if (!usableShell(suggestion, source, shell)) return false;
    return getHistory(source.sessionId).some(m => m.id === suggestion.anchorMessageId);
  }
  // A suggestion whose task identity was already split stays acceptable for as
  // long as there is anything left to hand off: the anchor, or any record the
  // attribution pass has since given to the new task. The conversation moving
  // on is irrelevant — the split turn is evidence, not a cursor.
  function splitAlive(suggestion) {
    const { source } = sourceOf(suggestion.sessionId, suggestion.receiptId);
    if (ports.isDeletedTask?.(source.id) || ports.getTask?.(source.id)?.status === 'archived') return false;
    const target = suggestion.taskId && store.get('task', suggestion.taskId);
    if (!target || ports.isDeletedTask?.(target.id) || ports.getTask?.(target.id)?.status === 'archived') return false;
    const history = getHistory(source.sessionId);
    return history.some(m => m.id === suggestion.anchorMessageId || (suggestion.taskId && m.taskId === suggestion.taskId));
  }
  function usable(suggestion) {
    return current(suggestion) || (suggestion.phase === 'blocked' && anchored(suggestion));
  }
  function publicState(suggestion) {
    if (!suggestion.taskId) {
      const valid = current(suggestion);
      if (!valid && suggestion.phase === 'blocked' && anchored(suggestion)) return { ...suggestion, deferred: true, stale: false };
      if (!valid) return suggestion.deferredAt ? { ...suggestion, deferred: true, stale: true } : null;
      return suggestion.deferredAt ? { ...suggestion, deferred: true, stale: false } : suggestion;
    }
    // A transiently blocked split parks in the tray exactly like a deferred one.
    const parked = !!suggestion.deferredAt || suggestion.phase === 'blocked';
    if (!splitAlive(suggestion)) return parked ? { ...suggestion, deferred: true, stale: true } : null;
    return parked ? { ...suggestion, deferred: true, stale: false } : suggestion;
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
    // Follow-up turns of the same conversation are often judged "the same new
    // task" again. Pending and kept both mean that identity already exists in
    // this shell; return it so the classifier can attribute the new turn to the
    // same task instead of silently folding it back into the source task.
    const twin = store.list('task-separation').find(s => s.sourceTaskId === source.id
      && s.title === title && ['pending', 'kept'].includes(s.state));
    if (twin) return twin;
    const suggestion = { id, sessionId, receiptId, sourceTaskId: source.id, sourceTitle: source.title,
      title, reason: String(input.separation.reason || '').slice(0, 240), turnId: input.turnId,
      anchorMessageId: input.anchorMessageId, cursorVersion: shell?.cursorVersion,
      state: 'pending', createdAt: Date.now() };
    if (!current(suggestion)) return null;
    // The task id is allocated here, with the suggestion: the transcript
    // annotation, the board card and a later shell switch all reference one
    // stable identity. The task shares the conversation's execution
    // (ready:false) until a separate decision gives it its own.
    const taskId = `tsk_${hash(id).slice(0, 32)}`;
    const record = getRecord(sessionId);
    store.transaction(() => {
      if (store.list('task').filter(t => t.dirId === source.dirId).length >= 200) throw fail('task_shell_task_limit');
      if (!store.get('task', taskId)) {
        store.set('task', taskId, { id: taskId, dirId: source.dirId, sessionId: `task-${taskId.slice(4)}`,
          ownerShellId: shell?.id || null, title, taskFirst: true, separatedFromTaskId: source.id,
          embedded: true, ready: false, snapshotIds: [], createdAt: Date.now(),
          runtime: { ...source.runtime, ...Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent', 'subagent']
            .filter(k => record?.[k] !== undefined).map(k => [k, record[k]])) } });
      }
      if (shell) store.set('link', `${shell.id}:${taskId}`, { shellId: shell.id, taskId });
      roles?.inherit(source.id, taskId);
      suggestion.taskId = taskId;
      store.set('task-separation', id, suggestion);
    });
    const task = store.get('task', taskId);
    Promise.resolve().then(() => indexTask(task)).then(indexed => {
      if (!indexed?.ok) console.warn('[task-separation] embedded task index failed');
    }).catch(error => console.warn('[task-separation] embedded task index failed', error.message));
    changed(sessionId);
    return suggestion;
  }
  function latest(sessionId) {
    const suggestion = store.list('task-separation').filter(s => s.sessionId === sessionId).at(-1);
    if (!suggestion || suggestion.state !== 'pending') return null;
    // The normal pending shape stays byte-identical for existing clients; only
    // the deferred/stale states add fields.
    if (suggestion.taskId) return publicState(suggestion);
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
  // The judged exchange: by turn when the transcript was never re-annotated
  // (fixtures, older hosts), plus everything the attribution pass has since
  // given to the split task. Union, in transcript order.
  function seedSelection(history, suggestion, receipt) {
    const end = history.findIndex(m => m.id === suggestion.anchorMessageId);
    const candidates = end >= 0 ? history.slice(0, end + 1) : history;
    let selected = candidates.filter(m => suggestion.turnId
      ? m.turnId === suggestion.turnId : m.clientMsgId === receipt.id);
    if (!selected.length && end >= 0 && !history[end].turnId) {
      const start = candidates.findLastIndex(m => m.role === 'user');
      selected = candidates.slice(Math.max(0, start));
    }
    if (suggestion.taskId) {
      const seen = new Set(selected.map(m => m.id));
      for (const m of history.filter(m => m.taskId === suggestion.taskId)) {
        if (!seen.has(m.id)) { seen.add(m.id); selected.push(m); }
      }
      const order = new Map(history.map((m, index) => [m.id, index]));
      selected.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    return selected.filter(m => ['user', 'assistant'].includes(m.role) && m.content && !m.displayOnly);
  }
  // Visible handoff, idempotent and best-effort: seed the target transcript
  // (skipping what an earlier attempt already imported), hide what landed from
  // the source view (the canonical transcript is kept), and move the judged
  // turn's open wait_user question so it is answered where the turn now lives.
  async function visibleHandoff(sessionId, suggestion, task) {
    let seededMessages = 0;
    try {
      if (typeof ports.appendHistory === 'function') {
        const targetHistory = getHistory(task.sessionId), receipt = store.get('receipt', suggestion.receiptId);
        const selected = seedSelection(getHistory(sessionId), suggestion, receipt);
        const landedIds = [];
        for (const m of selected) {
          const landed = targetHistory.some(value => value.importedBy === suggestion.id
            && value.sourceSessionId === sessionId && value.sourceMessageId === m.id)
            || targetHistory.some(value => value.sourceSessionId === sessionId && value.sourceMessageId === m.id);
          if (landed) { landedIds.push(m.id); continue; }
          if (ports.appendHistory(task.sessionId, { ...m, taskId: task.id,
            sourceSessionId: sessionId, sourceMessageId: m.id,
            contextMessageId: m.contextMessageId || `${sessionId}:${m.id}`,
            importedBy: suggestion.id, importedAt: Date.now() }) !== false) {
            seededMessages += 1;
            landedIds.push(m.id);
          }
        }
        // Hiding is deliberately independent from appending. Older builds may
        // already have imported the target transcript but never removed it from
        // the source view; restart healing must still finish that half of the
        // move. Only IDs proven present in the target are hidden.
        if (landedIds.length && typeof ports.hideHistory === 'function') {
          try { ports.hideHistory(sessionId, landedIds); }
          catch (error) { console.warn('[task-separation] source hide failed', error.message); }
        }
      }
    } catch (error) { console.warn('[task-separation] transcript seed failed', error.message); }
    let movedUserInput = null;
    try {
      const moved = typeof ports.movePendingUserInput === 'function'
        ? await ports.movePendingUserInput(sessionId, task.sessionId, { turnId: suggestion.turnId, taskId: task.id })
        : null;
      if (moved?.ok) movedUserInput = moved.requestId || true;
    } catch (error) { console.warn('[task-separation] pending input move failed', error.message); }
    return { seededMessages, movedUserInput };
  }
  // Restart/retry repair for already-confirmed separations: the durable task
  // and execution exist, so only the visible handoff may still be missing
  // (older builds separated without seeding or moving the open question).
  async function heal() {
    let healed = 0;
    for (const suggestion of store.list('task-separation').filter(s => s.state === 'separated')) {
      try {
        const task = suggestion.taskId && store.get('task', suggestion.taskId);
        if (!task?.sessionId || !getRecord(task.sessionId)) continue;
        await visibleHandoff(suggestion.sessionId, suggestion, task);
        healed += 1;
      } catch (error) { console.warn('[task-separation] heal failed', suggestion.id, error.message); }
    }
    return { ok: true, healed };
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
    // Declining only dismisses the dialog: with the identity already split,
    // "keep" means "stay in this shell", and accepting later is the detach.
    if (suggestion.state === 'kept') {
      if (decision === 'keep') return { ok: true, decision: 'keep' };
      if (!suggestion.taskId) throw fail('separation_already_resolved');
    }
    if (decision === 'keep') {
      // An accept that already built the execution is not dismissible: the
      // task is half-way into its own shell and must be finished (or purged),
      // never stranded by a "keep".
      const keptTask = suggestion.taskId && store.get('task', suggestion.taskId);
      if (keptTask && keptTask.embedded !== true) {
        throw fail('separation_already_confirmed', 'Separation was already confirmed; retry to finish creating the task');
      }
      store.set('task-separation', id, { ...suggestion, state: 'kept', resolvedAt: Date.now() });
      changed(sessionId);
      return { ok: true, decision };
    }
    // Accepting is blocked only when nothing separable remains. A legacy
    // (pre-split) suggestion keeps the tail-anchor rule; a blocked one stays
    // retryable while its judged turn is anchored in history.
    if (suggestion.taskId ? !splitAlive(suggestion) : !usable(suggestion)) {
      throw fail('separation_stale', 'The conversation has advanced; this suggestion has expired');
    }
    const operation = (async () => {
      const { receipt, source } = sourceOf(sessionId, suggestion.receiptId);
      // A separation creates a new task; it does not publish the source task's
      // code.  Requiring that code to be merged made a harmless task boundary
      // depend on an unrelated delivery workflow, and also ruled out a turn
      // which has deliberately paused for a user answer.  The writer barrier
      // below is the authoritative concurrency check: it only yields a baseline
      // after all actual writers have stopped and the worktree is re-observed.
      if (ports.isTaskLifecycleBusy?.(source.id)) throw fail('task_busy', 'The source task is changing lifecycle state');
      // The conversation advancing between verdict and accept is fine — the
      // split task simply takes its newer records along. But the tail moving
      // DURING an accept proves the writer barrier did not hold; abort rather
      // than split a history that is still being written.
      const tailAtStart = getHistory(sessionId).at(-1)?.id || null;
      const tailMoved = () => (getHistory(sessionId).at(-1)?.id || null) !== tailAtStart;
      let task = suggestion.taskId && store.get('task', suggestion.taskId);
      if (!task) {
        // Legacy path: a suggestion written before identity split at propose
        // time. The task is created at accept, exactly as it always was.
        if (store.list('task').filter(t => t.dirId === source.dirId).length >= 200) throw fail('task_shell_task_limit');
        if (typeof ports.withSeparationBarrier !== 'function') throw fail('separation_barrier_unavailable');
        if (typeof ports.recordSeparationApplication !== 'function') throw fail('separation_application_unavailable');
        const taskId = `tsk_${hash(id).slice(0, 32)}`, nextSessionId = `task-${taskId.slice(4)}`, shellId = `sh_${hash(nextSessionId).slice(0, 24)}`;
        await ports.withSeparationBarrier({ sessionId, turnId: suggestion.turnId, separationId: suggestion.id }, async ({ barrier, code }) => {
          // Revalidate after the writer lease is held.  The code head captured
          // here, not main's head, is the isolated task's reproducible start.
          if (!usable(suggestion) || tailMoved()) throw fail('separation_stale');
          if (code.dirty) throw fail('fork_source_dirty', 'Commit and merge the source changes before separating');
          const snapshot = handoffSnapshot(taskId, getHistory(sessionId), { ...suggestion, receipt,
            sourceWorkspace: getRecord(sessionId)?.worktreePath });
          if (!snapshot) throw fail('separation_context_missing');
          const record = getRecord(sessionId);
          const baseline = { commit: code.head,
            branch: record?.branch || null, sourceSessionId: sessionId,
            sourceWorkspace: record?.worktreePath || null };
          task = { id: taskId, dirId: source.dirId, sessionId: nextSessionId, ownerShellId: shellId,
            title: suggestion.title, taskFirst: true, separatedFromTaskId: source.id,
            ready: false, snapshotIds: [snapshot.hash], forkBaseline: baseline, createdAt: Date.now(),
            runtime: { ...source.runtime, ...Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent', 'subagent']
              .filter(k => record?.[k] !== undefined).map(k => [k, record[k]])) } };
          store.transaction(() => {
            if (!usable(suggestion) || tailMoved()) throw fail('separation_stale');
            store.set('snapshot', snapshot.hash, snapshot);
            store.set('task', task.id, task);
            store.set('shell', shellId, { id: shellId, sourceSessionId: nextSessionId, dirId: task.dirId,
              standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: task.createdAt });
            store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
            roles?.inherit(source.id, task.id);
            suggestion = { ...suggestion, taskId: task.id, barrierId: barrier.id,
              // This receipt proves a clean, stopped source snapshot.  It is
              // intentionally distinct from an integration receipt: the source
              // task can be delivered to main later, on its own schedule.
              deliveryKind: 'workspace_snapshot', integrationId: null,
              phase: 'target_recorded', lastError: null };
            store.set('task-separation', id, suggestion);
          });
        });
      } else if (task.embedded === true || !store.get('shell', task.ownerShellId)?.standalone) {
        // The identity was split at propose time; accepting gives that
        // existing task its own execution and a standalone shell.
        if (typeof ports.withSeparationBarrier !== 'function') throw fail('separation_barrier_unavailable');
        if (typeof ports.recordSeparationApplication !== 'function') throw fail('separation_application_unavailable');
        const shellId = `sh_${hash(task.sessionId).slice(0, 24)}`, sourceShellId = task.ownerShellId;
        await ports.withSeparationBarrier({ sessionId, turnId: suggestion.turnId, separationId: suggestion.id }, async ({ barrier, code }) => {
          if (!splitAlive(suggestion) || tailMoved()) throw fail('separation_stale');
          if (code.dirty) throw fail('fork_source_dirty', 'Commit and merge the source changes before separating');
          const snapshot = handoffSnapshot(task.id, getHistory(sessionId), { ...suggestion, receipt,
            sourceWorkspace: getRecord(sessionId)?.worktreePath });
          if (!snapshot) throw fail('separation_context_missing');
          const record = getRecord(sessionId);
          store.transaction(() => {
            if (!splitAlive(suggestion) || tailMoved()) throw fail('separation_stale');
            store.set('snapshot', snapshot.hash, snapshot);
            if (!store.get('shell', shellId)) {
              store.set('shell', shellId, { id: shellId, sourceSessionId: task.sessionId, dirId: task.dirId,
                standalone: true, currentTaskId: task.id, defaultTaskId: task.id, cursorVersion: 0, createdAt: Date.now() });
            }
            store.set('link', `${shellId}:${task.id}`, { shellId, taskId: task.id });
            if (sourceShellId && sourceShellId !== shellId) store.remove('link', `${sourceShellId}:${task.id}`);
            task = { ...task, ownerShellId: shellId, embedded: false,
              snapshotIds: [...new Set([...(task.snapshotIds || []), snapshot.hash])],
              forkBaseline: task.forkBaseline || { commit: code.head,
                branch: record?.branch || null, sourceSessionId: sessionId,
                sourceWorkspace: record?.worktreePath || null } };
            store.set('task', task.id, task);
            suggestion = { ...suggestion, barrierId: barrier.id,
              deliveryKind: 'workspace_snapshot', integrationId: null,
              phase: 'target_recorded', lastError: null };
            store.set('task-separation', id, suggestion);
          });
        });
      }
      if (!task.ready) {
        store.set('task-separation', id, { ...suggestion, phase: 'creating_execution', lastError: null });
        const created = await createExecution(task, task.runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed', created?.error || 'Execution creation failed');
        task = { ...task, ready: true, baseline: created.baseline };
        store.set('task', task.id, task);
      }
      store.set('task-separation', id, { ...suggestion, phase: 'indexing_task', lastError: null });
      if (!(await indexTask(task))?.ok) throw fail('task_index_failed');
      const application = ports.recordSeparationApplication({ separationId: suggestion.id,
        sourceSessionId: sessionId, sourceTaskId: source.id, targetTaskId: task.id,
        targetSessionId: task.sessionId, targetShellId: task.ownerShellId,
        turnId: suggestion.turnId, barrierId: suggestion.barrierId });
      const handoff = await visibleHandoff(sessionId, suggestion, task);
      const result = { ok: true, decision, taskId: task.id, sessionId: task.sessionId,
        seededMessages: handoff.seededMessages, movedUserInput: handoff.movedUserInput,
        url: `/air?dir=${encodeURIComponent(task.dirId)}&task=${encodeURIComponent(task.id)}` };
      store.set('task-separation', id, { ...suggestion, state: 'separated', phase: 'applied',
        applicationId: application.id, resolvedAt: Date.now(), lastError: null, result });
      changed(sessionId);
      return result;
    })().catch(error => {
      const saved = store.get('task-separation', id);
      if (saved && ['pending', 'kept'].includes(saved.state)) store.set('task-separation', id, { ...saved, phase: 'blocked',
        lastError: { code: safeErrorCode(error) } });
      changed(sessionId);
      throw error;
    });
    flights.set(id, operation);
    try { return await operation; } finally { flights.delete(id); }
  }
  return { propose, latest, forTask, decide, heal };
}
module.exports = { createTaskSeparation };

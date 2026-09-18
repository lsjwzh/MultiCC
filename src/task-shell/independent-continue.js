'use strict';

const { hash } = require('./context');
const { historySnapshot } = require('./history-context');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const safeCode = error => /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(String(error?.code || ''))
  ? String(error.code) : 'continuation_failed';

// Independent continuation (P3): give one logical task its own execution.
//
// A logical task may share an execution with its conversation for a long time —
// the identity is an annotation, not a resource. Wanting its own worktree and
// native context is therefore a separate request, and it is durable: it may
// have to wait for the shared execution to finish, for uncommitted work to be
// delivered, or for capacity, and the user must not have to keep the page open
// for that. Every state below is written to the task-shell store, so a restart
// resumes exactly where the request stopped.
//
//   requested → waiting → preparing → ready → applied
//                    ↘ needs_attention / failed
//   未开始切换的申请 → cancelled
//
// Nothing here copies code, commits, merges or cherry-picks: `ready` means a
// second execution exists on a frozen baseline commit, and `applied` means the
// task's new input goes there. The original conversation keeps its history.
const TERMINAL = Object.freeze(['applied', 'cancelled', 'failed']);
// `preparing` is retryable on purpose: a restart in the middle of creating the
// second execution re-reads what physically exists and continues, instead of
// creating it twice.
const RETRYABLE = Object.freeze(['requested', 'waiting', 'preparing']);
const MAX_MANIFEST_MESSAGES = 10;

function createIndependentContinuation({ store, getRecord, getHistory, getExecution, createExecution, indexTask, ports, ownerOf, roles, hasCapacity }) {
  const now = ports.now || (() => Date.now());
  const flights = new Map();
  let timer = null;

  const idOf = (taskId, clientMsgId) => `ind_${hash([taskId, clientMsgId]).slice(0, 32)}`;

  function list(filter) {
    return store.list('independent')
      .filter(op => !filter || !filter.taskId || op.taskId === filter.taskId)
      .filter(op => !filter || !filter.shellId || op.shellId === filter.shellId)
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  }

  function openFor(taskId) {
    return list({ taskId }).find(op => !TERMINAL.includes(op.state)) || null;
  }

  function publicOp(op) {
    if (!op) return null;
    const events = (Array.isArray(op.events) ? op.events : []).slice(-20);
    return { id: op.id, taskId: op.taskId, shellId: op.shellId, state: op.state, phase: op.phase || null,
      reason: op.reason || null, sourceSessionId: op.sourceSessionId, targetSessionId: op.targetSessionId || null,
      epoch: op.epoch || 1, manifest: op.manifest || null, events, cleanup: op.cleanup || null,
      error: op.error || null, createdAt: op.createdAt, updatedAt: op.updatedAt,
      appliedAt: op.appliedAt || null, cancelledAt: op.cancelledAt || null,
      capabilities: { cancel: !TERMINAL.includes(op.state), apply: op.state === 'ready',
        retry: op.state === 'needs_attention' } };
  }

  function get(id) {
    const op = store.get('independent', String(id || ''));
    if (!op) throw fail('continuation_not_found', 'Continuation request not found', 404);
    return op;
  }

  function save(op, note) {
    const events = note ? [...(Array.isArray(op.events) ? op.events : []), { at: now(), ...note }].slice(-20) : op.events;
    const next = { ...op, events, updatedAt: now() };
    store.set('independent', next.id, next);
    try { ports.onContinuationChanged?.(next.taskId, next.id); }
    catch (error) { console.warn('[task-continuation] notification failed', error.message); }
    return next;
  }

  // A task is independent once its execution is no longer the one the
  // conversation itself runs on.
  function isIndependent(task, owner = ownerOf(task)) {
    return !!(owner && task.sessionId && task.sessionId !== owner.sourceSessionId);
  }

  // The gates are read again before every attempt and once more inside the
  // writer barrier: "not yet" is a waiting reason, never a silent failure.
  async function blocker(task) {
    if (ports.isDeletedTask?.(task.id)) return { state: 'needs_attention', reason: 'task_deleted' };
    if (ports.getTask?.(task.id)?.status === 'archived') return { state: 'needs_attention', reason: 'task_archived' };
    if (ports.isTaskLifecycleBusy?.(task.id)) return { state: 'waiting', reason: 'task_busy' };
    const state = (await getExecution(task.sessionId)) || {};
    if (state.pending) return { state: 'waiting', reason: 'awaiting_answer' };
    if (state.busy !== false) return { state: 'waiting', reason: 'turn_busy' };
    if ((state.queue?.queued || []).length) return { state: 'waiting', reason: 'queued_work' };
    const baseline = typeof ports.captureIndependentBaseline === 'function'
      ? await ports.captureIndependentBaseline(task) : { ok: false, reason: 'workspace_probe_unavailable' };
    if (!baseline?.ok) return { state: baseline?.reason === 'directory_missing' ? 'needs_attention' : 'waiting',
      reason: baseline?.reason || 'workspace_unavailable' };
    // Commits that are not on the base branch are work this request cannot
    // prove belongs to this task, so it waits instead of taking them along.
    if (baseline.dirty) return { state: 'waiting', reason: 'uncommitted_changes' };
    if (baseline.ahead > 0) return { state: 'waiting', reason: 'undelivered_changes', detail: { ahead: baseline.ahead } };
    if (typeof hasCapacity === 'function' && !(await hasCapacity(task))) return { state: 'waiting', reason: 'capacity' };
    return null;
  }

  async function request(shellId, taskId, { clientMsgId } = {}) {
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    if (!store.get('shell', String(shellId || ''))) throw fail('task_shell_not_found', 'Task shell not found', 404);
    if (!store.get('link', `${shellId}:${taskId}`)) throw fail('task_not_linked', 'This task is not part of the conversation', 403);
    const task = store.get('task', String(taskId || ''));
    if (!task) throw fail('task_not_found', 'Task not found', 404);
    const existing = store.get('independent', idOf(task.id, clientMsgId));
    if (existing) return publicOp(existing);
    const open = openFor(task.id);
    if (open) return publicOp(open);
    if (isIndependent(task)) throw fail('already_independent', 'This task already has its own execution', 409);
    if (ports.isDeletedTask?.(task.id)) throw fail('task_not_found', 'Task not found', 404);
    const op = save({ id: idOf(task.id, clientMsgId), taskId: task.id, shellId, sourceSessionId: task.sessionId,
      epoch: (Number(task.executionEpoch) || 0) + 1, state: 'requested', phase: 'requested', events: [],
      clientMsgId, createdAt: now() }, { type: 'requested' });
    return publicOp(await advance(op.id));
  }

  async function advance(id) {
    const current = store.get('independent', String(id || ''));
    if (!current || TERMINAL.includes(current.state)) return current;
    if (flights.has(current.id)) return flights.get(current.id);
    const run = (async () => {
      const task = store.get('task', current.taskId);
      if (!task) {
        // A request made moments before the task was written is not a failure
        // yet; a genuinely unknown task is. Only the latter reports.
        if (now() - (current.createdAt || 0) < 60000) return save({ ...current, state: 'waiting', reason: 'task_pending' });
        return save({ ...current, state: 'needs_attention', phase: 'task_missing', reason: 'task_unknown',
          error: { code: 'task_not_found' } }, { type: 'task_missing' });
      }
      if (isIndependent(task)) return save({ ...current, state: 'failed', phase: 'already_independent',
        reason: 'already_independent', error: { code: 'already_independent' } }, { type: 'already_independent' });
      const blocked = await blocker(task);
      if (blocked) return save({ ...current, state: blocked.state, phase: blocked.state === 'waiting' ? 'waiting' : 'blocked',
        reason: blocked.reason, detail: blocked.detail || null, error: blocked.state === 'needs_attention' ? { code: blocked.reason } : null });
      return prepare(task, current);
    })().catch(error => save({ ...current, state: 'needs_attention', phase: 'failed', reason: safeCode(error),
      error: { code: safeCode(error) } }, { type: 'error', code: safeCode(error) }));
    flights.set(current.id, run);
    try { return await run; } finally { flights.delete(current.id); }
  }

  // Preparing creates a second execution on a frozen baseline. The manifest is
  // the whole authorization: which commit, which task revision, which messages
  // the new context may contain. Everything else is deliberately left behind.
  async function prepare(task, op) {
    let current = save({ ...op, state: 'preparing', phase: 'preparing', reason: null, error: null }, { type: 'preparing' });
    try {
      const baseline = await ports.captureIndependentBaseline(task);
      if (!baseline?.ok) throw fail(baseline?.reason || 'workspace_unavailable');
      const targetSessionId = op.targetSessionId || `task-${String(task.id).replace(/^tsk_/, '').slice(0, 20)}-x${op.epoch}`;
      const owned = (getHistory(task.sessionId) || []).filter(message => message.taskId === task.id);
      const snapshot = owned.length ? historySnapshot(task.id, owned.slice(-MAX_MANIFEST_MESSAGES)) : null;
      const manifest = { codeCommit: baseline.commit, baseBranch: baseline.baseBranch || null,
        sourceSessionId: baseline.sourceSessionId, sourceWorkspace: baseline.sourceWorkspace || null,
        attributionRevision: task.cursorVersion || null, roleSnapshotId: roles?.snapshot?.(task.id) || null,
        snapshotId: snapshot?.hash || null,
        importedMessages: snapshot ? owned.slice(-MAX_MANIFEST_MESSAGES).map(m => `${task.sessionId}:${m.id}`) : [] };
      current = save({ ...current, targetSessionId, epoch: op.epoch, manifest }, { type: 'manifest', commit: baseline.commit });
      if (snapshot) store.set('snapshot', snapshot.hash, snapshot);
      if (!getRecord(targetSessionId)) {
        const created = await createExecution({ ...task, sessionId: targetSessionId, ready: false,
          snapshotIds: snapshot ? [...(task.snapshotIds || []), snapshot.hash] : task.snapshotIds || [],
          forkBaseline: { commit: baseline.commit, branch: baseline.branch || null, sourceSessionId: task.sessionId,
            sourceWorkspace: baseline.sourceWorkspace || null } }, task.runtime);
        if (!created?.ok) throw fail(created?.code || 'execution_create_failed', created?.error || 'Execution creation failed');
        current = save({ ...current, created: true, baseline: created.baseline || null }, { type: 'execution_created', targetSessionId });
      }
      return save({ ...current, state: 'ready', phase: 'ready', reason: null, error: null }, { type: 'ready' });
    } catch (error) {
      const code = safeCode(error);
      return save({ ...current, state: 'needs_attention', phase: 'prepare_failed', reason: code, error: { code } },
        { type: 'prepare_failed', code });
    }
  }

  async function apply(id) {
    const op = get(id);
    if (op.state === 'applied') return publicOp(op);
    if (op.state !== 'ready') throw fail('continuation_not_ready', 'This request is not ready to apply', 409);
    if (flights.has(op.id)) { await flights.get(op.id); return apply(op.id); }
    const task = store.get('task', op.taskId);
    if (!task) throw fail('task_not_found', 'Task not found', 404);
    if (task.sessionId !== op.sourceSessionId) throw fail('continuation_source_changed', 'This task already moved to another execution', 409);
    // The switch is only allowed across a boundary: no running turn, no
    // unanswered control, no frozen queue. Anything admitted before it keeps
    // the execution it was routed to.
    const state = (await getExecution(task.sessionId)) || {};
    if (state.pending || state.busy !== false || (state.queue?.queued || []).length) throw fail('turn_busy', 'Wait for the running work to finish before switching', 409);
    const target = getRecord(op.targetSessionId);
    if (!target || target.taskBoundTaskId !== task.id) throw fail('continuation_target_missing', 'The prepared execution is gone', 409);
    const applied = store.transaction(() => {
      const fresh = store.get('task', task.id);
      if (!fresh || fresh.sessionId !== op.sourceSessionId) throw fail('continuation_source_changed', 'This task already moved to another execution', 409);
      const previous = [...(Array.isArray(fresh.previousExecutions) ? fresh.previousExecutions : []).slice(-4),
        { sessionId: op.sourceSessionId, at: now(), reason: 'independent-continue' }];
      store.set('task', fresh.id, { ...fresh, sessionId: op.targetSessionId, ready: true,
        executionEpoch: op.epoch, independentAt: now(), previousExecutions: previous,
        independentFrom: { sessionId: op.sourceSessionId, codeCommit: op.manifest?.codeCommit || null,
          sourceWorkspace: op.manifest?.sourceWorkspace || null },
        ...(fresh.chatSessionId === op.sourceSessionId ? { chatSessionId: op.targetSessionId } : {}) });
      store.set('link', `${op.shellId}:${fresh.id}`, { shellId: op.shellId, taskId: fresh.id });
      return save({ ...op, state: 'applied', phase: 'applied', appliedAt: now(), reason: null, error: null }, { type: 'applied' });
    });
    try { await indexTask(store.get('task', task.id)); }
    catch (error) { console.warn('[task-continuation] re-index failed', error.message); }
    return publicOp(applied);
  }

  // Cancelling reclaims only what this request provably created and nothing is
  // using: a planned execution with no history and no live work. Anything else
  // is reported as kept, because the alternative is deleting user work.
  async function cancel(id) {
    const op = get(id);
    if (op.state === 'cancelled') return publicOp(op);
    if (op.state === 'applied') throw fail('continuation_applied', 'An applied switch is not cancelled', 409);
    let cleanup = 'none';
    if (op.targetSessionId && op.created === true) {
      const record = getRecord(op.targetSessionId);
      const state = record ? ((await getExecution(op.targetSessionId)) || {}) : null;
      const used = !record || state.busy !== false || state.pending || (state.queue?.queued || []).length
        || (getHistory(op.targetSessionId) || []).length > 0;
      if (used) cleanup = 'kept';
      else {
        const result = await ports.discardExecution?.(op.targetSessionId, { taskId: op.taskId });
        cleanup = result?.ok === false ? `kept:${result.code || 'refused'}` : 'removed';
      }
    } else if (op.targetSessionId) cleanup = 'kept';
    return publicOp(save({ ...op, state: 'cancelled', phase: 'cancelled', cancelledAt: now(), cleanup, reason: null }, { type: 'cancelled', cleanup }));
  }

  // Retrying clears the recorded reason but keeps the identity and the target
  // of the original request, so a retry can never duplicate an execution.
  async function retry(id) {
    const op = get(id);
    if (op.state !== 'needs_attention') throw fail('continuation_not_retryable', 'Only a blocked request can be retried', 409);
    save({ ...op, state: 'requested', phase: 'requested', reason: null, error: null }, { type: 'retry' });
    return publicOp(await advance(op.id));
  }

  async function tick() {
    const open = list().filter(op => RETRYABLE.includes(op.state));
    for (const op of open) {
      try { await advance(op.id); } catch (error) { console.warn('[task-continuation] tick failed', safeCode(error)); }
    }
  }

  function start(intervalMs = 20000) {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    const first = setTimeout(() => { void tick(); }, 8000);
    if (typeof first.unref === 'function') first.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { request, advance, prepare, apply, cancel, retry, tick, start, stop, list, get, publicOp, isIndependent };
}

module.exports = { createIndependentContinuation, TERMINAL };

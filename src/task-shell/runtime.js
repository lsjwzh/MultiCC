'use strict';

const { randomUUID } = require('node:crypto');
const {
  estimateTokens, snapshotHistory, renderSnapshots, verifySnapshot, hash,
} = require('./context');
const { shellRecords, historySnapshot, handoffSnapshot, contextPage, pageSnapshots } = require('./history-context');
const { resolveGoalLimits } = require('../routes/aux-goal');

function failure(code, message = code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,160}$/.test(value)) throw failure('invalid_input', `invalid ${label}`, 400);
  return value;
}
function cleanError(error) {
  return {
    code: String(error?.code || 'task_shell_failed').slice(0, 100),
    message: String(error?.message || error).replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
      .replace(/((?:token|api[_-]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 4000),
  };
}

function createTaskShellRuntime(ports) {
  const {
    store, getRecord, getHistory, getExecution, createExecution, indexTask, send, cancel,
    getTask = () => null,
  } = ports;
  const flights = new Map();
  const taskActions = require('./task-actions').createTaskActions({ store, getRecord, getTask, getHistory, getExecution, createExecution, indexTask, ports, shell, open, chatScope });
  const launching = new Set();
  const maxConcurrent = Number.isInteger(ports.maxConcurrent) && ports.maxConcurrent > 0 ? ports.maxConcurrent : 4;
  async function checkCapacity(task) {
    const others = store.list('task').filter(t => t.id !== task.id && t.dirId === task.dirId && t.ready);
    const states = await Promise.all(others.map(async t => ({ id: t.id, busy: (await getExecution(t.sessionId)).busy })));
    const occupied = new Set(states.filter(s => s.busy !== false).map(s => s.id));
    for (const id of launching) if (id !== task.id && store.get('task', id)?.dirId === task.dirId) occupied.add(id);
    if (occupied.size >= maxConcurrent) throw failure('task_shell_capacity', `At most ${maxConcurrent} occupied tasks per project; retry this delivery when capacity is available`, 429);
  }
  function shell(id) {
    const value = store.get('shell', identifier(id, 'shellId'));
    if (!value) throw failure('shell_not_found', 'shell_not_found', 404);
    if (value.standalone === undefined) { const source = getRecord(value.sourceSessionId); value.standalone = !!source?.taskBoundTaskId && !source.workspaceOwnerSessionId; store.set('shell', value.id, value); }
    return value;
  }
  function taskFor(s, id, linked = true) {
    const task = store.get('task', identifier(id, 'taskId'));
    if (!task) throw failure('task_not_found', 'task_not_found', 404);
    if (task.dirId !== s.dirId) throw failure('project_mismatch', 'Tasks must belong to the same project', 403);
    if (linked && !store.get('link', `${s.id}:${id}`)) throw failure('task_not_linked');
    return task;
  }
  function linkedTasks(s) {
    const ids = new Set(store.list('link').filter(value => value.shellId === s.id).map(value => value.taskId));
    return store.list('task').filter(task => ids.has(task.id));
  }
  // One read-only traversal for chat entry, dashboard state and live fan-out.
  // A reference/link does not confer ownership or select another shell's task.
  function shellTarget(s) {
    const current = s.currentTaskId && taskFor(s, s.currentTaskId);
    const executionSessionId = current?.ready ? current.sessionId : s.sourceSessionId;
    if (getRecord(executionSessionId)?.dirId !== s.dirId) throw failure('source_session_missing');
    return { shellId: s.id, sourceSessionId: s.sourceSessionId,
      taskId: current?.id || null, executionSessionId };
  }
  function existingShell(sessionId) {
    const source = getRecord(sessionId);
    const owner = owns(sessionId);
    if (owner && !owner.adopted) {
      const origin = owner.ownerShellId ? { shellId: owner.ownerShellId } : store.list('link').find(l => l.taskId === owner.id);
      const parent = origin && store.get('shell', origin.shellId);
      if (parent?.dirId === source?.dirId) return parent;
    }
    return store.get('shell', `sh_${hash(sessionId).slice(0, 24)}`);
  }
  function stateTarget(sessionId) {
    const s = existingShell(sessionId);
    return s ? shellTarget(s) : { shellId: null, sourceSessionId: sessionId,
      taskId: null, executionSessionId: sessionId };
  }
  function stateSources(executionSessionId) {
    return store.list('shell').filter(s => !s.archivedAt
      && getRecord(s.sourceSessionId)?.dirId === s.dirId)
      .filter(s => shellTarget(s).executionSessionId === executionSessionId)
      .map(s => s.sourceSessionId);
  }
  const changedSources = new Set();
  function saveShell(id, value) {
    const previous = store.get('shell', id);
    store.set('shell', id, value);
    if (previous?.currentTaskId === value.currentTaskId || !ports.onStateTargetChanged) return;
    changedSources.add(value.sourceSessionId);
    // Read again after the synchronous transaction commits (or rolls back).
    // Only a committed cursor is ever published, and repeated writes coalesce.
    queueMicrotask(() => {
      if (!changedSources.delete(value.sourceSessionId)) return;
      try { ports.onStateTargetChanged(value.sourceSessionId); }
      catch (error) { console.warn('[task-shell] state projection failed', cleanError(error)); }
    });
  }
  function chatScope(shellId, sessionId = null) {
    const s = shell(shellId);
    const sessionIds = [...new Set([s.sourceSessionId, ...linkedTasks(s).map(t => t.sessionId)])]
      .filter(id => getRecord(id)?.dirId === s.dirId);
    if (sessionId && !sessionIds.includes(sessionId)) throw failure('task_not_linked', 'Execution is outside this shell', 403);
    const target = shellTarget(s);
    return { ...target, sessionIds, activeSessionId: target.executionSessionId };
  }
  function contextSnapshots(s, excludedTaskId = null) {
    const snapshots = [];
    let bytes = 0;
    const records = shellRecords(chatScope(s.id), getHistory, ports.getLiveState).filter(m => !m.inProgress);
    for (const task of linkedTasks(s).filter(value => value.id !== excludedTaskId).reverse()) {
      const snapshot = historySnapshot(task.id, records.filter(m => m.taskId === task.id));
      if (!snapshot.messages.length) continue;
      const size = Buffer.byteLength(JSON.stringify(snapshot));
      if (bytes + size > 60000) continue;
      snapshots.unshift(snapshot);
      bytes += size;
    }
    return snapshots;
  }
  function traceSnapshot(snapshot, mode, includeMessages) {
    if (!verifySnapshot(snapshot, snapshot?.hash)) throw failure('snapshot_unverified');
    const source = store.get('task', snapshot.taskId);
    return {
      taskId: snapshot.taskId,
      taskName: source?.title || snapshot.taskId,
      mode,
      messageCount: snapshot.messages.length,
      omittedExchanges: snapshot.omittedExchanges || 0,
      estimatedTokens: estimateTokens(renderSnapshots([snapshot])),
      ...(includeMessages ? { messages: snapshot.messages } : {}),
    };
  }
  function contextTrace(sessionId, receiptId, { includeMessages = false } = {}) {
    const owner = owns(identifier(sessionId, 'sessionId'));
    if (!owner) throw failure('task_shell_context_unavailable', 'This session is not owned by a task shell', 404);
    const receipt = store.get('receipt', identifier(receiptId, 'receiptId'));
    if (!receipt || receipt.taskId !== owner.id) throw failure('receipt_not_found', 'receipt_not_found', 404);
    const current = store.get('task', receipt.attributedTaskId || receipt.taskId) || owner;
    const sources = [];
    const seen = new Set();
    for (const [mode, ids] of [
      ['imported', receipt.contextSeedSnapshotIds],
      ['refilled', receipt.contextRefillSnapshotIds],
    ]) {
      for (const id of (Array.isArray(ids) ? ids : [])) {
        const snapshot = store.get('snapshot', id);
        if (!snapshot || seen.has(`${mode}:${id}`)) continue;
        seen.add(`${mode}:${id}`);
        sources.push(traceSnapshot(snapshot, mode, includeMessages));
      }
    }
    return {
      version: 1,
      traceId: receipt.id,
      currentTask: { taskId: current.id, taskName: current.title || current.id, mode: 'native' },
      sources,
      managedOnly: true,
    };
  }
  function savingsFor(s, taskId) {
    return estimateTokens(renderSnapshots(contextSnapshots(s, taskId)));
  }
  function runtimeFrom(record) {
    return Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent']
      .filter(key => record?.[key] !== undefined).map(key => [key, record[key]]));
  }
  function indexedTask(taskId) {
    const value = getTask(taskId);
    return value && typeof value === 'object' ? value : null;
  }
  function assertWritable(id) {
    if (ports.isTaskLifecycleBusy?.(id)) throw failure('task_busy');
    if (ports.isDeletedTask?.(id)) throw failure('task_deleted');
    const task = indexedTask(id);
    if (task?.deleting) throw failure('task_deleting');
    if (task?.status === 'archived') throw failure('task_archived');
  }
  function purgeTasks(ids) {
    const removed = new Set(ids);
    store.transaction(() => {
      const snapshots = new Set(store.list('task').filter(t => removed.has(t.id)).flatMap(t => t.snapshotIds || []));
      const receipts = new Set(store.list('receipt').filter(r => removed.has(r.taskId)).map(r => r.id));
      for (const kind of ['task', 'link', 'claim', 'receipt', 'answer', 'fork']) {
        for (const [id, value] of store.entries(kind)) {
          if (removed.has(id) || removed.has(value.taskId) || receipts.has(value.receiptId)) store.remove(kind, id);
        }
      }
      for (const s of store.list('shell')) {
        if (s.standalone && removed.has(s.defaultTaskId)
          && !store.list('task').some(t => t.ownerShellId === s.id)) {
          store.remove('shell', s.id);
          continue;
        }
        if (removed.has(s.currentTaskId) || removed.has(s.defaultTaskId)) {
          if (removed.has(s.currentTaskId)) s.currentTaskId = null;
          if (removed.has(s.defaultTaskId)) s.defaultTaskId = null;
          s.cursorVersion = (s.cursorVersion || 0) + 1;
          saveShell(s.id, s);
        }
      }
      const used = new Set(store.list('task').flatMap(t => t.snapshotIds || []));
      for (const id of snapshots) if (!used.has(id)) store.remove('snapshot', id);
    });
  }
  function open(sessionId) {
    identifier(sessionId, 'sessionId');
    const source = getRecord(sessionId);
    if (!source || source.kind !== 'chat' || source.taskExecutionSlot || source.experimentalMode
      || ['aux', 'gateway', 'commander'].includes(source.type)) throw failure('unsupported_source', 'Use an ordinary chat', 400);
    const existing = existingShell(sessionId);
    if (existing) return existing;
    const id = `sh_${hash(sessionId).slice(0, 24)}`;
    const value = { id, sourceSessionId: sessionId, dirId: source.dirId, currentTaskId: null, cursorVersion: 0, standalone: !!source.taskBoundTaskId && !source.workspaceOwnerSessionId, createdAt: Date.now() };
    saveShell(id, value); return value;
  }
  function link(shellId, taskId) {
    const s = shell(shellId); const task = taskFor(s, taskId, false);
    store.set('link', `${s.id}:${task.id}`, { shellId: s.id, taskId: task.id });
    return task;
  }
  // Attach an existing execution without changing its native ID, worktree or
  // transcript. New work still goes through the same receipt protocol.
  function adopt(shellId, sessionId) {
    const s = shell(shellId), record = getRecord(sessionId);
    if (!record || record.dirId !== s.dirId || record.kind !== 'chat'
      || record.taskExecutionSlot || ['aux', 'gateway', 'commander'].includes(record.type)) throw failure('unsupported_source');
    return store.transaction(() => {
      let task = owns(sessionId);
      const history = getHistory(sessionId);
      const last = [...history].reverse().find(message => message.taskId && !message.inherited && !ports.isDeletedTask?.(message.taskId));
      // Transcript annotations are evidence, not an ownership transfer. Older
      // transcript forks copied taskId verbatim; consult the task's owner before
      // using that hint to adopt a session with no explicit live task binding.
      const historicalTask = last && (store.get('task', last.taskId) || indexedTask(last.taskId));
      const historicalSessionId = historicalTask?.sessionId || historicalTask?.chatSessionId;
      const historyTaskId = !historicalSessionId || historicalSessionId === sessionId ? last?.taskId : null;
      const id = task?.id || record.taskBoundTaskId || (record.taskState?.pendingUserInput
        && !record.taskState.pendingUserInput.resolved ? record.taskState.pendingUserInput.taskId : null)
        || record.taskState?.userInputSignalTaskId || historyTaskId
        || `tsk_${hash(['adopt', sessionId]).slice(0, 32)}`;
      const indexed = indexedTask(id);
      const title = indexed?.title || (historyTaskId && last?.taskName) || record.label || last?.content?.slice?.(0, 120) || sessionId;
      if (!task) {
        if (store.get('task', id)) throw failure('task_identity_mismatch');
        task = { id, dirId: s.dirId, sessionId, title, ownerShellId: s.id,
          parentTaskId: null, snapshotIds: [], ready: true, adopted: true, createdAt: Date.now(),
          runtime: runtimeFrom(record) };
        store.set('task', id, task);
      } else if (title && task.title !== title) {
        task.title = title;
        store.set('task', task.id, task);
      }
      link(s.id, task.id);
      if (!s.currentTaskId) {
        s.currentTaskId = task.id;
        s.defaultTaskId = task.id;
        saveShell(s.id, s);
      }
      return task;
    });
  }
  function locateOrCreate(shellId, identity = {}) {
    const s = shell(shellId);
    const id = identifier(identity.taskId, 'taskId');
    if (s.standalone && s.currentTaskId && id !== s.currentTaskId) throw failure('standalone_task_identity_locked');
    const indexed = indexedTask(id);
    const source = getRecord(s.sourceSessionId);
    if (!source) throw failure('source_session_missing');
    return store.transaction(() => {
      let task = store.get('task', id);
      if (task && task.dirId !== s.dirId) throw failure('project_mismatch', 'Tasks must belong to the same project', 403);
      const indexedSession = indexed?.chatSessionId && getRecord(indexed.chatSessionId);
      if (indexedSession && indexedSession.dirId !== s.dirId) throw failure('project_mismatch', 'Tasks must belong to the same project', 403);
      const title = String(indexed?.title || identity.taskText || identity.title || id).trim().slice(0, 120) || id;
      if (!task) {
        if (store.list('task').filter(value => value.dirId === s.dirId).length >= 200) {
          throw failure('task_shell_task_limit', 'Task limit reached (200 tasks/project)', 429);
        }
        const sessionId = indexedSession?.kind === 'chat' ? indexedSession.id : `task-${id.replace(/^tsk_/, '')}`;
        const owned = owns(sessionId);
        if (owned && owned.id !== id) throw failure('task_identity_mismatch');
        task = { id, dirId: s.dirId, sessionId, title, ownerShellId: s.id, parentTaskId: null, snapshotIds: [],
          ready: !!indexedSession, adopted: !!indexedSession, createdAt: Date.now(), runtime: runtimeFrom(source) };
        store.set('task', id, task);
      } else if (indexed?.title && task.title !== indexed.title) {
        task.title = String(indexed.title).slice(0, 120);
        store.set('task', id, task);
      }
      store.set('link', `${s.id}:${id}`, { shellId: s.id, taskId: id });
      return task;
    });
  }
  function resolveTask(shellId, identity = {}) {
    assertWritable(identity.taskId);
    const task = locateOrCreate(shellId, identity);
    const s = shell(shellId);
    if (taskActions.ownerOf(task)?.id !== shellId) throw failure('task_owner_mismatch');
    return store.transaction(() => {
      s.cursorVersion = (s.cursorVersion || 0) + 1;
      s.cursorReceiptId = null;
      s.currentTaskId = task.id;
      s.defaultTaskId = task.id;
      saveShell(s.id, s);
      return task;
    });
  }
  function remove(shellId) {
    const s = shell(shellId);
    if (store.list('task').some(task => taskActions.ownerOf(task)?.id === s.id)) {
      store.set('shell', s.id, { ...s, archivedAt: Date.now() }); return { ok: true, archived: true };
    }
    store.transaction(() => {
      store.remove('shell', s.id);
      for (const link of store.list('link').filter(l => l.shellId === s.id)) store.remove('link', `${s.id}:${link.taskId}`);
    });
    return { ok: true };
  }
  function view(shellId) {
    const s = shell(shellId);
    if (!s.currentTaskId && s.defaultTaskId) {
      s.currentTaskId = s.defaultTaskId;
      saveShell(s.id, s);
    }
    const receipts = store.list('receipt').filter(r => r.shellId === s.id).slice(-100);
    const latestWork = [...receipts].reverse().find(receipt => receipt.payload.intent === 'work' && receipt.status === 'accepted');
    return { ...s, enabled: true, tasks: linkedTasks(s),
      availableTasks: store.list('task').filter(t => t.dirId === s.dirId).map(t => ({ id: t.id, title: t.title })),
      tokenSavings: latestWork?.contextSavings || null,
      receipts: receipts.map(r => ({
        id: r.id, clientMsgId: r.payload.clientMsgId, taskId: r.taskId, intent: r.payload.intent,
        status: r.status, error: r.error || null, contextSavings: r.contextSavings || null,
      })) };
  }
  async function detail(shellId, taskId) {
    const task = taskFor(shell(shellId), taskId);
    const execution = task.ready ? await getExecution(task.sessionId) : { busy: true, status: 'preparing' };
    return { task, execution, messages: shellRecords(chatScope(shellId), getHistory)
      .filter(m => m.taskId === taskId || (!m.taskId && m.sourceSessionId === task.sessionId)).slice(-200),
      snapshots: task.snapshotIds.map(id => store.get('snapshot', id)) };
  }
  function normalize(raw = {}) {
    const clientMsgId = identifier(raw.clientMsgId, 'clientMsgId');
    const intent = raw.intent || 'work';
    if (!['work', 'steer', 'answer', 'cancel'].includes(intent)) throw failure('invalid_intent', 'invalid_intent', 400);
    if (typeof raw.text !== 'string' || (intent !== 'cancel' && !raw.text.trim()) || raw.text.length > 32000) throw failure('invalid_text', 'invalid_text', 400);
    const list = field => {
      if (raw[field] == null) return [];
      if (!Array.isArray(raw[field]) || raw[field].length > 3) throw failure('invalid_input', `invalid ${field}`, 400);
      return [...new Set(raw[field].map(v => identifier(v, field)))].sort();
    };
    const result = { clientMsgId, intent, text: raw.text.trim(), taskId: raw.taskId == null ? null : identifier(raw.taskId, 'taskId'),
      newTask: raw.newTask === true,
      ...(raw.expectedCursorVersion == null ? {} : { expectedCursorVersion: Number(raw.expectedCursorVersion) }),
      contextTaskIds: list('contextTaskIds'), dependsOn: list('dependsOn'),
      turnId: raw.turnId == null ? null : identifier(raw.turnId, 'turnId'),
      requestId: raw.requestId == null ? null : identifier(raw.requestId, 'requestId') };
    if (raw.goal === true || raw.goalLimits != null) result.goalLimits = resolveGoalLimits(raw.goalLimits);
    if (intent !== 'work' && (result.newTask || !result.taskId || !result.turnId || result.contextTaskIds.length || result.dependsOn.length)) throw failure('invalid_control', 'Controls require the original task and turn', 400);
    if (intent === 'answer' && !result.requestId) throw failure('invalid_control', 'Answer requires requestId', 400);
    return result;
  }
  function checkControl(payload, state) {
    if (!state || payload.turnId !== state.turnId) throw failure('stale_control', 'The task has moved to another turn');
    if (payload.intent === 'answer' && (!state.pending || state.pending.resolved || state.pending.requestId !== payload.requestId
      || state.pending.taskId !== payload.taskId)) throw failure('stale_control', 'The question is no longer pending');
    if (payload.intent === 'steer' && state.pending && !state.pending.resolved) throw failure('answer_required');
  }
  async function reserve(s, payload, receiptId, fingerprint, delivery = {}) {
    if (s.standalone && payload.newTask) throw failure('standalone_task_identity_locked');
    const selectedTaskId = payload.newTask ? null : payload.taskId || s.currentTaskId || s.defaultTaskId || null;
    const target = selectedTaskId ? taskFor(s, selectedTaskId) : null;
    if (target) assertWritable(target.id);
    const observedClaim = target ? store.get('claim', target.id)?.receiptId : null;
    const state = target ? await getExecution(target.sessionId) : null;
    if (payload.intent !== 'work') {
      if (payload.intent === 'answer' && store.get('answer', `${target.id}:${payload.requestId}`)) throw failure('answer_already_reserved');
      checkControl(payload, state);
    }
    const references = [...new Set([...payload.contextTaskIds, ...payload.dependsOn])];
    const contexts = new Map();
    for (const id of references) {
      const source = taskFor(s, id);
      const sourceState = await getExecution(source.sessionId);
      if (payload.dependsOn.includes(id) && (sourceState.busy !== false || !sourceState.completed)) throw failure('dependency_not_ready');
      contexts.set(id, snapshotHistory(id, getHistory(source.sessionId), { activeTurnId: sourceState.turnId && sourceState.busy ? sourceState.turnId : null }));
    }
    return store.transaction(() => {
      const existing = store.get('receipt', receiptId);
      if (target) assertWritable(target.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw failure('idempotency_conflict');
        return existing;
      }
      const currentShell = shell(s.id);
      if (payload.intent === 'work' && !delivery.taskIdentityLocked && (
        (payload.expectedCursorVersion != null && payload.expectedCursorVersion !== (currentShell.cursorVersion || 0))
        || (!payload.newTask && payload.taskId && payload.taskId !== currentShell.currentTaskId)
        || (!payload.newTask && !payload.taskId && selectedTaskId !== (currentShell.currentTaskId || currentShell.defaultTaskId || null))
      )) throw failure('stale_shell_cursor', 'The current task changed; refresh before sending');
      if (target && taskActions.ownerOf(target)?.id !== s.id) throw failure('task_owner_mismatch', 'Open the owning conversation or fork this task');
      const claim = target && store.get('claim', target.id);
      const last = claim && store.get('receipt', claim.receiptId);
      const busy = target && (state?.busy !== false || claim?.receiptId !== observedClaim
        || (last && last.status !== 'accepted'));
      if (target && payload.intent === 'work' && references.length) throw failure('context_requires_new_task', 'Start a new task to import versioned context');
      let task = target;
      if (!task) {
        if (store.list('task').filter(t => t.dirId === s.dirId).length >= 200) throw failure('task_shell_task_limit', 'Task limit reached (200 tasks/project)', 429);
        const snapshotIds = [];
        for (const value of contexts.values()) { store.set('snapshot', value.hash, value); snapshotIds.push(value.hash); }
        const id = `tsk_${randomUUID().replace(/-/g, '')}`;
        const source = getRecord(s.sourceSessionId);
        if (!source) throw failure('source_session_missing');
        task = { id, dirId: s.dirId, sessionId: `task-${id.slice(4)}`, ownerShellId: s.id, parentTaskId: null,
          title: payload.text.slice(0, 120), snapshotIds, ready: false, createdAt: Date.now(),
          runtime: Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'agent'].filter(k => source[k] !== undefined).map(k => [k, source[k]])) };
        store.set('task', id, task);
      }
      if (payload.intent === 'answer') {
        const key = `${task.id}:${payload.requestId}`;
        if (store.get('answer', key)) throw failure('answer_already_reserved');
        store.set('answer', key, { receiptId });
      }
      const receipt = { id: receiptId, shellId: s.id, taskId: task.id, fingerprint, payload,
        taskIdentityLocked: delivery.taskIdentityLocked === true,
        taskMetadata: delivery.taskMetadata || null,
        cursorVersion: payload.intent === 'work' ? (currentShell.cursorVersion || 0) + 1 : currentShell.cursorVersion || 0,
        status: 'reserved', decision: target ? payload.intent === 'work' ? (busy ? 'queued' : 'continue') : payload.intent : 'new',
        contextSavings: payload.intent === 'work' ? {
          estimatedTokens: savingsFor(s, task.id), contextRefilled: false,
        } : null,
        createdAt: Date.now() };
      store.set('receipt', receiptId, receipt);
      if (payload.intent === 'work') {
        currentShell.cursorVersion = receipt.cursorVersion;
        currentShell.cursorReceiptId = receipt.id;
        saveShell(s.id, currentShell);
      }
      if (payload.intent === 'work') store.set('claim', task.id, { receiptId });
      store.set('link', `${s.id}:${task.id}`, { shellId: s.id, taskId: task.id });
      return receipt;
    });
  }
  async function deliver(receipt) {
    if (receipt.status === 'accepted') return receipt.result;
    const task = store.get('task', receipt.taskId);
    if (!task.ownerShellId) { task.ownerShellId = taskActions.ownerOf(task)?.id || receipt.shellId; store.set('task', task.id, task); }
    const needsCapacity = receipt.payload.intent === 'work';
    if (needsCapacity) launching.add(task.id);
    try {
      if (needsCapacity) await checkCapacity(task);
      if (!task.ready) {
        const created = await createExecution(task, task.runtime);
        if (!created?.ok) throw failure(created?.code || 'execution_create_failed', created?.error || 'execution_create_failed', 500);
        task.ready = true; task.baseline = created.baseline;
        store.set('task', task.id, task);
      }
      if (ports.prepareExecution) await ports.prepareExecution(task, taskActions.ownerOf(task));
      const indexed = await indexTask(task);
      if (!indexed?.ok) throw failure('task_index_failed', indexed?.error || 'task_index_failed', 500);
      let result;
      const p = receipt.payload;
      if (p.intent === 'cancel') {
        // An ambiguous cancel cannot kill a newer turn after a retry/restart.
        const state = await getExecution(task.sessionId);
        checkControl(p, state);
        result = await cancel(task.sessionId, p.turnId);
      } else {
        const snapshotIds = [...new Set([...(task.snapshotIds || []), ...(task.handoffSnapshotIds || [])])];
        const snapshots = snapshotIds.map(id => {
          const snapshot = store.get('snapshot', id);
          if (!verifySnapshot(snapshot, id)) throw failure('snapshot_unverified');
          return snapshot;
        });
        // Stable key is the handoff protocol across the SQLite/outbox boundary.
        receipt.contextSeedSnapshotIds = snapshotIds;
        receipt.status = 'delivering'; store.set('receipt', receipt.id, receipt);
        const metadata = receipt.taskMetadata || {};
        result = await send(task.sessionId, p.text, {
          taskId: task.id, taskStart: receipt.taskIdentityLocked ? metadata.taskStart !== false : true,
          taskText: receipt.taskIdentityLocked ? (metadata.taskStart === false ? null : metadata.taskText || p.text) : p.intent === 'work' ? p.text : task.title,
          taskSource: 'task-shell',
          clientMsgId: receipt.id, idempotencyKey: receipt.id, taskShellReceiptId: receipt.id,
          receivedAt: receipt.createdAt,
          ...(p.goalLimits ? { goalLimits: p.goalLimits } : {}),
          ...(p.intent !== 'work' ? { taskShellControl: { intent: p.intent, turnId: p.turnId } } : {}),
          taskContextSeed: renderSnapshots(snapshots),
          taskShellAutoClassify: p.intent === 'work' && p.newTask !== true && !receipt.taskIdentityLocked && !taskActions.ownerOf(task)?.standalone,
          ...(p.intent === 'answer' ? { userInputRequestId: p.requestId } : {}),
          ...(p.intent === 'steer' || ['continue', 'queued'].includes(receipt.decision) ? { originContinue: true } : {}),
        });
      }
      if (!result?.ok) throw failure(result?.code || 'delivery_failed', result?.error || result?.code || 'delivery_failed');
      receipt.status = 'accepted'; receipt.error = null;
      receipt.result = { ok: true, taskId: task.id, sessionId: task.sessionId, receiptId: receipt.id, decision: receipt.decision };
      store.set('receipt', receipt.id, receipt);
      if (receipt.payload.intent === 'work') store.transaction(() => {
        const delivered = store.get('task', task.id);
        if (delivered.handoffSnapshotIds?.length) {
          const consumed = new Set(receipt.contextSeedSnapshotIds || []);
          delivered.handoffSnapshotIds = delivered.handoffSnapshotIds.filter(id => !consumed.has(id));
          store.set('task', task.id, delivered);
        }
        const owner = shell(receipt.shellId);
        if (owner.cursorReceiptId !== receipt.id || (owner.cursorVersion || 0) !== receipt.cursorVersion) return;
        owner.currentTaskId = task.id;
        owner.defaultTaskId = task.id;
        owner.cursorReceiptId = receipt.id;
        saveShell(owner.id, owner);
      });
      return receipt.result;
    } catch (error) {
      const notDelivered = error.code === 'stale_control';
      receipt.status = notDelivered ? 'rejected' : 'failed'; receipt.error = cleanError(error);
      store.set('receipt', receipt.id, receipt);
      throw Object.assign(failure(receipt.error.code, receipt.error.message, error.status || 500), { receiptId: receipt.id, taskId: task.id, notDelivered });
    } finally { if (needsCapacity) launching.delete(task.id); }
  }
  async function sendInput(shellId, raw, delivery = {}) {
    const s = shell(shellId), payload = normalize(raw);
    const id = `sr_${hash([s.id, payload.clientMsgId]).slice(0, 40)}`, fingerprint = hash(payload);
    let receipt = store.get('receipt', id);
    if (receipt && receipt.fingerprint !== fingerprint) throw failure('idempotency_conflict');
    if (flights.has(id)) return flights.get(id);
    const operation = (async () => {
      receipt = receipt || await reserve(s, payload, id, fingerprint, delivery);
      return deliver(receipt);
    })();
    flights.set(id, operation);
    try { return await operation; } finally { flights.delete(id); }
  }
  function sendExplicit(shellId, raw, identity = {}) {
    const task = locateOrCreate(shellId, identity);
    return sendInput(shellId, { ...raw, taskId: task.id }, {
      taskIdentityLocked: true,
      taskMetadata: {
        taskStart: identity.taskStart === true,
        taskSource: identity.taskSource || null,
        taskText: String(identity.taskText || raw.text || ''),
      },
    });
  }
  function owns(sessionId) { return store.list('task').find(t => t.sessionId === sessionId) || null; }
  function recentTasks(sessionId, receiptId = null) {
    const task = owns(sessionId);
    if (!task) return [];
    const receipt = receiptId ? store.get('receipt', receiptId) : store.get('claim', task.id) && store.get('receipt', store.get('claim', task.id).receiptId);
    if (!receipt) return [];
    return linkedTasks(shell(receipt.shellId)).map(value => ({ taskId: value.id, taskName: value.title || '' }));
  }
  function refillContext(sessionId, { receiptId = null, ...query } = {}) {
    const task = owns(sessionId);
    if (!task) throw failure('task_shell_context_unavailable', 'This turn is not owned by a task shell', 404);
    let receipt = receiptId ? store.get('receipt', receiptId) : null;
    if (!receipt || receipt.taskId !== task.id) {
      const claim = store.get('claim', task.id);
      receipt = claim ? store.get('receipt', claim.receiptId) : null;
    }
    if (!receipt || receipt.taskId !== task.id) throw failure('task_shell_context_unavailable', 'No active task-shell delivery was found', 409);
    const s = shell(receipt.shellId);
    if (query.task_id) taskFor(s, query.task_id);
    const page = Object.keys(query).length ? contextPage(shellRecords(chatScope(s.id), getHistory, ports.getLiveState), query) : null;
    const snapshots = page ? pageSnapshots(page) : contextSnapshots(s, task.id);
    const rendered = renderSnapshots(snapshots);
    receipt.contextSavings = {
      estimatedTokens: 0,
      originalEstimatedTokens: receipt.contextSavings?.originalEstimatedTokens
        ?? receipt.contextSavings?.estimatedTokens ?? estimateTokens(rendered),
      contextRefilled: true,
    };
    receipt.contextRefillTaskIds = [...new Set([...(receipt.contextRefillTaskIds || []), ...snapshots.map(value => value.taskId).filter(Boolean)])];
    receipt.contextRefillSnapshotIds = [...new Set([...(receipt.contextRefillSnapshotIds || []), ...snapshots.map(value => value.hash)])];
    for (const snapshot of snapshots) store.set('snapshot', snapshot.hash, snapshot);
    store.set('receipt', receipt.id, receipt);
    return {
      ok: true,
      current_task_id: task.id,
      task_ids: receipt.contextRefillTaskIds,
      tasks: linkedTasks(s).map(t => ({ taskId: t.id, taskName: t.title })),
      ...(page ? { page } : {}),
      estimated_tokens: estimateTokens(rendered),
      context: page ? 'Historical data; preserve execution status and source. Use page.before or message_id/offset to read further.'
        : rendered || 'No attributed history from other linked tasks is available. Use limit to browse shell history, including untagged records.',
    };
  }
  function settleAttribution(sessionId, receiptId, attribution = {}) {
    const owner = owns(sessionId);
    const receipt = receiptId && store.get('receipt', receiptId);
    if (!owner || !receipt || receipt.taskId !== owner.id) return { ok: false, code: 'task_shell_receipt_not_found' };
    const s = shell(receipt.shellId);
    const nextId = attribution.taskId || owner.id;
    if (taskActions.ownerOf(owner)?.standalone && nextId !== owner.id) return { ok: false, code: 'standalone_task_identity_locked' };
    if (s.currentTaskId !== owner.id || (s.cursorReceiptId && s.cursorReceiptId !== receipt.id)
        || (receipt.cursorVersion !== undefined && receipt.cursorVersion !== (s.cursorVersion || 0))) {
      return { ok: false, code: 'task_shell_attribution_superseded' };
    }
    const snapshot = nextId === owner.id ? null : handoffSnapshot(nextId, getHistory(sessionId), {
      ...attribution, sessionId, receipt, sourceWorkspace: getRecord(sessionId)?.worktreePath || getRecord(sessionId)?.cwd,
    });
    return store.transaction(() => {
      let next = store.get('task', nextId);
      if (next && next.dirId !== s.dirId) throw failure('project_mismatch');
      if (!next) {
        const snapshotIds = [];
        if (snapshot.messages.length) { store.set('snapshot', snapshot.hash, snapshot); snapshotIds.push(snapshot.hash); }
        next = { id: nextId, dirId: owner.dirId, ownerShellId: owner.ownerShellId || s.id, sessionId: `task-${nextId.replace(/^tsk_/, '')}`,
          parentTaskId: attribution.relatedTaskId || null, title: attribution.taskName || receipt.payload.text.slice(0, 120),
          snapshotIds, ready: false, createdAt: Date.now(), runtime: { ...owner.runtime } };
        store.set('task', next.id, next);
      } else if (next.ownerShellId && next.ownerShellId !== (owner.ownerShellId || s.id)) {
        return { ok: false, code: 'task_owner_mismatch' };
      } else if (next.id !== owner.id && snapshot?.messages.length) {
        store.set('snapshot', snapshot.hash, snapshot);
        next.handoffSnapshotIds = [...new Set([...(next.handoffSnapshotIds || []), snapshot.hash])];
        store.set('task', next.id, next);
      }
      if (attribution.taskName && next.title !== attribution.taskName) {
        next.title = attribution.taskName;
        store.set('task', next.id, next);
      }
      store.set('link', `${s.id}:${next.id}`, { shellId: s.id, taskId: next.id });
      s.cursorVersion = (s.cursorVersion || 0) + 1;
      s.currentTaskId = next.id;
      s.defaultTaskId = next.id;
      saveShell(s.id, s);
      receipt.attributedTaskId = next.id;
      store.set('receipt', receipt.id, receipt);
      return { ok: true, taskId: next.id, changed: next.id !== owner.id };
    });
  }
  async function retry(shellId, receiptId) {
    const s = shell(shellId);
    const receipt = store.get('receipt', identifier(receiptId, 'receiptId'));
    if (!receipt || receipt.shellId !== s.id) throw failure('receipt_not_found', 'receipt_not_found', 404);
    return sendInput(s.id, receipt.payload);
  }
  function guardAdmission(sessionId, text, options = {}) {
    const task = owns(sessionId);
    if (!task) return null;
    try { assertWritable(options.taskId || task.id); } catch (error) { return { ok: false, code: error.code }; }
    // Admission timestamps are assigned by the host, never accepted from Web
    // messages. Work already durably queued before adoption keeps its identity.
    if (task.adopted && Number.isFinite(options.receivedAt) && options.receivedAt < task.createdAt) return null;
    if (options.taskId && options.taskId !== task.id) return { ok: false, code: 'task_identity_mismatch' };
    const receipt = options.taskShellReceiptId && store.get('receipt', options.taskShellReceiptId);
    if (receipt && receipt.taskId === task.id && receipt.payload.text === text
      && options.clientMsgId === receipt.id) return null;
    // Host-owned retry/callback carries originContinue; web clients never get
    // to set it. It resumes exactly this execution, with the immutable task ID.
    if (options.originContinue === true) { options.taskId = task.id; return null; }
    return { ok: false, code: 'task_shell_route_required' };
  }
  return {
    ...taskActions, purgeTasks, stateTarget, stateSources, open, adopt, link, remove, view, detail, chatScope, send: sendInput, retry, owns,
    guardAdmission, recentTasks, refillContext, contextTrace, settleAttribution, locateOrCreate, resolveTask, sendExplicit,
  };
}

module.exports = { createTaskShellRuntime, failure, cleanError };

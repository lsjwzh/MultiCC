'use strict';
const { MAX_TASKS_PER_DIRECTORY, directoryAtCapacity } = require('../native/runtime').taskShellCapacity;

const { randomUUID } = require('node:crypto');
const {
  estimateTokens, snapshotHistory, renderSnapshots, hash,
} = require('../native/runtime').taskShellContext;
const { relatedHistory, shellRecords, historySnapshot, handoffSnapshot, contextPage, pageSnapshots } = require('./history-context');
const { getNative } = require('../native/runtime');

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
  async function ensureTaskSlot(dirId, excludedIds = []) {
    if (!directoryAtCapacity(store, dirId)) return;
    await ports.evictTaskForCapacity?.(dirId, () => store.list('task'), () => directoryAtCapacity(store, dirId), excludedIds);
    if (directoryAtCapacity(store, dirId)) throw failure('task_shell_task_limit',
      `Task limit reached (${MAX_TASKS_PER_DIRECTORY} tasks/project)`, 409);
  }
  const flights = new Map();
  const roles = require('./role-bindings').createRoleBindings(store, { getRecord, getDirectory: ports.getDirectory, assertWritable });
  // Keep port reads live: host/tests may replace a callback after construction.
  const capacityPorts = Object.assign(Object.create(ports), { ensureTaskSlot });
  const taskActions = require('./task-actions').createTaskActions({ store, getRecord, getTask, getHistory, getExecution, createExecution, indexTask, ports: capacityPorts, shell, open, chatScope });
  const separation = require('./separation').createTaskSeparation({ store, getRecord, getHistory, getExecution, createExecution, indexTask, ports: capacityPorts, ownerOf: taskActions.ownerOf, roles });
  const independent = require('./independent-continue').createIndependentContinuation({ store, getRecord, getHistory,
    getExecution, createExecution, indexTask, ports, ownerOf: taskActions.ownerOf, roles, hasCapacity });
  const relations = require('../native/runtime').getTaskRelations().createTaskRelations({ store, taskTitle: id => store.get('task', id)?.title || null,
    onChanged: id => ports.onRelationChanged?.(id) });
  const taskFirst = require('./task-first').createTaskFirstMigration({ store, open, adopt, roles, indexTask, ports });
  const launching = new Set();
  const maxConcurrent = Number.isInteger(ports.maxConcurrent) && ports.maxConcurrent > 0 ? ports.maxConcurrent : 4;
  async function checkCapacity(task) {
    const others = store.list('task').filter(t => t.id !== task.id && t.dirId === task.dirId && t.ready);
    const states = await Promise.all(others.map(async t => ({ id: t.id, busy: (await getExecution(t.sessionId)).busy })));
    const occupied = new Set(states.filter(s => s.busy !== false).map(s => s.id));
    for (const id of launching) if (id !== task.id && store.get('task', id)?.dirId === task.dirId) occupied.add(id);
    if (occupied.size >= maxConcurrent) throw failure('task_shell_capacity', `At most ${maxConcurrent} occupied tasks per project; retry this delivery when capacity is available`, 429);
  }
  // The same capacity rule the delivery path enforces, asked as a question:
  // "independent continue" waits for a free slot instead of failing a delivery.
  async function hasCapacity(task) {
    try { await checkCapacity(task); return true; } catch (_) { return false; }
  }

  // P3 图谱上下文：宿主注入 ports.taskGraphContext（父任务记忆 / 同组摘要 /
  // 同壳前序结论）。缺失或抛错一律降级为 null——上下文增强绝不能挡住投递。
  // 返回 { text, sources }；旧式只返回纯字符串的 port 也兼容（sources 为空）。
  // sources 是「引用来源」的凭据：哪个任务、什么关系、实际注入了哪一行。
  function graphContextOf(taskId, options) {
    if (typeof ports.taskGraphContext !== 'function') return null;
    try {
      const value = ports.taskGraphContext(taskId, options);
      if (typeof value === 'string') return value ? { text: value, sources: [] } : null;
      if (value && typeof value === 'object') {
        const text = String(value.text || '');
        const sources = (Array.isArray(value.sources) ? value.sources : [])
          .filter(source => source && typeof source.taskId === 'string' && source.taskId);
        return text || sources.length || value.candidates ? { ...value, text, sources } : null;
      }
      return null;
    } catch (error) { return { text: '', sources: [], diagnostics: [{ reason: error.message }] }; }
  }
  const snapshotTaskHistory = ports.snapshotTaskHistory || ((sessionId, taskId, activeTurnId = null) =>
    snapshotHistory(taskId, getHistory(sessionId), { activeTurnId }));
  const contextPlanner = require('./context-plan').createContextPlanner({ store, getRecord, snapshotTaskHistory, getTask, graphContextOf });
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
  // 行缓存版本：一次解析后复用，避免每个 HTTP 请求把 10MB 的 task 表重新
  // JSON.parse 一遍（CPU profile 实测占进程 60%）。返回的行对象是共享、只读的。
  function linkedTasks(s) {
    const ids = new Set(store.cachedEntries('link').filter(([, value]) => value.shellId === s.id).map(([, value]) => value.taskId));
    return store.cachedList('task').filter(task => ids.has(task.id));
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
      const origin = owner.ownerShellId ? { shellId: owner.ownerShellId } : store.linkByTask(owner.id);
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
    return store.cachedList('shell').filter(s => !s.archivedAt
      && getRecord(s.sourceSessionId)?.dirId === s.dirId)
      .filter(s => shellTarget(s).executionSessionId === executionSessionId)
      .map(s => s.sourceSessionId);
  }
  const changedSources = new Set();
  function saveShell(id, value) {
    const previous = store.get('shell', id);
    store.set('shell', id, value);
    if (previous?.currentTaskId !== value.currentTaskId) publishStateTarget(value.sourceSessionId);
  }
  function publishStateTarget(sourceSessionId) {
    if (!ports.onStateTargetChanged) return;
    changedSources.add(sourceSessionId);
    // Read again after the synchronous transaction commits (or rolls back).
    // Only a committed cursor is ever published, and repeated writes coalesce.
    queueMicrotask(() => {
      if (!changedSources.delete(sourceSessionId)) return;
      try { ports.onStateTargetChanged(sourceSessionId); }
      catch (error) { console.warn('[task-shell] state projection failed', cleanError(error)); }
    });
  }
  function chatScope(shellId, sessionId = null) {
    const s = shell(shellId);
    const sessionIds = [...new Set([s.sourceSessionId, ...linkedTasks(s).map(t => t.sessionId)])]
      .filter(id => getRecord(id)?.dirId === s.dirId);
    if (sessionId && !sessionIds.includes(sessionId)) throw failure('task_not_linked', 'Execution is outside this shell', 403);
    const target = shellTarget(s);
    // The chat page needs the input cursor as a display handle ("下一条发给
    // #ABCD"), not just its id: mint the code here so the page never has to
    // guess one from a taskId suffix. It is a read of the same cursor the
    // index already marks with `target`.
    const code = target.taskId ? String(ports.taskShortCode?.(target.taskId) || '').trim().toUpperCase() : '';
    return { ...target, sessionIds, activeSessionId: target.executionSessionId,
      taskShortCode: /^[0-9A-Z]{4}$/.test(code) ? code : '' };
  }
  function contextSnapshots(s, excludedTaskId = null) {
    const tasks = linkedTasks(s).filter(value => value.id !== excludedTaskId).reverse();
    if (!tasks.length) return [];
    const buckets = new Map(tasks.map(task => [task.id, { total: 0, items: [] }]));
    const decorate = (m, sourceSessionId) => ({
      ...m, sourceSessionId, sourceMessageId: m.id, contextMessageId: `${sourceSessionId}:${m.id}`,
    });
    for (const sourceSessionId of chatScope(s.id).sessionIds) {
      const records = getHistory(sourceSessionId);
      const activeStart = ports.getLiveState?.(sourceSessionId)?.isStreaming
        ? records.findLastIndex(m => m.role === 'user') : -1;
      const limit = activeStart >= 0 ? activeStart : records.length;
      const perSession = new Map();
      for (let index = limit - 1; index >= 0; index--) {
        const message = records[index];
        const bucket = message && buckets.get(message.taskId);
        if (!bucket) continue;
        bucket.total += 1;
        let state = perSession.get(message.taskId);
        if (!state) {
          state = { tail: [], needUser: true };
          perSession.set(message.taskId, state);
        }
        if (state.tail.length < 10) {
          state.tail.push(decorate(message, sourceSessionId));
          if (message.role === 'user') state.needUser = false;
        } else if (state.needUser && message.role === 'user') {
          state.tail.push(decorate(message, sourceSessionId));
          state.needUser = false;
        }
      }
      for (const [taskId, state] of perSession) {
        const bucket = buckets.get(taskId);
        for (let i = state.tail.length - 1; i >= 0; i--) bucket.items.push(state.tail[i]);
      }
    }
    const snapshots = [];
    let bytes = 0;
    for (const task of tasks) {
      const bucket = buckets.get(task.id);
      if (!bucket.items.length) continue;
      if (bucket.items.length > 1) bucket.items.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      const snapshot = historySnapshot(task.id, bucket.items, bucket.total);
      if (!snapshot.messages.length) continue;
      const size = Buffer.byteLength(JSON.stringify(snapshot));
      if (bytes + size > 60000) continue;
      snapshots.unshift(snapshot);
      bytes += size;
    }
    return snapshots;
  }
  function contextTrace(sessionId, receiptId, { includeMessages = false, summary = false } = {}) {
    return store.shellContextTrace({ sessionId, receiptId, includeMessages, summary });
  }
  function savingsFor(s, taskId) {
    return estimateTokens(renderSnapshots(contextSnapshots(s, taskId)));
  }
  function runtimeFrom(record) {
    return Object.fromEntries(['cli', 'model', 'provider', 'providerSelection', 'effort', 'claudeWorkflow', 'preferSubtasks', 'agent']
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
      // 存储键是任务 id、正文 taskId 指向任务、或 receiptId 指向这些任务收据的行，
      // 在 Rust 里按引用列索引删除（含派生索引维护），不再全表扫描收据。
      store.purgeTaskRefs(['task', 'link', 'claim', 'receipt', 'answer', 'fork', 'task-separation',
        'context-ledger', 'context-source'], ids);
      const remainingTasks = store.list('task');
      const occupiedShells = new Set(remainingTasks.map(t => t.ownerShellId));
      for (const s of store.list('shell')) {
        if (s.standalone && removed.has(s.defaultTaskId)
          && !occupiedShells.has(s.id)) {
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
      const used = new Set(remainingTasks.flatMap(t => t.snapshotIds || []));
      for (const id of snapshots) if (!used.has(id)) store.remove('snapshot', id);
    });
  }
  function open(sessionId) {
    identifier(sessionId, 'sessionId');
    const record = getRecord(sessionId);
    const existing = existingShell(sessionId);
    const opened = store.registerChatShell({ sessionId, record, taskFirst: ports.taskFirst === true });
    if (!existing) publishStateTarget(opened.sourceSessionId);
    return opened;
  }
  function link(shellId, taskId) {
    const s = shell(shellId); const task = taskFor(s, taskId, false);
    store.set('link', `${s.id}:${task.id}`, { shellId: s.id, taskId: task.id });
    return task;
  }
  function adoptionFacts(sessionId) {
    const record = getRecord(sessionId);
    if (!record) return { sessionId, record, taskFirst: ports.taskFirst === true };
    const owned = owns(sessionId);
    const pending = !owned?.id && !record?.taskBoundTaskId
      ? (ports.pendingUserInput ? ports.pendingUserInput(sessionId) : record?.taskState?.pendingUserInput) : null;
    const last = [...getHistory(sessionId)].reverse()
      .find(message => message.taskId && !message.inherited && !ports.isDeletedTask?.(message.taskId));
    const candidates = [owned?.id, record?.taskBoundTaskId, pending?.taskId,
      record?.taskState?.userInputSignalTaskId, last?.taskId, `tsk_${hash(['adopt', sessionId]).slice(0, 32)}`];
    const indexed = Object.fromEntries([...new Set(candidates.filter(Boolean))].map(id => [id, indexedTask(id)]));
    return { sessionId, record, pending, indexed, taskFirst: ports.taskFirst === true,
      last: last && { taskId: last.taskId, taskName: last.taskName, content: last.content?.slice?.(0, 120) } };
  }
  function adopt(shellId, sessionId) {
    const previous = shell(shellId);
    const task = store.adoptChatShell({ ...adoptionFacts(sessionId), shellId });
    if (!previous.currentTaskId) publishStateTarget(previous.sourceSessionId);
    return task;
  }
  function openForSession(sessionId) {
    const previous = existingShell(sessionId);
    const opened = store.openChatShell(adoptionFacts(sessionId));
    if (previous?.currentTaskId !== opened.currentTaskId) publishStateTarget(opened.sourceSessionId);
    return opened;
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
        if (directoryAtCapacity(store, s.dirId)) {
          throw failure('task_shell_task_limit', `Task limit reached (${MAX_TASKS_PER_DIRECTORY} tasks/project)`, 429);
        }
        const sessionId = indexedSession?.kind === 'chat' ? indexedSession.id : `task-${id.replace(/^tsk_/, '')}`;
        const owned = owns(sessionId);
        if (owned && owned.id !== id) throw failure('task_identity_mismatch');
        task = { id, dirId: s.dirId, sessionId, title, ownerShellId: s.id, taskFirst: ports.taskFirst === true, parentTaskId: null, snapshotIds: [],
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
  function validateNewLocate(shellId, identity) {
    const s = shell(shellId), id = identifier(identity.taskId, 'taskId');
    if (s.standalone && s.currentTaskId && id !== s.currentTaskId) throw failure('standalone_task_identity_locked');
    if (!getRecord(s.sourceSessionId)) throw failure('source_session_missing');
    const indexed = indexedTask(id), indexedSession = indexed?.chatSessionId && getRecord(indexed.chatSessionId);
    if (indexedSession && indexedSession.dirId !== s.dirId) throw failure('project_mismatch', 'Tasks must belong to the same project', 403);
    const sessionId = indexedSession?.kind === 'chat' ? indexedSession.id : `task-${id.replace(/^tsk_/, '')}`;
    const owned = owns(sessionId);
    if (owned && owned.id !== id) throw failure('task_identity_mismatch');
    return s;
  }
  async function resolveTask(shellId, identity = {}) {
    assertWritable(identity.taskId);
    if (!store.get('task', identity.taskId)) {
      const owner = validateNewLocate(shellId, identity);
      await ensureTaskSlot(owner.dirId, [owner.currentTaskId, owner.defaultTaskId]);
    }
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
      // Only a real delete drops the shell's journal rows (the archive path
      // above keeps them, so an archived conversation can still be inspected).
      // turn-attr has no shellId: the overlay owner reclaims it by operationId.
      for (const kind of ['attr-decision', 'relation', 'relation-op', 'independent']) {
        for (const row of store.list(kind).filter(record => record.shellId === s.id)) store.remove(kind, row.id);
      }
    });
    try { ports.purgeShellAttribution?.(s.id); }
    catch (error) { console.warn('[task-shell] attribution purge failed', error.message); }
    return { ok: true };
  }
  function view(shellId) {
    const previous = store.get('shell', identifier(shellId, 'shellId'));
    const viewed = store.shellView(shellId, previous ? getRecord(previous.sourceSessionId) : null);
    if (previous?.currentTaskId !== viewed.currentTaskId) publishStateTarget(viewed.sourceSessionId);
    return viewed;
  }
  async function detail(shellId, taskId) {
    const task = taskFor(shell(shellId), taskId);
    const execution = task.ready ? await getExecution(task.sessionId) : { busy: true, status: 'preparing' };
    const records = shellRecords(chatScope(shellId), getHistory);
    const messages = (ports.applyAttributionOverlay?.(records) || records)
      .filter(m => m.taskId === taskId || (!m.taskId && m.sourceSessionId === task.sessionId)).slice(-200);
    return { task: getNative().taskDisplayTask(task, ports.taskShortCode), execution,
      messages: getNative().taskDisplayMessages(messages, task, { getTask: id => store.get('task', id) || getTask(id), codeFor: ports.taskShortCode }),
      snapshots: task.snapshotIds.map(id => store.get('snapshot', id)) };
  }
  function normalize(raw = {}, internalDispatch = false) {
    try { return getNative().taskShellInput(raw, internalDispatch); }
    catch (error) {
      if (!error.message.startsWith('TASK_RULE:')) throw error;
      const detail = JSON.parse(error.message.slice(10));
      throw failure(detail.code, detail.message, detail.status);
    }
  }
  async function reserve(s, payload, receiptId, fingerprint, delivery = {}) {
    if (s.standalone && payload.newTask) throw failure('standalone_task_identity_locked');
    const selectedTaskId = payload.newTask ? null : payload.taskId || s.currentTaskId || s.defaultTaskId || null;
    const target = selectedTaskId ? taskFor(s, selectedTaskId) : null;
    if (target) assertWritable(target.id);
    const observedClaim = target ? store.get('claim', target.id)?.receiptId : null;
    const state = target ? await getExecution(target.sessionId) : null;
    const references = [...new Set([...payload.contextTaskIds, ...payload.dependsOn])];
    const contexts = new Map();
    for (const id of references) {
      const source = taskFor(s, id);
      const sourceState = await getExecution(source.sessionId);
      if (payload.dependsOn.includes(id) && (sourceState.busy !== false || !sourceState.completed)) throw failure('dependency_not_ready');
      contexts.set(id, snapshotTaskHistory(source.sessionId, id, sourceState.busy ? sourceState.turnId : null));
    }
    if (!target && payload.intent === 'work' && !store.get('receipt', receiptId) && directoryAtCapacity(store, s.dirId)) {
      const currentShell = shell(s.id);
      if (!delivery.taskIdentityLocked && payload.expectedCursorVersion != null
          && payload.expectedCursorVersion !== (currentShell.cursorVersion || 0)) {
        throw failure('stale_shell_cursor', 'The current task changed; refresh before sending');
      }
      if (!getRecord(s.sourceSessionId)) throw failure('source_session_missing');
      await ensureTaskSlot(s.dirId, [s.currentTaskId, s.defaultTaskId]);
    }
    if (target) assertWritable(target.id);
    const source = !target && getRecord(s.sourceSessionId);
    const pending = state?.pending;
    const { created, receipt } = store.rule({ action: 'reserveReceipt', shellId: s.id,
      sourceSessionId: s.sourceSessionId, dirId: s.dirId,
      payloadJson: JSON.stringify(payload), receiptId, fingerprint,
      targetId: selectedTaskId, targetSessionId: target?.sessionId, observedClaim,
      state: state && { busy: state.busy, turnId: state.turnId,
        pending: pending && { resolved: pending.resolved, requestId: pending.requestId, taskId: pending.taskId } },
      expectedCursorSet: payload.expectedCursorVersion != null,
      snapshotBodies: [...contexts.values()].map(value => JSON.stringify(value)), taskFirst: ports.taskFirst === true,
      sourceRuntime: source ? runtimeFrom(source) : null,
      record: target ? { rolePrompt: getRecord(target.sessionId)?.rolePrompt } : null,
      directory: { rolePrompt: ports.getDirectory?.(s.dirId)?.rolePrompt },
      estimatedTokens: payload.intent === 'work' && !store.get('receipt', receiptId) ? savingsFor(s, target?.id) : null,
      delivery: { taskIdentityLocked: delivery.taskIdentityLocked, supervisorAnswer: delivery.supervisorAnswer,
        taskMetadata: delivery.taskMetadata || null, dispatch: delivery.dispatch || null },
    });
    return created ? { ...receipt, payload } : receipt;
  }
  async function deliver(receipt) {
    const task = store.get('task', receipt.taskId) || { id: receipt.taskId };
    const needsCapacity = receipt.payload.intent === 'work' && receipt.status !== 'accepted';
    const effects = { capacity: checkCapacity, createExecution, indexTask, getExecution, cancel, send,
      prepareExecution: (...args) => ports.prepareExecution(...args),
      dispatch: (id, text, options) => { assertWritable(options.taskId); return ports.dispatch(id, text, options); } };
    if (needsCapacity) launching.add(task.id);
    try {
      let phase = 'begin', value;
      for (;;) {
        const next = store.rule({ action: 'deliveryStep', receiptId: receipt.id, phase, value,
          unifiedAdmission: ports.unifiedAdmission === true, prepareExecution: typeof ports.prepareExecution === 'function' });
        if (next.done) {
          if (next.stateSource) publishStateTarget(next.stateSource);
          return next.result;
        }
        value = await effects[next.effect](...next.args);
        phase = next.phase;
      }
    } catch (error) {
      if (receipt.status === 'accepted') throw error;
      const cleaned = cleanError(error);
      const deliveryError = Object.assign(failure(cleaned.code, cleaned.message, error.status || error.statusCode || 500),
        { receiptId: receipt.id, taskId: task.id, notDelivered: error.code === 'stale_control' });
      try {
        const settled = store.rule({ action: 'settleReceipt', receiptId: receipt.id, error: cleaned });
        if (settled?.result) return settled.result;
      } catch (storageError) {
        deliveryError.cause = storageError;
      }
      throw deliveryError;
    } finally { if (needsCapacity) launching.delete(task.id); }
  }
  async function sendInput(shellId, raw, delivery = {}) {
    const s = shell(shellId), payload = normalize(raw, !!delivery.dispatch);
    if (delivery.supervisorAnswer === true && payload.intent !== 'answer') throw failure('invalid_control');
    const id = `sr_${hash([s.id, payload.clientMsgId]).slice(0, 40)}`;
    const fingerprint = hash(delivery.dispatch ? [payload, delivery.dispatch]
      : delivery.supervisorAnswer === true ? [payload, { supervisorAnswer: true }] : payload);
    return deliverInput(s, payload, id, fingerprint, delivery);
  }
  async function sendChatInput(shellId, message, controlTask) {
    const s = shell(shellId);
    const normalized = getNative().chatTaskShellInput(s.id, message, controlTask);
    if (!normalized.ok) throw failure(normalized.code, normalized.message, 400);
    return deliverInput(s, normalized.payload, normalized.id, normalized.fingerprint, {});
  }
  async function deliverInput(s, payload, id, fingerprint, delivery) {
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
  function dispatchFromSession(sessionId, text, options = {}) {
    if (typeof ports.dispatch !== 'function') throw failure('dispatch_unavailable');
    // Address the exact execution's owner, never the shell's mutable cursor.
    const s = open(sessionId);
    const task = owns(sessionId) || adopt(s.id, sessionId);
    if (!task?.id || task.unavailable) throw failure('task_shell_state_unavailable');
    if (options.taskId && options.taskId !== task.id) throw failure('task_identity_mismatch');
    const dispatch = Object.fromEntries(['ownerSessionId', 'replyTo', 'oneWay', 'resultMode',
      'requireIdle', 'operationId', 'idempotencyKey', 'allowCommander', 'queueIfBusy']
      .filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    return sendInput(taskActions.ownerOf(task).id, {
      text, intent: 'work', taskId: task.id,
      clientMsgId: `dispatch_${hash([options.ownerSessionId, options.idempotencyKey || options.operationId || randomUUID()]).slice(0, 40)}`,
    }, { taskIdentityLocked: true, dispatch });
  }
  async function sendExplicit(shellId, raw, identity = {}) {
    if (!store.get('task', identity.taskId)) {
      const payload = normalize({ ...raw, taskId: identity.taskId });
      if (payload.intent !== 'work' || payload.contextTaskIds.length || payload.dependsOn.length) {
        throw failure('context_requires_new_task', 'Start a new task to import versioned context');
      }
      const owner = validateNewLocate(shellId, identity);
      await ensureTaskSlot(owner.dirId, [owner.currentTaskId, owner.defaultTaskId]);
    }
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
  // 单点查询走索引行（见 store.js 的派生索引）：这曾经是 list('task').find(...)，
  // 每次全表读 + 逐行 JSON.parse，而任务板读投影是按卡片逐个问的 —— 1069 张卡片
  // 触发 511 次全表读（约 490MB），把 /api/air 的 CPU 从几十毫秒推到 3 秒以上。
  function owns(sessionId) { return store.taskBySession(sessionId); }
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
    const records = query.task_id
      ? relatedHistory({ store, targetId: query.task_id,
        getTask, getRecord, getHistory, getLiveState: ports.getLiveState, isDeletedTask: ports.isDeletedTask })
      : shellRecords(chatScope(s.id), getHistory, ports.getLiveState);
    const page = Object.keys(query).length ? contextPage(records, query) : null;
    const snapshots = page ? pageSnapshots(page) : contextSnapshots(s, task.id);
    const rendered = renderSnapshots(snapshots);
    const graphBlock = ''; // Explicit history reads do not repeat automatic graph injection.
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
      estimated_tokens: estimateTokens(rendered + graphBlock),
      context: (page ? 'Historical data; preserve execution status and source. Use page.before or message_id/offset to read further.'
        : rendered || 'No attributed history from other linked tasks is available. Use limit to browse shell history, including untagged records.') + graphBlock,
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
    return deliverInput(s, receipt.payload, receipt.id, receipt.fingerprint, { taskIdentityLocked: receipt.taskIdentityLocked,
      taskMetadata: receipt.taskMetadata, dispatch: receipt.dispatch,
      supervisorAnswer: receipt.supervisorAnswer === true });
  }
  // Undoing an accepted identity change puts the shell cursor back where it
  // was. It refuses once another turn has moved the cursor: that turn was
  // routed under the new identity, and silently re-pointing it would rewrite
  // the history a reader already saw.
  function restoreSettledCursor(shellId, { fromTaskId = null, toTaskId = null } = {}) {
    const s = shell(shellId);
    const previous = fromTaskId && store.get('task', fromTaskId);
    if (!previous || !toTaskId || s.currentTaskId !== toTaskId
        || !store.get('link', `${s.id}:${fromTaskId}`) || !store.get('link', `${s.id}:${toTaskId}`)) {
      return { ok: false, code: 'attribution_undo_conflict' };
    }
    return store.transaction(() => {
      s.currentTaskId = fromTaskId;
      s.defaultTaskId = fromTaskId;
      s.cursorVersion = (s.cursorVersion || 0) + 1;
      saveShell(s.id, s);
      return { ok: true, taskId: fromTaskId, previousTaskId: toTaskId };
    });
  }
  // 索引里的「选为下一条输入目标」：只移动输入游标，不划分轮次、不改身份、
  // 不创建执行。带 cursorVersion 的条件更新是多页面同开时的保护——另一个页面
  // 已经把目标挪走时这里必须失败，而不是悄悄覆盖它的选择。
  function selectTarget(shellId, { taskId, expectedCursorVersion } = {}) {
    const s = shell(shellId);
    const id = identifier(taskId, 'taskId');
    const result = store.selectChatShellTarget({ shellId, taskId: id, expectedCursorVersion,
      indexed: indexedTask(id), deleted: ports.isDeletedTask?.(id) === true });
    if (result.changed) publishStateTarget(s.sourceSessionId);
    return result;
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
    // Control/continuation paths above resume an already-routed execution, so
    // they may pass. New work must not: while the binding is being switched, a
    // message admitted here would be routed to the old execution even though
    // the task already points at the new one.
    if (independent.isSwitching(sessionId)) {
      return { ok: false, code: 'task_switching',
        message: '这个任务正在切换执行环境，请等这次切换结束后再发送。' };
    }
    // A durable scheduled message is user-authored future work delivered by the
    // orchestration timer, not a live client send. It never travels through the
    // shell WebSocket, so there is no receipt to match. Without an exemption it
    // dead-lettered with task_shell_route_required — the user's message was
    // shown as pending and then vanished without ever executing. Bind it to the
    // owned task like a host continuation so downstream attribution stays on the
    // task and the turn actually runs.
    if (options.scheduledMessageId) { options.taskId = task.id; return null; }
    // Same for a hook/trigger firing (events/host.js, triggers/index.js emit
    // chat:run with originTrigger). It is host-authored — the task-shell WS
    // path whitelists client fields, so a browser can never set it — and it
    // has no receipt either. Without this the hook's prompt was rejected here,
    // broadcast to a page nobody had open, and the run was still logged ok.
    if (options.originTrigger === true) { options.taskId = task.id; return null; }
    return { ok: false, code: 'task_shell_route_required' };
  }
  // Task-level directory move (Air 任务「移动」): the board relocates the
  // execution session's worktree; this follows the shell-store pointers so
  // taskFor's dirId check keeps passing afterwards. A shell shared with other
  // tasks (non-standalone) can never change directory.
  function relocateTask(taskId, dirId, options = {}) {
    const task = store.get('task', taskId);
    if (!task || task.dirId === dirId) return { ok: true, unchanged: true };
    const link = store.list('link').find(l => l.taskId === task.id);
    const ownerShell = (task.ownerShellId && store.get('shell', task.ownerShellId))
      || (link && store.get('shell', link.shellId)) || null;
    if (ownerShell && !ownerShell.standalone
      && store.list('link').some(l => l.shellId === ownerShell.id && l.taskId !== task.id)) {
      return { ok: false, code: 'task_shell_shared' };
    }
    if (options.dryRun === true) return { ok: true };
    store.transaction(() => {
      store.set('task', task.id, { ...task, dirId });
      if (ownerShell) store.set('shell', ownerShell.id, { ...ownerShell, dirId });
    });
    return { ok: true };
  }
  return {
    prepareContext: (id, options) => contextPlanner.prepare(owns(id), options),
    contextSent: (id, receipt, turn) => { const task = owns(id); if (task) contextPlanner.sent(task, receipt, turn); },
    contextComplete: (id, receipt, turn, success) => { const task = owns(id); if (task) contextPlanner.complete(task, receipt, turn, success); },
    // listTasks 是任务板读投影的热路径：一次 /api/air 里迁移与卡片刻画各读一次
    // 全表（线上 514 行 / 4.5MB）。走行缓存后同一份内容只解析一遍（store.js）。
    separation, roles, migrateTaskSessions: taskFirst.migrate, listTasks: () => store.cachedList('task'),
    // 任务图谱的只读快照：壳、持久任务、link 三张表一次拉全，供路由层聚合。
    taskGraphData: () => ({ shells: store.list('shell'), tasks: store.list('task'), links: store.list('link'),
      relations: store.list('relation') }),
    getSnapshot: id => { try { return store.get('snapshot', id); } catch (_) { return null; } },
    ...taskActions, purgeTasks, stateTarget, stateSources, open, openForSession, adopt, link, remove, view, detail, chatScope, send: sendInput, sendChatInput, retry, owns,
    guardAdmission, recentTasks, refillContext, contextTrace, settleAttribution, restoreSettledCursor, locateOrCreate,
    resolveTask, selectTarget, sendExplicit, dispatchFromSession, relocateTask, independent, relations,
  };
}

module.exports = { createTaskShellRuntime, failure, cleanError };

'use strict';

const { randomUUID } = require('node:crypto');
const { snapshotHistory, renderSnapshots, verifySnapshot, hash } = require('./context');

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
  const { store, enabled, getRecord, getHistory, getExecution, createExecution, indexTask, send, cancel } = ports;
  const flights = new Map();
  const launching = new Set();
  const maxConcurrent = Number.isInteger(ports.maxConcurrent) && ports.maxConcurrent > 0 ? ports.maxConcurrent : 4;
  async function checkCapacity(task) {
    const others = store.list('task').filter(t => t.id !== task.id && t.dirId === task.dirId && t.ready);
    const states = await Promise.all(others.map(async t => ({ id: t.id, busy: (await getExecution(t.sessionId)).busy })));
    const occupied = new Set(states.filter(s => s.busy !== false).map(s => s.id));
    for (const id of launching) if (id !== task.id && store.get('task', id)?.dirId === task.dirId) occupied.add(id);
    if (occupied.size >= maxConcurrent) throw failure('task_shell_capacity', `At most ${maxConcurrent} occupied experiment tasks per project; retry this delivery when capacity is available`, 429);
  }
  function writable() { if (!enabled()) throw failure('experiment_disabled', 'Task shells are disabled', 403); }
  function shell(id) {
    const value = store.get('shell', identifier(id, 'shellId'));
    if (!value) throw failure('shell_not_found', 'shell_not_found', 404);
    return value;
  }
  function taskFor(s, id, linked = true) {
    const task = store.get('task', identifier(id, 'taskId'));
    if (!task) throw failure('task_not_found', 'task_not_found', 404);
    if (task.dirId !== s.dirId) throw failure('project_mismatch', 'Tasks must belong to the same project', 403);
    if (linked && !store.get('link', `${s.id}:${id}`)) throw failure('task_not_linked');
    return task;
  }
  function open(sessionId) {
    writable(); identifier(sessionId, 'sessionId');
    const source = getRecord(sessionId);
    if (!source || source.kind !== 'chat' || source.taskBoundTaskId || ['aux', 'gateway', 'commander'].includes(source.type)
      || !['codex', 'claude'].includes(source.cli)) throw failure('unsupported_source', 'Use an ordinary Claude or Codex chat', 400);
    const id = `sh_${hash(sessionId).slice(0, 24)}`;
    const existing = store.get('shell', id);
    if (existing) return existing;
    const value = { id, sourceSessionId: sessionId, dirId: source.dirId, createdAt: Date.now() };
    store.set('shell', id, value); return value;
  }
  function link(shellId, taskId) {
    writable(); const s = shell(shellId); const task = taskFor(s, taskId, false);
    store.set('link', `${s.id}:${task.id}`, { shellId: s.id, taskId: task.id });
    return task;
  }
  function remove(shellId) {
    writable(); const s = shell(shellId);
    store.transaction(() => {
      store.remove('shell', s.id);
      for (const link of store.list('link').filter(l => l.shellId === s.id)) store.remove('link', `${s.id}:${link.taskId}`);
    });
    return { ok: true };
  }
  function view(shellId) {
    const s = shell(shellId);
    const ids = new Set(store.list('link').filter(l => l.shellId === s.id).map(l => l.taskId));
    return { ...s, enabled: enabled(), tasks: store.list('task').filter(t => ids.has(t.id)),
      availableTasks: store.list('task').filter(t => t.dirId === s.dirId).map(t => ({ id: t.id, title: t.title })),
      receipts: store.list('receipt').filter(r => r.shellId === s.id).slice(-100).map(r => ({
        id: r.id, clientMsgId: r.payload.clientMsgId, taskId: r.taskId, intent: r.payload.intent,
        status: r.status, error: r.error || null,
      })) };
  }
  async function detail(shellId, taskId) {
    const task = taskFor(shell(shellId), taskId);
    const execution = task.ready ? await getExecution(task.sessionId) : { busy: true, status: 'preparing' };
    return { task, execution, messages: getHistory(task.sessionId).slice(-200),
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
      contextTaskIds: list('contextTaskIds'), dependsOn: list('dependsOn'),
      turnId: raw.turnId == null ? null : identifier(raw.turnId, 'turnId'),
      requestId: raw.requestId == null ? null : identifier(raw.requestId, 'requestId') };
    if (intent !== 'work' && (!result.taskId || !result.turnId || result.contextTaskIds.length || result.dependsOn.length)) throw failure('invalid_control', 'Controls require the original task and turn', 400);
    if (intent === 'answer' && !result.requestId) throw failure('invalid_control', 'Answer requires requestId', 400);
    return result;
  }
  function checkControl(payload, state) {
    if (!state || payload.turnId !== state.turnId) throw failure('stale_control', 'The task has moved to another turn');
    if (payload.intent === 'answer' && (!state.pending || state.pending.resolved || state.pending.requestId !== payload.requestId
      || state.pending.taskId !== payload.taskId)) throw failure('stale_control', 'The question is no longer pending');
    if (payload.intent === 'steer' && state.pending && !state.pending.resolved) throw failure('answer_required');
  }
  async function reserve(s, payload, receiptId, fingerprint) {
    const target = payload.taskId ? taskFor(s, payload.taskId) : null;
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
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw failure('idempotency_conflict');
        return existing;
      }
      const claim = target && store.get('claim', target.id);
      const last = claim && store.get('receipt', claim.receiptId);
      const busy = target && (state?.busy !== false || claim?.receiptId !== observedClaim
        || (last && last.status !== 'accepted'));
      const fork = payload.intent === 'work' && !!busy;
      if (target && !fork && payload.intent === 'work' && references.length) throw failure('context_requires_new_task', 'Select a new task to import versioned context');
      let task = target;
      if (!task || fork) {
        if (store.list('task').filter(t => t.dirId === s.dirId).length >= 200) throw failure('experiment_task_limit', 'Experiment limit reached (200 tasks/project)', 429);
        if (fork) contexts.set(target.id, snapshotHistory(target.id, getHistory(target.sessionId), { activeTurnId: state?.busy ? state.turnId : null }));
        const snapshotIds = [];
        for (const value of contexts.values()) { store.set('snapshot', value.hash, value); snapshotIds.push(value.hash); }
        const id = `tsk_${randomUUID().replace(/-/g, '')}`;
        const source = getRecord(s.sourceSessionId);
        if (!source) throw failure('source_session_missing');
        task = { id, dirId: s.dirId, sessionId: `task-${id.slice(4)}`, parentTaskId: fork ? target.id : null,
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
        status: 'reserved', decision: fork ? 'fork' : target ? payload.intent === 'work' ? 'continue' : payload.intent : 'new', createdAt: Date.now() };
      store.set('receipt', receiptId, receipt);
      if (payload.intent === 'work') store.set('claim', task.id, { receiptId });
      store.set('link', `${s.id}:${task.id}`, { shellId: s.id, taskId: task.id });
      return receipt;
    });
  }
  async function deliver(receipt) {
    if (receipt.status === 'accepted') return receipt.result;
    const task = store.get('task', receipt.taskId);
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
        const snapshots = task.snapshotIds.map(id => {
          const snapshot = store.get('snapshot', id);
          if (!verifySnapshot(snapshot, id)) throw failure('snapshot_unverified');
          return snapshot;
        });
        // Stable key is the handoff protocol across the SQLite/outbox boundary.
        receipt.status = 'delivering'; store.set('receipt', receipt.id, receipt);
        result = await send(task.sessionId, p.text, {
          taskId: task.id, taskStart: true, taskText: task.title, taskSource: 'task-shell',
          clientMsgId: receipt.id, idempotencyKey: receipt.id, taskShellReceiptId: receipt.id,
          receivedAt: receipt.createdAt,
          ...(p.intent !== 'work' ? { taskShellControl: { intent: p.intent, turnId: p.turnId } } : {}),
          taskContextSeed: renderSnapshots(snapshots),
          ...(p.intent === 'answer' ? { userInputRequestId: p.requestId } : {}),
          ...(p.intent === 'steer' || receipt.decision === 'continue' ? { originContinue: true } : {}),
        });
      }
      if (!result?.ok) throw failure(result?.code || 'delivery_failed', result?.error || result?.code || 'delivery_failed');
      receipt.status = 'accepted'; receipt.error = null;
      receipt.result = { ok: true, taskId: task.id, sessionId: task.sessionId, receiptId: receipt.id, decision: receipt.decision };
      store.set('receipt', receipt.id, receipt);
      return receipt.result;
    } catch (error) {
      const notDelivered = error.code === 'stale_control';
      receipt.status = notDelivered ? 'rejected' : 'failed'; receipt.error = cleanError(error);
      store.set('receipt', receipt.id, receipt);
      throw Object.assign(failure(receipt.error.code, receipt.error.message, error.status || 500), { receiptId: receipt.id, taskId: task.id, notDelivered });
    } finally { if (needsCapacity) launching.delete(task.id); }
  }
  async function sendInput(shellId, raw) {
    writable(); const s = shell(shellId), payload = normalize(raw);
    const id = `sr_${hash([s.id, payload.clientMsgId]).slice(0, 40)}`, fingerprint = hash(payload);
    let receipt = store.get('receipt', id);
    if (receipt && receipt.fingerprint !== fingerprint) throw failure('idempotency_conflict');
    if (flights.has(id)) return flights.get(id);
    const operation = (async () => {
      receipt = receipt || await reserve(s, payload, id, fingerprint);
      return deliver(receipt);
    })();
    flights.set(id, operation);
    try { return await operation; } finally { flights.delete(id); }
  }
  function owns(sessionId) { return store.list('task').find(t => t.sessionId === sessionId) || null; }
  async function retry(shellId, receiptId) {
    writable(); const s = shell(shellId);
    const receipt = store.get('receipt', identifier(receiptId, 'receiptId'));
    if (!receipt || receipt.shellId !== s.id) throw failure('receipt_not_found', 'receipt_not_found', 404);
    return sendInput(s.id, receipt.payload);
  }
  function guardAdmission(sessionId, text, options = {}) {
    const task = owns(sessionId);
    if (!task) return null;
    if (options.taskId && options.taskId !== task.id) return { ok: false, code: 'task_identity_mismatch' };
    const receipt = options.taskShellReceiptId && store.get('receipt', options.taskShellReceiptId);
    if (receipt && receipt.taskId === task.id && receipt.payload.text === text
      && options.clientMsgId === receipt.id) return null;
    // Host-owned retry/callback carries originContinue; web clients never get
    // to set it. It resumes exactly this execution, with the immutable task ID.
    if (options.originContinue === true) { options.taskId = task.id; return null; }
    return { ok: false, code: 'task_shell_route_required' };
  }
  return { open, link, remove, view, detail, send: sendInput, retry, owns, guardAdmission };
}

module.exports = { createTaskShellRuntime, failure, cleanError };

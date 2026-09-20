'use strict';
const { hash, snapshotHistory, renderSnapshots } = require('./context');
const fail = code => Object.assign(new Error(code), { code, status: 409 });

function verifiedSnapshot(store, id, taskId = null) {
  const snapshot = id && store.get('task-role:snapshot', id);
  if (!snapshot || (taskId && snapshot.taskId !== taskId)
    || snapshot.id !== 'role_' + hash({ taskId: snapshot.taskId, version: snapshot.version, bindings: snapshot.bindings })) return null;
  return snapshot;
}

function materializeSnapshot(store, value) {
  const id = 'role_' + hash(value);
  const snapshot = { ...value, id, prompt: value.bindings.map(b => `【${b.name}】\n${b.prompt}`).join('\n\n') };
  const old = store.get('task-role:snapshot', id);
  if (old && JSON.stringify(old) !== JSON.stringify(snapshot)) throw fail('role_snapshot_conflict');
  if (!old) store.set('task-role:snapshot', id, snapshot);
  return id;
}

function createRoleBindings(store, { getRecord, getDirectory, assertWritable = () => {} }) {
  function current(taskId) {
    const task = store.get('task', taskId); if (!task) throw fail('task_not_found');
    const saved = store.get('task-role:binding', taskId); if (saved) return saved;
    const record = getRecord(task.sessionId), dir = getDirectory?.(task.dirId);
    const prompt = record?.rolePrompt || task.runtime?.rolePrompt || dir?.rolePrompt || '';
    return { taskId, version: 0, bindings: prompt ? [{ name: '原有角色', prompt }] : [] };
  }
  function update(taskId, input = {}) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || typeof input.clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(input.clientMsgId)
      || !Array.isArray(input.bindings) || input.bindings.length > 8) throw fail('invalid_role_binding');
    const bindings = input.bindings.map(b => {
      if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80
        || typeof b.prompt !== 'string' || !b.prompt.trim()) throw fail('invalid_role_binding');
      return { name: b.name.trim(), prompt: b.prompt.trim() };
    });
    if (bindings.reduce((n, b) => n + b.prompt.length + b.name.length, 0) > 40000) throw fail('invalid_role_binding');
    const id = hash([taskId, input.clientMsgId]), fingerprint = hash([input.expectedVersion, bindings]);
    return store.transaction(() => {
      assertWritable(taskId);
      const old = store.get('task-role:change', id);
      if (old) { if (old.fingerprint !== fingerprint) throw fail('idempotency_conflict'); return old.result; }
      const previous = current(taskId);
      if (previous.version !== input.expectedVersion) throw fail('role_version_conflict');
      const result = { taskId, version: previous.version + 1, bindings };
      store.set('task-role:binding', taskId, result);
      store.set('task-role:change', id, { id, fingerprint, previous, result, createdAt: Date.now() });
      return result;
    });
  }
  function snapshot(taskId) {
    const value = current(taskId);
    // Freeze the legacy/default role once. The execution record later contains
    // a compiled prompt and must never feed back into the binding definition.
    if (!store.get('task-role:binding', taskId)) store.set('task-role:binding', taskId, value);
    return materializeSnapshot(store, value);
  }
  function inherit(sourceTaskId, targetTaskId) {
    const source = current(sourceTaskId);
    const value = { taskId: targetTaskId, version: source.version,
      bindings: source.bindings.map(binding => ({ ...binding })) };
    const previous = store.get('task-role:binding', targetTaskId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw fail('role_binding_conflict');
    if (!previous) store.set('task-role:binding', targetTaskId, value);
    return value;
  }
  return { current, update, snapshot, inherit,
    isSnapshotFor: (taskId, id) => !!verifiedSnapshot(store, id, taskId) };
}

// Called only under a workspace permit before launching the queued receipt.
// Native session handles are archived, not removed from disk. Transcript and
// project/private memory remain in their original stores.
async function prepareRoleContext(store, descriptor, deps) {
  let receipt = descriptor.opts.taskShellReceiptId && store.get('receipt', descriptor.opts.taskShellReceiptId);
  if (!receipt?.roleSnapshotId) return;
  const task = store.get('task', receipt.taskId), record = deps.records.get(descriptor.sessionId);
  let snapshot = verifiedSnapshot(store, receipt.roleSnapshotId);
  // A pending question can move with a separated turn. Historical receipts
  // inherited the source turn's role snapshot even though the answer now runs
  // under the target task. Repair only that provable relationship: the target
  // names this snapshot's task as its separation source, and the durable run
  // binding proves the control belongs to the same source receipt. Arbitrary
  // corrupt or cross-task snapshots still fail closed below.
  if (task && ['answer', 'steer', 'cancel'].includes(receipt.payload?.intent)
      && snapshot && snapshot.taskId !== task.id && task.separatedFromTaskId === snapshot.taskId) {
    const originReceiptId = store.get('delivery:run', receipt.payload.turnId)?.binding?.receiptId;
    const originReceipt = originReceiptId && store.get('receipt', originReceiptId);
    const targetBinding = store.get('task-role:binding', task.id);
    if (originReceipt?.taskId === snapshot.taskId
        && originReceipt.roleSnapshotId === snapshot.id
        && targetBinding?.taskId === task.id) {
      const previousRoleSnapshotId = receipt.roleSnapshotId;
      const roleSnapshotId = materializeSnapshot(store, targetBinding);
      receipt = { ...receipt, roleSnapshotId,
        movedRoleSnapshot: { from: previousRoleSnapshotId, sourceTaskId: snapshot.taskId, repairedAt: Date.now() } };
      store.set('receipt', receipt.id, receipt);
      snapshot = verifiedSnapshot(store, roleSnapshotId, task.id);
    }
  }
  if (!task || task.sessionId !== descriptor.sessionId || !record
    || !snapshot || snapshot.taskId !== task.id) throw fail('role_snapshot_unverified');
  if (record.taskRoleEpoch !== snapshot.id) {
    if (deps.hasBackground(descriptor.sessionId)) throw fail('role_writer_busy');
    const closed = await deps.closePersistent(descriptor.sessionId);
    if (closed?.closed !== true) throw fail('role_native_close_unverified');
    if (deps.hasBackground(descriptor.sessionId)) throw fail('role_writer_busy');
    const checkpoint = snapshotHistory(task.id, deps.loadHistory?.(descriptor.sessionId) || []);
    const archiveId = hash([descriptor.sessionId, record.taskRoleEpoch || null, snapshot.id]);
    if (!store.get('task-role:native-archive', archiveId)) store.set('task-role:native-archive', archiveId, {
      sessionId: record.id, fromEpoch: record.taskRoleEpoch || null, toEpoch: snapshot.id,
      cliSessionId: record.cliSessionId || null, streamSessionId: record._streamSessionId || null,
      cliStates: record.cliStates || {}, checkpoint, createdAt: Date.now(),
    });
    deps.persistence.mutate('task-role.activate', records => {
      const current = records.get(record.id);
      current.taskRoleEpoch = snapshot.id;
      current.rolePrompt = snapshot.prompt || '按当前任务目标协作。没有额外角色设定。';
      current.rolePresetId = null;
      current.cliSessionId = null; delete current._streamSessionId;
      for (const state of Object.values(current.cliStates || {})) { state.cliSessionId = null; state.streamSessionId = null; }
      current.taskRoleCheckpoint = checkpoint;
    });
    const live = deps.getState(record.id); if (live) live.chatTurnCount = 0;
  }
  const checkpoint = deps.records.get(record.id).taskRoleCheckpoint;
  if (checkpoint && (!record.cliSessionId || deps.getState(record.id)?.chatTurnCount === 0)) descriptor.opts.taskContextSeed = (descriptor.opts.taskContextSeed || '') + renderSnapshots([checkpoint]);
  descriptor.opts.taskRoleSnapshotId = snapshot.id;
}
module.exports = { createRoleBindings, prepareRoleContext };

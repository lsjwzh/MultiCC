'use strict';
const { hash, snapshotHistory, renderSnapshots } = require('./context');
const fail = code => Object.assign(new Error(code), { code, status: 409 });

// 角色版本、校验、快照和幂等事务由 Rust 仓储持有；这里只读取宿主默认角色。
function verifiedSnapshot(store, id, taskId = null) {
  return store.rule({ action: 'roleVerify', id, taskId });
}
function materializeSnapshot(store, value) {
  return store.rule({ action: 'roleMaterialize', value });
}
function createRoleBindings(store, { getRecord, getDirectory, assertWritable = () => {} }) {
  function facts(taskId) {
    const task = store.get('task', taskId);
    return { record: task ? getRecord(task.sessionId) : null, directory: task ? getDirectory?.(task.dirId) : null };
  }
  return {
    current: taskId => store.rule({ action: 'roleCurrent', taskId, ...facts(taskId) }),
    update(taskId, input = {}) {
      store.rule({ action: 'roleValidate', input });
      return store.transaction(() => {
        assertWritable(taskId);
        return store.rule({ action: 'roleUpdate', taskId, input, now: Date.now(), ...facts(taskId) });
      });
    },
    snapshot: taskId => store.rule({ action: 'roleSnapshot', taskId, ...facts(taskId) }),
    inherit: (sourceTaskId, taskId) => store.rule({ action: 'roleInherit', sourceTaskId, taskId, ...facts(sourceTaskId) }),
    isSnapshotFor: (taskId, id) => !!verifiedSnapshot(store, id, taskId),
  };
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

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { createShellWorkspaceHost } = require('../src/task-shell/workspace');
const { createTaskFirstMigration } = require('../src/task-shell/task-first');
const { openBoardStore } = require('../src/task-board/board-store');
const { taskDomainAsync } = require('../src/native/task-domain');

test('role sessions become task entries without changing native handles, pending input, history or dirty files', async t => {
  let indexed = 0;
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }), indexTask: () => { indexed++; return { ok: true }; } });
  const root = path.dirname(f.file), file = path.join(root, 'unmerged.txt'); fs.writeFileSync(file, 'unmerged work');
  Object.assign(f.records.get('a'), { type: 'worker', label: 'Designer', rolePrompt: 'Design role',
    worktreePath: root, branch: 'multicc/legacy', cliSessionId: 'native-a', cliStates: { codex: { cliSessionId: 'native-a' } },
    taskState: { pendingUserInput: { taskId: 'tsk_waiting', requestId: 'q1', turnId: 'run1', resolved: false } } });
  f.histories.set('a', [{ id: 'm', role: 'assistant', taskId: 'tsk_waiting', content: 'Existing work' }]);
  const before = JSON.stringify([...f.records]), history = JSON.stringify([...f.histories]);
  const result = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(result.ok, true);
  const task = f.runtime.owns('a'); assert.equal(task.id, 'tsk_waiting'); assert.equal(task.sessionId, 'a');
  assert.equal((await f.runtime.taskEntry(task.id)).readOnly, false);
  assert.equal(f.runtime.roles.current(task.id).bindings[0].prompt, 'Design role');
  assert.equal(JSON.stringify([...f.records]), before); assert.equal(JSON.stringify([...f.histories]), history);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unmerged work'); assert.equal(f.creations.length, 0); assert.equal(f.sends.length, 0);
  const count = indexed, taskIds = f.store.list('task').map(t => t.id);
  await createTaskShellRuntime(f.ports).migrateTaskSessions([...f.records.values()]);
  assert.equal(indexed, count); assert.deepEqual(f.store.list('task').map(t => t.id), taskIds);
});

test('migration reports identity conflicts and failed indexes without deleting or hiding their evidence', async t => {
  let fail = true;
  const f = fixture(t, { getDirectory: id => ({ id }), indexTask: () => ({ ok: !fail, error: 'disk_full' }) });
  const first = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(first.ok, false); assert.equal(first.errors.length, 3); assert.equal(first.migrated.length, 0);
  assert.equal(f.records.size, 3); assert.equal(f.store.list('task').length, 3);
  fail = false;
  assert.equal((await f.runtime.migrateTaskSessions([...f.records.values()])).ok, true);
  const original = f.runtime.owns('a');
  f.records.set('conflict', { id: 'conflict', kind: 'chat', dirId: 'd1', taskBoundTaskId: original.id });
  const conflict = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(conflict.errors[0].code, 'task_identity_mismatch');
  assert.equal(f.records.has('conflict'), true); assert.equal(f.store.get('task', original.id).sessionId, 'a');
});

test('explicit task input can continue a migrated historical task without using another task cursor', async t => {
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }) });
  const a = f.runtime.adopt(f.a.id, 'a');
  const b = await f.runtime.send(f.a.id, { text: 'New goal', clientMsgId: 'b', newTask: true });
  f.statuses.set(b.sessionId, { busy: false });
  await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal((await f.runtime.taskEntry(a.id)).readOnly, false);
  const result = await f.runtime.sendExplicit(f.a.id, { text: 'Continue A', clientMsgId: 'a' }, { taskId: a.id, taskStart: true });
  assert.equal(result.taskId, a.id); assert.equal(result.sessionId, 'a');
  assert.equal(f.sends.at(-1).id, 'a');
});

test('task-first preparation retains existing workspace references instead of moving them into a role workspace', async () => {
  let touched = false;
  const host = createShellWorkspaceHost({ records: { get: () => { touched = true; throw new Error('must not rebind'); } } });
  await host.prepareExecution({ id: 't', taskFirst: true }, { sourceSessionId: 'old-role', standalone: false });
  assert.equal(touched, false);
});

test('opening a planned board task keeps its identity, plan content and creates metadata once without starting work', async t => {
  const board = { id: 'tsk_plan', dirId: 'd1', title: 'Implement task', origin: 'board', refs: [],
    recordType: 'planned', workflowStage: 'inbox', planningRevision: 3,
    description: 'Implement the planned change', acceptanceCriteria: 'The plan is visible before execution' };
  const f = fixture(t, { getDirectory: id => ({ id }), getTask: id => id === board.id ? board : null, defaultTaskRuntime: () => ({ cli: 'codex' }) });
  const [a, b] = await Promise.all([f.runtime.bindPlannedTask(board.id), f.runtime.bindPlannedTask(board.id)]);
  assert.equal(a.task.id, board.id); assert.deepEqual(a, b); assert.equal(f.creations.length, 1);
  assert.equal(a.task.recordType, 'planned'); assert.equal(a.task.description, board.description);
  assert.equal(a.task.acceptanceCriteria, board.acceptanceCriteria); assert.equal(a.task.planningRevision, 3);
  assert.equal(a.readOnly, false); assert.equal(f.sends.length, 0);
  assert.equal(f.creations[0].source.cli, 'codex');
  assert.equal(f.store.get('task', board.id).taskFirst, true);
  assert.equal(f.store.get('task', board.id).ownerShellId, a.ownerShellId);
  await f.runtime.bindPlannedTask(board.id); assert.equal(f.creations.length, 1);
});

test('planned execution retries a failed task index without creating duplicate metadata', async t => {
  let fail = true, indexes = 0;
  const board = { id: 'tsk_retry', dirId: 'd1', title: 'Retry', origin: 'board' };
  const f = fixture(t, { getDirectory: id => ({ id }), getTask: id => id === board.id ? board : null,
    indexTask: () => { indexes++; return { ok: !fail }; } });
  await assert.rejects(f.runtime.bindPlannedTask(board.id), { code: 'task_index_failed' });
  assert.equal(f.store.get('task', board.id).bindingPending, true);
  fail = false;
  await f.runtime.bindPlannedTask(board.id);
  assert.equal(indexes, 2); assert.equal(f.creations.length, 1);
  assert.equal(f.store.get('task', board.id).bindingPending, undefined);
});

test('legacy commander is adopted as a task while its existing execution and role stay intact', async t => {
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }) });
  f.records.set('commander', { id: 'commander', kind: 'chat', type: 'commander', dirId: 'd1', rolePrompt: 'Coordinate tasks', cliSessionId: 'native-commander' });
  const result = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(result.ok, true);
  const task = f.runtime.owns('commander'); assert.ok(task);
  assert.equal((await f.runtime.taskEntry(task.id)).readOnly, false);
  assert.equal(f.runtime.roles.current(task.id).bindings[0].prompt, 'Coordinate tasks');
  assert.equal(f.records.get('commander').cliSessionId, 'native-commander');
  assert.equal(f.creations.length, 0);
});

// ── 改前实现冻结参照 ────────────────────────────────────────────────────────
// 差分基准：逐字复制自本提交前的 src/task-shell/task-first.js（逐条
// ports.isDeletedTask）。新实现必须与它逐项一致，所以这里不随新行为改动。
function createFrozenMigration({ store, open, adopt, roles, indexTask, ports }) {
  let flight;
  function promote(task) {
    if (!task.taskFirst) store.set('task', task.id, { ...task, taskFirst: true });
    roles.snapshot(task.id);
    return store.get('task', task.id);
  }
  function migrate(records) {
    if (flight) return flight;
    flight = (async () => {
      const errors = [], migrated = [], tasks = [];
      const all = new Map(store.cachedList('task').map(task => [task.id, task]));
      const indexed = new Set(store.cachedEntries('task-first:indexed').map(([id]) => id));
      const known = new Map([...all.values()].map(task => [task.sessionId, task]));
      for (const record of records) {
        if (record.kind !== 'chat' || record.taskExecutionSlot || record.experimentalMode
          || ['aux', 'gateway'].includes(record.type) || !ports.getDirectory?.(record.dirId)) continue;
        if (ports.isDeletedTask?.(record.taskBoundTaskId) || ports.isDeletedTask?.(known.get(record.id)?.id)) continue;
        if (known.get(record.id)?.taskFirst && indexed.has(known.get(record.id).id)) continue;
        try {
          const owner = open(record.id), task = adopt(owner.id, record.id);
          all.set(task.id, promote(task));
        } catch (error) { errors.push({ sessionId: record.id, code: error.code || 'task_migration_failed' }); }
      }
      for (const original of all.values()) {
        if (ports.isDeletedTask?.(original.id)) continue;
        tasks.push(original);
        try {
          const promoted = original.taskFirst && indexed.has(original.id);
          const task = promoted ? original : promote(original);
          if (!promoted && !indexed.has(task.id)) {
            const result = await indexTask(task);
            if (!result?.ok) throw Object.assign(new Error(), { code: result?.error || 'task_index_failed' });
            store.set('task-first:indexed', task.id, { taskId: task.id, sessionId: task.sessionId, version: 1 });
            indexed.add(task.id);
          }
          migrated.push(task.id);
        } catch (error) { errors.push({ taskId: original.id, code: error.code || 'task_migration_failed' }); }
      }
      return { ok: errors.length === 0, migrated, errors, tasks };
    })().finally(() => { flight = null; });
    return flight;
  }
  return { migrate, promote };
}

// 差分用的内存任务仓储：与真实仓储的调用面（cachedList/cachedEntries/get/set）
// 同形，并记下每一次 set 的参数，用来比对写序列。
function memoryStore(tasks, indexedIds) {
  const rows = new Map(tasks.map(task => [task.id, JSON.parse(JSON.stringify(task))]));
  const indexed = new Map(indexedIds.map(id => [id, { taskId: id, sessionId: null, version: 1 }]));
  const sets = [];
  return {
    sets,
    cachedList: kind => (kind === 'task' ? [...rows.values()].map(value => JSON.parse(JSON.stringify(value))) : []),
    cachedEntries: kind => (kind === 'task-first:indexed'
      ? [...indexed.values()].map(value => [value.taskId, JSON.parse(JSON.stringify(value))]) : []),
    get: (kind, id) => (kind === 'task' ? JSON.parse(JSON.stringify(rows.get(id) ?? null)) : indexed.get(id) ?? null),
    set(kind, id, value) {
      sets.push(JSON.stringify([kind, id, value]));
      if (kind === 'task') rows.set(id, JSON.parse(JSON.stringify(value)));
      else indexed.set(id, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
}

// 覆盖每个分支：绑定删除、known 映射删除、taskFirst+已索引短路、领养抛错、
// 领养出的新行恰好已删除（只有第二轮的新键集能看见）、索引失败、过滤条件。
const ADOPTED_DELETED = 'tsk_adopted_r-adopt-deleted';
function differentialWorld() {
  return {
    deleted: new Set(['tsk_deleted', 'tsk_known_deleted', ADOPTED_DELETED]),
    tasks: [
      { id: 'tsk_live', sessionId: 's-live', dirId: 'd1', title: 'live', ready: true },
      { id: 'tsk_deleted', sessionId: 's-deleted', dirId: 'd1', title: 'deleted', ready: true },
      { id: 'tsk_promoted', sessionId: 'r-promoted', dirId: 'd1', taskFirst: true, ready: true },
      { id: 'tsk_promoted_unindexed', sessionId: 's-pu', dirId: 'd1', taskFirst: true, ready: true },
      { id: 'tsk_index_fails', sessionId: 's-fails', dirId: 'd1', ready: true },
      { id: 'tsk_known_deleted', sessionId: 'r-known-deleted', dirId: 'd1', ready: true },
    ],
    indexed: ['tsk_promoted'],
    records: [
      { id: 'r-live', kind: 'chat', dirId: 'd1' },
      { id: 'r-bound-deleted', kind: 'chat', dirId: 'd1', taskBoundTaskId: 'tsk_deleted' },
      { id: 'r-known-deleted', kind: 'chat', dirId: 'd1' },
      { id: 'r-promoted', kind: 'chat', dirId: 'd1' },
      { id: 'r-adopt-deleted', kind: 'chat', dirId: 'd1' },
      { id: 'r-adopt-fails', kind: 'chat', dirId: 'd1' },
      { id: 'r-aux', kind: 'chat', dirId: 'd1', type: 'aux' },
      { id: 'r-no-dir', kind: 'chat', dirId: 'd-missing' },
      { id: 'r-slot', kind: 'chat', dirId: 'd1', taskExecutionSlot: 'slot-1' },
      { id: 'r-experimental', kind: 'chat', dirId: 'd1', experimentalMode: true },
      { id: 'r-not-chat', kind: 'mcp', dirId: 'd1' },
    ],
  };
}
// taskDomainAsync({op:'deletedAmong'}) 的语义镜像：保持入参顺序与重复项，
// 非字符串入参视为未删除。
function deletedAmongFrom(deleted) {
  const table = new Set(deleted);
  return async ids => ids.filter(id => typeof id === 'string' && table.has(id));
}

async function runDifferential(kind) {
  const world = differentialWorld();
  const store = memoryStore(world.tasks, world.indexed);
  const calls = [];
  const ports = {
    getDirectory: id => (id === 'd1' ? { id } : null),
    isDeletedTask: id => world.deleted.has(id),
  };
  if (kind === 'batch') ports.deletedAmong = async ids => { calls.push(ids); return deletedAmongFrom(world.deleted)(ids); };
  const migration = (kind === 'frozen' ? createFrozenMigration : createTaskFirstMigration)({
    store,
    open: sessionId => ({ id: `sh_${sessionId}` }),
    adopt: (shellId, sessionId) => {
      if (sessionId === 'r-adopt-fails') throw Object.assign(new Error('unsupported'), { code: 'unsupported_source' });
      return { id: `tsk_adopted_${sessionId}`, sessionId, dirId: 'd1', title: sessionId, ready: true };
    },
    roles: { snapshot() {} },
    indexTask: async task => (task.id === 'tsk_index_fails' ? { ok: false, error: 'disk_full' } : { ok: true }),
    ports,
  });
  const result = await migration.migrate(world.records);
  return { result, sets: store.sets, calls };
}

test('batch deleted lookup keeps every migrate outcome and write sequence of the per-id implementation', async () => {
  const frozen = await runDifferential('frozen');
  const batch = await runDifferential('batch');
  const fallback = await runDifferential('fallback');

  // 逐项一致：返回值（ok/migrated/errors/tasks）与 store.set 调用序列。
  assert.deepEqual(batch.result, frozen.result);
  assert.deepEqual(batch.sets, frozen.sets);
  // 旧宿主只给 isDeletedTask 时仍走逐条判定，结果同样一致。
  assert.deepEqual(fallback.result, frozen.result);
  assert.deepEqual(fallback.sets, frozen.sets);
  assert.deepEqual(fallback.calls, []);

  // 覆盖断言：这不是「两边都空」的假绿。
  assert.equal(frozen.sets.length, 7);
  assert.equal(frozen.result.ok, false);
  assert.deepEqual(frozen.result.migrated,
    ['tsk_live', 'tsk_promoted', 'tsk_promoted_unindexed', 'tsk_adopted_r-live']);
  assert.deepEqual(frozen.result.errors, [
    { sessionId: 'r-adopt-fails', code: 'unsupported_source' },
    { taskId: 'tsk_index_fails', code: 'disk_full' },
  ]);
  assert.deepEqual(frozen.result.tasks.map(task => task.id),
    ['tsk_live', 'tsk_promoted', 'tsk_promoted_unindexed', 'tsk_index_fails', 'tsk_adopted_r-live']);
  assert.ok(frozen.sets.some(line => line.startsWith(`["task","${ADOPTED_DELETED}"`)),
    '领养出又被删除的行必须先被 promote，才会在第二轮被跳过');
  assert.ok(!frozen.result.migrated.includes(ADOPTED_DELETED));
  assert.ok(!frozen.result.tasks.some(task => task.id === ADOPTED_DELETED));
  // 两次批量调用：第一轮记录的 id，第二轮最终的 all 键集。
  assert.equal(batch.calls.length, 2);
  assert.ok(batch.calls[1].includes(ADOPTED_DELETED), '第二轮必须带上第一轮领养出的新行');
  assert.ok(batch.calls[1].includes('tsk_live'));
  assert.equal(batch.calls[0].includes(ADOPTED_DELETED), false);
});

test('migrate asks the resident board once per batch instead of once per task', async t => {
  const f = fixture(t, { taskFirst: true, getDirectory: id => ({ id }) });
  const quiet = { warn() {}, log() {} };
  const boardWith = deletedTaskIds => openBoardStore({
    raw: { schemaVersion: 2, revision: 0, modules: {}, tasks: {}, taskGroups: {}, deletedTaskIds },
    logger: quiet, verify: false,
  });
  let board = boardWith([]);
  t.after(() => board.close());
  const calls = [];
  f.ports.deletedAmong = async ids => {
    calls.push(ids);
    return taskDomainAsync({ op: 'deletedAmong', board: board.board, ids });
  };
  const first = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(first.ok, true);
  assert.equal(first.tasks.length, 3);
  assert.equal(calls.length, 2);

  const removed = first.tasks.find(task => task.sessionId === 'a').id;
  board.close();
  board = boardWith([removed]);
  calls.length = 0;
  const second = await f.runtime.migrateTaskSessions([...f.records.values()]);
  assert.equal(second.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(second.tasks.map(task => task.sessionId).sort(), ['b', 'other']);
  assert.ok(!second.migrated.includes(removed));
  assert.ok(!second.errors.length);
});


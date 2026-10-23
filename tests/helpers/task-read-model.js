'use strict';
// Test oracle only: the existing Air read index and production row cache remain
// the Node baseline. New product projection/query rules live in Rust.
const { createAirReadIndex } = require('../../src/workspace/air-read-index');

function project(task, overlays = {}) {
  const last = (task.refs || []).reduce((n, ref) => Math.max(n, Number(ref?.ts) || 0), 0)
    || Number(task.createdAt) || Number(task.updatedAt) || 0;
  return { id: task.id, dirId: task.dirId || task.refs?.find(r => r?.dirId)?.dirId || null,
    title: task.title, status: task.status, recordType: task.recordType || null,
    workflowStage: task.workflowStage || null, updatedAt: task.updatedAt || task.createdAt || 0,
    lastMessageAt: last, sessionId: task.chatSessionId || task.sessionId || null, ...overlays[task.id] };
}
function oracle(tasks, metadata = {}, overlays = {}) {
  const index = createAirReadIndex();
  index.apply({ ...metadata, tasks: tasks.map(task => project(task, overlays)) });
  return { index, page(options) { const { cursor, ...page } = index.page(options); return page; },
    stats: dayStart => index.stats(dayStart), snapshot: () => index.snapshot() };
}
function fixtures(count = 120, bytes = 8192) {
  const states = ['running', 'waiting', 'error', 'succeeded', 'idle', 'queued', 'background', 'blocked', 'cancelled'];
  const metadata = { directories: [{ id: 'dir0', name: '项目 中文' }, { id: 'dir1', name: '工具 😀' }],
    taskTodos: ['tsk_00001', 'tsk_00002'], taskTodoIgnored: ['tsk_00002'],
    taskPins: ['tsk_00004', 'tsk_00003'] };
  const overlays = {};
  const tasks = Array.from({ length: count }, (_, i) => {
    const id = `tsk_${String(i).padStart(5, '0')}`;
    overlays[id] = { runState: states[i % states.length], goalState: i % 2 ? 'interact' : 'achieved',
      readOnly: i % 4 === 0, resource: { residency: 'resident', capacityReason: null },
      attention: i % 5 === 0 ? { type: 'result', at: 1000 } : null, worktreeChanges: null };
    return { id, dirId: `dir${i % 2}`, title: `任务 中文 😀 ${i} ΟΣ`,
      status: i % 13 === 0 ? 'archived' : i % 11 === 0 ? 'done' : 'active',
      createdAt: 1000 + i, updatedAt: 5000 + i % 7, sessionId: `session${i}`,
      refs: [{ ts: 3000 + i % 3, dirId: `dir${i % 2}` }, { ts: 2000 }],
      contextLedger: { text: 'x'.repeat(bytes) } };
  });
  return { tasks, metadata, overlays };
}
function initialize(db, tasks, { indexed = true, journal = 'WAL' } = {}) {
  db.pragma(`journal_mode=${journal}`);
  db.exec('PRAGMA synchronous=NORMAL; CREATE TABLE shell_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
  if (indexed) db.exec('CREATE INDEX read_model_kind ON shell_records(kind)');
  const put = db.prepare("INSERT INTO shell_records VALUES ('task',?,?)");
  db.transaction(() => { for (const task of tasks) put.run(task.id, JSON.stringify(task)); })();
}

function cachedNodeModel(file) {
  const { createTaskShellStore } = require('../../src/task-shell/store');
  const store = createTaskShellStore(file), index = createAirReadIndex();
  const Probe = require('../../src/sqlite/driver').databaseConstructor(), probe = new Probe(':memory:');
  const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version; probe.close();
  let epoch = null, inputs = null;
  return {
    sqlite,
    refresh({ metadata = {}, overlays = {}, force = false } = {}) {
      const nextEpoch = store.epoch(['task']), nextInputs = JSON.stringify([metadata, overlays]);
      if (!force && epoch === nextEpoch && inputs === nextInputs) return;
      index.apply({ ...metadata, tasks: store.cachedList('task').map(t => project(t, overlays)) });
      epoch = nextEpoch; inputs = nextInputs;
    },
    page(options) { const { cursor, ...result } = index.page(options); return result; },
    stats: dayStart => index.stats(dayStart), snapshot: () => index.snapshot().tasks, close: () => store.close(),
  };
}
module.exports = { project, oracle, fixtures, initialize, cachedNodeModel };

// Benchmark oracle only: give Node the same explicit input-reuse/partial-update
// opportunity as Rust. Production business code must not import this helper.
function reusingNodeModel(file) {
  const { createTaskShellStore } = require('../../src/task-shell/store');
  const store = createTaskShellStore(file), index = createAirReadIndex();
  const Probe = require('../../src/sqlite/driver').databaseConstructor(), probe = new Probe(':memory:');
  const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version; probe.close();
  let epoch, metadata = {}, overlays = {}, sourceRows = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  function refresh(input = {}) {
    metadata = clone(input.metadata || {}); overlays = clone(input.overlays || {});
    const tasks = store.cachedList('task'); sourceRows = new Map(tasks.map(t => [t.id, t]));
    index.apply({ ...metadata, tasks: tasks.map(t => project(t, overlays)) });
    epoch = store.epoch(['task']);
  }
  function sync(input = {}) {
    const nextEpoch = store.epoch(['task']);
    const nextMetadata = input.metadata === undefined ? metadata : clone(input.metadata);
    const changed = Object.keys(input.overlayChanges || {});
    for (const id of changed) {
      if (input.overlayChanges[id] === null) delete overlays[id]; else overlays[id] = clone(input.overlayChanges[id]);
    }
    if (nextEpoch !== epoch) {
      const tasks = store.cachedList('task'); sourceRows = new Map(tasks.map(t => [t.id, t]));
      index.apply({ ...nextMetadata, tasks: tasks.map(t => project(t, overlays)) });
    } else if (changed.length || JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) {
      const byId = sourceRows;
      index.apply({ ...nextMetadata, tasks: changed.filter(id => byId.has(id)).map(id => project(byId.get(id), overlays)) }, { partial: true });
    }
    metadata = nextMetadata; epoch = nextEpoch;
  }
  return { sqlite, refresh, sync,
    page(options) { const { cursor, ...page } = index.page(options); return page; },
    stats: day => index.stats(day), snapshot: () => index.snapshot().tasks, close: () => store.close() };
}
module.exports.reusingNodeModel = reusingNodeModel;

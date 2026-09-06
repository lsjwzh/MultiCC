'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskShellStore } = require('../../src/task-shell/store');
const { createTaskShellRuntime } = require('../../src/task-shell/runtime');
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shell-test-'));
  const file = path.join(dir, 'shell.sqlite');
  const store = createTaskShellStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const records = new Map(['a', 'b', 'other'].map(id => [id, { id, kind: 'chat', cli: 'codex', dirId: id === 'other' ? 'd2' : 'd1' }]));
  const statuses = new Map(), histories = new Map(), sends = [], creations = [], cancels = [];
  const ports = {
    store,
    getRecord: id => records.get(id),
    getHistory: id => histories.get(id) || [],
    getExecution: async id => statuses.get(id) || { busy: false, turnId: null },
    createExecution: async (task, source) => {
      creations.push({ task, source });
      records.set(task.sessionId, { id: task.sessionId, dirId: task.dirId, taskBoundTaskId: task.id });
      return { ok: true, baseline: { commit: 'abc123', branch: 'main' } };
    },
    indexTask: () => ({ ok: true }),
    send: async (id, text, opts) => {
      sends.push({ id, text, opts });
      statuses.set(id, { busy: true, turnId: 'turn-' + sends.length });
      return { ok: true, entryId: 'entry-' + sends.length };
    },
    cancel: async (id, turnId) => { cancels.push({ id, turnId }); return { ok: true }; },
    ...extra,
  };
  const runtime = createTaskShellRuntime(ports);
  const a = runtime.open('a'), b = runtime.open('b');
  return { runtime, store, records, statuses, histories, sends, creations, cancels, a, b, file, ports };
}

module.exports = { fixture };

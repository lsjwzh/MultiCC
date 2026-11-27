'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

// Resolve unchanged dependencies at the original production location. Replaced
// dependencies are explicitly wired to the reference side of the comparison.
function snapshot(filename, source, dependencies = {}) {
  const original = path.resolve(__dirname, '../../src', filename);
  const loaded = new Module(original, module);
  loaded.filename = original;
  loaded.paths = Module._nodeModulePaths(path.dirname(original));
  const fallback = require('./frozen-batch10').from(original);
  loaded.require = id => Object.hasOwn(dependencies, id) ? dependencies[id] : fallback(id);
  loaded._compile(fs.readFileSync(path.join(__dirname, source), 'utf8'), original);
  return loaded.exports;
}

const batch = 'frozen-task-board-batch6/';
const planning = snapshot('task-board/planning.js', 'frozen-task-board-planning.js');
const bridge = snapshot('task-board/native-bridge.js', batch + 'native-bridge.js', { './planning': planning });
const normalize = snapshot('task-board/normalize.js', batch + 'normalize.js', {
  './planning': planning, './native-bridge': bridge,
});
const nativeBinding = require('../../src/native/binding');
const checkedBinding = Object.create(nativeBinding, {
  taskPlanning: { value: planning },
  taskDomainHost: { value: require('./frozen-batch10').frozen('native/task-domain') },
});
const boardStore = snapshot('task-board/board-store.js', '../../src/task-board/board-store.js', {
  '../native/binding': checkedBinding,
});
// The routing kernel is shared. Bind its taskDirId port to the reference
// normalizer so routing cannot silently compare the candidate with itself.
const routing = nativeBinding.getNative().taskBoardRoutingApi({
  taskDomain: require('./frozen-batch10').frozen('native/task-domain').taskDomain, taskDirId: normalize.taskDirId,
  entries: values => [...values || []],
  affinity: task => new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean)),
  rankInputs(records, { dirId = null, contextTerms = new Map(), affinitySessionIds = new Set(), options = {} } = {}, check) {
    const entries = [...records || []], availability = {}, activities = {};
    for (const [id, record] of entries) {
      if (typeof options.isAvailable === 'function') availability[id] = check(record, id, options);
      const value = record && (record.lastActivity || record.createdAt);
      const ms = typeof value === 'number' ? value : Date.parse(value || '');
      activities[id] = Number.isFinite(ms) ? ms : 0;
    }
    return { records: entries, dirId, contextTerms: [...contextTerms], affinitySessionIds: [...affinitySessionIds], availability, activities };
  },
});
const core = snapshot('task-board/core.js', 'legacy-task-board-core.js', {
  './planning': planning, './normalize': normalize, './native-bridge': bridge, './routing': routing,
});
const lifecycle = snapshot('task-board/lifecycle.js', batch + 'lifecycle.js', { './native-bridge': bridge });
const relocate = snapshot('task-board/relocate.js', batch + 'relocate.js');
const retention = snapshot('task-board/retention.js', batch + 'retention.js');
const taskSearch = snapshot('native/task-search.js', batch + 'task-search.js', {
  '../task-board/search': require('./legacy-task-search'),
});

module.exports = { snapshot, planning, bridge, core, lifecycle, relocate, retention, taskSearch, boardStore };

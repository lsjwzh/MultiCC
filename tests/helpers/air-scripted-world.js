'use strict';

// Scripted world for the Air task-board cluster: the deps that
// `src/workspace/air-routes.js` (and its frozen oracle) read, with every value
// fixed by the scenario so the migration differential can compare the legacy
// Node handlers against the Rust front door byte for byte.
//
// The scenario has two halves:
//
//   answers   keyed by port operation (`taskEntry:<id>`, `reclaim`, …). Each is
//             `{ value }` or `{ throw: { code, status, message } }`.
//   records / board / directories / admission / shellTasks / clis
//             the fixed board state the snapshot and the detail view read.
//
// Every stateful call the handlers make on those ports is recorded in
// `effects.calls`, which is what the differential compares per case (a route
// that answers the same bytes but asks Node for the wrong thing still fails).
//
// No real task board, clock or network is touched: each `buildDeps` gets its
// own temp directory, so the pins/todos/ignores files always start empty.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const EMPTY_LIFECYCLE = { resident: 0, retained: 0, hibernated: 0, planned: 0, leased: 0, onDisk: 0, total: 0 };

function makeBoard(ids) {
  const tasks = {};
  for (const id of ids) {
    tasks[id] = { id, sessionId: `s-${id}`, chatSessionId: null, title: `Task ${id}`,
      column: 'inbox', status: 'active', refs: [], routing: {}, updatedAt: 1700000000000 };
  }
  return { tasks };
}

function baseRecords() {
  return {
    's-tk-a': { id: 's-tk-a', dirId: 'dir-1', kind: 'chat', type: 'chat', cli: 'claude', provider: 'official',
      providerName: 'Official', model: 'opus', effort: 'high', lastWorkAt: '2026-01-02T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z', label: 'A', taskBoundTaskId: 'tk-a' },
    's-tk-b': { id: 's-tk-b', dirId: 'dir-1', kind: 'chat', type: 'chat', cli: 'codex', provider: 'official',
      providerName: 'Official', model: 'gpt', effort: 'medium', lastWorkAt: '2026-01-03T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z', label: 'B', taskBoundTaskId: 'tk-b' },
  };
}

// 这个替身有两个消费者，契约不同：冻结 oracle（tests/helpers/legacy-air-routes.js）
// 走退役的 resolveAsync + overlayAsync，现行宿主走一次完成的 snapshotAsync。两边
// 必须吐出逐字节相同的卡片，否则差分比的是替身自己的差异，而不是实现的差异 ——
// 所以卡片只在 cardOf 里定义一次。
function fakeCardCache(scenario) {
  const lifecycle = scenario.lifecycle || { 'dir-1': { ...EMPTY_LIFECYCLE, resident: 2, onDisk: 2, total: 2 } };
  const worktreeCounts = scenario.worktreeCounts || { 'dir-1': 2 };
  const cardOf = t => ({ id: t.id, title: t.title, sessionId: t.sessionId, runState: null,
    worktreeChanges: null, capacityReason: null,
    resource: { id: `ws-${t.id}`, residency: 'retained', lease: 'idle', capacityReason: null } });
  // snapshotAsync 只收到 key + 签名（真实实现里整行任务不过边界），卡片正文要靠
  // 同一轮 prepareAsync 已经给出的可见集合来还原。
  let visible = new Map();
  return {
    mode: 'off',
    async prepareAsync(input) {
      const tasks = Object.values((input.board && input.board.tasks) || {});
      visible = new Map(tasks.map(task => [task.id, task]));
      return {
        tasks,
        globalSignature: 'air-world-1',
        worktreeCounts,
        lifecycle,
        signatures: Object.fromEntries(tasks.map(task => [task.id, `sig:${task.id}`])),
        taskDirs: Object.fromEntries(tasks.map(task => [task.id, 'dir-1'])),
      };
    },
    async resolveAsync(_signature, cards) {
      return {
        hits: cards.length,
        builds: 0,
        entries: cards.map(t => ({ t, capacityOf: null, card: cardOf(t) })),
      };
    },
    async overlayAsync(resolved) {
      return resolved.entries.map(entry => entry.card);
    },
    // 脚本世界里卡片是写死的，所以不需要底稿回填：按 items 的顺序吐卡，与
    // resolveAsync + overlayAsync 的组合完全一致。
    async snapshotAsync(command) {
      const cards = (command.items || []).map(item => cardOf(visible.get(item.key)));
      return { cards, hits: cards.length, builds: 0 };
    },
  };
}

function answerOf(answers, key) {
  const entry = answers[key];
  if (entry === undefined) return undefined;
  if (entry.throw) {
    const spec = entry.throw;
    const error = Object.assign(new Error(spec.message), spec);
    throw error;
  }
  const value = entry.value === undefined ? null : entry.value;
  return JSON.parse(JSON.stringify(value));
}

function buildDeps(rawScenario) {
  const scenario = rawScenario || {};
  const answers = scenario.answers || {};
  const calls = [];
  // `undefined` never survives JSON, so a case's effects must not depend on
  // whether a port was called with it or with null.
  const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const record = (entry) => {
    const out = {};
    for (const [key, value] of Object.entries(entry)) out[key] = value === undefined ? null : value;
    calls.push(out);
    return out;
  };
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'air-scripted-world-'));
  const board = scenario.board ? { tasks: scenario.board } : makeBoard(['tk-a', 'tk-b']);
  const records = new Map(Object.entries(scenario.records || baseRecords()));
  const directories = new Map(Object.entries(scenario.directories
    || { 'dir-1': { id: 'dir-1', name: 'One', path: '/tmp/air-one' } }));
  const hibernation = scenario.hibernation === false ? () => null : () => ({
    policy: () => answerOf(answers, 'hibernationPolicy'),
    reclaim: async (input) => {
      record({ call: 'reclaim', dirId: input.dirId, force: input.force === true });
      return answerOf(answers, 'reclaim');
    },
  });

  const deps = {
    records,
    directories,
    clis: scenario.clis || [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
    getBoard: () => board,
    hibernation,
    sessions: new Map(),
    pinsFile: nodePath.join(dir, 'air-pins.json'),
    todosFile: nodePath.join(dir, 'air-todos.json'),
    todoIgnoresFile: nodePath.join(dir, 'air-todo-ignores.json'),
    cardCache: fakeCardCache(scenario),
    phaseDiagnostics: { logMs: 1e9, gapMs: 1e9, bootWindowS: 0 },
    logger: { warn() {}, error() {}, info() {} },
    isLocal: () => true,
    cronSessionIds: () => [],
    getSessionRunState: () => null,
    providerName: record_ => (record_ && record_.provider ? `Line ${record_.provider}` : null),
    serializeSubagent: value => (value ? JSON.parse(JSON.stringify(value)) : null),
    effectiveModel: record_ => (record_ ? record_.model || null : null),
    effectiveEffort: record_ => (record_ ? record_.effort || null : null),
    markTaskSeen: id => record({ call: 'markTaskSeen', taskId: id }),
    shell: {
      migrateTaskSessions: () => answerOf(answers, 'migrate'),
      listTasks: () => scenario.shellTasks || [],
      taskEntry: (taskId, options) => {
        record({ call: 'taskEntry', taskId,
          includeMessages: !(options && options.includeMessages === false) });
        return answerOf(answers, `taskEntry:${taskId}`);
      },
      createTask: (body) => {
        record({ call: 'createTask', body });
        return answerOf(answers, 'createTask');
      },
      updateRoleBindings: (taskId, body) => {
        record({ call: 'updateRoleBindings', taskId, body });
        return answerOf(answers, `roleBindings:${taskId}`);
      },
      roleBindings: taskId => answerOf(answers, `roleBindings:${taskId}`),
      stateTarget: (sessionId) => {
        record({ call: 'stateTarget', sessionId });
        return answerOf(answers, `stateTarget:${sessionId}`) || {};
      },
      artifactTaskId: (sessionId) => {
        record({ call: 'artifactTaskId', sessionId });
        return answerOf(answers, `artifactTaskId:${sessionId}`);
      },
      chatScope: (shellId) => {
        record({ call: 'chatScope', shellId });
        return answerOf(answers, `chatScope:${shellId}`) || {};
      },
      attributionCandidate: taskId => answerOf(answers, `candidate:${taskId}`) || null,
      taskSeparation: taskId => answerOf(answers, `separation:${taskId}`) || null,
      taskAccessBatch: cards => new Map(cards.map(task => [task.id, { role: 'owner' }])),
      taskAccess: () => ({ role: 'owner' }),
    },
    admission: {
      snapshot: () => {
        record({ call: 'admissionSnapshot' });
        return scenario.admission || { budgets: [], workspaces: [], leases: [] };
      },
      identify: (sessionId) => {
        record({ call: 'identify', sessionId });
        if (scenario.identifyThrow) {
          throw Object.assign(new Error(scenario.identifyThrow.message), scenario.identifyThrow);
        }
      },
      recoverEvidence: (sessionId) => {
        record({ call: 'recoverEvidence', sessionId });
        return answerOf(answers, `recoverEvidence:${sessionId}`);
      },
      capacityReason: () => ({ code: 'directory_busy' }),
      deliveryEvidence: (sessionId, turnId) => {
        record({ call: 'deliveryEvidence', sessionId, turnId });
        return answerOf(answers, `deliveryEvidence:${sessionId}`) || {};
      },
      verifyBaseline: () => answerOf(answers, 'verifyBaseline'),
    },
  };

  return { scenario, answers, effects: { calls }, deps, dir };
}

/** The stub child swaps worlds per host-port call without remounting the app. */
function bindDeps(getDeps) {
  // `buildDeps` returns the scenario bag ({scenario, answers, effects, dir})
  // around the deps the handlers read. Accept either shape, so a caller that
  // holds the bag gets the live deps (and its per-bag temp pins/todos files)
  // while a caller that already holds a deps object keeps working.
  const resolve = () => {
    const bag = getDeps();
    return bag && bag.deps ? bag.deps : bag;
  };
  return new Proxy({}, {
    get: (_target, key) => resolve()[key],
    has: (_target, key) => key in resolve(),
  });
}

module.exports = { buildDeps, bindDeps, makeBoard };

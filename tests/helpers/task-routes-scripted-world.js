'use strict';

// Scripted world for the task-surface cluster (16 public routes now answered by
// native/gateway/src/app/task_routes.rs). One bag of Node facts feeds both
// sides of the migration differential:
//
//   mountLegacy(app, bag)     the frozen HEAD handlers
//                             (tests/helpers/legacy-task-routes.js)
//   currentHostOptions(bag)   the live host port composition
//                             (src/routes/task-routes-host.js)
//
// so the comparison covers the split itself: the Rust side decides paths,
// parameter decoding, validation ladders, status codes and envelopes, and only
// asks Node for the facts through `/api/__host/task-routes`.
//
// The scenario has two halves:
//
//   answers   keyed by port operation (`findMessages`, `prepareDelete:<id>`,
//             `relocateSessionWorkspace`, …). Each is `{ value }` or
//             `{ throw: { code, status, message } }`.
//   board / records / shellTasks / directories / messagesRuntime / warming /
//   taskEntry / runStates / busySessions / pinned / attributionMode
//             the fixed facts the handlers read.
//
// Every stateful call both sides make is appended to `effects.calls`, which the
// differential compares per case: a route that answers the same bytes but asks
// Node for the wrong thing (or twice) fails.
//
// Each bag gets its own temp directory, so the task-board file never shares a
// path with another case or with the checkout.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const NOW = 1700000000000;

function clone(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function task(id, patch = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}`,
    dirId: 'dir-1',
    status: 'active',
    column: 'inbox',
    priority: 'medium',
    dueAt: null,
    acceptanceCriteria: '',
    recordType: 'planned',
    workflowStage: 'inbox',
    rank: 1024,
    planningRevision: 1,
    refs: [],
    routing: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function defaultBoard() {
  return {
    schemaVersion: 2,
    revision: 5,
    tasks: {
      'tk-1': task('tk-1', {
        refs: [{ sessionId: 's-done', dirId: 'dir-1', userMsgId: 'm-1', ts: '2026-01-03T00:00:00.000Z' }],
      }),
      'tk-2': task('tk-2', {
        title: 'Task tk-2', status: 'done', workflowStage: 'done', rank: 2048,
        description: 'Do tk-2', dirId: 'dir-1', chatSessionId: 's-done',
        refs: [{ sessionId: 's-done', dirId: 'dir-1', userMsgId: 'm-1', ts: '2026-01-03T00:00:00.000Z' }],
        updatedAt: NOW - 1000,
      }),
      'tk-3': task('tk-3', {
        status: 'archived', workflowStage: 'done', archivedFromStatus: 'done', rank: 3072,
        chatSessionId: 's-arch', updatedAt: NOW - 2000,
        refs: [{ sessionId: 's-arch', dirId: 'dir-1', userMsgId: 'm-2', ts: '2026-01-02T00:00:00.000Z' }],
      }),
      'tk-9': task('tk-9', { dirId: 'dir-2', title: 'Task tk-9' }),
      'tk-D': task('tk-D', { title: 'Interact', chatSessionId: 's-interact' }),
      'tk-A': task('tk-A', { title: 'Achieved', chatSessionId: 's-achieved' }),
      'tk-S': task('tk-S', { title: 'Streaming', chatSessionId: 's-stream' }),
    },
    deletedTaskIds: [],
    modules: {},
    taskGroups: {},
  };
}

function defaultRecords() {
  return {
    's-done': {
      id: 's-done', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Done session',
      taskBoundTaskId: 'tk-2', createdAt: '2026-01-01T00:00:00.000Z', lastWorkAt: '2026-01-03T00:00:00.000Z',
    },
    's-arch': {
      id: 's-arch', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Archived session',
      taskBoundTaskId: 'tk-3', createdAt: '2026-01-01T00:00:00.000Z', lastWorkAt: '2026-01-02T00:00:00.000Z',
    },
    's-interact': {
      id: 's-interact', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Interact session',
      taskBoundTaskId: 'tk-D',
      taskState: { taskId: 'tk-D', goalState: 'interact', classifyState: 'D' },
    },
    's-achieved': {
      id: 's-achieved', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Achieved session',
      taskBoundTaskId: 'tk-A',
      taskState: { taskId: 'tk-A', goalState: 'achieved', classifyState: 'D' },
    },
    's-stream': {
      id: 's-stream', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Streaming session',
      taskBoundTaskId: 'tk-S',
      taskState: { taskId: 'tk-S', goalState: 'interact', classifyState: 'D' },
    },
    's-legacy': {
      id: 's-legacy', kind: 'chat', type: 'chat', dirId: 'dir-1', label: 'Legacy session',
      taskState: { taskId: 'tk-2' },
    },
  };
}

function defaultShellTasks() {
  return [
    { id: 'tk-2', dirId: 'dir-1', sessionId: 's-done', ready: true, title: 'Task tk-2' },
    { id: 'tk-3', dirId: 'dir-1', sessionId: 's-arch', ready: true, title: 'Task tk-3' },
    { id: 'tk-1', dirId: 'dir-1', sessionId: 's-none', ready: true, title: 'Task tk-1' },
  ];
}

function defaultGraphState() {
  return {
    tasks: [
      { id: 'tk-1', dirId: 'dir-1', sessionId: 's-done', title: 'Task tk-1', ready: true, createdAt: NOW - 5000 },
      { id: 'tk-shell', dirId: 'dir-1', sessionId: 's-none', title: 'Shell task', ready: false, createdAt: NOW - 4000 },
    ],
    shells: [{ id: 'sh-1', dirId: 'dir-1', sourceSessionId: 's-done' }],
    links: [{ shellId: 'sh-1', taskId: 'tk-1' }],
    relations: [],
  };
}

function defaultDirectories() {
  return {
    'dir-1': { id: 'dir-1', name: 'One', path: '/tmp/task-routes/dir-1' },
    'dir-2': { id: 'dir-2', name: 'Two', path: '/tmp/task-routes/dir-2' },
  };
}

function answerOf(answers, key) {
  const entry = answers[key];
  if (entry === undefined) return undefined;
  if (entry.throw) {
    throw Object.assign(new Error(entry.throw.message), entry.throw);
  }
  return clone(entry.value === undefined ? null : entry.value);
}

function buildDeps(rawScenario) {
  const scenario = rawScenario || {};
  const answers = scenario.answers || {};
  const calls = [];
  const record = (entry) => {
    // A created task carries a random id; both sides generate their own, so the
    // comparison treats it as one value.
    calls.push(JSON.parse(JSON.stringify(entry).replace(/tsk-plan-[0-9a-f]{32}/g, 'tsk-plan-<uuid>')));
  };
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'task-routes-world-'));
  const boardFile = nodePath.join(dir, 'task_board.json');
  fs.writeFileSync(boardFile, JSON.stringify(scenario.board || defaultBoard()));
  const records = new Map(Object.entries(scenario.records || defaultRecords()));
  const directories = new Map(Object.entries(scenario.directories || defaultDirectories()));
  const bag = {};

  const repository = require('../../src/task-board/repository')
    .createTaskBoardRepository(boardFile);
  const recordingRepository = {
    load: () => repository.load(),
    save: (value, expectedRevision, options = {}) => {
      record({ call: 'boardSave', revision: value ? value.revision : null,
        expectedRevision: expectedRevision === undefined ? null : expectedRevision,
        onConflict: options.onConflict || null });
      return repository.save(value, expectedRevision, options);
    },
  };

  // server.js hands the routes a memoized accessor (getSharedSearchRuntime), so
  // the front door's two host operations for one search — scope, then search —
  // reach the same runtime instance. Resolving twice is not a second open.
  let messagesRuntime;
  const messages = () => {
    if (messagesRuntime !== undefined) return messagesRuntime;
    record({ call: 'messagesRuntime' });
    if (scenario.messagesRuntime === false) { messagesRuntime = null; return null; }
    messagesRuntime = {
      status: () => {
        record({ call: 'messageStatus' });
        return { warming: scenario.warming === true };
      },
      findMessages: (input) => {
        record({ call: 'findMessages', input });
        const answer = answerOf(answers, 'findMessages');
        return answer === undefined ? [] : answer;
      },
    };
    return messagesRuntime;
  };

  const deps = {
    file: boardFile,
    taskBoardRepository: recordingRepository,
    auxQueue: {
      isUnhealthy: () => false,
      cancel() {},
      enqueue: () => Promise.resolve({ ok: true }),
    },
    records,
    directories,
    getBoard: () => bag.runtime.getBoard(),
    listShellTasks: () => {
      record({ call: 'listShellTasks' });
      if (scenario.shellInventory === false) return [];
      return clone(scenario.shellTasks || defaultShellTasks());
    },
    loadHistory: (sessionId) => {
      record({ call: 'loadHistory', sessionId: sessionId === undefined ? null : sessionId });
      return [];
    },
    createSessionRecord: async (input) => {
      record({ call: 'createSessionRecord', taskId: input.taskBoundTaskId || null,
        dirId: input.dir ? input.dir.id : null });
      const answer = answerOf(answers, 'createSessionRecord');
      if (answer !== undefined) return answer;
      const id = `bound-${records.size + 1}`;
      records.set(id, { id, kind: 'chat', type: 'chat', dirId: input.dir ? input.dir.id : null,
        taskBoundTaskId: input.taskBoundTaskId || null, label: input.label || null });
      return { ok: true, id, session: records.get(id) };
    },
    dispatchToSession: async () => ({ ok: true, chatId: 's-done', operationId: 'op-1', status: 'delivering' }),
    sendSessionMessage: async (sessionId, text) => {
      record({ call: 'sendSessionMessage', sessionId });
      return { ok: true, handled: false, chatId: sessionId };
    },
    workspaceBroadcast: (dirId, payload) => {
      record({ call: 'broadcast', dirId: dirId === undefined ? null : dirId, payload });
    },
    atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: (sessionId) => {
      record({ call: 'getRunState', sessionId });
      return (scenario.runStates || {})[sessionId] || 'idle';
    },
    isSessionBusy: (sessionId) => {
      record({ call: 'isSessionBusy', sessionId });
      return (scenario.busySessions || []).includes(sessionId);
    },
    isTaskBusy: () => false,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    resolveSessionQueue: async (sessionId, taskId) => {
      record({ call: 'resolveSessionQueue', sessionId, taskId });
      const answer = answerOf(answers, `resolveSessionQueue:${sessionId}`);
      return answer === undefined ? { ok: true } : answer;
    },
    getPinnedTaskIds: () => {
      record({ call: 'getPinnedTaskIds' });
      return clone(scenario.pinned || []);
    },
    prepareTaskDelete: async (task_, ids, options = {}) => {
      record({ call: 'prepareTaskDelete', ids: clone(ids), force: options.force === true,
        automatic: options.automatic === true });
      const answer = answerOf(answers, `prepareDelete:${ids[0]}`);
      if (answer !== undefined) return answer;
      return { ok: true };
    },
    purgeTaskData: async (task_, ids, options = {}) => {
      record({ call: 'purgeTaskData', ids: clone(ids), force: options.force === true,
        automatic: options.automatic === true });
    },
    assertTaskIdle: async (task_, ids) => {
      record({ call: 'assertTaskIdle', taskId: task_ ? task_.id : null, ids: clone(ids) });
      const answer = answerOf(answers, `assertIdle:${task_ ? task_.id : ''}`);
      if (answer !== undefined) return answer;
    },
    relocateSessionWorkspace: async (sessionId, dirId, options = {}) => {
      record({ call: 'relocateSessionWorkspace', sessionId, dirId, force: options.force === true,
        carry: options.carry === true });
      const answer = answerOf(answers, 'relocateSessionWorkspace');
      return answer === undefined ? { ok: true, cwd: '/tmp/task-routes/dir-2' } : answer;
    },
    gitRelocateWorktree: async (from, to, worktree) => {
      record({ call: 'gitRelocateWorktree', from: from ? from.id : null, to: to ? to.id : null,
        taskId: worktree ? worktree.id : null });
      const answer = answerOf(answers, 'gitRelocateWorktree');
      return answer === undefined ? { ok: true } : answer;
    },
    relocateShellTask: (taskId, dirId, options = {}) => {
      record({ call: 'relocateShellTask', taskId, dirId, dryRun: options.dryRun === true });
      const answer = answerOf(answers, `relocateShellTask:${taskId}`);
      return answer === undefined ? { ok: true } : answer;
    },
    taskShellTaskEntry: async (taskId) => {
      record({ call: 'taskShellTaskEntry', taskId });
      const answer = answerOf(answers, `taskEntry:${taskId}`);
      return answer === undefined ? { ok: true, readOnly: false, task: { id: taskId } } : answer;
    },
    syncTaskTitle: (value) => {
      record({ call: 'syncTaskTitle', taskId: value && value.id ? value.id : null });
    },
    getTaskState: (record_) => {
      const state = record_ && record_.taskState ? record_.taskState : {};
      record({ call: 'getTaskState', sessionId: record_ && record_.id ? record_.id : null,
        taskId: state.taskId === undefined ? null : state.taskId });
      return state;
    },
    setTaskState: (sessionId, patch) => {
      record({ call: 'setTaskState', sessionId, keys: Object.keys(patch || {}).sort() });
      const record_ = records.get(sessionId);
      if (record_) record_.taskState = { ...(record_.taskState || {}), ...patch };
    },
    chatSessions: new Map([
      ['s-interact', { isStreaming: false }],
      ['s-stream', { isStreaming: true }],
    ]),
    messages,
    attributionMode: scenario.attributionMode || 'suggest',
  };
  deps.graph = {
    getBoard: () => bag.runtime.getBoard(),
    taskGraphData: () => {
      record({ call: 'taskGraphData' });
      if (scenario.graphThrows) throw new Error(scenario.graphThrows);
      return clone(scenario.graphState || defaultGraphState());
    },
    getRecord: (id) => {
      record({ call: 'graphGetRecord', sessionId: id === undefined ? null : id });
      return records.get(id);
    },
    directories,
    now: () => (scenario.clock === undefined ? Date.now() : scenario.clock),
  };

  bag.scenario = scenario;
  bag.answers = answers;
  bag.effects = { calls };
  bag.deps = deps;
  bag.records = records;
  bag.dir = dir;
  return bag;
}

/** The stub child swaps bags per host-port call without remounting the app. */
function bindDeps(getBag) {
  const current = () => {
    const value = getBag();
    return value && value.deps ? value.deps : value;
  };
  return new Proxy({}, {
    get: (_target, key) => current()[key],
    has: (_target, key) => key in current(),
  });
}

/** Frozen HEAD handlers over one bag. */
function mountLegacy(app, bag) {
  const legacy = require('./legacy-task-routes');
  const mounted = legacy.mountTaskRoutes(app, bag.deps);
  bag.runtime = mounted.boardRuntime;
  return mounted;
}

/** The live host-port composition over one bag. */
function currentHostOptions(bag) {
  const deps = bag.deps;
  const board = require('../../src/routes/task-board')
    .createTaskBoardRuntime(deps);
  bag.runtime = board;
  const search = require('../../src/routes/task-search')
    .createTaskSearchRoutes({ getBoard: () => board.getBoard(), messages: deps.messages, logger: deps.logger });
  const graph = require('../../src/routes/task-graph')
    .createTaskGraphRoutes(deps.graph);
  const goal = require('../../src/routes/task-goal');
  const attribution = require('../../src/task-shell/attribution-settings')
    .createAttributionSettings({ initial: deps.attributionMode });
  return {
    ports: board.routePorts,
    search,
    taskGoal: {
      facts: taskId => goal.markTaskAchievedFacts(deps, taskId),
      write: (taskId, sessionId) => goal.markTaskAchievedWrite(deps, taskId, sessionId),
    },
    taskGraph: graph,
    attributionMode: () => attribution.getMode(),
  };
}

module.exports = {
  buildDeps,
  bindDeps,
  mountLegacy,
  currentHostOptions,
  answerOf,
  defaultBoard,
  defaultRecords,
  NOW,
};

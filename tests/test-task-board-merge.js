'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const core = require('../src/task-board');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { createTaskRunStore } = require('../src/task-run-store');
const { mkRuntime } = require('./helpers/task-board-runtime');

function mkRef(overrides = {}) {
  return {
    sessionId: 's1', dirId: 'd1', dirLabel: 'multicc',
    userMsgId: 'mu1', assistantMsgId: 'ma1',
    ts: 1000, excerpt: '做点事',
    ...overrides,
  };
}

test('explicit board-task merge preserves target identity and folds bounded chronological evidence', () => {
  const ref = index => ({
    sessionId: index < 251 ? 'bound-target' : 'bound-source',
    dirId: 'd1', userMsgId: `u-${index}`, assistantMsgId: `a-${index}`,
    ts: index + 1, excerpt: `turn ${index}`,
  });
  const board = core.normalizeBoard({
    modules: {
      targetModule: { id: 'targetModule', name: '任务板', source: 'ai', dirId: 'd1' },
      sourceModule: { id: 'sourceModule', name: '会话', source: 'ai', dirId: 'd1' },
    },
    tasks: {
      target: {
        id: 'target', moduleId: 'targetModule', title: '保留这个标题', origin: 'board',
        status: 'done', areas: ['shared', 'target-area'], createdAt: 20, updatedAt: 30,
        refs: Array.from({ length: 251 }, (_, index) => ref(index)),
        chatSessionId: 'bound-target', worktreePath: '/repo/target', branch: 'multicc/target',
      },
      source: {
        id: 'source', moduleId: 'sourceModule', title: '相似但不同的标题', origin: 'board',
        status: 'active', areas: ['shared', 'source-area'], createdAt: 10, updatedAt: 40,
        // index 250 deliberately duplicates the target's final ref.
        refs: Array.from({ length: 252 }, (_, index) => ref(index + 250)),
        chatSessionId: 'bound-source',
      },
    },
  });

  const result = core.mergeTasks(board, {
    targetTaskId: 'target', sourceTaskIds: ['source'], now: 1_000,
  });

  assert.equal(result.ok, true);
  const target = board.tasks.target;
  const source = board.tasks.source;
  assert.equal(target.id, 'target');
  assert.equal(target.title, '保留这个标题');
  assert.equal(target.moduleId, 'targetModule');
  assert.equal(target.chatSessionId, 'bound-target');
  assert.equal(target.worktreePath, '/repo/target');
  assert.equal(target.branch, 'multicc/target');
  assert.equal(target.status, 'active', 'any active member keeps the merged task active');
  assert.deepEqual(target.areas, ['shared', 'target-area', 'source-area']);
  assert.equal(target.refs.length, core.MAX_REFS_PER_TASK);
  assert.equal(target.refs[0].ts, 3, 'the cap keeps the newest 500 refs');
  assert.equal(target.refs.at(-1).ts, 502);
  assert.equal(new Set(target.refs.map(item => item.assistantMsgId)).size, target.refs.length,
    'the overlapping source/target turn is present only once');
  assert.ok(target.refs.every((item, index, refs) => index === 0 || refs[index - 1].ts <= item.ts));

  assert.equal(source.status, 'archived');
  assert.equal(source.mergedInto, 'target');
  assert.equal(source.mergedAt, 1_000);
  assert.equal(source.chatSessionId, 'bound-source',
    'the tombstone retains its bound-session lineage instead of deleting history');
});

test('explicit session-task merge keeps done lifecycle and rejects cross-origin or cross-Fleet identity', () => {
  const makeBoard = () => core.normalizeBoard({
    modules: {
      d1: { id: 'd1', name: 'Fleet 1', source: 'ai', dirId: 'dir-1' },
      d2: { id: 'd2', name: 'Fleet 2', source: 'ai', dirId: 'dir-2' },
    },
    tasks: {
      target: {
        id: 'target', moduleId: 'd1', title: '修复任务', origin: 'session', status: 'done',
        refs: [mkRef({ sessionId: 's1', dirId: 'dir-1', userMsgId: 'u1', assistantMsgId: 'a1', ts: 10 })],
      },
      source: {
        id: 'source', moduleId: 'd1', title: '修复同一任务', origin: 'session', status: 'done',
        refs: [mkRef({ sessionId: 's2', dirId: 'dir-1', userMsgId: 'u2', assistantMsgId: 'a2', ts: 20 })],
      },
    },
  });

  const merged = makeBoard();
  assert.equal(core.mergeTasks(merged, {
    targetTaskId: 'target', sourceTaskIds: ['source'], now: 30,
  }).ok, true);
  assert.equal(merged.tasks.target.status, 'done', 'merging historical refs must not reactivate two done tasks');
  assert.deepEqual(merged.tasks.target.refs.map(item => item.sessionId), ['s1', 's2']);

  const mixed = makeBoard();
  mixed.tasks.source.origin = 'board';
  const mixedBefore = JSON.stringify(mixed);
  const mixedResult = core.mergeTasks(mixed, {
    targetTaskId: 'target', sourceTaskIds: ['source'], now: 31,
  });
  assert.equal(mixedResult.ok, false);
  assert.equal(mixedResult.error, 'task_origin_mismatch');
  assert.equal(JSON.stringify(mixed), mixedBefore, 'a rejected cross-origin merge is mutation-free');

  const crossFleet = makeBoard();
  crossFleet.tasks.source.moduleId = 'd2';
  crossFleet.tasks.source.refs[0].dirId = 'dir-2';
  const fleetBefore = JSON.stringify(crossFleet);
  const fleetResult = core.mergeTasks(crossFleet, {
    targetTaskId: 'target', sourceTaskIds: ['source'], now: 32,
  });
  assert.equal(fleetResult.ok, false);
  assert.equal(fleetResult.error, 'task_directory_mismatch');
  assert.equal(JSON.stringify(crossFleet), fleetBefore, 'a rejected cross-Fleet merge is mutation-free');
});

test('REST merge preserves bound-session history, persists tombstones and broadcasts every touched id', async () => {
  const released = [];
  const records = new Map([
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1', label: 'Agent Commander' }],
    ['bound-target', { id: 'bound-target', kind: 'chat', dirId: 'dir-1', label: '目标会话', taskBoundTaskId: 'target' }],
    ['bound-source', { id: 'bound-source', kind: 'chat', dirId: 'dir-1', label: '来源会话', taskBoundTaskId: 'source' }],
  ]);
  const histories = new Map([
    ['bound-target', [
      { id: 'u-target', role: 'user', content: '目标任务原文', ts: 10 },
      { id: 'a-target', role: 'assistant', content: '目标任务回复', ts: 11 },
    ]],
    ['bound-source', [
      { id: 'u-source', role: 'user', content: '来源任务原文', ts: 20 },
      { id: 'a-source', role: 'assistant', content: '来源任务回复', ts: 21 },
    ]],
  ]);
  const fixture = mkRuntime({
    records,
    loadHistory: sessionId => histories.get(sessionId) || [],
    releaseTaskBoundSession: async sessionId => {
      released.push(sessionId);
      return { ok: true };
    },
  });
  const seeded = core.normalizeBoard({
    modules: {
      mod: { id: 'mod', name: '任务板', source: 'ai', dirId: 'dir-1' },
    },
    tasks: {
      target: {
        id: 'target', moduleId: 'mod', title: '保留任务', origin: 'board', status: 'done',
        runState: 'succeeded', chatSessionId: 'bound-target', refs: [{
          sessionId: 'bound-target', dirId: 'dir-1', userMsgId: 'u-target',
          assistantMsgId: 'a-target', ts: 11, excerpt: '目标任务原文',
        }],
      },
      source: {
        id: 'source', moduleId: 'mod', title: '重复任务', origin: 'board', status: 'done',
        runState: 'succeeded', chatSessionId: 'bound-source', refs: [{
          sessionId: 'bound-source', dirId: 'dir-1', userMsgId: 'u-source',
          assistantMsgId: 'a-source', ts: 21, excerpt: '来源任务原文',
        }],
      },
    },
  });
  Object.assign(fixture.runtime.getBoard().modules, seeded.modules);
  Object.assign(fixture.runtime.getBoard().tasks, seeded.tasks);
  fixture.runtime.save();

  const routes = new Map();
  fixture.runtime.mountRoutes({
    get: (path_, handler) => routes.set(`GET ${path_}`, handler),
    post: (path_, handler) => routes.set(`POST ${path_}`, handler),
  });
  const response = () => ({
    code: 200, body: null, headersSent: false,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  });

  const merged = response();
  await routes.get('POST /api/task-board/tasks/:targetTaskId/merge-tasks')({
    params: { targetTaskId: 'target' }, body: { sourceTaskIds: ['source'] },
  }, merged);
  assert.equal(merged.code, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.ok, true);
  assert.equal(merged.body.targetTaskId, 'target');
  assert.deepEqual(merged.body.mergedTaskIds, ['source']);
  assert.equal(merged.body.task.id, 'target');
  assert.equal(merged.body.task.chatSessionId, 'bound-target');

  const board = fixture.runtime.getBoard();
  assert.equal(board.tasks.source.status, 'archived');
  assert.equal(board.tasks.source.mergedInto, 'target');
  assert.ok(board.tasks.source.mergedAt > 0);
  assert.equal(board.tasks.source.chatSessionId, 'bound-source');
  assert.deepEqual(released, [], 'merge never deletes the source bound session or its transcript');
  assert.equal(records.get('bound-source').taskBoundTaskId, 'source');
  assert.deepEqual(new Set(fixture.broadcasts.at(-1).payload.taskIds), new Set(['target', 'source']));

  const messages = response();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({
    params: { taskId: 'target' }, query: {},
  }, messages);
  assert.equal(messages.code, 200);
  assert.deepEqual(messages.body.items.map(item => item.messageId), [
    'u-target', 'a-target', 'u-source', 'a-source',
  ], 'the surviving task reads both bound-session transcripts through merged refs');

  const persisted = JSON.parse(fs.readFileSync(fixture.file, 'utf8'));
  assert.equal(persisted.tasks.source.mergedInto, 'target');
  assert.ok(persisted.tasks.source.mergedAt > 0);
  const restarted = createTaskBoardRuntime(fixture.deps);
  assert.equal(restarted.getBoard().tasks.source.mergedInto, 'target');
  assert.equal(restarted.getBoard().tasks.source.chatSessionId, 'bound-source');
});

test('REST merge aggregates target and tombstone TaskRuns without reassigning durable ownership', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-taskboard-merge-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taskRuns = createTaskRunStore({ file: path.join(dir, 'runs.sqlite'), Database });
  t.after(() => taskRuns.close());
  const admit = (taskId, runId, messageId, text, startedAt) => {
    taskRuns.admitRun({
      run: { runId, taskId, attemptId: runId, slotId: null, startedAt, metadata: {} },
      messages: [{
        messageId, role: 'user', kind: 'admission', content: text,
        metadata: {}, createdAt: startedAt,
      }],
    });
    taskRuns.sealUsage({
      runId, executionStatus: 'succeeded', outcomeDurable: true,
      producersDrained: true, nativeTranscriptChecked: true,
    });
  };
  admit('target', 'run-target', 'm-target', '目标运行', 10);
  admit('source', 'run-source', 'm-source', '来源运行', 20);

  const fixture = mkRuntime({ taskRuns });
  const seeded = core.normalizeBoard({
    modules: { mod: { id: 'mod', name: '任务板', source: 'ai', dirId: 'dir-1' } },
    tasks: {
      target: {
        id: 'target', moduleId: 'mod', title: '目标', origin: 'session', status: 'done',
        runState: 'succeeded', refs: [mkRef({ sessionId: 'sess-1', dirId: 'dir-1', ts: 10 })],
      },
      source: {
        id: 'source', moduleId: 'mod', title: '来源', origin: 'session', status: 'done',
        runState: 'succeeded', refs: [mkRef({
          sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'u2', assistantMsgId: 'a2', ts: 20,
        })],
      },
    },
  });
  Object.assign(fixture.runtime.getBoard().modules, seeded.modules);
  Object.assign(fixture.runtime.getBoard().tasks, seeded.tasks);

  const routes = new Map();
  fixture.runtime.mountRoutes({
    get: (path_, handler) => routes.set(`GET ${path_}`, handler),
    post: (path_, handler) => routes.set(`POST ${path_}`, handler),
  });
  const response = () => ({
    code: 200, body: null, headersSent: false,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  });
  const merged = response();
  await routes.get('POST /api/task-board/tasks/:targetTaskId/merge-tasks')({
    params: { targetTaskId: 'target' }, body: { sourceTaskIds: ['source'] },
  }, merged);
  assert.equal(merged.code, 200, JSON.stringify(merged.body));

  const detail = response();
  routes.get('GET /api/task-board/tasks/:taskId')({ params: { taskId: 'target' } }, detail);
  assert.deepEqual(detail.body.task.runs.map(run => run.runId), ['run-source', 'run-target'],
    'task run history keeps the existing newest-first projection contract');
  assert.equal(detail.body.task.usage.runCount, 2);

  const history = response();
  routes.get('GET /api/task-board/tasks/:taskId/messages')({
    params: { taskId: 'target' }, query: {},
  }, history);
  assert.deepEqual(
    history.body.items.filter(item => item.taskRunId).map(item => item.messageId),
    ['m-target', 'm-source'],
    'both durable run transcripts survive alongside any legacy ref-backed rows',
  );
  assert.equal(taskRuns.listTaskRuns('target').length, 1);
  assert.equal(taskRuns.listTaskRuns('source').length, 1,
    'tombstone lineage aggregates reads without rewriting durable run ownership');
});

test('REST merge rejects busy or worktree-owned selections and rolls back failed persistence', async () => {
  const invoke = async ({ targetPatch = {}, sourcePatch = {}, atomicWriteJson } = {}) => {
    const fixture = mkRuntime({ ...(atomicWriteJson ? { atomicWriteJson } : {}) });
    const seeded = core.normalizeBoard({
      modules: { mod: { id: 'mod', name: '任务板', source: 'ai', dirId: 'dir-1' } },
      tasks: {
        target: {
          id: 'target', moduleId: 'mod', title: '目标', origin: 'session', status: 'done',
          runState: 'succeeded', refs: [mkRef({ dirId: 'dir-1', ts: 10 })], ...targetPatch,
        },
        source: {
          id: 'source', moduleId: 'mod', title: '来源', origin: 'session', status: 'done',
          runState: 'succeeded', refs: [mkRef({
            dirId: 'dir-1', userMsgId: 'u2', assistantMsgId: 'a2', ts: 20,
          })], ...sourcePatch,
        },
      },
    });
    Object.assign(fixture.runtime.getBoard().modules, seeded.modules);
    Object.assign(fixture.runtime.getBoard().tasks, seeded.tasks);
    const before = JSON.stringify(fixture.runtime.getBoard());
    const routes = new Map();
    fixture.runtime.mountRoutes({
      get: () => {},
      post: (path_, handler) => routes.set(path_, handler),
    });
    const res = {
      code: 200, body: null, headersSent: false,
      status(code) { this.code = code; return this; },
      json(body) { this.body = body; this.headersSent = true; return this; },
    };
    await routes.get('/api/task-board/tasks/:targetTaskId/merge-tasks')({
      params: { targetTaskId: 'target' }, body: { sourceTaskIds: ['source'] },
    }, res);
    return { fixture, res, before };
  };

  for (const [where, state] of [['target', 'queued'], ['source', 'running'], ['source', 'waiting']]) {
    const result = await invoke({ [`${where}Patch`]: { runState: state } });
    assert.equal(result.res.code, 409, `${where} ${state}`);
    assert.equal(result.res.body.error, 'task_busy');
    assert.equal(JSON.stringify(result.fixture.runtime.getBoard()), result.before);
    assert.equal(result.fixture.broadcasts.length, 0);
  }

  const worktree = await invoke({
    sourcePatch: { worktreePath: '/repo/source', branch: 'multicc/source' },
  });
  assert.equal(worktree.res.code, 409);
  assert.equal(worktree.res.body.error, 'task_worktree_conflict');
  assert.equal(JSON.stringify(worktree.fixture.runtime.getBoard()), worktree.before);

  const persistFailure = await invoke({
    atomicWriteJson: () => { throw new Error('disk full'); },
  });
  assert.equal(persistFailure.res.code, 500);
  assert.equal(persistFailure.res.body.error, 'task_merge_persist_failed');
  assert.equal(JSON.stringify(persistFailure.fixture.runtime.getBoard()), persistFailure.before,
    'a failed atomic write restores the in-memory board including source lifecycle');
  assert.equal(persistFailure.fixture.broadcasts.length, 0);
});

test('merged cold start combines ledger and ref-only history once, including an enriched assistant', async () => {
  const taskRuns = {
    beginRun: input => input,
    listTaskRuns: taskId => taskId === 'source'
      ? [{ runId: 'source-run', executionStatus: 'succeeded' }] : [],
    getRunMessages: () => [{
      messageId: 'ledger-source-user', role: 'user', kind: 'admission',
      content: '来源任务原文', createdAt: 20,
    }],
  };
  const records = new Map([
    ['commander-1', { id: 'commander-1', kind: 'chat', type: 'commander', dirId: 'dir-1' }],
    ['target-session', { id: 'target-session', kind: 'chat', dirId: 'dir-1' }],
    ['source-session', { id: 'source-session', kind: 'chat', dirId: 'dir-1' }],
  ]);
  const histories = new Map([
    ['target-session', [
      { id: 'target-user', role: 'user', taskId: 'target', content: '目标任务原文', ts: 10 },
      { id: 'target-answer', role: 'assistant', taskId: 'target', content: '目标任务回复', ts: 11 },
    ]],
    ['source-session', [
      { id: 'source-user', role: 'user', taskId: 'source', content: '来源任务原文', ts: 20 },
      { id: 'source-answer', role: 'assistant', taskId: 'source', content: '来源任务回复', ts: 21 },
    ]],
  ]);
  const fixture = mkRuntime({
    records, taskRuns,
    loadHistory: id => histories.get(id) || [],
  });
  const board = core.normalizeBoard({
    modules: { mod: { name: '任务板', dirId: 'dir-1' } },
    tasks: {
      target: {
        title: '目标', moduleId: 'mod', origin: 'session',
        refs: [
          mkRef({ sessionId: 'target-session', dirId: 'dir-1',
            userMsgId: 'target-user', assistantMsgId: 'target-answer', ts: 11 }),
          mkRef({ sessionId: 'source-session', dirId: 'dir-1',
            userMsgId: 'source-user', assistantMsgId: 'source-answer',
            excerpt: '来源任务原文', ts: 21 }),
        ],
      },
      source: {
        title: '来源', moduleId: 'mod', origin: 'session',
        refs: [mkRef({ sessionId: 'source-session', dirId: 'dir-1',
          userMsgId: 'source-user', assistantMsgId: null,
          excerpt: '来源任务原文', ts: 20 })],
      },
    },
  });
  Object.assign(fixture.runtime.getBoard().modules, board.modules);
  Object.assign(fixture.runtime.getBoard().tasks, board.tasks);
  assert.equal(core.mergeTasks(fixture.runtime.getBoard(), {
    targetTaskId: 'target', sourceTaskIds: ['source'], now: 30,
  }).ok, true);

  const result = await fixture.runtime.routeCommanderFollowup(
    'commander-1', 'target', '继续处理', { clientMsgId: 'merged-seed' });
  assert.equal(result.ok, true);
  const seed = fixture.sessionMessages[0].options.taskContextSeed;
  for (const text of ['目标任务原文', '目标任务回复', '来源任务原文', '来源任务回复']) {
    assert.equal((seed.match(new RegExp(text, 'g')) || []).length, 1, `${text} should occur once`);
  }
  assert.equal(fixture.sessionMessages[0].text, '继续处理');
});

test('merge waits for status, send and target-worktree operations without resurrecting a source', async () => {
  const response = () => ({
    code: 200, body: null, headersSent: false,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  });
  const seedPair = fixture => {
    const seeded = core.normalizeBoard({
      modules: { mod: { name: '任务板', dirId: 'dir-1' } },
      tasks: {
        target: { title: '目标', moduleId: 'mod', origin: 'session',
          refs: [mkRef({ sessionId: 'sess-1', dirId: 'dir-1', ts: 10 })] },
        source: { title: '来源', moduleId: 'mod', origin: 'session',
          refs: [mkRef({ sessionId: 'sess-1', dirId: 'dir-1',
            userMsgId: 'u2', assistantMsgId: 'a2', ts: 20 })] },
      },
    });
    Object.assign(fixture.runtime.getBoard().modules, seeded.modules);
    Object.assign(fixture.runtime.getBoard().tasks, seeded.tasks);
  };
  const routesOf = fixture => {
    const routes = new Map();
    fixture.runtime.mountRoutes({ get() {}, post: (route, handler) => routes.set(route, handler) });
    return routes;
  };
  const merge = (routes, res = response()) => {
    routes.get('/api/task-board/tasks/:targetTaskId/merge-tasks')({
      params: { targetTaskId: 'target' }, body: { sourceTaskIds: ['source'] },
    }, res);
    return res;
  };

  let enterQueue;
  let finishQueue;
  const queueEntered = new Promise(resolve => { enterQueue = resolve; });
  const queueGate = new Promise(resolve => { finishQueue = resolve; });
  const statusFixture = mkRuntime({
    resolveSessionQueue: async () => { enterQueue(); return queueGate; },
  });
  seedPair(statusFixture);
  const statusRoutes = routesOf(statusFixture);
  const statusPromise = statusRoutes.get('/api/task-board/tasks/:taskId/status')({
    params: { taskId: 'source' }, body: { status: 'done' },
  }, response());
  await queueEntered;
  assert.equal(merge(statusRoutes).body.error, 'task_busy');
  finishQueue({ ok: false, code: 'no_active_task' });
  await statusPromise;
  assert.equal(merge(statusRoutes).code, 200);
  assert.equal(statusFixture.runtime.getBoard().tasks.source.status, 'archived');

  let enterSend;
  let finishSend;
  const sendEntered = new Promise(resolve => { enterSend = resolve; });
  const sendGate = new Promise(resolve => { finishSend = resolve; });
  const sendFixture = mkRuntime({
    sendSessionMessage: async () => { enterSend(); return sendGate; },
  });
  seedPair(sendFixture);
  const sendRoutes = routesOf(sendFixture);
  const sendPromise = sendFixture.runtime.routeCommanderFollowup(
    'commander-1', 'source', '继续', { clientMsgId: 'held-send' });
  await sendEntered;
  assert.equal(merge(sendRoutes).body.error, 'task_busy');
  finishSend({ ok: true, chatId: 'bound-1' });
  await sendPromise;
  assert.equal(merge(sendRoutes).code, 200);
  assert.equal(sendFixture.runtime.getBoard().tasks.source.status, 'archived');

  let enterWorktree;
  let finishWorktree;
  const worktreeEntered = new Promise(resolve => { enterWorktree = resolve; });
  const worktreeGate = new Promise(resolve => { finishWorktree = resolve; });
  const worktreeFixture = mkRuntime({
    gitWorktreeAdd: async () => { enterWorktree(); return worktreeGate; },
    gitWorktreeRemove: async () => ({ ok: true }),
    gitMergeBack: async () => ({ ok: true }),
  });
  seedPair(worktreeFixture);
  const worktreeRoutes = routesOf(worktreeFixture);
  const worktreePromise = worktreeFixture.runtime.taskWorktree.ensureForTask('target');
  await worktreeEntered;
  assert.equal(merge(worktreeRoutes).body.error, 'task_busy');
  finishWorktree({ worktreePath: '/repo/task-target', branch: 'multicc/task-target' });
  await worktreePromise;
  assert.equal(merge(worktreeRoutes).code, 200, 'a target may retain its worktree');
  assert.equal(worktreeFixture.runtime.getBoard().tasks.source.status, 'archived');
});

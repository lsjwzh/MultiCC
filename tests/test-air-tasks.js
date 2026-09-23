'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { airResponse } = require('./helpers/air-response');

test('navigation entry skips history reads while ordinary task details retain the transcript', async t => {
  let historyReads = 0;
  const f = fixture(t, { getHistory: () => { historyReads++; return [{ id: 'huge', role: 'user', content: 'x'.repeat(1024 * 1024) }]; } });
  const sent = await f.runtime.send(f.a.id, { clientMsgId: 'seed', text: 'seed', intent: 'work' });
  const task = f.runtime.listTasks().find(task => task.id === sent.taskId);
  historyReads = 0;
  const lean = await f.runtime.bindPlannedTask(task.id, { includeMessages: false });
  assert.equal(historyReads, 0);
  assert.deepEqual(lean.messages, []);
  const full = await f.runtime.taskEntry(task.id);
  assert.ok(historyReads > 0);
  assert.ok(JSON.stringify(full).length > 1024 * 1024);
  assert.equal(lean.sessionId, full.sessionId);
  assert.equal(lean.readOnly, full.readOnly);
});

test('Air chat-open endpoint returns only authorized session metadata and skips delivery work', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map();
  let readOnly = false;
  const calls = [];
  const record = { id: 'bound', kind: 'chat', dirId: 'd', cli: 'codex', taskBoundTaskId: 't', autoCommit: false,
    memory: 'PRIVATE', rolePrompt: 'PRIVATE', providerSecret: 'PRIVATE' };
  mountAirRoutes({ get: (p, fn) => handlers.set(p, fn), post() {} }, {
    records: new Map([['bound', record], ['source', { id: 'source', kind: 'chat', dirId: 'd' }]]),
    directories: new Map([['d', { path: '/repo' }]]),
    shell: { taskEntry: async (id, options) => { calls.push([id, options]); return { sessionId: 'bound', sourceSessionId: 'source', readOnly }; },
      attributionCandidate() { throw Error('must not inspect delivery when opening'); } },
  });
  const route = handlers.get('/api/air/tasks/:id/open');
  const read = async () => { const res = { headersSent: false, json(value) { this.body = value; } }; await route({ params: { id: 't' } }, res); return res.body; };
  const entry = await read();
  assert.deepEqual(calls, [['t', { includeMessages: false }]]);
  assert.equal(entry.session.id, 'bound');
  assert.equal(entry.session.autoCommit, false);
  // 老记录（没有这个键）也必须读成「关」：Air 的任务开关直接照这个字段渲染，
  // 缺键读成「开」会跟网页 `#auto-commit-btn`（走 session-dto 的 `!!`）打架。
  delete record.autoCommit;
  assert.equal((await read()).session.autoCommit, false, '缺 autoCommit 的旧记录读作关');
  record.autoCommit = false;
  assert.equal(entry.session.cwd, '/repo');
  assert.equal(entry.configuration.cli, 'codex');
  assert.equal(entry.configuration.provider, null);
  assert.ok(!JSON.stringify(entry).includes('PRIVATE'));
  assert.ok(!Object.hasOwn(entry, 'messages'));
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) < 1024);
  readOnly = true;
  assert.equal((await read()).session.id, 'source', 'read-only tasks retain their original conversation');
  readOnly = false; record.taskExecutionSlot = true;
  assert.equal((await read()).session, null, 'execution slots never become ordinary chat entries');
});

function airFixture(t) {
  const f = fixture(t, { getDirectory: id => id === 'd1' ? { id } : null, unifiedAdmission: true });
  f.ports.createExecution = async task => {
    f.creations.push(task.id); f.records.set(task.sessionId, { id: task.sessionId, kind: 'chat', dirId: task.dirId,
      cli: task.runtime.cli, taskBoundTaskId: task.id, workspaceState: 'planned' });
    return { ok: true, baseline: null };
  };
  // Runtime captured the original factory: use its fixture implementation,
  // then annotate the created metadata as production's planned factory does.
  const { createTaskShellRuntime } = require('../src/task-shell/runtime');
  f.runtime = createTaskShellRuntime(f.ports); return f;
}
test('concurrent navigation and detail reads share binding, but keep their own history projection', async t => {
  const f = airFixture(t);
  const created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Task', clientMsgId: 'opening' });
  const task = f.store.get('task', created.taskId);
  task.ready = false; task.bindingPending = true; f.store.set('task', task.id, task);
  f.histories.set(task.sessionId, [{ id: 'm', role: 'user', content: 'Retained history' }]);
  let release, bindings = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.ports.createExecution = async () => { bindings++; await gate; return { ok: true }; };
  const { createTaskShellRuntime } = require('../src/task-shell/runtime');
  const runtime = createTaskShellRuntime(f.ports);
  const lean = runtime.bindPlannedTask(task.id, { includeMessages: false });
  const full = runtime.bindPlannedTask(task.id);
  release();
  const [navigation, detail] = await Promise.all([lean, full]);
  assert.equal(bindings, 1);
  assert.deepEqual(navigation.messages, []);
  assert.ok(detail.messages.some(m => m.content === 'Retained history'));
  assert.equal(navigation.sessionId, detail.sessionId);
});
test('Air creates canonical standalone task metadata and repeated requests return the same task', async t => {
  const f = airFixture(t), input = { dirId: 'd1', title: 'New UI', cli: 'codex', clientMsgId: 'create-1' };
  const [a, b] = await Promise.all([f.runtime.createStandalone(input), f.runtime.createStandalone(input)]);
  assert.deepEqual(a, b); assert.equal(f.creations.length, 1); assert.equal(f.sends.length, 0);
  const entry = await f.runtime.taskEntry(a.taskId); assert.equal(entry.readOnly, false);
  assert.equal(entry.task.title, 'New UI'); assert.equal(f.records.get(a.sessionId).workspaceState, 'planned');
  assert.equal(f.store.get('task', a.taskId).baseline, null);
  await assert.rejects(f.runtime.createStandalone({ ...input, title: 'Changed' }), { code: 'idempotency_conflict' });
});
test('Air tasks accept queued work through the existing canonical receipt protocol', async t => {
  const f = airFixture(t), created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Task', clientMsgId: 'a' });
  const input = { text: 'Implement', taskId: created.taskId, clientMsgId: 'message-1', intent: 'work' };
  const result = await f.runtime.send(created.shellId, input);
  assert.equal(result.taskId, created.taskId); assert.equal(f.sends[0].opts.taskId, created.taskId);
  await f.runtime.send(created.shellId, input); assert.equal(f.sends.length, 1);
});
test('invalid directory/title cannot create tasks or execution records', async t => {
  const f = airFixture(t);
  for (const input of [{ dirId: 'unknown', title: 'X' }, { dirId: 'd1', title: '' }, { dirId: 'd1', title: 'x'.repeat(121) }]) {
    await assert.rejects(f.runtime.createStandalone({ ...input, clientMsgId: 'invalid' }), { code: 'invalid_input' });
  }
  assert.equal(f.creations.length, 0); assert.equal(f.store.list('task').length, 0);
});
test('many Air task records do not start any work and retain separate roles', async t => {
  const f = airFixture(t);
  for (let i = 0; i < 20; i++) await f.runtime.createStandalone({ dirId: 'd1', title: `Task ${i}`, clientMsgId: `a-${i}`, rolePrompt: `Role ${i}` });
  assert.equal(f.store.list('task').length, 20); assert.equal(f.sends.length, 0);
  assert.equal(f.store.list('task')[1].runtime.rolePrompt, 'Role 1');
});
test('online attribution candidates do not create task B or rewrite the original receipt', async t => {
  const f = airFixture(t), created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Source', clientMsgId: 'src' });
  const sent = await f.runtime.send(created.shellId, { text: 'Work', taskId: created.taskId, intent: 'work', clientMsgId: 'm' });
  const { createCandidateStore } = require('../src/task-routing/candidates'), candidates = createCandidateStore(f.store);
  const before = f.runtime.view(created.shellId), original = f.store.get('receipt', sent.receiptId);
  const candidate = candidates.propose(created.sessionId, sent.receiptId, { taskId: 'tsk_new_candidate', taskName: 'New goal', turnId: 'turn1' });
  assert.equal(candidate.pending, true); assert.equal(candidate.candidate.state, 'pending');
  assert.equal(f.store.get('task', 'tsk_new_candidate'), null);
  assert.deepEqual(f.store.get('receipt', sent.receiptId), original);
  assert.equal(f.runtime.view(created.shellId).currentTaskId, before.currentTaskId);
  await f.runtime.send(created.shellId, { text: 'New input', taskId: created.taskId, intent: 'work', clientMsgId: 'm2' });
  assert.equal(candidates.latest(created.taskId).state, 'stale');
});
test('Air list resolves legacy reference directories and never includes provider credentials', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  mountAirRoutes(app, { admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', providerSecret: 'private' }]]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ modules: {}, tasks: { t: { id: 't', chatSessionId: 's', title: 'Legacy', recordType: 'planned', workflowStage: 'inbox', refs: [{ sessionId: 's', dirId: 'd1' }] } } }),
    clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) } });
  const res = airResponse(); await handlers.get('/api/air')({}, res); const response = JSON.parse(res.body);
  assert.equal(response.tasks[0].dirId, 'd1'); assert.equal(response.tasks[0].recordType, 'planned');
  assert.equal(response.tasks[0].workflowStage, 'inbox'); assert.equal(JSON.stringify(response).includes('private'), false);
});

test('Air exposes message time separately from task metadata update time', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  mountAirRoutes(app, { admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat' }]]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ modules: {}, tasks: { t: { id: 't', chatSessionId: 's', title: 'Task',
      createdAt: 100, updatedAt: 900, refs: [
        { sessionId: 's', dirId: 'd1', ts: 300 },
        { sessionId: 's', dirId: 'd1', ts: 500 },
      ] } } }),
    clis: ['codex'], shell: { taskAccess: () => ({ readOnly: false }) } });
  const res = airResponse(); await handlers.get('/api/air')({}, res);
  const [task] = JSON.parse(res.body).tasks;
  assert.equal(task.updatedAt, 900);
  assert.equal(task.lastMessageAt, 500);
});

test('Air reports unique worktree counts per directory for manual task cleanup', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const records = new Map([
    ['s1', { id: 's1', dirId: 'd1', kind: 'chat', worktreePath: '/repo/.multicc-worktrees/a' }],
    ['s2', { id: 's2', dirId: 'd1', kind: 'chat', worktreePath: '/repo/.multicc-worktrees/a' }],
    ['s3', { id: 's3', dirId: 'd1', kind: 'chat', worktreePath: '/repo/.multicc-worktrees/b' }],
  ]);
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records,
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ modules: {}, tasks: {
      t1: { id: 't1', chatSessionId: 's1', refs: [{ sessionId: 's1', dirId: 'd1' }] },
      t2: { id: 't2', dirId: 'd1', worktreePath: '/repo/.multicc-worktrees/c', refs: [] },
    } }),
    clis: ['codex'],
    shell: { taskAccess: () => ({ readOnly: false }), listTasks: () => [] },
  });
  const res = airResponse();
  await handlers.get('/api/air')({}, res);
  assert.equal(JSON.parse(res.body).directories[0].worktreeCount, 3,
    'duplicate record paths count once; detached task worktrees still count');
});

test('Air lists and pins hide unseparated tasks across decisions and restarts, then show the same identity after separation', async t => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const { createTaskShellRuntime } = require('../src/task-shell/runtime');
  const path = require('node:path');
  const { createAirPinRuntime } = require('../src/workspace/pins');
  for (const decision of ['pending', 'defer', 'keep']) await t.test(decision, async t => {
    const board = { tasks: {} };
    const f = fixture(t, {
      getDirectory: id => id === 'd1' ? { id } : null,
      // Like the persisted board, this index has no embedded/ready fields.
      indexTask: task => {
        board.tasks[task.id] = { id: task.id, title: task.title, chatSessionId: task.sessionId,
          refs: [{ sessionId: task.sessionId, dirId: task.dirId }] };
        return { ok: true };
      },
    });
    const source = await f.runtime.createStandalone({ dirId: 'd1', title: 'Source', clientMsgId: 'source' });
    f.histories.set(source.sessionId, [{ id: 'u0', role: 'user', content: 'Old goal', taskId: source.taskId }]);
    const sent = await f.runtime.send(source.shellId, { text: 'New goal', clientMsgId: 'new-goal' });
    f.histories.get(source.sessionId).push(
      { id: 'u1', role: 'user', content: 'New goal', turnId: 'turn-1', clientMsgId: sent.receiptId },
      { id: 'a1', role: 'assistant', content: 'Result', turnId: 'turn-1' });
    f.statuses.set(source.sessionId, { busy: false });
    const suggestion = f.runtime.separation.propose(source.sessionId, sent.receiptId, {
      turnId: 'turn-1', anchorMessageId: 'a1', separation: { title: 'New goal' },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(board.tasks[suggestion.taskId], 'already indexed tasks must also be hidden');
    if (decision !== 'pending') await f.runtime.separation.decide(source.sessionId, suggestion.id, decision);
    f.runtime = createTaskShellRuntime(f.ports);
    const pinsFile = path.join(path.dirname(f.file), 'air-pins.json');
    createAirPinRuntime({ file: pinsFile, listTaskIds: () => Object.keys(board.tasks) })
      .replace([source.taskId, suggestion.taskId]);
    const handlers = new Map();
    mountAirRoutes({ get: (url, fn) => handlers.set(url, fn), post: (url, fn) => handlers.set(`POST ${url}`, fn) }, {
      pinsFile, getBoard: () => board, records: f.records,
      directories: new Map([['d1', { id: 'd1', path: '/repo' }]]), clis: ['codex'],
      admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
      shell: { listTasks: () => f.runtime.listTasks(), taskAccess: task => f.runtime.taskAccess(task),
        migrateTaskSessions: () => f.runtime.migrateTaskSessions([]) },
    });
    const before = airResponse();
    await handlers.get('/api/air')({}, before);
    assert.deepEqual(JSON.parse(before.body).tasks.map(task => task.id), [source.taskId]);
    assert.deepEqual(JSON.parse(before.body).taskPins, [source.taskId]);
    const pins = airResponse(); handlers.get('/api/air/pins')({}, pins);
    assert.deepEqual(JSON.parse(pins.body).taskIds, [source.taskId]);
    const toggle = airResponse();
    handlers.get('POST /api/air/pins/toggle')({ body: { taskId: suggestion.taskId } }, toggle);
    assert.equal(toggle.statusCode, 404);
    assert.ok(f.store.get('task', suggestion.taskId), 'filtering must preserve conversation identity');
    assert.ok(f.store.get('link', `${source.shellId}:${suggestion.taskId}`));

    const separated = await f.runtime.separation.decide(source.sessionId, suggestion.id, 'separate');
    assert.equal(separated.taskId, suggestion.taskId);
    const after = airResponse();
    await handlers.get('/api/air')({ headers: { 'if-none-match': before.headers.etag } }, after);
    assert.equal(after.statusCode, 200, 'separation invalidates the list ETag');
    assert.deepEqual(JSON.parse(after.body).tasks.map(task => task.id), [source.taskId, suggestion.taskId]);
    assert.deepEqual(JSON.parse(after.body).taskPins, [source.taskId, suggestion.taskId]);
  });
});

test('Air hides incomplete separation but keeps idle, planned and legacy standalone tasks', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const tasks = [
    { id: 'partial', separatedFromTaskId: 'source', embedded: false, ready: false },
    { id: 'idle', ready: true }, { id: 'planned', ready: false },
    { id: 'separated', separatedFromTaskId: 'source', embedded: false, ready: true },
  ];
  const board = { tasks: Object.fromEntries([...tasks, { id: 'legacy' }].map(task => [task.id, { id: task.id }])) };
  const handlers = new Map();
  mountAirRoutes({ get: (url, fn) => handlers.set(url, fn), post() {} }, {
    records: new Map(), directories: new Map(), getBoard: () => board, clis: [],
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    shell: { listTasks: () => tasks, taskAccess: () => ({ readOnly: false }) },
  });
  const res = airResponse(); await handlers.get('/api/air')({}, res);
  assert.deepEqual(JSON.parse(res.body).tasks.map(task => task.id), ['idle', 'planned', 'separated', 'legacy']);
});

test('Air snapshot projects a never-admitted dispatch claim as idle, not 执行中', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const stale = Date.now() - 10 * 60 * 1000;
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([
      // 会话记录在，但从头到尾没有任何 taskState：这一轮连受理都没发生过。
      ['ghost', { id: 'ghost', dirId: 'd1', kind: 'chat' }],
      // 会话有调度状态：卡片自报什么就是什么。
      ['live', { id: 'live', dirId: 'd1', kind: 'chat', taskState: { queueState: 'running' } }],
    ]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ modules: {}, tasks: {
      g: { id: 'g', title: '新任务', status: 'active', runState: 'running', runStateAt: stale, updatedAt: stale,
        refs: [{ sessionId: 'ghost', dirId: 'd1' }] },
      l: { id: 'l', title: '真在跑', status: 'active', runState: 'running', runStateAt: stale, updatedAt: stale,
        refs: [{ sessionId: 'live', dirId: 'd1' }] },
    } }),
    clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) } });
  const res = airResponse(); await handlers.get('/api/air')({}, res); const response = JSON.parse(res.body);
  const byId = Object.fromEntries(response.tasks.map(task => [task.id, task.runState]));
  assert.equal(byId.g, 'idle', '派发时的乐观值 + 会话从没受理过 → 空闲，不是执行中');
  assert.equal(byId.l, 'running', '会话有调度状态时不越权改判');
});

test('Air snapshot carries the most recently worked chat runtime as lastRuntime', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  mountAirRoutes(app, { admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([
      // 老一些的 chat 会话：更近的那份赢了它才不该出现。
      ['older', { id: 'older', dirId: 'd1', kind: 'chat', cli: 'claude', provider: 'p-old',
        model: 'sonnet', lastWorkAt: '2026-09-13T00:00:00.000Z', providerSecret: 'private' }],
      // terminal 镜像会话 lastWorkAt 最新，但它的 cli 是进程归属不是用户挑的路由。
      ['term', { id: 'term', dirId: 'd1', kind: 'terminal', type: 'aux', cli: 'qoder', lastWorkAt: '2026-09-15T12:00:00.000Z' }],
      ['newer', { id: 'newer', dirId: 'd1', kind: 'chat', cli: 'codex', provider: 'p-new',
        model: 'gpt-5.6', effort: 'high', lastWorkAt: '2026-09-14T00:00:00.000Z', providerSecret: 'private' }],
    ]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ tasks: {} }), clis: ['claude', 'codex'],
    shell: { taskAccess: () => ({ readOnly: true }) },
    providerName: record => record.provider === 'p-new' ? 'New Relay' : null });
  const res = airResponse(); await handlers.get('/api/air')({}, res); const response = JSON.parse(res.body);
  assert.deepEqual(response.lastRuntime, { cli: 'codex', provider: 'p-new', providerName: 'New Relay',
    providerSelection: null, model: 'gpt-5.6', effort: 'high', subagent: null });
  assert.equal(JSON.stringify(response).includes('private'), false);
});

test('Air snapshot leaves lastRuntime null when no chat session has a cli', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  mountAirRoutes(app, { admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map([['s', { id: 's', dirId: 'd1', kind: 'chat', providerSecret: 'private' }]]),
    directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => ({ tasks: {} }), clis: ['codex'], shell: { taskAccess: () => ({ readOnly: true }) } });
  const res = airResponse(); await handlers.get('/api/air')({}, res); const response = JSON.parse(res.body);
  assert.equal(response.lastRuntime, null);
});

test('Air task entry exposes provider routing metadata without credentials', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const record = { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex', provider: 'provider-a',
    providerSecret: 'must-not-leak', model: 'gpt-alias', effort: 'high',
    subagent: { providerId: 'provider-b', model: 'gpt-b' },
    providerSelection: { version: 1, mode: 'auto', protocol: 'openai_responses', candidates: [
      { providerId: 'provider-a', model: 'gpt-a', priority: 1, enabled: true },
      { providerId: 'provider-b', model: 'gpt-b', priority: 2, enabled: true },
    ], maxAttempts: 2, sticky: true, allowCrossTrust: false } };
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }),
      deliveryEvidence: () => ({ run: null, integration: null }) },
    records: new Map([['s', record]]), directories: new Map([['d1', { id: 'd1', path: '/repo' }]]),
    shell: { taskEntry: async () => ({ ok: true, task: { id: 't', title: 'Task' }, sessionId: 's' }),
      attributionCandidate: () => null, roleBindings: () => ({ version: 0, bindings: [] }) },
    getBoard: () => ({ tasks: {} }), clis: ['codex'], providerName: () => 'Provider A',
    effectiveModel: () => 'gpt-a', effectiveEffort: () => 'high',
    serializeSubagent: sa => (sa ? { providerId: sa.providerId, model: sa.model, effectiveModel: 'gpt-b' } : null),
  });
  const res = airResponse();
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' } }, res);
  const response = JSON.parse(res.body);
  assert.deepEqual(response.configuration, {
    pendingConfiguration: null,
    cli: 'codex', model: 'gpt-alias', effectiveModel: 'gpt-a', effort: 'high', effectiveEffort: 'high',
    provider: 'provider-a', providerName: 'Provider A', providerSelection: record.providerSelection,
    // The task AI config panel reads the live sub-task route back, so a saved
    // tail survives reopening the dialog.
    subagent: { providerId: 'provider-b', model: 'gpt-b', effectiveModel: 'gpt-b' },
  });
  // JSON 线路上没有 undefined 这个值：没设过角色预设就是没有这个键。
  assert.equal('rolePresetId' in response.configuration, false);
  assert.equal(JSON.stringify(response).includes('must-not-leak'), false);
});

test('Air task entry resolves the pending route provider name instead of leaking the id', async () => {
  const { mountAirRoutes } = require('../src/workspace/air-routes');
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  // 待生效的那份配置存的是 id：它是给人看的胶囊文字，必须由服务端换成名字。
  const profile = { provider: 'provider-b', providerSelection: null, model: 'gpt-b', effort: 'low',
    agent: null, subagent: null, rolePrompt: null };
  const record = { id: 's', dirId: 'd1', kind: 'chat', cli: 'codex', provider: 'provider-a', model: 'gpt-a',
    effectiveModel: 'gpt-a', pendingConfiguration: { cli: 'codex', fresh: false, profile,
      updatedAt: '2026-09-18T00:00:00.000Z' } };
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }),
      deliveryEvidence: () => ({ run: null, integration: null }) },
    records: new Map([['s', record]]), directories: new Map([['d1', { id: 'd1', path: '/repo' }]]),
    shell: { taskEntry: async () => ({ ok: true, task: { id: 't', title: 'Task' }, sessionId: 's' }),
      attributionCandidate: () => null, roleBindings: () => ({ version: 0, bindings: [] }) },
    getBoard: () => ({ tasks: {} }), clis: ['codex'],
    providerName: session => session.provider === 'provider-b' ? 'Backup Relay'
      : (session.provider === 'provider-a' ? 'Main Relay' : null),
    effectiveModel: () => 'gpt-a', effectiveEffort: () => 'low',
  });
  const res = airResponse();
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' } }, res);
  const response = JSON.parse(res.body);
  assert.equal(response.configuration.providerName, 'Main Relay');
  assert.equal(response.configuration.pendingConfiguration.providerName, 'Backup Relay');
  // 只读的展示名落在 pending 上，不进 profile：应用这份配置时 profile 会被整体
  // assign 进会话记录，写进去就成了永远不会再更新的陈旧副本。
  assert.deepEqual(response.configuration.pendingConfiguration.profile, profile);
  assert.equal('providerName' in profile, false);
});

test('a task pinned at creation keeps its sub-agent route in the runtime', async t => {
  const f = airFixture(t);
  const created = await f.runtime.createStandalone({ dirId: 'd1', title: 'Routed', clientMsgId: 'route-1',
    cli: 'claude', subagent: { providerId: 'relay-b', model: 'glm-4.7' } });
  const task = f.store.get('task', created.taskId);
  // The tail rides the same runtime object as cli/provider/model, so the task's
  // first run spawns with it instead of only being editable afterwards.
  assert.deepEqual(task.runtime.subagent, { providerId: 'relay-b', model: 'glm-4.7' });
  assert.equal(task.runtime.cli, 'claude');
  // Same request replayed: one task, one runtime, no duplicate creation.
  await f.runtime.createStandalone({ dirId: 'd1', title: 'Routed', clientMsgId: 'route-1',
    cli: 'claude', subagent: { providerId: 'relay-b', model: 'glm-4.7' } });
  assert.equal(f.creations.length, 1);
  // A different tail is a different task request, not a silent overwrite.
  await assert.rejects(f.runtime.createStandalone({ dirId: 'd1', title: 'Routed', clientMsgId: 'route-1',
    cli: 'claude', subagent: { providerId: 'relay-a', model: 'glm-5.2' } }), { code: 'idempotency_conflict' });
});

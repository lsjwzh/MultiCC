'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
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
  let response; await handlers.get('/api/air')({}, { json: v => { response = v; }, status() { return this; } });
  assert.equal(response.tasks[0].dirId, 'd1'); assert.equal(response.tasks[0].recordType, 'planned');
  assert.equal(response.tasks[0].workflowStage, 'inbox'); assert.equal(JSON.stringify(response).includes('private'), false);
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
  let response; await handlers.get('/api/air')({}, { json: v => { response = v; }, status() { return this; } });
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
  let response; await handlers.get('/api/air')({}, { json: v => { response = v; }, status() { return this; } });
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
  let response; await handlers.get('/api/air')({}, { json: v => { response = v; }, status() { return this; } });
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
  let response;
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' } }, {
    json: value => { response = value; }, status() { return this; },
  });
  assert.deepEqual(response.configuration, {
    pendingConfiguration: null,
    cli: 'codex', model: 'gpt-alias', effectiveModel: 'gpt-a', effort: 'high', effectiveEffort: 'high',
    provider: 'provider-a', providerName: 'Provider A', providerSelection: record.providerSelection,
    // The task AI config panel reads the live sub-task route back, so a saved
    // tail survives reopening the dialog.
    subagent: { providerId: 'provider-b', model: 'gpt-b', effectiveModel: 'gpt-b' },
    rolePresetId: undefined,
  });
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
  let response;
  await handlers.get('/api/air/tasks/:id')({ params: { id: 't' } }, {
    json: value => { response = value; }, status() { return this; },
  });
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

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mountSessionCreateRoutes } = require('../src/routes/session-create');

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, post: register('POST'), put: register('PUT') };
}

async function invoke(handler, { params = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  await handler({ params, body }, res);
  return response;
}

function fixture() {
  const dir = { id: 'fleet-1' };
  const preset = { id: 'testing__testing-engineer', name: '测试工程师', prompt: 'quality' };
  const ensured = [];
  const creates = [];
  let reused = false;
  const app = fakeApp();
  mountSessionCreateRoutes(app, {
    directories: new Map([[dir.id, dir]]),
    asyncHandler: handler => handler,
    getAgentPreset: id => id === preset.id ? preset : null,
    async ensureRoleWorker(input) {
      ensured.push(input);
      const result = {
        ok: true,
        reused,
        session: {
          id: 'qa-1',
          dirId: dir.id,
          label: '测试工程师',
          kind: 'chat',
          type: 'worker',
          rolePrompt: preset.prompt,
        },
      };
      reused = true;
      return result;
    },
    async createSessionRecord(input) {
      creates.push(input);
      return { ok: true, session: { id: 'legacy-create', ...input } };
    },
  });
  return { app, ensured, creates };
}

test('retired role-worker route never creates or refreshes a fixed role session', async () => {
  const current = fixture();
  const handler = current.app.routes.get('PUT /api/directories/:id/role-workers/:presetId');
  for (const params of [{ id: 'fleet-1', presetId: 'testing__testing-engineer' }, { id: 'missing', presetId: 'missing' }]) {
    const response = await invoke(handler, { params });
    assert.equal(response.statusCode, 410);
    assert.equal(response.body.code, 'role_sessions_retired');
    assert.equal(response.body.url, '/air');
  }
  assert.equal(current.ensured.length, 0);
  assert.equal(current.creates.length, 0);
});

test('legacy session create contract remains unchanged', async () => {
  const current = fixture();
  const handler = current.app.routes.get('POST /api/directories/:id/sessions');
  const response = await invoke(handler, {
    params: { id: 'fleet-1' },
    body: {
      cli: ' codex ',
      kind: ' chat ',
      label: ' Existing role ',
      rolePrompt: ' prompt ',
      provider: '',
      effort: 'high',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(current.creates.length, 1);
  assert.deepEqual(current.creates[0], {
    dir: { id: 'fleet-1' },
    cli: 'codex',
    kind: 'chat',
    label: 'Existing role',
    model: null,
    provider: '',
    effort: 'high',
    agent: null,
    rolePrompt: 'prompt',
    experimentalMode: null,
    persistence: 'required',
    persistenceSource: 'http.create-session',
  });
});

test('session create forwards the isolated experimental mode marker', async () => {
  const current = fixture();
  const handler = current.app.routes.get('POST /api/directories/:id/sessions');
  const response = await invoke(handler, {
    params: { id: 'fleet-1' },
    body: {
      cli: 'codex',
      kind: 'chat',
      label: 'TUI mirror',
      experimentalMode: 'tui-chat-mirror',
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(current.creates[0].experimentalMode, 'tui-chat-mirror');
});

test('legacy chat creation adapts to a task and never creates a role workspace', async () => {
  const app = fakeApp(), tasks = [], executions = [];
  mountSessionCreateRoutes(app, {
    directories: new Map([['d', { id: 'd' }]]), asyncHandler: fn => fn,
    createSessionRecord: input => { executions.push(input); throw new Error('unexpected materialization'); },
    createTask: async input => { tasks.push(input); return { taskId: 'task-a', sessionId: 'execution-a', url: '/air?task=task-a' }; },
    getRecord: id => ({ id, taskBoundTaskId: 'task-a', workspaceState: 'planned' }),
  });
  const result = await invoke(app.routes.get('POST /api/directories/:id/sessions'), {
    params: { id: 'd' }, body: { kind: 'chat', cli: 'codex', label: 'Deliver report', rolePrompt: 'Research role', clientMsgId: 'm1' },
  });
  assert.equal(result.statusCode, 200); assert.equal(result.body.taskId, 'task-a');
  assert.equal(result.body.workspaceState, 'planned'); assert.equal(tasks[0].rolePrompt, 'Research role');
  assert.equal(tasks[0].title, 'Deliver report'); assert.equal(tasks[0].clientMsgId, 'm1');
  assert.equal(executions.length, 0);
});

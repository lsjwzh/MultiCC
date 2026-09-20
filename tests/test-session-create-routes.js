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
    sessions: new Map(),
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
    sessions: new Map(),
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

test('vendor login terminal: unknown session and non-vendor cli are rejected', async () => {
  const sessions = new Map([
    ['chat-1', { id: 'chat-1', dirId: 'fleet-1', cli: 'claude', kind: 'chat' }],
  ]);
  const app = fakeApp();
  const creates = [];
  mountSessionCreateRoutes(app, {
    directories: new Map([['fleet-1', { id: 'fleet-1' }]]),
    sessions,
    asyncHandler: fn => fn,
    createSessionRecord: async input => { creates.push(input); return { ok: true, session: { id: 't-new', ...input, dir: undefined } }; },
  });
  const handler = app.routes.get('POST /api/sessions/:id/vendor-login-terminal');

  const missing = await invoke(handler, { params: { id: 'nope' } });
  assert.equal(missing.statusCode, 404);

  const nonVendor = await invoke(handler, { params: { id: 'chat-1' } });
  assert.equal(nonVendor.statusCode, 400);
  assert.match(nonVendor.body.error, /does not use vendor terminal login/);
  assert.equal(creates.length, 0);
});

test('vendor login terminal: creates a whitelisted loginFlow terminal once, then reuses it', async () => {
  const dir = { id: 'fleet-1' };
  const sessions = new Map([
    ['wb-chat', { id: 'wb-chat', dirId: dir.id, cli: 'codebuddy', kind: 'chat' }],
  ]);
  const app = fakeApp();
  const creates = [];
  mountSessionCreateRoutes(app, {
    directories: new Map([[dir.id, dir]]),
    sessions,
    asyncHandler: fn => fn,
    async createSessionRecord(input) {
      creates.push(input);
      const session = {
        id: 'wb-login-1', dirId: dir.id, cli: input.cli, kind: input.kind,
        label: input.label, loginFlow: input.loginFlow,
      };
      sessions.set(session.id, session);
      return { ok: true, session };
    },
  });
  const handler = app.routes.get('POST /api/sessions/:id/vendor-login-terminal');

  const created = await invoke(handler, { params: { id: 'wb-chat' } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.id, 'wb-login-1');
  assert.equal(created.body.url, '/?id=wb-login-1');
  assert.equal(created.body.reused, undefined);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].kind, 'terminal');
  assert.equal(creates[0].cli, 'codebuddy');
  assert.equal(creates[0].loginFlow, 'codebuddy-login');
  assert.equal(creates[0].persistence, 'required');
  assert.match(creates[0].label, /WorkBuddy/);

  const again = await invoke(handler, { params: { id: 'wb-chat' } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.id, 'wb-login-1');
  assert.equal(again.body.reused, true);
  assert.equal(creates.length, 1);
});

test('vendor login terminal: qoder maps to qoder-login', async () => {
  const dir = { id: 'fleet-1' };
  const sessions = new Map([
    ['q-chat', { id: 'q-chat', dirId: dir.id, cli: 'qoder', kind: 'chat' }],
  ]);
  const app = fakeApp();
  const creates = [];
  mountSessionCreateRoutes(app, {
    directories: new Map([[dir.id, dir]]),
    sessions,
    asyncHandler: fn => fn,
    async createSessionRecord(input) {
      creates.push(input);
      return { ok: true, session: { id: 'q-login-1', dirId: dir.id, ...input } };
    },
  });
  const response = await invoke(app.routes.get('POST /api/sessions/:id/vendor-login-terminal'), {
    params: { id: 'q-chat' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(creates[0].loginFlow, 'qoder-login');
});

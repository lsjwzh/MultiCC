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

test('idempotent role-worker route creates then reuses the same persistent worker', async () => {
  const current = fixture();
  const handler = current.app.routes.get('PUT /api/directories/:id/role-workers/:presetId');
  const request = {
    params: { id: 'fleet-1', presetId: 'testing__testing-engineer' },
    body: {},
  };
  const created = await invoke(handler, request);
  const reused = await invoke(handler, request);

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.id, 'qa-1');
  assert.equal(created.body.kind, 'chat');
  assert.equal(created.body.type, 'worker');
  assert.equal(created.body.reused, false);
  assert.equal(reused.statusCode, 200);
  assert.equal(reused.body.id, 'qa-1');
  assert.equal(reused.body.reused, true);
  assert.equal(current.ensured.length, 2);
});

test('role-worker route fails closed for unknown fleet and preset', async () => {
  const current = fixture();
  const handler = current.app.routes.get('PUT /api/directories/:id/role-workers/:presetId');
  const missingFleet = await invoke(handler, {
    params: { id: 'missing', presetId: 'testing__testing-engineer' },
  });
  assert.equal(missingFleet.statusCode, 404);
  assert.equal(missingFleet.body.error, 'directory not found');

  const missingPreset = await invoke(handler, {
    params: { id: 'fleet-1', presetId: 'missing' },
  });
  assert.equal(missingPreset.statusCode, 404);
  assert.equal(missingPreset.body.error, 'agent preset not found');
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
    persistence: 'required',
    persistenceSource: 'http.create-session',
  });
});


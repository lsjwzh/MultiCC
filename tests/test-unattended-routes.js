'use strict';

// GET/POST /api/sessions/:id/unattended (docs/unattended-mode.md §API).
// The supervisor host is a fake: these tests pin the HTTP surface, the error
// envelope and the aux/gateway refusal.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountUnattendedRoutes } = require('../src/unattended/routes');

function createApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return { routes, get: register('GET'), post: register('POST') };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, req = {}) {
  const res = response();
  await handler({ params: { id: 's1' }, body: {}, ...req }, res);
  return { status: res.statusCode, body: res.body };
}

const LIMITS = { maxDurationMinutesDefault: 120, maxDurationMinutesMin: 5, maxDurationMinutesMax: 1440 };
const STATE = { status: 'active', goal: 'ship it', rounds: 1, maxDurationMinutes: 60, startedAt: 10, deadlineAt: 3600010 };

function fixture({ host = true, records } = {}) {
  const app = createApp();
  const store = records || new Map([
    ['s1', { id: 's1', type: null }],
    ['aux1', { id: 'aux1', type: 'aux' }],
    ['gw1', { id: 'gw1', type: 'gateway' }],
  ]);
  const calls = [];
  const fakeHost = {
    get: id => (id === 's1' ? STATE : null),
    // v2 start/resume are async (they check streaming/queued before evaluating);
    // the route must await them.
    start: async (id, body) => { calls.push(['start', id, body]); return { ok: true, unattended: { status: 'active' } }; },
    update: (id, body) => { calls.push(['update', id, body]); return { ok: false, code: 'no_unattended', status: 409 }; },
    stop: id => { calls.push(['stop', id]); return { ok: true, unattended: { status: 'stopped' } }; },
    resume: async (id, body) => { calls.push(['resume', id, body]); return { ok: false, code: 'invalid_state', status: 409 }; },
  };
  mountUnattendedRoutes(app, { records: store, getUnattended: () => (host ? fakeHost : null) });
  return { app, calls, store };
}

test('GET returns the state and the duration limits, or null when never armed', async () => {
  const { app } = fixture();
  const armed = await invoke(app.routes.get('GET /api/sessions/:id/unattended'));
  assert.equal(armed.status, 200);
  assert.deepEqual(armed.body.unattended, STATE);
  assert.deepEqual(armed.body.limits, LIMITS);

  const idle = await invoke(app.routes.get('GET /api/sessions/:id/unattended'), { params: { id: 'aux1' } });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.unattended, null);
});

test('GET 404s an unknown session and 501s without a supervisor host', async () => {
  const { app } = fixture();
  const missing = await invoke(app.routes.get('GET /api/sessions/:id/unattended'), { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { ok: false, error: 'session_not_found' });

  const unavailable = await invoke(fixture({ host: false }).app.routes.get('GET /api/sessions/:id/unattended'));
  assert.equal(unavailable.status, 501);
  assert.deepEqual(unavailable.body, { ok: false, error: 'unattended_unavailable' });
});

test('POST dispatches start, update, stop and resume', async () => {
  const { app, calls } = fixture();
  const handler = app.routes.get('POST /api/sessions/:id/unattended');
  const started = await invoke(handler, { body: { action: 'start', goal: 'ship it', maxDurationMinutes: 60 } });
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.unattended.status, 'active');

  const updated = await invoke(handler, { body: { action: 'update', goal: 'new goal' } });
  assert.equal(updated.status, 409, 'host failures keep their status');
  assert.deepEqual(updated.body, { ok: false, error: 'no_unattended', unattended: null, limits: LIMITS });

  assert.equal((await invoke(handler, { body: { action: 'stop' } })).status, 200);
  assert.equal((await invoke(handler, { body: { action: 'resume', maxDurationMinutes: 30 } })).status, 409);
  assert.deepEqual(calls.map(call => call[0]), ['start', 'update', 'stop', 'resume']);
  assert.equal(calls[3][2].maxDurationMinutes, 30, 'resume forwards the new duration');
  // Legacy round fields ride along but are the host's host-to-ignore concern.
  await invoke(handler, { body: { action: 'start', goal: 'ship it', maxRounds: 5 } });
  assert.equal(calls[4][2].maxRounds, 5);
});

test('POST rejects a bad action, an aux/gateway session and an unknown session', async () => {
  const { app } = fixture();
  const handler = app.routes.get('POST /api/sessions/:id/unattended');
  const bad = await invoke(handler, { body: { action: 'dance' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_action');
  assert.equal(bad.body.unattended.status, 'active', 'the current state is echoed back');

  for (const id of ['aux1', 'gw1']) {
    const refused = await invoke(handler, { params: { id }, body: { action: 'start', goal: 'x' } });
    assert.equal(refused.status, 400, id);
    assert.equal(refused.body.error, 'not_a_chat_session');
  }

  const missing = await invoke(handler, { params: { id: 'nope' }, body: { action: 'start', goal: 'x' } });
  assert.equal(missing.status, 404);
});

test('POST 501s without a supervisor host', async () => {
  const { app } = fixture({ host: false });
  const result = await invoke(app.routes.get('POST /api/sessions/:id/unattended'),
    { body: { action: 'start', goal: 'x' } });
  assert.equal(result.status, 501);
  assert.deepEqual(result.body, { ok: false, error: 'unattended_unavailable' });
});

test('mounting without an app or records map fails loudly', () => {
  assert.throws(() => mountUnattendedRoutes(null, {}), /Express app is required/);
  assert.throws(() => mountUnattendedRoutes(createApp(), {}), /records map is required/);
});

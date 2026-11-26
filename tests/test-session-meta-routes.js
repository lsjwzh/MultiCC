'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const frozen = require('./helpers/legacy-session-routes/session-meta');
const current = require('../src/routes/session-routes-host');

function mount(api, override = {}) {
  let notes = [];
  const events = [];
  const sessions = new Map(['a', 'b'].map(id => [id, { id, dirId: 'd' }]));
  const deps = {
    persistedSessions: sessions,
    asyncHandler: handler => handler,
    getNotes: () => notes,
    saveNotes: () => events.push('save'),
    pendingNotesFor: id => notes.filter(note => note.toSessionId === id && !note.delivered),
    appendEvent: (...args) => events.push(args),
    workspaceBroadcast: (...args) => events.push(args),
    getLivenessRuntime: () => ({ assess: async (id, options) => ({ id, ...options }) }),
    ...override,
  };
  const routes = new Map();
  api.createSessionMetaRuntime(deps).mountRoutes({
    get: (path, handler) => routes.set('GET ' + path, handler),
    post: (path, handler) => routes.set('POST ' + path, handler),
  });
  return {
    notes: () => notes, replace(value) { notes = value; }, events, sessions,
    post: routes.get('POST /api/sessions/:id/notes'),
    list: routes.get('GET /api/sessions/:id/notes'),
    assess: routes.get('GET /api/sessions/:id/liveness'),
  };
}

function response() {
  return {
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

for (const [name, api] of Object.entries({ frozen, current })) {
  test(name + ' note writes retain UTF-16 slicing, object identity and effect order', () => {
    const world = mount(api);
    const req = { params: { id: 'a' }, body: { toSessionId: ' b ', body: '  ' + 'x'.repeat(3999) + '😀  ' } };
    const res = response();
    assert.equal(world.post(req, res), undefined);
    const [note] = world.notes();
    assert.equal(note, res.body);
    assert.equal(note.body.length, 4000);
    assert.equal(note.body.charCodeAt(3999), 0xd83d);
    assert.match(note.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(note.ts));
    assert.deepEqual(world.events, ['save', ['d', 'note', '→ b', 'a'],
      ['d', { type: 'note_pending', sessionId: 'b', count: 1 }]]);
    const incoming = { toSessionId: 'a' };
    const unrelated = { toSessionId: 'z', fromSessionId: 'b' };
    world.replace([incoming, , unrelated, note]);
    assert.equal(world.list(req, res), undefined);
    assert.deepEqual(res.body, [incoming, note]);
    assert.equal(res.body[0], incoming);
  });

  test(name + ' note failures preserve the original exception and stop subsequent effects', () => {
    const sentinel = new Error('save failed');
    const world = mount(api, { saveNotes() { throw sentinel; } });
    const req = { params: { id: 'a' }, body: { toSessionId: 'b', body: 'one' } };
    assert.throws(() => world.post(req, response()), err => err === sentinel);
    assert.equal(world.notes().length, 1);
    assert.deepEqual(world.events, []);
    req.body.toSessionId = 42;
    assert.throws(() => world.post(req, response()), TypeError);
    assert.equal(world.notes().length, 1);
  });

  test(name + ' liveness looks up the runtime per request and preserves promise rejection', async () => {
    const results = [];
    const failure = new Error('probe failed');
    const world = mount(api, { getLivenessRuntime: () => ({
      assess(id, { probe }) {
        results.push([id, probe]);
        return results.length === 2 ? Promise.reject(failure) : Promise.resolve('idle');
      },
    }) });
    const req = { params: { id: 'a' }, query: { probe: '0' } };
    const res = response();
    assert.equal(await world.assess(req, res), undefined);
    assert.equal(res.body, 'idle');
    req.query.probe = 0;
    await assert.rejects(world.assess(req, res), err => err === failure);
    world.sessions.clear();
    assert.equal(await world.assess(req, res), res);
    assert.equal(res.code, 404);
    assert.deepEqual(results, [['a', false], ['a', true]]);
  });

  test(name + ' validates missing ports at composition time', () => {
    assert.throws(() => api.createSessionMetaRuntime(), { name: 'TypeError', message: '[session-meta] persistedSessions map is required' });
    assert.throws(() => mount(api, { getNotes: null }), { name: 'TypeError', message: '[session-meta] getNotes must be a function' });
  });
}

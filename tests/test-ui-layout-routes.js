'use strict';

// The user's drag-and-drop arrangement is durable and shared across devices.
// These tests pin the two properties that make that true: what a client sends
// is normalized before it is stored, and what no longer exists is pruned rather
// than accumulating in the file forever.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createUiLayoutRuntime } = require('../src/directory/ui-layout');
const core = require('../src/ui-layout');

function createFakeApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => {
    const key = `${method} ${routePath}`;
    assert.equal(routes.has(key), false, `route registered only once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), put: register('PUT') };
}

function invoke(handler, { params = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler({ params, body }, res);
  return response;
}

// The runtime takes ports, not Maps, so the directory module can back it with
// its own repo/sessions adapters. These fakes stand in for those.
function makeDeps({ file, directories, persistedSessions }) {
  return {
    file,
    listDirIds: () => directories.keys(),
    listSessionIds: dirId => [...persistedSessions.values()].filter(s => s.dirId === dirId).map(s => s.id),
  };
}

function createFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ui-layout-'));
  const file = path.join(dir, 'ui-layout.json');
  const directories = overrides.directories || new Map([
    ['d1', { id: 'd1' }],
    ['d2', { id: 'd2' }],
  ]);
  const persistedSessions = overrides.persistedSessions || new Map([
    ['s1', { id: 's1', dirId: 'd1' }],
    ['s2', { id: 's2', dirId: 'd1' }],
    ['s3', { id: 's3', dirId: 'd2' }],
  ]);
  const warnings = [];
  const runtime = createUiLayoutRuntime({
    file,
    listDirIds: () => directories.keys(),
    listSessionIds: dirId => [...persistedSessions.values()].filter(s => s.dirId === dirId).map(s => s.id),
    logger: { warn: m => warnings.push(m) },
    now: () => '2026-08-08T00:00:00.000Z',
  });
  const app = createFakeApp();
  runtime.mountRoutes(app);
  return { dir, file, directories, persistedSessions, runtime, app, warnings };
}

test('an install with no layout file serves an empty document', () => {
  const { app } = createFixture();
  const r = invoke(app.routes.get('GET /api/ui-layout'));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.layout.dirOrder, []);
  assert.deepEqual(r.body.layout.sessionOrder, {});
});

test('a directory order survives a fresh runtime — this is the whole point', () => {
  const { file, directories, persistedSessions, app } = createFixture();
  invoke(app.routes.get('PUT /api/ui-layout/dir-order'), { body: { order: ['d2', 'd1'] } });

  // A second browser, or the same one after a restart: new runtime, same file.
  const reopened = createUiLayoutRuntime(makeDeps({ file, directories, persistedSessions }));
  assert.deepEqual(reopened.readLayout().dirOrder, ['d2', 'd1']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).data.dirOrder.length, 2);
});

test('session order is scoped per directory and rejects an unknown fleet', () => {
  const { app } = createFixture();
  const ok = invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'd1' }, body: { order: ['s2', 's1'] },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.layout.sessionOrder, { d1: ['s2', 's1'] });

  const missing = invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'nope' }, body: { order: ['s1'] },
  });
  assert.equal(missing.statusCode, 404);
});

test('a session from another fleet cannot be smuggled into this one', () => {
  const { app } = createFixture();
  const r = invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'd1' }, body: { order: ['s3', 's1', 's1', 'ghost'] },
  });
  // s3 belongs to d2, 'ghost' to nothing, and the duplicate s1 is one card.
  assert.deepEqual(r.body.layout.sessionOrder.d1, ['s1']);
});

test('a non-array order is a 400, not a silently emptied arrangement', () => {
  const { app } = createFixture();
  invoke(app.routes.get('PUT /api/ui-layout/dir-order'), { body: { order: ['d1', 'd2'] } });

  const bad = invoke(app.routes.get('PUT /api/ui-layout/dir-order'), { body: { order: 'd1' } });
  assert.equal(bad.statusCode, 400);
  const after = invoke(app.routes.get('GET /api/ui-layout'));
  assert.deepEqual(after.body.layout.dirOrder, ['d1', 'd2']);
});

test('deleting a fleet drops it from the stored order instead of accumulating', () => {
  const { directories, persistedSessions, app, runtime } = createFixture();
  invoke(app.routes.get('PUT /api/ui-layout/dir-order'), { body: { order: ['d2', 'd1'] } });
  invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'd1' }, body: { order: ['s2', 's1'] },
  });

  directories.delete('d2');
  persistedSessions.delete('s2');

  const layout = runtime.readLayout();
  assert.deepEqual(layout.dirOrder, ['d1'], 'a deleted directory keeps no slot');
  assert.deepEqual(layout.sessionOrder.d1, ['s1'], 'a deleted session keeps no slot');
});

test('a corrupt layout file costs the arrangement and nothing else', () => {
  const { file, directories, persistedSessions } = createFixture();
  fs.writeFileSync(file, '{ not json');
  const warnings = [];
  const runtime = createUiLayoutRuntime({
    ...makeDeps({ file, directories, persistedSessions }),
    logger: { warn: m => warnings.push(m) },
  });
  // Unlike sessions.json, this store does NOT fail closed: refusing to boot
  // over a lost card arrangement would be the wrong blast radius.
  assert.deepEqual(runtime.readLayout().dirOrder, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ui-layout/);
});

test('normalizeOrder caps a hostile payload rather than growing the file', () => {
  const huge = Array.from({ length: core.MAX_IDS + 500 }, (_, i) => `id-${i}`);
  assert.equal(core.normalizeOrder(huge).length, core.MAX_IDS);
  assert.deepEqual(core.normalizeOrder(['ok', 'x'.repeat(core.MAX_ID_LENGTH + 1), 42, '', '  ']), ['ok']);
  assert.deepEqual(core.normalizeOrder('not an array'), []);
});

test('normalizeLayout ignores keys the document does not define', () => {
  const layout = core.normalizeLayout({
    dirOrder: ['a'], sessionOrder: { d: ['s'] }, updatedAt: '2026-08-08T00:00:00.000Z',
    somethingElse: { secret: 1 },
  });
  assert.deepEqual(Object.keys(layout).sort(), ['dirOrder', 'sessionOrder', 'updatedAt']);
  assert.equal(layout.updatedAt, '2026-08-08T00:00:00.000Z');
});

test('dragging a fleet back to default removes its entry entirely', () => {
  const { app } = createFixture();
  invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'd1' }, body: { order: ['s2', 's1'] },
  });
  const cleared = invoke(app.routes.get('PUT /api/ui-layout/session-order/:dirId'), {
    params: { dirId: 'd1' }, body: { order: [] },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal('d1' in cleared.body.layout.sessionOrder, false);
});

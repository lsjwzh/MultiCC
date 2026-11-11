'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  mountFileTransferHostRoute,
  createFileTransferHost,
  HOST_PATH,
} = require('../src/routes/file-transfer-host');

function createApp() {
  const routes = new Map();
  const add = method => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: add('GET'), post: add('POST') };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function localRequest(body = {}) {
  return {
    body,
    headers: { host: 'localhost:3000' },
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

async function invoke(app, request) {
  const handlers = app.routes.get(`POST ${HOST_PATH}`);
  assert.ok(handlers, `route POST ${HOST_PATH} is mounted`);
  const response = createResponse();
  await handlers.at(-1)(request, response);
  // The mount answers from a promise chain, so let the microtask drain first.
  await new Promise(resolve => setImmediate(resolve));
  return response;
}

function createHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-file-host-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const deps = {
    fs,
    path,
    os: { homedir: () => home },
    getActiveSession: () => null,
    getPersistedSession: () => null,
    ...overrides,
  };
  const app = createApp();
  mountFileTransferHostRoute(app, deps);
  return { app, deps, root, home };
}

test('mount registers only the loopback host port', () => {
  const { app } = createHarness();
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
  assert.equal(app.routes.get(`POST ${HOST_PATH}`).length, 1);
});

test('non-local callers get a 404 and unknown ops get an empty failure', async () => {
  const denied = createHarness({ isLocal: () => false });
  let response = await invoke(denied.app, localRequest({ op: 'files', path: denied.home }));
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'not found' });

  const { app } = createHarness();
  response = await invoke(app, localRequest({ op: 'upload' }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: false });

  response = await invoke(app, localRequest([]));
  assert.deepEqual(response.body, { ok: false });
});

test('directory resolution preserves session, home and tilde precedence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-file-host-resolve-'));
  try {
    const home = path.join(root, 'home');
    const activeDir = path.join(root, 'active');
    const persistedDir = path.join(root, 'persisted');
    fs.mkdirSync(home);
    fs.mkdirSync(activeDir);
    fs.mkdirSync(persistedDir);
    fs.mkdirSync(path.join(home, 'nested'));
    const handle = createFileTransferHost({
      fs,
      path,
      os: { homedir: () => home },
      getActiveSession: id => (id === 'active' ? { cwd: activeDir } : null),
      getPersistedSession: id => (id === 'persisted' ? { cwd: persistedDir } : null),
    });
    const resolved = async (rawPath, session) => (await handle({ op: 'files', path: rawPath, session })).dir;
    assert.equal(await resolved('', 'active'), path.resolve(activeDir));
    assert.equal(await resolved('', 'persisted'), path.resolve(persistedDir));
    assert.equal(await resolved('', 'missing'), path.resolve(home));
    assert.equal(await resolved('~', ''), path.resolve(home));
    assert.equal(await resolved('~/nested', ''), path.join(home, 'nested'));
    assert.equal(await resolved(home, 'active'), path.resolve(home));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file listing returns the host-port payload with sizes and directories first', async () => {
  const { app, home } = createHarness();
  fs.mkdirSync(path.join(home, 'z-dir'));
  fs.writeFileSync(path.join(home, 'a.txt'), 'hello');

  const response = await invoke(app, localRequest({ op: 'files', path: home }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body), ['ok', 'dir', 'entries']);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.dir, path.resolve(home));
  assert.deepEqual(response.body.entries.map(entry => Object.keys(entry)), [
    ['name', 'isDir', 'path', 'size'],
    ['name', 'isDir', 'path', 'size'],
  ]);
  assert.deepEqual(response.body.entries, [
    { name: 'z-dir', isDir: true, path: path.join(response.body.dir, 'z-dir'), size: null },
    { name: 'a.txt', isDir: false, path: path.join(response.body.dir, 'a.txt'), size: 5 },
  ]);
});

test('listing applies the ICU localeCompare order inside each directory group', async () => {
  // A synthetic tree pins the ordering without relying on the host filesystem:
  // macOS temp volumes are case-insensitive, so A.txt/a.txt cannot coexist there.
  const names = ['zz-dir', 'b.txt', 'A.txt', 'a.txt'];
  const handle = createFileTransferHost({
    fs: {
      readdirSync: () => names.map(name => ({ name, isDirectory: () => name === 'zz-dir' })),
      statSync: () => ({ size: 3 }),
    },
    path,
    os: { homedir: () => os.tmpdir() },
    getActiveSession: () => null,
    getPersistedSession: () => null,
  });

  const result = await handle({ op: 'files', path: os.tmpdir(), session: '' });
  assert.equal(result.ok, true);
  // Pinned against Node's ICU order: lowercase sorts before uppercase for the same letter.
  assert.deepEqual(result.entries.map(entry => entry.isDir), [true, false, false, false]);
  assert.deepEqual(result.entries.map(entry => entry.name), ['zz-dir', 'a.txt', 'A.txt', 'b.txt']);
});

test('unreadable directories return the legacy error message', async () => {
  const { app, home } = createHarness();
  const response = await invoke(app, localRequest({ op: 'files', path: path.join(home, 'missing') }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, false);
  assert.equal(typeof response.body.message, 'string');
  assert.match(response.body.message, /^ENOENT/);
});

test('mount falls back to the shared loopback predicate when isLocal is not provided', async () => {
  const { app, home } = createHarness();
  let response = await invoke(app, localRequest({ op: 'files', path: home }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);

  const remote = localRequest({ op: 'files', path: home });
  remote.socket = { remoteAddress: '192.168.1.20' };
  remote.connection = { remoteAddress: '192.168.1.20' };
  response = await invoke(app, remote);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'not found' });
});

test('unexpected handler rejections surface as the 500 fallback', async () => {
  const { app } = createHarness({
    getActiveSession: () => { throw new Error('session table exploded'); },
  });
  const response = await invoke(app, localRequest({ op: 'files', path: '', session: 'boom' }));
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'file transfer failed');
  assert.match(response.body.detail, /session table exploded/);
});

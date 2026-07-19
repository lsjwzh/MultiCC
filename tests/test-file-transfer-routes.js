'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveDirectory,
  mountFileTransferRoutes,
} = require('../src/routes/file-transfer');

function createApp() {
  const routes = new Map();
  const add = method => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE') };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentFile: null,
    downloadedFile: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    sendFile(filePath) { this.sentFile = filePath; return this; },
    download(filePath) { this.downloadedFile = filePath; return this; },
  };
}

async function invoke(app, method, routePath, req = {}) {
  const handlers = app.routes.get(`${method} ${routePath}`);
  assert.ok(handlers, `route ${method} ${routePath} is mounted`);
  const request = { query: {}, body: {}, ...req };
  const response = createResponse();
  await handlers.at(-1)(request, response);
  return response;
}

function createHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-file-routes-'));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  const calls = { logs: [], errors: [], persisted: [] };
  const uploadMiddleware = (req, res, next) => next();
  const deps = {
    fs,
    path,
    os: { homedir: () => home, tmpdir: () => temp },
    upload: { chat: uploadMiddleware },
    persistChatUpload(file) {
      calls.persisted.push(file);
      return { path: path.join(temp, 'saved.txt'), name: 'saved.txt' };
    },
    sendUploadError(res, error) {
      calls.errors.push(error);
      return res.status(507).json({ error: 'upload_failed' });
    },
    getActiveSession: () => null,
    getPersistedSession: () => null,
    log: message => calls.logs.push(message),
    ...overrides,
  };
  const app = createApp();
  mountFileTransferRoutes(app, deps);
  return { app, deps, calls, root, home, temp, uploadMiddleware };
}

test('mount owns the complete legacy file-transfer surface and upload middleware order', () => {
  const { app, uploadMiddleware } = createHarness();
  assert.deepEqual([...app.routes.keys()], [
    'GET /api/files',
    'GET /api/download',
    'POST /api/upload',
    'GET /api/uploads/stats',
    'DELETE /api/uploads/cleanup',
  ]);
  assert.equal(app.routes.get('POST /api/upload').length, 2);
  assert.equal(app.routes.get('POST /api/upload')[0], uploadMiddleware);
});

test('directory resolution preserves session, home and tilde precedence', () => {
  const { deps, home } = createHarness({
    getActiveSession: id => (id === 'active' ? { cwd: '/active/cwd' } : null),
    getPersistedSession: id => (id === 'persisted' ? { cwd: '/persisted/cwd' } : null),
  });
  assert.equal(resolveDirectory('', 'active', deps), path.resolve('/active/cwd'));
  assert.equal(resolveDirectory('', 'persisted', deps), path.resolve('/persisted/cwd'));
  assert.equal(resolveDirectory('', 'missing', deps), path.resolve(home));
  assert.equal(resolveDirectory('~', '', deps), path.resolve(home));
  assert.equal(resolveDirectory('~/nested', '', deps), path.join(home, 'nested'));
  assert.equal(resolveDirectory('/explicit', 'active', deps), path.resolve('/explicit'));
});

test('file listing keeps directories first, reports sizes and retains legacy errors', async () => {
  const { app, home } = createHarness();
  fs.mkdirSync(path.join(home, 'z-dir'));
  fs.writeFileSync(path.join(home, 'a.txt'), 'hello');
  const response = await invoke(app, 'GET', '/api/files', { query: { path: home } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.path, home);
  assert.equal(response.body.parent, path.dirname(home));
  assert.deepEqual(response.body.files.map(entry => [entry.name, entry.isDir, entry.size]), [
    ['z-dir', true, null],
    ['a.txt', false, 5],
  ]);

  const missing = await invoke(app, 'GET', '/api/files', { query: { path: path.join(home, 'missing') } });
  assert.equal(missing.statusCode, 400);
  assert.equal(typeof missing.body.error, 'string');
});

test('download preserves required, directory, inline, attachment and missing responses', async () => {
  const { app, home } = createHarness();
  const file = path.join(home, 'file.txt');
  fs.writeFileSync(file, 'data');

  let response = await invoke(app, 'GET', '/api/download');
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'path required' });

  response = await invoke(app, 'GET', '/api/download', { query: { path: home } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: '不能下载目录' });

  response = await invoke(app, 'GET', '/api/download', { query: { path: file, inline: '1' } });
  assert.equal(response.sentFile, file);
  response = await invoke(app, 'GET', '/api/download', { query: { path: file } });
  assert.equal(response.downloadedFile, file);

  response = await invoke(app, 'GET', '/api/download', { query: { path: path.join(home, 'missing') } });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: '文件不存在' });
});

test('chat upload keeps response shape, releases buffer and delegates policy failures', async () => {
  let harness = createHarness();
  let response = await invoke(harness.app, 'POST', '/api/upload');
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'No file' });

  const file = { originalname: 'upload.txt', buffer: Buffer.from('body') };
  response = await invoke(harness.app, 'POST', '/api/upload', { file });
  assert.deepEqual(response.body, { path: path.join(harness.temp, 'saved.txt'), name: 'saved.txt' });
  assert.equal(file.buffer, null);
  assert.equal(harness.calls.persisted.length, 1);
  assert.match(harness.calls.logs[0], /Uploaded:/);

  const failure = new Error('quota');
  harness = createHarness({ persistChatUpload: () => { throw failure; } });
  response = await invoke(harness.app, 'POST', '/api/upload', {
    file: { originalname: 'upload.txt', buffer: Buffer.from('body') },
  });
  assert.equal(response.statusCode, 507);
  assert.deepEqual(response.body, { error: 'upload_failed' });
  assert.equal(harness.calls.errors[0], failure);
});

test('upload stats and cleanup only manage multicc-prefixed regular files', async () => {
  const { app, temp, calls } = createHarness();
  fs.writeFileSync(path.join(temp, 'multicc_one'), '123');
  fs.writeFileSync(path.join(temp, 'multicc_two'), '12345');
  fs.writeFileSync(path.join(temp, 'foreign'), 'ignored');
  fs.mkdirSync(path.join(temp, 'multicc_dir'));

  let response = await invoke(app, 'GET', '/api/uploads/stats');
  assert.equal(response.body.count, 2);
  assert.equal(response.body.totalSize, 8);
  assert.equal(response.body.dir, temp);
  assert.deepEqual(response.body.files.map(file => file.name).sort(), ['multicc_one', 'multicc_two']);

  response = await invoke(app, 'DELETE', '/api/uploads/cleanup');
  assert.deepEqual(response.body, { deleted: 2, freed: 8 });
  assert.equal(fs.existsSync(path.join(temp, 'foreign')), true);
  assert.equal(fs.existsSync(path.join(temp, 'multicc_dir')), true);
  assert.match(calls.logs.at(-1), /deleted 2 temp files/);
});

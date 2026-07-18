'use strict';

// Isolated HTTP coverage for the memo host/controller. It uses a temporary
// MULTICC_DATA_DIR and an injected fake runTurn port, so no native CLI or AI
// process can be started by this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { requestIdMiddleware, safeErrorHandler } = require('../src/http-errors');
const { createMemoFilePort, createMemoModule, MEMO_MAX_BYTES } = require('../src/memo');
const { assertTestDir, createPaths } = require('../src/paths');

test('isolated memo HTTP contract uses the safe boundary and fake turn port', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-memo-http-'));
  const dataDir = assertTestDir(path.join(root, 'data'));
  const project = path.join(root, 'project');
  const failureProject = path.join(root, 'failure-project');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(failureProject, { recursive: true });
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = dataDir;
  assert.equal(createPaths({ dataDir }).root, dataDir);

  const directories = new Map([
    ['dir-1', { id: 'dir-1', path: project }],
    ['dir-other', { id: 'dir-other', path: path.join(root, 'other') }],
    ['dir-missing-path', { id: 'dir-missing-path', path: path.join(root, 'absent') }],
    ['dir-io-failure', { id: 'dir-io-failure', path: failureProject }],
  ]);
  const sessions = new Map([
    ['chat-1', { id: 'chat-1', dirId: 'dir-1', kind: 'chat' }],
    ['chat-other', { id: 'chat-other', dirId: 'dir-other', kind: 'chat' }],
    ['terminal-1', { id: 'terminal-1', dirId: 'dir-1', kind: 'terminal' }],
    ['busy-1', { id: 'busy-1', dirId: 'dir-1', kind: 'chat' }],
    ['start-fail', { id: 'start-fail', dirId: 'dir-1', kind: 'chat' }],
  ]);
  const turns = [];
  const nativeFiles = createMemoFilePort();
  const files = {
    ...nativeFiles,
    readText(file) {
      if (file.startsWith(failureProject)) {
        throw new Error('EIO token=private at /Users/private/worktree/multicc.memo.md');
      }
      return nativeFiles.readText(file);
    },
  };
  const module = createMemoModule({
    directories: { get: id => directories.get(id) },
    sessions: { get: id => sessions.get(id) },
    runtime: {
      getChatSession: id => id === 'busy-1' ? { claudeProc: { pid: 1 } } : null,
      async runTurn(id, text, options) {
        turns.push({ id, text, options });
        return id !== 'start-fail';
      },
    },
    files,
  });

  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '6mb' }));
  app.use(module.router);
  app.use(safeErrorHandler({ error() {} }));
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
    value.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function api(method, route, body) {
    const requestId = `memo_http_${++sequence}`;
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = JSON.parse(await response.text());
    return { status: response.status, body: payload, requestId, headers: response.headers };
  }

  function assertFailure(result, status, message) {
    assert.equal(result.status, status);
    assert.equal(result.body.error, message);
    assert.equal(result.body.requestId, result.requestId);
    assert.equal(result.headers.get('x-multicc-request-id'), result.requestId);
    assert.equal(typeof result.body.code, 'string');
  }

  let response = await api('GET', '/api/directories/missing/memo');
  assertFailure(response, 404, 'directory not found');

  response = await api('GET', '/api/directories/dir-1/memo');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    path: path.join(project, 'multicc.memo.md'), text: '', mtime: 0, exists: false,
  });

  response = await api('PUT', '/api/directories/dir-1/memo', {});
  assertFailure(response, 400, 'text must be a string');
  response = await api('PUT', '/api/directories/dir-1/memo', { text: 'x'.repeat(MEMO_MAX_BYTES + 1) });
  assertFailure(response, 413, 'memo too large (>5MB)');
  response = await api('PUT', '/api/directories/dir-missing-path/memo', { text: 'memo' });
  assertFailure(response, 400, 'directory path missing');

  response = await api('PUT', '/api/directories/dir-1/memo', { text: '# release\n' });
  assert.equal(response.status, 200);
  assert.equal(response.body.path, path.join(project, 'multicc.memo.md'));
  assert.equal(typeof response.body.mtime, 'number');
  response = await api('GET', '/api/directories/dir-1/memo');
  assert.equal(response.status, 200);
  assert.equal(response.body.text, '# release\n');
  assert.equal(response.body.exists, true);

  response = await api('GET', '/api/directories/dir-io-failure/memo');
  assertFailure(response, 500, 'internal_error');
  assert.doesNotMatch(JSON.stringify(response.body), /private|\/Users|EIO|token|stack|stderr/i);

  response = await api('POST', '/api/directories/dir-1/memo/send', { sessionId: 'chat-1' });
  assertFailure(response, 400, 'text required');
  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'go' });
  assertFailure(response, 400, 'sessionId required');
  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'go', sessionId: 'missing' });
  assertFailure(response, 404, 'session not found');
  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'go', sessionId: 'chat-other' });
  assertFailure(response, 400, 'session is not in this directory');
  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'go', sessionId: 'terminal-1' });
  assertFailure(response, 400, '只能发送到 chat 类型的会话');
  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'go', sessionId: 'busy-1' });
  assertFailure(response, 409, '目标会话正在跑回合，稍后再试');
  assert.deepEqual(turns, []);

  response = await api('POST', '/api/directories/dir-1/memo/send', { text: '  ship it  ', sessionId: 'chat-1' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, sentTo: 'chat-1' });
  assert.deepEqual(turns, [{ id: 'chat-1', text: 'ship it', options: {} }]);

  response = await api('POST', '/api/directories/dir-1/memo/send', { text: 'fail', sessionId: 'start-fail' });
  assertFailure(response, 500, 'internal_error');
  assert.equal(turns.length, 2);
});

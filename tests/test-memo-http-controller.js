'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { presentError } = require('../src/http');
const { MEMO_MAX_BYTES, createMemoController } = require('../src/memo');

const CONTEXT = Object.freeze({ requestId: 'memo_req_1', correlationId: 'memo_corr_1' });

function enoent() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fixture() {
  const directories = new Map([
    ['dir-1', { id: 'dir-1', path: '/project/one' }],
    ['dir-2', { id: 'dir-2', path: '/project/two' }],
    ['dir-missing', { id: 'dir-missing', path: '/project/missing' }],
  ]);
  const sessions = new Map([
    ['chat-1', { id: 'chat-1', dirId: 'dir-1', kind: 'chat' }],
    ['other-dir', { id: 'other-dir', dirId: 'dir-2', kind: 'chat' }],
    ['terminal-1', { id: 'terminal-1', dirId: 'dir-1', kind: 'terminal' }],
    ['busy-1', { id: 'busy-1', dirId: 'dir-1', kind: 'chat' }],
    ['fail-1', { id: 'fail-1', dirId: 'dir-1', kind: 'chat' }],
    ['throw-1', { id: 'throw-1', dirId: 'dir-1', kind: 'chat' }],
  ]);
  const data = new Map();
  const mtimes = new Map();
  const directoriesOnDisk = new Set(['/project/one', '/project/two']);
  const calls = [];
  let readFailure = null;
  let writeFailure = null;

  const files = {
    readText(file) {
      if (readFailure) throw readFailure;
      if (!data.has(file)) throw enoent();
      return data.get(file);
    },
    stat(file) {
      if (!data.has(file)) throw enoent();
      return { mtimeMs: mtimes.get(file) || 0 };
    },
    exists(file) { return directoriesOnDisk.has(file); },
    writeAtomic(file, text) {
      if (writeFailure) throw writeFailure;
      data.set(file, text);
      mtimes.set(file, 99);
    },
  };
  const runtime = {
    getChatSession(id) { return id === 'busy-1' ? { claudeProc: { pid: 42 } } : null; },
    async runTurn(id, text, options) {
      calls.push({ id, text, options });
      if (id === 'throw-1') throw new Error('stderr token=hidden at /Users/private/run.log');
      return id !== 'fail-1';
    },
  };
  const controller = createMemoController({
    directories: { get: id => directories.get(id) },
    sessions: { get: id => sessions.get(id) },
    runtime,
    files,
    pathPort: path.posix,
  });
  return {
    controller, calls, data, mtimes,
    setReadFailure(error) { readFailure = error; },
    setWriteFailure(error) { writeFailure = error; },
  };
}

async function capture(action) {
  try {
    await action();
  } catch (error) {
    return presentError(error, CONTEXT);
  }
  assert.fail('expected action to fail');
}

test('read preserves the legacy missing/existing memo payloads', async () => {
  const f = fixture();
  assert.deepEqual(f.controller.read({ directoryId: 'dir-1' }), {
    path: '/project/one/multicc.memo.md', text: '', mtime: 0, exists: false,
  });
  f.data.set('/project/one/multicc.memo.md', '# memo');
  f.mtimes.set('/project/one/multicc.memo.md', 17);
  assert.deepEqual(f.controller.read({ directoryId: 'dir-1' }), {
    path: '/project/one/multicc.memo.md', text: '# memo', mtime: 17, exists: true,
  });

  const missing = await capture(() => f.controller.read({ directoryId: 'unknown' }));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'directory not found');
  assert.equal(missing.body.code, 'memo_directory_not_found');
});

test('read and write infrastructure failures cannot enter public payloads', async () => {
  const f = fixture();
  f.setReadFailure(new Error('EACCES token=secret at /Users/private/multicc.memo.md'));
  let result = await capture(() => f.controller.read({ directoryId: 'dir-1' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'internal_error');
  assert.equal(result.body.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(result.body), /secret|\/Users|EACCES|stack|stderr/i);

  const writeFixture = fixture();
  writeFixture.setWriteFailure(new Error('rename failed /private/project token=hidden'));
  result = await capture(() => writeFixture.controller.write({ directoryId: 'dir-1', text: 'safe' }));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'internal_error');
  assert.doesNotMatch(JSON.stringify(result.body), /hidden|\/private|rename/i);
});

test('write locks legacy validation statuses and performs one atomic write', async () => {
  const f = fixture();
  const invalid = await capture(() => f.controller.write({ directoryId: 'dir-1', text: 42 }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'text must be a string');

  const large = await capture(() => f.controller.write({
    directoryId: 'dir-1', text: 'x'.repeat(MEMO_MAX_BYTES + 1),
  }));
  assert.equal(large.status, 413);
  assert.equal(large.body.error, 'memo too large (>5MB)');
  assert.equal(large.body.code, 'memo_too_large');

  const pathMissing = await capture(() => f.controller.write({ directoryId: 'dir-missing', text: 'safe' }));
  assert.equal(pathMissing.status, 400);
  assert.equal(pathMissing.body.error, 'directory path missing');

  assert.deepEqual(f.controller.write({ directoryId: 'dir-1', text: 'saved' }), {
    path: '/project/one/multicc.memo.md', mtime: 99,
  });
  assert.equal(f.data.get('/project/one/multicc.memo.md'), 'saved');
});

test('send locks missing, mismatch, kind and busy error semantics', async () => {
  const f = fixture();
  const cases = [
    [{ directoryId: 'dir-1', text: '', sessionId: 'chat-1' }, 400, 'text required'],
    [{ directoryId: 'dir-1', text: 'go', sessionId: '' }, 400, 'sessionId required'],
    [{ directoryId: 'dir-1', text: 'go', sessionId: 'unknown' }, 404, 'session not found'],
    [{ directoryId: 'dir-1', text: 'go', sessionId: 'other-dir' }, 400, 'session is not in this directory'],
    [{ directoryId: 'dir-1', text: 'go', sessionId: 'terminal-1' }, 400, '只能发送到 chat 类型的会话'],
  ];
  for (const [input, status, message] of cases) {
    const result = await capture(() => f.controller.send(input));
    assert.equal(result.status, status);
    assert.equal(result.body.error, message);
    assert.equal(result.body.requestId, CONTEXT.requestId);
  }
  assert.equal(f.calls.length, 0);
});

test('send delegates only valid turns and fails closed when start fails', async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.send({
    directoryId: 'dir-1', text: '  ship it  ', sessionId: ' chat-1 ',
  }), { ok: true, sentTo: 'chat-1' });
  assert.deepEqual(f.calls, [{ id: 'chat-1', text: 'ship it', options: {} }]);
  assert.deepEqual(await f.controller.send({
    directoryId: 'dir-1', text: 'queue me', sessionId: 'busy-1',
  }), { ok: true, sentTo: 'busy-1' });
  assert.deepEqual(f.calls.at(-1), { id: 'busy-1', text: 'queue me', options: {} });

  for (const sessionId of ['fail-1', 'throw-1']) {
    const result = await capture(() => f.controller.send({ directoryId: 'dir-1', text: 'go', sessionId }));
    assert.equal(result.status, 500);
    assert.equal(result.body.error, 'internal_error');
    assert.equal(result.body.code, 'internal_error');
    assert.doesNotMatch(JSON.stringify(result.body), /hidden|\/Users|stderr|token/i);
  }
});

test('production server mounts only the injected memo module', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'memo', 'controller.js'), 'utf8');
  assert.match(source, /const \{ createMemoModule \} = require\('\.\/src\/memo'\);/);
  assert.equal((source.match(/createMemoModule\(\{/g) || []).length, 1);
  assert.doesNotMatch(source, /app\.(?:get|put|post)\('\/api\/directories\/:id\/memo/);
  assert.doesNotMatch(source, /const MEMO_(?:FILENAME|MAX_BYTES)/);
  assert.match(source, /runTurn: \(id, text, options\) => chatTurnEngine\.admitChatWork\(id, text, options\)/);
  assert.doesNotMatch(controllerSource, /require\(['"]express['"]\)|server\.js/);
});

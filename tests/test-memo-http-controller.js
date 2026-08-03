'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { presentError } = require('../src/http');
const {
  MEMO_MAX_BYTES,
  createMemoController,
  createGitTrackPort,
  migrateProjectMemos,
} = require('../src/memo');

const CONTEXT = Object.freeze({ requestId: 'memo_req_1', correlationId: 'memo_corr_1' });
// Memos live under multicc's memory store, keyed by directory id — never in the
// project itself, where an untracked file blocks that repository's merges.
const MEMO_ROOT = '/state/memories';
const MEMO_1 = '/state/memories/dir-1/memo.md';
const LEGACY_1 = '/project/one/multicc.memo.md';

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
  const ensured = [];
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
    exists(file) { return directoriesOnDisk.has(file) || data.has(file); },
    ensureDir(dir) { ensured.push(dir); directoriesOnDisk.add(dir); },
    remove(file) { data.delete(file); mtimes.delete(file); },
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
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
  });
  return {
    controller, calls, data, mtimes, ensured, files, directories,
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

test('read serves the memory-store memo and never the project tree', async () => {
  const f = fixture();
  assert.deepEqual(f.controller.read({ directoryId: 'dir-1' }), {
    path: MEMO_1, text: '', mtime: 0, exists: false,
  });
  f.data.set(MEMO_1, '# memo');
  f.mtimes.set(MEMO_1, 17);
  assert.deepEqual(f.controller.read({ directoryId: 'dir-1' }), {
    path: MEMO_1, text: '# memo', mtime: 17, exists: true,
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
    path: MEMO_1, mtime: 99,
  });
  assert.equal(f.data.get(MEMO_1), 'saved');
  assert.deepEqual(f.ensured, ['/state/memories/dir-1']);
  assert.equal(f.data.has(LEGACY_1), false);
});

test('migration copies legacy project memos out and clears untracked ones', async () => {
  const f = fixture();
  f.data.set(LEGACY_1, '# legacy');
  const report = await migrateProjectMemos({
    directories: [...f.directories.values()],
    files: f.files,
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
    git: { isTracked: async () => 'untracked' },
  }).done;
  assert.deepEqual(
    { found: report.found, moved: report.moved, removed: report.removed },
    { found: 1, moved: 1, removed: 1 },
  );
  assert.equal(f.data.get(MEMO_1), '# legacy');
  assert.equal(f.data.has(LEGACY_1), false, 'untracked legacy memo must leave the project tree');
  assert.deepEqual(f.controller.read({ directoryId: 'dir-1' }).text, '# legacy');

  // Second pass is a no-op: nothing left to find.
  assert.equal((await migrateProjectMemos({
    directories: [...f.directories.values()],
    files: f.files,
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
    git: { isTracked: async () => 'untracked' },
  }).done).found, 0);
});

test('migration never deletes a git-tracked memo and never overwrites a differing one', async () => {
  const tracked = fixture();
  tracked.data.set(LEGACY_1, '# legacy');
  let report = await migrateProjectMemos({
    directories: [...tracked.directories.values()],
    files: tracked.files,
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
    git: { isTracked: async () => 'tracked' },
  }).done;
  assert.equal(tracked.data.get(MEMO_1), '# legacy');
  assert.equal(tracked.data.get(LEGACY_1), '# legacy', 'deleting a tracked file would dirty a clean repo');
  assert.equal(report.removed, 0);
  assert.deepEqual(report.keptTracked.map(entry => entry.id), ['dir-1']);

  // An unclassifiable repository is treated as tracked: never delete on doubt.
  const unknown = fixture();
  unknown.data.set(LEGACY_1, '# legacy');
  report = await migrateProjectMemos({
    directories: [...unknown.directories.values()],
    files: unknown.files,
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
    git: { isTracked: async () => 'unknown' },
  }).done;
  assert.equal(unknown.data.get(LEGACY_1), '# legacy');
  assert.equal(report.removed, 0);

  const conflict = fixture();
  conflict.data.set(LEGACY_1, '# legacy');
  conflict.data.set(MEMO_1, '# already stored');
  report = await migrateProjectMemos({
    directories: [...conflict.directories.values()],
    files: conflict.files,
    memoRoot: MEMO_ROOT,
    pathPort: path.posix,
    git: { isTracked: async () => 'untracked' },
  }).done;
  assert.equal(conflict.data.get(MEMO_1), '# already stored');
  assert.equal(conflict.data.get(LEGACY_1), '# legacy');
  assert.deepEqual(report.conflicts.map(entry => entry.id), ['dir-1']);
  assert.equal(report.moved, 0);
});

test('git track port classifies without deleting on doubt', async () => {
  const fail = (stderr) => ({ error: Object.assign(new Error('git failed'), { code: 128 }), stdout: '', stderr });
  const port = createGitTrackPort({
    run: async (dir) => {
      if (dir === '/tracked') return { error: null, stdout: 'multicc.memo.md\n', stderr: '' };
      if (dir === '/untracked') return { error: null, stdout: '', stderr: '' };
      if (dir === '/plain') return fail('fatal: not a git repository');
      if (dir === '/broken') return fail('fatal: something else');
      throw new Error('spawn failed');
    },
  });
  assert.equal(await port.isTracked('/tracked', 'multicc.memo.md'), 'tracked');
  assert.equal(await port.isTracked('/untracked', 'multicc.memo.md'), 'untracked');
  assert.equal(await port.isTracked('/plain', 'multicc.memo.md'), 'untracked');
  assert.equal(await port.isTracked('/broken', 'multicc.memo.md'), 'unknown');
  assert.equal(await port.isTracked('/missing-git', 'multicc.memo.md'), 'unknown');
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
  assert.match(source, /memoRoot: MEMORY_STORE_ROOT/);
  assert.match(source, /memoModule\.migrateLegacy\(\)/);
  assert.doesNotMatch(controllerSource, /require\(['"]express['"]\)|server\.js/);
  // The project tree is no longer a memo destination anywhere in the module.
  assert.doesNotMatch(controllerSource, /join\(\s*value\.path/);
});

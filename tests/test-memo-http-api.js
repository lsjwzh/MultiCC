'use strict';

// The three public memo routes (GET/PUT /api/directories/:id/memo and
// POST /api/directories/:id/memo/send) belong to the Rust front door now
// (native/gateway/src/app/docs_memory_routes.rs + native/core/src/docs_memory_routes.rs,
// live suite in native/gateway/tests/docs_memory_routes.rs). Status codes,
// request bodies and the "text required" style validation are Rust's, and the
// differential (docs/rust-migration/differential/docs-memory-routes.js) pins them.
//
// Exercise the native controller through the production host port using an isolated
// store and a fake runTurn. The legacy project memo migration uses the same file port.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMemoFilePort, createMemoModule, MEMO_MAX_BYTES } = require('../src/memo');
const { createDocsMemoryHost } = require('../src/routes/docs-memory-host');
const { assertTestDir, createPaths } = require('../src/paths');

test('memo controller keeps memos in the store and delivers over the fake turn port', async (t) => {
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
  const memoRoot = path.join(dataDir, 'memories');
  const nativeFiles = createMemoFilePort();
  const files = {
    ...nativeFiles,
    readText(file) {
      if (file.startsWith(path.join(memoRoot, 'dir-io-failure'))) {
        throw new Error('EIO token=private at /Users/private/worktree/multicc.memo.md');
      }
      return nativeFiles.readText(file);
    },
  };
  const module = createMemoModule({
    directories: { get: id => directories.get(id), list: () => [...directories.values()] },
    sessions: { get: id => sessions.get(id) },
    runtime: {
      getChatSession: id => id === 'busy-1' ? { claudeProc: { pid: 1 } } : null,
      async runTurn(id, text, options) {
        turns.push({ id, text, options });
        return id !== 'start-fail';
      },
    },
    files,
    memoRoot,
  });
  const controller = module.controller;
  const host = createDocsMemoryHost({
    memo: controller,
    directories,
    isLocal: () => true,
    logger: { error() {} },
  });

  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    assertTestDir(root);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function refused(envelope) {
    assert.equal(Object.keys(envelope).length, 1);
    return envelope.refused;
  }

  // ── host port: what the front door asks for ──────────────────────────────
  let answer = await host.handle({ op: 'memo-read', directoryId: 'missing' });
  assert.deepEqual(refused(answer), {
    status: 404,
    code: 'memo_directory_not_found',
    message: 'directory not found',
  });

  answer = await host.handle({ op: 'memo-read', directoryId: 'dir-1' });
  assert.deepEqual(answer.data, {
    path: path.join(memoRoot, 'dir-1', 'memo.md'), text: '', mtime: 0, exists: false,
  });

  assert.deepEqual(refused(await host.handle({ op: 'memo-write', directoryId: 'dir-1', text: undefined })), {
    status: 400, code: 'memo_text_invalid', message: 'text must be a string',
  });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-write', directoryId: 'dir-1', text: 'x'.repeat(MEMO_MAX_BYTES + 1),
  })), { status: 413, code: 'memo_too_large', message: 'memo too large (>5MB)' });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-write', directoryId: 'dir-missing-path', text: 'memo',
  })), { status: 400, code: 'memo_directory_path_missing', message: 'directory path missing' });

  answer = await host.handle({ op: 'memo-write', directoryId: 'dir-1', text: '# release\n' });
  assert.equal(answer.data.path, path.join(memoRoot, 'dir-1', 'memo.md'));
  assert.equal(typeof answer.data.mtime, 'number');
  answer = await host.handle({ op: 'memo-read', directoryId: 'dir-1' });
  assert.equal(answer.data.text, '# release\n');
  assert.equal(answer.data.exists, true);
  // The whole point of the move: writing a memo must not touch the project.
  assert.deepEqual(fs.readdirSync(project), []);

  // ── the legacy project memo migration ────────────────────────────────────
  // A memo written by an older build is copied out and the untracked original
  // removed, so it can no longer show up as a dirty entry in that project.
  fs.writeFileSync(path.join(project, 'multicc.memo.md'), '# legacy', 'utf8');
  fs.writeFileSync(path.join(failureProject, 'multicc.memo.md'), '# other', 'utf8');
  const report = await module.migrateLegacy().done;
  assert.equal(report.found, 2);
  assert.equal(fs.existsSync(path.join(failureProject, 'multicc.memo.md')), false);
  assert.equal(fs.readFileSync(path.join(memoRoot, 'dir-io-failure', 'memo.md'), 'utf8'), '# other');
  // dir-1 already had a different stored memo: keep both, report the conflict.
  assert.deepEqual(report.conflicts.map(entry => entry.id), ['dir-1']);
  assert.equal(fs.readFileSync(path.join(memoRoot, 'dir-1', 'memo.md'), 'utf8'), '# release\n');
  fs.rmSync(path.join(project, 'multicc.memo.md'), { force: true });

  // A read failure surfaces as the branded 500 and never leaks the cause.
  answer = await host.handle({ op: 'memo-read', directoryId: 'dir-io-failure' });
  assert.deepEqual(refused(answer), { status: 500, code: 'internal_error', message: 'internal_error' });
  assert.doesNotMatch(JSON.stringify(answer), /private|\/Users|EIO|token|stack|stderr/i);

  // ── send: validation, then a real delivery through runTurn ───────────────
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: undefined, sessionId: 'chat-1',
  })), { status: 400, code: 'memo_text_required', message: 'text required' });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: 'go', sessionId: undefined,
  })), { status: 400, code: 'memo_session_required', message: 'sessionId required' });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: 'go', sessionId: 'missing',
  })), { status: 404, code: 'memo_session_not_found', message: 'session not found' });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: 'go', sessionId: 'chat-other',
  })), { status: 400, code: 'memo_session_mismatch', message: 'session is not in this directory' });
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: 'go', sessionId: 'terminal-1',
  })), { status: 400, code: 'memo_session_kind_invalid', message: '只能发送到 chat 类型的会话' });
  assert.deepEqual(turns, []);

  // A busy session queues rather than 409s: admitChatWork owns the FIFO, so the
  // memo host must not second-guess it (see the controller test's "queue me").
  answer = await host.handle({ op: 'memo-send', directoryId: 'dir-1', text: 'go', sessionId: 'busy-1' });
  assert.deepEqual(answer.data, { ok: true, sentTo: 'busy-1' });

  answer = await host.handle({ op: 'memo-send', directoryId: 'dir-1', text: '  ship it  ', sessionId: 'chat-1' });
  assert.deepEqual(answer.data, { ok: true, sentTo: 'chat-1' });
  assert.deepEqual(turns, [
    { id: 'busy-1', text: 'go', options: {} },
    { id: 'chat-1', text: 'ship it', options: {} },
  ]);

  // runTurn returning false (a turn that could not start) is a 500, not a 200.
  assert.deepEqual(refused(await host.handle({
    op: 'memo-send', directoryId: 'dir-1', text: 'fail', sessionId: 'start-fail',
  })), { status: 500, code: 'internal_error', message: 'internal_error' });
  assert.equal(turns.length, 3);

  // The controller is frozen: the front door only ever sees these three calls.
  assert.equal(Object.isFrozen(controller), true);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSdkStream } = require('../src/chat/claude-sdk-stream');
const { createStreamRouter } = require('../src/chat/stream-router');

// The lane is exercised against tests/helpers/fake-claude-lane.js: a real
// child process speaking the same JSONL control protocol. It is deterministic,
// needs no network, and — unlike a mocked query object — goes through the
// native spawn/framing/classify code that actually ships.
const FAKE = path.join(__dirname, 'helpers', 'fake-claude-lane.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ledger(file) {
  return {
    spawns: () => fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        .filter(row => row.__fake === 'spawn') : [],
    stdin: () => fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        .filter(row => row.__fake !== 'spawn') : [],
  };
}

async function laneFixture(t, { scenario = 'basic', streamDeps = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lane-stream-'));
  const log = path.join(root, 'lane.jsonl');
  const sessionId = randomUUID();
  const sdk = createSdkStream({
    binary: process.execPath, binaryArgs: [FAKE], ...streamDeps,
  });
  const runtime = createStreamRouter({ status: () => null, closeAndWait: async () => ({ closed: true }) }, sdk);
  const files = ledger(log);
  t.after(async () => {
    try { await runtime.closeAndWait('sdk', { timeoutMs: 5000 }); } catch (_) { /* already gone */ }
    for (const spawn of files.spawns()) {
      try { process.kill(spawn.pid, 'SIGKILL'); } catch (_) { /* exited */ }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); return; }
      catch (_) { await sleep(50); }
    }
  });
  let background = false;
  let cfg;
  function configure(overrides = {}) {
    cfg = {
      cwd: root, sessionId, sdkOptions: { model: 'fake-model' }, initializeTimeoutMs: 2000,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root,
        FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: log },
      isBackgroundActive: () => background,
      backgroundHold: { maxMs: 0 },
      ...overrides,
    };
    runtime.ensure('sdk', cfg);
    return cfg;
  }
  const send = (text, onEvent = () => {}) => runtime.send('sdk', text, onEvent);
  return { root, log, sessionId, sdk, runtime, files, configure, send,
    setBackground: value => { background = value; } };
}

async function until(predicate, message = 'condition not reached', timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(20);
  }
}

test('one native child serves rotated turns and set_model', { timeout: 30000 }, async t => {
  const f = await laneFixture(t);
  f.configure();
  const first = await f.send('FIRST_TURN');
  assert.equal(first.subtype, 'success');
  const firstPid = f.runtime.status('sdk').pid;
  assert.ok(firstPid > 0);

  f.configure({ sdkOptions: { model: 'second-model' } });
  const second = await f.send('SECOND_TURN');
  assert.equal(second.subtype, 'success');

  assert.equal(f.runtime.status('sdk').pid, firstPid, 'same resident child');
  assert.equal(f.files.spawns().length, 1);
  assert.ok(f.files.spawns()[0].argv.some(arg => arg === '--model=fake-model'));
  const lines = f.files.stdin();
  assert.equal(lines.filter(line => line.type === 'control_request'
    && line.request?.subtype === 'initialize').length, 1);
  const setModel = lines.find(line => line.type === 'control_request' && line.request?.subtype === 'set_model');
  assert.equal(setModel.request.model, 'second-model');
  const users = lines.filter(line => line.type === 'user');
  assert.equal(users.length, 2);
  assert.match(JSON.stringify(users), /FIRST_TURN/);
  assert.match(JSON.stringify(users), /SECOND_TURN/);
  assert.ok(users.every(line => line.session_id === f.sessionId));
});

test('hook callbacks are answered on the request_id the child asked for', { timeout: 30000 }, async t => {
  const f = await laneFixture(t, { scenario: 'hook' });
  f.configure();
  const pending = f.send('HOOK_PROMPT');
  await until(() => f.files.stdin().some(line => line.type === 'control_response'),
    'the hook callback was never answered', 5000);
  const result = await pending;
  assert.equal(result.result, 'hook:allowed');
  const replies = f.files.stdin().filter(line => line.type === 'control_response');
  assert.equal(replies.length, 1);
  assert.match(replies[0].response.request_id, /^hookreq-/, 'answered the id the child asked for');
  assert.equal(replies[0].response.subtype, 'success');
});

test('interrupt drains the cancelled turn and reuses the child', { timeout: 30000 }, async t => {
  const f = await laneFixture(t);
  f.configure({ interruptTimeoutMs: 3000 });
  const events = [];
  const pending = f.send('SLOW request', event => events.push(event));
  const rejected = assert.rejects(pending, /cancelled/);
  await until(() => f.files.stdin().some(line => line.type === 'user'));
  const pid = f.runtime.status('sdk').pid;
  const queued = assert.rejects(f.send('queued message must be cancelled'), /cancelled/);
  f.runtime.cancel('sdk');
  await Promise.all([rejected, queued]);
  await until(() => f.runtime.status('sdk').alive === true, 'interrupt must not kill the child');
  const after = [];
  assert.equal((await f.send('after interrupt', event => after.push(event))).subtype, 'success');
  assert.equal(f.runtime.status('sdk').pid, pid);
  assert.equal(f.files.spawns().length, 1);
  assert.equal(after.filter(event => event.type === 'result').length, 1);
  assert.doesNotMatch(JSON.stringify(f.files.stdin().filter(line => line.type === 'user')),
    /queued message must be cancelled/);
  assert.ok(f.files.stdin().some(line => line.type === 'control_request'
    && line.request?.subtype === 'interrupt'));
});

test('idle cleanup holds live background work, then resumes the same history', { timeout: 30000 }, async t => {
  const f = await laneFixture(t);
  f.configure({ idleMs: 25 });
  f.setBackground(true);
  await f.send('IDLE_HISTORY_MARKER');
  await sleep(90);
  assert.equal(f.runtime.status('sdk').alive, true, 'background work owns the process');
  const pid = f.runtime.status('sdk').pid;
  f.setBackground(false);
  await until(() => f.runtime.status('sdk').alive === false, 'idle cleanup did not close the child');
  f.configure();
  await f.send('after idle cleanup');
  assert.equal(f.files.spawns().length, 2);
  assert.ok(f.files.spawns()[1].argv.includes(`--resume=${f.sessionId}`));
  assert.notEqual(f.runtime.status('sdk').pid, pid);
});

test('closing during start cannot send a user message', async t => {
  let release, loading;
  const ready = new Promise(resolve => { loading = resolve; });
  let sentUser = false;
  const stubLane = () => ({
    get alive() { return false; },
    start: async () => { loading(); await new Promise(resolve => { release = resolve; }); return JSON.stringify({ pid: 0, argv: [] }); },
    sendUser() { sentUser = true; },
    closeInput() {}, kill() {}, stderrTail() { return ''; },
    respondControl() {}, respondControlError() {},
  });
  const sdk = createSdkStream({ createLane: () => stubLane() });
  t.after(() => sdk.closeAndWait('sdk').catch(() => {}));
  const { randomUUID } = require('node:crypto');
  sdk.ensure('sdk', { cwd: '/unused', sessionId: randomUUID(), env: {}, sdkOptions: {} });
  const rejected = assert.rejects(sdk.send('sdk', 'closing'), /cancelled/);
  await ready;
  // Close while start() is still awaited; the release lets start observe the
  // disposal and bail out instead of writing to the child.
  sdk.close('sdk');
  release();
  await sdk.waitForClose('sdk');
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sentUser, false);
  assert.equal(sdk.status('sdk'), null);
});

test('missing established native history stays missing', { timeout: 30000 }, async t => {
  const f = await laneFixture(t, { scenario: 'missing-history' });
  f.configure({ resume: true });
  const result = await f.send('missing history must stay missing');
  assert.match(JSON.stringify(result), /No conversation found with session ID/);
  assert.equal(f.files.spawns().length, 1);
  assert.ok(f.files.spawns()[0].argv.includes(`--resume=${f.sessionId}`));
  assert.equal(f.files.stdin().filter(line => line.type === 'user').length, 1);
});

test('crash recovery resumes history and pruning waits for background work', { timeout: 30000 }, async t => {
  const f = await laneFixture(t);
  f.configure();
  await f.send('first unsuccessful round');
  const firstPid = f.runtime.status('sdk').pid;
  process.kill(firstPid, 'SIGKILL');
  await until(() => f.runtime.status('sdk').alive === false, 'the child did not die');

  f.configure();
  await f.send('recover after crash');
  assert.equal(f.files.spawns().length, 2);
  assert.ok(f.files.spawns()[1].argv.includes(`--resume=${f.sessionId}`));
  const secondPid = f.runtime.status('sdk').pid;
  assert.notEqual(secondPid, firstPid);

  f.setBackground(true);
  assert.equal(f.runtime.recycle('sdk', 'transcript-pruned').applied, 'deferred-background');
  await assert.rejects(f.send('must not terminate background work'), { code: 'SDK_BACKGROUND_ACTIVE' });
  assert.equal(f.runtime.status('sdk').pid, secondPid);
  f.setBackground(false);
  await f.send('after transcript prune');
  assert.equal(f.files.spawns().length, 3);
});

test('getTaskOutput serves the resident control channel and degrades to null', { timeout: 30000 }, async t => {
  const f = await laneFixture(t);
  f.configure();
  await f.send('warm');
  assert.deepEqual(await f.runtime.getTaskOutput('sdk', 'task-9'),
    { output: 'fake:task-9', totalBytes: 4, truncated: false });
  assert.equal(await f.runtime.getTaskOutput('missing', 'task-9'), null);
  assert.equal(await f.runtime.getTaskOutput('sdk', ''), null);

  assert.equal(await f.runtime.stopTask('sdk', 'task-7'), true);
  assert.equal(await f.runtime.stopTask('missing', 'task-7'), false);
  assert.equal(await f.runtime.stopTask('sdk', ''), false);

  // A child that has exited cannot serve controls: callers fall back.
  process.kill(f.runtime.status('sdk').pid, 'SIGKILL');
  await until(() => f.runtime.status('sdk').alive === false, 'the child did not die');
  assert.equal(await f.runtime.getTaskOutput('sdk', 'task-9'), null);
  assert.equal(await f.runtime.stopTask('sdk', 'task-7'), false);
});

test('stream router forwards task control only to backends that implement it', async () => {
  const legacy = {};
  const sdk = {
    async getTaskOutput(name, taskId) { return { output: `router:${taskId}`, totalBytes: 4, truncated: false }; },
    async stopTask() { return true; },
  };
  const router = createStreamRouter(legacy, sdk);
  // No ensure() ran, so the name is unknown and resolves to the legacy backend.
  assert.equal(await router.getTaskOutput('any', 't'), null);
  assert.equal(await router.stopTask('any', 't'), false);
});

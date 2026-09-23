'use strict';
// The resident app-server lane, exercised through the facade the session
// lifecycle actually calls (ensure/send/status/recycle/cancel/closeAndWait).
//
// This drives the REAL bridge against a fake `codex app-server`, so it covers
// the contract both halves must agree on: what a turn boundary is, where the
// thread id comes from, and what happens to the conversation when the child is
// replaced.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexAppStream } = require('../src/chat/codex-app-stream');
const { writeFakeAppServer } = require('./helpers/fake-codex-app-server');

const BRIDGE = path.join(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs');

function createFixture(name, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-codex-stream-${name}-`));
  const logFile = path.join(root, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const bin = writeFakeAppServer(root);
  const stream = createCodexAppStream();
  const childEnv = { ...process.env, FAKE_CODEX_LOG: logFile, ...env };
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: root,
    baseArgs: [BRIDGE, '--codex-bin', bin, '--resident'],
    env: childEnv,
    idleMs: 60_000,
  });
  return {
    stream,
    bin,
    logFile,
    childEnv,
    requests: () => (fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))),
    methods: () => (fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((item) => item.id).map((item) => item.method)),
  };
}

function collect() {
  const events = [];
  return { events, onEvent: (evt) => events.push(evt) };
}

for (const method of ['thread/start', 'thread/resume', 'turn/start']) {
  test(`a rejected ${method} exits and releases the host turn`, { timeout: 5000 }, async () => {
    const name = `reject-${method}`;
    const { stream } = createFixture(name.replace('/', '-'), { FAKE_CODEX_REJECT: method });
    const id = name.replace('/', '-');
    if (method === 'thread/resume') stream.ensure(id, { sessionId: 'missing-thread' });
    try {
      await assert.rejects(stream.send(id, 'hello', () => {}), /fixture request rejected/);
      assert.equal(stream.status(id).busy, false);
      assert.equal(stream.status(id).alive, false);
    } finally { await stream.closeAndWait(id); }
  });
}

test('a warm app-server serves several turns on one thread', async (t) => {
  const fixture = createFixture('turns');
  const { stream } = fixture;
  t.after(() => { stream.close('turns'); });

  const first = collect();
  const one = await stream.send("turns", "hello one", first.onEvent, { turnOptions: { model: "gpt-5.5", effort: "high" } });
  assert.equal(one.result.method, 'turn/completed');
  assert.deepEqual(first.events.map((evt) => evt.method), [
    'thread/started', 'item/agentMessage/delta', 'turn/completed',
  ]);
  assert.equal(stream.status('turns').threadId, 'thread-resident');

  const second = collect();
  await stream.send('turns', 'hello two', second.onEvent);
  assert.deepEqual(second.events.map((evt) => evt.method), [
    'item/agentMessage/delta', 'turn/completed',
  ]);

  assert.deepEqual(fixture.methods(), ['initialize', 'thread/start', 'turn/start', 'turn/start'],
    'the second turn must run on the thread already open, not open a new one');
  const turns = fixture.requests().filter((item) => item.method === 'turn/start');
  assert.deepEqual(turns.map((item) => item.params.input[0].text), ['hello one', 'hello two']);
  assert.deepEqual(turns.map((item) => item.params.threadId), ['thread-resident', 'thread-resident']);
  // Per-turn overrides ride on turn/start, so a model/effort change never
  // requires respawning the app-server.
  assert.deepEqual(
    turns.map((item) => [item.params.model || null, item.params.effort || null]),
    [['gpt-5.5', 'high'], [null, null]],
  );

  const status = stream.status('turns');
  assert.equal(status.busy, false);
  assert.equal(status.alive, true);
  const closed = await stream.closeAndWait('turns');
  assert.deepEqual(closed, { closed: true, hadProcess: true });
  assert.equal(stream.status('turns'), null);
});

test('an ensured session re-attaches to an existing thread instead of forking one', async (t) => {
  const fixture = createFixture('resume');
  const { stream } = fixture;
  t.after(() => { stream.close('resume'); });
  stream.ensure('resume', {
    cmd: process.execPath,
    cwd: path.dirname(fixture.logFile),
    baseArgs: [BRIDGE, '--codex-bin', fixture.bin, '--resident'],
    sessionId: 'thread-from-disk',
    env: fixture.childEnv,
  });

  const sink = collect();
  await stream.send('resume', 'continue', sink.onEvent);
  assert.deepEqual(fixture.methods(), ['initialize', 'thread/resume', 'turn/start']);
  assert.equal(fixture.requests().find((item) => item.method === 'thread/resume').params.threadId, 'thread-from-disk');
  assert.equal(stream.status('resume').threadId, 'thread-from-disk');
  await stream.closeAndWait('resume');
});

test('a routing-env change replaces the child at a turn boundary and keeps the thread', async (t) => {
  const fixture = createFixture('env', { OPENAI_BASE_URL: 'http://upstream-a' });
  const { stream } = fixture;
  t.after(() => { stream.close('env'); });

  const sink = collect();
  await stream.send('env', 'before switch', sink.onEvent);
  assert.deepEqual(fixture.methods(), ['initialize', 'thread/start', 'turn/start']);

  // Same session, new upstream. A live app-server bakes OPENAI_* at spawn, so
  // the turn boundary must replace the child — and the replacement has to
  // re-attach to the thread, or the switch would silently start an empty one.
  stream.ensure('env', { env: { ...fixture.childEnv, OPENAI_BASE_URL: 'http://upstream-b' } });
  await stream.send('env', 'after switch', sink.onEvent);

  assert.deepEqual(fixture.methods(),
    ['initialize', 'thread/start', 'turn/start', 'initialize', 'thread/resume', 'turn/start'],
    'the respawned child resumes the same thread instead of starting a new one');
  const resumes = fixture.requests().filter((item) => item.method === 'thread/resume');
  assert.deepEqual(resumes.map((item) => item.params.threadId), ['thread-resident']);
  await stream.closeAndWait('env');
});

test('a moved CODEX_HOME replaces the child, because the route lives in that home', async (t) => {
  // This protocol's upstream base_url is not in the env: it is in config.toml
  // inside CODEX_HOME, and codex reads it once at startup. A resident lane whose
  // managed route moves therefore swaps the home rather than rewriting it, so the
  // turn boundary has to see that swap — otherwise the child keeps talking to a
  // route the host has already retired.
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-home-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-home-b-'));
  const fixture = createFixture('home', { CODEX_HOME: homeA });
  const { stream } = fixture;
  t.after(() => { stream.close('home'); });

  const sink = collect();
  await stream.send('home', 'before switch', sink.onEvent);
  stream.ensure('home', { env: { ...fixture.childEnv, CODEX_HOME: homeB } });
  await stream.send('home', 'after switch', sink.onEvent);

  assert.deepEqual(fixture.methods(),
    ['initialize', 'thread/start', 'turn/start', 'initialize', 'thread/resume', 'turn/start'],
    'a new home means a new config.toml, so the child is replaced and re-attaches to the thread');
  await stream.closeAndWait('home');
});

test('cancel stops the child and settles the in-flight turn', async (t) => {
  const fixture = createFixture('cancel', { FAKE_CODEX_HOLD_MS: '30000' });
  const { stream } = fixture;
  t.after(() => { stream.close('cancel'); });

  const sink = collect();
  const turn = stream.send('cancel', 'long turn', sink.onEvent);
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the turn reach the app-server
  assert.equal(stream.status('cancel').busy, true);

  stream.cancel('cancel');
  await assert.rejects(turn, /exited|cancelled/);
  assert.equal(stream.isAlive('cancel'), false, 'cancel must reap the app-server, not just detach from it');
});

test('recycle replaces the child at a boundary and preserves the thread', async (t) => {
  const fixture = createFixture('recycle');
  const { stream } = fixture;
  t.after(() => { stream.close('recycle'); });

  const sink = collect();
  await stream.send('recycle', 'first', sink.onEvent);
  assert.deepEqual(stream.recycle('recycle', 'transcript-pruned'), { ok: true, applied: 'now' });
  await stream.send('recycle', 'second', sink.onEvent);

  assert.deepEqual(fixture.methods(),
    ['initialize', 'thread/start', 'turn/start', 'initialize', 'thread/resume', 'turn/start']);
  await stream.closeAndWait('recycle');
});

test('process capabilities are prepared once per spawn, including after recycle', { timeout: 5000 }, async () => {
  const { stream } = createFixture('spawn-hooks');
  let prepared = 0, disposed = 0;
  stream.ensure('spawn-hooks', { beforeSpawn: () => { prepared++; }, onDispose: () => { disposed++; } });
  try {
    await stream.send('spawn-hooks', 'one', () => {});
    await stream.send('spawn-hooks', 'two', () => {});
    assert.equal(prepared, 1);
    stream.recycle('spawn-hooks', 'test');
    await stream.send('spawn-hooks', 'three', () => {});
    assert.equal(prepared, 2);
  } finally { await stream.closeAndWait('spawn-hooks'); }
  assert.equal(disposed, 1);
});

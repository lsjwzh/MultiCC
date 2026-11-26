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

test('process close retains the frozen timeout, stop, tracking and listener behavior', async () => {
  const api = require('../src/native/binding').getProcessCloser();
  const frozen = require('./helpers/frozen-file-batch27/process-close');
  const { exercise } = require('./helpers/process-close-fixture');
  for (let mode = 0; mode < 8; mode++) for (let timeout = 0; timeout < 6; timeout++) {
    assert.deepEqual(await exercise(api, { mode, timeout }), await exercise(frozen, { mode, timeout }), `${mode}/${timeout}`);
  }
  for (const implementation of [api, frozen]) {
    const closer = implementation.createProcessCloser({ timeoutMs: 10, code: 'SHAPE' });
    assert.deepEqual(Object.keys(closer), ['track', 'wait', 'isClosing', 'drained']);
    assert.deepEqual(Object.entries(closer).map(([key, value]) => [key, value.name, value.length]),
      [['track', 'track', 2], ['wait', 'wait', 2], ['isClosing', 'isClosing', 1], ['drained', 'drained', 1]]);
    assert.equal(Object.prototype.toString.call(closer.wait), '[object AsyncFunction]');
    const sentinel = new Error('number refused');
    await assert.rejects(closer.wait('none', () => assert.fail('stop called'), { timeoutMs: { valueOf() { throw sentinel; } } }), error => error === sentinel);
  }
});

const BRIDGE = 'codex-app-bridge';
const BRIDGE_CMD = require('../src/native/binding').gatewayPath();

function createFixture(name, env = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `multicc-codex-stream-${name}-`));
  const logFile = path.join(root, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const bin = writeFakeAppServer(root);
  const stream = createCodexAppStream();
  const childEnv = { ...process.env, FAKE_CODEX_LOG: logFile, ...env };
  stream.ensure(name, {
    cmd: BRIDGE_CMD,
    cwd: root,
    baseArgs: [BRIDGE, '--codex-bin', bin, '--resident'],
    env: childEnv,
    idleMs: 60_000,
    ...options,
  });
  return {
    root,
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

test('两个子线程独立更新，子线程完成不结束主回合，主回合结束后继续接收后台进度', { timeout: 5000 }, async () => {
  const background = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const fixture = createFixture('child-progress', { FAKE_CODEX_CHILD_SCENARIO: '1' }, {
    idleMs: 50,
    onBackgroundEvent: event => {
      background.push(event);
      if (event.subtype === 'codex_task_done' && event.task_id === 'codex-agent:child-2') resolveDone(event);
    },
  });
  const { stream } = fixture;
  try {
    const sink = collect();
    const main = await stream.send('child-progress', '并行检查', sink.onEvent);
    assert.equal(main.result.params.turn.id, 'turn-1');
    assert.equal(stream.status('child-progress').threadId, 'thread-resident');
    assert.equal(sink.events.filter(e => e.method === 'turn/completed').length, 1);
    assert.equal(sink.events.some(e => e.params?.threadId?.startsWith('child-')), false);
    assert.deepEqual(background.filter(e => e.subtype === 'codex_task_started').map(e => e.task_id),
      ['codex-agent:child-1', 'codex-agent:child-2']);
    assert.ok(background.some(e => e.task_id === 'codex-agent:child-1' && e.status === 'completed'));
    assert.equal(stream.status('child-progress').backgroundActive, true);
    const second = await done;
    assert.equal(second.status, 'failed');
    assert.equal(stream.status('child-progress').backgroundActive, false);
    const resumes = fixture.requests().filter(r => r.method === 'thread/resume');
    assert.deepEqual(resumes.map(r => r.params), [
      { threadId: 'child-1', excludeTurns: true }, { threadId: 'child-2', excludeTurns: true },
    ]);
    assert.equal(sink.events.some(e => e.params?.threadId === 'unrelated-thread'), false);
  } finally { await stream.closeAndWait('child-progress'); }
});

test('关闭仍有子任务的常驻进程会调用退出收尾', { timeout: 5000 }, async () => {
  let exits = 0;
  const fixture = createFixture('child-close', {
    FAKE_CODEX_CHILD_SCENARIO: '1', FAKE_CODEX_CHILD_HOLD_MS: '10000',
  }, { onBackgroundEvent() {}, onExit: () => { exits += 1; } });
  try {
    await fixture.stream.send('child-close', '并行检查', () => {});
    assert.equal(fixture.stream.status('child-close').backgroundActive, true);
  } finally { await fixture.stream.closeAndWait('child-close'); }
  assert.equal(exits, 1);
});

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
    cmd: BRIDGE_CMD,
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

test('idle shutdown fences a new send until exit, then resumes on a fresh child', { timeout: 8000 }, async () => {
  const { stream, root } = createFixture('idle-race', { FAKE_CODEX_IGNORE_TERM: '1' }, { idleMs: 30 });
  try {
    await stream.send('idle-race', 'first', () => {});
    const state = stream.ensure('idle-race', {}), oldPid = state.proc.pid;
    const next = new Promise((resolve, reject) => state.proc.stdin.once('finish', () => {
      assert.equal(stream.status('idle-race').recycling, true);
      stream.send('idle-race', 'during shutdown', () => {}).then(resolve, reject);
    }));
    await next;
    assert.notEqual(stream.status('idle-race').pid, oldPid);
    assert.equal(stream.status('idle-race').threadId, 'thread-resident');
  } finally { await stream.closeAndWait('idle-race'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a close deadline cannot erase the old child or permit an early workspace handoff', { timeout: 8000 }, async () => {
  const { stream, root } = createFixture('join-timeout', { FAKE_CODEX_IGNORE_TERM: '1' });
  const router = require('../src/chat/stream-router').createStreamRouter(stream, stream, stream);
  const w = { id: 'join-workspace', path: root };
  router.ensure('join-timeout', { streamBackend: 'app-server', cwd: root });
  try {
    await router.send('join-timeout', 'first', () => {});
    const pid = router.status('join-timeout').pid;
    router.parkWorkspace('join-timeout', w);
    await assert.rejects(router.closeAndWait('join-timeout', { timeoutMs: 10 }), { code: 'CODEX_APP_STREAM_CLOSE_TIMEOUT' });
    assert.doesNotThrow(() => process.kill(pid, 0));
    await assert.rejects(router.claimWorkspace('next-owner', w), { code: 'workspace_busy' });
    await router.closeAndWait('join-timeout');
    await router.claimWorkspace('next-owner', w);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await router.closeAndWait('join-timeout'); await router.closeAndWait('next-owner'); fs.rmSync(root, { recursive: true, force: true }); }
});


test('历史缺失时新建线程，后续消息复用新线程', async (t) => {
  const name = 'missing-rollout-recovery';
  const f = createFixture(name, {
    FAKE_CODEX_REJECT: 'thread/resume',
    FAKE_CODEX_REJECT_MESSAGE: 'no rollout found for thread id old-thread',
  }, { sessionId: 'old-thread' });
  t.after(() => f.stream.closeAndWait(name));
  const events = [];
  await f.stream.send(name, '继续当前任务', event => events.push(event));
  await f.stream.send(name, '下一条消息');
  assert.deepEqual(f.methods(), ['initialize', 'thread/resume', 'thread/start', 'turn/start', 'turn/start']);
  const reset = events.findIndex(event => event.method === 'multicc/native_session_missing');
  const started = events.findIndex(event => event.method === 'thread/started');
  assert.ok(reset >= 0 && started > reset);
  assert.equal(events[reset].params.threadId, 'old-thread');
  assert.deepEqual(f.requests().filter(r => r.method === 'turn/start').map(r => r.params.threadId),
    ['thread-resident', 'thread-resident']);
});

test('其他恢复错误不能擅自新建线程', async (t) => {
  const name = 'resume-other-error';
  const f = createFixture(name, { FAKE_CODEX_REJECT: 'thread/resume' }, { sessionId: 'old-thread' });
  t.after(() => f.stream.closeAndWait(name));
  await assert.rejects(f.stream.send(name, '继续'), /fixture request rejected/);
  assert.deepEqual(f.methods(), ['initialize', 'thread/resume']);
});

test('清空宿主线程引用会替换常驻进程，不再恢复旧线程', async (t) => {
  const name = 'reset-missing-native-id';
  const f = createFixture(name);
  t.after(() => f.stream.closeAndWait(name));
  await f.stream.send(name, '第一条');
  f.stream.ensure(name, { sessionId: null });
  await f.stream.send(name, '历史删除后继续');
  assert.equal(f.methods().filter(method => method === 'thread/start').length, 2);
  assert.equal(f.methods().includes('thread/resume'), false);
});

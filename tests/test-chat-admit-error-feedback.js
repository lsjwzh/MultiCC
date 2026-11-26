'use strict';

// L0 regression (M3, docs/chat-page-architecture-review.md 五节): admitChatWork
// returning { ok:false, code:'scheduler_not_ready' } was completely ignored by
// callers - the WS handler dropped the value, so the user's message vanished
// with zero feedback: no turn, no error, nothing. The other admission failures
// (auth gates, 消息入队失败) already broadcast their own error frames from
// session-work-host; scheduler_not_ready is the silent one, so this boundary
// emits the error frame itself.
//
// Drives the REAL turn-engine factory with a minimal dep set (only the ports
// touched by admitChatWork plus the construction-time port assertions).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatTurnEngine, deliverAfterPendingMemory } = require('../src/chat/turn-engine-host');
const { createSessionNotices } = require('../src/native/runtime').getSessionNotices();
const { createQueuedTurnPreparation } = require('../src/chat/admission-progress');
const { createTestChatHub } = require('./helpers/native-chat-hub');
const frozenNoticeApi = require('./helpers/frozen-file-batch23/session-notices');

test('notice facade preserves captured ports, durable ordering and sync versus async failures', async () => {
  async function capture(api, mode) {
    const events = [];
    const sentinel = new RangeError('notice sentinel');
    let thenReads = 0;
    const ports = {
      appendChatMessage(id, message) {
        events.push(['append', id, message]);
        if (mode === 'throw') throw sentinel;
        if (mode === 'reject') return Promise.reject(sentinel);
        if (mode === 'resolve') return Promise.resolve(true);
        if (mode === 'resolve-empty') return Promise.resolve(false);
        if (mode === 'thenable') return { get then() { events.push(['then', ++thenReads]); return resolve => { events.push('settle'); resolve(true); }; } };
        if (mode === 'then-getter') return { get then() { events.push('then'); throw sentinel; } };
        if (mode === 'empty') return false;
        return true;
      },
      chatBroadcast(id, frame) { events.push(['broadcast', id, frame]); if (mode === 'broadcast-throw') throw sentinel; },
      now() { events.push('now'); return 123; },
      logger: { warn(...args) { events.push(['warn', ...args]); if (mode === 'warn-throw') throw sentinel; } },
    };
    if (mode === 'no-append') ports.appendChatMessage = null;
    if (mode === 'bad-now') ports.now = null;
    if (mode === 'bad-broadcast') ports.chatBroadcast = 1;
    if (mode === 'warn-throw') ports.appendChatMessage = () => { throw sentinel; };
    const watched = new Proxy(ports, { get(target, key) { events.push(['port', key]); return target[key]; } });
    const notices = api.createSessionNotices(watched);
    watched.now = () => 999;
    let result;
    try { result = notices.notifyLostMessage({ sessionId: mode === 'empty-id' ? '' : 's1', error: { code: 'failed', detail: 'remedy\nnext' } }); }
    catch (error) { return { stage: 'sync', identity: error === sentinel, name: error.name, message: error.message, events }; }
    events.push('returned');
    const promise = result instanceof Promise;
    try { return { value: await result, promise, events }; }
    catch (error) { return { stage: 'async', identity: error === sentinel, name: error.name, message: error.message, events }; }
  }
  for (const mode of ['saved', 'empty', 'throw', 'reject', 'resolve', 'resolve-empty', 'thenable', 'then-getter', 'broadcast-throw', 'warn-throw', 'no-append', 'bad-now', 'bad-broadcast', 'empty-id']) {
    assert.deepEqual(await capture(require('../src/native/runtime').getSessionNotices(), mode), await capture(frozenNoticeApi, mode), mode);
  }
});

test('notice facade retains parameter errors, clock defaults and public function shapes', () => {
  const current = require('../src/native/runtime').getSessionNotices();
  function observe(run) { try { return { value: run() }; } catch (error) { return { name: error.name, message: error.message }; } }
  assert.deepEqual(Object.keys(current), Object.keys(frozenNoticeApi));
  for (const name of Object.keys(current)) {
    assert.equal(current[name].name, frozenNoticeApi[name].name);
    assert.equal(current[name].length, frozenNoticeApi[name].length);
  }
  for (const value of [undefined, null, false, 0, 1n, Symbol('port'), '']) {
    assert.deepEqual(observe(() => current.createSessionNotices(value) && 'created'), observe(() => frozenNoticeApi.createSessionNotices(value) && 'created'));
    for (const name of ['stuckDeliveryText', 'heldBackgroundText', 'heldCapText']) assert.deepEqual(observe(() => current[name](value)), observe(() => frozenNoticeApi[name](value)));
    for (const name of ['notifyLostMessage', 'notifyStuckDelivery', 'notifyHoldCap']) {
      assert.deepEqual(observe(() => current.createSessionNotices({})[name](value)), observe(() => frozenNoticeApi.createSessionNotices({})[name](value)));
    }
  }
  const original = Date.now;
  try {
    for (const api of [current, frozenNoticeApi]) {
      const appended = [];
      Date.now = () => 51;
      const notices = api.createSessionNotices({ appendChatMessage: (_id, message) => { appended.push(message); return true; } });
      Date.now = () => 99;
      assert.equal(notices.notifyHoldCap({ sessionId: 's1', minutes: 1 }), true);
      assert.equal(appended[0].ts, 51);
    }
  } finally { Date.now = original; }
});

test('notice warning getters keep their original exception boundary', async () => {
  async function capture(api, async) {
    const sentinel = new Error('warning getter');
    const failure = { get message() { throw sentinel; } };
    const notices = api.createSessionNotices({
      appendChatMessage: () => async ? Promise.reject(failure) : (() => { throw failure; })(),
      logger: { warn() { throw new Error('must not reach logger'); } },
    });
    let pending;
    try { pending = notices.notifyHoldCap({ sessionId: 's', minutes: 1 }); }
    catch (error) { assert.equal(error, sentinel); return 'sync'; }
    await assert.rejects(pending, error => error === sentinel);
    return 'async';
  }
  for (const async of [false, true]) assert.equal(await capture(require('../src/native/runtime').getSessionNotices(), async), await capture(frozenNoticeApi, async));
});

test('session notice text matches the frozen host for coercions, UTF-16 and minute boundaries', () => {
  const previous = require('./helpers/frozen-session-notices');
  const current = require('../src/native/runtime').getSessionNotices();
  function observe(api, method, makeInput) {
    const trace = [];
    const sentinel = new Error('notice getter');
    try {
      return { value: api[method](makeInput(trace, sentinel)), trace };
    } catch (error) {
      return { type: error.name, message: error.message, sentinel: error === sentinel, trace };
    }
  }
  function compare(method, makeInput) {
    assert.deepEqual(observe(current, method, makeInput), observe(previous, method, makeInput));
  }
  for (const value of [undefined, null, false, 0n, -Infinity, NaN, -1, 0, 0.5, 1, 1.5,
    29_999.9999, 30_000, 89_999.9999, 90_000, 1e25, Infinity, '60000', Symbol('time')]) {
    compare('heldBackgroundText', () => ({ waitedMs: value }));
    compare('heldCapText', () => ({ minutes: value }));
    for (const reason of ['delivery_locked', 'session_busy', null, '\ud800']) {
      compare('stuckDeliveryText', () => ({ reason, reasons: ['a', null, '\udfff'], waitedMs: value }));
    }
  }
  for (const detail of ['', '\uFEFF\n\t', '\u00a0多行\n修复\ud800\uFEFF', Symbol('detail')]) {
    for (const message of [null, '\n第二行', '第一行\r\n第二行', '\udfff', Symbol('msg')]) {
      compare('lostMessageText', trace => ({
        get code() {
          trace.push('code');
          return { toString() { trace.push('stringify code'); return 'code-' + trace.length; } };
        },
        get detail() { trace.push('detail'); return detail; },
        get message() { trace.push('message'); return message; },
      }));
    }
  }
  compare('lostMessageText', () => ({ code: Symbol('code') }));
  compare('lostMessageText', (trace, sentinel) => ({
    get detail() { trace.push('detail'); throw sentinel; },
  }));
  for (const next of [-2.5, Infinity, NaN]) {
    compare('heldCapText', trace => ({
      minutes: { valueOf() { trace.push('number'); return trace.length === 1 ? 2 : next; } },
    }));
  }
  compare('stuckDeliveryText', trace => ({
    reasons: { length: 1, join(s) { trace.push(s); return { toString() { trace.push('list'); return 'x'; } }; } },
    waitedMs: { valueOf() { trace.push('time'); return 45_000; } },
  }));
});

const noop = () => {};

// Regression scaffold for the read-only history ports. `viewChatHistory` hands
// back the runtime cache array itself (the real contract: no copy, no freeze);
// `loadChatHistory` returns a deep clone. Any changed call site must use the
// view without mutating what it was handed.
function historyProbe(shared) {
  const calls = { view: 0, load: 0 };
  const snapshot = JSON.parse(JSON.stringify(shared));
  return {
    calls,
    snapshot,
    viewChatHistory: () => { calls.view += 1; return shared; },
    loadChatHistory: () => { calls.load += 1; return JSON.parse(JSON.stringify(shared)); },
    assertOnlyRead: () => {
      assert.ok(calls.view > 0, 'the path read the live view');
      assert.equal(calls.load, 0, 'the path never paid for a deep clone');
      assert.deepEqual(shared, snapshot, 'the cached transcript was not mutated');
    },
  };
}

function baseEngineDeps(overrides = {}) {
  return {
    getExperimentalTuiChatRuntime: () => null,
    replay: createTestChatHub().hub,
    isShuttingDown: () => false,
    cwdForSession: () => '/tmp',
    savePersistedSessionsBestEffort: () => {},
    chatTurnPreparationRuntime: { claim: () => ({ ok: true }), settle: noop },
    turnProgressHeartbeat: { stop: noop },
    logger: { warn: noop, info: noop, error: noop },
    chatBroadcast: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
    appendChatMessage: () => true,
    // Stops the turn right after the history read under test, before any CLI
    // process or provider call.
    cancelClassify() { throw new Error('history-probe-stop'); },
    ...overrides,
  };
}

test('turn admission counts and restores the live history view, never a clone', async t => {
  t.mock.method(console, 'error', noop);
  const shared = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'older reply' },
  ];
  const probe = historyProbe(shared);
  let restored = null;
  const engine = createChatTurnEngine(baseEngineDeps({
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    chatSessions: new Map(),
    taskContextHost: { turnOptions: opts => opts, restore: history => { restored = history; return null; } },
    viewChatHistory: probe.viewChatHistory,
    loadChatHistory: probe.loadChatHistory,
  }));
  await engine.runChatTurn('s1', 'hello', { taskId: 'task-1' });
  probe.assertOnlyRead();
  assert.equal(restored, shared,
    'the same array that seeded chatTurnCount also fed taskContextHost.restore');
});

test('opencode context rotation builds its checkpoint from the live history view', async t => {
  t.mock.method(console, 'error', noop);
  const shared = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'older reply' },
  ];
  const probe = historyProbe(shared);
  const persisted = { id: 's1', kind: 'chat', cli: 'opencode', cliSessionId: 'native-1' };
  const engine = createChatTurnEngine(baseEngineDeps({
    persistedSessions: new Map([['s1', persisted]]),
    chatSessions: new Map([['s1', { cli: 'opencode', chatTurnCount: 2 }]]),
    // A live chat state exists, so admission does not pre-read history: the
    // rotation's lazy history() accessor is the only reader.
    opencodeContextGuard: {
      enforce: async () => ({
        action: 'rotate', cliSessionId: 'native-2', reason: 'context_used',
        message: 'rotate', tokensTotal: 9, contextLimit: 10, ratio: 0.9, threshold: 0.8,
      }),
    },
    rememberActiveCliState: noop,
    appendEvent: noop,
    taskContextHost: { turnOptions: opts => opts, restore: () => null },
    viewChatHistory: probe.viewChatHistory,
    loadChatHistory: probe.loadChatHistory,
  }));
  await engine.runChatTurn('s1', 'hello', { taskId: 'task-1' });
  probe.assertOnlyRead();
  assert.equal(persisted.pendingCliHandoff?.status, 'pending',
    'the rotation still persisted the handoff checkpoint');
});

test('dispatch recovery scans the live history view', () => {
  const shared = [
    { role: 'user', content: 'go', originDispatchId: 'op-1', turnId: 'tu-1' },
    { role: 'assistant', content: 'done', turnId: 'tu-1' },
  ];
  const probe = historyProbe(shared);
  const engine = createChatTurnEngine(baseEngineDeps({
    persistedSessions: new Map(),
    chatSessions: new Map(),
    viewChatHistory: probe.viewChatHistory,
    loadChatHistory: probe.loadChatHistory,
  }));
  assert.deepEqual(engine.recoverDispatchOperation({ id: 'op-1', spec: { chatId: 's1' } }),
    { completed: true, text: 'done' });
  probe.assertOnlyRead();
});

test('chat websocket session creation reads the live history view', async () => {
  const shared = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'older reply' },
  ];
  const probe = historyProbe(shared);
  let restored = null;
  const capture = new Error('session-created');
  // Capture the freshly built chat state by making the cache write observable,
  // then stop before the replay/WS frames that need the full host.
  const chatSessions = { get: () => undefined, set: () => { throw capture; } };
  const engine = createChatTurnEngine(baseEngineDeps({
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    chatSessions,
    invalidSessions: new Map(),
    taskContextHost: { restore: history => { restored = history; return null; } },
    sendWs: noop,
    viewChatHistory: probe.viewChatHistory,
    loadChatHistory: probe.loadChatHistory,
  }));
  await assert.rejects(
    () => engine.handleChatWs({}, {}, new URL('http://localhost/ws/chat?session=s1')),
    error => error === capture,
  );
  probe.assertOnlyRead();
  assert.equal(restored, shared,
    'the same cached array seeded _currentTaskId');
});

test('后台准备等路由结论落定后才放行，路由或记忆失败保留兜底与反馈', async () => {
  let release, ready = false;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [], calls = [];
  const prepare = createQueuedTurnPreparation({
    prepareRouting: (...args) => { calls.push(args); return gate; },
    getPendingMemory: () => Promise.reject(new Error('记忆整理失败')),
    broadcast: (id, frame) => events.push({ id, frame }),
  });
  const pending = prepare({ sessionId: 's1', text: '消息', opts: { directUserInput: true, clientMsgId: 'm1' } }).then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  assert.deepEqual(calls, [['s1', '消息', 'm1']]);
  release(); await pending;
  assert.equal(ready, true);
  assert.equal(events.at(-1).frame.reason, 'memory_distill_failed');
  assert.equal(events.at(-1).frame.clientMsgId, 'm1');
  const fallback = createQueuedTurnPreparation({ prepareRouting: () => { throw new Error('路由不可用'); } });
  await fallback({ sessionId: 's1', text: '继续', opts: { directUserInput: true, taskShellReceiptId: 'r1' } });
  await prepare({ sessionId: 's1', text: '后台通知', opts: {} });
  await prepare({ sessionId: 's1', text: '回答确认', opts: { directUserInput: true, taskShellControl: { intent: 'answer' } } });
  assert.equal(calls.length, 1, '后台通知不额外调用用户输入路由');
});

function makeEngine({ hostAdmit } = {}) {
  const broadcasts = [];
  const warns = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
    replay: createTestChatHub().hub,
    persistedSessions: new Map([['s1', { id: 'x', kind: 'chat', cli: 'codex' }]]),
    chatSessions: new Map(),
    getSessionWorkHost: () => ({ admit: hostAdmit }),
    logger: { warn: (...args) => warns.push(args), info: noop, error: noop },
    chatBroadcast: (id, payload) => broadcasts.push({ id, payload }),
    // Construction-time port assertions only; never reached by these tests.
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  return { engine, broadcasts, warns };
}

test('task-shell admission can prepare Jev with the persisted session before its turn starts', async () => {
  const session = { id: 's1', kind: 'chat', cli: 'codex', providerSelection: { mode: 'auto' } };
  const calls = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
    replay: createTestChatHub().hub,
    persistedSessions: new Map([['s1', session]]),
    chatSessions: new Map(),
    autoProviderRuntime: { prepareAdmission: args => { calls.push(args); return Promise.resolve(); } },
    logger: { warn: noop, info: noop, error: noop }, chatBroadcast: noop,
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  await engine.prepareQueuedTurn({ sessionId: 's1', text: 'Fix a typo',
    opts: { directUserInput: true, clientMsgId: 'receipt-1', taskShellReceiptId: 'receipt-1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, session);
  assert.equal(calls[0].text, 'Fix a typo');
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].clientMsgId, 'receipt-1');
  assert.equal(typeof calls[0].providers.listProviders, 'function');
  assert.equal(engine.prepareAutoProviderAdmission('missing', 'Fix a typo', 'receipt-2'), null);
});

test('admitChatWork with no work host emits an error frame and returns scheduler_not_ready', async () => {
  const broadcasts = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
    replay: createTestChatHub().hub,
    persistedSessions: new Map([['s1', { id: 'x', kind: 'chat', cli: 'codex' }]]),
    chatSessions: new Map(),
    getSessionWorkHost: () => null,
    logger: { warn: noop, info: noop, error: noop },
    chatBroadcast: (id, payload) => broadcasts.push({ id, payload }),
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.deepEqual(result, { ok: false, code: 'scheduler_not_ready' });
  const errorFrames = broadcasts.filter(b => b.payload.type === 'error');
  assert.equal(errorFrames.length, 1, 'exactly one error frame reaches the frontend');
  assert.equal(errorFrames[0].id, 's1');
  assert.equal(errorFrames[0].payload.code, 'scheduler_not_ready');
  assert.ok(errorFrames[0].payload.error, 'the frame carries a human-readable message');
});

test('admitChatWork surfaces the work host\'s own silent scheduler_not_ready', async () => {
  // session-work-host returns this shape when its scheduler runtime is not
  // wired - equally silent, so the engine boundary must cover it too.
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: false, code: 'scheduler_not_ready' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.equal(result.code, 'scheduler_not_ready');
  assert.equal(broadcasts.filter(b => b.payload.type === 'error').length, 1,
    'the host-internal not-ready path also reaches the frontend');
});

test('admitChatWork stays silent for admissions the host already reported', async () => {
  // 消息入队失败 / auth-gate failures broadcast their own error frame from
  // session-work-host; a second generic frame here would double the user-facing
  // error. Only scheduler_not_ready is this boundary's responsibility.
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: false, code: 'configuration_required' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.equal(result.code, 'configuration_required');
  assert.equal(broadcasts.filter(b => b.payload.type === 'error').length, 0,
    'no duplicate error frame for self-reporting admission failures');
});

test('admitChatWork passes a successful admission through untouched', async () => {
  const { engine, broadcasts } = makeEngine({
    hostAdmit: async () => ({ ok: true, entryId: 'e-1' }),
  });
  const result = await engine.admitChatWork('s1', 'hello', {});
  assert.deepEqual(result, { ok: true, entryId: 'e-1' });
  assert.equal(broadcasts.length, 0, 'no error frame on the happy path');
});

test('pending memory reports progress before delivery and then delivers exactly once', async () => {
  let resolveMemory;
  const pendingMemory = new Promise(resolve => { resolveMemory = resolve; });
  const progress = [];
  let deliveries = 0;
  const resultPromise = deliverAfterPendingMemory(
    pendingMemory,
    event => progress.push(event),
    async () => { deliveries += 1; return { ok: true }; },
  );

  await Promise.resolve();
  assert.deepEqual(progress, [{ state: 'waiting', reason: 'memory_distill_pending' }]);
  assert.equal(deliveries, 0, 'delivery waits until memory distillation settles');
  resolveMemory({ updated: true });
  assert.deepEqual(await resultPromise, { ok: true });
  assert.deepEqual(progress, [
    { state: 'waiting', reason: 'memory_distill_pending' },
    { state: 'ready' },
  ]);
  assert.equal(deliveries, 1);
});

test('failed or skipped memory distillation remains visible and never eats the message', async t => {
  const cases = [
    { name: 'resolved error', pending: Promise.resolve({ updated: false, error: '502' }), reason: 'memory_distill_failed' },
    { name: 'rejected promise', pending: Promise.reject(new Error('offline')), reason: 'memory_distill_failed' },
    { name: 'explicit skip', pending: Promise.resolve({ updated: false, skipped: 'aux unhealthy' }), reason: 'memory_distill_skipped' },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      const progress = [];
      let deliveries = 0;
      await deliverAfterPendingMemory(current.pending, event => progress.push(event), async () => { deliveries += 1; });
      assert.equal(deliveries, 1);
      assert.deepEqual(progress.at(-1), {
        state: 'skipped',
        reason: current.reason,
        ...(current.name === 'resolved error' ? { rootCause: '502' } : {}),
        ...(current.name === 'rejected promise' ? { rootCause: 'offline' } : {}),
      });
    });
  }
});

test('delivery failure replaces loading with a terminal admission state', async () => {
  const progress = [];
  await assert.rejects(
    deliverAfterPendingMemory(
      Promise.resolve({ updated: true }),
      event => progress.push(event),
      async () => { throw new Error('scheduler unavailable'); },
    ),
    /scheduler unavailable/,
  );
  assert.deepEqual(progress.at(-1), {
    state: 'failed',
    reason: 'message_delivery_failed',
    rootCause: 'scheduler unavailable',
  });
});

test('a rejected admission result also replaces loading with a terminal state', async () => {
  const progress = [];
  const result = await deliverAfterPendingMemory(
    Promise.resolve({ updated: true }),
    event => progress.push(event),
    async () => ({ ok: false, code: 'session_not_found' }),
  );
  assert.deepEqual(result, { ok: false, code: 'session_not_found' });
  assert.deepEqual(progress.at(-1), {
    state: 'failed', reason: 'message_delivery_rejected', code: 'session_not_found',
  });
});

// The same feedback duty, one layer later: once the message is in the outbox
// there is no client waiting on a progress frame any more, so a delivery that
// becomes terminal has to be written into the transcript instead. This is the
// half of the same class of bug that used to leave a task "卡在 queued" with
// nothing but lastError in the logs.
test('a lost message is written into the transcript and broadcast, once', () => {
  const appended = [], broadcasts = [];
  const notice = createSessionNotices({
    appendChatMessage: (sessionId, message) => { appended.push({ sessionId, message }); return true; },
    chatBroadcast: (sessionId, payload) => broadcasts.push({ sessionId, payload }),
    now: () => 1234,
  });
  notice.notifyLostMessage({ sessionId: 's1', error: Object.assign(new Error('该目录体积过大（超过 2GB）\n多行细节不进这一行'), { code: 'workspace_repository_not_ready' }) });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].sessionId, 's1');
  assert.equal(appended[0].message.role, 'system');
  assert.equal(appended[0].message.ts, 1234);
  assert.match(appended[0].message.content, /workspace_repository_not_ready/);
  assert.match(appended[0].message.content, /该目录体积过大/);
  assert.doesNotMatch(appended[0].message.content, /多行细节/, 'lastError prose stays one line');
  assert.deepEqual(broadcasts.at(-1), {
    sessionId: 's1',
    payload: { type: 'system', subtype: 'notice', message: appended[0].message.content },
  });
});

test('a history append that fails is not broadcast as if it had been saved', () => {
  const broadcasts = [];
  const notice = createSessionNotices({
    appendChatMessage: () => false,
    chatBroadcast: (sessionId, payload) => broadcasts.push({ sessionId, payload }),
  });
  notice.notifyLostMessage({ sessionId: 's1', error: new Error('boom') });
  assert.deepEqual(broadcasts, [], 'a live line with no durable record would be gone on reload');
});

test('the notice carries the whole remedy, not just the first line of it', () => {
  // The report's last ask was a stuck task that names its cause *and* its fix.
  // `message` is deliberately one line (it is also what lastError returns), so
  // anything read by a human has to come from `detail`.
  const appended = [];
  const notice = createSessionNotices({
    appendChatMessage: (sessionId, message) => { appended.push(message); return true; },
  });
  notice.notifyLostMessage({
    sessionId: 's1',
    error: Object.assign(new Error('git 无权访问该目录：macOS 的隐私保护会拦截…'), {
      code: 'workspace_repository_not_ready',
      detail: 'git 无权访问该目录：macOS 的隐私保护会拦截…\n要授权的对象取决于你现在的启动方式：\n· 双击 MultiCC.app 启动：给这个 App 授权',
    }),
  });
  assert.match(appended[0].content, /要授权的对象取决于你现在的启动方式/,
    'the steps the user has to take survive into the transcript');
  assert.match(appended[0].content, /修好后请重新发送/);
});

// The same complaint one step earlier than a dead letter: the message is not
// lost, it simply never starts. Nothing on screen said so — only a repeated
// `delivery_skipped` line in the log — which is what the report saw for thirteen
// messages in a row.
test('a stuck delivery names the busy reason and the way out', () => {
  const appended = [], broadcasts = [];
  const notice = createSessionNotices({
    appendChatMessage: (sessionId, message) => { appended.push(message); return true; },
    chatBroadcast: (sessionId, payload) => broadcasts.push(payload),
    now: () => 4242,
  });
  notice.notifyStuckDelivery({ sessionId: 's1', reasons: ['workspace_occupied'], waitedMs: 90_000 });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].role, 'system');
  assert.equal(appended[0].ts, 4242);
  assert.match(appended[0].content, /workspace_occupied/, 'the machine reason survives verbatim');
  assert.match(appended[0].content, /2 分钟/, 'the wait is in the units the user experiences');
  assert.match(appended[0].content, /立刻插入/, 'the remedy is the button that exists in the queue');
  assert.deepEqual(broadcasts, [{ type: 'system', subtype: 'notice', message: appended[0].content }]);
  // An empty reason list still has to say something true rather than nothing —
  // the skip reason itself, now that it is carried alongside the reasons.
  appended.length = 0;
  notice.notifyStuckDelivery({ sessionId: 's1', reasons: [], waitedMs: 60_000 });
  assert.match(appended[0].content, /session_busy/);
});

test('a stuck delivery behind an unsettled previous delivery is not called a busy workspace', () => {
  // `delivery_locked` is the other silent skip shape: the session's previous
  // delivery never settled, so nothing new can start, yet no workspace is
  // held and no turn is running. Calling that 「工作区被占用」 would be a lie.
  const appended = [];
  const notice = createSessionNotices({
    appendChatMessage: (sessionId, message) => { appended.push(message); return true; },
  });
  notice.notifyStuckDelivery({ sessionId: 's1', reason: 'delivery_locked', reasons: [], waitedMs: 120_000 });
  assert.match(appended[0].content, /上一条投递尚未结算（delivery_locked）/);
  assert.doesNotMatch(appended[0].content, /工作区被占用/);
  assert.match(appended[0].content, /立刻插入/, 'the escape hatch is the same button either way');
});

// The turn transport fires notices without awaiting them (the stuck-delivery
// notice sits inside a synchronous try/catch). Once the append became async,
// a rejection there escaped as an unhandled rejection — which exits the whole
// server. `say()` must absorb it at the source and resolve `false`.
test('a notice whose durable append rejects is not an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const warnings = [];
    const rejected = createSessionNotices({
      appendChatMessage: () => Promise.reject(new Error('disk full')),
      chatBroadcast: () => {},
      logger: { warn: (...args) => warnings.push(args) },
    });
    // Fire-and-forget exactly like `notifyStuckDelivery` in the orchestration
    // runtime, which only wraps the call in a synchronous try/catch.
    rejected.notifyStuckDelivery({ sessionId: 's1', reasons: ['workspace_occupied'], waitedMs: 1000 });
    // A synchronous throw from the port is absorbed too.
    const thrown = createSessionNotices({
      appendChatMessage: () => { throw new Error('disk gone'); },
      logger: { warn: (...args) => warnings.push(args) },
    });
    assert.equal(thrown.notifyLostMessage({ sessionId: 's1', error: new Error('boom') }), false);
    // The promised result is a real verdict, never a rejection.
    const held = createSessionNotices({
      appendChatMessage: () => Promise.resolve(false),
      logger: { warn: () => {} },
    });
    assert.equal(await held.notifyHoldCap({ sessionId: 's1', minutes: 61 }), false);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'no append rejection reaches the process handler');
    assert.equal(warnings.filter(args => args[0] === 'chat_notice_persist_failed').length, 2);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

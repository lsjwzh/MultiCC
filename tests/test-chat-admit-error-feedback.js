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
const { createChatTurnEngine, deliverAfterPendingMemory } = require('../src/chat/turn-engine');
const { createSessionNotices } = require('../src/chat/session-notices');

const noop = () => {};

function makeEngine({ hostAdmit } = {}) {
  const broadcasts = [];
  const warns = [];
  const engine = createChatTurnEngine({
    getExperimentalTuiChatRuntime: () => null,
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
    persistedSessions: new Map([['s1', session]]),
    chatSessions: new Map(),
    autoProviderRuntime: { prepareAdmission: args => { calls.push(args); return Promise.resolve(); } },
    logger: { warn: noop, info: noop, error: noop }, chatBroadcast: noop,
    cancelClassify: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
  });
  await engine.prepareAutoProviderAdmission('s1', 'Fix a typo', 'receipt-1');
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

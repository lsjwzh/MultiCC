'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { BusinessPushRequestError, browserPayloadOf } = require('../src/push/business');
const { createPushRuntime, redactClassifierTail, stripAnsi, CLASSIFY_PROMPT } = require('../src/push/runtime');
const { mountPushHostRoute, HOST_PATH } = require('../src/routes/push-host');

// The public /api/push/* DTOs now live in Rust (native/gateway/src/app/
// push_routes.rs, pinned by native/gateway/tests/push_routes.rs). These tests
// exercise the Node side of the split: the host port
// (POST /api/__host/push) reads the in-process Maps, drives the real device
// stores and senders, and returns the raw values or rendered replies Rust
// needs. No real FCM/Bark/webhook endpoint is contacted.
function createHostApp() {
  const routes = new Map();
  return { routes, post: (path, handler) => routes.set(`POST ${path}`, handler) };
}

async function callHost(app, body, options = {}) {
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing POST ${HOST_PATH}`);
  let resolveResponse;
  const completed = new Promise(resolve => { resolveResponse = resolve; });
  const response = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) {
      this.body = value;
      this.headersSent = true;
      resolveResponse();
      return this;
    },
  };
  handler({ local: options.local !== false, body }, response);
  await completed;
  return response;
}

function mountHost(harness) {
  const app = createHostApp();
  mountPushHostRoute(app, {
    push: harness.push,
    businessPush: harness.businessPush,
    isLocal: req => req.local === true,
    logger: harness.state.logger,
    now: () => harness.state.time,
  });
  return app;
}

function createHarness(options = {}) {
  const state = {
    time: options.time ?? 10_000,
    timers: [],
    cleared: [],
    auxGets: 0,
    auxCalls: [],
    dispatches: [],
    taskWrites: [],
    pushCalls: [],
    businessPushCalls: [],
    barkCalls: [],
    webhookCalls: [],
    saves: 0,
    logs: [],
    warnings: [],
  };
  const push = {
    subscriptions: new Map(),
    cfg: { BARK_URL: '', WEBHOOK_URL: '' },
    globalStats: {},
    async saveSubscriptions() {
      state.saves++;
      if (options.saveError) throw options.saveError;
    },
    async sendPushToAll(payload) {
      state.pushCalls.push(payload);
      if (options.pushError) throw options.pushError;
    },
    sendBarkNotification(...args) {
      state.barkCalls.push(args);
      if (options.barkError) throw options.barkError;
    },
    sendWebhookNotification(payload) {
      state.webhookCalls.push(payload);
      if (options.webhookError) throw options.webhookError;
    },
  };
  const sessions = new Map(options.sessions || [['term', { cwd: '/a/very/long/workspace/path/that/exceeds/thirty/chars', clients: new Set() }]]);
  const persistedSessions = new Map(options.persistedSessions || [['term', { id: 'term', dirId: 'dir', taskState: {} }]]);
  const workspaceClients = new Map(options.workspaceClients || []);
  const chatSessions = new Map(options.chatSessions || [['term', { id: 'chat' }]]);
  const aux = {
    enqueue(request) {
      state.auxCalls.push(request);
      if (options.auxDeferred) return options.auxDeferred.promise;
      if (options.auxError) return Promise.reject(options.auxError);
      return Promise.resolve({ text: 'terminal goal\n验证中\nD' });
    },
  };
  const timers = {
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      state.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { state.cleared.push(timer); },
  };
  const defaultBusinessResult = {
    statusCode: 200,
    body: {
      ok: true,
      delivered: true,
      deduped: false,
      dedupe_persisted: true,
      subscriber_count: 2,
      delivery_count: 2,
      failure_count: 0,
      stale_count: 0,
      remaining_subscriber_count: 2,
    },
  };
  const businessPush = {
    async notify(payload) {
      state.businessPushCalls.push(payload);
      if (options.businessPushError) throw options.businessPushError;
      return options.businessPushResult || defaultBusinessResult;
    },
  };
  const runtime = createPushRuntime({
    push,
    businessPush,
    sessions,
    persistedSessions,
    workspaceClients,
    chatSessions,
    getAuxQueue() { state.auxGets++; return aux; },
    getTaskState(persisted) { return persisted.taskState || {}; },
    setTaskState(id, patch) {
      state.taskWrites.push({ id, patch });
      const persisted = persistedSessions.get(id);
      if (persisted) persisted.taskState = { ...(persisted.taskState || {}), ...patch };
    },
    parseClassifyResult(text) {
      const lines = text.split('\n');
      return { goal: lines[0], phase: lines[1], state: lines[2] === 'D' ? 'completed' : 'waiting' };
    },
    dispatchStateAction(parsed, context) { state.dispatches.push({ parsed, context }); },
    timers,
    now: () => state.time,
    idleMs: 25,
    minChars: 5,
    cooldownMs: 100,
    logger: (state.logger = {
      log(message) { state.logs.push(message); },
      warn(message) { state.warnings.push(message); },
      error(message) { state.warnings.push(message); },
    }),
  });
  return { runtime, state, push, businessPush, sessions, persistedSessions, workspaceClients };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

const VALID_BUSINESS_PUSH = Object.freeze({
  title: '策略提醒测试',
  body: '安全验收，不含真实交易建议',
  type: 'strategy-test',
  tag: 'strategy-test-us-AAPL',
  url: '/manage',
  dedupeKey: 'us:strategy:AAPL:BUY:2026-08-08T03:55:00+08:00',
});

test('host port preserves subscribe, delete, validate, test, Bark and Webhook side effects', async () => {
  const harness = createHarness();
  const app = mountHost(harness);

  assert.deepEqual((await callHost(app, { op: 'subscribe', body: {} })).body,
    { ok: true, value: { status: 400, body: { error: 'Invalid subscription' } } });
  assert.equal(harness.state.saves, 0);

  assert.deepEqual((await callHost(app, {
    op: 'subscribe', body: { endpoint: 'https://push.test/one', locale: 'en' },
  })).body, { ok: true, value: { ok: true } });
  assert.equal(harness.state.saves, 1);
  assert.equal(harness.push.subscriptions.size, 1);

  assert.deepEqual((await callHost(app, {
    op: 'validate', endpoint: 'https://push.test/one',
  })).body, { ok: true, value: { known: true } });

  assert.deepEqual((await callHost(app, { op: 'test' })).body,
    { ok: true, value: { subscribers: 1 } });
  assert.equal(harness.state.pushCalls.length, 1);
  assert.equal(harness.state.barkCalls.length, 1);
  assert.equal(harness.state.webhookCalls.length, 1);

  assert.deepEqual((await callHost(app, { op: 'test-bark' })).body,
    { ok: true, value: { configured: false } });
  harness.push.cfg.BARK_URL = 'https://bark.test';
  assert.deepEqual((await callHost(app, { op: 'test-bark' })).body,
    { ok: true, value: { configured: true, ok: true } });
  assert.deepEqual((await callHost(app, { op: 'test-webhook' })).body,
    { ok: true, value: { configured: false } });
  harness.push.cfg.WEBHOOK_URL = 'https://hook.test';
  assert.deepEqual((await callHost(app, { op: 'test-webhook' })).body,
    { ok: true, value: { configured: true } });

  assert.deepEqual((await callHost(app, {
    op: 'unsubscribe', body: { endpoint: 'https://push.test/one' },
  })).body, { ok: true, value: { ok: true } });
  assert.equal(harness.push.subscriptions.size, 0);
  assert.equal(harness.state.saves, 2);
});

test('notify op delegates once to the validated business push service and returns its reply', async () => {
  const harness = createHarness();
  const app = mountHost(harness);

  const response = await callHost(app, { op: 'notify', body: VALID_BUSINESS_PUSH });
  assert.deepEqual(response.body, {
    ok: true,
    value: {
      status: 200,
      body: {
        ok: true,
        delivered: true,
        deduped: false,
        dedupe_persisted: true,
        subscriber_count: 2,
        delivery_count: 2,
        failure_count: 0,
        stale_count: 0,
        remaining_subscriber_count: 2,
      },
    },
  });
  assert.deepEqual(harness.state.businessPushCalls, [VALID_BUSINESS_PUSH]);
  assert.equal(harness.state.pushCalls.length, 0,
    'the route must not bypass the validated business push service');
  assert.deepEqual(browserPayloadOf(harness.state.businessPushCalls[0]), {
    title: VALID_BUSINESS_PUSH.title,
    body: VALID_BUSINESS_PUSH.body,
    type: VALID_BUSINESS_PUSH.type,
    tag: VALID_BUSINESS_PUSH.tag,
    url: VALID_BUSINESS_PUSH.url,
  });
  assert.equal(Object.hasOwn(browserPayloadOf(harness.state.businessPushCalls[0]), 'dedupeKey'), false,
    'the idempotency key is server metadata, not browser-controlled notification data');
});

test('notify op maps validation and idempotency errors without leaking details', async () => {
  for (const expected of [
    {
      error: new BusinessPushRequestError('UNKNOWN_FIELD', 'actions'),
      status: 400,
      body: {
        ok: false,
        delivered: false,
        deduped: false,
        error: 'UNKNOWN_FIELD',
        field: 'actions',
      },
    },
    {
      error: new BusinessPushRequestError('IDEMPOTENCY_KEY_REUSE', 'dedupeKey'),
      status: 409,
      body: {
        ok: false,
        delivered: false,
        deduped: false,
        error: 'IDEMPOTENCY_KEY_REUSE',
        field: 'dedupeKey',
      },
    },
  ]) {
    const harness = createHarness({ businessPushError: expected.error });
    const app = mountHost(harness);
    const response = await callHost(app, { op: 'notify', body: VALID_BUSINESS_PUSH });
    assert.deepEqual(response.body, { ok: true, value: { status: expected.status, body: expected.body } });
    assert.equal(harness.state.businessPushCalls.length, 1);
  }
});

test('notify op preserves empty-subscriber and incomplete-delivery status', async () => {
  for (const expected of [
    {
      statusCode: 503,
      body: {
        ok: false,
        delivered: false,
        deduped: false,
        subscriber_count: 0,
        delivery_count: 0,
        failure_count: 0,
        stale_count: 0,
        remaining_subscriber_count: 0,
        error: 'NO_PUSH_SUBSCRIBERS',
      },
    },
    {
      statusCode: 502,
      body: {
        ok: false,
        delivered: false,
        deduped: false,
        subscriber_count: 4,
        delivery_count: 3,
        failure_count: 1,
        stale_count: 0,
        remaining_subscriber_count: 4,
        error: 'PUSH_DELIVERY_INCOMPLETE',
        partial: true,
      },
    },
  ]) {
    const harness = createHarness({ businessPushResult: expected });
    const app = mountHost(harness);
    const response = await callHost(app, { op: 'notify', body: VALID_BUSINESS_PUSH });
    assert.deepEqual(response.body, { ok: true, value: { status: expected.statusCode, body: expected.body } });
  }
});

test('host port contains unknown failures behind a stable 500 and logs the op', async () => {
  const harness = createHarness({
    businessPushError: new Error('/Users/alice/private token=business-push-secret'),
  });
  const app = mountHost(harness);
  const response = await callHost(app, { op: 'notify', body: VALID_BUSINESS_PUSH });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'internal_error' });
  assert.match(harness.state.warnings.join('\n'), /notify failed/);
  assert.equal(harness.state.businessPushCalls.length, 1);
});

test('subscribe/delete roll back the in-memory Map when the save fails', async () => {
  const saveHarness = createHarness({
    saveError: new Error('Authorization: Bearer push-secret'),
  });
  const saveApp = mountHost(saveHarness);
  const saveFailed = await callHost(saveApp, { op: 'subscribe', body: { endpoint: 'x' } });
  assert.equal(saveFailed.statusCode, 500);
  assert.equal(saveHarness.push.subscriptions.has('x'), false,
    'failed subscribe rolls back its in-memory mutation');

  saveHarness.push.subscriptions.set('existing', { endpoint: 'existing' });
  const deleteFailed = await callHost(saveApp, {
    op: 'unsubscribe', body: { endpoint: 'existing' },
  });
  assert.equal(deleteFailed.statusCode, 500);
  assert.equal(saveHarness.push.subscriptions.has('existing'), true,
    'failed delete restores its in-memory subscription');
});

test('host port gates non-loopback callers and unknown operations', async () => {
  const harness = createHarness();
  const app = mountHost(harness);
  assert.deepEqual((await callHost(app, { op: 'test' }, { local: false })).body,
    { error: 'not found' });
  assert.equal((await callHost(app, { op: 'test' }, { local: false })).statusCode, 404);
  assert.deepEqual((await callHost(app, { op: 'nope' })).body,
    { error: 'unknown host operation' });
  assert.equal((await callHost(app, { op: 'nope' })).statusCode, 400);
});

test('output without a notification consumer does not allocate a timer or Aux request', () => {
  const harness = createHarness();
  assert.equal(harness.runtime.onOutput('term', 'x'.repeat(100)), false);
  assert.equal(harness.state.timers.length, 0);
  assert.equal(harness.state.auxGets, 0);
});

test('idle classification respects the threshold and durable D/W guard', async () => {
  const harness = createHarness({ workspaceClients: [['dir', new Set([{}])]] });
  harness.runtime.onOutput('term', '\x1b[31m1234\x1b[0m');
  assert.equal(harness.state.timers.length, 1);
  harness.state.timers[0].callback();
  await flush();
  assert.equal(harness.state.auxGets, 0, 'under-threshold output is not classified');
  assert.equal(stripAnsi('\x1b[31mhello\x1b[0m'), 'hello');

  harness.runtime.onOutput('term', '12345');
  harness.state.timers.at(-1).callback();
  await flush();
  assert.equal(harness.state.auxGets, 1);
  assert.equal(harness.state.auxCalls.length, 1);
  assert.match(harness.state.auxCalls[0].prompt, /12345$/);
  assert.equal(harness.state.dispatches.length, 1);
  assert.equal(harness.state.dispatches[0].context.isTerminal, true);

  harness.persistedSessions.get('term').taskState.classifyState = 'D';
  harness.runtime.onOutput('term', 'another batch');
  harness.state.timers.at(-1).callback();
  await flush();
  assert.equal(harness.state.auxGets, 1, 'D is never reclassified by stray terminal output');
});

test('input restores persisted D/W terminals to P even without an in-memory monitor', () => {
  const harness = createHarness();
  harness.persistedSessions.get('term').taskState.classifyState = 'W';
  assert.equal(harness.runtime.onInput('term'), true);
  assert.deepEqual(harness.state.taskWrites, [{ id: 'term', patch: { classifyState: 'P' } }]);
  harness.runtime.onInput('term');
  assert.equal(harness.state.taskWrites.length, 1, 'ordinary input does not repeat the state write');
});

test('input invalidates late Aux classification and classifier prompts redact credentials', async () => {
  const pending = deferred();
  const harness = createHarness({
    workspaceClients: [['dir', new Set([{}])]],
    auxDeferred: pending,
  });
  harness.runtime.onOutput('term',
    'AUTH_TOKEN=sk-secretvalue123 /Users/alice/private/project finished');
  harness.state.timers[0].callback();
  await flush();
  assert.equal(harness.state.auxCalls.length, 1);
  assert.doesNotMatch(harness.state.auxCalls[0].prompt, /sk-secretvalue123|\/Users\/alice/);
  assert.match(harness.state.auxCalls[0].prompt, /AUTH_TOKEN=\[REDACTED\]|~\/private\/project/);
  assert.equal(redactClassifierTail('Bearer abc123 /home/bob/work'),
    'Bearer [REDACTED] ~/work');

  harness.runtime.onInput('term');
  pending.resolve({ text: 'old result\n已完成\nD' });
  await flush();
  assert.equal(harness.state.dispatches.length, 0,
    'classification started before user input cannot overwrite the new state');
});

test('notify enforces cooldown and produces localized Web Push plus Bark/Webhook payloads', async () => {
  const harness = createHarness();
  harness.push.subscriptions.set('en', { endpoint: 'en', locale: 'en' });
  const first = harness.runtime.notify('term', 'succeeded', '执行成功');
  assert.equal(first.title, 'MultiCC #term: 执行成功');
  assert.equal(first.locale, 'zh');
  assert.match(first.body, /执行成功\n\.\.\./);
  const payloadFactory = harness.state.pushCalls[0];
  assert.equal(typeof payloadFactory, 'function');
  assert.equal(payloadFactory({ locale: 'en' }).title, 'MultiCC #term: Execution succeeded');
  assert.equal(payloadFactory({ locale: 'zh' }).title, 'MultiCC #term: 执行成功');
  assert.equal(harness.state.barkCalls.length, 1);
  assert.equal(harness.state.webhookCalls.length, 1);
  assert.deepEqual(harness.push.globalStats, {
    lastPushTime: 10_000,
    lastPushType: 'succeeded',
    lastPushSessionId: 'term',
  });

  assert.equal(harness.runtime.notify('term', 'error', '失败'), false);
  assert.equal(harness.state.pushCalls.length, 1);
  harness.state.time += 100;
  const waiting = harness.runtime.notify('term', 'waiting', '请确认');
  assert.equal(waiting.title, 'MultiCC #term: 等待操作');
  // waiting 推送不携带字母/子状态（那是终局成功那一发才有的）。
  assert.equal('classifyState' in waiting, false);
  assert.equal('goalState' in waiting, false);

  // 终局成功的推送带 D 字母 + goalState：锁屏标题换成更细的那句，payload 里
  // 两个字段都透传给 webhook / push 订阅方。
  harness.state.time += 100;
  const done = harness.runtime.notify('term', 'succeeded', '执行成功：x', {
    classifyState: 'D', goalState: 'interact',
  });
  assert.equal(done.title, 'MultiCC #term: 需要交互');
  assert.equal(done.classifyState, 'D');
  assert.equal(done.goalState, 'interact');
  harness.state.time += 100;
  const achieved = harness.runtime.notify('term', 'succeeded', '执行成功：y', {
    classifyState: 'D', goalState: 'achieved',
  });
  assert.equal(achieved.title, 'MultiCC #term: 达成目标');
  await flush();
});

test('FCM-only installs count as consumers and task verdicts use the FCM transport', async () => {
  const harness = createHarness();
  const calls = [];
  harness.push.fcmDevices = { hasEnabled: () => true, send: async factory => calls.push(factory({ locale: 'en' })) };
  harness.runtime.notify('term', 'waiting', 'needs input', { classifyState: 'W' });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'term');
  assert.equal(calls[0].locale, 'en');
  assert.equal(calls[0].body.includes('needs input'), true);
  // The consumer check must not depend on Web Push/Bark being configured.
  assert.equal(harness.runtime.onOutput('term', 'new terminal output'), true);
  assert.equal(harness.state.timers.length, 1);
});

test('the terminal classify prompt reads progress and status before answering', () => {
  // The terminal-side classifier (legacy CLI lanes) is the same "internal
  // parsing" job as the chat-side one: no plan block, but it must read the
  // task's progress and status out of the tail instead of judging the last line.
  assert.match(CLASSIFY_PROMPT, /先读进度与状态/);
  assert.match(CLASSIFY_PROMPT, /「已完成」= 目标达成/);
});

test('stop clears every idle timer and invalidates stale timer and Aux callbacks', async () => {
  const pending = deferred();
  const harness = createHarness({
    workspaceClients: [['dir', new Set([{}])]],
    auxDeferred: pending,
  });
  harness.runtime.onOutput('term', '12345');
  const firstTimer = harness.state.timers[0];
  firstTimer.callback();
  await flush();
  assert.equal(harness.state.auxCalls.length, 1);

  harness.runtime.onOutput('term', '67890');
  const secondTimer = harness.state.timers[1];
  harness.runtime.stop();
  harness.runtime.stop();
  assert.ok(harness.state.cleared.includes(secondTimer));
  assert.doesNotThrow(() => secondTimer.callback());
  pending.resolve({ text: 'late\n已完成\nD' });
  await flush();
  assert.equal(harness.state.dispatches.length, 0, 'an in-flight Aux result cannot dispatch after stop');
  assert.equal(harness.runtime.onOutput('term', 'after stop'), false);
  assert.equal(harness.runtime.onInput('term'), false);
  assert.equal(harness.runtime.notify('term', 'completed', 'after stop'), false);
});

test('notifyHost sends a plugin health alert to every existing channel, outside any session cooldown', async () => {
  const harness = createHarness();
  harness.runtime.notify('term', 'error', 'first');
  const alert = { source: 'demo-plugin', key: 'agent-permissions', level: 'critical', title: 'Agent 权限缺失', body: 'x'.repeat(900) };
  const payload = harness.runtime.notifyHost(alert);
  assert.equal(payload.title, 'MultiCC: Agent 权限缺失');
  assert.equal(payload.body.length, 500);
  assert.equal(payload.type, 'alert');
  assert.equal(payload.level, 'critical');
  assert.equal(payload.tag, 'multicc-alert-demo-plugin-agent-permissions');
  await flush();
  assert.equal(harness.state.pushCalls.length, 2, 'the session push and the alert both went out');
  assert.equal(harness.state.pushCalls[1]({ locale: 'en' }), payload);
  assert.deepEqual(harness.state.barkCalls[1], [payload.title, payload.body, '/air']);
  assert.equal(harness.state.webhookCalls[1], payload);
  assert.equal(harness.runtime.notifyHost(null), false);
  harness.runtime.stop();
  assert.equal(harness.runtime.notifyHost(alert), false, 'nothing after stop');
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { BusinessPushRequestError, browserPayloadOf } = require('../src/business-push');
const { createPushRuntime, redactClassifierTail, stripAnsi } = require('../src/push-runtime');

function createApp() {
  const routes = new Map();
  const register = method => (path, handler) => routes.set(`${method} ${path}`, handler);
  return { routes, post: register('POST'), delete: register('DELETE') };
}

async function invoke(app, method, path, body = {}, options = {}) {
  const handler = app.routes.get(`${method} ${path}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${path}`);
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
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  handler({
    body,
    is(type) { return type === contentType; },
  }, response, error => { throw error; });
  await completed;
  return response;
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
    logger: {
      log(message) { state.logs.push(message); },
      warn(message) { state.warnings.push(message); },
    },
  });
  return { runtime, state, push, sessions, persistedSessions, workspaceClients };
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

test('mountRoutes preserves subscribe, delete, validate, test, Bark and Webhook DTOs', async () => {
  const harness = createHarness();
  const app = createApp();
  harness.runtime.mountRoutes(app);
  assert.deepEqual([...app.routes.keys()], [
    'POST /api/push/subscribe',
    'DELETE /api/push/subscribe',
    'POST /api/push/validate',
    'POST /api/push/test',
    'POST /api/push/notify',
    'POST /api/push/test-bark',
    'POST /api/push/test-webhook',
  ]);

  assert.deepEqual((await invoke(app, 'POST', '/api/push/subscribe')).body,
    { error: 'Invalid subscription' });
  assert.deepEqual((await invoke(app, 'POST', '/api/push/subscribe', {
    endpoint: 'https://push.test/one', locale: 'en',
  })).body, { ok: true });
  assert.equal(harness.state.saves, 1);
  assert.deepEqual((await invoke(app, 'POST', '/api/push/validate', {
    endpoint: 'https://push.test/one',
  })).body, { known: true });

  const tested = await invoke(app, 'POST', '/api/push/test');
  assert.deepEqual(tested.body, { ok: true, subscribers: 1 });
  assert.equal(harness.state.pushCalls.length, 1);
  assert.equal(harness.state.barkCalls.length, 1);
  assert.equal(harness.state.webhookCalls.length, 1);

  assert.equal((await invoke(app, 'POST', '/api/push/test-bark')).statusCode, 400);
  harness.push.cfg.BARK_URL = 'https://bark.test';
  assert.deepEqual((await invoke(app, 'POST', '/api/push/test-bark')).body, { ok: true });
  assert.equal((await invoke(app, 'POST', '/api/push/test-webhook')).statusCode, 400);
  harness.push.cfg.WEBHOOK_URL = 'https://hook.test';
  assert.deepEqual((await invoke(app, 'POST', '/api/push/test-webhook')).body, { ok: true });

  assert.deepEqual((await invoke(app, 'DELETE', '/api/push/subscribe', {
    endpoint: 'https://push.test/one',
  })).body, { ok: true });
  assert.equal(harness.push.subscriptions.size, 0);
  assert.equal(harness.state.saves, 2);
});

test('business notification route defaults to JSON, delegates once, and returns its delivery DTO', async () => {
  const harness = createHarness();
  const app = createApp();
  harness.runtime.mountRoutes(app);

  const response = await invoke(app, 'POST', '/api/push/notify', VALID_BUSINESS_PUSH);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    delivered: true,
    deduped: false,
    dedupe_persisted: true,
    subscriber_count: 2,
    delivery_count: 2,
    failure_count: 0,
    stale_count: 0,
    remaining_subscriber_count: 2,
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

test('business notification route rejects non-JSON before invoking the service', async () => {
  const harness = createHarness();
  const app = createApp();
  harness.runtime.mountRoutes(app);

  const response = await invoke(app, 'POST', '/api/push/notify', VALID_BUSINESS_PUSH, {
    contentType: 'text/plain',
  });
  assert.equal(response.statusCode, 415);
  assert.deepEqual(response.body, {
    ok: false,
    delivered: false,
    deduped: false,
    error: 'UNSUPPORTED_MEDIA_TYPE',
  });
  assert.equal(harness.state.businessPushCalls.length, 0);
});

test('business notification route maps validation and idempotency errors without leaking details', async () => {
  for (const expected of [
    {
      error: new BusinessPushRequestError('UNKNOWN_FIELD', 'actions'),
      statusCode: 400,
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
      statusCode: 409,
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
    const app = createApp();
    harness.runtime.mountRoutes(app);
    const response = await invoke(app, 'POST', '/api/push/notify', VALID_BUSINESS_PUSH);
    assert.equal(response.statusCode, expected.statusCode);
    assert.deepEqual(response.body, expected.body);
    assert.equal(harness.state.businessPushCalls.length, 1);
  }
});

test('business notification route preserves empty-subscriber and incomplete-delivery status', async () => {
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
    const app = createApp();
    harness.runtime.mountRoutes(app);
    const response = await invoke(app, 'POST', '/api/push/notify', VALID_BUSINESS_PUSH);
    assert.equal(response.statusCode, expected.statusCode);
    assert.deepEqual(response.body, expected.body);
  }
});

test('business notification route contains unknown failures behind a stable 500 response', async () => {
  const harness = createHarness({
    businessPushError: new Error('/Users/alice/private token=business-push-secret'),
  });
  const app = createApp();
  harness.runtime.mountRoutes(app);
  const response = await invoke(app, 'POST', '/api/push/notify', VALID_BUSINESS_PUSH);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'push request failed' });
  assert.doesNotMatch(JSON.stringify(response.body), /business-push-secret|\/Users\/alice/);
  assert.equal(harness.state.businessPushCalls.length, 1);
});

test('route sync and async failures are contained and redact paths and credentials', async () => {
  const harness = createHarness({
    pushError: new Error('/Users/alice/.multicc token=push-secret'),
  });
  const app = createApp();
  harness.runtime.mountRoutes(app);
  const failed = await invoke(app, 'POST', '/api/push/test');
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { error: 'push request failed' });
  assert.doesNotMatch(JSON.stringify(failed.body), /push-secret|\/Users\/alice/);

  const saveHarness = createHarness({
    saveError: new Error('Authorization: Bearer push-secret'),
  });
  const saveApp = createApp();
  saveHarness.runtime.mountRoutes(saveApp);
  const saveFailed = await invoke(saveApp, 'POST', '/api/push/subscribe', { endpoint: 'x' });
  assert.equal(saveFailed.statusCode, 500);
  assert.deepEqual(saveFailed.body, { error: 'push request failed' });
  assert.equal(saveHarness.push.subscriptions.has('x'), false,
    'failed subscribe rolls back its in-memory mutation');

  saveHarness.push.subscriptions.set('existing', { endpoint: 'existing' });
  const deleteFailed = await invoke(saveApp, 'DELETE', '/api/push/subscribe', {
    endpoint: 'existing',
  });
  assert.equal(deleteFailed.statusCode, 500);
  assert.equal(saveHarness.push.subscriptions.has('existing'), true,
    'failed delete restores its in-memory subscription');
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
  assert.equal(harness.runtime.notify('term', 'waiting', '请确认').title,
    'MultiCC #term: 等待操作');
  await flush();
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

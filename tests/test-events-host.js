'use strict';

// 宿主端口（host port）：POST /api/__host/events。
//
// events & triggers 簇的 15 条公开路由已由 Rust 前门独占
// （native/gateway/src/app/event_routes.rs，集成测试在
// native/gateway/tests/event_routes.rs）。Node 侧只剩宿主契约：事件环、规则表、
// 会话记录、fireTrigger、cron 校验、渠道注册表与标注转发。路径匹配、参数解码、
// 校验决策树、DTO 键序、publicSessionAccessGuard 的 404 与 OPTIONS Allow 都在
// Rust，所以本文件只断言 op 映射、回环闸门与错误信封。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEventsRuntime,
  mountEventsHostRoute,
  HOST_PATH,
} = require('../src/routes/events-host');

function fakeDeps(overrides = {}) {
  const calls = [];
  const recorded = (name, ...args) => { calls.push([name, ...args]); };
  const deps = {
    engine: {
      listGlobal: () => { recorded('listGlobal'); return [{ id: 'r1' }]; },
      listAll: () => { recorded('listAll'); return [{ id: 'r1' }]; },
      insertGlobal: rule => recorded('insertGlobal', rule),
      findGlobal: id => { recorded('findGlobal', id); return id === 'r1' ? { id } : null; },
      replaceGlobal: (id, rule) => { recorded('replaceGlobal', id, rule); return id === 'r1'; },
      removeGlobal: id => { recorded('removeGlobal', id); return id === 'r1'; },
      recentResults: () => { recorded('recentResults'); return []; },
      pendingChains: () => { recorded('pendingChains'); return []; },
    },
    hub: {
      recent: limit => { recorded('recent', limit); return []; },
      emit: (type, sessionId, data, meta) => {
        recorded('emit', type, sessionId, data, meta);
        return { eventId: 'ev-1' };
      },
    },
    persistedSessions: new Map(),
    chatSessions: new Map(),
    sessionPersistence: { mutate: (source, fn) => { recorded('mutate', source); return fn(); } },
    appendEvent: (...args) => recorded('appendEvent', ...args),
    triggerRuntime: {
      reconcileSession: id => recorded('reconcileSession', id),
      fireTrigger: (id, trigger, reason, options) => recorded('fireTrigger', id, trigger, reason, options),
    },
    cron: { validate: expression => { recorded('cron', expression); return expression === '0 9 * * *'; } },
    checkChannelTarget: (plugin, target) => { recorded('checkChannel', plugin, target); return null; },
    annotation: {
      CONFIG: '/data/annotation-live.json',
      loadTargets: () => { recorded('loadTargets'); return [{ url: 'http://h/1' }]; },
      relay: payload => { recorded('relay', payload); return { relayed: 1, results: [] }; },
    },
    now: () => 1700000000000,
    randomUUID: () => 'uuid-1',
    logger: { error: (...args) => recorded('logError', ...args) },
    ...overrides,
  };
  return { deps, calls };
}

function createApp() {
  const routes = new Map();
  const app = { routes };
  app.post = (routePath, handler) => routes.set(`POST ${routePath}`, handler);
  return app;
}

function mount(options = {}) {
  const { deps, calls } = fakeDeps(options.deps);
  const app = createApp();
  mountEventsHostRoute(app, { isLocal: () => true, ...deps, ...options.mount });
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', `missing route POST ${HOST_PATH}`);
  return { handler, calls, deps };
}

function respond(handler, body) {
  let settle;
  const responded = new Promise(resolve => { settle = resolve; });
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; settle(this); return this; },
  };
  handler({ body }, res);
  return responded;
}

test('the host port rejects a request forwarded from a real client', async () => {
  const { deps } = fakeDeps();
  const app = createApp();
  createEventsRuntime({ ...deps, isLocal: () => false }).mount(app);
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  const res = await respond(handler, { op: 'rules-list' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not found' });
});

test('an unknown op is a 400, never a silent success', async () => {
  const { handler } = mount();
  const res = await respond(handler, { op: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'unknown host operation' });
});

test('every op maps to exactly one runtime fact', async () => {
  const { handler, calls, deps } = mount();
  const session = { id: 's1', dirId: 'd1', triggers: [{ id: 't1' }] };
  deps.persistedSessions.set('s1', session);

  const ok = async (body, value) => {
    calls.length = 0;
    const res = await respond(handler, body);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, value });
    return calls;
  };

  await ok({ op: 'identity' }, { id: 'uuid-1', createdAt: '2023-11-14T22:13:20.000Z' });
  await ok({ op: 'rules-state' }, { count: 1, id: 'uuid-1', createdAt: '2023-11-14T22:13:20.000Z' });
  await ok({ op: 'rules-list' }, [{ id: 'r1' }]);
  await ok({ op: 'rules-add', rule: { id: 'r2' } }, { rule: { id: 'r2' } });
  assert.deepEqual(calls, [['insertGlobal', { id: 'r2' }]]);
  await ok({ op: 'rules-get', id: 'r1' }, { found: true, rule: { id: 'r1' } });
  await ok({ op: 'rules-get', id: 'nope' }, { found: false, rule: null });
  await ok({ op: 'rules-replace', id: 'r1', rule: { id: 'r1' } }, { found: true });
  await ok({ op: 'rules-replace', id: 'nope', rule: {} }, { found: false });
  await ok({ op: 'rules-remove', id: 'r1' }, { removed: true });
  await ok({ op: 'check-channels', rule: { action: { kind: 'channel', plugin: 'wechat', target: 'u1' } } },
    { problem: null });
  assert.deepEqual(calls, [['checkChannel', 'wechat', 'u1']]);
  await ok({ op: 'cron-validate', expression: '0 9 * * *' }, { valid: true });
  await ok({ op: 'cron-validate', expression: 'nope' }, { valid: false });
  await ok({ op: 'recent', limit: 10 }, { events: [], runs: [], chains: [] });
  assert.deepEqual(calls, [['recent', 10], ['recentResults'], ['pendingChains']]);
  await ok({ op: 'list-all' }, [{ id: 'r1' }]);
  await ok({ op: 'emit', event: { type: 'task.achieved', sessionId: 's1', goal: 'g', goalState: 'achieved' } },
    { eventId: 'ev-1' });
  assert.deepEqual(calls, [['emit', 'task.achieved', 's1', { goal: 'g', goalState: 'achieved' }, { origin: 'manual-test' }]]);

  const trigger = { id: 't1', type: 'post-turn' };
  await ok({ op: 'trigger-add', id: 's1', trigger, label: '每轮结束' }, { missing: false });
  assert.deepEqual(session.triggers.length, 2);
  assert.deepEqual(calls, [
    ['mutate', 'http.create-session-trigger'],
    ['reconcileSession', 's1'],
    ['appendEvent', 'd1', 'trigger_added', '每轮结束', 's1'],
  ]);
  await ok({ op: 'trigger-add', id: 'nope', trigger, label: '' }, { missing: true });
  await ok({ op: 'trigger-replace', id: 's1', tid: 't1', trigger: { id: 't1', type: 'post-turn', prompt: 'x' } },
    { ok: true });
  assert.deepEqual(calls, [['mutate', 'http.update-session-trigger'], ['reconcileSession', 's1']]);
  await ok({ op: 'trigger-replace', id: 's1', tid: 't9', trigger }, { error: 'trigger not found' });
  await ok({ op: 'trigger-delete', id: 's1', tid: 't1' }, { ok: true });
  assert.deepEqual(calls, [['mutate', 'http.delete-session-trigger'], ['reconcileSession', 's1']]);
  await ok({ op: 'trigger-delete', id: 's1', tid: 't9' }, { error: 'trigger not found' });
  await ok({ op: 'trigger-test', id: 's1', trigger }, { ok: true });
  assert.deepEqual(calls, [['fireTrigger', 's1', { id: 't1', type: 'post-turn' }, 'manual-test', { persistence: 'required' }]]);
  await ok({ op: 'trigger-test', id: 'nope', trigger }, { error: 'not found' });

  await ok({ op: 'annotation-get' },
    { config: '/data/annotation-live.json', targets: [{ url: 'http://h/1' }] });
  await ok({ op: 'annotation-relay', payload: { sessionId: 's' } }, { relayed: 1, results: [] });
});

test('a throwing op is a logged 500 the front door turns into its 503', async () => {
  const { handler, calls } = mount({
    deps: {
      engine: {
        listGlobal: () => { throw new Error('rules file is unreadable'); },
      },
    },
  });
  const res = await respond(handler, { op: 'rules-list' });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'host operation failed' });
  assert.equal(calls.filter(([name]) => name === 'logError').length, 1);
});

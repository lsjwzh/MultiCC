'use strict';

// Plugin channels wired into push and hooks (docs/notification-channel-plugin-design.md
// 10.3–10.5, phase-3 rows of section 13). A fake resident channel plugin (a Node
// script) records every `deliver` it gets; nothing here touches a real app.
//   • push: a recipient subscribed to 「出错了」 only gets errors; existing channels
//     still get every category; turns cut short by a restart are left out;
//   • subscriptions are checked on save (unknown plugin / recipient, plugin down) and
//     an unchanged one can still be edited while the plugin is down;
//   • hooks: 「发到渠道」 follows the rule filter, is rejected on save when the
//     recipient is gone, records a failure (other rules still run) when it fires;
//   • push subscription and hook hitting the same recipient for the same thing send
//     the same dedup key, so the plugin keeps one;
//   • the existing 「推送」 hook also reaches plugin subscriptions;
//   • /api/channels reports inUse, and recheck says whether the problem is still there.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const registry = require('../src/plugins/channel-registry');
const { createPluginsRoutes } = require('../src/routes/plugins');
const { createChannelSubscriptions, mountChannelSubscriptionRoutes } = require('../src/push/channel-subscriptions');
const { createPushRuntime } = require('../src/push/runtime');
const { createEventRuleEngine } = require('../src/events/engine');

const SKIP = process.platform === 'win32' ? 'the fake plugin is a #! script' : false;

// targets: tgt_a, tgt_b (active). deliver to anything else fails like the real plugin.
const FAKE = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
if (process.argv[2] !== 'serve') process.exit(2);
const log = path.join(process.env.MULTICC_PLUGIN_DATA_DIR, 'delivered.jsonl');
fs.mkdirSync(path.dirname(log), { recursive: true });
const out = message => process.stdout.write(JSON.stringify(message) + '\\n');
out({ event: 'hello', protocol: 1, version: '1.0.0' });
let buffer = '';
let next = 1;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.type === 'targets') {
      out({ id: message.id, ok: true, data: { targets: [{ id: 'tgt_a', name: 'A', status: 'active' }, { id: 'tgt_b', name: 'B', status: 'active' }] } });
    } else if (message.type === 'deliver') {
      if (message.target !== 'tgt_a' && message.target !== 'tgt_b') { out({ id: message.id, ok: false, error: '没有这个接收人' }); continue; }
      const { id, type, ...body } = message;
      fs.appendFileSync(log, JSON.stringify(body) + '\\n');
      out({ id: message.id, ok: true, data: { deliveryId: next++, status: 'queued' } });
    } else if (message.type === 'run' && message.command === 'crash') {
      process.exit(9);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const quiet = { info() {}, warn() {}, log() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, { timeout = 5000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(step);
  }
}

function fakeApp() {
  const routes = new Map();
  const register = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: register('GET'), post: register('POST'), put: register('PUT'), delete: register('DELETE'), use() {} };
}

async function call(app, method, route, { body = {}, params = {}, local = true } = {}) {
  const handler = app.routes.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${route}`);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headersSent: false,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.headersSent = true; resolve(this); return this; },
    };
    const req = {
      body, params, headers: { host: '127.0.0.1:3000' },
      socket: { remoteAddress: local ? '127.0.0.1' : '203.0.113.9' },
      connection: { remoteAddress: local ? '127.0.0.1' : '203.0.113.9' },
      ip: local ? '127.0.0.1' : '203.0.113.9',
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

function setup(t, { backoffMs = [50, 100] } = {}) {
  registry.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-channel-routing-'));
  const user = path.join(root, 'home', 'plugins');
  const dir = path.join(user, 'demo-channel');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'builtin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schema: 1, id: 'demo-channel', name: 'Demo channel', version: '1.0.0',
    engine: { type: 'command', binary: 'bin/fake', resident: true },
    channel: { label: 'Demo' }, commands: ['crash'],
  }));
  fs.writeFileSync(path.join(dir, 'bin', 'fake'), FAKE, { mode: 0o755 });
  const plugins = createPluginsRoutes({
    pluginsDir: path.join(root, 'builtin'), userPluginsDir: user, platform: process.platform, arch: process.arch, logger: quiet,
    isLocalRequest: req => req.ip === '127.0.0.1',
    resident: { baseUrl: () => 'http://127.0.0.1:4321', overrides: { backoffMs, downAlertMs: 60_000, rescanMs: 60_000, stopGraceMs: 200 } },
  });
  const app = fakeApp();
  plugins.mount(app);

  const subscriptions = createChannelSubscriptions({ file: path.join(root, 'channel-subscriptions.json'), logger: quiet });
  const bark = [];
  const push = {
    subscriptions: new Map(), cfg: { BARK_URL: 'https://bark.example/key', WEBHOOK_URL: '' }, globalStats: {},
    async saveSubscriptions() {}, async sendPushToAll() {},
    sendBarkNotification(title, body) { bark.push({ title, body }); },
    sendWebhookNotification() {},
    channelSubscriptions: subscriptions,
  };
  const persistedSessions = new Map([
    ['s1', { id: 's1', dirId: 'dir-x', label: '修复登录页', cwd: '/work/shop/.multicc-worktrees/task-1', taskState: { classifyState: 'E' } }],
    ['s2', { id: 's2', dirId: 'dir-y', label: '写周报', cwd: '/work/notes', taskState: { classifyState: 'W' } }],
  ]);
  let time = 1_000_000;
  const runtime = createPushRuntime({
    push, businessPush: { async notify() { return { statusCode: 200, body: {} }; } },
    sessions: new Map(), persistedSessions, workspaceClients: new Map(), chatSessions: new Map(),
    getAuxQueue: () => ({ enqueue: async () => ({ text: '' }) }),
    getTaskState: persisted => persisted.taskState || {},
    setTaskState() {}, parseClassifyResult: () => ({}), dispatchStateAction() {},
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    now: () => (time += 10_000), // past the per-session cooldown every call
    logger: quiet,
  });
  mountChannelSubscriptionRoutes(app, subscriptions, handler => handler, () => ({ webPush: 0, fcm: 0, bark: true, webhook: false, any: true }));

  let handler = null;
  const hub = { subscribe(fn) { handler = fn; return () => { handler = null; }; }, emit() {} };
  const rulesFile = path.join(root, 'event-rules.json');
  const engine = createEventRuleEngine({
    hub, persistedSessions, logger: quiet, now: () => time,
    store: { read: () => (fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : null), write: value => fs.writeFileSync(rulesFile, JSON.stringify(value)) },
    notify: (...args) => runtime.notify(...args),
  });
  engine.start();
  let seq = 0;
  const fire = (type, sessionId, data = {}) => handler({
    eventId: `ev${++seq}`, seq, ts: time, type, sessionId, dirId: persistedSessions.get(sessionId)?.dirId, depth: 0, data,
  });

  const log = path.join(root, 'home', 'plugins-data', 'demo-channel', 'delivered.jsonl');
  const delivered = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  t.after(() => {
    engine.stop();
    subscriptions.stop();
    plugins.channelHost.stop();
    registry.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = () => until(() => plugins.channelHost.status().find(item => item.ready)
    && plugins.channelHost.checkTarget('demo-channel', 'tgt_a') === null);
  return { root, app, plugins, subscriptions, runtime, engine, fire, delivered, bark, persistedSessions, rulesFile, ready };
}

test('a recipient subscribed to errors only gets errors; existing channels get everything; restarts are left out', { skip: SKIP }, async t => {
  const env = setup(t);
  await env.ready();
  const saved = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a', categories: ['error'] } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.subscriptions.length, 1);
  assert.deepEqual(saved.body.defaults, ['error', 'question']);
  const subscriptionId = saved.body.subscriptions[0].id;

  env.runtime.notify('s1', 'error', '[Chat] API 异常，未自动重试', { classifyState: 'E' });
  env.runtime.notify('s2', 'succeeded', '[Chat] 执行成功', { classifyState: 'D' });
  env.runtime.notify('s2', 'waiting', '[Chat] 后台等待：跑测试', { classifyState: 'B' });
  env.runtime.notify('s2', 'waiting', '[Chat] 等待：要不要发版', { classifyState: 'W' });
  env.runtime.notify('s1', 'error', '[Chat] 服务重启', { classifyState: 'E', errorCategory: 'cancel_shutdown' });

  const got = await until(() => { const list = env.delivered(); return list.length >= 1 && list; });
  await sleep(150); // nothing else may arrive
  const all = env.delivered();
  assert.equal(all.length, 1, 'only the real error reaches the plugin');
  assert.deepEqual({ ...got[0], occurredAt: 0 }, {
    target: 'tgt_a', source: `push:${subscriptionId}`, sessionId: 's1', taskName: '修复登录页', project: 'shop',
    category: 'error', summary: 'API 异常，未自动重试', occurredAt: 0, dedupKey: 's1:error',
  });
  assert.equal(env.bark.length, 5, 'Bark still gets every category, restarts included');
});

test('subscriptions are checked on save; an unchanged one can still be edited while the plugin is down', { skip: SKIP }, async t => {
  const env = setup(t, { backoffMs: [60_000] });
  await env.ready();
  const unknownTarget = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_gone' } });
  assert.deepEqual([unknownTarget.statusCode, unknownTarget.body.code], [400, 'unknownTarget']);
  const unknownPlugin = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'other-plugin', target: 'tgt_a' } });
  assert.deepEqual([unknownPlugin.statusCode, unknownPlugin.body.code], [400, 'unknownPlugin']);
  const badCategory = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a', categories: ['spam'] } });
  assert.deepEqual([badCategory.statusCode, badCategory.body.code], [400, 'invalid']);
  const ok = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a' } });
  assert.deepEqual(ok.body.subscriptions[0].categories, ['question', 'error'], 'default: 在等你回答 + 出错了');
  const duplicate = await call(env.app, 'PUT', '/api/push/channel-subscriptions', {
    body: { subscriptions: [{ plugin: 'demo-channel', target: 'tgt_b' }, { plugin: 'demo-channel', target: 'tgt_b' }] },
  });
  assert.deepEqual([duplicate.statusCode, duplicate.body.code], [400, 'duplicate']);

  await env.plugins.runPluginCommand('demo-channel', 'crash', {});
  await until(() => !env.plugins.channelHost.status().find(item => item.ready));
  const down = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_b' } });
  assert.deepEqual([down.statusCode, down.body.code], [400, 'pluginDown']);
  const edited = await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a', categories: ['done'], enabled: false } });
  assert.equal(edited.statusCode, 200);
  assert.deepEqual([edited.body.subscriptions[0].categories, edited.body.subscriptions[0].enabled], [['done'], false]);
  const test = await call(env.app, 'POST', '/api/push/test-channel', { body: { plugin: 'demo-channel', target: 'tgt_a' } });
  assert.equal(test.statusCode, 503, 'a test to a stopped plugin says so');
  // Survives a reload from disk.
  env.subscriptions.reload();
  assert.equal(env.subscriptions.list()[0].enabled, false);
  const removed = await call(env.app, 'DELETE', '/api/push/channel-subscriptions/:id', { params: { id: env.subscriptions.list()[0].id } });
  assert.deepEqual(removed.body.subscriptions, []);
});

test('hooks: 「发到渠道」 follows the filter, is rejected on save for a gone recipient, and a failed send does not stop other rules', { skip: SKIP }, async t => {
  const env = setup(t);
  await env.ready();
  const gone = env.engine.addGlobal({ on: ['task.waiting_user'], action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_gone' } });
  assert.equal(gone.error, 'unknown channel target');
  assert.equal(env.engine.addGlobal({ on: ['task.failed'], action: { kind: 'channel', plugin: 'nope-plugin', target: 'tgt_a' } }).error, 'unknown channel plugin');
  assert.equal(env.engine.addGlobal({ on: ['task.failed'], action: { kind: 'channel', plugin: 'demo-channel', target: '' } }).error, 'invalid channel action');

  const forB = env.engine.addGlobal({ on: ['task.waiting_user'], filter: { dirIds: ['dir-x'] }, action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_b' } });
  assert.ok(forB.rule, forB.error);
  env.fire('task.waiting_user', 's2', { goal: '写周报' }); // dir-y: not for B
  env.fire('task.waiting_user', 's1', { goal: '修复登录页' });
  const got = await until(() => { const list = env.delivered(); return list.length >= 1 && list; });
  await sleep(100);
  assert.equal(env.delivered().length, 1);
  assert.deepEqual([got[0].target, got[0].category, got[0].source, got[0].sessionId, got[0].summary], ['tgt_b', 'question', `hook:${forB.rule.id}`, 's1', '修复登录页']);
  const run = await until(() => env.engine.listAll().find(item => item.rule.id === forB.rule.id && item.lastRun));
  assert.equal(run.lastRun.ok, true);
  assert.equal(run.lastRun.deliveryId, 1);

  // A rule saved before the recipient was deleted still loads; firing it records a
  // failure and the other rule on the same event still runs.
  const stored = JSON.parse(fs.readFileSync(env.rulesFile, 'utf8'));
  stored.rules.push({ ...forB.rule, id: 'stale', on: ['task.failed'], filter: {}, action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_gone', message: '' } });
  stored.rules.push({ ...forB.rule, id: 'live', on: ['task.failed'], filter: {}, action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_a', message: '登录页挂了' } });
  fs.writeFileSync(env.rulesFile, JSON.stringify(stored));
  env.engine.stop();
  env.engine.start();
  env.fire('task.failed', 's1', { goal: '修复登录页' });
  const failed = await until(() => env.engine.listAll().find(item => item.rule.id === 'stale' && item.lastRun));
  assert.deepEqual([failed.lastRun.ok, failed.lastRun.error], [false, '没有这个接收人']);
  await until(() => env.delivered().some(item => item.target === 'tgt_a' && item.summary === '登录页挂了'));
});

test('the same thing via a push subscription and a hook carries one dedup key; the 「推送」 hook reaches subscriptions too', { skip: SKIP }, async t => {
  const env = setup(t);
  await env.ready();
  await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a', categories: ['error'] } });
  assert.ok(env.engine.addGlobal({ on: ['task.failed'], action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_a' } }).rule);
  assert.ok(env.engine.addGlobal({ on: ['task.failed'], action: { kind: 'notify', message: '任务出错' } }).rule);
  env.fire('task.failed', 's1', { goal: '修复登录页' });
  const got = await until(() => { const list = env.delivered(); return list.length >= 2 && list; });
  assert.deepEqual(got.map(item => item.target), ['tgt_a', 'tgt_a']);
  assert.deepEqual(new Set(got.map(item => item.dedupKey)), new Set(['s1:error']), 'the plugin keeps one of them');
  assert.ok(got.some(item => item.source.startsWith('push:')), 'the 「推送」 hook went through notify() into the subscription');
  assert.ok(got.some(item => item.source.startsWith('hook:')));
  assert.equal(env.bark.length, 1, 'and the existing channels got it as before');
});

test('/api/channels reports who relies on a channel; recheck answers whether the problem is still there', { skip: SKIP }, async t => {
  const env = setup(t);
  await env.ready();
  const before = await call(env.app, 'GET', '/api/channels');
  assert.equal(before.body.plugins[0].inUse, false);
  await call(env.app, 'POST', '/api/push/channel-subscriptions', { body: { plugin: 'demo-channel', target: 'tgt_a' } });
  env.engine.addGlobal({ on: ['task.failed'], action: { kind: 'channel', plugin: 'demo-channel', target: 'tgt_b' } });
  const after = await call(env.app, 'GET', '/api/channels');
  assert.deepEqual([after.body.plugins[0].inUse, after.body.plugins[0].subscriptions, after.body.plugins[0].uses], [true, 1, 2]);

  const ask = items => call(env.app, 'POST', '/api/channels/recheck', { body: { items } });
  let answer = await ask([{ sessionId: 's1', category: 'error' }, { sessionId: 's2', category: 'question' }, { sessionId: 's2', category: 'error' }, { sessionId: 'gone', category: 'error' }, { sessionId: 's2', category: 'done' }]);
  assert.deepEqual(answer.body.items.map(item => item.active), [true, true, false, false, true]);
  env.persistedSessions.get('s1').taskState.classifyState = 'P'; // the user picked it up again
  answer = await ask([{ sessionId: 's1', category: 'error' }]);
  assert.equal(answer.body.items[0].active, false);
  const remote = await call(env.app, 'POST', '/api/channels/recheck', { body: { items: [] }, local: false });
  assert.equal(remote.statusCode, 403);
});

test('category mapping and project names', () => {
  assert.equal(registry.categoryOfPush('succeeded', 'D'), 'done');
  assert.equal(registry.categoryOfPush('waiting', 'W'), 'question');
  assert.equal(registry.categoryOfPush('waiting', 'B'), 'background');
  assert.equal(registry.categoryOfPush('error', 'E'), 'error');
  assert.equal(registry.categoryOfPush('alert'), null);
  assert.equal(registry.categoryOfEvent('task.needs_interaction'), 'question');
  assert.equal(registry.categoryOfEvent('turn.completed'), 'info');
  assert.equal(registry.projectName('/Users/me/code/multicc/.multicc-worktrees/task-abc'), 'multicc');
  assert.equal(registry.projectName('/Users/me/code/notes/'), 'notes');
  assert.equal(registry.projectName(''), '');
});

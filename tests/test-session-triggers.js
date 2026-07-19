'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_TRIGGER_PROMPT, createSessionTriggers } = require('../src/triggers');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) {
      const timer = { id: ++sequence, callback, delay, unref() {} };
      pending.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) pending.delete(timer.id);
    },
    run(timerOrId) {
      const id = typeof timerOrId === 'number' ? timerOrId : timerOrId.id;
      const timer = pending.get(id);
      assert.ok(timer, `timer ${id} is pending`);
      pending.delete(id);
      timer.callback();
    },
  };
}

class FakeWatcher extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = 0;
    this.closed = false;
  }

  close() {
    this.closeCalls += 1;
    this.closed = true;
    return Promise.resolve();
  }
}

function createApp() {
  const handlers = new Map();
  const app = { handlers };
  for (const method of ['get', 'post', 'put', 'delete']) {
    app[method] = (routePath, handler) => {
      handlers.set(`${method.toUpperCase()} ${routePath}`, handler);
      return app;
    };
  }
  return app;
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function invoke(app, method, routePath, request = {}) {
  const handler = app.handlers.get(`${method} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing ${method} ${routePath}`);
  const response = createResponse();
  const result = handler({ params: {}, body: {}, ...request }, response);
  return { response, result };
}

function createHarness(options = {}) {
  const timers = options.timers || createTimers();
  const bus = options.bus || new EventEmitter();
  const persistedSessions = options.persistedSessions || new Map();
  const chatSessions = options.chatSessions || new Map();
  const watcherRecords = [];
  const cronRecords = [];
  const persistenceSources = [];
  const bestEffortSources = [];
  const events = [];
  const broadcasts = [];
  const logs = [];
  let clock = options.now === undefined ? Date.parse('2026-07-19T00:00:00.000Z') : options.now;

  const chokidar = options.chokidar || {
    watch(root, watcherOptions) {
      const watcher = new FakeWatcher();
      watcherRecords.push({ root, options: watcherOptions, watcher });
      return watcher;
    },
  };
  const cron = options.cron || {
    validate(expression) { return /^\* \/5 \* \* \* \*$/.test(expression); },
    schedule(expression, callback) {
      const task = {
        expression,
        callback,
        stopCalls: 0,
        stop() { this.stopCalls += 1; },
      };
      cronRecords.push(task);
      return task;
    },
  };
  const sessionPersistence = options.sessionPersistence || {
    mutate(source, mutator) {
      persistenceSources.push(source);
      return mutator(persistedSessions);
    },
  };

  const runtime = createSessionTriggers({
    crypto: { randomUUID: () => 'trigger-generated' },
    cron,
    chokidar,
    fs: options.fs || { existsSync: () => true },
    path,
    bus,
    persistedSessions,
    chatSessions,
    sessionPersistence,
    saveBestEffort(source) { bestEffortSources.push(source); return true; },
    cwdForSession(session) { return `/worktrees/${session.id}`; },
    appendEvent(...args) { events.push(args); },
    chatBroadcast(...args) { broadcasts.push(args); },
    timers,
    now: () => clock,
    logger: {
      info(event, fields) { logs.push({ level: 'info', event, fields }); },
      warn(event, fields) { logs.push({ level: 'warn', event, fields }); },
    },
  });
  const app = createApp();
  runtime.mountRoutes(app);
  return {
    runtime,
    app,
    bus,
    timers,
    persistedSessions,
    chatSessions,
    watcherRecords,
    cronRecords,
    persistenceSources,
    bestEffortSources,
    events,
    broadcasts,
    logs,
    setNow(value) { clock = value; },
  };
}

function makeSession(triggers = []) {
  return {
    id: 'session-1',
    dirId: 'directory-1',
    worktreePath: '/worktrees/session-1',
    triggers,
  };
}

test('trigger validation and glob matching preserve the established contract', () => {
  const harness = createHarness();
  assert.deepEqual(harness.runtime.validateTrigger({ type: 'unknown' }), { error: 'invalid type' });
  assert.deepEqual(harness.runtime.validateTrigger({ type: 'file-change' }), {
    error: 'file-change requires paths[]',
  });
  assert.deepEqual(harness.runtime.validateTrigger({ type: 'schedule', cron: 'bad' }), {
    error: 'invalid cron expression',
  });

  const result = harness.runtime.validateTrigger({
    type: 'file-change',
    paths: 'src/**/*.js',
    prompt: 'x'.repeat(5000),
    debounceMs: 20,
    cooldownMs: 90000000,
  });
  assert.equal(result.trigger.id, 'trigger-generated');
  assert.equal(result.trigger.createdAt, '2026-07-19T00:00:00.000Z');
  assert.equal(result.trigger.prompt.length, 4000);
  assert.equal(result.trigger.debounceMs, 500);
  assert.equal(result.trigger.cooldownMs, 86400000);
  assert.deepEqual(result.trigger.paths, ['src/**/*.js']);
  assert.equal(harness.runtime.matchGlob('src/domain/file.js', 'src/**/*.js'), true);
  assert.equal(harness.runtime.matchGlob('src/domain/file.ts', 'src/**/*.js'), false);
  assert.equal(harness.runtime.matchAnyGlob('README.md', ['*.md']), true);
});

test('trigger CRUD preserves route DTOs, last-fired state, and strong persistence sources', () => {
  const session = makeSession();
  const harness = createHarness({ persistedSessions: new Map([[session.id, session]]) });

  let call = invoke(harness.app, 'GET', '/api/sessions/:id/triggers', {
    params: { id: session.id },
  });
  assert.deepEqual(call.response.body, { triggers: [] });

  call = invoke(harness.app, 'POST', '/api/sessions/:id/triggers', {
    params: { id: session.id },
    body: { type: 'post-turn', prompt: 'review' },
  });
  assert.equal(call.response.statusCode, 200);
  assert.equal(call.response.body.id, 'trigger-generated');
  assert.equal(session.triggers.length, 1);
  assert.deepEqual(harness.events, [[
    'directory-1', 'trigger_added', '每轮结束', 'session-1',
  ]]);

  session.triggers[0].lastFiredAt = 123;
  call = invoke(harness.app, 'PUT', '/api/sessions/:id/triggers/:tid', {
    params: { id: session.id, tid: 'trigger-generated' },
    body: { prompt: 'updated' },
  });
  assert.equal(call.response.body.prompt, 'updated');
  assert.equal(call.response.body.lastFiredAt, 123);

  call = invoke(harness.app, 'DELETE', '/api/sessions/:id/triggers/:tid', {
    params: { id: session.id, tid: 'trigger-generated' },
  });
  assert.deepEqual(call.response.body, { ok: true });
  assert.deepEqual(session.triggers, []);
  assert.deepEqual(harness.persistenceSources, [
    'http.create-session-trigger',
    'http.update-session-trigger',
    'http.delete-session-trigger',
  ]);

  call = invoke(harness.app, 'POST', '/api/sessions/:id/triggers', {
    params: { id: session.id },
    body: { type: 'bad' },
  });
  assert.equal(call.response.statusCode, 400);
  assert.deepEqual(call.response.body, { error: 'invalid type' });
});

test('create, update, and delete rely on persistence rollback and do not reconcile after failure', () => {
  const cases = [
    {
      method: 'POST', route: '/api/sessions/:id/triggers',
      request: { body: { type: 'post-turn' } }, initial: [],
    },
    {
      method: 'PUT', route: '/api/sessions/:id/triggers/:tid',
      request: { params: { tid: 'existing' }, body: { prompt: 'changed' } },
      initial: [{ id: 'existing', type: 'post-turn', enabled: true, prompt: 'old', cooldownMs: 0, mode: 'inject', createdAt: 'old' }],
    },
    {
      method: 'DELETE', route: '/api/sessions/:id/triggers/:tid',
      request: { params: { tid: 'existing' } },
      initial: [{ id: 'existing', type: 'post-turn', enabled: true, prompt: 'old', cooldownMs: 0, mode: 'inject', createdAt: 'old' }],
    },
  ];

  for (const item of cases) {
    const session = makeSession(clone(item.initial));
    const records = new Map([[session.id, session]]);
    const persistence = {
      mutate(source, mutator) {
        const before = clone([...records.values()]);
        mutator(records);
        records.clear();
        for (const record of before) records.set(record.id, record);
        throw Object.assign(new Error('disk unavailable'), { code: 'SESSION_PERSISTENCE_FAILED' });
      },
    };
    const harness = createHarness({ persistedSessions: records, sessionPersistence: persistence });
    assert.throws(() => invoke(harness.app, item.method, item.route, {
      params: { id: session.id, ...(item.request.params || {}) },
      body: item.request.body || {},
    }), /disk unavailable/);
    assert.deepEqual(records.get(session.id).triggers, item.initial);
    assert.deepEqual(harness.runtime.status(), {
      started: false,
      watchers: 0,
      cronTasks: 0,
      debouncers: 0,
      deferred: 0,
      pendingClosures: 0,
    });
  }
});

test('manual test bypasses enabled and cooldown while requiring durable lastFiredAt', () => {
  const trigger = {
    id: 'manual',
    type: 'post-turn',
    enabled: false,
    prompt: '',
    cooldownMs: 86400000,
    lastFiredAt: Date.parse('2026-07-19T00:00:00.000Z'),
  };
  const session = makeSession([trigger]);
  const harness = createHarness({
    persistedSessions: new Map([[session.id, session]]),
    now: Date.parse('2026-07-19T00:00:01.000Z'),
  });
  const runs = [];
  harness.bus.on('chat:run', (...args) => runs.push(args));

  const call = invoke(harness.app, 'POST', '/api/sessions/:id/triggers/:tid/test', {
    params: { id: session.id, tid: trigger.id },
  });
  assert.deepEqual(call.response.body, { ok: true });
  assert.equal(trigger.lastFiredAt, Date.parse('2026-07-19T00:00:01.000Z'));
  assert.deepEqual(harness.persistenceSources, ['http.test-session-trigger']);
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0], session.id);
  assert.equal(runs[0][1], DEFAULT_TRIGGER_PROMPT);
  assert.deepEqual(runs[0][2], { originTrigger: true });
  assert.equal(harness.broadcasts[0][1].subtype, 'trigger_fired');
});

test('busy sessions keep only one deferred fire and run it after streaming ends', () => {
  const trigger = { id: 'busy', type: 'post-turn', enabled: true, prompt: 'after', cooldownMs: 0 };
  const session = makeSession([trigger]);
  const chats = new Map([[session.id, { isStreaming: true }]]);
  const harness = createHarness({
    persistedSessions: new Map([[session.id, session]]),
    chatSessions: chats,
  });
  const runs = [];
  harness.bus.on('chat:run', (...args) => runs.push(args));

  assert.equal(harness.runtime.fireTrigger(session.id, trigger, 'schedule'), false);
  assert.equal(harness.runtime.fireTrigger(session.id, trigger, 'schedule'), false);
  assert.equal(harness.runtime.status().deferred, 1);
  assert.equal(harness.timers.pending.size, 1);

  chats.get(session.id).isStreaming = false;
  harness.timers.run([...harness.timers.pending.keys()][0]);
  assert.equal(harness.runtime.status().deferred, 0);
  assert.equal(runs.length, 1);
  assert.deepEqual(harness.bestEffortSources, ['runtime.trigger-fired.schedule']);
});

test('file watchers match globs and debounce repeated changes per trigger', async () => {
  const trigger = {
    id: 'file', type: 'file-change', enabled: true, prompt: 'inspect', cooldownMs: 0,
    paths: ['src/**/*.js'], debounceMs: 900,
  };
  const session = makeSession([trigger]);
  const harness = createHarness({ persistedSessions: new Map([[session.id, session]]) });
  const runs = [];
  harness.bus.on('chat:run', (...args) => runs.push(args));

  assert.equal(harness.runtime.start(), true);
  assert.equal(harness.watcherRecords.length, 1);
  const watcher = harness.watcherRecords[0].watcher;
  watcher.emit('change', '/worktrees/session-1/src/domain/a.js');
  const firstTimer = [...harness.timers.pending.values()][0];
  watcher.emit('change', '/worktrees/session-1/src/domain/a.js');
  assert.equal(harness.timers.pending.size, 1);
  assert.equal(harness.timers.pending.has(firstTimer.id), false);
  assert.equal(harness.runtime.status().debouncers, 1);

  harness.timers.run([...harness.timers.pending.keys()][0]);
  assert.equal(runs.length, 1);
  assert.equal(harness.events[0][2], '文件变更 src/**/*.js · file:src/domain/a.js');
  await harness.runtime.stop();
});

test('post-turn firing requires a durable result and blocks trigger recursion', () => {
  const trigger = { id: 'turn', type: 'post-turn', enabled: true, prompt: 'review', cooldownMs: 0 };
  const session = makeSession([trigger]);
  const harness = createHarness({ persistedSessions: new Map([[session.id, session]]) });
  const runs = [];
  harness.bus.on('chat:run', (...args) => runs.push(args));

  assert.equal(harness.runtime.firePostTurnTriggers(session.id, {}, { resultDurable: false }), 0);
  assert.equal(harness.runtime.firePostTurnTriggers(session.id, {}, {
    resultDurable: true,
    lineage: { kind: 'trigger' },
  }), 0);
  assert.equal(harness.runtime.firePostTurnTriggers(session.id, {}, {
    resultDurable: true,
    lineage: { kind: 'user' },
  }), 1);
  assert.equal(runs.length, 1);
});

test('stale trigger callbacks cannot fire or re-arm resources after stop', async () => {
  const stale = {
    id: 'stale', type: 'schedule', enabled: true, prompt: 'old prompt', cooldownMs: 0,
    cron: '* /5 * * * *',
  };
  const session = makeSession([stale]);
  const harness = createHarness({ persistedSessions: new Map([[session.id, session]]) });
  const runs = [];
  harness.bus.on('chat:run', (...args) => runs.push(args));

  harness.runtime.start();
  session.triggers = [];
  assert.equal(harness.runtime.fireTrigger(session.id, stale, 'late-cron'), false);
  assert.equal(runs.length, 0, 'deleted trigger callback is ignored');

  await harness.runtime.stop();
  session.triggers = [{
    id: 'new-file', type: 'file-change', enabled: true, prompt: '', cooldownMs: 0,
    paths: ['*.js'], debounceMs: 1000,
  }];
  assert.equal(harness.runtime.reconcileSession(session.id), false);
  assert.equal(harness.runtime.status().watchers, 0,
    'stopped runtime cannot resurrect a watcher');
  assert.equal(harness.runtime.status().cronTasks, 0,
    'stopped runtime cannot resurrect a cron task');
});

test('reconcile and stop remove bus listeners, watchers, cron jobs, debounce, and deferred timers', async () => {
  const triggers = [
    {
      id: 'file', type: 'file-change', enabled: true, prompt: '', cooldownMs: 0,
      paths: ['*.js'], debounceMs: 1000,
    },
    {
      id: 'cron', type: 'schedule', enabled: true, prompt: '', cooldownMs: 0,
      cron: '* /5 * * * *',
    },
  ];
  const session = makeSession(triggers);
  const chats = new Map([[session.id, { isStreaming: true }]]);
  const harness = createHarness({
    persistedSessions: new Map([[session.id, session]]),
    chatSessions: chats,
  });

  harness.runtime.start();
  assert.equal(harness.bus.listenerCount('chat:turn-complete'), 1);
  assert.equal(harness.runtime.status().watchers, 1);
  assert.equal(harness.runtime.status().cronTasks, 1);
  harness.watcherRecords[0].watcher.emit('change', '/worktrees/session-1/a.js');
  harness.runtime.fireTrigger(session.id, triggers[1], 'schedule');
  assert.equal(harness.runtime.status().debouncers, 1);
  assert.equal(harness.runtime.status().deferred, 1);

  session.triggers = [triggers[1]];
  harness.runtime.reconcileSession(session.id);
  assert.equal(harness.watcherRecords[0].watcher.closeCalls, 1);
  assert.equal(harness.cronRecords[0].stopCalls, 1);
  assert.equal(harness.runtime.status().watchers, 0);
  assert.equal(harness.runtime.status().cronTasks, 1);
  assert.equal(harness.runtime.status().debouncers, 0);
  assert.equal(harness.runtime.status().deferred, 0);

  await harness.runtime.stop();
  assert.equal(harness.bus.listenerCount('chat:turn-complete'), 0);
  assert.deepEqual(harness.runtime.status(), {
    started: false,
    watchers: 0,
    cronTasks: 0,
    debouncers: 0,
    deferred: 0,
    pendingClosures: 0,
  });
  assert.equal(harness.cronRecords[1].stopCalls, 1);
  assert.equal(harness.timers.pending.size, 0);
});

test('background watcher failures are fail-safe and redact paths and tokens', () => {
  const trigger = {
    id: 'file', type: 'file-change', enabled: true, prompt: '', cooldownMs: 0,
    paths: ['*.js'], debounceMs: 1000,
  };
  const session = makeSession([trigger]);
  const harness = createHarness({
    persistedSessions: new Map([[session.id, session]]),
    chokidar: {
      watch() { throw new Error('/Users/private/project token=sk-secretvalue'); },
    },
  });
  assert.doesNotThrow(() => harness.runtime.start());
  const serialized = JSON.stringify(harness.logs);
  assert.doesNotMatch(serialized, /Users\/private|sk-secretvalue|token=/);
  assert.match(serialized, /trigger runtime failed/);
});

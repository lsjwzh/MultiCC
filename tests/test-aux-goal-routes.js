'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  AUX_SESSION_ID,
  AUX_HISTORY_MAX,
  AUX_CONCURRENCY_DEFAULT,
  AUX_CONCURRENCY_MAX,
  resolveAuxConcurrency,
  normalizeGoalConfig,
  resolveGoalLimits,
  buildGoalLimitNote,
  parseGoalVerdict,
  safeAuxErrorMessage,
  mountAuxGoalRoutes,
} = require('../src/routes/aux-goal');

function createApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return { routes, get: register('GET'), post: register('POST') };
}

function createResponse() {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  return {
    statusCode: 200,
    body: undefined,
    completed,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; finish(); return this; },
  };
}

async function invoke(app, method, routePath, req = {}) {
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.equal(typeof handler, 'function', `missing route ${method} ${routePath}`);
  const res = createResponse();
  const result = handler({ body: {}, query: {}, ...req }, res);
  if (result && typeof result.then === 'function') await result;
  if (res.body === undefined) await res.completed;
  return res;
}

function createHarness(overrides = {}) {
  const files = new Map([
    ['/tmp/aux-config.json', JSON.stringify({ cli: 'codex', providerId: 'codex-one', model: 'old-model' })],
    ['/tmp/goal-config.json', JSON.stringify({ dimensions: { scope: false }, minScore: 75 })],
  ]);
  const writes = [];
  const chat = [];
  const broadcasts = [];
  const persistedSessions = new Map();
  const providers = {
    listProviders(appType) {
      return appType === 'codex'
        ? [{ id: 'codex-one', name: 'Codex One', modelOptions: ['gpt-test'] }]
        : [{ id: 'claude-one', name: 'Claude One', modelOptions: ['claude-test'] }];
    },
    resolveAuxHttpTarget(protocol, providerId, options) {
      if (providerId === 'unavailable') return { available: false, reason: 'no endpoint' };
      return {
        available: true,
        wireApi: protocol === 'openai' ? 'responses' : 'messages',
        model: protocol === 'openai' ? 'gpt-test' : 'claude-test',
        modelOptions: protocol === 'openai' ? ['gpt-test'] : ['claude-test'],
        protocol,
        providerId,
        options,
      };
    },
  };
  const deps = {
    fs: { readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); } },
    crypto: { randomUUID: () => `task-${chat.length}` },
    rootDir: '/repo',
    auxConfigFile: '/tmp/aux-config.json',
    goalConfigFile: '/tmp/goal-config.json',
    atomicWriteJson(file, value) { writes.push({ file, value: JSON.parse(JSON.stringify(value)) }); },
    persistedSessions,
    savePersistedSessionsBestEffort() {},
    isShuttingDown: () => false,
    recordApiError() {},
    recordApiSuccess() {},
    appendChatMessage(sessionId, message) { chat.push({ sessionId, message }); },
    loadChatHistory: () => chat.map(entry => entry.message),
    providers,
    getPort: () => 4321,
    getClaudeOfficialViaProxy: () => true,
    executeAuxHttp: async ({ prompt }) => prompt.includes('任务质量审查助手')
      ? JSON.stringify({ verdict: 'ok', score: 70, issues: [], questions: [], criteria: ['done'], revised: 'better' })
      : 'aux-result',
    broadcast(clients, payload) { broadcasts.push({ clients, payload }); },
    env: { AUX_TIMEOUT_MS: '12345' },
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  };
  const app = createApp();
  const runtime = mountAuxGoalRoutes(app, deps);
  return { app, runtime, deps, files, writes, chat, broadcasts, persistedSessions };
}

test('mounts the complete Aux and Goal REST surface', () => {
  const { app } = createHarness();
  assert.deepEqual([...app.routes.keys()].sort(), [
    'GET /api/aux/config',
    'GET /api/aux/health',
    'GET /api/aux/history',
    'GET /api/aux/status',
    'GET /api/settings/goal',
    'POST /api/aux/cancel',
    'POST /api/aux/config',
    'POST /api/aux/enqueue',
    'POST /api/goal/precheck',
    'POST /api/settings/goal',
  ]);
});

test('exports the Aux history retention constant consumed by the host', () => {
  assert.equal(AUX_HISTORY_MAX, 200);
  const { runtime } = createHarness();
  assert.equal(runtime.AUX_HISTORY_MAX, 200);
});

test('initialization migrates legacy Aux config and registers the synthetic session', () => {
  const { runtime, writes, persistedSessions } = createHarness();
  runtime.auxQueue.init();
  assert.deepEqual(runtime.getAuxConfig(), { protocol: 'openai', providerId: 'codex-one', model: 'old-model' });
  assert.deepEqual(writes[0], {
    file: '/tmp/aux-config.json',
    value: { protocol: 'openai', providerId: 'codex-one', model: 'old-model' },
  });
  assert.deepEqual(persistedSessions.get(AUX_SESSION_ID), {
    id: AUX_SESSION_ID,
    cwd: '/repo',
    createdAt: persistedSessions.get(AUX_SESSION_ID).createdAt,
    type: 'aux',
    label: 'AI Assistant',
  });
  assert.ok(persistedSessions.get(AUX_SESSION_ID).createdAt instanceof Date);
});

test('Aux config preserves validation, provider filtering and persisted DTOs', async () => {
  const { app, runtime, writes } = createHarness();
  runtime.auxQueue.init();
  let res = await invoke(app, 'GET', '/api/aux/config');
  assert.equal(res.body.protocol, 'openai');
  assert.deepEqual(res.body.providersByProtocol.anthropic.map(item => item.id), ['claude-one']);
  assert.deepEqual(res.body.providersByProtocol.openai.map(item => item.id), ['codex-one']);

  res = await invoke(app, 'POST', '/api/aux/config', { body: { protocol: 'invalid', providerId: 'codex-one' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'protocol 必须是 anthropic 或 openai' });

  res = await invoke(app, 'POST', '/api/aux/config', {
    body: { protocol: 'anthropic', providerId: 'claude-one', model: 'claude-custom' },
  });
  assert.deepEqual(res.body, {
    ok: true,
    protocol: 'anthropic',
    providerId: 'claude-one',
    model: 'claude-custom',
    wireApi: 'messages',
  });
  assert.deepEqual(writes.at(-1).value, { protocol: 'anthropic', providerId: 'claude-one', model: 'claude-custom' });
  const detached = runtime.getAuxConfig();
  detached.model = 'caller-mutated';
  assert.equal(runtime.getAuxConfig().model, 'claude-custom');
});

test('Aux and Goal config write failures preserve the legacy best-effort response contract', async () => {
  const warnings = [];
  const harness = createHarness({
    atomicWriteJson() { throw new Error('/Users/example/private/config.json failed'); },
    logger: { log() {}, error() {}, warn(...args) { warnings.push(args); } },
  });
  harness.runtime.auxQueue.init();
  let res = await invoke(harness.app, 'POST', '/api/aux/config', {
    body: { protocol: 'anthropic', providerId: 'claude-one', model: 'claude-custom' },
  });
  assert.deepEqual(res.body, {
    ok: true,
    protocol: 'anthropic',
    providerId: 'claude-one',
    model: 'claude-custom',
    wireApi: 'messages',
  });
  assert.equal(harness.runtime.getAuxConfig().model, 'claude-custom');

  res = await invoke(harness.app, 'POST', '/api/settings/goal', {
    body: { dimensions: { objective: false }, minScore: 88 },
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.minScore, 88);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('/Users/example/private/config.json'), false);
  assert.equal(warnings[0].at(-1), 'save failed');
});

test('queue retains shutdown guard, history metadata and health accounting', async () => {
  let successes = 0;
  const harness = createHarness({ recordApiSuccess: () => { successes++; } });
  const result = await harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'hello', meta: { sid: 's1' } });
  assert.deepEqual(result, { text: 'aux-result', cancelled: false });
  assert.equal(successes, 1);
  assert.equal(harness.chat.length, 2);
  assert.equal(harness.chat[0].sessionId, AUX_SESSION_ID);
  assert.equal(harness.chat[0].message.taskType, 'manual');
  assert.equal(harness.chat[1].message.transport, 'directHttp');
  assert.equal(harness.chat[1].message.wireApi, 'messages');
  assert.equal(harness.runtime.auxQueue.getStatus().totalProcessed, 1);

  const stopped = createHarness({ isShuttingDown: () => true });
  await assert.rejects(
    stopped.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'no' }),
    error => error.code === 'SERVER_SHUTTING_DOWN',
  );
});

test('the Aux pool runs five direct HTTP tasks at once and keeps FIFO order', async () => {
  let sequence = 0;
  const started = [];
  const pending = [];
  const harness = createHarness({
    crypto: { randomUUID: () => `fifo-${++sequence}` },
    executeAuxHttp: ({ prompt }) => new Promise(resolve => {
      started.push(prompt);
      pending.push(resolve);
    }),
  });
  const prompts = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const tasks = prompts.map(prompt => harness.runtime.auxQueue.enqueue({ type: 'manual', prompt, meta: {} }));
  await new Promise(resolve => setImmediate(resolve));
  // Five slots → the first five are already in flight; only the sixth waits.
  assert.deepEqual(started, ['first', 'second', 'third', 'fourth', 'fifth']);
  assert.equal(harness.runtime.auxQueue.getStatus().active, 5);
  assert.deepEqual(harness.runtime.auxQueue.queue.map(task => task.prompt), ['sixth']);

  pending.shift()('one');
  assert.deepEqual(await tasks[0], { text: 'one', cancelled: false });
  await new Promise(resolve => setImmediate(resolve));
  // The freed slot admits exactly the next queued task, in order.
  assert.deepEqual(started, ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']);
  pending.forEach((resolve, index) => resolve(`done-${index}`));
  await Promise.all(tasks);
  assert.equal(harness.runtime.auxQueue.getStatus().queueDepth, 0);
  assert.equal(harness.runtime.auxQueue.processing, false);
});

test('resolveAuxConcurrency defaults to 5 and clamps the env override', () => {
  assert.equal(AUX_CONCURRENCY_DEFAULT, 5);
  assert.equal(AUX_CONCURRENCY_MAX, 16);
  assert.equal(resolveAuxConcurrency({}), 5);
  assert.equal(resolveAuxConcurrency({ MULTICC_AUX_CONCURRENCY: '3' }), 3);
  assert.equal(resolveAuxConcurrency({ AUX_CONCURRENCY: '2' }), 2);
  assert.equal(resolveAuxConcurrency({ MULTICC_AUX_CONCURRENCY: '0' }), 1);
  assert.equal(resolveAuxConcurrency({ MULTICC_AUX_CONCURRENCY: '-4' }), 1);
  assert.equal(resolveAuxConcurrency({ MULTICC_AUX_CONCURRENCY: '999' }), AUX_CONCURRENCY_MAX);
  assert.equal(resolveAuxConcurrency({ MULTICC_AUX_CONCURRENCY: 'nope' }), 5);
});

test('the pool size follows the injected env', async () => {
  const started = [];
  const gates = new Map();
  const harness = createHarness({
    env: { MULTICC_AUX_CONCURRENCY: '2' },
    executeAuxHttp: ({ prompt }) => new Promise(resolve => {
      started.push(prompt);
      gates.set(prompt, resolve);
    }),
  });
  const tasks = ['a', 'b', 'c'].map(prompt => harness.runtime.auxQueue.enqueue({ type: 'manual', prompt, meta: {} }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(harness.runtime.auxQueue.getStatus().concurrency, 2);
  assert.deepEqual(harness.runtime.auxQueue.queue.map(task => task.prompt), ['c']);
  const settle = async prompt => {
    gates.get(prompt)(`r-${prompt}`);
    await new Promise(resolve => setImmediate(resolve));
  };
  await settle('a');
  await settle('b');
  assert.deepEqual(started, ['a', 'b', 'c']);
  await settle('c');
  assert.deepEqual((await Promise.all(tasks)).map(result => result.text), ['r-a', 'r-b', 'r-c']);
  assert.deepEqual(harness.runtime.auxQueue.getStatus().running, []);
});

// 同一把 key = 同一个 session：并发池可以让不同 session 同时判词，但同一个
// session 的两次判词仍然严格先旧后新 —— 这是单并发时代靠全局串行顺带保证的。
test('tasks sharing a serialization key never overlap while other sessions keep running', async () => {
  const started = [];
  const pending = [];
  const harness = createHarness({
    executeAuxHttp: ({ prompt }) => new Promise(resolve => {
      started.push(prompt);
      pending.push(resolve);
    }),
  });
  const queue = harness.runtime.auxQueue;
  const a1 = queue.enqueue({ type: 'intent_classify', prompt: 'a1', meta: { sessionName: 'A' } });
  const b1 = queue.enqueue({ type: 'intent_classify', prompt: 'b1', meta: { sessionName: 'B' } });
  const a2 = queue.enqueue({ type: 'intent_classify', prompt: 'a2', meta: { sid: 'A' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b1']);
  assert.deepEqual(queue.queue.map(task => task.prompt), ['a2']);
  assert.equal(queue.hasPendingFor('A'), true);

  pending[0]('one');
  assert.deepEqual(await a1, { text: 'one', cancelled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  pending[1]('two');
  pending[2]('three');
  await Promise.all([b1, a2]);
});

// 「必须严格顺序执行」的那一类单独一条单并发 lane：memory 提炼/复盘写共享记忆
// 目录（多个 session 可能落到同一个 folder），并发写会互相覆盖。
test('strictly ordered Aux work runs in its own single-slot lane', async () => {
  const started = [];
  const pending = [];
  const harness = createHarness({
    executeAuxHttp: ({ prompt }) => new Promise(resolve => {
      started.push(prompt);
      pending.push(resolve);
    }),
  });
  const queue = harness.runtime.auxQueue;
  const review = queue.enqueue({ type: 'memory_review', prompt: 'mem-1', meta: { sessionId: 's1' } });
  const distill = queue.enqueue({ type: 'memory_distill', prompt: 'mem-2', meta: { sessionId: 's2' } });
  const classify = queue.enqueue({ type: 'intent_classify', prompt: 'cls', meta: { sessionName: 's1' } });
  await new Promise(resolve => setImmediate(resolve));
  // The two memory writes are serialized; the classify is untouched by them.
  assert.deepEqual(started, ['mem-1', 'cls']);
  assert.deepEqual(queue.queue.map(task => task.prompt), ['mem-2']);
  assert.deepEqual(queue.getStatus().lanes, {
    serial: { concurrency: 1, active: 1, queueDepth: 1 },
    pool: { concurrency: 5, active: 1, queueDepth: 0 },
  });

  pending[0]('one');
  await review;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['mem-1', 'cls', 'mem-2']);
  pending[1]('two');
  pending[2]('three');
  await Promise.all([classify, distill]);
  assert.equal(queue.isUnhealthy(), false);
});

test('the Aux status DTO keeps its legacy keys and adds the pool breakdown', async () => {
  let sequence = 0;
  const gate = new Promise(() => {});
  const harness = createHarness({
    crypto: { randomUUID: () => `slot-${++sequence}` },
    executeAuxHttp: () => gate,
  });
  const queue = harness.runtime.auxQueue;
  queue.enqueue({ type: 'intent_classify', prompt: 'busy', meta: { sessionName: 's9' } }).catch(() => {});
  queue.enqueue({ type: 'intent_classify', prompt: 'wait', meta: { sessionName: 's9' } }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  const status = (await invoke(harness.app, 'GET', '/api/aux/status')).body;
  assert.deepEqual(Object.keys(status).sort(), [
    'active', 'capacity', 'concurrency', 'currentTask', 'health', 'lanes',
    'lastTaskTime', 'processing', 'queueDepth', 'running', 'totalProcessed',
  ]);
  assert.equal(status.processing, true);
  assert.equal(status.queueDepth, 1);
  assert.deepEqual(status.currentTask, { id: 'slot-1', type: 'intent_classify', lane: 'pool' });
  assert.equal(status.active, 1);
  assert.equal(status.concurrency, 5);
  assert.equal(status.capacity, 6);
  assert.deepEqual(status.running, [{ id: 'slot-1', type: 'intent_classify', lane: 'pool' }]);
  assert.deepEqual(status.lanes.pool, { concurrency: 5, active: 1, queueDepth: 1 });
  assert.deepEqual(status.lanes.serial, { concurrency: 1, active: 0, queueDepth: 0 });
});

test('cancel and pending checks see every running slot, not only the first', async () => {
  let sequence = 0;
  const harness = createHarness({
    crypto: { randomUUID: () => `slot-${++sequence}` },
    executeAuxHttp: () => new Promise(() => {}),
  });
  const queue = harness.runtime.auxQueue;
  queue.enqueue({ type: 'intent_classify', prompt: 'one', meta: { sessionName: 's1' } }).catch(() => {});
  queue.enqueue({ type: 'intent_classify', prompt: 'two', meta: { sessionName: 's2' } }).catch(() => {});
  const queued = queue.enqueue({ type: 'manual', prompt: 'three', meta: { sessionName: 's2' } });
  queued.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queue.running.map(task => task.id), ['slot-1', 'slot-2']);
  assert.deepEqual(queue.queue.map(task => task.id), ['slot-3']);
  assert.equal(queue.hasPendingFor('s2'), true);
  assert.equal(queue.hasPendingFor('nope'), false);

  // Cancelling a slot that is NOT currentTask used to be a no-op.
  queue.cancel('slot-2');
  assert.equal(queue.running.find(task => task.id === 'slot-2').cancelled, true);
  // A queue-only cancel (the third task never starts) still rejects its promise.
  queue.cancel('slot-3');
  await assert.rejects(queued, error => error && error.cancelled === true);
  assert.equal(queue.queue.length, 0);
});

test('concurrent Aux failures still drive the shared health machine', async () => {
  const harness = createHarness({ executeAuxHttp: async () => { throw new Error('aux failed'); } });
  const queue = harness.runtime.auxQueue;
  await Promise.allSettled([
    queue.enqueue({ type: 'manual', prompt: 'one', meta: {} }),
    queue.enqueue({ type: 'manual', prompt: 'two', meta: {} }),
    queue.enqueue({ type: 'manual', prompt: 'three', meta: {} }),
  ]);
  assert.equal(queue.health.consecutiveFails, 3);
  assert.equal(queue.isUnhealthy(), true);
  assert.deepEqual(queue.getStatus().running, []);
  const recovered = createHarness({ executeAuxHttp: async () => 'ok' });
  recovered.runtime.auxQueue.health.unhealthy = true;
  recovered.runtime.auxQueue.health.consecutiveFails = 3;
  await recovered.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'fine', meta: {} });
  assert.equal(recovered.runtime.auxQueue.health.consecutiveFails, 0);
  assert.equal(recovered.runtime.auxQueue.isUnhealthy(), false);
});

test('in-flight cancellation does not poison Aux health when transport later fails', async () => {
  let rejectTransport;
  const observedErrors = [];
  const harness = createHarness({
    crypto: { randomUUID: () => 'cancel-current' },
    executeAuxHttp: () => new Promise((resolve, reject) => { rejectTransport = reject; }),
    recordApiError(message) { observedErrors.push(message); },
  });
  const pending = harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'cancel me', meta: {} });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  harness.runtime.auxQueue.cancel('cancel-current');
  rejectTransport(new Error('provider failed after cancel'));
  await assert.rejects(pending, error => error && error.cancelled === true);
  assert.equal(harness.runtime.auxQueue.health.consecutiveFails, 0);
  assert.deepEqual(observedErrors, []);
  assert.equal(harness.runtime.auxQueue.processing, false);
  assert.equal(harness.broadcasts.at(-1).payload.status, 'done');
  assert.equal(harness.broadcasts.at(-1).payload.cancelled, true);
});

test('cancelClassifyFor drops a session\'s queued and in-flight judgements, and nobody else\'s', async () => {
  let sequence = 0;
  const harness = createHarness({
    crypto: { randomUUID: () => `cls-${++sequence}` },
    executeAuxHttp: () => new Promise(() => {}),  // never settles: stays in flight
  });
  const queue = harness.runtime.auxQueue;
  const classify = (meta, prompt) => {
    const pending = queue.enqueue({ type: 'intent_classify', prompt, meta });
    pending.catch(() => {});
    return pending;
  };
  const running = classify({ sessionName: 's1' }, 'judge s1');
  const queued = classify({ sid: 's1' }, 'judge s1 again');   // sid is the other key
  classify({ sessionName: 's2' }, 'judge s2');
  queue.enqueue({ type: 'manual', prompt: 'unrelated', meta: { sessionName: 's1' } }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  // 并发池：s1 的第一条在跑，s1 的第二条与那条 manual 因为同一把 key 排在它后面；
  // s2 是另一把 key，所以它和 s1 同时在跑。
  assert.deepEqual(queue.running.map(task => task.id), ['cls-1', 'cls-3']);
  assert.deepEqual(queue.queue.map(task => task.id), ['cls-2', 'cls-4']);
  assert.equal(queue.currentTask.id, 'cls-1');

  // Two: the one already executing plus the one still queued.
  assert.equal(queue.cancelClassifyFor('s1'), 2);
  assert.equal(queue.running.find(task => task.id === 'cls-1').cancelled, true);
  await assert.rejects(queued, error => error && error.cancelled === true);
  // Another session's judgement and this session's non-classify work are untouched.
  assert.deepEqual(queue.queue.map(task => task.id), ['cls-4']);
  assert.deepEqual(queue.running.map(task => task.id), ['cls-1', 'cls-3']);
  // Idempotent: a repeated cancel has nothing left to drop.
  assert.equal(queue.cancelClassifyFor('s1'), 0);
  running.catch(() => {});
});

test('Aux WebSocket ownership cleans up on close and error', () => {
  const { runtime } = createHarness();
  const closed = new EventEmitter();
  runtime.auxQueue.attachClient(closed);
  assert.equal(runtime.auxQueue.clients.has(closed), true);
  closed.emit('close');
  assert.equal(runtime.auxQueue.clients.has(closed), false);

  const failed = new EventEmitter();
  runtime.auxQueue.attachClient(failed);
  assert.equal(runtime.auxQueue.clients.has(failed), true);
  assert.doesNotThrow(() => failed.emit('error', new Error('socket failed')));
  assert.equal(runtime.auxQueue.clients.has(failed), false);
});

test('Aux routes preserve history limiting, enqueue validation and response shape', async () => {
  const { app, runtime, chat } = createHarness();
  for (let index = 0; index < 4; index++) chat.push({ sessionId: AUX_SESSION_ID, message: { index } });
  let res = await invoke(app, 'GET', '/api/aux/history', { query: { limit: '2' } });
  assert.deepEqual(res.body, [{ index: 2 }, { index: 3 }]);
  res = await invoke(app, 'POST', '/api/aux/enqueue', { body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'prompt required' });
  res = await invoke(app, 'POST', '/api/aux/enqueue', { body: { prompt: 'ping' } });
  assert.deepEqual(res.body, { ok: true, result: 'aux-result', taskId: 'task-4' });
  assert.equal(runtime.auxQueue.getStatus().queueDepth, 0);
});

test('Aux failures never expose provider secrets or filesystem paths', async () => {
  const observedErrors = [];
  const harness = createHarness({
    executeAuxHttp: async () => {
      throw new Error('Bearer sk-secret-token from /Users/example/private/provider.json');
    },
    recordApiError(message) { observedErrors.push(message); },
  });
  const res = await invoke(harness.app, 'POST', '/api/aux/enqueue', {
    body: { prompt: 'safe user prompt' },
  });
  assert.deepEqual(res.body, { ok: false, error: 'aux failed', taskId: 'task-0' });
  assert.equal(observedErrors.length, 1);
  assert.equal(observedErrors[0].message, 'aux failed');
  assert.doesNotMatch(JSON.stringify(observedErrors[0]), /secret-token|\/Users\/example/);
  assert.equal(harness.runtime.auxQueue.health.lastFailMsg, 'aux failed');
  assert.equal(harness.chat.at(-1).message.content, '[ERROR] aux failed');
  assert.equal(harness.broadcasts.at(-1).payload.error, 'aux failed');
  assert.equal(safeAuxErrorMessage(new Error('timeout')), 'timeout');
});

test('Aux authentication/configuration failures fail fast without recovery probes', async () => {
  const harness = createHarness({
    executeAuxHttp: async () => {
      const error = new Error('permission denied');
      error.status = 403;
      throw error;
    },
    recordApiError(raw) {
      assert.equal(raw.httpStatus, 403);
      return {
        action: 'fail_fast',
        reason: 'authentication_permission_not_retryable',
        error: {
          category: 'authentication_permission',
          provider: 'aux-openai',
          code: null,
          httpStatus: 403,
          retryable: false,
          retryAfterMs: null,
        },
      };
    },
  });
  await assert.rejects(
    harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'safe', meta: {} }),
    /permission denied/,
  );
  const health = harness.runtime.auxQueue.getStatus().health;
  assert.equal(health.unhealthy, true);
  assert.equal(health.retryable, false);
  assert.equal(health.category, 'authentication_permission');
});

test('an unhealthy observation never suppresses the next Aux request', async () => {
  let calls = 0;
  const harness = createHarness({
    executeAuxHttp: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('permission denied');
        error.status = 403;
        throw error;
      }
      return 'recovered-response';
    },
    recordApiError: () => ({
      action: 'fail_fast',
      error: { category: 'authentication_permission', retryable: false },
    }),
  });

  await assert.rejects(
    harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'first', meta: {} }),
    /permission denied/,
  );
  assert.equal(harness.runtime.auxQueue.isUnhealthy(), true);

  const next = await harness.runtime.auxQueue.enqueue({
    type: 'manual', prompt: 'second', meta: {},
  });
  assert.equal(calls, 2, 'the second request must reach executeAuxHttp');
  assert.equal(next.text, 'recovered-response');
  assert.equal(harness.runtime.auxQueue.isUnhealthy(), false);
});

test('Goal helpers keep clamping, framing and defensive verdict parsing', () => {
  assert.deepEqual(resolveGoalLimits({ maxRounds: 999, maxBudget: -2 }), { maxRounds: 200, maxBudget: 0 });
  assert.match(buildGoalLimitNote({ maxRounds: 3, maxBudget: 50 }), /3 轮/);
  assert.match(buildGoalLimitNote({ maxRounds: 3, maxBudget: 50 }), /50/);
  assert.deepEqual(normalizeGoalConfig({ dimensions: { scope: false }, minScore: 101 }), {
    dimensions: { objective: true, criteria: true, scope: false, executable: true },
    minScore: 100,
  });
  const malformed = parseGoalVerdict('not json');
  assert.equal(malformed.verdict, 'needs_work');
  assert.equal(malformed.score, 0);
  assert.equal(malformed.raw, 'not json');
});

test('Goal routes preserve settings DTO and downgrade scores below threshold', async () => {
  const { app, writes } = createHarness();
  let res = await invoke(app, 'GET', '/api/settings/goal');
  assert.equal(res.body.minScore, 75);
  assert.equal(res.body.dimensions.scope, false);
  assert.equal(typeof res.body.dimensionLabels.objective, 'string');

  res = await invoke(app, 'POST', '/api/settings/goal', {
    body: { dimensions: { objective: false }, minScore: 80 },
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.minScore, 80);
  assert.deepEqual(writes.at(-1).value, {
    dimensions: { objective: false, criteria: true, scope: true, executable: true },
    minScore: 80,
  });

  res = await invoke(app, 'POST', '/api/goal/precheck', {
    body: { task: 'ship it', minScore: 80 },
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verdict, 'needs_work');
  assert.equal(res.body.score, 70);
  assert.match(res.body.issues[0], /低于设定阈值 80/);
  assert.equal(res.body.revised, 'better');
});

// Regression (2026-09-23 user report): Goal precheck answered every time with a
// bare client abort. Two things had to be true: the request must be allowed to
// outlive the 15s generic client budget, and the server must never hold the
// response open forever behind a stalled Aux transport.
test('goal precheck answers with an explicit AUX_TIMEOUT instead of hanging on a stalled aux transport', async () => {
  const harness = createHarness({
    env: { AUX_TIMEOUT_MS: '12345', GOAL_PRECHECK_TIMEOUT_MS: '30' },
    executeAuxHttp: () => new Promise(() => {}),   // never settles
  });
  const res = await invoke(harness.app, 'POST', '/api/goal/precheck', { body: { task: 'ship it' } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'AUX_TIMEOUT');
  assert.match(res.body.error, /预检超时/);
});

// Regression (2026-09-23 user follow-up): "辅助模型应该很快啊，他就是一个请求而已？"
// 池子满了以后（5 个在跑）才是排序问题：预检曾经排在一堆后台 classify /
// memory_review 后面，队列等待实测最长可到两分钟。人在等的那个请求必须插队。
test('an interactive goal precheck jumps ahead of already-queued background Aux work', async () => {
  const releases = [];
  const started = [];
  const harness = createHarness({
    executeAuxHttp: async ({ prompt }) => {
      const kind = prompt.includes('任务质量审查助手') ? 'goal_check' : 'background';
      started.push(kind);
      // 只把填满池子的那 5 个后台任务挂住：第 6 个和预检都必须等出槽位。
      if (kind === 'background' && started.filter(item => item === 'background').length <= 5) {
        await new Promise(resolve => { releases.push(resolve); });
      }
      return kind === 'goal_check'
        ? JSON.stringify({ verdict: 'ok', score: 90, issues: [], questions: [], criteria: [], revised: '' })
        : 'aux-result';
    },
  });
  harness.runtime.auxQueue.init();

  const backgrounds = [];
  for (let index = 0; index < 6; index += 1) {
    backgrounds.push(harness.runtime.auxQueue.enqueue({ type: 'intent_classify', prompt: `bg-${index}`, meta: {} }));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.filter(item => item === 'background').length, 5);
  assert.deepEqual(harness.runtime.auxQueue.queue.map(task => task.prompt), ['bg-5']);

  const res = createResponse();
  const pending = harness.app.routes.get('POST /api/goal/precheck')({ body: { task: 'ship it' } }, res);
  // The precheck arrived last and still queues ahead of bg-5: order is the point.
  assert.deepEqual(harness.runtime.auxQueue.queue.map(task => task.type), ['goal_check', 'intent_classify']);
  assert.deepEqual(harness.runtime.auxQueue.queue.map(task => task.priority), ['interactive', 'background']);

  releases.splice(0).forEach(resolve => resolve());
  // The precheck route answers from inside the queue's `.then`, so the handler
  // itself returns nothing — wait on the response instead.
  assert.equal(pending, undefined);
  await res.completed;
  assert.equal(res.body.ok, true);
  // The freed slots admit the precheck first, then the leftover background task.
  assert.deepEqual(started.slice(5, 7), ['goal_check', 'background']);
  await Promise.all(backgrounds);
  assert.equal(harness.runtime.auxQueue.getStatus().queueDepth, 0);
});

// The web client must consume the published budget rather than repeat the number.
// Two hard-coded copies is exactly how this broke: 15s of generic client budget
// against a ~18s Aux call.
test('the web precheck consumes the published wait budget instead of hard-coding one', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  const settingsRead = host.slice(host.indexOf("'/api/settings/goal'"));
  assert.ok(settingsRead.includes('precheckWaitMs'), 'loadGoalDims reads precheckWaitMs');
  assert.ok(host.includes('timeoutMs: goalPrecheckTimeoutMs()'), 'precheck uses the derived budget');
  const call = host.slice(host.indexOf("'/api/goal/precheck'"), host.indexOf('renderGoalVerdict'));
  assert.ok(!/timeoutMs:\s*\d+/.test(call), 'no numeric literal on the precheck call');
});

// The client must not guess this number: whatever the route enforces is what
// /api/settings/goal publishes, so the two cannot drift apart again.
test('the precheck wait budget the client reads is the one the route enforces', async () => {
  const tuned = createHarness({ env: { AUX_TIMEOUT_MS: '12345', GOAL_PRECHECK_TIMEOUT_MS: '30' } });
  assert.equal((await invoke(tuned.app, 'GET', '/api/settings/goal')).body.precheckWaitMs, 1000);

  const dflt = createHarness({ env: { AUX_TIMEOUT_MS: '12345' } });
  // max(30s, 2 × AUX_TIMEOUT_MS) = 30s here: one queued call plus this one.
  assert.equal((await invoke(dflt.app, 'GET', '/api/settings/goal')).body.precheckWaitMs, 30000);
});

test('goal precheck forwards its own inference timeout to the aux transport', async () => {
  const seen = [];
  const harness = createHarness({
    executeAuxHttp: async (args) => {
      seen.push(args.timeoutMs);
      return JSON.stringify({ verdict: 'ok', score: 90, issues: [], questions: [], criteria: [], revised: '' });
    },
  });
  const res = await invoke(harness.app, 'POST', '/api/goal/precheck', { body: { task: 'ship it' } });
  assert.equal(res.body.ok, true);
  assert.deepEqual(seen, [12345]);
});

test('enqueue with valid id echoes taskId in both success and failure responses', async () => {
  const successHarness = createHarness();
  const successRes = await invoke(successHarness.app, 'POST', '/api/aux/enqueue', {
    body: { prompt: 'ping', id: 'my-task-id' },
  });
  assert.equal(successRes.body.ok, true);
  assert.equal(successRes.body.taskId, 'my-task-id');

  const failHarness = createHarness({
    executeAuxHttp: async () => { throw new Error('fail'); },
  });
  const failRes = await invoke(failHarness.app, 'POST', '/api/aux/enqueue', {
    body: { prompt: 'ping', id: 'fail-task-id' },
  });
  assert.equal(failRes.body.ok, false);
  assert.equal(failRes.body.taskId, 'fail-task-id');
  assert.equal(failRes.body.error, 'fail');
});

test('enqueue with invalid id falls back to server-generated taskId', async () => {
  const { app } = createHarness();
  let res = await invoke(app, 'POST', '/api/aux/enqueue', {
    body: { prompt: 'ping', id: 'has spaces' },
  });
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.taskId, 'string');
  assert.notEqual(res.body.taskId, 'has spaces');

  res = await invoke(app, 'POST', '/api/aux/enqueue', {
    body: { prompt: 'ping', id: '   ' },
  });
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.taskId, 'string');
  assert.ok(res.body.taskId.trim().length > 0);
});

test('POST /api/aux/cancel returns 400 for missing id and 200 for any provided id', async () => {
  const { app } = createHarness();
  let res = await invoke(app, 'POST', '/api/aux/cancel', { body: {} });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'id required' });

  res = await invoke(app, 'POST', '/api/aux/cancel', { body: { id: 'unknown' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  res = await invoke(app, 'POST', '/api/aux/cancel', { body: { id: 'unknown' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('POST /api/aux/cancel cancels an in-flight task by id', async () => {
  let rejectTransport;
  const harness = createHarness({
    crypto: { randomUUID: () => 'cancel-test-id' },
    executeAuxHttp: () => new Promise((resolve, reject) => { rejectTransport = reject; }),
  });
  const pending = harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'cancel me', meta: {} });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  const res = await invoke(harness.app, 'POST', '/api/aux/cancel', { body: { id: 'cancel-test-id' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  rejectTransport(new Error('provider failed after cancel'));
  await assert.rejects(pending, error => error && error.cancelled === true);
});

test('GET /api/aux/config attaches the persisted limit summary + freshness from real SQLite rows', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { createProviderLimitCache } = require('../src/quota/provider-limit-cache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-aux-limit-'));
  const cache = createProviderLimitCache({ file: path.join(dir, 'provider-limit-cache.db'), now: () => 1000 });
  // Seed two different providers with different summaries + freshness.
  cache.record('claude', 'claude-one', {
    kind: 'window',
    summary: { kind: 'window', provider: 'claude', status: 'allowed', usedPercentage: 20 },
    summaryText: '5h 80%',
    barText: '5h 80% {cd:123}',
    fetchedAt: 900,
  });
  cache.record('codex', 'codex-one', {
    kind: 'window',
    summary: { kind: 'window', provider: 'codex', status: 'allowed', usedPercentage: 60 },
    summaryText: '1d 40%',
    fetchedAt: 100,
  });
  const harness = createHarness({
    providers: {
      listProviders(appType) {
        return appType === 'codex'
          ? [{ id: 'codex-one', appType: 'codex', name: 'Codex One', modelOptions: ['gpt-test'] }]
          : [{ id: 'claude-one', appType: 'claude', name: 'Claude One', modelOptions: ['claude-test'] }];
      },
      resolveAuxHttpTarget(protocol, providerId) {
        if (providerId === 'unavailable') return { available: false, reason: 'no endpoint' };
        return {
          available: true,
          wireApi: protocol === 'openai' ? 'responses' : 'messages',
          model: protocol === 'openai' ? 'gpt-test' : 'claude-test',
          modelOptions: protocol === 'openai' ? ['gpt-test'] : ['claude-test'],
          protocol,
          providerId,
        };
      },
    },
    providerLimitCache: cache,
    // 500ms window on a fake millisecond clock (now=1000): claude (100ms old) is
    // fresh, codex (900ms old) is stale — exercises both branches deterministically.
    limitCacheStaleMs: 500,
    now: () => 1000,
  });
  harness.runtime.auxQueue.init();
  const res = await invoke(harness.app, 'GET', '/api/aux/config');
  const anthropic = res.body.providersByProtocol.anthropic.find(p => p.id === 'claude-one');
  const openai = res.body.providersByProtocol.openai.find(p => p.id === 'codex-one');
  assert.ok(anthropic, 'claude-one present');
  assert.ok(openai, 'codex-one present');
  assert.equal(anthropic.limit.kind, 'window');
  assert.equal(anthropic.limit.summaryText, '5h 80%');
  assert.equal(anthropic.limit.stale, false); // fetchedAt 900 → 100ms old < 500ms
  assert.equal(openai.limit.summaryText, '1d 40%');
  assert.equal(openai.limit.stale, true); // fetchedAt 100 → 900ms old > 500ms
  // The public projection never leaks the raw bar placeholders.
  assert.equal(JSON.stringify(res.body).includes('{cd'), false);
  // A provider without a cache row gets a clean null limit, not an error.
  const harness2 = createHarness({ providerLimitCache: cache, limitCacheStaleMs: 600000 });
  harness2.runtime.auxQueue.init();
  const res2 = await invoke(harness2.app, 'GET', '/api/aux/config');
  for (const group of Object.values(res2.body.providersByProtocol)) {
    for (const p of group) assert.equal(p.limit, null);
  }
});

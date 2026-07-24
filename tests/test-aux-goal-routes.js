'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  AUX_SESSION_ID,
  AUX_HISTORY_MAX,
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

test('Aux queue is FIFO and never overlaps direct HTTP tasks', async () => {
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
  const first = harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'first', meta: {} });
  const second = harness.runtime.auxQueue.enqueue({ type: 'manual', prompt: 'second', meta: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  assert.equal(harness.runtime.auxQueue.getStatus().queueDepth, 1);

  pending.shift()('one');
  assert.deepEqual(await first, { text: 'one', cancelled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'second']);
  pending.shift()('two');
  assert.deepEqual(await second, { text: 'two', cancelled: false });
  assert.equal(harness.runtime.auxQueue.processing, false);
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

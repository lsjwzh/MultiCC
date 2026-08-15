'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');
const { buildReplayMessages, createChatHistoryRuntime } = require('../src/routes/chat-history');

test('reconnect promotes a persisted interim into the one live streaming tail', () => {
  const messages = buildReplayMessages([{
    id: 'interim-1', role: 'assistant', content: 'first batch', _interim: true, ts: 10,
  }], {
    currentAssistantText: 'first batch plus second batch',
    currentToolCalls: [{ id: 'tool-1', name: 'Read' }],
    isStreaming: true,
    _resultSaved: false,
  }, () => 20);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    id: 'interim-1', role: 'assistant', content: 'first batch plus second batch',
    _interim: true, ts: 20, streaming: true,
    tools: [{ id: 'tool-1', name: 'Read' }],
  });
});

test('reconnect appends an id-less live tail only when no interim exists', () => {
  const messages = buildReplayMessages([
    { id: 'user-1', role: 'user', content: 'question' },
  ], {
    currentAssistantText: 'answer', currentToolCalls: [], isStreaming: true,
  }, () => 30);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, 'answer');
  assert.equal(messages[1].streaming, true);
  assert.equal(messages[1].id, undefined);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryHistory(events, initial = {}) {
  const records = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  let writeFailure = null;
  return {
    records,
    failNextWrite(error) { writeFailure = error; },
    read(sessionId) { return clone(records.get(String(sessionId)) || []); },
    write(sessionId, messages) {
      events.push(`write:${sessionId}`);
      if (writeFailure) {
        const error = writeFailure;
        writeFailure = null;
        throw error;
      }
      records.set(String(sessionId), clone(messages));
    },
    deleteSession(sessionId) { return records.delete(String(sessionId)); },
    hasPersistedDelivery(sessionId, deliveryId) {
      return (records.get(String(sessionId)) || []).some(message =>
        message.deliveryId === deliveryId || message.clientMsgId === deliveryId);
    },
  };
}

function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function fixture(overrides = {}) {
  const events = [];
  const immediate = [];
  const timerRecords = [];
  const persistedSessions = overrides.persistedSessions || new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude', branch: 'main' }],
  ]);
  const chatState = { cli: 'claude', turnStartedAt: 4500, chatTurnCount: 7 };
  const chatSessions = overrides.chatSessions || new Map([['s1', chatState]]);
  const history = overrides.history || createMemoryHistory(events, overrides.initial || {});
  let id = 0;
  const logs = [];
  const deps = {
    history,
    persistedSessions,
    chatSessions,
    idFactory: () => `id-${++id}`,
    now: () => 5000,
    maxMessages: overrides.maxMessages || 100,
    historyPageSize: overrides.historyPageSize || 2,
    memoryDistillBatch: overrides.memoryDistillBatch || 2,
    incrementalSaveDelayMs: 25,
    auxSessionId: '__aux__',
    chatBroadcast(sessionId, payload) {
      events.push(`broadcast:${payload.type}:${sessionId}`);
      events.push({ payload: clone(payload) });
    },
    distillHistoryIntoMemory(sessionId, messages) {
      events.push(`distill:${sessionId}:${messages.length}`);
      return Promise.resolve({ updated: true });
    },
    maybeSchedulePeriodicMemoryReview(sessionId) { events.push(`review:${sessionId}`); },
    async cliSwitchGitSnapshot(session) {
      events.push(`git:${session.id}`);
      return { branch: session.branch, head: 'abc', changes: [] };
    },
    chatStream: { close(sessionId) { events.push(`stream-close:${sessionId}`); } },
    clearAllNativeCliStates(session) {
      events.push(`clear-native:${session.id}`);
      session.cliSessionId = null;
      return 2;
    },
    buildHandoffCheckpoint(input) {
      events.push(`checkpoint:${input.session.id}`);
      return { createdAt: 123, history: clone(input.history), git: clone(input.git) };
    },
    rememberActiveCliState(session) { events.push(`remember:${session.id}`); },
    saveBestEffort(source) { events.push(`save:${source}`); },
    isSessionBusy() {
      return overrides.rotationBlock === 'session_busy';
    },
    getSessionRunState() {
      return overrides.runState || 'idle';
    },
    getActiveBackgroundTasks() {
      return overrides.rotationBlock === 'background_tasks_running' ? [{ id: 'bg-1' }] : [];
    },
    sessionPersistence: {
      mutate(source, mutator) {
        events.push(`persist:${source}`);
        return mutator(persistedSessions);
      },
    },
    trackPendingMemoryDistill(sessionId, promise) {
      events.push(`track:${sessionId}`);
      return promise;
    },
    randomBytes: () => Buffer.from('0011223344556677', 'hex'),
    setImmediate(fn) { immediate.push(fn); return { unref() {} }; },
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timerRecords.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    logger: { warn(event, payload) { logs.push({ event, payload: clone(payload) }); } },
    ...overrides.deps,
  };
  const runtime = createChatHistoryRuntime(deps);
  return { runtime, history, persistedSessions, chatSessions, chatState, events, immediate, timerRecords, logs };
}

function eventNames(events) {
  return events.filter(value => typeof value === 'string');
}

test('dependency boundary fails closed before registering routes or timers', () => {
  assert.throws(() => createChatHistoryRuntime(), /dependencies are required/);
  assert.throws(() => createChatHistoryRuntime({ history: {} }), /history\.read/);
  const fx = fixture();
  assert.throws(() => fx.runtime.mountRoutes({ get() {} }), /app\.delete/);
});

test('append broadcasts metadata only after durable write and stamps assistant latency', () => {
  const fx = fixture();
  const message = { role: 'assistant', content: 'done', ts: 5000 };
  assert.equal(fx.runtime.appendMessage('s1', message), true);
  assert.equal(message.id, 'id-1');
  assert.equal(message.durationMs, 500);
  assert.deepEqual(eventNames(fx.events).slice(0, 2), [
    'write:s1',
    'broadcast:chat_msg_meta:s1',
  ]);
  assert.equal(fx.chatState.lastActivity.toISOString(), new Date(5000).toISOString());
  assert.equal(fx.immediate.length, 1);
  fx.immediate.shift()();
  assert.equal(eventNames(fx.events).at(-1), 'review:s1');
});

test('append surfaces answeredQuestionId so multi-window clients can settle the prompt from the message', () => {
  const fx = fixture();
  const message = {
    role: 'user', content: '是', ts: 5000,
    clientMsgId: 'c1', answeredQuestionId: 'usrq-7',
  };
  assert.equal(fx.runtime.appendMessage('s1', message), true);
  const meta = fx.events
    .find(event => event && event.payload && event.payload.type === 'chat_msg_meta');
  assert.ok(meta, 'expected a chat_msg_meta broadcast');
  assert.equal(meta.payload.message.answeredQuestionId, 'usrq-7');
  assert.equal(meta.payload.message.content, '是');
  // The marker is metadata-only and never reaches the model: a plain user
  // message without it projects cleanly too.
  fx.runtime.appendMessage('s1', { role: 'user', content: 'plain', ts: 5000 });
  const plainMeta = fx.events
    .filter(event => event && event.payload && event.payload.type === 'chat_msg_meta')
    .at(-1);
  assert.equal(plainMeta.payload.message.answeredQuestionId, undefined);
});

test('write failure has no broadcast proof and diagnostics redact paths and credentials', () => {
  const fx = fixture();
  fx.history.failNextWrite(new Error('token=secret /Users/private/chat.json'));
  assert.equal(fx.runtime.appendMessage('s1', { role: 'assistant', content: 'lost', ts: 5000 }), false);
  assert.deepEqual(eventNames(fx.events), ['write:s1']);
  assert.equal(fx.chatState.lastActivity, undefined);
  assert.equal(fx.logs[0].event, 'chat_history_append_failed');
  assert.equal(fx.logs[0].payload.error, 'chat history operation failed');
  assert.doesNotMatch(JSON.stringify(fx.logs), /secret|\/Users\/private/);
});

test('HTTP pagination and delete preserve legacy DTOs, status codes and commit ordering', () => {
  const fx = fixture({ initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
    { id: 'm2', role: 'assistant', content: 'two' },
    { id: 'm3', role: 'user', content: 'three' },
  ] } });
  const app = createFakeApp();
  fx.runtime.mountRoutes(app);

  let res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 's1' }, query: { limit: '2' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    messages: [
      { id: 'm2', role: 'assistant', content: 'two' },
      { id: 'm3', role: 'user', content: 'three' },
    ],
    hasMore: true,
  });

  res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 's1' }, query: { before: 'm2', limit: '50' },
  }, res);
  assert.deepEqual(res.body, {
    messages: [{ id: 'm1', role: 'user', content: 'one' }],
    hasMore: false,
  });

  fx.events.length = 0;
  res = createResponse();
  app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
    params: { id: 's1', msgId: 'm2' }, query: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(eventNames(fx.events), [
    'write:s1',
    'broadcast:chat_msg_deleted:s1',
  ]);

  res = createResponse();
  app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
    params: { id: 's1', msgId: 'missing' }, query: {},
  }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'message not found' });

  res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 'missing' }, query: {},
  }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'session not found' });
});

test('HTTP pagination projects the full history before slicing a page', () => {
  const seen = [];
  const fx = fixture({
    initial: { s1: [
      { id: 'm1', role: 'assistant', content: 'one', usage: { value: 10 } },
      { id: 'm2', role: 'assistant', content: 'two', usage: { value: 15 } },
      { id: 'm3', role: 'assistant', content: 'three', usage: { value: 19 } },
    ] },
    deps: {
      projectMessages(sessionId, messages) {
        seen.push({ sessionId, count: messages.length });
        let previous = 0;
        return messages.map(message => {
          const next = clone(message);
          next.usage.value -= previous;
          previous = message.usage.value;
          return next;
        });
      },
    },
  });
  const page = fx.runtime.paginate('s1', { limit: 2 });
  assert.deepEqual(seen, [{ sessionId: 's1', count: 3 }]);
  assert.deepEqual(page.messages.map(message => message.usage.value), [5, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(fx.history.records.get('s1')[1].usage.value, 15,
    'read-time projection never mutates the durable record');
});

test('HTTP around pagination locates an exact id in projected history without changing legacy pages', () => {
  const fx = fixture({
    initial: { s1: [
      { id: 'm1', role: 'user', content: 'one', ts: 100 },
      { id: 'm2', role: 'assistant', content: 'two', ts: 100 },
      { id: 'm3', role: 'user', content: 'three', ts: 100 },
      { id: 'm4', role: 'assistant', content: 'four', ts: 100 },
      { id: 'm5', role: 'user', content: 'five', ts: 100 },
    ] },
    deps: {
      projectMessages(sessionId, messages) {
        return messages.map(message => ({ ...message, projectedFor: sessionId }));
      },
    },
  });
  const app = createFakeApp();
  fx.runtime.mountRoutes(app);

  let res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 's1' }, query: { around: 'm3', limit: '3' },
  }, res);
  assert.deepEqual(res.body, {
    messages: [
      { id: 'm2', role: 'assistant', content: 'two', ts: 100, projectedFor: 's1' },
      { id: 'm3', role: 'user', content: 'three', ts: 100, projectedFor: 's1' },
      { id: 'm4', role: 'assistant', content: 'four', ts: 100, projectedFor: 's1' },
    ],
    hasMore: true,
    found: true,
    hasNewer: true,
  });

  res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 's1' }, query: { around: 'does-not-exist', limit: '3' },
  }, res);
  assert.deepEqual(res.body, {
    messages: [], hasMore: false, found: false, hasNewer: false,
  });

  res = createResponse();
  app.routes.get('GET /api/sessions/:id/history')({
    params: { id: 's1' }, query: { limit: '1' },
  }, res);
  assert.deepEqual(res.body, {
    messages: [
      { id: 'm5', role: 'user', content: 'five', ts: 100, projectedFor: 's1' },
    ],
    hasMore: true,
  });
});

test('HTTP delete persistence failure reaches the terminal safe boundary without a false broadcast', () => {
  const fx = fixture({ initial: { s1: [{ id: 'm1', role: 'user', content: 'one' }] } });
  const app = createFakeApp();
  fx.runtime.mountRoutes(app);
  fx.history.failNextWrite(new Error('password=hunter2 /private/history.json'));
  const res = createResponse();
  let forwarded = null;
  app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
    params: { id: 's1', msgId: 'm1' }, query: {},
  }, res, error => { forwarded = error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, undefined);
  assert.equal(forwarded.message, 'chat history operation failed');
  assert.deepEqual(eventNames(fx.events), ['write:s1']);
  assert.doesNotMatch(JSON.stringify({ forwarded: forwarded.message, logs: fx.logs }), /hunter2|\/private\/history/);
});

test('clear is durable-first, broadcasts one authoritative page, then resets native contexts', async () => {
  const fx = fixture({ initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
    { id: 'm2', role: 'assistant', content: 'two' },
    { id: 'm3', role: 'user', content: 'three' },
    { id: 'm4', role: 'assistant', content: 'four' },
  ] } });
  const result = await fx.runtime.clearHistory('s1', { keep: '2' }, fx.chatState);
  assert.deepEqual(result, {
    keep: 2,
    removedCount: 2,
    retainedCount: 2,
    clearedNativeSessions: 2,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['m3', 'm4']);
  assert.deepEqual(eventNames(fx.events), [
    'git:s1',
    'write:s1',
    'distill:s1:2',
    'broadcast:chat_history_reset:s1',
    'stream-close:s1',
    'clear-native:s1',
    'checkpoint:s1',
    'remember:s1',
    'save:websocket.clear-native-session-state',
    'track:s1',
  ]);
  const reset = fx.events.find(value => value && value.payload)?.payload;
  assert.deepEqual(reset, {
    type: 'chat_history_reset',
    messages: [
      { id: 'm3', role: 'user', content: 'three' },
      { id: 'm4', role: 'assistant', content: 'four' },
    ],
    hasMore: false,
    keep: 2,
    removedCount: 2,
    retainedCount: 2,
  });
  assert.equal(fx.chatState.chatTurnCount, 0);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff.reason, 'history_clear_keep');
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff.checkpoint.reason, 'history_clear_keep');
});

test('clear write failure is sanitized and cannot reset clients or native CLI state', async () => {
  const fx = fixture({ initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
    { id: 'm2', role: 'assistant', content: 'two' },
  ] } });
  fx.history.failNextWrite(new Error('api_key=abc /Users/private/history.json'));
  await assert.rejects(
    fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState),
    error => error.code === 'CHAT_HISTORY_CLEAR_FAILED'
      && error.message === 'chat history clear failed',
  );
  assert.deepEqual(eventNames(fx.events), ['write:s1']);
  assert.equal(fx.chatState.chatTurnCount, 7);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  assert.doesNotMatch(JSON.stringify(fx.logs), /abc|\/Users\/private/);
});

test('manual native context rotation preserves full history and commits a one-shot checkpoint', async () => {
  const persistedSessions = new Map([
    ['s1', {
      id: 's1', kind: 'chat', cli: 'claude', branch: 'main',
      cliSessionId: 'native-old',
    }],
  ]);
  const fx = fixture({
    persistedSessions,
    initial: { s1: [
      { id: 'm1', role: 'user', content: 'first' },
      { id: 'm2', role: 'assistant', content: 'done' },
    ] },
  });
  const before = clone(fx.history.records.get('s1'));
  const result = await fx.runtime.rotateNativeContext('s1', fx.chatState);

  assert.deepEqual(result, {
    ok: true,
    reused: false,
    checkpointId: 'checkpoint_0011223344556677',
    clearedNativeSessions: 2,
  });
  assert.deepEqual(fx.history.records.get('s1'), before);
  assert.deepEqual(eventNames(fx.events), [
    'git:s1',
    'checkpoint:s1',
    'persist:websocket.rotate-native-context',
    'clear-native:s1',
    'remember:s1',
    'stream-close:s1',
    'broadcast:native_context_rotated:s1',
  ]);
  assert.equal(fx.persistedSessions.get('s1').cliSessionId, null);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff.status, 'pending');
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff.reason, 'manual_native_context_rotate');
  assert.equal(
    fx.persistedSessions.get('s1').pendingCliHandoff.checkpoint.reason,
    'manual_native_context_rotate',
  );
  assert.equal(fx.chatState.chatTurnCount, 0);
});

test('manual native context rotation is idempotent while its checkpoint is pending', async () => {
  const pending = {
    id: 'checkpoint-existing',
    status: 'pending',
    reason: 'manual_native_context_rotate',
  };
  const persistedSessions = new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude', pendingCliHandoff: pending }],
  ]);
  const fx = fixture({ persistedSessions });
  const result = await fx.runtime.rotateNativeContext('s1', fx.chatState);
  assert.deepEqual(result, {
    ok: true,
    reused: true,
    checkpointId: 'checkpoint-existing',
    clearedNativeSessions: 0,
  });
  assert.deepEqual(eventNames(fx.events), ['broadcast:native_context_rotated:s1']);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, pending);
});

test('persisted manual rotation recovers after reload without clearing native state twice', async () => {
  const first = fixture({
    persistedSessions: new Map([
      ['s1', { id: 's1', kind: 'chat', cli: 'claude', cliSessionId: 'native-old' }],
    ]),
    initial: { s1: [{ id: 'm1', role: 'assistant', content: 'tranche done' }] },
  });
  const rotated = await first.runtime.rotateNativeContext('s1', first.chatState);
  const recoveredRecord = clone(first.persistedSessions.get('s1'));
  const recovered = fixture({
    persistedSessions: new Map([['s1', recoveredRecord]]),
    initial: { s1: clone(first.history.records.get('s1')) },
  });
  const replay = await recovered.runtime.rotateNativeContext('s1', recovered.chatState);

  assert.equal(replay.reused, true);
  assert.equal(replay.checkpointId, rotated.checkpointId);
  assert.equal(recoveredRecord.cliSessionId, null);
  assert.equal(
    eventNames(recovered.events).includes('persist:websocket.rotate-native-context'),
    false,
  );
  assert.equal(eventNames(recovered.events).includes('clear-native:s1'), false);
});

test('manual native context rotation rejects busy sessions without changing history or native state', async () => {
  const persistedSessions = new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude', cliSessionId: 'native-old' }],
  ]);
  const fx = fixture({
    persistedSessions,
    rotationBlock: 'background_tasks_running',
    initial: { s1: [{ id: 'm1', role: 'user', content: 'keep' }] },
  });
  const result = await fx.runtime.rotateNativeContext('s1', fx.chatState);
  assert.deepEqual(result, { ok: false, code: 'background_tasks_running' });
  assert.equal(fx.persistedSessions.get('s1').cliSessionId, 'native-old');
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  assert.deepEqual(fx.history.records.get('s1'), [{ id: 'm1', role: 'user', content: 'keep' }]);
  assert.deepEqual(eventNames(fx.events), ['broadcast:native_context_rotation_rejected:s1']);
});

test('manual native context rotation fails closed when durable session commit fails', async () => {
  const persistedSessions = new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude', cliSessionId: 'native-old' }],
  ]);
  const fx = fixture({
    persistedSessions,
    initial: { s1: [{ id: 'm1', role: 'user', content: 'keep' }] },
    deps: {
      sessionPersistence: {
        mutate() {
          throw new Error('api_key=secret /private/sessions.json');
        },
      },
    },
  });
  await assert.rejects(
    fx.runtime.rotateNativeContext('s1', fx.chatState),
    error => error.code === 'NATIVE_CONTEXT_ROTATION_FAILED'
      && error.message === 'native context rotation failed',
  );
  assert.equal(fx.persistedSessions.get('s1').cliSessionId, 'native-old');
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  assert.deepEqual(eventNames(fx.events), ['git:s1', 'checkpoint:s1']);
  assert.doesNotMatch(JSON.stringify(fx.logs), /secret|\/private\/sessions/);
});

test('incremental saves are single-flight, cancellable and drained on stop', () => {
  const fx = fixture();
  const state = {
    currentAssistantText: 'this assistant output is long enough',
    currentToolCalls: [{ id: 't1', name: 'Read' }],
  };
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), true);
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), false);
  assert.equal(fx.timerRecords.length, 1);
  assert.equal(fx.timerRecords[0].delay, 25);
  assert.equal(fx.timerRecords[0].unrefCalled, true);
  fx.timerRecords[0].fn();
  assert.equal(fx.runtime.hasIncrementalSave('s1'), false);
  assert.equal(fx.history.records.get('s1').at(-1)._interim, true);

  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), true);
  assert.equal(fx.runtime.clearIncrementalSave('s1'), true);
  assert.equal(fx.timerRecords[1].cleared, true);
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), true);
  assert.equal(fx.runtime.stop(), true);
  assert.equal(fx.timerRecords[2].cleared, true);
  assert.equal(fx.runtime.stop(), false);
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), false);
});

test('opaque hostile session ids remain inside the repository data root', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-chat-history-route-'));
  try {
    const events = [];
    const history = createChatHistoryFileRepository({ dataDir });
    const hostileId = '../../outside';
    const fx = fixture({
      history,
      persistedSessions: new Map([[hostileId, { id: hostileId, kind: 'chat' }]]),
      chatSessions: new Map([[hostileId, {}]]),
      deps: { chatBroadcast: (sessionId, payload) => events.push([sessionId, payload.type]) },
    });
    assert.equal(fx.runtime.appendMessage(hostileId, { role: 'user', content: 'safe' }), true);
    const resolvedRoot = path.resolve(history.root);
    const resolvedFile = path.resolve(history.fileFor(hostileId));
    assert.equal(resolvedFile.startsWith(`${resolvedRoot}${path.sep}`), true);
    assert.equal(fs.existsSync(resolvedFile), true);
    assert.equal(fs.existsSync(path.resolve(dataDir, '..', 'outside.json')), false);
    assert.deepEqual(events, [[hostileId, 'chat_msg_meta']]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// The context readout exists so "Prompt is too long" stops being invisible until it
// fails: it reports the water level of the CLI transcript that `--resume` reloads.
// It is a GET the UI may poll, so it must never rewrite the transcript, and — like
// every other diagnostic here — must not hand an absolute filesystem path to a client.
test('context level reports the transcript water level read-only and without leaking paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-context-level-home-'));
  const cwd = '/repo/.multicc-worktrees/s1';
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { claudeProjectDir } = require('../src/chat/transcript-prune');
    const dir = claudeProjectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stream-sid.jsonl');
    const lines = [];
    let uuid = 0;
    const next = () => `u${++uuid}`;
    let parent = null;
    const push = (obj) => {
      const id = next();
      lines.push(JSON.stringify({ ...obj, uuid: id, parentUuid: parent }));
      parent = id;
    };
    for (let t = 0; t < 3; t++) {
      push({ type: 'user', message: { role: 'user', content: `question ${t}` } });
      push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } });
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const before = fs.readFileSync(file, 'utf8');

    const fx = fixture({
      persistedSessions: new Map([['s1', {
        id: 's1', kind: 'chat', cli: 'claude', _streamSessionId: 'stream-sid',
      }]]),
      deps: {
        cwdForSession: () => cwd,
        chatStream: {
          close() {},
          status: () => ({ alive: true, busy: false, recycleRequested: true }),
        },
      },
    });
    const app = createFakeApp();
    fx.runtime.mountRoutes(app);
    const handler = app.routes.get('GET /api/sessions/:id/context-level');
    assert.ok(handler, 'the readout must be mounted');

    const call = (id, query = {}) => {
      const res = createResponse();
      handler({ params: { id }, query }, res, () => { throw new Error('unexpected next()'); });
      return res;
    };

    assert.equal(call('missing').statusCode, 404);

    const res = call('s1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.supported, true);
    assert.equal(res.body.transcript.found, true);
    assert.equal(res.body.transcript.lines, 6);
    assert.equal(res.body.transcript.realUserTurns, 3);
    assert.equal(res.body.transcript.liveTurns, 3);
    assert.equal(res.body.transcript.compactBoundary.present, false);
    // Small file: under the gate, so the next turn would not trim it.
    assert.equal(res.body.transcript.wouldPrune, false);
    assert.equal(res.body.transcript.status, 'ok');
    // A pending recycle is the difference between "trimmed on disk" and "trimmed in
    // the process that answers the next turn", so it belongs in the readout.
    assert.deepEqual(res.body.process, { alive: true, busy: false, recycleRequested: true });
    assert.equal(JSON.stringify(res.body).includes(home), false, 'no absolute path may reach the client');
    assert.equal(JSON.stringify(res.body).includes('.jsonl'), false, 'no transcript filename either');

    // ?plan=1 is a dry run: it may describe a rewrite, never perform one.
    const planned = call('s1', { plan: '1' });
    assert.equal(planned.statusCode, 200);
    assert.equal('plan' in planned.body, true);
    if (planned.body.plan) {
      assert.equal(planned.body.plan.dryRun, true);
      assert.equal('file' in planned.body.plan, false, 'the plan must not carry the transcript path');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a GET must never rewrite the transcript');

    // A non-claude session has no such transcript; say so instead of guessing.
    const other = fixture({
      persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'codex' }]]),
      deps: { cwdForSession: () => cwd },
    });
    const otherApp = createFakeApp();
    other.runtime.mountRoutes(otherApp);
    const otherRes = createResponse();
    otherApp.routes.get('GET /api/sessions/:id/context-level')(
      { params: { id: 's1' }, query: {} }, otherRes, () => {},
    );
    assert.equal(otherRes.body.supported, false);
    assert.equal(otherRes.body.reason, 'cli-not-claude');

    // OpenCode: supported=true with the water level of the EXACT native session
    // the logical session captured — a sibling session sharing the cwd is never
    // consulted. No filesystem path may reach the client here either.
    const readCalls = [];
    const opencodeFixture = ({
      native,
      persistedExtra = {},
    } = {}) => fixture({
      persistedSessions: new Map([['s1', {
        id: 's1', kind: 'chat', cli: 'opencode', model: 'deepseek-v4-flash',
        cliSessionId: 'native-a', ...persistedExtra,
      }]]),
      deps: {
        cwdForSession: () => cwd,
        opencodeContextReader: {
          read(sessionId, modelId) {
            readCalls.push({ sessionId, modelId });
            return native;
          },
        },
      },
    });
    const okFixture = opencodeFixture({ native: {
      found: true, sessionId: 'native-a',
      tokens: { total: 897243, input: 178, output: 41, reasoning: 0, cacheRead: 897024, cacheWrite: 0 },
      limit: { context: 1000000, output: 32768, source: 'models.dev' },
      threshold: 0.85, ratio: 0.897, wouldRotate: true,
    } });
    const okApp = createFakeApp();
    okFixture.runtime.mountRoutes(okApp);
    const okRes = createResponse();
    okApp.routes.get('GET /api/sessions/:id/context-level')(
      { params: { id: 's1' }, query: {} }, okRes, () => {},
    );
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.body.supported, true);
    assert.equal(okRes.body.cli, 'opencode');
    assert.equal(okRes.body.native.tokens.total, 897243);
    assert.equal(okRes.body.native.limit.context, 1000000);
    assert.equal(okRes.body.native.wouldRotate, true);
    assert.deepEqual(readCalls, [{ sessionId: 'native-a', modelId: 'deepseek-v4-flash' }],
      'the query is scoped to the captured native session id, not the cwd');
    assert.equal(JSON.stringify(okRes.body).includes('/Users/'), false);

    // Missing native session / unreadable db stay supported with a reason.
    for (const native of [{ found: false, reason: 'no-native-session' }, { found: false, reason: 'db-unavailable' }]) {
      const missing = opencodeFixture({ native });
      const mApp = createFakeApp();
      missing.runtime.mountRoutes(mApp);
      const mRes = createResponse();
      mApp.routes.get('GET /api/sessions/:id/context-level')(
        { params: { id: 's1' }, query: {} }, mRes, () => {},
      );
      assert.equal(mRes.body.supported, true);
      assert.equal(mRes.body.native.reason, native.reason);
    }
    // The streaming-path native id wins over the per-turn fallback, matching
    // which session `--session` actually resumes.
    readCalls.length = 0;
    const streamed = opencodeFixture({
      native: { found: false, reason: 'session-not-found' },
      persistedExtra: { _streamSessionId: 'native-stream' },
    });
    const sApp = createFakeApp();
    streamed.runtime.mountRoutes(sApp);
    const sRes = createResponse();
    sApp.routes.get('GET /api/sessions/:id/context-level')(
      { params: { id: 's1' }, query: {} }, sRes, () => {},
    );
    assert.equal(sRes.body.supported, true);
    assert.deepEqual(readCalls, [{ sessionId: 'native-stream', modelId: 'deepseek-v4-flash' }]);

    // A host that never supplied a cwd resolver degrades to unsupported, not a 500.
    const noResolver = fixture({
      persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude' }]]),
    });
    const nrApp = createFakeApp();
    noResolver.runtime.mountRoutes(nrApp);
    const nrRes = createResponse();
    nrApp.routes.get('GET /api/sessions/:id/context-level')(
      { params: { id: 's1' }, query: {} }, nrRes, () => {},
    );
    assert.equal(nrRes.body.supported, false);
    assert.equal(nrRes.body.reason, 'no-cwd-resolver');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

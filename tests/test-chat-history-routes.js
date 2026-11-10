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

test('display clearing and hiding survive restart without changing task evidence or delivery receipts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-display-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createChatHistoryFileRepository({ dataDir });
  const original = [
    { id: 'u1', role: 'user', taskId: 't1', content: 'requirement', deliveryId: 'delivery-1' },
    { id: 'a1', role: 'assistant', taskId: 't1', content: 'complete evidence' },
    { id: 'u2', role: 'user', content: 'next question' },
  ];
  history.write('s1', original);
  const bytes = fs.readFileSync(history.fileFor('s1'), 'utf8');
  const fx = fixture({ history });
  await fx.runtime.clearHistory('s1', { keep: 1 }, fx.chatState);
  const app = createFakeApp(); fx.runtime.mountRoutes(app);
  const res = createResponse();
  await app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({ params: { id: 's1', msgId: 'u2' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fs.readFileSync(history.fileFor('s1'), 'utf8'), bytes);
  fx.runtime.stop();
  const restarted = fixture({ history: createChatHistoryFileRepository({ dataDir }) });
  t.after(() => restarted.runtime.stop());
  assert.deepEqual(restarted.runtime.paginate('s1').messages, []);
  assert.equal(restarted.runtime.paginate('s1', { around: 'a1' }).found, false);
  assert.deepEqual(restarted.runtime.load('s1'), original);
  assert.equal(await restarted.runtime.service.hasPersistedDelivery('s1', 'delivery-1'), true);
  assert.deepEqual(restarted.runtime.paginate('s1', { includeHidden: true, limit: 100 }).messages, original);
  await restarted.runtime.appendMessage('s1', { id: 'u3', role: 'user', content: 'new message' });
  assert.deepEqual(restarted.runtime.paginate('s1').messages.map(m => m.id), ['u3']);
});

test('display cap and task-linked removal never delete original records', async () => {
  const original = Array.from({ length: 6 }, (_, index) => ({
    id: `m${index}`, role: 'user', content: `task evidence ${index}`, taskId: 'task-1',
  }));
  const fx = fixture({ maxMessages: 2, initial: { s1: original } });
  assert.equal(fx.runtime.load('s1').length, 6);
  assert.deepEqual(fx.runtime.paginate('s1').messages.map(m => m.id), ['m4', 'm5']);
  const app = createFakeApp(); fx.runtime.mountRoutes(app);
  const res = createResponse();
  app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({ params: { id: 's1', msgId: 'm4' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fx.runtime.load('s1').length, 6);
  assert.throws(() => fx.runtime.service.remove('s1', 'm4'), { code: 'TASK_HISTORY_REFERENCED' });
  await fx.runtime.clearHistory('s1', { keep: 1 }, fx.chatState);
  await fx.runtime.clearHistory('s1', { keep: 100 }, fx.chatState);
  assert.deepEqual(fx.runtime.paginate('s1').messages.map(m => m.id), ['m5']);
  assert.equal(fx.runtime.load('s1').length, 6);
  fx.runtime.stop();
});

test('legacy IDs are made durable before hiding, and visibility follows a repository rename', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-legacy-display-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createChatHistoryFileRepository({ dataDir });
  history.write('s1', [{ role: 'user', content: 'legacy evidence', taskId: 't1' }]);
  const fx = fixture({ history });
  await fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState);
  fx.runtime.stop();
  assert.equal(history.renameSession('s1', 'renamed'), true);
  const restarted = fixture({ history: createChatHistoryFileRepository({ dataDir }) });
  assert.deepEqual(restarted.runtime.paginate('renamed').messages, []);
  assert.equal(restarted.runtime.load('renamed')[0].content, 'legacy evidence');
  restarted.runtime.stop();
});

test('clearing completed messages keeps the ongoing answer and its work state', async () => {
  const fx = fixture({ initial: { s1: [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'live', role: 'assistant', content: 'still working', _interim: true },
  ] } });
  fx.chatState.isStreaming = true;
  fx.chatState.currentAssistantText = 'still working';
  await fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState);
  assert.equal(fx.runtime.load('s1').length, 2);
  assert.deepEqual(fx.runtime.paginate('s1').messages.map(m => m.id), ['live']);
  assert.equal(fx.chatState.isStreaming, true);
  const reset = fx.events.find(value => value?.payload?.type === 'chat_history_reset').payload;
  assert.equal(reset.messages.at(-1).streaming, true);
  assert.equal(reset.messages.at(-1).id, 'live');
  fx.runtime.stop();
});

function createMemoryHistory(events, initial = {}, { asyncWrite = false } = {}) {
  const records = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  let writeFailure = null;
  const visibility = new Map();
  const pendingWrites = [];
  function persist(sessionId, messages) {
    events.push(`write:${sessionId}`);
    if (writeFailure) {
      const error = writeFailure;
      writeFailure = null;
      throw error;
    }
    records.set(String(sessionId), clone(messages));
  }
  const history = {
    records,
    pendingWrites,
    failNextWrite(error) { writeFailure = error; },
    read(sessionId) { return clone(records.get(String(sessionId)) || []); },
    write(sessionId, messages) { persist(sessionId, messages); },
    readVisibility(sessionId) { return visibility.get(sessionId) || null; },
    writeVisibility(sessionId, value) {
      events.push(`visibility:${sessionId}`);
      if (writeFailure) { const error = writeFailure; writeFailure = null; throw error; }
      visibility.set(sessionId, clone(value));
    },
    deleteSession(sessionId) { return records.delete(String(sessionId)); },
    hasPersistedDelivery(sessionId, deliveryId) {
      return (records.get(sessionId) || []).some(message =>
        message.deliveryId === deliveryId || message.clientMsgId === deliveryId);
    },
  };
  if (asyncWrite) {
    history.writeAsync = (sessionId, messagesJson) => {
      events.push(`async-start:${sessionId}`);
      const entry = {
        sessionId: String(sessionId),
        messages: JSON.parse(messagesJson),
        settle(error = null) {
          events.push(`async-end:${String(sessionId)}`);
          if (error) entry.reject(error);
          else {
            try {
              persist(sessionId, entry.messages);
              entry.resolve();
            } catch (caught) {
              entry.reject(caught);
            }
          }
        },
      };
      const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      pendingWrites.push(entry);
      return promise;
    };
  } else {
    // Durable writes are the only append path now; the default fake uses the
    // same serialization `persist` the real file repository exercises.
    history.writeAsync = (sessionId, messagesJson) => {
      try {
        persist(sessionId, JSON.parse(messagesJson));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    };
  }
  // Visibility now travels through the queue as a durable write port too.
  history.writeVisibilityAsync = (sessionId, stateJson) => {
    history.writeVisibility(sessionId, JSON.parse(stateJson));
    return Promise.resolve();
  };
  return history;
}

// Settles every asyncWrite the queue issues until `target` lands, so a test can
// assert that a written-behind-delete append really reached the fake repository
// instead of relying on the cancel path that used to reject it early.
async function drainPendingWrites(fx, target) {
  let done = false;
  const tracked = target.then(value => { done = true; return value; }, error => { done = true; throw error; });
  tracked.catch(() => {});
  const settled = new Set();
  for (let round = 0; round < 200 && !done; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
    for (const entry of fx.history.pendingWrites) {
      if (settled.has(entry)) continue;
      settled.add(entry);
      entry.settle();
    }
  }
  return tracked;
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
  const history = overrides.history || createMemoryHistory(events, overrides.initial || {}, {
    asyncWrite: overrides.asyncWrite || false,
  });
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

test('append broadcasts metadata only after durable write and stamps assistant latency', async () => {
  const fx = fixture();
  const message = { role: 'assistant', content: 'done', ts: 5000 };
  assert.equal(await fx.runtime.appendMessage('s1', message), true);
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

test('the registry-owned four-character task code reaches append, replay and attribution events', async () => {
  const fx = fixture({
    initial: { s1: [{ id: 'old', role: 'assistant', content: '旧消息', taskId: 'tsk-old', taskName: '旧任务' }] },
    deps: { taskShortCode: taskId => taskId === 'tsk-new' ? 'N3W1' : '0LD1' },
  });
  assert.equal(fx.runtime.paginate('s1').messages[0].taskShortCode, '0LD1',
    'old stored history is enriched without a migration write');

  const message = { role: 'user', content: '继续', taskId: 'tsk-new', taskName: '新任务' };
  assert.equal(await fx.runtime.appendMessage('s1', message), true);
  assert.equal(message.taskShortCode, 'N3W1');
  const meta = fx.events.find(event => event?.payload?.type === 'chat_msg_meta')?.payload;
  assert.equal(meta.message.taskShortCode, 'N3W1');

  const changed = await fx.runtime.annotateTurn('s1', null, {
    taskId: 'tsk-new', taskName: '新任务', auxRunId: 'run-1',
  }, { anchorMessageId: message.id });
  assert.equal(changed[0].taskShortCode, 'N3W1');
  const annotation = fx.events.filter(event => event?.payload?.type === 'chat_history_annotation').pop().payload;
  assert.equal(annotation.messages[0].taskShortCode, 'N3W1');
});

test('append surfaces answeredQuestionId so multi-window clients can settle the prompt from the message', async () => {
  const fx = fixture();
  const message = {
    role: 'user', content: '是', ts: 5000,
    clientMsgId: 'c1', answeredQuestionId: 'usrq-7',
  };
  assert.equal(await fx.runtime.appendMessage('s1', message), true);
  const meta = fx.events
    .find(event => event && event.payload && event.payload.type === 'chat_msg_meta');
  assert.ok(meta, 'expected a chat_msg_meta broadcast');
  assert.equal(meta.payload.message.answeredQuestionId, 'usrq-7');
  assert.equal(meta.payload.message.content, '是');
  // The marker is metadata-only and never reaches the model: a plain user
  // message without it projects cleanly too.
  await fx.runtime.appendMessage('s1', { role: 'user', content: 'plain', ts: 5000 });
  const plainMeta = fx.events
    .filter(event => event && event.payload && event.payload.type === 'chat_msg_meta')
    .at(-1);
  assert.equal(plainMeta.payload.message.answeredQuestionId, undefined);
});

test('Aux attribution atomically stamps every message in one turn', async () => {
  const fx = fixture({ initial: { s1: [
    { id: 'u1', role: 'user', content: '继续改颜色', turnId: 'turn-1', taskId: 'old' },
    { id: 'a1', role: 'assistant', content: '已经改好', turnId: 'turn-1', taskId: 'old' },
    { id: 'u2', role: 'user', content: '另一轮', turnId: 'turn-2', taskId: 'other' },
  ] } });
  const changed = await fx.runtime.annotateTurn('s1', 'turn-1', {
    taskId: 'new', taskName: '配色调整', auxRunId: 'run-9',
    taskStart: true, taskSource: 'aux', taskText: '继续改颜色',
  });
  assert.deepEqual(changed.map(message => message.id), ['u1', 'a1']);
  const saved = fx.runtime.load('s1');
  assert.equal(saved[0].taskId, 'new');
  assert.equal(saved[0].taskStart, true);
  assert.equal(saved[1].taskName, '配色调整');
  assert.equal(saved[1].auxRunId, 'run-9');
  assert.equal(saved[2].taskId, 'other');
  assert.ok(fx.events.some(event => event?.payload?.type === 'chat_history_annotation'));
});

test('write failure has no broadcast proof and diagnostics redact paths and credentials', async () => {
  const fx = fixture();
  fx.history.failNextWrite(new Error('token=secret /Users/private/chat.json'));
  assert.equal(await fx.runtime.appendMessage('s1', { role: 'assistant', content: 'lost', ts: 5000 }), false);
  assert.deepEqual(eventNames(fx.events), ['write:s1']);
  assert.equal(fx.chatState.lastActivity, undefined);
  assert.equal(fx.logs[0].event, 'chat_history_append_failed');
  assert.equal(fx.logs[0].payload.error, 'chat history operation failed');
  assert.doesNotMatch(JSON.stringify(fx.logs), /secret|\/Users\/private/);
});

test('async append keeps cache, callbacks and broadcast behind the durable write', async () => {
  const fx = fixture({
    asyncWrite: true,
    initial: { s1: [{ id: 'old', role: 'user', content: 'before' }] },
  });
  const promise = fx.runtime.appendMessage('s1', {
    id: 'new', role: 'assistant', content: 'after durable write', ts: 5000,
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fx.history.pendingWrites.length, 1);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['old']);
  assert.deepEqual(fx.runtime.load('s1').map(message => message.id), ['old']);
  assert.deepEqual(eventNames(fx.events), ['async-start:s1']);

  fx.history.pendingWrites[0].settle();
  assert.equal(await promise, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['old', 'new']);
  assert.deepEqual(fx.runtime.load('s1').map(message => message.id), ['old', 'new']);
  assert.deepEqual(eventNames(fx.events), [
    'async-start:s1',
    'async-end:s1',
    'write:s1',
    'broadcast:chat_msg_meta:s1',
  ]);
  fx.runtime.stop();
});

test('async append failure leaves the committed view intact and retries without duplication', async () => {
  const fx = fixture({
    asyncWrite: true,
    initial: { s1: [{ id: 'old', role: 'user', content: 'before' }] },
  });
  const message = { id: 'new', role: 'assistant', content: 'retry me', ts: 5000 };
  const failed = fx.runtime.appendMessage('s1', message);
  await new Promise(resolve => setImmediate(resolve));
  const error = Object.assign(new Error('disk full'), {
    code: 'ENOSPC', errno: -28, syscall: 'write', path: '/private/history.json',
  });
  fx.history.pendingWrites[0].settle(error);
  assert.equal(await failed, false);
  assert.deepEqual(fx.runtime.load('s1').map(entry => entry.id), ['old']);
  assert.deepEqual(fx.history.records.get('s1').map(entry => entry.id), ['old']);
  assert.equal(fx.events.some(entry => typeof entry === 'string' && entry.startsWith('broadcast:')), false);
  assert.equal(fx.logs.at(-1).event, 'chat_history_append_failed');

  const retried = fx.runtime.appendMessage('s1', message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 2);
  fx.history.pendingWrites[1].settle();
  assert.equal(await retried, true);
  assert.deepEqual(fx.runtime.load('s1').map(entry => entry.id), ['old', 'new']);
  assert.equal(fx.events.filter(entry => entry === 'broadcast:chat_msg_meta:s1').length, 1);
  fx.runtime.stop();
});

test('async appends serialize one session while different sessions write in parallel', async () => {
  const records = new Map();
  const starts = [];
  const active = { now: 0, max: 0 };
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  const history = {
    read(sessionId) { return clone(records.get(String(sessionId)) || []); },
    write(sessionId, messages) { records.set(String(sessionId), clone(messages)); },
    async writeAsync(sessionId, messagesJson) {
      starts.push(String(sessionId));
      active.now += 1;
      active.max = Math.max(active.max, active.now);
      if (starts.length === 2) releaseBarrier();
      await barrier;
      records.set(String(sessionId), JSON.parse(messagesJson));
      active.now -= 1;
    },
    readVisibility() { return null; },
    writeVisibility() {},
    writeVisibilityAsync() { return Promise.resolve(); },
    deleteSession(sessionId) { return records.delete(String(sessionId)); },
    hasPersistedDelivery() { return false; },
  };
  const fx = fixture({ history });
  const first = fx.runtime.appendMessage('s1', { id: 's1-a', role: 'user', content: 'first' });
  const second = fx.runtime.appendMessage('s1', { id: 's1-b', role: 'assistant', content: 'second' });
  const other = fx.runtime.appendMessage('s2', { id: 's2-a', role: 'user', content: 'parallel' });

  await barrier;
  assert.deepEqual(starts, ['s1', 's2']);
  assert.equal(active.max, 2, 'different sessions must be writing at the same time');

  assert.deepEqual(await Promise.all([first, second, other]), [true, true, true]);
  assert.deepEqual(records.get('s1').map(entry => entry.id), ['s1-a', 's1-b']);
  assert.deepEqual(records.get('s2').map(entry => entry.id), ['s2-a']);
  fx.runtime.stop();
});

test('concurrent appends in one session are queued, never dropped', async () => {
  // This is the regression the deleted synchronous door used to cause: a caller
  // that could not join the in-flight write failed closed and silently lost the
  // message. Every append now returns a Promise and waits its turn.
  const fx = fixture({ asyncWrite: true });
  const first = fx.runtime.appendMessage('s1', {
    id: 'async-first', role: 'user', content: 'already writing',
  });
  await new Promise(resolve => setImmediate(resolve));
  const second = fx.runtime.appendMessage('s1', {
    id: 'async-second', role: 'assistant', content: 'queued behind the write', ts: 5000,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(eventNames(fx.events), ['async-start:s1']);

  fx.history.pendingWrites[0].settle();
  assert.equal(await first, true);
  await new Promise(resolve => setImmediate(resolve));
  // The queued append starts only after the first one settles and commits.
  assert.deepEqual(eventNames(fx.events), [
    'async-start:s1', 'async-end:s1', 'write:s1', 'broadcast:chat_msg_meta:s1', 'async-start:s1',
  ]);
  fx.history.pendingWrites[1].settle();
  assert.equal(await second, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['async-first', 'async-second']);
  fx.runtime.stop();
});

test('appendMessage resolves true and publishes the frame after the write', async () => {
  const fx = fixture();
  assert.equal(await fx.runtime.appendMessage('s1', {
    id: 'sync-final', role: 'assistant', content: 'durable now', ts: 5000,
  }), true);
  assert.deepEqual(fx.runtime.load('s1').map(message => message.id), ['sync-final']);
  assert.deepEqual(eventNames(fx.events), ['write:s1', 'broadcast:chat_msg_meta:s1']);
  fx.runtime.stop();
});

test('HTTP pagination and delete preserve legacy DTOs, status codes and commit ordering', async () => {
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
  await app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
    params: { id: 's1', msgId: 'm2' }, query: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(eventNames(fx.events), [
    'visibility:s1',
    'broadcast:chat_msg_deleted:s1',
  ]);

  res = createResponse();
  await app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
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

test('HTTP delete persistence failure reaches the terminal safe boundary without a false broadcast', async () => {
  const fx = fixture({ initial: { s1: [{ id: 'm1', role: 'user', content: 'one' }] } });
  const app = createFakeApp();
  fx.runtime.mountRoutes(app);
  fx.history.failNextWrite(new Error('password=hunter2 /private/history.json'));
  const res = createResponse();
  let forwarded = null;
  await app.routes.get('DELETE /api/sessions/:id/messages/:msgId')({
    params: { id: 's1', msgId: 'm1' }, query: {},
  }, res, error => { forwarded = error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, undefined);
  assert.equal(forwarded.message, 'chat history operation failed');
  assert.deepEqual(eventNames(fx.events), ['visibility:s1']);
  assert.doesNotMatch(JSON.stringify({ forwarded: forwarded.message, logs: fx.logs }), /hunter2|\/private\/history/);
});

test('clear persists display state, preserves raw messages and leaves native context intact', async () => {
  const original = [
    { id: 'm1', role: 'user', content: 'one', taskId: 'task-1' },
    { id: 'm2', role: 'assistant', content: 'two', taskId: 'task-1' },
    { id: 'm3', role: 'user', content: 'three' },
    { id: 'm4', role: 'assistant', content: 'four' },
  ];
  const fx = fixture({ initial: { s1: original } });
  const result = await fx.runtime.clearHistory('s1', { keep: '2' }, fx.chatState);
  assert.deepEqual(result, { keep: 2, removedCount: 2, retainedCount: 2, clearedNativeSessions: 0 });
  assert.deepEqual(fx.history.records.get('s1'), original);
  assert.deepEqual(fx.runtime.load('s1'), original);
  assert.deepEqual(fx.runtime.paginate('s1').messages.map(m => m.id), ['m3', 'm4']);
  assert.deepEqual(eventNames(fx.events), ['visibility:s1', 'broadcast:chat_history_reset:s1']);
  const reset = fx.events.find(value => value && value.payload)?.payload;
  assert.equal(reset.displayOnly, true);
  assert.deepEqual(reset.messages, original.slice(2));
  assert.equal(fx.chatState.chatTurnCount, 7);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
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
  assert.deepEqual(eventNames(fx.events), ['visibility:s1']);
  assert.equal(fx.chatState.chatTurnCount, 7);
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  assert.doesNotMatch(JSON.stringify(fx.logs), /abc|\/Users\/private/);
});

test('clear is allowed with live background work and never tears down its native stream', async () => {
  const original = [{ id: 'm1', role: 'user', content: 'one' }, { id: 'm2', role: 'assistant', content: 'two' }];
  const fx = fixture({ initial: { s1: original }, rotationBlock: 'background_tasks_running' });
  await fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState);
  assert.deepEqual(fx.history.records.get('s1'), original);
  assert.deepEqual(fx.runtime.paginate('s1').messages, []);
  assert.deepEqual(eventNames(fx.events), ['visibility:s1', 'broadcast:chat_history_reset:s1']);
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

test('incremental saves are single-flight, cancellable and drained on stop', async () => {
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
  await fx.runtime.settle();
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

test('opaque hostile session ids remain inside the repository data root', async () => {
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
    assert.equal(await fx.runtime.appendMessage(hostileId, { role: 'user', content: 'safe' }), true);
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
test('context level reports the transcript water level read-only and without leaking paths', async () => {
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
    await okApp.routes.get('GET /api/sessions/:id/context-level')(
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
      await mApp.routes.get('GET /api/sessions/:id/context-level')(
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
    await sApp.routes.get('GET /api/sessions/:id/context-level')(
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


test('legacy empty history remains deletable without weakening durable delivery checks', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-empty-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createChatHistoryFileRepository({ dataDir });
  history.write('empty', []);
  assert.deepEqual(history.readStrict('empty', { allowEmpty: true }), []);
  assert.throws(() => history.hasPersistedDelivery('empty', 'receipt'), { code: 'CHAT_HISTORY_CORRUPT' });
  const { createTaskHistoryRetention } = require('../src/session/task-history-retention');
  const board = { tasks: {} };
  const policy = createTaskHistoryRetention({ getBoard: () => board, getRecord: () => null,
    loadHistory: id => history.readStrict(id, { allowEmpty: true }) });
  assert.equal(policy.canDeleteSession('empty'), true);
  board.tasks.keep = { id: 'keep', refs: [{ sessionId: 'empty' }] };
  assert.equal(policy.canDeleteSession('empty'), false);
});

test('quiet bulk hide writes visibility once, broadcasts nothing and counts only newly hidden IDs', async () => {
  const fx = fixture({ initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
    { id: 'm2', role: 'assistant', content: 'two' },
    { id: 'm3', role: 'user', content: 'three' },
  ] } });
  fx.events.length = 0;
  assert.equal(await fx.runtime.hideMessages('s1', ['m1', 'm2', 'm1', 'missing', ''], { quiet: true }), 2);
  assert.deepEqual(eventNames(fx.events), ['visibility:s1']);
  assert.equal(await fx.runtime.hideMessages('s1', ['m1', 'm2'], { quiet: true }), 0, 'already hidden is not hidden again');
  assert.deepEqual(fx.runtime.projectedMessages('s1').map(m => m.id), ['m3']);
});

// ── 变更串行化竞态 ────────────────────────────────────────────────────────
// 这些用例用会挂起的 transcript 写端口把「写进行中」变成可控窗口：旧同步实现
// 会在这个窗口里用过期快照清空/隐藏/标注，串行化之后它们必须排在追加之后，
// 并在落地后的状态上计算。
async function settlePendingWrites(fx, rounds = 12) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
    const pending = fx.history.pendingWrites.splice(0);
    for (const entry of pending) entry.settle();
  }
}

test('a clear queued behind an in-flight append plans on the landed transcript', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
  ] } });
  const append = fx.runtime.appendMessage('s1', { id: 'm2', role: 'assistant', content: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1, 'the append holds the durable port');
  fx.events.length = 0;

  const cleared = fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1, 'the clear must not write before the append lands');
  assert.deepEqual(eventNames(fx.events).filter(name => name.startsWith('visibility:')), [],
    'no display write may race ahead of the queued append');
  assert.deepEqual(fx.runtime.paginate('s1').messages.map(m => m.id), ['m1'],
    'the in-flight append is not projected before it is durable');

  fx.history.pendingWrites[0].settle();
  assert.equal(await append, true);
  const result = await cleared;
  assert.deepEqual(result, { keep: 0, removedCount: 2, retainedCount: 0, clearedNativeSessions: 0 },
    'the clear snapshot must include the message that landed before it');
  assert.deepEqual(fx.runtime.paginate('s1').messages, []);
  assert.deepEqual(
    eventNames(fx.events).filter(name => /^(visibility|broadcast):/.test(name)),
    ['broadcast:chat_msg_meta:s1', 'visibility:s1', 'broadcast:chat_history_reset:s1'],
  );
  const reset = fx.events.find(event => event?.payload?.type === 'chat_history_reset').payload;
  assert.deepEqual(reset.messages.map(m => m.id), [], 'the reset page is the post-clear page, not a stale one');
  fx.runtime.stop();
});

test('hide and annotate queued behind an in-flight append act on the landed message', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [] } });
  const append = fx.runtime.appendMessage('s1', {
    id: 'u1', role: 'user', content: 'question', turnId: 't1',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1);
  fx.events.length = 0;

  const hide = fx.runtime.hideMessages('s1', ['u1']);
  const annotate = fx.runtime.annotateTurn('s1', 't1', { taskId: 'task-alpha' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1, 'later mutations must not write ahead of the append');
  assert.deepEqual(eventNames(fx.events), [], 'nothing may broadcast before the append is durable');

  const settled = Promise.all([append, hide, annotate]);
  await settlePendingWrites(fx);
  const [appended, hidden, changed] = await settled;
  assert.equal(appended, true);
  assert.equal(hidden, 1, 'hide counts the message it newly hid');
  assert.deepEqual(changed.map(message => message.id), ['u1'],
    'the annotation must address the message that landed before it');
  assert.deepEqual(
    eventNames(fx.events).filter(name => /^(visibility|broadcast):/.test(name)),
    [
      'broadcast:chat_msg_meta:s1',
      'visibility:s1',
      'broadcast:chat_msg_deleted:s1',
      'broadcast:chat_history_annotation:s1',
    ],
  );
  assert.deepEqual(fx.runtime.paginate('s1').messages, []);
  assert.equal(fx.runtime.load('s1')[0].taskId, 'task-alpha');
  fx.runtime.stop();
});

test('an incremental save straddling a clear never resurrects the pre-clear display state', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [
    { id: 'm1', role: 'user', content: 'one' },
  ] } });
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', {
    currentAssistantText: 'streaming interim text long enough',
    currentToolCalls: [{ name: 'Read' }],
  }), true);
  fx.timerRecords[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1, 'the interim write owns the queue');
  fx.events.length = 0;

  const cleared = fx.runtime.clearHistory('s1', { keep: 0 }, fx.chatState);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.history.pendingWrites.length, 1, 'the clear waits for the interim write');

  await settlePendingWrites(fx);
  const result = await cleared;
  assert.deepEqual(result, { keep: 0, removedCount: 1, retainedCount: 1, clearedNativeSessions: 0 });
  const visible = fx.runtime.paginate('s1').messages;
  assert.equal(visible.length, 1, 'only the in-flight answer survives a clear');
  assert.equal(visible[0]._interim, true);
  assert.deepEqual(visible.map(m => m.id).includes('m1'), false, 'the pre-clear message stays hidden');
  assert.equal(fx.history.records.get('s1').filter(message => message.id === 'm1').length, 1,
    'the stale interim snapshot never re-appended the cleared message');
  assert.equal(eventNames(fx.events).filter(name => /^(visibility|broadcast):/.test(name))[0], 'visibility:s1');
  assert.equal(fx.runtime.hasIncrementalSave('s1'), false);
  assert.equal(await fx.runtime.settle(), true);
  fx.runtime.stop();
});

// ── 轮换的两段式重判 ──────────────────────────────────────────────────────
test('rotation re-validates after the git snapshot and refuses a session that started a turn', async () => {
  const overrides = { runState: 'idle' };
  let started;
  const snapshotStarted = new Promise(resolve => { started = resolve; });
  let release;
  const snapshotGate = new Promise(resolve => { release = resolve; });
  const fx = fixture(Object.assign(overrides, {
    persistedSessions: new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude', branch: 'main' }]]),
    deps: {
      async cliSwitchGitSnapshot(session) {
        fx.events.push(`git:${session.id}`);
        started();
        await snapshotGate;
        return { branch: session.branch, head: 'abc', changes: [] };
      },
    },
  }));
  const rotating = fx.runtime.rotateNativeContext('s1', fx.chatState);
  await snapshotStarted;
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  // The snapshot await is where a new turn can begin; the second decision must
  // see it and refuse instead of committing a handoff over live work.
  overrides.runState = 'running';
  release();
  assert.deepEqual(await rotating, { ok: false, code: 'session_busy' });
  assert.equal(fx.persistedSessions.get('s1').pendingCliHandoff, undefined);
  assert.equal(fx.chatState.chatTurnCount, 7);
  assert.equal(eventNames(fx.events).some(name => name.startsWith('persist:')), false,
    'a refused rotation must never write the session record');
  assert.deepEqual(eventNames(fx.events), ['git:s1', 'broadcast:native_context_rotation_rejected:s1'],
    'a refused rotation reports the rejection and never a rotation result');
  fx.runtime.stop();
});

test('rotation re-validates after the git snapshot and reports a session deleted meanwhile', async () => {
  let started, release;
  const snapshotStarted = new Promise(resolve => { started = resolve; });
  const snapshotGate = new Promise(resolve => { release = resolve; });
  const persistedSessions = new Map([['s1', { id: 's1', kind: 'chat', cli: 'claude', branch: 'main' }]]);
  const fx = fixture({
    persistedSessions,
    deps: {
      async cliSwitchGitSnapshot() {
        started();
        await snapshotGate;
        return { branch: 'main', head: 'abc', changes: [] };
      },
    },
  });
  const rotating = fx.runtime.rotateNativeContext('s1', fx.chatState);
  await snapshotStarted;
  persistedSessions.delete('s1');
  release();
  assert.deepEqual(await rotating, { ok: false, code: 'session_not_found' });
  assert.equal(persistedSessions.has('s1'), false);
  assert.equal(fx.chatState.chatTurnCount, 7);
  assert.equal(eventNames(fx.events).some(name => name.startsWith('persist:')), false);
  fx.runtime.stop();
});

// ── 关停排空真实的 driver Promise ──────────────────────────────────────────
test('settle waits for the real driver promise instead of spinning over wrappers', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const appended = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'answer' });
  assert.equal(fx.history.pendingWrites.length, 1, 'the append write must be in flight');
  let finished = false;
  const draining = fx.runtime.settle({ timeoutMs: 2000 }).then(value => {
    finished = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished, false, 'settle must not resolve while the in-flight write is pending');
  fx.history.pendingWrites[0].settle();
  assert.equal(await draining, true);
  assert.equal(await appended, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'a1']);
  fx.runtime.stop();
});

test('settle returns false at the caller deadline when a write never lands', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const appended = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'answer' });
  const started = Date.now();
  const drained = await fx.runtime.settle({ deadline: Date.now() + 60 });
  const elapsed = Date.now() - started;
  assert.equal(drained, false);
  assert.ok(elapsed >= 40, `settle must respect the deadline (waited ${elapsed}ms)`);
  fx.history.pendingWrites[0].settle();
  assert.equal(await appended, true);
  fx.runtime.stop();
});

test('settle keeps draining other sessions while one session is wedged', async () => {
  const persistedSessions = new Map([
    ['s1', { id: 's1', kind: 'chat', cli: 'claude' }],
    ['s2', { id: 's2', kind: 'chat', cli: 'claude' }],
  ]);
  const fx = fixture({ asyncWrite: true, persistedSessions });
  const blocked = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'blocked' });
  const quick = fx.runtime.appendMessage('s2', { id: 'a2', role: 'assistant', content: 'quick' });
  assert.equal(fx.history.pendingWrites.length, 2);
  const quickWrite = fx.history.pendingWrites.find(entry => entry.sessionId === 's2');
  const blockedWrite = fx.history.pendingWrites.find(entry => entry.sessionId === 's1');
  let drained = false;
  const settling = fx.runtime.settle({ timeoutMs: 2000 }).then(value => {
    drained = true;
    return value;
  });
  quickWrite.settle();
  assert.equal(await quick, true);
  assert.equal(fx.history.records.has('s2'), true, 'the other session must land while s1 is wedged');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(drained, false, 'one wedged session still holds the drain open');
  blockedWrite.settle();
  assert.equal(await settling, true);
  assert.equal(await blocked, true);
  fx.runtime.stop();
});

// ── 删除栅栏与整份替换 ────────────────────────────────────────────────────
test('delete waits for an in-flight append, discards queued work and fences later appends', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const first = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'first' });
  const queued = fx.runtime.appendMessage('s1', { id: 'a2', role: 'assistant', content: 'queued' });
  let queuedSettled = false;
  queued.then(() => { queuedSettled = true; }, () => { queuedSettled = true; });
  const removing = fx.runtime.removeSession('s1');
  // A delete only cancels queued work once it is actually committed; before the
  // in-flight write lands the queued append must still be pending.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queuedSettled, false, 'queued work is not canceled by an unconfirmed delete');
  assert.equal(fx.history.pendingWrites.length, 1, 'only the in-flight append may write');
  assert.equal(fx.history.records.has('s1'), true, 'the delete must wait behind the in-flight write');
  fx.history.pendingWrites[0].settle();
  assert.equal(await first, true);
  await assert.rejects(queued, { code: 'CHAT_HISTORY_SESSION_DELETED' });
  assert.equal(await removing, true);
  assert.equal(fx.history.records.has('s1'), false, 'the final disk state is the delete');
  await assert.rejects(fx.runtime.appendMessage('s1', { id: 'a3', role: 'assistant', content: 'late' }),
    { code: 'CHAT_HISTORY_SESSION_DELETED' });
  assert.equal(await fx.runtime.removeSession('s1'), true, 'a repeated delete is idempotent');
  fx.runtime.stop();
});

test('a refused delete leaves every accepted write intact and lifts the fence', async () => {
  const fx = fixture({
    asyncWrite: true,
    initial: { s1: [{ id: 'u1', role: 'user', content: 'protected', taskId: 't1' }] },
    deps: { canDeleteSession: () => false },
  });
  const first = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'first' });
  const queued = fx.runtime.appendMessage('s1', { id: 'a2', role: 'assistant', content: 'queued' });
  const removing = fx.runtime.removeSession('s1');
  removing.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  fx.history.pendingWrites[0].settle();
  assert.equal(await first, true);
  // The queued append was accepted before the delete attempt: it must land and
  // its caller must not be told the session disappeared.
  assert.equal(await drainPendingWrites(fx, queued), true);
  await assert.rejects(removing, { code: 'TASK_HISTORY_REFERENCED' });
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'a1', 'a2']);
  // The failed delete must not leave a tombstone behind.
  const after = fx.runtime.appendMessage('s1', { id: 'a3', role: 'assistant', content: 'after' });
  assert.equal(await drainPendingWrites(fx, after), true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'a1', 'a2', 'a3']);
  fx.runtime.stop();
});

test('mutations queued while a delete is pending follow the delete outcome', async () => {
  const failed = fixture({
    asyncWrite: true,
    initial: { s1: [{ id: 'u1', role: 'user', content: 'protected', taskId: 't1' }] },
    deps: { canDeleteSession: () => false },
  });
  const inflight = failed.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'first' });
  const removing = failed.runtime.removeSession('s1');
  const duringFailure = failed.runtime.appendMessage('s1', { id: 'a2', role: 'assistant', content: 'during' });
  removing.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  failed.history.pendingWrites[0].settle();
  assert.equal(await inflight, true);
  await assert.rejects(removing, { code: 'TASK_HISTORY_REFERENCED' });
  assert.equal(await drainPendingWrites(failed, duringFailure), true,
    'a refused delete must run the writes it accepted');
  assert.deepEqual(failed.history.records.get('s1').map(message => message.id), ['u1', 'a1', 'a2']);
  failed.runtime.stop();

  const success = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const blocked = success.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'first' });
  const removed = success.runtime.removeSession('s1');
  const duringSuccess = success.runtime.appendMessage('s1', { id: 'a2', role: 'assistant', content: 'during' });
  duringSuccess.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  success.history.pendingWrites[0].settle();
  assert.equal(await blocked, true);
  assert.equal(await removed, true);
  await assert.rejects(duringSuccess, { code: 'CHAT_HISTORY_SESSION_DELETED' },
    'a committed delete cancels the work it accepted while pending');
  assert.equal(success.history.records.has('s1'), false);
  success.runtime.stop();
});

test('registering while a delete is pending keeps the new epoch and only settles the old history', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'old', role: 'user', content: 'old history' }] } });
  const inflight = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'accepted before register' });
  const removing = fx.runtime.removeSession('s1');
  const stale = fx.runtime.appendMessage('s1', { id: 'stale', role: 'assistant', content: 'old epoch' });
  stale.catch(() => {});
  // The session is re-registered while the delete still sits behind the
  // in-flight append. Its epoch moves on; the queued Delete belongs to the old
  // one and must not drag the new epoch's work down with it.
  fx.runtime.registerSession('s1');
  const fresh = fx.runtime.appendMessage('s1', { id: 'n1', role: 'user', content: 'new epoch' });
  const outcome = await drainPendingWrites(fx, Promise.allSettled([inflight, removing, stale, fresh]));
  assert.deepEqual(outcome.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(outcome[0].value, true, 'the in-flight append lands before the delete');
  assert.equal(outcome[1].value, true, 'the delete still commits');
  assert.equal(outcome[2].reason.code, 'CHAT_HISTORY_SESSION_DELETED',
    'old-epoch work queued behind the delete belongs to the deleted history');
  assert.equal(outcome[3].value, true, 'a write accepted in the new epoch survives the delete');
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['n1'],
    'the final disk state is the new epoch only — no old content comes back');
  const later = fx.runtime.appendMessage('s1', { id: 'n2', role: 'assistant', content: 'later' });
  assert.equal(await drainPendingWrites(fx, later), true, 'the session keeps accepting new-epoch writes');
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['n1', 'n2']);
  fx.runtime.stop();
});

test('a removeSession in the new epoch is an independent delete, not a coalesced one', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const inflight = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'first' });
  const firstDelete = fx.runtime.removeSession('s1');
  fx.runtime.registerSession('s1');
  const recreated = fx.runtime.appendMessage('s1', { id: 'n1', role: 'user', content: 'recreated' });
  const secondDelete = fx.runtime.removeSession('s1');
  const outcome = await drainPendingWrites(fx, Promise.allSettled([inflight, firstDelete, recreated, secondDelete]));
  assert.deepEqual(outcome.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(outcome[1].value, true, 'the old-epoch delete is not coalesced into the new one');
  assert.equal(outcome[2].reason.code, 'CHAT_HISTORY_SESSION_DELETED',
    'the second delete discards the work queued before it, like any delete');
  assert.equal(outcome[3].value, true, 'the new-epoch delete is an independent job');
  // Coalescing the second delete onto the first would leave the recreated
  // history on disk; an independent delete removes it again.
  assert.equal(fx.history.records.has('s1'), false, 'the new-epoch delete removes the recreated history');
  await assert.rejects(fx.runtime.appendMessage('s1', { id: 'late', role: 'user', content: 'late' }),
    { code: 'CHAT_HISTORY_SESSION_DELETED' });
  fx.runtime.stop();
});

test('registering after a refused delete starts a clean epoch that keeps writing', async () => {
  const fx = fixture({
    initial: { s1: [{ id: 'u1', role: 'user', content: 'protected', taskId: 't1' }] },
    deps: { canDeleteSession: () => false },
  });
  const removing = fx.runtime.removeSession('s1');
  removing.catch(() => {});
  await assert.rejects(removing, { code: 'TASK_HISTORY_REFERENCED' });
  fx.runtime.registerSession('s1');
  assert.equal(await fx.runtime.appendMessage('s1', { id: 'n1', role: 'user', content: 'after re-register' }), true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'n1']);
  fx.runtime.stop();
});

test('dropMessages runs on the queue-head transcript and keeps a concurrent append', async () => {
  const fx = fixture({
    asyncWrite: true,
    initial: { s1: [
      { id: 'u1', role: 'user', content: 'keep' },
      { id: 'u2', role: 'user', content: 'drop' },
    ] },
  });
  const appended = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'new answer' });
  const dropped = fx.runtime.dropMessages('s1', ['u2'], { reason: 'task-delete' });
  assert.equal(fx.history.pendingWrites.length, 1, 'the drop must not write before the append lands');
  fx.history.pendingWrites[0].settle();
  assert.equal(await appended, true);
  assert.equal(await dropped, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'a1']);
  fx.runtime.stop();
});

test('mergeHistory appends on the queue-head transcript instead of overwriting it', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'keep' }] } });
  const appended = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'new answer' });
  const merged = fx.runtime.mergeHistory('s1', [{ id: 'm1', role: 'user', content: 'imported intro' }],
    { reason: 'bundle-import-merge' });
  assert.equal(fx.history.pendingWrites.length, 1, 'the merge must not write before the append lands');
  fx.history.pendingWrites[0].settle();
  assert.equal(await appended, true);
  assert.equal(await merged, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['u1', 'a1', 'm1']);
  fx.runtime.stop();
});

test('canDeleteSession asks the Rust retention rule and registerSession clears the tombstone', async () => {
  const fx = fixture({
    initial: { s1: [{ id: 'u1', role: 'user', content: 'protected', taskId: 't1' }] },
    deps: { canDeleteSession: id => id !== 's1' },
  });
  assert.equal(fx.runtime.canDeleteSession('s1'), false);
  assert.equal(fx.runtime.canDeleteSession('other'), true);
  await fx.runtime.removeSession('other');
  await assert.rejects(fx.runtime.appendMessage('other', { id: 'x', role: 'user', content: 'x' }),
    { code: 'CHAT_HISTORY_SESSION_DELETED' });
  fx.runtime.registerSession('other');
  assert.equal(await fx.runtime.appendMessage('other', { id: 'x2', role: 'user', content: 'x2' }), true);
  fx.runtime.stop();
});

test('deletionVerdict separates shared from referenced links and keeps the boolean rule', () => {
  const references = [{ id: 't2', title: 'Worker', via: 'session' },
    { id: 't3', title: 'Sibling', via: 'messages' }];
  const facts = {
    clean: { executionSlot: false, sessionLinks: [], routingLinks: [], messageLinks: [], references: [] },
    shared: { executionSlot: false, sessionLinks: ['t1'], routingLinks: ['t2'], messageLinks: [],
      references: [{ id: 't1', title: 'Owner', via: 'session' }] },
    referenced: { executionSlot: false, sessionLinks: [], routingLinks: ['t2'], messageLinks: ['t3'],
      references },
    slot: { executionSlot: true, sessionLinks: ['t1'], routingLinks: [], messageLinks: [], references: [] },
  };
  const fx = fixture({ deps: { sessionDeletionFacts: id => facts[id] } });
  assert.deepEqual(fx.runtime.deletionVerdict('clean'), { ok: true });
  // A task that formally owns the session wins even when routing also points here.
  assert.deepEqual(fx.runtime.deletionVerdict('shared'), { ok: false, reason: 'shared' });
  assert.deepEqual(fx.runtime.deletionVerdict('referenced'),
    { ok: false, reason: 'referenced', tasks: references, taskIds: ['t2', 't3'] });
  assert.deepEqual(fx.runtime.deletionVerdict('slot'), { ok: true });
  // The boolean API stays a projection of the same Rust verdict.
  assert.equal(fx.runtime.canDeleteSession('clean'), true);
  assert.equal(fx.runtime.canDeleteSession('shared'), false);
  assert.equal(fx.runtime.canDeleteSession('referenced'), false);
  assert.equal(fx.runtime.canDeleteSession('slot'), true);
  fx.runtime.stop();
});

test('full history replacement serializes behind an in-flight append', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const appended = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'answer' });
  const replaced = fx.runtime.replaceHistory('s1', [{ id: 'kept', role: 'user', content: 'trimmed' }],
    { reason: 'task-delete' });
  assert.equal(fx.history.pendingWrites.length, 1, 'the replacement must not write before the append lands');
  fx.history.pendingWrites[0].settle();
  assert.equal(await appended, true);
  assert.equal(await replaced, true);
  assert.deepEqual(fx.history.records.get('s1').map(message => message.id), ['kept']);
  fx.runtime.stop();
});

test('a queued interim is replaced by the newest one instead of writing twice', async () => {
  const fx = fixture({ asyncWrite: true, initial: { s1: [{ id: 'u1', role: 'user', content: 'hi' }] } });
  const blocked = fx.runtime.appendMessage('s1', { id: 'a1', role: 'assistant', content: 'answer' });
  const state = { currentAssistantText: 'streaming text that is long enough', currentToolCalls: [] };
  assert.equal(fx.runtime.scheduleIncrementalSave('s1', state), true);
  const timer = fx.timerRecords.find(record => record.delay === 25);
  assert.ok(timer, 'the interim timer must be scheduled');
  timer.fn();
  state.currentAssistantText = 'streaming text that is long enough and newer';
  timer.fn();
  fx.history.pendingWrites[0].settle();
  assert.equal(await blocked, true);
  let drained;
  const settling = fx.runtime.settle({ timeoutMs: 2000 }).then(value => { drained = value; });
  const written = new Set();
  for (let round = 0; round < 100 && drained === undefined; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
    for (const entry of fx.history.pendingWrites) {
      if (written.has(entry)) continue;
      written.add(entry);
      entry.settle();
    }
  }
  await settling;
  assert.equal(drained, true);
  const transcriptWrites = eventNames(fx.events).filter(name => name === 'async-start:s1');
  assert.equal(transcriptWrites.length, 2, 'one append plus one coalesced interim write');
  const stored = fx.history.records.get('s1');
  assert.ok(stored.some(message => message._interim === true), 'the merged interim still lands');
  fx.runtime.stop();
});

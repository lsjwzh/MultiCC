'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createSandboxConsole } = require('./helpers/sandbox-console');
// The VM below pins host-lifecycle's require set to `./shutdown`, so the lane
// predicate is only reachable through `deps` — pass the production one.
const { isResidentSession } = require('../src/cli/cli-capability');

const HOST_LIFECYCLE_FILE = path.join(__dirname, '..', 'src', 'host-lifecycle.js');

function loadHostLifecycle() {
  const source = fs.readFileSync(HOST_LIFECYCLE_FILE, 'utf8');
  let coordinator = null;
  function createShutdownCoordinator({ logger }) {
    let started = false;
    const checkpoints = [];
    const drains = [];
    const finalFlushes = [];
    const closers = [];
    coordinator = {
      checkpoints,
      drains,
      finalFlushes,
      closers,
      finished: false,
      onCheckpoint(fn) { checkpoints.push(fn); },
      onDrain(fn) { drains.push(fn); },
      onFinalFlush(fn) { finalFlushes.push(fn); },
      onClose(fn) { closers.push(fn); },
      isShuttingDown() { return started; },
      async shutdown({ graceMs = 0 } = {}) {
        if (started) return;
        started = true;
        for (const fn of checkpoints) {
          try { await fn(); } catch (error) { logger.error(`checkpoint: ${error.message}`); }
        }
        for (const fn of drains) {
          try { await fn({ graceMs, deadline: Date.now() + graceMs }); }
          catch (error) { logger.error(`drain: ${error.message}`); }
        }
        for (const fn of finalFlushes) {
          try { await fn({ deadline: Date.now() + 10_000, timeoutMs: 10_000 }); }
          catch (error) { logger.error(`final flush: ${error.message}`); }
        }
        for (const fn of closers) {
          try { await fn(); } catch (error) { logger.error(`closer: ${error.message}`); }
        }
        coordinator.finished = true;
      },
    };
    return coordinator;
  }
  const fakeProcess = { on() {}, exit() {} };
  const commonJsModule = { exports: {} };
  const wrapper = vm.runInNewContext(`(function(require, module, exports) {\n${source}\n})`, {
    console: createSandboxConsole(),
    global: {},
    process: fakeProcess,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Promise,
  }, { filename: HOST_LIFECYCLE_FILE });
  wrapper((request) => {
    if (request === './shutdown') return { createShutdownCoordinator };
    throw new Error(`unexpected require: ${request}`);
  }, commonJsModule, commonJsModule.exports);
  return { ...commonJsModule.exports, getCoordinator: () => coordinator };
}

function createDeps({ timeline = [], errors = [], sessionPersistenceStop } = {}) {
  let shuttingDown = false;
  return {
    isResidentSession,
    getShuttingDown: () => shuttingDown,
    setShuttingDown: value => { shuttingDown = value; },
    setServiceReady: value => timeline.push(`service-ready:${value}`),
    getChatHistoryRuntime: () => null,
    getOrchestrationRuntime: () => ({ dispose: async () => timeline.push('orchestration-disposed') }),
    chatSessions: new Map(),
    sessions: new Map(),
    auxQueue: { queue: [], processing: false, currentTask: null },
    appendChatMessage: () => null,
    isCurrentTurnRunner: () => false,
    recordPartialCheckpoint: () => {},
    assistantCheckpointKey: () => '',
    savePersistedSessionsBestEffort: source => timeline.push(`persisted:${source}`),
    waitInjector: { stop: () => timeline.push('wait-stopped') },
    cronTasks: { stop: () => timeline.push('cron-stopped') },
    tunnel: { stop: () => timeline.push('tunnel-stopped') },
    skillSyncRuntime: { stop: async () => timeline.push('skill-sync-stopped') },
    triggerRuntime: { stop: async () => timeline.push('triggers-stopped') },
    pushRuntime: { stop: () => timeline.push('push-stopped') },
    lanDiscovery: { stop: async () => timeline.push('lan-discovery-stopped') },
    wechatBridge: null,
    feishuBridge: null,
    telegramBridge: null,
    discordBridge: null,
    slackBridge: null,
    wss: { clients: new Set(), close: callback => callback() },
    server: { listening: false },
    turnProgressHeartbeat: { stopAll: () => timeline.push('heartbeat-stopped') },
    backgroundTaskRuntime: {
      reapSessionShadows: (id, options) => timeline.push(`background-reap:${id}:${options.reason}`),
      stopAll: () => timeline.push('background-stopped'),
    },
    cancelClassify: () => {},
    assignKillReason: () => {},
    finishProviderAttempt: () => {},
    chatStream: { close: () => {}, status: () => ({ busy: false }) },
    cleanupPushMonitor: () => {},
    stopOutputCapture: async () => {},
    routerToolHost: { clear: () => timeline.push('router-cleared') },
    sessionPersistence: {
      stop: sessionPersistenceStop || (() => timeline.push('session-persistence-stopped')),
    },
    qwenAudioSupervisor: { stopAll: () => timeline.push('audio-stopped') },
    log: {
      log: message => timeline.push(`log:${message}`),
      warn: message => timeline.push(`warn:${message}`),
      error: message => errors.push(String(message)),
    },
  };
}

test('forced shutdown terminalizes the active provider attempt before closing its runner', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatSessions.set('chat-a', {
    cli: 'codex',
    currentAssistantText: '',
    currentToolCalls: [],
    _activeRunner: { providerAttempt: { routeAttemptId: 'route-a' } },
    claudeProc: { kill: signal => timeline.push(`proc-kill:${signal}`) },
    clients: new Set(),
  });
  deps.assignKillReason = (_runner, reason) => timeline.push(`kill-reason:${reason}`);
  deps.finishProviderAttempt = (attempt, facts) => {
    timeline.push(`attempt-finish:${attempt.routeAttemptId}:${facts.reasonCode}`);
  };
  deps.chatStream = {
    status: () => ({ busy: false }),
    close: name => timeline.push(`stream-close:${name}`),
  };
  loaded.createHostLifecycle(deps);

  await loaded.getCoordinator().shutdown({ graceMs: 0 });

  const finished = timeline.indexOf('attempt-finish:route-a:shutdown');
  assert.ok(finished >= 0);
  assert.ok(finished < timeline.indexOf('stream-close:chat-a'));
  assert.ok(finished < timeline.indexOf('proc-kill:SIGTERM'));
});

test('forced shutdown reaps each chat background shadow exactly once before stream close', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatSessions.set('chat-a', { clients: new Set() });
  deps.chatStream = {
    status: () => ({ busy: false }),
    close: name => timeline.push(`stream-close:${name}`),
  };
  loaded.createHostLifecycle(deps);

  await loaded.getCoordinator().shutdown({ graceMs: 0 });

  const reaps = timeline.filter(value => value === 'background-reap:chat-a:shutdown');
  assert.equal(reaps.length, 1);
  assert.ok(timeline.indexOf(reaps[0]) < timeline.indexOf('stream-close:chat-a'));
});

// stopAuxQueue 从「一个 currentTask」变成「并发池里的每一个槽」：停机时每一个在飞
// 的 Aux 请求都要标脏，否则它的结果会在关停中途回流；排队的照旧带着
// SERVER_SHUTTING_DOWN 被拒。
test('shutdown marks every running aux slot cancelled, not only the first', async () => {
  const timeline = [];
  const rejected = [];
  const slots = ['slot-1', 'slot-2', 'slot-3'].map(id => ({ id, cancelled: false }));
  const queued = ['wait-1', 'wait-2'].map(id => ({
    id,
    cancelled: false,
    reject: error => rejected.push({ id, code: error.code }),
  }));
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.auxQueue = { queue: queued, running: slots, processing: true, currentTask: slots[0] };
  loaded.createHostLifecycle(deps);

  await loaded.getCoordinator().shutdown({ graceMs: 0 });

  assert.deepEqual(rejected, [
    { id: 'wait-1', code: 'SERVER_SHUTTING_DOWN' },
    { id: 'wait-2', code: 'SERVER_SHUTTING_DOWN' },
  ]);
  assert.deepEqual(slots.map(slot => slot.cancelled), [true, true, true]);
});

// Partial checkpoint writes are durable fsyncs now, so shutdown awaits them —
// but a wedged filesystem must not hang the process forever. The cap is bounded
// and shutdown still runs every later closer.
test('shutdown partial flush is bounded when a durable write never settles', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatFlushTimeoutMs = 25;
  deps.chatSessions.set('chat-a', {
    cli: 'codex',
    currentAssistantText: 'half streamed answer',
    currentToolCalls: [],
    currentCost: 0,
    _resultSaved: false,
    _activeTurn: null,
    _activeRunner: null,
    clients: new Set(),
  });
  deps.appendChatMessage = () => new Promise(() => {});
  loaded.createHostLifecycle(deps);

  const started = Date.now();
  await loaded.getCoordinator().shutdown({ graceMs: 0 });
  assert.ok(Date.now() - started >= 20, 'the flush must actually be awaited');
  assert.equal(
    timeline.some(entry => entry.startsWith('warn:[multicc] shutdown partial flush exceeded 25ms')),
    true,
  );
  assert.equal(timeline.includes('persisted:teardown.checkpoint'), true,
    'the checkpoint continues after the bounded flush');
});

// The checkpoint must actually wait for a write that lands tens of ms later;
// otherwise the durable partial is recorded only after the session runtime has
// already been closed (or never at all on a SIGKILL right after exit).
test('a partial write that lands after the shutdown starts is recorded before later closers', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  const turn = { turnId: 'turn-late' };
  const runner = { runnerId: 'runner-late' };
  deps.chatSessions.set('chat-a', {
    cli: 'codex',
    currentAssistantText: 'late partial answer',
    currentToolCalls: [],
    currentCost: 0,
    _resultSaved: false,
    _activeTurn: turn,
    _activeRunner: runner,
    clients: new Set(),
  });
  deps.isCurrentTurnRunner = () => true;
  deps.recordPartialCheckpoint = () => timeline.push('partial-checkpoint');
  deps.appendChatMessage = () => new Promise(resolve => setTimeout(() => resolve(true), 30));
  loaded.createHostLifecycle(deps);

  await loaded.getCoordinator().shutdown({ graceMs: 0 });

  const recorded = timeline.indexOf('partial-checkpoint');
  assert.ok(recorded >= 0, 'the durable write was confirmed');
  assert.ok(recorded < timeline.indexOf('session-persistence-stopped'),
    'the confirmed record lands before the session runtime closer runs');
});

// The partial append is one half of shutdown durability; the history mutation
// queue (interim saves, annotations, visibility steps) is the other. The queue
// must be drained *after* the partial appends land and inside the same total
// budget, otherwise a queued interim save can be lost by the process exit.
test('shutdown drains the queued history mutations after the partial append lands', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatSessions.set('chat-a', {
    cli: 'codex',
    currentAssistantText: 'half streamed answer',
    currentToolCalls: [],
    currentCost: 0,
    _resultSaved: false,
    _activeTurn: null,
    _activeRunner: null,
    clients: new Set(),
  });
  let releaseAppend;
  deps.appendChatMessage = () => new Promise(resolve => { releaseAppend = () => resolve(true); });
  let releaseSettle;
  const settleGate = new Promise(resolve => { releaseSettle = resolve; });
  deps.getChatHistoryRuntime = () => ({
    clearAllIncrementalSaves: () => timeline.push('history-timers-cleared'),
    settle: () => {
      timeline.push('settle:start');
      return settleGate.then(() => {
        timeline.push('settle:end');
        return true;
      });
    },
  });
  loaded.createHostLifecycle(deps);

  const shutdown = loaded.getCoordinator().shutdown({ graceMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeline.includes('history-timers-cleared'), true,
    'queued interim timers are cancelled before the queue drains');
  assert.equal(timeline.includes('settle:start'), false,
    'the queue drain waits for the partial append to land');
  assert.equal(loaded.getCoordinator().finished, false);

  releaseAppend();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeline.includes('settle:start'), true,
    'the queue is drained once the durable append is confirmed');
  assert.equal(loaded.getCoordinator().finished, false, 'shutdown waits for the queue to drain');

  releaseSettle();
  await shutdown;
  assert.ok(timeline.filter(entry => entry === 'settle:end').length >= 1);
  assert.ok(timeline.lastIndexOf('settle:end') < timeline.indexOf('session-persistence-stopped'),
    'the drained queue lands before the session runtime closes');
});

// The two tests above mock `settle` itself, so they only prove call order. This
// one uses the real runtime and a gated `writeAsync`: shutdown must stay open
// until that durable write lands, which is the behaviour the mocked versions
// could not observe.
test('shutdown waits on the real history runtime driver promise', async () => {
  const { createChatHistoryRuntime } = require('../src/routes/chat-history');
  const records = new Map();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const history = {
    read: id => records.get(id) || [],
    write: (id, messages) => { records.set(String(id), messages); },
    writeAsync: (id, messagesJson) => {
      writes += 1;
      return gate.then(() => { records.set(String(id), JSON.parse(messagesJson)); });
    },
    writeVisibilityAsync: async () => {},
    deleteSession: id => records.delete(String(id)),
    hasPersistedDelivery: () => false,
  };
  const runtime = createChatHistoryRuntime({
    history,
    persistedSessions: new Map([['chat-a', { id: 'chat-a', kind: 'chat', cli: 'codex' }]]),
    chatSessions: new Map(),
    idFactory: () => 'id-1',
    now: () => Date.now(),
    maxMessages: 100,
    historyPageSize: 5,
    memoryDistillBatch: 2,
    incrementalSaveDelayMs: 5000,
    auxSessionId: '__aux__',
    chatBroadcast: () => {},
    distillHistoryIntoMemory: () => Promise.resolve({ ok: true }),
    maybeSchedulePeriodicMemoryReview: () => {},
    cliSwitchGitSnapshot: () => ({ dirty: false }),
    clearAllNativeCliStates: () => 0,
    buildHandoffCheckpoint: () => ({ createdAt: 0 }),
    rememberActiveCliState: () => {},
    chatStream: { close: () => {} },
    logger: { warn() {} },
    setImmediate,
    setTimeout,
    clearTimeout,
    randomBytes: size => Buffer.alloc(size, 1),
  });
  const appending = runtime.appendMessage('chat-a', { role: 'assistant', content: 'partial' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1, 'the append write is in flight');

  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatSessions.set('chat-a', { _resultSaved: true, clients: new Set() });
  deps.getChatHistoryRuntime = () => runtime;
  loaded.createHostLifecycle(deps);

  const shutdown = loaded.getCoordinator().shutdown({ graceMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.getCoordinator().finished, false,
    'shutdown must not finish while the real driver promise is pending');
  release();
  assert.equal(await appending, true);
  await shutdown;
  assert.equal(loaded.getCoordinator().finished, true);
  assert.deepEqual(records.get('chat-a').map(message => message.content), ['partial']);
  runtime.stop();
});

// A wedged queue must not outlive the flush budget either: shutdown still runs
// the later closers and says so, exactly like a wedged transcript write.
test('shutdown bounds a history queue that never drains', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  const deps = createDeps({ timeline });
  deps.chatFlushTimeoutMs = 25;
  deps.chatSessions.set('chat-a', {
    cli: 'codex',
    currentAssistantText: 'half streamed answer',
    currentToolCalls: [],
    currentCost: 0,
    _resultSaved: false,
    _activeTurn: null,
    _activeRunner: null,
    clients: new Set(),
  });
  deps.appendChatMessage = () => Promise.resolve(true);
  deps.getChatHistoryRuntime = () => ({
    clearAllIncrementalSaves() {},
    settle: () => new Promise(() => {}),
  });
  loaded.createHostLifecycle(deps);

  const started = Date.now();
  await loaded.getCoordinator().shutdown({ graceMs: 0 });
  assert.ok(Date.now() - started >= 20, 'the queue drain is actually awaited, up to the cap');
  assert.equal(
    timeline.some(entry => entry.startsWith('warn:[multicc] shutdown partial flush exceeded 25ms')),
    true,
  );
  assert.equal(timeline.includes('persisted:teardown.checkpoint'), true,
    'shutdown continues after a wedged queue');
  assert.equal(timeline.includes('session-persistence-stopped'), true);
});

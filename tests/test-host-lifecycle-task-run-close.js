'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const HOST_LIFECYCLE_FILE = path.join(__dirname, '..', 'src', 'host-lifecycle.js');

function loadHostLifecycle() {
  const source = fs.readFileSync(HOST_LIFECYCLE_FILE, 'utf8');
  let coordinator = null;
  function createShutdownCoordinator({ logger }) {
    let started = false;
    const checkpoints = [];
    const drains = [];
    const closers = [];
    coordinator = {
      checkpoints,
      drains,
      closers,
      finished: false,
      onCheckpoint(fn) { checkpoints.push(fn); },
      onDrain(fn) { drains.push(fn); },
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
    console,
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

function createDeps({ timeline = [], errors = [], taskRunHost, taskRunStore, sessionPersistenceStop } = {}) {
  let shuttingDown = false;
  return {
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
    stopNetworkProbe: () => timeline.push('network-probe-stopped'),
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
    taskRunStore,
    taskRunHost,
    log: {
      log: message => timeline.push(`log:${message}`),
      warn: message => timeline.push(`warn:${message}`),
      error: message => errors.push(String(message)),
    },
  };
}

test('optional TaskRun store closes once, after service quiesce and persisted session shutdown', async () => {
  const withoutPort = loadHostLifecycle();
  withoutPort.createHostLifecycle(createDeps());
  const baselineCloserCount = withoutPort.getCoordinator().closers.length;

  const timeline = [];
  let closeCalls = 0;
  const withPort = loadHostLifecycle();
  withPort.createHostLifecycle(createDeps({
    timeline,
    taskRunStore: {
      async close() {
        closeCalls += 1;
        timeline.push('task-run-store-closed');
      },
    },
  }));
  const coordinator = withPort.getCoordinator();
  assert.equal(coordinator.closers.length, baselineCloserCount + 1,
    'omitting the optional port leaves the existing closer list unchanged');

  await coordinator.shutdown({ graceMs: 1 });
  await coordinator.shutdown({ graceMs: 1 });
  assert.equal(closeCalls, 1);
  assert.ok(timeline.indexOf('service-ready:false') < timeline.indexOf('task-run-store-closed'));
  assert.ok(timeline.indexOf('persisted:teardown.checkpoint') < timeline.indexOf('task-run-store-closed'));
  assert.ok(timeline.indexOf('session-persistence-stopped') < timeline.indexOf('task-run-store-closed'));
  assert.equal(timeline.at(-1), 'task-run-store-closed');

  const taskRunCloser = coordinator.closers.at(-1);
  await taskRunCloser();
  assert.equal(closeCalls, 1, 'the port itself also guards against duplicate close invocation');
});

test('shutdown joins TaskRun finalizers before closing their SQLite store', async () => {
  const timeline = [];
  const loaded = loadHostLifecycle();
  loaded.createHostLifecycle(createDeps({
    timeline,
    taskRunHost: {
      async waitForFinalizers() {
        timeline.push('task-run-finalizers-drained');
      },
    },
    taskRunStore: {
      close() {
        timeline.push('task-run-store-closed');
      },
    },
  }));
  await loaded.getCoordinator().shutdown({ graceMs: 1 });
  assert.ok(timeline.indexOf('task-run-finalizers-drained') >= 0);
  assert.ok(timeline.indexOf('orchestration-disposed') < timeline.indexOf('task-run-finalizers-drained'));
  assert.ok(timeline.indexOf('task-run-finalizers-drained') < timeline.indexOf('session-persistence-stopped'));
  assert.ok(timeline.indexOf('task-run-finalizers-drained') < timeline.indexOf('task-run-store-closed'));
});

test('TaskRun store close errors are logged and do not reject or stall shutdown', async () => {
  const timeline = [];
  const errors = [];
  let closeCalls = 0;
  const loaded = loadHostLifecycle();
  loaded.createHostLifecycle(createDeps({
    timeline,
    errors,
    taskRunStore: {
      close() {
        closeCalls += 1;
        timeline.push('task-run-store-close-attempted');
        throw new Error('simulated sqlite close failure');
      },
    },
  }));

  const coordinator = loaded.getCoordinator();
  await assert.doesNotReject(coordinator.shutdown({ graceMs: 1 }));
  assert.equal(coordinator.finished, true);
  assert.equal(closeCalls, 1);
  assert.ok(timeline.indexOf('session-persistence-stopped') < timeline.indexOf('task-run-store-close-attempted'));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task-run store close error/i);
  assert.match(errors[0], /simulated sqlite close failure/);
});

test('TaskRun close is still attempted after an earlier persistence closer fails', async () => {
  const timeline = [];
  const errors = [];
  let closeCalls = 0;
  const loaded = loadHostLifecycle();
  loaded.createHostLifecycle(createDeps({
    timeline,
    errors,
    sessionPersistenceStop: () => {
      timeline.push('session-persistence-attempted');
      throw new Error('session persistence stop failed');
    },
    taskRunStore: {
      close() {
        closeCalls += 1;
        timeline.push('task-run-store-closed');
      },
    },
  }));

  const coordinator = loaded.getCoordinator();
  await coordinator.shutdown({ graceMs: 1 });
  assert.equal(closeCalls, 1);
  assert.ok(timeline.indexOf('session-persistence-attempted') < timeline.indexOf('task-run-store-closed'));
  assert.ok(errors.some(message => /session persistence stop failed/.test(message)));
});

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

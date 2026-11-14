'use strict';

// Acceptance tests for the one global realtime-voice gateway.
//
// The invariant under test is "one machine, one voice runtime, and the routing
// target belongs to the utterance rather than to the process". Everything else
// here follows from that: two pre-migration Fleet records must still collapse to
// a single child, a launch ticket must be re-resolved (not replayed from a
// snapshot), and every entry point — Dashboard, Web Chat, Manage, Flutter — must
// go through the same launch call instead of naming a target itself.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  GLOBAL_VOICE_GATEWAY_ID,
  createVoiceGatewayService,
} = require('../src/voice/gateway');
const { createQwenAudioSupervisor } = require('../src/voice/qwen-audio-supervisor');
const { createVoiceLaunchRegistry } = require('../src/voice/launch');
const { VOICE_ROUTER_ID, createVoiceRouterProvisioner } = require('../src/voice/router');
const { createVoiceRuntimeHost, HOST_PATH } = require('../src/routes/voice-runtime-host');
const { createGatewayHost } = require('../src/dispatch/gateway-host');
const { resolveDirectoryCommander } = require('../src/task-board/core');

const REPO_ROOT = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseRecords() {
  return new Map([
    ['commander-1', {
      id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Fleet 一 Commander',
    }],
    ['chat-1', {
      id: 'chat-1', dirId: 'dir-1', type: 'worker', kind: 'chat', label: '前端会话',
      taskState: {
        goal: '修复登录页样式', phase: 'implementing', classifyState: 'P',
        classifyHistory: [{ goal: '旧任务', phase: 'done', state: 'D' }],
      },
    }],
    ['term-1', {
      id: 'term-1', dirId: 'dir-1', type: 'worker', kind: 'terminal', label: '终端会话',
    }],
    ['commander-2', {
      id: 'commander-2', dirId: 'dir-2', type: 'commander', kind: 'chat', label: 'Fleet 二 Commander',
    }],
    ['chat-2', {
      id: 'chat-2', dirId: 'dir-2', type: 'worker', kind: 'chat', label: '后端会话',
      taskState: {
        goal: '等待用户确认方案', phase: 'planning', classifyState: 'W',
        pendingUserInput: { question: '这个方案敏感吗', resolved: false },
      },
    }],
  ]);
}

function baseDirectories() {
  return new Map([
    ['dir-1', { id: 'dir-1', path: '/tmp/fleet-one', label: 'Fleet 一' }],
    ['dir-2', { id: 'dir-2', path: '/tmp/fleet-two', label: 'Fleet 二' }],
  ]);
}

// A pre-migration per-Fleet gateway record, exactly as an older MultiCC wrote it.
function addLegacyGateway(records, dirId, commanderSessionId) {
  const id = `__voice_gateway__legacy-${dirId}`;
  records.set(id, {
    id,
    dirId,
    type: 'gateway',
    kind: 'voice',
    gatewayKind: 'qwen-audio',
    enabled: true,
    commanderSessionId,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  return id;
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
  }
}

function supervisorHarness(records) {
  const root = tempDir('multicc-voice-global-');
  const runtime = {
    nodePath: '/private/runtime/node',
    packageRoot: path.join(root, 'package'),
    serverEntry: path.join(root, 'package', 'server', 'src', 'index.mjs'),
    fleetConfigRoot: path.join(root, 'fleets'),
  };
  const spawns = [];
  const supervisor = createQwenAudioSupervisor({
    records,
    directories: baseDirectories(),
    installer: {
      resolveInstalled: () => runtime,
      status: () => ({ installed: true, package: { version: '0.0.0-test' } }),
    },
    getConfig: () => ({ apiKey: 'dashscope-secret', model: 'qwen-test', voice: 'longanqian' }),
    getBaseUrl: () => 'http://127.0.0.1:3000',
    acpAgentPath: '/opt/multicc/multicc-acp-agent.mjs',
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return new FakeChild();
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        voiceConfigured: true,
        realtimeModel: 'qwen-test',
        backend: { ok: true, kind: 'acp' },
      }),
    }),
    healthIntervalMs: 60_000,
    startTimeoutMs: 2000,
    log: { error() {}, warn() {} },
  });
  return { runtime, spawns, supervisor };
}

test('two legacy Fleets left enabled still resolve to exactly one unbound child', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1');
  addLegacyGateway(records, 'dir-2', 'commander-2');

  // Before the migration both Fleets genuinely wanted their own process.
  const before = supervisorHarness(records);
  assert.equal(before.supervisor.hasGlobalGateway(), false);
  assert.equal(before.supervisor.status('dir-1').desired, true);
  assert.equal(before.supervisor.status('dir-2').desired, true);

  // The global record is the whole migration: same two enabled Fleet records.
  createVoiceGatewayService({
    records,
    directories: baseDirectories(),
    mutate: (_source, operation) => operation(records),
  }).ensureGlobal({});
  const global = records.get(GLOBAL_VOICE_GATEWAY_ID);
  assert.equal(global.enabled, true, 'an enabled Fleet migrates its intent, it is not silently dropped');

  const harness = supervisorHarness(records);
  assert.equal(harness.supervisor.hasGlobalGateway(), true);
  harness.supervisor.reconcileAll();
  const status = await harness.supervisor.startGlobal();

  assert.equal(status.state, 'running');
  assert.equal(harness.spawns.length, 1, 'two enabled Fleet records must not become two processes');
  assert.equal(harness.supervisor.status('dir-1').desired, false);
  assert.equal(harness.supervisor.status('dir-2').desired, false);

  const env = harness.spawns[0].options.env;
  assert.deepEqual(
    JSON.parse(env.ACP_ARGS),
    ['/opt/multicc/multicc-acp-agent.mjs'],
    'the global child must not be pinned to one Fleet at spawn time',
  );
  assert.equal(env.ACP_LABEL, 'MultiCC 实时语音');
  assert.equal(
    env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR,
    path.join(REPO_ROOT, 'src', 'voice', 'frontend-prompt'),
  );
  assert.ok(fs.existsSync(path.join(env.QWEN_AUDIO_AGENT_FRONTEND_PROMPT_DIR, 'PROMPT.md')));
  assert.doesNotMatch(JSON.stringify(status), /dashscope-secret/);

  await harness.supervisor.stopAll();
  await before.supervisor.stopAll();
});

const DEFAULT_INSTALLER = Object.freeze({
  status: () => ({ state: 'ready', installed: true }),
  startInstall: () => ({ state: 'installing', installed: false }),
  waitForInstall: async () => ({}),
});

const DEFAULT_SUPERVISOR = Object.freeze({
  hasGlobalGateway: () => false,
  status: directoryId => ({ directoryId, state: 'stopped' }),
  statusGlobal: () => ({ scope: 'global', state: 'stopped', desired: false }),
  restart: async directoryId => ({ directoryId, state: 'running' }),
  restartGlobal: async () => ({ scope: 'global', state: 'running' }),
  reconcileAll() {},
});

function launchHarness({
  records = baseRecords(),
  directories = baseDirectories(),
  enabled = true,
  provisionRouter = true,
  ttlMs = 30 * 60 * 1000,
  runtimeUrl = 'http://127.0.0.1:32123',
  runtime: runtimeOverride = null,
  installer = DEFAULT_INSTALLER,
  supervisor = DEFAULT_SUPERVISOR,
} = {}) {
  const clock = { value: Date.parse('2026-08-02T00:00:00.000Z') };
  const service = createVoiceGatewayService({
    records,
    directories,
    mutate: (_source, operation) => operation(records),
  });
  if (enabled) service.ensureGlobal({ enabled: true });
  const voiceRouter = createVoiceRouterProvisioner({
    records,
    mutate: (_source, operation) => operation(records),
    runtimeRoot: tempDir('multicc-voice-router-'),
  });
  if (provisionRouter) voiceRouter.ensure();
  let ticketSeq = 0;
  const launchRegistry = createVoiceLaunchRegistry({
    records,
    directories,
    resolveCommander: resolveDirectoryCommander,
    now: () => clock.value,
    randomId: () => `ticket-${++ticketSeq}`,
    ttlMs,
  });
  const calls = { start: 0, restart: 0, reconcile: 0 };
  const runtime = runtimeOverride || {
    statusGlobal: () => ({ scope: 'global', state: 'running', desired: true, url: runtimeUrl }),
    startGlobal: async () => { calls.start += 1; return { scope: 'global', state: 'running', url: runtimeUrl }; },
    restartGlobal: async () => { calls.restart += 1; return { scope: 'global', state: 'running', url: runtimeUrl }; },
    reconcileAll: () => { calls.reconcile += 1; },
    stopGlobal: async () => {},
  };
  const host = createVoiceRuntimeHost({
    service,
    launchRegistry,
    voiceRouter,
    runtime,
    getBaseUrl: () => 'http://127.0.0.1:3000',
    log: { info() {}, warn() {} },
    installer,
    supervisor,
  });
  const app = hostApp();
  host.mountRoutes(app);
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return { app, calls, clock, directories, handler, host, launchRegistry, records, runtime, service, voiceRouter };
}

function hostApp() {
  const routes = new Map();
  return {
    routes,
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
  };
}

function hostResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function localRequest(body) {
  return {
    body,
    ip: '127.0.0.1',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

async function hostCall(harness, body) {
  const res = hostResponse();
  await harness.handler(localRequest(body), res);
  return res;
}

// A runtime host with the shared defaults, for the installer/supervisor-only ops.
function runtimeHost({ installer = DEFAULT_INSTALLER, supervisor = DEFAULT_SUPERVISOR } = {}) {
  const records = baseRecords();
  const directories = baseDirectories();
  const service = createVoiceGatewayService({
    records,
    directories,
    mutate: (_source, operation) => operation(records),
  });
  const launchRegistry = createVoiceLaunchRegistry({
    records,
    directories,
    resolveCommander: resolveDirectoryCommander,
  });
  const app = hostApp();
  createVoiceRuntimeHost({
    service,
    launchRegistry,
    installer,
    supervisor,
    log: { info() {}, warn() {}, error() {} },
  }).mountRoutes(app);
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return { handler, records };
}

test('chat and global launches resolve to their own targets and never each other', async () => {
  const harness = launchHarness();

  const chat = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'chat-1' });
  assert.equal(chat.body.ok, true);
  assert.equal(chat.body.launch.scope, 'chat');
  assert.equal(chat.body.launch.display, '前端会话');
  assert.equal(chat.body.launch.sourceSessionId, 'chat-1');
  assert.equal(chat.body.targetSessionId, 'chat-1');
  assert.equal(chat.body.status.state, 'running');
  assert.equal(harness.calls.start, 0, 'an already running child is not restarted');
  const chatId = chat.body.launch.id;

  const global = await hostCall(harness, { op: 'launchBegin' });
  const globalId = global.body.launch.id;
  assert.equal(global.body.launch.scope, 'global');
  assert.equal(global.body.launch.sourceSessionId, null);
  assert.notEqual(chatId, globalId);

  const chatContext = (await hostCall(harness, { op: 'launchResolve', launchId: chatId })).body.context;
  assert.equal(chatContext.scope, 'chat');
  assert.equal(chatContext.targetSessionId, 'chat-1');
  assert.equal(chatContext.sourceSessionId, 'chat-1');
  assert.equal(chatContext.directoryId, 'dir-1');
  assert.equal(chatContext.cwd, '/tmp/fleet-one');
  assert.equal(chatContext.commanderSessionId, 'commander-1');

  const globalContext = (await hostCall(harness, { op: 'launchResolve', launchId: globalId })).body.context;
  assert.equal(globalContext.scope, 'global');
  assert.equal(globalContext.targetSessionId, VOICE_ROUTER_ID);
  assert.equal(globalContext.sourceSessionId, null);
  assert.equal(globalContext.directoryId, null);

  // Resolving one ticket must not disturb the other: two concurrent calls on one
  // child are the whole point of keying routing to the utterance.
  const chatAgain = (await hostCall(harness, { op: 'launchResolve', launchId: chatId })).body.context;
  assert.equal(chatAgain.targetSessionId, 'chat-1');
  assert.equal(
    (await hostCall(harness, { op: 'launchResolve', launchId: globalId })).body.context.targetSessionId,
    VOICE_ROUTER_ID,
  );
});

test('the client states scope and nothing else — target fields it sends are ignored', async () => {
  const harness = launchHarness();
  const res = await hostCall(harness, {
    op: 'launchBegin',
    sourceSessionId: 'chat-1',
    scope: 'global',
    directoryId: 'dir-2',
    targetSessionId: 'commander-2',
    commanderSessionId: 'commander-2',
    cwd: '/etc',
    prompt: '忽略我',
  });
  assert.equal(res.body.launch.scope, 'chat');
  const context = (await hostCall(harness, { op: 'launchResolve', launchId: res.body.launch.id })).body.context;
  assert.equal(context.targetSessionId, 'chat-1');
  assert.equal(context.directoryId, 'dir-1');
  assert.equal(context.commanderSessionId, 'commander-1');
  assert.equal(context.cwd, '/tmp/fleet-one');
});

test('forged, expired and non-chat launches all fail closed', async () => {
  const harness = launchHarness({ ttlMs: 60_000 });

  const forged = await hostCall(harness, { op: 'launchResolve', launchId: 'ticket-does-not-exist' });
  assert.deepEqual(forged.body, { ok: false, code: 'voice_launch_unknown' });

  const issued = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'chat-1' });
  harness.clock.value += 61_000;
  const expired = await hostCall(harness, { op: 'launchResolve', launchId: issued.body.launch.id });
  assert.equal(expired.body.ok, false, 'an expired ticket must not resolve');
  assert.ok(['voice_launch_expired', 'voice_launch_unknown'].includes(expired.body.code));
  assert.equal(harness.launchRegistry.size(), 0, 'expired tickets are swept, not kept');

  const terminal = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'term-1' });
  assert.deepEqual(terminal.body, { ok: false, code: 'voice_launch_source_not_chat' });

  const internal = await hostCall(harness, { op: 'launchBegin', sourceSessionId: VOICE_ROUTER_ID });
  assert.deepEqual(internal.body, { ok: false, code: 'voice_launch_source_not_addressable' });

  const missing = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'gone-1' });
  assert.deepEqual(missing.body, { ok: false, code: 'voice_launch_source_not_found' });
});

test('a chat launch defaults to its own session and dies with it', async () => {
  const harness = launchHarness();
  const issued = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'chat-2' });
  assert.equal(issued.body.launch.sourceSessionId, 'chat-2');
  const context = (await hostCall(harness, { op: 'launchResolve', launchId: issued.body.launch.id })).body.context;
  assert.equal(context.targetSessionId, 'chat-2');
  assert.equal(context.directoryId, 'dir-2');
  assert.equal(context.commanderSessionId, 'commander-2');

  harness.records.delete('chat-2');
  const orphaned = await hostCall(harness, { op: 'launchResolve', launchId: issued.body.launch.id });
  assert.deepEqual(orphaned.body, { ok: false, code: 'voice_launch_source_not_found' });
});

test('an ambiguous global request lands on the router, never on a guessed Fleet', async () => {
  // With no router record the registry fails closed rather than picking a Fleet.
  const bare = new Map([
    ['commander-1', { id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Commander' }],
  ]);
  const registry = createVoiceLaunchRegistry({
    records: bare,
    directories: baseDirectories(),
    resolveCommander: resolveDirectoryCommander,
  });
  const refused = registry.issue({});
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'voice_router_not_provisioned');
  assert.equal(registry.size(), 0, 'a refused launch issues no ticket');

  // The host port backfills the missing router instead of failing the user, but
  // it still lands on the router — never on the only Fleet that happens to exist.
  const unprovisioned = launchHarness({ provisionRouter: false });
  const backfilled = await hostCall(unprovisioned, { op: 'launchBegin' });
  assert.equal(backfilled.body.ok, true);
  assert.ok(unprovisioned.records.has(VOICE_ROUTER_ID));
  assert.equal(
    (await hostCall(unprovisioned, { op: 'launchResolve', launchId: backfilled.body.launch.id }))
      .body.context.targetSessionId,
    VOICE_ROUTER_ID,
  );

  // Even with exactly one Fleet in play, a global launch must not "helpfully"
  // pick it: the router session is the only place allowed to decide.
  const records = new Map([
    ['commander-1', { id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Commander' }],
  ]);
  const single = launchHarness({ records, directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/only' }]]) });
  const issued = await hostCall(single, { op: 'launchBegin' });
  const context = (await hostCall(single, { op: 'launchResolve', launchId: issued.body.launch.id })).body.context;
  assert.equal(context.targetSessionId, VOICE_ROUTER_ID);
  assert.notEqual(context.targetSessionId, 'commander-1');
});

test('a conflicting reserved Voice Router id fails closed before ticket issue', async () => {
  const records = baseRecords();
  records.set(VOICE_ROUTER_ID, {
    id: VOICE_ROUTER_ID, dirId: 'dir-1', type: 'worker', kind: 'chat', label: 'Impostor',
  });
  const direct = createVoiceLaunchRegistry({
    records,
    directories: baseDirectories(),
    resolveCommander: resolveDirectoryCommander,
  });
  assert.deepEqual(direct.issue({}), { ok: false, code: 'voice_router_id_conflict' });
  assert.equal(direct.size(), 0);

  const harness = launchHarness({ records, provisionRouter: false });
  const response = await hostCall(harness, { op: 'launchBegin' });
  assert.deepEqual(response.body, { ok: false, code: 'voice_router_id_conflict' });
  assert.equal(harness.launchRegistry.size(), 0);

  const valid = launchHarness();
  const issued = await hostCall(valid, { op: 'launchBegin' });
  const launchId = issued.body.launch.id;
  valid.records.set(VOICE_ROUTER_ID, {
    id: VOICE_ROUTER_ID, dirId: 'dir-1', type: 'worker', kind: 'chat', label: 'Reclassified',
  });
  const reclassified = await hostCall(valid, { op: 'launchResolve', launchId });
  assert.deepEqual(reclassified.body, { ok: false, code: 'voice_router_id_conflict' });

  const racedRecords = baseRecords();
  const raced = createVoiceRouterProvisioner({
    records: racedRecords,
    runtimeRoot: tempDir('multicc-voice-router-race-'),
    mutate: (_source, operation) => {
      racedRecords.set(VOICE_ROUTER_ID, {
        id: VOICE_ROUTER_ID, dirId: 'dir-1', type: 'worker', kind: 'chat', label: 'Raced',
      });
      operation(racedRecords);
    },
  });
  assert.deepEqual(raced.ensure(), { ok: false, code: 'voice_router_id_conflict' });
});

test('chat launch refreshes compatibility Commander metadata without changing its source target', async () => {
  const harness = launchHarness();
  const issued = await hostCall(harness, { op: 'launchBegin', sourceSessionId: 'chat-1' });
  const launchId = issued.body.launch.id;
  assert.equal(
    (await hostCall(harness, { op: 'launchResolve', launchId })).body.context.commanderSessionId,
    'commander-1',
  );

  harness.records.delete('commander-1');
  harness.records.set('commander-9', {
    id: 'commander-9', dirId: 'dir-1', type: 'commander', kind: 'chat', label: '新 Commander',
  });

  const after = (await hostCall(harness, { op: 'launchResolve', launchId })).body.context;
  assert.equal(after.commanderSessionId, 'commander-9', 'the ticket is re-resolved, not a snapshot');
  assert.equal(after.targetSessionId, 'chat-1', 'Commander metadata never redirects a chat launch');
  assert.equal(after.launchId, launchId, 'the user does not have to re-launch');
  assert.equal(harness.calls.restart, 0, 'no process restart is involved');
});

test('the global runtime host ops report the raw child status and restart on demand', async () => {
  const harness = launchHarness();
  const runtime = await hostCall(harness, { op: 'globalRuntime' });
  assert.equal(runtime.body.status.state, 'running');
  // The host port is internal; stripping the loopback URL from the public
  // response is the Rust front door's job.
  assert.equal(runtime.body.status.url, 'http://127.0.0.1:32123');

  const restarted = await hostCall(harness, { op: 'globalRestart' });
  assert.equal(restarted.body.status.state, 'running');
  assert.equal(harness.calls.restart, 1);
});

test('legacy per-Fleet runtime host ops project the one global child', async () => {
  const installer = DEFAULT_INSTALLER;
  const projecting = {
    hasGlobalGateway: () => true,
    status: () => { throw new Error('the legacy Fleet slot must not answer once the gateway is global'); },
    statusGlobal: () => ({ scope: 'global', state: 'running', desired: true }),
    restart: async () => { throw new Error('the legacy Fleet child must not be restarted'); },
    restartGlobal: async () => ({ scope: 'global', state: 'running', desired: true }),
    reconcileAll() {},
  };
  const harness = runtimeHost({ installer, supervisor: projecting });

  const status = await hostCall(harness, { op: 'fleetRuntime', id: 'dir-1' });
  assert.deepEqual(status.body, {
    projectsGlobal: true,
    status: { scope: 'global', state: 'running', desired: true },
  });

  const restarted = await hostCall(harness, { op: 'fleetRestart', id: 'dir-1' });
  assert.deepEqual(restarted.body, {
    projectsGlobal: true,
    status: { scope: 'global', state: 'running', desired: true },
  });

  // Before the migration the same ops still answer for the Fleet itself.
  const legacy = runtimeHost({
    installer,
    supervisor: {
      hasGlobalGateway: () => false,
      status: directoryId => ({ directoryId, state: 'stopped', desired: true }),
      restart: async directoryId => ({ directoryId, state: 'running' }),
      reconcileAll() {},
    },
  });
  const legacyStatus = await hostCall(legacy, { op: 'fleetRuntime', id: 'dir-1' });
  assert.deepEqual(legacyStatus.body, {
    projectsGlobal: false,
    status: { directoryId: 'dir-1', state: 'stopped', desired: true },
  });
  const legacyRestart = await hostCall(legacy, { op: 'fleetRestart', id: 'dir-1' });
  assert.deepEqual(legacyRestart.body, {
    projectsGlobal: false,
    status: { directoryId: 'dir-1', state: 'running' },
  });
});

function gatewayHostFixture() {
  const records = baseRecords();
  records.set(VOICE_ROUTER_ID, {
    id: VOICE_ROUTER_ID, type: 'gateway', kind: 'chat', label: '🎙️ 实时语音 Router', dirId: null,
  });
  const admissions = [];
  const broadcasts = [];
  const completions = [];
  const chatSessions = new Map([[VOICE_ROUTER_ID, {
    _activeTurn: { turnId: 'voice-turn-1', requestId: 'voice-request-1' },
  }]]);
  const operations = new Map();
  const seen = new Set();
  const host = createGatewayHost({
    persistedSessions: records,
    chatSessions,
    directories: baseDirectories(),
    logger: { warn() {} },
    getChatHistoryService: () => ({ replace() {} }),
    appendEvent() {},
    getSessionDelivery: () => ({ deliverContinuation() {}, deliverSystem() {} }),
    normalizeEffort: value => value,
    dispatchTargetHintFor: () => '',
    cwdForSession: record => (record.dirId === 'dir-2' ? '/tmp/fleet-two' : '/tmp/fleet-one'),
    getSetSessionStatus: () => () => {},
    isTargetBusy: () => false,
    getOrchestrationRuntime: () => ({
      operations: { get: async id => operations.get(id) || null },
      admitDispatch: async spec => {
        admissions.push(spec);
        const duplicate = seen.has(spec.idempotencyKey);
        seen.add(spec.idempotencyKey);
        return { id: 'op-voice-1', status: 'admitted', createdAt: 1, idempotent: duplicate };
      },
      completeDispatch: async (id, result) => {
        completions.push({ id, result });
        return { ok: true };
      },
      tick: async () => {},
    }),
    getTaskContextHost: () => ({ dispatchSpec: () => ({}) }),
    getCreateSessionRecord: () => async () => { throw new Error('voice dispatch must reuse existing sessions'); },
    appendChatMessage() {},
    chatBroadcast: (sessionId, message) => broadcasts.push({ sessionId, message }),
    loadChatHistory: () => [],
  });
  return { admissions, broadcasts, chatSessions, completions, host, operations, records };
}

test('voice admission is emitted only from an authoritative MCP admission', () => {
  const fixture = gatewayHostFixture();
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'queued',
    duplicate: true,
  });
  // Turn completion must not overwrite an already-emitted admission.
  fixture.host.handleGatewayTurnComplete('已处理', VOICE_ROUTER_ID, 'voice-turn-1', 'voice-request-1');

  const frames = fixture.broadcasts.filter(entry => entry.message.type === 'voice_admission');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, VOICE_ROUTER_ID);
  assert.equal(frames[0].message.outcome, 'admitted');
  assert.equal(frames[0].message.operationId, 'op-voice-1');
  assert.equal(frames[0].message.duplicate, true);
  assert.equal(frames[0].message.targetLabel, undefined, 'target metadata never enters the voice frame');
});

test('a voice turn with no MCP admission emits no_dispatch, while WeChat needs no outcome frame', () => {
  const fixture = gatewayHostFixture();
  fixture.host.handleGatewayTurnComplete(
    '需要你先说明项目', VOICE_ROUTER_ID, 'voice-turn-2', 'voice-request-2',
  );
  fixture.host.handleGatewayTurnComplete('普通微信回复', fixture.host.GATEWAY_ID, 'wechat-1', 'wechat-1');
  const frames = fixture.broadcasts.filter(entry => entry.message.type === 'voice_admission');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].message.outcome, 'no_dispatch');
  assert.equal(frames[0].message.speechText, '需要你先说明项目');
});

test('the voice router prompt routes by Fleet and asks instead of guessing', () => {
  const fixture = gatewayHostFixture();
  const voice = fixture.host.buildGatewayPrompt('把这个交给一号项目', VOICE_ROUTER_ID);
  assert.match(voice, /realtime voice router/);
  assert.match(voice, /call dispatch_master with mode set to async/);
  assert.match(voice, /ask back in a single sentence instead of picking an id yourself/);
  assert.match(voice, /related session is busy.*prefer another qualified idle chat/);
  assert.match(voice, /explicitly named by the user must be chosen as-is, never redirected/);
  assert.match(voice, /waiting_user.*background.*error/);
  assert.match(voice, /goal, known facts, constraints.*acceptance criteria/);
  assert.doesNotMatch(voice, /<<dispatch target=/);
  assert.doesNotMatch(voice, /"type":"commander"/, 'Commander sessions are not worker targets');
  assert.match(voice, /"dirId":"dir-1"/, 'the router needs the Fleet id to resolve 这个项目');
  assert.equal(voice.includes(VOICE_ROUTER_ID), false, 'system sessions are not dispatch targets');

  const wechat = fixture.host.buildGatewayPrompt('把这个交给一号项目');
  assert.equal(wechat.includes('realtime voice router'), false, 'the WeChat prompt is untouched');
  assert.match(wechat, /wait for the user to reply with an explicit confirmation/);
  assert.match(wechat, /dispatch_master, with mode set to async/);
  assert.match(wechat, /related session is busy.*prefer another qualified idle chat/);
  assert.match(wechat, /explicitly named by the user must be chosen as-is, never redirected/);
  assert.match(wechat, /waiting_user.*background.*error/);
  assert.match(wechat, /goal, known facts, constraints.*acceptance criteria/);
  assert.match(wechat, /"routingState":"processing"/);
  assert.match(wechat, /修复登录页样式/);
});

test('an explicitly named worker is visible even beyond the bounded snapshot window', () => {
  const fixture = gatewayHostFixture();
  for (let index = 0; index < 35; index += 1) {
    fixture.records.set(`older-worker-${index}`, {
      id: `older-worker-${index}`,
      dirId: 'dir-1',
      type: 'worker',
      kind: 'chat',
      label: `旧会话 ${index}`,
    });
  }
  fixture.records.set('multicc-codex-chat-08', {
    id: 'multicc-codex-chat-08',
    dirId: 'dir-2',
    type: 'worker',
    kind: 'chat',
    label: '架构安全与可观测性',
  });

  const voice = fixture.host.buildGatewayPrompt(
    '把“构建已经完成”发给 multicc-codex-chat-08 会话',
    VOICE_ROUTER_ID,
  );
  const match = voice.match(/Realtime snapshot of currently visible sessions: (.+)\n\[Voice router system prompt end\]/);
  assert.ok(match, 'voice snapshot must remain machine-readable JSON');
  const snapshot = JSON.parse(match[1]);
  assert.equal(snapshot.length, 30, 'the prompt budget remains bounded');
  assert.ok(
    snapshot.some(session => session.id === 'multicc-codex-chat-08'),
    'an exact target is promoted before the 30-session truncation',
  );
});

test('the voice router snapshot carries live status so spoken status questions are answerable', () => {
  const fixture = gatewayHostFixture();
  const voice = fixture.host.buildGatewayPrompt('各个会话执行情况如何', VOICE_ROUTER_ID);
  // Status questions are answered from the snapshot, never dispatched.
  assert.match(voice, /answer truthfully from the routingState and recentTasks in the snapshot below/);
  assert.match(voice, /Do not invent details/);
  // The digest mirrors the Commander routing preamble's bounded facts.
  assert.match(voice, /"fleet":"Fleet 一"/, 'directory label resolves a spoken fleet name');
  assert.match(voice, /"routingState":"processing"/, 'chat-1 classify P maps to processing');
  assert.match(voice, /"routingState":"waiting_user"/, 'chat-2 pending input maps to waiting_user');
  assert.match(voice, /修复登录页样式/, 'current goal is visible');
  assert.match(voice, /"phase":"implementing"/, 'current phase is visible');
  // The pending question text must never leak into the snapshot.
  assert.equal(voice.includes('这个方案敏感吗'), false, 'pending question stays server-side');

  const wechat = fixture.host.buildGatewayPrompt('各个会话执行情况如何');
  assert.match(wechat, /"routingState":"processing"/, 'WeChat routing gets the same readiness signal');
  assert.match(wechat, /修复登录页样式/, 'WeChat can choose a capable fallback from recent task evidence');
  assert.equal(wechat.includes('这个方案敏感吗'), false, 'WeChat also keeps pending details private');
});

test('dispatch finalization keeps sync inline and requires dispatch_slave for async', async () => {
  const fixture = gatewayHostFixture();
  fixture.operations.set('op-sync', {
    id: 'op-sync', kind: 'dispatch', status: 'running',
    spec: { resultMode: 'sync', targetId: 'chat-1', replyTo: 'commander-1' },
  });
  await fixture.host.finalizeDispatch('op-sync', 'chat-1', 'sync result');
  assert.deepEqual(fixture.completions.at(-1), {
    id: 'op-sync',
    result: {
      status: 'completed', sessionName: 'chat-1', text: 'sync result',
      source: 'sync_final_output',
    },
  });

  fixture.operations.set('op-async-missing', {
    id: 'op-async-missing', kind: 'dispatch', status: 'running',
    spec: { resultMode: 'async', targetId: 'chat-1', replyTo: 'commander-1' },
  });
  await fixture.host.finalizeDispatch('op-async-missing', 'chat-1', 'untrusted final');
  const missing = fixture.completions.at(-1);
  assert.equal(missing.id, 'op-async-missing');
  assert.equal(missing.result.status, 'failed');
  assert.match(missing.result.error, /without calling dispatch_slave/);
  assert.equal(missing.result.source, 'missing_dispatch_slave');

  fixture.operations.set('op-async-done', {
    id: 'op-async-done', kind: 'dispatch', status: 'completed',
    spec: { resultMode: 'async', targetId: 'chat-1', replyTo: 'commander-1' },
  });
  const count = fixture.completions.length;
  await fixture.host.finalizeDispatch('op-async-done', 'chat-1', 'ignored');
  assert.equal(fixture.completions.length, count, 'dispatch_slave completion is not overwritten');
});

test('the repo-owned frontend prompt carries identity only, never per-call context', () => {
  const prompt = readRepoFile('src/voice/frontend-prompt/PROMPT.md');
  assert.match(prompt, /MultiCC/);
  assert.match(prompt, /spawn_thinking/);
  assert.match(prompt, /用户明确点名的项目、会话、Commander 或 Worker/);
  assert.match(prompt, /必须原样保留/);
  assert.match(prompt, /不要说：无法联系团队/);
  assert.match(prompt, /任务板/);
  // Dynamic routing context is injected per launch; baking it into a
  // machine-wide prompt would make every call speak for one Fleet.
  for (const leak of ['dir-1', '__voice_router__', 'sourceSessionId', 'launchId', 'commander-1']) {
    assert.equal(prompt.includes(leak), false, `${leak} must not be baked into the global prompt`);
  }
});

test('every voice entry point goes through the one launch endpoint', () => {
  const client = readRepoFile('public/voice-launch-client.js');
  assert.match(client, /ENDPOINT = '\/api\/v1\/voice-gateway\/launch'/);
  assert.match(client, /MultiCCVoiceLaunch/);
  assert.equal(/token=/.test(client), false, 'the launch URL is host-issued; no token is appended');

  const chatJs = readRepoFile('public/chat.js');
  assert.match(chatJs, /window\.MultiCCVoiceLaunch/);
  assert.match(chatJs, /sourceSessionId: _sessionName/, 'the Chat button launches in its own session');
  assert.equal(/new S2SSession/.test(chatJs), false, 'the in-page S2S state machine is gone');

  const chatHtml = readRepoFile('public/chat.html');
  assert.match(chatHtml, /voice-launch-client\.js/);
  assert.equal(/src="s2s-session\.js"/.test(chatHtml), false);


  const manage = readRepoFile('public/manage-qwen-audio.js');
  assert.match(manage, /MultiCCVoiceLaunch/);
  assert.match(manage, /\/api\/v1\/voice-gateway/);
  assert.match(manage, /Object\.freeze\(\{ initialize, loadPanel, openGlobalVoice \}\)/);
  assert.equal(/voice-gateway\/fleets|renderFleets/.test(manage), false, 'the Fleet list is gone');
  // 旧 manage 页首页那颗 #overview-voice-beta 按钮随该页删除，入口搬进 Air 的语音面板。
  const airVoice = readRepoFile('public/air-voice.js');
  assert.match(airVoice, /id = 'air-voice-global-call'/);
  assert.match(airVoice, /t\('globalVoiceBetaHint'\)/);
  assert.match(airVoice, /MultiCCManageQwenAudio\?\.openGlobalVoice/);
  assert.match(airVoice, /'BETA'/, 'the Air entry clearly marks the feature as beta');

  const dart = readRepoFile('app/lib/services/voice_launch_service.dart');
  assert.match(dart, /\/api\/v1\/voice-gateway\/launch/);
  assert.match(dart, /X-Access-Token/, 'the token travels in a header, never in the opened URL');
  assert.match(dart, /LaunchMode\.externalApplication/);
  assert.match(dart, /只在运行 MultiCC 的这台机器上可用/, 'loopback-only is stated, not papered over');

  const inputBar = readRepoFile('app/lib/widgets/input_bar.dart');
  assert.match(inputBar, /VoiceLaunchService\(settings: provider\.settings\)/);
  assert.match(inputBar, /sourceSessionId: provider\.sessionName/);
  assert.equal(/S2SSession|voice_call_screen/.test(inputBar), false);

  const mainShell = readRepoFile('app/lib/screens/main_shell.dart');
  assert.match(mainShell, /VoiceLaunchService\(settings: widget\.settings\)\.launch\(\)/);
  // 老首页那一版 _VoiceBetaEntry 入口随整块首页下线；Air 侧栏的语音入口由
  // public/air-voice.js 一节钉住（见上），这里不再要求 main_shell 自带那条横幅。
  assert.match(readRepoFile('app/assets/i18n/zh.json'), /"globalVoiceCall"/);
  assert.match(readRepoFile('app/assets/i18n/en.json'), /"globalVoiceCall"/);
  assert.match(readRepoFile('app/assets/i18n/zh.json'), /"globalVoiceBetaHint"/);
  assert.match(readRepoFile('app/assets/i18n/en.json'), /"globalVoiceBetaHint"/);
});

test('plain microphone dictation is untouched by the realtime voice gateway', () => {
  // Dictation lives in the shared voice module both the Chat page and the Air
  // directory's quick composer load; the composer delegates to it.
  const voice = readRepoFile('public/voice-composer.js');
  assert.match(voice, /\/ws\/voice/, 'web dictation still streams to /ws/voice');
  const composer = readRepoFile('public/chat-composer.js');
  assert.match(composer, /MultiCCVoiceComposer/, 'the chat composer delegates voice input');

  const dictation = readRepoFile('app/lib/services/voice_dictation_service.dart');
  assert.match(dictation, /\/ws\/voice/);
  // App 同理：会话页输入条与目录快速新建共用 voice_composer.dart。
  const voiceComposer = readRepoFile('app/lib/widgets/voice_composer.dart');
  assert.match(voiceComposer, /VoiceDictationService/);
  assert.match(voiceComposer, /toggleMic/);
  assert.match(readRepoFile('app/lib/widgets/input_bar.dart'), /VoiceComposerController/);

  // The launch path owns no microphone: dictation and realtime voice stay
  // separate features on separate buttons.
  const client = readRepoFile('public/voice-launch-client.js');
  for (const microphone of ['getUserMedia', 'MediaRecorder', '/ws/voice', 'AudioContext']) {
    assert.equal(client.includes(microphone), false);
    assert.equal(readRepoFile('app/lib/services/voice_launch_service.dart').includes(microphone), false);
  }
});

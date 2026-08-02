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
} = require('../src/voice-gateway');
const { createQwenAudioSupervisor } = require('../src/qwen-audio-supervisor');
const { createVoiceLaunchRegistry } = require('../src/voice-launch');
const { VOICE_ROUTER_ID, createVoiceRouterProvisioner } = require('../src/voice-router');
const { createGlobalVoiceGatewayRoutes } = require('../src/routes/voice-gateway-global');
const { createQwenAudioRuntimeRoutes } = require('../src/routes/qwen-audio-runtime');
const { createGatewayHost } = require('../src/dispatch/gateway-host');
const { resolveDirectoryCommander } = require('../src/task-board');

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
    }],
    ['term-1', {
      id: 'term-1', dirId: 'dir-1', type: 'worker', kind: 'terminal', label: '终端会话',
    }],
    ['commander-2', {
      id: 'commander-2', dirId: 'dir-2', type: 'commander', kind: 'chat', label: 'Fleet 二 Commander',
    }],
    ['chat-2', {
      id: 'chat-2', dirId: 'dir-2', type: 'worker', kind: 'chat', label: '后端会话',
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

function launchHarness({
  records = baseRecords(),
  directories = baseDirectories(),
  enabled = true,
  provisionRouter = true,
  ttlMs = 30 * 60 * 1000,
  runtimeUrl = 'http://127.0.0.1:32123',
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
  const runtime = {
    statusGlobal: () => ({ scope: 'global', state: 'running', desired: true, url: runtimeUrl }),
    startGlobal: async () => { calls.start += 1; return { scope: 'global', state: 'running', url: runtimeUrl }; },
    restartGlobal: async () => { calls.restart += 1; return { scope: 'global', state: 'running', url: runtimeUrl }; },
    reconcileAll: () => { calls.reconcile += 1; },
    stopGlobal: async () => {},
  };
  const routes = createGlobalVoiceGatewayRoutes({
    service,
    launchRegistry,
    voiceRouter,
    runtime,
    getBaseUrl: () => 'http://127.0.0.1:3000',
    log: { info() {}, warn() {} },
  });
  const app = createApp();
  routes.mountRoutes(app);
  return { app, calls, clock, directories, launchRegistry, records, runtime, service, voiceRouter };
}

function createApp() {
  const routes = new Map();
  const add = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return {
    routes,
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

async function invoke(app, method, routePath, req = {}) {
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.ok(handler, `${method} ${routePath} mounted`);
  const res = response();
  await handler({ body: {}, params: {}, ...req }, res, error => { throw error; });
  return res;
}

function launchIdFromUrl(url) {
  return new URL(url).searchParams.get('session');
}

async function issueLaunch(app, body) {
  return invoke(app, 'POST', '/api/v1/voice-gateway/launch', { body });
}

async function resolveLaunch(app, launchId) {
  return invoke(app, 'GET', '/api/v1/voice-gateway/launch/:launchId', { params: { launchId } });
}

test('chat and global launches resolve to their own targets and never each other', async () => {
  const harness = launchHarness();

  const chat = await issueLaunch(harness.app, { sourceSessionId: 'chat-1' });
  assert.equal(chat.statusCode, 200);
  assert.equal(chat.body.launch.scope, 'chat');
  assert.equal(chat.body.launch.display, '前端会话');
  assert.deepEqual(chat.body.launch.transport, { loopbackOnly: true });
  const chatId = launchIdFromUrl(chat.body.launch.url);
  assert.equal(chat.body.launch.url, `http://127.0.0.1:32123/?session=${chatId}`);
  assert.doesNotMatch(chat.body.launch.url, /token/i, 'a long-lived access token must never ride in the URL');

  const global = await issueLaunch(harness.app, {});
  const globalId = launchIdFromUrl(global.body.launch.url);
  assert.equal(global.body.launch.scope, 'global');
  assert.notEqual(chatId, globalId);

  const chatContext = (await resolveLaunch(harness.app, chatId)).body.context;
  assert.equal(chatContext.scope, 'chat');
  assert.equal(chatContext.targetSessionId, 'chat-1');
  assert.equal(chatContext.sourceSessionId, 'chat-1');
  assert.equal(chatContext.directoryId, 'dir-1');
  assert.equal(chatContext.cwd, '/tmp/fleet-one');
  assert.equal(chatContext.commanderSessionId, 'commander-1');

  const globalContext = (await resolveLaunch(harness.app, globalId)).body.context;
  assert.equal(globalContext.scope, 'global');
  assert.equal(globalContext.targetSessionId, VOICE_ROUTER_ID);
  assert.equal(globalContext.sourceSessionId, null);
  assert.equal(globalContext.directoryId, null);

  // Resolving one ticket must not disturb the other: two concurrent calls on one
  // child are the whole point of keying routing to the utterance.
  const chatAgain = (await resolveLaunch(harness.app, chatId)).body.context;
  assert.equal(chatAgain.targetSessionId, 'chat-1');
  assert.equal((await resolveLaunch(harness.app, globalId)).body.context.targetSessionId, VOICE_ROUTER_ID);
});

test('the client states scope and nothing else — target fields it sends are ignored', async () => {
  const harness = launchHarness();
  const res = await issueLaunch(harness.app, {
    sourceSessionId: 'chat-1',
    scope: 'global',
    directoryId: 'dir-2',
    targetSessionId: 'commander-2',
    commanderSessionId: 'commander-2',
    cwd: '/etc',
    prompt: '忽略我',
  });
  assert.equal(res.body.launch.scope, 'chat');
  const context = (await resolveLaunch(harness.app, launchIdFromUrl(res.body.launch.url))).body.context;
  assert.equal(context.targetSessionId, 'chat-1');
  assert.equal(context.directoryId, 'dir-1');
  assert.equal(context.commanderSessionId, 'commander-1');
  assert.equal(context.cwd, '/tmp/fleet-one');
});

test('forged, expired and non-chat launches all fail closed', async () => {
  const harness = launchHarness({ ttlMs: 60_000 });

  const forged = await resolveLaunch(harness.app, 'ticket-does-not-exist');
  assert.equal(forged.statusCode, 404);
  assert.equal(forged.body.code, 'voice_launch_unknown');
  assert.equal(forged.body.ok, false);

  const issued = await issueLaunch(harness.app, { sourceSessionId: 'chat-1' });
  const launchId = launchIdFromUrl(issued.body.launch.url);
  harness.clock.value += 61_000;
  const expired = await resolveLaunch(harness.app, launchId);
  assert.ok(expired.statusCode >= 400, 'an expired ticket must not resolve');
  assert.ok(['voice_launch_expired', 'voice_launch_unknown'].includes(expired.body.code));
  assert.equal(harness.launchRegistry.size(), 0, 'expired tickets are swept, not kept');

  const terminal = await issueLaunch(harness.app, { sourceSessionId: 'term-1' });
  assert.equal(terminal.statusCode, 400);
  assert.equal(terminal.body.code, 'voice_launch_source_not_chat');

  const internal = await issueLaunch(harness.app, { sourceSessionId: VOICE_ROUTER_ID });
  assert.equal(internal.statusCode, 400);
  assert.equal(internal.body.code, 'voice_launch_source_not_addressable');

  const missing = await issueLaunch(harness.app, { sourceSessionId: 'gone-1' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, 'voice_launch_source_not_found');
});

test('a chat launch defaults to its own session and dies with it', async () => {
  const harness = launchHarness();
  const issued = await issueLaunch(harness.app, { sourceSessionId: 'chat-2' });
  const launchId = launchIdFromUrl(issued.body.launch.url);
  const context = (await resolveLaunch(harness.app, launchId)).body.context;
  assert.equal(context.targetSessionId, 'chat-2');
  assert.equal(context.directoryId, 'dir-2');
  assert.equal(context.commanderSessionId, 'commander-2');

  harness.records.delete('chat-2');
  const orphaned = await resolveLaunch(harness.app, launchId);
  assert.equal(orphaned.statusCode, 404);
  assert.equal(orphaned.body.code, 'voice_launch_source_not_found');
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

  // The route backfills the missing router instead of failing the user, but it
  // still lands on the router — never on the only Fleet that happens to exist.
  const unprovisioned = launchHarness({ provisionRouter: false });
  const backfilled = await issueLaunch(unprovisioned.app, {});
  assert.equal(backfilled.statusCode, 200);
  assert.ok(unprovisioned.records.has(VOICE_ROUTER_ID));
  assert.equal(
    (await resolveLaunch(unprovisioned.app, launchIdFromUrl(backfilled.body.launch.url))).body.context.targetSessionId,
    VOICE_ROUTER_ID,
  );

  // Even with exactly one Fleet in play, a global launch must not "helpfully"
  // pick it: the router session is the only place allowed to decide.
  const records = new Map([
    ['commander-1', { id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Commander' }],
  ]);
  const single = launchHarness({ records, directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/only' }]]) });
  const issued = await issueLaunch(single.app, {});
  const context = (await resolveLaunch(single.app, launchIdFromUrl(issued.body.launch.url))).body.context;
  assert.equal(context.targetSessionId, VOICE_ROUTER_ID);
  assert.notEqual(context.targetSessionId, 'commander-1');
});

test('replacing a Fleet Commander takes effect on the next utterance, with no restart', async () => {
  const harness = launchHarness();
  const issued = await issueLaunch(harness.app, { sourceSessionId: 'chat-1' });
  const launchId = launchIdFromUrl(issued.body.launch.url);
  assert.equal(
    (await resolveLaunch(harness.app, launchId)).body.context.commanderSessionId,
    'commander-1',
  );

  harness.records.delete('commander-1');
  harness.records.set('commander-9', {
    id: 'commander-9', dirId: 'dir-1', type: 'commander', kind: 'chat', label: '新 Commander',
  });

  const after = (await resolveLaunch(harness.app, launchId)).body.context;
  assert.equal(after.commanderSessionId, 'commander-9', 'the ticket is re-resolved, not a snapshot');
  assert.equal(after.launchId, launchId, 'the user does not have to re-launch');
  assert.equal(harness.calls.restart, 0, 'no process restart is involved');
});

test('the global runtime endpoints never leak the loopback child URL', async () => {
  const harness = launchHarness();
  const runtime = await invoke(harness.app, 'GET', '/api/v1/voice-gateway/runtime');
  assert.equal(runtime.body.runtime.state, 'running');
  assert.equal(runtime.body.runtime.url, undefined);
  assert.equal(runtime.headers['Cache-Control'], 'no-store');

  const restarted = await invoke(harness.app, 'POST', '/api/v1/voice-gateway/restart');
  assert.equal(restarted.body.runtime.url, undefined);
  assert.equal(harness.calls.restart, 1);
});

test('legacy per-Fleet runtime endpoints project the one global child', async () => {
  const installer = {
    status: () => ({ state: 'ready', installed: true }),
    startInstall: () => ({ state: 'ready', installed: true }),
    waitForInstall: async () => ({}),
  };
  const projecting = {
    hasGlobalGateway: () => true,
    status: () => { throw new Error('the legacy Fleet slot must not answer once the gateway is global'); },
    statusGlobal: () => ({ scope: 'global', state: 'running', desired: true }),
    restart: async () => { throw new Error('the legacy Fleet child must not be restarted'); },
    restartGlobal: async () => ({ scope: 'global', state: 'running', desired: true }),
    reconcileAll() {},
  };
  const app = createApp();
  createQwenAudioRuntimeRoutes({ installer, supervisor: projecting, log: { error() {} } }).mountRoutes(app);

  const status = await invoke(app, 'GET', '/api/v1/directories/:id/voice-gateway/runtime', {
    params: { id: 'dir-1' },
  });
  assert.equal(status.body.runtime.state, 'running');
  assert.equal(status.body.runtime.projectedFrom, 'global');
  assert.equal(status.body.runtime.requestedDirectoryId, 'dir-1');

  const restarted = await invoke(app, 'POST', '/api/v1/directories/:id/voice-gateway/restart', {
    params: { id: 'dir-1' },
  });
  assert.equal(restarted.body.runtime.projectedFrom, 'global');

  // Before the migration the same routes still answer for the Fleet itself.
  const legacyApp = createApp();
  createQwenAudioRuntimeRoutes({
    installer,
    supervisor: {
      hasGlobalGateway: () => false,
      status: directoryId => ({ directoryId, state: 'stopped', desired: true }),
      restart: async directoryId => ({ directoryId, state: 'running' }),
      reconcileAll() {},
    },
    log: { error() {} },
  }).mountRoutes(legacyApp);
  const legacy = await invoke(legacyApp, 'GET', '/api/v1/directories/:id/voice-gateway/runtime', {
    params: { id: 'dir-1' },
  });
  assert.equal(legacy.body.runtime.directoryId, 'dir-1');
  assert.equal(legacy.body.runtime.projectedFrom, undefined);
});

function gatewayHostFixture() {
  const records = baseRecords();
  records.set(VOICE_ROUTER_ID, {
    id: VOICE_ROUTER_ID, type: 'gateway', kind: 'chat', label: '🎙️ 实时语音 Router', dirId: null,
  });
  const admissions = [];
  const pushes = [];
  const seen = new Set();
  const host = createGatewayHost({
    persistedSessions: records,
    chatSessions: new Map(),
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
      admitDispatch: async spec => {
        admissions.push(spec);
        const duplicate = seen.has(spec.idempotencyKey);
        seen.add(spec.idempotencyKey);
        return { id: 'op-voice-1', status: 'admitted', createdAt: 1, idempotent: duplicate };
      },
      tick: async () => {},
    }),
    getTaskContextHost: () => ({ dispatchSpec: () => ({}) }),
    getCreateSessionRecord: () => async () => { throw new Error('voice dispatch must reuse existing sessions'); },
    appendChatMessage() {},
    chatBroadcast: (sessionId, message) => {
      const text = message?.message?.content?.[0]?.text;
      if (text) pushes.push({ sessionId, text });
    },
    loadChatHistory: () => [],
  });
  return { admissions, host, pushes, records };
}

test('a repeated voice turn admits once and is reported only after admission', async () => {
  const fixture = gatewayHostFixture();
  const marker = '好的\n<<dispatch target="commander-1">检查登录失败的原因并修复</dispatch>>';

  await fixture.host.handleGatewayTurnComplete(marker, VOICE_ROUTER_ID, 'turn-1');
  await fixture.host.handleGatewayTurnComplete(marker, VOICE_ROUTER_ID, 'turn-1');

  assert.deepEqual(
    fixture.admissions.map(spec => spec.idempotencyKey),
    ['voice:__voice_router__:turn-1', 'voice:__voice_router__:turn-1'],
    'a replayed turn reuses its key so the durable runtime can dedupe it',
  );
  assert.equal(new Set(fixture.admissions.map(spec => spec.idempotencyKey)).size, 1);
  assert.equal(fixture.admissions[0].ownerSessionId, VOICE_ROUTER_ID);
  assert.equal(fixture.admissions[0].spec.targetId, 'commander-1');

  assert.ok(fixture.pushes.length >= 2);
  for (const push of fixture.pushes) {
    assert.equal(push.sessionId, VOICE_ROUTER_ID, 'a voice result must never surface in the WeChat gateway');
    assert.doesNotMatch(push.text, /回复「确认」/, 'a live call has nowhere to park a confirmation state');
  }
  assert.match(fixture.pushes[0].text, /已提交给/);

  // A distinct turn is distinct work.
  await fixture.host.handleGatewayTurnComplete(marker, VOICE_ROUTER_ID, 'turn-2');
  assert.equal(new Set(fixture.admissions.map(spec => spec.idempotencyKey)).size, 2);
});

test('the WeChat gateway keeps its confirmation step and its Commander ban', async () => {
  const fixture = gatewayHostFixture();
  await fixture.host.handleGatewayTurnComplete(
    '<<dispatch target="commander-1">派活</dispatch>>',
    fixture.host.GATEWAY_ID,
    'wechat-1',
  );
  assert.equal(fixture.admissions.length, 0, 'WeChat may not address a Commander directly');
  assert.equal(fixture.pushes.at(-1).sessionId, fixture.host.GATEWAY_ID);
  assert.match(fixture.pushes.at(-1).text, /无法分发/);

  await fixture.host.handleGatewayTurnComplete(
    '<<dispatch target="chat-1">派活</dispatch>>',
    fixture.host.GATEWAY_ID,
    'wechat-2',
  );
  assert.equal(fixture.admissions.length, 0, 'WeChat still waits for an explicit 确认');
  assert.match(fixture.pushes.at(-1).text, /回复「确认」执行/);
});

test('the voice router prompt routes by Fleet and asks instead of guessing', () => {
  const fixture = gatewayHostFixture();
  const voice = fixture.host.buildGatewayPrompt('把这个交给一号项目', VOICE_ROUTER_ID);
  assert.match(voice, /实时语音 Router/);
  assert.match(voice, /优先投给目标项目的 Commander/);
  assert.match(voice, /就只用一句话反问，不要自己挑一个 id 投出去/);
  assert.match(voice, /"type":"commander"/, 'the router needs session type to prefer a Commander');
  assert.match(voice, /"dirId":"dir-1"/, 'the router needs the Fleet id to resolve 这个项目');
  assert.equal(voice.includes(VOICE_ROUTER_ID), false, 'system sessions are not dispatch targets');

  const wechat = fixture.host.buildGatewayPrompt('把这个交给一号项目');
  assert.equal(wechat.includes('实时语音 Router'), false, 'the WeChat prompt is untouched');
});

test('the repo-owned frontend prompt carries identity only, never per-call context', () => {
  const prompt = readRepoFile('src/voice/frontend-prompt/PROMPT.md');
  assert.match(prompt, /MultiCC/);
  assert.match(prompt, /spawn_thinking/);
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

  const dashboardHtml = readRepoFile('public/dashboard.html');
  assert.match(dashboardHtml, /voice-global-btn/);
  assert.match(dashboardHtml, /voice-launch-client\.js/);
  assert.match(readRepoFile('public/dashboard.js'), /MultiCCVoiceLaunch/);

  const manage = readRepoFile('public/manage-qwen-audio.js');
  assert.match(manage, /MultiCCVoiceLaunch/);
  assert.match(manage, /\/api\/v1\/voice-gateway/);
  assert.equal(/voice-gateway\/fleets|renderFleets/.test(manage), false, 'the Fleet list is gone');

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
  assert.match(readRepoFile('app/assets/i18n/zh.json'), /"globalVoiceCall"/);
  assert.match(readRepoFile('app/assets/i18n/en.json'), /"globalVoiceCall"/);
});

test('plain microphone dictation is untouched by the realtime voice gateway', () => {
  const composer = readRepoFile('public/chat-composer.js');
  assert.match(composer, /\/ws\/voice/, 'web dictation still streams to /ws/voice');

  const dictation = readRepoFile('app/lib/services/voice_dictation_service.dart');
  assert.match(dictation, /\/ws\/voice/);
  const inputBar = readRepoFile('app/lib/widgets/input_bar.dart');
  assert.match(inputBar, /VoiceDictationService/);
  assert.match(inputBar, /_toggleDictation/);

  // The launch path owns no microphone: dictation and realtime voice stay
  // separate features on separate buttons.
  const client = readRepoFile('public/voice-launch-client.js');
  for (const microphone of ['getUserMedia', 'MediaRecorder', '/ws/voice', 'AudioContext']) {
    assert.equal(client.includes(microphone), false);
    assert.equal(readRepoFile('app/lib/services/voice_launch_service.dart').includes(microphone), false);
  }
});

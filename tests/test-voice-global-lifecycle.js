'use strict';

// Lifecycle tests for the one global realtime-voice gateway: the boot migration
// that folds legacy per-Fleet records into the single global record, and the
// serialized reconcile that never double-spawns while a legacy child exits.
//
// Kept in its own file (not folded into test-voice-global-gateway.js) so it can
// land without touching the acceptance suite that a parallel change owns.

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
const { VOICE_ROUTER_ID } = require('../src/voice-router');
const { createVoiceHost } = require('../src/voice-host');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseRecords() {
  return new Map([
    ['commander-1', { id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Fleet 一 Commander' }],
    ['commander-2', { id: 'commander-2', dirId: 'dir-2', type: 'commander', kind: 'chat', label: 'Fleet 二 Commander' }],
  ]);
}

function baseDirectories() {
  return new Map([
    ['dir-1', { id: 'dir-1', path: '/tmp/fleet-one', label: 'Fleet 一' }],
    ['dir-2', { id: 'dir-2', path: '/tmp/fleet-two', label: 'Fleet 二' }],
  ]);
}

function addLegacyGateway(records, dirId, commanderSessionId, enabled = true) {
  const id = `__voice_gateway__legacy-${dirId}`;
  records.set(id, {
    id,
    dirId,
    type: 'gateway',
    kind: 'voice',
    gatewayKind: 'qwen-audio',
    enabled,
    commanderSessionId,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  return id;
}

function createApp() {
  const routes = new Map();
  const add = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  // The voice host now also mounts the web reverse-proxy with app.use(prefix).
  // These tests do not exercise the proxy, so record it without acting.
  const use = (routePath, handler) => { if (typeof handler === 'undefined') { /* no-op middleware */ } };
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), use };
}

// The host composition under test. Only the ports prepareBoot actually touches
// (records mutate, router provisioning, gateway service) are real; the voice /
// ASR / TTS services are inert stubs so mounting the unrelated routes stays cheap.
function hostHarness(records = baseRecords(), directories = baseDirectories()) {
  const host = createVoiceHost({
    app: createApp(),
    records,
    directories,
    sessionPersistence: { mutate: (_source, operation) => operation(records) },
    runtimeRoot: tempDir('multicc-voice-host-'),
    getBaseUrl: () => 'http://127.0.0.1:3000',
    uploadVoice: (req, res, next) => { if (typeof next === 'function') next(); },
    voice: { cfg: {} },
    asrLocal: { isAvailable: () => false },
    voiceAsr: { providerStatus: () => ({}) },
    ttsService: { providerStatus: () => ({}) },
    readEnvFile: () => ({}),
    writeEnvFile: () => {},
    getAuxQueue: () => ({ push() {} }),
    reportFailure: () => {},
    log: { info() {}, warn() {}, error() {} },
  });
  return { host, records, directories };
}

class FakeChild extends EventEmitter {
  constructor({ holdExit = false } = {}) {
    super();
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.holdExit = holdExit;
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    if (this.holdExit) return; // stay alive until exitNow() — simulates a slow exit
    queueMicrotask(() => this.emit('exit', null, signal));
  }

  exitNow() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    const signal = this.signalCode;
    queueMicrotask(() => this.emit('exit', 0, signal));
  }
}

// A supervisor wired to fake children. Legacy children (their ACP_ARGS carry a
// --directory-id) hold their exit so a test can observe the window in which a
// legacy stop is in flight but not yet done; the global child exits normally.
function supervisorHarness(records) {
  const root = tempDir('multicc-voice-life-');
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
      const isLegacy = String(options.env.ACP_ARGS || '').includes('--directory-id');
      const child = new FakeChild({ holdExit: isLegacy });
      spawns.push({ command, args, options, child });
      return child;
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ voiceConfigured: true, realtimeModel: 'qwen-test', backend: { ok: true, kind: 'acp' } }),
    }),
    healthIntervalMs: 60_000,
    startTimeoutMs: 2000,
    log: { error() {}, warn() {} },
  });
  const globalSpawns = () => spawns.filter(spawn => {
    try { return JSON.parse(spawn.options.env.ACP_ARGS).length === 1; } catch { return false; }
  }).length;
  return { runtime, spawns, supervisor, globalSpawns };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('boot with two enabled legacy records and no global creates one global and spawns exactly one child', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1', true);
  addLegacyGateway(records, 'dir-2', 'commander-2', true);

  const { host } = hostHarness(records);
  const result = host.prepareBoot();

  assert.equal(result.migrated, true);
  assert.equal(result.enabled, true, 'an enabled legacy record migrates its intent');
  const global = records.get(GLOBAL_VOICE_GATEWAY_ID);
  assert.ok(global, 'the global record now exists');
  assert.equal(global.enabled, true);
  assert.ok(records.has(VOICE_ROUTER_ID), 'an enabled migration provisions the voice router');

  const sh = supervisorHarness(records);
  await sh.supervisor.reconcileAll();
  await sh.supervisor.startGlobal();
  assert.equal(sh.globalSpawns(), 1, 'two enabled Fleets collapse to exactly one child');
  assert.equal(sh.supervisor.status('dir-1').desired, false);
  assert.equal(sh.supervisor.status('dir-2').desired, false);
  await sh.supervisor.stopAll();
});

test('boot with only disabled legacy records creates a disabled global and spawns nothing', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1', false);
  addLegacyGateway(records, 'dir-2', 'commander-2', false);

  const { host } = hostHarness(records);
  const result = host.prepareBoot();

  assert.equal(result.migrated, true, 'legacy records still trigger the one-time migration');
  assert.equal(result.enabled, false, 'no enabled legacy means a disabled global');
  assert.equal(records.get(GLOBAL_VOICE_GATEWAY_ID).enabled, false);
  assert.equal(records.has(VOICE_ROUTER_ID), false, 'a disabled global provisions no router');

  const sh = supervisorHarness(records);
  await sh.supervisor.reconcileAll();
  await tick();
  assert.equal(sh.spawns.length, 0, 'a disabled global spawns nothing');
  await sh.supervisor.stopAll();
});

test('boot with an existing global record is idempotent and never mutates it', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1', true);
  createVoiceGatewayService({
    records,
    directories: baseDirectories(),
    mutate: (_source, operation) => operation(records),
  }).ensureGlobal({ enabled: true });
  const before = JSON.parse(JSON.stringify(records.get(GLOBAL_VOICE_GATEWAY_ID)));

  const { host } = hostHarness(records);
  const first = host.prepareBoot();
  const second = host.prepareBoot();

  assert.equal(first.migrated, false);
  assert.equal(first.reason, 'global_exists');
  assert.equal(second.migrated, false);
  assert.deepEqual(records.get(GLOBAL_VOICE_GATEWAY_ID), before, 'the existing global record is untouched');
  assert.ok(records.has(VOICE_ROUTER_ID), 'an enabled global still ensures the router');
});

test('boot with no voice records at all creates nothing', async () => {
  const records = baseRecords();
  const { host } = hostHarness(records);
  const result = host.prepareBoot();

  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'no_legacy');
  assert.equal(result.enabled, false);
  assert.equal(records.has(GLOBAL_VOICE_GATEWAY_ID), false, 'a brand-new install creates no global record');
  assert.equal(records.has(VOICE_ROUTER_ID), false);
});

test('reconcileAll awaits a slow legacy exit before starting the global child', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1', true);
  createVoiceGatewayService({
    records,
    directories: baseDirectories(),
    mutate: (_source, operation) => operation(records),
  }).ensureGlobal({ enabled: true });

  const sh = supervisorHarness(records);
  // Bring up a legacy child the hard way so it is genuinely running pre-migration.
  await sh.supervisor.start('dir-1');
  assert.equal(sh.spawns.length, 1);
  assert.equal(sh.globalSpawns(), 0, 'the only child so far is the legacy one');
  const legacyChild = sh.spawns[0].child;

  const reconciling = sh.supervisor.reconcileAll();
  await tick();
  assert.equal(sh.globalSpawns(), 0, 'global must not spawn while the legacy child is still exiting');

  legacyChild.exitNow();
  await reconciling;
  await sh.supervisor.startGlobal();
  assert.equal(sh.globalSpawns(), 1, 'only after the legacy exit does the global child start');
  await sh.supervisor.stopAll();
});

test('concurrent reconcileAll calls never start more than one global child', async () => {
  const records = baseRecords();
  addLegacyGateway(records, 'dir-1', 'commander-1', true);
  addLegacyGateway(records, 'dir-2', 'commander-2', true);
  createVoiceGatewayService({
    records,
    directories: baseDirectories(),
    mutate: (_source, operation) => operation(records),
  }).ensureGlobal({ enabled: true });

  const sh = supervisorHarness(records);
  const first = sh.supervisor.reconcileAll();
  const second = sh.supervisor.reconcileAll();
  const third = sh.supervisor.reconcileAll();
  await Promise.all([first, second, third]);
  await sh.supervisor.startGlobal();

  assert.equal(sh.globalSpawns(), 1, 'serialized reconcile spawns a single global child');
  await sh.supervisor.stopAll();
});

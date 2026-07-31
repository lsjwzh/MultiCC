'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  INSTALL_SCHEMA_VERSION,
  NODE_ARTIFACTS,
  QWEN_AUDIO_NODE_VERSION,
  QWEN_AUDIO_PACKAGE,
  QWEN_AUDIO_PACKAGE_INTEGRITY,
  QWEN_AUDIO_PACKAGE_VERSION,
  createQwenAudioInstaller,
  downloadWithRetry,
  platformKey,
  safeChildEnv,
} = require('../src/qwen-audio-installer');
const {
  createQwenAudioSupervisor,
  fleetRuntimeKey,
  redactLogLine,
} = require('../src/qwen-audio-supervisor');
const { createQwenAudioRuntimeRoutes } = require('../src/routes/qwen-audio-runtime');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedInstalledRuntime(runtimeRoot, platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  const artifact = NODE_ARTIFACTS[key];
  assert.ok(artifact, `test platform ${key} has a pinned Node artifact`);
  const directory = `qwen-${QWEN_AUDIO_PACKAGE_VERSION}-node-${QWEN_AUDIO_NODE_VERSION}-${key}`;
  const base = path.join(runtimeRoot, 'versions', directory);
  const nodePath = path.join(base, 'node', 'bin', 'node');
  const packageRoot = path.join(base, 'app', 'node_modules', QWEN_AUDIO_PACKAGE);
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(packageRoot, 'cli', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: QWEN_AUDIO_PACKAGE,
    version: QWEN_AUDIO_PACKAGE_VERSION,
  }));
  fs.writeFileSync(path.join(packageRoot, 'cli', 'bin', 'qwenaudio.mjs'), '');
  fs.writeFileSync(path.join(packageRoot, 'server', 'src', 'index.mjs'), '');
  fs.writeFileSync(path.join(runtimeRoot, 'active.json'), JSON.stringify({
    schemaVersion: INSTALL_SCHEMA_VERSION,
    directory,
    package: {
      name: QWEN_AUDIO_PACKAGE,
      version: QWEN_AUDIO_PACKAGE_VERSION,
      integrity: QWEN_AUDIO_PACKAGE_INTEGRITY,
    },
    node: { version: QWEN_AUDIO_NODE_VERSION, sha256: artifact.sha256 },
    installedAt: '2026-07-31T00:00:00.000Z',
  }));
  return { base, nodePath, packageRoot };
}

test('installer resolves only the pinned, integrity-recorded private runtime', () => {
  const root = tempDir('multicc-qwen-installer-');
  const seeded = seedInstalledRuntime(root);
  const installer = createQwenAudioInstaller({ runtimeRoot: root, log: { error() {} } });
  assert.deepEqual(installer.status(), {
    state: 'ready',
    installed: true,
    supported: true,
    platform: platformKey(),
    package: { name: QWEN_AUDIO_PACKAGE, version: QWEN_AUDIO_PACKAGE_VERSION },
    node: { version: QWEN_AUDIO_NODE_VERSION, managed: true },
    progress: null,
    lastError: null,
  });
  assert.equal(installer.resolveInstalled().nodePath, seeded.nodePath);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
  manifest.package.integrity = 'sha512-wrong';
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify(manifest));
  assert.equal(installer.resolveInstalled(), null, 'a stale or tampered manifest fails closed');
});

test('installer reports unsupported platforms without downloading or leaving a lock', async () => {
  const root = tempDir('multicc-qwen-unsupported-');
  let fetched = false;
  const installer = createQwenAudioInstaller({
    runtimeRoot: root,
    platform: 'win32',
    arch: 'x64',
    fetchImpl: async () => { fetched = true; },
    log: { error() {} },
  });
  await assert.rejects(installer.install(), error => error.code === 'platform_unsupported');
  assert.equal(fetched, false);
  assert.equal(fs.existsSync(path.join(root, '.install.lock')), false);
  assert.deepEqual(installer.status().lastError, {
    code: 'platform_unsupported',
    message: '当前平台暂不支持自动安装 Qwen Audio Runtime',
  });
});

test('installer never steals an old lock from a still-live process', async () => {
  const root = tempDir('multicc-qwen-live-lock-');
  const lock = path.join(root, '.install.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 'old' }), { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let fetched = false;
  const installer = createQwenAudioInstaller({
    runtimeRoot: root,
    fetchImpl: async () => { fetched = true; },
    log: { error() {} },
  });
  await assert.rejects(installer.install(), error => error.code === 'install_locked');
  assert.equal(fetched, false);
  assert.equal(fs.existsSync(lock), true);
});

test('package installer uses an isolated home and the official npm registry', () => {
  const env = safeChildEnv('/private/node/bin/node', '/private/qwen/npm-cache');
  assert.equal(env.HOME, '/private/qwen/npm-cache');
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
});

test('runtime download retries transient failures and removes partial files', async () => {
  const root = tempDir('multicc-qwen-download-retry-');
  const target = path.join(root, 'runtime.tar.gz');
  let attempts = 0;
  const bytes = Buffer.from('verified-download');
  const fetchImpl = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary network failure');
    return new Response(bytes, { status: 200 });
  };
  await downloadWithRetry('https://nodejs.org/runtime.tar.gz', target, {
    fetchImpl,
    attempts: 2,
    retryDelayMs: 1,
    sleep: async () => {},
    maxBytes: 1024,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

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

function gatewayRecords() {
  return new Map([
    ['commander-1', {
      id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Commander',
    }],
    ['gateway-1', {
      id: 'gateway-1', dirId: 'dir-1', type: 'gateway', kind: 'voice',
      gatewayKind: 'qwen-audio', enabled: true, commanderSessionId: 'commander-1',
    }],
  ]);
}

test('supervisor starts one isolated Fleet process and injects only the voice credential', async () => {
  const root = tempDir('multicc-qwen-supervisor-');
  const packageRoot = path.join(root, 'package');
  const runtime = {
    nodePath: '/private/runtime/node',
    packageRoot,
    serverEntry: path.join(packageRoot, 'server', 'src', 'index.mjs'),
    fleetConfigRoot: path.join(root, 'fleets'),
  };
  fs.mkdirSync(path.dirname(runtime.serverEntry), { recursive: true });
  fs.writeFileSync(runtime.serverEntry, '');
  const installer = {
    resolveInstalled: () => runtime,
    status: () => ({ installed: true, package: { version: QWEN_AUDIO_PACKAGE_VERSION } }),
  };
  let spawnSpec;
  const child = new FakeChild();
  const supervisor = createQwenAudioSupervisor({
    records: gatewayRecords(),
    directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/fleet-one' }]]),
    installer,
    getConfig: () => ({
      apiKey: 'dashscope-secret',
      model: 'qwen-audio-3.0-realtime-plus',
      voice: 'longanqian',
    }),
    getBaseUrl: () => 'http://127.0.0.1:3000',
    acpAgentPath: '/opt/multicc/multicc-acp-agent.mjs',
    spawnImpl(command, args, options) {
      spawnSpec = { command, args, options };
      return child;
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        voiceConfigured: true,
        realtimeModel: 'qwen-audio-3.0-realtime-plus',
        backend: { ok: true, kind: 'acp' },
      }),
    }),
    healthIntervalMs: 60000,
    startTimeoutMs: 1000,
  });

  const started = await supervisor.start('dir-1');
  assert.equal(started.state, 'running');
  assert.equal(spawnSpec.command, runtime.nodePath);
  assert.deepEqual(spawnSpec.args, [runtime.serverEntry]);
  assert.equal(spawnSpec.options.env.QWEN_AUDIO_REALTIME_API_KEY, 'dashscope-secret');
  assert.equal(spawnSpec.options.env.AGENT_PROTOCOL, 'acp');
  assert.equal(spawnSpec.options.env.ACP_COMMAND, runtime.nodePath);
  assert.deepEqual(JSON.parse(spawnSpec.options.env.ACP_ARGS), [
    '/opt/multicc/multicc-acp-agent.mjs', '--directory-id', 'dir-1',
  ]);
  assert.equal(spawnSpec.options.env.ACP_WORKSPACE, '/tmp/fleet-one');
  assert.equal(spawnSpec.options.env.MULTICC_BASE_URL, 'http://127.0.0.1:3000');
  assert.equal(spawnSpec.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(spawnSpec.options.env.OPENAI_API_KEY, undefined);
  assert.equal(path.basename(spawnSpec.options.env.QWAUDIO_CONFIG_DIR), fleetRuntimeKey('dir-1'));
  assert.doesNotMatch(JSON.stringify(started), /dashscope-secret|ACP_ARGS|private\/runtime/);

  await supervisor.stopAll();
  assert.equal(supervisor.status('dir-1').state, 'stopped');
});

test('supervisor fails closed before spawn when the DashScope key is missing', async () => {
  let spawned = false;
  const supervisor = createQwenAudioSupervisor({
    records: gatewayRecords(),
    directories: new Map([['dir-1', { id: 'dir-1', path: '/tmp/fleet-one' }]]),
    installer: {
      resolveInstalled: () => ({ nodePath: '/node', packageRoot: '/pkg', serverEntry: '/pkg/server.mjs', fleetConfigRoot: '/tmp/fleets' }),
      status: () => ({ installed: true, package: { version: QWEN_AUDIO_PACKAGE_VERSION } }),
    },
    getConfig: () => ({ apiKey: '' }),
    getBaseUrl: () => 'http://127.0.0.1:3000',
    acpAgentPath: '/opt/multicc/multicc-acp-agent.mjs',
    spawnImpl: () => { spawned = true; },
  });
  const result = await supervisor.start('dir-1');
  assert.equal(spawned, false);
  assert.equal(result.state, 'qwen_api_key_missing');
  assert.deepEqual(result.lastError, {
    code: 'qwen_api_key_missing',
    message: '尚未配置 Qwen Audio 的 DashScope API Key',
  });
});

test('runtime log redaction removes injected credentials and bearer tokens', () => {
  const line = redactLogLine(
    'failed key=dashscope-secret Authorization: Bearer abcdefghijklmnop',
    ['dashscope-secret'],
  );
  assert.equal(line.includes('dashscope-secret'), false);
  assert.equal(line.includes('abcdefghijklmnop'), false);
});

function createApp() {
  const routes = new Map();
  const add = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return { routes, get: add('GET'), post: add('POST') };
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

test('runtime routes expose path-free status and start one asynchronous install', async () => {
  let installs = 0;
  let reconciles = 0;
  const installer = {
    status: () => ({ state: installs ? 'installing' : 'not_installed', installed: false }),
    startInstall() { installs++; return { state: 'installing', installed: false }; },
    waitForInstall: async () => ({}),
  };
  const supervisor = {
    status: directoryId => ({ directoryId, state: 'stopped', desired: true }),
    reconcileAll() { reconciles++; },
    restart: async directoryId => ({ directoryId, state: 'running' }),
  };
  const app = createApp();
  createQwenAudioRuntimeRoutes({ installer, supervisor, log: { error() {} } }).mountRoutes(app);

  let res = await invoke(app, 'POST', '/api/v1/voice-runtime/install', {
    id: 'req-qwen', correlationId: 'corr-qwen',
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.apiVersion, 'v1');
  assert.equal(res.body.runtime.state, 'installing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installs, 1);
  assert.equal(reconciles, 1);

  res = await invoke(app, 'GET', '/api/v1/directories/:id/voice-gateway/runtime', {
    params: { id: 'dir-1' }, id: 'req-qwen', correlationId: 'corr-qwen',
  });
  assert.equal(res.body.runtime.directoryId, 'dir-1');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

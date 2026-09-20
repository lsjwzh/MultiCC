'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createOfficialImageBridge } = require('../src/codex/image-bridge');

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-image-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function authFile(root) {
  const file = path.join(root, 'auth.json');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: `x.${payload}.y`, account_id: 'acct' } }));
  fs.chmodSync(file, 0o600);
  return file;
}

function officialProvider() {
  return { id: 'official', appType: 'codex', settingsConfig: { auth: { auth_mode: 'chatgpt' } } };
}

function successfulSpawn(captured) {
  return (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    const child = new EventEmitter();
    child.stdout = { resume() {} };
    child.stderr = { resume() {} };
    child.kill = () => {};
    queueMicrotask(() => {
      const output = path.join(options.env.CODEX_HOME, 'generated_images', 'thread');
      fs.mkdirSync(output, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(output, 'native.png'), PNG);
      child.emit('close', 0, null);
    });
    return child;
  };
}

test('official image bridge runs a private native worker and returns only an artifact reference', async t => {
  const root = temp(t);
  const workspace = path.join(root, 'workspace');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(workspace);
  const reference = path.join(workspace, 'reference.png');
  fs.writeFileSync(reference, PNG);
  const captured = {};
  const registry = [];
  const bridge = createOfficialImageBridge({
    artifactsDir: artifacts,
    tempRoot: path.join(root, 'runs'),
    resolveSessionCwd: () => workspace,
    getProvider: () => officialProvider(),
    resolveAuthFile: () => authFile(root),
    registerArtifact: entry => registry.push(entry),
    codexCommand: '/opt/test-codex',
    spawnImpl: successfulSpawn(captured),
    environment: {
      PATH: '/usr/bin', HOME: '/must-not-be-used', OPENAI_API_KEY: 'must-not-leak',
      MULTICC_ROUTER_CAPABILITY: 'must-not-leak', CODEX_HOME: '/must-not-be-used',
    },
  });
  const result = await bridge.generate({
    context: { sessionId: 'session-1', taskId: 'task-1' },
    session: { id: 'session-1', cli: 'codex', provider: 'official' },
    prompt: 'a blue circle on white',
    referenceImagePaths: [reference],
  });

  assert.equal(result.ok, true);
  assert.match(result.artifact.url, /^\/artifacts\/image_[A-Za-z0-9_-]+\/image\.png$/);
  const artifactPath = path.join(artifacts, result.artifact.id, 'image.png');
  assert.equal(fs.existsSync(artifactPath), true);
  assert.equal(fs.statSync(artifactPath).mode & 0o777, 0o600);
  assert.equal('path' in result.artifact, false, 'the child gets a safe artifact URL, not a host filesystem path');
  assert.deepEqual(registry, [{
    kind: 'file', title: 'Generated image', url: result.artifact.url,
    sessionId: 'session-1', taskId: 'task-1', source: 'image-bridge',
  }]);
  assert.equal(captured.command, '/opt/test-codex');
  assert.ok(captured.args.includes('--ignore-user-config'));
  assert.ok(captured.args.includes('image_generation'));
  assert.equal(captured.args.includes(reference), false, 'the native worker receives a private copied reference');
  assert.equal(captured.options.env.OPENAI_API_KEY, undefined);
  assert.equal(captured.options.env.MULTICC_ROUTER_CAPABILITY, undefined);
  assert.equal(captured.options.env.HOME.startsWith(path.join(root, 'runs')), true);
  assert.equal(fs.existsSync(captured.options.env.CODEX_HOME), false, 'private auth home is removed after completion');
  assert.equal(fs.existsSync(path.join(root, 'runs')) && fs.readdirSync(path.join(root, 'runs')).length, 0);
});

test('bridge refuses non-official sessions and workspace escapes before a worker can start', async t => {
  const root = temp(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  let started = 0;
  const bridge = createOfficialImageBridge({
    artifactsDir: path.join(root, 'artifacts'), tempRoot: path.join(root, 'runs'),
    resolveSessionCwd: () => workspace,
    getProvider: () => ({ id: 'key-provider', appType: 'codex', settingsConfig: { auth: { OPENAI_API_KEY: 'x' } } }),
    resolveAuthFile: () => authFile(root),
    spawnImpl: () => { started += 1; throw new Error('must not spawn'); },
  });
  await assert.rejects(
    bridge.generate({ context: { sessionId: 's' }, session: { cli: 'codex', provider: 'key-provider' }, prompt: 'x' }),
    error => error.code === 'image_generation_unavailable',
  );
  assert.equal(started, 0);
});

test('bridge is available to a non-Codex chat through a host-owned direct official login', async t => {
  const root = temp(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const captured = {};
  const directAuth = authFile(root);
  const bridge = createOfficialImageBridge({
    artifactsDir: path.join(root, 'artifacts'), tempRoot: path.join(root, 'runs'),
    resolveSessionCwd: () => workspace,
    getProvider: () => null,
    resolveAuthFile: () => null,
    fallbackAuthFiles: () => [directAuth],
    spawnImpl: successfulSpawn(captured),
  });
  const session = { id: 'claude-chat', cli: 'claude', provider: 'claude-official' };
  assert.equal(bridge.isEligible(session), true);
  const result = await bridge.generate({
    context: { sessionId: 'claude-chat' }, session, prompt: 'a bright blue orb', referenceImagePaths: [],
  });
  assert.equal(result.ok, true);
  assert.equal(captured.options.env.CODEX_HOME.includes('codex-home'), true);
});

test('bridge removes its copied auth material when the native worker fails', async t => {
  const root = temp(t);
  const bridge = createOfficialImageBridge({
    artifactsDir: path.join(root, 'artifacts'), tempRoot: path.join(root, 'runs'),
    resolveSessionCwd: () => root,
    getProvider: () => officialProvider(), resolveAuthFile: () => authFile(root),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = { resume() {} }; child.stderr = { resume() {} }; child.kill = () => {};
      queueMicrotask(() => child.emit('close', 1, null));
      return child;
    },
  });
  await assert.rejects(
    bridge.generate({ context: { sessionId: 's' }, session: { cli: 'codex', provider: 'official' }, prompt: 'x' }),
    error => error.code === 'image_generation_failed',
  );
  assert.deepEqual(fs.existsSync(path.join(root, 'runs')) ? fs.readdirSync(path.join(root, 'runs')) : [], []);
});

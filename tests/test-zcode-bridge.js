'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');
const { ensureCliStates } = require('../src/cli-switch');
const { captureNativeSessionId } = require('../src/chat/native-session-state');

const BRIDGE = path.join(__dirname, '..', 'src', 'cli-adapters', 'zcode-bridge.cjs');
const TERMINAL_BRIDGE = path.join(__dirname, '..', 'src', 'cli-adapters', 'zcode-terminal.cjs');

function writeFakeEngine(root, captureEnv = 'ZCODE_TEST_CAPTURE') {
  const engine = path.join(root, 'fake-zcode.cjs');
  const capture = path.join(root, 'capture.json');
  fs.writeFileSync(engine, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `fs.writeFileSync(process.env.${captureEnv}, JSON.stringify({ args, hasBigModelKey: !!process.env.BIGMODEL_API_KEY, hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY }));`,
    "process.stdout.write(JSON.stringify({ sessionId: 'sess_fake', response: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }));",
  ].join('\n'));
  return { engine, capture };
}

function writeVendorConfig(root, model) {
  const settings = path.join(root, 'vendor-config.json');
  fs.writeFileSync(settings, JSON.stringify({
    model,
    provider: {
      bigmodel: {
        kind: 'anthropic',
        options: { baseURL: 'https://vendor.invalid/api/anthropic' },
        models: { 'glm-5.2': { id: 'glm-5.2' } },
      },
    },
  }));
  return settings;
}

test('bridge passes the turn straight to the vendor default config when the model matches', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-bridge-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const settings = writeVendorConfig(root, 'bigmodel/glm-5.2');

  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_SETTINGS: settings, ZCODE_TEST_CAPTURE: capture };
  delete env.BIGMODEL_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const result = spawnSync(process.execPath, [
    BRIDGE, '--session', 'sess_old', '--model', 'bigmodel/glm-5.2', 'hello',
  ], { encoding: 'utf8', env });

  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].sessionID, 'sess_fake');
  assert.equal(events.at(-1).type, 'step_finish');
  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  // 引擎 0.15.2 拒绝 --settings：model 一致时绝不能传，直接吃默认配置
  assert.equal(observed.args.includes('--settings'), false);
  assert.equal(observed.args.includes('--resume'), true);
  assert.equal(observed.hasBigModelKey, false);
  assert.equal(observed.hasAnthropicKey, false);
});

test('bridge fails loudly on a model mismatch instead of silently using the vendor model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-mismatch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const settings = writeVendorConfig(root, 'bigmodel/glm-5.2');

  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_SETTINGS: settings, ZCODE_TEST_CAPTURE: capture };
  const result = spawnSync(process.execPath, [
    BRIDGE, '--model', 'bigmodel/glm-5-turbo', 'hello',
  ], { encoding: 'utf8', env });

  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].sessionID, undefined, 'configuration errors must not allocate native history');
  assert.match(events[0].error.message, /不支持 model 覆盖/);
  assert.match(events[0].error.message, /glm-5-turbo/);
  assert.equal(fs.existsSync(capture), false, 'engine must not be spawned on a model mismatch');
});

test('bridge tolerates an unreadable vendor config and lets the engine report natively', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-noconfig-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const missing = path.join(root, 'does-not-exist.json');

  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_SETTINGS: missing, ZCODE_TEST_CAPTURE: capture };
  const result = spawnSync(process.execPath, [
    BRIDGE, '--model', 'bigmodel/glm-5.2', 'hello',
  ], { encoding: 'utf8', env });

  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'step_finish');
  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(observed.args.includes('--settings'), false);
});

test('ZCode bridge runs with vendor defaults and no MultiCC provider key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-default-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_TEST_CAPTURE: capture };
  delete env.BIGMODEL_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const result = spawnSync(process.execPath, [BRIDGE, 'hello'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).args.includes('--settings'), false);
});

test('ZCode terminal launcher skips the override when the persisted model matches', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-terminal-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const settings = writeVendorConfig(root, 'bigmodel/glm-5.2');

  const result = spawnSync(process.execPath, [
    TERMINAL_BRIDGE,
    '--engine', engine,
    '--model', 'bigmodel/glm-5.2',
    '--resume', 'sess_terminal',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZCODE_SETTINGS: settings, ZCODE_TEST_CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(observed.args[0], 'tui');
  assert.equal(observed.args.includes('--resume'), true);
  assert.equal(observed.args.includes('--settings'), false);
});

test('ZCode terminal launcher refuses a mismatched model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-terminal-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const settings = writeVendorConfig(root, 'bigmodel/glm-5.2');

  const result = spawnSync(process.execPath, [
    TERMINAL_BRIDGE,
    '--engine', engine,
    '--model', 'bigmodel/glm-5-turbo',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ZCODE_SETTINGS: settings, ZCODE_TEST_CAPTURE: capture },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不支持 model 覆盖/);
  assert.equal(fs.existsSync(capture), false, 'TUI must not launch on a model mismatch');
});

// 守护：bridge 是被 multicc 直接 exec 的（spawn(command)，靠 shebang），丢了
// 执行位就是 spawn EACCES（exit -13），每次 turn 秒挂。2026-07-25 实测事故。
test('bridge scripts keep their executable bit (multicc spawns them directly)', t => {
  if (process.platform === 'win32') return t.skip('exec bit is meaningless on Windows');
  for (const file of [BRIDGE, TERMINAL_BRIDGE]) {
    const mode = fs.statSync(file).mode;
    assert.notEqual(mode & 0o111, 0, `${path.basename(file)} lost its executable bit`);
  }
});

test('ZCode errors never become native session identities or mask the original failure', () => {
  const adapter = createZcodeAdapter();
  for (const id of ['zcode-settings', 'zcode-err', 'zcode-no-engine', 'zcode-parse', 'sess_existing']) {
    const record = { cli: 'zcode', cliSessionId: 'sess_existing' };
    const events = adapter.decodeEvent({ type: 'error', sessionID: id, error: { code: 'model_mismatch', message: 'model mismatch' } });
    for (const event of events) if (event.type === 'session_started') captureNativeSessionId(record, event.sessionId, { fresh: true });
    assert.equal(record.cliSessionId, 'sess_existing');
    assert.deepEqual(events.map(e => e.type), ['error']);
    assert.equal(events[0].error.code, 'model_mismatch');
  }
});

test('legacy ZCode error markers are repaired on state hydration; genuine IDs stay protected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { engine, capture } = writeFakeEngine(root);
  const record = { kind: 'chat', cli: 'zcode', cliSessionId: 'zcode-settings',
    cliStates: { zcode: { cliSessionId: 'zcode-settings', streamSessionId: null }, codex: { cliSessionId: 'thread-preserved' } } };
  assert.equal(ensureCliStates(record), true);
  assert.equal(record.cliSessionId, null);
  assert.equal(record.cliStates.zcode.cliSessionId, null);
  assert.equal(record.cliStates.codex.cliSessionId, 'thread-preserved');
  assert.equal(ensureCliStates(record), false, 'migration is idempotent');
  const adapter = createZcodeAdapter();
  const invocation = adapter.buildInvocation({ historyHandle: { isFirstTurn: !record.cliSessionId, cliSessionId: record.cliSessionId },
    spawnOpts: {}, contextLayers: [], userText: 'hello', suffix: '', rolePrompt: 'role evidence' });
  assert.match(invocation.payload, /role evidence/);
  const result = spawnSync(process.execPath, [invocation.cmd, ...invocation.args, invocation.payload], {
    encoding: 'utf8', env: { ...process.env, ZCODE_ENGINE: engine, ZCODE_TEST_CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const raw of result.stdout.trim().split('\n').map(JSON.parse)) {
    for (const event of adapter.decodeEvent(raw)) if (event.type === 'session_started') {
      assert.notEqual(captureNativeSessionId(record, event.sessionId, { fresh: false }).mismatch, true);
    }
  }
  assert.equal(record.cliSessionId, 'sess_fake');
  assert.equal(JSON.parse(fs.readFileSync(capture)).args.includes('--resume'), false);
  assert.equal(captureNativeSessionId(record, 'sess_other', { fresh: false }).mismatch, true);
  assert.equal(record.cliSessionId, 'sess_fake', 'real resume mismatch guard remains intact');
});

test('ZCode migration repairs inactive snapshots and only known bridge markers', () => {
  for (const marker of ['zcode-err', 'zcode-no-engine', 'zcode-parse', 'zcode-1788653210000']) {
    const record = { kind: 'chat', cli: 'codex', cliSessionId: 'thread-original', cliStates: { zcode: { cliSessionId: marker } } };
    ensureCliStates(record);
    assert.equal(record.cliSessionId, 'thread-original');
    assert.equal(record.cliStates.zcode.cliSessionId, null);
  }
  for (const native of ['sess_original', 'future-native-format']) {
    const record = { kind: 'chat', cli: 'zcode', cliSessionId: native };
    ensureCliStates(record);
    assert.equal(record.cliSessionId, native, 'do not discard unknown identities based on a broad prefix heuristic');
  }
});

test('successful engine output without a real session ID fails instead of inventing one', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine.cjs');
  fs.writeFileSync(engine, 'console.log(JSON.stringify({response:"unattributed reply"}))');
  const result = spawnSync(process.execPath, [BRIDGE, 'hello'], { encoding: 'utf8', env: { ...process.env, ZCODE_ENGINE: engine } });
  assert.equal(result.status, 0);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.type), ['error']);
  assert.equal(events[0].sessionID, undefined);
  assert.equal(events[0].error.code, 'zcode_invalid_session_id');
});

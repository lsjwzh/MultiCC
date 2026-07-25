'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

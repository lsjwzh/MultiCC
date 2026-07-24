'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'src', 'cli-adapters', 'zcode-bridge.cjs');
const TERMINAL_BRIDGE = path.join(__dirname, '..', 'src', 'cli-adapters', 'zcode-terminal.cjs');

test('ZCode bridge delegates auth to the vendor and overrides only the selected model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-bridge-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'fake-zcode.cjs');
  const settings = path.join(root, 'vendor-config.json');
  const capture = path.join(root, 'capture.json');
  fs.writeFileSync(settings, JSON.stringify({
    model: 'bigmodel/vendor-default',
    provider: {
      bigmodel: {
        kind: 'anthropic',
        options: { baseURL: 'https://vendor.invalid/api/anthropic' },
        models: { 'glm-5.2': { id: 'glm-5.2' } },
      },
    },
  }));
  fs.writeFileSync(engine, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const at = args.indexOf('--settings');",
    "const config = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : null;",
    "fs.writeFileSync(process.env.ZCODE_TEST_CAPTURE, JSON.stringify({ args, config, hasBigModelKey: !!process.env.BIGMODEL_API_KEY, hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY }));",
    "process.stdout.write(JSON.stringify({ sessionId: 'sess_vendor', response: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }));",
  ].join('\n'));

  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_SETTINGS: settings, ZCODE_TEST_CAPTURE: capture };
  delete env.BIGMODEL_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const result = spawnSync(process.execPath, [
    BRIDGE, '--session', 'sess_old', '--model', 'bigmodel/glm-5.2', 'hello',
  ], { encoding: 'utf8', env });

  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].sessionID, 'sess_vendor');
  assert.equal(events.at(-1).type, 'step_finish');
  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(observed.config.model, 'bigmodel/glm-5.2');
  assert.deepEqual(observed.config.provider, JSON.parse(fs.readFileSync(settings, 'utf8')).provider);
  assert.equal(observed.args.includes('--resume'), true);
  assert.equal(observed.hasBigModelKey, false);
  assert.equal(observed.hasAnthropicKey, false);
  const tempSettings = observed.args[observed.args.indexOf('--settings') + 1];
  assert.equal(fs.existsSync(tempSettings), false, 'temporary settings are removed after the engine exits');
});

test('ZCode bridge runs with vendor defaults and no MultiCC provider key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-default-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'fake-zcode.cjs');
  const capture = path.join(root, 'args.json');
  fs.writeFileSync(engine, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.ZCODE_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ sessionId: 'sess_default', response: 'ok' }));",
  ].join('\n'));
  const env = { ...process.env, ZCODE_ENGINE: engine, ZCODE_TEST_CAPTURE: capture };
  delete env.BIGMODEL_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const result = spawnSync(process.execPath, [BRIDGE, 'hello'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(capture, 'utf8')).includes('--settings'), false);
});

test('ZCode terminal launcher applies the persisted model and cleans up its settings copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-terminal-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'fake-zcode.cjs');
  const settings = path.join(root, 'vendor-config.json');
  const capture = path.join(root, 'capture.json');
  fs.writeFileSync(settings, JSON.stringify({
    model: 'bigmodel/vendor-default',
    provider: { bigmodel: { kind: 'anthropic', models: { 'glm-5.2': { id: 'glm-5.2' } } } },
  }));
  fs.writeFileSync(engine, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const at = args.indexOf('--settings');",
    "const config = JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));",
    "fs.writeFileSync(process.env.ZCODE_TEST_CAPTURE, JSON.stringify({ args, config, settings: args[at + 1] }));",
  ].join('\n'));
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
  assert.equal(observed.config.model, 'bigmodel/glm-5.2');
  assert.deepEqual(observed.config.provider, JSON.parse(fs.readFileSync(settings, 'utf8')).provider);
  assert.equal(fs.existsSync(observed.settings), false);
});

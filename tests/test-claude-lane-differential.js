'use strict';

// Differential test: the frozen JavaScript SDK is the oracle. Both transports
// drive the *same* fake CLI, so argv, the stdin JSONL sequence and the
// delivered message sequence must be identical (modulo generated ids).
//
// The SDK is loaded from node_modules as a read-only oracle; the production
// code never imports it. When node_modules (or the SDK) is absent the test is
// skipped rather than failed.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const FAKE = path.join(__dirname, 'helpers', 'fake-claude-lane.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findSdk() {
  if (process.env.MULTICC_SDK_ORACLE) return process.env.MULTICC_SDK_ORACLE;
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SDK_PATH = findSdk();

function readLedger(file) {
  const rows = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return {
    spawn: rows.find(row => row.__fake === 'spawn') || null,
    stdin: rows.filter(row => row.__fake !== 'spawn'),
  };
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'request_id') out[key] = '<request_id>';
    else if (key === 'uuid') out[key] = '<uuid>';
    else out[key] = scrub(inner);
  }
  return out;
}

function normalizeArgv(argv, settingsPath) {
  return argv.map(arg => (arg === settingsPath || /settings\.json$/.test(arg) ? '<settings>' : arg));
}

async function runSdk({ root, env, sessionId, settingsPath }) {
  const { query } = await import(pathToFileURL(SDK_PATH).href);
  async function* prompt() {
    yield {
      type: 'user', session_id: sessionId, uuid: 'differential-uuid', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'DIFFERENTIAL' }] },
    };
  }
  const messages = [];
  const stream = query({
    prompt: prompt(),
    options: {
      cwd: root,
      env,
      settings: settingsPath,
      pathToClaudeCodeExecutable: FAKE,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'fake-model',
      sessionId,
    },
  });
  for await (const message of stream) messages.push(message);
  return messages;
}

async function runNative({ root, env, sessionId, settingsPath, binary, binaryArgs }) {
  const { getNative } = require('../src/native/runtime');
  const messages = [];
  let resultSeen = null;
  const lane = new (getNative().RustClaudeLane)((payload) => {
    const [kind, a] = Array.isArray(payload) ? payload : [payload];
    if (kind !== 'message') return;
    const message = JSON.parse(a);
    messages.push(message);
    if (message.type === 'result') resultSeen();
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native lane produced no result')), 20000);
    resultSeen = () => { clearTimeout(timer); resolve(); };
  });
  await lane.start(JSON.stringify({
    cwd: root, env, settings: {}, settingsPath,
    includePartialMessages: true, permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true, hookCallback: false,
    sessionId, model: 'fake-model', binary, binaryArgs,
  }));
  await lane.sendUser(JSON.stringify({
    type: 'user', session_id: sessionId, uuid: 'differential-uuid', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'DIFFERENTIAL' }] },
  }));
  await result;
  lane.closeInput();
  const deadline = Date.now() + 10000;
  while (lane.alive && Date.now() < deadline) await sleep(20);
  lane.kill('SIGTERM');
  return messages;
}

test('native lane is byte-identical to the frozen SDK transport', { timeout: 90000, skip: !SDK_PATH && 'claude-agent-sdk oracle not installed' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lane-diff-'));
  const sessionId = randomUUID();
  const sdkSettings = path.join(root, 'oracle-settings.json');
  fs.writeFileSync(sdkSettings, JSON.stringify({}));
  const oracleLog = path.join(root, 'oracle.jsonl');
  const nativeLog = path.join(root, 'native.jsonl');
  const nativeSettingsDir = path.join(root, 'native-settings');
  fs.mkdirSync(nativeSettingsDir);
  const nativeSettings = path.join(nativeSettingsDir, 'settings.json');
  // The old MultiCC path added these before handing the env to the SDK
  // (`processOptions`); the native kernel still owns them, so they are part of
  // the comparison inputs rather than a difference.
  const baseEnv = {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    FAKE_CLAUDE_SCENARIO: 'basic',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'multicc-claude-exp/1.0',
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
  };
  t.after(() => {
    for (const file of [oracleLog, nativeLog]) {
      const spawn = readLedger(file).spawn;
      if (spawn) { try { process.kill(spawn.pid, 'SIGKILL'); } catch (_) { /* exited */ } }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sdkMessages = await runSdk({
    root, env: { ...baseEnv, FAKE_CLAUDE_LOG: oracleLog }, sessionId, settingsPath: sdkSettings,
  });
  const nativeMessages = await runNative({
    root, env: { ...baseEnv, FAKE_CLAUDE_LOG: nativeLog }, sessionId,
    settingsPath: nativeSettings, binary: process.execPath, binaryArgs: [FAKE],
  });

  const oracle = readLedger(oracleLog);
  const native = readLedger(nativeLog);
  assert.ok(oracle.spawn, 'oracle child spawned');
  assert.ok(native.spawn, 'native child spawned');

  assert.deepEqual(normalizeArgv(native.spawn.argv, nativeSettings),
    normalizeArgv(oracle.spawn.argv, sdkSettings), 'argv');

  const oracleEnv = { ...oracle.spawn.env, FAKE_CLAUDE_LOG: '<log>' };
  const nativeEnv = { ...native.spawn.env, FAKE_CLAUDE_LOG: '<log>' };
  assert.deepEqual(nativeEnv, oracleEnv, 'child environment');

  assert.deepEqual(native.stdin.map(scrub), oracle.stdin.map(scrub), 'stdin JSONL sequence');
  assert.deepEqual(nativeMessages.map(scrub), sdkMessages.map(scrub), 'delivered message sequence');
});

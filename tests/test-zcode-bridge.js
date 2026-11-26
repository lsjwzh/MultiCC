'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');
const { ensureCliStates } = require('../src/cli-switch');
const { captureNativeSessionId } = require('./helpers/legacy-native-session-state');

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
    "process.stdout.write(JSON.stringify({ sessionId: 'sess_fake', response: 'ok', projection: { status: 'idle' }, usage: { inputTokens: 1, outputTokens: 1 } }));",
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

test('bridge preserves unknown and failed native endings instead of inventing stop', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine.cjs');
  const adapter = createZcodeAdapter();
  for (const [native, expected] of [
    [{ response: 'ok', projection: { status: 'idle' } }, 'completed'],
    [{ response: 'ok' }, 'unknown'],
    [{ response: 'partial', projection: { status: 'running' } }, 'unknown'],
    [{ response: 'partial', projection: { status: 'error' } }, 'failed'],
    [{ response: 'partial', error: { message: 'failure' } }, 'failed'],
    [{ projection: { status: 'idle' } }, 'failed'],
  ]) {
    fs.writeFileSync(engine, `console.log(${JSON.stringify(JSON.stringify({ sessionId: 'sess_test', ...native }))})`);
    const result = spawnSync(process.execPath, [BRIDGE, 'hello'], { encoding: 'utf8', env: { ...process.env, ZCODE_ENGINE: engine } });
    const tracker = adapter.createCompletionTracker();
    for (const event of result.stdout.trim().split('\n').map(JSON.parse)) tracker.observe(event, adapter.decodeEvent(event));
    assert.equal(tracker.finish({ kind: 'process', code: result.status }).state, expected, JSON.stringify(native));
  }
});

test('engine env points 0.16.9+ at the desktop bundle builtin provider config', () => {
  const { zcodeEngineEnv } = require('../src/native/binding').zcodeEngine;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-builtin-'));
  const engine = path.join(root, 'Resources', 'glm', 'zcode.cjs');
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.writeFileSync(engine, '');
  const base = { PATH: '/bin' };
  assert.equal(zcodeEngineEnv(engine, base), base, 'missing bundle file leaves env untouched');
  const config = path.join(root, 'Resources', 'config', 'provider', 'zcode-builtin.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '{}');
  assert.equal(zcodeEngineEnv(engine, base).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, config);
  assert.equal(base.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined, 'input env not mutated');
  const explicit = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/custom.json' };
  assert.equal(zcodeEngineEnv(engine, explicit), explicit, 'explicit override wins');
  assert.equal(zcodeEngineEnv('zcode', base), base, 'bare binary name is not probed');
});

test('resume retries without runtimeModel when a 0.16.9+ engine rejects the key, and keeps streaming', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-resume-'));
  const engine = path.join(root, 'zcode.cjs');
  const log = path.join(root, 'log.jsonl');
  fs.writeFileSync(engine, `'use strict';
const fs = require('fs');
if (process.argv[2] !== 'app-server') process.exit(2);
const sid = 'sess_00000000-0000-4000-8000-000000000001';
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
const ev = (seq, type, payload) => out({ method: 'session/event', params: { sessionId: sid, seq, type, payload } });
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  if (m.method === 'session/resume') {
    if (m.params.runtimeModel) return out({ id: m.id, error: { code: -32602, message: 'Invalid params — (root): Unrecognized key: "runtimeModel"' } });
    return out({ id: m.id, result: { session: { sessionId: sid } } });
  }
  if (m.method === 'session/subscribe') return out({ id: m.id, result: { eventSeq: 5 } });
  if (m.method === 'session/send') {
    out({ id: m.id, result: { accepted: true, sessionId: sid } });
    ev(6, 'turn.started', {});
    ev(7, 'model.streaming', { kind: 'text_delta', delta: 'hi', assistantMessageId: 'a1' });
    ev(8, 'turn.completed', { resultType: 'success', response: 'hi', usage: { inputTokens: 3, outputTokens: 1 } });
  }
});
`);
  const settings = path.join(root, 'config.json');
  fs.writeFileSync(settings, JSON.stringify({
    model: 'zai/glm-5.2',
    provider: { zai: { kind: 'anthropic', options: { baseURL: 'https://api.z.ai/api/anthropic' }, models: { 'glm-5.2': {} } } },
  }));
  const res = spawnSync(process.execPath, [BRIDGE, '--session', 'sess_00000000-0000-4000-8000-000000000001', 'hello'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ZCODE_ENGINE: engine, ZCODE_SETTINGS: settings },
    timeout: 15000,
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const resumes = calls.filter(c => c.method === 'session/resume');
  assert.equal(resumes.length, 2);
  assert.ok(resumes[0].params.runtimeModel, 'first attempt keeps pre-0.16.9 compatibility');
  assert.equal(resumes[1].params.runtimeModel, undefined);
  assert.ok(calls.some(c => c.method === 'session/send'), 'turn ran on app-server, not the legacy path');
  const events = res.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some(e => e.type === 'text' && /hi/.test(e.part && e.part.text)), res.stdout + res.stderr);
  assert.ok(events.some(e => e.type === 'step_finish' && e.part.reason === 'stop'), res.stdout + res.stderr);
});

// Frozen from 7e57fd99 before the Rust migration; this oracle is test-only.
const legacyZcodeSession = require('./helpers/legacy-zcode-session');
const nativeZcodeSession = require('../src/native/binding');

test('Rust ZCode identity predicate matches every UTF-16 suffix and preserves type guards', () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    const value = 'sess_' + String.fromCharCode(unit);
    assert.equal(nativeZcodeSession.isZcodeSessionId(value), legacyZcodeSession.isZcodeSessionId(value), `unit ${unit}`);
  }
  for (const value of [undefined, null, false, 0, 1n, Symbol('id'), {}, [], new String('sess_a'),
    'sess_', 'sess_Az09_-', 'sess_a\n', 'sess_a\r\n', 'sess_a\u2028', 'sess_a\u2029',
    'sess_a\0', ' sess_a', 'sess_a/b', '\ud800', 'zcode-123']) {
    assert.equal(nativeZcodeSession.isZcodeSessionId(value), legacyZcodeSession.isZcodeSessionId(value));
  }
  const coercionTrap = { toString() { throw new Error('must not coerce'); } };
  assert.equal(nativeZcodeSession.isZcodeSessionId(coercionTrap), false);
});

test('Rust ZCode repair matches frozen mutations and JSON bytes without replacing state objects', () => {
  const ids = [undefined, null, false, 0, 123, '', 'sess_existing', 'zcode-settings', 'zcode-err',
    'zcode-no-engine', 'zcode-parse', 'zcode-0', 'zcode-1788653210000', 'zcode-', 'zcode--1',
    'zcode-1\n', 'zcode-１２', 'zcode-future', 'future-native-format', '\ud800'];
  let count = 0;
  for (const cli of ['zcode', 'codex', undefined, null]) for (const a of ids) for (const b of ids) {
    const make = () => ({ cli, cliSessionId: a, _streamSessionId: b, provider: 'keep', history: ['keep'],
      cliStates: { zcode: { cliSessionId: b, streamSessionId: a }, codex: { cliSessionId: 'thread-keep' } } });
    const old = make(), actual = make(), states = actual.cliStates, zcode = states.zcode, history = actual.history;
    assert.equal(nativeZcodeSession.repairZcodeSessionState(actual), legacyZcodeSession.repairZcodeSessionState(old));
    assert.equal(JSON.stringify(actual), JSON.stringify(old));
    assert.equal(actual.cliStates, states); assert.equal(states.zcode, zcode); assert.equal(actual.history, history);
    assert.equal(nativeZcodeSession.repairZcodeSessionState(actual), false, 'repair is idempotent');
    count++;
  }
  assert.equal(count, 1600);
  for (const cliStates of [undefined, null, false, 0, '', {}, { zcode: null }, { zcode: false }, { zcode: 0 }]) {
    const a = { cli: 'zcode', cliStates }, b = { cli: 'zcode', cliStates };
    assert.equal(nativeZcodeSession.repairZcodeSessionState(a), legacyZcodeSession.repairZcodeSessionState(b));
  }
});

test('Rust ZCode repair preserves accessor, proxy and reentrant mutation order', () => {
  function exercise(repair) {
    const trace = [];
    const observe = (label, value) => new Proxy(value, {
      get(target, key, receiver) { trace.push(`get ${label}.${String(key)}`); return Reflect.get(target, key, receiver); },
      set(target, key, value, receiver) { trace.push(`set ${label}.${String(key)}=${value}`); return Reflect.set(target, key, value, receiver); },
    });
    const later = observe('later', { cliSessionId: 'sess_keep', streamSessionId: 'zcode-123' });
    let active;
    const first = observe('first', {
      get cliSessionId() { trace.push('getter first'); return 'zcode-err'; },
      set cliSessionId(value) { trace.push(`setter first=${value}`); active = later; },
    });
    active = first;
    const session = observe('session', { cli: 'zcode', cliSessionId: 'zcode-settings', _streamSessionId: 'sess_keep',
      get cliStates() { trace.push('getter cliStates'); return observe('states', { zcode: active }); },
    });
    const changed = repair(session);
    return { trace, changed, final: [session.cliSessionId, session._streamSessionId, later.streamSessionId] };
  }
  assert.deepEqual(exercise(nativeZcodeSession.repairZcodeSessionState), exercise(legacyZcodeSession.repairZcodeSessionState));
});

test('Rust ZCode repair preserves thrown identities, partial writes and strict assignment failures', () => {
  const thrown = { fixture: 'original exception' };
  for (const failing of ['cli', 'cliSessionId', '_streamSessionId', 'cliStates', 'zcode', 'streamSessionId', 'setter']) {
    function exercise(repair) {
      const saved = { cliSessionId: 'zcode-err', streamSessionId: 'zcode-123' };
      const record = { cli: 'zcode', cliSessionId: 'zcode-settings', _streamSessionId: 'zcode-parse', cliStates: { zcode: saved } };
      const target = failing === 'zcode' ? record.cliStates : failing === 'streamSessionId' ? saved : record;
      if (failing === 'setter') Object.defineProperty(record, 'cliSessionId', {
        get: () => 'zcode-settings', set: () => { throw thrown; },
      });
      else Object.defineProperty(target, failing, { get() { throw thrown; } });
      assert.throws(() => repair(record), error => error === thrown);
      return [Object.getOwnPropertyDescriptor(record, 'cliSessionId').value,
        Object.getOwnPropertyDescriptor(record, '_streamSessionId').value, saved.cliSessionId];
    }
    assert.deepEqual(exercise(nativeZcodeSession.repairZcodeSessionState), exercise(legacyZcodeSession.repairZcodeSessionState), failing);
  }
  for (const make of [
    () => Object.freeze({ cli: 'zcode', cliSessionId: 'zcode-err' }),
    () => ({ cli: 'codex', cliStates: { zcode: Object.freeze({ cliSessionId: 'zcode-err' }) } }),
    () => new Proxy({ cli: 'zcode', cliSessionId: 'zcode-err' }, { set: () => false }),
  ]) {
    assert.throws(() => legacyZcodeSession.repairZcodeSessionState(make()), TypeError);
    assert.throws(() => nativeZcodeSession.repairZcodeSessionState(make()), TypeError);
  }
  for (const value of [undefined, null]) {
    assert.throws(() => legacyZcodeSession.repairZcodeSessionState(value), TypeError);
    assert.throws(() => nativeZcodeSession.repairZcodeSessionState(value), TypeError);
  }
});

// Frozen from aef30f9f; no relative imports or production routing dependencies.
const legacyZcodeEngine = require('./helpers/legacy-zcode-engine');
const nativeZcodeEngine = require('../src/native/binding').zcodeEngine;

function engineOutcome(run) {
  try { return { value: run() }; }
  catch (error) { return { name: error.name, code: error.code, message: error.message }; }
}

function engineFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-engine-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Resources');
  const config = path.join(resources, 'config', 'provider', 'zcode-builtin.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(path.join(resources, 'glm'), { recursive: true });
  fs.writeFileSync(config, 'not parsed by this probe');
  return { root, resources, config, engine: path.join(resources, 'glm', 'zcode.cjs') };
}

test('Rust ZCode candidates match frozen defaults, host paths, types and getter order', () => {
  assert.equal(nativeZcodeEngine.DEFAULT_ZCODE_ENGINE, legacyZcodeEngine.DEFAULT_ZCODE_ENGINE);
  let cases = 0;
  for (const isWindows of [undefined, false, true, 0, 1, '', 'windows', null]) {
    for (const homeDir of [undefined, null, '', '/home/user', '/space home/../user', 'C:\\Users\\test', 123, {}, new String('home')]) {
      assert.deepEqual(engineOutcome(() => nativeZcodeEngine.zcodeEngineCandidates({ isWindows, homeDir })),
        engineOutcome(() => legacyZcodeEngine.zcodeEngineCandidates({ isWindows, homeDir })));
      cases++;
    }
  }
  assert.equal(cases, 72);
  for (const isWindows of [true, false, undefined]) {
    function exercise(api, fail) {
      const trace = [], thrown = { fixture: 'options getter' };
      const options = new Proxy({ isWindows, homeDir: '/test/home' }, { get(target, key) {
        trace.push(key); if (key === fail) throw thrown; return target[key];
      } });
      try { return { trace, value: api.zcodeEngineCandidates(options) }; }
      catch (error) { assert.equal(error, thrown); return { trace, threw: true }; }
    }
    for (const fail of [undefined, 'isWindows', 'homeDir']) {
      assert.deepEqual(exercise(nativeZcodeEngine, fail), exercise(legacyZcodeEngine, fail));
    }
  }
  assert.throws(() => nativeZcodeEngine.zcodeEngineCandidates(null), TypeError);
  assert.throws(() => legacyZcodeEngine.zcodeEngineCandidates(null), TypeError);
});

test('Rust ZCode metadata probe matches files, directories, symlinks and path bytes', t => {
  const { root, config, engine } = engineFixture(t);
  const engines = [engine, path.relative(process.cwd(), engine), engine.replace('.cjs', '.JS'), engine.replace('.cjs', '.CJS'),
    engine.replace('.cjs', '.mjs'), engine + '\n', engine + '\0', 'zcode', undefined, null, false, 0, 10,
    1n, {}, [], new String(engine), { toString: () => engine }, Symbol('engine')];
  const compare = () => {
    for (const value of engines) {
      const old = engineOutcome(() => legacyZcodeEngine.zcodeBuiltinProviderConfig(value));
      const actual = engineOutcome(() => nativeZcodeEngine.zcodeBuiltinProviderConfig(value));
      assert.deepEqual(actual, old); assert.equal(JSON.stringify(actual), JSON.stringify(old));
    }
  };
  compare();
  fs.chmodSync(config, 0o000); compare(); fs.chmodSync(config, 0o600);
  fs.unlinkSync(config); compare();
  fs.mkdirSync(config); compare(); fs.rmdirSync(config);
  if (process.platform !== 'win32') {
    const target = path.join(root, 'config-target'); fs.writeFileSync(target, 'fixture');
    fs.symlinkSync(target, config); compare(); fs.unlinkSync(config);
    fs.symlinkSync(root, config); compare(); fs.unlinkSync(config);
    fs.symlinkSync(path.join(root, 'missing'), config); compare(); fs.unlinkSync(config);
  }
  const strange = path.join(root, 'surrogate-\ud800', 'Resources');
  const strangeConfig = path.join(strange, 'config', 'provider', 'zcode-builtin.json');
  fs.mkdirSync(path.dirname(strangeConfig), { recursive: true }); fs.writeFileSync(strangeConfig, 'fixture');
  const strangeEngine = path.join(strange, 'glm', 'engine.js');
  assert.equal(nativeZcodeEngine.zcodeBuiltinProviderConfig(strangeEngine), legacyZcodeEngine.zcodeBuiltinProviderConfig(strangeEngine));
  assert.equal(JSON.stringify(nativeZcodeEngine.zcodeBuiltinProviderConfig(strangeEngine)), JSON.stringify(strangeConfig));
});

test('Rust ZCode env projection preserves fallback identity and ordered spread values', t => {
  const { engine, config } = engineFixture(t);
  const marker = Symbol('fixture');
  const bases = [false, 0, '', 'env', 1n, Symbol('env'), {}, [],
    { KEEP: 'value' }, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '' },
    { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: false, KEEP: 'value' },
    { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/explicit/config' },
    Object.create({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/inherited/config' }),
    Object.assign(Object.create({ INHERITED: 'omit' }), { KEEP: 'value', [marker]: 'symbol value' }),
  ];
  for (const base of bases) for (const file of [engine, 'bare-name', engine.replace('.cjs', '.mjs')]) {
    const old = legacyZcodeEngine.zcodeEngineEnv(file, base), actual = nativeZcodeEngine.zcodeEngineEnv(file, base);
    assert.deepEqual(actual, old);
    assert.equal(actual === base, old === base, 'identity is retained on both fast paths');
    if (typeof actual === 'object' && actual !== null) {
      assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(old));
      assert.equal(JSON.stringify(actual), JSON.stringify(old));
    }
  }
  assert.equal(nativeZcodeEngine.zcodeEngineEnv(engine, {}).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, config);
  assert.throws(() => nativeZcodeEngine.zcodeEngineEnv(engine, null), TypeError);
  assert.throws(() => legacyZcodeEngine.zcodeEngineEnv(engine, null), TypeError);
});

test('Rust ZCode env getters, proxies, coercion failures and short circuits match the oracle', t => {
  const { engine } = engineFixture(t);
  function exercise(api, fail) {
    const trace = [], thrown = { fixture: 'env trap' };
    const base = new Proxy({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '', KEEP: 'value' }, {
      get(target, key, receiver) { trace.push(`get ${String(key)}`); if (key === fail) throw thrown; return Reflect.get(target, key, receiver); },
      ownKeys(target) { trace.push('ownKeys'); if (fail === 'ownKeys') throw thrown; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { trace.push(`descriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    try { return { trace, value: api.zcodeEngineEnv(engine, base) }; }
    catch (error) { assert.equal(error, thrown); return { trace, threw: true }; }
  }
  for (const fail of [undefined, 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'KEEP', 'ownKeys']) {
    assert.deepEqual(exercise(nativeZcodeEngine, fail), exercise(legacyZcodeEngine, fail));
  }
  const thrown = { fixture: 'engine coercion' };
  for (const api of [legacyZcodeEngine, nativeZcodeEngine]) {
    const value = { toString() { throw thrown; } };
    assert.throws(() => api.zcodeBuiltinProviderConfig(value), error => error === thrown);
    const base = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/explicit/config' };
    assert.equal(api.zcodeEngineEnv(value, base), base, 'override prevents any engine coercion');
    assert.equal(api.zcodeEngineEnv(Symbol('unused'), base), base);
  }
});

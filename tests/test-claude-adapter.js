'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createClaudeAdapter } = require('../src/cli-adapters/claude');
const { processSpawnArgs } = require('../src/chat/process-spawn-args');
const { createChatTurnEngine } = require('../src/chat/turn-engine');
const { hasNativeHistory } = require('../src/cli-adapters/claude-exp-history');
const prepareTurn = require('./helpers/claude-turn');
const { recordsOf } = require('./helpers/session-records');

const SESSION_UUID = '05de20f7-563a-4d09-af34-b748c7b189ca';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function envelope({ first = true, sessionId = SESSION_UUID, effort = 'high' } = {}) {
  return {
    contextLayers: [{ kind: 'task-context', order: 12, text: 'context\n\n' }],
    userText: 'hello', suffix: '', rolePrompt: 'reviewer', imgHint: 'IMG',
    systemPrompt: 'IMG\n\nreviewer',
    historyHandle: { isFirstTurn: first, cliSessionId: sessionId },
    spawnOpts: {
      mode: 'per-turn', rawEffort: effort, rawModel: 'claude-opus-5',
      providerModel: null, providerModels: [], skipDefaultModel: false,
      rawAgent: 'reviewer', maxTurns: 4,
    },
  };
}

function adapter() {
  return createClaudeAdapter({
    bridge: '/opt/claude-agent-sdk-bridge.mjs',
    resolveSessionWireModel: model => model,
    claudeDefaultModel: () => 'claude-sonnet-5',
    cliEffortLevel: ({ effort }) => effort,
    normalizeEffort: value => value,
    debugLogClaudeInvoke: () => {},
    chatDisallowedTools: ['WebSearch'],
    routerMcpNode: '/opt/node',
    routerMcpScript: '/opt/multicc-router-mcp.js',
  });
}

test('claude chat invokes the Agent SDK bridge with first-turn and resume identity', () => {
  const instance = adapter();
  const first = instance.buildInvocation(envelope());
  assert.equal(instance.name, 'claude');
  assert.equal(first.cmd, process.execPath);
  assert.deepEqual(first.args, [
    '/opt/claude-agent-sdk-bridge.mjs', '--session-id', SESSION_UUID,
    '--model', 'claude-opus-5', '--effort', 'high', '--agent', 'reviewer',
    '--system-prompt', 'IMG\n\nreviewer', '--disallowed-tools-json', '["WebSearch"]',
    '--max-turns', '4', '--router-node', '/opt/node',
    '--router-script', '/opt/multicc-router-mcp.js', '--',
  ]);
  assert.equal(first.payload, 'context\n\nhello');
  assert.equal(first.sdkOptions.model, 'claude-opus-5');
  assert.equal(first.streamBackend, undefined, 'the SDK options are what route it to the resident lane');

  const resumed = instance.buildInvocation(envelope({ first: false }));
  assert.deepEqual(resumed.args.slice(0, 3), [
    '/opt/claude-agent-sdk-bridge.mjs', '--resume', SESSION_UUID,
  ]);
  assert.equal(resumed.args.includes('--session-id'), false);
});

test('turn spawn keeps settings before the prompt separator for claude', () => {
  const invocation = adapter().buildInvocation(envelope());
  assert.deepEqual(processSpawnArgs(invocation, '/tmp/settings.json').slice(-4), [
    '--settings', '/tmp/settings.json', '--', 'context\n\nhello',
  ]);
  assert.deepEqual(processSpawnArgs({
    args: ['--print', '--output-format', 'stream-json'], payload: 'hello',
  }, '/tmp/settings.json'), [
    '--print', '--output-format', 'stream-json', '--settings', '/tmp/settings.json', 'hello',
  ]);
});

test('claude preserves Claude stream-json event and completion semantics', () => {
  const instance = adapter();
  assert.deepEqual(instance.decodeEvent({ type: 'system', subtype: 'init', model: 'opus' }), [{
    type: 'session_init', model: 'opus',
    raw: { type: 'system', subtype: 'init', model: 'opus' },
  }]);
  assert.equal(instance.decodeEvent({ type: 'stream_event', event: { type: 'content_block_delta' } })[0].type, 'claude_event');
  assert.equal(instance.decodeEvent({ type: 'assistant', message: { content: [] } })[0].type, 'claude_event');
  const failure = instance.decodeEvent({ type: 'system', subtype: 'sdk_error', error: 'boom' })[0];
  assert.equal(failure.type, 'error');
  assert.equal(failure.label, 'Claude');

  const tracker = createAdapterCompletion(instance);
  const result = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
  tracker.observe(result, instance.decodeEvent(result));
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
});

test('native bridge maps MultiCC options without making a live request', async () => {
  const bridgeUrl = pathToFileURL(path.join(__dirname, '../src/cli-adapters/claude-agent-sdk-bridge.mjs')).href;
  const bridge = await import(bridgeUrl);
  const emitted = [];
  let observed = null;
  let sent = null;
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-settings-')), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Read'] } }));
  const createLane = callback => {
    const lane = {
      alive: true,
      async start(config) { observed = JSON.parse(config); return JSON.stringify({ pid: 1, argv: [] }); },
      async sendUser(line) {
        sent = JSON.parse(line);
        setImmediate(() => {
          callback(['message', JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_UUID }), '']);
          callback(['message', JSON.stringify({ type: 'result', subtype: 'success', is_error: false }), '']);
        });
      },
      respondControl() {}, respondControlError() {}, closeInput() {}, kill() {},
      stderrTail() { return ''; },
    };
    return { lane, binary: '/opt/claude' };
  };
  await bridge.run([
    '--session-id', SESSION_UUID, '--model', 'claude-opus-5', '--effort', 'high',
    '--agent', 'reviewer', '--system-prompt', 'ROLE', '--settings', settingsFile,
    '--max-turns', '3', '--disallowed-tools-json', '["WebSearch"]',
    '--router-node', '/opt/node', '--router-script', '/opt/router.js', '--', 'hello sdk',
  ], createLane, value => emitted.push(value));
  assert.equal(sent.message.content[0].text, 'hello sdk');
  assert.equal(sent.session_id, SESSION_UUID);
  assert.equal(observed.sessionId, SESSION_UUID);
  assert.equal(observed.model, 'claude-opus-5');
  assert.equal(observed.effort, 'high');
  assert.equal(observed.agent, 'reviewer');
  assert.equal(observed.maxTurns, 3);
  assert.deepEqual(observed.settings, { permissions: { allow: ['Read'] } });
  assert.match(observed.settingsPath, /multicc-sdk-.*\/settings\.json$/);
  assert.notEqual(observed.settingsPath, settingsFile);
  assert.equal(observed.permissionMode, 'bypassPermissions');
  assert.equal(observed.allowDangerouslySkipPermissions, true);
  assert.equal(observed.includePartialMessages, true);
  assert.equal(observed.systemPromptAppend, 'ROLE');
  assert.deepEqual(observed.disallowedTools, ['WebSearch']);
  assert.deepEqual(observed.mcpServers.multicc_router, { command: '/opt/node', args: ['/opt/router.js'] });
  assert.deepEqual(emitted.map(item => item.type), ['system', 'result']);
});

// Exercise real turn admission/preparation up to the next preparation port;
// stop there so these identity regressions never start a CLI or contact an API.
async function prepareIdentity({ cli = 'claude', connected = true, nativeId = null, reject = false } = {}) {
  const noop = () => {};
  const record = { id: 'sdk-identity-test', kind: 'chat', cli, cliSessionId: nativeId };
  const chat = { cli, chatTurnCount: nativeId ? 1 : 0, clients: new Set() };
  const saved = [];
  let preparedId;
  const engine = createChatTurnEngine({
    persistedSessions: new Map([[record.id, record]]),
    chatSessions: new Map(connected ? [[record.id, chat]] : []),
    taskContextHost: { turnOptions: opts => opts, restore: () => null },
    loadChatHistory: () => [],
    isShuttingDown: () => reject,
    cwdForSession: () => '/tmp',
    savePersistedSessionsBestEffort: () => saved.push(record.cliSessionId),
    chatTurnPreparationRuntime: { claim: () => ({ ok: true }), settle: noop },
    turnProgressHeartbeat: { stop: noop },
    logger: { warn: noop, info: noop, error: noop },
    chatBroadcast: noop, emitTurnOutcome: noop, classifyTurnEnd: noop,
    appendChatMessage: () => true,
    cancelClassify() {
      preparedId = record.cliSessionId;
      throw new Error('identity preparation probe complete');
    },
  });
  return engine.runChatTurn(record.id, 'hello', { taskId: 'task-identity-test' })
    .then(() => ({ record, preparedId, saved }));
}

test('accepted turns allocate Claude UUIDs after CLI switches and without a WebSocket', async t => {
  t.mock.method(console, 'error', () => {});
  for (const connected of [true, false]) {
    const result = await prepareIdentity({ connected });
    assert.match(result.preparedId || '', UUID_RE, `connected=${connected}`);
    assert.deepEqual(result.saved, [result.preparedId]);
    const invocation = adapter().buildInvocation(envelope({ sessionId: result.preparedId }));
    assert.equal(invocation.args[1], '--session-id');
    assert.match(invocation.args[2], UUID_RE);
  }
});

test('existing native sessions survive preparation and rejected turns allocate nothing', async t => {
  t.mock.method(console, 'error', () => {});
  for (const connected of [true, false]) {
    const resumed = await prepareIdentity({ connected, nativeId: SESSION_UUID });
    assert.equal(resumed.preparedId, SESSION_UUID);
    assert.deepEqual(resumed.saved, []);
    const rejected = await prepareIdentity({ connected, reject: true });
    assert.equal(rejected.record.cliSessionId, null);
    assert.equal(rejected.preparedId, undefined);
    assert.deepEqual(rejected.saved, []);
  }
});

test('a legacy claude -p session carries its streaming identity into the SDK lane', async t => {
  t.mock.method(console, 'error', () => {});
  const record = { id: 'legacy-claude-p', kind: 'chat', cli: 'claude', cliSessionId: null,
    _streamSessionId: SESSION_UUID };
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'old reply' }];
  // The retired key is renamed by the native owner at load time (M4), not by
  // the turn engine: load the record the way boot does before preparing.
  const records = recordsOf([[record.id, record]]);
  assert.equal(records.loadMigrated, true, 'the load normalisation owes one save');
  const { invocation } = await prepareTurn({ record, cwd: '/tmp', history });
  assert.equal(record.cliSessionId, SESSION_UUID, 'the streaming id becomes the SDK identity');
  assert.equal(record._streamSessionId, undefined, 'the retired key is gone');
  assert.deepEqual(invocation.args.slice(1, 3), ['--resume', SESSION_UUID],
    'history-bearing sessions resume the same transcript instead of starting over');
});

test('source CLI display replies cannot make a new Claude Exp target resume', async t => {
  t.mock.method(console, 'error', () => {});
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-exp-history-unit-'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  const history = Array.from({ length: 34 }, () => ({ role: 'assistant', content: 'old Claude reply' }));
  for (const connected of [true, false]) {
    for (const nativeId of [null, SESSION_UUID]) {
      const record = { id: 'new-exp-target', kind: 'chat', cli: 'claude-exp', cliSessionId: nativeId,
        pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: false } };
      const { invocation, envelope: prepared } = await prepareTurn({ record, cwd: '/tmp/exp-history-unit', history, connected });
      assert.equal(prepared.historyHandle.isFirstTurn, true, `connected=${connected}, reserved=${!!nativeId}`);
      assert.equal(invocation.args[1], '--session-id');
      assert.match(invocation.args[2], UUID_RE);
      assert.equal(invocation.args.includes('--resume'), false);
      if (nativeId) assert.equal(record.cliSessionId, nativeId, 'repair keeps the reserved identity');
    }
  }
  const reused = { id: 'old-exp-target', kind: 'chat', cli: 'claude-exp', cliSessionId: SESSION_UUID,
    pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: true } };
  const { invocation } = await prepareTurn({ record: reused, cwd: configDir, history });
  assert.equal(invocation.args[1], '--resume', 'missing established history must not silently restart');
});

test('a pending new target resumes after SDK history exists; unknown/reused history fails closed', () => {
  const record = { cli: 'claude-exp', cliSessionId: SESSION_UUID,
    pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: false } };
  const absent = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
  const dir = { name: 'SDK-custom-or-hashed-project', isDirectory: () => true };
  const io = { readdirSync: () => [dir], statSync: absent };
  assert.equal(hasNativeHistory(record, { fs: io }), false);
  assert.equal(hasNativeHistory(record, { fs: { ...io, readdirSync: absent } }), false);
  const checked = [];
  assert.equal(hasNativeHistory(record, { fs: { ...io, statSync: file => checked.push(file) } }), true);
  assert.ok(checked[0].endsWith(path.join(dir.name, SESSION_UUID + '.jsonl')));
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal(hasNativeHistory(record, { fs: { ...io, statSync: denied } }), true);
  assert.equal(hasNativeHistory(record, { fs: { ...io, readdirSync: denied } }), true);
  for (const pendingCliHandoff of [undefined,
    { ...record.pendingCliHandoff, reusedTarget: true },
    { ...record.pendingCliHandoff, status: 'consumed' },
  ]) assert.equal(hasNativeHistory({ ...record, pendingCliHandoff }, { fs: io }), true);
  assert.equal(hasNativeHistory({ ...record, cli: 'claude' }, { fs: io }), true);
  assert.equal(hasNativeHistory({ ...record, cli: 'codex' }, { fs: io }), true);
});

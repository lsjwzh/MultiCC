'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createClaudeExpAdapter } = require('../src/cli-adapters/claude-exp');
const { processSpawnArgs } = require('../src/chat/process-spawn-args');
const { createSessionRecordFactory } = require('../src/session/create-record');
const { isResidentSession } = require('../src/cli/cli-capability');
const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');
const { createChatTurnEngine } = require('../src/chat/turn-engine');
const { hasNativeHistory } = require('../src/cli-adapters/claude-exp-history');
const prepareTurn = require('./helpers/claude-exp-turn');

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
  return createClaudeExpAdapter({
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

test('claude-exp invokes the Agent SDK bridge with first-turn and resume identity', () => {
  const instance = adapter();
  const first = instance.buildInvocation(envelope());
  assert.equal(instance.name, 'claude-exp');
  assert.equal(first.cmd, process.execPath);
  assert.deepEqual(first.args, [
    '/opt/claude-agent-sdk-bridge.mjs', '--session-id', SESSION_UUID,
    '--model', 'claude-opus-5', '--effort', 'high', '--agent', 'reviewer',
    '--system-prompt', 'IMG\n\nreviewer', '--disallowed-tools-json', '["WebSearch"]',
    '--max-turns', '4', '--router-node', '/opt/node',
    '--router-script', '/opt/multicc-router-mcp.js', '--',
  ]);
  assert.equal(first.payload, 'context\n\nhello');

  const resumed = instance.buildInvocation(envelope({ first: false }));
  assert.deepEqual(resumed.args.slice(0, 3), [
    '/opt/claude-agent-sdk-bridge.mjs', '--resume', SESSION_UUID,
  ]);
  assert.equal(resumed.args.includes('--session-id'), false);
});

test('turn spawn keeps settings before the prompt separator for claude-exp', () => {
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

test('claude-exp preserves Claude stream-json event and completion semantics', () => {
  const instance = adapter();
  assert.deepEqual(instance.decodeEvent({ type: 'system', subtype: 'init', model: 'opus' }), [{
    type: 'session_init', model: 'opus',
    raw: { type: 'system', subtype: 'init', model: 'opus' },
  }]);
  assert.equal(instance.decodeEvent({ type: 'stream_event', event: { type: 'content_block_delta' } })[0].type, 'claude_event');
  assert.equal(instance.decodeEvent({ type: 'assistant', message: { content: [] } })[0].type, 'claude_event');
  assert.equal(instance.decodeEvent({ type: 'system', subtype: 'sdk_error', error: 'boom' })[0].type, 'error');

  const tracker = createAdapterCompletion(instance);
  const result = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
  tracker.observe(result, instance.decodeEvent(result));
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
});

test('Agent SDK bridge maps MultiCC options without making a live request', async () => {
  const bridgeUrl = pathToFileURL(path.join(__dirname, '../src/cli-adapters/claude-agent-sdk-bridge.mjs')).href;
  const bridge = await import(bridgeUrl);
  const emitted = [];
  let observed;
  async function* fakeQuery(input) {
    observed = input;
    yield { type: 'system', subtype: 'init', session_id: SESSION_UUID };
    yield { type: 'result', subtype: 'success', is_error: false };
  }
  await bridge.run([
    '--session-id', SESSION_UUID, '--model', 'claude-opus-5', '--effort', 'high',
    '--agent', 'reviewer', '--system-prompt', 'ROLE', '--settings', '/tmp/settings.json',
    '--max-turns', '3', '--disallowed-tools-json', '["WebSearch"]',
    '--router-node', '/opt/node', '--router-script', '/opt/router.js', '--', 'hello sdk',
  ], fakeQuery, value => emitted.push(value));
  assert.equal(observed.prompt, 'hello sdk');
  assert.equal(observed.options.sessionId, SESSION_UUID);
  assert.equal(observed.options.model, 'claude-opus-5');
  assert.equal(observed.options.effort, 'high');
  assert.equal(observed.options.agent, 'reviewer');
  assert.equal(observed.options.settings, '/tmp/settings.json');
  assert.equal(observed.options.permissionMode, 'bypassPermissions');
  assert.equal(observed.options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(observed.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'ROLE' });
  assert.deepEqual(observed.options.disallowedTools, ['WebSearch']);
  assert.deepEqual(observed.options.mcpServers.multicc_router, { command: '/opt/node', args: ['/opt/router.js'] });
  assert.deepEqual(emitted.map(item => item.type), ['system', 'result']);
});

test('claude-exp is chat-only at the canonical session boundary', async () => {
  const create = createSessionRecordFactory({
    isResidentSession, SUPPORTED_CHAT_CLIS,
    validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
  });
  assert.deepEqual(await create({ dir: { id: 'd' }, cli: 'claude-exp', kind: 'terminal' }), {
    ok: false, error: 'claude-exp only supports chat sessions',
  });
});

// Exercise real turn admission/preparation up to the next preparation port;
// stop there so these identity regressions never start a CLI or contact an API.
function prepareIdentity({ cli = 'claude-exp', connected = true, nativeId = null, reject = false } = {}) {
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
    cancelClassify() {
      preparedId = record.cliSessionId;
      throw new Error('identity preparation probe complete');
    },
  });
  engine.runChatTurn(record.id, 'hello', { taskId: 'task-identity-test' });
  return { record, preparedId, saved };
}

test('accepted turns allocate Claude UUIDs after CLI switches and without a WebSocket', t => {
  t.mock.method(console, 'error', () => {});
  for (const cli of ['claude-exp', 'claude']) {
    for (const connected of [true, false]) {
      const result = prepareIdentity({ cli, connected });
      assert.match(result.preparedId || '', UUID_RE, `${cli}, connected=${connected}`);
      assert.deepEqual(result.saved, [result.preparedId]);
      const invocation = adapter().buildInvocation(envelope({ sessionId: result.preparedId }));
      assert.equal(invocation.args[1], '--session-id');
      assert.match(invocation.args[2], UUID_RE);
    }
  }
});

test('existing native sessions survive preparation and rejected turns allocate nothing', t => {
  t.mock.method(console, 'error', () => {});
  for (const connected of [true, false]) {
    const resumed = prepareIdentity({ connected, nativeId: SESSION_UUID });
    assert.equal(resumed.preparedId, SESSION_UUID);
    assert.deepEqual(resumed.saved, []);
    const rejected = prepareIdentity({ connected, reject: true });
    assert.equal(rejected.record.cliSessionId, null);
    assert.equal(rejected.preparedId, undefined);
    assert.deepEqual(rejected.saved, []);
  }
});

test('source CLI display replies cannot make a new Claude Exp target resume', t => {
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
      const { invocation, envelope: prepared } = prepareTurn({ record, cwd: '/tmp/exp-history-unit', history, connected });
      assert.equal(prepared.historyHandle.isFirstTurn, true, `connected=${connected}, reserved=${!!nativeId}`);
      assert.equal(invocation.args[1], '--session-id');
      assert.match(invocation.args[2], UUID_RE);
      assert.equal(invocation.args.includes('--resume'), false);
      if (nativeId) assert.equal(record.cliSessionId, nativeId, 'repair keeps the reserved identity');
    }
  }
  const reused = { id: 'old-exp-target', kind: 'chat', cli: 'claude-exp', cliSessionId: SESSION_UUID,
    pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: true } };
  const { invocation } = prepareTurn({ record: reused, cwd: configDir, history });
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

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createClaudeAdapter } = require('../src/native/runtime');
const { processSpawnArgs } = require('../src/native/runtime');
const { createChatTurnEngine } = require('../src/chat/turn-engine-host');
const hasNativeHistory = (record, options) => require('../src/native/runtime').getNative().claudeExpHasNativeHistory(record, options);
const prepareTurn = require('./helpers/claude-turn');
const { createTestChatHub } = require('./helpers/native-chat-hub');
const { recordsOf } = require('./helpers/session-records');

const SESSION_UUID = '05de20f7-563a-4d09-af34-b748c7b189ca';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('chat preparation awaits ordered question resolution and turn initialization', async () => {
  let releaseResolve, enteredResolve, releaseBegin, enteredBegin;
  const resolveGate = new Promise(resolve => { releaseResolve = resolve; });
  const resolveStarted = new Promise(resolve => { enteredResolve = resolve; });
  const beginGate = new Promise(resolve => { releaseBegin = resolve; });
  const beginStarted = new Promise(resolve => { enteredBegin = resolve; });
  const trace = [];
  const promise = prepareTurn({ record: { id: 'ordered', cli: 'claude', model: 'opus' }, cwd: '/tmp',
    turnOptions: { userInputRequestId: 'q' }, hostDeps: { userInputSignalHost: {
      resolve() { throw new Error('synchronous resolution used'); },
      beginTurn() { throw new Error('synchronous begin used'); },
      async resolveAsync(_id, requestId) {
        trace.push(`resolve:${requestId}`); enteredResolve(); await resolveGate; trace.push('resolved');
        return { ok: true };
      },
      async beginTurnAsync(_id, options) {
        assert.ok(options.turnId); trace.push('begin'); enteredBegin(); await beginGate; trace.push('begun');
      },
    } } });
  await resolveStarted;
  assert.deepEqual(trace, ['resolve:q']);
  releaseResolve();
  await beginStarted;
  assert.deepEqual(trace, ['resolve:q', 'resolved', 'begin']);
  releaseBegin();
  await promise;
  assert.deepEqual(trace, ['resolve:q', 'resolved', 'begin', 'begun']);
});

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

test('Rust spawn argv preserves 384 frozen iterable/settings/payload combinations', () => {
  const legacy = require('./helpers/legacy-process-spawn-args').processSpawnArgs;
  const sources = [() => [], () => ['--'], () => ['-p', '--'], () => ['--', 'literal'],
    () => new Array(2), () => '中😀', () => new Set(['--verbose', '--']),
    () => ({ *[Symbol.iterator]() { yield 'first'; yield '--'; } })];
  const payloadObject = Object.freeze({ text: 'identity' });
  const payloads = ['hello', '--help', '中文\ud800', undefined, null, payloadObject];
  const settingsValues = [undefined, null, false, 0, '', '/private/settings.json', {}, Symbol('settings')];
  let count = 0;
  for (const makeArgs of sources) for (const settings of settingsValues) for (const payload of payloads) {
    const invocation = { args: makeArgs(), payload };
    const result = processSpawnArgs(invocation, settings);
    const expected = legacy({ args: makeArgs(), payload }, settings);
    assert.deepEqual(result, expected);
    assert.equal(result.at(-1), payload);
    if (typeof settings !== 'symbol') assert.equal(JSON.stringify(result), JSON.stringify(expected));
    count++;
  }
  assert.equal(count, 384);
});

test('Rust spawn argv preserves iterator/getter order, exception identity and source immutability', () => {
  const legacy = require('./helpers/legacy-process-spawn-args').processSpawnArgs;
  function run(build, fail) {
    const calls = [];
    const error = new Error('iterator failure');
    const invocation = {
      get args() {
        calls.push('args');
        return { [Symbol.iterator]() {
          calls.push('iterator'); let index = 0;
          return { next() {
            calls.push(`next:${index}`);
            if (fail && index === 1) throw error;
            return index++ === 0 ? { done: false, value: '--' } : { done: true };
          }, return() { calls.push('return'); return {}; } };
        } };
      },
      get payload() { calls.push('payload'); return 'literal'; },
    };
    if (fail) assert.throws(() => build(invocation, '/settings'), thrown => thrown === error);
    else assert.deepEqual(build(invocation, '/settings'), ['--settings', '/settings', '--', 'literal']);
    return calls;
  }
  for (const fail of [false, true]) assert.deepEqual(run(processSpawnArgs, fail), run(legacy, fail));
  const original = Object.freeze(['--']);
  assert.deepEqual(processSpawnArgs({ args: original, payload: 'prompt' }, '/settings'),
    ['--settings', '/settings', '--', 'prompt']);
  assert.deepEqual(original, ['--']);
  for (const args of [null, undefined, 12, {}]) {
    assert.throws(() => legacy({ args, payload: 'prompt' }), TypeError);
    assert.throws(() => processSpawnArgs({ args, payload: 'prompt' }), TypeError);
  }
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
  const { hub } = createTestChatHub();
  const chat = { cli, chatTurnCount: nativeId ? 1 : 0, clients: hub.clientsOf(record.id) };
  const saved = [];
  let preparedId;
  const engine = createChatTurnEngine({
    replay: hub,
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

test('a pending new target resumes after SDK history exists; unknown/reused history fails closed', t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-exp-history-probe-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const record = { cli: 'claude-exp', cliSessionId: SESSION_UUID,
    pendingCliHandoff: { status: 'pending', toCli: 'claude-exp', reusedTarget: false } };
  // No projects tree: the Rust probe proves absence, so the reserved id cannot
  // masquerade as a conversation.
  assert.equal(hasNativeHistory(record, { configDir }), false);
  // Any project directory holding <id>.jsonl is history, whatever canonical
  // name the SDK gave it (symlink/hash/custom project layouts).
  const project = path.join(configDir, 'projects', 'SDK-custom-or-hashed-project');
  fs.mkdirSync(project, { recursive: true });
  assert.equal(hasNativeHistory(record, { configDir }), false, 'an empty project tree is still absence');
  fs.writeFileSync(path.join(project, `${SESSION_UUID}.jsonl`), '{}\n');
  assert.equal(hasNativeHistory(record, { configDir }), true);
  for (const pendingCliHandoff of [undefined,
    { ...record.pendingCliHandoff, reusedTarget: true },
    { ...record.pendingCliHandoff, status: 'consumed' },
  ]) assert.equal(hasNativeHistory({ ...record, pendingCliHandoff }, { configDir }), true);
  assert.equal(hasNativeHistory({ ...record, cli: 'claude' }, { configDir }), true);
  assert.equal(hasNativeHistory({ ...record, cli: 'codex' }, { configDir }), true);
  assert.equal(hasNativeHistory({ ...record, cliSessionId: null }, { configDir }), false);
  assert.equal(hasNativeHistory({ ...record, cliSessionId: 'not-a-uuid' }, { configDir }), true);
});

function frozenClaudeAdapter() {
  const Module = require('node:module'), crypto = require('node:crypto');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-claude-adapter.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '8fa206f6674e9cae6c135452b5b47a331dfca31cad60eb0e1ba79085f7769e7b');
  const filename = path.resolve(__dirname, '../src/cli-adapters/claude.js');
  const legacy = new Module(filename); legacy.filename = filename;
  legacy.paths = Module._nodeModulePaths(path.dirname(filename));
  legacy.require = function (id) {
    if (id === '../message-composer') return require('./helpers/legacy-message-composer');
    return Module.prototype.require.call(this, id);
  };
  legacy._compile(source, filename);
  return legacy.exports.createClaudeAdapter;
}

test('Rust Claude adapter matches frozen argv, SDK settings, debug calls and event identities', () => {
  const frozen = frozenClaudeAdapter();
  for (const first of [false, true]) for (const effort of [undefined, 'high', 'ultracode']) for (const tools of [[], ['WebSearch']]) {
    const run = make => {
      const trace = [];
      const instance = make({ cmd: '/opt/claude', args: ['--verbose'], bridge: '/bridge.mjs', chatDisallowedTools: tools,
        resolveSessionWireModel: (model, options) => { trace.push(['model', model, options]); return model; },
        cliEffortLevel: value => value.effort, normalizeEffort: value => value,
        debugLogClaudeInvoke: (...args) => trace.push(['debug', ...args]), routerMcpNode: '/node', routerMcpScript: '/router.js' });
      const input = envelope({ first, effort }); input.spawnOpts.rawEffort = effort;
      const invocation = instance.buildInvocation(input);
      const terminal = instance.buildTerminalCmd({ model: 'opus', agent: 'reviewer', effort, cliSessionId: SESSION_UUID });
      const events = [{ type: 'system', subtype: 'init', model: 'opus' }, { type: 'system', subtype: 'sdk_error', error: 'upstream failed' },
        { type: 'result', subtype: 'success', is_error: false }, { type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: 'child' }, null];
      const decoded = events.map(event => instance.decodeEvent(event));
      assert.equal(decoded[0][0].raw, events[0], 'raw event identity survives the native boundary');
      return { invocation, terminal, decoded, trace };
    };
    assert.deepEqual(run(createClaudeAdapter), run(frozen), JSON.stringify({ first, effort, tools }));
  }
});

test('Rust startup cleanup matches frozen bytes and completes before the SDK child starts', async t => {
  const { getNative } = require('../src/native/runtime');
  const legacyFactory = frozenClaudeAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    '{"message":{"content":[{"type":"thinking","thinking":"  \\ufeff"},{"type":"text","text":"中文😀"}]}}\n',
    '{"message":{"content":[{"type":"thinking","thinking":""},null]}}\n',
    '{"message":{"content":[{"type":"thinking","thinking":0},{"type":"thinking","thinking":"kept"}]}}\n',
    '  null \nnot json\n  \n{"message":{"content":[{"type":"thinking","thinking":false}]},"2":"b","1":"a"}\n',
  ];
  const originalHome = os.homedir;
  for (let i = 0; i < cases.length; i++) {
    const homes = ['oracle', 'rust'].map(name => path.join(dir, `${i}-${name}`));
    const files = homes.map(home => path.join(home, '.claude/projects/project', `${SESSION_UUID}.jsonl`));
    for (const file of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, cases[i]); }
    let oldCount;
    try { os.homedir = () => homes[0]; oldCount = legacyFactory({}).prepareSpawn({ sessionId: SESSION_UUID }); }
    finally { os.homedir = originalHome; }
    let ticked = false;
    const scheduled = getNative().claudeAdapterPrepareSpawn(SESSION_UUID, () => homes[1]);
    Promise.resolve().then(() => { ticked = true; });
    assert.equal(await scheduled, oldCount, `count ${i}`);
    assert.equal(ticked, true, 'file work yields the host event loop');
    assert.deepEqual(fs.readFileSync(files[1]), fs.readFileSync(files[0]), `bytes ${i}`);
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/chat/claude-sdk-stream.js'), 'utf8');
  assert.match(source, /await cfg\.beforeSpawn\?\./, 'SDK startup waits for the asynchronous preparation port');
  const backend = fs.readFileSync(path.join(__dirname, '../native/addon/src/turn_engine/streaming/backend.rs'), 'utf8');
  assert.match(backend, /st\.callback\("invalidate", 1,[\s\S]{0,140}call\(cleaned, c"then", &\[cb\]\)/,
    '异步清理完成后才使旧准备失效，并将该 Promise 返回给 SDK');

});

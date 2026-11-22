'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { addUsage, appServerUsage, createCodexExpAdapter, isReconnectProgress, requestUserInputEvent } = require('../src/native/runtime').codexAppAdapter;
const { appendAdapterAssistantText } = require('../src/chat/turn-engine');
const createSessionRecordFactory = deps => require('../src/native/runtime').getNative().sessionCreateRecordFactory(deps, require('node:path'));
const { isResidentSession } = require('../src/cli/cli-capability');
const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');

function envelope({ first = true, threadId = null } = {}) {
  return {
    contextLayers: [], userText: 'hello', suffix: '', rolePrompt: 'reviewer',
    historyHandle: { isFirstTurn: first, cliSessionId: threadId },
    spawnOpts: { rawEffort: 'high', rawModel: 'gpt-5.5', effectiveModel: 'gpt-5.5' },
  };
}

test('codex-exp invocation is isolated and resumes its own app-server thread', () => {
  const adapter = createCodexExpAdapter({
    codexCmd: '/opt/codex', bridge: '/opt/codex-exp-bridge.cjs',
    codexReasoningLevel: () => 'high',
    codexReasoningConfigArg: () => 'model_reasoning_effort="high"',
    codexModelConfigArg: () => 'model="gpt-5.5"',
    routerMcpNode: '/opt/node', routerMcpScript: '/opt/router.cjs',
    envConstraint: 'ENV', multiccImgHint: 'IMG',
  });
  const invocation = adapter.buildInvocation(envelope({ first: false, threadId: 'thread-exp' }));
  assert.equal(adapter.name, 'codex-exp');
  assert.equal(invocation.cmd, process.execPath);
  assert.deepEqual(invocation.args.slice(0, 7), [
    '/opt/codex-exp-bridge.cjs', '--codex-bin', '/opt/codex', '--thread-id', 'thread-exp', '--model', 'gpt-5.5',
  ]);
  assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
  assert.ok(invocation.args.includes('mcp_servers.multicc_router.enabled=true'));
  assert.match(invocation.payload, /^ENV\n\nhello$/);
});

test('native deltas remain deltas while reasoning is one keyed snapshot', () => {
  const adapter = createCodexExpAdapter();
  const first = adapter.decodeEvent({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hel' } })[0];
  const second = adapter.decodeEvent({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'lo' } })[0];
  assert.equal(appendAdapterAssistantText(appendAdapterAssistantText('', first.text, first), second.text, second), 'Hello');
  const reasoning1 = adapter.decodeEvent({ method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: 'think' } })[0];
  const reasoning2 = adapter.decodeEvent({ method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: ' more' } })[0];
  assert.deepEqual(reasoning1, { type: 'thinking', id: 'r', text: 'think', snapshot: true, delta: true });
  assert.equal(reasoning2.id, 'r');
  assert.equal(reasoning2.text, 'think more');
});

test('app-server usage and terminal status normalize into existing contracts', () => {
  const adapter = createCodexExpAdapter();
  assert.deepEqual(appServerUsage({
    last: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 5, outputTokens: 7, reasoningOutputTokens: 3 },
    modelContextWindow: 258400,
  }), {
    input_tokens: 60, cached_input_tokens: 40, cache_creation_input_tokens: 5,
    output_tokens: 7, reasoning_output_tokens: 3, model_context_window: 258400,
    cache_read_input_tokens: 40,
  });
  assert.deepEqual(addUsage(
    { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7, model_context_window: 258400 },
    { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 },
  ), {
    input_tokens: 80, cached_input_tokens: 0, cache_read_input_tokens: 45,
    cache_creation_input_tokens: 4, output_tokens: 9, reasoning_output_tokens: 1,
    model_context_window: 258400,
  });
  const tracker = createAdapterCompletion(adapter);
  adapter.decodeEvent({ method: 'thread/tokenUsage/updated', params: {
    turnId: 'previous-turn', tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } },
  } });
  adapter.decodeEvent({ method: 'turn/started', params: { turn: { id: 't' } } });
  adapter.decodeEvent({ method: 'thread/tokenUsage/updated', params: {
    turnId: 't', tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 }, modelContextWindow: 258400 },
  } });
  adapter.decodeEvent({ method: 'thread/tokenUsage/updated', params: {
    turnId: 't', tokenUsage: { last: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 3 }, modelContextWindow: 258400 },
  } });
  const completed = { method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } };
  const completedEvents = adapter.decodeEvent(completed);
  tracker.observe(completed, completedEvents);
  assert.deepEqual(completedEvents[0].usage, {
    input_tokens: 100, cached_input_tokens: 50, cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
    model_context_window: 258400,
  });
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
  const interruptedTracker = createAdapterCompletion(adapter);
  const interrupted = { method: 'turn/completed', params: { turn: { id: 't2', status: 'interrupted' } } };
  interruptedTracker.observe(interrupted, adapter.decodeEvent(interrupted));
  assert.equal(interruptedTracker.finish({ kind: 'process', code: 0 }).state, 'cancelled');
});

test('codex-exp reconnect progress stays transient and a later completion succeeds', () => {
  const adapter = createCodexExpAdapter();
  const tracker = createAdapterCompletion(adapter);
  const reconnect = { method: 'error', params: { message: 'Reconnecting... 1/5' } };
  const progress = adapter.decodeEvent(reconnect);
  assert.deepEqual(progress, [{ type: 'activity', phase: 'recovering', message: 'Reconnecting... 1/5' }]);
  tracker.observe(reconnect, progress);

  const completed = { method: 'turn/completed', params: { turn: { id: 'after-reconnect', status: 'completed' } } };
  tracker.observe(completed, adapter.decodeEvent(completed));
  assert.equal(tracker.finish({ kind: 'stream', resolved: true }).state, 'completed');

  assert.equal(isReconnectProgress('Reconnecting... 5/5 (stream disconnected before completion)'), true);
  assert.equal(isReconnectProgress('upstream request failed'), false);
  assert.equal(adapter.decodeEvent({ method: 'error', params: { message: 'upstream request failed' } })[0].type, 'error');
});

test('native requestUserInput becomes the shared waiting signal', () => {
  assert.deepEqual(requestUserInputEvent({ questions: [{
    id: 'q1', header: 'Mode', question: 'Choose one',
    options: [{ label: 'Safe', description: 'Read only' }, { label: 'Fast', description: 'Full access' }],
  }] }), {
    type: 'user_input_signal', toolName: 'request_user_input', question: 'Mode\nChoose one',
    options: ['Safe', 'Fast'], allowMultiple: false,
    fallbackText: '**Mode**\nChoose one\n  - Safe：Read only\n  - Fast：Full access',
    log: 'native requestUserInput decoded to user_input_signal',
  });
});

test('codex-exp is chat-only at the canonical session boundary', async () => {
  const create = createSessionRecordFactory({
    isResidentSession, SUPPORTED_CHAT_CLIS,
    validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
  });
  assert.deepEqual(await create({ dir: { id: 'd' }, cli: 'codex-exp', kind: 'terminal' }), {
    ok: false, error: 'codex-exp only supports chat sessions',
  });
});

test('bridge performs initialize, thread/start and turn/start over JSON-RPC', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-exp-'));
  try {
    const logFile = path.join(root, 'requests.jsonl');
    const fakeCodex = path.join(root, 'codex');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=process.env.FAKE_CODEX_LOG;
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');
if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fake/'+(process.env.FAKE_CODEX_VERSION||'0.154.0')+' (test)',codexHome:'/tmp/codex',platformFamily:'unix',platformOs:'linux'}})+'\\n');
if(m.method==='thread/start'){process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'thread-live'}}})+'\\n');process.stdout.write(JSON.stringify({method:'thread/started',params:{thread:{id:'thread-live'}}})+'\\n');}
if(m.method==='thread/resume')process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:m.params.threadId}}})+'\\n');
if(m.method==='turn/start'){process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'turn-live'}}})+'\\n');process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'a',delta:'OK'}})+'\\n');process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-live',status:'completed'}}})+'\\n');}});
setInterval(()=>{},1000);
`, { mode: 0o755 });
    const result = spawnSync(require('../src/native/runtime').gatewayPath(), [
      'codex-app-bridge',
      '--codex-bin', fakeCodex, '--', 'hello bridge',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(output.map(item => item.method), ['thread/started', 'item/agentMessage/delta', 'turn/completed']);
    const requests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests.filter(item => item.id).map(item => item.method), ['initialize', 'thread/start', 'turn/start']);
    assert.equal(requests.find(item => item.method === 'turn/start').params.input[0].text, 'hello bridge');

    const resumed = spawnSync(require('../src/native/runtime').gatewayPath(), [
      'codex-app-bridge',
      '--codex-bin', fakeCodex, '--thread-id', 'thread-live', '--', 'hello again',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    const allRequests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const resume = allRequests.find(item => item.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'thread-live');
    assert.equal(resume.params.excludeTurns, true);

    const unsupported = spawnSync(require('../src/native/runtime').gatewayPath(), [
      'codex-app-bridge',
      '--codex-bin', fakeCodex, '--', 'old version',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile, FAKE_CODEX_VERSION: '0.153.9' }, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /requires Codex >= 0\.154\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('历史缺失恢复通知携带旧线程身份', () => {
  assert.deepEqual(createCodexExpAdapter().decodeEvent({
    method: 'multicc/native_session_missing', params: { threadId: 'old-thread' },
  }), [{ type: 'native_session_missing', sessionId: 'old-thread' }]);
});

function frozenCodexAdapter() {
  const Module = require('node:module'), crypto = require('node:crypto');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-codex-adapter.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '9f94b4cd6348e411e32fb09b77fdc5d0a75d48a5dfb6b7ce74eff821bf4cfecd');
  const filename = path.resolve(__dirname, '../src/cli-adapters/codex.js');
  const legacy = new Module(filename); legacy.filename = filename;
  legacy.paths = Module._nodeModulePaths(path.dirname(filename));
  legacy.require = function (id) {
    if (id === '../message-composer') return require('./helpers/legacy-message-composer');
    return Module.prototype.require.call(this, id);
  };
  legacy._compile(source, filename);
  return legacy.exports;
}

test('Rust Codex exec adapter matches frozen terminal, invocation, usage and shared MCP helpers', () => {
  const native = require('../src/native/runtime').codexAdapter, oracle = frozenCodexAdapter();
  for (const first of [false, true]) for (const effort of [null, 'high']) for (const hints of [false, true]) {
    const run = make => {
      const trace = [];
      const instance = make({ cmd: 'codex', args: ['--verbose'],
        codexReasoningConfigArg: session => { trace.push(['effort', session.effort]); return session.effort && `reasoning="${session.effort}"`; },
        codexModelConfigArg: session => { trace.push(['model', session.model]); return session.model && `model="${session.model}"`; },
        ...(hints ? { envConstraint: 'constraint', stayAlivePrompt: 'stay', multiccImgHint: 'images', routerMcpNode: '/node', routerMcpScript: '/router.js' } : {}) });
      const value = envelope({ first, threadId: 'thread-1' });
      Object.assign(value.spawnOpts, { rawEffort: effort, rawModel: 'model-1', effectiveModel: 'default' });
      return { invocation: instance.buildInvocation(value), terminal: instance.buildTerminalCmd({ model: 'model-1', effort, cliSessionId: 'thread-1', turnHookConfigArgs: ['hook=true'] }), trace };
    };
    assert.deepEqual(run(native.createCodexAdapter), run(oracle.createCodexAdapter), JSON.stringify({ first, effort, hints }));
  }
  for (const usage of [undefined, null, {}, { input_tokens: 50, cached_input_tokens: 20 }, { input_tokens: '20', cache_read_input_tokens: 7 }, { input_tokens: '-0' }, { input_tokens: 'bad' }, { input_tokens: Infinity, cached_input_tokens: Infinity }]) {
    assert.deepEqual(native.normalizeCodexUsage(usage), oracle.normalizeCodexUsage(usage));
  }
  for (const value of [null, {}, { result: { content: [{ type: 'text', text: '中文😀' }, { type: 'image', text: 'ignored' }] } }, { error: { code: 'upstream' } }, { result: 0 }, { result: 1n }]) {
    assert.deepEqual(native.mcpResultText(value), oracle.mcpResultText(value));
  }
  assert.deepEqual(native.routerMcpConfigArgs('/node', '/router.js'), oracle.routerMcpConfigArgs('/node', '/router.js'));
});

test('Rust Codex decoder matches every frozen event branch and preserves opaque tool arguments', () => {
  const native = require('../src/native/runtime').codexAdapter, oracle = frozenCodexAdapter();
  const options = { cmd: 'codex', isResponseCompletedDisconnect: text => /response-disconnect/.test(text), isTransportDisconnect: text => /transport-disconnect/.test(text) };
  const current = native.createCodexAdapter(options), legacy = oracle.createCodexAdapter(options);
  const items = [
    { type: 'mcp_tool_call', id: 'm', tool: 'search', arguments: '{"query":"x"}', result: { content: [{ type: 'text', text: 'found' }] } },
    { type: 'collab_tool_call', id: 'a', tool: 'wait', receiver_thread_ids: [], agents_states: { child: { status: 'completed', message: 'done' } } },
    { type: 'collab_tool_call', id: 'b', tool: 'spawn_agent', prompt: 'review', receiver_thread_ids: ['child'] },
    { type: 'function_call', call_id: 'f', name: 'exec', arguments: '1', output: 'done' },
    { type: 'custom_tool_call', call_id: 'c', name: 'custom', arguments: 'raw' },
    { type: 'command_execution', id: 'cmd', command: 'pwd', aggregated_output: '/work', exit_code: '0' },
    { type: 'function_call', id: 'q', name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{ header: '目录', question: '选哪个？', options: [{ label: '本地', description: '当前机器' }, 'remote'] }] }) },
    { type: 'function_call', id: 'bad', name: 'request_user_input', arguments: 'not json' },
    { type: 'agent_message', text: '答案' }, { type: 'reasoning', id: 'reason', text: '思考' }, { type: 'other' },
  ];
  const events = [null, 1, { type: 'thread.started', thread_id: 'thread' }, { type: 'thread.started' }, { type: 'turn.started' },
    ...['item.started', 'item.completed'].flatMap(type => items.map(item => ({ type, item }))),
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 3 } },
    ...['error', 'turn.failed'].flatMap(type => ['HTTP 429: limited', 'failed to load skill', 'response-disconnect', 'transport-disconnect', 'raw {"error":{"message":"拒绝","code":"bad","status_code":401,"request_id":"request","param":"model"}}'].map(message => ({ type, message }))),
  ];
  for (const event of events) assert.deepEqual(current.decodeEvent(event), legacy.decodeEvent(event), JSON.stringify(event));
  const opaque = { command: 'x' };
  const event = { type: 'item.started', item: { type: 'mcp_tool_call', arguments: opaque } };
  assert.equal(current.decodeEvent(event)[0].input, opaque);
});

test('Rust shared MCP text keeps filter and text getter ordering', () => {
  const run = api => {
    const trace = [];
    const content = ['a', 'b'].map(value => ({ get type() { trace.push(`type:${value}`); return 'text'; }, get text() { trace.push(`text:${value}`); return value; } }));
    const output = api.mcpResultText({ result: { content } });
    return { output, trace };
  };
  assert.deepEqual(run(require('../src/native/runtime').codexAdapter), run(frozenCodexAdapter()));
});

function frozenCodexAppAdapter() {
  const Module = require('node:module'), crypto = require('node:crypto');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-codex-app-adapter.js.txt'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '93cd19f3a09e1a818bd739a6acf0824cece4882af0e3444c1bdbf03bc6fe78f5');
  const filename = path.resolve(__dirname, '../src/cli-adapters/codex-exp.js');
  const legacy = new Module(filename); legacy.filename = filename;
  legacy.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = legacy.require.bind(legacy);
  legacy.require = name => name === '../native/runtime' ? { codexAdapter: frozenCodexAdapter() }
    : name === '../message-composer' ? require('./helpers/legacy-message-composer') : originalRequire(name);
  legacy._compile(source, filename);
  return legacy.exports;
}

test('Rust app-server 调用与纯函数逐项匹配冻结版本，保留实时依赖和方法接收者', () => {
  const oracle = frozenCodexAppAdapter(), native = require('../src/native/runtime').codexAppAdapter;
  for (const first of [false, true]) for (const effort of [null, 'high']) for (const hints of [false, true]) {
    const run = api => {
      const trace = [], deps = { bridge: '/bridge', codexCmd: '/codex', tag: 'live',
        codexReasoningLevel(session) { assert.equal(this, deps); trace.push(['level', this.tag, session]); return effort; },
        codexReasoningConfigArg(session) { assert.equal(this, deps); trace.push(['reasoning', session]); return effort && 'effort=high'; },
        codexModelConfigArg(session) { assert.equal(this, deps); trace.push(['model', session]); return 'model=gpt'; },
        ...(hints ? { multiccImgHint: '图片', envConstraint: '环境', routerMcpNode: '/node', routerMcpScript: '/router' } : {}) };
      const adapter = api.createCodexExpAdapter(deps);
      deps.codexCmd = '/codex-new'; deps.tag = 'changed';
      const env = envelope({ first, threadId: 'thread' }); env.subagentHint = '代理';
      return { invocation: adapter.buildInvocation(env), terminal: adapter.buildTerminalCmd(), trace };
    };
    assert.deepEqual(run(native), run(oracle));
  }
  for (const value of [undefined, null, {}, { last: {} }, { total: { inputTokens: '20', cachedInputTokens: 5n } },
    { last: { inputTokens: NaN, cachedInputTokens: Infinity, outputTokens: -0 }, modelContextWindow: 0 }]) {
    assert.deepEqual(native.appServerUsage(value), oracle.appServerUsage(value));
  }
  for (const current of [undefined, {}, { input_tokens: '4', output_tokens: 1n, model_context_window: 200 }]) {
    for (const next of [undefined, {}, { input_tokens: -0, output_tokens: Infinity, model_context_window: 0 }]) {
      assert.deepEqual(native.addUsage(current, next), oracle.addUsage(current, next));
    }
  }
  assert.throws(() => native.addUsage(null, {}));
  assert.throws(() => oracle.addUsage(null, {}));
  for (const value of ['', null, undefined, ' Reconnecting... 1/5 (网络) ', 'Reconnecting... 1/5\nterminal', 123, Symbol('x')]) {
    assert.equal(native.isReconnectProgress(value), oracle.isReconnectProgress(value));
  }
  const sparse = []; sparse[2] = { label: '末项' };
  for (const value of [null, {}, { questions: [] }, { questions: [{}] }, { questions: [{ header: '选择', question: '哪项', options: sparse }] },
    { questions: [{ header: '一', question: '甲', options: [{ label: 'A', description: '说明' }] }, { question: '乙', options: [] }] }]) {
    assert.deepEqual(native.requestUserInputEvent(value), oracle.requestUserInputEvent(value));
  }
  for (const value of [{ questions: [{ options: [null] }] }, { questions: [{}, null] }]) {
    assert.throws(() => native.requestUserInputEvent(value)); assert.throws(() => oracle.requestUserInputEvent(value));
  }
});

test('Rust app-server 覆盖所有事件分支并保留不透明工具输入引用', () => {
  const current = createCodexExpAdapter(), legacy = frozenCodexAppAdapter().createCodexExpAdapter();
  const items = [
    ...['spawnAgent', 'wait', 'sendInput', 'closeAgent', 'followupTask', 'sendMessage', 'resumeAgent', 'interruptAgent', 'listAgents', 'other', 'toString'].map(tool => ({ type: 'collabAgentToolCall', id: 'child', tool, prompt: '检查', receiverThreadIds: ['a'], agentsStates: { a: { status: 'completed', message: '好' }, b: null } })),
    ...[0, undefined, '1', null, 2n].map(exitCode => ({ type: 'commandExecution', id: 'cmd', command: 'pwd', cwd: '/work', exitCode, aggregatedOutput: '结果' })),
    { type: 'mcpToolCall', id: 'm', tool: 'search', arguments: { q: '查找' }, result: { content: [null, { type: 'image' }, { type: 'text', text: '甲' }, { type: 'text', text: 2 }] } },
    { type: 'mcpToolCall', id: 'm2', error: { message: '失败' } },
    { type: 'agentMessage', id: 'text', text: '快照' }, { type: 'reasoning', id: 'r', summary: ['想', '好'], content: ['后备'] },
    { type: 'reasoning', id: 'r', summary: [], content: ['内容'] }, { type: 'unknown' },
  ];
  const events = [null, {}, { method: 'unknown' }, { method: 'item/tool/requestUserInput', params: { questions: [{ question: '选哪项' }] } },
    { method: 'item/tool/requestUserInput' }, { id: 0, method: 'item/command/requestApproval' }, { method: 'item/command/requestApproval' },
    { method: 'multicc/native_session_missing', params: { threadId: 'old' } }, { method: 'thread/started', params: { thread: { sessionId: 's' } } },
    ...['idle', 'busy', undefined].map(type => ({ method: 'thread/status/changed', params: { status: { type } } })),
    ...items.flatMap(item => ['item/started', 'item/completed'].map(method => ({ method, params: { item } }))),
    { method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd', delta: '行' } },
    { method: 'item/mcpToolCall/progress', params: { message: '进度' } },
    ...['completed', 'failed', 'interrupted', undefined].map(status => ({ method: 'turn/completed', params: { turn: { id: 't', status } } })),
    ...['Reconnecting... 2/5', '真实错误'].map(message => ({ method: 'error', params: { error: { message } } })),
    ...['warning', 'configWarning', 'deprecationNotice'].map(method => ({ method, params: { summary: '提示' } })),
  ];
  for (const event of events) assert.deepEqual(current.decodeEvent(event), legacy.decodeEvent(event), JSON.stringify(event, (_, value) => typeof value === 'bigint' ? String(value) : value));
  const input = { self: null }; input.self = input;
  assert.equal(current.decodeEvent({ method: 'item/started', params: { item: { type: 'mcpToolCall', arguments: input } } })[0].input, input);
});

test('Rust app-server 多轮交错、键身份、回放去重、失败清理与状态槽复用均匹配冻结版本', () => {
  const current = createCodexExpAdapter(), legacy = frozenCodexAppAdapter().createCodexExpAdapter();
  const compare = event => assert.deepEqual(current.decodeEvent(event), legacy.decodeEvent(event));
  const objectKey = {}, otherKey = {};
  const keys = [undefined, null, NaN, 0, -0, 1, '1', false, '', objectKey, otherKey];
  for (let round = 0; round < 30; round++) {
    for (const id of keys) {
      compare({ method: 'thread/tokenUsage/updated', params: { turnId: id, tokenUsage: { last: { inputTokens: 9000 } } } });
      compare({ method: 'turn/started', params: { turn: { id } } });
      compare({ method: 'item/agentMessage/delta', params: { itemId: id, delta: '中文😀' } });
      compare({ method: 'item/reasoning/textDelta', params: { itemId: id, delta: '思' } });
      compare({ method: 'item/reasoning/summaryTextDelta', params: { itemId: id, delta: '考' } });
      for (const inputTokens of [5, 3]) compare({ method: 'thread/tokenUsage/updated', params: { turnId: id, tokenUsage: { last: { inputTokens, cachedInputTokens: 1, outputTokens: 2 } } } });
    }
    for (const [index, id] of keys.entries()) {
      compare({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text: '不重复' } } });
      compare({ method: 'item/completed', params: { item: { type: 'agentMessage', id, text: '下一次快照' } } });
      compare({ method: 'item/completed', params: { item: { type: 'reasoning', id } } });
      compare({ method: 'item/completed', params: { item: { type: 'reasoning', id } } });
      compare({ method: 'turn/completed', params: { turn: { id, status: ['completed', 'failed', 'interrupted'][index % 3] } } });
      compare({ method: 'thread/tokenUsage/updated', params: { turnId: id, tokenUsage: { last: { inputTokens: 9000 } } } });
      compare({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
    }
  }
});

test('Rust app-server 保留 getter 顺序、异常后的状态与重入安全', () => {
  const run = make => {
    const adapter = make(), trace = [];
    const content = ['甲', '乙'].map(value => ({ get type() { trace.push(`type:${value}`); return 'text'; }, get text() { trace.push(`text:${value}`); return value; } }));
    const output = adapter.decodeEvent({ method: 'item/completed', params: { item: { type: 'mcpToolCall', result: { content } } } });
    const fault = new Error('getter 故障');
    assert.throws(() => adapter.decodeEvent({ method: 'item/agentMessage/delta', params: { itemId: 'x', get delta() { throw fault; } } }), error => error === fault);
    const afterFault = adapter.decodeEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'x', text: '已标记' } } });
    adapter.decodeEvent({ method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: '原' } });
    const reentrant = adapter.decodeEvent({ method: 'item/reasoning/textDelta', params: { itemId: 'r', get delta() {
      trace.push('reenter'); adapter.decodeEvent({ method: 'item/completed', params: { item: { type: 'reasoning', id: 'r' } } }); return '后';
    } } });
    return { output, trace, afterFault, reentrant };
  };
  assert.deepEqual(run(createCodexExpAdapter), run(frozenCodexAppAdapter().createCodexExpAdapter));
});

test('Rust app-server 事件属性读取顺序与冻结版本一致', () => {
  const seeds = [
    { method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'x', tool: 'wait', prompt: 'p' } } },
    { method: 'item/started', params: { item: { type: 'commandExecution', id: 'x', command: 'pwd' } } },
    { method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'x', tool: 'search' } } },
    ...['collabAgentToolCall', 'agentMessage', 'reasoning', 'commandExecution', 'mcpToolCall', 'unknown'].map(type => ({ method: 'item/completed', params: { item: { type, id: 'x', text: '正文', command: 'pwd', status: 'failed' } } })),
    { method: 'turn/completed', params: { turn: { id: 'x', status: 'failed' } } },
    { method: 'thread/started', params: { thread: { id: 's' } } },
  ];
  for (const seed of seeds) {
    const run = make => {
      const trace = [];
      const wrap = (value, prefix) => value && typeof value === 'object' && !Array.isArray(value) ? new Proxy(value, { get(target, key) {
        trace.push(`${prefix}.${String(key)}`); return wrap(Reflect.get(target, key), `${prefix}.${String(key)}`);
      } }) : value;
      const output = make().decodeEvent(wrap(seed, 'event'));
      return { output, trace: [...trace] };
    };
    assert.deepEqual(run(createCodexExpAdapter), run(frozenCodexAppAdapter().createCodexExpAdapter), seed.method);
  }
});

function legacyBridgeCommand(root) {
  const Module = require('node:module');
  const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-codex-app-server-bridge.cjs.txt'), 'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'), '476e2fbb25a2b171afb1090e8665c81d220a8f1e71758d0d4dc6712b7f338004');
  const filename = path.resolve(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs');
  const launcher = path.join(root, 'legacy-bridge.cjs');
  // Compile the frozen source under its original directory so only transport
  // imports need no path rewrites. The frozen background owner is independent.
  fs.writeFileSync(launcher, `const Module=require('node:module');const fs=require('node:fs');const path=require('node:path');
const filename=${JSON.stringify(filename)},source=${JSON.stringify(source)};
const legacy=new Module(filename);legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));
const req=legacy.require.bind(legacy);legacy.require=name=>{
 if(name!=='./codex-background-events.cjs')return req(name);
 const bgFile=path.join(path.dirname(filename),'codex-background-events.cjs');const bg=new Module(bgFile);
 bg.filename=bgFile;bg.paths=Module._nodeModulePaths(path.dirname(bgFile));bg._compile(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'helpers/legacy-codex-background-events.cjs.txt'))},'utf8'),bgFile);return bg.exports;
};legacy._compile(source,filename);`);
  return { cmd: process.execPath, args: [launcher] };
}

test('Rust 进程桥与冻结 Node 桥的通知原始字节及 RPC 副作用一致', { timeout: 20_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-bridge-parity-'));
  try {
    const { writeFakeAppServer } = require('./helpers/fake-codex-app-server');
    const binary = writeFakeAppServer(root), legacy = legacyBridgeCommand(root);
    const rust = { cmd: require('../src/native/runtime').gatewayPath(), args: ['codex-app-bridge'] };
    for (const scenario of [
      {}, { prompt: '--help' }, { prompt: '--version' }, { args: ['--thread-id', 'saved'] }, { env: { FAKE_CODEX_REJECT: 'thread/start' } },
      { env: { FAKE_CODEX_VERSION: '0.153.9' } },
      { args: ['--thread-id', 'old'], env: { FAKE_CODEX_REJECT: 'thread/resume', FAKE_CODEX_REJECT_MESSAGE: 'no rollout found for thread id' } },
      { args: ['--thread-id', 'old'], env: { FAKE_CODEX_REJECT: 'thread/resume', FAKE_CODEX_REJECT_MESSAGE: 'HTTP 401: unauthorized' } },
    ]) {
      const run = (command, tag) => {
        const logFile = path.join(root, `${tag}.jsonl`); fs.writeFileSync(logFile, '');
        const result = spawnSync(command.cmd, [...command.args, '--codex-bin', binary, ...(scenario.args || []), '--', scenario.prompt || '中文😀'], {
          cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile, ...scenario.env }, encoding: 'utf8', timeout: 6000,
        });
        assert.equal(result.error, undefined);
        return { status: result.status, stdout: result.stdout, stderr: result.stderr, requests: fs.readFileSync(logFile, 'utf8') };
      };
      assert.deepEqual(run(rust, 'rust'), run(legacy, 'legacy'), JSON.stringify(scenario));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

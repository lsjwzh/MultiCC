'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createAcpAdapter } = require('../src/cli-adapters/acp');
const { createOpencodeAdapter } = require('../src/cli-adapters/opencode');
const { createGeminiAdapter } = require('../src/cli-adapters/gemini');
const { createGrokAdapter } = require('../src/cli-adapters/grok');
const { createAgyAdapter } = require('../src/cli-adapters/agy');
const { pickPermissionOption, routerMcpServers } = require('../src/cli-adapters/acp-bridge.cjs');

const BRIDGE = path.join(__dirname, '..', 'src', 'cli-adapters', 'acp-bridge.cjs');

// A scripted ACP agent: enough of the protocol to drive the bridge through
// handshake, config, one streamed turn with a permissioned tool, cancel and
// resume. Its argv[2] selects behaviour; it logs every request to argv[3].
const FAKE_AGENT = `
const readline = require('readline');
const fs = require('fs');
const [mode, logPath] = process.argv.slice(2);
let next = 1000;
const pending = new Map();
let cancelled = null;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(m) + '\\n');
  if (m.id != null && !m.method) { const r = pending.get(m.id); pending.delete(m.id); r && r(m); return; }
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake' }, authMethods: [{ id: 'login', description: 'run fake login' }] });
  if (m.method === 'session/new') {
    if (mode === 'auth') return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    return reply({ sessionId: 'ses_new', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'm/default', options: [{ value: 'm/default' }, { value: 'm/fast' }] }] });
  }
  if (m.method === 'session/load') {
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
    return reply({});
  }
  if (m.method === 'session/set_config_option') return reply({ configOptions: [] });
  if (m.method === 'session/cancel') { cancelled && cancelled(); return; }
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    if (mode === 'context-usage') {
      update('different-session', { sessionUpdate: 'usage_update', used: 999, size: 1000 });
      update(sid, { sessionUpdate: 'usage_update', used: 1024, size: 65536 });
      update(sid, { sessionUpdate: 'usage_update', used: 999999, size: 65536 });
      return reply({ stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 4, cachedReadTokens: 2 } });
    }
    if (mode === 'native-usage' || mode === 'native-usage-rpc') {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.env.ACP_TEST_DB);
      const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
      for (const [id, time, input] of [['new1', 2, 100], ['new2', 3, 200]]) {
        insert.run(id, sid, time, JSON.stringify({ role: 'assistant', tokens: { input, output: 10, cache: { read: 5, write: 0 } } }));
      }
      db.close();
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成' } });
      return reply({ stopReason: 'end_turn', ...(mode === 'native-usage-rpc'
        ? { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } : {}) });
    }
    if (mode === 'context') return send({ id: m.id, error: {
      code: -32603, message: 'Internal error: Conversation history too large to compact - exceeds model context limit',
      data: { service: 'session', errorName: 'ContextOverflowError' },
    } });
    if (mode === 'context-name') return send({ id: m.id, error: {
      code: -32603, message: 'Internal error', data: { errorName: 'ContextOverflowError' },
    } });
    if (mode === 'hang') { cancelled = () => reply({ stopReason: 'cancelled' }); return; }
    update(sid, { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'think' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    const id = next++;
    pending.set(id, (answer) => {
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] });
      update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'done:' + answer.result.outcome.optionId } });
      reply({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedReadTokens: 1 } });
    });
    send({ id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'c1', title: 'ls' }, options: [{ optionId: 'rej', kind: 'reject_once' }, { optionId: 'ok', kind: 'allow_once' }] } });
  }
});
`;

function runBridge(args, { signalAfterMs = 0, nativeUsage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-test-'));
  const agent = path.join(dir, 'agent.js');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(agent, FAKE_AGENT);
  const env = { ...process.env };
  if (nativeUsage) {
    const dbPath = path.join(dir, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new (require('better-sqlite3'))(dbPath);
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('old', 'ses_old', 1,
      JSON.stringify({ role: 'assistant', tokens: { input: 9999, output: 999 } }));
    db.close();
    env.XDG_DATA_HOME = dir;
    env.ACP_TEST_DB = dbPath;
  }
  const [mode, ...rest] = args;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, '--agent-bin', process.execPath,
      '--agent-arg', agent, '--agent-arg', mode, '--agent-arg', log, '--label', 'Fake', ...rest], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    if (signalAfterMs) setTimeout(() => child.kill('SIGTERM'), signalAfterMs);
    child.on('close', (code) => {
      const events = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const requests = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, events, requests });
    });
  });
}

test('第三方 OpenCode 没有返回 ACP 用量时，从本轮原生消息补齐且不重复统计旧历史', async () => {
  const { code, events } = await runBridge(['native-usage', '--native-usage', 'opencode',
    '--session-id', 'ses_old', '--', '继续'], { nativeUsage: true });
  assert.equal(code, 0);
  const result = events.find(e => e.method === 'multicc/turnEnd');
  assert.equal(result.params.usage.input_tokens, 300);
  assert.equal(result.params.usage.output_tokens, 20);
  assert.equal(result.params.usage.cache_read_input_tokens, 10);
  assert.equal(result.params.usage.context_tokens, 215);
  const [decoded] = createOpencodeAdapter({ cmd: 'opencode', env: {} }).decodeEvent(result);
  assert.equal(decoded.usage.input_tokens, 300);
});

test('ACP 已返回有效用量时保留原值，原生记录只补充上下文水位', async () => {
  const { events } = await runBridge(['native-usage-rpc', '--native-usage', 'opencode',
    '--session-id', 'ses_old', '--', '继续'], { nativeUsage: true });
  const usage = events.find(e => e.method === 'multicc/turnEnd').params.usage;
  assert.equal(usage.input_tokens, 7);
  assert.equal(usage.output_tokens, 3);
  assert.equal(usage.context_tokens, 215);
});

function envelope({ first = true, sessionId = null, model = null, effort = null, agent = null } = {}) {
  return {
    contextLayers: [], userText: 'hello', suffix: '', rolePrompt: first ? 'reviewer' : '',
    historyHandle: { isFirstTurn: first, cliSessionId: sessionId },
    spawnOpts: { rawModel: model, rawEffort: effort, rawAgent: agent },
  };
}

test('bridge streams one turn, auto-approves permission and reports the stop reason', async () => {
  const { code, events, requests } = await runBridge(['ok', '--model', 'm/fast', '--', 'hi']);
  assert.equal(code, 0);
  assert.deepEqual(events[0], { method: 'multicc/session', params: { sessionId: 'ses_new', resumed: false, agentInfo: { name: 'fake' } } });
  const setConfig = requests.find(r => r.method === 'session/set_config_option');
  assert.deepEqual(setConfig.params, { sessionId: 'ses_new', configId: 'model', value: 'm/fast' });
  const prompt = requests.find(r => r.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'hi' }]);
  assert.ok(events.some(e => e.method === 'multicc/permission' && e.params.optionId === 'ok'));
  const end = events.at(-1);
  assert.equal(end.method, 'multicc/turnEnd');
  assert.equal(end.params.stopReason, 'end_turn');
  assert.deepEqual(end.params.usage, { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 });

  const adapter = createAcpAdapter({ name: 'fake', label: 'Fake', cmd: 'fake' });
  const tracker = createAdapterCompletion(adapter);
  const decoded = [];
  for (const event of events) {
    const out = adapter.decodeEvent(event);
    tracker.observe(event, out);
    decoded.push(...out);
  }
  assert.deepEqual(decoded.map(e => e.type), [
    'session_started', 'thinking', 'thinking', 'tool_update', 'tool_update', 'assistant_text', 'complete',
  ]);
  assert.equal(decoded[1].delta, true);
  assert.equal(decoded[2].completed, true);
  assert.equal(decoded[4].completed, true);
  assert.equal(decoded[4].content, 'a.txt');
  assert.equal(decoded[4].name, 'execute');
  assert.deepEqual(decoded[5], { type: 'assistant_text', text: 'done:ok', delta: true });
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
});

test('ACP context updates retain the last valid session measurement with turn usage', async () => {
  const { code, events } = await runBridge(['context-usage', '--', '你好']);
  assert.equal(code, 0);
  const usage = events.find(e => e.method === 'multicc/turnEnd').params.usage;
  assert.equal(usage.input_tokens, 30);
  assert.equal(usage.output_tokens, 4);
  assert.equal(usage.cache_read_input_tokens, 2);
  assert.equal(usage.context_tokens, 1024);
  assert.equal(usage.context_window, 65536);
  assert.equal(usage.usage_source, 'acp');
});

test('bridge rejects a model the agent does not offer before prompting', async () => {
  const { code, events, requests } = await runBridge(['ok', '--model', 'nope', '--', 'hi']);
  assert.equal(code, 1);
  const error = events.find(e => e.method === 'multicc/error');
  assert.match(error.params.message, /no model "nope".*m\/default/);
  assert.equal(error.params.phase, 'config');
  assert.ok(!requests.some(r => r.method === 'session/prompt'));
});

test('resume via session/load suppresses replayed history', async () => {
  const { events, requests } = await runBridge(['ok', '--session-id', 'ses_old', '--', 'again']);
  assert.ok(requests.some(r => r.method === 'session/load' && r.params.sessionId === 'ses_old'));
  assert.deepEqual(events[0].params, { sessionId: 'ses_old', resumed: true, agentInfo: { name: 'fake' } });
  assert.ok(!JSON.stringify(events).includes('REPLAYED'));
});

test('SIGTERM cancels the turn in place before stopping the agent', async () => {
  const { code, events, requests } = await runBridge(['hang', '--', 'long'], { signalAfterMs: 400 });
  assert.ok(requests.some(r => r.method === 'session/cancel'));
  assert.equal(events.at(-1).params.stopReason, 'cancelled');
  assert.equal(code, 1);
  const adapter = createAcpAdapter({ name: 'fake', label: 'Fake', cmd: 'fake' });
  const tracker = createAdapterCompletion(adapter);
  for (const event of events) tracker.observe(event, adapter.decodeEvent(event));
  assert.equal(tracker.finish({ kind: 'process', code: 1 }).state, 'cancelled');
});

test('auth failures carry the agent login hint', async () => {
  const { events } = await runBridge(['auth', '--', 'hi']);
  const error = events.find(e => e.method === 'multicc/error');
  assert.match(error.params.message, /Authentication required \(run fake login\)/);
  assert.equal(error.params.code, 'auth_required');
});

test('OpenCode ACP context errors survive the bridge and fail without replaying the prompt', async () => {
  const { createApiErrorPolicyRuntime, retryNotice } = require('../src/chat/api-error-policy');
  const { planTurnFinalization, resolveTurnFinalization } = require('../src/chat/finalize-plan');
  for (const mode of ['context', 'context-name']) {
    const { code, events, requests } = await runBridge([mode, '--session-id', 'ses_old', '--', 'continue']);
    assert.equal(code, 1);
    assert.equal(requests.filter(r => r.method === 'session/prompt').length, 1);
    const error = events.find(e => e.method === 'multicc/error');
    assert.equal(error.params.rpcError.code, -32603);
    assert.equal(error.params.rpcError.data.errorName, 'ContextOverflowError');
    const adapter = createOpencodeAdapter({ cmd: 'opencode', env: {} });
    const tracker = createAdapterCompletion(adapter);
    for (const event of events) tracker.observe(event, adapter.decodeEvent(event));
    assert.equal(tracker.finish({ kind: 'process', code }).state, 'failed');
    assert.equal(events.some(e => e.method === 'multicc/turnEnd'), false);
    const [decoded] = adapter.decodeEvent(error);
    assert.equal(decoded.error.code, -32603);
    assert.match(decoded.message, /上下文上限/);
    assert.match(decoded.message, /压缩上下文.*保留完整聊天历史/);
    assert.doesNotMatch(decoded.message, /Internal error|无响应|\[Object/);
    const decision = createApiErrorPolicyRuntime().evaluate(decoded.error, { phase: 'before_first_token' });
    assert.equal(decision.error.category, 'context_token_limit');
    assert.equal(decision.action, 'fail_fast');
    assert.equal(decision.error.safeToRetry, false);
    assert.match(retryNotice(decision), /上下文超限，未自动重试/);
    for (const isRetry of [false, true]) {
      const plan = planTurnFinalization({ current: true, runnerKind: 'process', cli: 'opencode',
        code, hasOutput: false, isRetry, adapterError: true, apiError: true, apiErrorDecision: decision });
      assert.equal(plan.action, 'finalize');
      assert.ok(!resolveTurnFinalization(plan).effects.some(e => e.type === 'report-empty-retry-failure'));
    }
  }
});

test('OpenCode legacy JSON context failures use the same structured diagnosis', () => {
  const adapter = createOpencodeAdapter({ cmd: 'opencode', env: { MULTICC_OPENCODE_LEGACY_JSON: '1' } });
  const [decoded] = adapter.decodeEvent({ type: 'error', error: {
    name: 'ContextOverflowError', data: { message: 'Internal error' },
  } });
  const { normalizeApiError } = require('../src/chat/api-error-policy');
  const normalized = normalizeApiError(decoded.error);
  assert.equal(normalized.category, 'context_token_limit');
  assert.equal(decoded.error.error.name, 'ContextOverflowError');
  assert.equal(normalized.diagnosis.recovery.context, 'rotate');
  assert.match(decoded.message, /保留完整聊天历史/);
  const [unrelated] = adapter.decodeEvent({ type: 'error', error: { data: { message: 'HTTP 401 Unauthorized' } } });
  assert.equal(unrelated.message, 'HTTP 401 Unauthorized');
});

test('协议投影保留数值码和嵌套类型，巨大文案不会挤掉类型或带入请求正文', () => {
  const { errorFields, classifyProviderError } = require('../src/provider-error');
  const wire = errorFields({ code: -32603, message: 'x'.repeat(100000), data: {
    errorName: 'ContextOverflowError', statusCode: 400,
    prompt: { message: '不得透传的请求正文' }, authorization: '不得透传的认证字段',
  } });
  assert.equal(wire.code, -32603);
  assert.equal(wire.data.errorName, 'ContextOverflowError');
  assert.equal(wire.data.statusCode, 400);
  assert.equal(wire.message.length, 65536);
  assert.equal(wire.data.prompt, undefined);
  assert.equal(wire.data.authorization, undefined);
  const failure = classifyProviderError(wire, { provider: 'opencode', source: 'opencode_event' });
  assert.equal(failure.diagnosis.recovery.context, 'rotate');
  assert.equal(failure.diagnosis.evidence.path, '$.data.errorName');
});

test('permission and router MCP helpers', () => {
  assert.equal(pickPermissionOption([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_always' }]).optionId, 'b');
  assert.equal(pickPermissionOption([]), null);
  assert.deepEqual(routerMcpServers({ command: '/n', script: '/r.js' }, { MULTICC_SESSION_ID: 's1', OTHER: 'x' }), [
    { name: 'multicc_router', command: '/n', args: ['/r.js'], env: [{ name: 'MULTICC_SESSION_ID', value: 's1' }] },
  ]);
});

test('opencode defaults to ACP and grok launches its ACP server', () => {
  const opencode = createOpencodeAdapter({ cmd: '/bin/opencode', routerMcpNode: '/n', routerMcpScript: '/r.js', userInputReminder: 'R' });
  const inv = opencode.buildInvocation(envelope({ first: false, sessionId: 'ses_1', model: 'p/m', effort: 'high', agent: 'plan' }));
  assert.equal(inv.cmd, process.execPath);
  assert.deepEqual(inv.args.slice(1), [
    '--agent-bin', '/bin/opencode', '--label', 'OpenCode', '--native-usage', 'opencode', '--agent-arg', 'acp', '--session-id', 'ses_1',
    '--model', 'p/m', '--effort', 'high', '--mode', 'plan', '--router-mcp', '/n', '/r.js', '--',
  ]);
  assert.equal(inv.payload, 'R\n\nhello');
  assert.equal(opencode.protocol, 'acp');
  assert.equal(opencode.buildTerminalCmd({ model: 'p/m', effort: 'max', agent: 'build', cliSessionId: 'ses_1' }),
    '/bin/opencode --model p/m --variant max --agent build --session ses_1');

  const gemini = createGeminiAdapter({ cmd: 'gemini' });
  const geminiArgs = gemini.buildInvocation(envelope({ model: 'gemini-2.5-pro', effort: 'high' })).args;
  assert.deepEqual(geminiArgs.slice(1), [
    '--agent-bin', 'gemini', '--label', 'Gemini', '--agent-arg', '--experimental-acp', '--agent-arg', '--yolo',
    '--agent-arg', '-m', '--agent-arg', 'gemini-2.5-pro', '--',
  ]);
  assert.match(gemini.buildInvocation(envelope()).payload, /^\[Role prompt\]\nreviewer/);

  const grok = createGrokAdapter({ cmd: 'grok' });
  const grokArgs = grok.buildInvocation(envelope({ model: 'grok-4.6', effort: 'high' })).args;
  const agentArgv = grokArgs.filter((_, index) => grokArgs[index - 1] === '--agent-arg');
  assert.deepEqual(agentArgv, ['agent', '--no-leader', '--always-approve', '-m', 'grok-4.6', '--reasoning-effort', 'high', 'stdio']);
  assert.ok(!grokArgs.includes('--model') && !grokArgs.includes('--effort'));
});

test('Antigravity uses ACP session resume and model configuration', () => {
  const adapter = createAgyAdapter({ cmd: '/bin/agy', routerMcpNode: '/node', routerMcpScript: '/router' });
  const inv = adapter.buildInvocation(envelope({ first: false, sessionId: 'session-1', model: 'gemini-4-argon', effort: 'low' }));
  assert.deepEqual(inv.args.slice(1), [
    '--agent-bin', '/bin/agy', '--label', 'Antigravity', '--agent-arg', 'acp',
    '--agent-arg', '--dangerously-skip-permissions', '--session-id', 'session-1',
    '--model', 'gemini-4-argon', '--effort', 'low', '--router-mcp', '/node', '/router',
    // agy 的账号 HOME 由父进程的 buildChildEnv 钉好，桥进程继承，不再走参数。
    '--',
  ]);
  assert.equal(inv.payload, 'hello');
  assert.equal(adapter.buildTerminalCmd({ model: 'gemini-4-argon', cliSessionId: 'session-1' }),
    "'/bin/agy' --model 'gemini-4-argon' --conversation 'session-1'");
  assert.equal(adapter.buildTerminalCmd({ cliSessionId: "abc'; touch /tmp/no; '" }),
    "'/bin/agy' --conversation 'abc'\"'\"'; touch /tmp/no; '\"'\"''");
});

test('tool cards wait for real input and are announced once', () => {
  const adapter = createAcpAdapter({ name: 'fake', label: 'Fake', cmd: 'fake' });
  const call = (update) => adapter.decodeEvent({ method: 'session/update', params: { sessionId: 's', update } });
  assert.deepEqual(call({ sessionUpdate: 'tool_call', toolCallId: 't', kind: 'read', title: 'read', status: 'pending', rawInput: {} }), []);
  const [started] = call({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress', rawInput: { filePath: '/a' } });
  assert.deepEqual(started.input, { filePath: '/a' });
  assert.equal(started.completed, false);
  assert.deepEqual(call({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress', rawInput: { filePath: '/a' } }), []);
  const [done] = call({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }] });
  assert.equal(done.completed, true);
  assert.equal(done.isError, true);
  assert.equal(done.content, 'ENOENT');
});

test('non-success stop reasons surface as errors', () => {
  const adapter = createAcpAdapter({ name: 'fake', label: 'Fake', cmd: 'fake' });
  const [maxTokens] = adapter.decodeEvent({ method: 'multicc/turnEnd', params: { sessionId: 's', stopReason: 'max_tokens' } });
  assert.equal(maxTokens.type, 'error');
  assert.equal(maxTokens.error.code, 'max_tokens');
  const [cancelled] = adapter.decodeEvent({ method: 'multicc/turnEnd', params: { sessionId: 's', stopReason: 'cancelled' } });
  assert.equal(cancelled.kind, 'cancelled');
  assert.deepEqual(adapter.decodeEvent({ method: 'multicc/notice', params: { message: 'm' } }), [{ type: 'activity', phase: 'warning', message: 'm' }]);
});


test('Gemini resolves to its real adapter when registered', () => {
  const { createCliProviderRegistry } = require('../src/native/runtime');
  const fallback = { name: 'claude', buildInvocation: () => ({ cmd: 'claude' }), decodeEvent: () => [] };
  const gemini = createGeminiAdapter({ cmd: 'gemini' });
  const registry = createCliProviderRegistry([fallback, gemini]);
  assert.equal(registry.get('gemini').name, 'gemini');
  assert.match(registry.get('gemini').buildTerminalCmd({}), /^gemini/);
  // An unregistered lane still falls back — the registry never invents an adapter.
  assert.equal(createCliProviderRegistry([fallback]).get('gemini').name, 'claude');
});

// Byte-identical oracle from 83c714ba; it imports no production modules.
const legacyRegistry = require('./helpers/legacy-cli-provider-registry').createCliProviderRegistry;
const nativeRegistry = require('../src/native/runtime').createCliProviderRegistry;
const registryAdapter = name => ({ name, buildInvocation() { return this; }, decodeEvent() { return []; } });

function registryOutcome(run) {
  try { return { value: run() }; }
  catch (error) { return { name: error.name, message: error.message, code: error.code }; }
}

test('Rust CLI registry preserves opaque keys, replacement order, adapter identity and detached snapshots', () => {
  const symbol = Symbol('provider'), object = { toString: () => 'object-name' };
  const names = ['claude', 'codex', 'gemini', ' GEMINI ', '__proto__', 'constructor', '2', '1',
    symbol, object, true, 1, NaN, '', 0, null, undefined];
  let comparisons = 0;
  for (const name of names) {
    const fallback = registryAdapter('claude'), first = registryAdapter(name), last = registryAdapter(name);
    const input = [null, undefined, false, 0, '', fallback, first, last];
    const old = legacyRegistry(input), actual = nativeRegistry(input);
    assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(old));
    assert.deepEqual(Reflect.ownKeys(actual.providers), Reflect.ownKeys(old.providers));
    assert.deepEqual(Object.getOwnPropertyDescriptors(actual.providers), Object.getOwnPropertyDescriptors(old.providers));
    assert.equal(Object.getPrototypeOf(actual.providers), Object.prototype);
    for (const query of [name, 'claude', 'codex', 'missing', undefined, null, false, '', symbol, object]) {
      const expected = old.get(query), got = actual.get(query);
      if (expected.name === 'gemini' && Object.isFrozen(expected)) {
        assert.equal(got.name, expected.name);
        assert.equal(got.buildTerminalCmd(), expected.buildTerminalCmd());
      } else assert.equal(got, expected);
      comparisons++;
    }
    actual.providers.claude = registryAdapter('replacement');
    old.providers.claude = registryAdapter('replacement');
    assert.equal(actual.get('claude'), old.get('claude'), 'snapshot writes do not replace the lookup table');
    delete actual.providers.claude;
    assert.equal(actual.get('claude'), old.get('claude'));
  }
  assert.equal(comparisons, 170);
  const chosen = registryAdapter(object);
  assert.equal(nativeRegistry([chosen], object).get('unknown'), chosen);
  assert.equal(nativeRegistry([chosen], object).get(object), chosen);
});

test('Rust CLI registry retains validation messages and fallback coercion without adding error codes', () => {
  const fallback = registryAdapter('claude');
  for (const adapter of [{ name: 'bad' }, { name: 'bad', buildInvocation() {} },
    { name: Symbol('bad') }, { name: { toString: () => 'named-object' } },
    { name: 'bad', buildInvocation: 1, decodeEvent() {} }]) {
    assert.deepEqual(registryOutcome(() => nativeRegistry([fallback, adapter])),
      registryOutcome(() => legacyRegistry([fallback, adapter])));
  }
  for (const name of [undefined, null, '', false, 0, 'missing', Symbol('missing'),
    { toString: () => 'missing-object' }]) {
    assert.deepEqual(registryOutcome(() => nativeRegistry([], name)),
      registryOutcome(() => legacyRegistry([], name)));
  }
  for (const invalid of [null, undefined, false, 0, {}]) {
    assert.throws(() => nativeRegistry(invalid), TypeError);
    assert.throws(() => legacyRegistry(invalid), TypeError);
  }
});

test('Rust CLI registry matches iterable closing, lazy getters, reentry and thrown object identities', () => {
  function exercise(create, fail, closeFails) {
    const trace = [], fault = { kind: 'getter fault' }, closeFault = { kind: 'close fault' };
    const adapter = new Proxy(registryAdapter('claude'), { get(target, key, receiver) {
      trace.push(String(key));
      if (key === fail) throw fault;
      if (key === 'buildInvocation') {
        const nested = registryAdapter('nested');
        assert.equal(create([nested], 'nested').get('unknown'), nested);
      }
      return Reflect.get(target, key, receiver);
    } });
    const input = { [Symbol.iterator]() {
      trace.push('iterator'); let index = 0;
      return { next() {
        trace.push(`next:${index}`);
        if (fail === 'next') throw fault;
        return index++ === 0 ? { value: adapter, done: false } : { done: true };
      }, return() { trace.push('return'); if (closeFails) throw closeFault; return {}; } };
    } };
    try { const registry = create(input); assert.equal(registry.get('claude'), adapter); return { trace }; }
    catch (error) { assert.equal(error, fault); return { trace, threw: true }; }
  }
  for (const fail of [undefined, 'name', 'buildInvocation', 'decodeEvent', 'next']) {
    for (const closeFails of [false, true]) {
      assert.deepEqual(exercise(nativeRegistry, fail, closeFails), exercise(legacyRegistry, fail, closeFails));
    }
  }
  for (const create of [legacyRegistry, nativeRegistry]) {
    const fault = { kind: 'name coercion' };
    assert.throws(() => create([], { toString() { throw fault; } }), error => error === fault);
    assert.equal(create([registryAdapter('claude')]).get('unknown').name, 'claude');
  }
});

test('Rust registry matches the legacy lookup for registered and unregistered lanes', () => {
  const fallback = registryAdapter('claude');
  const old = legacyRegistry([fallback]), actual = nativeRegistry([fallback]);
  for (const name of ['gemini', 'some-unknown', '', null]) {
    assert.equal(actual.get(name).name, old.get(name).name, String(name));
    assert.deepEqual(registryOutcome(() => actual.get(name).buildInvocation({})),
      registryOutcome(() => old.get(name).buildInvocation({})));
  }
  // A registered Gemini now resolves to that adapter in both registries.
  const gemini = registryAdapter('gemini');
  assert.equal(nativeRegistry([fallback, gemini]).get('gemini'), gemini);
  assert.equal(legacyRegistry([fallback, gemini]).get('gemini'), gemini);
  const fault = { kind: 'query coercion' };
  for (const registry of [old, actual]) {
    assert.equal(registry.get({ toString() { throw fault; } }), fallback);
    assert.equal(registry.get(Symbol('unregistered')), fallback);
  }
});

test('Rust CLI registry closures retain live adapters, release cycles and do not keep a child alive', async () => {
  const runtime = path.resolve(__dirname, '../src/native/runtime');
  const source = `
    const assert = require('node:assert/strict');
    const { createCliProviderRegistry: create } = require(${JSON.stringify(runtime)});
    const make = () => ({ name: 'claude', buildInvocation() {}, decodeEvent() { return []; } });
    const collect = async refs => {
      for (let i = 0; i < 80; i++) {
        await new Promise(resolve => setImmediate(resolve)); global.gc();
        if (refs.every(ref => ref.deref() === undefined)) return;
      }
      assert.fail('registry or adapter cycle retained');
    };
    (async () => {
      let retained;
      const live = (() => { const adapter = make(); retained = create([adapter]).get; return new WeakRef(adapter); })();
      await new Promise(resolve => setImmediate(resolve)); global.gc();
      assert.equal(retained('claude'), live.deref());
      retained = null;
      await collect([live]);
      const refs = (() => { const adapter = make(), registry = create([adapter]); adapter.registry = registry;
        return [new WeakRef(adapter), new WeakRef(registry)]; })();
      await collect(refs);
      console.log('registry GC and exit PASS');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['--expose-gc', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.signal, null, output);
  assert.equal(result.code, 0, output);
  assert.match(output, /registry GC and exit PASS/);
});

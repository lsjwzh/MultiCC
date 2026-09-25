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

function runBridge(args, { signalAfterMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-test-'));
  const agent = path.join(dir, 'agent.js');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(agent, FAKE_AGENT);
  const [mode, ...rest] = args;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, '--agent-bin', process.execPath,
      '--agent-arg', agent, '--agent-arg', mode, '--agent-arg', log, '--label', 'Fake', ...rest], { cwd: dir });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    if (signalAfterMs) setTimeout(() => child.kill('SIGTERM'), signalAfterMs);
    child.on('close', (code) => {
      const events = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const requests = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      resolve({ code, events, requests });
    });
  });
}

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

test('permission and router MCP helpers', () => {
  assert.equal(pickPermissionOption([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_always' }]).optionId, 'b');
  assert.equal(pickPermissionOption([]), null);
  assert.deepEqual(routerMcpServers({ command: '/n', script: '/r.js' }, { MULTICC_SESSION_ID: 's1', OTHER: 'x' }), [
    { name: 'multicc_router', command: '/n', args: ['/r.js'], env: [{ name: 'MULTICC_SESSION_ID', value: 's1' }] },
  ]);
});

test('opencode defaults to ACP; gemini and grok launch their ACP servers', () => {
  const opencode = createOpencodeAdapter({ cmd: '/bin/opencode', routerMcpNode: '/n', routerMcpScript: '/r.js', userInputReminder: 'R' });
  const inv = opencode.buildInvocation(envelope({ first: false, sessionId: 'ses_1', model: 'p/m', effort: 'high', agent: 'plan' }));
  assert.equal(inv.cmd, process.execPath);
  assert.deepEqual(inv.args.slice(1), [
    '--agent-bin', '/bin/opencode', '--label', 'OpenCode', '--agent-arg', 'acp', '--session-id', 'ses_1',
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

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { addUsage, appServerUsage, createCodexExpAdapter, requestUserInputEvent } = require('../src/cli-adapters/codex-exp');
const { appendAdapterAssistantText } = require('../src/chat/turn-engine');
const { createSessionRecordFactory } = require('../src/session/create-record');
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
    last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 3 },
    modelContextWindow: 258400,
  }), {
    input_tokens: 60, cached_input_tokens: 40, cache_write_input_tokens: 0,
    output_tokens: 7, reasoning_output_tokens: 3, model_context_window: 258400,
    cache_read_input_tokens: 40,
  });
  assert.deepEqual(addUsage(
    { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7, model_context_window: 258400 },
    { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1 },
  ), {
    input_tokens: 80, cached_input_tokens: 0, cache_read_input_tokens: 45,
    cache_write_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 1,
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
    cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
    model_context_window: 258400,
  });
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
  const interruptedTracker = createAdapterCompletion(adapter);
  const interrupted = { method: 'turn/completed', params: { turn: { id: 't2', status: 'interrupted' } } };
  interruptedTracker.observe(interrupted, adapter.decodeEvent(interrupted));
  assert.equal(interruptedTracker.finish({ kind: 'process', code: 0 }).state, 'cancelled');
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
    SUPPORTED_CHAT_CLIS, validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
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
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs'),
      '--codex-bin', fakeCodex, '--', 'hello bridge',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(output.map(item => item.method), ['thread/started', 'item/agentMessage/delta', 'turn/completed']);
    const requests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests.filter(item => item.id).map(item => item.method), ['initialize', 'thread/start', 'turn/start']);
    assert.equal(requests.find(item => item.method === 'turn/start').params.input[0].text, 'hello bridge');

    const resumed = spawnSync(process.execPath, [
      path.join(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs'),
      '--codex-bin', fakeCodex, '--thread-id', 'thread-live', '--', 'hello again',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    const allRequests = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const resume = allRequests.find(item => item.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'thread-live');
    assert.equal(resume.params.excludeTurns, true);

    const unsupported = spawnSync(process.execPath, [
      path.join(__dirname, '../src/cli-adapters/codex-app-server-bridge.cjs'),
      '--codex-bin', fakeCodex, '--', 'old version',
    ], { cwd: root, env: { ...process.env, FAKE_CODEX_LOG: logFile, FAKE_CODEX_VERSION: '0.153.9' }, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /requires Codex >= 0\.154\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

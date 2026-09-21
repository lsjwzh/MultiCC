'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { createClaudeExpAdapter } = require('../src/cli-adapters/claude-exp');
const { processSpawnArgs } = require('../src/chat/process-spawn-args');
const { createSessionRecordFactory } = require('../src/session/create-record');
const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');

function envelope({ first = true, sessionId = 'claude-exp-session', effort = 'high' } = {}) {
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
    '/opt/claude-agent-sdk-bridge.mjs', '--session-id', 'claude-exp-session',
    '--model', 'claude-opus-5', '--effort', 'high', '--agent', 'reviewer',
    '--system-prompt', 'IMG\n\nreviewer', '--disallowed-tools-json', '["WebSearch"]',
    '--max-turns', '4', '--router-node', '/opt/node',
    '--router-script', '/opt/multicc-router-mcp.js', '--',
  ]);
  assert.equal(first.payload, 'context\n\nhello');

  const resumed = instance.buildInvocation(envelope({ first: false }));
  assert.deepEqual(resumed.args.slice(0, 3), [
    '/opt/claude-agent-sdk-bridge.mjs', '--resume', 'claude-exp-session',
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
    yield { type: 'system', subtype: 'init', session_id: 'sdk-session' };
    yield { type: 'result', subtype: 'success', is_error: false };
  }
  await bridge.run([
    '--session-id', 'sdk-session', '--model', 'claude-opus-5', '--effort', 'high',
    '--agent', 'reviewer', '--system-prompt', 'ROLE', '--settings', '/tmp/settings.json',
    '--max-turns', '3', '--disallowed-tools-json', '["WebSearch"]',
    '--router-node', '/opt/node', '--router-script', '/opt/router.js', '--', 'hello sdk',
  ], fakeQuery, value => emitted.push(value));
  assert.equal(observed.prompt, 'hello sdk');
  assert.equal(observed.options.sessionId, 'sdk-session');
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
    SUPPORTED_CHAT_CLIS, validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
  });
  assert.deepEqual(await create({ dir: { id: 'd' }, cli: 'claude-exp', kind: 'terminal' }), {
    ok: false, error: 'claude-exp only supports chat sessions',
  });
});

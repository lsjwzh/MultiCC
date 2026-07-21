'use strict';

const assert = require('assert');
const { createClaudeAdapter } = require('../src/cli-adapters/claude');
const { createCodexAdapter } = require('../src/cli-adapters/codex');
const { createOpencodeAdapter } = require('../src/cli-adapters/opencode');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');
const { createQoderAdapter } = require('../src/cli-adapters/qoder');

const claude = createClaudeAdapter({
  cmd: 'claude', resolveSessionWireModel: model => model,
  claudeDefaultModel: () => null, cliEffortLevel: () => null,
  normalizeEffort: () => null, debugLogClaudeInvoke: () => {},
});
const codex = createCodexAdapter({
  cmd: 'codex', codexReasoningConfigArg: () => null,
  codexModelConfigArg: () => null, multiccImgHint: 'hint',
  isResponseCompletedDisconnect: message => message === 'response-disconnect',
  isTransportDisconnect: message => message === 'transport-disconnect',
});
const opencode = createOpencodeAdapter({ cmd: 'opencode' });
const zcode = createZcodeAdapter({ cmd: 'zcode' });
const qoder = createQoderAdapter({ cmd: 'qoderclicn' });

for (const adapter of [claude, codex, opencode, zcode, qoder]) {
  assert.strictEqual(typeof adapter.buildInvocation, 'function', `${adapter.name} buildInvocation`);
  assert.strictEqual(typeof adapter.decodeEvent, 'function', `${adapter.name} decodeEvent`);
  assert.strictEqual(adapter.shape, undefined, `${adapter.name} has no shape API`);
  assert.strictEqual(adapter.buildChatSpawnArgs, undefined, `${adapter.name} has no legacy argv API`);
}

assert.deepStrictEqual(
  qoder.decodeEvent({ type: 'system', subtype: 'init', model: 'auto', session_id: 'qoder-1' }),
  [
    { type: 'session_init', model: 'auto', raw: { type: 'system', subtype: 'init', model: 'auto', session_id: 'qoder-1' } },
    { type: 'session_started', sessionId: 'qoder-1' },
  ],
);
assert.strictEqual(qoder.decodeEvent({ type: 'assistant', message: { content: [] } })[0].type, 'claude_event');

assert.deepStrictEqual(
  claude.decodeEvent({ type: 'system', subtype: 'init', model: 'claude-x' })[0],
  { type: 'session_init', model: 'claude-x', raw: { type: 'system', subtype: 'init', model: 'claude-x' } },
);
assert.strictEqual(claude.decodeEvent({ type: 'assistant' })[0].type, 'claude_event');

assert.deepStrictEqual(
  codex.decodeEvent({ type: 'thread.started', thread_id: 'thread-1' }),
  [{ type: 'session_started', sessionId: 'thread-1' }],
);
assert.strictEqual(
  codex.decodeEvent({ type: 'item.started', item: { type: 'command_execution', id: 't1', command: 'pwd' } })[0].type,
  'tool_start',
);
assert.strictEqual(
  codex.decodeEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })[0].type,
  'assistant_text',
);
assert.deepStrictEqual(
  codex.decodeEvent({ type: 'item.started', item: { type: 'function_call', name: 'wait_agent' } }),
  [{ type: 'activity', phase: 'tool', toolKind: 'wait_agent' }],
);
assert.deepStrictEqual(
  codex.decodeEvent({ type: 'item.completed', item: { type: 'custom_tool_call', name: 'exec' } }),
  [{ type: 'activity', phase: 'tool', toolKind: 'exec' }],
);
assert.deepStrictEqual(
  codex.decodeEvent({
    type: 'item.started',
    item: { type: 'collab_tool_call', id: 'a1', tool: 'spawn_agent', prompt: 'inspect' },
  })[0],
  {
    type: 'tool_start', id: 'a1', name: 'Agent',
    input: { prompt: 'inspect', agentIds: [] }, status: 'running',
  },
);
assert.strictEqual(
  codex.decodeEvent({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call', id: 'a1', tool: 'spawn_agent', status: 'completed',
      agents_states: { child: { status: 'completed', message: 'ok' } },
    },
  })[0].content,
  'child [completed]: ok',
);
assert.strictEqual(codex.decodeEvent({ type: 'error', message: 'response-disconnect' })[0].kind, 'response_completed_disconnect');
assert.strictEqual(codex.decodeEvent({ type: 'error', message: 'transport-disconnect' })[0].kind, 'transport_disconnect');
assert.strictEqual(codex.decodeEvent({ type: 'turn.completed', usage: { input_tokens: 3 } })[0].type, 'complete');
assert.deepStrictEqual(
  codex.decodeEvent({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
  })[0].usage,
  {
    input_tokens: 60, cached_input_tokens: 40, output_tokens: 7,
    cache_read_input_tokens: 40,
  },
);

for (const adapter of [opencode, zcode]) {
  const decoded = adapter.decodeEvent({ type: 'text', sessionID: 'ses_1', part: { text: 'hello' } });
  assert.deepStrictEqual(decoded.map(event => event.type), ['session_started', 'assistant_text']);
  const tool = adapter.decodeEvent({
    type: 'tool_call',
    part: { callID: 'call_1', tool: 'read', state: { status: 'completed', input: { file: 'a' }, output: 'ok' } },
  })[0];
  assert.strictEqual(tool.type, 'tool_update');
  assert.strictEqual(tool.completed, true);
  assert.strictEqual(adapter.decodeEvent({ type: 'step_finish', part: { reason: 'stop' } })[0].type, 'complete');
}

const opencodeEnvelope = {
  spawnOpts: { rawModel: 'open/model', rawEffort: 'high', rawAgent: 'build' },
  historyHandle: { isFirstTurn: true, cliSessionId: null },
  contextLayers: [], userText: 'hello', suffix: '', rolePrompt: '',
};
assert.deepStrictEqual(
  opencode.buildInvocation(opencodeEnvelope).args,
  ['run', '--format', 'json', '--auto', '--model', 'open/model', '--variant', 'high', '--agent', 'build'],
);
assert.deepStrictEqual(
  zcode.buildInvocation(opencodeEnvelope).args,
  ['run', '--format', 'json', '--auto', '--model', 'open/model'],
);
assert.strictEqual(
  opencode.buildTerminalCmd({ model: 'open/model', effort: 'max', agent: 'build', cliSessionId: 'ses_1' }),
  'opencode --model open/model --variant max --agent build --session ses_1',
);
assert.strictEqual(
  zcode.buildTerminalCmd({ model: 'z/model', effort: 'max', agent: 'build', cliSessionId: 'ses_1' }),
  'zcode --model z/model --session ses_1',
);
assert.strictEqual(
  claude.buildTerminalCmd({ model: 'opus', effort: null, agent: 'reviewer', cliSessionId: null }),
  'claude --model opus --agent reviewer',
);
assert.deepStrictEqual(
  qoder.buildInvocation({
    ...opencodeEnvelope,
    systemPrompt: 'system',
    spawnOpts: { rawModel: 'performance', rawEffort: 'high', rawAgent: 'reviewer' },
  }).args,
  [
    '-p', '--output-format', 'stream-json', '--dangerously-skip-permissions',
    '--append-system-prompt', 'system', '--model', 'performance',
    '--reasoning-effort', 'high', '--agent', 'reviewer',
  ],
);
assert.strictEqual(
  qoder.buildTerminalCmd({ model: 'performance', effort: 'xhigh', agent: 'reviewer', cliSessionId: 'qoder-1' }),
  'qoderclicn --model performance --reasoning-effort xhigh --agent reviewer --resume qoder-1',
);

console.log('CLI adapter contract and decoder tests passed');

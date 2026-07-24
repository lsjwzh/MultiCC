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
// function_call / custom_tool_call now surface as real tool cards (start→result)
// instead of a swallowed `activity` block, so a long tool chain shows inline
// progress and the turn no longer looks stuck.
assert.deepStrictEqual(
  codex.decodeEvent({ type: 'item.started', item: { type: 'function_call', id: 'fc1', name: 'wait_agent', arguments: '{"ms":500}' } }),
  [{ type: 'tool_start', id: 'fc1', name: 'wait_agent', input: { ms: 500 }, status: 'running' }],
);
assert.deepStrictEqual(
  codex.decodeEvent({ type: 'item.completed', item: { type: 'custom_tool_call', id: 'ct1', name: 'exec', output: 'ok' } }),
  [{ type: 'tool_result', id: 'ct1', content: 'ok', isError: false }],
);
// non-JSON arguments fall back to a raw string field; failed status → isError.
assert.deepStrictEqual(
  codex.decodeEvent({ type: 'item.started', item: { type: 'function_call', id: 'fc2', name: 'grep', arguments: 'not json' } }),
  [{ type: 'tool_start', id: 'fc2', name: 'grep', input: { arguments: 'not json' }, status: 'running' }],
);
assert.strictEqual(
  codex.decodeEvent({ type: 'item.completed', item: { type: 'function_call', id: 'fc3', name: 'x', status: 'failed' } })[0].isError,
  true,
);
assert.deepStrictEqual(
  codex.decodeEvent({
    type: 'item.started',
    item: {
      type: 'mcp_tool_call', id: 'mcp1', server: 'multicc_router',
      tool: 'dispatch_master', arguments: { target_session_id: 'worker-1', message: 'test' },
    },
  }),
  [{
    type: 'tool_start', id: 'mcp1', name: 'dispatch_master',
    input: { target_session_id: 'worker-1', message: 'test' }, status: 'running',
  }],
);
assert.deepStrictEqual(
  codex.decodeEvent({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call', id: 'mcp1', status: 'completed',
      result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
    },
  }),
  [{ type: 'tool_result', id: 'mcp1', content: '{"ok":true}', isError: false }],
);
assert.strictEqual(
  codex.decodeEvent({
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call', id: 'mcp2', status: 'failed',
      error: { message: 'tool timed out' },
    },
  })[0].isError,
  true,
);
// request_user_input / AskUserQuestion must still degrade to text (special-cased
// before the generic function_call → tool_result path).
assert.strictEqual(
  codex.decodeEvent({ type: 'item.completed', item: { type: 'function_call', name: 'request_user_input', arguments: '{"questions":[{"question":"go?"}]}' } })[0].type,
  'assistant_text',
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
assert.deepStrictEqual(
  codex.decodeEvent({
    type: 'turn.failed',
    error: {
      message: 'limited',
      code: 'rate_limit_error',
      status: 429,
      headers: { 'retry-after': '5' },
      request_id: 'private-request-id',
    },
  })[0].error,
  {
    source: 'codex_event',
    provider: 'codex',
    code: 'rate_limit_error',
    httpStatus: 429,
    headers: { 'retry-after': '5' },
    requestId: 'private-request-id',
    message: 'limited',
  },
);
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
  const providerError = adapter.decodeEvent({
    type: 'error',
    error: { message: 'bad model', code: 'model_not_found', statusCode: 404 },
  })[0];
  assert.equal(providerError.error.provider, adapter.name);
  assert.equal(providerError.error.source, `${adapter.name}_event`);
  assert.equal(providerError.error.code, 'model_not_found');
  assert.equal(providerError.error.httpStatus, 404);
}

assert.deepStrictEqual(
  opencode.decodeEvent({ type: 'reasoning', sessionID: 'ses_1', part: { id: 'reason_1', text: 'inspect protocol' } }),
  [
    { type: 'session_started', sessionId: 'ses_1' },
    { type: 'thinking', id: 'reason_1', text: 'inspect protocol' },
  ],
);

const opencodeEnvelope = {
  spawnOpts: { rawModel: 'open/model', rawEffort: 'high', rawAgent: 'build' },
  historyHandle: { isFirstTurn: true, cliSessionId: null },
  contextLayers: [], userText: 'hello', suffix: '', rolePrompt: '',
};
assert.deepStrictEqual(
  opencode.buildInvocation(opencodeEnvelope).args,
  ['run', '--format', 'json', '--auto', '--thinking', '--model', 'open/model', '--variant', 'high', '--agent', 'build'],
);
// zcode 专用 adapter：不直调引擎，而是 spawn 树内 bridge（zcode-bridge.cjs）。
// 首轮无 --session；payload 由 multicc 作为末尾 argv 传给 bridge。
const zcodeInv = zcode.buildInvocation(opencodeEnvelope);
assert.deepStrictEqual(zcodeInv.args, ['--model', 'open/model']);
assert.ok(zcodeInv.cmd.endsWith('zcode-bridge.cjs'), 'zcode cmd 指向树内 bridge');
assert.strictEqual(zcodeInv.payload, 'hello');
// 续轮：带 cliSessionId → bridge 收到 --session（转成引擎 --resume）
assert.deepStrictEqual(
  zcode.buildInvocation({ ...opencodeEnvelope, historyHandle: { isFirstTurn: false, cliSessionId: 'sess_abc' } }).args,
  ['--session', 'sess_abc', '--model', 'open/model'],
);
// 首轮 + rolePrompt → payload 包裹角色设定
assert.ok(
  zcode.buildInvocation({ ...opencodeEnvelope, rolePrompt: '你是审查者' }).payload.includes('[角色设定]'),
);
const codexWithRouter = createCodexAdapter({
  cmd: 'codex',
  codexReasoningConfigArg: () => null,
  codexModelConfigArg: () => null,
  multiccImgHint: 'hint',
  routerMcpNode: '/opt/node',
  routerMcpScript: '/opt/multicc/router-mcp.js',
});
const codexRouterArgs = codexWithRouter.buildInvocation(opencodeEnvelope).args;
assert.deepStrictEqual(codexRouterArgs.slice(0, 3), [
  'exec',
  '-c',
  'mcp_servers.multicc_router.command="/opt/node"',
]);
assert.equal(
  codexRouterArgs.includes('mcp_servers.multicc_router.args=["/opt/multicc/router-mcp.js"]'),
  true,
);
assert.equal(
  codexRouterArgs.includes('mcp_servers.multicc_router.required=true'),
  true,
);
assert.equal(
  codexRouterArgs.includes('mcp_servers.multicc_router.default_tools_approval_mode="approve"'),
  true,
);
const claudeWithRouter = createClaudeAdapter({
  cmd: 'claude',
  resolveSessionWireModel: model => model,
  claudeDefaultModel: () => null,
  cliEffortLevel: () => null,
  normalizeEffort: () => null,
  debugLogClaudeInvoke: () => {},
  routerMcpNode: '/opt/node',
  routerMcpScript: '/opt/multicc/router-mcp.js',
});
const claudeRouterArgs = claudeWithRouter.buildInvocation({
  ...opencodeEnvelope,
  systemPrompt: 'system',
  spawnOpts: { ...opencodeEnvelope.spawnOpts, mode: 'streaming' },
}).args;
const claudeMcpIndex = claudeRouterArgs.indexOf('--mcp-config');
assert.notEqual(claudeMcpIndex, -1);
assert.deepStrictEqual(
  JSON.parse(claudeRouterArgs[claudeMcpIndex + 1]).mcpServers.multicc_router,
  { command: '/opt/node', args: ['/opt/multicc/router-mcp.js'] },
);
const qoderWithRouter = createQoderAdapter({
  cmd: 'qoderclicn',
  routerMcpNode: '/opt/node',
  routerMcpScript: '/opt/multicc/router-mcp.js',
});
const qoderRouterArgs = qoderWithRouter.buildInvocation({
  ...opencodeEnvelope,
  systemPrompt: 'system',
}).args;
assert.notEqual(qoderRouterArgs.indexOf('--mcp-config'), -1);
assert.strictEqual(
  opencode.buildTerminalCmd({ model: 'open/model', effort: 'max', agent: 'build', cliSessionId: 'ses_1' }),
  'opencode --model open/model --variant max --agent build --session ses_1',
);
// zcode buildTerminalCmd：走引擎 TUI（ZCODE_ENGINE 未设时回退到 cmd）
const priorZcodeEngine = process.env.ZCODE_ENGINE;
delete process.env.ZCODE_ENGINE;
try {
  assert.strictEqual(
    zcode.buildTerminalCmd({ model: 'bigmodel/glm-5.2', cliSessionId: 'ses_1' }),
    `${JSON.stringify(process.execPath)} ${JSON.stringify(require('node:path').join(__dirname, '..', 'src', 'cli-adapters', 'zcode-terminal.cjs'))} --engine "zcode" --model "bigmodel/glm-5.2" --resume "ses_1"`,
  );
} finally {
  if (priorZcodeEngine == null) delete process.env.ZCODE_ENGINE;
  else process.env.ZCODE_ENGINE = priorZcodeEngine;
}
// zcode decodeEvent：bridge 输出 opencode raw shape，按 opencode-like 同款解码
assert.strictEqual(zcode.decodeEvent({ sessionID: 'sess_z', type: 'step_start' })[0].type, 'session_started');
assert.strictEqual(zcode.decodeEvent({ sessionID: 'sess_z', type: 'step_start' })[1].type, 'status');
assert.strictEqual(zcode.decodeEvent({ type: 'text', part: { text: 'hi' } })[0].type, 'assistant_text');
const zFinish = zcode.decodeEvent({
  type: 'step_finish', part: { reason: 'stop', tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } } },
});
assert.strictEqual(zFinish[zFinish.length - 1].type, 'complete');
assert.strictEqual(
  zcode.decodeEvent({ type: 'error', error: { message: 'boom' } }).pop().message, 'boom',
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

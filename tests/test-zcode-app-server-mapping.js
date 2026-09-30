'use strict';

// ZCode Protocol app-server 通知 → opencode raw 事件 的映射单测。
// 语料是实测录下来的 session/event 形状（引擎 0.16.5，见 zcode-bridge.cjs 头注释），
// 断言分两层：
//   1. 映射本身（event 形状、顺序、分隔符、用量、终止判定）；
//   2. 端到端契约——把映射出来的事件再喂给 zcode adapter 的 decodeEvent 与
//      completion tracker，确认「带工具调用的一轮」仍然判 completed（这是整条
//      映射存在的理由：step 纪律必须和 step-completion 对齐）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { createZcodeAdapter } = require('../src/cli-adapters/zcode');
const {
  RUNTIME_PREFERENCES,
  DEFAULT_MODE,
  DELIVERY_KIND,
  TERMINAL_ERROR_CODE,
  tokensOfUsage,
  buildRuntimeModel,
  createZcodeTurnMapper,
} = require('../src/cli-adapters/zcode-app-server');

const SID = 'sess_11111111-2222-3333-4444-555555555555';

// 一条通知的录制形态：单行 JSONL，params 里带 type/payload/seq。
function mapperFor(clock = { at: 0 }) {
  return { mapper: createZcodeTurnMapper({ sessionId: SID, now: () => clock.at }), clock };
}

function feed(mapper, seq, type, payload) {
  const parts = mapper.map({ type, payload, seq, sessionId: SID });
  return { events: parts.events, done: parts.done };
}

function types(events) {
  return events.map(event => event.type);
}

test('turn.started opens a step and every event carries the native session id', () => {
  const { mapper } = mapperFor();
  const { events, done } = feed(mapper, 1, 'turn.started', { turnNumber: 0, messageId: 'msg_1' });
  assert.deepEqual(types(events), ['step_start']);
  assert.equal(events[0].sessionID, SID);
  assert.equal(done, null);
});

test('text deltas stream through as-is and a new assistant message becomes a clean step', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', { messageId: 'msg_1' });
  const first = feed(mapper, 2, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_1', delta: 'Hel' });
  const second = feed(mapper, 3, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_1', delta: 'lo' });
  assert.deepEqual(first.events[0].part, { text: 'Hel' });
  assert.deepEqual(second.events[0].part, { text: 'lo' });

  // 第二条 assistant 消息 = 新 step + 一个 `\n\n` 分隔事件（delta 语义，直接拼）
  const third = feed(mapper, 4, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_2', delta: 'answer' });
  assert.deepEqual(types(third.events), ['step_start', 'text', 'text']);
  assert.equal(third.events[1].part.text, '\n\n');
  assert.equal(third.events[2].part.text, 'answer');
});

test('reasoning deltas are emitted as accumulated snapshots and closed at turn end', () => {
  const clock = { at: 0 };
  const { mapper } = mapperFor(clock);
  feed(mapper, 1, 'turn.started', { messageId: 'msg_1' });
  clock.at = 1_000;
  const first = feed(mapper, 2, 'model.streaming', { kind: 'reasoning_delta', assistantMessageId: 'msg_1', delta: '我想' });
  assert.deepEqual(types(first.events), ['reasoning']);
  assert.deepEqual(first.events[0].part, { id: 'msg_1', text: '我想' });

  // 200ms 内继续分片：只累计，不再发快照（避免 O(n²) 流量）
  clock.at = 1_050;
  const throttled = feed(mapper, 3, 'model.streaming', { kind: 'reasoning_delta', assistantMessageId: 'msg_1', delta: '想看' });
  assert.deepEqual(throttled.events, []);

  clock.at = 1_400;
  const second = feed(mapper, 4, 'model.streaming', { kind: 'reasoning_delta', assistantMessageId: 'msg_1', delta: '看文件' });
  assert.deepEqual(second.events[0].part, { id: 'msg_1', text: '我想想看看文件' });

  // 收尾必须补一条 completed，否则宿主的 Thinking 卡片永远停在 running
  const end = feed(mapper, 5, 'turn.completed', { resultType: 'success', response: '', tokenCount: 0, usage: {} });
  assert.deepEqual(types(end.events), ['reasoning', 'step_finish']);
  assert.equal(end.events[0].part.completed, true);
  assert.equal(end.events[0].part.text, '我想想看看文件');
  assert.equal(end.done, 'success');
});

test('tool call input is reassembled from the streaming fragments and results upsert the same id', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', { messageId: 'msg_1' });
  feed(mapper, 2, 'model.streaming', { kind: 'tool_input_start', toolCallId: 'call_1', toolName: 'Bash' });
  feed(mapper, 3, 'model.streaming', { kind: 'tool_input_delta', toolCallId: 'call_1', delta: '{"command":' });
  feed(mapper, 4, 'model.streaming', { kind: 'tool_input_delta', toolCallId: 'call_1', delta: '"ls"}' });
  const call = feed(mapper, 5, 'model.streaming', { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Bash' });
  assert.deepEqual(types(call.events), ['tool_call']);
  assert.equal(call.events[0].part.callID, 'call_1');
  assert.deepEqual(call.events[0].part.state.input, { command: 'ls' });
  assert.equal(call.events[0].part.state.status, 'running');

  const settled = feed(mapper, 6, 'tool.updated', {
    kind: 'result', toolCallId: 'call_1', toolName: 'Bash',
    result: { success: true, content: 'a.txt\nb.txt' },
  });
  assert.deepEqual(types(settled.events), ['tool_call']);
  assert.equal(settled.events[0].part.callID, 'call_1');
  assert.equal(settled.events[0].part.state.status, 'completed');
  assert.equal(settled.events[0].part.state.output, 'a.txt\nb.txt');
  assert.deepEqual(settled.events[0].part.state.input, { command: 'ls' });
});

test('a failed tool result is reported as an error state, not a completed one', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', {});
  feed(mapper, 2, 'model.streaming', { kind: 'tool_call', toolCallId: 'call_2', toolName: 'Read', input: { file: 'x' } });
  const settled = feed(mapper, 3, 'tool.updated', { kind: 'error', toolCallId: 'call_2', error: { message: 'ENOENT' } });
  assert.equal(settled.events[0].part.state.status, 'error');
  assert.match(String(settled.events[0].part.state.output), /ENOENT/);
});

test('usage lands on step_finish and terminal outcomes keep their native meaning', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', {});
  const ok = feed(mapper, 2, 'turn.completed', {
    resultType: 'success', response: 'hi', tokenCount: 3,
    usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 90, cacheWriteTokens: 1 },
  });
  assert.equal(ok.events.at(-1).type, 'step_finish');
  assert.equal(ok.events.at(-1).part.reason, 'stop');
  assert.deepEqual(ok.events.at(-1).part.tokens, {
    input: 120, output: 7, cache: { read: 90, write: 1 },
  });
  assert.equal(ok.done, 'success');

  const cancelled = mapperFor().mapper;
  feed(cancelled, 1, 'turn.started', {});
  const stopped = feed(cancelled, 2, 'turn.completed', { resultType: 'cancelled', response: '' });
  assert.equal(stopped.events.at(-1).part.reason, 'cancelled');
  assert.equal(stopped.done, 'cancelled');

  for (const resultType of ['error_max_turns', 'error_during_execution', 'error_max_tool_calls', 'error_max_budget']) {
    const m = mapperFor().mapper;
    feed(m, 1, 'turn.started', {});
    const ended = feed(m, 2, 'turn.completed', { resultType });
    assert.deepEqual(types(ended.events), ['error'], resultType);
    assert.equal(ended.events[0].error.code, TERMINAL_ERROR_CODE);
    assert.match(ended.events[0].error.message, new RegExp(resultType));
    assert.equal(ended.done, 'failed');
  }
});

test('turn.failed becomes a terminal error carrying the engine message', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', {});
  const failed = feed(mapper, 2, 'turn.failed', { error: { type: 'api_error', message: '额度不足', code: 429 }, turnPhase: 'model' });
  assert.deepEqual(types(failed.events), ['error']);
  assert.equal(failed.events[0].error.code, TERMINAL_ERROR_CODE);
  assert.match(failed.events[0].error.message, /额度不足/);
  assert.match(failed.events[0].error.message, /429/);
  assert.equal(failed.done, 'failed');
});

test('a response with no streamed text is still delivered once', () => {
  const { mapper } = mapperFor();
  feed(mapper, 1, 'turn.started', {});
  const end = feed(mapper, 2, 'turn.completed', { resultType: 'success', response: '整段回答', usage: {} });
  assert.deepEqual(types(end.events), ['text', 'step_finish']);
  assert.equal(end.events[0].part.text, '整段回答');
});

test('a stale turn ending (before our turn.started) never ends our turn', () => {
  const { mapper } = mapperFor();
  const stale = feed(mapper, 1, 'turn.completed', { resultType: 'success', response: '上一轮的尾巴' });
  assert.deepEqual(stale.events, []);
  assert.equal(stale.done, null);
  const staleFailed = feed(mapper, 2, 'turn.failed', { error: { message: '上一轮失败' } });
  assert.deepEqual(staleFailed.events, []);
  assert.equal(staleFailed.done, null);

  // 我们这一轮照样能正常开、正常收
  const start = feed(mapper, 3, 'turn.started', { messageId: 'msg_1' });
  assert.deepEqual(types(start.events), ['step_start']);
  const end = feed(mapper, 4, 'turn.completed', { resultType: 'success', response: '我们这一轮', usage: {} });
  assert.equal(end.done, 'success');
  assert.equal(end.events[0].part.text, '我们这一轮');
});

test('irrelevant notifications are ignored without breaking the state machine', () => {
  const { mapper } = mapperFor();
  for (const type of ['session.updated', 'session.titleUpdated', 'message.upserted', 'part.delta', 'permission.requested', 'checkpoint.created']) {
    const out = feed(mapper, 1, type, { anything: true });
    assert.deepEqual(out.events, [], type);
    assert.equal(out.done, null, type);
  }
});

// ── 端到端契约：映射事件 → decodeEvent → completion tracker ──────────────────
function decodeAll(adapter, mapped) {
  const decoded = [];
  for (const event of mapped) decoded.push(...adapter.decodeEvent(event));
  return decoded;
}

function completionOf(mapped, code = 0) {
  const adapter = createZcodeAdapter();
  const tracker = adapter.createCompletionTracker();
  let sessionId = null;
  for (const event of mapped) {
    for (const decoded of adapter.decodeEvent(event)) {
      if (decoded.type === 'session_started') sessionId = decoded.sessionId;
      tracker.observe(event, [decoded]);
    }
  }
  return { state: tracker.finish({ kind: 'process', code }).state, sessionId, decoded: decodeAll(adapter, mapped) };
}

test('a tool-using turn still completes: the follow-up step is kept tool-free', () => {
  const { mapper } = mapperFor();
  const mapped = [];
  const push = (seq, type, payload) => { mapped.push(...feed(mapper, seq, type, payload).events); };
  push(1, 'turn.started', { messageId: 'msg_1' });
  push(2, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_1', delta: '先看一眼。' });
  push(3, 'model.streaming', { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Bash', input: { command: 'ls' } });
  push(4, 'tool.updated', { kind: 'result', toolCallId: 'call_1', toolName: 'Bash', result: { success: true, content: 'a.txt' } });
  push(5, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_2', delta: '目录里只有 a.txt。' });
  push(6, 'turn.completed', { resultType: 'success', tokenCount: 2, usage: { inputTokens: 10, outputTokens: 4 } });

  const { state, sessionId, decoded } = completionOf(mapped);
  assert.equal(sessionId, SID, 'decodeEvent 必须认领原生会话身份');
  assert.equal(state, 'completed');
  // decodeEvent 对每条带 sessionID 的 raw 事件都会补一条 session_started（宿主按
  // 原生 id 认领，重复无害），这里只看业务事件。
  assert.deepEqual(decoded.filter(event => event.type !== 'session_started').map(event => event.type), [
    'status',                                          // turn.started → step_start
    'assistant_text',                                  // 先看一眼。
    'tool_update', 'tool_update',                      // 工具起、工具落（同一个 id upsert）
    'status',                                          // 新 assistant 消息 = 新 step
    'assistant_text', 'assistant_text',                // \n\n + 收尾文本
    'complete',                                        // step_finish stop + 用量
  ]);
  assert.equal(decoded.at(-1).usage.input_tokens, 10);
  assert.equal(decoded.at(-1).usage.output_tokens, 4);
});

test('a turn that ends on tool calls still completes (defensive clean step)', () => {
  const { mapper } = mapperFor();
  const mapped = [];
  const push = (seq, type, payload) => { mapped.push(...feed(mapper, seq, type, payload).events); };
  push(1, 'turn.started', { messageId: 'msg_1' });
  push(2, 'model.streaming', { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Read', input: { file: 'x' } });
  push(3, 'tool.updated', { kind: 'result', toolCallId: 'call_1', toolName: 'Read', result: { success: true, content: 'x' } });
  push(4, 'turn.completed', { resultType: 'success', tokenCount: 1, usage: {} });

  assert.equal(completionOf(mapped).state, 'completed');
});

test('terminal errors fail the turn instead of masquerading as a stop', () => {
  const { mapper } = mapperFor();
  const mapped = [];
  const push = (seq, type, payload) => { mapped.push(...feed(mapper, seq, type, payload).events); };
  push(1, 'turn.started', { messageId: 'msg_1' });
  push(2, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_1', delta: '半句' });
  push(3, 'turn.failed', { error: { message: '上游 500' } });
  const { state, decoded } = completionOf(mapped, 1);
  assert.equal(state, 'failed');
  assert.equal(decoded.at(-1).type, 'error');
  assert.equal(decoded.at(-1).kind, 'provider');
  assert.match(decoded.at(-1).message, /上游 500/);
});

test('a cancelled turn is reported as cancelled, not completed', () => {
  const { mapper } = mapperFor();
  const mapped = [];
  const push = (seq, type, payload) => { mapped.push(...feed(mapper, seq, type, payload).events); };
  push(1, 'turn.started', { messageId: 'msg_1' });
  push(2, 'model.streaming', { kind: 'text_delta', assistantMessageId: 'msg_1', delta: '写了' });
  push(3, 'turn.completed', { resultType: 'cancelled', response: '' });
  const { state, decoded } = completionOf(mapped, 0);
  assert.equal(state, 'unknown');
  assert.equal(decoded.some(event => event.type === 'complete'), false, '取消不能变成 complete');
});

test('runtimeModel is rebuilt from the vendor config so resume does not need -32031', () => {
  const config = {
    model: 'zai/glm-5.2',
    provider: {
      zai: {
        kind: 'anthropic',
        options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'sk-test' },
        models: { 'glm-5.2': { id: 'glm-5.2' }, 'glm-5-turbo': { id: 'glm-5-turbo' } },
      },
    },
  };
  const runtimeModel = buildRuntimeModel(config, null);
  assert.equal(runtimeModel.model.providerId, 'zai');
  assert.equal(runtimeModel.model.modelId, 'glm-5.2');
  assert.equal(runtimeModel.provider.kind, 'anthropic');
  assert.equal(runtimeModel.provider.source, 'workspace');
  assert.equal(runtimeModel.provider.baseURL, 'https://api.z.ai/api/anthropic');
  assert.deepEqual(runtimeModel.provider.apiKey, { source: 'inline', value: 'sk-test' });
  assert.deepEqual(runtimeModel.provider.models, [{ modelId: 'glm-5.2' }, { modelId: 'glm-5-turbo' }]);
  assert.equal(typeof runtimeModel.revision, 'string');
  assert.equal(typeof runtimeModel.generatedAt, 'number');

  // 读不到/结构不认识 → 返回 null，让引擎按自己的配置走
  assert.equal(buildRuntimeModel(null, null), null);
  assert.equal(buildRuntimeModel({ model: 'zai/glm-5.2' }, null), null);
  assert.equal(buildRuntimeModel({ model: 'no-slash' }, null), null);
  assert.equal(buildRuntimeModel({ model: 'zai/glm-5.2', provider: {} }, null), null);
});

test('protocol constants stay in the shape the engine accepts', () => {
  assert.deepEqual(RUNTIME_PREFERENCES, {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  });
  assert.equal(DEFAULT_MODE, 'yolo');
  assert.equal(DELIVERY_KIND, 'web-remote-replayable');
  assert.deepEqual(tokensOfUsage({ inputTokens: 5, outputTokens: 0, cacheReadTokens: 2 }), {
    input: 5, output: 0, cache: { read: 2, write: 0 },
  });
  assert.deepEqual(tokensOfUsage(undefined), { input: 0, output: 0, cache: { read: 0, write: 0 } });
  assert.deepEqual(tokensOfUsage({ inputTokens: -1, outputTokens: 'x' }), {
    input: 0, output: 0, cache: { read: 0, write: 0 },
  });
});

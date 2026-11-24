'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgyAdapter } = require('../src/cli-adapters/agy');
const { createAdapterCompletion } = require('../src/cli-adapters/completion');
const { getNative } = require('../src/native/runtime');

function envelope({ first = true, sessionId = null, model = null, effort = null, userText = 'hello' } = {}) {
  return {
    contextLayers: [],
    userText,
    suffix: '',
    rolePrompt: first ? 'reviewer' : '',
    historyHandle: { isFirstTurn: first, cliSessionId: sessionId },
    spawnOpts: { rawModel: model, rawEffort: effort },
  };
}

test('Antigravity stream-json invocation preserves model, effort, conversation resume, and terminal cmd', () => {
  const adapter = createAgyAdapter({ cmd: '/bin/agy' });

  const first = adapter.buildInvocation(envelope({
    first: true, sessionId: 'ignored-first', model: 'gemini-4-neon', effort: 'high',
  }));
  assert.equal(first.cmd, '/bin/agy');
  assert.deepEqual(first.args, [
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', 'gemini-4-neon',
    '--effort', 'high',
    '-p',
  ]);
  assert.match(first.payload, /^\[Role prompt\]\nreviewer\n\[End of role prompt\]\n\nhello$/);

  const resume = adapter.buildInvocation(envelope({
    first: false, sessionId: 'conv-42', model: 'gemini-4-argon', effort: 'low', userText: '- dash prompt',
  }));
  assert.deepEqual(resume.args, [
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', 'gemini-4-argon',
    '--effort', 'low',
    '--conversation', 'conv-42',
    '-p',
  ]);
  assert.equal(resume.payload, '- dash prompt');

  assert.equal(
    adapter.buildTerminalCmd({ model: 'gemini-4-argon', cliSessionId: 'session-1' }),
    "'/bin/agy' --model 'gemini-4-argon' --conversation 'session-1'",
  );
  assert.equal(
    adapter.buildTerminalCmd({ cliSessionId: "abc'; touch /tmp/no; '" }),
    "'/bin/agy' --conversation 'abc'\"'\"'; touch /tmp/no; '\"'\"''",
  );
});

test('Orchestrator 的新会话、续聊和终端都省略遗留强度', () => {
  const adapter = createAgyAdapter({ cmd: 'agy' });
  const model = 'gemini-pro-orchestrator-neon';
  for (const first of [true, false]) {
    const input = envelope({ first, sessionId: 'previous', model, effort: 'high' });
    assert.ok(!adapter.buildInvocation(input).args.includes('--effort'));
    input.spawnOpts.rawModel = null;
    input.spawnOpts.effectiveModel = model;
    assert.ok(!adapter.buildInvocation(input).args.includes('--effort'));
  }
  assert.ok(!adapter.buildTerminalCmd({ model, effort: 'high' }).includes('--effort'));
});

test('Antigravity stream-json accumulates per-step live usage and ignores turn-2 cumulative result usage', () => {
  const adapter = createAgyAdapter({ cmd: '/bin/agy' });
  const tracker = createAdapterCompletion(adapter);

  const rawEvents = [
    { event: 'init', conversation_id: 'conv-2', init: { model: 'gemini-4-neon' } },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-2',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        usage: { input_tokens: 13389, output_tokens: 113, thinking_tokens: 83, cache_read_tokens: 0, total_tokens: 13502 },
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-2',
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: { name: 'read_file', parameters: { Path: '/tmp/a.txt' } },
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-2',
        step_index: 2,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'read_file',
        tool_info: {
          name: 'read_file',
          parameters: { Path: '/tmp/a.txt' },
          error: { type: 'TOOL_ERROR', message: 'file does not exist' },
        },
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-2',
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'done',
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-2',
        step_index: 3,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: '\n',
        usage: { input_tokens: 2201, output_tokens: 84, thinking_tokens: 33, cache_read_tokens: 11332, total_tokens: 2285 },
      },
    },
    {
      event: 'result',
      result: {
        conversation_id: 'conv-2',
        status: 'SUCCESS',
        num_turns: 2,
        usage: { input_tokens: 99999, output_tokens: 9999, thinking_tokens: 888, cache_read_tokens: 77777 },
      },
    },
  ];

  const decoded = [];
  for (const raw of rawEvents) {
    const out = adapter.decodeEvent(raw);
    tracker.observe(raw, out);
    decoded.push(...out);
  }

  const liveUpdates = decoded.filter(e => e.type === 'live_usage');
  assert.equal(liveUpdates.length, 2);
  assert.deepEqual(liveUpdates[0].roleMain, { inputTokens: 13389, outputTokens: 113, cacheRead: 0, cacheWrite: 0 });
  assert.equal(liveUpdates[0].stepUsage.context_tokens, 13389);
  assert.deepEqual(liveUpdates[1].roleMain, { inputTokens: 15590, outputTokens: 197, cacheRead: 11332, cacheWrite: 0 });
  assert.equal(liveUpdates[1].usage.reasoning_output_tokens, 116);
  assert.equal(liveUpdates[1].usage.context_tokens, 13533);

  const toolErr = decoded.find(e => e.type === 'tool_update' && e.completed);
  assert.equal(toolErr.isError, true);
  assert.equal(toolErr.content, 'file does not exist');
  assert.equal(toolErr.currentFile, '/tmp/a.txt');

  const complete = decoded.find(e => e.type === 'complete');
  assert.equal(complete.usage.input_tokens, 15590);
  assert.equal(complete.usage.output_tokens, 197);
  assert.equal(complete.usage.cache_read_input_tokens, 11332);
  assert.equal(complete.usage.reasoning_output_tokens, 116);
  assert.equal(complete.usage.context_tokens, 13533);
  assert.equal(tracker.finish({ kind: 'process', code: 0 }).state, 'completed');
});

test('Antigravity error and cancelled results fail or cancel completion tracker', () => {
  const adapter = createAgyAdapter({ cmd: '/bin/agy' });

  const errTracker = createAdapterCompletion(adapter);
  const errRaw = { event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'bad model', finished_reason: 'error' } };
  const errOut = adapter.decodeEvent(errRaw);
  errTracker.observe(errRaw, errOut);
  assert.equal(errOut[0].type, 'error');
  assert.equal(errOut[0].message, 'bad model');
  assert.equal(errTracker.finish({ kind: 'process', code: 1 }).state, 'failed');

  const cancelTracker = createAdapterCompletion(adapter);
  const cancelRaw = { event: 'result', result: { conversation_id: 'c', status: 'CANCELLED', finished_reason: 'cancelled' } };
  const cancelOut = adapter.decodeEvent(cancelRaw);
  cancelTracker.observe(cancelRaw, cancelOut);
  assert.equal(cancelOut[0].kind, 'cancelled');
  assert.equal(cancelTracker.finish({ kind: 'process', code: 1 }).state, 'cancelled');
});

test('chat_apply_adapter_decoded_event forwards live_usage as role_token_stats and message_delta', () => {
  const native = getNative();
  const forwarded = [];
  const turn = { turnId: 't-1' };
  const runner = { runnerId: 'r-1' };
  const cs = { _activeTurn: turn, _activeRunner: runner };
  const ports = {
    isCurrent: () => true,
    scrub: (_attempt, evt) => evt,
    observeAdapter: () => {},
    touchActivity: () => {},
    decodeEvent: () => [],
    updatePhase: () => {},
    setSessionStatus: () => {},
    scheduleIncrementalSave: () => {},
    backgroundRecordToolUseId: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    consoleWarn: () => {},
    consoleLog: () => {},
  };
  const liveEvent = {
    type: 'live_usage',
    usage: { input_tokens: 15590, output_tokens: 197, cache_read_input_tokens: 11332, reasoning_output_tokens: 116, context_tokens: 13533 },
    stepUsage: { input_tokens: 2201, output_tokens: 84, cache_read_input_tokens: 11332, reasoning_output_tokens: 33, context_tokens: 13533 },
    roleMain: { inputTokens: 15590, outputTokens: 197, cacheRead: 11332, cacheWrite: 0 },
  };
  native.chatApplyAdapterDecodedEvent(
    { name: 'agy' }, cs, { cli: 'agy' }, 'sess-1', liveEvent,
    frame => forwarded.push(frame), turn, runner, ports,
  );
  assert.deepEqual(runner.pendingUsage, liveEvent.usage);
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].type, 'role_token_stats');
  assert.deepEqual(forwarded[0].role.main, liveEvent.roleMain);
  assert.equal(forwarded[1].type, 'stream_event');
  assert.equal(forwarded[1].event.type, 'message_delta');
  assert.deepEqual(forwarded[1].event.usage, liveEvent.stepUsage);
});

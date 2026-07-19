'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexUsageHost,
  normalizeCodexTurnUsage,
  projectHistoryUsage,
  summarizeHistoryUsage,
  usageEpochForSessionId,
} = require('../src/codex-usage');

function cumulative(input, cached, output, reasoning = 0) {
  return {
    input_tokens: input - cached,
    cached_input_tokens: cached,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

test('Codex cumulative snapshots become durable per-turn deltas', () => {
  const cliSessionId = 'native-thread-secret';
  const usageEpoch = usageEpochForSessionId(cliSessionId);
  const history = [{
    role: 'assistant',
    usage: cumulative(100, 70, 20, 5),
    usageCumulative: cumulative(100, 70, 20, 5),
    usageEpoch,
  }];
  const result = normalizeCodexTurnUsage({
    usage: cumulative(145, 100, 29, 8),
    history,
    cliSessionId,
  });

  assert.equal(result.code, 'delta');
  assert.deepEqual(result.usage, cumulative(45, 30, 9, 3));
  assert.deepEqual(result.cumulativeUsage, cumulative(145, 100, 29, 8));
  assert.equal(result.usageEpoch, usageEpoch);
  assert.equal(JSON.stringify(result).includes(cliSessionId), false,
    'the native session id is never persisted or returned');
});

test('legacy cumulative history is accepted as a restart baseline', () => {
  const result = normalizeCodexTurnUsage({
    usage: cumulative(230, 180, 40, 12),
    history: [{ role: 'assistant', usage: cumulative(200, 160, 31, 9) }],
    cliSessionId: 'same-native-thread',
  });
  assert.equal(result.code, 'delta');
  assert.deepEqual(result.usage, cumulative(30, 20, 9, 3));
});

test('same-epoch regressions fail closed instead of recounting from zero', () => {
  const cliSessionId = 'thread-a';
  const result = normalizeCodexTurnUsage({
    usage: cumulative(20, 10, 3, 1),
    history: [{
      role: 'assistant',
      usage: cumulative(100, 70, 20, 5),
      usageCumulative: cumulative(100, 70, 20, 5),
      usageEpoch: usageEpochForSessionId(cliSessionId),
    }],
    cliSessionId,
  });
  assert.equal(result.code, 'regression');
  assert.deepEqual(result.usage, cumulative(0, 0, 0, 0));
  assert.deepEqual(result.cumulativeUsage, cumulative(100, 70, 20, 5));
});

test('history projection fixes legacy footers and strips private baselines', () => {
  const epoch = usageEpochForSessionId('thread-a');
  const history = [
    { id: 'a', role: 'assistant', usage: cumulative(100, 70, 20, 5) },
    { id: 'b', role: 'assistant', usage: cumulative(145, 100, 29, 8) },
    {
      id: 'c', role: 'assistant', usage: cumulative(15, 10, 4, 1),
      usageCumulative: cumulative(160, 110, 33, 9), usageEpoch: epoch,
    },
  ];
  const projected = projectHistoryUsage(history);

  assert.deepEqual(projected.map(message => message.usage), [
    cumulative(100, 70, 20, 5),
    cumulative(45, 30, 9, 3),
    cumulative(15, 10, 4, 1),
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(projected[2], 'usageCumulative'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected[2], 'usageEpoch'), false);
  assert.ok(history[2].usageCumulative, 'projection never mutates persisted history');
  assert.deepEqual(summarizeHistoryUsage(history), {
    inputTokens: 160,
    consumedInputTokens: 160,
    freshInputTokens: 50,
    cacheReadTokens: 110,
    cacheWriteTokens: 0,
    breakdownKnown: true,
    outputTokens: 33,
    turnCount: 3,
  });
});

test('legacy vector regression starts a new display epoch without affecting source', () => {
  const history = [
    { role: 'assistant', usage: cumulative(100, 70, 20) },
    { role: 'assistant', usage: cumulative(10, 4, 2) },
  ];
  const projected = projectHistoryUsage(history);
  assert.deepEqual(projected[1].usage, cumulative(10, 4, 2));
  assert.deepEqual(history[1].usage, cumulative(10, 4, 2));
});

test('Codex host sends one delta to history, ledger, role tracker and live result', () => {
  const cliSessionId = 'native-thread';
  const epoch = usageEpochForSessionId(cliSessionId);
  const calls = [];
  const cs = {
    currentAssistantText: 'done',
    currentToolCalls: [],
    chatTurnCount: 4,
    turnStartedAt: 900,
  };
  const host = createCodexUsageHost({
    loadHistory() {
      return [{
        role: 'assistant', usage: cumulative(100, 70, 20, 5),
        usageCumulative: cumulative(100, 70, 20, 5), usageEpoch: epoch,
      }];
    },
    reconcileRole(sessionId, usage) { calls.push(['role', sessionId, usage]); },
    persistFinalAssistantResult(sessionId, state, turn, runner, message, options) {
      calls.push(['persist', sessionId, message, options]);
      state._resultSaved = true;
      return true;
    },
    recordDurableTurnUsage(sessionId, runner, usage) {
      calls.push(['ledger', sessionId, usage]);
    },
    recordResultEvent() { calls.push(['empty']); },
    setSessionStatus(sessionId, status) { calls.push(['status', sessionId, status]); },
    now: () => 1000,
  });
  const forwarded = [];
  const runner = {};
  host.complete({
    evt: { type: 'complete', usage: cumulative(145, 100, 29, 8) },
    cs,
    persisted: { cliSessionId },
    sessionName: 'session-a',
    turn: { id: 'turn-a' },
    runner,
    forward: event => forwarded.push(event),
  });

  const expected = cumulative(45, 30, 9, 3);
  assert.deepEqual(runner.pendingUsage, expected);
  assert.deepEqual(calls.find(call => call[0] === 'role')[2], expected);
  assert.deepEqual(calls.find(call => call[0] === 'ledger')[2], expected);
  const persisted = calls.find(call => call[0] === 'persist')[2];
  assert.deepEqual(persisted.usage, expected);
  assert.deepEqual(persisted.usageCumulative, cumulative(145, 100, 29, 8));
  assert.equal(persisted.usageEpoch, epoch);
  assert.equal(persisted.ts, 1000);
  assert.deepEqual(forwarded, [{
    type: 'result', total_cost_usd: null, usage: expected,
    durationMs: 100, num_turns: 5,
  }]);
  assert.deepEqual(calls.at(-1), [
    'status', 'session-a', { status: 'completed', currentFile: null },
  ]);
});

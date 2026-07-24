'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTurnFinalizationExecutor,
  planTurnFinalization,
} = require('../src/chat');

function createHarness(options = {}) {
  const calls = [];
  const ports = {
    persistAssistant(context, append) {
      calls.push(['persist', append.final, append.partial]);
      if (options.persisted !== false && append.final) context.turn.resultDurable = true;
      return options.persisted !== false;
    },
    commitUsage() { calls.push(['usage']); },
    broadcast(sessionName, event) { calls.push(['broadcast', event.type, event.error || null]); },
    cancelClassify() { calls.push(['cancel-classify']); },
    clearIncrementalSave() { calls.push(['clear-timer']); },
    setStatus(sessionName, status) { calls.push(['status', status]); },
    classifyTurnEnd() { calls.push(['classify']); },
    resetInterrupted() { calls.push(['reset-interrupted']); },
    resumeInterrupted() { calls.push(['resume-interrupted']); return options.resumed === true; },
    freezeInterrupted(sessionName, reason) { calls.push(['freeze-interrupted', reason]); },
    emitTurnOutcome() { calls.push(['outcome']); },
    runPostTurn(context, entry) { calls.push(['post-turn', entry.guard, context.turn.resultDurable]); },
    now: () => 200,
  };
  return { calls, executor: createTurnFinalizationExecutor(ports) };
}

function context(overrides = {}) {
  return {
    runnerKind: 'process',
    sessionName: 'session-1',
    cs: {
      cli: 'codex',
      isStreaming: true,
      streamReplay: [{ type: 'assistant' }],
      currentAssistantText: 'answer',
      currentToolCalls: [],
      currentCost: 0.1,
      chatTurnCount: 2,
      turnStartedAt: 100,
    },
    persisted: { cli: 'codex' },
    turn: { resultDurable: false },
    runner: { resultEvent: true, pendingUsage: { input_tokens: 1 } },
    ...overrides,
  };
}

function processPlan(overrides = {}) {
  return planTurnFinalization({
    current: true,
    runnerKind: 'process',
    cli: 'codex',
    hasOutput: true,
    resultEvent: true,
    resultDurable: false,
    ...overrides,
  });
}

test('host executor crosses the real append boundary before usage, classify, stream_end and post-turn', () => {
  const harness = createHarness();
  const ctx = context();
  const result = harness.executor.execute(processPlan(), ctx);
  const labels = harness.calls.map(call => call[0] === 'broadcast' ? `broadcast:${call[1]}` : call[0]);
  const at = label => labels.indexOf(label);
  assert.equal(result.appendPersisted, true);
  assert.equal(ctx.turn.resultDurable, true);
  assert.equal(ctx.cs.chatTurnCount, 3);
  assert.equal(ctx.cs.currentAssistantText, '');
  assert.ok(at('clear-timer') < at('persist'));
  assert.ok(at('persist') < at('usage'));
  assert.ok(at('usage') < at('classify'));
  assert.ok(at('classify') < at('broadcast:stream_end'));
  assert.ok(at('broadcast:stream_end') < at('post-turn'));
  assert.deepEqual(harness.calls.at(-1), ['post-turn', 'current-runner-and-durable-final-result', true]);
});

test('failed append never fabricates durability and exposes the guarded post-turn attempt', () => {
  const harness = createHarness({ persisted: false });
  const ctx = context();
  const result = harness.executor.execute(processPlan(), ctx);
  assert.equal(result.appendPersisted, false);
  assert.equal(ctx.turn.resultDurable, false);
  assert.equal(harness.calls.some(call => call[0] === 'usage'), false);
  assert.equal(harness.calls.some(call => call[0] === 'broadcast' && call[2]?.includes('未能持久化')), true);
  assert.deepEqual(harness.calls.at(-1), ['post-turn', 'current-runner-and-durable-final-result', false]);
});

test('unknown stream interruption freezes and never invokes automatic resume', () => {
  const harness = createHarness({ resumed: true });
  const ctx = context({
    runnerKind: 'stream',
    cs: { ...context().cs, cli: 'claude', currentAssistantText: '', streamReplay: [] },
    persisted: { cli: 'claude' },
    runner: { resultEvent: false },
  });
  const plan = planTurnFinalization({
    current: true,
    runnerKind: 'stream',
    cli: 'claude',
    hasOutput: false,
    resultEvent: false,
    resultDurable: false,
  });
  harness.executor.execute(plan, ctx);
  assert.equal(harness.calls.some(call => call[0] === 'resume-interrupted'), false);
  assert.equal(harness.calls.some(call => call[0] === 'freeze-interrupted'), true);
  assert.deepEqual(harness.calls.find(call => call[0] === 'status'), ['status', 'waiting']);
  assert.equal(harness.calls.some(call => call[0] === 'broadcast' && call[1] === 'stream_end'), true);
});

test('finalize host fails closed when a required runtime port is absent', () => {
  assert.throws(() => createTurnFinalizationExecutor({}), /finalize host port missing/);
});

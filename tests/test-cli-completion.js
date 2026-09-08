'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapterCompletion, isCompleted } = require('../src/cli-adapters/completion');
const { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream } = require('../src/chat/adapter-completion');
const { clearErrorFlagsForSucceededTurn, evaluatePostTurn } = require('../src/chat/turn-lifecycle');
const { planTurnFinalization, resolveTurnFinalization } = require('../src/chat/finalize-plan');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');

const adapters = [
  require('../src/cli-adapters/claude').createClaudeAdapter({}),
  require('../src/cli-adapters/codex').createCodexAdapter({}),
  require('../src/cli-adapters/opencode').createOpencodeAdapter({}),
  require('../src/cli-adapters/zcode').createZcodeAdapter({}),
  require('../src/cli-adapters/qoder').createQoderAdapter({}),
  require('../src/cli-adapters/kimi').createKimiAdapter({}),
  require('../src/cli-adapters/codebuddy').createCodebuddyAdapter({}),
  require('../src/cli-adapters/dsh').createDshAdapter({}),
];
const successResult = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
const traces = {
  claude: [successResult], qoder: [{ type: 'result', subtype: 'success', is_error: false }],
  codebuddy: [{ type: 'result', subtype: 'success', is_error: false }],
  codex: [{ type: 'turn.completed', usage: {} }],
  opencode: [{ type: 'step_start' }, { type: 'step_finish', part: { reason: 'stop' } }],
  zcode: [{ type: 'step_finish', part: { reason: 'stop' } }],
  kimi: [{ role: 'meta', type: 'session.resume_hint', session_id: 'session-1' }],
  dsh: [{ type: 'session_finished' }, { type: 'complete' }],
};
const exit0 = { kind: 'process', code: 0 };
function play(adapter, events) {
  const tracker = createAdapterCompletion(adapter);
  for (const event of events) tracker.observe(event, adapter.decodeEvent(event));
  return tracker;
}

for (const adapter of adapters) {
  test(`${adapter.name}: completion is local to one runner and requires settlement`, () => {
    assert.equal(typeof adapter.createCompletionTracker, 'function');
    const tracker = play(adapter, traces[adapter.name]);
    assert.equal(isCompleted(tracker.snapshot()), false, 'native marker alone cannot clear proxy failures');
    assert.equal(isCompleted(tracker.finish(exit0)), true);
    assert.equal(createAdapterCompletion(adapter).finish(exit0).state, 'unknown', 'no evidence inherited');
    for (const boundary of [
      { kind: 'process', code: 1 }, { kind: 'process', code: 0, signal: 'SIGTERM' },
      { kind: 'stream', rejected: true }, { kind: 'stream' }, {},
      { kind: 'process', code: 0, killReason: 'user_cancel' },
    ]) assert.equal(isCompleted(play(adapter, traces[adapter.name]).finish(boundary)), false);
    tracker.observe({ type: 'error' }, [{ type: 'error' }]);
    assert.equal(isCompleted(tracker.finish({ kind: 'stream', rejected: true })), true,
      'settlement is immutable; late callbacks cannot mutate a closed runner');
  });
}

for (const name of ['claude', 'qoder', 'codebuddy']) {
  const adapter = adapters.find(a => a.name === name);
  test(`${name}: historical result variants distinguish boundary from success`, () => {
    for (const result of [
      { ...successResult, is_error: true, terminal_reason: 'api_error' },
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ]) assert.equal(play(adapter, [result, successResult]).finish(exit0).state, 'failed');
    for (const result of [
      { ...successResult, terminal_reason: 'max_tokens' },
      { ...successResult, terminal_reason: { kind: 'completed' } },
      { ...successResult, terminal_reason: null },
      { type: 'result', subtype: 'success' },
      { ...successResult, origin: { kind: 'task-notification' } },
      { ...successResult, parent_tool_use_id: 'child-tool' },
    ]) assert.equal(play(adapter, [result]).finish(exit0).state, 'unknown');
    assert.equal(play(adapter, [{ ...successResult, terminal_reason: 'aborted' }]).finish(exit0).state, 'cancelled');
    assert.equal(play(adapter, [{ ...successResult, is_error: true, terminal_reason: 'cancelled' }]).finish({ kind: 'process', code: 1 }).state, 'cancelled');
    assert.equal(play(adapter, [{ type: 'result', subtype: 'success', is_error: false }]).finish(exit0).state, 'completed');
    assert.deepEqual(adapter.decodeEvent({ ...successResult, parent_tool_use_id: 'child-tool' }), []);
  });
}

test('Codex retries can recover transient errors; failed whole turns cannot recover', () => {
  const adapter = adapters.find(a => a.name === 'codex');
  assert.equal(play(adapter, [{ type: 'error', message: 'retrying' }, ...traces.codex]).finish(exit0).state, 'completed');
  for (const terminal of [{ type: 'turn.failed' }, { type: 'turn.completed', error: { message: 'failed' } }]) {
    assert.equal(play(adapter, [terminal, ...traces.codex]).finish(exit0).state, 'failed');
  }
});

for (const name of ['opencode', 'zcode']) {
  test(`${name}: a tool step saying stop still requires another step`, () => {
    const adapter = adapters.find(a => a.name === name);
    const toolStep = [{ type: 'step_start' },
      { type: 'tool_use', part: { callID: 'tool-1', state: { status: 'completed', output: 'ok' } } },
      { type: 'step_finish', part: { reason: 'stop' } }];
    assert.equal(play(adapter, toolStep).finish(exit0).state, 'unknown');
    assert.equal(play(adapter, [...toolStep, ...traces.opencode]).finish(exit0).state, 'completed');
    assert.equal(play(adapter, [...traces.opencode, { type: 'step_start' }]).finish(exit0).state, 'unknown');
    assert.equal(play(adapter, [{ type: 'error', error: { message: 'provider failed' } }, ...traces.opencode]).finish(exit0).state, 'failed');
    for (const reason of [undefined, 'length', 'tool-calls', 'unknown']) {
      assert.equal(play(adapter, [{ type: 'step_finish', part: { reason } }]).finish(exit0).state, 'unknown');
    }
  });
}

test('Kimi needs its native success-only resume hint, with all tools settled', () => {
  const adapter = adapters.find(a => a.name === 'kimi');
  const output = { role: 'assistant', content: 'done' };
  assert.equal(play(adapter, [output]).finish(exit0).state, 'unknown');
  const pending = { role: 'assistant', tool_calls: [{ id: 'tool-1', function: { name: 'exec' } }] };
  assert.equal(play(adapter, [pending, ...traces.kimi]).finish(exit0).state, 'unknown');
  const toolResult = { role: 'tool', tool_call_id: 'tool-1', content: 'ok' };
  assert.equal(play(adapter, [pending, toolResult, ...traces.kimi]).finish(exit0).state, 'completed');
});

test('dsh idle/session_finished is insufficient; its bridge must prove turn/end completed', () => {
  const adapter = adapters.find(a => a.name === 'dsh');
  assert.equal(play(adapter, [{ type: 'session_finished' }]).finish(exit0).state, 'unknown');
  assert.equal(play(adapter, [{ type: 'error', reason: 'aborted' }]).finish(exit0).state, 'cancelled');
});

test('only an adapter without native completion support uses conservative exit fallback', () => {
  const generic = { decodeEvent: event => [event] };
  const text = { type: 'assistant_text', text: 'done' };
  assert.equal(play(generic, [text]).finish(exit0).source, 'exit_fallback');
  for (const events of [[], [text, { type: 'error' }], [text, { type: 'tool_start', id: 'tool-1' }]]) {
    assert.equal(play(generic, events).finish(exit0).state, 'unknown');
  }
  assert.equal(play(generic, [text]).finish({ kind: 'stream', resolved: true }).state, 'unknown');
});

test('durable native success followed by rejected send cannot suppress errors or run post-turn', async () => {
  const runtime = createProviderAttemptRuntime();
  const attempt = runtime.beginAttempt({ sessionId: 's', turnId: 't', cli: 'claude', providerId: 'p',
    providerName: 'P', model: 'm', protocol: 'anthropic', providerRevision: 'r', attemptNo: 1 });
  runtime.observeProxyOutcome({ ...attempt, roleKind: 'main', routeAttribution: 'exact',
    status: 'error', statusCode: 200, errorCode: 'CLIENT_ABORTED', proxyOutcome: {
      version: 1, requestId: 'req', requestKind: 'inference', termination: 'downstream_disconnect', httpStatus: null,
    } });
  const turn = { turnId: 't', resultDurable: true, resultRunnerId: 'runner-1' };
  const runner = { runnerId: 'runner-1', turnId: 't', resultEvent: true, sawApiError: true,
    completion: play(adapters[0], [successResult]) };
  let finalizations = 0;
  await finalizeCompletionStream(Promise.reject(new Error('socket closed')), {
    runner, onRejected() {}, onFinalizeError: assert.fail,
    finalize() {
      finalizations++;
      assert.equal(runner.completionOutcome.state, 'failed');
      assert.equal(clearErrorFlagsForSucceededTurn(turn, runner, {}, {}), false);
      const failure = runtime.proxyFailure(attempt, { resultDurable: true, completion: runner.completionOutcome });
      assert.ok(failure);
      assert.equal(canPersistAdapterCompletion(runner.completionOutcome, failure), false);
      const resolved = resolveTurnFinalization(planTurnFinalization({ current: true, runnerKind: 'stream',
        resultDurable: true, resultEvent: true, hasOutput: true, completion: runner.completionOutcome }));
      assert.equal(resolved.effects.some(e => e.type === 'complete-session-turn'), false);
      assert.equal(resolved.effects.find(e => e.type === 'classify-turn-end').classification, 'interrupted');
      assert.equal(resolved.effects.find(e => e.type === 'run-post-turn').interrupted, true);
      assert.equal(evaluatePostTurn(turn, runner, { currentTurn: turn, currentRunner: runner }).ok, false);
    },
  });
  assert.equal(finalizations, 1);
  const normal = { runnerId: 'runner-1', completion: play(adapters[0], [successResult]) };
  const outcome = settleAdapterCompletion(normal, { kind: 'stream', resolved: true });
  assert.equal(runtime.proxyFailure(attempt, { resultDurable: true, completion: outcome }), null);
  assert.equal(clearErrorFlagsForSucceededTurn(turn, { ...normal, sawApiError: true }, {}, {}), true);
  assert.equal(clearErrorFlagsForSucceededTurn(turn, { ...normal, runnerId: 'stale', sawApiError: true }, {}, {}), false);
  for (const failure of [{ httpStatus: 429 }, { proxyOutcome: { termination: 'upstream_failure' } }]) {
    assert.equal(canPersistAdapterCompletion(outcome, failure), false);
  }
  assert.equal(canPersistAdapterCompletion(outcome, null, { message: 'provider error envelope' }), false);
});

test('a finalization exception is reported once, never replayed as a stream rejection', async () => {
  let calls = 0;
  const runner = { completion: play(adapters[0], [successResult]) };
  await finalizeCompletionStream(Promise.resolve(), {
    runner, onRejected: assert.fail, finalize() { calls++; throw new Error('persistence failed'); },
    onFinalizeError(error) { assert.equal(error.message, 'persistence failed'); },
  });
  assert.equal(calls, 1);
  assert.equal(runner.completionOutcome.state, 'failed');
});

test('missing completion never turns exit zero or a saved answer into success', () => {
  const plan = planTurnFinalization({ current: true, runnerKind: 'process', code: 0,
    hasOutput: true, resultEvent: true, resultDurable: true });
  assert.equal(resolveTurnFinalization(plan).effects.some(e => e.type === 'complete-session-turn'), false);
});

test('persistent Claude ignores child/background results and joins its native process', async t => {
  const stream = require('../src/chat/chat-stream');
  const name = 'adapter-completion-boundary-test';
  t.after(() => stream.closeAndWait(name, { timeoutMs: 2000 }));
  const frames = [
    { ...successResult, origin: { kind: 'task-notification' }, result: 'background' },
    { ...successResult, parent_tool_use_id: 'child', result: 'child' },
    { ...successResult, result: 'main' },
  ];
  const script = `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n') + '\n')}));`;
  stream.ensure(name, { cmd: process.execPath, baseArgs: ['-e', script, '--'], sessionId: name,
    env: process.env, cwd: process.cwd() });
  const tracker = createAdapterCompletion(adapters[0]);
  const result = await stream.send(name, 'hello', raw => tracker.observe(raw, adapters[0].decodeEvent(raw)));
  assert.equal(result.result.result, 'main');
  assert.equal(isCompleted(tracker.finish({ kind: 'stream', resolved: true })), true);
});

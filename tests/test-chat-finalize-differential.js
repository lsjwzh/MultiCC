'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const legacy = require('./helpers/legacy-chat-finalize-plan');
const native = require('../src/chat/finalize-plan');

const NOW = 1234;

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

// Type-tagged view so key order, undefined-vs-missing, NaN, Infinity and -0 all
// participate in the comparison.
function view(value) {
  if (value === undefined) return { t: 'undefined' };
  if (value === null) return { t: 'null' };
  const type = typeof value;
  if (type === 'boolean') return { t: 'bool', v: value };
  if (type === 'number') {
    if (Number.isNaN(value)) return { t: 'number', v: 'NaN' };
    if (value === Infinity) return { t: 'number', v: 'Infinity' };
    if (value === -Infinity) return { t: 'number', v: '-Infinity' };
    if (Object.is(value, -0)) return { t: 'number', v: '-0' };
    return { t: 'number', v: value };
  }
  if (type === 'string') return { t: 'string', v: value };
  if (Array.isArray(value)) return { t: 'array', v: value.map(view) };
  if (type === 'object') {
    return { t: 'object', v: Object.keys(value).map(key => [key, view(value[key])]) };
  }
  return { t: type };
}

function stableDeps(limits, delays) {
  return { retry: { now: () => NOW, limits, delays } };
}

function comparePlan(input, deps, outcome, label) {
  const leftInput = clone(input);
  const rightInput = clone(input);
  const leftDeps = deps ? clone(deps) : deps;
  const rightDeps = deps ? clone(deps) : deps;
  // The oracle freezes plan.retry (the API decision object) in place; keep the
  // two sides fully independent.
  if (leftDeps && leftDeps.retry) leftDeps.retry.now = () => NOW;
  if (rightDeps && rightDeps.retry) rightDeps.retry.now = () => NOW;

  const expected = legacy.planTurnFinalization(leftInput, leftDeps);
  const actual = native.planTurnFinalization(rightInput, rightDeps);
  assert.deepEqual(view(actual), view(expected), `plan mismatch: ${label}`);

  const leftOutcome = clone(outcome || {});
  const rightOutcome = clone(outcome || {});
  const expectedResolved = legacy.resolveTurnFinalization(expected, leftOutcome);
  const actualResolved = native.resolveTurnFinalization(actual, rightOutcome);
  assert.deepEqual(view(actualResolved), view(expectedResolved), `resolve mismatch: ${label}`);
  return { expected, actual };
}

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

const BOOLISH = [true, false, undefined, 1, 0, 'yes', null];
const COMPLETIONS = [
  undefined,
  null,
  { version: 1, state: 'completed', settled: true },
  { version: 1, state: 'unknown', settled: true },
  { version: 1, state: 'failed', settled: false },
  { version: 1, state: 'cancelled' },
  { state: 'completed', settled: true },
];
const KILL_REASONS = [undefined, null, '', 'user_cancel', 'new_user_message', 'shutdown', 'session_delete', 'cli_switch', 0];
const SIGNALS = [undefined, null, '', 'SIGTERM', 'SIGINT', 'SIGPIPE', 0, false];
const CODES = [undefined, null, 0, 1, -1, '1', NaN, -0, 137];
const PENDING = [undefined, null, '', 'disconnect', false, 0, 'response.completed disconnected'];
const DECISIONS = [
  undefined,
  null,
  { action: 'retry', attempt: 1, delayMs: 7000, retryAt: 8000, error: { category: 'rate_limit', maxAttempts: 2 } },
  { action: 'retry', attempt: 0, delayMs: 0, retryAt: 0, error: { category: 'billing_quota', maxAttempts: 0 } },
  { action: 'wait_reset', attempt: 0, delayMs: 14_000, retryAt: 15_000, error: { category: 'billing_quota', maxAttempts: 0 } },
  { action: 'fail_fast', reason: 'authentication_permission_not_retryable', error: { category: 'authentication_permission', maxAttempts: 0 } },
  { action: 'retry', attempt: 2, error: { category: 'unknown' } },
];
const HANDOFFS = [
  undefined,
  null,
  {},
  { status: 'pending', reusedTarget: true, toCli: 'codex' },
  { status: 'pending', reusedTarget: true, toCli: 'claude' },
  { status: 'pending', reusedTarget: false, toCli: 'codex' },
  { pending: true, reusedTarget: true, toCli: 'codex' },
  { status: 'done', reusedTarget: true, toCli: 'codex' },
];
const CLI_VALUES = [undefined, '', 'codex', 'claude', 'CODEX', 'claude-exp', 'Codex'];

function randomInput(random) {
  const input = {};
  const runnerKind = pick(random, ['process', 'stream', undefined, 'Process']);
  if (runnerKind !== undefined) input.runnerKind = runnerKind;
  const cli = pick(random, CLI_VALUES);
  if (cli !== undefined) input.cli = cli;
  input.current = pick(random, BOOLISH);
  input.completion = pick(random, COMPLETIONS);
  input.killReason = pick(random, KILL_REASONS);
  input.apiError = pick(random, BOOLISH);
  input.adapterError = pick(random, BOOLISH);
  input.retryPlanned = pick(random, BOOLISH);
  input.retryUnavailable = pick(random, BOOLISH);
  input.retryUnavailableReason = pick(random, [undefined, null, '', 'run_not_active', 0]);
  input.resultEvent = pick(random, BOOLISH);
  input.resultDurable = pick(random, BOOLISH);
  input.hasOutput = pick(random, BOOLISH);
  input.sameDurablePartial = pick(random, BOOLISH);
  input.isRetry = pick(random, BOOLISH);
  input.recoveredTransport = pick(random, BOOLISH);
  input.pendingStreamError = pick(random, PENDING);
  input.nativeSession = pick(random, BOOLISH);
  input.replaySafeProviderError = pick(random, BOOLISH);
  input.signal = pick(random, SIGNALS);
  input.code = pick(random, CODES);
  input.apiErrorDecision = pick(random, DECISIONS);
  input.retryBlockedByAdapterError = pick(random, BOOLISH);
  input.handoff = pick(random, HANDOFFS);
  if (random() < 0.7) input.codexDisconnectAttempt = pick(random, [undefined, 0, 1, 2, 3, -1, '1']);
  if (random() < 0.7) input.freshStartAttempt = pick(random, [undefined, 0, 1, 2, '1']);
  return input;
}

test('randomized planning and resolution match the frozen implementation', () => {
  const random = mulberry32(0x5eed);
  const actions = new Set();
  const limitSets = [undefined, { codexDisconnect: 2 }, { freshStart: 0 }, { freshStart: 3, codexDisconnect: 1 }];
  const delaySets = [undefined, { freshStart: 5 }, { codexDisconnect: 9 }, { freshStart: 1, codexDisconnect: 2 }];
  for (let index = 0; index < 1200; index += 1) {
    const input = randomInput(random);
    const deps = stableDeps(pick(random, limitSets), pick(random, delaySets));
    const outcome = {
      resultDurable: pick(random, BOOLISH),
      appendPersisted: pick(random, BOOLISH),
    };
    const { expected, actual } = comparePlan(input, deps, outcome, `random#${index}`);
    assert.deepEqual(view(actual.facts), view(expected.facts), `facts mismatch: random#${index}`);
    actions.add(actual.action);

    if (expected.action === 'continue-codex' || expected.action === 'retry-fresh') {
      const overrides = { retryUnavailableReason: pick(random, ['run_not_active', '', undefined]) };
      const expectedBlocked = legacy.planRetryBlockedFinalization(expected, clone(overrides));
      const actualBlocked = native.planRetryBlockedFinalization(actual, clone(overrides));
      assert.deepEqual(view(actualBlocked), view(expectedBlocked), `blocked mismatch: random#${index}`);
    }
  }
  assert.equal(actions.size >= 3, true, 'randomized cases must span several dispositions');
});

test('branch table exercises every finality and retry decision', () => {
  const base = {
    completion: { version: 1, state: 'completed', settled: true },
    current: true,
    runnerKind: 'process',
    cli: 'codex',
    code: 0,
    signal: null,
    hasOutput: true,
    resultEvent: true,
    resultDurable: false,
  };
  const cases = [
    { label: 'stale', input: { ...base, current: false }, action: 'noop' },
    { label: 'codex continue', input: { ...base, pendingStreamError: 'x', nativeSession: true, codexDisconnectAttempt: 0, resultEvent: false }, action: 'continue-codex' },
    { label: 'codex capped', input: { ...base, pendingStreamError: 'x', nativeSession: true, codexDisconnectAttempt: 2, resultEvent: false }, action: 'finalize' },
    { label: 'codex no session', input: { ...base, pendingStreamError: 'x', nativeSession: false }, action: 'finalize' },
    { label: 'codex killed', input: { ...base, pendingStreamError: 'x', nativeSession: true, killReason: 'shutdown' }, action: 'finalize' },
    { label: 'fresh retry', input: { ...base, hasOutput: false, resultEvent: false }, action: 'retry-fresh' },
    { label: 'fresh retry exhausted', input: { ...base, hasOutput: false, resultEvent: false, isRetry: true }, action: 'finalize' },
    { label: 'fresh retry adapter', input: { ...base, hasOutput: false, resultEvent: false, adapterError: true }, action: 'finalize' },
    { label: 'fresh retry claude', input: { ...base, cli: 'claude', hasOutput: false, resultEvent: false }, action: 'finalize' },
    { label: 'api retry', input: { ...base, apiError: true, apiErrorDecision: DECISIONS[2] }, action: 'retry-api' },
    { label: 'api retry suppressed by handoff', input: { ...base, apiError: true, hasOutput: false, resultEvent: false, apiErrorDecision: DECISIONS[2], handoff: HANDOFFS[3] }, action: 'finalize' },
    { label: 'api retry replay safe', input: { ...base, runnerKind: 'stream', cli: 'claude', apiError: true, replaySafeProviderError: true, apiErrorDecision: DECISIONS[2], handoff: HANDOFFS[4] }, action: 'retry-api' },
    { label: 'api fail fast', input: { ...base, apiError: true, apiErrorDecision: DECISIONS[5] }, action: 'finalize' },
    { label: 'retry unavailable', input: { ...base, hasOutput: false, resultEvent: false, retryUnavailable: true }, action: 'finalize' },
    { label: 'process clean', input: { ...base }, action: 'finalize' },
    { label: 'process killed', input: { ...base, killReason: 'user_cancel' }, action: 'finalize' },
    { label: 'process nonzero', input: { ...base, code: 1 }, action: 'finalize' },
    { label: 'process signaled', input: { ...base, signal: 'SIGTERM' }, action: 'finalize' },
    { label: 'process recovered', input: { ...base, code: 1, recoveredTransport: true }, action: 'finalize' },
    { label: 'stream clean', input: { ...base, runnerKind: 'stream', cli: 'claude' }, action: 'finalize' },
    { label: 'stream no result', input: { ...base, runnerKind: 'stream', cli: 'claude', resultEvent: false }, action: 'finalize' },
    { label: 'stream guarded', input: { ...base, runnerKind: 'stream', cli: 'claude', resultEvent: false, hasOutput: false, handoff: HANDOFFS[4] }, action: 'finalize' },
  ];
  const seen = new Set();
  for (const { label, input, action } of cases) {
    const expected = legacy.planTurnFinalization(clone(input), stableDeps());
    const actual = native.planTurnFinalization(clone(input), stableDeps());
    assert.deepEqual(view(actual), view(expected), `table plan mismatch: ${label}`);
    assert.equal(actual.action, action, `table action: ${label}`);
    seen.add(action);
    for (const outcome of [{}, { resultDurable: true }, { appendPersisted: true }, { resultDurable: true, appendPersisted: true }]) {
      assert.deepEqual(
        view(native.resolveTurnFinalization(actual, clone(outcome))),
        view(legacy.resolveTurnFinalization(expected, clone(outcome))),
        `table resolve mismatch: ${label}`,
      );
    }
  }
  for (const action of ['noop', 'continue-codex', 'retry-api', 'retry-fresh', 'finalize']) {
    assert.equal(seen.has(action), true, `table must exercise ${action}`);
  }
});

test('classification, handoff normalization and guard stay byte-identical', () => {
  const random = mulberry32(0xbeef);
  for (let index = 0; index < 400; index += 1) {
    const exitInput = {
      signal: pick(random, SIGNALS),
      killReason: pick(random, KILL_REASONS),
      code: pick(random, CODES),
      recoveredTransport: pick(random, BOOLISH),
      resultDurable: pick(random, BOOLISH),
      hasOutput: pick(random, BOOLISH),
    };
    assert.equal(native.classifyProcessExit(clone(exitInput)), legacy.classifyProcessExit(clone(exitInput)));

    const handoffInput = { handoff: pick(random, HANDOFFS) };
    assert.deepEqual(view(native.normalizeHandoff(clone(handoffInput))), view(legacy.normalizeHandoff(clone(handoffInput))));

    const facts = {
      runnerKind: pick(random, ['process', 'stream']),
      cli: pick(random, ['codex', 'claude']),
      resultDurable: pick(random, BOOLISH),
      hasOutput: pick(random, BOOLISH),
      killReason: pick(random, KILL_REASONS),
      isRetry: pick(random, BOOLISH),
      retryBlockedByAdapterError: pick(random, BOOLISH),
    };
    const handoff = pick(random, [
      { pending: true, reusedTarget: true, toCli: 'codex' },
      { pending: true, reusedTarget: true, toCli: 'claude' },
      { pending: false, reusedTarget: true, toCli: 'codex' },
    ]);
    assert.equal(
      native.isGuardedHandoffFailure(clone(facts), clone(handoff)),
      legacy.isGuardedHandoffFailure(clone(facts), clone(handoff)),
    );
  }
});

test('plans, effects and results stay frozen and preserve host identities', () => {
  const decision = { action: 'retry', attempt: 1, delayMs: 0, retryAt: 1, error: { category: 'unknown', maxAttempts: 1 } };
  const input = {
    current: true, runnerKind: 'stream', cli: 'claude', code: 0, signal: null,
    hasOutput: true, resultEvent: true, resultDurable: false, apiError: true, apiErrorDecision: decision,
  };
  const plan = native.planTurnFinalization(input, stableDeps());
  assert.equal(plan.action, 'retry-api');
  assert.equal(plan.retry, decision, 'the accepted retry schedule keeps host identity');
  assert.equal(plan.facts.apiErrorDecision, decision);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.facts), true);
  assert.equal(Object.isFrozen(plan.effects), true);
  for (const effect of plan.effects) assert.equal(Object.isFrozen(effect), true);

  const finalPlan = native.planTurnFinalization({ ...input, apiError: false, apiErrorDecision: undefined }, stableDeps());
  assert.equal(finalPlan.action, 'finalize');
  assert.equal(Object.isFrozen(finalPlan.append), true);
  const resolved = native.resolveTurnFinalization(finalPlan, { appendPersisted: true });
  assert.equal(resolved.facts, finalPlan.facts, 'resolution reuses the plan facts object');
  assert.equal(resolved.append, finalPlan.append, 'resolution reuses the plan append object');
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.result), true);
  assert.equal(Object.isFrozen(resolved.effects), true);
  for (const effect of resolved.effects) assert.equal(Object.isFrozen(effect), true);
});

test('the host clock is sampled only when a retry is scheduled and its errors surface', () => {
  let nativeCalls = 0;
  let legacyCalls = 0;
  const nativeDeps = { retry: { now: () => { nativeCalls += 1; return NOW; } } };
  const legacyDeps = { retry: { now: () => { legacyCalls += 1; return NOW; } } };
  const scheduled = { current: true, runnerKind: 'process', cli: 'codex', code: 0, signal: null, hasOutput: false, resultEvent: false };
  assert.equal(native.planTurnFinalization(scheduled, nativeDeps).action, 'retry-fresh');
  assert.equal(legacy.planTurnFinalization(scheduled, legacyDeps).action, 'retry-fresh');
  assert.equal(nativeCalls, 1);
  assert.equal(legacyCalls, 1);

  nativeCalls = 0;
  legacyCalls = 0;
  const finalize = { current: true, runnerKind: 'process', cli: 'codex', code: 0, signal: null, hasOutput: true, resultEvent: true };
  assert.equal(native.planTurnFinalization(finalize, nativeDeps).action, 'finalize');
  assert.equal(legacy.planTurnFinalization(finalize, legacyDeps).action, 'finalize');
  assert.equal(nativeCalls, 0, 'a plain finalization must not sample the clock');
  assert.equal(legacyCalls, 0);

  const throwing = () => { throw new Error('clock down'); };
  assert.throws(() => native.planTurnFinalization(scheduled, { retry: { now: throwing } }), /clock down/);
  assert.throws(() => legacy.planTurnFinalization(scheduled, { retry: { now: throwing } }), /clock down/);
  assert.doesNotThrow(() => native.planTurnFinalization(finalize, { retry: { now: throwing } }));
  assert.doesNotThrow(() => legacy.planTurnFinalization(finalize, { retry: { now: throwing } }));
});


// 执行器以迁移前冻结的宿主实现为对照，比较完整端口轨迹和可见状态。
const legacyExecutor = require('./helpers/legacy-chat-finalize-host');
const nativeExecutor = require('../src/chat/finalize-host');

function executionHarness(owner, input, options = {}) {
  const calls = [];
  const runner = { id: 'runner' };
  runner.self = runner;
  const context = {
    sessionName: 's1', runnerKind: input.runnerKind, runner,
    turn: { resultDurable: input.resultDurable === true, turnId: 't1',
      task: { id: 'admitted-task', start: options.taskStart, source: options.taskSource } },
    cs: { cli: input.cli, _activeRunner: options.replaced ? {} : runner,
      isStreaming: true, claudeProc: runner, streamReplay: ['frame'],
      currentAssistantText: input.hasOutput ? 'answer' : '', currentToolCalls: ['tool'],
      chatTurnCount: options.count ?? 3, turnStartedAt: 100,
      _resultSaved: false, _sawApiError: input.apiError },
    stderrTail: options.stderrTail ?? ' stderr ', pendingTransportError: options.transport,
    code: input.code, signal: input.signal,
    ...options.context,
  };
  const captured = {};
  const error = new Error('port unavailable');
  const record = (name, args) => {
    calls.push([name, ...args]);
    if (options.fail === name) throw options.thrown ?? error;
  };
  const ports = {
    persistAssistant(ctx, append) {
      assert.equal(this, ports);
      assert.equal(ctx.cs, context.cs);
      assert.equal(ctx.runner, runner);
      assert.equal(Object.isFrozen(append), true);
      captured.context = ctx;
      record('persist', [append]);
      if (options.liveDurable !== undefined) ctx.turn.resultDurable = options.liveDurable;
      else if (options.persisted !== false && append.final) ctx.turn.resultDurable = true;
      return options.persisted !== undefined ? options.persisted : true;
    },
    commitUsage(ctx) {
      assert.equal(this, ports);
      record('usage', [ctx.turn.resultDurable]);
      return options.usage !== undefined ? options.usage : true;
    },
    broadcast(session, event) { record('broadcast', [session, event]); },
    cancelClassify(cs) { assert.equal(cs, context.cs); record('cancel', []); },
    clearIncrementalSave(session) { record('clear', [session]); },
    setStatus(session, status) { record('status', [session, status]); },
    completeSessionTurn(session) {
      record('complete', [session]);
      if (options.rejectComplete) return Promise.reject(error);
    },
    classifyTurnEnd(cs, session, opts) { record('classify', [session, opts]); },
    resetInterrupted(session) { record('reset', [session]); },
    resumeInterrupted(session) { record('resume', [session]); return options.resumed; },
    freezeInterrupted(session, reason) { record('freeze', [session, reason]); },
    emitTurnOutcome(session, event) { record('outcome', [session, event]); },
    runPostTurn(ctx, entry) {
      captured.postEntry = entry;
      record('post', [entry, ctx.finalText, ctx.appendPersisted, ctx.usageAttempted,
        ctx.usageDurable, ctx.usageError, ctx.terminalBlocked]);
    },
    recordRunResult(ctx, result) {
      captured.recorded = result;
      record('record', [result]);
    },
    now() { assert.equal(this, undefined); record('clock', []); return 200; },
    timelineField(session, cs, now) {
      assert.equal(this, undefined);
      record('timeline', [session, now]);
      return { timeline: { elapsed: 100 } };
    },
    log(event, detail) { record('log', [event, detail]); },
    logError(event, detail) {
      // 原生桥接产生的类型错误使用不同引擎文案；业务端口错误仍保留对象身份。
      if (detail.error === error) captured.errorIdentity = true;
      record('log-error', [event, detail.action, detail.error?.message ?? detail.error]);
    },
  };
  const plan = native.planTurnFinalization(clone(input), stableDeps());
  const result = owner.createTurnFinalizationExecutor(ports).execute(plan, context);
  const state = { ...context.cs, _activeRunner: context.cs._activeRunner === runner ? 'original'
    : context.cs._activeRunner === null ? null : 'replacement',
  claudeProc: context.cs.claudeProc === runner ? 'original' : context.cs.claudeProc };
  return { calls, state, turn: context.turn, result, captured, plan };
}

const EXECUTION_BASE = {
  completion: { version: 1, state: 'completed', settled: true },
  current: true, runnerKind: 'process', cli: 'codex', code: 0, signal: null,
  hasOutput: true, resultEvent: true, resultDurable: false,
};

function compareExecution(input, options, label) {
  const before = executionHarness(legacyExecutor, input, options);
  const after = executionHarness(nativeExecutor, input, options);
  for (const key of ['calls', 'state', 'turn', 'result']) {
    assert.deepEqual(view(after[key]), view(before[key]), `${label}: ${key}`);
  }
  assert.equal(Object.isFrozen(after.result), true);
  if (after.captured.recorded && after.result.resolved.code !== 'finalization_execution_failed') {
    assert.equal(after.captured.recorded, after.result.resolved);
  }
  if (after.captured.postEntry && after.result.resolved.code !== 'finalization_execution_failed') {
    assert.equal(Object.isFrozen(after.captured.postEntry), true);
    assert.equal(after.captured.postEntry,
      after.result.resolved.effects.find(entry => entry.type === 'run-post-turn'));
  }
  if (after.plan.action === 'finalize' && after.result.resolved.code !== 'finalization_execution_failed') {
    assert.equal(after.result.resolved.facts, after.plan.facts);
    assert.equal(after.result.resolved.append, after.plan.append);
  }
  return { before, after };
}

test('收尾执行：正常、重试、取消、历史失败及用量失败与旧宿主轨迹一致', () => {
  const variants = [
    {}, { current: false }, { resultDurable: true }, { resultEvent: false },
    { hasOutput: false, resultEvent: false }, { killReason: 'user_cancel' },
    { apiError: true }, { adapterError: true }, { signal: 'SIGTERM' }, { code: 1 },
    { pendingStreamError: 'disconnect', nativeSession: true, resultEvent: false },
    { handoff: { status: 'pending', reusedTarget: true, toCli: 'codex' }, hasOutput: false, resultEvent: false },
    { apiError: true, apiErrorDecision: DECISIONS[2] },
  ];
  const outcomes = [{}, { persisted: false }, { usage: false }, { usage: 'true' },
    { persisted: 'true', liveDurable: false }, { persisted: false, liveDurable: true },
    { fail: 'usage' }, { fail: 'persist' }, { replaced: true, taskStart: true },
    { count: '2', taskStart: true, taskSource: 'task-board' }];
  for (const runnerKind of ['process', 'stream']) {
    for (const variant of variants) {
      for (const outcome of outcomes) {
        const input = { ...EXECUTION_BASE, runnerKind, ...variant };
        compareExecution(input, outcome, JSON.stringify([runnerKind, variant, outcome]));
      }
    }
  }
});

test('收尾执行：宿主异常、Promise 拒绝和后续再次执行保留行为', async () => {
  for (const fail of ['cancel', 'clear', 'broadcast', 'status', 'complete', 'classify',
    'reset', 'outcome', 'post', 'record', 'usage', 'persist']) {
    compareExecution(EXECUTION_BASE, { fail }, fail);
  }
  for (const thrown of ['text error', { message: 'object error' }, 0, false]) {
    compareExecution(EXECUTION_BASE, { fail: 'usage', thrown }, String(thrown));
  }
  const before = executionHarness(legacyExecutor, EXECUTION_BASE, { rejectComplete: true });
  const after = executionHarness(nativeExecutor, EXECUTION_BASE, { rejectComplete: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(view(after.calls), view(before.calls));
  compareExecution(EXECUTION_BASE, {}, 'after failures');
});

test('收尾执行：随机计划及结果与冻结宿主一致', () => {
  const random = mulberry32(0x71f1);
  for (let i = 0; i < 350; i++) {
    compareExecution(randomInput(random), {
      persisted: pick(random, [true, false, 1]), usage: pick(random, [true, false, 1]),
      liveDurable: pick(random, [undefined, true, false]),
      replaced: random() < 0.5, transport: pick(random, [undefined, '连接中断']),
    }, `execution#${i}`);
  }
});

test('收尾执行：错误正文保留 UTF-16 代码单元及显式字符串转换', () => {
  const emptyRetry = { ...EXECUTION_BASE, isRetry: true, hasOutput: false, resultEvent: false };
  for (const stderrTail of [' \ud800 ', Symbol('stderr'), { toString: () => 'stderr object' }]) {
    compareExecution(emptyRetry, { stderrTail }, 'stderr coercion');
  }
  compareExecution(emptyRetry, { transport: '\udc00 transport' }, 'transport UTF-16');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapterCompletion, isCompleted } = require('../src/cli-adapters/completion');
const { settleAdapterCompletion, canPersistAdapterCompletion, finalizeCompletionStream } = require('../src/chat/adapter-completion');
const { clearErrorFlagsForSucceededTurn, evaluatePostTurn } = require('../src/chat/turn-lifecycle');
const { planTurnFinalization, resolveTurnFinalization } = require('../src/chat/finalize-plan');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { observeProxyRequest } = require('../src/providers/proxy-outcome');
const { createTurnEventJournal } = require('../src/chat/turn-event-journal');
const { recordResultEvent } = require('../src/chat/turn-lifecycle');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const adapters = [
  require('../src/cli-adapters/claude').createClaudeAdapter({}),
  require('../src/cli-adapters/claude-exp').createClaudeExpAdapter({}),
  require('../src/cli-adapters/codex').createCodexAdapter({}),
  require('../src/cli-adapters/codex-exp').createCodexExpAdapter({}),
  // Legacy JSON lane; the default ACP lane's completion is covered by test-acp-adapter.js.
  require('../src/cli-adapters/opencode').createOpencodeAdapter({ env: { MULTICC_OPENCODE_LEGACY_JSON: '1' } }),
  require('../src/cli-adapters/zcode').createZcodeAdapter({}),
  require('../src/cli-adapters/qoder').createQoderAdapter({}),
  require('../src/cli-adapters/kimi').createKimiAdapter({}),
  require('../src/cli-adapters/codebuddy').createCodebuddyAdapter({}),
  require('../src/cli-adapters/dsh').createDshAdapter({}),
];
const successResult = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' };
const traces = {
  claude: [successResult], 'claude-exp': [successResult], qoder: [{ type: 'result', subtype: 'success', is_error: false }],
  codebuddy: [{ type: 'result', subtype: 'success', is_error: false }],
  codex: [{ type: 'turn.completed', usage: {} }],
  'codex-exp': [{ method: 'turn/completed', params: { turn: { id: 'turn-exp', status: 'completed' } } }],
  opencode: [{ type: 'step_start' }, { type: 'step_finish', part: { reason: 'stop' } }],
  zcode: [{ type: 'step_finish', part: { reason: 'stop' } }],
  kimi: [{ role: 'meta', type: 'session.resume_hint', session_id: 'session-1' }],
  dsh: [{ type: 'session_finished' }, { type: 'complete' }],
};
const exit0 = { kind: 'process', code: 0 };

// Frozen pre-migration policies: compare native reads and coercions as well as
// the resulting evidence. These references are test-only.
function legacyCompletion(state, reason, source = 'protocol') {
  if (!new Set(['completed', 'failed', 'cancelled', 'unknown']).has(state)) throw new TypeError('invalid CLI completion state');
  return Object.freeze({ version: 1, state, reason: typeof reason === 'string' ? reason.slice(0, 160) : 'unknown_reason', source });
}
function legacyIsCompleted(outcome) {
  return outcome?.version === 1 && outcome.state === 'completed' && outcome.settled === true;
}
function legacyMainResult(event) {
  return event?.type === 'result' && event.parent_tool_use_id == null && event.origin?.kind !== 'task-notification';
}
function legacyResultCompletion(event) {
  if (!legacyMainResult(event)) return null;
  const reason = event.terminal_reason;
  if (['cancelled', 'aborted', 'interrupted'].includes(reason)) return legacyCompletion('cancelled', reason);
  if (event.is_error === true || /^error(?:_|$)/.test(event.subtype || '') || reason === 'api_error') {
    return legacyCompletion('failed', reason || event.subtype || 'error_result');
  }
  if (reason !== undefined && reason !== 'completed') return legacyCompletion('unknown', 'unrecognized_terminal_reason');
  if (event.subtype === 'success' && event.is_error === false) return legacyCompletion('completed', reason || 'success_result');
  return legacyCompletion('unknown', 'unrecognized_result');
}
function legacyCompatible(failure, outcome) {
  if (!failure || !legacyIsCompleted(outcome)) return false;
  if (outcome.source === 'protocol' || outcome.source === 'protocol_and_exit') return true;
  return failure.httpStatus == null && failure.proxyOutcome?.termination === 'downstream_disconnect';
}
function legacyCanPersist(outcome, failure, envelope) {
  return legacyIsCompleted(outcome) && !envelope && (!failure || legacyCompatible(failure, outcome));
}

function legacyTracker({ observe, close, fallback = false } = {}) {
  let evidence = legacyCompletion('unknown', 'missing_terminal_event');
  let ended = false, failed = false, hasOutput = false, sawError = false;
  const tools = new Set();
  return Object.freeze({
    observe(raw, decoded = []) {
      if (ended || !raw || typeof raw !== 'object') return evidence;
      for (const event of decoded) {
        if (!event) continue;
        if (event.type === 'assistant_text' && event.text) hasOutput = true;
        if (event.type === 'error') sawError = true;
        if (event.type === 'tool_start' || event.type === 'tool_update' && !event.completed) tools.add(event.id);
        if (event.type === 'tool_result' || event.type === 'tool_update' && event.completed) tools.delete(event.id);
      }
      const next = observe?.(raw, decoded);
      if (next && !failed) {
        evidence = next;
        failed = next.state === 'failed' || next.state === 'cancelled';
        if (next.state === 'completed') sawError = false;
      }
      return evidence;
    },
    finish(boundary = {}) {
      if (ended) return evidence;
      ended = true;
      if (boundary.killReason) evidence = legacyCompletion('cancelled', boundary.killReason, 'host');
      else if (failed) {}
      else if (boundary.rejected) evidence = legacyCompletion('failed', 'stream_rejected', 'host');
      else if (boundary.signal) evidence = legacyCompletion('failed', 'process_signaled', 'host');
      else if (boundary.kind === 'process' && boundary.code !== 0) evidence = legacyCompletion('failed', 'nonzero_exit', 'host');
      else if (boundary.kind === 'stream' && boundary.resolved !== true) evidence = legacyCompletion('unknown', 'missing_stream_settlement', 'host');
      else if (!['process', 'stream'].includes(boundary.kind)) evidence = legacyCompletion('unknown', 'missing_execution_boundary', 'host');
      else if (!failed) {
        evidence = close?.(boundary, evidence, { hasOutput, sawError, pendingTools: tools.size }) || evidence;
        if (fallback && evidence.state === 'unknown' && boundary.kind === 'process'
            && boundary.code === 0 && hasOutput && !sawError && tools.size === 0) {
          evidence = legacyCompletion('completed', 'clean_exit_with_output', 'exit_fallback');
        }
      }
      evidence = Object.freeze({ ...evidence, settled: true });
      return evidence;
    },
    snapshot() { return evidence; },
  });
}

test('Rust completion tracker matches legacy traces and opaque tool identities', () => {
  const { createCompletionTracker } = require('../src/cli-adapters/completion');
  const ids = ['a', 'b', NaN, 0, -0, {}, {}, Symbol('a'), Symbol('a'), undefined, 1n];
  const evidence = ['unknown', 'completed', 'failed', 'cancelled'].map(state => legacyCompletion(state, state));
  const symbol = Symbol('evidence');
  evidence.push({ state: 'unknown', [symbol]: ids[5] }, 'opaque', true, null);
  const boundaries = [exit0, { kind: 'process', code: 1 }, { kind: 'process', code: '0' }, { kind: 'process', code: 0, signal: 'SIGTERM' },
    { kind: 'process', code: 0, killReason: 'user_cancel' }, { kind: 'stream', resolved: true }, { kind: 'stream' }, { rejected: true }, {}];
  let seed = 0x31284;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 1200; i++) {
    const facts = [[], []], calls = [0, 0];
    const options = side => ({ fallback: i % 2 === 0,
      observe(raw) { calls[side]++; return raw.evidence; },
      close(_boundary, current, value) { facts[side].push(value); return current; },
    });
    const actual = createCompletionTracker(options(0)), expected = legacyTracker(options(1));
    for (let n = 0; n < 16; n++) {
      const event = { type: ['assistant_text', 'error', 'tool_start', 'tool_update', 'tool_result'][next() % 5],
        text: next() % 2 ? 'output' : '', completed: next() % 3 === 0, id: ids[next() % ids.length] };
      const raw = next() % 3 ? {} : { evidence: evidence[next() % evidence.length] };
      assert.deepEqual(actual.observe(raw, [event]), expected.observe(raw, [event]));
    }
    const boundary = boundaries[next() % boundaries.length];
    assert.deepEqual(actual.finish(boundary), expected.finish(boundary));
    assert.deepEqual(facts[0], facts[1]);
    assert.equal(calls[0], calls[1]);
    const settled = actual.snapshot();
    assert.equal(Object.isFrozen(settled), true);
    assert.equal(actual.finish({ rejected: true }), settled);
    assert.equal(actual.observe({ evidence: evidence[2] }, [{ type: 'error' }]), settled);
  }
  for (const id of ids) {
    const tracker = createCompletionTracker({ fallback: true });
    tracker.observe({}, [{ type: 'assistant_text', text: 'out' }, { type: 'tool_start', id }, { type: 'tool_result', id }]);
    assert.equal(tracker.finish(exit0).state, 'completed');
  }
});

test('Rust completion tracker permits host reentry and preserves iterable cleanup and exceptions', () => {
  const { createCompletionTracker } = require('../src/cli-adapters/completion');
  function run(create) {
    const reads = [];
    let entered = false;
    const tracker = create({ fallback: true,
      observe(raw) { reads.push(['observe', raw.type, tracker.snapshot().state]); return null; },
      close(_boundary, evidence, facts) {
        reads.push(['close', facts, tracker.finish({ rejected: true }) === evidence]);
        return evidence;
      },
    });
    const event = { get type() {
      reads.push('type');
      if (!entered) { entered = true; tracker.observe({ type: 'inner' }, [{ type: 'tool_start', id: 'nested' }]); }
      return 'assistant_text';
    }, get text() { reads.push('text'); return 'output'; } };
    tracker.observe({ type: 'outer' }, [event, { type: 'tool_result', id: 'nested' }]);
    const final = tracker.finish(new Proxy(exit0, { get(obj, key) { reads.push(key); return obj[key]; } }));
    return { reads, final };
  }
  assert.deepEqual(run(createCompletionTracker), run(legacyTracker));
  const sentinel = new Error('decoded getter failed');
  for (const create of [createCompletionTracker, legacyTracker]) {
    const tracker = create({ fallback: true });
    let closed = false;
    function* decoded() {
      try { yield { get type() { throw sentinel; } }; }
      finally { closed = true; }
    }
    assert.throws(() => tracker.observe({}, decoded()), error => error === sentinel);
    assert.equal(closed, true);
    assert.throws(() => tracker.finish({ get killReason() { throw sentinel; } }), error => error === sentinel);
    assert.equal(tracker.finish(exit0).settled, undefined, 'a throwing boundary preserves the previously closed tracker contract');
  }
});

test('native completion rules match legacy values, UTF-16 truncation and error types', () => {
  const { completion } = require('../src/cli-adapters/completion');
  const { isMainResult, resultCompletion } = require('../src/cli-adapters/result-completion');
  const { isProxyFailureCompatibleWithCompletion } = require('../src/chat/adapter-completion');
  const source = Object.freeze({ marker: Symbol('source') });
  for (const state of ['completed', 'failed', 'cancelled', 'unknown']) {
    for (const reason of [undefined, null, false, 42, 42n, Symbol('reason'), {}, new String('boxed'), '', '\ud800', 'x'.repeat(159) + '😀tail']) {
      const actual = completion(state, reason, source);
      assert.deepEqual(actual, legacyCompletion(state, reason, source));
      assert.equal(actual.source, source);
      assert.equal(Object.isFrozen(actual), true);
    }
  }
  for (const state of [undefined, null, true, 1, {}, new String('completed'), Symbol('completed')]) {
    assert.throws(() => completion(state), { name: 'TypeError', message: 'invalid CLI completion state' });
  }
  const values = [undefined, null, false, true, '', 'completed', 'cancelled', 'aborted', 'interrupted',
    'api_error', 'error', 'error_code', 'error\n', 'success', 0, 1, 1n, {}, []];
  let seed = 0x96242;
  const choose = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  for (let i = 0; i < 8000; i++) {
    const event = { type: i % 7 ? 'result' : choose(), parent_tool_use_id: i % 9 ? null : choose(),
      origin: i % 11 ? undefined : { kind: 'task-notification' }, terminal_reason: choose(), is_error: choose(), subtype: choose() };
    assert.equal(isMainResult(event), legacyMainResult(event));
    assert.deepEqual(resultCompletion(event), legacyResultCompletion(event));
    const outcome = { version: i % 3 ? 1 : choose(), state: i % 4 ? 'completed' : choose(), settled: i % 5 ? true : choose(),
      source: ['protocol', 'protocol_and_exit', 'exit_fallback', 'host'][i % 4] };
    const failure = i % 7 ? { httpStatus: i % 3 ? null : 502, proxyOutcome: { termination: i % 2 ? 'downstream_disconnect' : 'upstream_failure' } } : null;
    const envelope = i % 9 ? null : {};
    assert.equal(isCompleted(outcome), legacyIsCompleted(outcome));
    assert.equal(isProxyFailureCompatibleWithCompletion(failure, outcome), legacyCompatible(failure, outcome));
    assert.equal(canPersistAdapterCompletion(outcome, failure, envelope), legacyCanPersist(outcome, failure, envelope));
  }
});

test('native completion reads preserve getter order, short circuits, coercion and thrown identity', () => {
  const { resultCompletion } = require('../src/cli-adapters/result-completion');
  const sentinel = new Error('getter sentinel');
  function compare(native, legacy, make) {
    const execute = fn => {
      const reads = [];
      const args = make(reads);
      try { return { value: fn(...args), reads }; }
      catch (error) { return { error, reads }; }
    };
    const expected = execute(legacy), actual = execute(native);
    assert.deepEqual(actual.reads, expected.reads);
    if (expected.error) assert.equal(actual.error, expected.error);
    else assert.deepEqual(actual.value, expected.value);
  }
  for (const throwAt of [null, 'type', 'parent_tool_use_id', 'origin', 'terminal_reason', 'is_error', 'subtype']) {
    compare(resultCompletion, legacyResultCompletion, reads => [new Proxy({ type: 'result', parent_tool_use_id: null,
      origin: { kind: 'main' }, terminal_reason: undefined, is_error: false, subtype: 'success' }, {
      get(target, key) { reads.push(key); if (key === throwAt) throw sentinel; return target[key]; },
      ownKeys() { throw new Error('the native policy must not eagerly enumerate its input'); },
    })]);
  }
  compare(resultCompletion, legacyResultCompletion, reads => [{ type: 'result', is_error: false,
    subtype: { [Symbol.toPrimitive](hint) { reads.push(hint); return 'error_native'; } } }]);
  compare(canPersistAdapterCompletion, legacyCanPersist, reads => {
    let n = 0;
    const outcome = new Proxy({ version: 1, state: 'completed', settled: true }, {
      get(target, key) { reads.push(key); return key === 'source' ? (++n === 1 ? 'host' : 'protocol_and_exit') : target[key]; },
    });
    return [outcome, { get httpStatus() { throw sentinel; } }, null];
  });
  for (const fn of [resultCompletion, legacyResultCompletion]) {
    assert.throws(() => fn({ type: 'result', subtype: Symbol('subtype') }), TypeError);
  }
});

function legacyProtocol(protocol, event) {
  const complete = legacyCompletion;
  if (protocol === 'codex') {
    if (event.type === 'turn.completed') return event.error != null ? complete('failed', 'terminal_error') : complete('completed', 'turn.completed');
    if (event.type === 'turn.failed') return complete('failed', 'turn.failed');
    if (event.type === 'turn.aborted') return complete('cancelled', 'turn.aborted');
  } else if (protocol === 'codex-exp') {
    if (event?.method !== 'turn/completed') return null;
    const status = event.params?.turn?.status;
    if (status === 'completed') return complete('completed', 'turn/completed');
    if (status === 'interrupted') return complete('cancelled', 'turn/interrupted');
    return complete('failed', `turn/${status || 'failed'}`);
  } else if (protocol === 'dsh') {
    if (event.type === 'complete') return complete('completed', 'turn_end_completed');
    if (event.type === 'error') return complete(event.reason === 'aborted' ? 'cancelled' : 'failed', event.reason || 'turn_error');
  } else if (protocol === 'acp') {
    if (event?.method === 'multicc/error') return complete('failed', `acp_${event.params?.phase || 'error'}`);
    if (event?.method !== 'multicc/turnEnd') return null;
    const reason = event.params?.stopReason || 'unknown';
    if (reason === 'end_turn') return complete('completed', 'acp/end_turn');
    if (reason === 'cancelled') return complete('cancelled', 'acp/cancelled');
    return complete('failed', `acp/${reason}`);
  } else if (protocol === 'commandcode') {
    const nested = event.event || event;
    if (nested.type === 'error') return complete('failed', 'commandcode/error');
    if (event.type !== 'result') return null;
    return complete(event.subtype === 'success' && event.stopReason === 'end_turn' ? 'completed' : 'failed',
      `commandcode/${event.stopReason || event.subtype || 'unknown'}`);
  }
  return null;
}

test('five native CLI protocols preserve legacy values, lazy reads and coercions', () => {
  const native = require('../src/native/runtime').getNative();
  const values = [undefined, null, false, true, '', 'completed', 'interrupted', 'end_turn', 'cancelled', 'aborted',
    'success', 0, NaN, 1, 1n, {}, [], Symbol('reason'), '\ud800', 'x'.repeat(159) + '😀'];
  const protocols = ['codex', 'codex-exp', 'dsh', 'acp', 'commandcode'];
  const types = ['turn.completed', 'turn.failed', 'turn.aborted', 'complete', 'error', 'result', 'other'];
  const methods = ['turn/completed', 'multicc/error', 'multicc/turnEnd', 'other'];
  let seed = 7329;
  const pick = list => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return list[seed % list.length]; };
  const sentinel = new Error('protocol getter failed');
  const execute = (fn, event, throwAt) => {
    const reads = [];
    const wrap = (value, path = '') => value && typeof value === 'object' ? new Proxy(value, {
      get(target, key) { const name = `${path}.${String(key)}`; reads.push(name); if (name === throwAt) throw sentinel; return wrap(Reflect.get(target, key), name); },
      ownKeys() { throw new Error('unexpected eager enumeration'); },
    }) : value;
    try { return { value: fn(wrap(event)), reads }; }
    catch (error) { return { error, reads }; }
  };
  for (let i = 0; i < 2500; i++) {
    const event = { type: pick(types), method: pick(methods), error: pick(values), reason: pick(values),
      subtype: pick(values), stopReason: pick(values), event: i % 5 ? undefined : { type: pick(types) },
      params: { turn: { status: pick(values) }, phase: pick(values), stopReason: pick(values) } };
    for (const protocol of protocols) {
      const throwAt = i % 7 === 0 ? pick(['.type', '.params', '.params.turn.status', '.event', '.reason']) : null;
      const actual = execute(value => native.cliProtocolCompletion(protocol, value), event, throwAt);
      const expected = execute(value => legacyProtocol(protocol, value), event, throwAt);
      assert.deepEqual(actual.reads, expected.reads, protocol);
      if (expected.error) {
        assert.ok(actual.error, protocol);
        assert.equal(actual.error === sentinel, expected.error === sentinel);
        assert.equal(actual.error.name, expected.error.name);
      } else assert.deepEqual(actual.value, expected.value, protocol);
    }
  }
});

function legacyKimiHooks() {
  let resumeHint = false;
  return {
    observe(event) {
      if (event.role === 'meta' && event.type === 'session.resume_hint'
          && typeof event.session_id === 'string' && event.session_id.trim()) resumeHint = true;
      return null;
    },
    close(boundary, evidence, facts) {
      return boundary.kind === 'process' && resumeHint && !facts.sawError && !facts.pendingTools
        ? legacyCompletion('completed', 'print_resume_hint', 'protocol_and_exit') : evidence;
    },
  };
}
const legacyLastAssistant = event => (event.messages || []).filter(message => message.role === 'assistant').at(-1);
function legacyPiHooks() {
  let latest = legacyCompletion('unknown', 'pi_missing_agent_end');
  return {
    observe(event) {
      if (event.type === 'agent_start' || event.type === 'auto_retry_start') latest = legacyCompletion('unknown', 'pi_agent_running');
      else if (event.type === 'agent_end') {
        const reason = legacyLastAssistant(event)?.stopReason;
        latest = legacyCompletion(reason === 'stop' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed', `pi_${reason || 'missing_assistant'}`);
      } else if (event.type === 'auto_retry_end' && !event.success) latest = legacyCompletion('failed', 'pi_retry_exhausted');
      return null;
    },
    close(_boundary, _evidence, facts) {
      return latest.state === 'completed' && facts.pendingTools ? legacyCompletion('failed', 'pi_pending_tools') : latest;
    },
  };
}

test('Kimi and Pi native completion states match legacy recovery, errors and tool settlement', () => {
  const kimi = adapters.find(adapter => adapter.name === 'kimi');
  const pi = require('../src/cli-adapters/pi').createPiAdapter({});
  let seed = 74247;
  const pick = list => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return list[seed % list.length]; };
  const values = [undefined, null, false, '', 'stop', 'aborted', 'length', 'error', '\ud800', 'x'.repeat(200), 0, 1, {}];
  for (const [adapter, hooks] of [[kimi, legacyKimiHooks], [pi, legacyPiHooks]]) {
    for (let i = 0; i < 400; i++) {
      const actual = adapter.createCompletionTracker(), expected = legacyTracker(hooks());
      for (let n = 0; n < 20; n++) {
        const raw = { type: pick(['session.resume_hint', 'agent_start', 'agent_end', 'auto_retry_start', 'auto_retry_end']),
          role: pick(['meta', 'assistant']), session_id: pick(['session', ' \n ', undefined]), success: pick(values),
          messages: [{ role: 'assistant', stopReason: pick(values) }, { role: 'tool' }] };
        const decoded = [{ type: pick(['assistant_text', 'error', 'tool_start', 'tool_result']), text: 'text', id: pick(['a', 'b']) }];
        assert.deepEqual(actual.observe(raw, decoded), expected.observe(raw, decoded));
      }
      const boundary = pick([exit0, { kind: 'stream', resolved: true }, { kind: 'process', code: 1 }, { killReason: 'cancel' }]);
      assert.deepEqual(actual.finish(boundary), expected.finish(boundary));
    }
  }
});

test('native stateful protocol hooks keep receiver, getter reentry and thrown identity', () => {
  const native = require('../src/native/runtime').getNative();
  for (const create of [legacyKimiHooks, () => new native.RustKimiCompletionTracker()]) {
    const hooks = create();
    const sentinel = new Error('trim failed');
    let reads = 0;
    const event = { role: 'meta', type: 'session.resume_hint', get session_id() {
      if (++reads === 1) return 'valid';
      const receiver = { trim() { assert.equal(this, receiver); throw sentinel; } };
      return receiver;
    } };
    assert.throws(() => hooks.observe(event), error => error === sentinel);
    assert.equal(reads, 2);
    const evidence = {};
    assert.equal(hooks.close(exit0, evidence, { sawError: false, pendingTools: 0 }), evidence);
  }
  const runPi = nativeSide => {
    const tracker = nativeSide ? new native.RustPiCompletionTracker() : legacyPiHooks();
    const observe = event => tracker.observe(event, legacyLastAssistant);
    observe({ type: 'agent_end', messages: [{ role: 'assistant', get stopReason() {
      observe({ type: 'auto_retry_start' });
      return 'stop';
    } }] });
    const facts = { get pendingTools() { observe({ type: 'auto_retry_start' }); return 0; } };
    return nativeSide ? tracker.close(facts) : tracker.close(exit0, null, facts);
  };
  assert.deepEqual(runPi(true), runPi(false));
});

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

for (const name of ['claude', 'claude-exp', 'qoder', 'codebuddy']) {
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
    assert.equal(canPersistAdapterCompletion(outcome, failure), true,
      'a normal native completion reconciles historical request errors');
    assert.equal(canPersistAdapterCompletion({ ...outcome, state: 'failed' }, failure), false);
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

test('恢复后的整轮结果不受代理回调顺序影响，错误日志仍落盘', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multicc-recovery-journal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const cli of ['codex', 'codex-exp', 'claude']) {
    for (const order of ['success-first', 'success-late', 'disconnect', 'missing-success', 'terminal-failure']) {
      await t.test(`${cli}: ${order}`, async subtest => {
        const journal = createTurnEventJournal({ dir: () => dir });
        const sessionId = `${cli}-${order}`;
        subtest.after(() => journal.whenIdle(sessionId));
        const runtime = createProviderAttemptRuntime({ audit: journal.note });
        const attempt = runtime.beginAttempt({ sessionId, turnId: 'turn', cli,
          providerId: 'provider', providerName: 'Provider', model: 'model',
          protocol: cli === 'claude' ? 'anthropic' : 'openai-responses', providerRevision: 'rev', attemptNo: 1 });
        const identity = { ...attempt, roleKind: 'main', routeAttribution: 'exact' };
        function request() {
          const req = Object.assign(new EventEmitter(), { method: 'POST',
            url: cli === 'claude' ? '/v1/messages' : '/responses' });
          const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false });
          const observation = observeProxyRequest(cli === 'claude' ? 'claude' : 'codex', req, res,
            (proxyOutcome, event) => runtime.observeProxyOutcome({ ...identity, ...event, proxyOutcome }));
          return { observation, res };
        }
        const first = request();
        first.observation.settle({ status: 'error', statusCode: 502, errorCode: 'UPSTREAM_HTTP_ERROR' });
        const original = runtime.proxyFailure(attempt);
        const retry = request();
        if (order === 'success-first' || order === 'terminal-failure') {
          retry.observation.settle({ status: 'success', statusCode: 200 });
        } else if (order === 'disconnect') retry.res.emit('close');
        const adapter = adapters.find(item => item.name === cli);
        const terminalFailure = cli === 'codex' ? { type: 'turn.failed' }
          : cli === 'codex-exp' ? { method: 'turn/completed', params: { turn: { status: 'failed' } } }
            : { type: 'result', subtype: 'error_during_execution', is_error: true };
        const runner = { runnerId: 'runner', turnId: 'turn', sawApiError: true,
          apiErrorRaw: { code: 'UPSTREAM_HTTP_ERROR', httpStatus: 502 },
          completion: play(adapter, order === 'terminal-failure' ? [terminalFailure] : traces[cli]) };
        const turn = { turnId: 'turn', resultDurable: false };
        const cs = { _sawApiError: true, _codexTransportError: 'connection reset', _codexPendingStreamError: 'stream cut' };
        const completion = settleAdapterCompletion(runner, { kind: 'stream', resolved: true });
        const persisted = canPersistAdapterCompletion(completion, runtime.proxyFailure(attempt));
        recordResultEvent(turn, runner, { current: true, persisted });
        clearErrorFlagsForSucceededTurn(turn, runner, cs, {});
        const apiError = !!runtime.proxyFailure(attempt, { resultDurable: turn.resultDurable, completion })
          || !!runner.sawApiError || !!cs._codexTransportError;
        const resolved = resolveTurnFinalization(planTurnFinalization({ current: true,
          runnerKind: 'stream', cli, completion, hasOutput: true,
          resultEvent: true, resultDurable: turn.resultDurable, apiError }));
        const classification = resolved.effects.find(effect => effect.type === 'classify-turn-end').classification;
        const succeeded = order !== 'terminal-failure';
        assert.equal(persisted, succeeded);
        assert.equal(classification, succeeded ? 'succeeded' : 'api-error');
        const postTurn = resolved.effects.find(effect => effect.type === 'run-post-turn');
        assert.equal(postTurn.apiError, !succeeded);
        runtime.finishAttempt(attempt, { outcome: succeeded ? 'succeeded' : 'failed' });
        if (order === 'success-late') retry.observation.settle({ status: 'success', statusCode: 200 });
        assert.equal(runtime.snapshot(sessionId).outcome, succeeded ? 'succeeded' : 'failed');
        assert.equal(runtime.proxyFailure(attempt).httpStatus, 502);
        await journal.whenIdle(sessionId);
        const errors = journal.read(sessionId).filter(item => item.event.type === 'provider_attempt_proxy_failure_observed');
        assert.ok(errors.some(item => item.event.httpStatus === 502
          && item.event.code === 'UPSTREAM_HTTP_ERROR' && item.event.requestId === original.requestId));
        if (order === 'disconnect') assert.ok(errors.some(item => item.event.termination === 'downstream_disconnect'));
      });
    }
  }
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

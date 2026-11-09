'use strict';

// Differential test for the adapter-neutral chat-event reducer.
//
// The frozen Node implementation in tests/helpers/legacy-adapter-chat-event.js is
// the oracle. Each sequence drives both reducers from byte-identical starting
// state with byte-identical wire events; the final cs/persisted/turn/runner/
// forwards snapshot and the ordered host-effect log must match exactly. Every
// adapter family reaches the same reducer with its own `provider.name`, so the
// table below exercises codex/opencode/kimi/pi/zcode/commandcode names against
// the events their decoders emit.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { getNative } = require('../src/native/runtime');
const { applyAdapterChatEventLegacy } = require('./helpers/legacy-adapter-chat-event');
const { applyClaudeChatEventLegacy } = require('./helpers/legacy-claude-chat-event');
const { captureNativeSessionId } = require('../src/chat/native-session-state');

const native = getNative();

// ── deterministic cloning / serialization ───────────────────────────────────
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof Set) return new Set([...value].map(clone));
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [clone(key), clone(item)]));
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

// Property order, present-but-undefined keys, NaN/-0/infinities and lone
// surrogates are all significant, so JSON.stringify cannot be the comparison.
function serialize(value, seen = new Set()) {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'T' : 'F';
  if (kind === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return '+Inf';
    if (value === -Infinity) return '-Inf';
    if (Object.is(value, -0)) return '-0';
    return 'n' + value;
  }
  if (kind === 'string') return 's' + JSON.stringify(value);
  if (kind === 'bigint') return 'b' + value;
  if (kind === 'function') return 'fn';
  if (kind === 'symbol') return 'sym:' + String(value);
  if (seen.has(value)) return 'cycle';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = '[' + value.map(item => serialize(item, seen)).join(',') + ']';
  } else if (value instanceof Set) {
    out = 'Set{' + [...value].map(item => serialize(item, seen)).join(',') + '}';
  } else if (value instanceof Map) {
    out = 'Map{' + [...value].map(([key, item]) => serialize(key, seen) + '=>' + serialize(item, seen)).join(',') + '}';
  } else {
    out = '{' + Object.keys(value).map(key => JSON.stringify(key) + ':' + serialize(value[key], seen)).join(',') + '}';
  }
  seen.delete(value);
  return out;
}

const digest = text => crypto.createHash('sha1').update(text).digest('hex');
function encodeValue(value, run) {
  if (value === run.cs) return '#cs';
  if (value === run.turn) return '#turn';
  if (value === run.runner) return '#runner';
  if (value === run.persisted) return '#persisted';
  if (value === run.ports) return '#ports';
  if (value === run.provider) return '#provider';
  const text = serialize(value);
  return text.length > 512 ? `#h${text.length}:${digest(text)}` : text;
}

// ── fake adapters (decodeEvent is the only adapter-owned port) ──────────────
function decodeWire(kind, raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return raw;
  switch (raw.mode) {
    case 'array': return raw.events;
    case 'single': return raw.events[0];
    case 'null': return null;
    case 'undefined': return undefined;
    case 'object': return raw.events[0];
    case 'throwing': throw new Error(`decode ${kind} exploded`);
    default: return raw.events || [];
  }
}

function makeProvider(kind) {
  return { name: kind, decodeEvent(raw) { return decodeWire(kind, raw); } };
}

const ADAPTER_KINDS = ['codex', 'codex-exp', 'opencode', 'opencode-like', 'kimi', 'pi', 'zcode', 'commandcode', 'acp'];

// ── one reducer run ─────────────────────────────────────────────────────────
function createRun(scenario) {
  const run = {
    cs: clone(scenario.cs),
    persisted: clone(scenario.persisted || {}),
    turn: clone(scenario.turn),
    runner: clone(scenario.runner),
    portEffects: [],
    effects: [],
    forwards: [],
    scenario,
    provider: makeProvider(scenario.kind || 'codex'),
  };
  run.cs.currentTurn = run.turn;
  run.cs.currentRunner = run.runner;
  if (scenario.stale) run.cs.currentTurn = { turnId: 'stale-turn' };
  // The completion tracker is a host object on the runner; its `observe` is an
  // effect, so it records into the same ordered log as the ports.
  run.runner.completion.observe = (raw, list) => {
    run.portEffects.push(['completion.observe', encodeValue(raw, run), encodeValue(list, run)]);
    if (scenario.staleCompletion) throw new Error('stale completion tracker');
    if (scenario.reentrantCompletion) run.cs.currentAssistantText += '|reenter';
  };
  return run;
}

function makePorts(run) {
  const scenario = run.scenario;
  const effect = (name, ...args) => {
    run.portEffects.push([name, ...args.map(value => encodeValue(value, run))]);
  };
  const maybeThrow = name => {
    if (scenario.throwPort === name) throw new Error(`port ${name} exploded`);
  };
  const ports = {
    isCurrent: (cs, turn, runner) => {
      effect('isCurrent', String(
        cs === run.cs && turn === run.turn && runner === run.runner
        && cs.currentTurn === turn && cs.currentRunner === runner
        && !!turn && !!runner && runner.turnId === turn.turnId,
      ));
      return cs === run.cs && turn === run.turn && runner === run.runner
        && cs.currentTurn === turn && cs.currentRunner === runner
        && !!turn && !!runner && runner.turnId === turn.turnId;
    },
    scrub: (attempt, event) => {
      maybeThrow('scrub');
      effect('scrub', attempt, event);
      if (scenario.reentrantScrub && event && event.type === 'assistant_text') {
        run.cs.currentAssistantText += '|scrubbed';
      }
      return event;
    },
    touchActivity: (session, turnId) => { maybeThrow('touchActivity'); effect('touchActivity', session, turnId); },
    observeClaude: (cs, event) => { maybeThrow('observeClaude'); effect('observeClaude', cs, event); },
    observeAdapter: (cs, event) => { maybeThrow('observeAdapter'); effect('observeAdapter', cs, event); },
    decodeEvent: (provider, raw) => {
      maybeThrow('decodeEvent');
      effect('decodeEvent', provider.name, raw);
      return provider.decodeEvent(raw);
    },
    rememberActiveCliState: (record) => { maybeThrow('rememberActiveCliState'); effect('rememberActiveCliState', record); },
    savePersistedSessions: (reason) => { maybeThrow('savePersistedSessions'); effect('savePersistedSessions', reason); },
    finishProviderAttempt: (runner, outcome, facts) => {
      maybeThrow('finishProviderAttempt');
      effect('finishProviderAttempt', runner, outcome, facts);
      return null;
    },
    recordUserInput: (evt, session, turnId) => {
      maybeThrow('recordUserInput');
      effect('recordUserInput', evt, session, turnId);
      if (scenario.userInputThrows) throw new Error('record user input exploded');
      return scenario.userInputResult === undefined ? null : clone(scenario.userInputResult);
    },
    noteReportedModel: (session, model) => { maybeThrow('noteReportedModel'); effect('noteReportedModel', session, model); },
    updatePhase: (session, turnId, phase, name) => {
      maybeThrow('updatePhase');
      effect('updatePhase', session, turnId, phase, name);
      if (scenario.reentrantPhase) run.cs.lastPhase = phase;
    },
    setSessionStatus: (session, status) => { maybeThrow('setSessionStatus'); effect('setSessionStatus', session, status); },
    scheduleIncrementalSave: (session, cs) => { maybeThrow('scheduleIncrementalSave'); effect('scheduleIncrementalSave', session, cs); },
    backgroundRecordToolUseId: (session, id) => { maybeThrow('backgroundRecordToolUseId'); effect('backgroundRecordToolUseId', session, id); },
    backgroundMarkTaskOutputAwaiting: (session, input) => { effect('backgroundMarkTaskOutputAwaiting', session, input); },
    clearIncrementalSave: (session) => { effect('clearIncrementalSave', session); },
    contextTrace: (session, cs) => { effect('contextTrace', session, cs); return scenario.contextTrace ? clone(scenario.contextTrace) : null; },
    isMapped: (session, cs) => { effect('isMapped', String(run.mapped && cs === run.cs)); return run.mapped && cs === run.cs; },
    persistFinal: (session, cs, turn, runner, message, options) => {
      effect('persistFinal', session, message, options);
      if (scenario.replaceAfterPersist) run.mapped = false;
      if (scenario.durable) { turn.resultDurable = true; turn.resultRunnerId = runner.runnerId; }
      return !!scenario.durable;
    },
    recordDurableUsage: (session, runner, usage) => effect('recordDurableUsage', session, usage),
    proxyFailure: (attempt) => { effect('proxyFailure', attempt); return scenario.proxyFailure === undefined ? null : clone(scenario.proxyFailure); },
    onTurnComplete: (session) => effect('onTurnComplete', session),
    modelAttribution: (cs, turn, runner) => { effect('modelAttribution', cs, turn, runner); return scenario.modelAttribution ? clone(scenario.modelAttribution) : {}; },
    timelineField: (cs) => { effect('timelineField', cs); return scenario.timelineField ? clone(scenario.timelineField) : {}; },
    turnTimings: (session, turnId) => { effect('turnTimings', session, turnId); return scenario.turnTimings ? clone(scenario.turnTimings) : {}; },
    markHostEnvelope: (event) => { effect('markHostEnvelope', event); return { ...event, __hostEnvelope: true }; },
    consoleWarn: (message) => effect('consoleWarn', message),
    consoleLog: (message) => effect('consoleLog', message),
    logger: {
      info: (name, fields) => effect('logger.info', name, fields),
      warn: (name, fields) => effect('logger.warn', name, fields),
      error: (name, fields) => effect('logger.error', name, fields),
    },
  };
  run.ports = ports;
  return ports;
}

function legacyContext(run) {
  const ports = run.ports;
  return {
    isCurrentTurnRunner: (cs, turn, runner) => ports.isCurrent(cs, turn, runner),
    touchActivity: (session, turnId) => ports.touchActivity(session, turnId),
    decodeEvent: (provider, raw) => ports.decodeEvent(provider, raw),
    observeAdapter: (cs, event) => ports.observeAdapter(cs, event),
    scrubAttemptStructure: (attempt, event) => ports.scrub(attempt, event),
    applyClaudeChatEvent: (cs, session, event, forward, turn, runner, providerName) => (
      applyClaudeChatEventLegacy(ports, cs, session, event, forward, turn, runner, providerName)
    ),
    noteReportedModel: (session, model) => ports.noteReportedModel(session, model),
    rememberActiveCliState: (record) => ports.rememberActiveCliState(record),
    savePersistedSessions: (reason) => ports.savePersistedSessions(reason),
    captureSession: (record, sessionId, fresh) => captureNativeSessionId(record, sessionId, { fresh }),
    assignKillReason: (runner, reason) => {
      if (!runner) return false;
      const value = String(reason || '').trim();
      runner.killReason = value || null;
      return !!runner.killReason;
    },
    finishProviderAttempt: (runner, outcome, facts) => ports.finishProviderAttempt(runner, outcome, facts),
    updatePhase: (session, turnId, phase, name) => ports.updatePhase(session, turnId, phase, name),
    setSessionStatus: (session, status) => ports.setSessionStatus(session, status),
    recordUserInput: (evt, session, turnId) => ports.recordUserInput(evt, session, turnId),
    consoleWarn: (message) => ports.consoleWarn(message),
    consoleLog: (message) => ports.consoleLog(message),
    scheduleIncrementalSave: (session, cs) => ports.scheduleIncrementalSave(session, cs),
    backgroundRecordToolUseId: (session, id) => ports.backgroundRecordToolUseId(session, id),
    markHostEnvelope: (event) => ports.markHostEnvelope(event),
    logger: ports.logger,
  };
}

function applyNative(run, wire, forward) {
  return native.chatApplyAdapterEvent(
    run.provider, run.cs, run.persisted, run.scenario.sessionName, wire, forward,
    run.turn, run.runner, run.ports,
  );
}

function applyLegacy(run, wire, forward) {
  const ctx = legacyContext(run);
  return applyAdapterChatEventLegacy(
    ctx, run.provider, run.cs, run.persisted, run.scenario.sessionName, wire, forward,
    run.turn, run.runner,
  );
}

function runSequence(scenario, wires, apply) {
  const run = createRun(scenario);
  makePorts(run);
  const forward = event => run.forwards.push(clone(event));
  const realNow = Date.now;
  let clock = scenario.clockStart ?? 1700000000000;
  Date.now = () => (clock += 1);
  try {
    for (const wire of wires) apply(run, clone(wire), forward);
  } finally {
    Date.now = realNow;
  }
  return run;
}

function snapshot(run) {
  return {
    state: serialize([run.cs, run.persisted, run.turn, run.runner, run.forwards]),
    effects: serialize(run.portEffects),
  };
}

function firstDifference(left, right, label) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  const from = Math.max(0, index - 160);
  return `${label} diverges at offset ${index}\nlegacy: ...${left.slice(from, index + 240)}\nnative: ...${right.slice(from, index + 240)}`;
}

function compareSequence(scenario, wires, label) {
  let legacy;
  let legacyError = null;
  try {
    legacy = snapshot(runSequence(scenario, wires, applyLegacy));
  } catch (error) {
    legacyError = error;
  }
  let nativeRun;
  let nativeError = null;
  try {
    nativeRun = snapshot(runSequence(scenario, wires, applyNative));
  } catch (error) {
    nativeError = error;
  }
  if (legacyError || nativeError) {
    assert.ok(legacyError && nativeError,
      `${label}: one side threw but not the other (legacy=${legacyError && legacyError.message}; native=${nativeError && nativeError.message})`);
    return;
  }
  if (legacy.state !== nativeRun.state) throw new Error(`${label}: ${firstDifference(legacy.state, nativeRun.state, 'state')}`);
  if (legacy.effects !== nativeRun.effects) throw new Error(`${label}: ${firstDifference(legacy.effects, nativeRun.effects, 'effects')}`);
}

// ── scenario and event generation ───────────────────────────────────────────
const ROUTE = ' pr1.' + 'a'.repeat(12) + '.' + 'b'.repeat(12);
const LONG = 'x'.repeat(4096);
const ENVELOPE = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";

function baseScenario(kind, extra = {}) {
  const turn = { turnId: 'turn-1', resultDurable: false };
  return {
    kind,
    sessionName: 'sess-a',
    turn,
    cs: { currentAssistantText: '', currentToolCalls: [], streamReplay: [], _resultSaved: false },
    persisted: { cli: kind, cliSessionId: null },
    runner: { turnId: 'turn-1', runnerId: 'runner-1', providerAttempt: { id: 'attempt-1' }, completion: {} },
    ...extra,
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

function randomText(rand, base) {
  const roll = rand();
  if (roll < 0.08) return '';
  if (roll < 0.12) return LONG;
  if (roll < 0.16) return '\ud800 lone surrogate';
  if (roll < 0.24) return base + ROUTE;
  if (roll < 0.30) return base + ' proxy-route-abcdef';
  if (roll < 0.34) return ENVELOPE;
  return base + ' #' + Math.floor(rand() * 1000);
}

function randomEvent(rand, kind) {
  const roll = rand();
  if (roll < 0.16) return { type: 'assistant_text', text: randomText(rand, 'answer'), delta: rand() < 0.5 };
  if (roll < 0.24) return { type: 'thinking', id: pick(rand, ['r1', 'r2']), text: randomText(rand, 'think'), delta: rand() < 0.5, snapshot: rand() < 0.5, completed: rand() < 0.5 };
  if (roll < 0.34) return { type: 'tool_start', name: pick(rand, ['Bash', 'Read', 'Thinking']), id: pick(rand, ['t1', 't2']), input: rand() < 0.5 ? { cmd: 'ls' } : undefined, status: rand() < 0.5 ? 'running' : undefined, currentFile: rand() < 0.3 ? 'a.js' : undefined };
  if (roll < 0.44) return { type: 'tool_result', id: pick(rand, ['t1', 't2', 'missing']), content: randomText(rand, 'out'), isError: rand() < 0.3 };
  if (roll < 0.54) return { type: 'tool_update', name: pick(rand, ['Bash', 'Read']), id: rand() < 0.5 ? pick(rand, ['t1', 't2']) : undefined, completed: rand() < 0.5, content: randomText(rand, 'out'), isError: rand() < 0.2, currentFile: rand() < 0.3 ? 'a.js' : undefined };
  if (roll < 0.62) return { type: 'status', status: pick(rand, ['thinking', 'running', undefined]), phase: pick(rand, ['tool', 'thinking', undefined]), currentFile: rand() < 0.3 ? 'a.js' : undefined };
  if (roll < 0.68) return { type: 'activity', phase: pick(rand, [undefined, 'tool']), toolKind: pick(rand, [undefined, 'shell']) };
  if (roll < 0.72) return { type: 'session_init', model: pick(rand, ['gpt-5.5', '', undefined]) };
  if (roll < 0.76) return { type: 'session_started', sessionId: pick(rand, ['ses-1', '', 'ses-2']) };
  if (roll < 0.80) return { type: 'native_session_missing', sessionId: pick(rand, ['ses-1', 'ses-other']) };
  if (roll < 0.84) return { type: 'user_input_signal', log: rand() < 0.3 ? 'ask' : undefined, fallbackText: pick(rand, ['question', '', undefined]) };
  if (roll < 0.87) return { type: 'complete', usage: { input_tokens: 3 }, stopReason: 'end_turn' };
  if (roll < 0.93) {
    return {
      type: 'error',
      kind: pick(rand, ['provider_error', 'transport_disconnect', 'response_completed_disconnect', undefined]),
      message: randomText(rand, 'boom'), label: pick(rand, [undefined, 'Codex', '']),
      error: rand() < 0.25 ? { source: 'x', provider: kind, code: 500, message: 'raw' } : undefined,
    };
  }
  if (roll < 0.97) {
    return { type: 'claude_event', raw: { type: 'assistant', message: { content: [{ type: 'text', text: randomText(rand, 'nested') }] } } };
  }
  return { type: 'unknown_kind', payload: randomText(rand, 'x') };
}

function randomWire(rand, kind) {
  const mode = rand();
  const count = 1 + Math.floor(rand() * 3);
  const events = Array.from({ length: count }, () => randomEvent(rand, kind));
  if (mode < 0.72) return { mode: 'array', events };
  if (mode < 0.78) return { mode: 'single', events };
  if (mode < 0.82) return { mode: 'null', events };
  if (mode < 0.85) return { mode: 'undefined', events };
  if (mode < 0.88) return { mode: 'object', events };
  if (mode < 0.90) return events; // raw array (no `events` key)
  return { mode: 'array', events: [null, false, 0, '', ...events, undefined] };
}

// ── tests ───────────────────────────────────────────────────────────────────
test('fixtures from every adapter family reduce identically', () => {
  const sequences = {
    codex: [
      { type: 'session_started', sessionId: 'ses-1' },
      { type: 'thinking', id: 'r', text: 'think', snapshot: true, delta: true },
      { type: 'assistant_text', text: 'Hel', delta: true },
      { type: 'assistant_text', text: 'lo', delta: true },
      { type: 'tool_start', name: 'Bash', id: 't1', input: { cmd: 'ls' } },
      { type: 'tool_result', id: 't1', content: 'a.txt', isError: false },
      { type: 'complete', usage: { input_tokens: 3 }, stopReason: 'end_turn' },
    ],
    'codex-exp': [
      { type: 'session_started', sessionId: 'thread-exp' },
      { type: 'assistant_text', text: 'one', delta: true },
      { type: 'thinking', id: 'r', text: 'deep', snapshot: true, delta: true },
      { type: 'user_input_signal', log: 'native requestUserInput decoded to user_input_signal', fallbackText: 'Which?' },
      { type: 'error', kind: 'response_completed_disconnect', message: 'socket closed' },
    ],
    opencode: [
      { type: 'session_init', model: 'gpt-5.5' },
      { type: 'status', status: 'running', phase: 'thinking' },
      { type: 'assistant_text', text: 'part one' },
      { type: 'thinking', id: 'r1', text: 'step', delta: true },
      { type: 'thinking', id: 'r1', text: ' more', delta: true, completed: true },
      { type: 'tool_update', name: 'Read', id: 't1', input: { path: 'a.js' } },
      { type: 'tool_update', name: 'Read', id: 't1', completed: true, content: 'ok' },
      { type: 'claude_event', raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'nested' }] } } },
    ],
    'opencode-like': [
      { type: 'activity', phase: 'tool', toolKind: 'shell' },
      { type: 'tool_start', name: 'Bash', id: 'call_0', input: { cmd: 'pwd' }, status: 'running' },
      { type: 'error', kind: 'transport_disconnect', message: 'ECONNRESET' },
    ],
    kimi: [
      { type: 'session_started', sessionId: 'kimi-1' },
      { type: 'assistant_text', text: 'snapshot one' },
      { type: 'assistant_text', text: 'snapshot two' },
      { type: 'complete' },
    ],
    pi: [
      { type: 'thinking', id: 'p1', text: 'plan' },
      { type: 'tool_update', name: 'Edit', input: { path: 'b.js' } },
      { type: 'error', message: 'model failed', label: 'Pi' },
    ],
    zcode: [
      { type: 'session_init', model: 'glm-5.2' },
      { type: 'assistant_text', text: 'z', delta: true },
      { type: 'tool_start', name: 'Bash', id: 'z1', input: {} },
      { type: 'tool_result', id: 'z1', content: LONG, isError: true },
    ],
    commandcode: [
      { type: 'native_session_missing', sessionId: 'cc-old' },
      { type: 'session_started', sessionId: 'cc-new' },
      { type: 'assistant_text', text: 'resumed' },
    ],
    acp: [
      { type: 'status', status: 'thinking' },
      { type: 'assistant_text', text: ENVELOPE },
      { type: 'error', kind: 'response_completed_disconnect', message: 'boom', error: { code: 1 } },
    ],
  };
  for (const kind of ADAPTER_KINDS) {
    for (const pendingCliHandoff of [undefined, { status: 'pending', reusedTarget: true, toCli: kind }]) {
      const scenario = baseScenario(kind, {
        persisted: { cli: kind, cliSessionId: 'old-session', pendingCliHandoff },
      });
      compareSequence(scenario, sequences[kind].map(events => ({ mode: 'array', events })), `${kind} fixture`);
    }
  }
});

test('randomized sequences hold for every adapter family', () => {
  for (const kind of ADAPTER_KINDS) {
    const rand = mulberry32(0xC0DE ^ kind.length * 7919);
    for (let index = 0; index < 120; index += 1) {
      const wires = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => randomWire(rand, kind));
      const scenario = baseScenario(kind, {
        persisted: {
          cli: kind,
          cliSessionId: pick(rand, [null, 'ses-1', 'old-session']),
          pendingCliHandoff: rand() < 0.2 ? { status: 'pending', reusedTarget: true, toCli: kind } : undefined,
        },
        freshNativeSession: rand() < 0.2,
        userInputResult: pick(rand, [null, { ok: true }, { ok: false, fallbackText: 'fallback' }, undefined]),
        clockStart: 1700000000000 + index * 1000,
      });
      scenario.runner.freshNativeSession = rand() < 0.2;
      compareSequence(scenario, wires, `${kind} randomized #${index}`);
    }
  }
});

test('at least one thousand perturbed sequences per representative family', () => {
  for (const kind of ['codex', 'opencode']) {
    const rand = mulberry32(kind === 'codex' ? 0x1234 : 0x5678);
    for (let index = 0; index < 1000; index += 1) {
      const wires = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => randomWire(rand, kind));
      const scenario = baseScenario(kind, {
        persisted: {
          cli: kind,
          cliSessionId: pick(rand, [null, 'ses-1', 'ses-2']),
          pendingCliHandoff: rand() < 0.15 ? { status: 'pending', reusedTarget: true, toCli: kind } : undefined,
        },
        userInputResult: pick(rand, [null, { ok: true }, { ok: false, fallbackText: randomText(rand, 'fb') }]),
      });
      compareSequence(scenario, wires, `${kind} perturbed #${index}`);
    }
  }
});

test('decode shapes, stale runners and throwing ports agree', () => {
  const scenario = baseScenario('codex');
  const cases = [
    { mode: 'null' },
    { mode: 'undefined' },
    { mode: 'single', events: [{ type: 'assistant_text', text: 'single' }] },
    { mode: 'object', events: [{ type: 'tool_start', name: 'Read', id: 'x', input: {} }] },
    { mode: 'throwing' },
  ];
  for (const wire of cases) compareSequence(scenario, [wire], `decode shape ${wire.mode || 'array'}`);

  compareSequence(baseScenario('codex', { stale: true }), [{ mode: 'array', events: [{ type: 'assistant_text', text: 'x' }] }], 'stale runner');
  compareSequence(baseScenario('codex', { staleCompletion: true }), [{ mode: 'array', events: [] }], 'stale completion');
  compareSequence(baseScenario('codex', { reentrantScrub: true }), [{ mode: 'array', events: [{ type: 'assistant_text', text: 'a', delta: true }, { type: 'assistant_text', text: 'b', delta: true }] }], 'reentrant scrub');
  compareSequence(baseScenario('codex', { reentrantPhase: true }), [{ mode: 'array', events: [{ type: 'status', status: 'running' }, { type: 'assistant_text', text: 'x' }] }], 'reentrant phase');
  compareSequence(baseScenario('codex', { reentrantCompletion: true }), [{ mode: 'array', events: [{ type: 'assistant_text', text: 'x' }] }], 'reentrant completion');
  compareSequence(baseScenario('codex', { userInputThrows: true }), [{ mode: 'array', events: [{ type: 'user_input_signal', fallbackText: 'q' }] }], 'throwing user input');
  for (const port of ['scrub', 'touchActivity', 'observeAdapter', 'decodeEvent', 'noteReportedModel', 'updatePhase',
    'setSessionStatus', 'scheduleIncrementalSave', 'backgroundRecordToolUseId', 'rememberActiveCliState',
    'savePersistedSessions', 'finishProviderAttempt', 'recordUserInput']) {
    compareSequence(baseScenario('codex', { throwPort: port }), [{ mode: 'array', events: [
      { type: 'session_started', sessionId: 'ses-1' },
      { type: 'assistant_text', text: 'x' },
      { type: 'tool_start', name: 'Read', id: 't', input: {} },
    ] }], `throwing port ${port}`);
  }
});

test('lone surrogates and very large events keep exact bytes', () => {
  const events = [
    { type: 'assistant_text', text: '𐏿 lone', delta: true },
    { type: 'tool_start', name: 'Bash', id: 't', input: { text: LONG } },
    { type: 'tool_result', id: 't', content: LONG, isError: false },
    { type: 'tool_update', name: 'Bash', id: 't', completed: true, content: 'y'.repeat(2000) },
    { type: 'thinking', id: 'r', text: '\udc00', delta: false, completed: true },
    { type: 'error', message: '\ud800' + ENVELOPE },
  ];
  for (const kind of ['codex', 'opencode']) {
    compareSequence(baseScenario(kind), [{ mode: 'array', events }], `${kind} adversarial bytes`);
    compareSequence(baseScenario(kind, { stale: true }), [{ mode: 'array', events }], `${kind} stale bytes`);
  }
});

test('session capture and resume mismatch paths match', () => {
  const wires = [
    { mode: 'array', events: [{ type: 'session_started', sessionId: 'ses-new' }] },
    { mode: 'array', events: [{ type: 'native_session_missing', sessionId: 'ses-new' }] },
    { mode: 'array', events: [{ type: 'session_started', sessionId: 'ses-other' }] },
  ];
  for (const persisted of [
    { cli: 'codex', cliSessionId: 'ses-old' },
    { cli: 'codex', cliSessionId: 'ses-old', pendingCliHandoff: { status: 'pending', reusedTarget: true, toCli: 'codex' } },
    { cli: 'codex', cliSessionId: 'ses-old', pendingCliHandoff: { status: 'done', reusedTarget: true, toCli: 'codex' } },
    { cli: 'codex', cliSessionId: null },
  ]) {
    for (const fresh of [false, true]) {
      const scenario = baseScenario('codex', { persisted });
      scenario.runner.freshNativeSession = fresh;
      scenario.cs.claudeProc = { kill(signal) { scenario.killed = (scenario.killed || []).concat(signal); } };
      compareSequence(scenario, wires, `capture ${persisted.cliSessionId}/${fresh}`);
    }
  }
});

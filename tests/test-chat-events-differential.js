'use strict';

// Differential test for the Claude chat-event reducer.
//
// The frozen Node implementation in tests/helpers/legacy-claude-chat-event.js is
// the oracle. Each sequence drives both reducers from byte-identical starting
// state with byte-identical events; the final cs/turn/runner/forward snapshot
// and the ordered host-effect log must match exactly. Host effects go through
// the same port names in both, so this measures decisions, mutations and
// ordering rather than I/O.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getNative } = require('../src/native/runtime');
const { applyClaudeChatEventLegacy } = require('./helpers/legacy-claude-chat-event');

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
  const text = serialize(value);
  return text.length > 512 ? `#h${text.length}:${digest(text)}` : text;
}

// ── one reducer run ─────────────────────────────────────────────────────────
function createRun(scenario) {
  const run = {
    cs: clone(scenario.cs),
    turn: clone(scenario.turn),
    runner: clone(scenario.runner),
    sessionName: scenario.sessionName,
    providerName: scenario.providerName,
    scenario,
    mapped: scenario.mapped !== false,
    effects: [],
    forwards: [],
  };
  run.cs.currentTurn = run.turn;
  run.cs.currentRunner = run.runner;
  if (scenario.stale) run.cs.currentTurn = { turnId: 'stale-turn' };
  return run;
}

function makePorts(run) {
  const scenario = run.scenario;
  const effect = (name, ...args) => run.effects.push([name, args.map(value => encodeValue(value, run))]);
  const ports = {
    isCurrent: (cs, turn, runner) => {
      const value = cs === run.cs && turn === run.turn && runner === run.runner
        && cs.currentTurn === turn && cs.currentRunner === runner
        && !!turn && !!runner && runner.turnId === turn.turnId;
      effect('isCurrent', String(value));
      return value;
    },
    scrub: (attempt, event) => { effect('scrub', attempt, event); return event; },
    touchActivity: (session, turnId) => effect('touchActivity', session, turnId),
    observeClaude: (cs, event) => effect('observeClaude', cs, event),
    noteReportedModel: (session, model) => effect('noteReportedModel', session, model),
    updatePhase: (session, turnId, phase, name) => effect('updatePhase', session, turnId, phase, name),
    setSessionStatus: (session, status) => effect('setSessionStatus', session, status),
    scheduleIncrementalSave: (session, cs) => effect('scheduleIncrementalSave', session, cs),
    backgroundRecordToolUseId: (session, id) => effect('backgroundRecordToolUseId', session, id),
    backgroundMarkTaskOutputAwaiting: (session, input) => effect('backgroundMarkTaskOutputAwaiting', session, input),
    clearIncrementalSave: (session) => effect('clearIncrementalSave', session),
    contextTrace: (session, cs) => {
      effect('contextTrace', session, cs);
      return scenario.contextTrace ? clone(scenario.contextTrace) : null;
    },
    isMapped: (session, cs) => {
      const value = run.mapped && cs === run.cs;
      effect('isMapped', String(value));
      return value;
    },
    persistFinal: (session, cs, turn, runner, message, options) => {
      effect('persistFinal', session, message, options);
      if (scenario.replaceAfterPersist) run.mapped = false;
      if (scenario.durable) {
        turn.resultDurable = true;
        turn.resultRunnerId = runner.runnerId;
      }
      return !!scenario.durable;
    },
    // Two-phase production path: the reducer starts the write and the host
    // hands the durable verdict back through `chatCommitFinalPersist`. The
    // differential oracle writes synchronously, so the commit runs inline and
    // both traces stay byte-identical.
    requestFinalPersist: (session, cs, turn, runner, message, options, forward, wasMapped, evt) => {
      const durable = ports.persistFinal(session, cs, turn, runner, message, options);
      native.chatCommitFinalPersist(
        cs, session, evt, message, forward, turn, runner, durable, durable, wasMapped, ports,
      );
    },
    recordDurableUsage: (session, runner, usage) => effect('recordDurableUsage', session, usage),
    proxyFailure: (attempt) => {
      effect('proxyFailure', attempt);
      return scenario.proxyFailure === undefined ? null : clone(scenario.proxyFailure);
    },
    onTurnComplete: (session) => effect('onTurnComplete', session),
    modelAttribution: (cs, turn, runner) => {
      effect('modelAttribution', cs, turn, runner);
      return scenario.modelAttribution ? clone(scenario.modelAttribution) : {};
    },
    timelineField: (cs) => {
      effect('timelineField', cs);
      return scenario.timelineField ? clone(scenario.timelineField) : {};
    },
    turnTimings: (session, turnId) => {
      effect('turnTimings', session, turnId);
      return scenario.turnTimings ? clone(scenario.turnTimings) : {};
    },
    markHostEnvelope: (event) => {
      effect('markHostEnvelope', event);
      return { ...event, __hostEnvelope: true };
    },
    logger: {
      info: (name, fields) => effect('logger.info', name, fields),
      warn: (name, fields) => effect('logger.warn', name, fields),
      error: (name, fields) => effect('logger.error', name, fields),
    },
  };
  return ports;
}

function applyNative(ports, cs, sessionName, evt, forward, turn, runner, providerName) {
  return native.chatApplyClaudeEvent(cs, sessionName, evt, forward, turn, runner, providerName, ports);
}

function runSequence(scenario, events, apply) {
  const run = createRun(scenario);
  const ports = makePorts(run);
  const forward = event => run.forwards.push(clone(event));
  const realNow = Date.now;
  let clock = scenario.clockStart ?? 1700000000000;
  Date.now = () => (clock += 1);
  try {
    for (const event of events) {
      apply(ports, run.cs, run.sessionName, clone(event), forward, run.turn, run.runner, run.providerName);
    }
  } finally {
    Date.now = realNow;
  }
  return run;
}

function snapshot(run) {
  return {
    state: serialize([run.cs, run.turn, run.runner, run.forwards]),
    effects: serialize(run.effects),
  };
}

function firstDifference(left, right, label) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  const from = Math.max(0, index - 120);
  return `${label} diverges at offset ${index}\nlegacy: ...${left.slice(from, index + 200)}\nnative: ...${right.slice(from, index + 200)}`;
}

function compareSequence(scenario, events, label) {
  let legacy;
  let legacyError = null;
  try {
    legacy = snapshot(runSequence(scenario, events, applyClaudeChatEventLegacy));
  } catch (error) {
    legacyError = error;
  }
  let nativeRun;
  let nativeError = null;
  try {
    nativeRun = snapshot(runSequence(scenario, events, applyNative));
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
const ENVELOPE = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const ROUTE = ' pr1.' + 'a'.repeat(12) + '.' + 'b'.repeat(12);
const LONG = 'x'.repeat(4096);

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

const COMPLETIONS = [
  null,
  { version: 1, state: 'completed', reason: 'success_result', source: 'protocol', settled: true },
  { version: 1, state: 'failed', reason: 'api_error', source: 'protocol', settled: true },
  { version: 1, state: 'completed', reason: 'clean_exit_with_output', source: 'exit', settled: true },
  { version: 1, state: 'failed', reason: 'nonzero_exit', source: 'exit', settled: true },
  { version: 1, state: 'cancelled', reason: 'turn.aborted', source: 'protocol', settled: true },
  { version: 1, state: 'completed', reason: 'x', source: 'protocol', settled: false },
  { version: 1, state: 'unknown', reason: 'x', source: 'protocol', settled: true },
];
const PROXY_FAILURES = [
  undefined,
  null,
  { httpStatus: 429 },
  { httpStatus: null, proxyOutcome: { termination: 'downstream_disconnect' } },
  {},
];

function makeScenario(rand) {
  const completion = pick(rand, COMPLETIONS);
  const tools = rand() < 0.5 ? [] : [
    rand() < 0.5 && { name: 'Thinking', input: {}, id: 'tool-0', startedAt: 1699999999000 },
    { name: 'Read', input: { file_path: '/tmp/a' }, id: 'tool-1', startedAt: 1699999999000, endedAt: 1699999999500 },
  ].filter(Boolean);
  return {
    sessionName: 'sess',
    providerName: pick(rand, ['claude', 'claude-exp', 'claude-sdk']),
    cs: {
      cli: 'claude',
      chatTurnCount: Math.floor(rand() * 3),
      currentAssistantText: pick(rand, ['', 'answer', 'partial' + ROUTE]),
      currentToolCalls: tools,
      currentCost: pick(rand, [null, 0, 0.25]),
      turnStartedAt: pick(rand, [null, 0, 1699999999000]),
      clients: new Set(),
    },
    turn: { turnId: 'turn-1', sessionId: 'sess' },
    runner: {
      runnerId: 'runner-1',
      turnId: pick(rand, ['turn-1', 'turn-1', 'turn-1', 'turn-2']),
      completionOutcome: completion ? clone(completion) : null,
      pendingClaudeResult: null,
      providerAttempt: { cli: 'claude', attemptNo: 1 },
      sawApiError: false,
      apiErrorRaw: null,
      resultEvent: false,
      pendingUsage: null,
    },
    durable: rand() < 0.7,
    mapped: rand() < 0.9,
    replaceAfterPersist: rand() < 0.15,
    stale: rand() < 0.1,
    proxyFailure: pick(rand, PROXY_FAILURES),
    contextTrace: rand() < 0.4 ? { receipt: 'r1', summary: true } : null,
    modelAttribution: rand() < 0.5 ? { model: 'opus' } : null,
    timelineField: rand() < 0.5 ? { timeline: [{ at: 1 }] } : null,
    turnTimings: rand() < 0.5 ? { totalMs: 12 } : null,
    clockStart: 1700000000000,
  };
}

function makeEvent(rand) {
  const kind = pick(rand, [
    'assistant_text', 'assistant_text', 'assistant_tool', 'assistant_tool',
    'assistant_mixed', 'assistant_snapshot', 'api_error_message', 'api_error_message',
    'user_tool_result', 'user_tool_result', 'user_other', 'result', 'system_init',
    'system_other', 'model_only', 'unknown',
  ]);
  if (kind === 'assistant_text') {
    return { type: 'assistant', message: {
      role: 'assistant',
      ...(rand() < 0.5 ? { model: 'opus' } : {}),
      content: [{ type: 'text', text: randomText(rand, 'hello') }],
    } };
  }
  if (kind === 'assistant_tool') {
    const name = pick(rand, ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'TaskOutput', 'Thinking', 'Grep']);
    const input = name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit'
      ? { file_path: rand() < 0.5 ? '/tmp/file' : undefined }
      : name === 'TaskOutput' ? { task_id: 'task-' + Math.floor(rand() * 3) }
        : { command: 'ls', file_path: '/tmp/x' };
    return { type: 'assistant', message: { content: [
      { type: 'tool_use', id: pick(rand, ['tool-0', 'tool-1', 'tool-2']), name, input },
    ] } };
  }
  if (kind === 'assistant_mixed') {
    return { type: 'assistant', message: { model: 'opus', content: [
      { type: 'text', text: randomText(rand, 'mix') },
      { type: 'tool_use', id: 'tool-1', name: pick(rand, ['Bash', 'Edit', 'Read']), input: { file_path: '/tmp/m' } },
    ] } };
  }
  if (kind === 'assistant_snapshot') {
    return { type: 'assistant', message: { model: 'opus', content: [
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
      rand() < 0.3 ? null : { type: 'thinking', thinking: 'hmm' },
    ] } };
  }
  if (kind === 'api_error_message') {
    const event = {
      type: 'assistant',
      is_api_error_message: rand() < 0.7,
      api_error_status: pick(rand, [429, 500, 0, '429', null, undefined, 700, { valueOf: () => 503 }]),
      error: pick(rand, ['rate_limit', '', undefined, 'x']),
      message: { model: '<synthetic>', content: [
        { type: 'text', text: pick(rand, [ENVELOPE, 'API Error: boom', randomText(rand, 'err')]) },
      ] },
    };
    if (rand() < 0.5) event.uuid = 'uuid-' + Math.floor(rand() * 3);
    if (rand() < 0.5) event.request_id = 'req-' + Math.floor(rand() * 3);
    return event;
  }
  if (kind === 'user_tool_result') {
    const content = pick(rand, [
      'plain result',
      [{ type: 'text', text: 'text block ' + ROUTE }],
      [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }],
      { object: 1 },
      null,
      42,
      'y'.repeat(1500),
    ]);
    return { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: pick(rand, ['tool-0', 'tool-1', 'tool-missing']), content, is_error: rand() < 0.5 },
    ] } };
  }
  if (kind === 'user_other') {
    return { type: 'user', message: { content: pick(rand, [
      [{ type: 'text', text: 'hi' }],
      'plain user text',
      { type: 'text', text: 'obj' },
    ]) } };
  }
  if (kind === 'result') {
    const event = {
      type: 'result',
      subtype: pick(rand, ['success', 'error_max_turns', 'error']),
      total_cost_usd: pick(rand, [0, 0.5, null, undefined]),
      usage: pick(rand, [{ input_tokens: 1 }, {}, null, undefined]),
      result: randomText(rand, 'answer'),
    };
    if (rand() < 0.3) event.error = { code: 'x', http_status: 429, message: 'm', type: 't', request_id: 'r', headers: { h: 1 } };
    if (rand() < 0.2) event.api_error_status = 500;
    if (rand() < 0.2) event.startup_failure_reason = 'boom';
    if (rand() < 0.2) event.headers = { a: 1 };
    if (rand() < 0.2) event.request_id = 'rq';
    if (rand() < 0.2) event.http_status = 503;
    if (rand() < 0.2) event.status = 502;
    return event;
  }
  if (kind === 'system_init') {
    return { type: 'system', subtype: 'init', model: pick(rand, ['opus', null, undefined]), session_id: 'sess' };
  }
  if (kind === 'system_other') {
    return { type: 'system', subtype: pick(rand, ['status', 'other']), status: 'ok' };
  }
  if (kind === 'model_only') {
    return { type: 'assistant', message: { model: pick(rand, ['opus', null]) } };
  }
  return { type: pick(rand, ['stream_event', 'control_response', 'foo']), payload: randomText(rand, 'x') };
}

function makeSequence(rand) {
  const scenario = makeScenario(rand);
  const count = 1 + Math.floor(rand() * 6);
  const events = [];
  for (let index = 0; index < count; index += 1) events.push(makeEvent(rand));
  return { scenario, events };
}

// ── tests ───────────────────────────────────────────────────────────────────
test('differential: 1200 randomized/perturbed sequences', () => {
  const rand = mulberry32(0x6d2b79f5);
  let compared = 0;
  for (let index = 0; index < 1200; index += 1) {
    const { scenario, events } = makeSequence(rand);
    compareSequence(scenario, events, `random#${index}`);
    compared += 1;
  }
  assert.equal(compared, 1200);
});

test('differential: seeded fuzz is stable across a second pass', () => {
  const rand = mulberry32(0x1234abcd);
  for (let index = 0; index < 200; index += 1) {
    const { scenario, events } = makeSequence(rand);
    compareSequence(scenario, events, `fuzz#${index}`);
  }
});

test('differential: adversarial single events', () => {
  const scenario = makeScenario(mulberry32(7));
  scenario.runner.completionOutcome = clone(COMPLETIONS[1]);
  scenario.durable = true;
  const cases = [
    { type: 'assistant', is_api_error_message: true, uuid: 'u', api_error_status: 429, error: 'rate_limit',
      message: { model: '<synthetic>', content: [{ type: 'text', text: ENVELOPE }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '𐏿 lone' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: LONG + LONG }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'z'.repeat(5000), is_error: true }] } },
    { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {}, result: ENVELOPE },
    { type: 'result', subtype: 'error', error: { http_status: 429, message: 'boom' }, usage: { input_tokens: 2 } },
    { type: 'system', subtype: 'init', model: undefined },
    { type: null, message: null },
  ];
  for (const [index, event] of cases.entries()) compareSequence(scenario, [event], `adversarial#${index}`);
});

test('differential: stale turn/runner is a no-op in both', () => {
  for (const stale of ['currentTurn', 'turnId']) {
    const rand = mulberry32(99);
    const { scenario, events } = makeSequence(rand);
    if (stale === 'currentTurn') scenario.stale = true;
    else scenario.runner.turnId = 'turn-other';
    compareSequence(scenario, events, `stale-${stale}`);
  }
});

test('differential: throwing host ports surface an error in both', () => {
  for (const port of ['scrub', 'touchActivity', 'updatePhase', 'persistFinal']) {
    const scenario = makeScenario(mulberry32(5));
    scenario.stale = false;
    scenario.runner.turnId = 'turn-1';
    scenario.runner.completionOutcome = clone(COMPLETIONS[1]);
    scenario.proxyFailure = null;
    scenario.durable = true;
    scenario.cs.currentAssistantText = 'answer';
    const event = port === 'persistFinal'
      ? { type: 'result', subtype: 'success', usage: { input_tokens: 1 }, total_cost_usd: 0 }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'boom' }] } };
    const boom = () => { throw new Error('port ' + port + ' exploded'); };
    const build = () => {
      const run = createRun(scenario);
      const ports = makePorts(run);
      ports[port] = boom;
      return { run, ports };
    };
    const legacy = build();
    let legacyThrew = false;
    try {
      applyClaudeChatEventLegacy(legacy.ports, legacy.run.cs, legacy.run.sessionName, clone(event),
        () => {}, legacy.run.turn, legacy.run.runner, legacy.run.providerName);
    } catch { legacyThrew = true; }
    const nativeRun = build();
    let nativeThrew = false;
    try {
      applyNative(nativeRun.ports, nativeRun.run.cs, nativeRun.run.sessionName, clone(event),
        () => {}, nativeRun.run.turn, nativeRun.run.runner, nativeRun.run.providerName);
    } catch { nativeThrew = true; }
    assert.equal(legacyThrew, true, `legacy should throw from ${port}`);
    assert.equal(nativeThrew, true, `native should throw from ${port}`);
  }
});

test('differential: reentrant port call matches', () => {
  const scenario = makeScenario(mulberry32(11));
  scenario.runner.completionOutcome = null;
  const outer = { type: 'assistant', message: { content: [{ type: 'text', text: 'outer' }] } };
  const inner = { type: 'assistant', message: { content: [{ type: 'text', text: 'inner' }] } };
  const run = (apply) => {
    const state = createRun(scenario);
    let reentered = false;
    const ports = makePorts(state);
    const original = ports.observeClaude;
    ports.observeClaude = (cs, event) => {
      original(cs, event);
      if (!reentered) {
        reentered = true;
        apply(ports, cs, state.sessionName, clone(inner), value => state.forwards.push(clone(value)), state.turn, state.runner, state.providerName);
      }
    };
    const realNow = Date.now;
    let clock = 1700000000000;
    Date.now = () => (clock += 1);
    try {
      apply(ports, state.cs, state.sessionName, clone(outer), value => state.forwards.push(clone(value)), state.turn, state.runner, state.providerName);
    } finally {
      Date.now = realNow;
    }
    return snapshot(state);
  };
  assert.equal(run(applyClaudeChatEventLegacy).state, run(applyNative).state);
});

test('differential: real captured Claude traces', () => {
  const root = '/tmp/claude-lane-capture/real';
  if (!fs.existsSync(root)) return;
  const traces = [];
  for (const entry of fs.readdirSync(root)) {
    const file = path.join(root, entry, 'trace.jsonl');
    if (!fs.existsSync(file)) continue;
    const events = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.dir !== 'cli->host' || row.kind !== 'line' || typeof row.raw !== 'string') continue;
      let event;
      try { event = JSON.parse(row.raw); } catch { continue; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
      events.push(event);
    }
    if (events.length) traces.push({ name: entry, events });
  }
  assert.ok(traces.length > 0, 'expected at least one real trace');
  const rand = mulberry32(20261109);
  for (const trace of traces) {
    const scenario = makeScenario(rand);
    scenario.runner.completionOutcome = clone(COMPLETIONS[1]);
    compareSequence(scenario, trace.events, `real-${trace.name}`);
  }
});

// Intentional new protocol: a query may finish while the host turn stays open.
function heldRun() {
  const scenario = makeScenario(mulberry32(109));
  Object.assign(scenario, { mapped: true, stale: false, durable: true, replaceAfterPersist: false, proxyFailure: null });
  Object.assign(scenario.cs, { currentAssistantText: '', currentToolCalls: [], chatTurnCount: 0 });
  Object.assign(scenario.runner, { turnId: scenario.turn.turnId, completionOutcome: null });
  const run = createRun(scenario);
  const ports = makePorts(run);
  const saved = [];
  ports.appendHeldAnswer = (_session, message, key, cs, turn, runner) => {
    saved.push(clone(message));
    native.chatCommitHeldAnswer(cs, turn, runner, key, true, ports);
    return true;
  };
  const apply = event => applyNative(ports, run.cs, run.sessionName, event,
    frame => run.forwards.push(clone(frame)), run.turn, run.runner, run.providerName);
  const answer = text => apply({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const boundary = (id, identities = [], ack = () => {}) => ({
    type: 'held_query_result', held_result_id: id, held_identities: identities,
    subtype: 'success', is_error: false, usage: { input_tokens: 3 }, total_cost_usd: .03,
    acknowledge: ack,
  });
  return { run, ports, saved, apply, answer, boundary };
}

test('held query boundaries save separate answers without completing the host turn', () => {
  const h = heldRun();
  let acknowledged = 0;
  h.answer('主回答');
  h.apply(h.boundary('1', [], () => acknowledged++));
  h.answer('两个注入消息的同一个回答');
  const identities = [{ identity: 'm1', uuid: 'u1' }, { identity: 'm2', uuid: 'u2' }];
  h.apply(h.boundary('2', identities, () => acknowledged++));
  h.answer('后台完成后的回答');
  h.apply(h.boundary('3', [], () => acknowledged++));
  assert.equal(acknowledged, 3);
  assert.deepEqual(h.saved.map(row => row.content), ['主回答', '两个注入消息的同一个回答', '后台完成后的回答']);
  assert.deepEqual(h.saved[1].heldIdentities, identities);
  assert.equal(h.saved[0].heldResultId, 'turn-1:runner-1:held:1');
  assert.equal(h.run.turn.resultDurable, undefined, 'a query is not the host completion');
  assert.equal(h.run.cs.currentAssistantText, '');
  assert.equal(h.run.cs.chatTurnCount, 0);
  assert.equal(h.run.effects.some(([name]) => name === 'onTurnComplete'), false);
  h.run.runner.completionOutcome = clone(COMPLETIONS[1]);
  h.apply({ type: 'result', subtype: 'success', is_error: false, result: '后台完成后的回答',
    usage: { input_tokens: 3 }, held_usage: { input_tokens: 9 },
    held_answers_saved: true, total_cost_usd: .09 });
  assert.equal(h.run.turn.resultDurable, true);
  assert.equal(h.run.cs.chatTurnCount, 1);
  assert.equal(h.run.cs.currentAssistantText, '后台完成后的回答', 'finalizer gets the host outcome');
  assert.deepEqual(h.run.runner.pendingUsage, { input_tokens: 9 });
  assert.equal(h.run.effects.filter(([name]) => name === 'persistFinal').length, 0, 'no duplicate final tail');
  assert.equal(h.run.effects.filter(([name]) => name === 'recordDurableUsage').length, 1);
});

test('failed held history append retries its captured row without clearing newer output', () => {
  const h = heldRun();
  let available = false, attempts = 0, acks = 0;
  h.ports.appendHeldAnswer = (_session, message, key, cs, turn, runner) => {
    attempts++;
    const ok = available;
    if (ok) h.saved.push(clone(message));
    native.chatCommitHeldAnswer(cs, turn, runner, key, ok, h.ports);
    return true;
  };
  h.answer('未写盘的第一回答');
  const first = h.boundary('1', [{ identity: 'm1', uuid: 'u1' }], () => acks++);
  h.apply(first);
  assert.equal(acks, 0);
  assert.equal(h.run.cs.currentAssistantText, '');
  h.answer('正在写第二回答');
  available = true;
  h.apply(first);
  assert.equal(acks, 1);
  assert.equal(h.saved[0].content, '未写盘的第一回答');
  assert.equal(h.run.cs.currentAssistantText, '正在写第二回答');
  h.apply(first);
  assert.equal(attempts, 2, 'saved replay does not append twice');
  assert.equal(h.run.forwards.filter(frame => frame.type === 'held_query_boundary').length, 1);
});

test('held append reentry cannot append twice or acknowledge a superseded runner', () => {
  const h = heldRun();
  let acks = 0, calls = 0;
  const event = h.boundary('1', [], () => acks++);
  h.ports.appendHeldAnswer = (_session, message, key, cs, turn, runner) => {
    calls++;
    h.apply(event);
    h.run.cs.currentRunner = {};
    native.chatCommitHeldAnswer(cs, turn, runner, key, true, h.ports);
    return true;
  };
  h.answer('保留原回答');
  h.apply(event);
  assert.equal(calls, 1);
  assert.equal(acks, 0);
});

test('held answer waits for user history and same-turn retries have distinct row ids', () => {
  const h = heldRun();
  let acks = 0;
  h.answer('注入回答');
  const event = { ...h.boundary('1', [{ identity: 'm1', uuid: 'u1' }], () => acks++), held_history_ready: false };
  h.apply(event);
  assert.equal(h.saved.length, 0);
  assert.equal(acks, 0);
  event.held_history_ready = true;
  h.apply(event);
  assert.equal(h.saved.length, 1);
  assert.equal(acks, 1);
  const next = heldRun();
  next.run.runner.runnerId = 'runner-2';
  next.answer('重试回答');
  next.apply(next.boundary('1'));
  assert.notEqual(h.saved[0].id, next.saved[0].id);
});

test('an injected API error stays with its row and does not poison the host outcome', () => {
  const h = heldRun();
  h.answer('主回答');
  h.apply(h.boundary('1'));
  h.apply({ type: 'assistant', uuid: 'error-message', is_api_error_message: true,
    api_error_status: 429, error: 'rate_limit', message: { model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 429 rate limit' }] } });
  h.apply({ ...h.boundary('2', [{ identity: 'm1', uuid: 'u1' }]), is_error: true, subtype: 'error_during_execution' });
  assert.equal(h.saved[1].isError, true);
  assert.equal(h.run.runner.claudeApiError.pending, null);
  h.run.runner.completionOutcome = clone(COMPLETIONS[1]);
  h.apply({ type: 'result', subtype: 'success', is_error: false, result: '主回答',
    held_answers_saved: true, held_usage: { input_tokens: 6 } });
  assert.equal(h.run.cs.currentAssistantText, '主回答');
  assert.equal(h.run.runner.sawApiError, false);
  assert.equal(h.run.turn.resultDurable, true);
});

test('real semantic scrub preserves the held boundary acknowledgement callback', () => {
  const h = heldRun();
  let acks = 0;
  h.ports.scrub = (_attempt, event) => native.providerScrubSemanticStructure(event, ['fake-route-capability']);
  h.answer('可保存回答');
  h.apply({ ...h.boundary('1', [], () => acks++), result: ROUTE });
  assert.equal(acks, 1);
  assert.equal(h.saved.length, 1);
});

test('later held rows cannot overtake an earlier failed append', () => {
  const h = heldRun();
  let available = false;
  h.ports.appendHeldAnswer = (_session, message, key, cs, turn, runner) => {
    const ok = available;
    if (ok) h.saved.push(clone(message));
    native.chatCommitHeldAnswer(cs, turn, runner, key, ok, h.ports);
    return true;
  };
  h.answer('第一回答');
  const first = h.boundary('1');
  h.apply(first);
  h.answer('第二回答');
  const second = h.boundary('2');
  available = true;
  h.apply(second);
  assert.deepEqual(h.saved, []);
  h.apply(first);
  h.apply(second);
  assert.deepEqual(h.saved.map(row => row.content), ['第一回答', '第二回答']);
});

test('held failure rows display error details and cancellation alongside partial output', () => {
  const h = heldRun();
  h.apply({ ...h.boundary('1', [{ identity: 'm1', uuid: 'u1' }]),
    subtype: 'error_during_execution', is_error: true, errors: ['429 rate limit'] });
  assert.match(h.saved[0].content, /429 rate limit/);
  h.answer('已生成的部分');
  h.apply({ ...h.boundary('2', [{ identity: 'm2', uuid: 'u2' }]),
    subtype: 'error_during_execution', is_error: true, terminal_reason: 'cancelled', result: '这条消息的回答已取消。' });
  assert.match(h.saved[1].content, /已生成的部分[\s\S]*已取消/);
  assert.equal(h.saved[1].terminalReason, 'cancelled');
});

// ── two-phase final-answer persistence (native reducer) ─────────────────────
// The result event only starts the durable write. Nothing after the append
// boundary — usage ledger, turn count, _resultSaved, the live frame — may appear
// until the host commits a real verdict.
function finalRun() {
  const scenario = makeScenario(mulberry32(211));
  Object.assign(scenario, {
    mapped: true, stale: false, durable: true, replaceAfterPersist: false, proxyFailure: null,
  });
  Object.assign(scenario.cs, {
    currentAssistantText: 'answer', currentToolCalls: [], currentCost: 0,
    chatTurnCount: 0, turnStartedAt: 900,
  });
  Object.assign(scenario.runner, {
    turnId: scenario.turn.turnId, completionOutcome: clone(COMPLETIONS[1]),
  });
  const run = createRun(scenario);
  const ports = makePorts(run);
  const requests = [];
  ports.requestFinalPersist = (...args) => { requests.push(args); };
  const forward = frame => run.forwards.push(clone(frame));
  const apply = event => applyNative(ports, run.cs, run.sessionName, event, forward,
    run.turn, run.runner, run.providerName);
  const result = overrides => ({
    type: 'result', subtype: 'success', is_error: false, result: 'answer',
    usage: { input_tokens: 5 }, total_cost_usd: 0.05, ...overrides,
  });
  const commit = (durable, wasMapped, requested = requests[0], persisted = durable) => {
    const [session, cs, turn, runner, message, options, sink, mapped, evt] = requested;
    native.chatCommitFinalPersist(cs, session, evt, message, sink, turn, runner,
      durable, persisted, wasMapped, ports);
  };
  return { run, ports, requests, apply, forward, result, commit };
}

test('final answer persistence waits for the durable verdict before any post-boundary effect', () => {
  const h = finalRun();
  h.apply(h.result());
  assert.equal(h.requests.length, 1, 'the result event starts exactly one write');
  assert.equal(h.run.runner.pendingFinalPersist, true);
  assert.equal(h.run.cs.chatTurnCount, 0);
  assert.equal(h.run.cs._resultSaved, undefined);
  assert.deepEqual(h.run.forwards, []);
  assert.equal(h.run.effects.some(([name]) => name === 'recordDurableUsage'), false);
  assert.equal(h.run.effects.some(([name]) => name === 'onTurnComplete'), false);
  // A duplicate result while the first write is in flight must not start another.
  h.apply(h.result());
  assert.equal(h.requests.length, 1);
  assert.equal(h.run.runner.pendingFinalPersist, true);

  h.commit(true, true);
  assert.equal(h.run.runner.pendingFinalPersist, undefined);
  assert.equal(h.run.cs.chatTurnCount, 1);
  assert.equal(h.run.cs._resultSaved, true);
  assert.equal(h.run.effects.filter(([name]) => name === 'recordDurableUsage').length, 1);
  assert.equal(h.run.effects.filter(([name]) => name === 'onTurnComplete').length, 1);
  assert.equal(h.run.forwards.length, 2, 'the live frame then the original event');
  assert.equal(h.run.forwards[0].type, 'result');
  assert.equal(h.run.forwards[0].num_turns, 1);
});

test('a failed final-answer write is treated exactly like a synchronous false verdict', () => {
  const h = finalRun();
  h.apply(h.result());
  h.commit(false, true);
  assert.equal(h.run.runner.pendingFinalPersist, undefined);
  assert.equal(h.run.cs.chatTurnCount, 0);
  assert.equal(h.run.cs._resultSaved, undefined);
  assert.equal(h.run.effects.some(([name]) => name === 'recordDurableUsage'), false);
  assert.equal(h.run.forwards.length, 2, 'a failed write still forwards the live frame and event');
  assert.equal(h.run.forwards[0].type, 'result');
});

test('a replaced turn records usage by identity but writes no frame; a mapping loss stays inert', () => {
  for (const [lose, usageCommits] of [['runner', 1], ['mapping', 0]]) {
    const h = finalRun();
    h.apply(h.result());
    assert.equal(h.requests.length, 1);
    if (lose === 'runner') h.run.cs.currentRunner = {};
    else h.run.mapped = false;
    h.commit(true, true);
    assert.equal(h.run.runner.pendingFinalPersist, undefined, 'the marker is always released');
    assert.equal(h.run.cs.chatTurnCount, 0, 'the replacement keeps its own turn count');
    assert.equal(h.run.cs._resultSaved, undefined, 'the replacement keeps its own saved state');
    // A replacement loses the turn but not the tokens: usage is committed under
    // (turnId, runnerId). A mapping loss keeps the turn; its old synchronous
    // probe order returned before usage, and that parity is preserved. Nothing
    // is forwarded into either session.
    assert.equal(h.run.effects.filter(([name]) => name === 'recordDurableUsage').length, usageCommits);
    assert.deepEqual(h.run.forwards, []);
  }
});

test('a write that persisted but lost its turn still owes usage, while a failed write owes none', () => {
  for (const [durable, persisted, expected] of [[false, true, 1], [false, false, 0]]) {
    const h = finalRun();
    h.apply(h.result());
    assert.equal(h.requests.length, 1);
    h.run.cs.currentRunner = {};
    h.commit(durable, true, h.requests[0], persisted);
    assert.equal(h.run.effects.filter(([name]) => name === 'recordDurableUsage').length, expected);
    assert.equal(h.run.cs.chatTurnCount, 0);
    assert.deepEqual(h.run.forwards, []);
  }
});

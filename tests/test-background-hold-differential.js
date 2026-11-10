'use strict';
// Differential test: the frozen pre-Rust hold
// (tests/helpers/legacy-background-hold.js) versus the Rust owner behind
// src/chat/background-hold.js.
//
// Both are driven with the same fake clock (node:test mock timers patch
// setTimeout/setInterval/Date), the same events and the same host facts. After
// every step the observable surface is compared: the getter `held`, the return
// value of `start`/`observe`, and every released event.
//
// Named intentional divergences from the frozen oracle, asserted explicitly
// instead of being averaged away by the generator (which never injects):
//   * the cap is no longer a release trigger — it only unlocks one visible
//     notice (the generator passes a one-day cap so it can never reach it);
//   * injected messages are settled by the uuids their answer reports (H1: the
//     oracle counted results, so a self-wake could settle a typed message whose
//     answer had not arrived) and their answer is not the turn's result or
//     usage (M2: it rides along as `injected_exchanges` / `injected_usage`).
//
// Clock granularity: the legacy starts its quiet window inside the event
// handler, the Rust owner on its next tick, so the two can differ by one tick.
// Every `advance` is therefore at least QUIET_MS + 2 * TICK_MS, which makes a
// release land inside the same step on both sides; the comparison then only
// ever sees equivalent timing.
//
// The advance itself is stepped (`advanceClock` below): node:test's mock clock
// only moves `Date.now()` once per `tick(ms)` call, so a single big tick makes
// every interval callback of that jump read the same final `now` — something a
// real `setInterval` never does (and the Rust quiet window, which starts on a
// tick, would then never elapse). Ticking in TICK_MS steps gives each callback
// an advancing clock, exactly like production.
//
// Mutations: the frozen oracle is loaded again from its own source with one
// deliberate defect injected, and this same comparison must catch every one.
// That is what proves the scenarios have teeth — the Rust side cannot be
// mutated at runtime, the oracle can.
//
//   MULTICC_RUST_ADDON=<build>/multicc_core.node node --test tests/test-background-hold-differential.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const legacy = require('./helpers/legacy-background-hold');
const facade = require('../src/chat/background-hold');

const QUIET_MS = 5000;
const TICK_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Anything >= QUIET_MS + 2 * TICK_MS keeps a release inside one step on both
// sides (see the header). The generator only uses these.
const ADVANCES = [10000, 15000, 20000, 30000];

function stable(value) {
  if (value === undefined) return { __undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

const mainResult = (overrides = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'main answer',
  usage: { input_tokens: 1 }, modelUsage: { 'claude-x': 1 }, total_cost_usd: 0.01,
  session_id: 'native', ...overrides,
});
const wakeResult = (overrides = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'wake answer',
  usage: { input_tokens: 2 }, modelUsage: { 'claude-y': 2 }, total_cost_usd: 0.02,
  origin: { kind: 'task-notification' }, ...overrides,
});
const failedWake = (overrides = {}) => ({
  type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom',
  terminal_reason: 'api_error', api_error_status: 429, usage: { input_tokens: 3 }, ...overrides,
});
// Observed with the bundled engine (SDK 0.3.317): a result answering host input
// lists the uuids it answered; the singular field is the LAST one.
const answerResult = (uuids, overrides = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'answer',
  user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids,
  usage: { input_tokens: 3 }, total_cost_usd: 0.03, ...overrides,
});
const EVENTS = {
  assistant: { type: 'assistant', message: { role: 'assistant', content: [] } },
  user: { type: 'user', message: { role: 'user', content: [] } },
  stream: { type: 'stream_event', event: { delta: 'x' } },
  init: { type: 'system', subtype: 'init', session_id: 'native' },
  progress: { type: 'system', subtype: 'task_progress', task_id: 't1' },
  unknownResult: { type: 'result', subtype: 'unknown_verdict', is_error: false },
  cancelledWake: { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'cancelled' },
};

function makeWorld(factory, options = {}) {
  const releases = [];
  const capNotes = [];
  let background = options.background === true;
  const hold = factory({
    hasBackground: () => background,
    release: event => releases.push(event),
    quietMs: options.quietMs,
    tickMs: options.tickMs,
    maxMs: options.maxMs,
    onCapReached: ms => capNotes.push(ms),
  });
  return {
    hold, releases, capNotes,
    setBackground(value) { background = value; },
    snapshot() {
      return {
        held: hold.held === true,
        releases: stable(releases),
        capNotes: [...capNotes],
      };
    },
  };
}

// Runs `ops` against both factories, advancing the shared fake clock, and
// returns the first observable difference as a string (null when equivalent).
function compare({ factoryA, factoryB, ops, options, tick, label }) {
  const a = makeWorld(factoryA, options);
  const b = makeWorld(factoryB, options);
  const returnsA = [], returnsB = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op.type === 'start') {
      returnsA.push(a.hold.start(op.event));
      returnsB.push(b.hold.start(op.event));
    } else if (op.type === 'observe') {
      returnsA.push(a.hold.observe(op.event));
      returnsB.push(b.hold.observe(op.event));
    } else if (op.type === 'background') {
      a.setBackground(op.active);
      b.setBackground(op.active);
    } else if (op.type === 'advance') {
      tick(op.ms);
    } else if (op.type === 'flush') {
      returnsA.push(a.hold.flush());
      returnsB.push(b.hold.flush());
    } else if (op.type === 'dispose') {
      a.hold.dispose();
      b.hold.dispose();
    } else {
      throw new Error(`unknown op ${op.type}`);
    }
    const left = { ...a.snapshot(), returns: stable(returnsA) };
    const right = { ...b.snapshot(), returns: stable(returnsB) };
    try {
      assert.deepStrictEqual(left, right);
    } catch (_) {
      return `${label || 'scenario'}: first difference after op #${index} (${op.type})`
        + `\n  legacy: ${JSON.stringify(left)}\n  rust:   ${JSON.stringify(right)}`;
    }
  }
  return null;
}

// One `tick(ms)` moves the mock clock and `Date.now()` to the END of the jump
// before running the callbacks due inside it, so a single big advance would
// give every interval callback the same `now`. Stepping by TICK_MS restores
// the production behaviour of a clock that keeps moving under the callbacks.
function advanceClock(t, ms) {
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(TICK_MS, remaining);
    t.mock.timers.tick(step);
    remaining -= step;
  }
}

function scenarioOps(t) {
  const tick = ms => advanceClock(t, ms);
  return {
    tick,
    compare: (ops, options = {}, label = '') => compare({
      factoryA: legacy.createBackgroundHold, factoryB: facade.createBackgroundHold, ops, options,
      tick, label,
    }),
  };
}

function enable(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
}

// ── deterministic scenarios ──────────────────────────────────────────────────
test('hold lifecycle matches the frozen oracle', async t => {
  enable(t);
  const { compare: run } = scenarioOps(t);
  const deterministic = {
    'holds a successful main result while background work is alive': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'advance', ms: 30000 },
      { type: 'background', active: false },
      { type: 'advance', ms: 30000 },
    ],
    'does not hold without background work or without a successful result': [
      { type: 'background', active: false },
      { type: 'start', event: mainResult() },
      { type: 'background', active: true },
      { type: 'start', event: mainResult({ subtype: 'error', is_error: true }) },
      { type: 'start', event: EVENTS.cancelledWake },
      { type: 'advance', ms: 30000 },
    ],
    'self-wake success supersedes the held answer': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'observe', event: EVENTS.assistant },
      { type: 'observe', event: wakeResult({ result: 'first wake' }) },
      { type: 'observe', event: EVENTS.user },
      { type: 'observe', event: wakeResult({ result: 'second wake', usage: { input_tokens: 7 } }) },
      { type: 'background', active: false },
      { type: 'advance', ms: 30000 },
    ],
    'a later success supersedes an earlier failed wake': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'observe', event: failedWake() },
      { type: 'observe', event: wakeResult({ result: 'recovered' }) },
      { type: 'background', active: false },
      { type: 'advance', ms: 30000 },
    ],
    'a failed last wake releases the turn as an api error': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'observe', event: wakeResult() },
      { type: 'observe', event: failedWake({ result: undefined }) },
      { type: 'background', active: false },
      { type: 'advance', ms: 30000 },
    ],
    'cancelled and unknown wake results leave the outcome untouched': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'observe', event: wakeResult({ result: 'kept' }) },
      { type: 'observe', event: EVENTS.cancelledWake },
      { type: 'observe', event: EVENTS.unknownResult },
      { type: 'background', active: false },
      { type: 'advance', ms: 30000 },
    ],
    'a wake answer in flight keeps the turn open after background ends': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'background', active: false },
      { type: 'observe', event: EVENTS.assistant },
      { type: 'advance', ms: 30000 },
      { type: 'observe', event: wakeResult({ result: 'late answer' }) },
      { type: 'advance', ms: 30000 },
    ],
    'flush releases immediately and a second flush is a no-op': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'advance', ms: 10000 },
      { type: 'flush' },
      { type: 'flush' },
      { type: 'advance', ms: 30000 },
    ],
    'dispose drops the hold without releasing': [
      { type: 'background', active: true },
      { type: 'start', event: mainResult() },
      { type: 'dispose' },
      { type: 'advance', ms: 30000 },
      { type: 'start', event: mainResult() },
      { type: 'advance', ms: 30000 },
    ],
  };
  for (const [name, ops] of Object.entries(deterministic)) {
    assert.strictEqual(run(ops, { maxMs: DAY_MS }, name), null, name);
  }
});

// ── seeded randomized interleavings ──────────────────────────────────────────
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OBSERVE_EVENTS = [
  EVENTS.assistant, EVENTS.user, EVENTS.stream, EVENTS.init, EVENTS.progress,
  EVENTS.unknownResult, EVENTS.cancelledWake,
  wakeResult({ result: 'wake a' }), wakeResult({ result: 'wake b', usage: { input_tokens: 5 } }),
  failedWake(), failedWake({ result: undefined, api_error_status: 500 }),
];

function randomizedOps(seed, steps) {
  const random = mulberry32(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const chance = probability => random() < probability;
  const ops = [];
  for (let index = 0; index < steps; index += 1) {
    const roll = random();
    if (roll < 0.12) ops.push({ type: 'start', event: chance(0.75) ? mainResult() : mainResult({ subtype: 'error', is_error: true }) });
    else if (roll < 0.45) ops.push({ type: 'observe', event: pick(OBSERVE_EVENTS) });
    else if (roll < 0.58) ops.push({ type: 'background', active: chance(0.5) });
    else if (roll < 0.9) ops.push({ type: 'advance', ms: pick(ADVANCES) });
    else if (roll < 0.96) ops.push({ type: 'flush' });
    else ops.push({ type: 'dispose' });
  }
  return ops;
}

test('randomized interleavings match the frozen oracle', async t => {
  enable(t);
  const { compare: run } = scenarioOps(t);
  for (let seed = 1; seed <= 12; seed += 1) {
    const ops = randomizedOps(seed, 80);
    assert.strictEqual(run(ops, { maxMs: DAY_MS, background: seed % 2 === 0 }, `seed ${seed}`), null,
      `randomized interleaving seed ${seed} must match the frozen oracle`);
  }
});

// ── intentional divergence: the cap no longer releases ───────────────────────
test('intentional divergence: the cap warns instead of releasing', async t => {
  enable(t);
  const options = { maxMs: 5000, quietMs: QUIET_MS, background: true };
  const ops = [
    { type: 'start', event: mainResult() },
    { type: 'advance', ms: 20000 },
  ];
  const legacyWorld = makeWorld(legacy.createBackgroundHold, options);
  const rustWorld = makeWorld(facade.createBackgroundHold, options);
  for (const op of ops) {
    if (op.type === 'start') { legacyWorld.hold.start(op.event); rustWorld.hold.start(op.event); }
    else advanceClock(t, op.ms);
  }
  // Frozen oracle: the cap released the turn while its background work was alive.
  assert.strictEqual(legacyWorld.releases.length, 1, 'legacy releases at the cap');
  assert.deepStrictEqual(stable(legacyWorld.releases[0]), stable(mainResult()));
  assert.strictEqual(legacyWorld.hold.held, false);
  // Rust owner: the turn is still held; the cap only unlocked one warning.
  assert.strictEqual(rustWorld.releases.length, 0, 'rust does not release at the cap');
  assert.strictEqual(rustWorld.hold.held, true);
  assert.deepStrictEqual(rustWorld.capNotes, [5000], 'the cap warning fires exactly once');
  // More time on the same cap must not warn twice nor release.
  advanceClock(t, 600000);
  assert.deepStrictEqual(rustWorld.capNotes, [5000]);
  assert.strictEqual(rustWorld.releases.length, 0, 'a persistent task keeps the turn open');
  // The turn ends when the background work does.
  rustWorld.setBackground(false);
  advanceClock(t, 30000);
  assert.strictEqual(rustWorld.releases.length, 1);
  assert.deepStrictEqual(stable(rustWorld.releases[0]), stable(mainResult()));
});

// ── a message the user types INTO the held turn (H1 / H2 / M2) ───────────────
// Intentional divergence from the frozen oracle, asserted by name: the oracle
// counted results and let ANY of them settle an injection, so a self-wake could
// settle a typed message whose answer had not arrived (H1) and the injected
// answer itself could become the turn's result and usage (M2).
test('an injected message is settled by its own answer, never by a self-wake', async t => {
  enable(t);
  const world = makeWorld(facade.createBackgroundHold, { maxMs: DAY_MS, background: true });
  assert.strictEqual(world.hold.start(mainResult()), true);
  world.setBackground(false);
  const registered = world.hold.beginInjection('typed-1', 'uuid-1');
  assert.strictEqual(registered.action, 'write');
  assert.strictEqual(registered.uuid, 'uuid-1');
  advanceClock(t, 60000);
  assert.strictEqual(world.releases.length, 0, 'the outstanding injected answer holds the turn');
  // The injected query streams and ends like any other query of the turn.
  assert.strictEqual(world.hold.observe(EVENTS.assistant), false);
  // A self-wake (task notification) answers no injected uuid: it must not
  // settle the typed message nor let the turn end.
  assert.strictEqual(world.hold.observe(wakeResult({ result: 'wake while pending' })), true);
  assert.strictEqual(world.hold.injectionsInFlight, 1, 'the self-wake settled nothing');
  advanceClock(t, 60000);
  assert.strictEqual(world.releases.length, 0, 'still held');
  // Now the real answer lands.
  assert.strictEqual(world.hold.observe(answerResult(['uuid-1'])), true);
  assert.strictEqual(world.hold.injectionsInFlight, 0);
  // A duplicate of that answer is swallowed too and never becomes the turn's
  // own outcome (nor adds a second exchange).
  assert.strictEqual(world.hold.observe(answerResult(['uuid-1'], { result: 'duplicate' })), true);
  advanceClock(t, 30000);
  assert.strictEqual(world.releases.length, 1);
  const released = world.releases[0];
  // M2: the turn's outcome is its own last answer (the self-wake), NOT the
  // answer to the typed message; that one rides along as its own exchange with
  // its own usage.
  assert.strictEqual(released.result, 'wake while pending');
  assert.strictEqual(released.injected_exchanges.length, 1);
  assert.strictEqual(released.injected_exchanges[0].identity, 'typed-1');
  assert.strictEqual(released.injected_exchanges[0].uuid, 'uuid-1');
  assert.deepStrictEqual(released.injected_usage, { input_tokens: 3 });
  assert.strictEqual(released.injected_cost_usd, 0.03);
  assert.strictEqual(released.total_cost_usd, 0.02, 'the turn cost stays the self-wake\'s, not the injected one');
  // Injecting into a turn that is no longer held is refused.
  const refused = world.hold.beginInjection('typed-2', 'uuid-2');
  assert.strictEqual(refused.action, 'refuse');
  assert.strictEqual(refused.reason, 'not_held');
});

test('two queued messages are settled by one coalesced answer, in order', async t => {
  enable(t);
  const world = makeWorld(facade.createBackgroundHold, { maxMs: DAY_MS, background: true });
  assert.strictEqual(world.hold.start(mainResult()), true);
  world.setBackground(false);
  assert.strictEqual(world.hold.beginInjection('typed-1', 'uuid-1').action, 'write');
  assert.strictEqual(world.hold.beginInjection('typed-2', 'uuid-2').action, 'write');
  assert.strictEqual(world.hold.injectionsInFlight, 2);
  // Observed: two back-to-back injections are coalesced into ONE result that
  // lists BOTH uuids (the singular field is the last one).
  assert.strictEqual(world.hold.observe(answerResult(['uuid-1', 'uuid-2'])), true);
  assert.strictEqual(world.hold.injectionsInFlight, 0);
  advanceClock(t, 30000);
  assert.strictEqual(world.releases.length, 1);
  assert.strictEqual(world.releases[0].result, 'main answer', 'no self-wake: the main answer decides');
  assert.deepStrictEqual(world.releases[0].injected_exchanges.map(item => item.identity),
    ['typed-1', 'typed-2']);
  assert.deepStrictEqual(world.releases[0].injected_usage, { input_tokens: 6 });
});

test('exactly-once: a retry appends the row only, an abort releases the identity', async t => {
  enable(t);
  const world = makeWorld(facade.createBackgroundHold, { maxMs: DAY_MS, background: true });
  assert.strictEqual(world.hold.start(mainResult()), true);
  world.setBackground(false);
  const first = world.hold.beginInjection('typed-1', 'uuid-1');
  assert.strictEqual(first.action, 'write');
  assert.strictEqual(first.uuid, 'uuid-1');
  // The host wrote the line but failed to persist the history row: the retry
  // may not write the message into the process a second time (H2).
  const retried = world.hold.beginInjection('typed-1', 'uuid-9');
  assert.strictEqual(retried.action, 'append_only', 'the written uuid is authoritative');
  assert.strictEqual(retried.uuid, 'uuid-1');
  // A failed write aborts the identity, and only then may a retry write.
  world.hold.abortInjection('typed-1');
  assert.strictEqual(world.hold.injectionsInFlight, 0);
  assert.strictEqual(world.hold.beginInjection('typed-1', 'uuid-2').action, 'write');
  assert.strictEqual(world.hold.observe(answerResult(['uuid-2'])), true);
  // An aborted/failed delivery leaves no outstanding answer behind.
  const second = makeWorld(facade.createBackgroundHold, { maxMs: DAY_MS, background: true });
  assert.strictEqual(second.hold.start(mainResult()), true);
  assert.strictEqual(second.hold.beginInjection('typed-1', 'uuid-1').action, 'write');
  second.hold.abortInjection('typed-1');
  second.setBackground(false);
  advanceClock(t, 30000);
  assert.strictEqual(second.releases.length, 1, 'an aborted injection does not pin the turn');
  assert.strictEqual(second.releases[0].injected_exchanges, undefined);
});

// ── the pure delivery predicate (Rust) ───────────────────────────────────────
test('delivery predicate: one rule for every resident backend', () => {
  const facts = (overrides = {}) => ({
    held: true, userTyped: true, attributable: true, turnActive: true,
    processAlive: true, processStale: false, processContract: 'digest-a', wantedContract: 'digest-a',
    deliverySettled: false, ...overrides,
  });
  const reason = overrides => facade.mayInjectIntoHeldTurn(facts(overrides)).reason;
  const inject = overrides => facade.mayInjectIntoHeldTurn(facts(overrides)).inject;
  assert.deepStrictEqual(facade.mayInjectIntoHeldTurn(facts()), { inject: true, reason: 'held' });
  const cases = [
    [{ held: false }, 'not_held'],
    [{ turnActive: false }, 'no_active_turn'],
    [{ userTyped: false }, 'not_user_typed'],
    // A plain stream-json lane reports no answer attribution, so an injected
    // line there could never be settled (the message keeps waiting).
    [{ attributable: false }, 'unattributable_lane'],
    [{ processAlive: false }, 'process_not_alive'],
    // M3: route/credential/vault drift is decided by the same staleness
    // comparison the pump uses; a stale process is the one legitimate wait.
    [{ processStale: true }, 'process_changed'],
    [{ processContract: 'digest-b' }, 'spawn_contract_changed'],
    [{ processContract: null }, 'spawn_contract_changed'],
    [{ wantedContract: null }, 'spawn_contract_changed'],
    [{ deliverySettled: true }, 'already_delivered'],
  ];
  for (const [overrides, expected] of cases) {
    assert.strictEqual(inject(overrides), false, `${JSON.stringify(overrides)} must wait`);
    assert.strictEqual(reason(overrides), expected);
  }
  // The one staleness comparison (M3): same facts never look stale, route
  // credential or vault drift does.
  const running = { routeUrl: 'https://a', routeToken: 't', fingerprint: 'f', vaultDigest: 'v' };
  assert.strictEqual(facade.processStale(running, running).stale, false);
  const movedRoute = facade.processStale(running, { ...running, routeToken: 'other' });
  assert.strictEqual(movedRoute.routeChanged, true);
  assert.strictEqual(movedRoute.configChanged, false);
  assert.strictEqual(movedRoute.vaultStale, false);
  assert.strictEqual(movedRoute.stale, true);
  assert.strictEqual(facade.processStale(running, { ...running, fingerprint: 'g' }).configChanged, true);
  assert.strictEqual(facade.processStale(running, { ...running, vaultDigest: 'w' }).vaultStale, true);
  // The digest is stable for equal facts and sensitive to every deciding field.
  const digest = facade.spawnContract({ cli: 'claude', model: 'm', effort: 'high' });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.strictEqual(digest, facade.spawnContract({ effort: 'high', model: 'm', cli: 'claude' }), 'key order is not a fact');
  assert.notStrictEqual(digest, facade.spawnContract({ cli: 'claude', model: 'other', effort: 'high' }));
  assert.notStrictEqual(digest, facade.spawnContract({ cli: 'claude', model: 'm', effort: 'high', pendingConfiguration: { model: 'other' } }));
});

// ── mutations: the differential must catch every injected defect ─────────────
const LEGACY_SOURCE = fs.readFileSync(path.join(__dirname, 'helpers', 'legacy-background-hold.js'), 'utf8');

function loadVariant(transform) {
  const source = transform(LEGACY_SOURCE);
  assert.notStrictEqual(source, LEGACY_SOURCE, 'mutation must change the oracle source');
  const helperRequire = spec => require(path.resolve(__dirname, 'helpers', spec));
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', source)(helperRequire, mod, mod.exports, path.join(__dirname, 'helpers'));
  return mod.exports.createBackgroundHold;
}

const MUTANTS = [
  ['releases as soon as the background fact is read', src => src.replace(
    'if (active) { quietSince = 0; return; }', 'if (active) { finish(); return; }')],
  ['releases while a wake answer is still streaming', src => src.replace(
    'if (!held || busy) { quietSince = 0; return; }', 'if (!held) { quietSince = 0; return; }')],
  ['forgets a failing self-wake', src => src.replace(
    'else if (failed(event)) lastWake = event;', 'else if (failed(event)) lastWake = null;')],
  ['hides a failing self-wake behind the held answer', src => src.replace(
    'const result = lastWake && failed(lastWake) ? failedRelease(held, lastWake) : merge(held, latest);',
    'const result = merge(held, latest);')],
  ['holds a failing main result', src => src.replace(
    'if (done || held || !isMainResult(event) || !succeeded(event)) return false;',
    'if (done || held || !isMainResult(event)) return false;')],
  ['leaks a failing self-wake result to the host', src => src.replace(
    "if (event?.type === 'result') {", "if (event?.type === 'result' && succeeded(event)) {")],
  ['keeps the held answer instead of the final wake answer', src => src.replace(
    "return { ...held, result: pick('result'), usage: pick('usage'), modelUsage: pick('modelUsage'),",
    "return { ...held, result: held.result, usage: pick('usage'), modelUsage: pick('modelUsage'),")],
  ['leaks a cancelled wake result to the host', src => src.replace(
    'if (CANCELLED.has(event?.terminal_reason)) { tick(); return true; }',
    'if (CANCELLED.has(event?.terminal_reason)) { tick(); return false; }')],
  ['merges a quiet release without the last wake', src => src.replace(
    '? failedRelease(held, lastWake) : merge(held, latest);',
    '? failedRelease(held, lastWake) : merge(held, null);')],
];

const MUTATION_CORPUS = [
  [
    { type: 'background', active: true },
    { type: 'start', event: mainResult() },
    { type: 'advance', ms: 15000 },
  ],
  [
    { type: 'background', active: true },
    { type: 'start', event: mainResult() },
    { type: 'background', active: false },
    { type: 'observe', event: EVENTS.assistant },
    { type: 'advance', ms: 20000 },
  ],
  [
    { type: 'background', active: true },
    { type: 'start', event: mainResult() },
    { type: 'observe', event: wakeResult({ result: 'ok' }) },
    { type: 'observe', event: failedWake() },
    { type: 'background', active: false },
    { type: 'advance', ms: 30000 },
  ],
  [
    { type: 'background', active: true },
    { type: 'start', event: mainResult({ subtype: 'error_during_execution', is_error: true }) },
    { type: 'advance', ms: 15000 },
  ],
  [
    { type: 'background', active: true },
    { type: 'start', event: mainResult() },
    { type: 'observe', event: EVENTS.cancelledWake },
    { type: 'observe', event: EVENTS.unknownResult },
    { type: 'observe', event: wakeResult({ result: 'final answer' }) },
    { type: 'background', active: false },
    { type: 'advance', ms: 20000 },
  ],
  ...Array.from({ length: 6 }, (_, index) => randomizedOps(100 + index, 80)),
];

test('mutations of the frozen oracle are all caught by the differential', async t => {
  enable(t);
  const tick = ms => advanceClock(t, ms);
  // Sanity: the unmutated oracle is equivalent to itself on this corpus (i.e.
  // the corpus and the comparison are deterministic).
  for (const [name, transform] of [['unmutated', src => src]]) {
    const factory = name === 'unmutated' ? legacy.createBackgroundHold : loadVariant(transform);
    for (const [index, ops] of MUTATION_CORPUS.entries()) {
      assert.strictEqual(compare({
        factoryA: legacy.createBackgroundHold, factoryB: factory, ops, options: { maxMs: DAY_MS }, tick,
        label: `corpus ${index}`,
      }), null, 'the oracle must equal itself');
    }
  }
  for (const [name, transform] of MUTANTS) {
    const mutant = loadVariant(transform);
    const caught = MUTATION_CORPUS.some(ops => compare({
      factoryA: legacy.createBackgroundHold, factoryB: mutant, ops, options: { maxMs: DAY_MS }, tick,
      label: name,
    }) !== null);
    assert.strictEqual(caught, true, `mutation not caught: ${name}`);
  }
  assert.ok(MUTANTS.length >= 5, 'at least five mutations');
});

// ── holdMaxMs (env parsing) ──────────────────────────────────────────────────
test('holdMaxMs parses the environment exactly like the frozen oracle', () => {
  const cases = [
    [{}, 3600000],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: '0' }, 0],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: '2500' }, 2500],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: '-5' }, 3600000],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: 'abc' }, 3600000],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: '' }, 0],
    [{ MULTICC_BACKGROUND_HOLD_MAX_MS: 'Infinity' }, 3600000],
  ];
  for (const [env, expected] of cases) {
    assert.strictEqual(facade.holdMaxMs(env), expected, JSON.stringify(env));
    assert.strictEqual(legacy.holdMaxMs(env), expected, JSON.stringify(env));
  }
});

'use strict';

// Differential coverage for the native owners behind the live chat-session table
// (chatSessions) and the per-session turn runtime store. The frozen
// pre-migration implementation is the oracle: every randomized step runs against
// both and must agree on values, key order, frozenness and object identity.
//
// The stores are native-only (`src/chat/runtime-store.js` and
// `src/chat/sessions.js` are facades); a divergence means the Rust owner drifted
// from the frozen semantics, not that a fallback lane exists.

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { createStateOwner } = require('../src/state/owner');
const { createChatSessions } = require('../src/chat/sessions');
const { createTurnRuntimeStore: createNativeRuntime } = require('../src/chat/runtime-store');
const { createTurnRuntimeStore: createLegacyRuntime } = require('./helpers/legacy-chat-runtime-store');
const { createLegacyChatSession, createLegacyChatSessions } = require('./helpers/legacy-chat-sessions');

test('a runtime facade keeps its host anchor alive, then releases native/host cycles', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict');
    const { createStateOwner } = require('./src/state/owner');
    const { createTurnRuntimeStore } = require('./src/chat/runtime-store');
    (async () => {
      const fixture = (() => {
        const owner = createStateOwner();
        const now = () => 100;
        now.native = owner.native; // anchor -> clock -> native -> anchor cycle
        return {
          store: createTurnRuntimeStore({ owner, now }),
          anchor: new WeakRef(owner.anchor), native: new WeakRef(owner.native),
        };
      })();
      fixture.store.claim('gc-session', 'gc-turn');
      await new Promise(setImmediate);
      global.gc();
      assert.ok(fixture.anchor.deref(), 'live facade must retain the host anchor');
      assert.equal(fixture.store.settle('gc-session', 'gc-turn', { status: 'failed' }).ok, true);
      fixture.store = null;
      for (let i = 0; i < 20; i++) {
        await new Promise(setImmediate);
        global.gc();
        if (!fixture.anchor.deref() && !fixture.native.deref()) break;
      }
      assert.equal(fixture.anchor.deref(), undefined, 'unreachable host cycle must be collectible');
      assert.equal(fixture.native.deref(), undefined, 'native instance must not be rooted forever');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

// Each harness is one "process": a runtime store, a chat-session table and a
// clock that advances identically so timestamps line up across the two lanes.
function nativeHarness() {
  const owner = createStateOwner();
  let tick = 1000;
  const store = createNativeRuntime({ owner, now: () => (tick += 7) });
  return { store, sessions: createChatSessions(owner), owner };
}

function legacyHarness() {
  let tick = 1000;
  const store = createLegacyRuntime({ now: () => (tick += 7) });
  return { store, sessions: createLegacyChatSessions() };
}

function routeFor(sessionId, turnId, variant) {
  const route = {
    runtimeEpoch: 'epoch-1',
    decisionId: 'decision-1',
    routeAttemptId: 'attempt-1',
    providerId: 'provider-1',
    protocol: 'anthropic',
    model: 'model-1',
    providerRevision: 'revision-1',
    routeGeneration: 1,
    attemptNo: 1,
  };
  const proof = { kind: 'provider-route', resolved: true, sessionId, turnId, route };
  switch (variant) {
    case 'zero-generation': route.routeGeneration = 0; break;
    case 'fractional-attempt': route.attemptNo = 1.5; break;
    case 'missing-model': delete route.model; break;
    case 'unsafe-generation': route.routeGeneration = 2 ** 53; break;
    case 'wrong-session': proof.sessionId = `${sessionId}-other`; break;
    case 'wrong-turn': proof.turnId = `${turnId}-other`; break;
    case 'route-thawed': break; // `route` is frozen below unless this variant
    default: break;
  }
  proof.route = variant === 'route-thawed' ? { ...route } : Object.freeze(route);
  return variant === 'proof-thawed' ? proof : Object.freeze(proof);
}

function assertFrozenState(state, label) {
  assert.equal(Object.isFrozen(state), true, `${label}: state must be frozen`);
  if (state.lastOutcome) {
    assert.equal(Object.isFrozen(state.lastOutcome), true, `${label}: lastOutcome must be frozen`);
  }
  if (state.pendingOutcome) {
    assert.equal(Object.isFrozen(state.pendingOutcome), true, `${label}: pendingOutcome must be frozen`);
  }
}

function compareResult(native, legacy, label) {
  assert.deepStrictEqual(native, legacy, label);
  if (native && typeof native === 'object' && !Array.isArray(native)) {
    assert.deepStrictEqual(Object.keys(native), Object.keys(legacy), `${label}: result key order`);
    assert.equal(Object.isFrozen(native), true, `${label}: result must be frozen`);
  }
  if (native && native.state) {
    assert.deepStrictEqual(
      Object.keys(native.state), Object.keys(legacy.state), `${label}: state key order`,
    );
    assertFrozenState(native.state, label);
    if (native.missing) assert.equal(Object.isFrozen(native.missing), true, `${label}: missing frozen`);
  }
}

const SESSIONS = ['s-a', 's-b', ' s-c ', 's-d', '', 's-e'];
const TURNS = ['t-1', 't-2', ' t-3 ', 't-4', '', 't-5'];

test('randomized turn lifecycles agree between the native owner and the frozen store', () => {
  const rnd = mulberry32(0x5eed1234);
  const native = nativeHarness();
  const legacy = legacyHarness();
  let steps = 0;
  let last = null;
  for (let index = 0; index < 1200; index += 1) {
    // Stick to the previous (session, turn) pair most of the time: independent
    // uniform picks almost never walk one turn through claim → route → start →
    // cleanup, which is exactly the sequence that must be compared.
    const stick = last && rnd() < 0.65;
    const session = stick ? last.session : pick(rnd, SESSIONS);
    const turn = stick ? last.turn : pick(rnd, TURNS);
    last = { session, turn };
    const op = pick(rnd, [
      'claim', 'claim', 'markMessageDurable', 'markProviderRouteResolved',
      'markProviderRouteResolved', 'providerRouteFailed', 'abortPreparation', 'settle',
      'start', 'beginCleanup', 'cleanup', 'claimProof', 'snapshot', 'list',
      'chatSet', 'chatSet', 'chatGet', 'chatHas', 'chatDelete', 'chatSize', 'chatEntries',
    ]);
    const label = `${index}:${op}(${JSON.stringify(session)},${JSON.stringify(turn)})`;
    let nativeValue;
    let legacyValue;
    switch (op) {
      case 'claim': {
        const meta = pick(rnd, [{}, { cli: 'codex' }, { cli: '', transport: '' },
          { cli: 'claude', transport: 'claude-stream' }]);
        nativeValue = native.store.claim(session, turn, meta);
        legacyValue = legacy.store.claim(session, turn, meta);
        break;
      }
      case 'markMessageDurable':
        nativeValue = native.store.markMessageDurable(session, turn);
        legacyValue = legacy.store.markMessageDurable(session, turn);
        break;
      case 'markProviderRouteResolved': {
        const snapshot = native.store.snapshot(session);
        const routeTurn = snapshot.turnId == null ? turn : snapshot.turnId;
        const variant = pick(rnd, ['valid', 'zero-generation', 'fractional-attempt',
          'missing-model', 'wrong-session', 'wrong-turn', 'proof-thawed', 'resolved-false',
          'reason-null']);
        let route;
        if (variant === 'resolved-false') route = { resolved: false, reason: pick(rnd, ['busy', '', null]) };
        else if (variant === 'reason-null') route = { resolved: false };
        else route = { resolved: true, proof: routeFor(snapshot.sessionId, routeTurn, variant) };
        nativeValue = native.store.markProviderRouteResolved(session, turn, route);
        legacyValue = legacy.store.markProviderRouteResolved(session, turn, route);
        if (nativeValue.ok && variant === 'valid') {
          assert.equal(nativeValue.state.providerRouteProof, route.proof,
            `${label}: native must keep the proof object identity`);
          assert.equal(legacyValue.state.providerRouteProof, route.proof,
            `${label}: oracle identity`);
        }
        break;
      }
      case 'providerRouteFailed': {
        const reason = pick(rnd, [undefined, null, 'route-failed', 'busy', '   ']);
        nativeValue = native.store.providerRouteFailed(session, turn, reason);
        legacyValue = legacy.store.providerRouteFailed(session, turn, reason);
        break;
      }
      case 'abortPreparation': {
        const reason = pick(rnd, [undefined, null, 'message-not-durable', '  ']);
        nativeValue = native.store.abortPreparation(session, turn, reason);
        legacyValue = legacy.store.abortPreparation(session, turn, reason);
        break;
      }
      case 'settle': {
        const outcome = pick(rnd, [{}, { status: 'failed' }, { reason: 'boom' },
          { status: '', reason: null }, { status: 'cancelled', reason: '  ' }]);
        const allowed = pick(rnd, [undefined, ['preparing'], ['preparing', 'running'],
          ['running'], ['finishing'], ['preparing', 'running', 'finishing']]);
        nativeValue = native.store.settle(session, turn, outcome, allowed);
        legacyValue = legacy.store.settle(session, turn, outcome, allowed);
        break;
      }
      case 'start':
        nativeValue = native.store.start(session, turn);
        legacyValue = legacy.store.start(session, turn);
        break;
      case 'beginCleanup': {
        const outcome = pick(rnd, [{}, { status: 'completed' }, { status: 'failed', reason: 'x' }]);
        nativeValue = native.store.beginCleanup(session, turn, outcome);
        legacyValue = legacy.store.beginCleanup(session, turn, outcome);
        break;
      }
      case 'cleanup':
        nativeValue = native.store.cleanup(session, turn);
        legacyValue = legacy.store.cleanup(session, turn);
        break;
      case 'claimProof':
        nativeValue = native.store.claimProof(session, turn);
        legacyValue = legacy.store.claimProof(session, turn);
        break;
      case 'snapshot':
        nativeValue = native.store.snapshot(session);
        legacyValue = legacy.store.snapshot(session);
        assert.deepStrictEqual(Object.keys(nativeValue), Object.keys(legacyValue), `${label}: keys`);
        assertFrozenState(nativeValue, label);
        break;
      case 'list': {
        nativeValue = native.store.list();
        legacyValue = legacy.store.list();
        assert.deepStrictEqual(nativeValue, legacyValue, `${label}: list`);
        assert.equal(Object.isFrozen(nativeValue), true, `${label}: list frozen`);
        assert.deepStrictEqual(nativeValue.map(Object.keys), legacyValue.map(Object.keys));
        break;
      }
      case 'chatSet': {
        const value = createLegacyChatSession({ cli: pick(rnd, ['claude', 'codex']) });
        const nativeReturn = native.sessions.set(session, value);
        const legacyReturn = legacy.sessions.set(session, value);
        assert.equal(nativeReturn, native.sessions, `${label}: Map#set returns the map`);
        assert.equal(legacyReturn, legacy.sessions);
        assert.equal(native.sessions.get(session), value, `${label}: identity through native table`);
        nativeValue = true;
        legacyValue = true;
        break;
      }
      case 'chatGet':
        nativeValue = native.sessions.get(session);
        legacyValue = legacy.sessions.get(session);
        assert.equal(nativeValue, legacyValue, `${label}: same host object or undefined`);
        nativeValue = nativeValue === undefined ? null : true;
        legacyValue = legacyValue === undefined ? null : true;
        break;
      case 'chatHas':
        nativeValue = native.sessions.has(session);
        legacyValue = legacy.sessions.has(session);
        break;
      case 'chatDelete':
        nativeValue = native.sessions.delete(session);
        legacyValue = legacy.sessions.delete(session);
        assert.equal(native.sessions.has(session), legacy.sessions.has(session));
        break;
      case 'chatSize':
        nativeValue = native.sessions.size;
        legacyValue = legacy.sessions.size;
        break;
      case 'chatEntries': {
        assert.deepStrictEqual(
          [...native.sessions.keys()], [...legacy.sessions.keys()], `${label}: key order`,
        );
        assert.deepStrictEqual(
          [...native.sessions.values()].map(value => value.cli),
          [...legacy.sessions.values()].map(value => value.cli), `${label}: value order`,
        );
        const nativeSeen = [];
        native.sessions.forEach((value, key) => nativeSeen.push([key, value.cli]));
        const legacySeen = [];
        legacy.sessions.forEach((value, key) => legacySeen.push([key, value.cli]));
        assert.deepStrictEqual(nativeSeen, legacySeen, `${label}: forEach order`);
        nativeValue = true;
        legacyValue = true;
        break;
      }
      default:
        throw new Error(`unhandled op ${op}`);
    }
    if (nativeValue !== undefined || legacyValue !== undefined) {
      compareResult(nativeValue, legacyValue, label);
    }
    // What the owner STORES is part of the contract, not only what the call
    // returned: a transition that reports success but forgets to publish it
    // (e.g. a cleanup that leaves the finished turn active) must show up here.
    assert.deepStrictEqual(native.store.snapshot(session), legacy.store.snapshot(session),
      `${label}: stored state drift`);
    if (index % 40 === 0) {
      assert.deepStrictEqual(native.store.list(), legacy.store.list(), `${label}: periodic list drift`);
      assert.equal(native.sessions.size, legacy.sessions.size, `${label}: periodic table size drift`);
    }
    steps += 1;
  }
  assert.ok(steps >= 1000, `expected at least 1000 differential steps, ran ${steps}`);
});

test('scripted full lifecycles publish every transition, exactly like the frozen store', () => {
  // Uniform random picks almost never walk one turn through the whole chain, so
  // the long path is scripted here: claim → durable → route proof → start →
  // cleanup (complete or cancel). Every step's return value AND the stored
  // snapshot are compared, which is what catches a transition that reports a
  // result the owner never published.
  const variants = [
    { session: 's-1', turn: 't-1', outcome: {} },
    { session: 's-2', turn: 't-2', outcome: { status: 'completed' } },
    { session: 's-3', turn: 't-3', outcome: { status: 'failed', reason: 'boom' } },
    { session: 's-4', turn: 't-4', outcome: { status: 'cancelled', reason: 'user_cancelled' } },
    { session: 's-5', turn: 't-5', outcome: { status: '', reason: null } },
  ];
  for (let round = 0; round < 200; round += 1) {
    const spec = variants[round % variants.length];
    const native = nativeHarness();
    const legacy = legacyHarness();
    const steps = [
      ['claim', () => [round % 2 ? { cli: 'codex' } : {}]],
      ['markMessageDurable'],
      ['markProviderRouteResolved'],
      ['start'],
      ['beginCleanup'],
      ['cleanup'],
    ];
    for (const [op, argsOf] of steps) {
      let nativeValue, legacyValue;
      if (op === 'markProviderRouteResolved') {
        // The route proof must name the exact session/turn the stores hold.
        const snapshot = native.store.snapshot(spec.session);
        assert.equal(snapshot.turnId, spec.turn);
        const route = {
          kind: 'provider-route', resolved: true, sessionId: snapshot.sessionId,
          turnId: snapshot.turnId,
          route: Object.freeze({ runtimeEpoch: 'epoch', decisionId: 'decision',
            routeAttemptId: 'attempt', providerId: 'provider', protocol: 'anthropic',
            model: 'model', providerRevision: 'revision', routeGeneration: 1, attemptNo: 1 }),
        };
        Object.freeze(route);
        nativeValue = native.store.markProviderRouteResolved(spec.session, spec.turn, { resolved: true, proof: route });
        legacyValue = legacy.store.markProviderRouteResolved(spec.session, spec.turn, { resolved: true, proof: route });
      } else if (op === 'beginCleanup') {
        nativeValue = native.store.beginCleanup(spec.session, spec.turn, spec.outcome);
        legacyValue = legacy.store.beginCleanup(spec.session, spec.turn, spec.outcome);
      } else if (argsOf) {
        nativeValue = native.store[op](spec.session, spec.turn, ...argsOf());
        legacyValue = legacy.store[op](spec.session, spec.turn, ...argsOf());
      } else {
        nativeValue = native.store[op](spec.session, spec.turn);
        legacyValue = legacy.store[op](spec.session, spec.turn);
      }
      compareResult(nativeValue, legacyValue, `round ${round}: ${op}`);
      assert.equal(nativeValue.ok, true, `round ${round}: ${op} must succeed`);
      assert.deepStrictEqual(native.store.snapshot(spec.session), legacy.store.snapshot(spec.session),
        `round ${round}: ${op} stored state`);
    }
    const final = native.store.snapshot(spec.session);
    assert.equal(final.phase, 'idle', `round ${round}: cleanup must clear the active turn`);
    assert.equal(final.turnId, null);
    assert.ok(final.lastOutcome, `round ${round}: pending outcome must be promoted`);
    assert.equal(final.lastOutcome.turnId, spec.turn);
    assert.deepStrictEqual(final, legacy.store.snapshot(spec.session));
  }
});

test('route proof validation matrix matches the frozen rule exactly', () => {
  const variants = ['valid', 'zero-generation', 'fractional-attempt', 'missing-model',
    'unsafe-generation', 'wrong-session', 'wrong-turn', 'proof-thawed', 'route-thawed'];
  for (const variant of variants) {
    const native = nativeHarness();
    const legacy = legacyHarness();
    for (const store of [native.store, legacy.store]) {
      assert.equal(store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' }).ok, true);
      assert.equal(store.markMessageDurable('s1', 't1').ok, true);
    }
    const proof = routeFor('s1', 't1', variant);
    const nativeResult = native.store.markProviderRouteResolved('s1', 't1', { resolved: true, proof });
    const legacyResult = legacy.store.markProviderRouteResolved('s1', 't1', { resolved: true, proof });
    compareResult(nativeResult, legacyResult, `proof variant ${variant}`);
    if (variant === 'valid') {
      assert.equal(nativeResult.ok, true, 'valid proof resolves the route');
      assert.equal(nativeResult.state.phase, 'preparing');
      assert.equal(nativeResult.state.providerRouteResolved, true);
      assert.equal(nativeResult.state.providerRouteProof, proof);
      assert.equal(native.store.start('s1', 't1').state.phase, 'running');
      assert.equal(legacy.store.start('s1', 't1').state.phase, 'running');
    } else {
      // Legacy `providerRouteFailed` settles successfully, so `ok` stays true
      // and the observable failure is the idle lastOutcome.
      assert.equal(nativeResult.ok, true, `${variant}: settle itself succeeds`);
      assert.equal(nativeResult.state.phase, 'idle', `${variant}: failed proof settles to idle`);
      assert.equal(nativeResult.state.lastOutcome.status, 'failed');
      assert.equal(nativeResult.state.lastOutcome.reason, 'invalid-provider-route-proof');
      assert.equal('providerRouteProof' in nativeResult.state, false);
      assert.equal(native.store.start('s1', 't1').code, 'stale_turn');
      assert.equal(legacy.store.start('s1', 't1').code, 'stale_turn');
    }
    const nativeSnapshot = native.store.snapshot('s1');
    const legacySnapshot = legacy.store.snapshot('s1');
    assert.deepStrictEqual(nativeSnapshot, legacySnapshot, `${variant}: snapshot drift`);
    assert.deepStrictEqual(Object.keys(nativeSnapshot), Object.keys(legacySnapshot));
  }
});

test('the clock callback can re-enter reads without corrupting or deadlocking the owner', () => {
  function build(lane) {
    const observed = [];
    let store = null;
    const now = () => {
      // Re-enter a read-only path mid-transition. The pending mutation must not
      // be visible yet and the owner must not panic on a nested borrow.
      observed.push(store.snapshot('s1').phase);
      return 4242;
    };
    if (lane === 'native') {
      const owner = createStateOwner();
      const sessions = createChatSessions(owner);
      store = createNativeRuntime({ owner, now });
      return { store, sessions, observed };
    }
    const sessions = createLegacyChatSessions();
    store = createLegacyRuntime({ now });
    return { store, sessions, observed };
  }

  const lanes = ['native', 'legacy'].map(build);
  for (const harness of lanes) {
    harness.sessions.set('s1', createLegacyChatSession());
    assert.equal(harness.store.claim('s1', 't1').state.claimedAt, 4242);
    harness.store.markMessageDurable('s1', 't1');
    const proof = routeFor('s1', 't1', 'valid');
    harness.store.markProviderRouteResolved('s1', 't1', { resolved: true, proof });
    assert.equal(harness.store.start('s1', 't1').state.startedAt, 4242);
    assert.equal(harness.store.beginCleanup('s1', 't1', { status: 'completed' })
      .state.finishingAt, 4242);
    assert.equal(harness.store.cleanup('s1', 't1').state.lastOutcome.at, 4242);
    assert.equal(harness.sessions.get('s1') !== undefined, true, 'the live table is untouched');
  }
  assert.deepStrictEqual(lanes[0].observed, lanes[1].observed,
    'both owners observe the same mid-transition phases');
  assert.deepStrictEqual(lanes[0].observed, ['idle', 'running', 'finishing', 'finishing']);
  assert.deepStrictEqual(lanes[0].store.snapshot('s1'), lanes[1].store.snapshot('s1'));
});

test('host values keep identity and survive drains, deletes and re-creation', () => {
  const native = nativeHarness();
  const legacy = legacyHarness();
  const cs = createLegacyChatSession({ cli: 'codex' });
  for (const sessions of [native.sessions, legacy.sessions]) {
    sessions.set('s1', cs);
    assert.equal(sessions.get('s1'), cs, 'stored object identity');
    sessions.delete('s1');
    assert.equal(sessions.get('s1'), undefined);
    sessions.set('s1', cs);
    assert.equal(sessions.get('s1'), cs, 'identity after delete and re-create');
  }
  const proof = routeFor('s1', 't1', 'valid');
  for (const store of [native.store, legacy.store]) {
    assert.equal(store.claim('s1', 't1', { cli: 'codex', transport: 'cli-process' }).ok, true);
    assert.equal(store.markMessageDurable('s1', 't1').ok, true);
    assert.equal(store.markProviderRouteResolved('s1', 't1', { resolved: true, proof }).ok, true);
    assert.equal(store.start('s1', 't1').ok, true);
  }
  // Churn unrelated sessions and turn entries so retired host slots are drained.
  for (let index = 0; index < 1500; index += 1) {
    const id = `churn-${index % 17}`;
    native.sessions.set(id, createLegacyChatSession());
    native.sessions.delete(id);
    native.store.claim(id, 'turn');
    native.store.settle(id, 'turn', { status: 'failed' });
  }
  assert.equal(native.sessions.get('s1'), cs);
  assert.equal(native.store.snapshot('s1').providerRouteProof, proof,
    'the frozen route proof is the same object after many drains');
  assert.equal(legacy.store.snapshot('s1').providerRouteProof, proof);
  // Property order is part of the serialized contract.
  assert.deepStrictEqual(Object.keys(native.store.snapshot('s1')),
    Object.keys(legacy.store.snapshot('s1')));
});

test('the runtime store outlives chat-session deletion and needs no chat entry to claim', () => {
  const native = nativeHarness();
  const legacy = legacyHarness();
  for (const harness of [native, legacy]) {
    assert.equal(harness.store.claim('s1', 't1', { cli: 'claude', transport: 'claude-stream' }).ok, true);
    assert.equal(harness.store.settle('s1', 't1', { status: 'failed', reason: 'busy' }).ok, true);
    harness.sessions.set('s1', createLegacyChatSession());
    harness.sessions.delete('s1');
    const snapshot = harness.store.snapshot('s1');
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.lastOutcome.reason, 'busy');
  }
  assert.deepStrictEqual(native.store.snapshot('s1'), legacy.store.snapshot('s1'));
  assert.deepStrictEqual(native.store.list(), legacy.store.list());
  assert.equal(native.sessions.size, 0);
  assert.equal(legacy.sessions.size, 0);
});

'use strict';

// P0-2 unit surface: the delivery-handoff probe distinguishes "user message
// already written to history" (persisted) from "a runner actually took over"
// (handedOff). The outbox recovery branch must not treat the former as the
// latter — that is the "message exists but is never executed" wedge.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createDeliveryProbeRegistry,
  shouldReexecutePersistedDelivery,
} = require('../src/chat/turn-engine');

test('lookup reports unknown before any turn, then the recorded handoff facts', () => {
  const registry = createDeliveryProbeRegistry({ now: () => 42 });
  assert.equal(registry.lookup('s1', 'cmid-1'), null);
  assert.equal(registry.lookup('s1', null), null);
  assert.equal(registry.lookup(null, 'cmid-1'), null);

  registry.record('s1', 'cmid-1', 'delivery-9', { handedOff: false, turnId: 'turn-1' });
  const before = registry.lookup('s1', 'cmid-1');
  assert.deepEqual(before, { known: true, handedOff: false, turnId: 'turn-1', at: 42 });
  // Both identities (clientMsgId and deliveryId) resolve to the same record.
  assert.deepEqual(registry.lookup('s1', 'delivery-9'), before);
  // Records are per-session.
  assert.equal(registry.lookup('s2', 'cmid-1'), null);

  registry.record('s1', 'cmid-1', 'delivery-9', { handedOff: true, turnId: 'turn-1' });
  assert.deepEqual(registry.lookup('s1', 'cmid-1'), {
    known: true, handedOff: true, turnId: 'turn-1', at: 42,
  });
});

test('the identity window is bounded and evicts oldest-first', () => {
  const registry = createDeliveryProbeRegistry({ maxIdentities: 3, now: () => 1 });
  registry.record('s1', 'a', null, { handedOff: false });
  registry.record('s1', 'b', null, { handedOff: false });
  registry.record('s1', 'c', null, { handedOff: false });
  registry.record('s1', 'd', null, { handedOff: false });
  assert.equal(registry.lookup('s1', 'a'), null, 'oldest identity evicted');
  assert.notEqual(registry.lookup('s1', 'b'), null);
  assert.notEqual(registry.lookup('s1', 'd'), null);
});

test('re-execution requires a duplicate persisted delivery AND a known pre-handoff failure', () => {
  const knownPreHandoff = { known: true, handedOff: false, turnId: 't', at: 1 };
  const knownHandedOff = { known: true, handedOff: true, turnId: 't', at: 1 };
  assert.equal(shouldReexecutePersistedDelivery(true, true, knownPreHandoff), true);
  // Not a duplicate, or duplicate never persisted → normal admission path.
  assert.equal(shouldReexecutePersistedDelivery(false, true, knownPreHandoff), false);
  assert.equal(shouldReexecutePersistedDelivery(true, false, knownPreHandoff), false);
  // Handed off or unknown (restart) → keep the idempotent skip.
  assert.equal(shouldReexecutePersistedDelivery(true, true, knownHandedOff), false);
  assert.equal(shouldReexecutePersistedDelivery(true, true, null), false);
  assert.equal(shouldReexecutePersistedDelivery(true, true, { known: false }), false);
});

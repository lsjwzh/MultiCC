'use strict';

// Persisted ≠ delivered. The delivery-handoff probe backs runnerDeliveryHandoff()
// in the turn engine: it distinguishes "the user message is already written to
// history" (persisted) from "a runner actually took over" (handedOff). Without
// it the outbox recovery branch reads persisted as delivered and the message is
// never executed — the "exists but never runs" wedge.
//
// Pure and stateless, so it lives outside the engine and is required directly.

// In-memory delivery-handoff facts. Semantics per lookup:
//   known && handedOff===false → safe to re-execute (we watched it fail
//     before handoff; re-running cannot duplicate side effects);
//   known && handedOff===true → idempotent skip as before;
//   unknown (no record, e.g. after a restart) → conservative crash-recovery
//     reading stands: persisted = delivered, because re-running a message
//     that may have executed risks duplicate side effects.
function createDeliveryProbeRegistry({ maxIdentities = 64, now = Date.now } = {}) {
  const bySession = new Map();
  function record(sessionName, clientMsgId, deliveryId, facts = {}) {
    if (!sessionName || (!clientMsgId && !deliveryId)) return;
    let byIdentity = bySession.get(sessionName);
    if (!byIdentity) {
      byIdentity = new Map();
      bySession.set(sessionName, byIdentity);
    }
    const entry = Object.freeze({
      handedOff: facts.handedOff === true,
      turnId: facts.turnId || null,
      at: Number(now()),
    });
    for (const identity of [clientMsgId, deliveryId]) {
      if (!identity) continue;
      byIdentity.delete(identity);
      byIdentity.set(identity, entry);
    }
    while (byIdentity.size > maxIdentities) {
      byIdentity.delete(byIdentity.keys().next().value);
    }
  }
  function lookup(sessionName, identity) {
    if (!sessionName || !identity) return null;
    const byIdentity = bySession.get(sessionName);
    const entry = byIdentity ? byIdentity.get(identity) : null;
    if (!entry) return null;
    return { known: true, handedOff: entry.handedOff, turnId: entry.turnId, at: entry.at };
  }
  return Object.freeze({ record, lookup });
}

// The outbox re-delivers a persisted message only when the live engine
// actually watched it fail BEFORE a runner took over (duplicate admission +
// known probe + handedOff===false). Everything else keeps the historical
// duplicate semantics.
function shouldReexecutePersistedDelivery(duplicateSeen, duplicatePersisted, probe) {
  return duplicateSeen === true && duplicatePersisted === true
    && !!probe && probe.known === true && probe.handedOff === false;
}

module.exports = { createDeliveryProbeRegistry, shouldReexecutePersistedDelivery };

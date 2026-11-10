'use strict';

// Delivery into a held turn — thin wiring.
//
// User's rule: background work is part of the turn. A resident Claude turn whose
// main result already arrived while its Agent / background Bash / Monitor is
// still running is therefore still the CURRENT turn, and the live process is
// sitting idle inside it. A message the human types now must run in that turn,
// not queue behind it as the next one.
//
// The decisions are Rust (`backgroundHoldMayInject`, `backgroundHoldUserTyped`):
// native/core/src/background_hold.rs owns the injectable predicate, the
// "human typed it" rule, the pending-injection registry (keyed by delivery
// identity AND message uuid) and the written-once memory. This file only
// translates host objects into facts and performs the two I/O steps: register
// the delivery with the live process, append the history row.
//
// Exactly-once shape: the identity is registered in Rust BEFORE the line is
// written. A refused duplicate is 'append_only' — the retry re-appends the
// missing row and never writes stdin again. A failed write aborts the
// registration so the retry may write.

const { mayInjectIntoHeldTurn, isDirectUserTyped, spawnContract } = require('./background-hold');

// Facts that decide WHICH process serves a turn. The same projection is taken
// when the process is spawned (turn-engine passes the digest to chatStream) and
// when a message would be injected, so a persisted change staged while the turn
// is running (pendingConfiguration) or applied outright (provider, accounts,
// model) makes the digests differ — and the message waits for the next turn.
// Nothing here is host state: it is the persisted session record, verbatim.
function spawnContractFacts(record) {
  if (!record) return null;
  return {
    cli: record.cli ?? null,
    provider: record.provider ?? null,
    providerSelection: record.providerSelection ?? null,
    model: record.model ?? null,
    effort: record.effort ?? null,
    subagent: record.subagent ?? null,
    cliAccounts: record.cliAccounts ?? null,
    pendingConfiguration: record.pendingConfiguration ?? null,
    nativeSessionId: record.cliSessionId ?? record._streamSessionId ?? null,
  };
}

function spawnContractOf(record) {
  const facts = spawnContractFacts(record);
  return facts ? spawnContract(facts) : null;
}

function createHeldTurnInjection({
  getRecord,
  chatStream,
  isRunActive,
  appendMessage,
  activeTurnId,
  hasPersistedDelivery = async () => false,
  log = () => {},
} = {}) {
  function identityOf(item, opts) {
    return String(opts?.clientMsgId || item?.payload?.clientMsgId || item?.id);
  }

  // The Rust predicate over the host's facts. `deliverySettled` is the only
  // fact this file supplies rather than reads: the sync variant (used before an
  // outbox claim) can only consult the durable row.
  function decide({ item, sessionId, opts, deliverySettled }) {
    const record = getRecord?.(sessionId) || null;
    if (!record) return null;
    let live = null;
    try { live = chatStream?.heldTurn?.(sessionId) || null; } catch (_) { live = null; }
    if (!live) return null;
    return {
      identity: identityOf(item, opts),
      decision: mayInjectIntoHeldTurn({
        held: live.held === true,
        userTyped: isDirectUserTyped(item, opts),
        attributable: live.attributable === true,
        turnActive: isRunActive?.(sessionId) === true,
        processAlive: live.alive === true,
        processStale: live.stale === true,
        processContract: live.contract ?? null,
        wantedContract: spawnContractOf(record),
        deliverySettled,
      }),
    };
  }

  async function settled(sessionId, identity) {
    if (!identity) return false;
    try { return await hasPersistedDelivery(sessionId, identity) === true; } catch (_) { return true; }
  }

  // Sync gate for the delivery worker: may the outbox even claim this item while
  // the session is busy? Only a message the predicate would take makes the claim
  // worthwhile — anything else keeps waiting exactly as before.
  function canInject({ item, sessionId, opts } = {}) {
    if (!item || !sessionId) return false;
    const facts = decide({ item, sessionId, opts, deliverySettled: false });
    return facts?.decision?.inject === true;
  }

  function appendUserRow({ item, sessionId, text, opts }) {
    const turnId = activeTurnId?.(sessionId) || undefined;
    return typeof appendMessage === 'function' && appendMessage(sessionId, {
      role: 'user', content: text, ts: Date.now(),
      ...(turnId ? { turnId } : {}),
      ...(opts?.clientMsgId ? { clientMsgId: opts.clientMsgId } : {}),
      ...(opts?.deliveryId ? { deliveryId: opts.deliveryId } : {}),
      ...(opts?.originDispatchId ? { originDispatchId: opts.originDispatchId } : {}),
      heldTurnInjected: true,
    });
  }

  async function tryInject({ item, sessionId, text, opts } = {}) {
    if (!item || !sessionId || typeof text !== 'string' || !text) return null;
    const identity = identityOf(item, opts);
    const facts = decide({
      item, sessionId, opts, deliverySettled: await settled(sessionId, identity),
    });
    if (!facts) return null;
    if (!facts.decision.inject) return { delivered: false, reason: facts.decision.reason };
    let written = null;
    try { written = await chatStream.injectHeldTurn(sessionId, text, identity); } catch (_) { written = null; }
    if (!written || (written.delivered !== true && written.appendOnly !== true)) {
      return { delivered: false, reason: written?.reason || 'write_failed' };
    }
    const saved = appendUserRow({ item, sessionId, text, opts });
    if (!saved) {
      // The line is already in the live process; without its row the answer
      // would stream next to nothing. The hold still counts the outstanding
      // answer, so the turn cannot end underneath it; report failure so the
      // outbox retries — and the retry is told 'append_only', so it appends the
      // row without writing the message into the process a second time.
      log(`[held-turn] user row was not persisted for ${sessionId}`);
      return { delivered: false, reason: 'row_not_persisted' };
    }
    log(`[held-turn] delivered ${identity} into the held turn of ${sessionId}`);
    return { delivered: true, identity };
  }

  return { tryInject, canInject };
}

module.exports = { createHeldTurnInjection, spawnContractFacts, spawnContractOf, isDirectUserTyped };

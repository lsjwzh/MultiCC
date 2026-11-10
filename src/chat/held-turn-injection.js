'use strict';

// Delivery into a held turn — thin wiring.
//
// User's rule: background work is part of the turn. A resident Claude turn whose
// main result already arrived while its Agent / background Bash / Monitor is
// still running is therefore still the CURRENT turn, and the live process is
// sitting idle inside it. A message the human types now must run in that turn,
// not queue behind it as the next one.
//
// The decision is Rust (`backgroundHoldMayInject`, see
// native/core/src/background_hold.rs). This file only translates the host's
// objects into the predicate's facts, performs the write into the live process
// when the answer is yes, and keeps the exactly-once memory. It must never grow
// a rule of its own.
//
// Exactly-once shape: the message is written into the live process first (that
// is the delivery), then its user row is appended with `heldTurnInjected: true`.
// A row without that marker was written by the normal turn path and keeps its
// normal meaning; a remembered delivery identity (or a durable row with the same
// client id) makes a retried outbox entry settled instead of delivered twice.

const { mayInjectIntoHeldTurn, spawnContract } = require('./background-hold');

// Bounded: this only bridges the seconds between the write and the outbox ack.
const MAX_REMEMBERED = 1024;

// Facts that decide WHICH process serves a turn. The same projection is taken
// when the process is spawned (turn-engine passes the digest to chatStream) and
// when a message would be injected, so a route change staged while the turn is
// running (pendingConfiguration) or applied outright (cliAccounts, label edits
// aside) makes the digests differ — and the message waits for the next turn,
// which is the only way to keep "same spawn contract" true. Nothing here is
// host state: it is the persisted session record, verbatim.
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

// A human typed this in the chat input's own message box. Excluded on purpose:
// dispatch requests, triggers, machine continuations (originContinue), and
// task-page (task-shell) messages — the last is human-typed too, but its
// receipt lifecycle is owned by the turn engine, which an injected message
// never enters, so it keeps waiting instead of being written behind the
// engine's back.
function isDirectUserTyped(item, opts) {
  const payload = item?.payload;
  if (!payload || payload.type !== 'session.work') return false;
  if (payload.source !== 'direct') return false;
  if (opts?.originContinue === true) return false;
  if (opts?.originDispatchId || payload.originDispatchId) return false;
  if (payload.requestId || opts?.userInputRequestId) return false;
  return true;
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
  const injected = new Set();

  // Bounded drop-oldest so a long-lived server cannot grow it without limit;
  // the durable row (same client id) stays the second guard after a clear.
  function remember(identity) {
    if (injected.size >= MAX_REMEMBERED) injected.delete(injected.values().next().value);
    injected.add(identity);
  }

  async function settled(sessionId, identity) {
    if (!identity) return false;
    if (injected.has(identity)) return true;
    try { return await hasPersistedDelivery(sessionId, identity) === true; } catch (_) { return true; }
  }

  // The Rust predicate over the host's facts. `deliverySettled` is the only
  // fact this file supplies rather than reads: the sync variant (used before an
  // outbox claim) can only consult the in-memory memory, the async one also the
  // durable row.
  function decide({ item, sessionId, opts, deliverySettled }) {
    const record = getRecord?.(sessionId) || null;
    if (!record) return null;
    let live = null;
    try { live = chatStream?.heldTurn?.(sessionId) || null; } catch (_) { live = null; }
    if (!live) return null;
    return {
      identity: String(opts?.clientMsgId || item?.payload?.clientMsgId || item?.id),
      decision: mayInjectIntoHeldTurn({
        held: live.held === true,
        injectionInFlight: live.injectionInFlight === true,
        userTyped: isDirectUserTyped(item, opts),
        turnActive: isRunActive?.(sessionId) === true,
        processAlive: live.alive === true,
        processContract: live.contract ?? null,
        wantedContract: spawnContractOf(record),
        deliverySettled,
      }),
    };
  }

  // Sync gate for the delivery worker: may the outbox even claim this item while
  // the session is busy? Only a message the predicate would take makes the claim
  // worthwhile — anything else keeps waiting exactly as before.
  function canInject({ item, sessionId, opts } = {}) {
    if (!item || !sessionId) return false;
    const identity = String(opts?.clientMsgId || item.payload?.clientMsgId || item.id);
    const facts = decide({ item, sessionId, opts, deliverySettled: injected.has(identity) });
    return facts?.decision?.inject === true;
  }

  async function tryInject({ item, sessionId, text, opts } = {}) {
    if (!item || !sessionId || typeof text !== 'string' || !text) return null;
    const identity = String(opts?.clientMsgId || item.payload?.clientMsgId || item.id);
    const facts = decide({
      item, sessionId, opts, deliverySettled: await settled(sessionId, identity),
    });
    if (!facts) return null;
    if (!facts.decision.inject) return { delivered: false, reason: facts.decision.reason };
    let written = false;
    try { written = await chatStream.injectHeldTurn(sessionId, text) === true; } catch (_) { written = false; }
    if (!written) return { delivered: false, reason: 'write_failed' };
    const turnId = activeTurnId?.(sessionId) || undefined;
    const saved = typeof appendMessage === 'function' && appendMessage(sessionId, {
      role: 'user', content: text, ts: Date.now(),
      ...(turnId ? { turnId } : {}),
      ...(opts?.clientMsgId ? { clientMsgId: opts.clientMsgId } : {}),
      ...(opts?.deliveryId ? { deliveryId: opts.deliveryId } : {}),
      ...(opts?.originDispatchId ? { originDispatchId: opts.originDispatchId } : {}),
      heldTurnInjected: true,
    });
    if (!saved) {
      // The line is already in the live process; without its row the answer
      // would stream next to nothing. The hold still counts the outstanding
      // answer, so the turn cannot end underneath it; report failure so the
      // outbox retries (the identity is not remembered, so the retry is the
      // one that appends the row).
      log(`[held-turn] user row was not persisted for ${sessionId}`);
      return { delivered: false, reason: 'row_not_persisted' };
    }
    remember(identity);
    log(`[held-turn] delivered ${identity} into the held turn of ${sessionId}`);
    return { delivered: true, identity };
  }

  return { tryInject, canInject };
}

module.exports = { createHeldTurnInjection, spawnContractFacts, spawnContractOf, isDirectUserTyped };

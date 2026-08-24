'use strict';

function clone(record) {
  if (!record) return null;
  return {
    ...record,
    lastOutcome: record.lastOutcome ? { ...record.lastOutcome } : null,
    pendingOutcome: record.pendingOutcome ? { ...record.pendingOutcome } : undefined,
  };
}

function freezeRecord(record) {
  const copy = clone(record);
  if (copy.lastOutcome) Object.freeze(copy.lastOutcome);
  if (copy.pendingOutcome) Object.freeze(copy.pendingOutcome);
  return Object.freeze(copy);
}

function ownsConcreteRouteProof(proof, sessionId, turnId) {
  const route = proof && proof.route;
  return !!(proof && proof.kind === 'provider-route'
    && proof.resolved === true && Object.isFrozen(proof) && Object.isFrozen(route)
    && proof.sessionId === sessionId && proof.turnId === turnId
    && route.runtimeEpoch && route.decisionId && route.routeAttemptId
    && route.providerId && route.protocol && route.model && route.providerRevision
    && Number.isSafeInteger(route.routeGeneration) && route.routeGeneration > 0
    && Number.isSafeInteger(route.attemptNo) && route.attemptNo > 0);
}

function createTurnRuntimeStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sessions = new Map();

  function current(sessionId) {
    return sessions.get(sessionId) || {
      sessionId,
      phase: 'idle',
      turnId: null,
      generation: 0,
      lastOutcome: null,
    };
  }

  function result(ok, record, code) {
    return Object.freeze({ ok, ...(code ? { code } : {}), state: freezeRecord(record) });
  }

  function match(sessionId, turnId, phases) {
    const record = current(sessionId);
    if (!record.turnId || record.turnId !== turnId) return { ok: false, code: 'stale_turn', record };
    if (!phases.includes(record.phase)) return { ok: false, code: 'invalid_transition', record };
    return { ok: true, record };
  }

  function claim(sessionId, turnId, meta = {}) {
    sessionId = String(sessionId || '').trim();
    turnId = String(turnId || '').trim();
    if (!sessionId || !turnId) return result(false, current(sessionId), 'invalid_identity');
    const previous = current(sessionId);
    if (previous.phase !== 'idle') return result(false, previous, 'turn_in_flight');
    const record = {
      sessionId,
      turnId,
      phase: 'preparing',
      generation: previous.generation + 1,
      cli: String(meta.cli || 'claude'),
      transport: String(meta.transport || (meta.cli === 'claude' ? 'claude-stream' : 'cli-process')),
      messageDurable: false,
      providerRouteResolved: false,
      claimedAt: Number(now()),
      startedAt: null,
      finishingAt: null,
      lastOutcome: previous.lastOutcome,
    };
    sessions.set(sessionId, record);
    return result(true, record);
  }

  function markMessageDurable(sessionId, turnId) {
    const found = match(sessionId, turnId, ['preparing']);
    if (!found.ok) return result(false, found.record, found.code);
    found.record.messageDurable = true;
    return result(true, found.record);
  }

  function markProviderRouteResolved(sessionId, turnId, route = {}) {
    const found = match(sessionId, turnId, ['preparing']);
    if (!found.ok) return result(false, found.record, found.code);
    if (route.resolved !== true) return providerRouteFailed(sessionId, turnId, route.reason || 'route-failed');
    if (!ownsConcreteRouteProof(route.proof, sessionId, turnId)) {
      return providerRouteFailed(sessionId, turnId, 'invalid-provider-route-proof');
    }
    found.record.providerRouteResolved = true;
    found.record.providerRouteProof = route.proof;
    return result(true, found.record);
  }

  function abortPreparation(sessionId, turnId, reason = 'preparation-failed') {
    return settle(sessionId, turnId, { status: 'failed', reason }, ['preparing']);
  }

  // The production host only owns the short preparation lease. Once the
  // existing Claude/Codex runner accepts a spawn, its established lifecycle
  // remains authoritative and this store returns to idle. The same primitive
  // also releases either a preparing or just-authorized claim on every failure.
  function settle(sessionId, turnId, outcome = {}, allowedPhases = ['preparing', 'running']) {
    const found = match(sessionId, turnId, allowedPhases);
    if (!found.ok) return result(false, found.record, found.code);
    const idle = {
      sessionId,
      phase: 'idle',
      turnId: null,
      generation: found.record.generation,
      lastOutcome: {
        turnId,
        status: String(outcome.status || 'completed'),
        reason: outcome.reason == null ? null : String(outcome.reason),
        at: Number(now()),
      },
    };
    sessions.set(sessionId, idle);
    return result(true, idle);
  }

  function providerRouteFailed(sessionId, turnId, reason = 'route-failed') {
    return abortPreparation(sessionId, turnId, reason);
  }

  function start(sessionId, turnId) {
    const found = match(sessionId, turnId, ['preparing']);
    if (!found.ok) return result(false, found.record, found.code);
    const missing = [];
    if (!found.record.messageDurable) missing.push('durable-user-message');
    if (!found.record.providerRouteResolved) missing.push('provider-route');
    if (missing.length) {
      return Object.freeze({ ok: false, code: 'spawn_proof_missing', missing: Object.freeze(missing), state: freezeRecord(found.record) });
    }
    found.record.phase = 'running';
    found.record.startedAt = Number(now());
    return result(true, found.record);
  }

  function beginCleanup(sessionId, turnId, outcome = {}) {
    const found = match(sessionId, turnId, ['running']);
    if (!found.ok) return result(false, found.record, found.code);
    found.record.phase = 'finishing';
    found.record.finishingAt = Number(now());
    found.record.pendingOutcome = {
      status: String(outcome.status || 'completed'),
      reason: outcome.reason == null ? null : String(outcome.reason),
    };
    return result(true, found.record);
  }

  function cleanup(sessionId, turnId) {
    const found = match(sessionId, turnId, ['finishing']);
    if (!found.ok) return result(false, found.record, found.code);
    const idle = {
      sessionId,
      phase: 'idle',
      turnId: null,
      generation: found.record.generation,
      lastOutcome: {
        turnId,
        status: found.record.pendingOutcome.status,
        reason: found.record.pendingOutcome.reason,
        at: Number(now()),
      },
    };
    sessions.set(sessionId, idle);
    return result(true, idle);
  }

  function claimProof(sessionId, turnId) {
    const record = current(sessionId);
    return Object.freeze({
      kind: 'runtime-claim',
      sessionId,
      turnId,
      claimed: record.turnId === turnId && record.phase !== 'idle',
    });
  }

  function snapshot(sessionId) { return freezeRecord(current(sessionId)); }
  function list() { return Object.freeze([...sessions.values()].map(freezeRecord)); }

  return Object.freeze({
    claim,
    markMessageDurable,
    markProviderRouteResolved,
    providerRouteFailed,
    abortPreparation,
    settle,
    start,
    beginCleanup,
    cleanup,
    claimProof,
    snapshot,
    list,
  });
}

module.exports = { createTurnRuntimeStore };

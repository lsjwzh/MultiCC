'use strict';

function clean(value) { return value == null ? '' : String(value).trim(); }
function receiptSet(receipts) { return new Set(Array.isArray(receipts) ? receipts.map(String) : []); }

function deliveryEffect(type, effectId, fields) {
  return Object.freeze({
    type,
    effectId,
    requiresDeliveryProof: true,
    ...fields,
  });
}

// Returns effect descriptions only. No bus emit, persistence or
// network work occurs here. Stable effectIds make the caller's durable receipt
// ledger the exactly-once authority.
function routePostTurn(input = {}) {
  const turnId = clean(input.turnId);
  const sessionId = clean(input.sessionId);
  const finalText = String(input.finalText || '');
  const receipts = receiptSet(input.receipts);
  const handoff = input.handoff && typeof input.handoff === 'object' ? input.handoff : null;

  if (input.handoffResumeFailure === true) {
    return Object.freeze({ route: 'handoff-failed', effects: Object.freeze([]), reason: 'fail-closed' });
  }

  const effects = [];
  if (handoff && handoff.status === 'pending' && handoff.completed === true) {
    const handoffId = clean(handoff.id);
    const effectId = `handoff:${handoffId}`;
    if (handoffId && !receipts.has(effectId)) {
      effects.push(deliveryEffect('ack-handoff', effectId, {
        handoffId,
        sessionId,
        requiresResultProof: true,
      }));
    }
  }

  const originDispatchId = clean(input.originDispatchId);
  if (originDispatchId) {
    const effectId = `dispatch-return:${originDispatchId}`;
    if (!receipts.has(effectId)) {
      effects.push(deliveryEffect('complete-dispatch', effectId, {
        operationId: originDispatchId,
        sessionId,
        finalText,
      }));
    }
    // Origin dispatch always owns completion bookkeeping. The dispatch host
    // decides whether final output closes a sync/one-way operation or whether
    // an async worker omitted its required dispatch_slave receipt.
    return Object.freeze({ route: 'dispatch-return', effects: Object.freeze(effects) });
  }

  if (input.sessionType === 'gateway') {
    const effectId = `gateway-turn:${turnId}`;
    if (turnId && !receipts.has(effectId)) {
      // requestId travels with the effect so the gateway host can address its
      // terminal outcome frame back at the exact request (the voice bridge's
      // clientMsgId). The effectId stays keyed on turnId alone: correlation is
      // additive, exactly-once is not.
      effects.push(deliveryEffect('gateway-turn-complete', effectId, {
        sessionId, turnId, finalText, requestId: clean(input.requestId),
      }));
    }
    return Object.freeze({ route: 'gateway', effects: Object.freeze(effects) });
  }
  if (input.sessionType === 'aux') {
    return Object.freeze({ route: 'aux', effects: Object.freeze(effects) });
  }
  if (input.sessionType === 'commander') {
    // Cross-session routing is MCP-only. Assistant text is never parsed as an
    // executable dispatch instruction.
    return Object.freeze({ route: 'commander', effects: Object.freeze(effects) });
  }

  return Object.freeze({ route: 'normal', effects: Object.freeze(effects) });
}

function createDeliveryProof(input = {}) {
  return Object.freeze({
    kind: 'delivery-proof',
    effectId: clean(input.effectId),
    deliveryId: clean(input.deliveryId),
    durable: input.durable === true,
    delivered: input.delivered === true,
  });
}

function acknowledgeDeliveredEffect(effect, proof) {
  if (!effect || effect.requiresDeliveryProof !== true) {
    return Object.freeze({ ok: false, code: 'effect_not_delivery_bound' });
  }
  if (!proof || proof.kind !== 'delivery-proof' || proof.effectId !== effect.effectId
      || !proof.deliveryId || proof.durable !== true || proof.delivered !== true) {
    return Object.freeze({ ok: false, code: 'delivery_proof_required' });
  }
  return Object.freeze({
    ok: true,
    receipt: Object.freeze({
      type: 'ack-delivery',
      effectId: effect.effectId,
      deliveryId: proof.deliveryId,
    }),
  });
}

module.exports = { routePostTurn, createDeliveryProof, acknowledgeDeliveredEffect };

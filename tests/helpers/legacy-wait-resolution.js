'use strict';
// Frozen pre-migration oracle for behavior parity tests, never imported by production.
const crypto = require('node:crypto');
const { admitOutboxItem, hashPayload, normalizeJson, timingSafeHashEqual } = require('../../src/outbox');
function legacyWaitResolver(store, now, cryptoImpl = crypto) {
  async function resolveInternal(id, payload, {
    callbackToken,
    expectedMode,
    deliveryText,
    sessionWork = null,
  } = {}) {
    if (!id || typeof id !== 'string') {
      throw new TypeError('[wait-service] resolve requires wait id');
    }
    return store.mutate(draft => {
      const wait = draft.waits[id];
      if (!wait) return { ok: false, code: 'not_found' };
      if (expectedMode && wait.mode !== expectedMode) {
        return { ok: false, code: 'mode_mismatch' };
      }
      if (wait.mode === 'callback'
          && !timingSafeHashEqual(wait.callbackTokenHash, callbackToken, cryptoImpl)) {
        return { ok: false, code: 'invalid_token' };
      }
      // Authenticate callback capabilities before normalizing or hashing an
      // attacker-controlled payload.  The mutation remains serialized and the
      // token comparison still always uses equal-length buffers.
      const normalizedPayload = normalizeJson(payload);
      const payloadHash = hashPayload(normalizedPayload, cryptoImpl);
      if (wait.status === 'resolved') {
        if (wait.resolutionPayloadHash === payloadHash) {
          return {
            ok: true,
            idempotent: true,
            waitId: wait.id,
            outboxId: wait.outboxId,
          };
        }
        return {
          ok: false,
          code: 'payload_conflict',
          statusCode: 409,
          waitId: wait.id,
          outboxId: wait.outboxId,
        };
      }
      if (wait.status !== 'pending') {
        return { ok: false, code: 'not_pending', status: wait.status };
      }

      const at = Number(now());
      const outboxId = `wait:${wait.id}`;
      const sessionWorkText = typeof sessionWork?.text === 'string'
        ? sessionWork.text.trim() : '';
      const outboxPayload = sessionWorkText
        ? {
          type: 'session.work',
          // A timer represents user-authored future work, not an internal
          // callback/continuation. Keeping it as task work makes an active P
          // turn stage it in the ordinary FIFO instead of crossing that turn.
          workKind: 'task',
          message: sessionWorkText,
          options: {
            originContinue: false,
            clientMsgId: outboxId,
            scheduledMessageId: wait.id,
            receivedAt: at,
          },
          source: 'scheduled',
          taskId: null,
          requestId: null,
          activeEntryId: null,
        }
        : {
          type: 'wait.resolved',
          waitId: wait.id,
          mode: wait.mode,
          injectPrefix: wait.injectPrefix,
          data: normalizedPayload,
          deliveryText: typeof deliveryText === 'string' ? deliveryText : null,
          ...(wait.metadata?.taskId ? { taskId: wait.metadata.taskId } : {}),
          ...(wait.metadata?.originDispatchId
            ? { originDispatchId: wait.metadata.originDispatchId }
            : {}),
        };
      const admitted = admitOutboxItem(draft, {
        id: outboxId,
        sessionId: wait.sessionId,
        payload: outboxPayload,
        source: { type: 'wait', waitId: wait.id },
        now: at,
      });
      // A scheduled user message behaves like a normal direct submission once
      // its clock expires: W/B/E at-rest verdicts must not strand it. While a P
      // turn is active, task work remains in the ordinary FIFO.
      if (sessionWorkText && draft.outbox[admitted.item.id]) {
        draft.outbox[admitted.item.id].directRun = true;
      }

      wait.status = 'resolved';
      wait.resolvedAt = at;
      wait.updatedAt = at;
      wait.resolutionPayloadHash = payloadHash;
      wait.outboxId = admitted.item.id;

      return {
        ok: true,
        idempotent: admitted.idempotent,
        waitId: wait.id,
        outboxId: admitted.item.id,
      };
    });
  }

  return { resolveInternal };
}
module.exports = { legacyWaitResolver };

'use strict';

// Frozen Node oracle for differential admission tests; never used by production.
const { admitOutboxItem, hashPayload, hashSecret, normalizeJson } = require('../../src/outbox');

function createLegacyOperationAdmission({ now, cryptoImpl, OperationConflictError, publicOperation }) {
  function findIdempotent(draft, { kind, ownerSessionId, idempotencyKeyHash }) {
    if (!idempotencyKeyHash) return null;
    const where = { kind, ownerSessionId, idempotencyKeyHash };
    const rows = typeof draft.select === 'function'
      ? draft.select('operations', { where }) : Object.values(draft.operations);
    return rows.find(operation => operation.kind === kind
      && operation.ownerSessionId === ownerSessionId
      && operation.idempotencyKeyHash === idempotencyKeyHash) || null;
  }
  function admitBase(draft, { id, kind, ownerSessionId, resultSessionId, idempotencyKey, spec, externalId = null }) {
    const normalizedSpec = normalizeJson(spec);
    const requestHash = hashPayload(normalizedSpec, cryptoImpl);
    const idempotencyKeyHash = idempotencyKey ? hashSecret(idempotencyKey, cryptoImpl) : null;
    const existing = findIdempotent(draft, { kind, ownerSessionId, idempotencyKeyHash });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new OperationConflictError(`${kind} idempotency key was already used with different content`, existing.id);
      }
      return { operation: existing, idempotent: true };
    }
    if (draft.operations[id]) throw new OperationConflictError(`operation ${id} already exists`, id);
    const at = Number(now());
    const operation = { id, kind, ownerSessionId, resultSessionId: resultSessionId || ownerSessionId,
      status: 'admitted', idempotencyKeyHash, requestHash, resultHash: null, spec: normalizedSpec,
      externalId, requestOutboxId: null, resultOutboxId: null, createdAt: at, updatedAt: at,
      startedAt: null, completedAt: null, cancelledAt: null, lastError: null };
    draft.operations[id] = operation;
    return { operation, idempotent: false };
  }
  function detached(draft, { operationId, sessionId, idempotencyKey, spec }) {
    const externalId = `d_${operationId.replace(/^op_/, '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
    const admitted = admitBase(draft, { id: operationId, kind: 'detached', ownerSessionId: sessionId,
      resultSessionId: sessionId, idempotencyKey, spec, externalId });
    return { ...publicOperation(admitted.operation), idempotent: admitted.idempotent };
  }
  function dispatch(draft, { operationId, ownerSessionId, resultSessionId, idempotencyKey, spec }) {
    const admitted = admitBase(draft, { id: operationId, kind: 'dispatch', ownerSessionId,
      resultSessionId: resultSessionId || ownerSessionId, idempotencyKey, spec });
    const operation = admitted.operation;
    if (!operation.requestOutboxId) {
      const outboxId = `operation:${operation.id}:request`;
      const outbox = admitOutboxItem(draft, {
        id: outboxId,
        sessionId: operation.spec.chatId,
        payload: {
          type: 'dispatch.request', operationId: operation.id, targetId: operation.spec.targetId,
          message: operation.spec.message, taskId: operation.spec.taskId || null,
          taskStart: operation.spec.taskStart === true, taskSource: operation.spec.taskSource || null,
          taskText: operation.spec.taskText || null,
          ...(operation.spec.taskShellReceiptId ? { taskShellReceiptId: operation.spec.taskShellReceiptId,
            clientMsgId: operation.spec.clientMsgId, receivedAt: operation.spec.receivedAt } : {}),
        },
        source: { type: 'operation', kind: 'dispatch', operationId: operation.id }, now: Number(now()),
      });
      operation.requestOutboxId = outbox.item.id;
      operation.updatedAt = Number(now());
    }
    return { ...publicOperation(operation), idempotent: admitted.idempotent };
  }
  return { detached, dispatch };
}
module.exports = { createLegacyOperationAdmission };

'use strict';

// ── Message admission progress ───────────────────────────────────────────────
//
// A user message can only start a turn once the work that must precede it has
// finished. Today that is the pending memory distill (the turn has to see the
// distilled memory) and, when a pool routes by difficulty, the Jev tier verdict.
// Both take an unbounded-ish amount of time, and the user has already seen their
// bubble: the client renders `message_admission_progress` frames so the wait is
// visible instead of looking like a dropped message.
//
// This module owns that protocol end to end — the frames, their failure
// vocabulary and the delivery call they wrap — so the WebSocket handler only has
// to pass the pending work in and await one call.

const { sanitizeMessage: sanitizeApiErrorMessage } = require('./api-error-policy');

function admissionRootCause(value) {
  const raw = value instanceof Error
    ? value.message
    : typeof value === 'string' ? value : '';
  return raw.trim() ? sanitizeApiErrorMessage(raw) : null;
}

async function deliverAfterPendingMemory(pendingMemory, emitProgress, deliver) {
  if (!pendingMemory) return deliver();
  const emit = progress => {
    try { emitProgress?.(progress); } catch (_) {}
  };
  emit({ state: 'waiting', reason: 'memory_distill_pending' });
  let memoryResult;
  try {
    memoryResult = await Promise.resolve(pendingMemory);
  } catch (error) {
    memoryResult = { error };
  }
  const reason = memoryResult?.error
    ? 'memory_distill_failed'
    : memoryResult?.skipped ? 'memory_distill_skipped' : null;
  const memoryRootCause = reason === 'memory_distill_failed'
    ? admissionRootCause(memoryResult.error)
    : null;
  emit({
    state: reason ? 'skipped' : 'ready',
    ...(reason ? { reason } : {}),
    ...(memoryRootCause ? { rootCause: memoryRootCause } : {}),
  });
  try {
    const delivered = await deliver();
    if (delivered?.ok === false) {
      const code = typeof delivered.code === 'string' && /^[a-z0-9_]{1,64}$/.test(delivered.code)
        ? delivered.code : null;
      const rootCause = admissionRootCause(delivered.error || delivered.message);
      emit({
        state: 'failed',
        reason: 'message_delivery_rejected',
        ...(code ? { code } : {}),
        ...(rootCause ? { rootCause } : {}),
      });
    }
    return delivered;
  } catch (error) {
    const rootCause = admissionRootCause(error);
    emit({
      state: 'failed',
      reason: 'message_delivery_failed',
      ...(rootCause ? { rootCause } : {}),
    });
    throw error;
  }
}

// Difficulty routing rides the same window. It is deliberately *not* folded into
// deliverAfterPendingMemory: that function is the memory protocol, and the
// routing wait must still happen for a message with no distill pending.
//
// Returns a promise only when the pool actually routes; the caller awaits the
// result unconditionally and a null return makes that a no-op. The verdict is
// awaited rather than raced against admission because the turn resolves its
// provider route synchronously once the message is admitted — a verdict that
// arrives late is a verdict that cannot be used.
function createRoutingAdmissionPhase({ prepareTurn, broadcast }) {
  if (typeof prepareTurn !== 'function') throw new TypeError('[admission] prepareTurn is required');
  return function prepareRoutingAdmission({ session, text, providers, sessionId, clientMsgId } = {}) {
    let pending;
    try { pending = prepareTurn({ session, text, providers }); }
    catch (_) { return null; }
    if (!pending) return null;
    try {
      broadcast?.(sessionId, {
        type: 'message_admission_progress',
        stage: 'auto_provider_routing',
        state: 'waiting',
        reason: 'auto_provider_routing_pending',
        message: text,
        clientMsgId: clientMsgId || null,
        at: Date.now(),
      });
    } catch (_) {}
    // Never rejects: this is awaited unconditionally on the message path.
    return Promise.resolve(pending).then(() => undefined, () => undefined);
  };
}

module.exports = {
  admissionRootCause,
  createRoutingAdmissionPhase,
  deliverAfterPendingMemory,
};

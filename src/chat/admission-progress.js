'use strict';

// ── Message admission progress ───────────────────────────────────────────────
//
// 用户消息可靠入队后，后台再等待记忆整理、模型路由等启动前置条件。
// 等待期间用 message_admission_progress 显示进度；HTTP/WS 接收回执
// 不依赖这些步骤完成。这里统一维护进度事件和失败后继续投递的规则。

const { sanitizeMessage: sanitizeApiErrorMessage } = require('../native/binding').apiErrorPolicy;

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

// 消息先落盘，再由队列等待模型路由和记忆整理。两种发送入口共用此处，
// 重启后重放同一条队列记录也会重新准备，不依赖请求期间的内存承诺。
function createQueuedTurnPreparation({ prepareRouting, getPendingMemory, broadcast }) {
  return async function prepareQueuedTurn({ sessionId, text, opts = {} }) {
    if (!opts.directUserInput || opts.taskShellControl) return;
    let pendingMemory;
    // 任务壳管理自己的上下文；普通聊天保留原来的记忆等待契约。
    if (!opts.taskShellReceiptId) {
      try { pendingMemory = getPendingMemory?.(sessionId); }
      catch (error) { pendingMemory = Promise.resolve({ error }); }
    }
    // 路由等待期间记忆任务也可能失败，先接住拒绝，稍后统一显示结果。
    if (pendingMemory) pendingMemory = Promise.resolve(pendingMemory).catch(error => ({ error }));
    try { await prepareRouting(sessionId, text, opts.clientMsgId); }
    catch (_) { /* 路由服务异常时沿用配置的兜底模型。 */ }
    if (pendingMemory) await deliverAfterPendingMemory(pendingMemory, progress => broadcast?.(sessionId, {
      type: 'message_admission_progress', stage: 'memory_distill', message: text,
      clientMsgId: opts.clientMsgId || null, at: Date.now(), ...progress,
    }), () => undefined);
  };
}

module.exports = {
  admissionRootCause,
  createRoutingAdmissionPhase,
  createQueuedTurnPreparation,
  deliverAfterPendingMemory,
};

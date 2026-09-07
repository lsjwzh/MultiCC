'use strict';

const MAX_HANDOFF_KEYS = 2_048;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function createAutoProviderHandoff(options = {}) {
  const inject = options.inject;
  if (typeof inject !== 'function') {
    throw new TypeError('[auto-provider-handoff] inject port is required');
  }
  const hasLiveBackgroundTasks = typeof options.hasLiveBackgroundTasks === 'function'
    ? options.hasLiveBackgroundTasks : null;
  const logger = options.logger || { info() {}, warn() {} };
  const scheduled = new Map();

  function remember(key, sessionId) {
    scheduled.set(key, sessionId);
    if (scheduled.size > MAX_HANDOFF_KEYS) scheduled.delete(scheduled.keys().next().value);
  }

  function schedule({ sessionId, turnId, preparation, lineage } = {}) {
    const cleanSessionId = clean(sessionId);
    const cleanTurnId = clean(turnId);
    if (!cleanSessionId || !cleanTurnId || !preparation?.providerId) {
      return Object.freeze({ scheduled: false, reason: 'handoff_not_prepared' });
    }
    if (hasLiveBackgroundTasks) {
      let active = true;
      try { active = hasLiveBackgroundTasks(cleanSessionId) === true; } catch (_) {}
      if (active) return Object.freeze({ scheduled: false, reason: 'background_tasks_active' });
    }
    const key = `auto-provider-handoff:${cleanTurnId}`;
    if (scheduled.has(key)) {
      return Object.freeze({ scheduled: false, reason: 'duplicate', idempotencyKey: key });
    }
    remember(key, cleanSessionId);
    const from = clean(preparation.fromProviderName) || '上一个 Provider';
    const to = clean(preparation.providerName) || clean(preparation.providerId);
    const text = `${from} 因上游限额或接口错误中断。请由 ${to} 基于已有对话和工具结果继续剩余任务；不要重复已经完成的操作。`;
    const metadata = {
      originContinue: true,
      clientMsgId: key,
      idempotencyKey: key,
      taskSource: 'auto_provider_handoff',
      ...(lineage?.kind === 'dispatch' && lineage.operationId
        ? { originDispatchId: lineage.operationId } : {}),
      ...(lineage?.kind === 'trigger' ? { originTrigger: true } : {}),
    };
    try {
      inject(cleanSessionId, text, 0, metadata);
      logger.info?.('auto_provider_handoff_scheduled', {
        sessionId: cleanSessionId,
        turnId: cleanTurnId,
        fromProviderId: preparation.fromProviderId || null,
        toProviderId: preparation.providerId,
      });
    } catch (error) {
      scheduled.delete(key);
      logger.warn?.('auto_provider_handoff_failed', {
        sessionId: cleanSessionId, turnId: cleanTurnId,
        code: clean(error?.code) || 'inject_failed',
      });
      return Object.freeze({ scheduled: false, reason: 'inject_failed' });
    }
    return Object.freeze({
      scheduled: true,
      reason: preparation.reasonCode || 'unsafe_replay_boundary',
      idempotencyKey: key,
      providerId: preparation.providerId,
    });
  }

  function clearSession(sessionId) {
    for (const [key, owner] of scheduled) {
      if (owner === sessionId) scheduled.delete(key);
    }
  }

  return Object.freeze({ schedule, clearSession });
}

module.exports = { createAutoProviderHandoff };

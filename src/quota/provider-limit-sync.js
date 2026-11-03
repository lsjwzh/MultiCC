'use strict';

const { providerLimitBar } = require('./quota-bar-view');
const { STALE_MS_DEFAULT } = require('./provider-limit-cache');

// 只投影展示字段；不把原始响应、错误详情或凭据放进跨会话事件。
function providerLimitSnapshot(entry, now = Date.now()) {
  if (!entry || entry.kind === 'availability') return null;
  const stale = entry.fetchedAt != null && now - entry.fetchedAt > STALE_MS_DEFAULT;
  const bar = providerLimitBar({ ...entry, stale }, now);
  if (!bar) return null;
  return {
    type: 'provider_limit_updated', ok: true,
    appType: entry.appType, providerId: entry.providerId, kind: entry.kind,
    fetchedAt: entry.fetchedAt, updatedAt: entry.updatedAt, stale, bar,
    dto: { kind: entry.kind === 'balance' ? 'balance' : 'window' },
  };
}

function connectProviderLimitSync({ cache, persistedSessions, providers, broadcast }) {
  return cache.subscribe(entry => {
    const snapshot = providerLimitSnapshot(entry);
    if (!snapshot) return;
    for (const [sessionId, record] of persistedSessions) {
      const types = providers.appTypesForCli?.(record.cli || 'claude')
        || [providers.appTypeForCli(record.cli || 'claude')];
      if (!types.includes(entry.appType)) continue;
      const matches = record.provider === entry.providerId
        || record.providerSelection?.candidates?.some(candidate => candidate.providerId === entry.providerId);
      if (!matches) continue;
      try { broadcast(sessionId, { ...snapshot, sessionId }); } catch (_) { /* 单个连接失败不阻断其他会话 */ }
    }
  });
}

module.exports = { providerLimitSnapshot, connectProviderLimitSync };

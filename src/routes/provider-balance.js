'use strict';

// 兼容宿主调用方的刷新接口。业务查询统一进入 Rust 前门，Node 不再注册余额
// 或借道 quota 公开路由，也不再保留另一套厂商请求/缓存回退/并发去重实现。
const { outboundFetch } = require('../network/outbound');
const { mountProviderBalanceHost } = require('./provider-balance-host');

function createProviderBalanceRuntime(options = {}) {
  const request = async path => {
    const port = typeof options.getPort === 'function' ? options.getPort() : null;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('provider balance gateway port unavailable');
    const response = await outboundFetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(60000) });
    return response.json();
  };
  const path = (appType, id) => `/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}/balance`;
  const refreshOne = (appType, id) => request(path(appType, id)).catch(() => null);
  return Object.freeze({
    queryOne: refreshOne, refreshOne,
    queryAll: () => request('/api/providers/balances'),
    readCached: (appType, id) => request(`${path(appType, id)}?cached=1`),
  });
}

function mountProviderBalanceRoutes(app, options = {}) {
  mountProviderBalanceHost(app, options);
  return options.runtime || createProviderBalanceRuntime(options);
}

function mountProviderRelayQuotaRoutes(app, options = {}) {
  // 宿主端口由两处旧挂载点共同装配：早期提供 provider store，额度缓存就绪后
  // 补 lookupCached/recorder。Rust 借道路径独立禁用 stale 回退。
  mountProviderBalanceHost(app, options);
  return options.runtime || createProviderBalanceRuntime(options);
}

module.exports = { createProviderBalanceRuntime, mountProviderBalanceRoutes, mountProviderRelayQuotaRoutes };

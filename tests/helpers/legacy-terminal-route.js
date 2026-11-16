'use strict';

const crypto = require('node:crypto');

// 终端会话的托管 provider 路由能力。
//
// 终端**不是回合**：tmux 里的 CLI 是长活进程，它那条托管路由必须跨回合、跨服务重启
// 都成立（CODEX_HOME/config.toml 与 ANTHROPIC_BASE_URL 是进程启动时读一次就定死的）。
// 所以能力不放内存里的 attempt，而存在**会话记录**上（`proxyRouteToken`）：记录在，
// 路由就有效；会话删掉，路由立即失效 —— 不需要任何生命周期钩子、也不需要启动时重建。
//
// 写进路由的 session 段是编码过的 `pr1.<b64 id>.<b64 token>`，与 chat 轮次那条同一
// 形状：proxy guard 只认这个形状（src/providers/proxy-guard.js 的
// `classifyProviderProxyRoute` + provider-attempt-runtime 的 `authorizeProxyRequest`）。
// 这条修的就是「终端拿到的是明文 id，于是每个请求都 409
// proxy_route_capability_mismatch」。

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function createTerminalProxyRoutes({ persistedSessions, persist, encode, mint } = {}) {
  if (!persistedSessions || typeof persistedSessions.get !== 'function') {
    throw new TypeError('[terminal-route] a session store is required');
  }
  if (typeof encode !== 'function') {
    throw new TypeError('[terminal-route] a route encoder is required');
  }
  const newToken = typeof mint === 'function'
    ? mint
    : () => crypto.randomBytes(18).toString('base64url');

  // 只有绑了托管 provider 的终端才写代理路由（没 provider 的终端走原生登录直连，
  // 根本不经过代理），所以那种会话原样返回 id。
  function sessionSegment(session) {
    const id = clean(session && session.id);
    if (!id || !clean(session && session.provider)) return id;
    let token = clean(session.proxyRouteToken);
    if (!token) {
      token = newToken();
      session.proxyRouteToken = token;
      // 令牌要和会话记录一起活过重启 —— 它已经被写进那个进程的配置里了。
      if (typeof persist === 'function') persist('runtime.terminal-route-token');
    }
    return encode(id, token);
  }

  // guard 侧的反查：只认「终端 + 有 provider + 有令牌」的记录。可用的 provider 就是
  // 这条会话自己声明的那两个（主 + 子线路），与 chat 轮次的 allowedSubProviderIds
  // 同一个口径。
  function lookup(sessionId) {
    const record = persistedSessions.get(clean(sessionId));
    if (!record || record.kind !== 'terminal') return null;
    const providerId = clean(record.provider);
    const token = clean(record.proxyRouteToken);
    if (!providerId || !token) return null;
    const subId = clean(record.subagent && record.subagent.providerId);
    return Object.freeze({
      token,
      providerId,
      allowedSubProviderIds: Object.freeze(subId && subId !== providerId
        ? [providerId, subId] : [providerId]),
    });
  }

  return Object.freeze({ sessionSegment, lookup });
}

module.exports = { createTerminalProxyRoutes };

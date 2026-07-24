'use strict';

// Proxy→chat-session broadcasters for cli-provider-router sidecar callbacks.
//
// Both the claude (Anthropic content_block_delta) and codex (item delta) proxies
// forward per-turn deltas here for incremental rendering; the claude proxy
// additionally forwards the subscription 5h rate-limit DTO that it reads from
// the anthropic-ratelimit-unified-5h-* response headers on official-OAuth turns.
//
// Each callback is best-effort: a broadcast failure must never break the proxy
// stream (same contract as onUsage/onActivity), so every path is try/catch'd.
function createProxyBroadcasters(chatBroadcast) {
  const onDelta = (delta, ctx) => {
    try {
      if (!delta || !ctx || !ctx.sessionId) return;
      chatBroadcast(ctx.sessionId, { type: 'part_delta', sessionId: ctx.sessionId, role: ctx.role, model: ctx.model || null, delta });
    } catch (_) {}
  };
  const onRateLimit = (info) => {
    try {
      if (info && info.sessionId && info.rateLimitInfo) {
        chatBroadcast(info.sessionId, { type: 'rate_limit_event', sessionId: info.sessionId, rate_limit_info: info.rateLimitInfo });
      }
    } catch (_) {}
  };
  return { onDelta, onRateLimit };
}

module.exports = { createProxyBroadcasters };

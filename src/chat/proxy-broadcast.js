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

const {
  normalizeWindowEvent, windowEventBar, labelRoutedProvider,
} = require('../quota/quota-bar-view');
const { rememberClaudeLive, renderClaudeBar } = require('../quota/claude-bar-state');

// `resolveCli(sessionName)` → the session's CLI, used only to decide whether
// this window belongs to the CLI itself or to a provider routed underneath it
// (OpenCode Go meters its own subscription separately from whatever it routes
// to, and two unlabeled `5h N%` values read as one contradictory meter).
function createProxyBroadcasters(chatBroadcast, { resolveCli } = {}) {
  const cliOf = (name) => {
    try { return typeof resolveCli === 'function' ? resolveCli(name) : null; } catch (_) { return null; }
  };
  const onDelta = (delta, ctx) => {
    try {
      if (!delta || !ctx || !ctx.sessionId) return;
      chatBroadcast(ctx.sessionId, { type: 'part_delta', sessionId: ctx.sessionId, role: ctx.role, model: ctx.model || null, delta });
    } catch (_) {}
  };
  const onRateLimit = (info) => {
    try {
      if (!info || !info.sessionId || !info.rateLimitInfo) return;
      // The event carries the rendered bar alongside the raw DTO. Claude's 5h
      // is only half its bar — the weekly windows come from the usage-page
      // scrape — so the merge happens here, server-side, and both clients paint
      // the result rather than each recombining the two sources.
      const normalized = normalizeWindowEvent(info.rateLimitInfo, Date.now());
      let bar = null;
      if (normalized && normalized.provider === 'claude') {
        rememberClaudeLive(info.sessionId, normalized);
        bar = renderClaudeBar(info.sessionId);
      } else if (normalized) {
        bar = windowEventBar(normalized);
      }
      if (bar && cliOf(info.sessionId) === 'opencode') {
        bar = labelRoutedProvider(bar, normalized.provider);
      }
      chatBroadcast(info.sessionId, {
        type: 'rate_limit_event', sessionId: info.sessionId,
        rate_limit_info: info.rateLimitInfo, bar,
      });
    } catch (_) {}
  };
  return { onDelta, onRateLimit };
}

module.exports = { createProxyBroadcasters };

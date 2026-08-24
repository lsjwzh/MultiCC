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
const { redactProviderRouteCapability } = require('../observability');

// `resolveCli(sessionName)` → the session's CLI, used only to decide whether
// this window belongs to the CLI itself or to a provider routed underneath it
// (OpenCode Go meters its own subscription separately from whatever it routes
// to, and two unlabeled `5h N%` values read as one contradictory meter).
//
// `recordLimit(sessionId, dto, providerId)` is an optional side channel into the persistent
// provider-limit cache (see limit-cache-recorder); best-effort like every other
// callback here.
function createProxyBroadcasters(chatBroadcast, {
  resolveCli, recordLimit, attemptRuntime, audit,
  } = {}) {
  const cliOf = (name) => {
    try { return typeof resolveCli === 'function' ? resolveCli(name) : null; } catch (_) { return null; }
  };
  const auditDrop = (ctx, code) => {
    if (typeof audit !== 'function') return;
    const rawSessionId = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
    const sessionId = attemptRuntime && typeof attemptRuntime.resolveProxySessionId === 'function'
      ? attemptRuntime.resolveProxySessionId(rawSessionId) || '' : rawSessionId;
    try {
      audit(sessionId, Object.freeze({
        type: 'proxy_part_delta_dropped',
        code,
        role: ctx && ctx.role ? String(ctx.role) : null,
        providerId: ctx && ctx.providerId ? String(ctx.providerId) : null,
      }));
    } catch (_) {}
  };
  const attemptIdentity = (observed) => {
    const identity = observed && {
      providerRouteScope: 'attempt',
      runtimeEpoch: observed.runtimeEpoch,
      turnId: observed.turnId,
      decisionId: observed.decisionId,
      routeAttemptId: observed.routeAttemptId,
      routeGeneration: observed.routeGeneration,
      attemptNo: observed.attemptNo,
      providerId: observed.providerId,
      providerRevision: observed.providerRevision,
    };
    if (!identity || !identity.runtimeEpoch || !identity.turnId || !identity.decisionId
        || !identity.routeAttemptId || !identity.providerId || !identity.providerRevision
        || !Number.isSafeInteger(identity.routeGeneration) || identity.routeGeneration < 1
        || !Number.isSafeInteger(identity.attemptNo) || identity.attemptNo < 1) return null;
    return identity;
  };
  const onDelta = (delta, ctx) => {
    try {
      if (!delta || !ctx || !ctx.sessionId) return;
      const safeDelta = redactProviderRouteCapability(delta);
      if (!attemptRuntime) {
        chatBroadcast(ctx.sessionId, { type: 'part_delta', sessionId: ctx.sessionId, role: ctx.role, model: ctx.model || null, delta: safeDelta });
        return;
      }
      if (String(ctx.role || '').toLowerCase() !== 'main') {
        auditDrop(ctx, 'non_main_role');
        return;
      }
      let observed;
      try {
        observed = attemptRuntime.observeProxyDelta(safeDelta, ctx);
      } catch (_) {
        auditDrop(ctx, 'attempt_runtime_error');
        return;
      }
      if (!observed || observed.accepted !== true) {
        auditDrop(ctx, observed && observed.code ? observed.code : 'proxy_attempt_unbound');
        return;
      }
      const identity = attemptIdentity(observed);
      if (!identity) {
        auditDrop(ctx, 'attempt_identity_incomplete');
        return;
      }
      const scrubbed = attemptRuntime.scrubAttemptEvent(observed, { type: 'part_delta', delta: safeDelta });
      chatBroadcast(observed.sessionId, {
        type: 'part_delta', sessionId: observed.sessionId, role: ctx.role,
        model: ctx.model || null, delta: scrubbed.delta, ...identity,
      });
    } catch (_) {}
  };
  const onRateLimit = (info) => {
    try {
      if (!info || !info.sessionId || !info.rateLimitInfo) return;
      let identity = null;
      let sessionId = info.sessionId;
      let providerId = info.providerId || null;
      const role = String(info.role || info.roleKind || 'main').toLowerCase();
      if (attemptRuntime) {
        const attributed = attemptRuntime.attributeProxyUsage({
          ...info, roleKind: role,
        });
        if (role === 'main') {
          identity = attributed && attributed.routeAttribution === 'exact'
            ? attemptIdentity(attributed) : null;
          if (!identity) { auditDrop(info, 'rate_limit_attempt_unbound'); return; }
        } else if (!attributed || attributed.producerBound !== true) {
          auditDrop(info, 'rate_limit_producer_unbound'); return;
        }
        sessionId = attributed.sessionId;
        providerId = attributed.providerId || providerId;
      }
      if (recordLimit) {
        try { recordLimit(sessionId, info.rateLimitInfo, providerId); } catch (_) {}
      }
      if (role !== 'main' && attemptRuntime) return;
      // The event carries the rendered bar alongside the raw DTO. Claude's 5h
      // is only half its bar — the weekly windows come from the usage-page
      // scrape — so the merge happens here, server-side, and both clients paint
      // the result rather than each recombining the two sources.
      const normalized = normalizeWindowEvent(info.rateLimitInfo, Date.now());
      let bar = null;
      if (normalized && normalized.provider === 'claude') {
        rememberClaudeLive(sessionId, normalized);
        bar = renderClaudeBar(sessionId);
      } else if (normalized) {
        bar = windowEventBar(normalized);
      }
      if (bar && cliOf(sessionId) === 'opencode') {
        bar = labelRoutedProvider(bar, normalized.provider);
      }
      chatBroadcast(sessionId, {
        type: 'rate_limit_event', sessionId,
        ...(providerId ? { providerId: String(providerId) } : {}),
        rate_limit_info: info.rateLimitInfo, bar, ...(identity || {}),
      });
    } catch (_) {}
  };
  return { onDelta, onRateLimit };
}

module.exports = { createProxyBroadcasters };

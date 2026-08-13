'use strict';

// Wires the usage-limit poller into the chat runtime: resolves a session to its
// provider's pollable limit target, and maps the poller's unified DTO onto the
// chat WS events the front-end already understands (rate_limit_event for window
// utilization, usage_balance_event for prepaid balance). Kept out of server.js
// so the poller's session/provider knowledge lives beside the rest of the chat
// wiring, not in the monolith.
//
// deps:
//   persistedSessions — Map<sessionName, record{ provider, cli }>
//   providers         — src/providers (appTypeForCli, getProviderLimitTarget)
//   chatBroadcast     — (sessionName, payload) => void
//   createPoller      — factory from src/usage-limit-poller (injectable for tests)

const {
  normalizeWindowEvent, windowEventBar, normalizeBalance, balanceBar,
  labelRoutedProvider, labelRoutedBalance,
} = require('../quota/quota-bar-view');
const { rememberClaudeLive, renderClaudeBar } = require('../quota/claude-bar-state');

function createUsageLimitWiring({ persistedSessions, providers, chatBroadcast, createPoller }) {
  if (!persistedSessions || !providers || typeof chatBroadcast !== 'function' || typeof createPoller !== 'function') {
    throw new Error('createUsageLimitWiring requires persistedSessions, providers, chatBroadcast, createPoller');
  }
  return createPoller({
    resolveTarget(sessionName) {
      const rec = persistedSessions.get(sessionName);
      if (!rec || !rec.provider) return null;
      const appType = providers.appTypeForCli(rec.cli || 'claude');
      if (!appType) return null; // vendor-owned CLI (Qoder/ZCode) — bypasses our proxy
      return providers.getProviderLimitTarget(appType, rec.provider);
    },
    // Each event carries its bar already rendered, so the web and the app
    // display one string produced in one place rather than each formatting this
    // DTO their own way.
    broadcast(sessionName, dto) {
      // OpenCode Go meters its own subscription separately from whatever it
      // routes to, so a routed provider's window says whose it is.
      const routed = (persistedSessions.get(sessionName) || {}).cli === 'opencode';
      if (dto.kind === 'window') {
        const info = {
          rateLimitType: dto.rateLimitType, status: dto.status,
          utilization: dto.utilization, resetsAt: dto.resetsAt,
          provider: dto.provider || 'glm',
        };
        const normalized = normalizeWindowEvent(info, Date.now());
        let bar = null;
        if (normalized && normalized.provider === 'claude') {
          // Claude's 5h is only half its bar; the weekly windows come from the
          // usage-page scrape, so the merge happens server-side.
          rememberClaudeLive(sessionName, normalized);
          bar = renderClaudeBar(sessionName);
        } else if (normalized) {
          bar = windowEventBar(normalized);
        }
        if (bar && routed) bar = labelRoutedProvider(bar, normalized.provider);
        chatBroadcast(sessionName, {
          type: 'rate_limit_event', sessionId: sessionName, rate_limit_info: info, bar,
        });
      } else if (dto.kind === 'balance') {
        let bar = balanceBar(normalizeBalance(dto));
        if (bar && routed) bar = labelRoutedBalance(bar);
        chatBroadcast(sessionName, {
          type: 'usage_balance_event', sessionId: sessionName, balance_info: dto, bar,
        });
      }
    },
  });
}

module.exports = { createUsageLimitWiring };

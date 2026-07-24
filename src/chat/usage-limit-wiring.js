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
    broadcast(sessionName, dto) {
      if (dto.kind === 'window') {
        chatBroadcast(sessionName, {
          type: 'rate_limit_event', sessionId: sessionName,
          rate_limit_info: {
            rateLimitType: dto.rateLimitType, status: dto.status,
            utilization: dto.utilization, resetsAt: dto.resetsAt,
            provider: dto.provider || 'glm',
          },
        });
      } else if (dto.kind === 'balance') {
        chatBroadcast(sessionName, {
          type: 'usage_balance_event', sessionId: sessionName, balance_info: dto,
        });
      }
    },
  });
}

module.exports = { createUsageLimitWiring };

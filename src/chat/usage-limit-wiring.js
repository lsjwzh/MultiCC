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
//   providers         — src/providers/core (appTypeForCli, getProviderLimitTarget)
//   chatBroadcast     — (sessionName, payload) => void
//   createPoller      — factory from src/usage-limit-poller (injectable for tests)
//   recordLimit       — optional (sessionName, dto) => void — persists the DTO
//                       into the provider-limit cache (see limit-cache-recorder)

const {
  normalizeWindowEvent, windowEventBar, normalizeBalance, balanceBar,
  labelRoutedProvider, labelRoutedBalance,
} = require('../quota/quota-bar-view');
const { rememberClaudeLive, renderClaudeBar } = require('../quota/claude-bar-state');
const {
  DEFAULT_KEY, configureClaudeKeyResolver, claudeProviderKey, enqueueClaudeUsage,
} = require('../quota/claude-usage-queue');

// A task boundary is the one automatic moment a Claude scrape is allowed (the
// other is the user's own ⟳): a turn ending is when the account's numbers have
// just moved, and the reading is then there for every session on that account.
// The queue enforces the one-a-minute floor and joins an open scrape, so a
// boundary costs nothing when someone else already read the account.
function warmClaudeUsage(sessionName) {
  try {
    const key = claudeProviderKey(sessionName);
    if (!key) return;
    enqueueClaudeUsage(key).catch(() => {});
  } catch (_) {
    // best-effort: never disturb the chat flow
  }
}

function createUsageLimitWiring({ persistedSessions, providers, chatBroadcast, createPoller, recordLimit }) {
  if (!persistedSessions || !providers || typeof chatBroadcast !== 'function' || typeof createPoller !== 'function') {
    throw new Error('createUsageLimitWiring requires persistedSessions, providers, chatBroadcast, createPoller');
  }
  // Which account's Claude reading a session reads and writes: the official
  // account its provider borrows (claude-usage-queue keys its cache by account),
  // DEFAULT_KEY for the shared CLI login, and '' for a session whose Claude
  // traffic never reaches the subscription — another CLI, or a provider routed
  // to some other vendor, which has no business warming that cache at all.
  //
  // The queue has to ask this about a bare session name, and only this closure
  // holds both halves at once (a session knows its provider, and the provider
  // knows its account), so it is configured from here and used everywhere: the
  // claude quota routes, the unified bar refresh and the live-window store.
  function claudeSubscriptionKey(sessionName) {
    const rec = persistedSessions.get(sessionName);
    if (!rec) return '';
    const cli = String(rec.cli || 'claude');
    if (cli !== 'claude' && cli !== 'claude-exp') return '';
    const appType = providers.appTypeForCli(cli);
    if (appType !== 'claude') return '';
    let summary = null;
    try {
      summary = rec.provider ? providers.getProviderSummary(appType, rec.provider) : null;
    } catch (_) { summary = null; }
    // A baseUrl means the Claude CLI is pointed at someone else's endpoint
    // (Zhipu, a 借道 relay): the subscription bar is hidden for those, so there
    // is nothing to warm.
    if (summary && summary.baseUrl) return '';
    const accountId = String((summary && summary.officialAccountId) || '');
    return accountId ? `claude:${accountId}` : DEFAULT_KEY;
  }
  configureClaudeKeyResolver(claudeSubscriptionKey);
  const poller = createPoller({
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
      if (recordLimit) {
        try { recordLimit(sessionName, dto); } catch (e) { /* cache write must not break chat */ }
      }
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
  // The task boundary is where an automatic Claude reading is allowed, and a
  // turn ending is the one hook every session passes through — so it is warmed
  // here rather than at a new call site (turn-engine is at its line budget, and
  // a poller wrapper costs it nothing). Everything else the poller exposes
  // (`_refresh`, `_cache`, the turn-start hook) is passed through untouched.
  return {
    ...poller,
    onTurnComplete(sessionName) {
      warmClaudeUsage(sessionName);
      return poller.onTurnComplete(sessionName);
    },
  };
}

module.exports = { createUsageLimitWiring };

'use strict';

// Quota self-heal wiring — the host glue that keeps a cached quota reading
// from going stale in the two ways that used to deadlock an account:
//
//   1. quota-guard stale release → refreshOne: a blocking reading older than
//      maxReadingAgeMs no longer holds the gate (src/quota/quota-guard.js);
//      the guard offers the provider's real quota re-read here so the cache
//      — not the released probe turn — is what usually supplies the verdict.
//   2. codex 401 → OAuth refresh: the usage read fails with HTTP 401 when the
//      on-disk access token lapses, and nothing in the quota path used to run
//      the codex CLI that rotates it (turns are exactly what a guarded account
//      is not running). The hook installed here lets pollCodexUsage and
//      /api/codex/quota repair the token on the spot and retry once.
//
// Both wirings share the one refresh port the balance routes already expose,
// so this module is also where server.js's old one-line setRefresher call
// moved — server.js passes the pieces, this module owns the shape.

const path = require('node:path');
const os = require('node:os');

function wireCodexAuthRefresher({ codexOAuthRefresh, codexAccountRefresh, officialAccounts }) {
  require('../usage-limit-poller').setCodexAuthRefresher(async ({ authFile } = {}) => {
    try {
      const shared = !authFile || authFile === path.join(os.homedir(), '.codex', 'auth.json');
      let refresher = null;
      if (shared) {
        refresher = codexOAuthRefresh || null;
      } else {
        // A per-account credential maps to that account's own refresher. A
        // cliCopy shares the CLI's single-use refresh token — rotating it
        // here would log the user's own CLI out, so it is never touched.
        codexAccountRefresh.sync();
        const account = (officialAccounts.listCodexAccounts() || [])
          .find(item => officialAccounts.codexAuthFile(item.id) === authFile);
        if (!account || account.cliCopy) return false;
        refresher = codexAccountRefresh.refreshers.get(account.id) || null;
      }
      if (!refresher) return false;
      // force: a cooldown or a stale needs_login latch must not stand between
      // a live 401 and its repair; the refresher still declines on its own
      // when the credential reads healthy.
      const outcome = await refresher.refresh({ reason: 'codex-quota-401', force: true });
      // 'fresh' means another writer already rotated the token — the retry
      // then reads a working credential even though this attempt ran nothing.
      return !!outcome && (outcome.outcome === 'refreshed' || outcome.outcome === 'fresh');
    } catch (_) {
      return false;
    }
  });
}

function wireQuotaSelfHeal({
  app,
  providers,
  limitRecorder,
  providerLimitCache,
  quotaGuard,
  codexOAuthRefresh,
  codexAccountRefresh,
  officialAccounts,
  mountProviderBalanceRoutes,
}) {
  const refreshOne = mountProviderBalanceRoutes(app, {
    ...providers,
    onResult: limitRecorder.recordProvider,
    lookupCached: (appType, id) => providerLimitCache.get(appType, id),
  })?.refreshOne || null;
  // The shared quota refresh port: a route rejection re-reads the provider's
  // quota through the recorder, virtual providers reuse the same port.
  limitRecorder.setRefresher(require('../providers/virtual-provider').setRefresher(refreshOne));
  quotaGuard.setStaleRefresher(refreshOne ? (appType, id) => refreshOne(appType, id) : null);
  wireCodexAuthRefresher({ codexOAuthRefresh, codexAccountRefresh, officialAccounts });
}

module.exports = { wireQuotaSelfHeal, wireCodexAuthRefresher };

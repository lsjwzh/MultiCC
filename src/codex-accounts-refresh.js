'use strict';

// Per-account Codex OAuth refresh supervisor.
//
// The shared-login refresher (codex-oauth-refresh.js) only watches
// ~/.codex/auth.json. Official-account credentials live in their own dirs and
// NOTHING else refreshes them — chat turns route through the relay with an
// auth-stripped home, so the codex CLI never sees the account token. One
// refresher instance per logged-in account (the refresher is already
// parameterized by authFile + buildEnv; we just point CODEX_HOME at the
// account dir so the CLI rotates THAT auth.json).

const { createCodexOAuthRefresher, stripOpenAiEnv } = require('./codex-oauth-refresh');

function createCodexAccountRefreshSupervisor(options = {}) {
  const accounts = options.accounts;
  if (!accounts) throw new TypeError('[codex-accounts-refresh] accounts store is required');
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const makeRefresher = typeof options.makeRefresher === 'function'
    ? options.makeRefresher
    : (account) => createCodexOAuthRefresher({
        logger,
        authFile: accounts.codexAuthFile(account.id),
        buildEnv: () => {
          const env = stripOpenAiEnv({ ...process.env });
          env.CODEX_HOME = accounts.codexDir(account.id);
          return env;
        },
      });

  const refreshers = new Map(); // accountId -> refresher

  // Reconcile the refresher set with the accounts on disk. New accounts get a
  // refresher once logged in; deleted accounts are dropped (refreshers hold no
  // timers of their own — the host drives check() — so dropping is enough).
  function sync() {
    let list = [];
    try {
      list = accounts.listCodexAccounts();
    } catch (_) {
      return;
    }
    const seen = new Set();
    for (const account of list) {
      seen.add(account.id);
      if (!account.loggedIn || refreshers.has(account.id)) continue;
      try {
        refreshers.set(account.id, makeRefresher(account));
      } catch (error) {
        logger.warn('codex_account_refresher_create_failed', { accountId: account.id, error: error.message });
      }
    }
    for (const id of [...refreshers.keys()]) {
      if (!seen.has(id)) refreshers.delete(id);
    }
  }

  async function checkAll(reason = 'periodic') {
    sync();
    const results = [];
    for (const [accountId, refresher] of refreshers) {
      try {
        const outcome = await refresher.check(reason);
        results.push({ accountId, outcome: outcome && outcome.outcome || null });
      } catch (error) {
        logger.warn('codex_account_refresh_check_failed', { accountId, error: error.message });
      }
    }
    return results;
  }

  function status(accountId) {
    const refresher = refreshers.get(accountId);
    return refresher ? refresher.status() : null;
  }

  return Object.freeze({ sync, checkAll, status, refreshers });
}

module.exports = { createCodexAccountRefreshSupervisor };

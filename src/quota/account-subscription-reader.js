'use strict';

// Subscription readers for the virtual provider / quota machinery. NOT a
// route: `GET /api/{claude,codex}/subscription` is answered by the Rust front
// door (native/gateway/src/app/account_subscription.rs) since the migration in
// docs/gateway.md §9.
//
// What stays here is the cross-module contract the route used to own:
//   - `read(id)` is the single-flight subscription query the account-level
//     providers refresh through (src/providers/virtual-provider.js →
//     subscriptions.refresh). Its semantics are unchanged from the deleted
//     route: read-only credential peek, no renewal, no account lock, fallback
//     never cached.
//   - registering it with src/quota/account-subscription-cache.js is what keeps
//     `subscriptions.refresh(provider)` able to obtain a number at all;
//     deleting the route without this file would have silently disconnected
//     every reader with no failing test anywhere.
//
// The HTTP route itself (400/404 decisions, Cache-Control) moved to Rust and
// lives in the frozen oracle tests/helpers/legacy-account-subscription-route.js
// for the differential.

const path = require('node:path');
const os = require('node:os');
const cache = require('../quota/account-subscription-cache');
const { query } = require('../providers/native-subscription');

// Node had one Map per mount (one per vendor); moving the readers into one
// module keeps that key space explicit instead of relying on closures.
const pending = new Map();

function registerAccountSubscriptionReader(vendor, deps = {}) {
  async function read(id) {
    if (vendor === 'claude' && id && !deps.accounts.listClaudeAccounts().some(a => a.id === id)) {
      return { status: 'no_auth' };
    }
    const key = `${vendor}\0${id}`;
    if (!pending.has(key)) {
      const attemptAt = Date.now();
      const queryOnce = async () => {
        if (vendor === 'codex') {
          const authFile = id ? deps.resolveAccountAuthFile?.(id) : path.join(os.homedir(), '.codex', 'auth.json');
          if (!authFile) return { status: 'no_auth' };
          return query({ vendor, authFile }, { fetch: deps.fetch });
        }
        let token;
        if (id) token = (await deps.credentials.peekAccountToken(id))?.token;
        else {
          const read = await (deps.readCliCredentials || require('../quota/claude-cli-oauth').readCliCredentials)();
          if (read?.ok && (read.expiresAt == null || read.expiresAt > Date.now())) token = read.accessToken;
        }
        return query({ vendor, token }, { fetch: deps.fetch });
      };
      pending.set(key, queryOnce().catch(error => ({ status: error?.status === 401 ? 'no_auth' : 'unavailable' }))
        .then(async result => { await cache.record(vendor, id, result, attemptAt).catch(() => {}); return result; })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }
  cache.register(vendor, read);
  return read;
}

module.exports = { registerAccountSubscriptionReader };

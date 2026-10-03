'use strict';

// Per-account Claude credential reader with refresh-on-read — the cpr claude
// proxy's injected readOfficialCredential and the per-account quota route both
// go through here. Unlike the shared Keychain login (which the CLI refreshes
// itself), account credential files are owned by multicc and NOTHING else
// refreshes them, so an expired access token is rotated inline: singleflight
// per account + Retry-After honouring backoff, exactly CPA's policy
// (claudeRefreshGroup / claudeRefreshBlock, 5s–5min clamps).

const { refreshTokens, fetchProfile, ClaudeOAuthError, REFRESH_MIN_BACKOFF_MS } = require('./official-oauth');
const { followsCliImport } = require('../official-accounts');

const EXPIRY_MARGIN_MS = 60 * 1000; // treat tokens expiring within a minute as expired

function createClaudeAccountCredentialService(options = {}) {
  const accounts = options.accounts;
  if (!accounts) throw new TypeError('[claude-account-credentials] accounts store is required');
  const fetchImpl = options.fetch || globalThis.fetch;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = options.now || (() => Date.now());
  // Shared with the per-account CLI refresher (accounts-refresh.js): one
  // rotation per account at a time, or two holders spend one single-use token.
  const exclusive = typeof options.exclusive === 'function' ? options.exclusive : (id, fn) => fn();
  const fresh = expiresAt => expiresAt == null || expiresAt > now() + EXPIRY_MARGIN_MS;

  const inflight = new Map();     // accountId -> Promise (singleflight)
  const blockedUntil = new Map(); // accountId -> epoch ms (Retry-After backoff)
  const stats = new Map();        // accountId -> {refreshCount, lastError, lastRefreshAt}

  function note(id, patch) {
    stats.set(id, { refreshCount: 0, lastError: null, lastRefreshAt: null, ...(stats.get(id) || {}), ...patch });
  }

  function readStored(id) {
    const data = accounts.readClaudeCredential(id);
    if (!data) return { ok: false, reason: 'credential_unreadable' };
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) return { ok: false, reason: 'access_token_missing' };
    const expiresAt = data.expired ? Date.parse(data.expired) : null;
    return {
      ok: true,
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '',
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      fromCli: followsCliImport(data.source, data.importedRefreshHash, data.refresh_token),
    };
  }

  async function refresh(id, refreshToken) {
    const blocked = blockedUntil.get(id) || 0;
    if (blocked > now()) {
      return { ok: false, reason: `refresh temporarily blocked until ${new Date(blocked).toISOString()}` };
    }
    if (!refreshToken) return { ok: false, reason: 'refresh_token_missing' };
    try {
      const tokenData = await refreshTokens(fetchImpl, { refreshToken, now });
      // Advisory, matching CPA: profile fills identity the token response omitted.
      try {
        const profile = await fetchProfile(fetchImpl, tokenData.access_token);
        for (const key of ['email', 'account_uuid', 'organization_uuid', 'organization_name']) {
          if (profile[key]) tokenData[key] = profile[key];
        }
      } catch (error) {
        logger.warn('claude_account_profile_fetch_failed', { accountId: id, error: error.message });
      }
      accounts.writeClaudeCredential(id, tokenData);
      blockedUntil.delete(id);
      const prev = stats.get(id);
      note(id, { refreshCount: (prev ? prev.refreshCount : 0) + 1, lastError: null, lastRefreshAt: now() });
      return { ok: true, accessToken: tokenData.access_token, expiresAt: Date.parse(tokenData.expired) };
    } catch (error) {
      if (error instanceof ClaudeOAuthError && error.status === 429) {
        blockedUntil.set(id, now() + (error.retryAfterMs || REFRESH_MIN_BACKOFF_MS));
      }
      note(id, { lastError: error.message });
      logger.warn('claude_account_refresh_failed', { accountId: id, error: error.message, status: error.status || null });
      return { ok: false, reason: `refresh_failed: ${error.message}` };
    }
  }

  // A copy imported from the CLI shares the CLI's refresh token: rotating it
  // here would log the CLI out. Re-sync from the CLI first (the CLI refresher
  // keeps the CLI fresh); while the copy still shares the CLI's token family it
  // never rotates on its own. Only once the CLI holds a different login does
  // the copy refresh itself like any multicc-owned account.
  async function refreshPreferringCli(id, stored) {
    if (stored.fromCli && typeof options.refreshFromCli === 'function') {
      let r = {};
      try { r = (await options.refreshFromCli('claude', id)) || {}; } catch (_) { /* treat as not shared */ }
      if (r.synced) {
        const synced = readStored(id);
        if (synced.ok && fresh(synced.expiresAt)) {
          return { ok: true, accessToken: synced.accessToken, expiresAt: synced.expiresAt };
        }
      }
      if (r.shared) return { ok: false, reason: 'waiting_for_cli_refresh' };
    }
    return refresh(id, stored.refreshToken);
  }

  // The cpr-facing read: {token} on success, {token:null, reason} otherwise.
  // Sync-shape contract (cpr awaits the result, so async is fine).
  async function readAccountToken(id) {
    const stored = readStored(id);
    if (!stored.ok) return { token: null, reason: stored.reason };
    if (fresh(stored.expiresAt)) return { token: stored.accessToken };
    // Expired (or nearly): singleflight refresh, then re-read the file.
    let pending = inflight.get(id);
    if (!pending) {
      pending = exclusive(id, () => {
        // A CLI refresh of this account may have landed while we waited.
        const current = readStored(id);
        if (current.ok && fresh(current.expiresAt)) {
          return { ok: true, accessToken: current.accessToken, expiresAt: current.expiresAt };
        }
        return refreshPreferringCli(id, current.ok ? current : stored);
      }).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    const refreshed = await pending;
    if (!refreshed.ok) return { token: null, reason: refreshed.reason };
    return { token: refreshed.accessToken };
  }

  function status(id) {
    const blocked = blockedUntil.get(id) || 0;
    return {
      ...(stats.get(id) || { refreshCount: 0, lastError: null, lastRefreshAt: null }),
      blockedUntil: blocked > now() ? blocked : null,
    };
  }

  // The cpr claude-proxy entry point (createHandler options.readOfficialCredential):
  // an account context object resolves via refresh-on-read; anything else (the
  // canonical claude-official provider's legacy string arg) defers to the shared
  // Keychain reader. The default is required lazily so this module stays loadable
  // in tests without the router package.
  const sharedLoginReader = typeof options.sharedLoginReader === 'function'
    ? options.sharedLoginReader
    : (arg) => require('cli-provider-router').readOfficialOAuthToken(arg);

  function readOfficialCredential(arg) {
    if (arg && typeof arg === 'object') return readAccountToken(arg.accountId);
    return sharedLoginReader(arg);
  }

  return Object.freeze({ readAccountToken, readOfficialCredential, status });
}

module.exports = { createClaudeAccountCredentialService, EXPIRY_MARGIN_MS };

'use strict';

// Per-account Claude credential reader — the cpr claude proxy's injected
// readOfficialCredential and the per-account quota routes both go through here.
// It reads, and it asks. It never renews.
//
// Renewal has exactly one writer: the claude CLI, driven by accounts-refresh.js
// under the account's own CLAUDE_CONFIG_DIR. A refresh token is single-use, so a
// second holder renewing in parallel spends it twice and the loser is told
// `invalid_grant` — a healthy account reported dead. Two consequences shape
// this module:
//
//   - Every read still joins the account's lock, even for a locally fresh
//     token: a CLI rotation can revoke the old access token before its probe
//     has finished and the supervisor has adopted the new credential.
//   - A lapsed token is delegated, not refreshed. The read asks the supervisor
//     to rotate (onNeedsRefresh) and re-reads once; whether a CLI actually runs
//     is the supervisor's decision, already bounded by its park, cooldown and
//     spacing gates, so a burst of reads cannot become a burst of processes.
//
// Display-only callers use peekAccountToken: it reports an expired token
// instead of triggering a rotation, because showing a usage number must not
// spend the account's one single-use credential.

const { credential } = require('../providers/native-credentials');

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // 与官方 CLI 一样，提前五分钟检查续期
// A peek may hand out a token this close to expiry: it is about to be used for
// one control-plane GET, and refusing it would blank the number needlessly.
const PEEK_MARGIN_MS = 60 * 1000;
// A delegation is on the request path, so it is capped: past this the caller is
// better served by a clear failure than by a turn that hangs on a CLI probe.
const DEFAULT_REFRESH_WAIT_MS = 8 * 1000;

function createClaudeAccountCredentialService(options = {}) {
  const accounts = options.accounts;
  if (!accounts) throw new TypeError('[claude-account-credentials] accounts store is required');
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = options.now || (() => Date.now());
  // Shared with the per-account CLI refresher (accounts-refresh.js): one
  // rotation per account at a time, and a read waits for the rotation in flight
  // rather than serving the token it is about to replace.
  const exclusive = typeof options.exclusive === 'function' ? options.exclusive : async (id, fn) => fn();
  // Injected by server.js: (accountId) -> supervisor.checkAccount(id, 'read-miss').
  // Absent when this service is built standalone (the quota route's fallback
  // source, tests): a lapsed token is then reported, never renewed.
  const onNeedsRefresh = typeof options.onNeedsRefresh === 'function' ? options.onNeedsRefresh : null;
  const refreshWaitMs = Number(options.refreshWaitMs) > 0
    ? Number(options.refreshWaitMs) : DEFAULT_REFRESH_WAIT_MS;
  const fresh = (expiresAt, margin = EXPIRY_MARGIN_MS) => expiresAt == null || expiresAt > now() + margin;

  const inflight = new Map(); // accountId -> Promise (singleflight)

  function readStored(id) {
    return credential({ operation: 'stored', data: accounts.readClaudeCredential(id) });
  }

  function usable(stored, margin) {
    return credential({ operation: 'usable', stored, margin, now: now() });
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      // The timer is deliberately ref'd: the caller is awaiting this promise, and
      // an unref'd timer is not event-loop work — when the wait is the only thing
      // pending the process exits before it can fire, so the read never settles
      // (node --test reports "Promise resolution is still pending but the event
      // loop has already resolved"). Staying alive at most refreshWaitMs while a
      // read is genuinely in flight is the correct behaviour.
      const timer = setTimeout(() => reject(new Error(`delegated refresh timed out after ${ms}ms`)), ms);
      Promise.resolve(promise).then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function load(id) {
    const before = await exclusive(id, () => readStored(id));
    // A copy of the CLI's login shares the CLI's single-use refresh token, so it
    // is served until it lapses and then needs its own login — never delegated.
    const direct = usable(before, before.ok && before.cliCopy ? 60_000 : EXPIRY_MARGIN_MS);
    if (direct.token) return direct;
    if (!before.ok || before.cliCopy || !onNeedsRefresh) return direct;

    let outcome = null;
    try { outcome = await withTimeout(onNeedsRefresh(id), refreshWaitMs); }
    catch (error) {
      logger.warn('claude_account_refresh_delegation_failed', { accountId: id, error: error.message });
    }
    const after = await exclusive(id, () => readStored(id));
    // The supervisor adopts the rotated credential into the account file as part
    // of its run, so a different access token here means the rotation landed.
    if (after.ok && after.accessToken !== before.accessToken) return { token: after.accessToken };
    // No rotation came back — the CLI may have declined (its own window opens
    // later) or the supervisor may be inside its spacing gate. Failing the turn
    // outright would be worse than using what is left: the margin that led here
    // is a safety margin, not the expiry. The fallback is the peek margin, so a
    // token with seconds left is still reported as lapsed rather than handed to
    // a request that cannot finish with it.
    if (fresh(before.expiresAt, PEEK_MARGIN_MS)) return { token: before.accessToken };
    return {
      token: null,
      // Why the turn is about to fail, in one word a log reader can act on:
      // parked / needs-login / cooldown / staggered / failed — or unavailable
      // when the delegation itself timed out.
      reason: `cli_refresh_${(outcome && outcome.outcome) || 'unavailable'}`,
    };
  }

  // The cpr-facing read: {token} on success, {token:null, reason} otherwise.
  function readAccountToken(id) {
    let pending = inflight.get(id);
    if (!pending) {
      pending = load(id).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    return pending;
  }

  // Read-only: never asks for a rotation, never takes the account lock. For a
  // caller that wants a number on screen, not a turn on the wire.
  function peekAccountToken(id) {
    return usable(readStored(id), PEEK_MARGIN_MS);
  }

  async function recoverAccountToken(id, failedToken) {
    if (!failedToken) return { token: null, reason: 'failed_token_missing' };
    // 现有账号锁就是续期进行中标记：排在它后面，等保存完成后重读。
    // 异常恢复不发起续期；没有新令牌就保留原错误，避免重复续期。
    return exclusive(id, () => {
      const current = readStored(id);
      if (!current.ok) return { token: null, reason: current.reason };
      if (current.accessToken !== failedToken && fresh(current.expiresAt)) {
        return { token: current.accessToken };
      }
      return { token: null, reason: 'credential_unchanged' };
    });
  }

  function status(id) {
    const data = accounts.readClaudeCredential(id) || {};
    const at = data.last_refresh ? Date.parse(data.last_refresh) : NaN;
    return {
      // The reader performs no rotations any more; the CLI's own record in the
      // account file is the honest "when did this credential last move".
      refreshCount: 0,
      lastError: null,
      lastRefreshAt: Number.isFinite(at) ? at : null,
      blockedUntil: null,
      renewedBy: 'cli',
    };
  }

  // The cpr claude-proxy entry point (createHandler options.readOfficialCredential):
  // an account context object resolves through the delegating read; anything else
  // (the canonical claude-official provider's legacy string arg) defers to the
  // Rust Keychain/file reader. The CLI supervisor remains the only refresher.
  const sharedLoginReader = typeof options.sharedLoginReader === 'function'
    ? options.sharedLoginReader
    : async (keychainService) => {
      const value = await require('../quota/claude-cli-oauth').readCliCredentials({ keychainService });
      return value.ok && fresh(value.expiresAt, 0) ? { token: value.accessToken } : { token: null, reason: value.reason || 'access_token_expired' };
    };

  function readOfficialCredential(arg) {
    if (arg && typeof arg === 'object') return readAccountToken(arg.accountId);
    return sharedLoginReader(arg);
  }

  function recoverOfficialCredential(arg, failedToken) {
    // 共享钥匙串登录仍由原生 CLI 管理，不能在此花它的刷新令牌。
    if (!arg || typeof arg !== 'object') return Promise.resolve({ token: null, reason: 'unmanaged_login' });
    return recoverAccountToken(arg.accountId, failedToken);
  }

  return Object.freeze({
    readAccountToken,
    peekAccountToken,
    readOfficialCredential,
    recoverAccountToken,
    recoverOfficialCredential,
    status,
  });
}

module.exports = { createClaudeAccountCredentialService, EXPIRY_MARGIN_MS };

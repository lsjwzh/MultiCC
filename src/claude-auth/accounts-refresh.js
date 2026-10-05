'use strict';

// Per-account Claude OAuth refresh through the claude CLI itself — the Claude
// twin of codex/accounts-refresh.js (which points CODEX_HOME at each account).
//
// The claude CLI keys its credential store on CLAUDE_CONFIG_DIR: with the
// variable unset it uses the Keychain item "Claude Code-credentials"; with it
// set, "Claude Code-credentials-<first 8 hex of sha256(configDir)>" (macOS), or
// <configDir>/.credentials.json elsewhere. So each store account gets its own
// config dir, and before its token lapses we
//
//   1. seed that dir's credential slot with the account's token,
//   2. run the CLI with CLAUDE_CONFIG_DIR=<dir> (the shared oauth-refresh.js
//      ladder: `auth status`, then a one-turn probe) so the CLI rotates it,
//   3. read the rotated token back into the account file and clear the slot.
//
// The CLI stays the only thing that speaks the refresh protocol, and the
// default login ("Claude Code-credentials") is never touched.
//
// This only works for accounts with their OWN token family. A copy of the
// CLI's login (isCliCopy) shares the CLI's single-use refresh token, so
// rotating it here would log the CLI out — it is skipped, and needs its own
// login once it lapses.
//
// A rotation is the one step that cannot be repeated (the old refresh token is
// spent), so: one rotation per account at a time (exclusive(), shared with the
// inline refresh in account-credentials.js), and a slot that still holds a
// newer token than the account — a run that rotated but never got read back —
// is adopted on the next check instead of being overwritten.

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClaudeOAuthRefresher, KEYCHAIN_SERVICE } = require('./oauth-refresh');
const { parseCredentials } = require('../quota/claude-cli-oauth');
const { atomicWriteJson, ensurePrivateDir, secureFile } = require('../runtime-security');
const { isCliCopy } = require('../official-accounts');

// Narrower than the shared refresher's 15 min: each attempt seeds and clears a
// credential slot, and the CLI declines anything outside its own ~5 min window.
const DEFAULT_BUFFER_MS = 6 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
// Probe while the inline refresh (1 min before expiry) is still a few minutes
// away, so the CLI normally wins and the inline path stays a fallback.
const DEFAULT_PROBE_THRESHOLD_MS = 5 * 60 * 1000;
// The triggers do not know about each other: the boot check, the periodic tick
// and any manual call can all decide the same account is due seconds apart. The
// refresher's own retryAfter covers a *declined* attempt (90s) but not a
// successful one, and every attempt that gets this far spends a seed/clear of
// the credential slot plus, near expiry, a real CLI turn against one single-use
// refresh token family. So attempts are spaced: a second trigger inside the gap
// is answered as `staggered` instead of running, and since the slot is only
// entered while the token is inside the 6 minute buffer anyway, being a cadence
// late costs nothing — the CLI declines until the token is nearly dead.
//
// The default is one slot-entering check per cadence (never faster than 90s): a
// gap below the cadence would be inert against the periodic tick, which is half
// the point, and the cadence is already how often this account is meant to be
// looked at. The floor keeps a deliberately short interval from becoming a
// hammer. Note this is not what stops a double spend — exclusive() does that —
// it stops a second ladder from spending a refresh on a token the first one just
// handled, which the refresher's own retryAfter misses whenever the first
// attempt succeeded and left the account still due.
const DEFAULT_MIN_CHECK_GAP_MS = 90 * 1000;
// The periodic cadence is otherwise anchored to process start, so every restart
// re-aligns it, and both the 10 minute usage sweep (also process-anchored) and
// any second instance watching the same accounts drift into step with it. A
// per-process jitter breaks those alignments without changing the cadence in any
// way an operator would notice.
const DEFAULT_JITTER_RATIO = 0.15;
// Autonomous checks are the periodic tick and the boot check. A manual call is
// an operator asking a direct question, so it is never staggered away.
const AUTONOMOUS_REASONS = Object.freeze(['periodic', 'boot']);
const SECURITY_TIMEOUT_MS = 10_000;
// `security -i` reads one command line; the CLI falls back to argv beyond this.
const SECURITY_STDIN_LIMIT = 4000;
const DEFAULT_SCOPES = Object.freeze(['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload']);

// Mirrors the CLI's own service-name derivation (verified against claude
// 2.1.285: `Claude Code${OAUTH_FILE_SUFFIX}-credentials-${sha256(dir)[0..8]}`).
function keychainServiceFor(configDir) {
  const hash = crypto.createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

// The Keychain account the CLI writes under ($USER, sanitised the CLI's way).
function keychainAccount(env = process.env) {
  let user;
  try { user = env.USER || os.userInfo().username; } catch (_) { user = ''; }
  return /^[a-zA-Z0-9._-]+$/.test(user || '') ? user : 'claude-code-user';
}

function defaultRun(file, args, { timeoutMs, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(error && error.killed),
        error: error ? error.message : null,
      });
    });
    if (input != null && child.stdin) child.stdin.end(input);
  });
}

// The credential slot one config dir maps to, in the CLI's own format.
function createCliCredentialSlot({ configDir, platform = process.platform, run = defaultRun, user = keychainAccount() }) {
  const service = keychainServiceFor(configDir);
  const file = path.join(configDir, '.credentials.json');

  if (platform === 'darwin') {
    return {
      service,
      async read() {
        const r = await run('security', ['find-generic-password', '-a', user, '-s', service, '-w'], { timeoutMs: SECURITY_TIMEOUT_MS });
        return r.code === 0 ? parseCredentials(r.stdout) : { ok: false, reason: 'absent' };
      },
      async write(value) {
        const hex = Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
        // Same as the CLI: hex via stdin keeps the token out of the process list.
        const line = `add-generic-password -U -a "${user}" -s "${service}" -X "${hex}"\n`;
        const r = line.length <= SECURITY_STDIN_LIMIT
          ? await run('security', ['-i'], { input: line, timeoutMs: SECURITY_TIMEOUT_MS })
          : await run('security', ['add-generic-password', '-U', '-a', user, '-s', service, '-X', hex], { timeoutMs: SECURITY_TIMEOUT_MS });
        return r.code === 0;
      },
      async remove() {
        await run('security', ['delete-generic-password', '-a', user, '-s', service], { timeoutMs: SECURITY_TIMEOUT_MS });
      },
    };
  }
  return {
    service: null,
    async read() {
      try { return parseCredentials(fs.readFileSync(file, 'utf8')); } catch (_) { return { ok: false, reason: 'absent' }; }
    },
    async write(value) {
      ensurePrivateDir(configDir);
      atomicWriteJson(file, value);
      secureFile(file);
      return true;
    },
    async remove() { fs.rmSync(file, { force: true }); },
  };
}

// Everything spreads accounts over the cadence, so the tick has to be finer than
// the cadence: the spacing gate already holds each account to one slot-entering
// check per cadence, so ticking more often costs a file read per account and
// buys those checks somewhere to land.
const TICKS_PER_CADENCE = 8;

// One account's slice of the cadence, derived from its id, so an account always
// occupies the same slot: two runs over the same store spread the same way, and
// a test can pin it. Deliberately not a counter over the account list — the
// order the store happens to list accounts in must not decide who refreshes
// first, and a deleted account must not shift everyone else's slot.
function accountPhaseMs(id, windowMs) {
  const window = Math.trunc(Number(windowMs));
  if (!(window > 0)) return 0;
  const hash = crypto.createHash('sha256').update(String(id)).digest();
  return hash.readUInt32BE(0) % window;
}

// Exported so the jitter is pinnable without a timer: the delay is a decision,
// not an implementation detail. One draw per process start, not per tick, so the
// cadence stays recognisable in the logs.
function jitteredIntervalMs(intervalMs, ratio = DEFAULT_JITTER_RATIO, randomValue = Math.random()) {
  const spread = Math.round(intervalMs * ratio);
  const offset = Math.round((Number(randomValue) * 2 - 1) * spread);
  return Math.max(1000, intervalMs + offset);
}

function createClaudeAccountRefreshSupervisor(options = {}) {
  const accounts = options.accounts;
  if (!accounts) throw new TypeError('[claude-accounts-refresh] accounts store is required');
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const platform = options.platform || process.platform;
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const bufferMs = Number(options.bufferMs) > 0 ? Number(options.bufferMs) : DEFAULT_BUFFER_MS;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  // A zero gap is a legitimate choice for a caller that wants every trigger to
  // land, so 0 is honoured rather than treated as "unset".
  const minCheckGapMs = Number(options.minCheckGapMs) >= 0
    ? Number(options.minCheckGapMs)
    : Math.max(DEFAULT_MIN_CHECK_GAP_MS, intervalMs);
  const jitterRatio = Number(options.jitterRatio) >= 0 ? Number(options.jitterRatio) : DEFAULT_JITTER_RATIO;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const isEnabled = typeof options.isEnabled === 'function'
    ? options.isEnabled
    : (() => process.env.CLAUDE_ACCOUNT_CLI_REFRESH !== '0' && process.env.CLAUDE_OAUTH_AUTO_REFRESH !== '0');
  const user = options.user || keychainAccount();

  const slotFor = id => createCliCredentialSlot({ configDir: accounts.claudeHomeDir(id), platform, run, user });
  const makeRefresher = typeof options.makeRefresher === 'function'
    ? options.makeRefresher
    : (id) => {
        const configDir = accounts.claudeHomeDir(id);
        return createClaudeOAuthRefresher({
          logger,
          run,
          now,
          platform,
          claudeBin: options.claudeBin,
          bufferMs,
          probeThresholdMs: options.probeThresholdMs != null ? options.probeThresholdMs : DEFAULT_PROBE_THRESHOLD_MS,
          cooldownMs: options.cooldownMs,
          deferCooldownMs: options.deferCooldownMs,
          keychainService: keychainServiceFor(configDir),
          credentialsFile: path.join(configDir, '.credentials.json'),
          isEnabled: () => true,
          // An inherited CLAUDE_SECURESTORAGE_CONFIG_DIR would override the
          // per-account slot, so it is removed, not just left alone.
          extraEnv: { ...(options.extraEnv || {}), CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: null },
        });
      };

  const refreshers = new Map(); // accountId -> refresher
  const locks = new Map();      // accountId -> tail promise
  const lastSlotAt = new Map(); // accountId -> epoch ms of the last slot-entering check
  let timer = null;

  function exclusive(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.then(() => fn());
    const tail = next.then(() => {}, () => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  function refresherFor(id) {
    if (!refreshers.has(id)) refreshers.set(id, makeRefresher(id));
    return refreshers.get(id);
  }

  function adopt(id, cred) {
    accounts.writeClaudeCredential(id, {
      access_token: cred.accessToken,
      refresh_token: cred.refreshToken || '',
      expired: cred.expiresAt != null ? new Date(cred.expiresAt).toISOString() : '',
      last_refresh: new Date(now()).toISOString(),
      ...(cred.scopes ? { scopes: cred.scopes } : {}),
      ...(cred.subscriptionType ? { subscription_type: cred.subscriptionType } : {}),
    });
  }

  async function checkAccount(id, reason) {
    const data = accounts.readClaudeCredential(id) || {};
    if (isCliCopy(data.source)) return { outcome: 'cli_copy' };
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
    if (!accessToken || !refreshToken) return { outcome: 'needs-login' };
    const expiresAt = Date.parse(data.expired || '');
    if (!Number.isFinite(expiresAt)) return { outcome: 'no-expiry' };
    // The common case touches nothing — no Keychain write, no CLI.
    if (expiresAt - now() > bufferMs) return { outcome: 'fresh' };
    const refresher = refresherFor(id);
    const retryAfter = refresher.status().retryAfter;
    if (retryAfter && retryAfter > now()) return { outcome: 'cooldown', retryInMs: retryAfter - now() };
    // Spacing gate (see DEFAULT_MIN_CHECK_GAP_MS). Only the autonomous triggers
    // are held back; a manual call always runs. The stamp is left by *every*
    // check that reached this point — a rotation someone asked for by hand is
    // still a rotation, and the periodic tick right behind it must not repeat it.
    //
    // First sight of a due account is where its place in the cadence is decided,
    // by seeding the stamp *backwards* rather than leaving the account eligible
    // at once. Accounts whose tokens lapse together — logged in together, or a
    // restart that emptied this map — would otherwise run their ladders in one
    // burst; the phase (accountPhaseMs) spreads them over the cadence that
    // follows. A manual call is not gated, so it still runs immediately and moves
    // the account to the present.
    if (!lastSlotAt.has(id)) lastSlotAt.set(id, now() - minCheckGapMs + accountPhaseMs(id, minCheckGapMs));
    const sinceMs = now() - lastSlotAt.get(id);
    if (AUTONOMOUS_REASONS.includes(reason) && sinceMs < minCheckGapMs) {
      return { outcome: 'staggered', retryInMs: minCheckGapMs - sinceMs };
    }
    lastSlotAt.set(id, now());

    ensurePrivateDir(accounts.claudeHomeDir(id));
    const slot = slotFor(id);
    const left = await slot.read();
    // "Newer" is judged by the expiry, not by the token merely differing, and
    // that is deliberate — do not relax it to `accessToken !== accessToken`.
    // A leftover slot can hold an *older* credential than the account file (the
    // account was re-logged in through multicc's PKCE flow, which starts a new
    // token family, while a slot from the previous family was never cleared);
    // adopting that would overwrite a healthy login with a dead one. The
    // rotation case this branch exists for is not lost by the comparison: the
    // CLI only rotates inside its own ~5 minute window, so a rotation it did
    // perform always lands an expiry well beyond the one it replaced — which is
    // what tests/test-claude-account-cli-refresh.js pins.
    if (left.ok && left.accessToken !== accessToken && left.expiresAt != null && left.expiresAt > expiresAt) {
      adopt(id, left);
      await slot.remove();
      logger.info('claude_account_cli_refresh_recovered', { accountId: id });
      return { outcome: 'recovered' };
    }
    const seeded = await slot.write({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt,
        scopes: Array.isArray(data.scopes) && data.scopes.length ? data.scopes : [...DEFAULT_SCOPES],
        subscriptionType: data.subscription_type || null,
      },
    });
    if (!seeded) return { outcome: 'slot_write_failed' };

    let result;
    try { result = (await refresher.check(reason)) || {}; } catch (error) { result = { outcome: 'failed', error: error.message }; }
    const after = await slot.read();
    // Same expiry-based "newer" test as above, and safe here for a stronger
    // reason: this slot was seeded with the account's own token moments ago, so
    // anything else in it is this run's rotation, and a rotation the CLI agreed
    // to always carries a longer expiry (it waits for its own window).
    if (after.ok && after.accessToken !== accessToken && after.expiresAt != null && after.expiresAt > expiresAt) {
      adopt(id, after);
      await slot.remove();
      logger.info('claude_account_cli_refreshed', { accountId: id, step: result.step || null, reason });
      return { outcome: 'refreshed', step: result.step || null };
    }
    // Unrotated: leave nothing behind. A slot whose refresh token moved but
    // could not be adopted is kept — it is the only copy of the new token.
    if (!after.ok || after.refreshToken === refreshToken) await slot.remove();
    return { outcome: result.outcome || 'failed', detail: result.detail || null };
  }

  // Config dirs whose account was deleted outside deleteClaudeAccount (or a
  // crash between the two removals): drop the dir and its Keychain slot.
  async function sweepOrphans() {
    const base = path.join(accounts.root, 'claude');
    let names = [];
    try { names = fs.readdirSync(base); } catch (_) { return; }
    for (const name of names) {
      const m = /^([a-f0-9]{16})\.home$/.exec(name);
      if (!m || fs.existsSync(path.join(base, `${m[1]}.json`))) continue;
      try { await createCliCredentialSlot({ configDir: path.join(base, name), platform, run, user }).remove(); } catch (_) {}
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    }
  }

  async function checkAll(reason = 'periodic') {
    if (!isEnabled()) return [];
    let list = [];
    try { list = accounts.listClaudeAccounts(); } catch (_) { return []; }
    const results = [];
    for (const account of list) {
      if (!account.loggedIn) continue;
      try {
        const r = await exclusive(account.id, () => checkAccount(account.id, reason));
        results.push({ accountId: account.id, ...r });
      } catch (error) {
        logger.warn('claude_account_cli_refresh_check_failed', { accountId: account.id, error: error.message });
      }
    }
    for (const id of [...refreshers.keys()]) if (!list.some(a => a.id === id)) refreshers.delete(id);
    for (const id of [...lastSlotAt.keys()]) if (!list.some(a => a.id === id)) lastSlotAt.delete(id);
    try { await sweepOrphans(); } catch (_) {}
    return results;
  }

  function status(id) {
    const refresher = refreshers.get(id);
    // lastCheckAt is the spacing gate's own state, surfaced so "why was this
    // account skipped?" is answerable without reading the logs.
    return refresher ? { ...refresher.status(), lastCheckAt: lastSlotAt.get(id) || null } : null;
  }

  const tick = reason => checkAll(reason).catch(error => logger.warn('claude_account_cli_refresh_failed', { error: error.message }));

  return Object.freeze({
    checkAll,
    checkAccount: (id, reason = 'manual') => exclusive(id, () => checkAccount(id, reason)),
    exclusive,
    status,
    start() {
      if (timer) return;
      // The tick is a sub-step of the cadence, not the cadence itself — see
      // TICKS_PER_CADENCE. Jittered once per process start (DEFAULT_JITTER_RATIO)
      // so a restart cannot restore a fixed phase, for this loop or for anything
      // else watching the same accounts.
      const step = Math.max(5_000, Math.round(intervalMs / TICKS_PER_CADENCE));
      timer = setInterval(() => tick('periodic'), jitteredIntervalMs(step, jitterRatio, random()));
      if (timer.unref) timer.unref();
      setTimeout(() => tick('boot'), 10_000).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  });
}

module.exports = {
  createClaudeAccountRefreshSupervisor,
  createCliCredentialSlot,
  jitteredIntervalMs,
  accountPhaseMs,
  keychainServiceFor,
  keychainAccount,
  DEFAULT_SCOPES,
  DEFAULT_MIN_CHECK_GAP_MS,
  DEFAULT_JITTER_RATIO,
};

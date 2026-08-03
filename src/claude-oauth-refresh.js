'use strict';

// An expired `Claude Code-credentials` entry is a self-inflicted outage. The
// provider router reads that entry to speak official OAuth and is deliberately
// read-only on it — writing would race the CLI over a credential neither side
// owns alone — so once the access token lapses every claude turn fails with
//
//   502 cpr: official OAuth unavailable — OAuth token expired —
//       run `claude` once to refresh the Keychain
//
// and the documented cure is a human running the CLI. This runtime is that
// human. It watches the expiry and, shortly before the token lapses, runs the
// claude CLI itself so the CLI performs its own refresh and rewrites its own
// entry. The writer is still the CLI; multicc only decides *when* it runs, so
// the router's read-only stance and the CLI's cross-process refresh lock both
// keep holding.
//
// Two things follow from that division of labour:
//   - Success is never inferred from an exit code. The CLI can exit 0 having
//     done nothing; the credential store is the only ground truth, so every
//     attempt is judged by re-reading it.
//   - Which CLI invocation triggers a refresh is a private detail of the CLI,
//     so the attempt escalates: the cheap `auth status` first, then a real
//     authenticated turn, which cannot avoid the token path. Verification after
//     each rung is what makes guessing safe.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildChildEnv } = require('./providers');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// Start trying well before the token dies, because the CLI keeps its own idea
// of when a refresh is due and will simply decline until then. Attempts inside
// this window are expected to be declined; they cost one cheap subcommand each.
const DEFAULT_BUFFER_MS = 15 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
// The expensive rung is held back until the token is nearly dead, where the CLI
// cannot decline: a turn needs a valid access token, so it must refresh to run.
const DEFAULT_PROBE_THRESHOLD_MS = 2 * 60 * 1000;
// A genuine failure usually means the CLI itself cannot recover (network down,
// dead refresh token). Backing off keeps a broken state from spawning a CLI
// every check, while staying short enough to catch a transient failure.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
// A declined attempt is not a failure — the token is still valid and the CLI
// simply disagrees that it is due yet. Retry soon, but not on every check.
const DEFAULT_DEFER_COOLDOWN_MS = 90_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// Narrow on purpose. This decides whether an API error is worth spawning a CLI
// for, so it matches the router's own expired-credential wording and nothing
// else — an ordinary 401 from a third-party provider must not trigger a refresh
// of a credential that provider never used.
const EXPIRED_OAUTH_PATTERN =
  /official OAuth unavailable|OAuth token expired|refresh the Keychain|no OAuth credentials/i;

function looksLikeExpiredOAuth(message) {
  return EXPIRED_OAUTH_PATTERN.test(String(message || ''));
}

function parseCredentials(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_) {
    return { ok: false, reason: 'unparsable' };
  }
  const oauth = parsed && typeof parsed === 'object' ? parsed.claudeAiOauth : null;
  if (!oauth || typeof oauth !== 'object') return { ok: false, reason: 'no_oauth_entry' };
  const expiresAt = Number(oauth.expiresAt);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'no_expiry' };
  const refreshExpiresAt = Number(oauth.refreshTokenExpiresAt);
  return {
    ok: true,
    expiresAt,
    refreshExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : null,
    hasRefreshToken: !!oauth.refreshToken,
    subscriptionType: String(oauth.subscriptionType || '') || null,
  };
}

function defaultRun(file, args, { timeoutMs, cwd, env } = {}) {
  return new Promise(resolve => {
    execFile(file, args, {
      cwd,
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(error && error.killed),
        error: error ? error.message : null,
      });
    });
  });
}

function createClaudeOAuthRefresher(options = {}) {
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (file => fs.promises.readFile(file, 'utf8'));
  const platform = options.platform || process.platform;
  const claudeBin = options.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const model = options.model || process.env.CLAUDE_OAUTH_REFRESH_MODEL || 'haiku';
  // A scratch cwd keeps the probe from loading this repo's CLAUDE.md, hooks and
  // plugins — none of which have anything to do with refreshing a token.
  const cwd = options.cwd || os.tmpdir();
  const credentialsFile = options.credentialsFile
    || path.join(os.homedir(), '.claude', '.credentials.json');
  const bufferMs = Number(options.bufferMs) > 0 ? Number(options.bufferMs) : DEFAULT_BUFFER_MS;
  const probeThresholdMs = Number(options.probeThresholdMs) >= 0
    ? Number(options.probeThresholdMs) : DEFAULT_PROBE_THRESHOLD_MS;
  const cooldownMs = Number(options.cooldownMs) >= 0 ? Number(options.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const deferCooldownMs = Number(options.deferCooldownMs) >= 0
    ? Number(options.deferCooldownMs) : DEFAULT_DEFER_COOLDOWN_MS;
  const commandTimeoutMs = Number(options.commandTimeoutMs) > 0
    ? Number(options.commandTimeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
  const isEnabled = typeof options.isEnabled === 'function'
    ? options.isEnabled
    : (() => process.env.CLAUDE_OAUTH_AUTO_REFRESH !== '0');

  const state = {
    inFlight: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    retryAfter: 0,
    consecutiveFailures: 0,
    refreshCount: 0,
  };

  // The child must reach the official endpoint with the user's login: any
  // inherited ANTHROPIC_* routing (a per-session provider, a cc-switch leftover)
  // would send the probe somewhere that never touches the OAuth credential.
  // buildChildEnv already owns that strip for a provider-less claude session.
  function childEnv() {
    if (typeof options.buildEnv === 'function') return options.buildEnv();
    const built = buildChildEnv(process.env, { cli: 'claude', provider: null });
    const env = { ...built.env };
    // An externally supplied OAuth token bypasses the credential store entirely,
    // which would make the probe succeed without refreshing anything.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return env;
  }

  async function readCredentials() {
    if (platform === 'darwin') {
      const result = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        timeoutMs: 10_000,
      });
      if (result.code === 0) {
        const parsed = parseCredentials(result.stdout);
        if (parsed.ok) return { ...parsed, store: 'keychain' };
      }
    }
    // Non-macOS installs, and macOS installs whose keychain entry is missing,
    // keep the same JSON on disk. Reading it costs nothing and keeps the
    // "is a refresh due" question answerable on every platform.
    try {
      const parsed = parseCredentials(await readFile(credentialsFile));
      if (parsed.ok) return { ...parsed, store: 'file' };
      return { ok: false, reason: parsed.reason, store: 'file' };
    } catch (_) {
      return { ok: false, reason: 'unreadable', store: platform === 'darwin' ? 'keychain' : 'file' };
    }
  }

  // Split from refresh() so the decision is inspectable on its own: every
  // outcome below is a fact about the credential, not about the CLI run.
  function assess(credentials, ts) {
    if (!credentials.ok) return { due: false, outcome: 'no-credentials', detail: credentials.reason };
    if (credentials.refreshExpiresAt && credentials.refreshExpiresAt <= ts) {
      // No CLI invocation can rescue this — the refresh token itself is gone
      // and the user has to log in again. Spawning would only burn cycles.
      return { due: false, outcome: 'needs-login', detail: 'refresh_token_expired' };
    }
    if (!credentials.hasRefreshToken) {
      return { due: false, outcome: 'needs-login', detail: 'no_refresh_token' };
    }
    if (credentials.expiresAt - ts > bufferMs) {
      return { due: false, outcome: 'fresh', detail: null };
    }
    return { due: true, outcome: 'due', detail: null };
  }

  function refreshed(before, after, ts) {
    if (!after.ok) return false;
    // Either the CLI moved the expiry forward, or another process did while we
    // were running — both leave a usable token, which is all that was asked for.
    return after.expiresAt > before.expiresAt || after.expiresAt - ts > bufferMs;
  }

  const LADDER = [
    // Cheap, quota-free and side-effect free. Whether it refreshes is a CLI
    // implementation detail, so it is tried first and verified, not trusted.
    { step: 'auth-status', ready: () => true, args: () => ['auth', 'status', '--json'] },
    // A real turn cannot avoid acquiring a valid access token, which is exactly
    // the path that refreshes — but it costs a request, so it is withheld until
    // the token is close enough to dead that the CLI can no longer decline.
    {
      step: 'authenticated-probe',
      ready: (credentials, ts) => credentials.expiresAt - ts <= probeThresholdMs,
      args: () => [
        '-p', 'ok',
        '--max-turns', '1',
        '--model', model,
        '--strict-mcp-config',
        '--no-session-persistence',
      ],
    },
  ];

  async function attempt(reason) {
    const startedAt = now();
    state.lastAttemptAt = startedAt;
    const before = await readCredentials();
    const decision = assess(before, startedAt);
    // The credential decides whether a CLI runs — nothing else does, not even a
    // forced call. A fresh token needs no refresh, and a dead refresh token
    // cannot be revived by any invocation, so spawning would be pure noise.
    if (!decision.due) {
      // A usable token is the end state this runtime exists to produce — reached
      // here by any means, including another process, it clears the backoff.
      if (decision.outcome === 'fresh') {
        state.consecutiveFailures = 0;
        state.retryAfter = 0;
      }
      else logger.warn('claude_oauth_refresh_skipped', { outcome: decision.outcome, detail: decision.detail, reason });
      state.lastOutcome = { outcome: decision.outcome, detail: decision.detail, at: startedAt, reason };
      return state.lastOutcome;
    }

    const env = childEnv();
    const steps = [];
    for (const rung of LADDER) {
      if (!rung.ready(before, now())) {
        steps.push({ step: rung.step, skipped: 'not_due_yet' });
        continue;
      }
      const result = await run(claudeBin, rung.args(), { timeoutMs: commandTimeoutMs, cwd, env });
      const after = await readCredentials();
      const ok = refreshed(before, after, now());
      steps.push({ step: rung.step, code: result.code, timedOut: !!result.timedOut, refreshed: ok });
      if (ok) {
        state.lastSuccessAt = now();
        state.consecutiveFailures = 0;
        state.retryAfter = 0;
        state.refreshCount += 1;
        state.lastOutcome = {
          outcome: 'refreshed',
          step: rung.step,
          reason,
          at: state.lastSuccessAt,
          expiresAt: after.expiresAt,
          store: after.store,
          elapsedMs: state.lastSuccessAt - startedAt,
        };
        logger.info('claude_oauth_refreshed', {
          step: rung.step, reason, store: after.store,
          validForMs: after.expiresAt - state.lastSuccessAt,
          elapsedMs: state.lastOutcome.elapsedMs,
        });
        return state.lastOutcome;
      }
    }
    // Nothing refreshed. Whether that is a problem depends entirely on whether
    // the credential still works: a valid token means the CLI merely disagrees
    // that a refresh is due yet, which is the expected answer for most of the
    // buffer window and must not be logged or backed off like a fault. Only a
    // token that is already dead and stayed dead is a real failure.
    const ts = now();
    const declined = before.expiresAt > ts;
    state.lastOutcome = declined
      ? { outcome: 'deferred', reason, at: ts, steps, expiresInMs: before.expiresAt - ts }
      : { outcome: 'failed', reason, at: ts, steps, consecutiveFailures: state.consecutiveFailures + 1 };
    if (declined) {
      state.retryAfter = ts + deferCooldownMs;
      logger.info('claude_oauth_refresh_deferred', { reason, expiresInMs: before.expiresAt - ts });
    } else {
      state.consecutiveFailures += 1;
      state.retryAfter = ts + cooldownMs;
      logger.error('claude_oauth_refresh_failed', {
        reason, steps, consecutiveFailures: state.consecutiveFailures,
      });
    }
    return state.lastOutcome;
  }

  // Single-flight: the CLI holds a cross-process refresh lock, so a second
  // concurrent run would either contend for it or do redundant work. Callers
  // (the periodic check and the reactive API-error hook) share one attempt.
  // `force` waives the failure backoff — for an operator asking directly — and
  // nothing else; whether a CLI actually runs is still the credential's call.
  function refresh({ reason = 'manual', force = false } = {}) {
    if (!isEnabled()) return Promise.resolve({ outcome: 'disabled', reason });
    if (state.inFlight) return state.inFlight;
    const ts = now();
    if (!force && state.retryAfter && ts < state.retryAfter) {
      return Promise.resolve({ outcome: 'cooldown', reason, retryInMs: state.retryAfter - ts });
    }
    const running = attempt(reason)
      .catch(error => {
        state.consecutiveFailures += 1;
        state.retryAfter = now() + cooldownMs;
        logger.error('claude_oauth_refresh_error', { reason, error: error.message });
        return { outcome: 'failed', reason, error: error.message };
      })
      .finally(() => { state.inFlight = null; });
    state.inFlight = running;
    return running;
  }

  // Periodic entry point. Reading the credential is cheap enough to do often;
  // spawning only happens once the expiry is actually inside the buffer.
  function check(reason = 'periodic') {
    return refresh({ reason });
  }

  // Reactive entry point: a turn already failed on an expired credential, so
  // the buffer is moot — but the message must actually be about that credential.
  function onApiError(decision) {
    const error = decision && decision.error;
    if (!error || !looksLikeExpiredOAuth(error.sanitizedMessage)) return null;
    return refresh({ reason: 'api-error' });
  }

  function status() {
    return {
      enabled: isEnabled(),
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastOutcome: state.lastOutcome,
      retryAfter: state.retryAfter || null,
      consecutiveFailures: state.consecutiveFailures,
      refreshCount: state.refreshCount,
      inFlight: !!state.inFlight,
    };
  }

  return { check, refresh, onApiError, status, readCredentials, assess };
}

module.exports = {
  createClaudeOAuthRefresher,
  looksLikeExpiredOAuth,
  parseCredentials,
  KEYCHAIN_SERVICE,
  DEFAULT_CHECK_INTERVAL_MS,
};

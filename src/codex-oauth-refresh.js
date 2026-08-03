'use strict';

// The default `~/.codex/auth.json` holds a ChatGPT OAuth login whose access
// token is a one-hour JWT with a rotating, single-use refresh token. Every
// provider-less codex session shares that file, and every turn spawns a fresh
// `codex exec` — so the first turn after the access token lapses tries to
// rotate the refresh token, and concurrent turns race for the same single-use
// token:
//
//   Your access token could not be refreshed because your refresh token was
//   already used. Please log out and sign in again.
//
// Keeping the access token perpetually fresh removes the race: a turn that
// never has to refresh can never lose the rotation. This runtime is the
// background refresher. The codex CLI stays the sole writer of auth.json;
// multicc only decides *when* it runs, and never trusts an exit code — every
// attempt is judged by re-reading auth.json afterwards.
//
// The expiry is read from the access token's JWT `exp` claim, so "is a
// refresh due" is answerable without any network round trip.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildChildEnv } = require('./providers');

// Start trying well before the one-hour token dies: turns arriving inside the
// buffer then find an already-fresh token and never touch the refresh path.
const DEFAULT_BUFFER_MS = 15 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
// The expensive rung (a real one-turn probe) is held back until the token is
// nearly dead, where codex cannot avoid refreshing to run the turn at all.
const DEFAULT_PROBE_THRESHOLD_MS = 2 * 60 * 1000;
// A genuine failure usually means the refresh token itself is dead (rotated
// away by a race multicc did not run). Back off hard: no invocation revives a
// consumed refresh token, only `codex login` does.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
// A declined attempt — the token still works, codex simply did not refresh —
// is not a failure. Retry soon, but not on every check.
const DEFAULT_DEFER_COOLDOWN_MS = 90_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// Narrow on purpose: this decides whether an API error is worth spawning the
// codex CLI for. Generic 401s from third-party providers must not trigger a
// refresh of a ChatGPT login those providers never use — onApiError also
// requires the failing CLI to be codex itself.
const CODEX_AUTH_FAILURE_PATTERN =
  /refresh token was already used|log out and sign in|failed to refresh token|authentication expired|not logged in|no login found/i;

function looksLikeCodexAuthFailure(message) {
  return CODEX_AUTH_FAILURE_PATTERN.test(String(message || ''));
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

function parseCodexAuth(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_) {
    return { ok: false, reason: 'unparsable' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'unparsable' };
  if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY) {
    // API-key auth has nothing to refresh; read as healthy so the check is a
    // quiet no-op instead of a recurring warning.
    return { ok: false, reason: 'api_key_mode' };
  }
  const tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : null;
  if (!tokens || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    return { ok: false, reason: 'no_refresh_token' };
  }
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  // An unparseable access token is treated as expired: codex itself would try
  // to refresh before running anything with it, so due=true is the safe read.
  const expiresAt = jwtExpMs(accessToken) || 0;
  const lastRefreshAt = Date.parse(String(parsed.last_refresh || ''));
  return {
    ok: true,
    expiresAt,
    accessToken,
    hasRefreshToken: true,
    lastRefreshAt: Number.isFinite(lastRefreshAt) ? lastRefreshAt : null,
  };
}

function defaultRun(file, args, { timeoutMs, cwd, env, input } = {}) {
  return new Promise(resolve => {
    execFile(file, args, {
      cwd,
      env,
      input,
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

// The probe must reach the official endpoint with the user's ChatGPT login:
// an inherited OPENAI_API_KEY or OPENAI_BASE_URL would let it succeed without
// touching auth.json, and an inherited CODEX_HOME would aim it at a
// per-provider home instead of the shared default one.
function stripOpenAiEnv(env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^OPENAI_[A-Z0-9_]*$/.test(key) || key === 'CODEX_HOME') delete cleaned[key];
  }
  return cleaned;
}

function createCodexOAuthRefresher(options = {}) {
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (file => fs.promises.readFile(file, 'utf8'));
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  // A scratch cwd keeps the probe from loading this repo's AGENTS.md and
  // config — none of which have anything to do with refreshing a token.
  const cwd = options.cwd || os.tmpdir();
  const authFile = options.authFile || path.join(os.homedir(), '.codex', 'auth.json');
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
    : (() => process.env.CODEX_OAUTH_AUTO_REFRESH !== '0');

  const state = {
    inFlight: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    retryAfter: 0,
    consecutiveFailures: 0,
    refreshCount: 0,
  };

  function childEnv() {
    if (typeof options.buildEnv === 'function') return options.buildEnv();
    const built = buildChildEnv(process.env, { cli: 'codex', provider: null });
    return stripOpenAiEnv(built.env);
  }

  async function readCredentials() {
    try {
      return { ...parseCodexAuth(await readFile(authFile)), store: 'file' };
    } catch (_) {
      return { ok: false, reason: 'unreadable', store: 'file' };
    }
  }

  function assess(credentials, ts) {
    if (!credentials.ok) {
      if (credentials.reason === 'api_key_mode') {
        return { due: false, outcome: 'fresh', detail: 'api_key_mode' };
      }
      return { due: false, outcome: 'no-credentials', detail: credentials.reason };
    }
    if (credentials.expiresAt - ts > bufferMs) {
      return { due: false, outcome: 'fresh', detail: null };
    }
    return { due: true, outcome: 'due', detail: null };
  }

  function refreshed(before, after, ts) {
    if (!after.ok) return false;
    // The CLI moved the expiry forward, rotated the access token, or another
    // process refreshed while we were running — all leave a usable token.
    return after.expiresAt > before.expiresAt
      || after.expiresAt - ts > bufferMs
      || (!!after.accessToken && after.accessToken !== before.accessToken);
  }

  const LADDER = [
    // Cheap and side-effect free. Whether it refreshes is a CLI detail, so it
    // is tried first and verified against auth.json, not trusted.
    { step: 'login-status', ready: () => true, args: () => ['login', 'status'] },
    // A real turn cannot avoid acquiring a valid access token, which is the
    // path that refreshes — but it costs a request, so it is withheld until
    // the token is close enough to dead that codex can no longer decline.
    // No MCP is injected: the probe exists only to exercise the token path.
    {
      step: 'authenticated-probe',
      ready: (credentials, ts) => credentials.expiresAt - ts <= probeThresholdMs,
      args: () => [
        'exec', '--json', '--skip-git-repo-check',
        '-c', 'model_reasoning_effort="minimal"',
        '回复ok',
      ],
    },
  ];

  async function attempt(reason) {
    const startedAt = now();
    state.lastAttemptAt = startedAt;
    const before = await readCredentials();
    const decision = assess(before, startedAt);
    // The credential decides whether a CLI runs — nothing else does, not even
    // a forced call. A fresh token needs no refresh, and an API-key home has
    // nothing to refresh, so spawning would be pure noise.
    if (!decision.due) {
      if (decision.outcome === 'fresh') {
        state.consecutiveFailures = 0;
        state.retryAfter = 0;
      }
      else logger.warn('codex_oauth_refresh_skipped', { outcome: decision.outcome, detail: decision.detail, reason });
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
      // input:'' closes stdin immediately — `codex exec` otherwise waits for
      // more input and hangs the whole attempt until the kill timeout.
      const result = await run(codexBin, rung.args(), { timeoutMs: commandTimeoutMs, cwd, env, input: '' });
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
          elapsedMs: state.lastSuccessAt - startedAt,
        };
        logger.info('codex_oauth_refreshed', {
          step: rung.step, reason,
          validForMs: after.expiresAt - state.lastSuccessAt,
          elapsedMs: state.lastOutcome.elapsedMs,
        });
        return state.lastOutcome;
      }
    }
    // Nothing refreshed. A still-valid token means codex merely disagrees a
    // refresh is due — the expected answer inside the buffer window. Only a
    // token that is already dead and stayed dead is a real failure; that
    // almost always means the single-use refresh token was rotated away and
    // the user must run `codex login` once.
    const ts = now();
    const declined = before.expiresAt > ts;
    state.lastOutcome = declined
      ? { outcome: 'deferred', reason, at: ts, steps, expiresInMs: before.expiresAt - ts }
      : { outcome: 'failed', reason, at: ts, steps, consecutiveFailures: state.consecutiveFailures + 1 };
    if (declined) {
      state.retryAfter = ts + deferCooldownMs;
      logger.info('codex_oauth_refresh_deferred', { reason, expiresInMs: before.expiresAt - ts });
    } else {
      state.consecutiveFailures += 1;
      state.retryAfter = ts + cooldownMs;
      logger.error('codex_oauth_refresh_failed', {
        reason, steps, consecutiveFailures: state.consecutiveFailures,
      });
    }
    return state.lastOutcome;
  }

  // Single-flight: concurrent callers share one attempt so the CLI's own
  // cross-process refresh path is never contended — contending over the
  // single-use refresh token is exactly the outage this runtime exists to
  // prevent. `force` waives the failure backoff and nothing else.
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
        logger.error('codex_oauth_refresh_error', { reason, error: error.message });
        return { outcome: 'failed', reason, error: error.message };
      })
      .finally(() => { state.inFlight = null; });
    state.inFlight = running;
    return running;
  }

  function check(reason = 'periodic') {
    return refresh({ reason });
  }

  // Reactive entry point: a codex turn already failed on auth. The wording
  // must match and the failing CLI must be codex — a third-party 401 must not
  // refresh a ChatGPT login it never used.
  function onApiError(decision) {
    const error = decision && decision.error;
    if (!error || !looksLikeCodexAuthFailure(error.sanitizedMessage)) return null;
    if (error.provider && !/codex/i.test(String(error.provider))) return null;
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
  createCodexOAuthRefresher,
  looksLikeCodexAuthFailure,
  parseCodexAuth,
  stripOpenAiEnv,
  DEFAULT_CHECK_INTERVAL_MS,
};

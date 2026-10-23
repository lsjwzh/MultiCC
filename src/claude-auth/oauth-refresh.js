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

const { buildChildEnv } = require('../providers/core');
const { planClaudeExpiredRefresh } = require('./expired-refresh-policy');

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
// A fixed ten-minute retry is a scheduler, not a policy: a credential that can
// never be refreshed is knocked on forever (one account was retried every
// twelve minutes for thirteen days). Failures therefore back off exponentially
// to this ceiling...
const DEFAULT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// ...and a run of failures — or a single explicit server-side rejection —
// stops the ladder entirely until the credential itself changes.
const DEFAULT_PARK_AFTER_FAILURES = 6;
// Both rungs of the ladder cost a process; the second costs an actual API turn.
// One expired token is one event, so it gets one small, fixed budget: a couple
// of "is it due yet" questions, and two normal turns. Rust separately reserves
// one post-expiry opportunity if both were spent while the token was live.
// Without a budget
// the ladder re-asked every cooldown with the same answer and, over three days,
// issued 413 identical `claude -p ok` turns — the pattern a human would never
// produce, and the reason this module must never be allowed to behave like a
// poller.
const DEFAULT_MAX_DECLINES_PER_WINDOW = 2;
const DEFAULT_MAX_PROBES_PER_WINDOW = 2;

// Narrow on purpose. This decides whether an API error is worth spawning a CLI
// for, so it matches the router's own expired-credential wording and nothing
// else — an ordinary 401 from a third-party provider must not trigger a refresh
// of a credential that provider never used.
const EXPIRED_OAUTH_PATTERN =
  /official OAuth unavailable|OAuth token expired|refresh the Keychain|no OAuth credentials/i;

// Revocation is the opposite problem to expiry, and demands the opposite
// reaction. An expired access token is repaired by running the CLI — that is
// the whole point of this module. A revoked token family is already dead
// server-side, so every invocation fails identically and a refresh attempt can
// only burn a cooldown and hide the fact that a human must log in. Named
// separately so callers can park the account instead of retrying it.
const REVOKED_OAUTH_PATTERN =
  /oauth token revoked|token (?:has been |was )?revoked|credentials? (?:have been |were )?revoked/i;

// What the CLI said when a rung failed. Exit codes alone cannot tell a dead
// account from a dead network, and the difference decides whether retrying is
// useful at all: a rejected token never becomes valid again by waiting.
const REJECTED_FAILURE_PATTERN =
  /invalid_grant|access_denied|unsupported_country|not allowed|revoked|forbidden|unauthorized|authentication_error|\b401\b/i;
const NETWORK_FAILURE_PATTERN =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|\bTLS\b|proxy/i;

// stderr can carry a URL with a token in it; nothing here needs the value, and
// the health file is meant to be safe to read aloud when diagnosing.
function redactCliOutput(text, limit = 400) {
  const raw = String(text || '');
  const cleaned = raw
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_.-]{16,}|[A-Za-z0-9_-]{40,}={0,2})/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

// A fingerprint that changes when the credential is replaced — a fresh login
// writes a newer expiry, which is exactly the event that makes a parked
// account worth trying again. It deliberately does not hash the token itself:
// refresh-health.js stores this value on disk.
function credentialFingerprint(credentials) {
  if (!credentials || !credentials.ok) return null;
  return `${credentials.expiresAt}|${credentials.refreshExpiresAt || ''}|${credentials.hasRefreshToken ? 1 : 0}`;
}

function classifyFailure(steps) {
  // Only rungs that actually failed say anything about the credential. A
  // successful-but-declined `auth status` prints its normal state JSON, which
  // must not be mined for words like "401".
  const text = (Array.isArray(steps) ? steps : [])
    .filter(step => step && (step.timedOut || step.code === undefined || step.code !== 0))
    .map(step => `${step.stderr || ''} ${step.stdout || ''}`)
    .join(' ');
  if (!text.trim()) return 'unknown';
  if (REJECTED_FAILURE_PATTERN.test(text)) return 'rejected';
  if (NETWORK_FAILURE_PATTERN.test(text)) return 'network';
  return 'unknown';
}

function looksLikeExpiredOAuth(message) {
  return EXPIRED_OAUTH_PATTERN.test(String(message || ''));
}

function looksLikeRevokedOAuth(message) {
  return REVOKED_OAUTH_PATTERN.test(String(message || ''));
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

// `claude auth status --json` is the CLI's own verdict on whether it holds a
// login at all. The ladder used to look only at the exit code and at whether
// the credential changed, which cannot tell a healthy token that is not due yet
// from a CLI with no login whatsoever — both are "exit 0, nothing changed". The
// difference decides everything: one means wait, the other means a human has to
// log in and no amount of probing will help. When the field is absent (older
// CLIs print prose), the caller falls back to its previous judgement.
function parseAuthStatus(result) {
  const text = String((result && result.stdout) || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.loggedIn !== 'boolean') return null;
    return {
      loggedIn: parsed.loggedIn,
      authMethod: String(parsed.authMethod || '') || null,
    };
  } catch (_) {
    return null;
  }
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
  // Per-account refreshers (accounts-refresh.js) point the CLI at another
  // CLAUDE_CONFIG_DIR, whose Keychain entry carries a path-hash suffix.
  const keychainService = options.keychainService || KEYCHAIN_SERVICE;
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
  // Optional durable health (claude-auth/refresh-health.js). Without it the
  // behaviour degrades to the old in-memory one — including forgetting a park
  // on restart — which is why every production wiring passes it.
  const health = options.health && typeof options.health.read === 'function' ? options.health : null;
  const healthKey = options.healthKey || null;
  const maxCooldownMs = Number(options.maxCooldownMs) > 0
    ? Number(options.maxCooldownMs) : DEFAULT_MAX_COOLDOWN_MS;
  const parkAfterFailures = Number(options.parkAfterFailures) > 0
    ? Number(options.parkAfterFailures) : DEFAULT_PARK_AFTER_FAILURES;
  const maxDeclinesPerWindow = Number(options.maxDeclinesPerWindow) > 0
    ? Number(options.maxDeclinesPerWindow) : DEFAULT_MAX_DECLINES_PER_WINDOW;
  const maxProbesPerWindow = Number(options.maxProbesPerWindow) > 0
    ? Number(options.maxProbesPerWindow) : DEFAULT_MAX_PROBES_PER_WINDOW;

  const state = {
    inFlight: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    retryAfter: 0,
    consecutiveFailures: 0,
    refreshCount: 0,
    failureClass: null,
    lastFailure: null,
    // A credential change releases a park; Rust may also admit one durable
    // post-expiry attempt for an old non-terminal park.
    parked: null,
    // Reserved durably before a real post-expiry CLI probe starts. Rust uses
    // this receipt to keep the recovery opportunity bounded across restarts.
    postExpiryAttempt: null,
    lastProbeFailure: null,
    // Spend ledger for the token currently on disk. Keyed by its expiry, so a
    // refresh opens a fresh budget. Reserve each probe durably before spawning
    // it, so a restart cannot spend the same credential's budget again.
    window: null,
  };

  function windowFor(expiresAt) {
    if (!state.window || state.window.expiresAt !== expiresAt) {
      state.window = { expiresAt, declines: 0, probes: 0 };
    }
    return state.window;
  }

  // Restore what the previous process learned. A restart used to reset every
  // counter, which is how a permanently dead account kept being retried: the
  // evidence of its death died with the process.
  if (health && healthKey) {
    const persisted = health.read(healthKey);
    if (persisted && typeof persisted === 'object') {
      state.consecutiveFailures = Number(persisted.consecutiveFailures) || 0;
      state.lastSuccessAt = Number(persisted.lastSuccessAt) || null;
      state.refreshCount = Number(persisted.refreshCount) || 0;
      state.failureClass = persisted.failureClass || null;
      state.lastFailure = persisted.lastFailure || null;
      if (persisted.postExpiryAttempt && typeof persisted.postExpiryAttempt === 'object') {
        state.postExpiryAttempt = {
          credentialExpiresAt: Number(persisted.postExpiryAttempt.credentialExpiresAt) || null,
          reservedAt: Number(persisted.postExpiryAttempt.reservedAt) || null,
        };
      }
      if (persisted.lastProbeFailure && typeof persisted.lastProbeFailure === 'object') {
        const failure = persisted.lastProbeFailure;
        if (Number.isFinite(Number(failure.credentialExpiresAt)) && failure.step && typeof failure.step === 'object') {
          state.lastProbeFailure = {
            credentialExpiresAt: Number(failure.credentialExpiresAt),
            step: {
              step: 'authenticated-probe', code: failure.step.code,
              timedOut: failure.step.timedOut === true, refreshed: false,
              stderr: redactCliOutput(failure.step.stderr), stdout: redactCliOutput(failure.step.stdout),
            },
          };
        }
      }
      if (persisted.probeWindow && typeof persisted.probeWindow === 'object'
          && Number.isFinite(Number(persisted.probeWindow.expiresAt))) {
        state.window = {
          expiresAt: Number(persisted.probeWindow.expiresAt),
          declines: Math.max(0, Number(persisted.probeWindow.declines) || 0),
          probes: Math.max(0, Number(persisted.probeWindow.probes) || 0),
        };
      }
      if (persisted.parked && typeof persisted.parked === 'object') {
        state.parked = {
          at: Number(persisted.parked.at) || null,
          reason: persisted.parked.reason || 'persisted',
          failureClass: persisted.parked.failureClass || state.failureClass,
          consecutiveFailures: Number(persisted.parked.consecutiveFailures) || state.consecutiveFailures,
          credentialFingerprint: persisted.parked.credentialFingerprint || null,
          credentialExpiresAt: Number(persisted.parked.credentialExpiresAt) || null,
        };
      }
    }
  }

  function persist(fields) {
    if (!health || !healthKey) return true;
    return health.write(healthKey, {
      consecutiveFailures: state.consecutiveFailures,
      refreshCount: state.refreshCount,
      failureClass: state.failureClass,
      lastFailure: state.lastFailure,
      lastSuccessAt: state.lastSuccessAt,
      parked: state.parked,
      postExpiryAttempt: state.postExpiryAttempt,
      lastProbeFailure: state.lastProbeFailure,
      probeWindow: state.window ? { ...state.window } : null,
      ...fields,
    }) === true;
  }

  function expiredPlan(credentials, force = false) {
    const probeFailureClass = state.lastProbeFailure?.credentialExpiresAt === credentials.expiresAt
      ? classifyFailure([state.lastProbeFailure.step]) : null;
    return planClaudeExpiredRefresh({
      now: now(),
      expiresAt: credentials.expiresAt,
      hasRefreshToken: credentials.hasRefreshToken === true,
      refreshExpiresAt: credentials.refreshExpiresAt || null,
      postExpiryAttemptedFor: state.postExpiryAttempt?.credentialExpiresAt || null,
      parked: !!state.parked,
      // A terminal response is evidence about this credential even before the
      // old decline path creates a park. Rust owns whether it forbids a probe.
      parkedFailureClass: state.parked ? state.parked.failureClass || null : probeFailureClass,
      probes: state.window?.expiresAt === credentials.expiresAt ? state.window.probes : 0,
      maxProbes: maxProbesPerWindow,
      force,
    }, logger);
  }

  function unpark(credentials, why) {
    if (!state.parked) return false;
    const before = state.parked;
    state.parked = null;
    state.retryAfter = 0;
    logger.info('claude_oauth_refresh_unparked', {
      reason: why,
      failureClass: before.failureClass,
      credentialFingerprint: credentialFingerprint(credentials),
    });
    persist({ unparkedAt: new Date(now()).toISOString() });
    return true;
  }

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
    // extraEnv: a null value removes an inherited variable.
    for (const [key, value] of Object.entries(options.extraEnv || {})) {
      if (value == null) delete env[key]; else env[key] = String(value);
    }
    return env;
  }

  async function readCredentials() {
    if (platform === 'darwin') {
      const result = await run('security', ['find-generic-password', '-s', keychainService, '-w'], {
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

  async function attempt(reason, { force = false } = {}) {
    const startedAt = now();
    state.lastAttemptAt = startedAt;
    const before = await readCredentials();
    // Reading notices a replacement credential. For unchanged credentials,
    // Rust decides whether the durable post-expiry opportunity is available.
    if (state.parked) {
      const fingerprint = credentialFingerprint(before);
      if (before.ok && fingerprint && fingerprint !== state.parked.credentialFingerprint) {
        unpark(before, 'credential_replaced');
      } else {
        const plan = expiredPlan(before, force);
        if (plan?.recoverParked) {
          const spend = windowFor(before.expiresAt);
          spend.probes = Math.max(spend.probes, plan.budgetFloor);
          // Keep the durable park until the post-expiry reservation lands.
          // A crash during auth status must not reopen a fresh probe budget.
        } else {
          state.lastOutcome = {
            // A missing login must keep its actionable banner on later ticks.
            outcome: state.parked.failureClass === 'needs-login' ? 'needs-login' : 'parked',
            detail: state.parked.failureClass,
            parkedAt: state.parked.at,
            reason,
            at: startedAt,
          };
          return state.lastOutcome;
        }
      }
    }
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
    const spend = windowFor(before.expiresAt);
    let notLoggedIn = null;
    for (const rung of LADDER) {
      if (!rung.ready(before, now())) {
        steps.push({ step: rung.step, skipped: 'not_due_yet' });
        continue;
      }
      // A probe is a real API turn. Rust admits the normal budget and the one
      // post-expiry opportunity; the bridge reserves both before spawning.
      if (rung.step === 'authenticated-probe') {
        const previousSpend = { ...spend };
        const previousAttempt = state.postExpiryAttempt;
        const plan = expiredPlan(before, force);
        if (plan) spend.probes = Math.max(spend.probes, plan.budgetFloor);
        if (plan ? !plan.allowProbe : (!force && spend.probes >= maxProbesPerWindow)) {
          steps.push({ step: rung.step, skipped: 'budget_spent' });
          continue;
        }
        if (plan?.reservePostExpiry) {
          state.postExpiryAttempt = { credentialExpiresAt: before.expiresAt, reservedAt: now() };
        }
        spend.probes += 1;
        if (!persist()) {
          Object.assign(spend, previousSpend);
          state.postExpiryAttempt = previousAttempt;
          state.lastOutcome = { outcome: 'failed', detail: 'refresh_health_write_failed', reason, at: now(), steps };
          logger.warn('claude_oauth_refresh_reservation_failed', { reason, action: 'CLI probe was not started' });
          return state.lastOutcome;
        }
        if (plan?.recoverParked) unpark(before, 'post_expiry_retry');
      }
      const result = await run(claudeBin, rung.args(), { timeoutMs: commandTimeoutMs, cwd, env });
      const after = await readCredentials();
      const ok = refreshed(before, after, now());
      // The exit code alone was the whole record of a failure; it cannot tell a
      // revoked login from a broken network, which is the first question asked
      // after the fact. Capture the CLI's own words, redacted and truncated.
      const step = { step: rung.step, code: result.code, timedOut: !!result.timedOut, refreshed: ok };
      if (!ok && (result.stderr || result.stdout)) {
        step.stderr = redactCliOutput(result.stderr);
        if (!step.stderr && result.stdout) step.stdout = redactCliOutput(result.stdout);
      }
      steps.push(step);
      if (rung.step === 'authenticated-probe' && !ok && (step.timedOut || step.code !== 0)) {
        state.lastProbeFailure = { credentialExpiresAt: before.expiresAt, step: { ...step } };
        persist();
      }
      if (ok) {
        state.lastSuccessAt = now();
        state.consecutiveFailures = 0;
        state.retryAfter = 0;
        state.failureClass = null;
        state.lastFailure = null;
        state.lastProbeFailure = null;
        state.parked = null;
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
        persist({ credentialFingerprint: credentialFingerprint(after) });
        return state.lastOutcome;
      }
      // The CLI's own answer outranks the exit code. "Not logged in" is
      // terminal: escalating to a turn cannot authenticate either, and asking
      // again on the next tick is exactly the behaviour this module must not
      // have. Stop the ladder here and park on it.
      if (rung.step === 'auth-status') {
        const verdict = parseAuthStatus(result);
        if (verdict && !verdict.loggedIn) { notLoggedIn = verdict; break; }
      }
    }

    if (notLoggedIn) {
      const ts = now();
      state.parked = {
        at: ts,
        reason,
        failureClass: 'needs-login',
        consecutiveFailures: state.consecutiveFailures,
        credentialFingerprint: credentialFingerprint(before),
        credentialExpiresAt: before.ok ? before.expiresAt : null,
      };
      state.retryAfter = 0;
      state.failureClass = 'needs-login';
      state.lastFailure = {
        at: new Date(ts).toISOString(),
        failureClass: 'needs-login',
        reason,
        detail: 'cli_reports_not_logged_in',
        authMethod: notLoggedIn.authMethod,
        steps,
      };
      state.lastOutcome = {
        outcome: 'needs-login',
        reason,
        at: ts,
        detail: 'cli_reports_not_logged_in',
        authMethod: notLoggedIn.authMethod,
        steps,
      };
      logger.error('claude_oauth_refresh_parked', {
        reason,
        failureClass: 'needs-login',
        authMethod: notLoggedIn.authMethod,
        steps,
        action: 'the CLI reports no login — log in again; retries are suspended until the credential changes',
      });
      persist({ credentialFingerprint: credentialFingerprint(before) });
      return state.lastOutcome;
    }
    // Nothing refreshed. Whether that is a problem depends entirely on whether
    // the credential still works: a valid token means the CLI merely disagrees
    // that a refresh is due yet, which is the expected answer for most of the
    // buffer window and must not be logged or backed off like a fault. Only a
    // token that is already dead and stayed dead is a real failure.
    const ts = now();
    const declined = before.expiresAt > ts;
    if (declined) {
      spend.declines += 1;
      // Two questions per token is the whole budget. The third answer is the
      // first answer — the credential has not moved — so wait for the moment
      // the CLI must act (its own probe threshold) instead of asking again on
      // a timer.
      const probeAt = before.expiresAt - probeThresholdMs;
      if (!force && spend.declines >= maxDeclinesPerWindow && probeAt > ts) {
        state.retryAfter = probeAt;
        state.lastOutcome = {
          outcome: 'deferred', reason, at: ts, steps,
          expiresInMs: before.expiresAt - ts,
          nextAttemptInMs: probeAt - ts,
          declines: spend.declines,
        };
        logger.info('claude_oauth_refresh_deferred', {
          reason, expiresInMs: before.expiresAt - ts,
          nextAttemptInMs: probeAt - ts, declines: spend.declines,
          waitingForExpiry: true,
        });
        return state.lastOutcome;
      }
      state.retryAfter = ts + deferCooldownMs;
      state.lastOutcome = { outcome: 'deferred', reason, at: ts, steps, expiresInMs: before.expiresAt - ts };
      logger.info('claude_oauth_refresh_deferred', { reason, expiresInMs: before.expiresAt - ts });
      return state.lastOutcome;
    }

    // A real failure. What happens next is decided by *why* it failed: an
    // explicit rejection cannot be fixed by running the CLI again, and a
    // repeating generic failure stops being worth a spawn after a few tries.
    state.consecutiveFailures += 1;
    // A skipped probe supplies no new diagnosis. Carry the last real probe's
    // already-redacted evidence into the existing classifier, labelled as
    // historical so logs never claim that another CLI turn was performed.
    const failureSteps = [...steps];
    if (steps.some(step => step.step === 'authenticated-probe' && step.skipped === 'budget_spent')
        && state.lastProbeFailure?.credentialExpiresAt === before.expiresAt) {
      failureSteps.push({ ...state.lastProbeFailure.step, step: 'previous-authenticated-probe' });
    }
    const failureClass = classifyFailure(failureSteps);
    state.failureClass = failureClass;
    state.lastFailure = {
      at: new Date(ts).toISOString(),
      failureClass,
      reason,
      expiresInMs: before.expiresAt - ts,
      steps: failureSteps.filter(step => step.stderr || step.stdout || step.timedOut),
    };
    // Budget spent while the token stayed dead: nothing left in the ladder can
    // produce a different answer, so the remaining retries would be the exact
    // requests that already failed. A network fault is the one exception — it
    // says nothing about the credential — so it keeps its own backoff instead.
    const budgetSpent = spend.probes >= maxProbesPerWindow;
    const shouldPark = failureClass === 'rejected'
      || state.consecutiveFailures >= parkAfterFailures
      || (budgetSpent && failureClass !== 'network');
    if (shouldPark) {
      state.parked = {
        at: ts,
        reason,
        failureClass,
        consecutiveFailures: state.consecutiveFailures,
        credentialFingerprint: credentialFingerprint(before),
        // The per-account supervisor cannot read the CLI's scratch slot while
        // parked (it is only seeded inside the ladder), so it compares the
        // account file's expiry against this instead: a re-login always lands
        // a later expiry, and an untouched credential never does.
        credentialExpiresAt: before.expiresAt,
      };
      // Not a backoff: the periodic tick still reads the credential (so a
      // re-login releases the park) but spawns nothing.
      state.retryAfter = 0;
      state.lastOutcome = {
        outcome: 'parked',
        reason,
        at: ts,
        detail: failureClass,
        steps,
        consecutiveFailures: state.consecutiveFailures,
      };
      logger.error('claude_oauth_refresh_parked', {
        reason,
        failureClass,
        consecutiveFailures: state.consecutiveFailures,
        steps,
        // The operator-facing line: say what a human has to do, not how the
        // ladder failed.
        action: failureClass === 'rejected'
          ? 'credential rejected by the server — log in again; retries are suspended until the credential changes'
          : 'repeated refresh failures — retries are parked until the credential changes; run `claude` or log in again',
      });
    } else {
      // Exponential: 10m, 20m, 40m … capped. A dead network gets a few
      // chances; a dead credential spends a handful of spawns, not thousands.
      const backoffMs = Math.min(cooldownMs * 2 ** (state.consecutiveFailures - 1), maxCooldownMs);
      state.retryAfter = ts + backoffMs;
      state.lastOutcome = {
        outcome: 'failed',
        reason,
        at: ts,
        detail: failureClass,
        steps,
        consecutiveFailures: state.consecutiveFailures,
        retryInMs: backoffMs,
      };
      logger.error('claude_oauth_refresh_failed', {
        reason,
        failureClass,
        consecutiveFailures: state.consecutiveFailures,
        retryInMs: backoffMs,
        steps,
      });
    }
    persist({ credentialFingerprint: credentialFingerprint(before) });
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
    const running = attempt(reason, { force })
      .catch(error => {
        state.consecutiveFailures += 1;
        state.retryAfter = now() + Math.min(cooldownMs * 2 ** (state.consecutiveFailures - 1), maxCooldownMs);
        state.failureClass = 'harness_error';
        state.lastFailure = { at: new Date(now()).toISOString(), failureClass: 'harness_error', reason, error: error.message };
        logger.error('claude_oauth_refresh_error', { reason, error: error.message });
        persist();
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

  async function parkFromApiError(detail) {
    let credentials = { ok: false };
    try { credentials = await readCredentials(); } catch (_) { /* diagnosis, not a precondition */ }
    state.failureClass = 'rejected';
    state.parked = {
      at: now(),
      reason: 'api-error',
      failureClass: 'rejected',
      consecutiveFailures: state.consecutiveFailures,
      credentialFingerprint: credentialFingerprint(credentials),
      credentialExpiresAt: credentials.ok ? credentials.expiresAt : null,
    };
    // Release still works: the tick reads the credential and unparks when a
    // new login changes its fingerprint.
    state.retryAfter = 0;
    logger.error('claude_oauth_refresh_parked', {
      reason: 'api-error',
      failureClass: 'rejected',
      detail,
      action: 'credential rejected by the server — log in again; refreshes are suspended until the credential changes',
    });
    persist({ credentialFingerprint: credentialFingerprint(credentials) });
    return { outcome: 'needs-login', detail, reason: 'api-error' };
  }

  // Reactive entry point: a turn already failed on an expired credential, so
  // the buffer is moot — but the message must actually be about that credential.
  function onApiError(decision) {
    const error = decision && decision.error;
    if (!error) return null;
    // Answer revocation before expiry: the two patterns cannot both match, but
    // ordering makes the intent explicit. A revoked token is reported, never
    // refreshed — running the CLI here would spend a rotation on a credential
    // the server has already rejected.
    if (looksLikeRevokedOAuth(error.sanitizedMessage)) {
      // A live turn just learned the credential is server-side dead. Until
      // now that fact only stopped the provider from being re-selected; the
      // periodic ladder kept knocking on the same dead door. Park it here too.
      return parkFromApiError('token_revoked');
    }
    if (!looksLikeExpiredOAuth(error.sanitizedMessage)) return null;
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
      failureClass: state.failureClass,
      lastFailure: state.lastFailure,
      parked: state.parked || null,
      postExpiryAttempt: state.postExpiryAttempt || null,
      maxProbesPerWindow,
      // How much of this token's budget is already spent — the number that
      // explains why a check spawned nothing.
      window: state.window ? { ...state.window } : null,
      inFlight: !!state.inFlight,
    };
  }

  return { check, refresh, onApiError, status, readCredentials, assess };
}

module.exports = {
  createClaudeOAuthRefresher,
  looksLikeExpiredOAuth,
  looksLikeRevokedOAuth,
  parseCredentials,
  parseAuthStatus,
  classifyFailure,
  credentialFingerprint,
  redactCliOutput,
  KEYCHAIN_SERVICE,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_MAX_COOLDOWN_MS,
  DEFAULT_PARK_AFTER_FAILURES,
  DEFAULT_MAX_PROBES_PER_WINDOW,
};

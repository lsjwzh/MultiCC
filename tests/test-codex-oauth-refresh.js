'use strict';

// The default ~/.codex/auth.json holds a ChatGPT OAuth login with a one-hour
// JWT access token and a single-use rotating refresh token, shared by every
// provider-less codex session. Concurrent turns racing over that refresh token
// is the outage ("refresh token was already used"), and keeping the access
// token perpetually fresh is the fix. These tests pin the automation: it must
// run the CLI only when the JWT expiry says so, judge the result by
// re-reading auth.json rather than by an exit code, and never spawn anything
// for a state no CLI run can repair.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexOAuthRefresher,
  looksLikeCodexAuthFailure,
  parseCodexAuth,
  stripOpenAiEnv,
} = require('../src/codex-oauth-refresh');

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

function jwt(expiresInMs) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((T0 + expiresInMs) / 1000) })).toString('base64url');
  return `eyJh.${payload}.sig`;
}

function authJson({ expiresIn = 8 * HOUR, refreshToken = 'rt-1', accessToken, apiKey } = {}) {
  if (apiKey) return { OPENAI_API_KEY: apiKey };
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken || jwt(expiresIn),
      refresh_token: refreshToken,
    },
    last_refresh: new Date(T0).toISOString(),
  };
}

// `refreshOn` names the ladder rung whose CLI run rewrites auth.json — that
// is how a test says "login status was enough" or "only a real turn worked".
function fixture({ stored = authJson(), refreshOn = null, ...rest } = {}) {
  const store = { value: stored };
  const calls = [];
  let clock = T0;
  const refresher = createCodexOAuthRefresher({
    codexBin: '/fake/codex',
    logger: { info() {}, warn() {}, error() {} },
    buildEnv: () => ({ PATH: '/usr/bin' }),
    now: () => clock,
    readFile: async () => {
      if (!store.value) throw new Error('ENOENT');
      return JSON.stringify(store.value);
    },
    run: async (file, args, opts) => {
      calls.push({ file, args, opts });
      const step = args[0] === 'login' ? 'login-status' : 'authenticated-probe';
      if (step === refreshOn) {
        store.value = authJson({ expiresIn: 9 * HOUR, accessToken: jwt(9 * HOUR) + '.new' });
      }
      return { code: 0, stdout: 'ok' };
    },
    ...rest,
  });
  return {
    refresher,
    calls,
    store,
    advance: ms => { clock += ms; },
  };
}

test('a token with hours left is left alone — no CLI is spawned', async () => {
  const h = fixture();
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'fresh');
  assert.equal(h.calls.length, 0);
});

test('an API-key home has nothing to refresh and stays quiet', async () => {
  const h = fixture({ stored: authJson({ apiKey: 'sk-test' }) });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'fresh');
  assert.equal(result.detail, 'api_key_mode');
  assert.equal(h.calls.length, 0);
});

test('a token inside the refresh buffer is repaired by the cheapest rung that works', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 10 * 60_000 }), refreshOn: 'login-status' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.step, 'login-status');
  assert.equal(h.calls.length, 1, 'the expensive rung must not run once the cheap one worked');
  assert.deepEqual(h.calls[0].args, ['login', 'status']);
});

test('a rung that exits 0 without refreshing is not believed, and the ladder escalates', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 60_000 }), refreshOn: 'authenticated-probe' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.step, 'authenticated-probe');
  const probe = h.calls[1];
  assert.equal(probe.args[0], 'exec', 'the escalation must be a real authenticated turn');
  assert.ok(probe.args.includes('--json'));
  assert.ok(!probe.args.some(arg => /mcp_servers/.test(String(arg))),
    'no MCP servers may be injected into the probe');
  assert.equal(probe.opts.input, '', 'stdin must close or codex exec hangs waiting for input');
});

test('an already expired token still refreshes rather than waiting for a user', async () => {
  const h = fixture({ stored: authJson({ expiresIn: -HOUR }), refreshOn: 'login-status' });
  assert.equal((await h.refresher.check()).outcome, 'refreshed');
});

test('an unparseable access token reads as expired, not as healthy', () => {
  const parsed = parseCodexAuth(JSON.stringify({
    tokens: { access_token: 'not-a-jwt', refresh_token: 'rt-1' },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.expiresAt, 0);
});

// The CLI owns the write and therefore owns the "is it due yet" question. A
// declined attempt while the token still works must read as normal — otherwise
// every token cycle logs failures and burns a paid probe.
test('a decline while the token still works is deferred, not failed', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 10 * 60_000 }), refreshOn: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'deferred');
  assert.equal(h.calls.length, 1, 'only the free rung may run while the token still works');
  assert.deepEqual(result.steps.map(step => step.skipped || step.step),
    ['login-status', 'not_due_yet']);

  h.advance(10_000);
  assert.equal((await h.refresher.check()).outcome, 'cooldown', 'a decline still throttles retries');
  h.advance(120_000);
  await h.refresher.check();
  assert.equal(h.calls.length, 2, 'a short backoff, so the next attempt is soon');
});

test('a token about to die escalates to the probe, which the CLI cannot decline', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 30_000 }), refreshOn: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'deferred', 'the token is still usable for another 30s');
  assert.equal(h.calls.length, 2, 'both rungs run once expiry is imminent');
});

test('an exhausted ladder on a dead token is a real failure and backs off hard', async () => {
  const h = fixture({ stored: authJson({ expiresIn: -60_000 }), refreshOn: null });
  const failed = await h.refresher.check();
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.steps.length, 2);
  assert.equal(failed.steps.every(step => step.refreshed === false), true);

  h.advance(60_000);
  assert.equal((await h.refresher.check()).outcome, 'cooldown');
  assert.equal(h.calls.length, 2, 'the backoff must hold the CLI back');

  h.advance(30 * 60_000);
  await h.refresher.check();
  assert.equal(h.calls.length, 4, 'once the backoff lapses the repair is retried');
});

test('a missing auth.json is reported, not papered over with a CLI run', async () => {
  const h = fixture({ stored: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'no-credentials');
  assert.equal(h.calls.length, 0);
});

test('a missing refresh token means needs-login — no invocation can repair it', async () => {
  const h = fixture({ stored: { tokens: { access_token: jwt(0) } } });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'no-credentials');
  assert.equal(result.detail, 'no_refresh_token');
  assert.equal(h.calls.length, 0);
});

test('forcing waives the backoff but never the credential check', async () => {
  const h = fixture();
  const result = await h.refresher.refresh({ reason: 'manual', force: true });
  assert.equal(result.outcome, 'fresh');
  assert.equal(h.calls.length, 0, 'a fresh credential is still a reason not to spawn');
});

test('concurrent callers share one attempt so the refresh token is never raced', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 60_000 }), refreshOn: 'login-status' });
  const [a, b] = await Promise.all([h.refresher.check(), h.refresher.refresh({ reason: 'api-error' })]);
  assert.equal(a.outcome, 'refreshed');
  assert.equal(b, a, 'the second caller must join the in-flight attempt');
  assert.equal(h.calls.length, 1);
});

test('the reactive hook fires on codex auth wording and codex providers only', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 60_000 }), refreshOn: 'login-status' });
  // Generic upstream errors and non-codex providers must not trigger a refresh.
  assert.equal(h.refresher.onApiError({
    error: { sanitizedMessage: 'API Error: 500 upstream overloaded', provider: 'codex' },
  }), null);
  assert.equal(h.refresher.onApiError({
    error: {
      sanitizedMessage: 'Your access token could not be refreshed because your refresh token was already used',
      provider: 'claude',
    },
  }), null);
  assert.equal(h.calls.length, 0);

  const fired = h.refresher.onApiError({
    error: {
      sanitizedMessage: 'Your access token could not be refreshed because your '
        + 'refresh token was already used. Please log out and sign in again.',
      provider: 'codex',
    },
  });
  assert.notEqual(fired, null);
  assert.equal((await fired).outcome, 'refreshed');
});

test('the kill switch stops the runtime from spawning anything at all', async () => {
  const h = fixture({ stored: authJson({ expiresIn: 60_000 }), isEnabled: () => false });
  assert.equal((await h.refresher.check()).outcome, 'disabled');
  assert.equal(h.calls.length, 0);
});

test('the auth-failure predicate matches codex wording without over-reaching', () => {
  assert.equal(looksLikeCodexAuthFailure('refresh token was already used'), true);
  assert.equal(looksLikeCodexAuthFailure('Please log out and sign in again.'), true);
  assert.equal(looksLikeCodexAuthFailure('codex_login::auth Failed to refresh token: 401 Unauthorized'), true);
  assert.equal(looksLikeCodexAuthFailure('not logged in'), true);
  assert.equal(looksLikeCodexAuthFailure('401 invalid api key'), false);
  assert.equal(looksLikeCodexAuthFailure('rate_limit_error'), false);
  assert.equal(looksLikeCodexAuthFailure(''), false);
});

test('the probe env carries no OpenAI override that could bypass the login', () => {
  const cleaned = stripOpenAiEnv({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-x',
    OPENAI_BASE_URL: 'http://elsewhere',
    CODEX_HOME: '/some/provider/home',
    HOME: '/Users/x',
  });
  assert.equal(cleaned.OPENAI_API_KEY, undefined);
  assert.equal(cleaned.OPENAI_BASE_URL, undefined);
  assert.equal(cleaned.CODEX_HOME, undefined);
  assert.equal(cleaned.PATH, '/usr/bin');
  assert.equal(cleaned.HOME, '/Users/x');
});

test('a malformed auth.json never reads as a usable token', () => {
  assert.equal(parseCodexAuth('not json').ok, false);
  assert.equal(parseCodexAuth('{}').ok, false);
  assert.equal(parseCodexAuth('{"tokens":{}}').ok, false);
  assert.equal(parseCodexAuth(JSON.stringify(authJson())).ok, true);
});

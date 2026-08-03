'use strict';

// The provider router is read-only on the shared OAuth credential, so an expired
// access token turns every claude turn into
//   502 cpr: official OAuth unavailable — OAuth token expired
// until a human runs the CLI. These tests pin the automation that replaces the
// human: it must run the CLI only when the credential says so, judge the result
// by the credential rather than by an exit code, and never spawn anything for a
// failure it cannot repair.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createClaudeOAuthRefresher,
  looksLikeExpiredOAuth,
  parseCredentials,
} = require('../src/claude-oauth-refresh');

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

function credential({ expiresIn = 8 * HOUR, refreshIn = 10 * 24 * HOUR, refreshToken = 'rt-1' } = {}) {
  return {
    claudeAiOauth: {
      accessToken: 'at-1',
      refreshToken,
      expiresAt: T0 + expiresIn,
      refreshTokenExpiresAt: refreshIn === null ? undefined : T0 + refreshIn,
      subscriptionType: 'max',
    },
  };
}

// `refreshOn` names the ladder rung whose CLI run rewrites the store — that is
// how a test says "auth status was enough" or "only a real turn worked".
function fixture({
  stored = credential(), refreshOn = null, platform = 'darwin', keychainBroken = false, ...rest
} = {}) {
  const store = { value: stored };
  const calls = [];
  let clock = T0;
  const refresher = createClaudeOAuthRefresher({
    platform,
    claudeBin: '/fake/claude',
    logger: { info() {}, warn() {}, error() {} },
    buildEnv: () => ({ PATH: '/usr/bin' }),
    now: () => clock,
    readFile: async () => {
      if (!store.value) throw new Error('ENOENT');
      return JSON.stringify(store.value);
    },
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === 'security') {
        if (keychainBroken || !store.value) return { code: 44, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: JSON.stringify(store.value) };
      }
      const step = args[0] === 'auth' ? 'auth-status' : 'authenticated-probe';
      if (step === refreshOn) {
        store.value = credential({ expiresIn: 9 * HOUR });
      }
      return { code: 0, stdout: 'ok' };
    },
    ...rest,
  });
  return {
    refresher,
    calls,
    store,
    cliCalls: () => calls.filter(call => call.file !== 'security'),
    advance: ms => { clock += ms; },
  };
}

test('a token with hours left is left alone — no CLI is spawned', async () => {
  const h = fixture();
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'fresh');
  assert.equal(h.cliCalls().length, 0);
});

test('a token inside the refresh buffer is repaired by the cheapest rung that works', async () => {
  const h = fixture({ stored: credential({ expiresIn: 10 * 60_000 }), refreshOn: 'auth-status' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.step, 'auth-status');
  assert.equal(h.cliCalls().length, 1, 'the expensive rung must not run once the cheap one worked');
  assert.deepEqual(h.cliCalls()[0].args, ['auth', 'status', '--json']);
});

test('a rung that exits 0 without refreshing is not believed, and the ladder escalates', async () => {
  const h = fixture({
    stored: credential({ expiresIn: 60_000 }),
    refreshOn: 'authenticated-probe',
  });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.step, 'authenticated-probe');
  const probe = h.cliCalls()[1].args;
  assert.equal(probe[0], '-p', 'the escalation must be a real authenticated turn');
  assert.ok(probe.includes('--strict-mcp-config'), 'a token probe must not boot MCP servers');
  assert.ok(probe.includes('--no-session-persistence'), 'a token probe must not leave a session behind');
  assert.equal(probe.includes('--bare'), false, '--bare skips keychain reads, which defeats the purpose');
});

test('an already expired token still refreshes rather than waiting for a user', async () => {
  const h = fixture({ stored: credential({ expiresIn: -HOUR }), refreshOn: 'auth-status' });
  assert.equal((await h.refresher.check()).outcome, 'refreshed');
});

// The CLI owns the write and therefore owns the "is it due yet" question. Early
// in the buffer it will simply decline, so a declined attempt has to read as
// normal — otherwise every token cycle logs failures and burns a paid probe.
test('a decline while the token still works is deferred, not failed', async () => {
  const h = fixture({ stored: credential({ expiresIn: 10 * 60_000 }), refreshOn: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'deferred');
  assert.equal(h.cliCalls().length, 1, 'only the free rung may run while the token still works');
  assert.deepEqual(result.steps.map(step => step.skipped || step.step),
    ['auth-status', 'not_due_yet']);

  h.advance(10_000);
  assert.equal((await h.refresher.check()).outcome, 'cooldown', 'a decline still throttles retries');
  h.advance(120_000);
  await h.refresher.check();
  assert.equal(h.cliCalls().length, 2, 'a short backoff, so the next attempt is soon');
});

test('a token about to die escalates to the probe, which the CLI cannot decline', async () => {
  const h = fixture({ stored: credential({ expiresIn: 30_000 }), refreshOn: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'deferred', 'the token is still usable for another 30s');
  assert.equal(h.cliCalls().length, 2, 'both rungs run once expiry is imminent');
});

test('an exhausted ladder on a dead token is a real failure and backs off hard', async () => {
  const h = fixture({ stored: credential({ expiresIn: -60_000 }), refreshOn: null });
  const failed = await h.refresher.check();
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.steps.length, 2);
  assert.equal(failed.steps.every(step => step.refreshed === false), true);
  assert.equal(h.cliCalls().length, 2);

  h.advance(60_000);
  const second = await h.refresher.check();
  assert.equal(second.outcome, 'cooldown');
  assert.equal(h.cliCalls().length, 2, 'the backoff must hold the CLI back');

  h.advance(30 * 60_000);
  await h.refresher.check();
  assert.equal(h.cliCalls().length, 4, 'once the backoff lapses the repair is retried');
});

test('a dead refresh token spawns nothing — no CLI run can revive it', async () => {
  const h = fixture({ stored: credential({ expiresIn: -HOUR, refreshIn: -HOUR }) });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'needs-login');
  assert.equal(result.detail, 'refresh_token_expired');
  assert.equal(h.cliCalls().length, 0);
});

test('a missing credential is reported, not papered over with a CLI run', async () => {
  const h = fixture({ stored: null });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'no-credentials');
  assert.equal(h.cliCalls().length, 0);
});

test('forcing waives the backoff but never the credential check', async () => {
  const h = fixture();
  const result = await h.refresher.refresh({ reason: 'manual', force: true });
  assert.equal(result.outcome, 'fresh');
  assert.equal(h.cliCalls().length, 0, 'a fresh credential is still a reason not to spawn');
});

test('concurrent callers share one attempt so the CLI refresh lock is never contended', async () => {
  const h = fixture({ stored: credential({ expiresIn: 60_000 }), refreshOn: 'auth-status' });
  const [a, b] = await Promise.all([h.refresher.check(), h.refresher.refresh({ reason: 'api-error' })]);
  assert.equal(a.outcome, 'refreshed');
  assert.equal(b, a, 'the second caller must join the in-flight attempt');
  assert.equal(h.cliCalls().length, 1);
});

test('the reactive hook fires on the router expired-credential message and nothing else', async () => {
  const h = fixture({ stored: credential({ expiresIn: 60_000 }), refreshOn: 'auth-status' });
  assert.equal(h.refresher.onApiError({
    error: { sanitizedMessage: 'API Error: 500 upstream overloaded' },
  }), null);
  assert.equal(h.cliCalls().length, 0);

  const fired = h.refresher.onApiError({
    error: {
      sanitizedMessage: 'API Error: 502 {"error":"cpr: official OAuth unavailable '
        + '— OAuth token expired — run claude once to refresh the Keychain"}',
    },
  });
  assert.notEqual(fired, null);
  assert.equal((await fired).outcome, 'refreshed');
});

test('the kill switch stops the runtime from spawning anything at all', async () => {
  const h = fixture({ stored: credential({ expiresIn: 60_000 }), isEnabled: () => false });
  assert.equal((await h.refresher.check()).outcome, 'disabled');
  assert.equal(h.calls.length, 0, 'a disabled runtime must not even read the credential');
});

test('a platform without the macOS keychain reads the same credential from disk', async () => {
  const h = fixture({ platform: 'linux', stored: credential({ expiresIn: 60_000 }), refreshOn: 'auth-status' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.store, 'file');
  assert.equal(h.calls.some(call => call.file === 'security'), false);
});

test('a keychain read that fails falls back to the on-disk credential', async () => {
  const healthy = fixture({ stored: credential({ expiresIn: 60_000 }) });
  assert.equal((await healthy.refresher.readCredentials()).store, 'keychain');

  // A locked or missing keychain entry must not read as "no login": the CLI
  // keeps the same JSON on disk, and answering from it is what stops the runtime
  // from reporting needs-login for a credential that is merely unreadable here.
  const broken = fixture({ stored: credential({ expiresIn: 60_000 }), keychainBroken: true, refreshOn: 'auth-status' });
  const credentials = await broken.refresher.readCredentials();
  assert.equal(credentials.store, 'file');
  assert.equal((await broken.refresher.check()).outcome, 'refreshed');
});

test('the expired-credential predicate matches the router wording without over-reaching', () => {
  assert.equal(looksLikeExpiredOAuth('cpr: official OAuth unavailable — OAuth token expired'), true);
  assert.equal(looksLikeExpiredOAuth('run `claude` once to refresh the Keychain'), true);
  assert.equal(looksLikeExpiredOAuth('401 invalid x-api-key'), false);
  assert.equal(looksLikeExpiredOAuth('rate_limit_error'), false);
  assert.equal(looksLikeExpiredOAuth(''), false);
});

test('a malformed credential store never reads as a usable token', () => {
  assert.equal(parseCredentials('not json').ok, false);
  assert.equal(parseCredentials('{}').ok, false);
  assert.equal(parseCredentials('{"claudeAiOauth":{}}').ok, false);
  assert.equal(parseCredentials(JSON.stringify(credential())).ok, true);
});

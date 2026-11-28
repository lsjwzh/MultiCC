'use strict';

// A refresh that cannot succeed must not be retried forever, and the evidence
// of why it failed must outlive the process. These tests pin both halves of
// that: the failure classification and its stderr payload, the exponential
// backoff, the park that stops the ladder, the release when a new login
// changes the credential, and the durable record that makes a restart remember
// a dead account instead of starting the dozen-minute loop again.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createClaudeOAuthRefresher,
  classifyFailure,
  credentialFingerprint,
  redactCliOutput,
} = require('../src/native/binding').claudeOAuthRefresh;
const { createRefreshHealthStore } = require('../src/native/binding').refreshHealth;
const { createOfficialAccountStore } = require('../src/native/binding').officialAccounts;
const { createClaudeAccountRefreshSupervisor } = require('../src/claude-auth/accounts-refresh');

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function credential({ expiresIn = -60_000, refreshIn = 10 * 24 * HOUR } = {}) {
  return {
    claudeAiOauth: {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: T0 + expiresIn,
      refreshTokenExpiresAt: T0 + refreshIn,
      subscriptionType: 'pro',
    },
  };
}

function fixture({ stored = credential(), stderr = 'some transient error', health = null, authStatus = null } = {}) {
  const store = { value: stored };
  const calls = [];
  let clock = T0;
  const logs = [];
  const refresher = createClaudeOAuthRefresher({
    platform: 'linux',
    claudeBin: '/fake/claude',
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
    buildEnv: () => ({ PATH: '/usr/bin' }),
    now: () => clock,
    readFile: async () => JSON.stringify(store.value),
    run: async (file, args) => {
      calls.push({ file, args });
      if (authStatus && args[0] === 'auth' && args[1] === 'status') {
        return { code: 0, stdout: JSON.stringify(authStatus), stderr: '', timedOut: false };
      }
      return { code: 1, stdout: '', stderr, timedOut: false };
    },
    health,
    healthKey: health ? 'acct-1' : null,
    ...(health ? {} : {}),
  });
  return {
    refresher,
    store,
    logs,
    cliCalls: () => calls,
    advance: ms => { clock += ms; },
    now: () => clock,
  };
}

test('stderr is classified instead of discarded', () => {
  assert.equal(classifyFailure([{ stderr: 'error: invalid_grant' }]), 'rejected');
  assert.equal(classifyFailure([{ stderr: 'OAuth token revoked' }]), 'rejected');
  assert.equal(classifyFailure([{ stderr: '401 {"error":"access_denied"}' }]), 'rejected');
  assert.equal(classifyFailure([{ stderr: 'getaddrinfo ENOTFOUND api.anthropic.com' }]), 'network');
  assert.equal(classifyFailure([{ stderr: 'something odd happened' }]), 'unknown');
  assert.equal(classifyFailure([]), 'unknown');
});

test('CLI output is redacted and truncated before it is logged', () => {
  const line = `failed with sk-abcdefghijklmnop and ${'x'.repeat(600)}`;
  const out = redactCliOutput(line);
  assert.equal(out.includes('sk-abcdefghijklmnop'), false);
  assert.ok(out.length <= 401);
});

test('a failure records the CLI stderr so the next diagnosis needs no guesswork', async () => {
  const h = fixture({ stderr: 'OAuth token revoked' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'parked');
  const step = result.steps.find(s => s.step === 'authenticated-probe');
  assert.match(step.stderr, /revoked/);
  const parked = h.logs.find(l => l.event === 'claude_oauth_refresh_parked');
  assert.ok(parked, 'a park must be logged as its own event');
  assert.match(parked.fields.action, /log in again/);
});

test('repeated network failures back off exponentially, then park', async () => {
  const h = fixture({ stderr: 'getaddrinfo ENOTFOUND api.anthropic.com' });
  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    outcomes.push(await h.refresher.check());
    h.advance(8 * HOUR);
  }
  assert.deepEqual(
    outcomes.map(r => r.retryInMs),
    [10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 160 * MIN, undefined],
    'each retry must wait twice as long as the previous one',
  );
  assert.equal(outcomes[5].outcome, 'parked');

  const callsBefore = h.cliCalls().length;
  const again = await h.refresher.check();
  assert.equal(again.outcome, 'parked');
  assert.equal(h.cliCalls().length, callsBefore, 'a parked account must not spawn the CLI again');
});

test('a probe is a real API turn, and only two of them are ever spent per token', async () => {
  const h = fixture();
  const probes = () => h.cliCalls().filter(call => call.args[0] === '-p').length;
  const first = await h.refresher.check();
  assert.equal(first.outcome, 'failed');
  assert.equal(probes(), 1);
  h.advance(10 * MIN);
  const second = await h.refresher.check();
  assert.equal(second.outcome, 'parked', 'the second identical probe is the last one');
  assert.equal(probes(), 2);
  h.advance(HOUR);
  const third = await h.refresher.check();
  assert.equal(third.outcome, 'parked');
  assert.equal(probes(), 2, 'a parked account must never turn the API again');
});

test('the CLI saying "not logged in" parks at once instead of escalating to a turn', async () => {
  const h = fixture({ authStatus: { loggedIn: false, authMethod: 'none' } });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'needs-login');
  assert.equal(result.detail, 'cli_reports_not_logged_in');
  assert.equal(h.cliCalls().length, 1, 'no probe may follow a missing login');

  const parked = h.logs.find(l => l.event === 'claude_oauth_refresh_parked');
  assert.ok(parked);
  assert.match(parked.fields.action, /log in again/);

  const callsBefore = h.cliCalls().length;
  h.advance(5 * MIN);
  const again = await h.refresher.check();
  assert.equal(again.outcome, 'needs-login', 'the login banner must outlive the first attempt');
  assert.equal(h.cliCalls().length, callsBefore, 'and the ladder must stay closed');
});

test('a token the CLI keeps declining is asked twice, then left alone until it is due', async () => {
  const h = fixture({
    stored: credential({ expiresIn: 15 * MIN }),
    authStatus: { loggedIn: true, authMethod: 'oauth_token' },
  });
  const first = await h.refresher.check();
  assert.equal(first.outcome, 'deferred');
  h.advance(90_000);
  const second = await h.refresher.check();
  assert.equal(second.outcome, 'deferred');
  assert.ok(second.nextAttemptInMs > 90_000,
    'after the second answer the next question waits for the token to be nearly dead');
  const callsBefore = h.cliCalls().length;
  h.advance(MIN);
  const third = await h.refresher.check();
  assert.equal(third.outcome, 'cooldown');
  assert.equal(h.cliCalls().length, callsBefore, 'no polling inside the wait');
});

test('a server rejection parks after a single attempt', async () => {
  const h = fixture({ stderr: 'OAuth token revoked' });
  const result = await h.refresher.check();
  assert.equal(result.outcome, 'parked');
  assert.equal(result.consecutiveFailures, 1);
});

test('parking survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-health-'));
  try {
    const health = createRefreshHealthStore({ root: dir });
    const first = fixture({ stderr: 'OAuth token revoked', health });
    await first.refresher.check();
    assert.ok(first.refresher.status().parked);

    // A new process builds a new refresher from the same store.
    const second = fixture({ stderr: 'OAuth token revoked', health });
    assert.ok(second.refresher.status().parked, 'the park must be read back at construction');
    assert.equal(second.refresher.status().parked.credentialExpiresAt, T0 - 60_000,
      'the per-account supervisor needs the parked expiry after a restart, not just the park');
    const result = await second.refresher.check();
    assert.equal(result.outcome, 'parked');

    const record = JSON.parse(fs.readFileSync(path.join(dir, 'refresh-health', 'acct-1.json'), 'utf8'));
    assert.equal(record.parked.failureClass, 'rejected');
    assert.equal(record.parked.consecutiveFailures, 1);
    assert.ok(record.lastFailure.steps.some(step => /revoked/.test(step.stderr)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new login releases the park — the credential, not a timer, decides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-unpark-'));
  try {
    const health = createRefreshHealthStore({ root: dir });
    const h = fixture({ stderr: 'OAuth token revoked', health });
    await h.refresher.check();
    assert.ok(h.refresher.status().parked);

    // Re-login: same account, new token family, newer expiry.
    h.store.value = credential({ expiresIn: 8 * HOUR });
    const result = await h.refresher.check();
    assert.equal(h.refresher.status().parked, null);
    assert.equal(result.outcome, 'fresh');
    assert.ok(h.logs.some(l => l.event === 'claude_oauth_refresh_unparked'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the credential fingerprint changes on login and never carries the token', () => {
  const before = credentialFingerprint({ ok: true, expiresAt: T0, refreshExpiresAt: T0 + HOUR, hasRefreshToken: true });
  const after = credentialFingerprint({ ok: true, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + HOUR, hasRefreshToken: true });
  assert.notEqual(before, after);
  assert.equal(before.includes('at-1'), false);
});

test('a parked account is skipped before the credential slot is even touched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-slot-'));
  try {
    const accounts = createOfficialAccountStore({ root: path.join(dir, 'store') });
    const { id } = accounts.createClaudeAccount({ label: 'parked' });
    accounts.writeClaudeCredential(id, {
      access_token: 'at-1', refresh_token: 'rt-1',
      expired: new Date(Date.now() + MIN).toISOString(),
    });
    let ladderRuns = 0;
    const supervisor = createClaudeAccountRefreshSupervisor({
      accounts,
      platform: 'linux',
      minCheckGapMs: 0,
      isEnabled: () => true,
      makeRefresher: () => ({
        status: () => ({ parked: { failureClass: 'rejected' }, retryAfter: null }),
        check: async () => { ladderRuns += 1; return { outcome: 'refreshed' }; },
      }),
    });
    const result = await supervisor.checkAccount(id, 'manual');
    assert.equal(result.outcome, 'parked');
    assert.equal(result.detail, 'rejected');
    assert.equal(ladderRuns, 0, 'no ladder may run for a parked credential');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a re-login in the account file reopens the ladder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-renew-'));
  try {
    const accounts = createOfficialAccountStore({ root: path.join(dir, 'store') });
    const { id } = accounts.createClaudeAccount({ label: 'renewed' });
    const parkedExpiry = Date.now() - 60_000;
    accounts.writeClaudeCredential(id, {
      access_token: 'at-2', refresh_token: 'rt-2',
      expired: new Date(Date.now() + MIN).toISOString(),
    });
    let ladderRuns = 0;
    const supervisor = createClaudeAccountRefreshSupervisor({
      accounts,
      platform: 'linux',
      minCheckGapMs: 0,
      isEnabled: () => true,
      makeRefresher: () => ({
        status: () => ({
          parked: { failureClass: 'rejected', credentialExpiresAt: parkedExpiry },
          retryAfter: null,
        }),
        check: async () => { ladderRuns += 1; return { outcome: 'deferred' }; },
      }),
    });
    const result = await supervisor.checkAccount(id, 'manual');
    assert.equal(result.outcome, 'deferred');
    assert.equal(ladderRuns, 1, 'a newer credential must be tried again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('refresh health retains the latest observation when persistence fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-refresh-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const warnings = [];
  const health = createRefreshHealthStore({ root, logger: { warn: (...args) => warnings.push(args) } });
  assert.equal(health.read('cli'), null);
  fs.writeFileSync(health.dir, 'blocked');
  assert.equal(health.write('cli', { parked: true, version: 2 }), false);
  const cached = health.read('cli');
  assert.equal(cached.parked, true);
  assert.equal(cached.version, 2);
  assert.equal(health.read('cli'), cached);
  assert.equal(warnings[0][0], 'claude_refresh_health_write_failed');
  assert.equal(health.write('../escape', {}), false);
  fs.unlinkSync(health.dir);
  assert.equal(health.clear('cli'), true);
  assert.equal(health.read('cli'), null);
});

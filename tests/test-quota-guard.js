'use strict';

// The quota guard is a hard account-protection gate: once a subscription window
// reaches the configured share, the account stops receiving inference requests
// until that window resets. These tests pin the three properties that make it
// safe to leave enabled — it never fires without a reading, it never fires
// without a reset ahead of it, and it fires in the same place a route is either
// chosen (Auto pool) or dialled (proxy admission).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createQuotaGuard,
  envConfig,
  guardVerdict,
  normalizeConfig,
  windowKind,
} = require('../src/quota/quota-guard');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function entry(windows, { fetchedAt = NOW, lastAttemptAt = null } = {}) {
  return { status: 'ok', fetchedAt, lastAttemptAt, summary: { kind: 'window', windows } };
}

function window(name, usedPercent, resetMs) {
  return { window: name, usedPercent, resetMs };
}

// ── window identity and configuration ────────────────────────────────────────

test('every producer naming of the three cycles resolves to one window kind', () => {
  assert.equal(windowKind('5h'), 'five_hour');
  assert.equal(windowKind('session'), 'five_hour');
  assert.equal(windowKind('7d'), 'weekly');
  assert.equal(windowKind('1wk'), 'weekly');
  assert.equal(windowKind('monthly'), 'monthly');
  assert.equal(windowKind('30d'), 'monthly');
  assert.equal(windowKind('something-else'), null);
});

test('defaults hold a subscription at 98% and can be overridden per window', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.fiveHourPercent, 98);
  assert.equal(defaults.weeklyPercent, 98);
  assert.equal(defaults.scope, 'official');
  assert.equal(defaults.maxReadingAgeMs, 30 * 60_000);

  const env = envConfig({
    MULTICC_QUOTA_GUARD_PERCENT: '95',
    MULTICC_QUOTA_GUARD_WEEKLY_PERCENT: '90',
    MULTICC_QUOTA_GUARD_SCOPE: 'all',
    MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS: '600000',
  });
  assert.equal(env.fiveHourPercent, 95);
  assert.equal(env.weeklyPercent, 90);
  assert.equal(env.scope, 'all');
  assert.equal(env.maxReadingAgeMs, 600_000);
  // An out-of-band age is ignored, not clamped into a nonsense gate.
  assert.equal(envConfig({ MULTICC_QUOTA_GUARD_MAX_READING_AGE_MS: '5' }).maxReadingAgeMs, undefined);

  const off = normalizeConfig({ ...envConfig({ MULTICC_QUOTA_GUARD: '0' }) });
  assert.equal(off.enabled, false);

  const overridden = normalizeConfig({ ...defaults, fiveHourPercent: 99.5 });
  assert.equal(overridden.fiveHourPercent, 99.5);
});

// ── verdict ──────────────────────────────────────────────────────────────────

test('a window at the threshold with a reset ahead blocks the account', () => {
  const verdict = guardVerdict(entry([window('5h', 98, NOW + HOUR)]), { now: NOW });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.kind, 'five_hour');
  assert.equal(verdict.blockedUntilMs, NOW + HOUR);
});

test('just under the threshold, an expired reset, or no reset never blocks', () => {
  assert.equal(guardVerdict(entry([window('5h', 97.9, NOW + HOUR)]), { now: NOW }).blocked, false);
  assert.equal(guardVerdict(entry([window('7d', 99, NOW - 1)]), { now: NOW }).blocked, false);
  assert.equal(guardVerdict(entry([window('7d', 99, null)]), { now: NOW }).blocked, false);
  assert.equal(guardVerdict(null, { now: NOW }).blocked, false);
});

test('the fullest window decides, and a disabled guard never fires', () => {
  const verdict = guardVerdict(entry([
    window('5h', 40, NOW + HOUR),
    window('7d', 99.5, NOW + 48 * HOUR),
  ]), { now: NOW });
  assert.equal(verdict.kind, 'weekly');
  assert.equal(verdict.usedPercent, 99.5);

  assert.equal(guardVerdict(entry([window('5h', 100, NOW + HOUR)]), {
    now: NOW, config: { enabled: false },
  }).blocked, false);
});

test('a blocking reading older than maxReadingAgeMs releases the gate for revalidation', () => {
  // Consumption is monotone inside a window, but the denominator is not: a
  // plan upgrade or top-up shrinks usedPercent mid-window, and a held gate
  // starves the refresh path that would learn it. A two-hour-old 99% weekly
  // reading (default max age: 30 minutes) therefore does not block — it asks
  // for a re-read instead.
  const stale = entry([window('7d', 99, NOW + 48 * HOUR)], { fetchedAt: NOW - 2 * HOUR });
  const verdict = guardVerdict(stale, { now: NOW });
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.reason, 'stale_reading');
  assert.equal(verdict.kind, 'weekly');
  assert.equal(verdict.usedPercent, 99);
  assert.equal(verdict.readingAtMs, NOW - 2 * HOUR);
});

test('a blocking reading inside maxReadingAgeMs still blocks', () => {
  const fresh = entry([window('7d', 99, NOW + 48 * HOUR)], { fetchedAt: NOW - 10 * 60_000 });
  assert.equal(guardVerdict(fresh, { now: NOW }).blocked, true);
  // The bound is configurable per install.
  assert.equal(guardVerdict(fresh, { now: NOW, config: { maxReadingAgeMs: 5 * 60_000 } }).reason, 'stale_reading');
});

test('a failed re-read re-arms the staleness clock', () => {
  // The account read 99% two hours ago, but a refresh was attempted (and
  // failed) five minutes ago: while upstream cannot be asked, the gate keeps
  // holding rather than releasing a probe turn on every check.
  const rearmed = entry([window('7d', 99, NOW + 48 * HOUR)], {
    fetchedAt: NOW - 2 * HOUR,
    lastAttemptAt: NOW - 5 * 60_000,
  });
  assert.equal(guardVerdict(rearmed, { now: NOW }).blocked, true);
});

test('a stale release offers the provider a re-read, throttled per provider', () => {
  let clock = NOW;
  const cache = {
    get: () => entry([window('7d', 99, clock + 48 * HOUR)], { fetchedAt: clock - 2 * HOUR }),
  };
  const offered = [];
  const instance = createQuotaGuard({
    cache, now: () => clock, env: {}, configFile: null,
    onStale: (appType, providerId) => offered.push([appType, providerId]),
  });
  assert.equal(instance.check({ appType: 'claude', providerId: 'claude-official-abc' }).reason, 'stale_reading');
  instance.check({ appType: 'claude', providerId: 'claude-official-abc' });
  instance.check({ appType: 'claude', providerId: 'claude-official-abc' });
  assert.deepEqual(offered, [['claude', 'claude-official-abc']], 'one offer per throttle window');
  // The refresher can also be (re)wired after construction, and the throttle
  // window having passed lets the next check offer again.
  clock += 61_000;
  const later = [];
  instance.setStaleRefresher((appType, providerId) => later.push([appType, providerId]));
  instance.check({ appType: 'claude', providerId: 'claude-official-abc' });
  assert.deepEqual(later, [['claude', 'claude-official-abc']]);
  instance.setStaleRefresher(null);
  clock += 61_000;
  instance.check({ appType: 'claude', providerId: 'claude-official-abc' });
  assert.deepEqual(later, [['claude', 'claude-official-abc']], 'a cleared refresher offers nothing');
});

test('a single top-level reading is read as the window it names', () => {
  const single = {
    status: 'ok', fetchedAt: NOW,
    summary: { kind: 'window', window: '5h', usedPercentage: 99, resetsAtMs: NOW + HOUR },
  };
  const verdict = guardVerdict(single, { now: NOW });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.kind, 'five_hour');
});

// ── guard object: scope and cache lookup ─────────────────────────────────────

function guard(cache, overrides = {}) {
  return createQuotaGuard({
    cache, now: () => NOW, env: {}, configFile: null, ...overrides,
  });
}

test('only official accounts are held by default; scope=all covers the rest', () => {
  const cache = {
    get: () => entry([window('5h', 99, NOW + HOUR)]),
  };
  assert.equal(guard(cache).check({ providerId: 'claude-official-abc' }).blocked, true);
  assert.equal(guard(cache).check({ providerId: 'some-relay' }).blocked, false);
  assert.equal(guard(cache, { env: { MULTICC_QUOTA_GUARD_SCOPE: 'all' } })
    .check({ providerId: 'some-relay' }).blocked, true);
});

test('a missing cache entry is not a verdict', () => {
  const cache = { get: () => null };
  assert.equal(guard(cache).check({ providerId: 'claude-official-abc' }).blocked, false);
  assert.equal(createQuotaGuard({ now: () => NOW, env: {} })
    .check({ providerId: 'claude-official-abc' }).blocked, false);
});

test('asynchronous cache reads are awaited and a synchronous caller fails closed', async () => {
  const cache = { get: async () => entry([window('5h', 99, NOW + HOUR)]) };
  const instance = guard(cache);
  const input = { appType: 'claude', providerId: 'claude-official-abc' };
  assert.equal(instance.check(input).reason, 'async_cache_read_required');
  const verdict = await instance.checkAsync(input);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.kind, 'five_hour');
});

test('async auto selection reads one committed snapshot before choosing a line', async () => {
  const ids = ['claude-official-guarded', 'claude-official-roomy'];
  const entries = {
    'claude:claude-official-guarded': entry([window('5h', 99, NOW + HOUR)]),
    'claude:claude-official-roomy': entry([window('5h', 20, NOW + HOUR)]),
  };
  let reads = 0;
  const cache = { snapshot: async () => { reads += 1; return { entries }; }, get: () => { throw new Error('unexpected sync read'); } };
  const runtime = createAutoProviderRuntime({ providers: catalog(ids), now: () => NOW,
    providerLimitCache: cache, quotaGuard: guard(cache), emit: () => {}, hasLiveBackgroundTasks: () => false });
  const session = { id: 'async-s', cli: 'claude', providerSelection: {
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
    candidates: [{ providerId: ids[0], priority: 1 }, { providerId: ids[1], priority: 2 }],
  } };
  const turn = await runtime.beginTurnAsync({ session, turnId: 'async-t', promptText: 'hi' });
  assert.equal(reads, 1);
  assert.equal(turn.initial().providerId, ids[1]);
});

// ── proxy admission: the one place every inference request passes ────────────

function attemptRuntime(quotaGuard) {
  return createProviderAttemptRuntime({
    runtimeEpoch: 'runtime-epoch-guard',
    now: () => NOW,
    nextId: prefix => `${prefix}-1`,
    quotaGuard,
  });
}

test('a guarded account is refused at the proxy, before any route bookkeeping', () => {
  const cache = { get: () => entry([window('7d', 99, NOW + 48 * HOUR)]) };
  const runtime = attemptRuntime(guard(cache));
  const decision = runtime.authorizeProxyRequest({
    protocol: 'claude', providerId: 'claude-official-abc', sessionId: 's1', method: 'POST',
  });
  assert.equal(decision.ok, false);
  assert.match(decision.code, /^quota_guard:/);
  assert.match(decision.code, /99pct/);
});

test('connectivity probes still answer for a guarded account', () => {
  const cache = { get: () => entry([window('5h', 99, NOW + HOUR)]) };
  const runtime = attemptRuntime(guard(cache));
  // HEAD /api/hello only checks that the local proxy is alive; blocking it
  // would make a protected account look offline instead of capped.
  const decision = runtime.authorizeProxyRequest({
    protocol: 'claude', providerId: 'claude-official-abc', sessionId: 's1', method: 'HEAD',
  });
  assert.notEqual(decision.code && /^quota_guard:/.test(decision.code), true);
});

// ── Auto pool: a guarded candidate is withdrawn, sticky or not ───────────────

function catalog(ids) {
  const list = ids.map(id => ({
    id, name: id, appType: 'claude', apiFormat: 'anthropic',
    compatibleClis: ['claude'], model: `${id}-model`, modelOptions: [`${id}-model`],
  }));
  return {
    appTypeForCli: () => 'claude',
    appTypesForCli: () => ['claude'],
    listProviders: () => list,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (_appType, providerId, model) => list.some(
      item => item.id === providerId && item.model === model),
  };
}

test('Auto fails over away from a guarded account instead of spending it', () => {
  const ids = ['claude-official-guarded', 'claude-official-roomy'];
  const limitCache = {
    get: (_appType, id) => entry([
      id === 'claude-official-guarded'
        ? window('5h', 99, NOW + HOUR)
        : window('5h', 20, NOW + HOUR),
    ]),
  };
  const events = [];
  const runtime = createAutoProviderRuntime({
    providers: catalog(ids),
    now: () => NOW,
    limitCacheStaleMs: 60_000,
    providerLimitCache: limitCache,
    quotaGuard: guard(limitCache),
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's1',
    cli: 'claude',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
      candidates: [
        { providerId: 'claude-official-guarded', priority: 1 },
        { providerId: 'claude-official-roomy', priority: 2 },
      ],
    },
  };
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: 'hi' });
  assert.equal(turn.initial().providerId, 'claude-official-roomy');
  const selected = events.find(event => event.type === 'provider_auto_route'
    && event.routePhase === 'selected');
  assert.equal(selected.skipped[0].providerId, 'claude-official-guarded');
  assert.equal(selected.skipped[0].reason, 'quota_guard_five_hour');
});


test('native coercion preserves nonfinite, negative zero and UTF-16 input semantics', () => {
  const { liveWindows, readingAgeOf } = require('../src/quota/quota-guard');
  const config = normalizeConfig({ fiveHourPercent: -0, weeklyPercent: NaN, monthlyPercent: Infinity });
  assert.equal(Object.is(config.fiveHourPercent, 0), true);
  assert.equal(config.weeklyPercent, 98);
  assert.equal(config.monthlyPercent, 98);
  assert.equal(envConfig({ MULTICC_QUOTA_GUARD_PERCENT: -Infinity }).fiveHourPercent, undefined);
  assert.equal(readingAgeOf([60000]), 60000);
  const rows = liveWindows({ summary: { usedPercentage: [99], window: '\ud800', resetsAtMs: NOW + HOUR } });
  assert.equal(rows[0].window, '\ud800');
  assert.equal(rows[0].kind, 'five_hour');
  assert.equal(rows[0].usedPercent, 99);
});

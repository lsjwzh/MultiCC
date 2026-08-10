'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeFiveHourRateLimit,
  formatFiveHourRateLimit,
  saveFiveHourRateLimit,
  loadFiveHourRateLimit,
  consumeRateLimitEvent,
  normalizeBalance,
  formatBalance,
  consumeBalanceEvent,
  setCli,
  setProviderBaseUrl,
  formatArkQuota,
  arkPlanFromBaseUrl,
  humanizeCountdown,
  unifiedRemaining,
  unifiedWindowSeg,
  unifiedBalanceText,
  sortWindowSegs,
  formatClaudeUsageOnly,
  refreshClaudeUsage,
  restoreClaudeUsage,
} = require('../public/chat-rate-limit');

test('unified helpers: countdown buckets, remaining clamp, window seg, balance text', () => {
  // humanizeCountdown: <1h → minutes (min 1m), <24h → hours (1 decimal), else days+hours
  assert.equal(humanizeCountdown(null), '');
  assert.equal(humanizeCountdown(-1), '');
  assert.equal(humanizeCountdown(30 * 60_000), '30m');
  assert.equal(humanizeCountdown(3_600_000), '1h');
  assert.equal(humanizeCountdown(5_400_000), '1.5h');
  assert.equal(humanizeCountdown(25 * 3_600_000), '1d 1h');
  assert.equal(humanizeCountdown(48 * 3_600_000), '2d');
  assert.equal(humanizeCountdown(620 * 3_600_000), '25d 20h');

  // unifiedRemaining: 100 - used, clamped to [0,100], null passthrough
  assert.equal(unifiedRemaining(null), null);
  assert.equal(unifiedRemaining(0), 100);
  assert.equal(unifiedRemaining(72.4), 28);
  assert.equal(unifiedRemaining(100), 0);
  assert.equal(unifiedRemaining(150), 0);

  // unifiedWindowSeg: `<label> <remaining>% [<countdown>]`, '' without a percent
  assert.equal(unifiedWindowSeg('5h', null, 3_600_000), '');
  assert.equal(unifiedWindowSeg('5h', 72.4, 3_600_000), '5h 28% 1h');
  assert.equal(unifiedWindowSeg('1wk', 50, null), '1wk 50%');

  // unifiedBalanceText: 2-decimal amount with currency symbol
  assert.equal(unifiedBalanceText(null, 'CNY'), '');
  assert.equal(unifiedBalanceText(110, 'CNY'), '¥110.00');
  assert.equal(unifiedBalanceText(0, 'USD'), '$0.00');
  assert.equal(unifiedBalanceText(42.5, null), '42.50');
});

test('normalizes Claude five-hour rate-limit event into a privacy-minimal DTO', () => {
  const now = 1_700_000_000_000;
  const value = normalizeFiveHourRateLimit({
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    utilization: 0.724,
    resetsAt: 1_700_003_600,
    overageDisabledReason: 'out_of_credits',
    token: 'must-not-leak',
  }, now);

  assert.deepEqual(value, {
    schemaVersion: 1,
    kind: 'five_hour',
    status: 'allowed_warning',
    usedPercentage: 72.4,
    resetsAtMs: 1_700_003_600_000,
    observedAtMs: now,
    source: 'claude_code',
    provider: 'claude',
  });
  assert.equal('token' in value, false);
  assert.equal('overageDisabledReason' in value, false);
  assert.equal(Object.isFrozen(value), true);
});

test('rejects unrelated or malformed limit events and expires persisted windows', () => {
  const now = 1_700_000_000_000;
  assert.equal(normalizeFiveHourRateLimit({
    status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8,
  }, now), null);
  assert.equal(normalizeFiveHourRateLimit({
    status: 'unknown', rateLimitType: 'five_hour', utilization: 0.8,
  }, now), null);

  const active = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1,
    resetsAt: (now + 60_000) / 1000,
  }, now);
  assert.notEqual(formatFiveHourRateLimit(active, { nowMs: now }), null);
  assert.equal(formatFiveHourRateLimit(active, { nowMs: now + 60_000 }), null);
});

test('stores only the normalized per-session DTO and removes it after reset', () => {
  const now = 1_700_000_000_000;
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const limit = normalizeFiveHourRateLimit({
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    utilization: 0.72,
    resetsAt: (now + 3_600_000) / 1000,
    token: 'must-not-leak',
  }, now);

  assert.equal(saveFiveHourRateLimit(storage, 'chat-1', limit, now), true);
  assert.deepEqual(loadFiveHourRateLimit(storage, 'chat-1', now), limit);
  assert.equal([...values.values()][0].includes('must-not-leak'), false);
  assert.equal(loadFiveHourRateLimit(storage, 'chat-2', now), null);
  assert.equal(loadFiveHourRateLimit(storage, 'chat-1', now + 3_600_000), null);
  assert.equal(values.size, 0);
});

test('formats active five-hour state and hides expired state deterministically', () => {
  const now = 1_700_000_000_000;
  const limit = {
    kind: 'five_hour',
    status: 'allowed_warning',
    usedPercentage: 72.4,
    resetsAtMs: now + 3_600_000,
  };
  const view = formatFiveHourRateLimit(limit, { nowMs: now });
  // The Claude bar is always a click target (⟳ = fetch the usage page), so the
  // refresh affordance is part of every Claude rendering, not just the
  // scrape-driven one.
  assert.equal(view.text, '5h 28% 1h · 1wk - · ⟳ 刷新');
  assert.equal(view.color, '#d29922');
  assert.match(view.title, /^Claude 订阅窗口用量/);
  assert.match(view.title, /5小时: 已用 72%/);
  assert.equal(formatFiveHourRateLimit(limit, { nowMs: now + 3_600_000 }), null);
  assert.equal(formatFiveHourRateLimit({
    ...limit,
    status: 'rejected',
  }, { nowMs: now }).text, '5h 0% 1h · 1wk - · ⟳ 刷新');
});

test('structured event renders directly in the Claude chat bar and hides for another CLI', () => {
  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'claude-rate-limit-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  try {
    const limit = consumeRateLimitEvent({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.72,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    }, 'chat-1');
    assert.equal(limit.usedPercentage, 72);
    assert.match(element.textContent, /^5h 28%/);
    assert.equal(element.style.display, 'block');
    assert.equal(values.size, 1);

    setCli('codex');
    assert.equal(element.style.display, 'none');
    setCli('claude');
    assert.equal(element.style.display, 'block');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('GLM window renders in the unified 5h format under codex, idle placeholder under claude', () => {
  const value = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44,
    resetsAt: Math.floor(Date.now() / 1000) + 3600, provider: 'glm',
  }, Date.now());
  assert.equal(value.provider, 'glm');
  assert.match(formatFiveHourRateLimit(value).text, /^5h 56%/);

  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'claude-rate-limit-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    consumeRateLimitEvent({
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44,
      resetsAt: Math.floor(Date.now() / 1000) + 3600, provider: 'glm',
    }, 'glm-sess');
    setCli('codex');
    assert.equal(element.style.display, 'block', 'GLM window shows under codex');
    assert.match(element.textContent, /^5h 56%/);
    setCli('claude');
    assert.equal(element.style.display, 'block', 'bar stays visible under claude (idle placeholder)');
    assert.match(element.textContent, /^5h - · 1wk -/, 'GLM window replaced by Claude idle placeholder');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('Codex weekly window renders in the unified 1wk format under codex, idle placeholder under claude', () => {
  const value = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'weekly', utilization: 0.64,
    resetsAt: Math.floor(Date.now() / 1000) + 3600, provider: 'codex',
  }, Date.now());
  assert.equal(value.provider, 'codex');
  assert.match(formatFiveHourRateLimit(value).text, /^1wk 36%/);
  assert.match(formatFiveHourRateLimit(value).title, /周额度/);

  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'claude-rate-limit-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    consumeRateLimitEvent({
      status: 'allowed', rateLimitType: 'weekly', utilization: 0.64,
      resetsAt: Math.floor(Date.now() / 1000) + 3600, provider: 'codex',
    }, 'codex-sess');
    setCli('codex');
    assert.equal(element.style.display, 'block', 'Codex weekly shows under codex');
    assert.match(element.textContent, /^1wk 36%/);
    setCli('claude');
    assert.equal(element.style.display, 'block', 'bar stays visible under claude (idle placeholder)');
    assert.match(element.textContent, /^5h - · 1wk -/, 'Codex weekly replaced by Claude idle placeholder');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('rejects a non-window rateLimitType (e.g. seven_day) for codex too', () => {
  assert.equal(normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, provider: 'codex',
  }, Date.now()), null);
});

test('DeepSeek balance normalizes, formats, and renders in its own bar under codex', () => {
  assert.equal(normalizeBalance({ kind: 'window' }), null, 'rejects non-balance');
  const bal = normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 110 });
  assert.equal(bal.provider, 'deepseek');
  assert.equal(formatBalance(bal).text, '¥110.00');
  const exhausted = normalizeBalance({ kind: 'balance', available: false, currency: 'USD', total: 0 });
  assert.match(formatBalance(exhausted).text, /余额不足/);
  assert.equal(formatBalance(exhausted).text, '$0.00 · 余额不足');

  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'usage-balance-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    consumeBalanceEvent({ kind: 'balance', available: true, currency: 'CNY', total: 42.5 }, 'ds-sess');
    setCli('codex');
    assert.equal(element.style.display, 'block', 'balance shows under codex');
    assert.equal(element.textContent, '¥42.50');
    setCli('claude');
    assert.equal(element.style.display, 'none', 'balance hidden under claude');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('rejects a weekly window that would resolve to the claude provider (Claude has only 5h)', () => {
  assert.equal(normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'weekly', utilization: 0.5,
  }, Date.now()), null, 'weekly without a glm/codex provider tag must not become "Claude 5h"');
  const value = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
  }, Date.now());
  assert.equal(value.provider, 'claude');
  assert.match(formatFiveHourRateLimit(value).text, /^5h 50%/);
});

test('hides the Claude bar (data and idle placeholder) under a non-Claude provider', () => {
  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'claude-rate-limit-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    setCli('claude');
    setProviderBaseUrl('');
    assert.equal(element.style.display, 'block', 'idle placeholder shows on the default Claude login');
    assert.match(element.textContent, /^5h - · 1wk -/);

    consumeRateLimitEvent({
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.23,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    }, 'prov-sess');
    assert.match(element.textContent, /^5h 77%/);

    setProviderBaseUrl('https://api.z.ai/api/paas/v4');
    assert.equal(element.style.display, 'none', 'claude bar hidden under a zhipu provider');
    assert.equal(element.textContent, '', 'no empty "5h · —" placeholder');

    setProviderBaseUrl('https://api.anthropic.com');
    assert.equal(element.style.display, 'block', 'anthropic-family hosts still count as Claude');
    assert.match(element.textContent, /^5h 77%/);
  } finally {
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

const ARK_FIXTURE = {
  status: 'ok',
  fetchedAt: Date.now(),
  viewer: { user_name: 'tester' },
  items: [
    {
      product: 'agent-plan', edition: 'personal', tier: 'medium', subscribed: true, error: null,
      periods: [
        { label: '5h', used: 10.55, total: 10000, percent: 0.11, resetAt: null },
        { label: 'weekly', used: 5775, total: 35000, percent: 16.5, resetAt: null },
        { label: 'monthly', used: 29769, total: 100000, percent: 29.77, resetAt: null },
      ],
    },
    {
      product: 'coding-plan', edition: 'personal', tier: null, subscribed: true, error: null,
      periods: [
        { label: 'session', used: null, total: null, percent: 100, resetAt: null },
        { label: 'weekly', used: null, total: null, percent: 26.85, resetAt: null },
        { label: 'monthly', used: null, total: null, percent: 98.42, resetAt: null },
      ],
    },
  ],
};

test('detects the Ark plan family from the provider baseUrl path', () => {
  assert.equal(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding'), 'coding-plan');
  assert.equal(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'coding-plan');
  assert.equal(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/plan'), 'agent-plan');
  assert.equal(arkPlanFromBaseUrl('https://ark.cn-beijing.volces.com/api/v3'), null, 'bare inference path stays unknown');
  assert.equal(arkPlanFromBaseUrl(''), null);
  assert.equal(arkPlanFromBaseUrl('not a url'), null);
});

test('ark bar shows the active plan windows compactly, with all plans in the tooltip', () => {
  const agent = formatArkQuota(ARK_FIXTURE, 'https://ark.cn-beijing.volces.com/api/plan');
  assert.ok(agent.text.startsWith('5h 100% · 1wk 84% · 1m 70%'), agent.text);
  assert.equal(agent.color, '#58a6ff', 'color from the displayed (agent) plan, max used 29.77%');
  assert.ok(agent.title.includes('Agent · medium（当前 provider）'), agent.title);
  assert.ok(agent.title.includes('  5h: 10.55/10000 (0.11%)'), agent.title);
  assert.ok(agent.title.includes('Coding'), 'coding plan stays reachable in the tooltip');
  assert.ok(agent.title.includes('Coding（当前 provider）') === false, 'coding not marked current');

  const coding = formatArkQuota(ARK_FIXTURE, 'https://ark.cn-beijing.volces.com/api/coding/v3');
  // Canonical window order: 1wk/1m first, the ark-specific 会话 label last.
  assert.ok(coding.text.startsWith('1wk 73% · 1m 2% · 会话 0%'), coding.text);
  assert.equal(coding.color, '#f85149', 'coding 会话 100% used → 0% remaining → red');

  const unknown = formatArkQuota(ARK_FIXTURE, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.ok(unknown.text.startsWith('5h 100%'), unknown.text);
  assert.ok(unknown.text.includes('当前') === false, 'no plan marked in the bar text');
});

test('ark bar renders reset countdowns when resetAt is present', () => {
  const now = Date.now();
  const fixture = {
    status: 'ok',
    fetchedAt: now,
    viewer: null,
    items: [
      {
        product: 'agent-plan', edition: 'personal', tier: 'medium', subscribed: true, error: null,
        periods: [
          { label: '5h', used: 7200, total: 10000, percent: 72, resetAt: now + 3600000 },
          { label: 'weekly', used: 5000, total: 50000, percent: 10, resetAt: now + 3 * 86400000 + 5 * 3600000 },
          { label: 'monthly', used: 30000, total: 200000, percent: 15, resetAt: now + 25 * 86400000 + 20 * 3600000 },
        ],
      },
    ],
  };
  const view = formatArkQuota(fixture, 'https://ark.cn-beijing.volces.com/api/plan');
  assert.ok(view.text.includes('5h 28% 1h'), `expected '5h 28% 1h' in: ${view.text}`);
  assert.ok(view.text.includes('1wk 90% 3d 5h'), `expected '1wk 90% 3d 5h' in: ${view.text}`);
  assert.ok(view.text.includes('1m 85% 25d 20h'), `expected '1m 85% 25d 20h' in: ${view.text}`);
  assert.ok(view.title.includes('重置'), 'tooltip shows reset timestamp');
});

test('switching provider baseUrl to a vendor endpoint immediately refreshes its quota', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ status: 'ok', fetchedAt: Date.now(), items: [] }) };
  };
  try {
    setProviderBaseUrl(''); // baseline: no vendor active
    setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.some((u) => u.includes('/api/ark/quota')), `expected an ark quota fetch, got: ${calls.join(', ') || '(none)'}`);

    // Re-applying the same baseUrl must not refetch (only a real switch does).
    calls.length = 0;
    setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'unchanged baseUrl must not refetch');
  } finally {
    global.fetch = origFetch;
    setProviderBaseUrl('');
  }
});

// The 60s backoff exists to stop a broken endpoint from being hammered by
// automatic refreshes. A provider switch is the user asking for this vendor's
// number right now, so it must not be swallowed by a failure a moment earlier.
test('an explicit provider switch refetches inside the error-backoff window', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('vendor down');
  };
  try {
    setProviderBaseUrl('');
    setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'first switch fetches');

    // Immediately switch again: still well inside ARK_QUOTA_BACKOFF_MS.
    setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/plan');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'the backoff must yield to an explicit switch');
  } finally {
    global.fetch = origFetch;
    setProviderBaseUrl('');
  }
});

// The cli-gated bars are fetch-on-demand — nothing polls them — so a CLI switch
// left the new CLI's bar showing whatever localStorage had until it was clicked.
test('switching CLI refreshes the newly active cli-gated bar exactly once', async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ status: 'ok', fetchedAt: Date.now() }) };
  };
  try {
    setCli('claude');
    await new Promise((resolve) => setImmediate(resolve));
    calls.length = 0;

    setCli('codex');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['/api/codex/quota'], 'the codex bar refreshes on the switch to codex');

    // Re-applying the same CLI is not a switch.
    calls.length = 0;
    setCli('codex');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, 'unchanged cli must not refetch');
  } finally {
    global.fetch = origFetch;
    setCli('codex');
  }
});

// GLM speaks the Anthropic protocol at open.bigmodel.cn, so those sessions run
// under the claude CLI while the poller still tags their window 'glm'. Gating on
// the CLI alone dropped the event and the session showed no 5h bar at all.
test('a GLM window renders under the claude CLI when the provider is a Zhipu endpoint', async () => {
  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok', fetchedAt: Date.now(), sites: [] }) });
  global.document = { getElementById: id => id === 'claude-rate-limit-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    setCli('claude');
    setProviderBaseUrl('https://open.bigmodel.cn/api/anthropic');
    consumeRateLimitEvent({
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4, provider: 'glm',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    }, 'glm-claude-sess');
    assert.equal(element.style.display, 'block', 'GLM 5h shows on a claude-CLI Zhipu session');
    assert.match(element.textContent, /^5h 60%/);

    // Switching that session to another vendor must drop the GLM numbers rather
    // than leaving them on screen attributed to the new provider.
    setProviderBaseUrl('https://api.deepseek.com/anthropic');
    assert.equal(element.style.display, 'none', 'GLM window hidden once the provider is not Zhipu');
  } finally {
    global.fetch = origFetch;
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('a DeepSeek balance renders under the claude CLI when the provider is api.deepseek.com', () => {
  const element = { style: {}, textContent: '', title: '' };
  const values = new Map();
  global.document = { getElementById: id => id === 'usage-balance-bar' ? element : null };
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, v) => values.set(key, v),
    removeItem: key => values.delete(key),
  };
  try {
    setCli('claude');
    setProviderBaseUrl('https://api.deepseek.com/anthropic');
    consumeBalanceEvent({ kind: 'balance', available: true, currency: 'CNY', total: 42.5 }, 'ds-claude-sess');
    assert.equal(element.style.display, 'block', 'balance shows on a claude-CLI DeepSeek session');
    assert.equal(element.textContent, '¥42.50');

    setProviderBaseUrl('https://api.anthropic.com');
    assert.equal(element.style.display, 'none', 'balance hidden once the provider is not DeepSeek');
  } finally {
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

// ── 窗口顺序统一（5h → 1wk → 1m）──────────────────────────────────────────

test('sortWindowSegs orders window segments short → long from any input order', () => {
  const shuffled = [
    unifiedWindowSeg('1m', 80, null),
    unifiedWindowSeg('5h', 10, null),
    unifiedWindowSeg('1wk', 30, null),
  ];
  const ordered = sortWindowSegs(shuffled).map((s) => s.split(' ')[0]);
  assert.deepEqual(ordered, ['5h', '1wk', '1m']);
});

test('sortWindowSegs keeps unknown labels last and stable', () => {
  const segs = [
    unifiedWindowSeg('1wk', 30, null),
    '会话 50%',
    unifiedWindowSeg('5h', 10, null),
    'Total 90%',
  ];
  const ordered = sortWindowSegs(segs);
  assert.equal(ordered[0].startsWith('5h'), true);
  assert.equal(ordered[1].startsWith('1wk'), true);
  assert.equal(ordered[2], '会话 50%', 'unknown label order preserved among unknowns');
  assert.equal(ordered[3], 'Total 90%');
});

test('sortWindowSegs is non-mutating and tolerates junk input', () => {
  const segs = [unifiedWindowSeg('1m', 80, null)];
  const copy = segs.slice();
  const out = sortWindowSegs(segs);
  assert.deepEqual(segs, copy, 'input array untouched');
  assert.deepEqual(sortWindowSegs(null), []);
  assert.deepEqual(sortWindowSegs(undefined), []);
  assert.equal(out[0].startsWith('1m'), true);
});

// ── Claude 订阅 weekly 用量（/api/claude/quota 抓取）────────────────────────

test('Claude formatter appends weekly/monthly usage windows in canonical order', () => {
  const now = Date.now();
  const value = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5,
    resetsAt: Math.floor(now / 1000) + 3600,
  }, now);
  const usage = {
    status: 'ok',
    fetchedAt: now,
    source: 'usage-page',
    summary: [
      { window: '1m', label: 'Monthly limit', usedPercent: 80, resetMs: now + 10 * 86400_000 },
      { window: '5h', label: 'Current session', usedPercent: 20, resetMs: now + 3600_000 },
      { window: '1wk', label: 'Weekly limit', usedPercent: 30, resetMs: now + 3 * 86400_000 },
    ],
  };
  const view = formatFiveHourRateLimit(value, { usage, nowMs: now });
  const tokens = view.text.split(' · ').map((s) => s.split(' ')[0]);
  // Three slots in canonical 5h → 1wk → 1m order, then the sync-age stamp. The
  // page's own 5h row loses to the passive event, which is fresher.
  assert.deepEqual(tokens.slice(0, 3), ['5h', '1wk', '1m']);
  assert.match(view.text, /^5h 50%/);
  assert.match(view.text, /1wk 70%/);
  assert.match(view.text, /1m 20%/);
  assert.match(view.title, /周: 已用 30%/);
  assert.match(view.title, /月: 已用 80%/);
});

test('Claude formatter ignores a usage payload without ok status', () => {
  const now = 1_700_000_000_000;
  // Direct DTO (exact resetsAtMs, no second-truncation) so the countdown is exact.
  const limit = {
    kind: 'five_hour',
    status: 'allowed',
    usedPercentage: 50,
    resetsAtMs: now + 3_600_000,
    provider: 'claude',
  };
  // A failed scrape leaves the 1wk/1m slots blank — it never blanks or replaces
  // the 5h number the passive event already supplied.
  assert.equal(formatFiveHourRateLimit(limit, { usage: { status: 'needs_login' }, nowMs: now }).text, '5h 50% 1h · 1wk - · ⟳ 登录');
  assert.equal(formatFiveHourRateLimit(limit, { usage: null, nowMs: now }).text, '5h 50% 1h · 1wk - · ⟳ 刷新');
});

test('the Claude bar is one layout whether or not a passive event has landed', () => {
  const now = 1_700_000_000_000;
  const usage = {
    status: 'ok',
    fetchedAt: now,
    summary: [
      { window: '5h', label: 'Current session', usedPercent: 50, resetMs: now + 3_600_000 },
      { window: '1wk', label: 'Weekly limit', usedPercent: 25, resetMs: now + 3 * 86_400_000 },
    ],
  };
  const limit = {
    kind: 'five_hour', status: 'allowed', usedPercentage: 50,
    resetsAtMs: now + 3_600_000, provider: 'claude',
  };
  const withEvent = formatFiveHourRateLimit(limit, { usage, nowMs: now });
  const scrapeOnly = formatClaudeUsageOnly(usage, { nowMs: now });
  // Same numbers in, same bar out: the event only decides WHERE the 5h number
  // comes from. Two sessions on one account must not render differently.
  assert.equal(withEvent.text, scrapeOnly.text);
  assert.match(withEvent.text, /^5h 50% 1h · 1wk 75% 3d/);
});

test('a window the scrape could not classify is left blank, never labelled with page text', () => {
  const now = 1_700_000_000_000;
  const usage = {
    status: 'ok',
    fetchedAt: now,
    summary: [
      { window: '5h', label: 'Current session', usedPercent: 7, resetMs: now + 3_600_000 },
      // What an unparsed weekly row looks like: the reset line stood in for the
      // window name. It must not reach the bar as a label.
      { window: null, label: 'Resets Wed 2:00 PM', usedPercent: 25, resetMs: null },
    ],
  };
  const view = formatClaudeUsageOnly(usage, { nowMs: now });
  assert.equal(view.text.includes('Resets'), false, 'raw page text never becomes a window label');
  assert.match(view.text, /^5h 93% 1h/);
});

test('every weekly row the page meters gets its own segment, named by what it meters', () => {
  const now = 1_700_000_000_000;
  const usage = {
    status: 'ok',
    fetchedAt: now,
    summary: [
      { window: '1wk', label: 'All models', usedPercent: 25, resetMs: now + 86_400_000 },
      { window: '1wk', label: 'Fable', usedPercent: 90, resetMs: now + 86_400_000 },
    ],
  };
  const view = formatClaudeUsageOnly(usage, { nowMs: now });
  // Claude meters its weekly limit more than one way, so collapsing the rows
  // throws away a number the account actually has. Show them all, each named
  // by the model it meters.
  assert.match(view.text, /^5h - · 1wk-ALL 75% 1d · 1wk-Fable 10% 1d/);
  assert.equal(view.color, '#f85149', 'the bar takes its colour from the worst row');
  assert.match(view.title, /周（All models）: 已用 25%/);
  assert.match(view.title, /周（Fable）: 已用 90%/);
});

test('the bar keeps its shape when data is missing, and 刷新 is always the last segment', () => {
  const now = 1_700_000_000_000;
  // Nothing at all: both windows still render, blank rather than absent, so a
  // missing number is visibly missing instead of silently dropping a segment.
  assert.equal(formatClaudeUsageOnly(null, { nowMs: now }).text, '5h - · 1wk - · ⟳ 刷新');
  // Claude has no monthly limit, so 1m is never placeheld…
  assert.equal(formatClaudeUsageOnly(null, { nowMs: now }).text.includes('1m'), false);
  // …but a monthly row is still rendered if the page ever grows one.
  assert.match(formatClaudeUsageOnly({
    status: 'ok',
    fetchedAt: now,
    summary: [{ window: '1m', label: 'Monthly limit', usedPercent: 20, resetMs: now + 15 * 86_400_000 }],
  }, { nowMs: now }).text, /^5h - · 1wk - · 1m 80% 15d/);
});

test('formatClaudeUsageOnly renders windows when no passive event has landed yet', () => {
  const now = Date.now();
  const usage = {
    status: 'ok',
    fetchedAt: now,
    summary: [
      { window: '5h', label: 'Current session', usedPercent: 60, resetMs: now + 3600_000 },
      { window: '1wk', label: 'Weekly limit', usedPercent: 90, resetMs: now + 3 * 86400_000 },
    ],
  };
  const view = formatClaudeUsageOnly(usage);
  // The first two segments are the windows in canonical order; the trailing
  // segment is the sync-age stamp (e.g. "刚刚").
  assert.deepEqual(view.text.split(' · ').slice(0, 2).map((s) => s.split(' ')[0]), ['5h', '1wk']);
  assert.match(view.text, /5h 40%/);
  assert.match(view.text, /1wk 10%/);
  assert.equal(view.color, '#f85149', '10% remaining for weekly is danger-colored');
});

test('scrape trouble routes the click to login and explains itself in the tooltip', () => {
  // The bar itself stays the same row of windows in every state — why the
  // numbers are missing belongs in the tooltip, not in the one line of text
  // the user reads at a glance.
  const states = ['needs_login', 'chrome_unavailable', 'unavailable', 'ok'];
  for (const status of states) {
    const view = formatClaudeUsageOnly({ status, summary: [], error: 'x' });
    assert.equal(view.text, `5h - · 1wk - · ${status === 'needs_login' || status === 'chrome_unavailable' ? '⟳ 登录' : '⟳ 刷新'}`, status);
  }
  assert.equal(formatClaudeUsageOnly({ status: 'needs_login' }).action, 'login');
  assert.match(formatClaudeUsageOnly({ status: 'needs_login' }).title, /没有 claude\.ai 的登录态/);
  // No Chrome to talk to is also fixed by opening the login window.
  assert.equal(formatClaudeUsageOnly({ status: 'chrome_unavailable' }).action, 'login');
  assert.equal(formatClaudeUsageOnly({ status: 'unavailable', error: 'boom' }).action, undefined);
  assert.match(formatClaudeUsageOnly({ status: 'ok', summary: [] }).title, /没解析出窗口百分比/);
});

test('the trailing segment says what the click will do, and then what it is doing', () => {
  const now = 1_700_000_000_000;
  const usage = {
    status: 'ok',
    fetchedAt: now,
    summary: [{ window: '1wk', label: 'All models', usedPercent: 25, resetMs: now + 86_400_000 }],
  };
  const seg = (o) => formatClaudeUsageOnly(o.usage === undefined ? usage : o.usage, { ...o, nowMs: now })
    .text.split(' · ').pop();
  // The scrape is a 30-40s browser drive. A trailing segment that reads the
  // same before and during it makes the click look ignored — which is exactly
  // how it looked when every state rendered '⟳ 刷新'.
  assert.equal(seg({}), '⟳ 刷新');
  assert.equal(seg({ fetching: true }), '⟳ 抓取中…', 'a click on fresh data still shows it landed');
  assert.equal(seg({ usage: null, fetching: true }), '⟳ 抓取中…');
  assert.equal(seg({ usage: { status: 'needs_login' } }), '⟳ 登录', 'the click opens a login window, so say so');
  assert.equal(seg({ usage: { status: 'needs_login' }, loginPending: true }), '⟳ 等待登录…');
  // …and the same flags survive the passive-event entry point.
  const limit = {
    kind: 'five_hour', status: 'allowed', usedPercentage: 7,
    resetsAtMs: now + 42 * 60_000, provider: 'claude',
  };
  assert.match(formatFiveHourRateLimit(limit, { usage, fetching: true, nowMs: now }).text, /⟳ 抓取中…$/);
});

test('a live 5h event does not hide that the scrape still needs a login', () => {
  const now = 1_700_000_000_000;
  const limit = {
    kind: 'five_hour', status: 'allowed', usedPercentage: 7,
    resetsAtMs: now + 42 * 60_000, provider: 'claude',
  };
  // The event fills 5h but says nothing about the weekly windows, so the click
  // must still open the login window rather than re-running a scrape that will
  // fail the same way.
  const view = formatFiveHourRateLimit(limit, { usage: { status: 'needs_login' }, nowMs: now });
  assert.equal(view.text, '5h 93% 42m · 1wk - · ⟳ 登录');
  assert.equal(view.action, 'login');
});

test('refreshClaudeUsage stores ok data and surfaces fetch failures', async () => {
  const element = { style: {}, textContent: '', title: '', onclick: null };
  const values = new Map();
  global.document = { getElementById: (id) => (id === 'claude-rate-limit-bar' ? element : null) };
  global.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return { json: async () => ({ status: 'ok', fetchedAt: Date.now(), summary: [
      { window: '1wk', label: 'Weekly limit', usedPercent: 30, resetMs: Date.now() + 86400_000 },
    ] }) };
  };
  try {
    // setCli('claude') triggers the fetch-on-switch; the mock is already in
    // place, so let that auto-refresh settle before the explicit force call.
    setCli('claude');
    setProviderBaseUrl('');
    await new Promise((r) => setTimeout(r, 0));
    const data = await refreshClaudeUsage(true);
    assert.equal(data.status, 'ok');
    assert.equal(calls[0], '/api/claude/quota');
    assert.equal(values.has('multicc.claude.usage.v1'), true, 'ok scrape persisted');
    // The bar now merges the scrape's weekly window into the (absent) 5h event.
    assert.match(element.textContent, /1wk 70%/);
  } finally {
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
    delete global.fetch;
  }
});

test('refreshClaudeUsage records errors without persisting junk', async () => {
  const element = { style: {}, textContent: '', title: '', onclick: null };
  const values = new Map();
  global.document = { getElementById: (id) => (id === 'claude-rate-limit-bar' ? element : null) };
  global.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  global.fetch = async () => ({ json: async () => ({ status: 'needs_login', error: 'no session' }) });
  try {
    setCli('claude');
    setProviderBaseUrl('');
    await new Promise((r) => setTimeout(r, 0));
    const data = await refreshClaudeUsage(true);
    assert.equal(data.status, 'needs_login');
    assert.equal(values.has('multicc.claude.usage.v1'), false, 'non-ok scrape not persisted');
    assert.equal(element.textContent, '5h - · 1wk - · ⟳ 登录', 'the bar now offers the fix, not a retry');
    assert.match(element.title, /登录/, 'why the numbers are missing is in the tooltip');
    assert.equal(typeof element.onclick, 'function', 'bar stays a click target');
  } finally {
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
    delete global.fetch;
  }
});

test('restoreClaudeUsage pulls the cached scrape back into the bar', () => {
  const element = { style: {}, textContent: '', title: '', onclick: null };
  const values = new Map();
  values.set('multicc.claude.usage.v1', JSON.stringify({
    status: 'ok',
    fetchedAt: Date.now(),
    summary: [{ window: '1wk', label: 'Weekly limit', usedPercent: 30, resetMs: null }],
  }));
  global.document = { getElementById: (id) => (id === 'claude-rate-limit-bar' ? element : null) };
  global.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  try {
    setCli('claude');
    setProviderBaseUrl('');
    restoreClaudeUsage();
    assert.match(element.textContent, /1wk 70%/);
  } finally {
    setProviderBaseUrl('');
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

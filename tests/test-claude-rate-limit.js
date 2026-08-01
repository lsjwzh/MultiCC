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
  assert.deepEqual(formatFiveHourRateLimit(limit, { nowMs: now }), {
    text: '5h 28% 1h',
    color: '#d29922',
    title: 'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）',
  });
  assert.equal(formatFiveHourRateLimit(limit, { nowMs: now + 3_600_000 }), null);
  assert.equal(formatFiveHourRateLimit({
    ...limit,
    status: 'rejected',
  }, { nowMs: now }).text, '5h 0% 1h');
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
    assert.match(element.textContent, /^5h · —/, 'GLM window replaced by Claude idle placeholder');
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
    assert.match(element.textContent, /^5h · —/, 'Codex weekly replaced by Claude idle placeholder');
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
    assert.match(element.textContent, /^5h · —/);

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
  assert.ok(coding.text.startsWith('会话 0% · 1wk 73% · 1m 2%'), coding.text);
  assert.equal(coding.color, '#f85149', 'coding 会话 100% used → 0% remaining → red');

  const unknown = formatArkQuota(ARK_FIXTURE, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.ok(unknown.text.startsWith('5h 100%'), unknown.text);
  assert.ok(unknown.text.includes('当前') === false, 'no plan marked in the bar text');
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

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
} = require('../public/chat-rate-limit');

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
  assert.deepEqual(formatFiveHourRateLimit(limit, {
    nowMs: now,
    formatReset: () => '15:40',
  }), {
    text: 'Claude 5h 72.4% · 15:40 重置',
    color: '#d29922',
    title: 'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）',
  });
  assert.equal(formatFiveHourRateLimit(limit, { nowMs: now + 3_600_000 }), null);
  assert.equal(formatFiveHourRateLimit({
    ...limit,
    status: 'rejected',
  }, {
    nowMs: now,
    formatReset: () => '15:40',
  }).text, 'Claude 5h 已达上限 · 15:40 重置');
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
    assert.match(element.textContent, /^Claude 5h 72% · .+ 重置$/);
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

test('GLM window limit labels as GLM 5h and shows under codex, hides under claude', () => {
  const value = normalizeFiveHourRateLimit({
    status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44,
    resetsAt: Math.floor(Date.now() / 1000) + 3600, provider: 'glm',
  }, Date.now());
  assert.equal(value.provider, 'glm');
  assert.match(formatFiveHourRateLimit(value).text, /^GLM 5h 44% · .+ 重置$/);

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
    assert.match(element.textContent, /^GLM 5h 44%/);
    setCli('claude');
    assert.equal(element.style.display, 'none', 'GLM window hidden under claude');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

test('DeepSeek balance normalizes, formats, and renders in its own bar under codex', () => {
  assert.equal(normalizeBalance({ kind: 'window' }), null, 'rejects non-balance');
  const bal = normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 110 });
  assert.equal(bal.provider, 'deepseek');
  assert.equal(formatBalance(bal).text, 'DeepSeek 余额 ¥110.00');
  const exhausted = normalizeBalance({ kind: 'balance', available: false, currency: 'USD', total: 0 });
  assert.match(formatBalance(exhausted).text, /余额不足/);
  assert.equal(formatBalance(exhausted).text, 'DeepSeek 余额 $0.00 · 余额不足');

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
    assert.equal(element.textContent, 'DeepSeek 余额 ¥42.50');
    setCli('claude');
    assert.equal(element.style.display, 'none', 'balance hidden under claude');
  } finally {
    setCli('codex');
    delete global.document;
    delete global.localStorage;
  }
});

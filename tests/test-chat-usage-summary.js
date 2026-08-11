'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RATE_LIMIT_PATH = path.join(ROOT, 'public', 'chat-rate-limit.js');
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');

function element() {
  return { style: {}, textContent: '', innerHTML: '', title: '', onclick: null };
}

function rateLimitHarness(seed = {}) {
  const ids = [
    'claude-rate-limit-bar', 'usage-balance-bar', 'opencode-quota-bar',
    'qoder-quota-bar', 'codex-quota-bar', 'ark-quota-bar',
    'zhipu-quota-bar', 'kimi-quota-bar', 'cost-bar',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const values = new Map(Object.entries(seed));
  const previous = {
    document: global.document,
    localStorage: global.localStorage,
    api: global.MultiCCChatRateLimit,
  };
  global.document = { getElementById: (id) => elements[id] || null };
  global.localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  delete require.cache[require.resolve(RATE_LIMIT_PATH)];
  const api = require(RATE_LIMIT_PATH);
  return {
    api,
    elements,
    cleanup() {
      delete require.cache[require.resolve(RATE_LIMIT_PATH)];
      if (previous.document === undefined) delete global.document;
      else global.document = previous.document;
      if (previous.localStorage === undefined) delete global.localStorage;
      else global.localStorage = previous.localStorage;
      if (previous.api === undefined) delete global.MultiCCChatRateLimit;
      else global.MultiCCChatRateLimit = previous.api;
    },
  };
}

test('OpenCode composes native windows, routed-provider quota and balance with distinct labels', () => {
  const now = Date.now();
  const native = {
    status: 'ok',
    fetchedAt: now - 5_000,
    usage: {
      rolling: { usagePercent: 8, resetInSec: 39 * 60 },
      weekly: { usagePercent: 14, resetInSec: (5 * 24 + 22) * 3600 },
      monthly: { usagePercent: 31, resetInSec: (19 * 24 + 12) * 3600 },
    },
  };
  const h = rateLimitHarness({
    'multicc.opencode.quota.v1': JSON.stringify(native),
  });
  try {
    h.api.setCli('opencode');
    h.api.restoreOpenCodeQuota();
    h.api.consumeRateLimitEvent({
      rateLimitType: 'five_hour', provider: 'glm', status: 'allowed',
      utilization: 0, resetsAt: now + 39 * 60_000,
    }, 'opencode-layout');
    h.api.consumeBalanceEvent({
      kind: 'balance', available: true, currency: 'CNY', total: 87.69,
    }, 'opencode-layout');

    const own = h.elements['opencode-quota-bar'];
    const routed = h.elements['claude-rate-limit-bar'];
    const balance = h.elements['usage-balance-bar'];
    assert.equal(own.style.display, 'block');
    assert.match(own.textContent, /^OpenCode Go · 5h 92% 39m · 1wk 86% 5d 22h · 1m 69% 19d 12h/);
    assert.match(routed.textContent, /^路由供应商 GLM · 5h 100% 39m/);
    assert.match(routed.title, /不是 OpenCode Go 订阅额度/);
    assert.equal(balance.textContent, 'DeepSeek 余额 · ¥87.69');
    assert.equal((own.textContent.match(/\b5h\b/g) || []).length, 1);
    assert.equal((routed.textContent.match(/\b5h\b/g) || []).length, 1);
  } finally {
    h.cleanup();
  }
});

test('OpenCode native formatter keeps its source label and degrades cleanly when windows are missing', () => {
  const h = rateLimitHarness();
  try {
    const partial = h.api.formatOpenCodeQuota({
      status: 'ok', fetchedAt: Date.now(),
      usage: { weekly: { usagePercent: 14 } },
    });
    assert.match(partial.text, /^OpenCode Go · 1wk 86%/);
    assert.doesNotMatch(partial.text, /undefined|NaN|5h|1m/);

    const empty = h.api.formatOpenCodeQuota({ status: 'ok', fetchedAt: Date.now(), usage: {} });
    assert.match(empty.text, /^OpenCode Go · —/);
    assert.doesNotMatch(empty.text, /undefined|NaN/);
  } finally {
    h.cleanup();
  }
});

test('usage summary DOM has exactly two semantic rows and keeps cost in the secondary row', () => {
  assert.equal((CHAT_HTML.match(/class="usage-summary-row/g) || []).length, 2);
  const primaryStart = CHAT_HTML.indexOf('id="usage-primary-row"');
  const secondaryStart = CHAT_HTML.indexOf('id="usage-secondary-row"');
  const summaryEnd = CHAT_HTML.indexOf('</section>', secondaryStart);
  assert.ok(primaryStart > 0 && secondaryStart > primaryStart && summaryEnd > secondaryStart);

  const primary = CHAT_HTML.slice(primaryStart, secondaryStart);
  const secondary = CHAT_HTML.slice(secondaryStart, summaryEnd);
  for (const id of ['opencode-quota-bar', 'qoder-quota-bar', 'codex-quota-bar']) {
    assert.match(primary, new RegExp(`id="${id}"[^>]*data-usage-role="native"`));
  }
  for (const id of ['claude-rate-limit-bar', 'usage-balance-bar', 'ark-quota-bar', 'zhipu-quota-bar', 'kimi-quota-bar', 'cost-bar']) {
    assert.match(secondary, new RegExp(`id="${id}"`));
  }
  assert.match(secondary, /id="cost-bar"[^>]*data-usage-role="cost"/);
  assert.match(CHAT_JS, /costBar\.innerHTML = parts\.join\(''\);/, 'an empty update clears stale cost text');
});

test('desktop quota layout is capped at two nowrap rows; narrow layout wraps only in controlled rows', () => {
  assert.match(CHAT_HTML, /#usage-summary\s*\{[\s\S]*?flex-direction:\s*column;/);
  assert.match(CHAT_HTML, /\.usage-summary-row\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/);
  assert.match(CHAT_HTML, /@media \(max-width: 760px\)[\s\S]*?\.usage-summary-primary\s*\{[^}]*width:\s*100%;[^}]*overflow-x:\s*visible;/);
  assert.match(CHAT_HTML, /@media \(max-width: 760px\)[\s\S]*?\.usage-summary-primary \.usage-summary-bar\s*\{[\s\S]*?max-width:\s*calc\(100vw - 12px\);[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(CHAT_HTML, /@media \(max-width: 760px\)[\s\S]*?\.usage-summary-secondary\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?overflow-x:\s*visible;/);
  assert.equal((CHAT_HTML.match(/id="opencode-quota-bar"/g) || []).length, 1, 'narrow layout never mounts a duplicate native meter');
  assert.equal((CHAT_HTML.match(/id="claude-rate-limit-bar"/g) || []).length, 1, 'narrow layout never mounts a duplicate provider meter');
});

test('non-OpenCode CLIs preserve their existing quota text and hide the OpenCode native row', () => {
  const h = rateLimitHarness({
    'multicc.opencode.quota.v1': JSON.stringify({
      status: 'ok', fetchedAt: Date.now(),
      usage: { rolling: { usagePercent: 8, resetInSec: 60 } },
    }),
  });
  try {
    h.api.setCli('codex');
    h.api.restoreOpenCodeQuota();
    assert.equal(h.elements['opencode-quota-bar'].style.display, 'none');
    h.api.consumeRateLimitEvent({
      rateLimitType: 'weekly', provider: 'codex', status: 'allowed',
      utilization: 0.25, resetsAt: Date.now() + 3600_000,
    }, 'codex-layout');
    assert.match(h.elements['claude-rate-limit-bar'].textContent, /^1wk 75%/);
    assert.doesNotMatch(h.elements['claude-rate-limit-bar'].textContent, /路由供应商/);
  } finally {
    h.cleanup();
  }
});

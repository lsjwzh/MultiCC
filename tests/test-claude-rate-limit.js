'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The quota bar's words, colors, ordering and vendor rules are rendered once on
// the server (src/quota/quota-bar-view.js) and arrive on every response/event as
// a `bar`. public/chat-rate-limit.js no longer formats anything — it caches,
// fetches, gates and paints. These tests therefore split into two halves:
//   • the renderer + token resolver (the logic that used to live in the client);
//   • the client plumbing that stayed: consume → gate → persist → restore.
const Renderer = require('../src/quota/quota-bar-view');
const { resolveQuotaBar, humanizeCountdown } = require('../public/quota-bar-view');
const Client = require('../public/chat-rate-limit');

const NOW = 1_700_000_000_000;
const resolve = (bar, opts) => resolveQuotaBar(bar, { now: NOW, ...opts });

// ── Pure resolved helpers (the formulas the bar text is built from) ──
function unifiedRemaining(usedPercent) {
  if (!Number.isFinite(usedPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}
function unifiedBalanceText(amount, currency) {
  if (!Number.isFinite(amount)) return '';
  const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
  return `${sym}${Number(amount).toFixed(2)}`;
}

// ── Renderer: normalization ────────────────────────────────────────────────
const normalizeFiveHourRateLimit = (info, nowMs) => Renderer.normalizeWindowEvent(info, nowMs);

test('normalizes a Claude five-hour event into a privacy-minimal DTO', () => {
  const value = normalizeFiveHourRateLimit({
    status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.724,
    resetsAt: 1_700_003_600, overageDisabledReason: 'out_of_credits', token: 'must-not-leak',
  }, NOW);
  assert.deepEqual(value, {
    schemaVersion: 1, kind: 'five_hour', status: 'allowed_warning',
    usedPercentage: 72.4, resetsAtMs: 1_700_003_600_000, observedAtMs: NOW,
    source: 'claude_code', provider: 'claude',
  });
  assert.equal('token' in value, false);
  assert.equal('overageDisabledReason' in value, false);
  assert.equal(Object.isFrozen(value), true);
});

test('rejects unrelated or malformed limit events', () => {
  assert.equal(normalizeFiveHourRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 }, NOW), null);
  assert.equal(normalizeFiveHourRateLimit({ status: 'unknown', rateLimitType: 'five_hour', utilization: 0.8 }, NOW), null);
  // A weekly window that would resolve to Claude is malformed (Claude's weekly
  // comes only from the usage-page scrape, and the poller tags weekly 'codex').
  assert.equal(normalizeFiveHourRateLimit({ status: 'allowed', rateLimitType: 'weekly', utilization: 0.5 }, NOW), null);
});

test('tags the provider from the event and resolves resetsAt seconds→ms', () => {
  const glm = normalizeFiveHourRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' }, NOW);
  assert.equal(glm.provider, 'glm');
  assert.equal(glm.resetsAtMs, NOW + 3_600_000);
  const codex = normalizeFiveHourRateLimit({ status: 'allowed', rateLimitType: 'weekly', utilization: 0.64, resetsAt: (NOW + 3_600_000) / 1000, provider: 'codex' }, NOW);
  assert.equal(codex.provider, 'codex');
  assert.equal(normalizeFiveHourRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 }, NOW).provider, 'claude');
});

// ── Renderer: bars (key invariants; the golden parity test pins exact text) ──
test('the Claude bar renders every window, "-" for missing data, and is always clickable', () => {
  const live = normalizeFiveHourRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.724, resetsAt: (NOW + 3_600_000) / 1000 }, NOW);
  assert.match(resolve(Renderer.claudeBar(null, live)).text, /^5h 28% 1h · 1wk - · ⟳ 刷新$/);
  assert.equal(resolve(Renderer.claudeBar(null, live)).color, '#d29922');
  // Idle (no data at all) still shows the shape and the refresh affordance.
  assert.equal(resolve(Renderer.claudeBar(null, null)).text, '5h - · 1wk - · ⟳ 刷新');
  // needs_login turns the affordance into a login action.
  assert.equal(resolve(Renderer.claudeBar({ status: 'needs_login' }, live)).action, 'login');
});

test('GLM 5h, Codex weekly and OpenCode weekly render as single window segments', () => {
  const glm = Renderer.normalizeWindowEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' }, NOW);
  const codex = Renderer.normalizeWindowEvent({ status: 'allowed', rateLimitType: 'weekly', utilization: 0.64, resetsAt: (NOW + 3_600_000) / 1000, provider: 'codex' }, NOW);
  const opencode = Renderer.normalizeWindowEvent({ status: 'rejected', rateLimitType: 'weekly', utilization: 1, resetsAt: (NOW + 86_400_000) / 1000, provider: 'opencode' }, NOW);
  assert.match(resolve(Renderer.windowEventBar(glm)).text, /^5h 56% 1h$/);
  assert.match(resolve(Renderer.windowEventBar(codex)).text, /^1wk 36% 1h$/);
  assert.match(resolve(Renderer.windowEventBar(opencode)).text, /^OpenCode Go · 1wk 0% 1d$/);
});

test('the OpenCode routed-provider label says whose window it is', () => {
  const glm = Renderer.normalizeWindowEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' }, NOW);
  const labeled = Renderer.labelRoutedProvider(Renderer.windowEventBar(glm), 'glm');
  assert.match(resolve(labeled).text, /^路由供应商 GLM · 5h 56%/);
});

// ── Renderer + resolver: balance ──
test('balance normalizes and formats as money, warning when low or exhausted', () => {
  assert.equal(Renderer.normalizeBalance({ kind: 'window' }), null);
  const ok = Renderer.normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 110 });
  assert.equal(ok.provider, 'deepseek');
  assert.equal(resolve(Renderer.balanceBar(ok)).text, '¥110.00');
  const exhausted = Renderer.normalizeBalance({ kind: 'balance', available: false, currency: 'USD', total: 0 });
  assert.equal(resolve(Renderer.balanceBar(exhausted)).text, '$0.00 · 余额不足');
  assert.equal(resolve(Renderer.balanceBar(exhausted)).color, '#f85149');
});

// ── Pure helper formulas ──
test('humanizeCountdown buckets, unifiedRemaining clamps, balance text formats', () => {
  assert.equal(humanizeCountdown(30 * 60_000), '30m');
  assert.equal(humanizeCountdown(3_600_000), '1h');
  assert.equal(humanizeCountdown(5_400_000), '1.5h');
  assert.equal(humanizeCountdown(25 * 3_600_000), '1d 1h');
  assert.equal(unifiedRemaining(72.4), 28);
  assert.equal(unifiedRemaining(150), 0);
  assert.equal(unifiedRemaining(null), null);
  assert.equal(unifiedBalanceText(110, 'CNY'), '¥110.00');
  assert.equal(unifiedBalanceText(42.5, null), '42.50');
});

// ── Token expansion (the one piece of client-side math) ──
test('the resolver expands {cd:} and {ago:} at paint time and never lies about age', () => {
  const bar = { text: '{cd:' + (NOW + 3_600_000) + '} · {ago:' + (NOW - 57_000) + '}', color: '#58a6ff', title: '' };
  const v = resolveQuotaBar(bar, { now: NOW });
  assert.equal(v.text, '1h · 57s 前');
  // A deadline already past reads as "1m", never '' — so separators baked into
  // the server string can never collapse.
  const past = resolveQuotaBar({ text: 'x {cd:' + (NOW - 1_000) + '}', color: '#58a6ff', title: '' }, { now: NOW });
  assert.equal(past.text, 'x 1m');
});

// ── Client plumbing: consume → gate → persist → restore ────────────────────
// The client module is a singleton whose `let currentXxx` state has no reset
// API. To keep these tests independent, each re-loads a fresh client from a
// cleared require cache over a private DOM/storage stub. The client renders into
// #claude-rate-limit-bar / #usage-balance-bar and persists bars to localStorage.
// Seed the same idle bars the page bootstraps from /api/quota/bars/idle, so the
// client has its idle placeholders (without them an unfetched bar is just hidden).
const IDLE_BARS = JSON.parse(JSON.stringify({
  claude: Renderer.claudeBar(null, null),
  opencode: Renderer.renderQuotaBar('opencode', null),
  codex: Renderer.renderQuotaBar('codex', null),
}));

function freshClient() {
  const modPath = require.resolve('../public/chat-rate-limit');
  delete require.cache[modPath];
  const elements = {};
  const values = new Map();
  values.set('multicc.quota.idleBars.v1', JSON.stringify(IDLE_BARS));
  global.document = {
    getElementById: (id) => (elements[id] = elements[id] || { style: {}, textContent: '', title: '', onclick: null }),
  };
  global.localStorage = {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  global.location = { href: 'http://localhost/', search: '' };
  global.fetch = async () => ({ json: async () => ({ status: 'ok', bars: IDLE_BARS }) });
  const C = require('../public/chat-rate-limit');
  C.setCli('claude');
  C.setProviderBaseUrl('');
  return {
    C, values,
    element: (id) => elements[id],
    cleanup() { delete global.document; delete global.localStorage; delete global.location; delete global.fetch; },
  };
}
async function flushClient() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}

test('consumeRateLimitEvent renders the server bar, gates by CLI, and persists it', () => {
  const f = freshClient();
  try {
    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.72, resetsAt: (NOW + 3_600_000) / 1000 };
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'chat-1', bar);
    const el = f.element('claude-rate-limit-bar');
    assert.equal(el.style.display, 'block');
    assert.match(el.textContent, /^5h 28%/);
    assert.ok(f.values.has('multicc:claude-rate-limit:v1:chat-1'), 'the bar is cached per session');

    // Under codex the Claude subscription bar is hidden (provider no longer matches).
    f.C.setCli('codex');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
    f.C.setCli('claude');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
  } finally { f.cleanup(); }
});

test('a GLM 5h window bar shows under codex (provider matches that CLI)', () => {
  const f = freshClient();
  try {
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'glm-sess', bar);
    f.C.setCli('codex');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h 56%/);
  } finally { f.cleanup(); }
});

test('an OpenCode weekly limit event shows only under opencode', () => {
  const f = freshClient();
  try {
    const info = { status: 'rejected', rateLimitType: 'weekly', utilization: 1, resetsAt: (NOW + 86_400_000) / 1000, provider: 'opencode' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'opencode-sess', bar);
    f.C.setCli('opencode');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^OpenCode Go · 1wk 0%/);
    f.C.setCli('codex');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('with no limit event, the idle Claude placeholder shows under claude but hides under a non-Claude provider', () => {
  const f = freshClient();
  try {
    // No rate_limit_event and no scrape → idle placeholder under claude + a Claude baseUrl.
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h - · 1wk -/);
    // Pointing the claude CLI at a Zhipu endpoint is no longer a Claude provider:
    // there is nothing to show, so the bar hides.
    f.C.setProviderBaseUrl('https://open.bigmodel.cn/api/paas/v4');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('consumeBalanceEvent renders, gates (codex shows, claude hides), and persists', () => {
  const f = freshClient();
  try {
    const bar = Renderer.balanceBar(Renderer.normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 42.5 }));
    f.C.consumeBalanceEvent({ kind: 'balance', available: true, currency: 'CNY', total: 42.5 }, 'ds-sess', bar);
    f.C.setCli('codex');
    assert.equal(f.element('usage-balance-bar').style.display, 'block');
    assert.equal(f.element('usage-balance-bar').textContent, '¥42.50');
    f.C.setCli('claude');
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('restoreFiveHourRateLimit replays the persisted bar for the session', () => {
  const f = freshClient();
  try {
    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: (NOW + 3_600_000) / 1000 };
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'chat-1', bar);
    const key = 'multicc:claude-rate-limit:v1:chat-1';
    const raw = f.values.get(key);
    assert.ok(raw, 'the bar is persisted under its session key');
    // Re-load the same session: the persisted bar replays at the right percentage.
    const cached = JSON.parse(raw);
    assert.match(resolveQuotaBar(cached, { now: NOW }).text, /^5h 50%/);
  } finally { f.cleanup(); }
});

test('Ark quota fetch carries the active provider baseUrl and caches per plan', async () => {
  const f = freshClient();
  try {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return {
        json: async () => String(url).startsWith('/api/ark/quota')
          ? { status: 'ok', fetchedAt: NOW, bar: { text: 'Coding', color: '#58a6ff', title: 'Coding（当前 provider）' } }
          : { status: 'ok', bars: IDLE_BARS },
      };
    };
    f.values.set('multicc.ark.quota.v1', JSON.stringify({ status: 'ok', bar: { text: 'Agent', color: '#d29922', title: 'stale global key' } }));
    f.C.setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding');
    await flushClient();
    const arkCalls = calls.filter(url => url.startsWith('/api/ark/quota'));
    assert.ok(arkCalls.some(url => url === '/api/ark/quota?baseUrl=https%3A%2F%2Fark.cn-beijing.volces.com%2Fapi%2Fcoding'));
    assert.equal(f.element('ark-quota-bar').textContent, 'Coding');
    assert.ok(f.values.has('multicc.ark.quota.v1:coding-plan'), 'Coding and Agent cache entries must not share one bar');
    assert.equal(f.values.has('multicc.ark.quota.v1'), true, 'legacy global cache may exist but is no longer read for Ark');
  } finally { f.cleanup(); }
});

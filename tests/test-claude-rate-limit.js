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

// `providerReport: false` leaves the client exactly as the module booted it, so
// the FIRST setProviderBaseUrl a test makes is the page's identity report —
// which is how the real page loads (chat.js reports the session's provider once,
// after the module already restored its localStorage bars).
function freshClient(seed, { providerReport = true } = {}) {
  const modPath = require.resolve('../public/chat-rate-limit');
  delete require.cache[modPath];
  const elements = {};
  const values = new Map();
  values.set('multicc.quota.idleBars.v1', JSON.stringify(IDLE_BARS));
  // A reloaded page: the previous page's persisted session bars are in storage
  // before the module loads (that is what "reload" means here).
  for (const [key, value] of Object.entries(seed || {})) values.set(key, value);
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
  if (providerReport) C.setProviderBaseUrl('');
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

// Regression (2026-09-23 user report): under Codex Exp / Claude Exp on their
// official providers the subscription bar never appeared. Claude Exp is the
// Agent SDK build of the SAME account and provider pool as Claude Code, so the
// bar must be gated on the Claude family, not on the literal 'claude' cli id.
test('the Claude subscription bar (and its idle placeholder) also shows under claude-exp', () => {
  const f = freshClient();
  try {
    f.C.setCli('claude-exp');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block',
      'claude-exp on a Claude provider keeps the idle tap target');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h - · 1wk -/);

    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.72, resetsAt: (NOW + 3_600_000) / 1000 };
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'exp-1', bar);
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h 28%/);

    // A provider routed underneath Claude still switches the bar species:
    // on a Zhipu endpoint the subscription bar hides (same rule as 'claude').
    f.C.setProviderBaseUrl('https://open.bigmodel.cn/api/paas/v4');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('providerMatchesCli treats the Claude family as one CLI', () => {
  assert.equal(Client.providerMatchesCli('claude', 'claude'), true);
  assert.equal(Client.providerMatchesCli('claude', 'claude-exp'), true);
  assert.equal(Client.providerMatchesCli('claude', 'codex'), false);
  assert.equal(Client.providerMatchesCli('codex', 'codex-exp'), true);
  assert.equal(Client.providerMatchesCli('codex', 'claude-exp'), false);
});

// Regression (2026-09-24 user report: 借道 provider 的 limitbar 在 web 上不见了):
// the relay branch compared the CLI to the relay PROTOCOL by literal id, so a
// claude-exp session on a borrowed claude provider dropped every passed-through
// window bar — and claude-exp / codex-exp are the CLIs actually used with
// borrowed providers. The protocol must be judged by CLI family.
test('a borrowed provider gate follows the CLI family, not the literal cli id', () => {
  const f = freshClient();
  try {
    f.C.setProviderBaseUrl('https://relay.example:3000/claude-proxy/glm/remote');
    assert.equal(f.C.providerMatchesCli('claude', 'claude'), true);
    assert.equal(f.C.providerMatchesCli('claude', 'claude-exp'), true);
    assert.equal(f.C.providerMatchesCli('glm', 'claude-exp'), true);
    assert.equal(f.C.providerMatchesCli('claude', 'codex'), false);
    assert.equal(f.C.providerMatchesCli('claude', 'codex-exp'), false);
    f.C.setProviderBaseUrl('https://relay.example:3000/codex-proxy/official');
    assert.equal(f.C.providerMatchesCli('codex', 'codex-exp'), true);
    assert.equal(f.C.providerMatchesCli('codex', 'claude-exp'), false);
  } finally { f.cleanup(); }
});

test('a borrowed window bar paints in a claude-exp session', () => {
  const f = freshClient();
  try {
    f.C.setCli('claude-exp');
    // A claude-protocol relay whose lender is a Claude 官方 subscription
    // provider — the shape every 借用 claude provider has.
    f.C.setProviderBaseUrl('https://relay.example:3000/claude-proxy/official/remote');
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: (NOW + 3_600_000) / 1000, provider: 'claude' };
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'borrowed-exp', bar);
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h 70%/);
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

test('restoreFiveHourRateLimit replays the persisted bar AND its provider identity', () => {
  const f = freshClient();
  try {
    const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: (NOW + 3_600_000) / 1000 };
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'chat-1', bar);
    const key = 'multicc:claude-rate-limit:v1:chat-1';
    const raw = f.values.get(key);
    assert.ok(raw, 'the bar is persisted under its session key');
    // The record carries the identity WITH the bar: the display gate dispatches
    // on info.provider, so a bar stored on its own could never repaint.
    const cached = JSON.parse(raw);
    assert.equal(cached.info.rateLimitType, 'five_hour');
    assert.match(resolveQuotaBar(cached.bar, { now: NOW }).text, /^5h 50%/);
  } finally { f.cleanup(); }
});

test('a legacy bare persisted bar still replays (no identity, no crash)', () => {
  const info = { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: (NOW + 3_600_000) / 1000 };
  const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
  // The shape written before the identity was persisted: the bare server bar.
  const f = freshClient({ 'multicc:claude-rate-limit:v1:old-1': JSON.stringify(bar) });
  try {
    f.C.restoreFiveHourRateLimit('old-1');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h 50%/);
  } finally { f.cleanup(); }
});

// Regression (2026-09-24 user report: 借道 provider 的 limitbar 在 web 上不见了,
// 手机上还有): two page-load defects stacked here. The persisted window bar was
// stored WITHOUT the provider identity its gate dispatches on, and the page's
// first setProviderBaseUrl (a report, not a switch) deleted both it and its
// localStorage key before anything could repaint it. A borrowed provider has no
// other source until a turn runs, so the bar simply never came back.
test('a borrowed window bar survives a page reload', () => {
  const relay = 'https://relay.example:3000/claude-proxy/official/remote';
  const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: (NOW + 3_600_000) / 1000, provider: 'claude' };

  // Page 1: the borrowed window arrives as a live event and is persisted.
  const p1 = freshClient(null, { providerReport: false });
  let persisted;
  try {
    p1.C.setCli('claude-exp');
    p1.C.setProviderBaseUrl(relay);
    const bar = Renderer.claudeBar(null, Renderer.normalizeWindowEvent(info, NOW));
    p1.C.consumeRateLimitEvent(info, 'borrowed-1', bar);
    persisted = p1.values.get('multicc:claude-rate-limit:v1:borrowed-1');
    assert.ok(persisted);
  } finally { p1.cleanup(); }

  // Page 2: reload with the same storage and no live event yet.
  const p2 = freshClient(
    { 'multicc:claude-rate-limit:v1:borrowed-1': persisted },
    { providerReport: false },
  );
  try {
    p2.C.restoreFiveHourRateLimit('borrowed-1');
    p2.C.setCli('claude-exp');
    p2.C.setProviderBaseUrl(relay);
    assert.equal(p2.element('claude-rate-limit-bar').style.display, 'block',
      'the borrowed window is still on screen after the reload');
    assert.match(p2.element('claude-rate-limit-bar').textContent, /^5h 70%/);
    assert.ok(p2.values.has('multicc:claude-rate-limit:v1:borrowed-1'),
      'the identity report did not delete the session cache');
  } finally { p2.cleanup(); }
});

test('the first provider report is not a switch; a real one still wipes', () => {
  const f = freshClient(null, { providerReport: false });
  try {
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.setCli('codex');
    f.C.consumeRateLimitEvent(info, 'codex-1', bar);
    const key = 'multicc:claude-rate-limit:v1:codex-1';
    assert.ok(f.values.has(key));

    // First report: the page saying which provider it loaded. The window bar on
    // screen belongs to that provider, so nothing is dropped.
    f.C.setProviderBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'glm-1', { appType: 'codex' });
    assert.ok(f.values.has(key), 'the report keeps the session cache');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');

    // A later call that really changes the provider still drops it.
    f.C.setProviderBaseUrl('', '', { appType: 'codex' });
    assert.equal(f.values.has(key), false, 'a switch clears the session cache');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('Ark quota fetch carries the active provider baseUrl and caches per plan', async () => {
  const f = freshClient();
  try {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return {
        json: async () => String(url).startsWith('/api/quota/bars/refresh')
          ? { status: 'ok', fetchedAt: NOW, bar: { text: 'Coding', color: '#58a6ff', title: 'Coding（当前 provider）' } }
          : { status: 'ok', bars: IDLE_BARS },
      };
    };
    f.values.set('multicc.ark.quota.v1', JSON.stringify({ status: 'ok', bar: { text: 'Agent', color: '#d29922', title: 'stale global key' } }));
    f.C.setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding');
    await flushClient();
    const arkCalls = calls.filter(url => url.startsWith('/api/quota/bars/refresh'));
    assert.ok(arkCalls.some(url => url.includes('kind=ark')
      && url.includes('baseUrl=https%3A%2F%2Fark.cn-beijing.volces.com%2Fapi%2Fcoding')));
    assert.equal(f.element('ark-quota-bar').textContent, 'Coding');
    assert.ok(f.values.has('multicc.ark.quota.v1:coding-plan'), 'Coding and Agent cache entries must not share one bar');
    assert.equal(f.values.has('multicc.ark.quota.v1'), true, 'legacy global cache may exist but is no longer read for Ark');
  } finally { f.cleanup(); }
});

// ── 借道（relay）provider 的余量条门禁 ────────────────────────────────────────

test('a borrowed GLM window bar shows under the claude CLI when the provider is a relay', () => {
  const f = freshClient();
  try {
    // The relay baseUrl points at the LENDER's host, not at Zhipu — the vendor
    // host gate must not block the pass-through event; the relay's protocol is
    // the gate instead.
    f.C.setProviderBaseUrl('https://relay.example:3000/claude-proxy/glm/remote');
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'relay-sess', bar);
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.match(f.element('claude-rate-limit-bar').textContent, /^5h 56%/);
    // The claude-protocol relay does not speak the codex CLI.
    f.C.setCli('codex');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
    f.C.setCli('claude');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
  } finally { f.cleanup(); }
});

test('a codex-protocol relay gates its window to the codex/opencode CLIs', () => {
  const f = freshClient();
  try {
    f.C.setProviderBaseUrl('http://192.168.1.9:3000/codex-proxy/official');
    const info = { status: 'allowed', rateLimitType: 'weekly', utilization: 0.64, resetsAt: (NOW + 86_400_000) / 1000, provider: 'codex' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'relay-cx', bar);
    f.C.setCli('codex');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    f.C.setCli('claude');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('a borrowed Codex fetch hides the host subscription and paints the lender bar', async () => {
  const f = freshClient();
  try {
    await flushClient();
    const calls = [];
    global.fetch = async (url) => {
      const value = String(url); calls.push(value);
      if (value.includes('/api/providers/codex/borrowed/balance')) {
        return { json: async () => ({
          ok: true, dto: { kind: 'window', provider: 'codex' },
          bar: { text: 'Borrowed · 1wk 65%', color: '#58a6ff', title: 'lender' },
        }) };
      }
      return { json: async () => ({ bars: {
        codex: { status: 'ok', bar: { text: 'Host · 1wk 8%' } },
      } }) };
    };
    f.C.setCli('codex');
    f.C.setProviderBaseUrl('https://relay.example/codex-proxy/official', 'borrowed');
    await flushClient();
    assert.ok(calls.some(url => url.includes('/api/providers/codex/borrowed/balance')));
    assert.equal(f.element('codex-quota-bar').style.display, 'none');
    assert.equal(f.element('codex-quota-bar').textContent, '');
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Borrowed · 1wk 65%');
  } finally { f.cleanup(); }
});

test('every concrete Codex Provider selects its own bar species, including non-relay URLs', async () => {
  const f = freshClient();
  try {
    await flushClient();
    const calls = [];
    global.fetch = async (url) => {
      const value = String(url); calls.push(value);
      if (value.includes('/api/providers/codex/deepseek/balance')) {
        return { json: async () => ({
          ok: true, dto: { kind: 'balance', provider: 'deepseek' },
          bar: { text: 'DeepSeek · ¥12.50', color: '#3fb950', title: 'provider balance' },
        }) };
      }
      if (value.includes('/api/providers/codex/codex-official/balance')) {
        return { json: async () => ({
          ok: true, dto: { kind: 'window', provider: 'codex' },
          bar: { text: 'Selected Official · 1wk 23%', color: '#58a6ff', title: 'selected account' },
        }) };
      }
      return { json: async () => ({ bars: {
        codex: { status: 'ok', bar: { text: 'Host fallback · 1wk 8%' } },
      } }) };
    };

    f.C.setCli('codex');
    f.C.setProviderBaseUrl('https://api.deepseek.com/v1', 'deepseek', { appType: 'codex' });
    await flushClient();
    assert.ok(calls.some(url => url.includes('/api/providers/codex/deepseek/balance')));
    assert.equal(f.element('codex-quota-bar').style.display, 'none');
    assert.equal(f.element('usage-balance-bar').textContent, 'DeepSeek · ¥12.50');

    f.C.setProviderBaseUrl('', 'codex-official', { appType: 'codex', isOfficial: true });
    await flushClient();
    assert.ok(calls.some(url => url.includes('/api/providers/codex/codex-official/balance')));
    assert.equal(f.element('codex-quota-bar').style.display, 'none');
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Selected Official · 1wk 23%');

    // Auto has no account to display until a physical route is selected. It
    // must not temporarily fall back to this machine's Official account.
    f.C.setProviderBaseUrl('', '', { appType: 'codex', pending: true });
    await flushClient();
    assert.equal(f.element('codex-quota-bar').style.display, 'none');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
  } finally { f.cleanup(); }
});

test('loopback relay plumbing is not a borrowed provider and a balance chip shows for a relay', () => {
  const f = freshClient();
  try {
    // 127.0.0.1 relay paths are this host's own CPR plumbing — the vendor gates
    // apply unchanged, so a GLM window under the claude CLI stays hidden.
    assert.equal(f.C.relayProtocolFromBaseUrl('http://127.0.0.1:3000/claude-proxy/abc/remote'), null);
    assert.equal(f.C.isRelayBaseUrl('http://localhost:3000/codex-proxy/abc'), false);
    f.C.setProviderBaseUrl('http://127.0.0.1:3000/claude-proxy/abc/remote');
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'local-sess', bar);
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');

    // A borrowed DeepSeek is a prepaid balance arriving via the relay — the
    // balance chip is visible under the claude CLI for relay providers.
    f.C.setProviderBaseUrl('https://relay.example:3000/claude-proxy/ds/remote');
    const balanceBar = Renderer.balanceBar(Renderer.normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 12.5 }));
    f.C.consumeBalanceEvent({ kind: 'balance', available: true, currency: 'CNY', total: 12.5 }, 'relay-ds', balanceBar);
    assert.equal(f.element('usage-balance-bar').style.display, 'block');
    assert.equal(f.element('usage-balance-bar').textContent, '¥12.50');
  } finally { f.cleanup(); }
});

test('switching provider clears the previous provider\'s stale window bar', () => {
  const f = freshClient();
  try {
    // Own GLM provider under the codex CLI paints a window bar and persists it
    // per session.
    f.C.setCli('codex');
    f.C.setProviderBaseUrl('https://glm.example/api/paas/v4');
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.8, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    const bar = Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW));
    f.C.consumeRateLimitEvent(info, 'mixed-sess', bar);
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    const key = 'multicc:claude-rate-limit:v1:mixed-sess';
    assert.ok(f.values.has(key), 'persisted for the session');

    // Switch the session to the borrowed provider: the old provider's bar must
    // not keep speaking for the relay (whose gate would let it linger) — it is
    // cleared until the relay's first pass-through event repaints it.
    f.C.setProviderBaseUrl('https://relay.example:3000/codex-proxy/glm/remote');
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'none');
    assert.equal(f.values.has(key), false, 'the stale persisted bar is dropped');
  } finally { f.cleanup(); }
});

test('a Zhipu provider shows one window bar, from the Provider query alone', async () => {
  const f = freshClient();
  try {
    await flushClient();
    // The dedicated zhipu vendor slot is gone: it polled the same glm-monitor
    // account the exact Provider query (/api/providers/.../balance, kind=window)
    // resolves to, and both painted `5h … 1wk …` side by side. The Provider
    // window bar is now the only display — no kind=zhipu fetch is issued at all.
    const requested = [];
    global.fetch = (url) => {
      requested.push(String(url));
      if (String(url).includes('/api/providers/')) {
        return Promise.resolve({ json: async () => ({ ok: true, dto: { kind: 'window', provider: 'glm', utilization: 0.05 }, bar: { text: 'Provider GLM window' } }) });
      }
      return Promise.resolve({ json: async () => ({ status: 'ok', bar: { text: 'Zhipu slot window' } }) });
    };
    f.C.setProviderBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'glm-1', { appType: 'claude' });
    await flushClient();
    assert.equal(f.element('claude-rate-limit-bar').style.display, 'block');
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Provider GLM window');
    assert.ok(requested.some((u) => u.includes('/api/providers/claude/glm-1/balance')), 'the Provider query ran');
    assert.equal(requested.some((u) => u.includes('kind=zhipu')), false, 'no vendor-slot fetch is issued');

    // The provider window bar is click-refreshable (its render ends in ⟳).
    assert.equal(f.element('claude-rate-limit-bar').style.cursor, 'pointer');
    f.element('claude-rate-limit-bar').onclick();
    await flushClient();
    assert.ok(requested.filter((u) => u.includes('/balance')).length >= 2, 'clicking re-queries the provider');

    // The passive pass-through GLM event does not displace the Provider query's
    // fuller window bar for the same account.
    const info = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.05, resetsAt: (NOW + 3_600_000) / 1000, provider: 'glm' };
    f.C.consumeRateLimitEvent(info, 'zhipu-dup', Renderer.windowEventBar(Renderer.normalizeWindowEvent(info, NOW)));
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Provider GLM window');
  } finally { f.cleanup(); }
});

test('same-URL account switches clear both window and balance, but re-rendering does not', async () => {
  const f = freshClient();
  try {
    const url = 'https://relay.example/claude-proxy/account/remote';
    f.C.setProviderBaseUrl(url, 'account-a');
    const info = { provider: 'glm' };
    f.C.consumeRateLimitEvent(info, 'same-url', { text: 'Account A limit' });
    f.C.consumeBalanceEvent({}, 'same-url', { text: 'Account A balance' });
    f.C.setProviderBaseUrl(url, 'account-a');
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Account A limit');
    assert.equal(f.element('usage-balance-bar').textContent, 'Account A balance');

    f.C.setProviderBaseUrl(url, 'account-b');
    for (const id of ['claude-rate-limit-bar', 'usage-balance-bar']) {
      assert.equal(f.element(id).style.display, 'none');
      assert.equal(f.element(id).textContent, '');
    }
    assert.equal(f.values.has('multicc:claude-rate-limit:v1:same-url'), false);
    assert.equal(f.values.has('multicc.usageBalance.same-url'), false);
    f.C.restoreBalance('same-url');
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
    f.C.consumeRateLimitEvent(info, 'same-url', { text: 'Account B limit' });
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'Account B limit');
    await flushClient();
  } finally { f.cleanup(); }
});

test('switching vendors removes the previous balance before displaying the new limit', async () => {
  const f = freshClient();
  try {
    f.C.setCli('codex');
    f.C.setProviderBaseUrl('https://api.deepseek.com', 'deepseek');
    f.C.consumeBalanceEvent({}, 'balance-switch', { text: 'Old balance' });
    assert.equal(f.element('usage-balance-bar').style.display, 'block');
    f.C.setProviderBaseUrl('https://relay.example/codex-proxy/official', 'borrowed');
    f.C.consumeRateLimitEvent({ provider: 'codex' }, 'balance-switch', { text: 'New limit' });
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'New limit');
    await flushClient();
  } finally { f.cleanup(); }
});

test('late vendor responses cannot repaint, cache into the new plan, or block its refresh', async () => {
  for (const failOldRequest of [false, true]) {
    const f = freshClient();
    try {
      await flushClient();
      const pending = [];
      global.fetch = (url) => {
        if (!String(url).startsWith('/api/quota/bars/refresh')) {
          return Promise.resolve({ json: async () => ({ bars: {} }) });
        }
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      };
      f.C.setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/plan', 'agent');
      f.C.setProviderBaseUrl('https://ark.cn-beijing.volces.com/api/coding', 'coding');
      assert.equal(pending.length, 2, 'old in-flight request does not suppress the new one');
      assert.equal(f.element('ark-quota-bar').textContent, '');
      await flushClient();
      if (failOldRequest) pending[0].reject(new Error('old request failed'));
      else pending[0].resolve({ json: async () => ({ status: 'ok', bar: { text: 'Old plan' } }) });
      await flushClient();
      assert.equal(f.values.has('multicc.ark.quota.v1:coding-plan'), false);
      assert.notEqual(f.element('ark-quota-bar').textContent, 'Old plan');
      await f.C.refreshArkQuota();
      assert.equal(pending.length, 2, 'old completion must not unlock the new in-flight request');
      pending[1].resolve({ json: async () => ({ status: 'ok', bar: { text: 'New plan' } }) });
      await flushClient();
      assert.equal(f.element('ark-quota-bar').textContent, 'New plan');
      assert.equal(JSON.parse(f.values.get('multicc.ark.quota.v1:coding-plan')).bar.text, 'New plan');
    } finally { f.cleanup(); }
  }
});

test('late server snapshots and Claude scrapes cannot restore the previous account', async () => {
  const f = freshClient();
  try {
    await flushClient();
    const pending = [];
    global.fetch = (url) => new Promise(resolve => pending.push({ url: String(url), resolve }));
    const oldSnapshot = f.C.restoreServerQuotaBars();
    const oldScrape = f.C.refreshClaudeUsage(true);
    f.C.setProviderBaseUrl('', 'new-claude-account');
    assert.equal(pending.length, 4, 'new Provider triggers both cache restore and exact Provider query');
    pending[2].resolve({ json: async () => ({ bars: { claude: { bar: { text: 'New account' } } } }) });
    pending[3].resolve({ json: async () => ({ ok: false, reason: 'unsupported' }) });
    await flushClient();
    pending[0].resolve({ json: async () => ({ bars: { claude: { bar: { text: 'Old snapshot' } } } }) });
    pending[1].resolve({ json: async () => ({ status: 'ok', bar: { text: 'Old scrape' } }) });
    await Promise.all([oldSnapshot, oldScrape]);
    assert.equal(f.element('claude-rate-limit-bar').textContent, 'New account');
    assert.equal(f.values.has('multicc.claude.usage.v1'), false);
  } finally { f.cleanup(); }
});

test('chat provider selection forwards default, explicit, and active Auto identities to the bars', async () => {
  const f = freshClient();
  try {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const chat = fs.readFileSync(require.resolve('../public/chat.js'), 'utf8');
    const update = chat.slice(chat.indexOf('function updateProviderBtn()'), chat.indexOf('\nfunction showLoadingOverlay'));
    const url = 'https://relay.example/claude-proxy/shared/remote';
    const context = vm.createContext({
      providerBtn: { style: {} },
      window: { MultiCCChatRateLimit: f.C },
      _sessionProviderSelection: null,
      _sessionProvider: '',
      _activeProviderId: '',
      _providerList: [
        { id: 'a', appType: 'claude', baseUrl: url, isOfficial: false },
        { id: 'b', appType: 'claude', baseUrl: url, isOfficial: false },
      ],
      effectiveProviderIdForChoices: id => id || 'a',
      updateModelBtn() {},
    });
    vm.runInContext(update, context);
    vm.runInContext('updateProviderBtn()', context);
    f.C.consumeBalanceEvent({}, 'wired-switch', { text: 'Default A balance' });
    assert.equal(f.element('usage-balance-bar').style.display, 'block');
    context._sessionProvider = 'b';
    vm.runInContext('updateProviderBtn()', context);
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
    f.C.consumeBalanceEvent({}, 'wired-switch', { text: 'Explicit B balance' });
    context._sessionProviderSelection = { mode: 'auto' };
    context._activeProviderId = 'a';
    vm.runInContext('updateProviderBtn()', context);
    assert.equal(f.element('usage-balance-bar').style.display, 'none');
    await flushClient();
  } finally { f.cleanup(); }
});

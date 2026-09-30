'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The golden parity contract: the server renders a bar once (the words, colors,
// ordering and vendor rules all baked in, with only {cd:}/{ago:} time tokens
// left for the client), and BOTH clients must resolve those tokens to the same
// strings. This test is the node half; app/test/quota_bar_render_test.dart is
// the Flutter half. Both read the same fixture, so a resolver change that is not
// mirrored on the other end fails here AND there.
//
// The fixture is generated from the renderer + this resolver, so it also pins
// the renderer's output: if the renderer starts emitting different text/color
// for a given input, regenerating the fixture makes the diff an explicit review.
const fs = require('node:fs');
const path = require('node:path');

const { resolveQuotaBar, renderQuotaParts } = require('../public/quota-bar-view');
const Renderer = require('../src/quota/quota-bar-view');
const rateLimitApi = require('../public/chat-rate-limit');
const fixture = require('./fixtures/quota-bar-golden.json');
const zhCatalog = require('../app/assets/i18n/zh.json');
const enCatalog = require('../app/assets/i18n/en.json');

test('the golden fixture is non-empty and anchored to a fixed now', () => {
  assert.ok(Number.isFinite(fixture.now));
  assert.ok(fixture.cases.length >= 20, `expected broad coverage, got ${fixture.cases.length}`);
});

for (const c of fixture.cases) {
  test(`node resolver matches golden: ${c.name}`, () => {
    const view = resolveQuotaBar(c.bar, { state: c.state, now: fixture.now });
    assert.ok(view, 'a bar must resolve to a view, never null');
    assert.equal(view.text, c.expected.text, 'text');
    assert.equal(view.color, c.expected.colorHex, 'color');
    assert.equal(view.title, c.expected.title, 'title');
    assert.equal(view.action, c.expected.action ?? null, 'action');
  });
}

test('the resolver never leaves a {cd:} or {ago:} token in the output', () => {
  for (const c of fixture.cases) {
    const view = resolveQuotaBar(c.bar, { state: c.state, now: fixture.now });
    assert.doesNotMatch(view.text, /\{(cd|ago):/, `${c.name}: unresolved token in text`);
    assert.doesNotMatch(view.title, /\{(cd|ago):/, `${c.name}: unresolved token in title`);
  }
});

// ── The bar's other language ────────────────────────────────────────────────
//
// The server renders the bar in one language (Chinese) because it cannot know
// which one this client is in — the choice lives in localStorage. So every bar
// ALSO ships the pieces its two strings were assembled from (`textParts` /
// `titleParts`), and the Web client re-renders them when the language is
// English (public/chat-rate-limit.js → resolveBar → renderQuotaParts). The app
// displays the server's bytes verbatim and has no renderer for the pieces, so
// none of this is a second parity contract: it is one direction only.
//
// What must hold: every piece carries a catalog key that exists in BOTH
// catalogs (the app ships the same file), rendering the pieces through the zh
// catalog reproduces the server's own bytes exactly (so the two spellings
// cannot drift apart), and rendering them through the en catalog leaves no
// Chinese behind.

const CJK = /[　-〿㐀-鿿＀-￯]/;

// Mirrors the browser's barTranslate: a key this catalog does not know falls
// through to the server's own bytes, which is what keeps an old cached bar (or
// a bar from a server that learned a new string) rendering.
function translateWith(dict) {
  return (key, params, fallback) => {
    const value = typeof dict[key] === 'string' ? dict[key] : null;
    if (value === null) return fallback;
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  };
}

function walkParts(parts, fn) {
  for (const piece of parts || []) {
    if (!piece || typeof piece.s !== 'string') continue;
    fn(piece);
    if (piece.p) {
      for (const name of Object.keys(piece.p)) {
        const value = piece.p[name];
        if (value && typeof value === 'object' && typeof value.s === 'string') walkParts([value], fn);
      }
    }
  }
}

// A fixed clock so {ago:} renders the same everywhere; the parts themselves keep
// the raw tokens (only resolveText expands those), so these cases compare the
// renderer's strings, not a moment in time.
const NOW_MS = 1_700_000_000_000;
const AGO_MS = NOW_MS - 5 * 60_000;

const ZEN_USAGE = {
  status: 'ok', fetchedAt: AGO_MS, source: 'zen-api',
  usage: {
    rolling: { usagePercent: 42, resetInSec: 3600, status: 'allowed' },
    weekly: { usagePercent: 91, resetInSec: 3 * 86_400, status: 'rate-limited' },
    monthly: { usagePercent: 12, resetInSec: 20 * 86_400, status: 'allowed' },
    useBalance: true,
  },
};

const BAR_INPUTS = [
  ['opencode: never fetched', 'opencode', null],
  ['opencode: needs login', 'opencode', { status: 'needs_login' }],
  ['opencode: no reachable chrome', 'opencode', { status: 'chrome_unavailable' }],
  ['opencode: subscription key rejected', 'opencode', { status: 'no_auth' }],
  ['opencode: endpoint said no', 'opencode', { status: 'unavailable', error: 'gateway said no' }],
  ['opencode: three windows on the Zen API', 'opencode', ZEN_USAGE],
  ['opencode: three windows scraped by CDP', 'opencode', { ...ZEN_USAGE, source: 'cdp' }],
  ['qoder: never fetched', 'qoder', null],
  ['qoder: needs login', 'qoder', { status: 'needs_login' }],
  ['qoder: no reachable chrome', 'qoder', { status: 'chrome_unavailable' }],
  ['qoder: credits with plan and add-on quotas', 'qoder', {
    status: 'ok', fetchedAt: AGO_MS, plan: { plan_tier: 'PLAN_TIER_PRO', next_refresh_date: '2026-10-07T00:00:00Z' },
    quota: {
      nextResetAt: '2026-10-07T00:00:00Z',
      total_quota: { quota_summary: { used_value: 30, limit_value: 100, remaining_value: 70 } },
      plan_quota: { quota_summary: { used_value: 20, limit_value: 60 } },
      resource_package_quota: { quota_summary: { used_value: 5, limit_value: 10, remaining_value: 5 } },
    },
  }],
  ['qoder: no reset date at all', 'qoder', {
    status: 'ok', fetchedAt: AGO_MS, quota: { total_quota: { quota_summary: { used_value: 1, limit_value: 4 } } },
  }],
  ['codex: never fetched', 'codex', null],
  ['codex: not signed in', 'codex', { status: 'no_auth' }],
  ['codex: usage unavailable', 'codex', { status: 'unavailable', error: 'wham said no' }],
  ['codex: weekly with credits and extra windows', 'codex', {
    status: 'ok', fetchedAt: AGO_MS, planType: 'prolite', email: 'someone@example.com', limitReached: false,
    weekly: { usedPercent: 75, remainingPercent: 25, resetsAt: (NOW_MS + 4 * 86_400_000) / 1000 },
    additional: [{ name: 'Fable', usedPercent: 12 }, { name: '1m', usedPercent: 3 }],
    credits: { hasCredits: true, balance: 12.5 },
  }],
  ['ark: never fetched', 'ark', null],
  ['ark: not authenticated', 'ark', { status: 'needs_auth' }],
  ['ark: arkcli missing', 'ark', { status: 'needs_install' }],
  ['ark: usage unavailable', 'ark', { status: 'unavailable', error: 'arkcli said no' }],
  ['ark: two plans, both subscribed', 'ark', {
    status: 'ok', fetchedAt: AGO_MS,
    viewer: { user_name: 'someone', auth_method: 'sso' },
    items: [
      {
        product: 'coding', tier: 'Pro', subscribed: true,
        periods: [{ label: 'weekly', percent: 64, used: 32, total: 50, resetAt: NOW_MS + 86_400_000 }],
      },
      {
        product: 'agent', tier: 'Lite', subscribed: true,
        periods: [{ label: 'monthly', percent: 8, used: 2, total: 25, resetAt: NOW_MS + 20 * 86_400_000 },
          { label: 'weekly', percent: 55 }],
      },
    ],
  }, { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/plan' }],
  ['ark: nothing subscribed', 'ark', {
    status: 'ok', fetchedAt: AGO_MS, items: [{ product: 'coding', subscribed: false, periods: [] }],
  }],
  ['zhipu: never fetched', 'zhipu', null],
  ['zhipu: no provider configured', 'zhipu', { status: 'not_configured' }],
  ['zhipu: usage unavailable', 'zhipu', { status: 'unavailable', error: 'glm said no' }],
  ['zhipu: no site returned a window', 'zhipu', { status: 'ok', sites: [{ site: 'BigModel', host: 'open.bigmodel.cn', ok: false }] }],
  ['zhipu: two sites, one with a weekly window', 'zhipu', {
    status: 'ok', fetchedAt: AGO_MS,
    sites: [
      { site: 'BigModel', host: 'open.bigmodel.cn', ok: true, period: '5h', usedPercent: 12, resetsAt: NOW_MS + 3600_000, weeklyUsedPercent: 40, weeklyResetsAt: NOW_MS + 3 * 86_400_000, tier: 'pro' },
      { site: 'Z.ai', host: 'api.z.ai', ok: true, period: '5h', usedPercent: 90 },
    ],
  }],
  ['kimi: never fetched', 'kimi', null],
  ['kimi: no provider configured', 'kimi', { status: 'not_configured' }],
  ['kimi: needs login', 'kimi', {
    status: 'needs_login', error: '',
    sites: [{ site: 'Moonshot', host: 'api.moonshot.cn', ok: false, reason: 'auth_rejected' }],
  }],
  ['kimi: no browser at all', 'kimi', {
    status: 'chrome_unavailable',
    sites: [{ site: 'Moonshot', host: 'api.moonshot.cn', ok: false, reason: 'network_error' }],
  }],
  ['kimi: balance with a voucher and cash', 'kimi', {
    status: 'ok', fetchedAt: AGO_MS,
    sites: [{ site: 'Moonshot', host: 'api.moonshot.cn', ok: true, available: 88.5, voucher: 25, cash: 12, currency: 'CNY' }],
  }],
  ['kimi: balance endpoint rejected the key', 'kimi', {
    status: 'ok', fetchedAt: AGO_MS,
    sites: [{ site: 'Moonshot', host: 'api.moonshot.cn', ok: false, reason: 'endpoint_not_found' }],
  }],
  ['kimi: subscription page scraped into windows', 'kimi', {
    status: 'ok', fetchedAt: AGO_MS, source: 'subscription-page',
    summary: [{ window: '5h', usedPercent: 30, resetMs: NOW_MS + 3600_000 }, { window: 'weekly', usedPercent: 61 }],
  }],
  ['kimi: subscription page gave no percentages', 'kimi', {
    status: 'ok', source: 'subscription-page', summary: [], text: 'raw membership page text',
  }],
  ['claude: never fetched', 'claude', null],
  ['claude: needs login', 'claude', { status: 'needs_login' }],
  ['claude: no reachable chrome', 'claude', { status: 'chrome_unavailable' }],
  ['claude: usage unavailable', 'claude', { status: 'unavailable' }],
  ['claude: 5h live plus the weekly scrape', 'claude', {
    status: 'ok', fetchedAt: AGO_MS,
    summary: [{ window: '5h', label: 'Session limit', usedPercent: 72 }, { window: '1wk', label: 'Weekly limit', usedPercent: 41 }],
  }, { live: Renderer.normalizeWindowEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.28, resetsAt: (NOW_MS + 3600_000) / 1000, provider: 'claude' }, NOW_MS) }],
];

// The bars that are not a vendor render at all: the window event and the
// DeepSeek balance, plus the two labels the server wraps them in when the
// session is routed through a borrowed provider.
const EXTRA_BARS = [
  ['window event: GLM five-hour, labelled as routed provider', () => {
    const glm = Renderer.normalizeWindowEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.44, resetsAt: (NOW_MS + 3600_000) / 1000, provider: 'glm' }, NOW_MS);
    return Renderer.labelRoutedProvider(Renderer.windowEventBar(glm), 'glm');
  }],
  ['balance: CNY, labelled', () => {
    const norm = Renderer.normalizeBalance({ kind: 'balance', available: true, currency: 'CNY', total: 87.69 });
    return Renderer.labelRoutedBalance(Renderer.balanceBar(norm));
  }],
  ['balance: out of money', () => Renderer.balanceBar(Renderer.normalizeBalance({ kind: 'balance', available: false, currency: 'USD', total: 0 }))],
];

function everyView(bar) {
  const views = bar && bar.textParts ? [bar] : [];
  if (bar && bar.states) for (const key of Object.keys(bar.states)) if (bar.states[key]) views.push(bar.states[key]);
  return views;
}

function allBars() {
  const bars = [];
  for (const [name, kind, value, opts] of BAR_INPUTS) bars.push([name, Renderer.renderQuotaBar(kind, value, opts)]);
  for (const [name, build] of EXTRA_BARS) bars.push([name, build()]);
  return bars;
}

test('every key the renderer can emit exists in both catalogs', () => {
  // The static half: a key reachable from a branch no input below exercises still
  // has to be in the shared dictionary, because the app ships the same file and
  // generate-i18n.js keeps the two aligned by key set.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'quota', 'quota-bar-view.js'), 'utf8');
  const keys = new Set([...source.matchAll(/\bpart\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 120, `expected the whole bar vocabulary, got ${keys.size} key(s)`);
  assert.deepEqual([...keys].filter((k) => !(k in zhCatalog)), [], 'keys missing from zh.json');
  assert.deepEqual([...keys].filter((k) => !(k in enCatalog)), [], 'keys missing from en.json');
  // Two literals live on the client side of the bar (public/chat-rate-limit.js),
  // so the renderer never mentions them; they are still the same dictionary.
  for (const key of ['quotaRolledWindow', 'quotaArkInstallFailed']) {
    assert.ok(key in zhCatalog && key in enCatalog, `${key} must be in both catalogs`);
  }
});

test('rendering a bar through the zh catalog reproduces the server bytes', () => {
  const zhT = translateWith(zhCatalog);
  for (const [name, bar] of allBars()) {
    assert.ok(bar, `${name}: the renderer returned nothing`);
    for (const view of everyView(bar)) {
      assert.equal(renderQuotaParts(view.textParts, ' · ', zhT), view.text, `${name}: text`);
      assert.equal(renderQuotaParts(view.titleParts, '\n', zhT), view.title, `${name}: title`);
    }
  }
});

test('every piece carries a key both catalogs know, and every param is spelled out', () => {
  const enT = translateWith(enCatalog);
  for (const [name, bar] of allBars()) {
    for (const view of everyView(bar)) {
      for (const which of ['textParts', 'titleParts']) {
        walkParts(view[which], (piece) => {
          if (!piece.k) return;
          assert.ok(piece.k in zhCatalog, `${name}: ${piece.k} missing from zh.json`);
          assert.ok(piece.k in enCatalog, `${name}: ${piece.k} missing from en.json`);
        });
        const sep = which === 'textParts' ? ' · ' : '\n';
        const rendered = renderQuotaParts(view[which], sep, enT);
        // A template that names a param the renderer never passed would survive
        // as a literal `{name}`; the two time tokens are the only braces left.
        assert.doesNotMatch(rendered.replace(/\{(cd|ago):-?\d+\}/g, ''), /\{[a-zA-Z]\w*\}/,
          `${name}: ${which} kept an unfilled placeholder`);
      }
    }
  }
});

test('no English render of any bar is left holding Chinese', () => {
  const enT = translateWith(enCatalog);
  for (const [name, bar] of allBars()) {
    for (const view of everyView(bar)) {
      assert.doesNotMatch(renderQuotaParts(view.textParts, ' · ', enT), CJK, `${name}: text`);
      assert.doesNotMatch(renderQuotaParts(view.titleParts, '\n', enT), CJK, `${name}: title`);
    }
  }
});

test('the client picks the language: zh keeps the server bytes, en rebuilds them', () => {
  const bar = Renderer.renderQuotaBar('opencode', null);
  const previous = { getLang: global.getLang, I18N: global.I18N };
  try {
    // No language chosen (a fresh install) → the server's own render, untouched.
    delete global.getLang;
    delete global.I18N;
    assert.equal(rateLimitApi.resolveBar(bar, 'loading').text, bar.states.loading.text);
    assert.equal(rateLimitApi.resolveBar(bar).text, bar.text);

    global.getLang = () => 'zh';
    global.I18N = { zh: zhCatalog, en: enCatalog };
    assert.equal(rateLimitApi.resolveBar(bar).text, bar.text, 'zh reads the server bytes');

    global.getLang = () => 'en';
    const en = rateLimitApi.resolveBar(bar);
    assert.equal(en.text, enCatalog.quotaOpenCodeIdleText);
    assert.doesNotMatch(en.text, CJK);
    assert.doesNotMatch(en.title, CJK);
    // A state switch stays English too: the loading render threads the bar's own
    // label piece through the same dictionary.
    const loadingView = bar.states.loading;
    const enLabel = renderQuotaParts([loadingView.textParts[0].p.label], '', translateWith(enCatalog));
    const loading = rateLimitApi.resolveBar(bar, 'loading').text;
    assert.doesNotMatch(loading, CJK);
    assert.equal(loading, enCatalog.quotaLoading.replace('{label}', enLabel));
  } finally {
    if (previous.getLang === undefined) delete global.getLang; else global.getLang = previous.getLang;
    if (previous.I18N === undefined) delete global.I18N; else global.I18N = previous.I18N;
  }
});

test('a rolled-over window and an unknown key both degrade safely in English', () => {
  const previous = { getLang: global.getLang, I18N: global.I18N };
  try {
    global.getLang = () => 'en';
    global.I18N = { zh: zhCatalog, en: enCatalog };
    // The deadline passed: the countdown is replaced by the localized sentence,
    // not by the Chinese default (public/quota-bar-view.js ROLLED_WINDOW).
    const rolled = rateLimitApi.resolveBar({ text: `5h 28% {cd:${NOW_MS - 1000}}`, color: '#58a6ff', title: '' });
    assert.equal(rolled.text, `5h 28% ${enCatalog.quotaRolledWindow}`);
    // A piece whose key this dictionary does not know keeps the server's bytes
    // rather than dropping the segment.
    const unknown = rateLimitApi.resolveBar({
      text: '5h 28%', color: '#58a6ff', title: 'x',
      textParts: [{ k: 'quotaNoSuchKey', s: '5h 28%' }],
      titleParts: [{ k: 'quotaNoSuchKey', s: 'x' }],
    });
    assert.equal(unknown.text, '5h 28%');
    assert.equal(unknown.title, 'x');
  } finally {
    if (previous.getLang === undefined) delete global.getLang; else global.getLang = previous.getLang;
    if (previous.I18N === undefined) delete global.I18N; else global.I18N = previous.I18N;
  }
});

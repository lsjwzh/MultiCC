'use strict';

// GET /api/kimi/quota — fetch Moonshot/Kimi (api.moonshot.cn) prepaid balance for
// every configured Kimi provider.
//
// Kimi has no CLI credential store we can shell out to and no rolling-window
// monitor endpoint (unlike GLM): it is a PREPAID MONEY account, the same species
// as DeepSeek. The API key lives in each provider's settingsConfig, so we scan the
// provider store for accounts whose upstream resolves to the 'kimi-balance'
// strategy (providers.js getProviderLimitTarget) and hit the official balance
// endpoint directly:
//   GET https://api.moonshot.cn/v1/users/me/balance   (Authorization: Bearer <key>)
//   → { code:0, data:{ available_balance, voucher_balance, cash_balance }, status:true }
// Amounts are CNY. There is no window/reset — the value simply persists until the
// next poll overwrites it.
//
// Response:
//   { status:'ok', fetchedAt, sites:[ {host, site, ok, available, voucher, cash, currency} ] }
//   { status:'not_configured' }      — no Kimi provider configured (HTTP 404)
//   { status:'unavailable', sites }  — configured but every fetch failed (HTTP 502)

const providers = require('../providers');
const { keyHash } = require('../usage-limit-poller');
const { getManagedQuotaBrowser } = require('../quota-managed-browser');
const { renderQuotaBar } = require('../quota/quota-bar-view');

// The last response that actually carried a balance. A Kimi balance fetch fails
// for reasons that say nothing about the money (a Kimi-for-Coding key 401s the
// balance API by design), and a bar that blanks on those reads as "you have no
// balance". Holding the last real figure here — rather than in each client's
// own storage — means the web and the app fall back to the same number.
let lastKimiWithBalance = null;
function rememberKimiBalance(result) {
  const hasBalance = result && result.status === 'ok' && Array.isArray(result.sites)
    && result.sites.some((s) => s && s.ok && Number.isFinite(s.available));
  if (hasBalance) lastKimiWithBalance = result;
  return lastKimiWithBalance;
}

// Kimi subscription ("Kimi For Coding") keys 401 on the prepaid balance API —
// that account type's usage lives only on the logged-in membership page, so
// we scrape it through the managed browser when every balance fetch is an
// auth rejection.
// The quota panel lives on the ?tab=quota tab; the default landing renders a
// sidebar first and only paints the usage panel seconds later.
const KIMI_SUBSCRIPTION_URL = 'https://www.kimi.com/membership/subscription?tab=quota';
const CONSOLE_TIMEOUT_MS = Number(process.env.KIMI_QUOTA_TIMEOUT_MS || 15000);
function panelTextTimeoutMs() {
  return Number(process.env.KIMI_QUOTA_PANEL_TIMEOUT_MS || 30000);
}

// Gate for "the quota panel is actually on screen". The sidebar renders first
// and already contains words like 订阅/额度/升级订阅, so those are NOT proof.
// The panel always carries at least one real percentage (digits + %) plus one
// of its own marker words.
const PANEL_PERCENT_PATTERN = /\d+(?:\.\d+)?\s*%/;
const PANEL_MARKER_PATTERN = /用量进度|总使用量|小时用量|7\s*天用量|周用量|月用量/;
function subscriptionPanelReady(text) {
  const t = String(text || '');
  return PANEL_PERCENT_PATTERN.test(t) && PANEL_MARKER_PATTERN.test(t);
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Human-friendly site label. The product is "Kimi"; the API historically lives on
// api.moonshot.cn. Label by host so a user with both configured can tell them apart.
function siteLabel(host) {
  const h = String(host || '').toLowerCase();
  return h.includes('kimi') ? 'Kimi' : 'Moonshot';
}

// Scan configured providers for Kimi accounts. Deduped by (host, apiKey hash) so
// N sessions sharing one account issue one request — same key the poller uses.
function collectKimiTargets() {
  const targets = [];
  const seen = new Set();
  let summaries = [];
  try { summaries = providers.listProviders() || []; } catch (_) { summaries = []; }
  for (const s of summaries) {
    let t = null;
    try { t = providers.getProviderLimitTarget(s.appType, s.id); } catch (_) { t = null; }
    if (!t || t.strategy !== 'kimi-balance' || !t.apiKey) continue;
    const dedupe = `${t.host}:${keyHash(t.apiKey)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    targets.push(t);
  }
  return targets;
}

// The balance endpoint only exists on the canonical CN billing host. Inference is
// often routed through rebrand hosts (api.kimi.com / api.kimi.ai / api.moonshot.com)
// that return 404 for /v1/users/me/balance — verified: api.kimi.com 404s while
// api.moonshot.cn returns a proper 401/200. The API key is account-level (works on
// both), so query balance on api.moonshot.cn unless the provider already uses a
// moonshot.cn host.
const KIMI_BALANCE_HOST = 'api.moonshot.cn';
function balanceHost(host) {
  const h = String(host || '').toLowerCase();
  return h.endsWith('moonshot.cn') ? h : KIMI_BALANCE_HOST;
}

// Fetch one account's balance. Returns { available, voucher, cash, currency } on
// success or { error: true, httpStatus, reason } on failure so the caller can
// propagate a specific reason to the frontend.
async function fetchKimiBalance(target, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${balanceHost(target.host)}/v1/users/me/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      const status = res ? res.status : null;
      const reason = status === 401 || status === 403
        ? 'auth_rejected'
        : status === 404 ? 'endpoint_not_found' : 'http_error';
      return { error: true, httpStatus: status, reason };
    }
    const body = await res.json();
    const data = body && typeof body === 'object' ? body.data : null;
    if (!data || typeof data !== 'object') return { error: true, httpStatus: 200, reason: 'bad_shape' };
    const available = finite(data.available_balance);
    if (available === null && finite(data.voucher_balance) === null && finite(data.cash_balance) === null) {
      return { error: true, httpStatus: 200, reason: 'no_balance_fields' };
    }
    return {
      available,
      voucher: finite(data.voucher_balance),
      cash: finite(data.cash_balance),
      currency: 'CNY',
    };
  } catch (_) {
    return { error: true, httpStatus: null, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// Pull `N%` figures plus a short label out of the membership page's text.
// The page is a SPA with no stable DOM contract we can rely on across builds,
// so the summary is heuristic. Real panel layout (observed, 2026-08):
//   总使用量 / 29.1% / …重置… / 5 小时用量 / Code / 1.31% / 08-04 06:28 后重置 / …
// i.e. between a window label and its percentage there may sit a plan-name
// line (Code/Plus/…) — so the label is the nearest preceding line that is not
// a value, not a plan name, and not reset boilerplate.
const PLAN_NAME_LINE = /^(code|plus|pro|premium|standard|free|免费|会员|高级会员)$/i;
const RESET_INFO_LINE = /后重置|重置时间|刷新/;
function labelForPercent(lines, i) {
  for (let j = i - 1, steps = 0; j >= 0 && steps < 6; j--, steps++) {
    const cand = lines[j];
    if (/%/.test(cand)) break;                    // another value: no label for us
    if (PLAN_NAME_LINE.test(cand)) continue;      // plan name sits between label and value
    if (RESET_INFO_LINE.test(cand)) continue;     // reset boilerplate
    return cand.slice(0, 24);
  }
  return '';
}

// Map the raw scraped window label to the standard window token every quota
// surface renders through (chat-rate-limit unifiedWindowSeg). The frontend no
// longer trusts the raw Chinese label.
function windowTokenForLabel(label) {
  const l = String(label || '');
  if (/5\s*小时|小时用量/.test(l)) return '5h';
  if (/7\s*天|天用量|周/.test(l)) return '1wk';
  if (/总|月/.test(l)) return '1m';
  return null;
}

// The panel prints reset times right under each percentage, in two shapes:
//   2026-08-19 后重置        (absolute date)
//   08-04 06:28 后重置       (year-less; assumed current year, rolled forward
//                             if that would already be in the past)
// Returns epoch ms or null.
const RESET_DATE_RE = /(\d{4}-)?(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?\s*后重置/;
function parseResetAfter(text, nowMs = Date.now()) {
  const m = String(text || '').match(RESET_DATE_RE);
  if (!m) return null;
  const now = new Date(nowMs);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = m[4] ? Number(m[4]) : 0;
  const mm = m[5] ? Number(m[5]) : 0;
  let year = m[1] ? Number(m[1].slice(0, 4)) : now.getFullYear();
  let ts = new Date(year, month - 1, day, hh, mm).getTime();
  if (!m[1] && ts < nowMs - 24 * 3600 * 1000) {
    ts = new Date(year + 1, month - 1, day, hh, mm).getTime();
  }
  return ts;
}

// Summary items are the unified window shape every quota surface renders:
// { window: '5h'|'1wk'|'1m'|null, label, usedPercent, resetMs, line }.
// `percent` stays as a mirror of usedPercent so pre-upgrade caches keep working.
function summarizeSubscriptionText(text, nowMs = Date.now()) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+(?:\.\d+)?)\s*%$/) || lines[i].match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) continue;
    const label = labelForPercent(lines, i);
    // The reset line follows the value (occasionally with a plan-name line in
    // between); only the first candidate that really carries 后重置 counts.
    let resetMs = null;
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (/%/.test(lines[j])) break;
      if (/后重置/.test(lines[j])) { resetMs = parseResetAfter(lines[j], nowMs); break; }
    }
    const usedPercent = Number(m[1]);
    hits.push({ window: windowTokenForLabel(label), label, usedPercent, percent: usedPercent, resetMs, line: lines[i].slice(0, 80) });
    if (hits.length >= 4) break;
  }
  return hits.length ? hits : null;
}

// Scrape the logged-in membership page through the managed browser. Returns
// { status:'ok', summary, text } on success, needs_login when the profile has
// no kimi.com session (or it expired mid-redirect), chrome_unavailable when no
// browser can run at all.
async function fetchKimiSubscriptionPage(managed = getManagedQuotaBrowser()) {
  let browser;
  try { browser = await managed.attachManaged(); }
  catch (err) {
    const unavailable = err && err.code === 'chrome_unavailable';
    return { status: unavailable ? 'chrome_unavailable' : 'unavailable', error: (err && err.message) || 'managed browser attach failed' };
  }
  try {
    const cookies = await managed.getCookies('kimi.com', { browser });
    if (!cookies.length) {
      return { status: 'needs_login', error: '托管浏览器中没有 kimi.com 登录态，点余量徽标可打开登录窗口' };
    }
    return await managed.withPage(async (page) => {
      await page.enable(['Network', 'Page']);
      await page.navigate(KIMI_SUBSCRIPTION_URL);

      let hitLogin = false;
      const settled = await page.waitFor(async () => {
        const href = await page.evaluate('location.href');
        if (typeof href !== 'string' || !href) return null;
        if (/sign-?in|passport|\/login/i.test(href)) { hitLogin = true; return href; }
        const ready = await page.evaluate('document.readyState');
        return ready === 'complete' ? href : null;
      }, { timeoutMs: CONSOLE_TIMEOUT_MS });
      if (!settled) return { status: 'unavailable', error: 'kimi 订阅页加载超时' };
      if (hitLogin) return { status: 'needs_login', error: 'kimi.com 登录态已失效，点余量徽标可重新登录' };

      // Wait for the quota panel itself, not the sidebar: the sidebar renders
      // first and is full of words (订阅/额度/升级订阅) the old gate mistook
      // for the panel. Only digits+% plus a panel marker count. The panel is
      // an async SPA chunk, so it gets its own (larger) budget.
      const text = await page.waitFor(async () => {
        const t = await page.evaluate('document.body ? document.body.innerText : ""');
        return typeof t === 'string' && subscriptionPanelReady(t) ? t : null;
      }, { timeoutMs: panelTextTimeoutMs(), intervalMs: 800 }) || '';

      if (!String(text).trim()) return { status: 'unavailable', error: '订阅页未渲染出用量面板（可能未登录或页面改版）' };
      return {
        status: 'ok',
        fetchedAt: Date.now(),
        source: 'subscription-page',
        url: settled,
        summary: summarizeSubscriptionText(text),
        text: String(text).slice(0, 2000),
      };
    }, { browser });
  } catch (err) {
    return { status: 'unavailable', error: (err && err.message) || 'subscription page scrape failed' };
  } finally {
    browser.close();
  }
}

async function fetchKimiUsage(preferHost, nowMs = Date.now(), deps = {}) {
  const targets = Array.isArray(deps.targets) ? deps.targets : collectKimiTargets();
  const poll = typeof deps.poll === 'function' ? deps.poll : fetchKimiBalance;
  if (!targets.length) return { status: 'not_configured', error: 'no kimi provider configured' };

  // Put the caller's current site first so the frontend can take sites[0].
  const wanted = String(preferHost || '').toLowerCase().trim();
  const ordered = wanted
    ? [...targets.filter((t) => t.host === wanted), ...targets.filter((t) => t.host !== wanted)]
    : targets;

  const sites = await Promise.all(ordered.map(async (t) => {
    let bal = null;
    try { bal = await poll(t); } catch (_) { bal = { error: true, httpStatus: null, reason: 'network_error' }; }
    if (!bal || bal.error) {
      return { host: t.host, site: siteLabel(t.host), ok: false, httpStatus: bal?.httpStatus ?? null, reason: bal?.reason || 'fetch_failed' };
    }
    return {
      host: t.host,
      site: siteLabel(t.host),
      ok: true,
      available: bal.available,
      voucher: bal.voucher,
      cash: bal.cash,
      currency: bal.currency || 'CNY',
    };
  }));

  if (!sites.some((s) => s.ok)) {
    // Every site 401 = subscription keys, which the balance API will never
    // accept. Their usage is on the membership page instead.
    const consoleFallback = deps.console === undefined
      ? () => fetchKimiSubscriptionPage()
      : deps.console;
    if (typeof consoleFallback === 'function' && sites.every((s) => s.reason === 'auth_rejected')) {
      let scraped = null;
      try { scraped = await consoleFallback(); } catch (err) { scraped = { status: 'unavailable', error: err && err.message }; }
      if (scraped && scraped.status === 'ok') return { ...scraped, sites };
      if (scraped && scraped.status === 'needs_login') {
        return { status: 'needs_login', error: scraped.error, loginUrl: KIMI_SUBSCRIPTION_URL, sites };
      }
      return {
        status: 'unavailable',
        error: `余额 API 全部 401（疑似订阅 key），订阅页抓取也失败：${(scraped && scraped.error) || 'unknown'}`,
        fetchedAt: nowMs,
        sites,
      };
    }
    return { status: 'unavailable', error: 'all kimi fetches failed', fetchedAt: nowMs, sites };
  }
  return { status: 'ok', fetchedAt: nowMs, sites };
}

function mountKimiQuotaRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') return;
  const usageDeps = options.usageDeps || {};
  const recordVendor = typeof options.recordVendor === 'function' ? options.recordVendor : null;
  app.get('/api/kimi/quota', async (req, res) => {
    try {
      const preferHost = typeof req.query?.host === 'string' ? req.query.host : '';
      const result = await fetchKimiUsage(preferHost, Date.now(), usageDeps);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'not_configured' ? 404
          : status === 'needs_login' ? 401
            : status === 'chrome_unavailable' ? 503 : 502;
      // The bar is rendered here, once, so the web and the app display the same
      // string rather than each formatting this JSON their own way.
      const cached = rememberKimiBalance(result);
      if (recordVendor) {
        try { recordVendor({ kind: 'kimi', result, host: preferHost, opts: { cached } }); } catch (_) {}
      }
      res.status(httpStatus).json({ ...result, bar: renderQuotaBar('kimi', result, { cached }) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'kimi quota fetch failed' };
      if (recordVendor) {
        try { recordVendor({ kind: 'kimi', result, host: req.query?.host || '' }); } catch (_) {}
      }
      res.status(500).json({ ...result, bar: renderQuotaBar('kimi', result, { cached: lastKimiWithBalance }) });
    }
  });

  // Visible login window on the managed profile — same pattern as qoder /
  // opencode. The user logs into kimi.com once; the session then persists for
  // headless membership-page scrapes.
  app.post('/api/kimi/quota/login', async (req, res) => {
    try {
      await getManagedQuotaBrowser().openVisibleLogin(KIMI_SUBSCRIPTION_URL);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 kimi.com，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

module.exports = {
  mountKimiQuotaRoutes,
  fetchKimiUsage,
  fetchKimiBalance,
  fetchKimiSubscriptionPage,
  summarizeSubscriptionText,
  subscriptionPanelReady,
  windowTokenForLabel,
  parseResetAfter,
  collectKimiTargets,
  siteLabel,
  balanceHost,
  KIMI_SUBSCRIPTION_URL,
};

'use strict';

// GET  /api/aliyun/quota       — scrape the Aliyun Bailian (阿里云百炼) console
//                                 usage panel through the managed quota browser.
// POST /api/aliyun/quota/login — open a visible Chrome window (managed profile)
//                                 on the console so the user can log in once;
//                                 the session then persists for headless scrapes.
//
// HONEST CAVEAT: Aliyun exposes no public usage API for the token-plan / coding
// accounts this project sees, and there is no Aliyun login on the development
// machine, so the console URL, the login-redirect detector, and the panel
// markers below are BEST-EFFORT wiring modeled on the proven kimi membership
// scrape — not verified against a live logged-in session. When a real login
// becomes available, exercise GET /api/aliyun/quota once and tighten
// ALIYUN_PANEL_MARKER / ALIYUN_CONSOLE_URL to whatever the page actually shows.
// If the console turns out to be unsuitable for stable scraping, say so and
// drop the kind rather than forcing it.

const { getManagedQuotaBrowser } = require('../quota-managed-browser');
// Same unified window shape as the kimi membership scrape: { window, label,
// usedPercent, resetMs } so every quota surface renders through one template.
const { windowTokenForLabel, parseResetAfter } = require('./kimi-quota');

const ALIYUN_CONSOLE_URL = 'https://bailian.console.aliyun.com/';
const CONSOLE_TIMEOUT_MS = Number(process.env.ALIYUN_QUOTA_TIMEOUT_MS || 15000);
function panelTextTimeoutMs() {
  return Number(process.env.ALIYUN_QUOTA_PANEL_TIMEOUT_MS || 30000);
}

// Gate for "the usage panel is actually on screen". The console chrome (topbar /
// nav) loads first and never carries real percentages, so require digits+% plus
// one of the panel's own marker words — same two-condition lesson as kimi.
const ALIYUN_PERCENT_PATTERN = /\d+(?:\.\d+)?\s*%/;
const ALIYUN_PANEL_MARKER = /用量|额度|剩余|配额|已使用/;
function aliyunPanelReady(text) {
  const t = String(text || '');
  return ALIYUN_PERCENT_PATTERN.test(t) && ALIYUN_PANEL_MARKER.test(t);
}

const PLAN_NAME_LINE = /^(coding|standard|pro|free|体验|正式|旗舰)$/i;
const RESET_INFO_LINE = /后重置|重置时间|刷新|到期|续费/;
function labelForPercent(lines, i) {
  for (let j = i - 1, steps = 0; j >= 0 && steps < 6; j--, steps++) {
    const cand = lines[j];
    if (/%/.test(cand)) break;                    // another value: no label for us
    if (PLAN_NAME_LINE.test(cand)) continue;      // plan name sits between label and value
    if (RESET_INFO_LINE.test(cand)) continue;     // reset / expiry boilerplate
    return cand.slice(0, 24);
  }
  return '';
}

// Summary items use the unified window shape: { window, label, usedPercent,
// resetMs, line } (`percent` mirrors usedPercent for pre-upgrade caches).
// A window the mapper cannot classify keeps window:null — the frontend then
// renders it as a plain label segment through the same template.
function summarizeAliyunUsageText(text, nowMs = Date.now()) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+(?:\.\d+)?)\s*%$/) || lines[i].match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) continue;
    const label = labelForPercent(lines, i);
    let resetMs = null;
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (/%/.test(lines[j])) break;
      if (/后重置|重置时间/.test(lines[j])) { resetMs = parseResetAfter(lines[j], nowMs); break; }
    }
    const usedPercent = Number(m[1]);
    hits.push({ window: windowTokenForLabel(label), label, usedPercent, percent: usedPercent, resetMs, line: lines[i].slice(0, 80) });
    if (hits.length >= 6) break;
  }
  return hits.length ? hits : null;
}

// Scrape the logged-in console page. Returns { status:'ok', summary, text } on
// success, needs_login when the profile has no aliyun.com session (or it
// expired mid-redirect), chrome_unavailable when no browser can run at all.
async function fetchAliyunConsolePage(managed = getManagedQuotaBrowser()) {
  let browser;
  try { browser = await managed.attachManaged(); }
  catch (err) {
    const unavailable = err && err.code === 'chrome_unavailable';
    return { status: unavailable ? 'chrome_unavailable' : 'unavailable', error: (err && err.message) || 'managed browser attach failed' };
  }
  try {
    const cookies = await managed.getCookies('aliyun.com', { browser });
    if (!cookies.length) {
      return { status: 'needs_login', error: '托管浏览器中没有 aliyun.com 登录态，点余量徽标可打开登录窗口' };
    }
    return await managed.withPage(async (page) => {
      await page.enable(['Network', 'Page']);
      await page.navigate(ALIYUN_CONSOLE_URL);

      let hitLogin = false;
      const settled = await page.waitFor(async () => {
        const href = await page.evaluate('location.href');
        if (typeof href !== 'string' || !href) return null;
        if (/signin\.aliyun|sign-?in|passport|\/login/i.test(href)) { hitLogin = true; return href; }
        const ready = await page.evaluate('document.readyState');
        return ready === 'complete' ? href : null;
      }, { timeoutMs: CONSOLE_TIMEOUT_MS });
      if (!settled) return { status: 'unavailable', error: '阿里云控制台加载超时' };
      if (hitLogin) return { status: 'needs_login', error: 'aliyun.com 登录态已失效，点余量徽标可重新登录' };

      // The usage panel is an async SPA chunk; give it its own (larger) budget
      // instead of trusting the first text the console chrome renders.
      const text = await page.waitFor(async () => {
        const t = await page.evaluate('document.body ? document.body.innerText : ""');
        return typeof t === 'string' && aliyunPanelReady(t) ? t : null;
      }, { timeoutMs: panelTextTimeoutMs(), intervalMs: 800 }) || '';

      if (!String(text).trim()) return { status: 'unavailable', error: '控制台未渲染出用量面板（可能未登录、无套餐或页面改版）' };
      return {
        status: 'ok',
        fetchedAt: Date.now(),
        source: 'console-page',
        url: settled,
        summary: summarizeAliyunUsageText(text),
        text: String(text).slice(0, 2000),
      };
    }, { browser });
  } catch (err) {
    return { status: 'unavailable', error: (err && err.message) || 'console page scrape failed' };
  } finally {
    browser.close();
  }
}

async function fetchAliyunUsage(nowMs = Date.now(), deps = {}) {
  const scrape = typeof deps.console === 'function' ? deps.console : () => fetchAliyunConsolePage();
  let scraped = null;
  try { scraped = await scrape(); } catch (err) { scraped = { status: 'unavailable', error: err && err.message }; }
  if (scraped && scraped.status === 'ok') return { ...scraped, fetchedAt: scraped.fetchedAt || nowMs };
  if (scraped && scraped.status === 'needs_login') {
    return { status: 'needs_login', error: scraped.error, loginUrl: ALIYUN_CONSOLE_URL };
  }
  return { status: scraped?.status || 'unavailable', error: scraped?.error || 'aliyun console scrape failed', fetchedAt: nowMs };
}

function mountAliyunQuotaRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') return;
  const usageDeps = options.usageDeps || {};
  app.get('/api/aliyun/quota', async (req, res) => {
    try {
      const result = await fetchAliyunUsage(Date.now(), usageDeps);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_login' ? 401
          : status === 'chrome_unavailable' ? 503 : 502;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'aliyun quota fetch failed' });
    }
  });

  // Visible login window on the managed profile — same pattern as kimi / qoder /
  // opencode. The user logs into aliyun.com once; the session then persists for
  // headless console scrapes.
  app.post('/api/aliyun/quota/login', async (req, res) => {
    try {
      await getManagedQuotaBrowser().openVisibleLogin(ALIYUN_CONSOLE_URL);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录阿里云，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

module.exports = {
  mountAliyunQuotaRoutes,
  fetchAliyunUsage,
  fetchAliyunConsolePage,
  summarizeAliyunUsageText,
  aliyunPanelReady,
  ALIYUN_CONSOLE_URL,
};

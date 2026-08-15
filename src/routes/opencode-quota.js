'use strict';

// GET /api/opencode/quota — fetch the user's OpenCode Go subscription usage
// (5h rolling / weekly / monthly limits) from the opencode.ai Zen console.
//
// OpenCode Go does NOT expose usage in API responses (verified: /v1/chat/
// completions and /v1/messages both return only per-request tokens). The only
// authoritative source is the Zen console UI at
// https://opencode.ai/workspace/<workspaceId>/go, which is server-rendered:
// SolidStart inlines the usage data directly into the initial HTML as a
// hydrated JS object literal:
//
//   lite.subscription.get["<workspaceId>"] = {
//     rollingUsage:  { status:"ok", resetInSec:..., usagePercent:... },
//     weeklyUsage:   { status:"ok", resetInSec:..., usagePercent:... },
//     monthlyUsage: { status:"ok", resetInSec:..., usagePercent:... },
//     useBalance:false, region:["us","eu","sg"], ...
//   }
//
// So we drive a browser that holds the user's session — see ../chrome-cdp.js
// for what reaching one requires — opening a throwaway tab at /auth
// (auto-redirects to /workspace/<wsid>/go), reading the SSR HTML, regexing out
// the three usage triplets, and closing the tab again. We do NOT call any
// client-side REST API because there is none. Unlike the qoder route, there is
// no cookie shortcut here: the numbers exist only in the rendered page.
//
// Failure modes we surface to the frontend so the rate-limit bar can prompt
// the user instead of silently degrading:
//   chrome_unavailable — no browser we can reach over CDP
//   needs_login       — page redirected to the /authorize login screen
//                        (no session in that browser)
//   unavailable       — any other error / parse timeout

const { createChromeCdp, portsFromEnv, profileDirsFromEnv } = require('../chrome-cdp');
const { getManagedQuotaBrowser } = require('../quota-managed-browser');
const { renderQuotaBar } = require('../quota/quota-bar-view');

const CDP_TIMEOUT_MS = Number(process.env.OPENCODE_QUOTA_TIMEOUT_MS || 10000);
const OPENCODE_AUTH_URL = process.env.OPENCODE_QUOTA_URL || 'https://opencode.ai/auth';

const chrome = createChromeCdp({
  ports: portsFromEnv(process.env, [process.env.OPENCODE_QUOTA_CDP_PORT].filter(Boolean)),
  profileDirs: profileDirsFromEnv(process.env),
  commandTimeoutMs: CDP_TIMEOUT_MS,
});

// Extract rolling/weekly/monthly usage triplets from the SSR HTML. SolidStart
// serializes the lite.subscription.get hydration data with stable key names
// and shape, so a single regex captures each triplet. We match the FIRST
// occurrence (the inline hydration script is the only place these tokens
// appear in the initial HTML).
//
// Note: we operate on the concatenated text content of <script> tags, NOT on
// document.documentElement.outerHTML — outerHTML HTML-escapes the inline
// script body (`{` becomes `{`-as-text but some engines still escape
// quotes/tag-adjacent chars), so the regex would miss the literal.
function parseUsage(scriptText) {
  if (!scriptText || typeof scriptText !== 'string') return null;
  // The SolidStart hydration literal looks like:
  //   rollingUsage:$R[35]={status:"ok",resetInSec:17617,usagePercent:19}
  // The key is followed by `:$R[N]=` then the object literal. We tolerate the
  // optional `$R[<digits>]=` indirection (and a direct `:` shape) so the regex
  // survives either SolidStart build shape.
  const grab = (key) => {
    const re = new RegExp(
      // Status is not always "ok": a window the account has exhausted reports
      // status:"rate-limited" (verified on the live Zen console), so the status
      // charset must accept hyphens or that window silently drops to null.
      `${key}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{\\s*status\\s*:\\s*["']([a-z][a-z-]*)["']\\s*,\\s*resetInSec\\s*:\\s*(\\d+)\\s*,\\s*usagePercent\\s*:\\s*(\\d+)\\s*\\}`,
    );
    const m = scriptText.match(re);
    if (!m) return null;
    return { status: m[1], resetInSec: Number(m[2]), usagePercent: Number(m[3]) };
  };
  // Note: the billing block also contains `monthlyUsage:null` and
  // `monthlyLimit:null` — we must match the triplet-shaped entries (with
  // resetInSec + usagePercent), not the null placeholders. The triplet regex
  // above does that automatically since `null` doesn't match the inner
  // `{status:...,resetInSec:N,usagePercent:N}` shape.
  // Special handling for monthly: the literal we want appears AFTER the
  // billing null-placeholder. `string.match` returns the FIRST match, but our
  // regex shape (requiring resetInSec:digit) already excludes the null
  // placeholder. So a single match call is enough.
  const rolling = grab('rollingUsage');
  const weekly = grab('weeklyUsage');
  const monthly = grab('monthlyUsage');
  // useBalance appears as `useBalance:!1` (SolidStart minified), not
  // `useBalance:false`. Accept both.
  const patchRe = scriptText.match(/useBalance\s*:\s*(!0|!1|true|false)/);
  if (!rolling && !weekly && !monthly) return null;
  return {
    rolling,
    weekly,
    monthly,
    useBalance: patchRe ? (patchRe[1] === '!0' || patchRe[1] === 'true') : null,
  };
}

async function readUsageFromPage(page) {
  await page.enable(['Runtime', 'Page']);
  await page.navigate(OPENCODE_AUTH_URL);

  // 1. Wait for the redirect chain to settle — either into a workspace (logged
  //    in) or onto the login screen. Half the deadline; the rest is for the
  //    /go navigation and the SSR wait below.
  const finalUrl = await page.waitFor(async () => {
    const raw = await page.evaluate(
      'JSON.stringify({u:location.href,r:document.readyState,h:document.documentElement?document.documentElement.outerHTML.length:0})',
    );
    let js = null;
    try { js = JSON.parse(raw); } catch (_) { return null; }
    if (!js || !js.u) return null;
    if (/auth\.opencode\.ai\/authorize/.test(js.u) && js.h > 200) return js.u;
    if (/\/workspace\/[^/?#]+/.test(js.u) && js.r === 'complete') return js.u;
    return null;
  }, { timeoutMs: Math.floor(CDP_TIMEOUT_MS / 2) });

  if (!finalUrl) return { status: 'unavailable', error: 'page never settled' };

  // 2. Login-page detection.
  if (/auth\.opencode\.ai\/authorize/.test(finalUrl)) {
    const domText = await page.evaluate('document.body?document.body.innerText.slice(0,500):""') || '';
    if (/Continue with GitHub|Continue with Google/i.test(domText)) {
      return { status: 'needs_login', error: 'opencode.ai login required in this Chrome' };
    }
  }

  // 3. If we landed at /workspace/<id> without /go, navigate explicitly to the
  //    /go console route — the SSR hydration data we want is only injected on
  //    that page. If already at /go, we're done.
  if (/\/workspace\/[^/?#]+$/.test(finalUrl) && !/\/go$/.test(finalUrl)) {
    try {
      await page.navigate(`${finalUrl.replace(/\/$/, '')}/go`);
    } catch (err) {
      return { status: 'unavailable', error: 'navigate to /go failed: ' + err.message };
    }
  }

  // 4. Poll until the inline hydration script containing usagePercent is
  //    present in the DOM. On most machines /go SSR lands within ~3s; allow the
  //    rest of the deadline for slow renders. We keep the last text we saw so a
  //    page that rendered *something* reports a parse failure rather than
  //    claiming the scripts were missing.
  let lastScriptText = '';
  const hit = await page.waitFor(async () => {
    const text = await page.evaluate(
      '[...document.querySelectorAll("script")].map(s=>s.textContent||"").join("\\n").slice(0,262144)',
    );
    if (typeof text !== 'string') return null;
    lastScriptText = text;
    return text.includes('usagePercent') ? text : null;
  }, { timeoutMs: Math.floor(CDP_TIMEOUT_MS / 2), intervalMs: 800 });

  const scriptText = hit || lastScriptText;
  if (!scriptText) return { status: 'unavailable', error: 'script tags missing' };

  // 5. Regex the usage triplets out of the SSR script body.
  const parsed = parseUsage(scriptText);
  if (!parsed) return { status: 'unavailable', error: 'usage literals not found in HTML' };

  const wsidMatch = finalUrl.match(/\/workspace\/([^/?#]+)/);
  return {
    status: 'ok',
    workspaceId: wsidMatch ? wsidMatch[1] : null,
    fetchedAt: Date.now(),
    url: finalUrl,
    usage: parsed,
  };
}

async function fetchOpenCodeUsage() {
  const managed = getManagedQuotaBrowser();
  const sources = [
    {
      label: 'managed',
      run: async () => {
        const browser = await managed.attachManaged();
        try { return await managed.withPage(readUsageFromPage, { browser }); }
        finally { browser.close(); }
      },
    },
    {
      label: 'user-chrome',
      run: async () => {
        const browser = await chrome.attach();
        try { return await chrome.withPage(readUsageFromPage, { browser }); }
        finally { browser.close(); }
      },
    },
  ];

  let lastNeedsLogin = null;
  let lastUnavailable = null;
  let anyAttached = false;
  for (const source of sources) {
    let result;
    try { result = await source.run(); }
    catch (err) {
      if (err && err.code === 'chrome_unavailable') continue;
      return { status: 'unavailable', error: err.message };
    }
    anyAttached = true;
    if (result.status === 'ok') return { ...result, source: source.label };
    if (result.status === 'needs_login') { lastNeedsLogin = result; continue; }
    lastUnavailable = result;
  }
  if (lastNeedsLogin) return lastNeedsLogin;
  if (!anyAttached) {
    return { status: 'chrome_unavailable', error: '托管浏览器启动失败且没有可连的 Chrome 调试端点' };
  }
  return lastUnavailable || { status: 'unavailable', error: '所有浏览器来源都未能取得用量' };
}

function mountOpenCodeQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/opencode/quota', async (req, res) => {
    try {
      const result = await fetchOpenCodeUsage();
      const status = (result && result.status) || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : (status === 'needs_login' ? 401
          : (status === 'chrome_unavailable' ? 503 : 500));
      // The bar is rendered here, once, so the web and the app display the same
      // string rather than each formatting this JSON their own way.
      res.status(httpStatus).json({ ...result, bar: renderQuotaBar('opencode', result) });
    } catch (err) {
      const result = { status: 'unavailable', error: 'opencode quota fetch failed' };
      res.status(500).json({ ...result, bar: renderQuotaBar('opencode', result) });
    }
  });

  // Visible login window on the managed profile — same pattern as qoder: the
  // user logs in once, the session persists for later headless fetches.
  app.post('/api/opencode/quota/login', async (req, res) => {
    try {
      await getManagedQuotaBrowser().openVisibleLogin(OPENCODE_AUTH_URL);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 opencode.ai，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

module.exports = {
  mountOpenCodeQuotaRoutes,
  fetchOpenCodeUsage,
  parseUsage,
  // exposed for tests
  readUsageFromPage,
};
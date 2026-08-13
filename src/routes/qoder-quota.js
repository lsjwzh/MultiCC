'use strict';

// GET /api/qoder/quota — fetch Qoder CN credit usage from the user's own
// logged-in browser session.
//
// Qoder CN publishes credits only to its web app: the usage page is a SPA that
// calls /api/v2/me/usages/big_model_credits with session cookies, and the CLI's
// auth file uses an encryption we can't decode, so there is no token API to
// point at. What the browser has that we don't is the cookie.
//
// So take the cookie, not the browser. Reading it needs a browser we can reach
// over CDP (see ../chrome-cdp.js for what that requires), but once read, the
// usage API answers a plain HTTPS request — no CSRF header, no tab, no
// navigation, and no visible disturbance in someone's own browser. We cache the
// cookies, so refreshes for the next week need no browser running at all; the
// browser is only how the session gets in here the first time.
//
// The tab-and-intercept path the route used to take is kept as a fallback for
// the day the API starts demanding something only the page can produce.
//
// Failure modes surfaced to the frontend:
//   chrome_unavailable — no reachable browser, and no cached session either
//   needs_login        — a browser is there, but not logged in to qoder.com.cn
//   unavailable        — anything else

const fs = require('fs');
const https = require('https');
const path = require('path');

const {
  createChromeCdp,
  portsFromEnv,
  profileDirsFromEnv,
} = require('../chrome-cdp');
const { getManagedQuotaBrowser } = require('../quota-managed-browser');
const { renderQuotaBar } = require('../quota/quota-bar-view');

const SITE = 'qoder.com.cn';
const QUOTA_URL = `https://${SITE}/api/v2/me/usages/big_model_credits`;
const PLAN_URL = `https://${SITE}/api/v1/me/userplan`;
const USAGE_PAGE_URL = `https://${SITE}/account/usage`;
const LOGIN_PAGE_URL = `https://${SITE}/account`;
const HTTP_TIMEOUT_MS = Number(process.env.QODER_QUOTA_HTTP_TIMEOUT_MS || 8000);
const PAGE_TIMEOUT_MS = Number(process.env.QODER_QUOTA_TIMEOUT_MS || 15000);
const COOKIE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const DATA_DIR = process.env.MULTICC_DATA_DIR || path.join(require('os').homedir(), '.multicc');
const COOKIE_FILE = path.join(DATA_DIR, 'qoder-cookies.json');

const chrome = createChromeCdp({
  ports: portsFromEnv(process.env, [process.env.QODER_QUOTA_CDP_PORT].filter(Boolean)),
  profileDirs: profileDirsFromEnv(process.env),
  commandTimeoutMs: PAGE_TIMEOUT_MS,
});

function saveCookies(cookies) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify({ savedAt: Date.now(), cookies }, null, 2));
  } catch (_) {}
}

function loadSavedCookies() {
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (raw && Array.isArray(raw.cookies) && raw.savedAt
      && (Date.now() - raw.savedAt) < COOKIE_MAX_AGE_MS) return raw;
  } catch (_) {}
  return null;
}

function cookieHeader(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function httpsGetJson(url, jar) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        Cookie: jar,
        Accept: 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ statusCode: res.statusCode, location: res.headers.location || '', json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('qoder API timeout')));
    req.on('error', reject);
    req.end();
  });
}

function looksLikeQuota(json) {
  if (!json || typeof json !== 'object') return false;
  return Boolean(json.total_quota || json.plan_quota || json.resource_package_quota);
}

// A dead session doesn't always answer 401 — some deployments redirect an
// unauthenticated XHR to the sign-in page instead — so both shapes count.
function isUnauthenticated(response) {
  if (response.statusCode === 401 || response.statusCode === 403) return true;
  if (response.statusCode >= 300 && response.statusCode < 400) {
    return /sign-?in|login/i.test(response.location || '');
  }
  return false;
}

async function fetchWithCookies(cookies) {
  const jar = cookieHeader(cookies);
  if (!jar) return { status: 'needs_login', error: '没有 qoder.com.cn 的会话 cookie' };

  const quotaRes = await httpsGetJson(QUOTA_URL, jar);
  if (isUnauthenticated(quotaRes)) {
    return { status: 'needs_login', error: 'qoder.com.cn 会话已失效' };
  }
  if (quotaRes.statusCode !== 200 || !looksLikeQuota(quotaRes.json)) {
    return { status: 'unavailable', error: `用量 API 返回 HTTP ${quotaRes.statusCode}` };
  }

  let plan = null;
  try {
    const planRes = await httpsGetJson(PLAN_URL, jar);
    if (planRes.statusCode === 200 && planRes.json) plan = planRes.json;
  } catch (_) {}

  return { status: 'ok', fetchedAt: Date.now(), quota: quotaRes.json, plan };
}

// Fallback: drive a throwaway tab and read the SPA's own API responses. Slower
// and visible to the user, so it only runs when the cookie path failed for a
// reason a real page might get past.
async function fetchViaPage(browser) {
  return chrome.withPage(async (page) => {
    await page.enable(['Network', 'Page']);
    await page.navigate(USAGE_PAGE_URL);

    let needsLogin = false;
    const hit = await page.waitFor(async () => {
      const href = await page.evaluate('location.href');
      if (typeof href === 'string' && /sign-?in|login/i.test(href)) { needsLogin = true; return true; }
      return page.findResponse((r) => r.url.includes('usages/big_model_credits') && !r.url.includes('histories'));
    }, { timeoutMs: PAGE_TIMEOUT_MS });

    if (needsLogin) return { status: 'needs_login', error: '请在 Chrome 中登录 qoder.com.cn' };
    if (!hit) return { status: 'unavailable', error: '未能捕获用量 API 响应' };

    let quota = null;
    try { quota = JSON.parse(await page.responseBody(hit.requestId)); } catch (_) {}
    if (!looksLikeQuota(quota)) return { status: 'unavailable', error: '用量 API 响应无法解析' };

    let plan = null;
    const planHit = page.findResponse((r) => r.url.includes('userplan'));
    if (planHit) { try { plan = JSON.parse(await page.responseBody(planHit.requestId)); } catch (_) {} }

    return { status: 'ok', fetchedAt: Date.now(), quota, plan };
  }, { browser });
}

async function fetchQoderUsage() {
  // 1. Cached cookies: the fast path, and the only one that works with the
  //    browser closed.
  const saved = loadSavedCookies();
  if (saved) {
    try {
      const result = await fetchWithCookies(saved.cookies);
      if (result.status === 'ok') return { ...result, source: 'saved-cookies' };
    } catch (_) { /* fall through to the browser */ }
  }

  // 2. A live browser — managed headless Chrome first (its profile keeps the
  //    login between fetches), then the user's own debug Chrome as fallback.
  const managed = getManagedQuotaBrowser();
  const sources = [
    { label: 'managed', attach: () => managed.attachManaged(), cookies: (b) => managed.getCookies(SITE, { browser: b }) },
    { label: 'user-chrome', attach: () => chrome.attach(), cookies: (b) => chrome.getCookies(SITE, { browser: b }) },
  ];
  let lastNeedsLogin = null;
  let anyAttached = false;
  for (const source of sources) {
    let browser;
    try { browser = await source.attach(); }
    catch (_) { continue; }
    anyAttached = true;
    try {
      const cookies = await source.cookies(browser);
      if (!cookies.length) {
        lastNeedsLogin = { status: 'needs_login', error: '浏览器中没有 qoder.com.cn 的登录态，点余量徽标可打开登录窗口' };
        continue;
      }
      const result = await fetchWithCookies(cookies);
      if (result.status === 'ok') {
        saveCookies(cookies);
        return { ...result, source: `${source.label}-cookies` };
      }
      if (result.status === 'needs_login') { lastNeedsLogin = result; continue; }

      // The cookie is good enough to be worth a page, so let the SPA make the
      // call itself before we give up.
      const viaPage = await fetchViaPage(browser);
      if (viaPage.status === 'ok') { saveCookies(cookies); return { ...viaPage, source: `${source.label}-page` }; }
      return viaPage;
    } catch (err) {
      return { status: 'unavailable', error: err.message };
    } finally {
      browser.close();
    }
  }
  if (lastNeedsLogin) return lastNeedsLogin;
  if (!anyAttached) {
    return { status: 'chrome_unavailable', error: '托管浏览器启动失败且没有可连的 Chrome 调试端点' };
  }
  return { status: 'unavailable', error: '所有浏览器来源都未能取得用量' };
}

function mountQoderQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;

  app.get('/api/qoder/quota', async (req, res) => {
    try {
      const result = await fetchQoderUsage();
      const status = (result && result.status) || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_login' ? 401
          : status === 'chrome_unavailable' ? 503 : 500;
      // The bar is rendered here, once, so the web and the app display the same
      // string rather than each formatting this JSON their own way.
      res.status(httpStatus).json({ ...result, bar: renderQuotaBar('qoder', result) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'qoder quota fetch failed' };
      res.status(500).json({ ...result, bar: renderQuotaBar('qoder', result) });
    }
  });

  // Open a visible login window on the managed profile. The headless instance
  // is stopped first (one profile, one Chrome), and the window is left to the
  // user — once they log in, the session persists in the profile for later
  // headless fetches.
  app.post('/api/qoder/quota/login', async (req, res) => {
    try {
      await getManagedQuotaBrowser().openVisibleLogin(LOGIN_PAGE_URL);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 qoder.com.cn，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });

  app.get('/api/qoder/quota/cookies', (req, res) => {
    const saved = loadSavedCookies();
    if (!saved) return res.status(404).json({ ok: false, error: 'no saved cookies' });
    res.json(saved);
  });
}

module.exports = {
  mountQoderQuotaRoutes,
  fetchQoderUsage,
  // exposed for tests
  cookieHeader,
  looksLikeQuota,
  isUnauthenticated,
};

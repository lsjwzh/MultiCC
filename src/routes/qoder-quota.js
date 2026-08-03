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

  // 2. The live browser — which may hold a newer session than the file does.
  let browser;
  try { browser = await chrome.attach(); }
  catch (err) {
    if (err.code === 'chrome_unavailable') {
      return { status: 'chrome_unavailable', error: '没有可连接的 Chrome 调试端点' };
    }
    return { status: 'unavailable', error: err.message };
  }

  try {
    const cookies = await chrome.getCookies(SITE, { browser });
    if (!cookies.length) {
      return { status: 'needs_login', error: 'Chrome 中没有 qoder.com.cn 的登录态' };
    }
    const result = await fetchWithCookies(cookies);
    if (result.status === 'ok') {
      saveCookies(cookies);
      return { ...result, source: 'chrome-cookies' };
    }
    if (result.status === 'needs_login') return result;

    // The cookie is good enough to be worth a page, so let the SPA make the
    // call itself before we give up.
    const viaPage = await fetchViaPage(browser);
    if (viaPage.status === 'ok') { saveCookies(cookies); return { ...viaPage, source: 'page' }; }
    return viaPage;
  } catch (err) {
    return { status: 'unavailable', error: err.message };
  } finally {
    browser.close();
  }
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
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'qoder quota fetch failed' });
    }
  });

  // Open the login page for the user. This tab is deliberately left open —
  // it is the one the user is about to type into.
  app.post('/api/qoder/quota/login', async (req, res) => {
    let browser;
    try { browser = await chrome.attach(); }
    catch (_) { return res.status(503).json({ ok: false, error: 'chrome_unavailable' }); }
    try {
      await browser.send('Target.createTarget', { url: LOGIN_PAGE_URL });
      res.json({ ok: true, message: '已在 Chrome 中打开 Qoder 登录页' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      browser.close();
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

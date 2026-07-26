'use strict';

// GET /api/qoder/quota — fetch Qoder CN credit usage via CDP network interception.
//
// Qoder CN's usage page (qoder.com.cn/account/usage) is a SPA that fetches
// quota data from its own /api/v2/me/usages/big_model_credits endpoint with
// session cookies. There is no public Bearer-token API for credits (the CLI
// auth file uses a custom encryption we can't decode). So we drive the user's
// local Chrome via CDP (127.0.0.1:9222), navigate to the usage page, and
// intercept the network responses to capture the quota JSON.
//
// Failure modes surfaced to the frontend:
//   chrome_unavailable — CDP 9222 not reachable
//   needs_login       — page redirected to sign-in (no session)
//   unavailable       — any other error / timeout

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_HOST = process.env.QODER_QUOTA_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.QODER_QUOTA_CDP_PORT || 9222);
const CDP_TIMEOUT_MS = Number(process.env.QODER_QUOTA_TIMEOUT_MS || 15000);
const USAGE_URL = 'https://qoder.com.cn/account/usage';
const WS_OPTIONS = { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 };

const DATA_DIR = process.env.MULTICC_DATA_DIR || path.join(require('os').homedir(), '.multicc');
const COOKIE_FILE = path.join(DATA_DIR, 'qoder-cookies.json');

function cdpJson(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: CDP_HOST, port: CDP_PORT, path: endpoint, timeout: 2000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (_) { reject(new Error('CDP returned non-JSON')); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP http timeout')));
    req.on('error', reject);
  });
}

function cdpPut(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: CDP_HOST, port: CDP_PORT, path: endpoint, method: 'PUT', timeout: 3000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (_) { resolve({}); } });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP http timeout')));
    req.on('error', reject);
    req.end();
  });
}

function openChromeTab(url) {
  return cdpPut(`/json/new?${encodeURIComponent(url)}`);
}

function closeChromeTab(targetId) {
  return cdpJson(`/json/close/${targetId}`).catch(() => ({}));
}

function openPageSession(tab) {
  const ws = new WebSocket(tab.webSocketDebuggerUrl, WS_OPTIONS);
  let nextId = 0;
  const pending = new Map();
  const handlers = [];
  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, CDP_TIMEOUT_MS);
    });
  }
  ws.on('message', (msg) => {
    let obj;
    try { obj = JSON.parse(msg.toString()); } catch (_) { return; }
    if (obj.id && pending.has(obj.id)) {
      const p = pending.get(obj.id); pending.delete(obj.id);
      if (obj.error) p.reject(new Error(obj.error.message || 'CDP error'));
      else p.resolve(obj.result);
    } else {
      for (const h of handlers) h(obj);
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({
      send,
      onEvent: (fn) => handlers.push(fn),
      close: () => ws.close(),
    }));
    ws.on('error', reject);
  });
}

function saveCookies(cookies) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify({ savedAt: Date.now(), cookies }, null, 2));
  } catch (_) {}
}

function loadSavedCookies() {
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (raw && raw.cookies && raw.savedAt && (Date.now() - raw.savedAt) < 7 * 24 * 3600 * 1000) {
      return raw;
    }
  } catch (_) {}
  return null;
}

async function fetchQoderUsage() {
  let version;
  try { version = await cdpJson('/json/version'); }
  catch (_) { return { status: 'chrome_unavailable', error: 'CDP 9222 unreachable' }; }
  if (!version || !version['webSocketDebuggerUrl']) {
    return { status: 'chrome_unavailable', error: 'CDP version missing' };
  }

  // Reuse existing qoder tab if present
  let tab;
  let existingTab = false;
  try {
    const targets = await cdpJson('/json');
    tab = targets.find((t) => t.type === 'page' && t.url && t.url.includes('qoder.com.cn'));
    if (tab) existingTab = true;
  } catch (_) {}

  if (!tab) {
    try { tab = await openChromeTab('about:blank'); }
    catch (err) { return { status: 'chrome_unavailable', error: 'open tab failed: ' + err.message }; }
  }
  if (!tab || !tab.id || !tab.webSocketDebuggerUrl) {
    return { status: 'chrome_unavailable', error: 'tab missing ws url' };
  }
  const targetId = tab.id;

  let session;
  try {
    session = await openPageSession(tab);
    await session.send('Network.enable', {});
    await session.send('Page.enable', {});

    const apiResponses = [];
    const capturedCookies = [];

    session.onEvent((evt) => {
      if (evt.method === 'Network.responseReceived') {
        const url = evt.params?.response?.url || '';
        if (url.includes('/api/') && url.includes('qoder.com.cn')) {
          apiResponses.push({ requestId: evt.params.requestId, url, status: evt.params.response.status });
        }
      }
    });

    await session.send('Page.navigate', { url: USAGE_URL });

    // Poll for login state or API responses
    const deadline = Date.now() + CDP_TIMEOUT_MS;
    let needsLogin = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));

      // Check if redirected to sign-in
      try {
        const nav = await session.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        const href = nav?.result?.value || '';
        if (href.includes('sign-in') || href.includes('login')) {
          needsLogin = true;
          break;
        }
      } catch (_) {}

      // Check if we got the quota API response
      const quotaResp = apiResponses.find((r) => r.url.includes('usages/big_model_credits') && !r.url.includes('histories'));
      if (quotaResp) break;
    }

    if (needsLogin) {
      return { status: 'needs_login', error: '请在 Chrome 9222 中登录 qoder.com.cn' };
    }

    // Extract cookies for curl reuse
    try {
      const cookieResult = await session.send('Network.getAllCookies', {});
      const qoderCookies = (cookieResult.cookies || []).filter((c) =>
        c.domain.includes('qoder.com.cn')
      );
      if (qoderCookies.length) saveCookies(qoderCookies);
    } catch (_) {}

    // Fetch response bodies
    const quotaResp = apiResponses.find((r) => r.url.includes('usages/big_model_credits') && !r.url.includes('histories'));
    const planResp = apiResponses.find((r) => r.url.includes('userplan'));

    let quota = null;
    let plan = null;

    if (quotaResp) {
      try {
        const body = await session.send('Network.getResponseBody', { requestId: quotaResp.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body;
        quota = JSON.parse(text);
      } catch (_) {}
    }

    if (planResp) {
      try {
        const body = await session.send('Network.getResponseBody', { requestId: planResp.requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body;
        plan = JSON.parse(text);
      } catch (_) {}
    }

    if (!quota) {
      return { status: 'unavailable', error: '未能捕获用量 API 响应' };
    }

    return {
      status: 'ok',
      fetchedAt: Date.now(),
      quota,
      plan,
    };
  } finally {
    if (session) try { session.close(); } catch (_) {}
    if (!existingTab) { try { await closeChromeTab(targetId); } catch (_) {} }
  }
}

function mountQoderQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;

  app.get('/api/qoder/quota', async (req, res) => {
    try {
      const result = await fetchQoderUsage();
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_login' ? 401
        : status === 'chrome_unavailable' ? 503 : 500;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'qoder quota fetch failed' });
    }
  });

  // Open qoder login page in Chrome for the user
  app.post('/api/qoder/quota/login', async (req, res) => {
    try {
      await cdpJson('/json/version');
    } catch (_) {
      return res.status(503).json({ ok: false, error: 'chrome_unavailable' });
    }
    try {
      const targets = await cdpJson('/json');
      const existing = targets.find((t) => t.type === 'page' && t.url && t.url.includes('qoder.com.cn'));
      if (!existing) await openChromeTab('https://qoder.com.cn/account');
      res.json({ ok: true, message: '已在 Chrome 中打开 Qoder 登录页' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Get saved cookies for curl usage
  app.get('/api/qoder/quota/cookies', (req, res) => {
    const saved = loadSavedCookies();
    if (!saved) return res.status(404).json({ ok: false, error: 'no saved cookies' });
    res.json(saved);
  });
}

module.exports = { mountQoderQuotaRoutes, fetchQoderUsage };

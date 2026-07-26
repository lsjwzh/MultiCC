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
// So we drive the user's local Chrome via CDP (127.0.0.1:9222) — which already
// holds their opencode.ai login session — open a tab at /auth (auto-redirects
// to /workspace/<wsid>/go), read the SSR HTML, regex out the three usage
// triplets, close the tab. We do NOT call any client-side REST API because
// there is none.
//
// Failure modes we surface to the frontend so the rate-limit bar can prompt
// the user instead of silently degrading:
//   chrome_unavailable — CDP 9222 not reachable (Chrome not started with
//                        --remote-debugging-port=9222)
//   needs_login       — page redirected to the /authorize login screen
//                        (no session in this Chrome)
//   unavailable       — any other error / parse timeout

const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const CDP_HOST = process.env.OPENCODE_QUOTA_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.OPENCODE_QUOTA_CDP_PORT || 9222);
const CDP_TIMEOUT_MS = Number(process.env.OPENCODE_QUOTA_TIMEOUT_MS || 10000);
const OPENCODE_AUTH_URL = process.env.OPENCODE_QUOTA_URL || 'https://opencode.ai/auth';
const WS_OPTIONS = { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 };

function cdpJson(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: CDP_HOST, port: CDP_PORT, path: endpoint, timeout: 2000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(new Error('CDP returned non-JSON')); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP http timeout')));
    req.on('error', reject);
  });
}

function cdpPut(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : '';
    const req = http.request(
      {
        host: CDP_HOST, port: CDP_PORT, path: endpoint, method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 3000,
      },
      (res) => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (_) { resolve({}); } });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP http timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function openChromeTab(url) {
  // /json/new?<url> with PUT (GET is 405 on newer Chrome).
  const safeUrl = encodeURIComponent(url);
  return cdpPut(`/json/new?${safeUrl}`, null);
}

function closeChromeTab(targetId) {
  return cdpJson(`/json/close/${targetId}`).catch(() => ({}));
}

function evalInTab(wsConnection, expression, returnByValue = true) {
  return wsConnection.send('Runtime.evaluate', { expression, returnByValue });
}

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
      `${key}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{\\s*status\\s*:\\s*["']([a-z]+)["']\\s*,\\s*resetInSec\\s*:\\s*(\\d+)\\s*,\\s*usagePercent\\s*:\\s*(\\d+)\\s*\\}`,
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

// Connect to a page's DevTools websocket and run eval + close protocol.
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

async function fetchOpenCodeUsage() {
  // 1. Verify CDP is reachable.
  let version;
  try { version = await cdpJson('/json/version'); }
  catch (err) { return { status: 'chrome_unavailable', error: 'CDP 9222 unreachable' }; }
  if (!version || !version['webSocketDebuggerUrl']) {
    return { status: 'chrome_unavailable', error: 'CDP version missing' };
  }

  // 2. Open a new tab (about:blank) — we'll navigate explicitly via
  //    Page.navigate so we can wait for the SSR render. Some Chrome builds
  //    accept the URL in /json/new?<u> but the tab stays on about:blank until
  //    the renderer is ready; explicit Page.navigate + frameStoppedLoading is
  //    the reliable cross-version path.
  let tab;
  try { tab = await openChromeTab('about:blank'); }
  catch (err) { return { status: 'chrome_unavailable', error: 'open tab failed: ' + err.message }; }
  if (!tab || !tab.id || !tab.webSocketDebuggerUrl) {
    return { status: 'chrome_unavailable', error: 'tab created without ws url' };
  }
  const targetId = tab.id;

  let session;
  try {
    session = await openPageSession(tab);
    await session.send('Runtime.enable', {});
    await session.send('Page.enable', {});

    let navError = null;
    session.onEvent((evt) => {
      if (evt.method === 'Page.frameStoppedLoading') {
        // informational only — polling below drives the readiness check
      }
    });

    // 3. Trigger navigation.
    try {
      await session.send('Page.navigate', { url: OPENCODE_AUTH_URL });
    } catch (err) { return { status: 'unavailable', error: 'navigate failed: ' + err.message }; }

    // 4. Poll until location stabilizes (either logged into a workspace, or hit
    //    the login screen). Cap at CDP_TIMEOUT_MS / 2 — we leave the rest for
    //    the /go navigation + script-wait below.
    const settleDeadline = Date.now() + Math.floor(CDP_TIMEOUT_MS / 2);
    let finalUrl = '';
    while (Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const nav = await session.send('Runtime.evaluate', {
          expression: 'JSON.stringify({u:location.href,r:document.readyState,h:document.documentElement?document.documentElement.outerHTML.length:0})',
          returnByValue: true,
        });
        const v = nav && nav.result && nav.result.value;
        if (!v) continue;
        let js; try { js = JSON.parse(v); } catch (_) { continue; }
        finalUrl = js.u || '';
        if (/auth\.opencode\.ai\/authorize/.test(finalUrl) && js.h > 200) break;
        if (/\/workspace\/[^/?#]+/.test(finalUrl) && js.r === 'complete') break;
      } catch (_) { /* keep waiting */ }
    }

    if (!finalUrl) {
      return { status: 'unavailable', error: 'page never settled' };
    }

    // 5. Login-page detection.
    if (/auth\.opencode\.ai\/authorize/.test(finalUrl)) {
      const domRes = await session.send('Runtime.evaluate', { expression: 'document.body?document.body.innerText.slice(0,500):""', returnByValue: true });
      const domText = (domRes && domRes.result && domRes.result.value) || '';
      if (/Continue with GitHub|Continue with Google/i.test(domText)) {
        return { status: 'needs_login', error: 'opencode.ai login required in this Chrome' };
      }
    }

    // 6. If we landed at /workspace/<id> without /go, navigate explicitly to
    //    the /go console route — the SSR hydration data we want is only
    //    injected on that page. If already at /go, we're done.
    if (/\/workspace\/[^/?#]+$/.test(finalUrl) && !/\/go$/.test(finalUrl)) {
      try {
        await session.send('Page.navigate', { url: finalUrl.replace(/\/$/, '') + '/go' });
      } catch (err) {
        return { status: 'unavailable', error: 'navigate to /go failed: ' + err.message };
      }
    }

    // 7. Poll until the inline hydration script containing usagePercent is
    //    present in the DOM. On most machines /go SSR lands within ~3s; allow
    //    the rest of the deadline for slow renders.
    const scriptDeadline = Date.now() + Math.floor(CDP_TIMEOUT_MS / 2);
    let scriptText = '';
    while (Date.now() < scriptDeadline) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const scriptRes = await session.send('Runtime.evaluate', {
          expression: '[...document.querySelectorAll("script")].map(s=>s.textContent||"").join("\\n").slice(0,262144)',
          returnByValue: true,
        });
        scriptText = (scriptRes && scriptRes.result && scriptRes.result.value) || '';
        if (scriptText.includes('usagePercent')) break;
      } catch (_) { /* keep waiting */ }
    }
    if (!scriptText) {
      return { status: 'unavailable', error: 'script tags missing' };
    }

    // 8. Regex the usage triplets out of the SSR script body.
    const parsed = parseUsage(scriptText);
    if (!parsed) {
      return { status: 'unavailable', error: 'usage literals not found in HTML' };
    }
    const wsidMatch = finalUrl.match(/\/workspace\/([^/?#]+)/);
    return {
      status: 'ok',
      workspaceId: wsidMatch ? wsidMatch[1] : null,
      fetchedAt: Date.now(),
      url: finalUrl,
      usage: parsed,
    };
  } finally {
    if (session) try { session.close(); } catch (_) {}
    try { await closeChromeTab(targetId); } catch (_) {}
  }
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
      res.status(httpStatus).json(result);
    } catch (err) {
      res.status(500).json({ status: 'unavailable', error: 'opencode quota fetch failed' });
    }
  });
}

module.exports = {
  mountOpenCodeQuotaRoutes,
  fetchOpenCodeUsage,
  parseUsage,
  // exposed for tests
  _cdpJson: cdpJson,
  _cdpPut: cdpPut,
  _openChromeTab: openChromeTab,
  _closeChromeTab: closeChromeTab,
  _openPageSession: openPageSession,
};
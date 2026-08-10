'use strict';

// GET /api/claude/quota — fetch the Claude subscription's usage windows
// (5h session / weekly / monthly) from claude.ai/settings/usage.
//
// Claude's plan limits are NOT exposed through any REST API the CLI can reach:
// the structured rate_limit_event only carries the 5h rolling window, and there
// is no usage endpoint a cookie-only request could query. The authoritative
// source is the /settings/usage SPA, which is behind Cloudflare — plain HTTP
// scraping gets blocked (verified in the task brief: don't bother with a cookie
// fallback). So we drive a browser that holds the user's session — see
// ../quota-managed-browser.js (multicc-owned profile) and ../chrome-cdp.js
// (any local Chrome) — render the page headlessly, wait for it to hydrate, and
// parse `document.body.innerText` for the window percentages + reset times,
// the same text-heuristic approach as the kimi membership page.
//
// Response (ok):
//   { status:'ok', fetchedAt, source, url,
//     summary:[ { window:'5h'|'1wk'|'1m'|null, label, usedPercent, resetMs, line } ] }
// The 5h row on the page duplicates the passive rate_limit_event, so the
// frontend keeps the event's 5h and appends the weekly/monthly rows from here.
//
// Failure modes surfaced to the frontend so the rate-limit bar can prompt the
// user instead of silently degrading:
//   chrome_unavailable — no browser we can reach over CDP
//   needs_login       — page redirected to the login screen (no session)
//   unavailable       — any other error / parse timeout (incl. Cloudflare)

const { createChromeCdp, portsFromEnv, profileDirsFromEnv } = require('../chrome-cdp');
const { getManagedQuotaBrowser } = require('../quota-managed-browser');

const CDP_TIMEOUT_MS = Number(process.env.CLAUDE_QUOTA_TIMEOUT_MS || 15000);
function panelTextTimeoutMs() {
  return Number(process.env.CLAUDE_QUOTA_PANEL_TIMEOUT_MS || 30000);
}
const CLAUDE_USAGE_URL = process.env.CLAUDE_QUOTA_URL || 'https://claude.ai/settings/usage';

const chrome = createChromeCdp({
  ports: portsFromEnv(process.env, [process.env.CLAUDE_QUOTA_CDP_PORT].filter(Boolean)),
  profileDirs: profileDirsFromEnv(process.env),
  commandTimeoutMs: CDP_TIMEOUT_MS,
});

// Gate for "the usage panel is actually on screen". claude.ai renders a shell
// first; the panel only appears after the SPA hydrates. Require a real
// percentage plus one of the window markers the page uses (current session /
// weekly / monthly / countdown boilerplate).
const PANEL_PERCENT_PATTERN = /\d+(?:\.\d+)?\s*%/;
const USAGE_MARKER_PATTERN = /current session|weekly|monthly|5\s*hour|7\s*day|30\s*day|resets?\s+in|会话|周用量|月用量|5 小时/i;
function usagePanelReady(text) {
  const t = String(text || '');
  return PANEL_PERCENT_PATTERN.test(t) && USAGE_MARKER_PATTERN.test(t);
}

// Map the raw scraped window label to the standard window token every quota
// surface renders through (chat-rate-limit unifiedWindowSeg). The frontend no
// longer trusts the raw English label.
function windowTokenForLabel(label) {
  const l = String(label || '');
  if (/session|hour|5\s*h/i.test(l)) return '5h';
  if (/week|7\s*day/i.test(l)) return '1wk';
  if (/month|30\s*day/i.test(l)) return '1m';
  return null;
}

// claude.ai prints the reset time in TWO forms: a live countdown for a window
// that turns over soon ("Resets in 3h 20m"), and an absolute local weekday for
// one days away ("Resets Wed 2:00 PM"). Only the countdown form used to be
// understood, which is why the weekly rows lost both their countdown AND their
// label — see RESET_INFO_LINE below.
//
// The absolute form resolves to the NEXT such weekday-and-time after now: a
// window never resets in the past, and the page never says which week it means.
const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

function parseAbsoluteReset(text, nowMs) {
  const m = String(text || '').match(
    /resets?\s+(?:on\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?(?:\s+at)?(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i,
  );
  if (!m) return null;
  let hour = m[2] === undefined ? 0 : Number(m[2]);
  const minute = m[3] === undefined ? 0 : Number(m[3]);
  const meridiem = (m[4] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(nowMs);
  at.setHours(hour, minute, 0, 0);
  at.setDate(at.getDate() + ((WEEKDAYS.indexOf(m[1].toLowerCase()) - at.getDay() + 7) % 7));
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 7);  // that time already passed today
  return at.getTime();
}

// The relative form is a sum of whatever units the page felt like printing, in
// whatever spelling: "3d 4h", "2h 15m", "1 hr 18 min", "45 minutes". Summing
// every unit found beats a ladder of shape-specific patterns — the ladder
// silently read "1 hr 18 min" as one hour, because its "h then m" pattern
// wanted a space where the page had the "r" of "hr", and the plain-hours
// pattern below it matched first.
const RESET_UNIT_SECONDS = Object.freeze({ d: 86400, h: 3600, m: 60 });

function parseClaudeReset(text, nowMs = Date.now()) {
  const t = String(text || '');
  const relative = t.match(/resets?\s+in\s+(.+)/i);
  if (relative) {
    let seconds = 0;
    let matched = false;
    const units = /(\d+)\s*(days?|d|hrs?|hours?|h|mins?|minutes?|m)\b/gi;
    for (let u = units.exec(relative[1]); u; u = units.exec(relative[1])) {
      seconds += Number(u[1]) * RESET_UNIT_SECONDS[u[2][0].toLowerCase()];
      matched = true;
    }
    if (matched) return nowMs + seconds * 1000;
  }
  return parseAbsoluteReset(t, nowMs);
}

// Plan names sit between the window label and its percentage on this page, so
// they are skipped while walking backwards for the label.
const PLAN_NAME_LINE = /^(max|pro|team|enterprise|standard|plus|opus|sonnet|haiku|free)$/i;
// ANY line mentioning a reset is boilerplate, never a window label. Matching
// only the "resets in" phrasing let "Resets Wed 2:00 PM" through as the label
// for the weekly rows, so windowTokenForLabel saw no week/month keyword and the
// bar rendered a reset date where a window name belongs.
const RESET_INFO_LINE = /resets?\b|重置|remaining/i;
function labelForPercent(lines, i) {
  for (let j = i - 1, steps = 0; j >= 0 && steps < 6; j--, steps++) {
    const cand = lines[j];
    if (/%/.test(cand)) break;                 // another value: no label for us
    if (PLAN_NAME_LINE.test(cand)) continue;   // plan name between label and value
    if (RESET_INFO_LINE.test(cand)) continue;  // reset boilerplate
    return cand.slice(0, 24);
  }
  return '';
}

// The reset line sits next to its percentage — the page currently prints it
// just ABOVE (label / reset / percent), earlier layouts printed it below. Both
// are read, but each direction stops at the first line that reads like a label:
// in the current layout the line below a value is the NEXT row's label, and
// scanning past it would hand this row its neighbour's reset time.
function resetNearPercent(lines, i, nowMs) {
  for (const step of [1, -1]) {
    for (let j = i + step; j >= 0 && j < lines.length && Math.abs(j - i) <= 3; j += step) {
      if (/%/.test(lines[j])) break;              // the neighbouring row's value
      if (PLAN_NAME_LINE.test(lines[j])) continue;
      const at = parseClaudeReset(lines[j], nowMs);
      if (at) return at;
      break;                                      // a label: no reset this way
    }
  }
  return null;
}

// Summary items are the unified window shape every quota surface renders:
// { window: '5h'|'1wk'|'1m'|null, label, usedPercent, resetMs, line }.
// `percent` mirrors usedPercent so pre-upgrade caches keep working.
function summarizeUsageText(text, nowMs = Date.now()) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  // The window name is not always on the row. The page groups its weekly rows
  // under a "Weekly limits" heading and then labels each row by what it meters
  // ("All models", "Fable"), so those rows name a model, not a window. The last
  // heading that named a window is therefore carried down as the fallback — the
  // rows under "Weekly limits" are weekly ones whatever they call themselves.
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+(?:\.\d+)?)\s*%$/) || lines[i].match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) {
      section = windowTokenForLabel(lines[i]) || section;
      continue;
    }
    const label = labelForPercent(lines, i);
    const usedPercent = Number(m[1]);
    const resetMs = resetNearPercent(lines, i, nowMs);
    const window = windowTokenForLabel(label) || section;
    hits.push({ window, label, usedPercent, percent: usedPercent, resetMs, line: lines[i].slice(0, 80) });
    if (hits.length >= 4) break;
  }
  return hits.length ? hits : null;
}

async function readClaudeUsageFromPage(page) {
  await page.enable(['Runtime', 'Page']);
  await page.navigate(CLAUDE_USAGE_URL);

  // 1. Wait for the redirect chain to settle — either into the usage page
  //    (logged in) or onto the login screen. Half the deadline; the rest is for
  //    the SPA hydration wait below.
  let hitLogin = false;
  const settled = await page.waitFor(async () => {
    const href = await page.evaluate('location.href');
    if (typeof href !== 'string' || !href) return null;
    if (/\/login|sign-?in|auth\.claude\.ai/i.test(href)) { hitLogin = true; return href; }
    const ready = await page.evaluate('document.readyState');
    return ready === 'complete' ? href : null;
  }, { timeoutMs: Math.floor(CDP_TIMEOUT_MS / 2) });
  if (!settled) return { status: 'unavailable', error: 'usage page never settled' };
  if (hitLogin) return { status: 'needs_login', error: 'claude.ai 登录态缺失，点余量徽标可打开登录窗口' };

  // 2. Wait for the usage panel itself (percentages + window markers), not the
  //    shell. The SPA hydrates asynchronously, so it gets the larger budget.
  const text = await page.waitFor(async () => {
    const t = await page.evaluate('document.body ? document.body.innerText : ""');
    return typeof t === 'string' && usagePanelReady(t) ? t : null;
  }, { timeoutMs: panelTextTimeoutMs(), intervalMs: 800 }) || '';

  if (!String(text).trim()) return { status: 'unavailable', error: '用量面板未渲染（可能被 Cloudflare 拦截或页面改版）' };
  return {
    status: 'ok',
    fetchedAt: Date.now(),
    source: 'usage-page',
    url: settled,
    summary: summarizeUsageText(text),
    text: String(text).slice(0, 2000),
  };
}

async function fetchClaudeUsage() {
  const managed = getManagedQuotaBrowser();
  const sources = [
    {
      label: 'managed',
      run: async () => {
        const browser = await managed.attachManaged();
        try { return await managed.withPage(readClaudeUsageFromPage, { browser }); }
        finally { browser.close(); }
      },
    },
    {
      label: 'user-chrome',
      run: async () => {
        const browser = await chrome.attach();
        try { return await chrome.withPage(readClaudeUsageFromPage, { browser }); }
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

function mountClaudeUsageQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/claude/quota', async (req, res) => {
    try {
      const result = await fetchClaudeUsage();
      const status = (result && result.status) || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : (status === 'needs_login' ? 401
          : (status === 'chrome_unavailable' ? 503 : 500));
      res.status(httpStatus).json(result);
    } catch (err) {
      res.status(500).json({ status: 'unavailable', error: 'claude quota fetch failed' });
    }
  });

  // Visible login window on the managed profile — same pattern as qoder /
  // opencode / kimi. The user logs into claude.ai once; the session then
  // persists for headless usage-page scrapes.
  app.post('/api/claude/quota/login', async (req, res) => {
    try {
      await getManagedQuotaBrowser().openVisibleLogin(CLAUDE_USAGE_URL);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 claude.ai，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

module.exports = {
  mountClaudeUsageQuotaRoutes,
  fetchClaudeUsage,
  summarizeUsageText,
  usagePanelReady,
  windowTokenForLabel,
  parseClaudeReset,
  // exposed for tests
  readClaudeUsageFromPage,
};

'use strict';

// GET /api/codex/quota — fetch Codex (ChatGPT) subscription usage directly from
// the official backend using the on-disk OAuth token. No CDP needed: the codex
// CLI stores its rotated credential at ~/.codex/auth.json, and the same
// chatgpt.com/backend-api/wham/usage endpoint the CLI's /status uses returns the
// weekly quota window, plan tier, per-feature limits, and credit balance.
//
// Failure modes surfaced to the frontend:
//   no_auth           — ~/.codex/auth.json missing / unreadable (not logged in)
//   unavailable       — API error / unexpected shape

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 10000;
const WEEKLY_MIN_WINDOW_SECONDS = 24 * 60 * 60;

function readCodexAuth() {
  try {
    const file = path.join(os.homedir(), '.codex', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tokens = auth && auth.tokens;
    if (!tokens || !tokens.access_token) return null;
    return { accessToken: tokens.access_token, accountId: tokens.account_id || '' };
  } catch (_) {
    return null;
  }
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickWeeklyWindow(rl) {
  const windows = [rl.primary_window, rl.secondary_window].filter(
    (w) => w && typeof w === 'object'
      && finite(w.used_percent) !== null
      && finite(w.limit_window_seconds) !== null,
  );
  return windows
    .filter((w) => finite(w.limit_window_seconds) >= WEEKLY_MIN_WINDOW_SECONDS)
    .sort((a, b) => finite(b.limit_window_seconds) - finite(a.limit_window_seconds))[0] || null;
}

function windowResetsAt(w, nowMs) {
  let resetsAt = finite(w.reset_at);
  if (resetsAt === null) {
    const after = finite(w.reset_after_seconds);
    resetsAt = after !== null ? Math.trunc(nowMs / 1000) + after : null;
  }
  return resetsAt;
}

async function fetchCodexUsage(nowMs = Date.now()) {
  const auth = readCodexAuth();
  if (!auth) return { status: 'no_auth', error: '未找到 ~/.codex/auth.json，请先登录 codex' };

  let body;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        originator: 'codex_cli_rs',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { status: 'unavailable', error: `HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { status: 'unavailable', error: err.message || 'fetch failed' };
  }

  const rl = body && typeof body === 'object' ? body.rate_limit : null;
  if (!rl || typeof rl !== 'object') return { status: 'unavailable', error: 'rate_limit missing' };

  const weekly = pickWeeklyWindow(rl);
  if (!weekly) return { status: 'unavailable', error: 'no weekly window exposed' };

  const usedPercent = finite(weekly.used_percent);
  const resetsAt = windowResetsAt(weekly, nowMs);

  // Per-feature additional limits (e.g. GPT-5.3-Codex-Spark)
  const additional = Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits
        .filter((a) => a && a.limit_name && a.rate_limit && a.rate_limit.primary_window)
        .map((a) => ({
          name: a.limit_name,
          usedPercent: finite(a.rate_limit.primary_window.used_percent) ?? 0,
          resetsAt: windowResetsAt(a.rate_limit.primary_window, nowMs),
        }))
    : [];

  return {
    status: 'ok',
    fetchedAt: nowMs,
    planType: typeof body.plan_type === 'string' ? body.plan_type : null,
    email: typeof body.email === 'string' ? body.email : null,
    limitReached: rl.limit_reached === true,
    weekly: {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      windowSeconds: finite(weekly.limit_window_seconds),
      resetsAt,
    },
    additional,
    credits: body.credits && typeof body.credits === 'object'
      ? {
          hasCredits: body.credits.has_credits === true,
          balance: body.credits.balance ?? '0',
        }
      : null,
  };
}

function mountCodexQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/codex/quota', async (req, res) => {
    try {
      const result = await fetchCodexUsage();
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'no_auth' ? 401 : 500;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'codex quota fetch failed' });
    }
  });
}

module.exports = { mountCodexQuotaRoutes, fetchCodexUsage };

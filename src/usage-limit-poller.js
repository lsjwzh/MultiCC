'use strict';

// Usage-limit poller — the ACTIVE-POLL half of the limit subsystem.
//
// Some upstreams (Claude official, ChatGPT-backed Codex) report subscription
// limits in response HEADERS, which the proxy extracts passively for free. Others
// expose quota only through a SEPARATE authenticated request:
//   • GLM / 智谱 Coding Plan → GET open.bigmodel.cn/api/monitor/usage/quota/limit
//       returns rolling-window utilization % (5h + weekly) — a WINDOW limit,
//       semantically identical to Claude's 5h bar.
//   • DeepSeek             → GET api.deepseek.com/user/balance
//       returns a prepaid MONEY balance — NOT a window; a different widget.
//
// This module owns the poll: it dedups by (providerId, keyHash) so N sessions
// sharing one account issue one request, caches with a short TTL, normalizes to a
// unified DTO, and hands the result to a broadcaster. Every path is best-effort:
// a failed/timed-out/shape-drifted poll resolves to null and shows nothing —
// never fabricates, never throws into the chat flow.
//
// DTO kinds:
//   window  → { kind:'window', rateLimitType:'five_hour', status, utilization(0..1), resetsAt }
//             (shape the existing front-end 5h bar already consumes)
//   balance → { kind:'balance', available, currency, total, granted, toppedUp }

const crypto = require('crypto');

const POLL_TIMEOUT_MS = 6000;
// Window quota moves with usage → refresh often. Money balance moves slowly →
// poll lazily. Both are ceilings on staleness, not fixed timers: a poll only
// fires at a turn boundary when the cached snapshot for that account is older.
const TTL_BY_STRATEGY = Object.freeze({
  'glm-monitor': 60 * 1000,
  'deepseek-balance': 5 * 60 * 1000,
});

function keyHash(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Adapters: fetch + normalize. Each returns a DTO or null; never throws. ──

async function fetchJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// GLM Coding Plan. Auth is the RAW key with NO "Bearer" prefix. The endpoint is
// the console's internal monitor route (reverse-engineered, unofficial), so we
// tolerate missing/renamed fields and simply show nothing when the shape drifts.
async function pollGlmMonitor(target, nowMs, timeoutMs = POLL_TIMEOUT_MS) {
  const base = target.host === 'api.z.ai' ? 'https://api.z.ai' : `https://${target.host}`;
  const body = await fetchJson(
    `${base}/api/monitor/usage/quota/limit`,
    { Authorization: target.apiKey, 'Content-Type': 'application/json' },
    timeoutMs,
  );
  const limits = body && body.data && Array.isArray(body.data.limits) ? body.data.limits : null;
  if (!limits) return null;
  // Two TOKENS_LIMIT entries = the 5h window then the weekly window (percentage
  // used). Take the first as the primary 5h utilization; ignore TIME_LIMIT
  // (that's a call-count cap, e.g. MCP web search — not the token window).
  const tokenWindows = limits.filter((l) => l && l.type === 'TOKENS_LIMIT' && finite(l.percentage) !== null);
  if (!tokenWindows.length) return null;
  const pct = finite(tokenWindows[0].percentage);
  if (pct === null) return null;
  const resetsAt = finite(tokenWindows[0].nextResetTime);
  return {
    kind: 'window',
    provider: 'glm',
    rateLimitType: 'five_hour',
    status: pct >= 100 ? 'rejected' : (pct >= 80 ? 'allowed_warning' : 'allowed'),
    utilization: Math.max(0, Math.min(1, pct / 100)),
    resetsAt: resetsAt !== null ? resetsAt : null,
    tier: (body.data && body.data.level) || null,
  };
}

// DeepSeek prepaid balance. Auth is Bearer. Amounts are STRINGS.
async function pollDeepseekBalance(target, nowMs, timeoutMs = POLL_TIMEOUT_MS) {
  const body = await fetchJson(
    `https://${target.host}/user/balance`,
    { Authorization: `Bearer ${target.apiKey}` },
    timeoutMs,
  );
  if (!body || typeof body !== 'object' || !Array.isArray(body.balance_infos)) return null;
  const info = body.balance_infos[0] || null;
  if (!info) {
    return { kind: 'balance', available: body.is_available === true, currency: null, total: null, granted: null, toppedUp: null };
  }
  return {
    kind: 'balance',
    available: body.is_available === true,
    currency: info.currency || null,
    total: finite(info.total_balance),
    granted: finite(info.granted_balance),
    toppedUp: finite(info.topped_up_balance),
  };
}

const ADAPTERS = Object.freeze({
  'glm-monitor': pollGlmMonitor,
  'deepseek-balance': pollDeepseekBalance,
});

// ── Poller: dedup by account, TTL cache, best-effort broadcast. ──

function createUsageLimitPoller({ resolveTarget, broadcast, now = () => Date.now(), adapters = ADAPTERS } = {}) {
  if (typeof resolveTarget !== 'function') throw new Error('resolveTarget required');
  if (typeof broadcast !== 'function') throw new Error('broadcast required');
  // cacheKey = `${providerId}:${keyHash}` → { at, dto }
  const cache = new Map();
  // in-flight promise per cacheKey, so concurrent turns share one request
  const inflight = new Map();

  async function refresh(target, nowMs) {
    const cacheKey = `${target.providerId}:${keyHash(target.apiKey)}`;
    const ttl = TTL_BY_STRATEGY[target.strategy] || 60 * 1000;
    const cached = cache.get(cacheKey);
    if (cached && nowMs - cached.at < ttl) return cached.dto;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const adapter = adapters[target.strategy];
    if (!adapter) return null;
    const promise = (async () => {
      let dto = null;
      try { dto = await adapter(target, nowMs); } catch (_) { dto = null; }
      // Cache even a null result briefly, so a broken endpoint does not get
      // hammered every turn. A successful later poll overwrites it on TTL expiry.
      cache.set(cacheKey, { at: nowMs, dto });
      inflight.delete(cacheKey);
      return dto;
    })();
    inflight.set(cacheKey, promise);
    return promise;
  }

  // Call at each turn boundary for a session. Resolves the session's provider to
  // a limit target; if pollable and stale, refreshes and broadcasts the DTO.
  async function onTurnComplete(sessionId) {
    try {
      const target = resolveTarget(sessionId);
      if (!target || !target.strategy) return;
      const dto = await refresh(target, now());
      if (!dto) return;
      broadcast(sessionId, dto);
    } catch (_) {
      // best-effort: never disturb the chat flow
    }
  }

  return { onTurnComplete, _refresh: refresh, _cache: cache };
}

module.exports = {
  createUsageLimitPoller,
  pollGlmMonitor,
  pollDeepseekBalance,
  keyHash,
  TTL_BY_STRATEGY,
};

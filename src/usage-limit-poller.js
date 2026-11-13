'use strict';

const { outboundFetch } = require('./network/outbound');
const { getNative } = require('./native/runtime');
const { requestCodexUsage, readCodexAuth } = require('./quota/codex-usage-request');

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
const { publicTransportError } = require('./upstream-error');
const providers = require('./providers/core');
const { checkEgressIpAllowed } = require('./providers/egress-ip-policy');
const { codexRateLimitWindows, headlineWindow } = require('./codex/rate-limit-windows');

const POLL_TIMEOUT_MS = 6000;
// 借道余量透传：出借方收到查询后自己触发对厂商的真实余量查询（可能比本机
// 直查慢），给一个比 POLL_TIMEOUT_MS 更长的下限，等它把最新结果传回来。
const RELAY_TIMEOUT_MS = 20 * 1000;
function keyHash(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
}

function normalizeResponse(op, body) {
  const native = getNative();
  if (native.limitCacheRecorderRequestValue('cachePolicyVersion', {}) !== 1) {
    throw new Error('[usage-limit] Rust quota policy version mismatch; rebuild the native module');
  }
  return native.limitCacheRecorderRequestValue(op, { body });
}

// ── Adapters: fetch + normalize. Each returns a DTO on success, null when the
// endpoint answered but the shape drifted, and THROWS a limit_fetch_failed
// error (with .detail carrying the root cause) on transport/HTTP failure.
// Silently mapping every failure to null is what hid a wedged process-wide
// fetch behind a bare "fetch_failed" for days — see src/upstream-error.js
// publicTransportError for the cause-chain flattener reused here. ──

const LIMIT_FETCH_FAILED = 'limit_fetch_failed';

function limitFetchError(detail) {
  const error = new Error(`limit fetch failed: ${detail}`);
  error.kind = LIMIT_FETCH_FAILED;
  error.detail = String(detail);
  return error;
}

async function responseBodySnippet(res) {
  try { return String(await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim(); } catch (_) { return ''; }
}

async function readJson(request, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await request(controller.signal);
    if (!res || !res.ok) {
      const snippet = res ? await responseBodySnippet(res) : '';
      throw limitFetchError(
        snippet ? `HTTP ${res.status} ${snippet}` : (res ? `HTTP ${res.status}` : 'no response'),
      );
    }
    try {
      return await res.json();
    } catch (error) {
      const snippet = await responseBodySnippet(res).catch(() => '');
      throw limitFetchError(snippet ? `invalid JSON response: ${snippet}` : `invalid JSON response (${error.message})`);
    }
  } catch (error) {
    if (error && error.kind === LIMIT_FETCH_FAILED) throw error;
    // Transport failure: flatten the undici cause chain (fetch failed ←
    // ENOTFOUND/ECONNREFUSED/TLS...) instead of dropping it.
    const cause = publicTransportError(error).message;
    throw limitFetchError(timedOut ? `timeout after ${timeoutMs}ms: ${cause}` : cause);
  } finally {
    clearTimeout(timer);
  }
}

function fetchJson(url, headers, timeoutMs) {
  return readJson(signal => outboundFetch(url, { method: 'GET', headers, signal }), timeoutMs);
}

function postJson(url, headers, timeoutMs) {
  return readJson(signal => outboundFetch(url, { method: 'POST', headers, signal }), timeoutMs);
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
  return normalizeResponse('pollGlm', body);
}

// DeepSeek prepaid balance. Auth is Bearer. Amounts are STRINGS.
async function pollDeepseekBalance(target, nowMs, timeoutMs = POLL_TIMEOUT_MS) {
  const body = await fetchJson(
    `https://${target.host}/user/balance`,
    { Authorization: `Bearer ${target.apiKey}` },
    timeoutMs,
  );
  return normalizeResponse('pollDeepseek', body);
}

// Codex (real ChatGPT backend). Quota comes from the same usage read the codex
// CLI's /status uses: GET chatgpt.com/backend-api/wham/usage with the OAuth
// bearer + ChatGPT-Account-Id. This is a read (no messages consumed). Every
// window the plan has is surfaced — Plus meters a 5h window AND a weekly one,
// and the 5h one is usually what stops a session first; prolite has only the
// week. Windows are classified by length (src/codex/rate-limit-windows.js).
function codexUsageDto(body, nowMs) {
  const rl = body && typeof body === 'object' ? body.rate_limit : null;
  if (!rl || typeof rl !== 'object') return null;
  const windows = codexRateLimitWindows(rl, nowMs);
  const headline = headlineWindow(windows);
  if (!headline) return null; // no window exposed → show nothing
  // The account is blocked by whichever cycle runs out first, so the status
  // reads the tightest window, not just the headline one.
  const worst = Math.max(...windows.map((w) => w.usedPercent));
  const rejected = rl.limit_reached === true || worst >= 100;
  return {
    kind: 'window',
    provider: 'codex',
    // The headline window keeps the single-window DTO fields meaningful for
    // readers that predate `windows` (a 借道 borrower on an older build).
    rateLimitType: headline.window === '5h' ? 'five_hour' : 'weekly',
    status: rejected ? 'rejected' : (worst >= 80 ? 'allowed_warning' : 'allowed'),
    utilization: Math.max(0, Math.min(1, headline.usedPercent / 100)),
    // reset_at is epoch SECONDS (front-end multiplies ×1000, like Claude's resetsAt).
    resetsAt: headline.resetsAt,
    tier: typeof body.plan_type === 'string' ? body.plan_type : null,
    // Every cycle (usedPercent 0..100): the bar shows them all, and the quota
    // cache keeps them so Auto steers off an account before any one runs dry.
    windows: windows.map((w) => ({ window: w.window, label: w.label, usedPercent: w.usedPercent, resetMs: w.resetMs })),
  };
}

async function pollCodexUsage(target, nowMs, timeoutMs = POLL_TIMEOUT_MS, readAuth = null) {
  const reader = readAuth
    || (target && target.authFile ? () => readCodexAuth(target.authFile) : readCodexAuth);
  let auth = reader();
  if (!auth) return null;
  try {
    return codexUsageDto(await readJson(signal => requestCodexUsage(auth, { signal }), timeoutMs), nowMs);
  } catch (error) {
    // An expired token is repairable: offer the injected refresher one shot,
    // then retry the read once with whatever auth.json now holds. Any other
    // failure (and a declined refresh) propagates unchanged.
    if (!/HTTP 40[13]\b/.test(String(error && error.detail || ''))) throw error;
    if (!(await runCodexAuthRefresh({ authFile: (target && target.authFile) || null }))) throw error;
    auth = reader();
    if (!auth) return null;
    return codexUsageDto(await readJson(signal => requestCodexUsage(auth, { signal }), timeoutMs), nowMs);
  }
}

async function pollRelayQuota(target, nowMs, timeoutMs = POLL_TIMEOUT_MS) {
  const url = String((target && target.relayUrl) || '').trim();
  const apiKey = String((target && target.apiKey) || '').trim();
  if (!/^https?:\/\//i.test(url) || !apiKey) return null;
  const body = await postJson(
    `${url.replace(/\/+$/, '')}/quota`,
    { Authorization: `Bearer ${apiKey}` },
    Math.max(timeoutMs, RELAY_TIMEOUT_MS),
  );
  const result = normalizeResponse('pollRelay', body);
  if (result.error !== null) throw limitFetchError(result.error);
  return result.dto;
}

const ADAPTERS = Object.freeze({
  'glm-monitor': pollGlmMonitor,
  'deepseek-balance': pollDeepseekBalance,
  'codex-oauth-usage': pollCodexUsage,
  'relay-quota': pollRelayQuota,
});

// A 401 from the usage read means the on-disk OAuth token expired, and the
// poller cannot repair that itself — only the codex CLI rotating the refresh
// token can (src/codex/oauth-refresh.js, which the host already runs on a
// timer). The host injects that repair here; a 401 then costs one refresh
// attempt and one retry instead of every poll failing until something else
// happens to run the CLI. The hook receives { authFile } and resolves truthy
// when a retry is worth it (the token moved, or was already fresh).
let codexAuthRefresher = null;
function setCodexAuthRefresher(fn) {
  codexAuthRefresher = typeof fn === 'function' ? fn : null;
}
async function runCodexAuthRefresh(input) {
  if (typeof codexAuthRefresher !== 'function') return false;
  try { return !!(await codexAuthRefresher(input || {})); } catch (_) { return false; }
}

// ── Poller: dedup by account, TTL cache, best-effort broadcast. ──

function createUsageLimitPoller({ resolveTarget, broadcast, now = () => Date.now(), adapters = ADAPTERS } = {}) {
  if (typeof resolveTarget !== 'function') throw new Error('resolveTarget required');
  if (typeof broadcast !== 'function') throw new Error('broadcast required');
  // Rust owns the cached values, TTL and per-key admission. The host holds
  // only promises for injected Node transport callbacks awaiting completion.
  const state = new (getNative().RustUsageLimitPoller)();
  const inflight = new Map();
  const cache = Object.freeze({
    get: key => state.request('get', { key }),
    has: key => state.request('has', { key }),
    clear: () => state.request('clear', {}),
    get size() { return state.request('size', {}); },
  });

  async function refresh(target, nowMs) {
    // keyHashSeed lets a keyless account (codex OAuth, credential read from disk)
    // still dedup deterministically across sessions; otherwise hash the apiKey.
    const cacheKey = `${target.providerId}:${keyHash(target.keyHashSeed || target.apiKey)}`;
    let decision = state.request('begin', { key: cacheKey, strategy: target.strategy, now: nowMs });
    if (decision.action === 'cached') return decision.dto;
    if (decision.action === 'join') return inflight.get(cacheKey);
    const adapter = adapters[target.strategy];
    decision = state.request('begin', {
      key: cacheKey, strategy: target.strategy, now: nowMs, hasAdapter: !!adapter,
    });
    if (decision.action === 'none') return null;
    // Defer transport until its promise is installed. This also ensures an
    // immediate egress rejection cannot leave a completed in-flight entry.
    let finished = false;
    const promise = Promise.resolve().then(async () => {
      let dto = null;
      let failureDetail = null;
      // Same egress-IP-allowlist gate as the chat-turn admission path: a
      // restricted provider must not be polled for balance/quota either.
      const boundProvider = target.providerId ? providers.getProvider(target.appType, target.providerId) : null;
      const egressCheck = boundProvider ? checkEgressIpAllowed(boundProvider) : { allowed: true };
      if (!egressCheck.allowed) {
        failureDetail = egressCheck.detail;
        console.warn(`[usage-limit] ${target.strategy} poll skipped (${target.providerId}): ${failureDetail}`);
        state.request('finish', { key: cacheKey, at: nowMs, dto: null, error: failureDetail, includeError: true });
        finished = true;
        return null;
      }
      try {
        dto = await adapter(target, nowMs);
      } catch (error) {
        dto = null;
        failureDetail = error && error.kind === LIMIT_FETCH_FAILED
          ? error.detail
          : String((error && error.message) || error);
        // The root cause MUST reach the server console — a bare "fetch_failed"
        // once hid a wedged in-process fetch for days (api.deepseek.com failing
        // while fresh processes succeeded).
        console.warn(`[usage-limit] ${target.strategy} poll failed (${target.host || target.relayUrl || target.providerId}): ${failureDetail}`);
      }
      // Cache even a null result briefly, so a broken endpoint does not get
      // hammered every turn. A successful later poll overwrites it on TTL expiry.
      if (dto) dto = { ...dto, fetchedAt: now() };
      state.request('finish', { key: cacheKey, at: nowMs, dto, error: failureDetail });
      finished = true;
      return dto;
    }).finally(() => {
      if (!finished) state.request('abort', { key: cacheKey });
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
    });
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
  pollCodexUsage,
  pollRelayQuota,
  setCodexAuthRefresher,
  runCodexAuthRefresh,
  keyHash,
};

(function attachMultiCCChatRateLimit(global) {
  'use strict';

  function finiteNumber(value) {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isActive(value, nowMs) {
    if (!value || value.kind !== 'five_hour') return false;
    if (!['allowed', 'allowed_warning', 'rejected'].includes(value.status)) return false;
    const reset = finiteNumber(value.resetsAtMs);
    if (reset !== null && reset <= nowMs) return false;
    const used = finiteNumber(value.usedPercentage);
    return used === null || (used >= 0 && used <= 100);
  }

  function defaultResetLabel(resetsAtMs) {
    return new Date(resetsAtMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function normalizeResetTime(value) {
    const number = finiteNumber(value);
    if (number === null || number <= 0) return null;
    return Math.trunc(number < 10_000_000_000 ? number * 1000 : number);
  }

  function normalizeFiveHourRateLimit(info, nowMs) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
    // A window limit is either a rolling 5h window (Claude, GLM) or a weekly one
    // (Codex — its binding, and on some plans only, window). Same DTO shape; the
    // provider drives the label (5h vs 周) so no extra field is needed here.
    if (!['five_hour', 'weekly'].includes(info.rateLimitType)) return null;
    if (!['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return null;
    const utilization = finiteNumber(info.utilization);
    const usedPercentage = utilization === null
      ? null
      : Math.round(Math.max(0, Math.min(100, utilization * 100)) * 1000) / 1000;
    // Provider of this window limit. Claude 5h arrives from the proxy's
    // response-header extraction (no provider field → 'claude'); GLM Coding Plan
    // (5h) and Codex (weekly) arrive from the poller carrying provider:'glm' /
    // 'codex'. It drives both the bar label and the source↔cli gate below.
    const provider = info.provider === 'glm' ? 'glm' : info.provider === 'codex' ? 'codex' : 'claude';
    return Object.freeze({
      schemaVersion: 1,
      kind: 'five_hour',
      status: info.status,
      usedPercentage,
      resetsAtMs: normalizeResetTime(info.resetsAt),
      observedAtMs: Math.trunc(finiteNumber(nowMs) ?? Date.now()),
      source: 'claude_code',
      provider,
    });
  }

  function storageKey(sessionName) {
    const session = String(sessionName || '').trim();
    return session ? `multicc:claude-rate-limit:v1:${session}` : '';
  }

  function saveFiveHourRateLimit(storage, sessionName, value, nowMs = Date.now()) {
    const key = storageKey(sessionName);
    if (!storage || !key || !isActive(value, nowMs)) return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadFiveHourRateLimit(storage, sessionName, nowMs = Date.now()) {
    const key = storageKey(sessionName);
    if (!storage || !key) return null;
    try {
      const value = JSON.parse(storage.getItem(key) || 'null');
      if (isActive(value, nowMs)) return value;
      storage.removeItem(key);
    } catch (_) {
      try { storage.removeItem(key); } catch (_) {}
    }
    return null;
  }

  function formatFiveHourRateLimit(value, options = {}) {
    const nowMs = finiteNumber(options.nowMs) ?? Date.now();
    if (!isActive(value, nowMs)) return null;

    const used = finiteNumber(value.usedPercentage);
    const rejected = value.status === 'rejected';
    // Codex reports a WEEKLY window (no 5h); Claude/GLM report 5h.
    const label = value.provider === 'glm' ? 'GLM 5h'
      : value.provider === 'codex' ? 'Codex 周'
        : 'Claude 5h';
    let text = rejected ? `${label} 已达上限` : label;
    if (!rejected && used !== null) {
      const rounded = Math.round(used * 10) / 10;
      text += ` ${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
    }

    const reset = finiteNumber(value.resetsAtMs);
    if (reset !== null) {
      const formatReset = typeof options.formatReset === 'function'
        ? options.formatReset
        : defaultResetLabel;
      text += ` · ${formatReset(reset)} 重置`;
    }

    const color = rejected || (used !== null && used >= 90)
      ? '#f85149'
      : used !== null && used >= 70
        ? '#d29922'
        : '#58a6ff';
    return Object.freeze({
      text,
      color,
      title: value.provider === 'glm'
        ? 'GLM Coding Plan 五小时窗口用量（来自 open.bigmodel.cn 额度端点）'
        : value.provider === 'codex'
          ? 'Codex 订阅周额度用量（来自 chatgpt.com/backend-api/wham/usage）'
          : 'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）',
    });
  }

  let currentLimit = null;
  let currentSession = '';
  let currentCli = 'claude';
  let expiryTimer = null;

  function browserStorage() {
    if (!global.document) return null;
    try { return global.localStorage || null; } catch (_) { return null; }
  }

  // A window limit shows only under a CLI that could have produced it: Claude 5h
  // under claude/opencode, GLM 5h under codex/opencode (GLM routes through the
  // codex proxy). This preserves the original guard (a codex session never shows
  // stale Claude data) while letting GLM's own window bar render.
  function providerMatchesCli(provider, cli) {
    // GLM (5h) and Codex (weekly) both run under the codex CLI; Claude under claude.
    if (provider === 'glm' || provider === 'codex') return cli === 'codex' || cli === 'opencode';
    return cli === 'claude' || cli === 'opencode';
  }

  function renderCurrent() {
    const element = global.document?.getElementById?.('claude-rate-limit-bar');
    if (!element) return;
    const view = (currentLimit && providerMatchesCli(currentLimit.provider, currentCli))
      ? formatFiveHourRateLimit(currentLimit)
      : null;
    element.style.display = view ? 'block' : 'none';
    element.textContent = view?.text || '';
    element.title = view?.title || '';
    if (view) element.style.color = view.color;
    if (expiryTimer) global.clearTimeout?.(expiryTimer);
    expiryTimer = null;
    if (view && currentLimit.resetsAtMs) {
      const delay = Math.max(1, Math.min(2_147_000_000, currentLimit.resetsAtMs - Date.now() + 50));
      expiryTimer = global.setTimeout?.(() => {
        currentLimit = null;
        loadFiveHourRateLimit(browserStorage(), currentSession);
        renderCurrent();
      }, delay);
      if (expiryTimer && typeof expiryTimer.unref === 'function') expiryTimer.unref();
    }
  }

  function restoreFiveHourRateLimit(sessionName) {
    currentSession = String(sessionName || '').trim();
    currentLimit = loadFiveHourRateLimit(browserStorage(), currentSession);
    renderCurrent();
    return currentLimit;
  }

  function consumeRateLimitEvent(info, sessionName) {
    const limit = normalizeFiveHourRateLimit(info, Date.now());
    if (!limit) return null;
    currentSession = String(sessionName || currentSession || '').trim();
    currentLimit = limit;
    saveFiveHourRateLimit(browserStorage(), currentSession, limit);
    renderCurrent();
    return limit;
  }

  // ── Prepaid balance widget (DeepSeek). A DIFFERENT species from the window
  // bar: money remaining, not a rolling window %. Rendered in its own element so
  // the two are never conflated. No reset timer (balance has no window); the
  // value simply persists until the next poll overwrites it.
  function normalizeBalance(info) {
    if (!info || typeof info !== 'object' || info.kind !== 'balance') return null;
    const total = finiteNumber(info.total);
    // Show if we know it's unavailable (warn) OR we have a numeric total.
    if (total === null && info.available !== false) return null;
    return Object.freeze({
      kind: 'balance',
      provider: 'deepseek',
      available: info.available !== false,
      currency: typeof info.currency === 'string' ? info.currency : null,
      total,
    });
  }

  function balanceStorageKey(sessionName) {
    return `multicc.usageBalance.${String(sessionName || '').trim()}`;
  }

  function formatBalance(value) {
    if (!value) return null;
    const sym = value.currency === 'USD' ? '$' : value.currency === 'CNY' ? '¥' : '';
    let text = 'DeepSeek 余额';
    if (value.total !== null) {
      const amount = Math.round(value.total * 100) / 100;
      text += ` ${sym}${amount.toFixed(2)}`;
    }
    if (!value.available) text += ' · 余额不足';
    const color = !value.available || (value.total !== null && value.total <= 5)
      ? '#f85149'
      : (value.total !== null && value.total <= 20 ? '#d29922' : '#58a6ff');
    return Object.freeze({
      text,
      color,
      title: 'DeepSeek 预付费账户余额（来自 api.deepseek.com/user/balance，非窗口配额）',
    });
  }

  let currentBalance = null;

  function balanceMatchesCli(cli) {
    // DeepSeek is reached through the codex proxy.
    return cli === 'codex' || cli === 'opencode';
  }

  function renderBalance() {
    const element = global.document?.getElementById?.('usage-balance-bar');
    if (!element) return;
    const view = (currentBalance && balanceMatchesCli(currentCli)) ? formatBalance(currentBalance) : null;
    element.style.display = view ? 'block' : 'none';
    element.textContent = view?.text || '';
    element.title = view?.title || '';
    if (view) element.style.color = view.color;
  }

  function restoreBalance(sessionName) {
    currentSession = String(sessionName || currentSession || '').trim();
    const storage = browserStorage();
    if (storage) {
      try {
        const raw = storage.getItem(balanceStorageKey(currentSession));
        currentBalance = raw ? normalizeBalance(JSON.parse(raw)) : null;
      } catch (_) { currentBalance = null; }
    }
    renderBalance();
    return currentBalance;
  }

  function consumeBalanceEvent(info, sessionName) {
    const balance = normalizeBalance(info);
    if (!balance) return null;
    currentSession = String(sessionName || currentSession || '').trim();
    currentBalance = balance;
    const storage = browserStorage();
    if (storage) {
      try { storage.setItem(balanceStorageKey(currentSession), JSON.stringify(balance)); } catch (_) {}
    }
    renderBalance();
    return balance;
  }

  function setCli(cli) {
    currentCli = String(cli || 'claude');
    renderCurrent();
    renderBalance();
    renderOpenCodeQuota();
  }

  // ── OpenCode Go subscription usage (5h rolling / weekly / monthly). Sourced
  // by driving the user's local Chrome via CDP to opencode.ai/auth → /workspace/
  // <wsid>/go and regexing the SSR SolidStart hydration data. No REST API.
  // Rendered as a separate bar (id="opencode-quota-bar") so its 3 limit windows
  // and `needs_login` call to action don't fight the Claude 5h field.
  let currentQuota = null; // { status, usage, fetchedAt, ... } or { status:'needs_login'|... }
  let quotaFetchInFlight = false;
  const QUOTA_BACKOFF_MS = 60_000;
  let quotaLastErrorAt = 0;

  function quotaStorageKey() { return 'multicc.opencode.quota.v1'; }

  function loadQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(quotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      // Stale after 1 day (the Zen console only refreshes per request, and we
      // bump on every turn end so 24h is just a backstop).
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveQuotaToStorage(value) {
    const storage = browserStorage(); if (!storage || !value) return;
    try { storage.setItem(quotaStorageKey(), JSON.stringify(value)); } catch (_) {}
  }

  function formatResetRemaining(resetInSec) {
    if (!Number.isFinite(resetInSec) || resetInSec < 0) return '';
    if (resetInSec < 60) return `${Math.round(resetInSec)}s`;
    const mins = Math.round(resetInSec / 60);
    if (mins < 60) return `${mins} 分钟`;
    const hours = Math.floor(mins / 60); const rem = mins % 60;
    if (hours < 24) return rem ? `${hours} 小时 ${rem} 分钟` : `${hours} 小时`;
    const days = Math.floor(hours / 24); const remH = hours % 24;
    return remH ? `${days} 天 ${remH} 小时` : `${days} 天`;
  }

  function formatQuota(value) {
    if (!value) return null;
    if (value.status === 'needs_login') {
      return Object.freeze({
        text: 'OpenCode Go：需登录 →',
        color: '#f85149',
        title: '主 Chrome 9222 没登 opencode.ai/auth。点击开新标签去登录后回来这里点击重试。',
      });
    }
    if (value.status === 'chrome_unavailable') {
      return Object.freeze({
        text: 'OpenCode Go：未开 Chrome 9222',
        color: '#d29922',
        title: '请在本机开主 Chrome（--remote-debugging-port=9222）并登 opencode.ai/auth',
      });
    }
    if (value.status !== 'ok' || !value.usage) {
      return Object.freeze({
        text: 'OpenCode Go：用量暂不可用',
        color: '#d29922',
        title: value.error || '无法从 opencode.ai 拉取 Go 用量',
      });
    }
    const u = value.usage;
    const fmt = (n) => {
      const r = Math.round(n);
      return Number.isInteger(r) ? String(r) : (Math.round(n * 10) / 10).toString();
    };
    let text = 'OpenCode Go';
    if (u.rolling && Number.isFinite(u.rolling.usagePercent))  text += ` · 5h ${fmt(u.rolling.usagePercent)}%`;
    if (u.weekly  && Number.isFinite(u.weekly.usagePercent))   text += ` · 周 ${fmt(u.weekly.usagePercent)}%`;
    if (u.monthly && Number.isFinite(u.monthly.usagePercent))  text += ` · 月 ${fmt(u.monthly.usagePercent)}%`;
    const maxPct = Math.max(
      u.rolling?.usagePercent ?? 0,
      u.weekly?.usagePercent ?? 0,
      u.monthly?.usagePercent ?? 0,
    );
    let color = '#58a6ff';
    if (maxPct >= 90) color = '#f85149';
    else if (maxPct >= 70) color = '#d29922';
    let titleParts = ['OpenCode Go 订阅用量（CDP 抓 opencode.ai Zen console）'];
    if (u.rolling)  titleParts.push(`5h: ${fmt(u.rolling.usagePercent)}% · 重置 ${formatResetRemaining(u.rolling.resetInSec)}`);
    if (u.weekly)   titleParts.push(`周: ${fmt(u.weekly.usagePercent)}% · 重置 ${formatResetRemaining(u.weekly.resetInSec)}`);
    if (u.monthly)  titleParts.push(`月: ${fmt(u.monthly.usagePercent)}% · 重置 ${formatResetRemaining(u.monthly.resetInSec)}`);
    if (u.useBalance) titleParts.push('已启用：超额用余额兜底');
    return Object.freeze({ text, color, title: titleParts.join('\n') });
  }

  // Relative "N 分钟前" renderer for the fetchedAt timestamp.
  function relativeAgo(tsMs) {
    if (!tsMs || !Number.isFinite(tsMs)) return '';
    const sec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (sec < 5) return '刚刚';
    if (sec < 60) return `${sec}s 前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  }

  // Empty-state bar built into the same div: when no data yet, show a manual
  // refresh prompt so the user has a click target (it's NOT auto-refreshed on
  // turn end by default — see RESTART-POLICY memory: user must opt-in to extras
  // like this). Returns the same shape as formatQuota so the renderer below
  // doesn't need a separate code path.
  function formatQuotaIdle() {
    return Object.freeze({
      text: 'OpenCode Go 余量 · ⟳ 刷新',
      color: '#8b949e',
      title: '点击从 opencode.ai Zen console 拉取 Go 订阅 5h / 周 / 月 用量',
    });
  }

  function formatQuota(value) {
    if (!value) return formatQuotaIdle();
    if (value.status === 'needs_login') {
      return Object.freeze({
        text: 'OpenCode Go：需登录 · ⟳ 重试',
        color: '#f85149',
        title: '主 Chrome 9222 没登 opencode.ai/auth。点击 bar 重新拉取；登录后请先在主 Chrome 打开 https://opencode.ai/auth 走完 OAuth。',
      });
    }
    if (value.status === 'chrome_unavailable') {
      return Object.freeze({
        text: 'OpenCode Go：未开 Chrome 9222 · ⟳ 重试',
        color: '#d29922',
        title: '请在本机开主 Chrome（--remote-debugging-port=9222）并登 opencode.ai/auth',
      });
    }
    if (value.status !== 'ok' || !value.usage) {
      return Object.freeze({
        text: 'OpenCode Go：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: value.error || '无法从 opencode.ai 拉取 Go 用量',
      });
    }
    const u = value.usage;
    const fmt = (n) => {
      const r = Math.round(n);
      return Number.isInteger(r) ? String(r) : (Math.round(n * 10) / 10).toString();
    };
    let text = 'OpenCode Go';
    if (u.rolling && Number.isFinite(u.rolling.usagePercent))  text += ` · 5h ${fmt(u.rolling.usagePercent)}%`;
    if (u.weekly  && Number.isFinite(u.weekly.usagePercent))   text += ` · 周 ${fmt(u.weekly.usagePercent)}%`;
    if (u.monthly && Number.isFinite(u.monthly.usagePercent))  text += ` · 月 ${fmt(u.monthly.usagePercent)}%`;
    // Sync time: appended as "· N分钟前 ⟳" so users see how stale the data is
    // and have a visible refresh affordance.
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';
    const maxPct = Math.max(
      u.rolling?.usagePercent ?? 0,
      u.weekly?.usagePercent ?? 0,
      u.monthly?.usagePercent ?? 0,
    );
    let color = '#58a6ff';
    if (maxPct >= 90) color = '#f85149';
    else if (maxPct >= 70) color = '#d29922';
    let titleParts = ['OpenCode Go 订阅用量（CDP 抓 opencode.ai Zen console）'];
    if (u.rolling)  titleParts.push(`5h: ${fmt(u.rolling.usagePercent)}% · 重置 ${formatResetRemaining(u.rolling.resetInSec)}`);
    if (u.weekly)   titleParts.push(`周: ${fmt(u.weekly.usagePercent)}% · 重置 ${formatResetRemaining(u.weekly.resetInSec)}`);
    if (u.monthly)  titleParts.push(`月: ${fmt(u.monthly.usagePercent)}% · 重置 ${formatResetRemaining(u.monthly.resetInSec)}`);
    if (syncRel) titleParts.push(`同步于 ${syncRel}`);
    titleParts.push('点击 bar 刷新');
    if (u.useBalance) titleParts.push('已启用：超额用余额兜底');
    return Object.freeze({ text, color, title: titleParts.join('\n') });
  }

  function renderOpenCodeQuota() {
    const element = global.document?.getElementById?.('opencode-quota-bar');
    if (!element) return;
    // Show the bar whenever the chat CLI is set to opencode — even before the
    // first fetch resolves — so the user has a visible click target for manual
    // refresh. The bar is not auto-refreshed on turn end (this commit removed
    // that hook); the user clicks the bar to re-fetch.
    if (currentCli !== 'opencode') {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatQuota(currentQuota);
    if (quotaFetchInFlight) {
      element.textContent = 'OpenCode Go：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在通过 CDP 抓取 opencode.ai/console ...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => { refreshOpenCodeQuota(true); };
  }

  async function fetchOpenCodeQuota() {
    const res = await fetch('/api/opencode/quota', { credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return data || { status: 'unavailable', error: 'invalid response' };
  }

  // Refresh OpenCode Go quota from the server. Debounced: skip if a fetch is in
  // flight or we errored within the last QUOTA_BACKOFF_MS.
  async function refreshOpenCodeQuota(force) {
    if (currentCli !== 'opencode' && !force) return null;
    if (quotaFetchInFlight) return currentQuota;
    if (!force && quotaLastErrorAt && (Date.now() - quotaLastErrorAt) < QUOTA_BACKOFF_MS) {
      return currentQuota;
    }
    quotaFetchInFlight = true;
    try {
      const data = await fetchOpenCodeQuota();
      if (data.status === 'ok') {
        currentQuota = data;
        saveQuotaToStorage(data);
        quotaLastErrorAt = 0;
      } else {
        currentQuota = data;
        quotaLastErrorAt = Date.now();
      }
      renderOpenCodeQuota();
      return currentQuota;
    } catch (err) {
      quotaLastErrorAt = Date.now();
      currentQuota = { status: 'unavailable', error: 'fetch failed' };
      renderOpenCodeQuota();
      return currentQuota;
    } finally {
      quotaFetchInFlight = false;
    }
  }

  function restoreOpenCodeQuota() {
    currentQuota = loadQuotaFromStorage();
    renderOpenCodeQuota();
    return currentQuota;
  }

  const api = Object.freeze({
    normalizeFiveHourRateLimit,
    formatFiveHourRateLimit,
    saveFiveHourRateLimit,
    loadFiveHourRateLimit,
    restoreFiveHourRateLimit,
    consumeRateLimitEvent,
    normalizeBalance,
    formatBalance,
    restoreBalance,
    consumeBalanceEvent,
    refreshOpenCodeQuota,
    restoreOpenCodeQuota,
    setCli,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRateLimit = api;
  if (global.document && global.location) {
    const sess = new URLSearchParams(global.location.search).get('session') || '';
    restoreFiveHourRateLimit(sess);
    restoreBalance(sess);
    restoreOpenCodeQuota();
  }
})(typeof window !== 'undefined' ? window : globalThis);

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
    if (info.rateLimitType !== 'five_hour') return null;
    if (!['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return null;
    const utilization = finiteNumber(info.utilization);
    const usedPercentage = utilization === null
      ? null
      : Math.round(Math.max(0, Math.min(100, utilization * 100)) * 1000) / 1000;
    // Provider of this window limit. Claude 5h arrives from the proxy's
    // response-header extraction (no provider field → 'claude'); GLM Coding Plan
    // arrives from the poller carrying provider:'glm'. It drives both the bar
    // label and the source↔cli gate below.
    const provider = info.provider === 'glm' ? 'glm' : 'claude';
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
    const label = value.provider === 'glm' ? 'GLM 5h' : 'Claude 5h';
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
    if (provider === 'glm') return cli === 'codex' || cli === 'opencode';
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
    setCli,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRateLimit = api;
  if (global.document && global.location) {
    const sess = new URLSearchParams(global.location.search).get('session') || '';
    restoreFiveHourRateLimit(sess);
    restoreBalance(sess);
  }
})(typeof window !== 'undefined' ? window : globalThis);

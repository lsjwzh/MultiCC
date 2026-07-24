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
    return Object.freeze({
      schemaVersion: 1,
      kind: 'five_hour',
      status: info.status,
      usedPercentage,
      resetsAtMs: normalizeResetTime(info.resetsAt),
      observedAtMs: Math.trunc(finiteNumber(nowMs) ?? Date.now()),
      source: 'claude_code',
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
    let text = rejected ? 'Claude 5h 已达上限' : 'Claude 5h';
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
      title: 'Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）',
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

  function renderCurrent() {
    const element = global.document?.getElementById?.('claude-rate-limit-bar');
    if (!element) return;
    const view = currentCli === 'claude' ? formatFiveHourRateLimit(currentLimit) : null;
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

  function setCli(cli) {
    currentCli = String(cli || 'claude');
    renderCurrent();
  }

  const api = Object.freeze({
    normalizeFiveHourRateLimit,
    formatFiveHourRateLimit,
    saveFiveHourRateLimit,
    loadFiveHourRateLimit,
    restoreFiveHourRateLimit,
    consumeRateLimitEvent,
    setCli,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRateLimit = api;
  if (global.document && global.location) {
    restoreFiveHourRateLimit(new URLSearchParams(global.location.search).get('session') || '');
  }
})(typeof window !== 'undefined' ? window : globalThis);

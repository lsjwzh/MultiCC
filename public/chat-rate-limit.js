(function attachMultiCCChatRateLimit(global) {
  'use strict';

  function finiteNumber(value) {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // ── Unified compact quota display ─────────────────────────────────────────
  // Every provider renders its quota windows as `<window> <remaining%> <countdown>`
  // segments joined by ' · ', e.g. `5h 20% 1.2h · 1wk 50% 3d 5h · 1m 60% 14d`.
  // Window labels are short tokens (5h / 1wk / 1m); the percent is REMAINING
  // (100 − used), not used; the countdown is a humanized time-to-reset. Money
  // providers (DeepSeek / Kimi) render `¥<amount>` instead. Missing fields
  // degrade gracefully: a window with no percent is dropped, one with no reset
  // shows just `<window> <pct>%`.

  function unifiedRemaining(usedPercent) {
    const used = finiteNumber(usedPercent);
    if (used === null) return null;
    return Math.max(0, Math.min(100, Math.round(100 - used)));
  }

  function humanizeCountdown(ms) {
    const total = finiteNumber(ms);
    if (total === null || total < 0) return '';
    const totalH = total / 3_600_000;
    if (totalH < 1) return `${Math.max(1, Math.round(total / 60_000))}m`;
    if (totalH < 24) {
      const h = Math.round(totalH * 10) / 10;
      return `${Number.isInteger(h) ? h.toFixed(0) : h.toFixed(1)}h`;
    }
    const d = Math.floor(totalH / 24);
    const remH = Math.floor(totalH % 24);
    return remH ? `${d}d ${remH}h` : `${d}d`;
  }

  // One window → `<label> <remaining>% [<countdown>]`; '' when percent is missing.
  function unifiedWindowSeg(label, usedPercent, resetMs) {
    const rem = unifiedRemaining(usedPercent);
    if (rem === null) return '';
    const cd = humanizeCountdown(resetMs);
    return cd ? `${label} ${rem}% ${cd}` : `${label} ${rem}%`;
  }

  // Canonical window-bar display order. Every bar that merges several windows
  // (opencode 5h/1wk/1m, ark periods, zhipu 5h+1wk, kimi summary, claude 5h+
  // weekly) renders short → long: 5h → 1wk → 1m. The leading token of each
  // segment is its window label; rank by that. Unknown labels sort LAST but keep
  // their relative order (Array#sort is stable), so a provider's idiosyncratic
  // label never jumps ahead of the windows we standardize on.
  const WINDOW_SEG_ORDER = Object.freeze({ '5h': 0, '1wk': 1, '1m': 2 });
  function windowSegRank(seg) {
    const m = String(seg || '').match(/^(\S+)/);
    const label = m ? m[1] : '';
    return WINDOW_SEG_ORDER[label] === undefined ? 3 : WINDOW_SEG_ORDER[label];
  }
  function sortWindowSegs(segs) {
    return (Array.isArray(segs) ? segs : []).slice().sort((a, b) => windowSegRank(a) - windowSegRank(b));
  }

  function unifiedColorFromRemaining(rem) {
    if (rem === null) return '#58a6ff';
    if (rem <= 10) return '#f85149';
    if (rem <= 30) return '#d29922';
    return '#58a6ff';
  }

  function unifiedBalanceText(amount, currency) {
    const a = finiteNumber(amount);
    if (a === null) return '';
    const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
    return `${sym}${a.toFixed(2)}`;
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
    // Claude's window data arrives through TWO sources: the 5h rolling window
    // as a passive rate_limit_event, and the weekly/monthly limits via the
    // claude.ai/settings/usage scrape (src/routes/claude-usage-quota.js). A
    // WEEKLY-typed rate_limit_event that resolves to the claude provider is
    // still malformed — the poller always tags weekly with provider:'codex',
    // and Claude's weekly comes exclusively from the usage-page scrape, never
    // from this event shape — so reject it rather than mislabel it.
    if (info.rateLimitType === 'weekly' && provider === 'claude') return null;
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
    const windowLabel = value.provider === 'codex' ? '1wk' : '5h';
    const reset = finiteNumber(value.resetsAtMs);
    const resetMs = reset === null ? null : Math.max(0, reset - nowMs);
    // Rejected = window exhausted → force 0% remaining.
    const effectiveUsed = rejected ? 100 : used;
    const segs = [];
    const first = unifiedWindowSeg(windowLabel, effectiveUsed, resetMs);
    if (first) segs.push(first);
    // Claude subscription: the weekly (and monthly, when the page shows one)
    // limits come from the /api/claude/quota usage-page scrape. The page's own
    // 5h row duplicates the passive event above, so only the longer windows
    // are appended; the merge point normalizes order via sortWindowSegs.
    const usage = options && options.usage;
    if (value.provider === 'claude' && usage && usage.status === 'ok' && Array.isArray(usage.summary)) {
      for (const s of usage.summary) {
        if (!s || !Number.isFinite(s.usedPercent)) continue;
        if (s.window === '5h' || (s.window !== '1wk' && s.window !== '1m')) continue;
        const cd = s.resetMs ? Math.max(0, s.resetMs - nowMs) : null;
        const seg = unifiedWindowSeg(s.window, s.usedPercent, cd);
        if (seg) segs.push(seg);
      }
    }
    let text = sortWindowSegs(segs).join(' · ') || first || windowLabel;
    const color = unifiedColorFromRemaining(unifiedRemaining(effectiveUsed));
    const titleLines = [];
    if (value.provider === 'glm') {
      titleLines.push('GLM Coding Plan 五小时窗口用量（来自 open.bigmodel.cn 额度端点）');
    } else if (value.provider === 'codex') {
      titleLines.push('Codex 订阅周额度用量（来自 chatgpt.com/backend-api/wham/usage）');
    } else {
      titleLines.push('Claude 订阅五小时用量（来自 Claude Code 结构化 rate_limit_event）');
      if (usage && usage.status === 'ok' && Array.isArray(usage.summary)) {
        const zh = { '1wk': '周', '1m': '月' };
        for (const s of usage.summary) {
          if (!s || !Number.isFinite(s.usedPercent) || !s.window || s.window === '5h') continue;
          const cd = s.resetMs ? Math.max(0, s.resetMs - nowMs) : null;
          const pct = Math.round(s.usedPercent);
          titleLines.push(`${zh[s.window] || s.window}: 已用 ${pct}%${cd ? ' · ' + humanizeCountdown(cd) + ' 后重置' : ''}`);
        }
        if (usage.fetchedAt) titleLines.push(`同步于 ${relativeAgo(usage.fetchedAt)}（claude.ai/settings/usage 抓取）`);
      }
    }
    return Object.freeze({
      text,
      color,
      title: titleLines.join('\n'),
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
    if (provider === 'glm' || provider === 'codex') {
      if (cli === 'codex' || cli === 'opencode') return true;
      // GLM is ALSO a first-class claude-appType provider: open.bigmodel.cn /
      // z.ai speak the Anthropic protocol, so those sessions run under the
      // claude CLI — and the usage poller still tags their window 'glm'
      // (providers.js getProviderLimitTarget → strategy 'glm-monitor'). Gating
      // on the CLI alone silently dropped that event, leaving such a session
      // with no 5h bar at all. Under the codex CLI the same provider is reached
      // through our local proxy, so the baseUrl is 127.0.0.1 — hence an extra
      // allowance, never a tightening.
      return provider === 'glm' && isZhipuBaseUrl(currentProviderBaseUrl);
    }
    return cli === 'claude' || cli === 'opencode';
  }

  // Whether the session's active provider is Claude's own subscription. Empty
  // baseUrl = no provider override = the CLI's default login (Claude OAuth).
  // A session pointed at another provider (zhipu / volcano / kimi / a relay)
  // must not show Claude quota items — there is no Claude window there, and an
  // idle "Claude 5h · —" placeholder would be noise next to the real bar.
  function isClaudeProvider(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) return true;
    try {
      return /(^|\.)(anthropic|claude)\.(com|ai)$/i.test(new URL(baseUrl).hostname);
    } catch (_) {
      return false;
    }
  }

  // Idle placeholder for the always-visible Claude bar (mirrors the opencode
  // formatQuotaIdle fixed-display pattern). Claude window data arrives via the
  // passive WS rate_limit_event AND the /api/claude/quota usage scrape; until
  // either lands the bar is a clickable "—" (click = fetch the scrape).
  function formatClaudeIdle() {
    return Object.freeze({
      text: '5h · — · ⟳ 刷新',
      color: '#8b949e',
      title: 'Claude 订阅窗口用量。点击从 claude.ai/settings/usage 抓取 5h / 周 / 月 余量；5h 也会由 Claude Code 上报的 rate_limit_event 实时更新。',
    });
  }

  // Usage-page-only rendering for the Claude bar: no passive rate_limit_event
  // has landed yet, but the /api/claude/quota scrape may already carry real
  // windows — show them. With no scrape data at all, fall back to the idle
  // placeholder so the bar stays a visible click target.
  function formatClaudeUsageOnly(usage) {
    if (!usage) return formatClaudeIdle();
    if (usage.status === 'needs_login') {
      return Object.freeze({
        text: 'Claude：需登录 · 点击打开登录窗口',
        color: '#f85149',
        title: '你的浏览器里没有 claude.ai 的登录态。点击将由 multicc 拉起一个 Chrome 登录窗口（claude.ai/settings/usage），登录后回来再点一次刷新。',
        action: 'login',
      });
    }
    if (usage.status === 'chrome_unavailable') {
      return Object.freeze({
        text: 'Claude：无可连的 Chrome · 点击尝试打开登录窗口',
        color: '#d29922',
        title: '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；也可以自己开一个带调试端点的 Chrome 并在其中登录 claude.ai。',
        action: 'login',
      });
    }
    if (usage.status !== 'ok' || !Array.isArray(usage.summary)) {
      return Object.freeze({
        text: 'Claude：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: (usage && usage.error) || '无法从 claude.ai/settings/usage 拉取窗口用量',
      });
    }
    const summary = usage.summary.filter((s) => s && Number.isFinite(s.usedPercent));
    if (!summary.length) {
      return Object.freeze({
        text: 'Claude：已登录，未解析出用量 · ⟳ 重试',
        color: '#d29922',
        title: `已抓到 claude.ai 用量页，但没解析出百分比。\n原文：${String(usage.text || '').slice(0, 300)}`,
      });
    }
    const segs = [];
    let maxUsed = 0;
    for (const s of summary) {
      if (s.usedPercent > maxUsed) maxUsed = s.usedPercent;
      const label = s.window || s.label || '5h';
      const cd = s.resetMs ? Math.max(0, s.resetMs - Date.now()) : null;
      const seg = unifiedWindowSeg(label, s.usedPercent, cd);
      if (seg) segs.push(seg);
    }
    let text = sortWindowSegs(segs).join(' · ') || '—';
    const syncRel = relativeAgo(usage.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';
    let title = 'Claude 订阅窗口用量（claude.ai/settings/usage 抓取）';
    for (const s of summary) title += `\n${s.window || s.label}: 已用 ${Math.round(s.usedPercent)}%`;
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({
      text,
      color: unifiedColorFromRemaining(unifiedRemaining(maxUsed)),
      title,
    });
  }

  function renderCurrent() {
    const element = global.document?.getElementById?.('claude-rate-limit-bar');
    if (!element) return;
    const claudeProvider = isClaudeProvider(currentProviderBaseUrl);
    const matches = currentLimit && providerMatchesCli(currentLimit.provider, currentCli)
      && (currentLimit.provider !== 'claude' || claudeProvider);
    let view = matches ? formatFiveHourRateLimit(currentLimit, { usage: currentClaudeUsage }) : null;
    let viewForClick = view;
    if (view) {
      element.style.display = 'block';
      element.textContent = view.text;
      element.title = view.title;
      element.style.color = view.color;
    } else if (currentCli === 'claude' && claudeProvider) {
      // Always visible under the claude CLI on the Claude subscription: show
      // the CDP usage scrape when it came back with windows (even before any
      // passive event), else the idle placeholder — the bar stays a constant
      // fixture. Under another provider the item is hidden entirely.
      const usageView = claudeUsageFetchInFlight && !currentClaudeUsage
        ? { text: 'Claude：抓取用量中…', color: '#8b949e', title: '正在通过 CDP 打开 claude.ai/settings/usage 解析窗口余量…' }
        : formatClaudeUsageOnly(currentClaudeUsage);
      viewForClick = usageView;
      element.style.display = 'block';
      element.textContent = usageView.text;
      element.title = usageView.title;
      element.style.color = usageView.color;
    } else {
      element.style.display = 'none';
      element.textContent = '';
      element.title = '';
    }
    // Click = fetch the usage scrape (or open the login window when the scrape
    // needs one). The bar was previously passive; the click target is what lets
    // the weekly/monthly windows get pulled on demand.
    element.onclick = () => quotaBarClick('claude', viewForClick, () => refreshClaudeUsage(true));
    if (expiryTimer) global.clearTimeout?.(expiryTimer);
    expiryTimer = null;
    if (view && currentLimit && currentLimit.resetsAtMs) {
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

  // ── Claude subscription usage scrape (weekly / monthly windows). Sourced by
  // driving a browser via CDP to claude.ai/settings/usage and parsing the
  // hydrated page text (src/routes/claude-usage-quota.js). The 5h window lives
  // in the passive rate_limit_event above; this source only adds the longer
  // windows that event never carries. Fetch-on-demand like the other CDP bars.
  let currentClaudeUsage = null;
  let claudeUsageFetchInFlight = false;
  const CLAUDE_USAGE_BACKOFF_MS = 60_000;
  let claudeUsageLastErrorAt = 0;

  function claudeUsageStorageKey() { return 'multicc.claude.usage.v1'; }

  function loadClaudeUsageFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(claudeUsageStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveClaudeUsageToStorage(data) {
    const storage = browserStorage(); if (!storage || !data) return;
    try { storage.setItem(claudeUsageStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  async function refreshClaudeUsage(force) {
    if (claudeUsageFetchInFlight) return currentClaudeUsage;
    if (!force && claudeUsageLastErrorAt && (Date.now() - claudeUsageLastErrorAt) < CLAUDE_USAGE_BACKOFF_MS) {
      return currentClaudeUsage;
    }
    claudeUsageFetchInFlight = true;
    renderCurrent();
    try {
      const res = await fetch('/api/claude/quota', { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentClaudeUsage = data;
        saveClaudeUsageToStorage(data);
        claudeUsageLastErrorAt = 0;
      } else {
        currentClaudeUsage = data;
        claudeUsageLastErrorAt = Date.now();
      }
    } catch (_) {
      claudeUsageLastErrorAt = Date.now();
      currentClaudeUsage = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      claudeUsageFetchInFlight = false;
    }
    renderCurrent();
    return currentClaudeUsage;
  }

  function restoreClaudeUsage() {
    currentClaudeUsage = loadClaudeUsageFromStorage();
    renderCurrent();
    return currentClaudeUsage;
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
    let text = unifiedBalanceText(value.total, value.currency) || '—';
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

  // Same asymmetry as providerMatchesCli: DeepSeek is normally reached through
  // the codex proxy, but api.deepseek.com/anthropic is a claude-appType provider
  // too, and the poller reports a balance for those sessions as well.
  function isDeepseekBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return false;
    try {
      return /(^|\.)deepseek\.com$/i.test(new URL(baseUrl).hostname);
    } catch (_) {
      return /deepseek\.com/i.test(baseUrl);
    }
  }

  function balanceMatchesCli(cli) {
    return cli === 'codex' || cli === 'opencode' || isDeepseekBaseUrl(currentProviderBaseUrl);
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

  let cliInitialized = false;

  function setCli(cli) {
    const next = String(cli || 'claude');
    // The first call is the page reporting which CLI it loaded, not a switch —
    // page load must stay as cheap as it is today (restore from localStorage).
    const changed = cliInitialized && next !== currentCli;
    cliInitialized = true;
    currentCli = next;
    renderCurrent();
    renderBalance();
    renderOpenCodeQuota();
    renderQoderQuota();
    renderCodexQuota();
    // Switching CLI switches the account whose quota is on screen. These bars are
    // fetch-on-demand — nothing polls them — so without this the new CLI's bar
    // keeps showing whatever was last restored until the user clicks it. Exactly
    // one fetch per real switch, for the one bar that just became visible.
    if (!changed) return;
    if (next === 'opencode') { quotaLastErrorAt = 0; refreshOpenCodeQuota(); }
    else if (next === 'qoder') { qoderQuotaLastErrorAt = 0; refreshQoderQuota(); }
    else if (next === 'codex') { codexQuotaLastErrorAt = 0; refreshCodexQuota(); }
    // No claude auto-fetch here: the Claude bar is always visible and passive
    // (its 5h comes from the live rate_limit_event), so an automatic scrape on
    // switch would pop needs_login/unavailable states the user didn't ask for.
    // The weekly/monthly scrape is fetch-on-click (⟳ 刷新) + restore.
  }

  // ── Actionable quota states ─────────────────────────────────────────────
  // Every CDP-backed quota bar (opencode / qoder / kimi) can come back with a
  // top-level status the user can FIX in one click: `needs_login` (no session in
  // the managed browser) and `chrome_unavailable` (no browser to attach to —
  // opening a visible login window is also how a managed Chrome gets started).
  // Each has a POST route that pops a visible login window.
  //
  // Two rules follow, and both were being broken:
  //   1. A view carrying `action:'login'` must dispatch the login POST on click,
  //      not a plain refetch — a refetch of a not-logged-in account just returns
  //      the same failure, so the bar becomes a dead end.
  //   2. A top-level actionable status OUTRANKS any per-site failure reason.
  //      `sites[]` says WHICH account failed; the top-level status says what the
  //      user can DO. Kimi's bar rendered sites[0].reason ('auth_rejected' →
  //      "密钥不支持余额查询") over a perfectly actionable `needs_login`, telling
  //      the user their key was unsupported when they simply had to log in.
  const QUOTA_LOGIN_ROUTES = Object.freeze({
    opencode: '/api/opencode/quota/login',
    qoder: '/api/qoder/quota/login',
    kimi: '/api/kimi/quota/login',
    claude: '/api/claude/quota/login',
  });

  // The login window is opened by the server and then waited on by a human, so
  // re-poll a few seconds later rather than immediately.
  function requestQuotaLogin(kind, reFetch) {
    const route = QUOTA_LOGIN_ROUTES[kind];
    if (!route) { reFetch(); return; }
    Promise.resolve()
      .then(() => fetch(route, { method: 'POST', credentials: 'same-origin' }))
      .catch(() => {})
      .then(() => { global.setTimeout?.(() => reFetch(), 3000); });
  }

  // Click handler for a bar whose view may be actionable. `reFetch` is the
  // bar's own forced refresh.
  function quotaBarClick(kind, view, reFetch) {
    if (view && view.action === 'login') requestQuotaLogin(kind, reFetch);
    else reFetch();
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
        text: 'OpenCode Go：需登录 · 点击打开登录窗口',
        color: '#f85149',
        title: '你的 Chrome 里没有 opencode.ai 的登录态。点击将由 multicc 拉起一个 Chrome 登录窗口（opencode.ai/auth），走完 OAuth 后回来再点一次刷新。',
        action: 'login',
      });
    }
    if (value.status === 'chrome_unavailable') {
      return Object.freeze({
        text: 'OpenCode Go：无可连的 Chrome · 点击尝试打开登录窗口',
        color: '#d29922',
        title: '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；也可以自己开一个带调试端点的 Chrome（--remote-debugging-port=0 即可，我们会从 DevToolsActivePort 找到它）并在其中登录 opencode.ai。',
        action: 'login',
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
    const segs = [];
    if (u.rolling && Number.isFinite(u.rolling.usagePercent)) {
      segs.push(unifiedWindowSeg('5h', u.rolling.usagePercent, u.rolling.resetInSec * 1000));
    }
    if (u.weekly && Number.isFinite(u.weekly.usagePercent)) {
      segs.push(unifiedWindowSeg('1wk', u.weekly.usagePercent, u.weekly.resetInSec * 1000));
    }
    if (u.monthly && Number.isFinite(u.monthly.usagePercent)) {
      segs.push(unifiedWindowSeg('1m', u.monthly.usagePercent, u.monthly.resetInSec * 1000));
    }
    let text = sortWindowSegs(segs.filter(Boolean)).join(' · ') || '—';
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
    element.onclick = () => quotaBarClick('opencode', view, () => refreshOpenCodeQuota(true));
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

  // ── Qoder CN credit usage. Sourced by driving Chrome via CDP to
  // qoder.com.cn/account/usage and intercepting the SPA's API responses.
  // Rendered as #qoder-quota-bar, shown only when cli=qoder.
  let currentQoderQuota = null;
  let qoderQuotaFetchInFlight = false;
  const QODER_QUOTA_BACKOFF_MS = 60_000;
  let qoderQuotaLastErrorAt = 0;

  function qoderQuotaStorageKey() { return 'multicc.qoder.quota.v1'; }

  function loadQoderQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(qoderQuotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveQoderQuotaToStorage(data) {
    const storage = browserStorage(); if (!storage) return;
    try { storage.setItem(qoderQuotaStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  function formatQoderQuota(value) {
    if (!value) {
      return Object.freeze({
        text: 'Qoder CN 余量 · ⟳ 刷新',
        color: '#8b949e',
        title: '点击从 qoder.com.cn 拉取 credits 用量',
      });
    }
    if (value.status === 'needs_login') {
      return Object.freeze({
        text: 'Qoder CN：需登录 · 点击打开登录页',
        color: '#f85149',
        title: '你的 Chrome 里没有 qoder.com.cn 的登录态。点击将在 Chrome 中打开登录页，登录后再点刷新。',
        action: 'login',
      });
    }
    if (value.status === 'chrome_unavailable') {
      return Object.freeze({
        text: 'Qoder CN：无可连的 Chrome · 点击尝试打开登录窗口',
        color: '#d29922',
        // Opening the visible login window is also how the managed Chrome gets
        // started, so this is a fix-it click, not just a retry.
        title: '托管 Chrome 起不来，也没有可连的调试端点。点击会尝试拉起一个可见的 Chrome 登录窗口；在其中登录 qoder.com.cn 一次，之后一周的刷新都走缓存 cookie，不再需要浏览器。',
        action: 'login',
      });
    }
    if (value.status !== 'ok' || !value.quota) {
      return Object.freeze({
        text: 'Qoder CN：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: value.error || '无法从 qoder.com.cn 拉取用量',
      });
    }
    const q = value.quota;
    const total = q.total_quota?.quota_summary || {};
    const planQ = q.plan_quota?.quota_summary || {};
    const pkg = q.resource_package_quota?.quota_summary || {};
    const used = total.used_value ?? 0;
    const limit = total.limit_value ?? 0;
    const remaining = total.remaining_value ?? 0;
    const pct = total.usage_percentage ?? (limit > 0 ? Math.round(used / limit * 100) : 0);

    // Credits reset on the billing cycle. The usage API exposes the next reset
    // as top-level `nextResetAt` (epoch ms); the plan API's end_date /
    // next_refresh_date are the fallback when the usage response omits it.
    const resetAt = normalizeResetTime(q.nextResetAt)
      ?? normalizeResetTime(value.plan && value.plan.end_date)
      ?? normalizeResetTime(value.plan && value.plan.next_refresh_date);
    const resetMs = resetAt === null ? null : Math.max(0, resetAt - Date.now());

    let text = unifiedWindowSeg('1m', pct, resetMs) || '—';
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';

    let color = unifiedColorFromRemaining(unifiedRemaining(pct));

    const planTier = value.plan?.plan_tier?.replace('PLAN_TIER_', '') || '';
    let title = `Qoder CN 用量（CDP 抓 qoder.com.cn）\n套餐: ${planTier}\n总计: ${used}/${limit} · 剩余 ${remaining}`;
    if (planQ.limit_value) title += `\n套餐配额: ${planQ.used_value}/${planQ.limit_value}`;
    if (pkg.limit_value) title += `\n加油包: ${pkg.used_value}/${pkg.limit_value} (剩 ${pkg.remaining_value})`;
    // 到期/重置维度与其它 bar 一致：有真实时间戳显示倒计时与绝对时间，
    // 缺失时在 tooltip 如实标注（文本保持统一格式 <window> <remaining%>）。
    if (resetAt !== null) {
      title += `\n重置: ${new Date(resetAt).toLocaleString()}（${humanizeCountdown(resetMs)} 后）`;
    } else {
      title += '\n到期时间未知（API 未返回 nextResetAt/套餐到期日）';
    }
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({ text, color, title });
  }

  function renderQoderQuota() {
    const element = global.document?.getElementById?.('qoder-quota-bar');
    if (!element) return;
    if (currentCli !== 'qoder') {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatQoderQuota(currentQoderQuota);
    if (qoderQuotaFetchInFlight) {
      element.textContent = 'Qoder CN：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在通过 CDP 抓取 qoder.com.cn 用量...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => quotaBarClick('qoder', view, () => refreshQoderQuota(true));
  }

  async function refreshQoderQuota(force) {
    if (currentCli !== 'qoder' && !force) return null;
    if (qoderQuotaFetchInFlight) return currentQoderQuota;
    if (!force && qoderQuotaLastErrorAt && (Date.now() - qoderQuotaLastErrorAt) < QODER_QUOTA_BACKOFF_MS) {
      return currentQoderQuota;
    }
    qoderQuotaFetchInFlight = true;
    renderQoderQuota();
    try {
      const res = await fetch('/api/qoder/quota', { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentQoderQuota = data;
        saveQoderQuotaToStorage(data);
        qoderQuotaLastErrorAt = 0;
      } else {
        currentQoderQuota = data;
        qoderQuotaLastErrorAt = Date.now();
      }
    } catch (_) {
      qoderQuotaLastErrorAt = Date.now();
      currentQoderQuota = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      qoderQuotaFetchInFlight = false;
    }
    renderQoderQuota();
    return currentQoderQuota;
  }

  function restoreQoderQuota() {
    currentQoderQuota = loadQoderQuotaFromStorage();
    renderQoderQuota();
    return currentQoderQuota;
  }

  // ── Codex (ChatGPT) weekly quota. Sourced directly from
  // chatgpt.com/backend-api/wham/usage via the on-disk OAuth token (no CDP).
  // Rendered as #codex-quota-bar, shown when cli=codex.
  let currentCodexQuota = null;
  let codexQuotaFetchInFlight = false;
  const CODEX_QUOTA_BACKOFF_MS = 60_000;
  let codexQuotaLastErrorAt = 0;

  function codexQuotaStorageKey() { return 'multicc.codex.quota.v1'; }

  function loadCodexQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(codexQuotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveCodexQuotaToStorage(data) {
    const storage = browserStorage(); if (!storage) return;
    try { storage.setItem(codexQuotaStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  function formatCodexQuota(value) {
    if (!value) {
      return Object.freeze({
        text: 'Codex 余量 · ⟳ 刷新',
        color: '#8b949e',
        title: '点击从 chatgpt.com 拉取 Codex 周额度用量',
      });
    }
    if (value.status === 'no_auth') {
      return Object.freeze({
        text: 'Codex：未登录 · ⟳ 重试',
        color: '#f85149',
        title: '未找到 ~/.codex/auth.json。请先在终端运行 codex 完成登录。',
      });
    }
    if (value.status !== 'ok' || !value.weekly) {
      return Object.freeze({
        text: 'Codex：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: value.error || '无法从 chatgpt.com 拉取用量',
      });
    }
    const w = value.weekly;
    const used = w.usedPercent ?? 0;
    const resetMs = w.resetsAt ? Math.max(0, w.resetsAt * 1000 - Date.now()) : null;
    let text = unifiedWindowSeg('1wk', used, resetMs) || '—';
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';

    let color = unifiedColorFromRemaining(unifiedRemaining(value.limitReached ? 100 : used));

    let title = `Codex 周额度（chatgpt.com/backend-api/wham/usage）\n套餐: ${value.planType || '?'}${value.email ? ' · ' + value.email : ''}\n已用 ${used}% · 剩余 ${w.remainingPercent ?? 0}%`;
    if (w.resetsAt) title += `\n重置: ${new Date(w.resetsAt * 1000).toLocaleString()}`;
    for (const a of (value.additional || [])) title += `\n${a.name}: ${a.usedPercent}% 已用`;
    if (value.credits && value.credits.hasCredits) title += `\nCredits 余额: ${value.credits.balance}`;
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({ text, color, title });
  }

  function renderCodexQuota() {
    const element = global.document?.getElementById?.('codex-quota-bar');
    if (!element) return;
    if (currentCli !== 'codex') {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatCodexQuota(currentCodexQuota);
    if (codexQuotaFetchInFlight) {
      element.textContent = 'Codex：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在从 chatgpt.com 拉取 Codex 周额度...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => { refreshCodexQuota(true); };
  }

  async function refreshCodexQuota(force) {
    if (currentCli !== 'codex' && !force) return null;
    if (codexQuotaFetchInFlight) return currentCodexQuota;
    if (!force && codexQuotaLastErrorAt && (Date.now() - codexQuotaLastErrorAt) < CODEX_QUOTA_BACKOFF_MS) {
      return currentCodexQuota;
    }
    codexQuotaFetchInFlight = true;
    renderCodexQuota();
    try {
      const res = await fetch('/api/codex/quota', { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentCodexQuota = data;
        saveCodexQuotaToStorage(data);
        codexQuotaLastErrorAt = 0;
      } else {
        currentCodexQuota = data;
        codexQuotaLastErrorAt = Date.now();
      }
    } catch (_) {
      codexQuotaLastErrorAt = Date.now();
      currentCodexQuota = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      codexQuotaFetchInFlight = false;
    }
    renderCodexQuota();
    return currentCodexQuota;
  }

  function restoreCodexQuota() {
    currentCodexQuota = loadCodexQuotaFromStorage();
    renderCodexQuota();
    return currentCodexQuota;
  }

  // ── Volcano Ark (火山方舟) subscription quota. Sourced by shelling out to the
  // official `arkcli` CLI (`arkcli usage plan`) on the server. Unlike Qoder/Codex
  // (gated on currentCli), this bar is gated on the active provider's baseUrl
  // being a Volcano Ark endpoint (host *.volces.com), so it shows for any cli
  // pointed at Ark. Rendered as #ark-quota-bar.
  let currentProviderBaseUrl = '';
  let currentArkQuota = null;
  let arkQuotaFetchInFlight = false;
  let arkInstallInFlight = false;
  const ARK_QUOTA_BACKOFF_MS = 60_000;
  let arkQuotaLastErrorAt = 0;

  function isArkBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return false;
    try {
      return /(^|\.)volces\.com$/i.test(new URL(baseUrl).hostname);
    } catch (_) {
      return /volces\.com/i.test(baseUrl);
    }
  }

  function setProviderBaseUrl(baseUrl) {
    const next = String(baseUrl || '');
    const changed = next !== currentProviderBaseUrl;
    currentProviderBaseUrl = next;
    renderCurrent();
    renderBalance();
    renderArkQuota();
    renderZhipuQuota();
    renderKimiQuota();
    // A provider switch must immediately reflect the new provider's quota: pull
    // fresh data for whichever vendor the new baseUrl points at. Each refresh is
    // a no-op unless the baseUrl matches that vendor. The error backoff exists to
    // stop a broken endpoint from being hammered, not to stall an explicit user
    // action, so clear it first; the in-flight guard still dedupes concurrent
    // fetches, and an unchanged baseUrl still fetches nothing.
    if (changed) {
      arkQuotaLastErrorAt = 0;
      zhipuQuotaLastErrorAt = 0;
      kimiQuotaLastErrorAt = 0;
      refreshArkQuota();
      refreshZhipuQuota();
      refreshKimiQuota();
    }
  }

  function arkQuotaStorageKey() { return 'multicc.ark.quota.v1'; }

  function loadArkQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(arkQuotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveArkQuotaToStorage(data) {
    const storage = browserStorage(); if (!storage) return;
    try { storage.setItem(arkQuotaStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  function arkProductLabel(product) {
    if (product === 'agent-plan') return 'Agent';
    if (product === 'coding-plan') return 'Coding';
    if (product === 'agent-plan-team') return 'Agent团队';
    if (product === 'coding-plan-team') return 'Coding团队';
    return product || '?';
  }

  // Which subscription plan the provider's baseUrl points to: Volcano Ark
  // serves Coding Plan under /api/coding(/v3) and Agent Plan under /api/plan.
  // Anything else (bare /api/v3, unparseable) stays unknown → no plan is
  // marked as current rather than guessing wrong.
  function arkPlanFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    try {
      const p = new URL(baseUrl).pathname.toLowerCase();
      if (p.includes('/coding')) return 'coding-plan';
      if (p.includes('/plan')) return 'agent-plan';
    } catch (_) {}
    return null;
  }

  function arkPeriodLabel(label) {
    const l = String(label || '').toLowerCase();
    if (l === 'weekly') return '周';
    if (l === 'monthly') return '月';
    if (l === 'session') return '会话';
    return String(label || '?');
  }

  // Short unified window token for the compact bar (vs. the Chinese tooltip label).
  function arkWindowLabel(label) {
    const l = String(label || '').toLowerCase();
    if (l === '5h') return '5h';
    if (l === 'weekly') return '1wk';
    if (l === 'monthly') return '1m';
    if (l === 'session') return '会话';
    return l || '?';
  }

  // Round to at most 2 decimals for display (99.487123 -> 99.49, 12.3456 -> 12.35);
  // trailing zeros are dropped so integer counts stay clean (250 -> 250).
  function fmtArkNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n ?? '');
    return String(Number(v.toFixed(2)));
  }

  function formatArkQuota(value, baseUrl) {
    if (!value) {
      return Object.freeze({
        text: '火山方舟 余量 · ⟳ 刷新',
        color: '#8b949e',
        title: '点击通过 arkcli 拉取火山方舟套餐额度',
      });
    }
    if (value.status === 'needs_auth') {
      return Object.freeze({
        text: '火山方舟：未登录 · 点击登录',
        color: '#f85149',
        title: 'arkcli 未配置火山 SSO 凭证。点击将打开浏览器完成 SSO 登录，登录后再点刷新。',
      });
    }
    if (value.status === 'needs_install') {
      return Object.freeze({
        text: '火山方舟：未安装 arkcli · 点击安装',
        color: '#d29922',
        title: '未检测到 arkcli。点击将自动执行 npm install -g @volcengine/ark-cli 安装（需本机有 npm）。',
      });
    }
    if (value.status !== 'ok' || !Array.isArray(value.items)) {
      return Object.freeze({
        text: '火山方舟：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: value.error || '无法通过 arkcli 拉取用量',
      });
    }
    const subscribed = value.items.filter((it) => it.subscribed && !it.error && it.periods && it.periods.length);
    if (!subscribed.length) {
      return Object.freeze({
        text: '火山方舟：无生效套餐 · ⟳ 刷新',
        color: '#8b949e',
        title: '当前身份名下没有已订阅的 AgentPlan / CodingPlan',
      });
    }
    // The plan matching the session's provider baseUrl (or the first subscribed
    // plan when inconclusive) drives the compact bar; every plan's detail still
    // goes to the tooltip so the whole quota picture stays reachable.
    const activePlan = arkPlanFromBaseUrl(baseUrl);
    const ordered = activePlan
      ? [...subscribed].sort((a, b) => Number(b.product === activePlan) - Number(a.product === activePlan))
      : subscribed;
    const plan = ordered[0];
    const segs = [];
    let maxUsed = 0;
    for (const p of plan.periods) {
      const pct = p.percent ?? 0;
      if (pct > maxUsed) maxUsed = pct;
      const resetMs = p.resetAt ? Math.max(0, p.resetAt - Date.now()) : null;
      segs.push(unifiedWindowSeg(arkWindowLabel(p.label), pct, resetMs));
    }
    const titleLines = [];
    for (const it of ordered) {
      const isActive = it === plan;
      const itemTitle = [`${arkProductLabel(it.product)}${it.tier ? ' · ' + it.tier : ''}${isActive ? '（当前 provider）' : ''}`];
      for (const p of it.periods) {
        let line = `  ${arkPeriodLabel(p.label)}: `;
        line += (p.used != null && p.total != null)
          ? `${fmtArkNum(p.used)}/${fmtArkNum(p.total)} (${fmtArkNum(p.percent ?? 0)}%)`
          : `${fmtArkNum(p.percent ?? 0)}%`;
        if (p.resetAt) line += ` · ${new Date(p.resetAt).toLocaleString()} 重置`;
        itemTitle.push(line);
      }
      titleLines.push(...itemTitle);
    }
    let text = sortWindowSegs(segs.filter(Boolean)).join(' · ') || '—';
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';

    let color = unifiedColorFromRemaining(unifiedRemaining(maxUsed));

    const viewer = value.viewer;
    let title = '火山方舟套餐额度（arkcli usage plan）';
    if (viewer && (viewer.user_name || viewer.account_id)) {
      title += `\n身份: ${viewer.user_name || viewer.account_id}${viewer.auth_method ? ' · ' + viewer.auth_method : ''}`;
    }
    title += '\n' + titleLines.join('\n');
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({ text, color, title });
  }

  function renderArkQuota() {
    const element = global.document?.getElementById?.('ark-quota-bar');
    if (!element) return;
    if (!isArkBaseUrl(currentProviderBaseUrl)) {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatArkQuota(currentArkQuota, currentProviderBaseUrl);
    if (arkInstallInFlight) {
      element.textContent = '火山方舟：正在安装 arkcli…';
      element.style.color = '#8b949e';
      element.title = '正在执行 npm install -g @volcengine/ark-cli，首次安装可能需要一两分钟...';
    } else if (arkQuotaFetchInFlight) {
      element.textContent = '火山方舟：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在通过 arkcli 拉取火山方舟套餐额度...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => {
      if (currentArkQuota && currentArkQuota.status === 'needs_install' && !arkInstallInFlight) {
        arkInstallInFlight = true;
        renderArkQuota();
        fetch('/api/ark/quota/install', { method: 'POST', credentials: 'same-origin' })
          .then((r) => r.json().catch(() => ({})).then((d) => ({ httpOk: r.ok, body: d || {} })))
          .then(({ httpOk, body }) => {
            arkInstallInFlight = false;
            if (httpOk && body.status === 'ok') {
              refreshArkQuota(true);
            } else {
              currentArkQuota = { status: 'unavailable', error: body.error || '自动安装失败，请手动运行 npm install -g @volcengine/ark-cli' };
              arkQuotaLastErrorAt = 0;
              renderArkQuota();
            }
          })
          .catch(() => {
            arkInstallInFlight = false;
            renderArkQuota();
          });
      } else if (currentArkQuota && currentArkQuota.status === 'needs_auth') {
        fetch('/api/ark/quota/login', { method: 'POST', credentials: 'same-origin' })
          .then(() => setTimeout(() => refreshArkQuota(true), 4000));
      } else {
        refreshArkQuota(true);
      }
    };
  }

  async function refreshArkQuota(force) {
    if (!isArkBaseUrl(currentProviderBaseUrl) && !force) return null;
    if (arkQuotaFetchInFlight) return currentArkQuota;
    if (!force && arkQuotaLastErrorAt && (Date.now() - arkQuotaLastErrorAt) < ARK_QUOTA_BACKOFF_MS) {
      return currentArkQuota;
    }
    arkQuotaFetchInFlight = true;
    renderArkQuota();
    try {
      const res = await fetch('/api/ark/quota', { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentArkQuota = data;
        saveArkQuotaToStorage(data);
        arkQuotaLastErrorAt = 0;
      } else {
        currentArkQuota = data;
        arkQuotaLastErrorAt = Date.now();
      }
    } catch (_) {
      arkQuotaLastErrorAt = Date.now();
      currentArkQuota = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      arkQuotaFetchInFlight = false;
    }
    renderArkQuota();
    return currentArkQuota;
  }

  function restoreArkQuota() {
    currentArkQuota = loadArkQuotaFromStorage();
    renderArkQuota();
    return currentArkQuota;
  }

  // ── Zhipu official sites (z.ai / bigmodel.cn) window quota. Sourced from the
  // same glm-monitor window-utilization endpoint the usage-limit poller uses
  // (GET <host>/api/monitor/usage/quota/limit, raw API key auth). Like Ark, this
  // bar is gated on the active provider's baseUrl host (z.ai / bigmodel.cn) rather
  // than currentCli, so it shows for any cli pointed at a Zhipu official endpoint.
  // The backend returns all configured Zhipu sites; we pass the active host so the
  // matching site is ordered first. Rendered as #zhipu-quota-bar.
  let currentZhipuQuota = null;
  let zhipuQuotaFetchInFlight = false;
  const ZHIPU_QUOTA_BACKOFF_MS = 60_000;
  let zhipuQuotaLastErrorAt = 0;

  function zhipuHostFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    try { return new URL(baseUrl).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function isZhipuBaseUrl(baseUrl) {
    const h = zhipuHostFromBaseUrl(baseUrl);
    if (!h) return false;
    return h === 'z.ai' || h.endsWith('.z.ai')
      || h === 'bigmodel.cn' || h.endsWith('.bigmodel.cn');
  }

  function zhipuQuotaStorageKey() { return 'multicc.zhipu.quota.v1'; }

  function loadZhipuQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(zhipuQuotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveZhipuQuotaToStorage(data) {
    const storage = browserStorage(); if (!storage) return;
    try { storage.setItem(zhipuQuotaStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  // 2-decimal display, trailing zeros dropped (12.3456 -> 12.35, 100 -> 100).
  function fmtZhipuPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return String(Number(v.toFixed(2)));
  }

  function formatZhipuQuota(value) {
    if (!value) {
      return Object.freeze({
        text: 'Zhipu 余量 · ⟳ 刷新',
        color: '#8b949e',
        title: '点击从 z.ai / bigmodel.cn 额度端点拉取窗口用量',
      });
    }
    if (value.status === 'not_configured') {
      return Object.freeze({
        text: 'Zhipu：未配置 provider · ⟳ 刷新',
        color: '#8b949e',
        title: '没有 baseUrl 指向 z.ai / bigmodel.cn 的 provider，无法拉取用量',
      });
    }
    if (value.status !== 'ok' || !Array.isArray(value.sites)) {
      return Object.freeze({
        text: 'Zhipu：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: value.error || '无法从 z.ai / bigmodel.cn 拉取用量',
      });
    }
    const okSites = value.sites.filter((s) => s && s.ok && Number.isFinite(s.usedPercent));
    if (!okSites.length) {
      return Object.freeze({
        text: 'Zhipu：用量暂不可用 · ⟳ 重试',
        color: '#d29922',
        title: '所有 Zhipu 站点的额度端点都未返回有效窗口数据',
      });
    }
    // The backend orders the caller's current site first; it drives the compact
    // bar (5h + 1wk windows) while every site's detail stays in the tooltip.
    const s = okSites[0];
    const segs = [];
    let maxUsed = 0;
    if (s.usedPercent > maxUsed) maxUsed = s.usedPercent;
    segs.push(unifiedWindowSeg('5h', s.usedPercent, s.resetsAt ? Math.max(0, s.resetsAt - Date.now()) : null));
    if (Number.isFinite(s.weeklyUsedPercent)) {
      if (s.weeklyUsedPercent > maxUsed) maxUsed = s.weeklyUsedPercent;
      segs.push(unifiedWindowSeg('1wk', s.weeklyUsedPercent, s.weeklyResetsAt ? Math.max(0, s.weeklyResetsAt - Date.now()) : null));
    }
    const titleLines = [];
    for (const site of okSites) {
      let line = `${site.site} (${site.host}): 5h ${fmtZhipuPct(site.usedPercent)}% 已用`;
      if (site.resetsAt) line += ` · ${new Date(site.resetsAt).toLocaleString()} 重置`;
      if (Number.isFinite(site.weeklyUsedPercent)) {
        line += ` · 周 ${fmtZhipuPct(site.weeklyUsedPercent)}% 已用`;
        if (site.weeklyResetsAt) line += `（${new Date(site.weeklyResetsAt).toLocaleString()} 重置）`;
      }
      if (site.tier) line += ` · ${site.tier}`;
      titleLines.push(line);
    }
    let text = sortWindowSegs(segs.filter(Boolean)).join(' · ') || '—';
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';

    let color = unifiedColorFromRemaining(unifiedRemaining(maxUsed));

    let title = 'Zhipu 官方站点窗口用量（glm-monitor 额度端点）';
    title += '\n' + titleLines.join('\n');
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({ text, color, title });
  }

  function renderZhipuQuota() {
    const element = global.document?.getElementById?.('zhipu-quota-bar');
    if (!element) return;
    if (!isZhipuBaseUrl(currentProviderBaseUrl)) {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatZhipuQuota(currentZhipuQuota);
    if (zhipuQuotaFetchInFlight) {
      element.textContent = 'Zhipu：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在从 z.ai / bigmodel.cn 额度端点拉取窗口用量...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => { refreshZhipuQuota(true); };
  }

  async function refreshZhipuQuota(force) {
    if (!isZhipuBaseUrl(currentProviderBaseUrl) && !force) return null;
    if (zhipuQuotaFetchInFlight) return currentZhipuQuota;
    if (!force && zhipuQuotaLastErrorAt && (Date.now() - zhipuQuotaLastErrorAt) < ZHIPU_QUOTA_BACKOFF_MS) {
      return currentZhipuQuota;
    }
    zhipuQuotaFetchInFlight = true;
    renderZhipuQuota();
    try {
      const host = zhipuHostFromBaseUrl(currentProviderBaseUrl);
      const url = host ? `/api/zhipu/quota?host=${encodeURIComponent(host)}` : '/api/zhipu/quota';
      const res = await fetch(url, { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentZhipuQuota = data;
        saveZhipuQuotaToStorage(data);
        zhipuQuotaLastErrorAt = 0;
      } else {
        currentZhipuQuota = data;
        zhipuQuotaLastErrorAt = Date.now();
      }
    } catch (_) {
      zhipuQuotaLastErrorAt = Date.now();
      currentZhipuQuota = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      zhipuQuotaFetchInFlight = false;
    }
    renderZhipuQuota();
    return currentZhipuQuota;
  }

  function restoreZhipuQuota() {
    currentZhipuQuota = loadZhipuQuotaFromStorage();
    renderZhipuQuota();
    return currentZhipuQuota;
  }

  // ── Kimi / Moonshot (api.moonshot.cn) prepaid balance. A MONEY balance (like
  // DeepSeek), not a rolling window — sourced from GET <host>/v1/users/me/balance
  // with the provider's Bearer API key. Like Ark/Zhipu, gated on the active
  // provider's baseUrl host (moonshot.cn / kimi.com / …) rather than currentCli.
  // Rendered as #kimi-quota-bar.
  let currentKimiQuota = null;
  let kimiQuotaFetchInFlight = false;
  const KIMI_QUOTA_BACKOFF_MS = 60_000;
  let kimiQuotaLastErrorAt = 0;

  function kimiHostFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    try { return new URL(baseUrl).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function isKimiBaseUrl(baseUrl) {
    const h = kimiHostFromBaseUrl(baseUrl);
    if (!h) return false;
    return /(^|\.)(moonshot|kimi)\.(cn|com|ai)$/.test(h);
  }

  function kimiQuotaStorageKey() { return 'multicc.kimi.quota.v1'; }

  function loadKimiQuotaFromStorage() {
    const storage = browserStorage(); if (!storage) return null;
    try {
      const raw = storage.getItem(kimiQuotaStorageKey());
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      if (v.fetchedAt && (Date.now() - v.fetchedAt) > 24 * 60 * 60 * 1000) return null;
      return v;
    } catch (_) { return null; }
  }

  function saveKimiQuotaToStorage(data) {
    const storage = browserStorage(); if (!storage) return;
    try { storage.setItem(kimiQuotaStorageKey(), JSON.stringify(data)); } catch (_) {}
  }

  // 2-decimal money display, trailing zeros dropped (49.58894 -> 49.59, 3 -> 3).
  function fmtKimiNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return String(Number(v.toFixed(2)));
  }

  function kimiReasonText(sites) {
    if (!Array.isArray(sites) || !sites.length) return '';
    const s = sites[0];
    if (s.reason === 'auth_rejected') return 'API Key 不支持余额查询（Kimi-for-Coding 密钥无余额接口）';
    if (s.reason === 'endpoint_not_found') return '余额端点不存在';
    if (s.reason === 'network_error') return '网络请求失败';
    if (s.reason === 'bad_shape' || s.reason === 'no_balance_fields') return '接口返回格式异常';
    return s.reason || '';
  }

  // Short bar-text reason (the full reason goes in the tooltip title).
  function kimiShortReason(sites) {
    if (!Array.isArray(sites) || !sites.length) return '';
    const s = sites[0];
    if (s.reason === 'auth_rejected') return '密钥不支持余额查询';
    if (s.reason === 'endpoint_not_found') return '余额端点不存在';
    if (s.reason === 'network_error') return '网络请求失败';
    if (s.reason === 'bad_shape' || s.reason === 'no_balance_fields') return '接口格式异常';
    return '';
  }

  function kimiCachedSites(cached) {
    return (cached && cached.status === 'ok' && Array.isArray(cached.sites))
      ? cached.sites.filter((s) => s && s.ok && Number.isFinite(s.available))
      : [];
  }

  // Render the last good cached balance (live value missing or fetch failed) with
  // a stale indicator so it is never confused with fresh data.
  function kimiCachedView(cachedOk, fetchedAt, reason, headline) {
    const s = cachedOk[0];
    let text = unifiedBalanceText(s.available, s.currency) || '—';
    const syncRel = relativeAgo(fetchedAt);
    if (syncRel) text += ` · 上次 ${syncRel}`;
    text += ' ⟳';
    let color = '#8b949e';
    if (s.available <= 0) color = '#f85149';
    else if (s.available <= 5) color = '#d29922';
    let title = headline;
    if (reason) title += `\n原因：${reason}`;
    if (syncRel) title += `\n缓存于 ${syncRel}`;
    title += '\n点击 bar 重试';
    return Object.freeze({ text, color, title });
  }

  function formatKimiQuota(value, cached) {
    const cachedOk = kimiCachedSites(cached);
    if (!value) {
      if (cachedOk.length) return kimiCachedView(cachedOk, cached.fetchedAt, '', '显示上次缓存值');
      return Object.freeze({
        text: 'Kimi 余量 · ⟳ 刷新',
        color: '#8b949e',
        title: '点击从 api.moonshot.cn 拉取预付余额',
      });
    }
    if (value.status === 'not_configured') {
      return Object.freeze({
        text: 'Kimi：未配置 provider · ⟳ 刷新',
        color: '#8b949e',
        title: '没有 baseUrl 指向 moonshot / kimi 的 provider，无法拉取余额',
      });
    }
    // An actionable top-level status comes FIRST — ahead of both sites[0].reason
    // and the stale cache. A Kimi-for-Coding key always 401s the balance API
    // (that is the key type, not a fault), so the backend falls back to scraping
    // the membership page and reports needs_login when that page has no session.
    // Rendering 'auth_rejected' over it told the user their key was unsupported
    // and left them clicking a refresh that could never succeed.
    if (value.status === 'needs_login' || value.status === 'chrome_unavailable') {
      const needsLogin = value.status === 'needs_login';
      const titleParts = [value.error || (needsLogin
        ? '托管浏览器中没有 kimi.com 登录态'
        : '没有可用的浏览器来打开 kimi.com 订阅页')];
      // The per-site reason is context now, not the headline.
      const reason = kimiReasonText(value.sites);
      if (reason) titleParts.push(`余额 API：${reason}`);
      if (cachedOk.length) {
        titleParts.push(`上次余额：${unifiedBalanceText(cachedOk[0].available, cachedOk[0].currency) || '—'}`);
      }
      titleParts.push('点击将由 multicc 拉起一个 Chrome 登录窗口；登录后回来再点一次刷新。');
      return Object.freeze({
        text: needsLogin ? 'Kimi：需登录 · 点击打开登录窗口' : 'Kimi：无可用浏览器 · 点击尝试打开登录窗口',
        color: needsLogin ? '#f85149' : '#d29922',
        title: titleParts.join('\n'),
        action: 'login',
      });
    }
    // Subscription keys have no balance to report; their usage lives on the
    // membership page, which the backend scrapes into `summary`. Without this
    // the sites-only path below would call a SUCCESSFUL scrape "余额暂不可用" —
    // i.e. the login the bar just asked for would appear to have changed nothing.
    if (value.status === 'ok' && value.source === 'subscription-page') {
      // Unified window shape: { window:'5h'|'1wk'|'1m', usedPercent, resetMs }.
      // Old caches may still carry { label, percent } — accept both, render
      // through the same template either way.
      const summary = (Array.isArray(value.summary) ? value.summary : [])
        .map((s) => ({
          label: (s && s.window) || (s && s.label) || 'Kimi',
          used: s && Number.isFinite(s.usedPercent) ? s.usedPercent : (s ? s.percent : NaN),
          resetMs: s && Number.isFinite(s.resetMs) ? s.resetMs : null,
        }))
        .filter((s) => Number.isFinite(s.used));
      const syncRel = relativeAgo(value.fetchedAt);
      if (!summary.length) {
        return Object.freeze({
          text: 'Kimi 订阅：已登录，未解析出用量 · ⟳ 重试',
          color: '#d29922',
          title: `已抓到 kimi.com 会员页，但没解析出百分比。\n原文：${String(value.text || '').slice(0, 300)}`,
        });
      }
      const maxPct = Math.max.apply(null, summary.map((s) => s.used));
      let text = sortWindowSegs(summary.map((s) => {
        const cd = s.resetMs ? Math.max(0, s.resetMs - Date.now()) : null;
        return unifiedWindowSeg(s.label, s.used, cd) || `${s.label} ${s.used}%`;
      })).join(' · ');
      if (syncRel) text += ` · ${syncRel}`;
      text += ' ⟳';
      let title = 'Kimi 订阅用量（会员页抓取；订阅 key 无预付余额接口）';
      for (const s of summary) title += `\n${s.label}: 已用 ${s.used}%`;
      if (syncRel) title += `\n同步于 ${syncRel}`;
      title += '\n点击 bar 刷新';
      return Object.freeze({
        text,
        color: unifiedColorFromRemaining(unifiedRemaining(maxPct)),
        title,
      });
    }
    const okSites = (value.status === 'ok' && Array.isArray(value.sites))
      ? value.sites.filter((s) => s && s.ok && Number.isFinite(s.available))
      : [];
    if (!okSites.length) {
      const reason = kimiReasonText(value.sites);
      if (cachedOk.length) return kimiCachedView(cachedOk, cached.fetchedAt, reason, '余额刷新失败，显示上次缓存值');
      let title = value.error || '无法从 api.moonshot.cn 拉取余额';
      if (reason) title = reason;
      const short = kimiShortReason(value.sites);
      return Object.freeze({
        text: short ? `Kimi：余额暂不可用（${short}）· ⟳ 重试` : 'Kimi：余额暂不可用 · ⟳ 重试',
        color: '#d29922',
        title,
      });
    }
    const s = okSites[0];
    let text = unifiedBalanceText(s.available, s.currency) || '—';
    const titleLines = [];
    for (const site of okSites) {
      let line = `${site.site} (${site.host}): 可用 ¥${fmtKimiNum(site.available)}`;
      if (Number.isFinite(site.voucher)) line += ` · 券 ¥${fmtKimiNum(site.voucher)}`;
      if (Number.isFinite(site.cash)) line += ` · 现金 ¥${fmtKimiNum(site.cash)}`;
      titleLines.push(line);
    }
    const syncRel = relativeAgo(value.fetchedAt);
    if (syncRel) text += ` · ${syncRel}`;
    text += ' ⟳';

    let color = '#58a6ff';
    if (s.available <= 0) color = '#f85149';
    else if (s.available <= 5) color = '#d29922';

    let title = 'Kimi / Moonshot 预付余额（api.moonshot.cn/v1/users/me/balance）';
    title += '\n' + titleLines.join('\n');
    if (syncRel) title += `\n同步于 ${syncRel}`;
    title += '\n点击 bar 刷新';
    return Object.freeze({ text, color, title });
  }

  function renderKimiQuota() {
    const element = global.document?.getElementById?.('kimi-quota-bar');
    if (!element) return;
    if (!isKimiBaseUrl(currentProviderBaseUrl)) {
      element.style.display = 'none';
      element.textContent = '';
      element.onclick = null;
      return;
    }
    const view = formatKimiQuota(currentKimiQuota, loadKimiQuotaFromStorage());
    if (kimiQuotaFetchInFlight) {
      element.textContent = 'Kimi：加载中…';
      element.style.color = '#8b949e';
      element.title = '正在从 api.moonshot.cn 拉取预付余额...';
    } else {
      element.textContent = view?.text || '';
      element.title = view?.title || '';
      if (view) element.style.color = view.color;
    }
    element.style.display = 'block';
    element.onclick = () => quotaBarClick('kimi', view, () => refreshKimiQuota(true));
  }

  async function refreshKimiQuota(force) {
    if (!isKimiBaseUrl(currentProviderBaseUrl) && !force) return null;
    if (kimiQuotaFetchInFlight) return currentKimiQuota;
    if (!force && kimiQuotaLastErrorAt && (Date.now() - kimiQuotaLastErrorAt) < KIMI_QUOTA_BACKOFF_MS) {
      return currentKimiQuota;
    }
    kimiQuotaFetchInFlight = true;
    renderKimiQuota();
    try {
      const host = kimiHostFromBaseUrl(currentProviderBaseUrl);
      const url = host ? `/api/kimi/quota?host=${encodeURIComponent(host)}` : '/api/kimi/quota';
      const res = await fetch(url, { credentials: 'same-origin' });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      if (data.status === 'ok') {
        currentKimiQuota = data;
        saveKimiQuotaToStorage(data);
        kimiQuotaLastErrorAt = 0;
      } else {
        currentKimiQuota = data;
        kimiQuotaLastErrorAt = Date.now();
      }
    } catch (_) {
      kimiQuotaLastErrorAt = Date.now();
      currentKimiQuota = { status: 'unavailable', error: 'fetch failed' };
    } finally {
      kimiQuotaFetchInFlight = false;
    }
    renderKimiQuota();
    return currentKimiQuota;
  }

  function restoreKimiQuota() {
    currentKimiQuota = loadKimiQuotaFromStorage();
    renderKimiQuota();
    return currentKimiQuota;
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
    humanizeCountdown,
    unifiedRemaining,
    unifiedWindowSeg,
    unifiedBalanceText,
    refreshOpenCodeQuota,
    restoreOpenCodeQuota,
    // Exported so the actionable-state rendering (needs_login / chrome_unavailable
    // must carry action:'login') can be asserted without a DOM.
    formatOpenCodeQuota: formatQuota,
    quotaBarClick,
    refreshQoderQuota,
    restoreQoderQuota,
    formatQoderQuota,
    refreshCodexQuota,
    restoreCodexQuota,
    setProviderBaseUrl,
    refreshArkQuota,
    restoreArkQuota,
    formatArkQuota,
    arkPlanFromBaseUrl,
    refreshZhipuQuota,
    restoreZhipuQuota,
    formatZhipuQuota,
    isZhipuBaseUrl,
    refreshKimiQuota,
    restoreKimiQuota,
    formatKimiQuota,
    isKimiBaseUrl,
    sortWindowSegs,
    formatClaudeUsageOnly,
    refreshClaudeUsage,
    restoreClaudeUsage,
    setCli,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRateLimit = api;
  if (global.document && global.location) {
    const sess = new URLSearchParams(global.location.search).get('session') || '';
    restoreFiveHourRateLimit(sess);
    restoreBalance(sess);
    restoreOpenCodeQuota();
    restoreQoderQuota();
    restoreCodexQuota();
    restoreArkQuota();
    restoreZhipuQuota();
    restoreKimiQuota();
    restoreClaudeUsage();
  }
})(typeof window !== 'undefined' ? window : globalThis);

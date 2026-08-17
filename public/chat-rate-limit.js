(function attachMultiCCChatRateLimit(global) {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────
  // Quota / limit bars — client side.
  //
  // Every word, color, ordering and vendor rule is rendered ONCE on the server
  // (src/quota/quota-bar-view.js) and arrives on every quota response and WS
  // event as a `bar` field. This file does no vendor formatting: it caches the
  // bars, fetches them on demand, and paints them. The only client-side math is
  // expanding the two time-relative tokens the server bakes into a bar —
  //   {cd:<epochMs>}  a deadline  → "42m" · "3.5h" · "3d 5h"
  //   {ago:<epochMs>} a timestamp → "刚刚" · "57s 前" · "3 分钟前"
  // — because a bar is cached (localStorage) and redisplayed for up to 24h, so
  // baking those in would make it quietly lie about how old it is. That resolver
  // is public/quota-bar-view.js, a mirror of app/lib/models/quota_bar_view.dart,
  // and the two are pinned by shared golden fixtures.
  //
  // What stays client-side is necessarily client-side: which CLI / provider the
  // user is currently looking at. The server broadcasts per-session, but the
  // user switches CLIs locally without a round-trip, so the baseUrl/cli gates
  // that decide which bar is visible live here. They are predicates over the
  // current view state — never display strings.
  // ──────────────────────────────────────────────────────────────────────

  const QuotaBarView = global.QuotaBarView
    || (typeof require === 'function' ? (() => { try { return require('./quota-bar-view'); } catch (_) { return null; } })() : null);
  const resolveQuotaBar = QuotaBarView && QuotaBarView.resolveQuotaBar;

  function finiteNumber(value) {
    if (value === null || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function browserStorage() {
    if (!global.document) return null;
    try { return global.localStorage || null; } catch (_) { return null; }
  }

  // ── Idle bars: every bar's before-first-fetch render, served once ──
  // A client opening a chat has no quota data and these fetches are expensive
  // (a 30-40s CDP drive for several), so the bars start as click targets whose
  // words come from the server rather than a hardcoded default per client.
  let idleBars = null;
  const IDLE_KEY = 'multicc.quota.idleBars.v1';
  function loadIdleBars() {
    const s = browserStorage(); if (!s) return null;
    try { const raw = s.getItem(IDLE_KEY); if (!raw) return null; const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
  }
  function saveIdleBars(bars) {
    const s = browserStorage(); if (!s || !bars) return;
    try { s.setItem(IDLE_KEY, JSON.stringify(bars)); } catch (_) {}
  }
  function idleBarFor(kind) { return (idleBars && idleBars[kind]) || null; }
  async function bootstrapIdleBars() {
    if (!global.document || !global.location) return;
    idleBars = loadIdleBars();
    renderAll();
    try {
      const res = await fetch('/api/quota/bars/idle', { credentials: 'same-origin' });
      const data = await res.json();
      if (data && data.status === 'ok' && data.bars) { idleBars = data.bars; saveIdleBars(idleBars); renderAll(); }
    } catch (_) {}
  }

  function quotaBarParams(extra) {
    const params = new URLSearchParams();
    if (currentSession) params.set('session', currentSession);
    if (currentProviderBaseUrl) params.set('baseUrl', currentProviderBaseUrl);
    const fields = extra && typeof extra === 'object' ? extra : {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && String(value)) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  function cacheEntryToResponse(entry) {
    if (!entry || typeof entry !== 'object' || !entry.bar) return null;
    return {
      status: entry.status || 'ok',
      fetchedAt: entry.fetchedAt || entry.updatedAt || null,
      lastError: entry.lastError || null,
      lastErrorAt: entry.lastErrorAt || null,
      bar: entry.bar,
    };
  }

  // ── baseUrl / cli predicates (client view-state only) ──
  function hostFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    try { return new URL(baseUrl).hostname.toLowerCase(); } catch (_) { return ''; }
  }
  function isArkBaseUrl(baseUrl) {
    const h = hostFromBaseUrl(baseUrl);
    return h ? /(^|\.)volces\.com$/i.test(h) : /volces\.com/i.test(baseUrl || '');
  }
  function isZhipuBaseUrl(baseUrl) {
    const h = hostFromBaseUrl(baseUrl);
    return !!h && (h === 'z.ai' || h.endsWith('.z.ai') || h === 'bigmodel.cn' || h.endsWith('.bigmodel.cn'));
  }
  function isKimiBaseUrl(baseUrl) {
    const h = hostFromBaseUrl(baseUrl);
    return !!h && /(^|\.)(moonshot|kimi)\.(cn|com|ai)$/.test(h);
  }
  function isDeepseekBaseUrl(baseUrl) {
    const h = hostFromBaseUrl(baseUrl);
    return h ? /(^|\.)deepseek\.com$/i.test(h) : /deepseek\.com/i.test(baseUrl || '');
  }
  function isClaudeProvider(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) return true;
    const h = hostFromBaseUrl(baseUrl);
    return h ? /(^|\.)(anthropic|claude)\.(com|ai)$/i.test(h) : false;
  }
  function arkPlanFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    try { const p = new URL(baseUrl).pathname.toLowerCase(); if (p.includes('/coding')) return 'coding-plan'; if (p.includes('/plan')) return 'agent-plan'; } catch (_) {}
    return null;
  }
  // A window limit shows only under a CLI that could have produced it: Claude 5h
  // under claude/opencode, GLM 5h under codex/opencode (and the claude CLI when
  // pointed at a Zhipu endpoint), Codex weekly under codex/opencode, and
  // OpenCode Go's own window only under opencode.
  function providerMatchesCli(provider, cli) {
    if (provider === 'opencode') return cli === 'opencode';
    if (provider === 'glm' || provider === 'codex') {
      if (cli === 'codex' || cli === 'opencode') return true;
      return provider === 'glm' && isZhipuBaseUrl(currentProviderBaseUrl);
    }
    return cli === 'claude' || cli === 'opencode';
  }

  // ── DOM painter ──
  function resolveBar(bar, state) {
    if (!bar) return null;
    return resolveQuotaBar ? resolveQuotaBar(bar, { state }) : bar;
  }
  function hideBar(element) {
    if (!element) return;
    element.style.display = 'none'; element.textContent = ''; element.onclick = null; element.title = '';
  }
  function paintBar(element, bar, state) {
    if (!element) return null;
    const view = resolveBar(bar, state);
    if (!view) { hideBar(element); return null; }
    element.textContent = view.text || '';
    element.title = view.title || '';
    element.style.color = view.color || '#8b949e';
    element.style.display = 'block';
    return view;
  }

  // ── Per-vendor cache: one shape (a route response, fresh 24h) ──
  function makeStorage(key) {
    const resolveKey = () => (typeof key === 'function' ? key() : key);
    return {
      load() {
        const s = browserStorage(); if (!s) return null;
        try {
          const raw = s.getItem(resolveKey()); if (!raw) return null;
          const v = JSON.parse(raw); if (!v || typeof v !== 'object') return null;
          if (v.fetchedAt && (Date.now() - v.fetchedAt) > 86_400_000) return null;
          return v;
        } catch (_) { return null; }
      },
      save(v) { const s = browserStorage(); if (!s || !v) return; try { s.setItem(resolveKey(), JSON.stringify(v)); } catch (_) {} },
    };
  }

  // ── Actionable-state click: needs_login / chrome_unavailable → login POST ──
  const QUOTA_LOGIN_ROUTES = Object.freeze({
    opencode: '/api/opencode/quota/login', qoder: '/api/qoder/quota/login',
    kimi: '/api/kimi/quota/login', claude: '/api/claude/quota/login',
  });
  function requestQuotaLogin(kind, reFetch) {
    const route = QUOTA_LOGIN_ROUTES[kind];
    if (!route) { reFetch(); return; }
    Promise.resolve().then(() => fetch(route, { method: 'POST', credentials: 'same-origin' })).catch(() => {})
      .then(() => { global.setTimeout?.(() => reFetch(), 3000); });
  }
  // A bar whose server render carries action:'login' dispatches the login POST
  // on click, not a plain refetch — a refetch of a not-logged-in account just
  // returns the same failure, so the bar would be a dead end.
  function quotaBarClick(kind, view, reFetch) {
    if (view && view.action === 'login') requestQuotaLogin(kind, reFetch);
    else reFetch();
  }

  // ── HTTP quota slot factory ──
  // opencode / qoder / codex / zhipu / kimi share one lifecycle: a 24h
  // localStorage cache, fetch-on-demand, in-flight + 60s error backoff, and a
  // render drawn from the server `bar` (or the idle bar) with a 'loading' state
  // while in flight. ark adds an 'installing' state and its own click (install /
  // auth / refresh), so it passes onClick and sets canInstall.
  function createQuotaSlot(opts) {
    const store = makeStorage(opts.storageKey);
    const BACKOFF = 60_000;
    let current = null;
    let inFlight = false;
    let lastErrorAt = 0;
    let installInFlight = false;
    function isVisible() { return opts.isVisible ? opts.isVisible() : true; }
    function activeBar() { return (current && current.bar) || idleBarFor(opts.kind); }
    function activeState() {
      if (opts.canInstall && installInFlight) return 'installing';
      return inFlight ? 'loading' : undefined;
    }
    function render() {
      const element = global.document?.getElementById?.(opts.id);
      if (!element) return null;
      if (!isVisible()) { hideBar(element); return null; }
      const view = paintBar(element, activeBar(), activeState());
      element.style.cursor = view ? 'pointer' : '';
      if (view) element.onclick = () => (opts.onClick ? opts.onClick(view) : quotaBarClick(opts.loginKind, view, () => refresh(true)));
      return view;
    }
    async function refresh(force) {
      if (!isVisible() && !force) return current;
      if (inFlight) return current;
      if (!force && lastErrorAt && (Date.now() - lastErrorAt) < BACKOFF) return current;
      inFlight = true; render();
      try {
        const res = await fetch(opts.getUrl(), { method: 'POST', credentials: 'same-origin' });
        let data = null; try { data = await res.json(); } catch (_) {}
        if (!data) data = { status: 'unavailable', error: 'invalid response' };
        current = data;
        if (data.status === 'ok') { lastErrorAt = 0; store.save(data); }
        else lastErrorAt = Date.now();
      } catch (_) {
        lastErrorAt = Date.now();
        current = { status: 'unavailable', error: 'fetch failed' };
      } finally { inFlight = false; }
      render();
      return current;
    }
    function restore() { current = store.load(); render(); return current; }
    function setCurrent(v) { current = v || null; lastErrorAt = 0; render(); return current; }
    return {
      kind: opts.kind, render, refresh, restore, setCurrent,
      clearBackoff() { lastErrorAt = 0; },
      get current() { return current; },
      get inFlight() { return inFlight; },
      get installInFlight() { return installInFlight; },
      setInstallInFlight(v) { installInFlight = !!v; render(); },
    };
  }

  const opencodeSlot = createQuotaSlot({
    kind: 'opencode', id: 'opencode-quota-bar', loginKind: 'opencode',
    isVisible: () => currentCli === 'opencode',
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'opencode' })}`,
    storageKey: 'multicc.opencode.quota.v1',
  });
  const qoderSlot = createQuotaSlot({
    kind: 'qoder', id: 'qoder-quota-bar', loginKind: 'qoder',
    isVisible: () => currentCli === 'qoder',
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'qoder' })}`,
    storageKey: 'multicc.qoder.quota.v1',
  });
  const codexSlot = createQuotaSlot({
    kind: 'codex', id: 'codex-quota-bar',
    isVisible: () => currentCli === 'codex',
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'codex' })}`,
    storageKey: 'multicc.codex.quota.v1',
  });
  const zhipuSlot = createQuotaSlot({
    kind: 'zhipu', id: 'zhipu-quota-bar',
    isVisible: () => isZhipuBaseUrl(currentProviderBaseUrl),
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'zhipu', host: hostFromBaseUrl(currentProviderBaseUrl) })}`,
    storageKey: 'multicc.zhipu.quota.v1',
  });
  const kimiSlot = createQuotaSlot({
    kind: 'kimi', id: 'kimi-quota-bar', loginKind: 'kimi',
    isVisible: () => isKimiBaseUrl(currentProviderBaseUrl),
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'kimi', host: hostFromBaseUrl(currentProviderBaseUrl) })}`,
    storageKey: 'multicc.kimi.quota.v1',
  });
  const arkSlot = createQuotaSlot({
    kind: 'ark', id: 'ark-quota-bar', canInstall: true,
    isVisible: () => isArkBaseUrl(currentProviderBaseUrl),
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'ark' })}`,
    storageKey: () => `multicc.ark.quota.v1:${arkPlanFromBaseUrl(currentProviderBaseUrl) || hostFromBaseUrl(currentProviderBaseUrl) || 'unknown'}`,
    onClick: (view) => arkClick(view),
  });

  // Ark's click is three destinations: install arkcli (needs_install), open the
  // auth window (needs_auth), or refetch. Install is a long-running state that
  // is not a fetch, so it has its own server-rendered 'installing' state.
  function arkClick() {
    const cur = arkSlot.current;
    if (cur && cur.status === 'needs_install' && !arkSlot.installInFlight) {
      arkSlot.setInstallInFlight(true);
      fetch('/api/ark/quota/install', { method: 'POST', credentials: 'same-origin' })
        .then((r) => r.json().catch(() => ({})).then((d) => ({ httpOk: r.ok, body: d || {} })))
        .then(({ httpOk, body }) => {
          arkSlot.setInstallInFlight(false);
          if (httpOk && body.status === 'ok') arkSlot.refresh(true);
          else arkSlot.setCurrent({ status: 'unavailable', error: body.error || '自动安装失败，请手动运行 npm install -g @volcengine/ark-cli' });
        })
        .catch(() => arkSlot.setInstallInFlight(false));
    } else if (cur && cur.status === 'needs_auth') {
      fetch('/api/ark/quota/login', { method: 'POST', credentials: 'same-origin' })
        .then(() => setTimeout(() => arkSlot.refresh(true), 4000));
    } else {
      arkSlot.refresh(true);
    }
  }

  // ── Claude subscription + passive window limits (WS-sourced) ──
  // The #claude-rate-limit-bar slot shows two species:
  //   • the Claude subscription bar under the claude CLI on the Claude provider
  //     (the usage-page scrape, merged server-side with the live 5h event);
  //   • a standalone / routed window bar (GLM 5h, Codex weekly, Claude 5h under
  //     opencode) that arrived as a rate_limit_event.
  // Both arrive already rendered by the server; the slot only gates and paints.
  let currentCli = 'claude';
  let currentProviderBaseUrl = '';
  let currentSession = '';
  let cliInitialized = false;
  let currentLimitInfo = null;   // raw rate_limit_info (provider/resetsAt for gating + timer)
  let currentLimitBar = null;    // server-rendered bar from the rate_limit_event
  let currentClaudeUsage = null; // scrape response (its .bar is the full Claude bar)
  let claudeUsageFetchInFlight = false;
  let claudeLoginPending = false;
  let claudeLastErrorAt = 0;
  const CLAUDE_BACKOFF = 60_000;
  const claudeStore = makeStorage('multicc.claude.usage.v1');
  let expiryTimer = null;

  function limitStorageKey(session) { const s = String(session || '').trim(); return s ? `multicc:claude-rate-limit:v1:${s}` : ''; }
  function saveLimitBar(session, bar) {
    const k = limitStorageKey(session), s = browserStorage(); if (!s || !k || !bar) return;
    try { s.setItem(k, JSON.stringify(bar)); } catch (_) {}
  }
  function loadLimitBar(session) {
    const k = limitStorageKey(session), s = browserStorage(); if (!s || !k) return null;
    try { return JSON.parse(s.getItem(k) || 'null'); } catch (_) { return null; }
  }
  function limitProvider() {
    if (!currentLimitInfo) return null;
    const p = currentLimitInfo.provider;
    return p === 'glm' ? 'glm' : p === 'codex' ? 'codex' : p === 'opencode' ? 'opencode' : 'claude';
  }

  function renderCurrent() {
    const element = global.document?.getElementById?.('claude-rate-limit-bar');
    if (!element) return;
    const claudeProvider = isClaudeProvider(currentProviderBaseUrl);
    const provider = limitProvider();
    let bar = null, state, clickable = false;
    if (currentCli === 'claude' && claudeProvider) {
      // Claude subscription: the scrape (full, with weekly) is authoritative;
      // before it lands the live 5h event or the idle render stands in.
      bar = (currentClaudeUsage && currentClaudeUsage.bar) || currentLimitBar || idleBarFor('claude');
      state = claudeUsageFetchInFlight ? 'fetching' : (claudeLoginPending ? 'login_pending' : undefined);
      clickable = true;
    } else if (provider && providerMatchesCli(provider, currentCli)) {
      bar = currentLimitBar;
    }
    const view = paintBar(element, bar, state);
    if (view) {
      element.style.cursor = clickable ? 'pointer' : '';
      element.onclick = clickable ? () => claudeBarClick(view) : null;
    }
    scheduleExpiry();
  }

  function claudeBarClick(view) {
    if (!view) return;
    if (view.action === 'login' || view.action === 'login_pending') {
      claudeLoginPending = true; renderCurrent();
      requestQuotaLogin('claude', () => { claudeLoginPending = false; refreshClaudeUsage(true); });
      return;
    }
    refreshClaudeUsage(true);
  }

  async function refreshClaudeUsage(force) {
    if (claudeUsageFetchInFlight) return currentClaudeUsage;
    if (!force && claudeLastErrorAt && (Date.now() - claudeLastErrorAt) < CLAUDE_BACKOFF) return currentClaudeUsage;
    claudeUsageFetchInFlight = true; claudeLoginPending = false; renderCurrent();
    try {
      const res = await fetch(`/api/quota/bars/refresh${quotaBarParams({ kind: 'claude' })}`, { method: 'POST', credentials: 'same-origin' });
      let data = null; try { data = await res.json(); } catch (_) {}
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      currentClaudeUsage = data;
      if (data.status === 'ok') { claudeLastErrorAt = 0; claudeStore.save(data); }
      else claudeLastErrorAt = Date.now();
    } catch (_) {
      claudeLastErrorAt = Date.now();
      currentClaudeUsage = { status: 'unavailable', error: 'fetch failed' };
    } finally { claudeUsageFetchInFlight = false; }
    renderCurrent();
    return currentClaudeUsage;
  }
  function restoreClaudeUsage() { currentClaudeUsage = claudeStore.load(); renderCurrent(); return currentClaudeUsage; }

  function consumeRateLimitEvent(info, sessionName, bar) {
    currentSession = String(sessionName || currentSession || '').trim();
    currentLimitInfo = info || null;
    currentLimitBar = bar || null;
    if (currentLimitBar && currentSession) saveLimitBar(currentSession, currentLimitBar);
    renderCurrent();
    return currentLimitBar ? { provider: limitProvider(), bar: currentLimitBar } : null;
  }
  function restoreFiveHourRateLimit(sessionName) {
    currentSession = String(sessionName || '').trim();
    currentLimitBar = loadLimitBar(currentSession);
    renderCurrent();
    return currentLimitBar;
  }

  // Re-render at the 5h reset so a stale countdown refreshes. The bar is NOT
  // cleared (unlike the old single-window behaviour): it still shows the weekly
  // windows, which have not reset.
  function scheduleExpiry() {
    if (expiryTimer) { global.clearTimeout?.(expiryTimer); expiryTimer = null; }
    const resetsAt = finiteNumber(currentLimitInfo && currentLimitInfo.resetsAt);
    if (resetsAt !== null && resetsAt > Date.now()) {
      const delay = Math.max(1, Math.min(2_147_000_000, resetsAt - Date.now() + 50));
      expiryTimer = global.setTimeout?.(() => renderCurrent(), delay);
      if (expiryTimer && typeof expiryTimer.unref === 'function') expiryTimer.unref();
    }
  }

  // ── Prepaid balance (DeepSeek) — a different species, its own chip ──
  // Money remaining, no reset window, arrives on a WS event already rendered.
  let currentBalanceBar = null;
  function balanceStorageKey(session) { return `multicc.usageBalance.${String(session || '').trim()}`; }
  function balanceMatchesCli(cli) {
    return cli === 'codex' || cli === 'opencode' || isDeepseekBaseUrl(currentProviderBaseUrl);
  }
  function renderBalance() {
    const element = global.document?.getElementById?.('usage-balance-bar');
    if (!element) return;
    if (!(currentBalanceBar && balanceMatchesCli(currentCli))) { hideBar(element); return; }
    paintBar(element, currentBalanceBar);
  }
  function consumeBalanceEvent(info, sessionName, bar) {
    currentSession = String(sessionName || currentSession || '').trim();
    currentBalanceBar = bar || null;
    if (currentBalanceBar && currentSession) {
      const s = browserStorage();
      if (s) { try { s.setItem(balanceStorageKey(currentSession), JSON.stringify(currentBalanceBar)); } catch (_) {} }
    }
    renderBalance();
    return currentBalanceBar;
  }
  function restoreBalance(sessionName) {
    currentSession = String(sessionName || currentSession || '').trim();
    const s = browserStorage();
    if (s) { try { currentBalanceBar = JSON.parse(s.getItem(balanceStorageKey(currentSession)) || 'null'); } catch (_) { currentBalanceBar = null; } }
    renderBalance();
    return currentBalanceBar;
  }

  // ── CLI / provider switching ──
  function renderAll() {
    renderCurrent(); renderBalance();
    opencodeSlot.render(); qoderSlot.render(); codexSlot.render();
    arkSlot.render(); zhipuSlot.render(); kimiSlot.render();
  }
  async function restoreServerQuotaBars() {
    if (!global.document || !global.location) return null;
    try {
      const res = await fetch(`/api/quota/bars/state${quotaBarParams({ host: hostFromBaseUrl(currentProviderBaseUrl) })}`, { credentials: 'same-origin' });
      const data = await res.json();
      const bars = data && data.bars && typeof data.bars === 'object' ? data.bars : null;
      if (!bars) return null;
      opencodeSlot.setCurrent(cacheEntryToResponse(bars.opencode));
      qoderSlot.setCurrent(cacheEntryToResponse(bars.qoder));
      codexSlot.setCurrent(cacheEntryToResponse(bars.codex));
      arkSlot.setCurrent(cacheEntryToResponse(bars.ark));
      zhipuSlot.setCurrent(cacheEntryToResponse(bars.zhipu));
      kimiSlot.setCurrent(cacheEntryToResponse(bars.kimi));
      const claude = cacheEntryToResponse(bars.claude);
      if (claude) currentClaudeUsage = claude;
      renderAll();
      return data;
    } catch (_) {
      return null;
    }
  }
  function setCli(cli) {
    const next = String(cli || 'claude');
    // The first call is the page reporting which CLI it loaded, not a switch —
    // page load must stay as cheap as it is today (restore from localStorage).
    const changed = cliInitialized && next !== currentCli;
    cliInitialized = true; currentCli = next;
    renderAll();
    if (!changed) return;
    // Switching CLI switches the account whose quota is on screen. Exactly one
    // fetch per real switch, for the one bar that just became visible.
    if (next === 'opencode') { opencodeSlot.clearBackoff(); opencodeSlot.refresh(); }
    else if (next === 'qoder') { qoderSlot.clearBackoff(); qoderSlot.refresh(); }
    else if (next === 'codex') { codexSlot.clearBackoff(); codexSlot.refresh(); }
    // No claude auto-fetch on switch: its 5h is passive (the live event) and the
    // weekly scrape is fetch-on-click, so an auto-scrape would pop needs_login /
    // unavailable states the user did not ask for.
  }
  function setProviderBaseUrl(baseUrl) {
    const next = String(baseUrl || '');
    const changed = next !== currentProviderBaseUrl;
    currentProviderBaseUrl = next;
    renderCurrent(); renderBalance();
    arkSlot.render(); zhipuSlot.render(); kimiSlot.render();
    // A provider switch must immediately reflect the new provider's quota: pull
    // fresh data for whichever vendor the new baseUrl points at. The error
    // backoff is cleared first — it exists to stop a broken endpoint from being
    // hammered, not to stall an explicit user action.
    if (changed) {
      arkSlot.clearBackoff(); zhipuSlot.clearBackoff(); kimiSlot.clearBackoff();
      restoreServerQuotaBars();
      arkSlot.refresh(); zhipuSlot.refresh(); kimiSlot.refresh();
    }
  }

  const api = Object.freeze({
    setCli, setProviderBaseUrl,
    consumeRateLimitEvent, consumeBalanceEvent,
    restoreFiveHourRateLimit, restoreBalance, restoreClaudeUsage,
    refreshClaudeUsage,
    refreshOpenCodeQuota: (...a) => opencodeSlot.refresh(...a),
    restoreOpenCodeQuota: () => opencodeSlot.restore(),
    refreshQoderQuota: (...a) => qoderSlot.refresh(...a),
    restoreQoderQuota: () => qoderSlot.restore(),
    refreshCodexQuota: (...a) => codexSlot.refresh(...a),
    restoreCodexQuota: () => codexSlot.restore(),
    refreshArkQuota: (...a) => arkSlot.refresh(...a),
    restoreArkQuota: () => arkSlot.restore(),
    refreshZhipuQuota: (...a) => zhipuSlot.refresh(...a),
    restoreZhipuQuota: () => zhipuSlot.restore(),
    refreshKimiQuota: (...a) => kimiSlot.refresh(...a),
    restoreKimiQuota: () => kimiSlot.restore(),
    restoreServerQuotaBars,
    // Predicates kept public: the app mirrors them and tests assert them.
    isZhipuBaseUrl, isKimiBaseUrl, isArkBaseUrl, isDeepseekBaseUrl, isClaudeProvider,
    arkPlanFromBaseUrl, providerMatchesCli, quotaBarClick,
    // The resolver is exposed so tests can drive the shared golden fixtures
    // through the same expansion path the browser uses.
    QuotaBarView,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRateLimit = api;
  if (global.document && global.location) {
    const sess = new URLSearchParams(global.location.search).get('session') || '';
    restoreFiveHourRateLimit(sess);
    restoreBalance(sess);
    opencodeSlot.restore(); qoderSlot.restore(); codexSlot.restore();
    arkSlot.restore(); zhipuSlot.restore(); kimiSlot.restore();
    restoreClaudeUsage();
    bootstrapIdleBars();
    restoreServerQuotaBars();
  }
})(typeof window !== 'undefined' ? window : globalThis);

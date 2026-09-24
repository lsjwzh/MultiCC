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
  // The host is the ONE string both ends must agree on byte for byte (it is a
  // fixture cell and it feeds `?host=` params + storage keys), and the two
  // platforms serialize an IPv6 host differently: WHATWG `URL.hostname` keeps
  // the brackets (`[::1]`) while Dart's `Uri.host` drops them (`::1`). Strip
  // them, so the same baseUrl yields the same host everywhere.
  function hostFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return '';
    try { return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return ''; }
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
  // A borrowed (借道) provider's baseUrl points at ANOTHER multicc's protocol
  // relay, not at a vendor host. The borrowed account's windows/balances arrive
  // as WS events the server already rendered (the relay quota pass-through), so
  // the gate for them is the relay's PROTOCOL, not which vendor hides behind it.
  // Loopback relay paths are this host's own CPR plumbing, never a borrowed
  // provider — mirrors the server's relayRouteFromBaseUrl recognition.
  function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }
  function relayProtocolFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    let parsed;
    try { parsed = new URL(baseUrl); } catch (_) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (isLoopbackHost(parsed.hostname)) return null;
    let segments;
    try { segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch (_) { return null; }
    if (segments[0] === 'claude-proxy' && segments[1] && segments[2] === 'remote') return 'claude';
    if (segments[0] === 'codex-proxy' && segments[1]) return 'codex';
    return null;
  }
  function isRelayBaseUrl(baseUrl) { return relayProtocolFromBaseUrl(baseUrl) !== null; }
  function isCodexCli(cli) { return cli === 'codex' || cli === 'codex-exp'; }
  // Claude Code and the Claude Agent SDK build share one account, one
  // provider pool and one subscription, so every Claude-specific bar belongs to
  // both. Gating this on the literal 'claude' hid the whole subscription bar
  // under claude-exp: the exact-Provider branch only fired after a passive
  // window event, so before the first turn the bar was simply missing.
  function isClaudeCli(cli) { return cli === 'claude' || cli === 'claude-exp'; }
  function arkPlanFromBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    try { const p = new URL(baseUrl).pathname.toLowerCase(); if (p.includes('/coding')) return 'coding-plan'; if (p.includes('/plan')) return 'agent-plan'; } catch (_) {}
    return null;
  }
  // A window limit shows only under a CLI that could have produced it: Claude 5h
  // under the Claude family (claude / claude-exp) or opencode, GLM 5h under
  // codex/opencode (and the claude CLI when pointed at a Zhipu endpoint), Codex
  // weekly under the Codex family or opencode, and OpenCode Go's own window only
  // under opencode.
  // The gate is a PURE function of (kind, cli, baseUrl) so the app's mirror and
  // the fixture-driven parity test can drive the exact same code the browser
  // runs; the exported one-arg-less wrapper below only supplies the live
  // provider. Keeping the baseUrl implicit is what let the app's copy drift
  // unnoticed until a borrowed window went missing on web only.
  function providerMatchesCliIn(provider, cli, baseUrl) {
    if (provider === 'opencode') return cli === 'opencode';
    // 借道 provider：窗口余量经 relay 透传到达，协议对上 CLI 即属于当前会话。
    // 协议按 CLI 家族判，不按字面 id：claude-exp / codex-exp 与各自的正式 CLI
    // 共用同一个账号、同一个 provider 池，说的也是同一个 relay 协议面，所以
    // 借道窗口必须在 -exp 会话里显示（此前 `cli === relayProtocol` 把它们全挡了）。
    const relayProtocol = relayProtocolFromBaseUrl(baseUrl);
    if (relayProtocol) {
      const familyMatches = relayProtocol === 'codex' ? isCodexCli(cli) : isClaudeCli(cli);
      return familyMatches || cli === 'opencode';
    }
    if (provider === 'glm' || provider === 'codex') {
      if (isCodexCli(cli) || cli === 'opencode') return true;
      return provider === 'glm' && isZhipuBaseUrl(baseUrl);
    }
    return isClaudeCli(cli) || cli === 'opencode';
  }
  function providerMatchesCli(provider, cli) {
    return providerMatchesCliIn(provider, cli, currentProviderBaseUrl);
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
  // opencode / qoder / codex / kimi share one lifecycle: a 24h
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
    let revision = 0;
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
      const requestRevision = revision;
      inFlight = true; render();
      try {
        const res = await fetch(opts.getUrl(), { method: 'POST', credentials: 'same-origin' });
        let data = null; try { data = await res.json(); } catch (_) {}
        if (requestRevision !== revision) return current;
        if (!data) data = { status: 'unavailable', error: 'invalid response' };
        current = data;
        if (data.status === 'ok') { lastErrorAt = 0; store.save(data); }
        else lastErrorAt = Date.now();
      } catch (_) {
        if (requestRevision !== revision) return current;
        lastErrorAt = Date.now();
        current = { status: 'unavailable', error: 'fetch failed' };
      } finally { if (requestRevision === revision) inFlight = false; }
      render();
      return current;
    }
    function restore() { current = store.load(); render(); return current; }
    function setCurrent(v) { current = v || null; lastErrorAt = 0; render(); return current; }
    return {
      kind: opts.kind, render, refresh, restore, setCurrent,
      reset() { revision += 1; current = null; inFlight = false; lastErrorAt = 0; },
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
    // /api/codex/quota is a legacy fallback for sessions that do not expose a
    // concrete Provider identity. Once a Provider is known, its own balance
    // endpoint decides the bar species (Codex window / GLM window / money / no
    // bar). Neither the Codex CLI nor a URL shape may select this host account.
    isVisible: () => isCodexCli(currentCli) && !currentProviderId && !currentProviderPending,
    getUrl: () => `/api/quota/bars/refresh${quotaBarParams({ kind: 'codex' })}`,
    storageKey: 'multicc.codex.quota.v1',
  });
  // No zhipu slot: its quota surface is the provider's own API key, which the
  // generic Provider balance query already polls — a dedicated slot only
  // duplicated the same glm-monitor windows in a second bar.
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
  let currentProviderId = '';
  let currentProviderAppType = '';
  let currentProviderPending = false;
  let providerRevision = 0;
  let providerIdentityKnown = false;
  let currentSession = '';
  let cliInitialized = false;
  let currentLimitInfo = null;   // raw rate_limit_info (provider/resetsAt for gating + timer)
  let currentLimitBar = null;    // server-rendered bar from the rate_limit_event
  let currentClaudeUsage = null; // scrape response (its .bar is the full Claude bar)
  let currentProviderWindowBar = null;
  let claudeUsageFetchInFlight = false;
  let claudeLoginPending = false;
  let claudeLastErrorAt = 0;
  const CLAUDE_BACKOFF = 60_000;
  const claudeStore = makeStorage('multicc.claude.usage.v1');
  let expiryTimer = null;

  function limitStorageKey(session) { const s = String(session || '').trim(); return s ? `multicc:claude-rate-limit:v1:${s}` : ''; }
  // The window bar is stored WITH the provider identity that produced it. The
  // display gate is providerMatchesCli(info.provider, cli) — a bar restored
  // without its info could only ever paint through the exact-Provider branch,
  // so a borrowed (借道) window vanished on every page load even though its text
  // was sitting in localStorage.
  function saveLimitBar(session, bar, info) {
    const k = limitStorageKey(session), s = browserStorage(); if (!s || !k || !bar) return;
    try { s.setItem(k, JSON.stringify({ bar, info: info || null })); } catch (_) {}
  }
  // Returns { bar, info } for both the current record and the legacy bare-bar
  // shape written before the identity was persisted (a bar has no `bar` field,
  // so the two are unambiguous).
  function loadLimitBar(session) {
    const k = limitStorageKey(session), s = browserStorage(); if (!s || !k) return null;
    let raw = null;
    try { raw = JSON.parse(s.getItem(k) || 'null'); } catch (_) { return null; }
    if (!raw || typeof raw !== 'object') return null;
    if (raw.bar && typeof raw.bar === 'object') {
      return { bar: raw.bar, info: raw.info && typeof raw.info === 'object' ? raw.info : null };
    }
    if (!raw.text) return null;
    return { bar: raw, info: null };
  }
  function limitProvider() {
    if (!currentLimitInfo) return null;
    const p = currentLimitInfo.provider;
    return p === 'glm' ? 'glm' : p === 'codex' ? 'codex' : p === 'opencode' ? 'opencode' : 'claude';
  }

  function activeProviderMatchesCli() {
    if (currentCli === 'opencode') return true;
    return currentProviderAppType === (isCodexCli(currentCli) ? 'codex' : 'claude');
  }

  function renderCurrent() {
    const element = global.document?.getElementById?.('claude-rate-limit-bar');
    if (!element) return;
    const claudeProvider = isClaudeProvider(currentProviderBaseUrl);
    const provider = limitProvider();
    let bar = null, state, onBarClick = null;
    if (currentProviderWindowBar && activeProviderMatchesCli()) {
      // Exact Provider query wins over CLI heuristics and passive events. This
      // is what lets a Codex session correctly show GLM/borrowed/official quota
      // according to its active Provider rather than the local Codex account —
      // including Zhipu providers, whose windows come only from this query now
      // that the dedicated vendor slot is gone.
      bar = currentProviderWindowBar;
      // The render's trailing '⟳' segment promises a refresh; wire it to the
      // same query that produced the bar.
      onBarClick = () => refreshProviderLimit();
    } else if (isClaudeCli(currentCli) && claudeProvider) {
      // Claude subscription: the scrape (full, with weekly) is authoritative;
      // before it lands the live 5h event or the idle render stands in.
      bar = (currentClaudeUsage && currentClaudeUsage.bar) || currentLimitBar || idleBarFor('claude');
      state = claudeUsageFetchInFlight ? 'fetching' : (claudeLoginPending ? 'login_pending' : undefined);
      onBarClick = (view) => claudeBarClick(view);
    } else if (provider && providerMatchesCli(provider, currentCli)) {
      bar = currentLimitBar;
    }
    const view = paintBar(element, bar, state);
    if (view) {
      element.style.cursor = onBarClick ? 'pointer' : '';
      element.onclick = onBarClick ? () => onBarClick(view) : null;
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
    const requestRevision = providerRevision;
    claudeUsageFetchInFlight = true; claudeLoginPending = false; renderCurrent();
    try {
      const res = await fetch(`/api/quota/bars/refresh${quotaBarParams({ kind: 'claude' })}`, { method: 'POST', credentials: 'same-origin' });
      let data = null; try { data = await res.json(); } catch (_) {}
      if (requestRevision !== providerRevision) return currentClaudeUsage;
      if (!data) data = { status: 'unavailable', error: 'invalid response' };
      currentClaudeUsage = data;
      if (data.status === 'ok') { claudeLastErrorAt = 0; claudeStore.save(data); }
      else claudeLastErrorAt = Date.now();
    } catch (_) {
      if (requestRevision !== providerRevision) return currentClaudeUsage;
      claudeLastErrorAt = Date.now();
      currentClaudeUsage = { status: 'unavailable', error: 'fetch failed' };
    } finally { if (requestRevision === providerRevision) claudeUsageFetchInFlight = false; }
    renderCurrent();
    return currentClaudeUsage;
  }
  function restoreClaudeUsage() { currentClaudeUsage = claudeStore.load(); renderCurrent(); return currentClaudeUsage; }

  function consumeRateLimitEvent(info, sessionName, bar) {
    currentSession = String(sessionName || currentSession || '').trim();
    currentLimitInfo = info || null;
    currentLimitBar = bar || null;
    if (currentLimitBar && currentSession) saveLimitBar(currentSession, currentLimitBar, currentLimitInfo);
    renderCurrent();
    return currentLimitBar ? { provider: limitProvider(), bar: currentLimitBar } : null;
  }

  let providerLimitInFlightKey = null;
  async function refreshProviderLimit() {
    if (!currentProviderAppType || !currentProviderId) return null;
    // Click-reachable (the provider window bar's ⟳): one query at a time for a
    // given provider. Keyed on the identity, not a bare flag: a provider switch
    // landing while the previous provider's query is still open must not be
    // suppressed by it — that response belongs to the OLD provider and is
    // dropped by the revision check below, so suppressing the new query left the
    // bar blank (and, since the switch had just wiped the bars, showing nothing)
    // until some unrelated event happened to fetch again.
    const inFlightKey = `${currentProviderAppType}:${currentProviderId}`;
    if (providerLimitInFlightKey === inFlightKey) return null;
    const revision = providerRevision;
    providerLimitInFlightKey = inFlightKey;
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(currentProviderAppType)}/${encodeURIComponent(currentProviderId)}/balance`, { credentials: 'same-origin' });
      const data = await res.json();
      if (revision !== providerRevision || !data || data.ok !== true) return null;
      const kind = data.dto?.kind;
      currentProviderWindowBar = kind === 'window' ? (data.bar || null) : null;
      currentBalanceBar = kind === 'balance' ? (data.bar || null) : null;
      renderAll();
      return kind === 'balance' ? currentBalanceBar : currentProviderWindowBar;
    } catch (_) { return null; }
    finally { if (providerLimitInFlightKey === inFlightKey) providerLimitInFlightKey = null; }
  }
  function restoreFiveHourRateLimit(sessionName) {
    currentSession = String(sessionName || '').trim();
    const record = loadLimitBar(currentSession);
    currentLimitBar = record ? record.bar : null;
    // Only fill in the identity — a live event that already landed is fresher
    // than anything on disk, and its info drives scheduleExpiry().
    if (record && record.info && !currentLimitInfo) currentLimitInfo = record.info;
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
  // Same pure-core split as providerMatchesCliIn: the app mirror takes the
  // baseUrl explicitly, so the contract test needs the same shape here.
  function balanceBarVisibleFor(cli, baseUrl) {
    return isCodexCli(cli) || cli === 'opencode'
      || isDeepseekBaseUrl(baseUrl)
      // 借道 provider 借来的可能是预付费余额（DeepSeek 等），事件由 relay 透传。
      || isRelayBaseUrl(baseUrl);
  }
  function balanceMatchesCli(cli) {
    return balanceBarVisibleFor(cli, currentProviderBaseUrl);
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
    arkSlot.render(); kimiSlot.render();
  }
  async function restoreServerQuotaBars() {
    if (!global.document || !global.location) return null;
    const requestRevision = providerRevision;
    try {
      const res = await fetch(`/api/quota/bars/state${quotaBarParams({ host: hostFromBaseUrl(currentProviderBaseUrl) })}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (requestRevision !== providerRevision) return null;
      const bars = data && data.bars && typeof data.bars === 'object' ? data.bars : null;
      if (!bars) return null;
      opencodeSlot.setCurrent(cacheEntryToResponse(bars.opencode));
      qoderSlot.setCurrent(cacheEntryToResponse(bars.qoder));
      codexSlot.setCurrent(cacheEntryToResponse(bars.codex));
      arkSlot.setCurrent(cacheEntryToResponse(bars.ark));
      kimiSlot.setCurrent(cacheEntryToResponse(bars.kimi));
      const claude = cacheEntryToResponse(bars.claude);
      currentClaudeUsage = claude;
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
    else if (isCodexCli(next)) { codexSlot.clearBackoff(); codexSlot.refresh(); }
    // No claude auto-fetch on switch: its 5h is passive (the live event) and the
    // weekly scrape is fetch-on-click, so an auto-scrape would pop needs_login /
    // unavailable states the user did not ask for.
  }
  function setProviderBaseUrl(baseUrl, providerId = '', providerMeta = null) {
    const next = String(baseUrl || '');
    const nextId = String(providerId || '');
    const meta = providerMeta && typeof providerMeta === 'object' ? providerMeta : {};
    // A relay path still reveals its protocol for old callers. Otherwise the
    // session's concrete provider catalog supplies appType; currentCli is only
    // a compatibility fallback, never the bar-kind decision.
    const nextAppType = String(meta.appType || relayProtocolFromBaseUrl(next)
      || (nextId ? (isCodexCli(currentCli) ? 'codex' : 'claude') : ''));
    const nextPending = meta.pending === true;
    // Like setCli, the FIRST call is the page reporting which provider its
    // session runs on, not a switch — and the restored window bar on screen
    // belongs to exactly that provider. Treating it as a switch deleted the
    // session's persisted passive bar on every page load (借道 providers have no
    // other source before the first turn). A real switch still wipes.
    const firstReport = !providerIdentityKnown;
    providerIdentityKnown = true;
    // The identity is (baseUrl, providerId, appType) — and nothing else.
    // `pending` is ROUTING state: it only says auto-selection has not picked a
    // route yet. Folding it into the identity made a pending flip wipe the bars
    // of the identity still on screen and delete their persisted copies, i.e.
    // the same "the bar vanished" failure this file has been fixed for twice
    // already (a borrowed provider has no other source until a turn runs).
    const changed = !firstReport && (next !== currentProviderBaseUrl || nextId !== currentProviderId
      || nextAppType !== currentProviderAppType);
    const pendingFlipped = !firstReport && nextPending !== currentProviderPending;
    currentProviderBaseUrl = next;
    currentProviderId = nextId;
    currentProviderAppType = nextAppType;
    currentProviderPending = nextPending;
    // Both a first report and a real switch invalidate whatever is in flight
    // for the identity that was current a moment ago (the restore at load time
    // already fired its own queries); only a switch may discard what is on
    // screen. A pending flip is not a switch, but it does re-decide the route,
    // so data already in flight for it must not paint either — hence the
    // revision bump without the wipe.
    if (firstReport || changed || pendingFlipped) providerRevision += 1;
    if (changed) {
      // Different accounts can share a baseUrl. Drop every provider-owned
      // display before fetching the new selection.
      currentLimitInfo = null; currentLimitBar = null; currentProviderWindowBar = null; currentBalanceBar = null;
      currentClaudeUsage = null; claudeUsageFetchInFlight = false;
      claudeLoginPending = false; claudeLastErrorAt = 0;
      arkSlot.reset(); kimiSlot.reset();
      if (currentSession) {
        const s = browserStorage();
        if (s) {
          for (const key of [limitStorageKey(currentSession), balanceStorageKey(currentSession)]) {
            try { s.removeItem(key); } catch (_) {}
          }
        }
      }
      scheduleExpiry();
    }
    renderAll();
    // A provider switch must immediately reflect the new provider's quota: pull
    // fresh data for whichever vendor the new baseUrl points at. The error
    // backoff is cleared first — it exists to stop a broken endpoint from being
    // hammered, not to stall an explicit user action. The first report fetches
    // too (it used to, as a "change" from the empty default): the identity is
    // only known now, so this is the page's first chance to query it.
    if (firstReport || changed) {
      arkSlot.clearBackoff(); kimiSlot.clearBackoff();
      restoreServerQuotaBars();
      refreshProviderLimit();
      arkSlot.refresh(); kimiSlot.refresh();
    }
  }

  const api = Object.freeze({
    setCli, setProviderBaseUrl,
    consumeRateLimitEvent, consumeBalanceEvent,
    restoreFiveHourRateLimit, restoreBalance, restoreClaudeUsage,
    refreshClaudeUsage,
    refreshProviderLimit,
    // Compatibility alias for older callers; it now queries every concrete
    // Provider, not only relay URLs.
    refreshRelayBar: refreshProviderLimit,
    refreshOpenCodeQuota: (...a) => opencodeSlot.refresh(...a),
    restoreOpenCodeQuota: () => opencodeSlot.restore(),
    refreshQoderQuota: (...a) => qoderSlot.refresh(...a),
    restoreQoderQuota: () => qoderSlot.restore(),
    refreshCodexQuota: (...a) => codexSlot.refresh(...a),
    restoreCodexQuota: () => codexSlot.restore(),
    refreshArkQuota: (...a) => arkSlot.refresh(...a),
    restoreArkQuota: () => arkSlot.restore(),
    refreshKimiQuota: (...a) => kimiSlot.refresh(...a),
    restoreKimiQuota: () => kimiSlot.restore(),
    restoreServerQuotaBars,
    // Predicates kept public: the app mirrors them and tests assert them.
    isZhipuBaseUrl, isKimiBaseUrl, isArkBaseUrl, isDeepseekBaseUrl, isClaudeProvider,
    isRelayBaseUrl, relayProtocolFromBaseUrl,
    arkPlanFromBaseUrl, providerMatchesCli, quotaBarClick,
    // Pure (baseUrl-explicit) forms: the app mirror's exact counterparts, and
    // the functions tests/test-quota-gating-parity.js freezes into the shared
    // gating fixture that app/test/quota_gating_parity_test.dart also reads.
    providerMatchesCliIn, balanceBarVisibleFor, balanceMatchesCli, hostFromBaseUrl,
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
    arkSlot.restore(); kimiSlot.restore();
    restoreClaudeUsage();
    bootstrapIdleBars();
    restoreServerQuotaBars();
  }
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';
// Adapters that turn the various live limit producers into cache entries.
//
// Every producer emits a slightly different shape — the passive
// rate_limit_event DTO, the poller's window/balance DTO, a vendor route's JSON
// body, or the provider-balance per-provider result. This module normalizes
// them all onto the provider-limit-cache contract:
//
//   - window DTOs      → structured segments (window / remaining% / resetsAtMs)
//   - balance DTOs     → structured balance (available / total / currency)
//   - vendor route body → rendered via renderQuotaBar → compact summary text
//
// Identity resolution is deliberately conservative: a session name resolves to
// its current provider, a host/baseUrl matches every provider that shares it,
// and a record is only written when identity is unambiguous. Producers without
// a clean provider identity (account-level Qoder / OpenCode Go / Codex OAuth
// quotas) are intentionally skipped — their data would otherwise be misattached.

const {
  normalizeWindowEvent,
  windowEventBar,
  normalizeBalance,
  balanceBar,
  renderQuotaBar,
  compactBarText,
} = require('./quota-bar-view');

const PROVIDER_FAILURE_COOLDOWN_MS = 5 * 60_000;

// Poller utilization is a 0..1 fraction; the cache stores percent (0..100).
function windowPercent(utilization) {
  const value = Number(utilization);
  if (utilization == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value * 100)) * 1000) / 1000;
}

// Same epoch-seconds-or-ms tolerance as the window bar's resetsAtMs.
function resetMs(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number < 10_000_000_000 ? number * 1000 : number);
}

function createLimitRecorder({ cache, persistedSessions, providers, now = Date.now } = {}) {
  if (!cache || !persistedSessions || !providers) {
    throw new TypeError('[limit-cache-recorder] requires { cache, persistedSessions, providers }');
  }

  // Session → (appType, providerId). The provider may be missing/changed since
  // the event was produced; resolve at record time so renames self-heal.
  function appTypeForSession(sessionName) {
    if (!sessionName) return null;
    const rec = persistedSessions.get(String(sessionName));
    if (!rec || !rec.provider) return null;
    const appType = providers.appTypeForCli(rec.cli || 'claude');
    if (!appType) return null;
    return { appType, providerId: rec.provider };
  }

  function explicitProviderIdentity(providerId) {
    if (!providerId || typeof providers.getProvider !== 'function') return null;
    let provider;
    try { provider = providers.getProvider(undefined, String(providerId)); } catch (_) { return null; }
    if (!provider || !provider.id || !provider.appType) return null;
    return { appType: String(provider.appType), providerId: String(provider.id) };
  }

  // A window/balance DTO → full structured summary. This is the primary path:
  // the poller, the passive proxy broadcaster, and the log watchdog all feed it.
  function recordDto(appType, providerId, dto) {
    if (!dto || typeof dto !== 'object') return null;
    const at = now();
    if (dto.kind === 'window') {
      const normalized = normalizeWindowEvent(dto, at);
      if (!normalized) return null;
      const bar = windowEventBar(normalized);
      const summary = {
        kind: 'window',
        provider: normalized.provider,
        status: normalized.status,
        usedPercentage: normalized.usedPercentage,
        resetsAtMs: normalized.resetsAtMs,
        observedAtMs: normalized.observedAtMs,
      };
      // A plan with a second, longer window (GLM: 5h + weekly) is blocked by
      // whichever runs out first, so both are kept. Dropping the weekly one
      // once made a weekly-exhausted plan read as "5h 0% used → available".
      const weekly = windowPercent(dto.weeklyUtilization);
      if (weekly !== null) {
        summary.windows = [
          { label: '5h', usedPercent: normalized.usedPercentage, resetMs: normalized.resetsAtMs },
          { label: '1wk', usedPercent: weekly, resetMs: resetMs(dto.weeklyResetsAt) },
        ];
      }
      return cache.record(appType, providerId, {
        kind: 'window',
        summary,
        summaryText: compactBarText(bar ? bar.text : ''),
        barText: bar ? bar.text : null,
        fetchedAt: normalized.observedAtMs,
      });
    }
    if (dto.kind === 'balance') {
      const normalized = normalizeBalance(dto);
      if (!normalized) return null;
      const bar = balanceBar(normalized);
      const summary = {
        kind: 'balance',
        provider: normalized.provider,
        available: normalized.available,
        total: normalized.total,
        currency: normalized.currency,
      };
      return cache.record(appType, providerId, {
        kind: 'balance',
        summary,
        summaryText: compactBarText(bar ? bar.text : ''),
        barText: bar ? bar.text : null,
        fetchedAt: at,
      });
    }
    return null;
  }

  // Record a session-derived DTO (poller / passive proxy / watchdog).
  function recordSession(sessionName, dto, providerId) {
    const id = providerId ? explicitProviderIdentity(providerId) : appTypeForSession(sessionName);
    if (!id) return null;
    return recordDto(id.appType, id.providerId, dto);
  }

  // Provider-balance per-provider result: { ok:true, dto } | { ok:false, reason, detail? }.
  // `detail` (when present) is the layered root cause — HTTP status + body
  // snippet or the OS errno chain — and outranks the generic reason so the
  // cache's last_error column records why, not just that, a fetch failed.
  function recordProvider(appType, providerId, result) {
    if (!providerId) return null;
    if (!result || result.ok === false) {
      cache.recordFailure(appType, providerId, {
        error: result && (result.detail || result.reason || result.error)
          ? String(result.detail || result.reason || result.error).slice(0, 200)
          : null,
        code: result && result.code ? String(result.code) : null,
      });
      return null;
    }
    if (result.dto) return recordDto(appType, providerId, result.dto);
    if (result.summaryText) {
      return cache.record(appType, providerId, {
        kind: result.kind || 'quota',
        summary: result.summary || null,
        summaryText: result.summaryText,
        barText: result.barText || null,
        fetchedAt: result.fetchedAt || now(),
      });
    }
    return null;
  }

  // The quota runtime's real per-provider re-read, (appType, id) => Promise.
  // Wired after the balance routes exist; until then a rejection only records.
  let refreshProvider = null;
  function setRefresher(fn) {
    refreshProvider = typeof fn === 'function' ? fn : null;
  }

  // Store only a bounded availability cooldown. Response bodies and
  // credentials are intentionally excluded from this durable record.
  // The cooldown is a placeholder: a 429 also triggers a real quota re-read,
  // and whatever that reading says replaces it (the latest reading wins).
  function recordProviderFailure({
    sessionId, providerId, category, httpStatus, blockedUntilMs,
  } = {}) {
    const identity = providerId
      ? explicitProviderIdentity(providerId)
      : appTypeForSession(sessionId);
    if (!identity) return null;
    const recorded = recordCooldown(identity, { category, httpStatus, blockedUntilMs });
    if (refreshProvider) {
      try {
        Promise.resolve(refreshProvider(identity.appType, identity.providerId)).catch(() => {});
      } catch (_) { /* a refresh must never break the proxy outcome path */ }
    }
    return recorded;
  }

  function recordCooldown(identity, { category, httpStatus, blockedUntilMs }) {
    const observedAtMs = Number(now());
    const requestedUntil = Number(blockedUntilMs);
    const safeBlockedUntilMs = Number.isFinite(requestedUntil) && requestedUntil > observedAtMs
      ? Math.trunc(requestedUntil) : observedAtMs + PROVIDER_FAILURE_COOLDOWN_MS;
    const status = Number(httpStatus);
    return cache.record(identity.appType, identity.providerId, {
      kind: 'availability',
      summary: {
        kind: 'availability',
        status: 'rejected',
        category: String(category || 'provider_transient').slice(0, 80),
        httpStatus: Number.isInteger(status) ? status : null,
        blockedUntilMs: safeBlockedUntilMs,
        observedAtMs,
      },
      summaryText: '',
      barText: null,
      fetchedAt: observedAtMs,
    });
  }

  // Host → every provider whose limit target resolves to that upstream host.
  function resolveByHost(host) {
    if (!host || typeof host !== 'string') return [];
    const want = host.toLowerCase();
    const ids = [];
    for (const appType of ['claude', 'codex']) {
      for (const p of providers.listProviders(appType)) {
        const t = providers.getProviderLimitTarget(appType, p.id);
        if (t && t.host && t.host.toLowerCase() === want) ids.push({ appType, providerId: p.id });
      }
    }
    return ids;
  }

  // baseUrl → every provider whose summarized baseUrl matches on host (+ path
  // prefix). Used by routes that only know the URL they were called with.
  function resolveByBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return [];
    let want;
    try { want = new URL(baseUrl); } catch (_) { return []; }
    const wantHost = want.host.toLowerCase();
    const wantPath = want.pathname.toLowerCase().replace(/\/+$/, '');
    const ids = [];
    for (const appType of ['claude', 'codex']) {
      for (const p of providers.listProviders(appType)) {
        const s = p.baseUrl;
        if (!s) continue;
        let pu;
        try { pu = new URL(s); } catch (_) { continue; }
        if (pu.host.toLowerCase() !== wantHost) continue;
        const pp = pu.pathname.toLowerCase().replace(/\/+$/, '');
        if (!wantPath || !pp || wantPath === pp || wantPath.startsWith(pp) || pp.startsWith(wantPath)) {
          ids.push({ appType, providerId: p.id });
        }
      }
    }
    return ids;
  }

  // Vendor route result: `{ kind, result, session?, baseUrl?, host?, opts? }`.
  // Renders the bar server-side, then records a compact summary against every
  // matching provider identity. `opts` is forwarded to renderQuotaBar (e.g.
  // `{ cached }` for kimi). Failures only record diagnostics for an explicit
  // session identity; without one they are skipped entirely (never overwriting
  // a last good value, which satisfies the preserve-on-failure contract for
  // free).
  function recordVendor({ kind, result, session = '', baseUrl = '', host = '', opts }) {
    if (!result) return 0;
    const ids = [];
    if (session) {
      const sid = appTypeForSession(session);
      if (sid) ids.push(sid);
    }
    if (host) for (const m of resolveByHost(host)) {
      if (!ids.some(x => x.appType === m.appType && x.providerId === m.providerId)) ids.push(m);
    }
    if (baseUrl) for (const m of resolveByBaseUrl(baseUrl)) {
      if (!ids.some(x => x.appType === m.appType && x.providerId === m.providerId)) ids.push(m);
    }
    if (!ids.length) return 0;

    if (result.status !== 'ok' || result.ok === false) {
      // Diagnostics only when identity is explicit (session), and never a
      // data-overwriting write.
      if (ids.length === 1 && session) {
        cache.recordFailure(ids[0].appType, ids[0].providerId, {
          error: String(result.reason || result.error || 'fetch failed').slice(0, 200),
        });
      }
      return 0;
    }

    let bar = null;
    try { bar = renderQuotaBar(kind, result, { baseUrl, ...(opts || {}) }); } catch (_) { bar = null; }
    const summaryText = compactBarText(bar ? bar.text : '');
    let n = 0;
    for (const m of ids) {
      cache.record(m.appType, m.providerId, {
        kind,
        summary: { kind, status: 'ok', fetchedAt: result.fetchedAt || null },
        summaryText,
        barText: bar ? bar.text : null,
        fetchedAt: result.fetchedAt || now(),
      });
      n += 1;
    }
    return n;
  }

  // Claude usage-page scrape result: `{ status:'ok', fetchedAt, summary:[{window,
  // label, usedPercent, resetMs}] }`. Claude's bar is a merge of the passive 5h
  // window and the scraped weekly/monthly rows — record the merged bar text plus
  // the structured windows so the picker shows what the bar showed.
  function recordClaude(session, result, barText) {
    const id = appTypeForSession(session);
    if (!id) return null;
    if (!result || result.status !== 'ok') {
      cache.recordFailure(id.appType, id.providerId, {
        error: String((result && result.error) || 'claude usage unavailable').slice(0, 200),
      });
      return null;
    }
    const windows = Array.isArray(result.summary)
      ? result.summary.map(w => ({
          window: w.window || null,
          label: w.label || null,
          usedPercent: w.usedPercent != null ? w.usedPercent : null,
          resetMs: w.resetMs != null ? w.resetMs : null,
        }))
      : [];
    return cache.record(id.appType, id.providerId, {
      kind: 'claude',
      summary: { kind: 'claude', status: 'ok', fetchedAt: result.fetchedAt || now(), windows },
      summaryText: compactBarText(barText),
      barText: barText || null,
      fetchedAt: result.fetchedAt || now(),
    });
  }

  // Per-account official usage (one provider per signed-in account, see
  // official-catalog.js). The account identity is explicit, so no session
  // lookup: `windows` is [{window, label, usedPercent (0..100), resetMs}].
  // Auto reads these windows to steer between accounts before one runs dry.
  function recordOfficialWindows(appType, providerId, { windows, fetchedAt } = {}) {
    if (!providerId || !Array.isArray(windows)) return null;
    const at = fetchedAt || now();
    const rows = windows.filter(w => w && Number.isFinite(Number(w.usedPercent)));
    const text = rows.map(w => `${w.window || '?'} ${Math.round(Number(w.usedPercent))}%`).join(' · ');
    return cache.record(appType, providerId, {
      kind: 'claude',
      summary: { kind: 'claude', status: 'ok', fetchedAt: at, windows: rows },
      summaryText: compactBarText(text),
      barText: text || null,
      fetchedAt: at,
    });
  }

  // Live identity set (for pruning orphaned cache entries after deletion).
  function liveKeys() {
    const set = new Set();
    for (const appType of ['claude', 'codex']) {
      for (const p of providers.listProviders(appType)) set.add(cache.key(appType, p.id));
    }
    return set;
  }

  return Object.freeze({
    appTypeForSession,
    recordSession,
    recordDto,
    recordProvider,
    recordProviderFailure,
    setRefresher,
    recordVendor,
    recordClaude,
    recordOfficialWindows,
    resolveByHost,
    resolveByBaseUrl,
    liveKeys,
  });
}

module.exports = { createLimitRecorder, PROVIDER_FAILURE_COOLDOWN_MS };

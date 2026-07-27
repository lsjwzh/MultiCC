'use strict';

// GET /api/kimi/quota — fetch Moonshot/Kimi (api.moonshot.cn) prepaid balance for
// every configured Kimi provider.
//
// Kimi has no CLI credential store we can shell out to and no rolling-window
// monitor endpoint (unlike GLM): it is a PREPAID MONEY account, the same species
// as DeepSeek. The API key lives in each provider's settingsConfig, so we scan the
// provider store for accounts whose upstream resolves to the 'kimi-balance'
// strategy (providers.js getProviderLimitTarget) and hit the official balance
// endpoint directly:
//   GET https://api.moonshot.cn/v1/users/me/balance   (Authorization: Bearer <key>)
//   → { code:0, data:{ available_balance, voucher_balance, cash_balance }, status:true }
// Amounts are CNY. There is no window/reset — the value simply persists until the
// next poll overwrites it.
//
// Response:
//   { status:'ok', fetchedAt, sites:[ {host, site, ok, available, voucher, cash, currency} ] }
//   { status:'not_configured' }      — no Kimi provider configured (HTTP 404)
//   { status:'unavailable', sites }  — configured but every fetch failed (HTTP 502)

const providers = require('../providers');
const { keyHash } = require('../usage-limit-poller');

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Human-friendly site label. The product is "Kimi"; the API historically lives on
// api.moonshot.cn. Label by host so a user with both configured can tell them apart.
function siteLabel(host) {
  const h = String(host || '').toLowerCase();
  return h.includes('kimi') ? 'Kimi' : 'Moonshot';
}

// Scan configured providers for Kimi accounts. Deduped by (host, apiKey hash) so
// N sessions sharing one account issue one request — same key the poller uses.
function collectKimiTargets() {
  const targets = [];
  const seen = new Set();
  let summaries = [];
  try { summaries = providers.listProviders() || []; } catch (_) { summaries = []; }
  for (const s of summaries) {
    let t = null;
    try { t = providers.getProviderLimitTarget(s.appType, s.id); } catch (_) { t = null; }
    if (!t || t.strategy !== 'kimi-balance' || !t.apiKey) continue;
    const dedupe = `${t.host}:${keyHash(t.apiKey)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    targets.push(t);
  }
  return targets;
}

// Fetch one account's balance. Best-effort: resolves null on any network/shape
// problem so the caller shows "unavailable" rather than fabricating a number.
async function fetchKimiBalance(target, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${target.host}/v1/users/me/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const data = body && typeof body === 'object' ? body.data : null;
    if (!data || typeof data !== 'object') return null;
    const available = finite(data.available_balance);
    if (available === null && finite(data.voucher_balance) === null && finite(data.cash_balance) === null) {
      return null;
    }
    return {
      available,
      voucher: finite(data.voucher_balance),
      cash: finite(data.cash_balance),
      currency: 'CNY',
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKimiUsage(preferHost, nowMs = Date.now(), deps = {}) {
  const targets = Array.isArray(deps.targets) ? deps.targets : collectKimiTargets();
  const poll = typeof deps.poll === 'function' ? deps.poll : fetchKimiBalance;
  if (!targets.length) return { status: 'not_configured', error: 'no kimi provider configured' };

  // Put the caller's current site first so the frontend can take sites[0].
  const wanted = String(preferHost || '').toLowerCase().trim();
  const ordered = wanted
    ? [...targets.filter((t) => t.host === wanted), ...targets.filter((t) => t.host !== wanted)]
    : targets;

  const sites = await Promise.all(ordered.map(async (t) => {
    let bal = null;
    try { bal = await poll(t); } catch (_) { bal = null; }
    if (!bal) return { host: t.host, site: siteLabel(t.host), ok: false };
    return {
      host: t.host,
      site: siteLabel(t.host),
      ok: true,
      available: bal.available,
      voucher: bal.voucher,
      cash: bal.cash,
      currency: bal.currency || 'CNY',
    };
  }));

  if (!sites.some((s) => s.ok)) {
    return { status: 'unavailable', error: 'all kimi fetches failed', fetchedAt: nowMs, sites };
  }
  return { status: 'ok', fetchedAt: nowMs, sites };
}

function mountKimiQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/kimi/quota', async (req, res) => {
    try {
      const preferHost = typeof req.query?.host === 'string' ? req.query.host : '';
      const result = await fetchKimiUsage(preferHost);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'not_configured' ? 404 : 502;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'kimi quota fetch failed' });
    }
  });
}

module.exports = { mountKimiQuotaRoutes, fetchKimiUsage, fetchKimiBalance, collectKimiTargets, siteLabel };

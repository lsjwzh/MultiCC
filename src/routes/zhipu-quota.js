'use strict';

// GET /api/zhipu/quota — fetch Zhipu official-site (z.ai / bigmodel.cn) coding-plan
// window utilization for every configured Zhipu provider.
//
// Zhipu has no CLI credential store we can shell out to (unlike arkcli): the API
// key lives in each provider's settingsConfig. So we scan the provider store for
// accounts whose upstream resolves to the 'glm-monitor' strategy (providers.js
// getProviderLimitTarget) and reuse the usage-limit poller's adapter
// (pollGlmMonitor) to hit the console's internal window-utilization endpoint:
//   GET https://api.z.ai/api/monitor/usage/quota/limit         (Z.ai)
//   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit  (BigModel)
// Auth is the raw API key with NO Bearer prefix, exactly as glm-monitor does — we
// reuse that adapter verbatim rather than reinventing the request.
//
// Response:
//   { status:'ok', fetchedAt, sites:[ {host, site, ok, period:'5h', usedPercent,
//       windowStatus, resetsAt, weeklyPeriod:'weekly', weeklyUsedPercent, weeklyResetsAt, tier} ] }
//   { status:'not_configured' }      — no Zhipu provider configured (HTTP 404)
//   { status:'unavailable', sites }  — configured but every fetch failed (HTTP 502)

const providers = require('../providers');
const { pollGlmMonitor, keyHash } = require('../usage-limit-poller');

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Human-friendly site label for the bar. api.z.ai is the international site;
// open.bigmodel.cn (and any *.bigmodel.cn console host) is the CN site.
function siteLabel(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'z.ai' || h === 'api.z.ai' || h.endsWith('.z.ai')) return 'Z.ai';
  return 'BigModel';
}

// Scan configured providers for Zhipu official-site accounts. Deduped by
// (host, apiKey hash) so N sessions sharing one account issue one request — the
// same dedup key the usage-limit poller uses.
function collectZhipuTargets() {
  const targets = [];
  const seen = new Set();
  let summaries = [];
  try { summaries = providers.listProviders() || []; } catch (_) { summaries = []; }
  for (const s of summaries) {
    let t = null;
    try { t = providers.getProviderLimitTarget(s.appType, s.id); } catch (_) { t = null; }
    if (!t || t.strategy !== 'glm-monitor' || !t.apiKey) continue;
    const dedupe = `${t.host}:${keyHash(t.apiKey)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    targets.push(t);
  }
  return targets;
}

async function fetchZhipuUsage(preferHost, nowMs = Date.now(), deps = {}) {
  const targets = Array.isArray(deps.targets) ? deps.targets : collectZhipuTargets();
  const poll = typeof deps.poll === 'function' ? deps.poll : pollGlmMonitor;
  if (!targets.length) return { status: 'not_configured', error: 'no zhipu provider configured' };

  // Put the caller's current site first so the frontend can take sites[0].
  const wanted = String(preferHost || '').toLowerCase().trim();
  const ordered = wanted
    ? [...targets.filter((t) => t.host === wanted), ...targets.filter((t) => t.host !== wanted)]
    : targets;

  const sites = await Promise.all(ordered.map(async (t) => {
    let dto = null;
    try { dto = await poll(t, nowMs); } catch (_) { dto = null; }
    if (!dto) return { host: t.host, site: siteLabel(t.host), ok: false };
    const usedPercent = finite(dto.utilization) !== null
      ? Math.round(dto.utilization * 100 * 1000) / 1000
      : null;
    const weeklyUsedPercent = finite(dto.weeklyUtilization) !== null
      ? Math.round(dto.weeklyUtilization * 100 * 1000) / 1000
      : null;
    return {
      host: t.host,
      site: siteLabel(t.host),
      ok: true,
      period: '5h',
      usedPercent,
      windowStatus: dto.status,
      resetsAt: finite(dto.resetsAt),
      weeklyPeriod: weeklyUsedPercent !== null ? 'weekly' : null,
      weeklyUsedPercent,
      weeklyResetsAt: finite(dto.weeklyResetsAt),
      tier: dto.tier || null,
    };
  }));

  if (!sites.some((s) => s.ok)) {
    return { status: 'unavailable', error: 'all zhipu fetches failed', fetchedAt: nowMs, sites };
  }
  return { status: 'ok', fetchedAt: nowMs, sites };
}

function mountZhipuQuotaRoutes(app) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/zhipu/quota', async (req, res) => {
    try {
      const preferHost = typeof req.query?.host === 'string' ? req.query.host : '';
      const result = await fetchZhipuUsage(preferHost);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'not_configured' ? 404 : 502;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'zhipu quota fetch failed' });
    }
  });
}

module.exports = { mountZhipuQuotaRoutes, fetchZhipuUsage, collectZhipuTargets, siteLabel };

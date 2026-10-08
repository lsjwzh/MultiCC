'use strict';

// Quota bar API.
//
// GET  /api/quota/bars/idle    — every bar's before-anything-happened render.
// GET  /api/quota/bars/state   — server-side last-known bar snapshot.
// POST /api/quota/bars/refresh — one refresh intent endpoint for the web client.
//
// A client opening a chat has no quota data: its cache may be empty or expired,
// and the fetches behind these bars are expensive enough (a 30-40s CDP browser
// drive, for several of them) that firing them all on page load would be worse
// than useless. So the bars start as click targets — "OpenCode Go 余量 · ⟳ 刷新"
// — and the words for that state come from the same place as every other bar
// state rather than being duplicated into each client as a hardcoded default.
//
// One request, at load, no vendor work: this handler renders from constants.
//
// `force=1` is the user's own refresh on a bar that has one, and only claude
// reads it: its refresh is the expensive one, so a caller that does not ask for
// it is answered from that account's cache instead of a browser (see
// ../quota/claude-usage-queue.js).

const { idleQuotaBars } = require('../quota/quota-bar-view');
const { renderClaudeBar } = require('../quota/claude-bar-state');
const { claudeUsageKey, readClaudeUsage, enqueueClaudeUsage } = require('../quota/claude-usage-queue');

const REFRESH_KINDS = new Set(['opencode', 'qoder', 'codex', 'claude', 'ark', 'kimi']);

function statusCodeFor(status) {
  // 'idle' is the claude cache having no reading for this account yet — not an
  // error, and not a fetch either (nothing was asked of any upstream).
  if (status === 'ok' || status === 'idle') return 200;
  if (status === 'needs_login' || status === 'no_auth' || status === 'needs_auth') return 401;
  if (status === 'chrome_unavailable' || status === 'needs_install') return 503;
  return 500;
}

function text(value, max = 400) {
  const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return out.length > max ? out.slice(0, max) : out;
}

function requestInput(req) {
  const force = String(req.body?.force || req.query?.force || '');
  return {
    kind: text(req.body?.kind || req.query?.kind, 40).toLowerCase(),
    session: text(req.body?.session || req.query?.session, 180),
    baseUrl: text(req.body?.baseUrl || req.query?.baseUrl, 2048),
    host: text(req.body?.host || req.query?.host, 160).toLowerCase(),
    // The user's own refresh (the bar's ⟳). Only claude reads it: every other
    // kind's endpoint is a cheap query, but claude's is a 30-40s browser drive
    // that must not be started by a page merely opening — see
    // ../quota/claude-usage-queue.js.
    force: force === '1' || force === 'true',
  };
}

function defaultDeps() {
  const { fetchOpenCodeUsage } = require('./opencode-quota');
  const { fetchQoderUsage } = require('./qoder-quota');
  const { fetchCodexUsage } = require('./codex-quota');
  const { fetchArkUsage } = require('./ark-quota');
  const { fetchKimiUsage } = require('./kimi-quota');
  const { renderQuotaBar } = require('../quota/quota-bar-view');
  // No fetchClaudeUsage here: claude's fetcher is the cache's, not this route's
  // (see the claude branch of refresh below). Requiring it would also drag
  // chrome-cdp into every quota bar kind.
  return {
    fetchOpenCodeUsage,
    fetchQoderUsage,
    fetchCodexUsage,
    fetchArkUsage,
    fetchKimiUsage,
    renderQuotaBar,
  };
}

function createQuotaBarRuntime(options = {}) {
  const deps = { ...defaultDeps(), ...options };
  const cache = deps.quotaBarCache || null;
  const renderQuotaBar = deps.renderQuotaBar;

  async function refresh(input) {
    const kind = text(input && input.kind, 40).toLowerCase();
    if (!REFRESH_KINDS.has(kind)) {
      return { httpStatus: 400, body: { status: 'unavailable', error: 'invalid quota bar kind' } };
    }
    const selector = {
      session: text(input && input.session, 180),
      baseUrl: text(input && input.baseUrl, 2048),
      host: text(input && input.host, 160).toLowerCase(),
    };
    const force = !!(input && input.force);
    let result;
    let bar;
    let opts = {};
    // A miss is not a result: it must not be recorded as one (that would park a
    // healthy provider in the shared cache) and must not overwrite the last
    // known bar in the client-facing snapshot below.
    let missing = false;
    if (kind === 'opencode') {
      result = await deps.fetchOpenCodeUsage();
      bar = renderQuotaBar('opencode', result);
    } else if (kind === 'qoder') {
      result = await deps.fetchQoderUsage();
      bar = renderQuotaBar('qoder', result);
    } else if (kind === 'codex') {
      result = await deps.fetchCodexUsage();
      bar = renderQuotaBar('codex', result);
    } else if (kind === 'ark') {
      result = await deps.fetchArkUsage();
      opts = { baseUrl: selector.baseUrl };
      if (typeof deps.recordVendor === 'function') {
        try { deps.recordVendor({ kind: 'ark', result, baseUrl: selector.baseUrl }); } catch (_) {}
      }
      bar = renderQuotaBar('ark', result, opts);
    } else if (kind === 'kimi') {
      result = await deps.fetchKimiUsage(selector.host);
      if (typeof deps.recordVendor === 'function') {
        try { deps.recordVendor({ kind: 'kimi', result, host: selector.host }); } catch (_) {}
      }
      bar = renderQuotaBar('kimi', result);
    } else if (kind === 'claude') {
      // The scrape is cached and rate-limited per account, and only this
      // request's `force` (the user's ⟳) or a task boundary starts one — a read
      // never drives a browser. See ../quota/claude-usage-queue.js.
      const key = claudeUsageKey(selector.session);
      const entry = force ? await enqueueClaudeUsage(key) : readClaudeUsage(key);
      missing = !entry;
      result = entry ? entry.result : { status: 'idle' };
      bar = renderClaudeBar(selector.session);
      if (entry && typeof deps.recordClaude === 'function') {
        try { deps.recordClaude(selector.session, result, bar && bar.text); } catch (_) {}
      }
    }
    if (cache && bar && !missing) cache.record(kind, result, bar, selector);
    return {
      httpStatus: statusCodeFor(result && result.status),
      body: {
        status: (result && result.status) || 'unavailable',
        fetchedAt: result && result.fetchedAt ? result.fetchedAt : null,
        error: result && result.error ? text(result.error, 200) : undefined,
        reason: result && result.reason ? text(result.reason, 200) : undefined,
        bar,
        cached: cache ? cache.get(kind, selector) : null,
      },
    };
  }

  return Object.freeze({ refresh });
}

function mountQuotaBarRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') return;
  const runtime = createQuotaBarRuntime(options);
  const cache = options.quotaBarCache || null;
  app.get('/api/quota/bars/idle', (req, res) => {
    res.json({ status: 'ok', bars: idleQuotaBars() });
  });
  app.get('/api/quota/bars/state', (req, res) => {
    const input = requestInput(req);
    res.json(cache ? cache.snapshotFor(input) : { status: 'ok', bars: {}, updatedAt: 0 });
  });
  if (typeof app.post === 'function') {
    app.post('/api/quota/bars/refresh', async (req, res) => {
      try {
        const result = await runtime.refresh(requestInput(req));
        res.status(result.httpStatus).json(result.body);
      } catch (_) {
        res.status(500).json({ status: 'unavailable', error: 'quota bar refresh failed' });
      }
    });
  }
}

module.exports = { mountQuotaBarRoutes, createQuotaBarRuntime, statusCodeFor };

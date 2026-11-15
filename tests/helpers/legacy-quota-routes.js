'use strict';

// FROZEN ORACLE — do not edit to match new behaviour.
//
// These are the mount functions of the twenty-two quota & pricing routes as
// they stood at HEAD — `git show HEAD:src/routes/pricing.js`, `quota-bars.js`,
// `opencode-quota.js`, `qoder-quota.js`, `codex-quota.js`, `ark-quota.js`,
// `kimi-quota.js`, `claude-usage-quota.js`, `aliyun-quota.js` — with exactly
// three mechanical rebases and nothing else:
//
//   * every process-local dependency (the price table, the nine fetchers, the
//     managed-profile login window, the codex auth-file resolver, the arkcli
//     locator/spawn/installer, the saved cookies, the quota-bar cache, the
//     Claude usage queue, the bar renderers and the two recorders) is read off
//     `deps` instead of a module require;
//   * `Date.now()` — read only by the two claude bar renders — reads
//     `deps.now()`, because the front door renders that bar in Rust from the
//     host port's single `nowMs` and both sides must be compared at one
//     instant;
//   * the module-level `lastKimiWithBalance` reads `deps.lastKimiBalance()`.
//
// Everything else is the recorded contract: the status→HTTP trees, the
// try/catch arms and their fixed 500 bodies, `{ ...result, bar }` and its key
// order, the `||` fallbacks, the three pricing 400s and `text()` sanitising.
// docs/rust-migration/differential/quota-routes.js mounts this with the
// scripted world in tests/helpers/quota-scripted-world.js and compares every
// answer byte for byte against the Rust front door
// (native/gateway/src/app/quota_routes.rs). When the two disagree, the front
// door is what changes; the oracle stays frozen as the recorded contract.

const MAX_LOOKUP_MODELS = 50;
const MAX_MODEL_LENGTH = 100;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

const REFRESH_KINDS = new Set(['opencode', 'qoder', 'codex', 'claude', 'ark', 'kimi']);

// ── src/routes/pricing.js ──────────────────────────────────────────────────

// `models` is a comma-separated list, so any comma inside an id would split it.
function parseModelList(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  const models = [];
  for (const part of raw.split(',')) {
    const model = part.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function fallbackAsyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => {
    if (typeof next === 'function') return next(error);
    return res.status(500).json({ ok: false, error: 'pricing request failed' });
  });
}

function mountPricingRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return null;
  const priceTable = deps.priceTable;
  if (!priceTable || typeof priceTable.lookupMany !== 'function') {
    throw new TypeError('mountPricingRoutes requires a priceTable');
  }
  const wrap = typeof deps.asyncHandler === 'function' ? deps.asyncHandler : fallbackAsyncHandler;

  app.get('/api/pricing/status', (req, res) => {
    res.json({ ok: true, status: priceTable.status() });
  });

  app.get('/api/pricing/lookup', (req, res) => {
    const models = parseModelList(req.query && req.query.models);
    if (!models.length) {
      return res.status(400).json({ ok: false, error: 'models_required', max: MAX_LOOKUP_MODELS });
    }
    if (models.length > MAX_LOOKUP_MODELS) {
      return res.status(400).json({ ok: false, error: 'too_many_models', max: MAX_LOOKUP_MODELS });
    }
    const tooLong = models.find(model => model.length > MAX_MODEL_LENGTH);
    if (tooLong) {
      return res.status(400).json({ ok: false, error: 'model_too_long', max: MAX_MODEL_LENGTH });
    }
    return res.json({ ok: true, prices: priceTable.lookupMany(models), status: priceTable.status() });
  });

  app.post('/api/pricing/refresh', wrap(async (req, res) => {
    const force = String((req.query && req.query.force) || (req.body && req.body.force) || '') === '1'
      || (req.body && req.body.force === true);
    const status = await priceTable.refresh({ force });
    res.json({ ok: true, status });
  }));

  app.get('/api/pricing/search', (req, res) => {
    const query = String((req.query && req.query.q) || '').trim();
    const requested = Number.parseInt(String((req.query && req.query.limit) || ''), 10);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_SEARCH_LIMIT)
      : DEFAULT_SEARCH_LIMIT;
    const results = query ? priceTable.search(query, { limit }) : [];
    res.json({ ok: true, query, count: results.length, results, status: priceTable.status() });
  });

  return priceTable;
}

// ── src/routes/quota-bars.js ───────────────────────────────────────────────

function statusCodeFor(status) {
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
    force: force === '1' || force === 'true',
  };
}

function createQuotaBarRuntime(deps = {}) {
  const cache = deps.quotaBarCache || null;
  const renderQuotaBar = deps.renderQuotaBar;
  const renderClaudeBar = deps.renderClaudeBar;

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
        try { await deps.recordVendor({ kind: 'ark', result, baseUrl: selector.baseUrl }); } catch (_) {}
      }
      bar = renderQuotaBar('ark', result, opts);
    } else if (kind === 'kimi') {
      result = await deps.fetchKimiUsage(selector.host);
      if (typeof deps.recordVendor === 'function') {
        try { await deps.recordVendor({ kind: 'kimi', result, host: selector.host }); } catch (_) {}
      }
      bar = renderQuotaBar('kimi', result);
    } else if (kind === 'claude') {
      const key = deps.claudeUsageKey(selector.session);
      const entry = force ? await deps.enqueueClaudeUsage(key) : deps.readClaudeUsage(key);
      missing = !entry;
      result = entry ? entry.result : { status: 'idle' };
      bar = renderClaudeBar(selector.session);
      if (entry && typeof deps.recordClaude === 'function') {
        try { await deps.recordClaude(selector.session, result, bar && bar.text); } catch (_) {}
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
    res.json({ status: 'ok', bars: options.idleQuotaBars() });
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

// ── src/routes/opencode-quota.js ───────────────────────────────────────────

function mountOpenCodeQuotaRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/opencode/quota', async (req, res) => {
    try {
      const result = await deps.fetchOpenCodeUsage();
      const status = (result && result.status) || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : (status === 'needs_login' || status === 'no_auth' ? 401
          : (status === 'chrome_unavailable' ? 503 : 500));
      res.status(httpStatus).json({ ...result, bar: deps.renderQuotaBar('opencode', result) });
    } catch (err) {
      const result = { status: 'unavailable', error: 'opencode quota fetch failed' };
      res.status(500).json({ ...result, bar: deps.renderQuotaBar('opencode', result) });
    }
  });

  app.post('/api/opencode/quota/login', async (req, res) => {
    try {
      await deps.openLogin(deps.loginUrl.opencode);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 opencode.ai，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

// ── src/routes/qoder-quota.js ──────────────────────────────────────────────

function mountQoderQuotaRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') return;

  app.get('/api/qoder/quota', async (req, res) => {
    try {
      const result = await deps.fetchQoderUsage();
      const status = (result && result.status) || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_login' ? 401
          : status === 'chrome_unavailable' ? 503 : 500;
      res.status(httpStatus).json({ ...result, bar: deps.renderQuotaBar('qoder', result) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'qoder quota fetch failed' };
      res.status(500).json({ ...result, bar: deps.renderQuotaBar('qoder', result) });
    }
  });

  app.post('/api/qoder/quota/login', async (req, res) => {
    try {
      await deps.openLogin(deps.loginUrl.qoder);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 qoder.com.cn，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });

  app.get('/api/qoder/quota/cookies', (req, res) => {
    const saved = deps.loadSavedCookies();
    if (!saved) return res.status(404).json({ ok: false, error: 'no saved cookies' });
    res.json(saved);
  });
}

// ── src/routes/codex-quota.js ──────────────────────────────────────────────

function mountCodexQuotaRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/codex/quota', async (req, res) => {
    try {
      const accountId = String(req.query && req.query.account || '').trim();
      let authFile = null;
      if (accountId) {
        if (typeof deps.resolveAccountAuthFile !== 'function') {
          return res.status(400).json({ status: 'unavailable', error: 'official accounts not enabled' });
        }
        authFile = deps.resolveAccountAuthFile(accountId);
        if (!authFile) return res.status(404).json({ status: 'no_auth', error: '账号不存在' });
      }
      const result = await deps.fetchCodexUsage(undefined, {
        ...(authFile ? { authFile } : {}),
        ...(typeof deps.codexFetch === 'function' ? { fetch: deps.codexFetch } : {}),
      });
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'no_auth' ? 401 : 500;
      res.status(httpStatus).json({ ...result, bar: deps.renderQuotaBar('codex', result) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'codex quota fetch failed' };
      res.status(500).json({ ...result, bar: deps.renderQuotaBar('codex', result) });
    }
  });
}

// ── src/routes/ark-quota.js ────────────────────────────────────────────────

function mountArkQuotaRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') return;
  const record = typeof deps.recordVendor === 'function' ? deps.recordVendor : null;

  app.get('/api/ark/quota', async (req, res) => {
    try {
      const result = await deps.fetchArkUsage();
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_auth' ? 401
        : status === 'needs_install' ? 404
        : 500;
      const baseUrl = typeof req.query?.baseUrl === 'string' ? req.query.baseUrl : '';
      if (record) {
        try { await record({ kind: 'ark', result, baseUrl }); } catch (_) {}
      }
      res.status(httpStatus).json({ ...result, bar: deps.renderQuotaBar('ark', result, { baseUrl }) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'ark quota fetch failed' };
      if (record) {
        try { await record({ kind: 'ark', result, baseUrl: req.query?.baseUrl || '' }); } catch (_) {}
      }
      res.status(500).json({ ...result, bar: deps.renderQuotaBar('ark', result) });
    }
  });

  app.post('/api/ark/quota/login', (req, res) => {
    const bin = deps.resolveArkcliBin();
    if (!bin) {
      res.status(404).json({ status: 'needs_install', error: 'arkcli not found on PATH' });
      return;
    }
    try {
      const child = deps.spawn(bin.cmd, [...bin.prefix, 'auth', 'login', 'volc-sso'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      res.json({ status: 'started', pid: child.pid || null });
    } catch (err) {
      res.status(500).json({ status: 'unavailable', error: err.message || 'spawn failed' });
    }
  });

  app.post('/api/ark/quota/install', async (req, res) => {
    try {
      const result = await deps.installArkcli();
      if (result.ok) {
        res.json({ status: 'ok' });
      } else {
        res.status(500).json({ status: 'error', error: result.error });
      }
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message || 'install failed' });
    }
  });
}

// ── src/routes/kimi-quota.js ───────────────────────────────────────────────

function mountKimiQuotaRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return;
  const usageDeps = deps.kimiUsageDeps || {};
  const recordVendor = typeof deps.recordVendor === 'function' ? deps.recordVendor : null;
  app.get('/api/kimi/quota', async (req, res) => {
    try {
      const preferHost = typeof req.query?.host === 'string' ? req.query.host : '';
      const result = await deps.fetchKimiUsage(preferHost, deps.now(), usageDeps);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'not_configured' ? 404
          : status === 'needs_login' ? 401
            : status === 'chrome_unavailable' ? 503 : 502;
      const cached = deps.rememberKimiBalance(result);
      if (recordVendor) {
        try { await recordVendor({ kind: 'kimi', result, host: preferHost, opts: { cached } }); } catch (_) {}
      }
      res.status(httpStatus).json({ ...result, bar: deps.renderQuotaBar('kimi', result, { cached }) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'kimi quota fetch failed' };
      if (recordVendor) {
        try { await recordVendor({ kind: 'kimi', result, host: req.query?.host || '' }); } catch (_) {}
      }
      res.status(500).json({ ...result, bar: deps.renderQuotaBar('kimi', result, { cached: deps.lastKimiBalance() }) });
    }
  });

  app.post('/api/kimi/quota/login', async (req, res) => {
    try {
      await deps.openLogin(deps.loginUrl.kimi);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 kimi.com，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

// ── src/routes/claude-usage-quota.js ───────────────────────────────────────

function quotaHttpStatus(status) {
  if (status === 'ok' || status === 'idle') return 200;
  if (status === 'needs_login') return 401;
  if (status === 'chrome_unavailable') return 503;
  return 500;
}

function mountClaudeUsageQuotaRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return;
  const recordClaude = deps.recordClaude;
  app.get('/api/claude/quota', async (req, res) => {
    const session = typeof req.query?.session === 'string' ? req.query.session : '';
    const force = req.query?.force === '1' || req.query?.force === 'true';
    const key = deps.claudeUsageKey(session);
    try {
      const entry = force ? await deps.enqueueClaudeUsage(key) : deps.readClaudeUsage(key);
      const result = entry ? entry.result : null;
      const bar = deps.renderClaudeBar(session);
      if (entry && recordClaude) {
        try { await recordClaude(session, result, bar && bar.text); } catch (_) {}
      }
      const status = (result && result.status) || 'idle';
      res.status(quotaHttpStatus(status)).json({ ...(result || {}), status, bar });
    } catch (err) {
      res.status(500).json({
        status: 'unavailable',
        error: 'claude quota fetch failed',
        bar: deps.renderClaudeBar(session),
      });
    }
  });

  app.post('/api/claude/quota/login', async (req, res) => {
    try {
      await deps.openLogin(deps.loginUrl.claude);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录 claude.ai，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

// ── src/routes/aliyun-quota.js ─────────────────────────────────────────────

function mountAliyunQuotaRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return;
  const usageDeps = deps.aliyunUsageDeps || {};
  app.get('/api/aliyun/quota', async (req, res) => {
    try {
      const result = await deps.fetchAliyunUsage(deps.now(), usageDeps);
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200
        : status === 'needs_login' ? 401
          : status === 'chrome_unavailable' ? 503 : 502;
      res.status(httpStatus).json(result);
    } catch (_) {
      res.status(500).json({ status: 'unavailable', error: 'aliyun quota fetch failed' });
    }
  });

  app.post('/api/aliyun/quota/login', async (req, res) => {
    try {
      await deps.openLogin(deps.loginUrl.aliyun);
      res.json({ ok: true, message: '已打开登录窗口：请在弹出的 Chrome 中登录阿里云，完成后回来重新查询余量' });
    } catch (err) {
      const status = err && err.code === 'chrome_unavailable' ? 503 : 500;
      res.status(status).json({ ok: false, error: (err && err.code) || 'login_window_failed', message: err && err.message });
    }
  });
}

// ── server.js's mount order ────────────────────────────────────────────────

function mountQuotaRoutes(app, deps = {}) {
  mountPricingRoutes(app, deps);
  mountOpenCodeQuotaRoutes(app, deps);
  mountQoderQuotaRoutes(app, deps);
  mountCodexQuotaRoutes(app, deps);
  mountArkQuotaRoutes(app, deps);
  mountKimiQuotaRoutes(app, deps);
  mountClaudeUsageQuotaRoutes(app, deps);
  mountAliyunQuotaRoutes(app, deps);
  mountQuotaBarRoutes(app, deps);
}

module.exports = {
  mountQuotaRoutes,
  mountPricingRoutes,
  mountQuotaBarRoutes,
  mountOpenCodeQuotaRoutes,
  mountQoderQuotaRoutes,
  mountCodexQuotaRoutes,
  mountArkQuotaRoutes,
  mountKimiQuotaRoutes,
  mountClaudeUsageQuotaRoutes,
  mountAliyunQuotaRoutes,
  createQuotaBarRuntime,
  statusCodeFor,
  parseModelList,
};

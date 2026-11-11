'use strict';
// 冻结的 Node 原始实现（迁移前的 src/routes/{opencode,qoder,grok,commandcode,
// codebuddy,provider,codex}-models.js 里的 mount* 逐字副本），只给
// docs/rust-migration/differential/model-catalogs.js 当对照 oracle。
// 不参与生产路径，除差异测试外不要 require。
//
// 迁移后 live 模块只剩纯 helper（list*Models 等）；路由映射、查询串解析、
// 状态码与响应形状同样由 Rust 前门（native/gateway/src/app/model_catalogs.rs）
// 独占，所以这里复制的是「退役时的 mount 函数体」，而不是重新实现一遍。
//
// 依赖全部可注入，差异测试不碰真实网络/真实 CLI：
//   cliListers                    { opencode|qoder|grok|commandcode|codebuddy: (cb, opts) }
//   providerRuntime               { listProviderModels(id, {refresh}) }
//   accountRuntime                { resolveProvider, refreshProvider, peekProvider, isRefreshing }
//   providerModelsRuntime         codex 借道分支用的 provider 目录运行时
//   isOfficialCodexOAuthProvider  provider => boolean

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');

// 退役 provider-models.js 的 refresh 约定（逐字副本）。
function isRefresh(value) {
  return /^(?:1|true)$/i.test(String(value || ''));
}

function repoModule(relative) {
  return require(path.join(REPO_ROOT, relative));
}

function pickLister(options, name, modulePath, exportName) {
  if (options.cliListers && typeof options.cliListers[name] === 'function') {
    return options.cliListers[name];
  }
  return (callback, opts = {}) => repoModule(modulePath)[exportName](callback, opts);
}

// GET /api/opencode/models（退役 mountOpenCodeModelRoutes 的 handler 逐字副本，
// 只把 listOpenCodeModels 换成可注入的 list）。
function mountOpenCodeModelRoutes(app, options) {
  if (!app || typeof app.get !== 'function') return;
  const list = pickLister(options, 'opencode', 'src/routes/opencode-models', 'listOpenCodeModels');
  // ?refresh=1 skips the 1-hour cache (the picker 刷新模型 button, or a paid model unlocked by a new key).
  app.get('/api/opencode/models', (req, res) => {
    const refresh = String((req.query && req.query.refresh) || '') === '1';
    list((err, models, source) => {
      if (err) return res.status(503).json({ error: 'opencode models unavailable', models: [] });
      res.json({ models, source, cached: source === 'cache' });
    }, { refresh });
  });
}

// GET /api/<cli>/models（qoder / grok / commandcode / codebuddy 的 mount 逐字副本，
// 四者的 handler 除路径、模块与 503 文案外完全相同）。
function mountCliModelRoutes(app, options, name, route, modulePath, exportName, unavailable) {
  if (!app || typeof app.get !== 'function') return;
  const list = pickLister(options, name, modulePath, exportName);
  app.get(route, (req, res) => {
    // ?refresh=1 skips the cache (the picker 刷新模型 button).
    const refresh = /^(?:1|true)$/i.test(String((req && req.query && req.query.refresh) || ''));
    list((err, models, source) => {
      if (err) return res.status(503).json({ error: unavailable, models: [] });
      res.json({ models, source, cached: source === 'cache' });
    }, { refresh });
  });
}

// GET /api/providers/:id/models（退役 provider-models.js 的 runtime.mount 逐字副本）。
function mountProviderModelRoutes(app, options) {
  if (!app || typeof app.get !== 'function') return;
  const runtime = options.providerRuntime
    || repoModule('src/routes/provider-models').getSharedProviderModelsRuntime();
  app.get('/api/providers/:id/models', async (req, res) => {
    const result = await runtime.listProviderModels(req.params && req.params.id, {
      refresh: isRefresh(req.query && req.query.refresh),
    });
    res.set?.('Cache-Control', 'no-store');
    return res.status(result.status).json(result.body);
  });
}

// GET /api/codex/models + POST /api/codex/models/sync（退役 mountCodexModelRoutes
// 逐字副本；官方账号的 isOfficialCodexOAuthProvider 也可注入）。
function mountCodexModelRoutes(app, runtime, accountRuntime, providerModelsRuntime, options) {
  if (!app || typeof app.get !== 'function') return;
  const isOfficialCodexOAuthProvider = typeof options.isOfficialCodexOAuthProvider === 'function'
    ? options.isOfficialCodexOAuthProvider
    : repoModule('src/codex/official-relay').isOfficialCodexOAuthProvider;
  // Existing embedders may inject the legacy single-account runtime. The
  // production API uses the Rust account catalog; Express only projects its
  // snapshot and schedules work, never waits for a CLI discovery.
  if (!runtime) accountRuntime ||= repoModule('src/codex/model-catalog').defaultRuntime;
  async function accountResponse(req, res, pollOnly = false) {
    const providerId = String(req.query?.providerId || req.body?.providerId || 'codex-official');
    const provider = accountRuntime.resolveProvider(providerId);
    if (!provider) return res.status(404).json({ error: '账号线路不存在' });
    if (provider.appType !== 'codex') return res.status(400).json({ error: '该线路不是 Codex 官方账号' });
    if (!isOfficialCodexOAuthProvider(provider)) {
      // 借道（第三方中转）线路: this endpoint used to reject it with "该线路
      // 不是 Codex 官方账号", so 刷新模型 could never work on a relay. Those
      // rows carry their own base URL/key, not an OAuth account, so delegate to
      // the provider live-catalog path (same fetch as /api/providers/:id/models).
      // The response keeps the account-catalog shape loadCodexModels() expects.
      const catalogRuntime = providerModelsRuntime || repoModule('src/routes/provider-models').getSharedProviderModelsRuntime();
      const result = await catalogRuntime.listProviderModels(provider.id, {
        refresh: /^(?:1|true)$/i.test(String(req.query?.refresh || '')),
      });
      const models = (result.body && Array.isArray(result.body.models) ? result.body.models : [])
        .map(item => Object.freeze({ model: item.model, label: item.label || item.model }));
      res.set?.('Cache-Control', 'no-store');
      return res.json({
        models, source: result.body?.source || 'fallback', cached: false,
        available: models.length > 0, refreshing: false, fallback: 'custom',
        diagnostic: { code: models.length ? 'ok' : 'none', message: '' },
      });
    }
    if (!pollOnly) {
      // No force flag here: opening a picker must respect the one-day cache.
      // Only successful login explicitly requests a new-identity refresh.
      void accountRuntime.refreshProvider(provider).catch(() => {});
    }
    const result = accountRuntime.peekProvider(provider);
    res.set?.('Cache-Control', 'no-store');
    return res.json({ ...result, available: !!result?.models?.length,
      refreshing: accountRuntime.isRefreshing(provider) });
  }
  app.get('/api/codex/models', async (req, res) => {
    // 老版客户端没有进度轮询协议，保留其等待全局目录的响应契约。
    // 新选择器总会携带 providerId，走下方立即响应的后台刷新路径。
    if (accountRuntime && !req.query?.providerId && !req.query?.poll) {
      await accountRuntime.refreshProvider('codex-official');
      return accountResponse(req, res, true);
    }
    if (accountRuntime) return accountResponse(req, res, /^(?:1|true)$/i.test(String(req.query?.poll || '')));
    const forceRefresh = /^(?:1|true)$/i.test(String(req.query && req.query.refresh || ''));
    const result = await runtime.list({ forceRefresh });
    res.json(result);
  });
  // Compatibility endpoint for older clients. Rust owns cache age/version
  // checks; this request cannot bypass them.
  if (typeof app.post === 'function') {
    app.post('/api/codex/models/sync', (req, res) => {
      if (accountRuntime) return accountResponse(req, res);
      res.json({ ok: true, ...runtime.syncIfDue() });
    });
  }
}

/**
 * Mounts all eight retired routes (opencode, qoder, grok, commandcode,
 * codebuddy, provider, codex GET, codex sync POST).
 *
 * @param app Express-compatible app
 * @param options see the header comment; every dependency is injectable.
 */
function mountLegacyModelCatalogRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new TypeError('[legacy-model-catalog-routes] Express-compatible app is required');
  }
  mountOpenCodeModelRoutes(app, options);
  mountCliModelRoutes(app, options, 'qoder', '/api/qoder/models',
    'src/routes/qoder-models', 'listQoderModels', 'qoder models unavailable');
  mountCliModelRoutes(app, options, 'grok', '/api/grok/models',
    'src/routes/grok-models', 'listGrokModels', 'grok models unavailable');
  mountCliModelRoutes(app, options, 'commandcode', '/api/commandcode/models',
    'src/routes/commandcode-models', 'listCommandcodeModels', 'commandcode models unavailable');
  mountCliModelRoutes(app, options, 'codebuddy', '/api/codebuddy/models',
    'src/routes/codebuddy-models', 'listCodebuddyModels', 'codebuddy models unavailable');
  mountProviderModelRoutes(app, options);
  mountCodexModelRoutes(app, options.codexRuntime, options.accountRuntime,
    options.providerModelsRuntime || options.providerRuntime, options);
}

module.exports = { mountLegacyModelCatalogRoutes };

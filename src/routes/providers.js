'use strict';

const { sanitizePublicText } = require('../http/public-safety');

const DEFAULT_PROVIDER_IDS = Object.freeze({ claude: null, codex: null });
const { runSpeedtestRequest } = require('../providers/speedtest-request');
const { isOfficialCodexOAuthProvider } = require('../codex/official-relay');
const { officialAccountIdFromProvider } = require('../official-accounts');
const { createRoutingTest } = require('./auto-provider-routing-test');
const { relayRouteFromBaseUrl } = require('../providers/relay-share-store');
const { nativeVendorOf } = require('../providers/native-vendor');
const { CLAUDE_MODELS_FALLBACK } = require('../claude-models');

// A borrowed Claude line carries no canonical ANTHROPIC_MODEL: its share code
// only names a relay endpoint, so the provider summary is alias-only with an
// empty model list until the lender's catalog sync lands. The old speed test
// fell straight through to WIRE_DEFAULT_MODEL — a hardcoded id that outlives
// its upstream — so every borrowed Claude line probed a retired model and got
// `404 model: claude-sonnet-4-5`. Prefer what the provider actually serves:
// explicit env, then its relay catalog, then the CLI-known current models.
function wireModelId(value) {
  const model = String(value || '').trim();
  // `claude-opus-5[1m]` is a CLI context suffix; the wire only accepts the id.
  return model.replace(/\[[^\]]*\]$/, '').trim();
}

function preferredSpeedtestModel(values) {
  const models = (Array.isArray(values) ? values : [])
    .map(wireModelId)
    .filter(Boolean);
  if (!models.length) return '';
  const unique = [...new Set(models)];
  return unique.find(model => /haiku/i.test(model)) || unique[0];
}

function claudeSpeedtestModel(env, summary) {
  const explicit = [
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    summary && summary.model,
  ].map(value => (typeof value === 'string' ? value.trim() : '')).find(Boolean);
  if (explicit) return explicit;
  const fromCatalog = preferredSpeedtestModel(summary && summary.modelOptions);
  if (fromCatalog) return fromCatalog;
  if (relayRouteFromBaseUrl(env.ANTHROPIC_BASE_URL)) {
    // The bootstrap catalog a relay importer can read; cheap, current, and
    // accepts the retired 4-5 ids this fallback replaces.
    return preferredSpeedtestModel(CLAUDE_MODELS_FALLBACK.map(entry => entry.model));
  }
  return '';
}

function publicError(error, fallback) {
  return sanitizePublicText(error && error.message, fallback);
}

function publicText(value, fallback) {
  return sanitizePublicText(typeof value === 'string' ? value : '', fallback);
}

function assertProviderRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('provider route dependencies are required');
  const requiredFunctions = [
    'atomicWriteJson',
    'findProviderReferences',
    'getAuxConfig',
    'getPort',
  ];
  for (const name of requiredFunctions) {
    if (typeof deps[name] !== 'function') throw new TypeError(`provider route dependency missing: ${name}`);
  }
  if (!deps.fs || typeof deps.fs.readFileSync !== 'function') {
    throw new TypeError('provider route dependency missing: fs.readFileSync');
  }
  if (!deps.providers || !deps.providerRouterRuntime || !deps.persistedSessions
      || !deps.providerRelayShares
      || typeof deps.providerRelayShares.create !== 'function'
      || typeof deps.providerRelayShares.list !== 'function'
      || typeof deps.providerRelayShares.getCredential !== 'function'
      || typeof deps.providerRelayShares.revoke !== 'function'
      || typeof deps.providerRelayShares.revokeProvider !== 'function') {
    throw new TypeError('provider route runtime dependencies are required');
  }
  if (!deps.http || typeof deps.http.request !== 'function') {
    throw new TypeError('provider route HTTP dependencies are required');
  }
  if (!deps.providerDefaultsFile || !deps.claudeCmd) {
    throw new TypeError('provider route host values are required');
  }
  return deps;
}

function assertAppMethod(app, method) {
  if (!app || typeof app[method] !== 'function') {
    throw new TypeError(`Express app.${method} is required`);
  }
}

function createProviderRoutes(rawDeps) {
  const deps = assertProviderRouteDeps(rawDeps);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const log = deps.logger || console;
  const providerDefaults = { ...DEFAULT_PROVIDER_IDS };

  // 子任务默认线路的归一化只由 Rust 决定。
  const subagentNative = () => typeof deps.getNative === 'function'
    ? deps.getNative()
    : require('../native/runtime').getNative();
  function normalizeStoredSubagent(value) {
    const native = subagentNative();
    try {
      const parsed = JSON.parse(native.normalizeSubagentDefaults(JSON.stringify({ stored: value })));
      if (!parsed || typeof parsed !== 'object') return undefined;
      return { claude: parsed.claude ?? null, codex: parsed.codex ?? null };
    } catch (_) { return undefined; }
  }

  try {
    const stored = JSON.parse(deps.fs.readFileSync(deps.providerDefaultsFile, 'utf8'));
    providerDefaults.claude = stored.claude || null;
    providerDefaults.codex = stored.codex || null;
    // Only users who already used the feature see the key; everybody else keeps
    // the exact response shapes existing clients and tests deepEqual.
    if (Object.prototype.hasOwnProperty.call(stored, 'subagent')) {
      const normalized = normalizeStoredSubagent(stored.subagent);
      providerDefaults.subagent = normalized === undefined ? stored.subagent : normalized;
    }
  } catch (_) {
    // Missing or invalid legacy defaults keep the established null defaults.
  }

  if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
    for (const cli of ['claude', 'codex']) providerDefaults[cli] = deps.providers.normalizeOfficialProviderId(cli, providerDefaults[cli]);
  }

  // Throws so callers that must answer "saved or not" (the subagent-defaults
  // sync) can defer every session mutation until the file write succeeded.
  function persistProviderDefaults(value = providerDefaults) {
    deps.atomicWriteJson(deps.providerDefaultsFile, value);
  }

  function saveProviderDefaults() {
    try {
      persistProviderDefaults();
    } catch (error) {
      log.error('[multicc] save provider-defaults failed:', publicError(error, 'save failed'));
      return false;
    }
    return true;
  }

  function validProviderId(cli, id) {
    const appType = deps.providers.appTypeForCli(cli);
    if (typeof deps.providers.normalizeOfficialProviderId === 'function') {
      id = deps.providers.normalizeOfficialProviderId(cli === 'codex-exp' ? 'codex' : cli === 'claude-exp' ? 'claude' : cli, id);
    }
    if (id == null || id === '') return { ok: true, value: null };
    // A vendor-native Auto line has no provider record; the lane itself owns the
    // account, so only the lane check applies.
    const nativeVendor = nativeVendorOf(id);
    if (nativeVendor !== null) {
      return cli === nativeVendor.cli ? { ok: true, value: String(id) } : { ok: false };
    }
    // Qoder CN remains vendor-managed. OpenCode and ZCode both support the two
    // MultiCC pools, so their provider ids are looked up globally and then
    // constrained by the provider's declared protocol compatibility.
    const appTypes = typeof deps.providers.appTypesForCli === 'function'
      ? deps.providers.appTypesForCli(cli)
      : (appType ? [appType] : []);
    if (!appTypes.length) return { ok: false };
    const globalPoolCli = appTypes.length > 1;
    const summary = deps.providerRouterRuntime.getProviderSummary(
      globalPoolCli ? undefined : appType,
      String(id),
    );
    if (!summary || !deps.providers.providerSupportsCli(summary, cli)) return { ok: false };
    return { ok: true, value: String(id) };
  }

  function mountManagementRoutes(app) {
    for (const method of ['get', 'post', 'patch', 'delete', 'put']) assertAppMethod(app, method);
    // 16 条 provider 路由（目录、增删改、探测、批量迁移、借道、默认值）已由 Rust 前门
    // 独占（native/gateway/src/app/providers.rs）。这里只剩前门回调的宿主端口：
    // provider store 事实、会话引用、落盘与逐会话 PATCH。
    require('./providers-host').mountProvidersHostRoute(app, {
      providerDefaults,
      saveProviderDefaults,
      validProviderId,
      providers: deps.providers,
      providerRouterRuntime: deps.providerRouterRuntime,
      findProviderReferences: deps.findProviderReferences,
      getAuxConfig: deps.getAuxConfig,
      persistedSessions: deps.persistedSessions,
      applySessionPatch: deps.applySessionPatch,
      previewSessionPatch: deps.previewSessionPatch,
      clearAuxProvider: deps.clearAuxProvider,
      providerRelayShares: deps.providerRelayShares,
      getPort: deps.getPort,
      claudeCmd: deps.claudeCmd,
      relayModelCatalogRuntime: deps.relayModelCatalogRuntime,
      codexAccountModelCatalogRuntime: deps.codexAccountModelCatalogRuntime,
      providerLimitCache: deps.providerLimitCache,
      limitRecorder: deps.limitRecorder,
      limitCacheStaleMs: deps.limitCacheStaleMs,
      now,
      logger: log,
      ...(typeof deps.isLocalRequest === 'function' ? { isLocal: deps.isLocalRequest } : {}),
    });

    // 子任务默认线路 + 一键同步：公开路由由 Rust 前门独占（native/gateway/），这里只剩
    // 前门回调的宿主端口：会话表/provider 事实、默认值落盘与逐会话 PATCH。
    require('./subagent-defaults-host').mountSubagentDefaultsHostRoute(app, {
      providerDefaults,
      sessions: deps.persistedSessions,
      validProviderId,
      providers: deps.providers,
      applySessionPatch: deps.applySessionPatch,
      previewSessionPatch: deps.previewSessionPatch,
      persistDefaults: persistProviderDefaults,
      ...(typeof deps.isLocalRequest === 'function' ? { isLocal: deps.isLocalRequest } : {}),
    });

    // 测速留在 Node：它边测边把 SSE 帧写回 res，不是一条可以交给前门转发的 JSON 路由。
    app.post('/api/providers/:appType/:id/speedtest', async (req, res) => {
      const startedAt = now();
      const elapsed = () => now() - startedAt;
      try {
        const provider = deps.providers.getProvider(req.params.appType, req.params.id);
        if (!provider) return res.status(404).json({ ok: false, ms: elapsed(), error: 'provider not found' });
        const config = typeof provider.settingsConfig === 'string'
          ? JSON.parse(provider.settingsConfig)
          : (provider.settingsConfig || {});
        const env = (config && config.env) || {};

        const officialCodex = isOfficialCodexOAuthProvider(provider);
        // Both codex shapes now measure the SAME route a real turn takes: a
        // loopback POST to the host-owned codex proxy, which resolves the
        // account credential (official) or the provider's stored key
        // (third-party) and dials the vendor itself. The endpoint and the
        // credential therefore never enter this process's request headers. The
        // old third-party path dialed the vendor directly — a path production
        // traffic never takes, so the number it reported could disagree with
        // what turns actually do.
        const runCodexHostSpeedtest = ({ model }) => runSpeedtestRequest({
          client: deps.http,
          requestOptions: {
            hostname: '127.0.0.1', port: deps.getPort(),
            path: `/codex-proxy/${encodeURIComponent(req.params.id)}/responses`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          },
          body: JSON.stringify({
            model, instructions: 'Reply with only OK.',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            stream: true, store: false,
          }),
          model, res, elapsed, setTimeoutFn, clearTimeoutFn,
          streamProtocol: 'responses',
        });

        if (officialCodex) {
          const summary = deps.providerRouterRuntime.getProviderSummary('codex', req.params.id) || {};
          const model = summary.model || (summary.modelOptions || [])[0];
          if (!model) return res.json({ ok: false, ms: elapsed(), error: '官方模型目录为空，请先登录 Codex 并刷新模型列表' });
          await runCodexHostSpeedtest({ model });
          return;
        }

        if (req.params.appType === 'codex') {
          // Capability pre-check only — the target's own url/apiKey are no
          // longer used here (the hop owns them). canDirect is false for an
          // OAuth-subscription codex entry that is not the official provider,
          // which has no HTTP credential for the hop to forward.
          const target = deps.providers.resolveCodexDirectHttp(req.params.id);
          if (!target.canDirect) {
            return res.json({
              ok: false,
              ms: elapsed(),
              error: publicText(target.reason, 'OAuth 订阅型 provider 不支持测速'),
            });
          }
          const model = (target.modelOptions && target.modelOptions[0])
            || target.model
            || 'gpt-4o-mini';
          await runCodexHostSpeedtest({ model });
          return;
        }

        const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
        const isOfficial = req.params.id === 'claude-official' || !!officialAccountIdFromProvider(provider);
        const canDirect = (env.ANTHROPIC_BASE_URL && hasKey) || isOfficial;
        if (!canDirect) {
          return res.json({
            ok: false,
            ms: elapsed(),
            error: '缺少 API Key 或 Base URL',
          });
        }

        const speedtestSummary = deps.providerRouterRuntime.getProviderSummary(
          'claude',
          req.params.id,
        ) || {};
        const model = claudeSpeedtestModel(env, speedtestSummary)
          || deps.providers.WIRE_DEFAULT_MODEL;
        const isOfficialOAuth = isOfficial && !hasKey;
        const body = JSON.stringify({
          model,
          max_tokens: 1,
          ...(isOfficialOAuth
            ? { system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }] }
            : {}),
          messages: [{ role: 'user', content: 'hi' }],
        });

        await runSpeedtestRequest({
          client: deps.http,
          requestOptions: {
            hostname: '127.0.0.1',
            port: deps.getPort(),
            path: `/claude-proxy/${encodeURIComponent(req.params.id)}/speedtest/v1/messages?beta=true`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'multicc-speedtest',
              'anthropic-version': '2023-06-01',
              'x-api-key': 'multicc-speedtest',
              ...(isOfficialOAuth ? { 'x-app': 'cli' } : {}),
            },
          },
          body,
          model,
          res,
          elapsed,
          setTimeoutFn,
          clearTimeoutFn,
        });
      } catch (error) {
        res.json({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
      }
    });

    // Lives here rather than in server.js (at its line budget): the Auto
    // Provider editor's "测试一下" for difficulty routing.
    (deps.autoProviderRoutingTest || createRoutingTest()).mount(app);
  }

  return Object.freeze({
    providerDefaults,
    validProviderId,
    mountManagementRoutes,
  });
}

function mountProviderRoutes(app, deps) {
  const routes = createProviderRoutes(deps);
  routes.mountManagementRoutes(app);
  return routes;
}

module.exports = {
  DEFAULT_PROVIDER_IDS,
  assertProviderRouteDeps,
  createProviderRoutes,
  mountProviderRoutes,
  publicError,
};

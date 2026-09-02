'use strict';

const { safeCode, sanitizePublicText } = require('../http/public-safety');
const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache');

const DEFAULT_PROVIDER_IDS = Object.freeze({ claude: null, codex: null });
const MAX_PROBE_CANDIDATES = 20;
const MAX_PROBE_CANDIDATE_LENGTH = 200;
const SPEEDTEST_DEADLINE_MS = 15000;
const SPEEDTEST_MAX_RESPONSE_BYTES = 64 * 1024;

function publicError(error, fallback) {
  return sanitizePublicText(error && error.message, fallback);
}

function publicText(value, fallback) {
  return sanitizePublicText(typeof value === 'string' ? value : '', fallback);
}

function importErrorDto(error) {
  const dto = { error: publicError(error, 'provider import failed') };
  if (error && error.code) dto.code = safeCode(String(error.code), 'PROVIDER_IMPORT_FAILED');
  if (error && error.reason) dto.reason = publicText(error.reason, 'provider import failed');
  return dto;
}

function sanitizeProbeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const safe = { ...result };
  if (Object.prototype.hasOwnProperty.call(safe, 'error')) {
    safe.error = publicText(safe.error, 'provider probe failed');
  }
  if (Array.isArray(safe.tested)) {
    safe.tested = safe.tested.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const item = { ...entry };
      if (Object.prototype.hasOwnProperty.call(item, 'error')) {
        item.error = publicText(item.error, 'provider probe failed');
      }
      if (Object.prototype.hasOwnProperty.call(item, 'reason')) {
        item.reason = publicText(item.reason, 'provider probe failed');
      }
      if (Object.prototype.hasOwnProperty.call(item, 'sample')) {
        item.sample = publicText(item.sample, 'provider probe output hidden');
      }
      return item;
    });
  }
  return safe;
}

function normalizeProbeCandidates(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, status: 400, error: 'probe candidates must be an array' };
  }
  if (value.length > MAX_PROBE_CANDIDATES) {
    return { ok: false, status: 413, error: 'too many probe candidates' };
  }
  const candidates = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, status: 400, error: 'invalid probe candidate' };
    }
    const candidate = item.trim();
    if (!candidate || candidate.length > MAX_PROBE_CANDIDATE_LENGTH) {
      return { ok: false, status: 400, error: 'invalid probe candidate' };
    }
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return { ok: true, value: candidates };
}

function runSpeedtestRequest(options) {
  const {
    client,
    requestOptions,
    body,
    model,
    res,
    elapsed,
    setTimeoutFn,
    clearTimeoutFn,
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let deadlineTimer = null;
    let responseBytes = 0;

    const finish = (payload) => {
      if (settled) return false;
      settled = true;
      if (deadlineTimer) clearTimeoutFn(deadlineTimer);
      res.json(payload);
      resolve();
      return true;
    };
    const destroyAfter = (payload) => {
      if (!finish(payload)) return;
      if (request && typeof request.destroy === 'function') request.destroy();
    };
    const timeout = () => destroyAfter({ ok: false, ms: elapsed(), error: 'timeout' });

    try {
      request = client.request(requestOptions, (response) => {
        let data = '';
        response.on('data', (chunk) => {
          if (settled) return;
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > SPEEDTEST_MAX_RESPONSE_BYTES) {
            destroyAfter({
              ok: false,
              ms: elapsed(),
              status: response.statusCode,
              model,
              error: 'response too large',
            });
            return;
          }
          data += chunk.toString();
        });
        response.on('error', (error) => {
          destroyAfter({
            ok: false,
            ms: elapsed(),
            error: publicError(error, 'provider speedtest failed'),
          });
        });
        response.on('end', () => {
          if (settled) return;
          const ms = elapsed();
          if (response.statusCode >= 200 && response.statusCode < 300) {
            finish({ ok: true, ms, status: response.statusCode, model });
            return;
          }
          let message = `HTTP ${response.statusCode}`;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) message = parsed.error.message || JSON.stringify(parsed.error);
          } catch (_) {}
          finish({
            ok: false,
            ms,
            status: response.statusCode,
            model,
            error: publicText(message, `HTTP ${response.statusCode}`),
          });
        });
      });
      request.on('error', (error) => {
        finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
      });
      request.setTimeout(SPEEDTEST_DEADLINE_MS, timeout);
      deadlineTimer = setTimeoutFn(timeout, SPEEDTEST_DEADLINE_MS);
      if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
      request.write(body);
      request.end();
    } catch (error) {
      finish({ ok: false, ms: elapsed(), error: publicError(error, 'provider speedtest failed') });
    }
  });
}

function assertProviderRouteDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('provider route dependencies are required');
  const requiredFunctions = [
    'atomicWriteJson',
    'findProviderReferences',
    'getAuxConfig',
    'getClaudeOfficialViaProxy',
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
      || typeof deps.providerRelayShares.revoke !== 'function'
      || typeof deps.providerRelayShares.revokeProvider !== 'function') {
    throw new TypeError('provider route runtime dependencies are required');
  }
  if (!deps.http || typeof deps.http.request !== 'function'
      || !deps.https || typeof deps.https.request !== 'function') {
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
  const URLCtor = deps.URL || URL;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const log = deps.logger || console;
  const providerDefaults = { ...DEFAULT_PROVIDER_IDS };

  try {
    const stored = JSON.parse(deps.fs.readFileSync(deps.providerDefaultsFile, 'utf8'));
    providerDefaults.claude = stored.claude || null;
    providerDefaults.codex = stored.codex || null;
  } catch (_) {
    // Missing or invalid legacy defaults keep the established null defaults.
  }

  function saveProviderDefaults() {
    try {
      deps.atomicWriteJson(deps.providerDefaultsFile, providerDefaults);
    } catch (error) {
      log.error('[multicc] save provider-defaults failed:', publicError(error, 'save failed'));
    }
  }

  function validProviderId(cli, id) {
    if (id == null || id === '') return { ok: true, value: null };
    // Qoder CN remains vendor-managed. OpenCode and ZCode both support the two
    // MultiCC pools, so their provider ids are looked up globally and then
    // constrained by the provider's declared protocol compatibility.
    const appType = deps.providers.appTypeForCli(cli);
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

  function mountCatalogRoutes(app) {
    assertAppMethod(app, 'get');

    // MultiCC owns this store. CC-Switch is consulted only as a read-only
    // import source by the explicit import endpoint mounted below.
    app.get('/api/providers', (req, res) => {
      const appType = (req.query.appType || '').trim();
      const cli = (req.query.cli || '').trim();
      const ccSwitchStatus = deps.providers.getCcSwitchStatus();
      const providers = deps.providers.listProviders(
        appType === 'claude' || appType === 'codex' ? appType : undefined,
      ).filter(provider => !cli || deps.providers.providerSupportsCli(provider, cli));
      const nowMs = now();
      const staleAfterMs = deps.limitCacheStaleMs || STALE_MS_DEFAULT;
      // Attach the persistent last-known-good limit summary (if any) to each
      // provider, and prune entries whose provider identity vanished (deleted /
      // renamed). `limit` is a safe projection — the cache never stores
      // credentials, and only summary/format fields are exposed here.
      let limits = null;
      const cache = deps.providerLimitCache;
      const recorder = deps.limitRecorder;
      if (cache) {
        try {
          if (recorder) cache.prune(recorder.liveKeys());
          limits = {};
          for (const provider of providers) {
            const entry = cache.get(provider.appType, provider.id);
            limits[`${provider.appType}:${provider.id}`] = entry ? {
              kind: entry.kind,
              status: entry.status,
              summary: entry.summary,
              // Compact summary text (placeholders already stripped) — the
              // live bar text is intentionally not exposed; it carries
              // client-expanded {cd}/{ago} markers that a picker shouldn't
              // re-render.
              summaryText: entry.summaryText,
              fetchedAt: entry.fetchedAt,
              updatedAt: entry.updatedAt,
              lastError: entry.lastError,
              lastErrorAt: entry.lastErrorAt,
              stale: !!(entry.fetchedAt != null && nowMs - entry.fetchedAt > staleAfterMs),
            } : null;
          }
        } catch (_) { /* cache must never break the catalog */ }
      }
      const providersWithLimits = limits
        ? providers.map(provider => ({ ...provider, limit: limits[`${provider.appType}:${provider.id}`] || null }))
        : providers;
      res.json({
        available: true,
        ccSwitchAvailable: ccSwitchStatus.available,
        ccSwitchStatus,
        providers: providersWithLimits,
        defaults: providerDefaults,
        stats: deps.providers.getProviderUsageStats().stats,
        // Old clients ignore extra top-level fields; new clients use this to
        // decide whether a provider's `limit` counts as fresh without duplicating
        // the staleness constant in two codebases.
        limitCacheStaleMs: cache ? staleAfterMs : null,
      });
    });

    app.get('/api/providers/stats', (req, res) => {
      try {
        res.json(deps.providers.getProviderUsageStats());
      } catch (error) {
        res.status(500).json({ error: publicError(error, 'provider stats failed') });
      }
    });
  }

  function mountManagementRoutes(app) {
    for (const method of ['get', 'post', 'patch', 'delete', 'put']) assertAppMethod(app, method);

    app.post('/api/providers/import', (req, res) => {
      try {
        res.json({ ok: true, ...deps.providers.importFromCcSwitch() });
      } catch (error) {
        res.status(400).json(importErrorDto(error));
      }
    });

    app.post('/api/providers', (req, res) => {
      try {
        const result = deps.providers.createProvider({
          appType: (req.body.appType || '').trim(),
          name: req.body.name,
          baseUrl: (req.body.baseUrl || '').trim(),
          authToken: (req.body.authToken || '').trim(),
          model: (req.body.model || '').trim(),
          models: req.body.models,
          useChatResponsesProxy: req.body.useChatResponsesProxy,
          ...(req.body.apiFormat !== undefined ? { apiFormat: req.body.apiFormat } : {}),
          settingsConfig: req.body.settingsConfig,
          aliasMap: req.body.aliasMap,
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(400).json({ error: publicError(error, 'provider create failed') });
      }
    });

    app.patch('/api/providers/:appType/:id', (req, res) => {
      try {
        deps.providers.updateProvider(req.params.appType, req.params.id, {
          name: req.body.name,
          baseUrl: req.body.baseUrl,
          authToken: req.body.authToken,
          model: req.body.model,
          models: req.body.models,
          useChatResponsesProxy: req.body.useChatResponsesProxy,
          ...(req.body.apiFormat !== undefined ? { apiFormat: req.body.apiFormat } : {}),
          settingsConfig: req.body.settingsConfig,
          aliasMap: req.body.aliasMap,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({ error: publicError(error, 'provider update failed') });
      }
    });

    app.delete('/api/providers/:appType/:id', (req, res) => {
      try {
        const references = deps.findProviderReferences({
          appType: req.params.appType,
          providerId: req.params.id,
          sessions: deps.persistedSessions,
          defaults: providerDefaults,
          aux: deps.getAuxConfig(),
        });
        if (references.length) {
          return res.status(409).json({
            error: 'provider is still referenced',
            code: 'PROVIDER_IN_USE',
            references,
          });
        }
        const ok = deps.providers.deleteProvider(req.params.appType, req.params.id);
        if (ok) deps.providerRelayShares.revokeProvider(req.params.appType, req.params.id);
        res.json({ ok });
      } catch (error) {
        res.status(400).json({ error: publicError(error, 'provider delete failed') });
      }
    });

    app.post('/api/providers/:appType/:id/probe', async (req, res) => {
      try {
        const provider = deps.providers.getProvider(req.params.appType, req.params.id);
        if (!provider) return res.status(404).json({ error: 'provider not found' });
        const config = typeof provider.settingsConfig === 'string'
          ? JSON.parse(provider.settingsConfig)
          : (provider.settingsConfig || {});
        const env = (config && config.env) || {};
        const candidates = normalizeProbeCandidates(req.body && req.body.candidates);
        if (!candidates.ok) return res.status(candidates.status).json({ error: candidates.error });
        const result = await deps.providers.probeRelayModels(
          env,
          candidates.value,
          deps.claudeCmd,
        );
        res.json(sanitizeProbeResult(result));
      } catch (error) {
        res.status(400).json({ error: publicError(error, 'provider probe failed') });
      }
    });

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

        if (req.params.appType === 'codex') {
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
          const body = JSON.stringify(target.wireApi === 'responses'
            ? { model, input: 'hi', max_output_tokens: 1 }
            : { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
          let url;
          try {
            url = new URLCtor(target.url);
          } catch (_) {
            return res.json({ ok: false, ms: elapsed(), error: 'bad url' });
          }
          const isHttps = url.protocol === 'https:';
          const client = isHttps ? deps.https : deps.http;
          await runSpeedtestRequest({
            client,
            requestOptions: {
              hostname: url.hostname,
              port: url.port || (isHttps ? 443 : 80),
              path: url.pathname + url.search,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${target.apiKey}`,
              },
            },
            body,
            model,
            res,
            elapsed,
            setTimeoutFn,
            clearTimeoutFn,
          });
          return;
        }

        const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
        const isOfficial = req.params.id === 'claude-official';
        const canDirect = (env.ANTHROPIC_BASE_URL && hasKey)
          || (isOfficial && deps.getClaudeOfficialViaProxy());
        if (!canDirect) {
          return res.json({
            ok: false,
            ms: elapsed(),
            error: isOfficial
              ? 'OAuth 订阅型 provider 不支持测速（开启 CLAUDE_OFFICIAL_VIA_PROXY 可测速）'
              : '缺少 API Key 或 Base URL',
          });
        }

        const model = env.ANTHROPIC_MODEL
          || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
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
            path: `/claude-proxy/${req.params.id}/speedtest/v1/messages?beta=true`,
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

    // Each exported relay receives its own provider-scoped credential. The
    // share code discloses it once; durable inventory stores only its hash and
    // usage counters. MULTICC_PROXY_TOKEN is retained only for legacy imports.
    app.post('/api/providers/:appType/:id/relay-share', (req, res) => {
      const provider = deps.providers.getProvider(req.params.appType, req.params.id);
      if (!provider) return res.status(404).json({ error: 'provider not found' });
      let parsed = null;
      try { parsed = new URLCtor(String((req.body && req.body.publicBaseUrl) || '').trim()); } catch (_) {}
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return res.status(400).json({ error: 'publicBaseUrl must be an http(s) URL' });
      }
      const base = parsed.origin;
      const relayBaseUrl = req.params.appType === 'codex'
        ? `${base}/codex-proxy/${encodeURIComponent(req.params.id)}`
        : `${base}/claude-proxy/${encodeURIComponent(req.params.id)}/remote`;
      // Carry only public model metadata so the imported relay starts on a
      // model the source provider actually serves. This matters especially for
      // Codex Official: it has no model in config.toml, so without its cached
      // catalog the importer would fall back to the unrelated gpt-4o-mini.
      const summary = deps.providerRouterRuntime.getProviderSummary(
        req.params.appType,
        req.params.id,
      ) || {};
      const relayModels = [...new Set([
        summary.model,
        ...(Array.isArray(summary.modelOptions) ? summary.modelOptions : []),
      ].map(value => String(value || '').trim())
        .filter(value => value && value.length <= 256))].slice(0, 100);
      const payload = {
        v: 2,
        kind: 'multicc-relay',
        name: `${provider.name || req.params.id} · 借道`,
        appType: req.params.appType,
        baseUrl: relayBaseUrl,
        ...(relayModels[0] ? { model: relayModels[0], models: relayModels } : {}),
      };
      try {
        const created = deps.providerRelayShares.create({
          appType: req.params.appType,
          providerId: req.params.id,
          providerName: provider.name || req.params.id,
          publicBaseUrl: base,
          relayBaseUrl,
          token: req.body && req.body.token,
          label: req.body && req.body.label,
        });
        const code = 'mcrelay1.' + Buffer.from(JSON.stringify({
          ...payload,
          relayShareId: created.share.id,
          authToken: created.credential,
        }), 'utf8').toString('base64url');
        res.json({ ok: true, code, baseUrl: relayBaseUrl, share: created.share });
      } catch (error) {
        if (error && error.code === 'RELAY_TOKEN_INVALID') {
          return res.status(400).json({
            error: '借道令牌必须为 8–128 位无空格 ASCII 字符',
            code: 'RELAY_TOKEN_INVALID',
          });
        }
        return res.status(400).json({ error: publicError(error, 'relay share create failed') });
      }
    });

    app.get('/api/provider-relay-shares', (req, res) => {
      res.json({
        shares: deps.providerRelayShares.list({
          appType: req.query.appType,
          providerId: req.query.providerId,
        }),
      });
    });

    app.delete('/api/provider-relay-shares/:id', (req, res) => {
      try {
        const share = deps.providerRelayShares.revoke(req.params.id);
        if (!share) return res.status(404).json({ error: 'relay share not found' });
        return res.json({ ok: true, share });
      } catch (error) {
        return res.status(500).json({ error: publicError(error, 'relay share revoke failed') });
      }
    });

    app.get('/api/provider-defaults', (req, res) => res.json(providerDefaults));
    app.put('/api/provider-defaults', (req, res) => {
      const nextDefaults = { ...providerDefaults };
      for (const cli of ['claude', 'codex']) {
        if (req.body[cli] !== undefined) {
          const value = validProviderId(cli, req.body[cli]);
          if (!value.ok) return res.status(400).json({ error: `invalid ${cli} provider id` });
          nextDefaults[cli] = value.value;
        }
      }
      Object.assign(providerDefaults, nextDefaults);
      saveProviderDefaults();
      res.json({ ok: true, defaults: providerDefaults });
    });
  }

  return Object.freeze({
    providerDefaults,
    validProviderId,
    mountCatalogRoutes,
    mountManagementRoutes,
  });
}

function mountProviderRoutes(app, deps) {
  const routes = createProviderRoutes(deps);
  routes.mountCatalogRoutes(app);
  routes.mountManagementRoutes(app);
  return routes;
}

module.exports = {
  DEFAULT_PROVIDER_IDS,
  assertProviderRouteDeps,
  createProviderRoutes,
  importErrorDto,
  mountProviderRoutes,
  publicError,
  sanitizeProbeResult,
};

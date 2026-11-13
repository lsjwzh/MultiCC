'use strict';

// 宿主端口：公开 providers 路由已由 Rust 前门独占。
// 路径、校验、目录投影和响应组装见 native/gateway/src/app/providers.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   catalog            provider / 额度 / 订阅的内存快照与尚未迁移的 bar 渲染
//   usageStats         usage 统计读内存表
//   import             只读导入 CC-Switch
//   create/update      provider store 写盘
//   deleteFacts/Exec   引用枚举（会话表/默认值/Aux）与强制解绑
//   probeFacts/Exec    回环探测线路的模型
//   reassign*          批量迁移会话（走 applySessionPatch 的进程内会话 PATCH）
//   relayShare*        借道凭据的签发/清单/撤销/复制
//   relayModelsSync    借道线路的模型目录强制刷新
//   defaults*          provider-defaults.json 的进程内对象与落盘
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');
const { safeCode, sanitizePublicText } = require('../http/public-safety');
const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache');
const { providerLimitBar } = require('../quota/quota-bar-view');
const { detachProviderReferences } = require('../providers/force-detach');
const { reassignProviderSessions } = require('../provider-reassign');

const HOST_PATH = '/api/__host/providers';

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

function text(value) {
  return typeof value === 'string' ? value : '';
}

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[providers-host] dependencies are required');
  }
  for (const name of ['findProviderReferences', 'getAuxConfig', 'getPort', 'saveProviderDefaults', 'validProviderId']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[providers-host] dependency missing: ${name}`);
    }
  }
  const providers = deps.providers;
  if (!providers || typeof providers !== 'object') {
    throw new TypeError('[providers-host] providers is required');
  }
  for (const name of [
    'getCcSwitchStatus', 'listProviders', 'getProviderUsageStats',
    'importFromCcSwitch', 'createProvider', 'updateProvider', 'deleteProvider',
    'getProvider', 'probeRelayModels', 'claudeProbeRouteEnv',
  ]) {
    if (typeof providers[name] !== 'function') {
      throw new TypeError(`[providers-host] providers.${name} is required`);
    }
  }
  if (!deps.providerRouterRuntime || typeof deps.providerRouterRuntime.getProviderSummary !== 'function') {
    throw new TypeError('[providers-host] providerRouterRuntime.getProviderSummary is required');
  }
  if (!deps.providerDefaults || typeof deps.providerDefaults !== 'object') {
    throw new TypeError('[providers-host] providerDefaults object is required');
  }
  const shares = deps.providerRelayShares;
  if (!shares || typeof shares.create !== 'function' || typeof shares.list !== 'function'
      || typeof shares.getCredential !== 'function' || typeof shares.revoke !== 'function'
      || typeof shares.revokeProvider !== 'function') {
    throw new TypeError('[providers-host] providerRelayShares runtime is required');
  }
  if (typeof deps.claudeCmd !== 'string') {
    throw new TypeError('[providers-host] claudeCmd is required');
  }
}

function mountProvidersHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[providers-host] Express-compatible app is required');
  }
  assertDependencies(options);
  const deps = options;
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = options.logger || console;

  async function catalogFacts(body) {
    const appType = text(body.appType).trim();
    const cli = text(body.cli).trim();
    // Model pickers on both Web and App already read this endpoint.  Make
    // that existing read the automatic refresh trigger for imported relay
    // catalogs; the runtime is TTL-bound/in-flight-deduped, and any remote
    // failure keeps the durable last-known-good snapshot intact.
    if (deps.relayModelCatalogRuntime
        && typeof deps.relayModelCatalogRuntime.refreshDue === 'function') {
      try {
        await deps.relayModelCatalogRuntime.refreshDue({ appType, cli });
      } catch (_) { /* a catalog refresh must never hide the Provider list */ }
    }
    const ccSwitchStatus = deps.providers.getCcSwitchStatus();
    const subscriptions = require('../quota/account-subscription-cache');
    await subscriptions.ready().catch(() => {});
    // 这里只读宿主快照；筛选、订阅投影、公开限额字段和虚拟线路选择由前门组装。
    const providers = deps.providers.listProviders(
      appType === 'claude' || appType === 'codex' ? appType : undefined,
    );
    // 保留共享订阅缓存的跨进程重新加载触发，不在 Node 侧投影目录。
    subscriptions.project([]);
    const nowMs = now();
    const staleAfterMs = deps.limitCacheStaleMs || STALE_MS_DEFAULT;
    const cache = deps.providerLimitCache;
    let limits = null;
    const limitBars = {};
    if (cache) {
      try {
        if (deps.limitRecorder) await cache.prune(deps.limitRecorder.liveKeys());
        limits = {};
        for (const provider of providers) {
          const key = provider.appType + ':' + provider.id;
          const entry = await cache.get(provider.appType, provider.id);
          // 此共享渲染器仍服务其他 Node quota 调用者；迁移它时删除这个最后的展示端口。
          const bar = entry ? providerLimitBar({ ...entry,
            stale: !!(entry.fetchedAt != null && nowMs - entry.fetchedAt > staleAfterMs) }, nowMs) : null;
          limits[key] = entry || null;
          limitBars[key] = bar;
        }
      } catch (_) { /* cache must never break the catalog */ }
    }
    const virtualInputs = {};
    for (const provider of providers) {
      if (!provider.virtual) continue;
      const key = provider.appType + ':' + provider.id;
      try {
        const virtual = require('../providers/virtual-provider');
        virtualInputs[key] = cache?.isAsync
          ? await virtual.snapshotAsync(provider, deps.providers.listProviders())
          : virtual.snapshot(provider, deps.providers.listProviders());
      } catch (_) { virtualInputs[key] = null; }
    }
    return {
      ok: true,
      ccSwitchStatus,
      providers,
      subscriptions: subscriptions.snapshot(),
      limits,
      limitBars,
      virtualInputs,
      nowMs,
      stats: deps.providers.getProviderUsageStats().stats,
      defaults: deps.providerDefaults,
      limitCacheStaleMs: cache ? staleAfterMs : null,
    };
  }

  function normalizeTargetProviderId(value) {
    return value == null || value === '' ? null : String(value).trim();
  }

  async function handle(body) {
    if (body.op === 'catalog') return catalogFacts(body);

    if (body.op === 'catalogRefresh') {
      const runtime = deps.codexAccountModelCatalogRuntime;
      if (runtime && Array.isArray(body.providerIds)) {
        for (const id of body.providerIds) {
          if (typeof id !== 'string') continue;
          try { Promise.resolve(runtime.refreshProvider(id)).catch(() => {}); }
          catch (_) { /* refresh must never block the catalog */ }
        }
      }
      return { ok: true };
    }

    if (body.op === 'usageStats') {
      try {
        return { ok: true, stats: deps.providers.getProviderUsageStats() };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider stats failed') } };
      }
    }

    if (body.op === 'import') {
      try {
        return { ok: true, result: deps.providers.importFromCcSwitch() };
      } catch (error) {
        // The legacy DTO called the message `error`; the host contract names it
        // `message` like every other op, so the front door maps one shape.
        const dto = importErrorDto(error);
        return {
          ok: false,
          error: {
            message: dto.error,
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
          },
        };
      }
    }

    if (body.op === 'create') {
      const input = (body.body && typeof body.body === 'object' && !Array.isArray(body.body)) ? body.body : {};
      try {
        return { ok: true, result: deps.providers.createProvider(input) };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider create failed') } };
      }
    }

    if (body.op === 'update') {
      const input = (body.body && typeof body.body === 'object' && !Array.isArray(body.body)) ? body.body : {};
      try {
        deps.providers.updateProvider(text(body.appType), text(body.id), input);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider update failed') } };
      }
    }

    if (body.op === 'deleteFacts') {
      const references = deps.findProviderReferences({
        appType: text(body.appType),
        providerId: text(body.id),
        sessions: deps.persistedSessions,
        defaults: deps.providerDefaults,
        aux: deps.getAuxConfig(),
      });
      const forceable = typeof deps.applySessionPatch === 'function' && typeof deps.clearAuxProvider === 'function';
      return { ok: true, references, forceable };
    }

    if (body.op === 'deleteExec') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      const references = Array.isArray(body.references) ? body.references : [];
      try {
        let detached = [];
        if (references.length) {
          const result = detachProviderReferences({
            providerId,
            references,
            sessions: deps.persistedSessions,
            applySessionPatch: deps.applySessionPatch,
            clearDefault: (cli) => { if (deps.providerDefaults[cli] === providerId) { deps.providerDefaults[cli] = null; deps.saveProviderDefaults(); } },
            clearAuxProvider: deps.clearAuxProvider,
          });
          if (result.failed.length) {
            return { ok: true, deleteOk: false, detached: result.detached, failed: result.failed };
          }
          detached = result.detached;
          log.warn?.(`[multicc] force-deleting provider ${appType}/${providerId}: detached ${detached.length} reference(s)`);
        }
        const deleteOk = deps.providers.deleteProvider(appType, providerId);
        if (deleteOk) await deps.providerRelayShares.revokeProvider(appType, providerId);
        return { ok: true, deleteOk: !!deleteOk, detached, failed: [] };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider delete failed') } };
      }
    }

    if (body.op === 'probeFacts') {
      return { ok: true, exists: !!deps.providers.getProvider(text(body.appType), text(body.id)) };
    }

    if (body.op === 'probeExec') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      try {
        const provider = deps.providers.getProvider(appType, providerId);
        if (!provider) return { ok: false, error: { message: 'provider not found' } };
        // The probe used to spawn the CLI with the provider's raw env — i.e.
        // straight at the vendor endpoint, with the vendor credential in a
        // throwaway child process, measuring a path production traffic never
        // takes. Materialize the same loopback route a real turn gets; the
        // probe then measures the hop multicc actually uses (null = nothing to
        // probe, the entry has no upstream base URL).
        const routeEnv = deps.providers.claudeProbeRouteEnv(appType, providerId, deps.getPort());
        const result = routeEnv
          ? await deps.providers.probeRelayModels(routeEnv, body.candidates, deps.claudeCmd)
          : { tested: [], accepted: [], error: 'no base url' };
        return { ok: true, result: sanitizeProbeResult(result) };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider probe failed') } };
      }
    }

    if (body.op === 'reassignFacts') {
      return {
        ok: true,
        sourceExists: !!deps.providers.getProvider(text(body.appType), text(body.id)),
        patchRuntime: typeof deps.applySessionPatch === 'function',
      };
    }

    if (body.op === 'reassignTarget') {
      const targetProviderId = normalizeTargetProviderId(body.targetProviderId);
      return {
        ok: true,
        target: targetProviderId ? (deps.providers.getProvider(undefined, targetProviderId) || null) : null,
      };
    }

    if (body.op === 'reassignExec') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      const targetProviderId = normalizeTargetProviderId(body.targetProviderId);
      const dryRun = body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true';
      const sourceProvider = deps.providers.getProvider(appType, providerId);
      if (!sourceProvider) return { ok: false, error: { message: 'provider not found' } };
      let targetProvider = null;
      if (targetProviderId) {
        // Provider ids are globally unique, so the target may live in the other
        // pool (an OpenCode/ZCode session can move across pools).
        targetProvider = deps.providers.getProvider(undefined, targetProviderId);
        if (!targetProvider) return { ok: false, error: { message: 'target provider not found' } };
      }
      if (typeof deps.applySessionPatch !== 'function') {
        return { ok: false, error: { message: 'session patch runtime unavailable' } };
      }
      try {
        const result = reassignProviderSessions({
          appType,
          providerId,
          sourceProvider,
          targetProviderId,
          targetProvider,
          dryRun,
          sessions: deps.persistedSessions,
          references: deps.findProviderReferences({
            appType,
            providerId,
            sessions: deps.persistedSessions,
            defaults: deps.providerDefaults,
            aux: deps.getAuxConfig(),
          }),
          listProviders: () => deps.providers.listProviders(),
          validProviderId: deps.validProviderId,
          applySessionPatch: deps.applySessionPatch,
          previewSessionPatch: deps.previewSessionPatch,
        });
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider reassignment failed') } };
      }
    }

    if (body.op === 'relayShareFacts') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      const provider = deps.providers.getProvider(appType, providerId);
      return {
        ok: true,
        provider: provider ? { name: provider.name } : null,
        summary: deps.providerRouterRuntime.getProviderSummary(appType, providerId) || {},
      };
    }

    if (body.op === 'relayShareCreate') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      try {
        const created = await deps.providerRelayShares.create({
          appType,
          providerId,
          providerName: body.providerName,
          publicBaseUrl: text(body.publicBaseUrl),
          relayBaseUrl: text(body.relayBaseUrl),
          token: body.token,
          label: body.label,
        });
        return { ok: true, share: created.share, credential: created.credential };
      } catch (error) {
        if (error && error.code === 'RELAY_TOKEN_INVALID') {
          return {
            ok: false,
            code: 'RELAY_TOKEN_INVALID',
            error: { message: '共享凭据必须为 8–128 位无空格 ASCII 字符' },
          };
        }
        return { ok: false, error: { message: publicError(error, 'relay share create failed') } };
      }
    }

    if (body.op === 'relayModelsSync') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      const found = !!deps.providers.getProvider(appType, providerId);
      const runtime = deps.relayModelCatalogRuntime;
      const available = !!runtime && typeof runtime.syncProvider === 'function';
      const result = found && available
        ? await runtime.syncProvider(appType, providerId, { force: true })
        : null;
      return { ok: true, found, available, result };
    }

    if (body.op === 'relaySharesList') {
      try {
        return {
          ok: true,
          shares: await deps.providerRelayShares.list({
            appType: body.appType,
            providerId: body.providerId,
          }),
        };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'relay share list failed') } };
      }
    }

    if (body.op === 'relayShareRevoke') {
      try {
        return { ok: true, share: await deps.providerRelayShares.revoke(text(body.id)) };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'relay share revoke failed') } };
      }
    }

    if (body.op === 'relayShareCodeFacts') {
      try {
        const found = await deps.providerRelayShares.getCredential(text(body.id));
        if (!found || !found.ok) return { ok: true, found };
        const share = found.share;
        const provider = deps.providers.getProvider(share.appType, share.providerId);
        return {
          ok: true,
          found,
          provider: provider ? { name: provider.name } : null,
          summary: deps.providerRouterRuntime.getProviderSummary(share.appType, share.providerId) || {},
        };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'relay share copy failed') } };
      }
    }

    if (body.op === 'relayImportFacts') {
      const appType = text(body.appType);
      const providerId = text(body.id);
      const provider = deps.providers.getProvider(appType, providerId);
      return {
        ok: true,
        provider: provider ? { name: provider.name } : null,
        summary: deps.providerRouterRuntime.getProviderSummary(appType, providerId) || {},
        token: typeof deps.providers.getRelayImportToken === 'function'
          ? deps.providers.getRelayImportToken(appType, providerId) : '',
      };
    }

    if (body.op === 'speedtestFacts') {
      const appType = text(body.appType);
      const id = text(body.id);
      try {
        const provider = deps.providers.getProvider(appType, id);
        if (!provider) return { ok: true, found: false };
        const config = typeof provider.settingsConfig === 'string'
          ? JSON.parse(provider.settingsConfig)
          : (provider.settingsConfig || {});
        const env = (config && config.env) || {};
        const officialCodex = deps.providers.isOfficialCodexOAuthProvider(provider);
        if (appType === 'codex' && officialCodex) {
          return {
            ok: true,
            found: true,
            kind: 'codex',
            official: true,
            summary: deps.providerRouterRuntime.getProviderSummary('codex', id) || {},
          };
        }
        if (appType === 'codex') {
          // Capability pre-check only: the hop owns the target's url/apiKey.
          const target = deps.providers.resolveCodexDirectHttp(id);
          return {
            ok: true,
            found: true,
            kind: 'codex',
            official: false,
            canDirect: !!target.canDirect,
            reason: target.reason,
            modelOptions: target.modelOptions,
            model: target.model,
          };
        }
        return {
          ok: true,
          found: true,
          kind: 'claude',
          official: id === 'claude-official'
            || !!require('../official-accounts').officialAccountIdFromProvider(provider),
          hasKey: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
          env: {
            ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
            ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
            ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          },
          summary: deps.providerRouterRuntime.getProviderSummary('claude', id) || {},
          fallbackModels: require('../claude-models').CLAUDE_MODELS_FALLBACK.map(entry => entry.model),
          wireDefaultModel: deps.providers.WIRE_DEFAULT_MODEL,
        };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider speedtest failed') } };
      }
    }

    if (body.op === 'v1Providers') {
      const appType = text(body.appType);
      try {
        return {
          ok: true,
          providers: deps.providers.listProviders(
            appType === 'claude' || appType === 'codex' ? appType : undefined,
          ),
        };
      } catch (error) {
        return { ok: false, error: { message: publicError(error, 'provider list failed') } };
      }
    }

    if (body.op === 'defaultsGet') {
      return { ok: true, defaults: deps.providerDefaults };
    }

    if (body.op === 'defaultsValidate') {
      const result = deps.validProviderId(text(body.cli), body.id);
      return {
        ok: true,
        valid: result.ok === true,
        value: result.ok === true ? (result.value === undefined ? null : result.value) : null,
      };
    }

    if (body.op === 'defaultsPersist') {
      Object.assign(deps.providerDefaults, (body.next && typeof body.next === 'object' && !Array.isArray(body.next)) ? body.next : {});
      deps.saveProviderDefaults();
      return { ok: true, defaults: deps.providerDefaults };
    }

    return null;
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve(handle(body)).then(
      (value) => {
        if (value === null) return res.status(400).json({ error: 'unknown host operation' });
        return res.json(value);
      },
      () => res.status(500).json({ error: 'host operation failed' }),
    );
  });
}

module.exports = {
  HOST_PATH,
  importErrorDto,
  mountProvidersHostRoute,
  publicError,
  publicText,
  sanitizeProbeResult,
};

'use strict';

// 冻结基线：`src/providers/core.js` 的 saveVirtualProvider / createProvider /
// updateProvider / deleteProvider 在写入决策迁入 Rust 之前的实现（逐字取自提交
// 0860ed62 的工作树状态）。
//
// 与生产实现的唯一区别是依赖注入：store 的读写、官方目录、虚拟线路校验、
// uuid/时间/端口全部由 createLegacyWrites(deps) 传入，这样 tests/
// test-provider-writes-differential.js 能用同一份记录清单和同一组事实同时喂给
// 两侧，比较「下一份清单 + 返回值 + 副作用调用序列」的字节。
//
// 它刻意不再随生产代码变化：跟着改就等于拿新实现和自己比，差分永久失去辨别力。

function createLegacyWrites(deps) {
  const {
    loadStore, saveStore, officialCatalog, isOfficialProviderId, summarize,
    getProvider, listProviders, validateVirtual, buildSettingsConfig,
    normalizeApiFormat, assertApiFormatMatchesAppType, normalizeEgressIpAllowlist,
    normalizeEgressBinding, parseConfig, parseModelList, applyAliasMapToEnv,
    ensureZhipuFableAlias, tomlValue, randomUUID, now,
  } = deps;
  const crypto = { randomUUID };
  const Date = { now };
  const APP_TYPES = ['claude', 'codex'];

  function saveVirtualProvider(appType, id, name, virtual) {
    if (!String(name || '').trim()) throw new Error('name required');
    const plan = validateVirtual({ appType, id, virtual, providers: listProviders() });
    const list = loadStore();
    const previous = list.find(p => p.id === id && p.appType === appType);
    const record = { id, appType, name: String(name).trim(), source: 'local', virtual: plan.virtual,
      apiFormat: appType === 'claude' ? 'anthropic' : 'openai_responses',
      createdAt: previous?.createdAt || Date.now(),
      // Non-routable placeholder: only Rust CPR may resolve virtual members.
      settingsConfig: buildSettingsConfig(appType, { baseUrl: 'https://virtual.invalid',
        authToken: 'multicc-virtual', providerId: id, model: plan.models[0] || '', models: plan.models }) };
    if (previous) list[list.indexOf(previous)] = record; else list.push(record);
    saveStore(list);
    return { id, appType, name: record.name };
  }

  function createProvider({ appType, name, baseUrl, authToken, model, models, apiFormat, settingsConfig, aliasMap, egressIpAllowlist, egressBinding, virtual }) {
    if (virtual !== undefined) return saveVirtualProvider(appType, crypto.randomUUID(), name, virtual);
    if (!APP_TYPES.includes(appType)) throw new Error('appType must be claude or codex');
    if (!name || !String(name).trim()) throw new Error('name required');
    // Official entries are never created here (they come from the account
    // catalog), so a brand-new provider can't own a dedicated egress.
    if (egressBinding !== undefined) throw new Error('专用出口只能绑在 Claude 官方账号线路上');
    assertApiFormatMatchesAppType(apiFormat, appType);
    // Generate id first so buildSettingsConfig can embed it in the proxy base_url.
    const id = crypto.randomUUID();
    const cfg = (settingsConfig && typeof settingsConfig === 'object')
      ? settingsConfig
      : buildSettingsConfig(appType, { baseUrl, authToken, model, models, apiFormat, providerId: id, aliasMap });
    const format = normalizeApiFormat(apiFormat, appType, cfg);
    const p = {
      id,
      appType,
      apiFormat: format,
      name: String(name).trim(),
      source: 'local',
      settingsConfig: cfg,
      createdAt: Date.now(),
    };
    const normalizedEgressIpAllowlist = normalizeEgressIpAllowlist(egressIpAllowlist);
    if (normalizedEgressIpAllowlist.length) p.egressIpAllowlist = normalizedEgressIpAllowlist;
    const list = loadStore();
    if (officialCatalog && officialCatalog.isOfficial(p)) return summarize(officialCatalog.provider(appType));
    list.push(p);
    saveStore(list);
    return { id: p.id, appType, name: p.name };
  }

  function updateProvider(appType, id, { name, baseUrl, authToken, model, models, apiFormat, settingsConfig, aliasMap, egressIpAllowlist, egressBinding, virtual }) {
    const existingVirtual = getProvider(appType, id);
    if (virtual !== undefined || existingVirtual?.virtual) {
      if (!existingVirtual?.virtual) throw new Error('普通线路不能直接转换成虚拟线路，请新建组合');
      return saveVirtualProvider(appType, id, name ?? existingVirtual.name, virtual ?? existingVirtual.virtual);
    }
    if (officialCatalog && (isOfficialProviderId(appType, id) || isOfficialProviderId(appType, officialCatalog.normalize(appType, id)))) {
      // Login/account identity is OAuth-managed and not editable here. Advanced
      // settings (currently: egress-IP allowlist) are the one thing an official
      // provider's editor may still submit — persisted as a minimal override
      // record (see official-catalog.js's provider() merge), everything else
      // still bounces to the dedicated official-account flow.
      if ([name, baseUrl, authToken, model, models, apiFormat, settingsConfig, aliasMap].some(v => v !== undefined)) {
        throw new Error('请在官方账号中管理登录和切换账号');
      }
      // The allowlist override belongs to the entry being edited: the terminal
      // alias keeps its own record, each account entry gets its own — never a
      // vendor-wide shared one (an unrestricted account must stay unrestricted).
      // The dedicated-egress binding is per entry for the same reason: binding one
      // account to an egress profile must never move the others.
      const targetId = isOfficialProviderId(appType, id)
        ? id
        : officialCatalog.normalize(appType, id);
      const list = loadStore();
      const normalized = normalizeEgressIpAllowlist(egressIpAllowlist);
      const binding = normalizeEgressBinding(egressBinding);
      let p = list.find(x => x.appType === appType && x.id === targetId);
      if (!p && (normalized.length || binding)) {
        p = { id: targetId, appType, source: 'builtin-override' };
        list.push(p);
      }
      if (p) {
        // `undefined` = this PATCH didn't touch the allowlist (e.g. the UI only
        // sent an egress binding); only an explicit list or `[]` rewrites it.
        if (egressIpAllowlist !== undefined) {
          if (normalized.length) p.egressIpAllowlist = normalized;
          else delete p.egressIpAllowlist;
        }
        if (binding) p.egressBinding = binding;
        else if (binding === null) delete p.egressBinding;
        // Drop the record only when it is a pure override stub; a record that
        // carries anything else (e.g. a legacy import with a name) keeps its
        // identity and just loses the settings.
        if (p.source === 'builtin-override' && !p.egressIpAllowlist && !p.egressBinding) {
          const idx = list.indexOf(p);
          if (idx !== -1) list.splice(idx, 1);
        }
      }
      saveStore(list);
      return { id: targetId, appType };
    }
    // A dedicated egress only means something for an OAuth-managed official entry:
    // any other line already names its own upstream, and routing it through the
    // loopback hop would need a different pipeline. Reject instead of storing a
    // binding that silently does nothing.
    if (egressBinding !== undefined) {
      throw new Error('专用出口只能绑在 Claude 官方账号线路上');
    }
    assertApiFormatMatchesAppType(apiFormat, appType);
    const list = loadStore();
    const p = list.find(x => x.appType === appType && x.id === id);
    if (!p) throw new Error('provider not found');
    let cfg = parseConfig(p.settingsConfig);
    if (settingsConfig && typeof settingsConfig === 'object') {
      cfg = settingsConfig;
    } else if (appType === 'claude') {
      cfg.env = cfg.env || {};
      if (baseUrl !== undefined) { if (baseUrl) cfg.env.ANTHROPIC_BASE_URL = baseUrl; else delete cfg.env.ANTHROPIC_BASE_URL; }
      if (authToken !== undefined && authToken) cfg.env.ANTHROPIC_AUTH_TOKEN = authToken;
      if (model !== undefined) { if (model) cfg.env.ANTHROPIC_MODEL = model; else delete cfg.env.ANTHROPIC_MODEL; }
      if (models !== undefined || model !== undefined) {
        cfg.modelCatalog = { models: parseModelList(models, model !== undefined ? model : cfg.env.ANTHROPIC_MODEL).map(m => ({ model: m })) };
      }
      if (aliasMap !== undefined) applyAliasMapToEnv(cfg.env, aliasMap);
      // Bounded Zhipu fable fill on edit-save (also fires when aliasMap is not
      // part of the update — e.g. a legacy provider whose editor only touched
      // the model list). Never overwrites a non-empty custom fable mapping.
      ensureZhipuFableAlias(cfg.env);
    } else {
      const currentBaseUrl = (cfg.proxyTarget && cfg.proxyTarget.originalBaseUrl) || tomlValue(cfg.config, 'base_url');
      const rebuilt = buildSettingsConfig('codex', {
        baseUrl: baseUrl !== undefined ? baseUrl : currentBaseUrl,
        authToken: authToken || (cfg.auth && cfg.auth.OPENAI_API_KEY) || '',
        model: model !== undefined ? model : tomlValue(cfg.config, 'model'),
        models: models !== undefined
          ? models
          : ((cfg.modelCatalog && Array.isArray(cfg.modelCatalog.models)) ? cfg.modelCatalog.models.map(m => m && m.model).filter(Boolean) : undefined),
        apiFormat,
        providerId: id,
      });
      // Drop a stale proxyTarget if the rebuilt config no longer needs one.
      cfg = { ...cfg, ...rebuilt };
      if (!rebuilt.proxyTarget) delete cfg.proxyTarget;
    }
    if (name) p.name = String(name).trim();
    p.apiFormat = normalizeApiFormat(apiFormat || p.apiFormat, appType, cfg);
    p.settingsConfig = cfg;
    if (egressIpAllowlist !== undefined) {
      const normalized = normalizeEgressIpAllowlist(egressIpAllowlist);
      if (normalized.length) p.egressIpAllowlist = normalized;
      else delete p.egressIpAllowlist;
    }
    saveStore(list);
    return { id, appType };
  }

  function deleteProvider(appType, id) {
    if (officialCatalog && id === `${appType}-official`) throw new Error(`“同 ${appType === 'codex' ? 'Codex' : 'Claude'} 终端”为内置线路，不能删除`);
    if (officialCatalog && isOfficialProviderId(appType, id)) {
      const deleted = officialCatalog.delete(appType, id);
      // The account's allowlist override record (if any) outlived its synthetic
      // provider — drop it so store reads never see a dead entry's restriction.
      const list = loadStore();
      const next = list.filter(p => !(p.appType === appType && p.id === id));
      if (next.length !== list.length) saveStore(next, list);
      return deleted;
    }
    const list = loadStore();
    const next = list.filter(p => !(p.appType === appType && p.id === id));
    if (next.length === list.length) return false;
    saveStore(next, list);
    return true;
  }
  return { saveVirtualProvider, createProvider, updateProvider, deleteProvider };
}

module.exports = { createLegacyWrites };

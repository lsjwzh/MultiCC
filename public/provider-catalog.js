'use strict';

(function initProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.MultiCCProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window : null, function createProviderCatalog() {
  const APP_TYPES = new Set(['claude', 'codex']);
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  function text(value, max = 300) {
    const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : 0;
  }

  function safeBaseUrl(value) {
    const raw = text(value, 2048);
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, raw.endsWith('/') ? '/' : '');
    } catch (_) {
      return '';
    }
  }

  function normalizeModelOptions(value, primary) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const seen = new Set();
    const result = [];
    for (const item of [primary, ...source]) {
      const model = text(item, 240);
      if (model && !seen.has(model)) {
        seen.add(model);
        result.push(model);
      }
    }
    return result;
  }

  function normalizeAliasMap(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    for (const tier of ALIAS_TIERS) {
      const entry = source[tier];
      if (!entry || typeof entry !== 'object') continue;
      const model = text(entry.model, 240);
      if (!model) continue;
      result[tier] = { model, name: text(entry.name, 160) };
    }
    return result;
  }

  function safeTokenMask(value) {
    const mask = text(value, 32);
    return mask === '***' || mask.includes('…') ? mask : '';
  }

  function normalizeProvider(value) {
    if (!value || typeof value !== 'object') return null;
    const id = text(value.id, 180);
    const appType = text(value.appType, 20).toLowerCase();
    if (!id || !APP_TYPES.has(appType)) return null;
    const model = text(value.model, 240);
    return Object.freeze({
      id,
      appType,
      name: text(value.name, 240) || id,
      source: value.source === 'ccswitch' ? 'ccswitch' : 'local',
      baseUrl: safeBaseUrl(value.baseUrl),
      model,
      modelOptions: Object.freeze(normalizeModelOptions(value.modelOptions || value.models, model)),
      aliasOnly: value.aliasOnly === true,
      aliasMap: Object.freeze(normalizeAliasMap(value.aliasMap)),
      useChatResponsesProxy: value.useChatResponsesProxy === true,
      tokenMask: safeTokenMask(value.tokenMask),
      hasToken: value.hasToken === true,
      isOfficial: value.isOfficial === true,
    });
  }

  function normalizeDefaults(value) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      claude: text(source.claude, 180) || null,
      codex: text(source.codex, 180) || null,
    });
  }

  function normalizeWindow(value) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      inputTokens: number(source.inputTokens),
      outputTokens: number(source.outputTokens),
    });
  }

  function normalizeStat(value) {
    if (!value || typeof value !== 'object') return null;
    const providerId = text(value.providerId, 180);
    if (!providerId) return null;
    return Object.freeze({
      providerId,
      today: normalizeWindow(value.today),
      week: normalizeWindow(value.week),
      month: normalizeWindow(value.month),
      totalTokens: number(value.totalTokens),
      turnCount: number(value.turnCount),
      sessionCount: number(value.sessionCount),
    });
  }

  function normalizeCcSwitchStatus(value, availableFallback) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      available: source.available === true || (!value && availableFallback === true),
      dbFound: source.dbFound === true || (!value && availableFallback === true),
      reason: text(source.reason, 100) || null,
      message: text(source.message, 500),
    });
  }

  function normalizeCatalog(value) {
    const source = value && typeof value === 'object' ? value : {};
    const providers = (Array.isArray(source.providers) ? source.providers : [])
      .map(normalizeProvider)
      .filter(Boolean);
    const stats = (Array.isArray(source.stats) ? source.stats : [])
      .map(normalizeStat)
      .filter(Boolean);
    const ccSwitchAvailable = source.ccSwitchAvailable === true;
    return Object.freeze({
      available: source.available === true,
      ccSwitchAvailable,
      ccSwitchStatus: normalizeCcSwitchStatus(source.ccSwitchStatus, ccSwitchAvailable),
      providers: Object.freeze(providers),
      defaults: normalizeDefaults(source.defaults),
      stats: Object.freeze(stats),
    });
  }

  function groupByAppType(value) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const groups = { claude: [], codex: [] };
    for (const provider of providers) {
      if (provider && APP_TYPES.has(provider.appType)) groups[provider.appType].push(provider);
    }
    return groups;
  }

  function findProvider(value, appType, id) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const type = appType ? text(appType, 20).toLowerCase() : '';
    const providerId = text(id, 180);
    return providers.find(provider => provider && provider.id === providerId && (!type || provider.appType === type)) || null;
  }

  function modelsFor(value) {
    return value ? normalizeModelOptions(value.modelOptions, value.model) : [];
  }

  function normalizeDeleteReferences(value) {
    const source = value && value.details ? value.details : value;
    const refs = source && Array.isArray(source.references) ? source.references : [];
    return refs.slice(0, 100).map((ref) => {
      if (!ref || typeof ref !== 'object') return null;
      const kind = text(ref.kind, 30).toLowerCase();
      if (kind === 'main' || kind === 'subagent') {
        const sessionId = text(ref.sessionId, 180);
        const sessionName = text(ref.sessionName, 240);
        return { kind, title: sessionName || sessionId || kind, detail: sessionId };
      }
      if (kind === 'default') {
        const cli = text(ref.cli, 30);
        return { kind, title: cli || 'default', detail: '' };
      }
      if (kind === 'aux') {
        const protocol = text(ref.protocol, 40);
        return { kind, title: protocol || 'aux', detail: '' };
      }
      return null;
    }).filter(Boolean);
  }

  function deleteReferenceDisplayData(value) {
    const items = normalizeDeleteReferences(value);
    return Object.freeze({
      count: items.length,
      kinds: Object.freeze(Array.from(new Set(items.map(item => item.kind)))),
      items: Object.freeze(items.map(Object.freeze)),
    });
  }

  return {
    normalizeProvider,
    normalizeCatalog,
    normalizeDefaults,
    normalizeModelOptions,
    groupByAppType,
    findProvider,
    modelsFor,
    normalizeDeleteReferences,
    deleteReferenceDisplayData,
  };
});

'use strict';

(function initProviderCatalog(root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  if (root) root.MultiCCProviderCatalog = catalog;
})(typeof window !== 'undefined' ? window : null, function createProviderCatalog() {
  const APP_TYPES = new Set(['claude', 'codex']);
  const API_FORMATS = new Set(['anthropic', 'openai_responses', 'openai_chat']);
  const ALIAS_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

  function text(value, max = 300) {
    const out = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return out.length > max ? out.slice(0, max) : out;
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : 0;
  }

  function formatCompactTokens(value) {
    const count = number(value);
    if (count >= 1000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(count);
  }

  function formatUsageWindow(value) {
    const window = normalizeWindow(value);
    if (window.inputTokens + window.outputTokens === 0) return '';
    const output = formatCompactTokens(window.outputTokens);
    if (!window.breakdownKnown) {
      return `入(含缓存):${formatCompactTokens(window.inputTokens)}/出:${output}`;
    }
    const unknown = window.unattributedInputTokens;
    return `新:${formatCompactTokens(window.freshInputTokens)}` +
      `/缓读:${formatCompactTokens(window.cacheReadTokens)}` +
      `/缓写:${formatCompactTokens(window.cacheWriteTokens)}` +
      `${unknown ? `/未分:${formatCompactTokens(unknown)}` : ''}/出:${output}`;
  }

  function formatUsageCumulative(value) {
    const stat = value && typeof value === 'object' ? value : {};
    if (!stat.breakdownKnown) return `输入含缓存 ${formatCompactTokens(stat.inputTokens)}`;
    const unknown = number(stat.unattributedInputTokens);
    return `新 ${formatCompactTokens(stat.freshInputTokens)}` +
      ` / 缓读 ${formatCompactTokens(stat.cacheReadTokens)}` +
      ` / 缓写 ${formatCompactTokens(stat.cacheWriteTokens)}` +
      `${unknown ? ` / 未分 ${formatCompactTokens(unknown)}` : ''}`;
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
    const apiFormat = API_FORMATS.has(value.apiFormat)
      ? value.apiFormat
      : (appType === 'claude' ? 'anthropic' : (value.useChatResponsesProxy ? 'openai_chat' : 'openai_responses'));
    const defaultClis = apiFormat === 'anthropic' ? ['claude', 'opencode'] : ['codex', 'opencode'];
    return Object.freeze({
      id,
      appType,
      name: text(value.name, 240) || id,
      source: value.source === 'ccswitch' ? 'ccswitch' : 'local',
      apiFormat,
      protocol: apiFormat,
      wireApi: ['messages', 'responses', 'chat_completions', 'chat-completions'].includes(value.wireApi) ? value.wireApi : '',
      compatibleClis: Object.freeze((Array.isArray(value.compatibleClis) ? value.compatibleClis : defaultClis)
        .filter(cli => ['claude', 'codex', 'opencode'].includes(cli))),
      requiresConversionFor: Object.freeze((Array.isArray(value.requiresConversionFor) ? value.requiresConversionFor : (apiFormat === 'openai_chat' ? ['codex'] : []))
        .filter(cli => cli === 'codex')),
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
    const inputTokens = number(source.consumedInputTokens == null
      ? source.inputTokens
      : source.consumedInputTokens);
    const freshInputTokens = number(source.freshInputTokens);
    const cacheReadTokens = number(source.cacheReadTokens);
    const cacheWriteTokens = number(source.cacheWriteTokens);
    const breakdownKnown = source.breakdownKnown === true;
    return Object.freeze({
      inputTokens,
      consumedInputTokens: inputTokens,
      freshInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      unattributedInputTokens: number(source.unattributedInputTokens),
      breakdownKnown,
      outputTokens: number(source.outputTokens),
    });
  }

  function normalizeStat(value) {
    if (!value || typeof value !== 'object') return null;
    const providerId = text(value.providerId, 180);
    if (!providerId) return null;
    return Object.freeze({
      providerId,
      inputTokens: number(value.consumedInputTokens == null ? value.inputTokens : value.consumedInputTokens),
      freshInputTokens: number(value.freshInputTokens),
      cacheReadTokens: number(value.cacheReadTokens),
      cacheWriteTokens: number(value.cacheWriteTokens),
      unattributedInputTokens: number(value.unattributedInputTokens),
      breakdownKnown: value.breakdownKnown === true,
      outputTokens: number(value.outputTokens),
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

  function groupByProtocol(value) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    const groups = { anthropic: [], openai_responses: [], openai_chat: [] };
    for (const provider of providers) {
      if (provider && groups[provider.apiFormat]) groups[provider.apiFormat].push(provider);
    }
    return groups;
  }

  function providersForCli(value, cli) {
    const providers = Array.isArray(value) ? value : ((value && value.providers) || []);
    return providers.filter(provider => provider && provider.compatibleClis.includes(cli));
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
    formatCompactTokens,
    formatUsageWindow,
    formatUsageCumulative,
    groupByAppType,
    groupByProtocol,
    providersForCli,
    findProvider,
    modelsFor,
    normalizeDeleteReferences,
    deleteReferenceDisplayData,
  };
});

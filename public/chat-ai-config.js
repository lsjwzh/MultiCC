'use strict';

// Classic-script boundary for the Chat page's Provider / model / effort /
// native-agent picker.  It owns the picker policy and DOM, while chat.js keeps
// only the live session state and small compatibility delegates.
(function initChatAiConfig(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatAiConfig = api;
})(typeof window !== 'undefined' ? window : null, function createChatAiConfig(root) {
  const EFFORT_OPTIONS = Object.freeze([
    Object.freeze({ value: 'low', label: 'low' }),
    Object.freeze({ value: 'medium', label: 'medium' }),
    Object.freeze({ value: 'high', label: 'high' }),
    Object.freeze({ value: 'xhigh', label: 'xhigh' }),
    Object.freeze({ value: 'max', label: 'max' }),
    Object.freeze({ value: 'ultracode', label: 'ultracode' }),
  ]);
  const CODEX_REASONING_OPTIONS = Object.freeze([
    Object.freeze({ value: 'low', label: 'Low', desc: 'Fast responses with lighter reasoning' }),
    Object.freeze({ value: 'medium', label: 'Medium', desc: 'Balances speed and reasoning depth for everyday tasks' }),
    Object.freeze({ value: 'high', label: 'High', desc: 'Greater reasoning depth for complex problems' }),
    Object.freeze({ value: 'xhigh', label: 'Extra high', desc: 'Extra high reasoning depth for complex problems' }),
    Object.freeze({ value: 'max', label: 'Max', desc: 'Native on Codex 5.6; otherwise uses Extra high' }),
    Object.freeze({ value: 'ultra', label: 'Ultra', desc: 'Native on Codex 5.6; otherwise uses Extra high' }),
  ]);
  const OPENCODE_VARIANT_OPTIONS = Object.freeze([
    Object.freeze({ value: '', label: 'Default', desc: 'Use the selected model/provider default' }),
    Object.freeze({ value: 'minimal', label: 'Minimal', desc: 'Minimal reasoning where supported by the model' }),
    Object.freeze({ value: 'low', label: 'Low' }),
    Object.freeze({ value: 'medium', label: 'Medium' }),
    Object.freeze({ value: 'high', label: 'High' }),
    Object.freeze({ value: 'max', label: 'Max' }),
  ]);
  const QODER_REASONING_OPTIONS = Object.freeze([
    Object.freeze({ value: '', label: 'Default', desc: 'Follow Qoder CN settings' }),
    Object.freeze({ value: 'low', label: 'Low' }),
    Object.freeze({ value: 'medium', label: 'Medium' }),
    Object.freeze({ value: 'high', label: 'High' }),
    Object.freeze({ value: 'xhigh', label: 'Extra high' }),
    Object.freeze({ value: 'max', label: 'Max' }),
  ]);
  const QODER_MODEL_OPTIONS = Object.freeze(['', 'auto', 'ultimate', 'performance', 'efficient', 'lite']);
  const CODEBUDDY_REASONING_OPTIONS = Object.freeze([
    Object.freeze({ value: '', label: 'Default', desc: 'Follow WorkBuddy settings' }),
    Object.freeze({ value: 'minimal', label: 'Minimal', desc: 'Minimal reasoning where supported' }),
    Object.freeze({ value: 'low', label: 'Low' }),
    Object.freeze({ value: 'medium', label: 'Medium' }),
    Object.freeze({ value: 'high', label: 'High' }),
    Object.freeze({ value: 'xhigh', label: 'Extra high' }),
    Object.freeze({ value: 'max', label: 'Max' }),
  ]);
  // WorkBuddy (codebuddy): tier aliases stay valid --model values (verified
  // against 2.156.0) and are always pinned. The concrete catalog is dynamic —
  // /api/codebuddy/models parses `codebuddy --help` (1-hour cache) because the
  // CLI auto-updates faster than any static table; a stale id hard-400s the
  // turn ("model [x] service info not found"). Snapshot below is the offline
  // fallback only (codebuddy 2.156.0).
  const CODEBUDDY_TIER_OPTIONS = Object.freeze([
    'default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model',
  ]);
  const CODEBUDDY_FALLBACK_MODELS = Object.freeze([
    'hy4-preview-f', 'hy3', 'hy3-x', 'deepseek-v4.1-flash',
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
    'minimax-m3', 'minimax-m2.7',
    'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6',
    'deepseek-v4-pro',
  ]);
  const CODEBUDDY_MODEL_OPTIONS = Object.freeze(['', ...CODEBUDDY_TIER_OPTIONS, ...CODEBUDDY_FALLBACK_MODELS]);
  const DSH_MODEL_OPTIONS = Object.freeze(['', 'deepseek-v4-flash', 'deepseek-v4-pro']);
  // Provider-less ZCode follows its native config/Coding Plan. Do not hardcode
  // a vendor/model pair here: the native provider may be Z.ai, BigModel, Start
  // Plan, Team Plan, or a user-defined provider.
  const ZCODE_MODEL_OPTIONS = Object.freeze(['']);
  const ZCODE_SETUP_PROMPTED = new Set();
  let _autoProviderEditorApi = null;
  const isClaudeCli = cli => cli === 'claude' || cli === 'claude-exp';
  const isCodexCli = cli => cli === 'codex' || cli === 'codex-exp';

  // Browser pages load auto-provider-editor.js first; Node tests resolve the
  // same classic-script module through CommonJS. Keep this lazy so importing
  // the non-DOM policy helpers never requires a window/document.
  function autoProviderEditorApi() {
    if (_autoProviderEditorApi) return _autoProviderEditorApi;
    if (root && root.MultiCCAutoProviderEditor) {
      _autoProviderEditorApi = root.MultiCCAutoProviderEditor;
      return _autoProviderEditorApi;
    }
    if (typeof require === 'function') {
      try { _autoProviderEditorApi = require('./auto-provider-editor'); } catch (_) {}
    }
    if (!_autoProviderEditorApi) throw new Error('MultiCCAutoProviderEditor is unavailable');
    return _autoProviderEditorApi;
  }

  // Difficulty routing needs the vault's `vercel-api-key` entry, but this editor
  // never touches the vault itself — only /manage's secrets panel and the vault
  // module do. This just checks whether that name is present (never its value)
  // so the routing checkbox can warn instead of silently failing every turn.
  function checkRoutingKeyConfigured() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const keyName = autoProviderEditorApi().ROUTING_API_KEY_NAME;
    return fetch('/api/secrets').then(response => (response.ok ? response.json() : []))
      .then(list => Array.isArray(list) && list.some(entry => entry && entry.name === keyName))
      .catch(() => null);
  }

  function defaultEffort(cli) {
    if (isCodexCli(cli)) return 'xhigh';
    if (isClaudeCli(cli)) return 'medium';
    return '';
  }

  function effortOptions(cli) {
    if (isCodexCli(cli)) return CODEX_REASONING_OPTIONS;
    if (cli === 'opencode') return OPENCODE_VARIANT_OPTIONS;
    if (cli === 'qoder') return QODER_REASONING_OPTIONS;
    if (cli === 'codebuddy') return CODEBUDDY_REASONING_OPTIONS;
    if (isClaudeCli(cli)) return EFFORT_OPTIONS;
    return [];
  }

  function effortLabel(cli) {
    if (isCodexCli(cli)) return 'Reasoning Level';
    if (cli === 'opencode') return 'Variant';
    if (cli === 'qoder' || cli === 'codebuddy') return 'Reasoning Effort';
    return 'Effort';
  }

  function effortShortName(cli, effort) {
    const value = effort || defaultEffort(cli);
    if (cli === 'zcode') return '';
    if (cli === 'opencode') return value ? `Variant ${value}` : '';
    if (isCodexCli(cli) || cli === 'qoder' || cli === 'codebuddy') {
      return ({
        xhigh: 'Extra high', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
        max: 'Max', ultra: 'Ultra',
      })[value] || value;
    }
    return value;
  }

  function providersOf(state) {
    return state && Array.isArray(state.providers) ? state.providers : [];
  }

  function protocolOfProvider(provider) {
    return autoProviderEditorApi().protocolOf(provider);
  }

  function autoProtocolLabel(protocol) {
    return autoProviderEditorApi().protocolLabel(protocol);
  }

  function autoOptionValue(protocol) {
    return autoProviderEditorApi().optionValue(protocol);
  }

  function autoProtocolFromValue(value) {
    return autoProviderEditorApi().protocolFromValue(value);
  }

  function autoProvidersForProtocol(protocol, providers) {
    return autoProviderEditorApi().providersForProtocol(providers, protocol);
  }

  function autoSelectionCrossesTrust(candidates, providers) {
    return autoProviderEditorApi().selectionCrossesTrust(candidates, providers);
  }

  function autoCandidateModel(provider, configured) {
    return autoProviderEditorApi().candidateModel(provider, configured);
  }

  function translate(state, key) {
    return state && typeof state.translate === 'function' ? state.translate(key) : key;
  }

  // 文案走页面上的全局 t()（i18n.js）：Air 的任务 AI 配置、chat 的配置弹窗都用这一份
  // 标签表，语言得跟着页面走。没有 t()（Node 单测、旧目录）就回落到中文默认值 ——
  // manage/chat 的断言正是按中文写的。
  function tt(key, fallback, params) {
    const scope = typeof window !== 'undefined' ? window : null;
    const out = scope && typeof scope.t === 'function' ? scope.t(key, params) : '';
    if (out && out !== key) return out;
    return Object.keys(params || {}).reduce((text, name) => (
      text.split(`{${name}}`).join(String(params[name]))
    ), fallback);
  }

  // 先问调用方注入的 translator（它只管自己认识的那几条 key，不认识的会把 key 原样
  // 退回），再落到全局 t()，最后才是中文默认值。
  function localized(state, key, fallback) {
    const text = translate(state, key);
    return text && text !== key ? text : tt(key, fallback);
  }

  function effectiveProviderId(providerId, state) {
    const defaults = state && state.defaults && typeof state.defaults === 'object' ? state.defaults : {};
    const cli = (state && state.cli) || 'claude';
    return providerId || defaults[isCodexCli(cli) ? 'codex' : cli] || '';
  }

  function findProvider(providerId, state) {
    const id = effectiveProviderId(providerId, state);
    return id ? providersOf(state).find(provider => provider && provider.id === id) || null : null;
  }

  // 内置官方供应商的名字是服务端数据（'Codex 官方'），展示时按身份翻译。
  function displayProviderName(provider) {
    const api = root && root.MultiCCProviderCatalog;
    return api && api.providerDisplayName
      ? api.providerDisplayName(provider) : (provider && provider.name) || '';
  }

  function providerShortName(providerId, state) {
    if (!providerId) return translate(state, 'default');
    const provider = providersOf(state).find(item => item && item.id === providerId);
    return provider
      ? displayProviderName(provider)
      : ((state && state.providerDisplayName) || String(providerId).slice(0, 8));
  }

  function providerModelOptions(providerId, state) {
    const provider = findProvider(providerId, state);
    return provider && Array.isArray(provider.modelOptions)
      ? provider.modelOptions.filter(Boolean)
      : [];
  }

  function providerAliasMap(providerId, state) {
    // Alias tiers are Claude CLI routing concepts. ZCode needs the real model
    // ids from its provider config.
    if (state && state.cli === 'zcode') return null;
    const provider = findProvider(providerId, state);
    if (!provider || !provider.aliasMap || typeof provider.aliasMap !== 'object') return null;
    const entries = Object.entries(provider.aliasMap).filter(([, value]) => value && value.model);
    return entries.length ? Object.fromEntries(entries) : null;
  }

  function providerAliasTiers(providerId, state) {
    const mapper = state && state.aliasTiersFromMap;
    if (typeof mapper === 'function') return mapper(providerAliasMap(providerId, state));
    const map = providerAliasMap(providerId, state);
    return ['opus', 'sonnet', 'haiku', 'fable']
      .filter(tier => map && map[tier] && map[tier].model)
      .map(tier => [tier, map[tier]]);
  }

  function normalizeModel(providerId, model, state) {
    if (!model) return model;
    for (const [tier, entry] of providerAliasTiers(providerId, state)) {
      if (tier === model || entry.model === model) return tier;
    }
    return model;
  }

  // Every model dropdown builds its list through buildModelChoices, so this is
  // the "picker opened" hook: keep the live catalogs from going stale without a
  // manual /model. Both calls are throttled and never block the render.
  function nudgeModelCatalog(state) {
    const cli = state && state.cli;
    try {
      if (isCodexCli(cli) && typeof window.syncCodexModelsIfDue === 'function') window.syncCodexModelsIfDue();
      else if (isClaudeCli(cli) && typeof loadClaudeModels === 'function') void loadClaudeModels();
    } catch (_) { /* best-effort */ }
  }

  function buildModelChoices(providerId, state) {
    nudgeModelCatalog(state);
    const tiers = providerAliasTiers(providerId, state);
    if (tiers.length) return [...tiers.map(([tier]) => tier), '__custom__'];
    const options = providerModelOptions(providerId, state);
    if (options.length) return [...options, '__custom__'];
    if (state && isClaudeCli(state.cli)) {
      // Prefer the live list extracted from the installed claude CLI's bundle
      // (localStorage cache filled by loadClaudeModels(); see
      // public/shared/models.js) so new Anthropic releases appear without a
      // multicc update. Falls back to the static table on old servers and on
      // the first picker open before refreshClaudeModels() lands.
      const cached = readClaudeModelsSync();
      if (cached.length) return ['', ...cached.map(m => m.model), '__custom__'];
      return (state.claudeModelOptions || []).map(option => option.value);
    }
    if (state && state.cli === 'qoder') {
      // Qoder CN's catalog is entitlement-scoped and renames models in place,
      // so prefer the live `--list-models` result over the built-in tiers.
      // Sync-read the 1-day cache filled by loadQoderModels(); the first picker
      // open may miss, then refreshQoderModels() triggers a rebuild.
      const cached = readQoderModelsSync();
      if (cached.length) return ['', ...cached.map(m => m.model), '__custom__'];
      return [...QODER_MODEL_OPTIONS, '__custom__'];
    }
    if (state && state.cli === 'codebuddy') {
      // Same live-catalog contract as qoder: sync-read the 1-hour cache filled
      // by loadCodebuddyModels(); refreshCodebuddyModels() warms it on init /
      // CLI switch. Tier aliases stay pinned ahead of the concrete ids.
      const cached = readCodebuddyModelsSync();
      const concrete = cached.length ? cached.map(m => m.model) : [...CODEBUDDY_FALLBACK_MODELS];
      return ['', ...CODEBUDDY_TIER_OPTIONS,
        ...concrete.filter(model => !CODEBUDDY_TIER_OPTIONS.includes(model)), '__custom__'];
    }
    if (state && state.cli === 'dsh') return [...DSH_MODEL_OPTIONS, '__custom__'];
    if (state && state.cli === 'zcode') return [...ZCODE_MODEL_OPTIONS, '__custom__'];
    if (state && state.cli === 'opencode') {
      // No multicc-managed provider chosen: list the local opencode CLI's
      // available provider/model pairs. Sync-read the 1-day localStorage cache
      // populated by loadOpenCodeModels() (see public/shared/models.js); the
      // first picker open may return [] here, then refreshOpenCodeModels()
      // fires a rebuild once the fetch resolves.
      const nativeId = openCodeNativeProviderOf(providerId);
      const cached = readOpenCodeModelsSync().filter(m => !nativeId || m.provider === nativeId);
      // A picked native provider pins its own models — no "follow config" row.
      if (cached.length) return [...(nativeId ? [] : ['']), ...cached.map(m => `${m.provider}/${m.model}`), '__custom__'];
      return ['', '__custom__'];
    }
    return ['', '__custom__'];
  }

  // OpenCode's own providers (Zen gateway, Go plan, `opencode auth login`
  // ones) are not MultiCC providers: they appear in the Provider dropdown as
  // `opencode-native:<id>` rows that only filter the model list, and save as
  // provider '' (native config) with a `<id>/<model>` model.
  const OPENCODE_NATIVE_PREFIX = 'opencode-native:';
  const OPENCODE_NATIVE_NAMES = { opencode: 'OpenCode Zen', opencodego: 'OpenCode Go' };
  function openCodeNativeProviderOf(value) {
    const text = String(value || '');
    return text.startsWith(OPENCODE_NATIVE_PREFIX) ? text.slice(OPENCODE_NATIVE_PREFIX.length) : '';
  }
  function openCodeNativeProviders() {
    const ids = [...new Set(readOpenCodeModelsSync().map(m => m.provider).filter(Boolean))];
    return ids.map(id => ({ value: OPENCODE_NATIVE_PREFIX + id, label: `OpenCode 原生 · ${OPENCODE_NATIVE_NAMES[id] || id}` }));
  }

  // Synchronous read of a CLI model cache populated by shared/models.js
  // (loadOpenCodeModels / loadQoderModels). Returns [] when the cache is
  // missing/stale so callers can render a placeholder option without blocking.
  function readModelCacheSync(key, ttlMs) {
    try {
      const ls = root && root.localStorage;
      if (!ls) return [];
      const raw = ls.getItem(key);
      if (!raw) return [];
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return [];
      const at = Number(obj.at) || 0;
      const models = Array.isArray(obj.models) ? obj.models : [];
      const TTL = ttlMs || 24 * 60 * 60 * 1000;
      if (!at || (Date.now() - at) >= TTL) return [];
      return models;
    } catch (_) { return []; }
  }

  function readOpenCodeModelsSync() {
    return readModelCacheSync('multicc.opencode.models.v2');
  }

  function readQoderModelsSync() {
    return readModelCacheSync('multicc.qoder.models.v1');
  }

  function readClaudeModelsSync() {
    return readModelCacheSync('multicc.claude.models.v1');
  }

  function readCodebuddyModelsSync() {
    return readModelCacheSync('multicc.codebuddy.models.v1', 60 * 60 * 1000);
  }

  // Background-refresh the OpenCode model list (1-day cache, shared with
  // shared/models.js via the same localStorage key). The chat page should call
  // this once on init when `cli === 'opencode'`; on completion it triggers a
  // UI re-resolve so the picker shows the freshly fetched entries.
  async function refreshOpenCodeModels(rebuildCallback) {
    try {
      if (typeof loadOpenCodeModels !== 'function') return;
      const prev = readOpenCodeModelsSync();
      await loadOpenCodeModels();
      if (typeof rebuildCallback === 'function' && prev.length === 0) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
    } catch (_) { /* swallow — picker keeps the placeholder */ }
  }

  // Same contract as refreshOpenCodeModels, for the Qoder CN catalog. The chat
  // page calls this on init when `cli === 'qoder'` so the picker upgrades from
  // the built-in tiers to the account's real model list.
  async function refreshQoderModels(rebuildCallback) {
    try {
      if (typeof loadQoderModels !== 'function') return;
      const prev = readQoderModelsSync();
      await loadQoderModels();
      if (typeof rebuildCallback === 'function' && prev.length === 0) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
    } catch (_) { /* swallow — picker keeps the tier fallback */ }
  }

  // Same contract as refreshQoderModels, for the Claude CLI-bundle model list.
  // The chat page calls this on init / CLI switch when `cli === 'claude'` so
  // the picker upgrades from the static table to the CLI's real model ids.
  async function refreshClaudeModels(rebuildCallback) {
    try {
      if (typeof loadClaudeModels !== 'function') return;
      const prev = readClaudeModelsSync();
      await loadClaudeModels();
      if (typeof rebuildCallback === 'function' && prev.length === 0) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
    } catch (_) { /* swallow — picker keeps the static table */ }
  }

  // Same contract as refreshQoderModels, for the WorkBuddy catalog. The chat
  // page calls this on init / CLI switch when `cli === 'codebuddy'` so the
  // picker upgrades from the fallback snapshot to the installed CLI's ids.
  async function refreshCodebuddyModels(rebuildCallback) {
    try {
      if (typeof loadCodebuddyModels !== 'function') return;
      const prev = readCodebuddyModelsSync();
      await loadCodebuddyModels();
      if (typeof rebuildCallback === 'function' && prev.length === 0) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
    } catch (_) { /* swallow — picker keeps the fallback snapshot */ }
  }

  function stripModelSuffix(model) {
    return String(model || '').replace(/\[[^\]]*\]$/, '').trim();
  }

  function defaultModelChoice(providerId, state) {
    const provider = findProvider(providerId, state);
    const tiers = providerAliasTiers(providerId, state);
    if (tiers.length) {
      const primary = provider ? stripModelSuffix(provider.model) : '';
      const matched = primary && tiers.find(([, entry]) => stripModelSuffix(entry.model) === primary);
      return (matched || tiers[0])[0];
    }
    const options = providerModelOptions(providerId, state);
    return (provider && provider.model) || options[0] || '';
  }

  function modelChoiceLabel(value, providerId, state) {
    const map = providerAliasMap(providerId, state);
    if (map && map[value] && map[value].model) {
      const formatter = state && state.formatAliasTierLabel;
      return typeof formatter === 'function'
        ? formatter(value, map[value])
        : `${value}${map[value].name ? ` · ${map[value].name}` : ''} · ${map[value].model}`;
    }
    if (value === '') {
      if (state && isCodexCli(state.cli)) return localized(state, 'aiConfigDefaultFollowProvider', '默认（跟随 Provider）');
      if (state && state.cli === 'qoder') return localized(state, 'aiConfigDefaultFollowQoder', '默认（跟随 Qoder CN 设置）');
      if (state && state.cli === 'codebuddy') return localized(state, 'aiConfigDefaultFollowWorkBuddy', '默认（跟随 WorkBuddy 设置）');
      if (state && state.cli === 'dsh') return localized(state, 'aiConfigDefaultFollowDsh', '默认（跟随 DSH 配置）');
      if (state && state.cli === 'zcode') return localized(state, 'aiConfigDefaultFollowZcode', '默认（跟随 ZCode 设置）');
      return translate(state, 'default');
    }
    if (state && state.cli === 'codebuddy') {
      return ({
        'default-model': localized(state, 'aiConfigTierDefault', 'default（默认档）'),
        'fast-model': localized(state, 'aiConfigTierFast', 'fast（快速档）'),
        'balanced-model': localized(state, 'aiConfigTierBalanced', 'balanced（均衡档）'),
        'primary-model': localized(state, 'aiConfigTierPrimary', 'primary（主力档）'),
        'deep-model': localized(state, 'aiConfigTierDeep', 'deep（深度档）'),
      })[value] || (value === '__custom__' ? translate(state, 'custom') : value);
    }
    if (state && state.cli === 'dsh') {
      return value === '__custom__' ? translate(state, 'custom') : value;
    }
    if (state && state.cli === 'qoder') {
      return ({
        auto: localized(state, 'aiConfigEffortAuto', 'Auto（智能路由）'),
        ultimate: localized(state, 'aiConfigEffortUltimate', 'Ultimate（极致）'),
        performance: localized(state, 'aiConfigEffortPerformance', 'Performance（性能）'),
        efficient: localized(state, 'aiConfigEffortEfficient', 'Efficient（经济）'),
        lite: localized(state, 'aiConfigEffortLite', 'Lite（轻量）'),
      })[value] || (value === '__custom__' ? translate(state, 'custom') : value);
    }
    const named = (state && state.claudeModelOptions || []).find(option => option.value === value);
    if (named) return named.labelKey ? translate(state, named.labelKey) : named.label;
    const live = readClaudeModelsSync().find(entry => entry && entry.model === value);
    if (live && live.label) return live.label;
    if (value === '__custom__') return translate(state, 'custom');
    return value;
  }

  function modelDisplayName(model, providerId, state) {
    if (!model) return model;
    const map = providerAliasMap(providerId, state);
    if (map) {
      if (map[model]) return map[model].name || map[model].model;
      for (const entry of Object.values(map)) {
        if (entry && entry.model === model) return entry.name || model;
      }
    }
    const shortener = state && state.modelShortName;
    return typeof shortener === 'function' ? shortener(model) : model;
  }

  function providerLabel(provider, includeModel) {
    if (!provider) return '';
    const protocol = provider.apiFormat === 'openai_responses' ? ' [Responses]' : ' [Anthropic]';
    const endpoint = provider.isOfficial
      ? tt('subscriptionSuffix', ' · 订阅')
      : (provider.baseUrl ? ' · ' + provider.baseUrl.replace(/^https?:\/\//, '') : '');
    return displayProviderName(provider) + protocol + endpoint + (includeModel && provider.model ? ' · ' + provider.model : '');
  }

  // Relative freshness for the cached limit, reusing the quota bar's resolver
  // (public/quota-bar-view.js) so picker and quota bars age the same way.
  // Resolved lazily from the window global (browser) or require (tests) exactly
  // like chat-rate-limit.js does, so the two never drift.
  function quotaBarView() {
    if (root && root.QuotaBarView) return root.QuotaBarView;
    if (typeof require === 'function') {
      try { return require('./quota-bar-view'); } catch (_) { return null; }
    }
    return null;
  }
  function limitAgoText(tsMs, nowMs) {
    const view = quotaBarView();
    if (view && typeof view.relativeAgo === 'function') {
      const ago = view.relativeAgo(tsMs, nowMs);
      return ago || '';
    }
    return '';
  }

  // Compact suffix appended to a provider option: the cached limit summary plus
  // freshness / failure / stale markers. Returns '' when there is no cache entry
  // (never queried, cache disabled, or a provider that predates the cache) so the
  // option reads exactly as before — no data is a clean, intentional absence.
  // `tr` is the active translator (tt / window.t), which accepts {params}.
  function providerLimitLabel(provider, tr, nowMs) {
    const limit = provider && provider.limit;
    if (!limit) return '';
    const parts = [];
    if (limit.summaryText) parts.push(limit.summaryText);
    if (limit.lastError) {
      parts.push(typeof tr === 'function' ? tr('limitFetchFailed') : '查询失败');
    } else if (limit.fetchedAt) {
      const ago = limitAgoText(limit.fetchedAt, nowMs);
      if (ago) parts.push(typeof tr === 'function' ? tr('limitUpdatedAgo', { ago }) : `更新于 ${ago}`);
    }
    if (limit.stale && limit.summaryText) parts.push(typeof tr === 'function' ? tr('limitStale') : '过期');
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  // 子任务（子 agent）线路的判定只有一份：chat 的 AI 配置弹窗、Air 的任务 AI
  // 配置弹窗、以及创建任务时把线路钉进 runtime，都调这两个函数。服务端有对应的
  // src/session/subagent.js；客户端这边只负责「什么算设了」，别的地方别再手写。
  const SUBAGENT_CLIS = Object.freeze(['claude', 'claude-exp', 'codex', 'codex-exp']);

  function supportsSubagentCli(cli) {
    return SUBAGENT_CLIS.includes(cli || '');
  }

  // 模型为空 = 没设（交 null 清空，落到主线路）；线路留空时用这一轮实际生效的
  // 主 Provider —— Auto 档下就是池子里排第一的那条。两者都有值才算设了。
  function resolveSubagent(input = {}) {
    if (!supportsSubagentCli(input.cli)) return null;
    const providerId = (input.providerId || input.primaryProviderId || '').toString().trim();
    const model = (input.model || '').toString().trim();
    return providerId && model ? { providerId, model } : null;
  }

  function documentOf(options) {
    const document = options && options.document || (root && root.document);
    if (!document) throw new Error('Chat AI config picker requires a document');
    return document;
  }

  /* Phones: several of these panels are taller than the viewport (the AI config
   * one stacks six selects plus two inputs). A plain centred box then pushes
   * its action row below the screen edge with nothing to scroll, so the save
   * button is unreachable. Build every dialog as a flex column whose body
   * scrolls and whose footer stays pinned inside the visible box. */
  function modalShell(document, width, dim) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:var(--chat-overlay, rgba(0,0,0,${dim || '.7'}));z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;`;
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--chat-surface, #161b22);border:1px solid var(--chat-line, #30363d);border-radius:12px;color:var(--chat-text, #c9d1d9);'
      + `width:${width}px;max-width:94vw;display:flex;flex-direction:column;`
      + 'max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);';
    const body = document.createElement('div');
    body.style.cssText = 'padding:18px;overflow-y:auto;min-height:0;-webkit-overflow-scrolling:touch;';
    const footer = document.createElement('div');
    footer.style.cssText = 'flex:none;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:12px 18px;border-top:1px solid var(--chat-soft, #21262d);';
    box.append(body, footer);
    overlay.appendChild(box);
    return { overlay, box, body, footer };
  }

  // Dialog buttons are touch targets too: 44px tall wherever the pointer is coarse.
  function ensureModalStyle(document) {
    if (document.getElementById('multicc-modal-style')) return;
    const style = document.createElement('style');
    style.id = 'multicc-modal-style';
    style.textContent = '.multicc-modal-btn{border-radius:6px;font-size:13px;padding:8px 16px;min-height:40px;cursor:pointer;}'
      + '@media (pointer:coarse){.multicc-modal-btn{min-height:44px;}}';
    (document.head || document.body).appendChild(style);
  }
  const MODAL_BTN_GHOST = 'background:var(--chat-soft, #21262d);border:1px solid var(--chat-line, #30363d);color:var(--chat-text, #c9d1d9);';
  const MODAL_BTN_PRIMARY = 'background:#238636;border:1px solid #2ea043;color:#fff;';

  function showLoadingOverlay(text, options = {}) {
    const document = documentOf(options);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--chat-overlay, rgba(0,0,0,.55));z-index:10001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--chat-surface, #161b22);border:1px solid var(--chat-line, #30363d);border-radius:10px;padding:16px 22px;color:var(--chat-text, #c9d1d9);font-size:13px;display:flex;align-items:center;gap:10px;';
    const spinner = document.createElement('span');
    spinner.style.cssText = 'width:14px;height:14px;border:2px solid var(--chat-line, #30363d);border-top-color:var(--chat-blue, #58a6ff);border-radius:50%;display:inline-block;animation:multiccSpin .8s linear infinite;';
    box.appendChild(spinner);
    box.appendChild(document.createTextNode(text || '加载中…'));
    overlay.appendChild(box);
    if (!document.getElementById('multicc-spin-style')) {
      const style = document.createElement('style');
      style.id = 'multicc-spin-style';
      style.textContent = '@keyframes multiccSpin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
    return () => overlay.remove();
  }

  function showEffortPicker(current, options = {}) {
    const document = documentOf(options);
    const cli = options.cli || 'claude';
    const choices = effortOptions(cli);
    return new Promise((resolve) => {
      ensureModalStyle(document);
      const { overlay, box, body, footer } = modalShell(document, 380);
      body.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">选择努力程度（下一轮生效）</div>
        <div style="font-size:12px;color:var(--chat-muted, #8b949e);line-height:1.5;margin-bottom:12px;">Claude 支持 low / medium / high / xhigh / max。ultracode 会向 Claude 传 xhigh，并启用 MultiCC 跨会话 workflow 编排。</div>
        <select id="effort-select" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;">
          ${choices.map(option => `<option value="${option.value}">${option.label}</option>`).join('')}
        </select>`;
      footer.innerHTML = `
        <button id="effort-cancel" class="multicc-modal-btn" style="${MODAL_BTN_GHOST}">取消</button>
        <button id="effort-ok" class="multicc-modal-btn" style="${MODAL_BTN_PRIMARY}">保存</button>`;
      document.body.appendChild(overlay);
      const select = box.querySelector('#effort-select');
      select.value = choices.some(option => option.value === current) ? current : defaultEffort(cli);
      const close = result => { overlay.remove(); resolve(result); };
      box.querySelector('#effort-ok').onclick = () => close(select.value);
      box.querySelector('#effort-cancel').onclick = () => close(null);
      overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
  }

  function showProviderPicker(current, list, options = {}) {
    const document = documentOf(options);
    const t = typeof options.translate === 'function' ? options.translate : key => key;
    return new Promise((resolve) => {
      ensureModalStyle(document);
      const { overlay, body, footer } = modalShell(document, 400);
      const message = document.createElement('div');
      message.style.cssText = 'font-size:14px;color:var(--chat-text, #c9d1d9);line-height:1.6;margin-bottom:12px;';
      message.textContent = t('providerTitle');
      body.appendChild(message);
      const select = document.createElement('select');
      select.style.cssText = 'width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = t('providerDefault');
      const officialProvider = (list || []).find(p => p.builtinOfficial);
      if (!officialProvider) select.appendChild(defaultOption);
      for (const provider of list || []) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, true) + providerLimitLabel(provider, t, Date.now());
        select.appendChild(option);
      }
      select.value = current || officialProvider?.id || '';
      body.appendChild(select);
      if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:12px;color:var(--chat-muted, #8b949e);';
        empty.textContent = t('providerEmpty');
        body.appendChild(empty);
      }
      const cancel = document.createElement('button');
      cancel.textContent = t('cancel');
      cancel.className = 'multicc-modal-btn';
      cancel.style.cssText = MODAL_BTN_GHOST;
      const save = document.createElement('button');
      save.textContent = t('save');
      save.className = 'multicc-modal-btn';
      save.style.cssText = MODAL_BTN_PRIMARY;
      footer.append(cancel, save);
      document.body.appendChild(overlay);
      const close = result => { overlay.remove(); resolve(result); };
      save.onclick = () => close({ value: select.value });
      cancel.onclick = () => close(null);
      overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
  }

  function showAIConfigPicker(config, state = {}) {
    const document = documentOf(state);
    const cli = state.cli || 'claude';
    const choicesForEffort = effortOptions(cli);
    const supportsProvider = cli !== 'qoder' && cli !== 'codebuddy' && cli !== 'dsh';
    return new Promise((resolve) => {
      ensureModalStyle(document);
      const { overlay, box, body, footer } = modalShell(document, 620);
      body.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">AI 配置（下一轮生效）</div>
        <div style="font-size:12px;color:var(--chat-muted, #8b949e);line-height:1.5;margin-bottom:12px;">${supportsProvider ? 'Provider、' : ''}Model${choicesForEffort.length ? `、${effortLabel(cli)}` : ''} 会一起保存。${supportsProvider ? (cli === 'zcode' ? '选择 Provider 时使用 MultiCC 的三协议隔离配置；选择默认时跟随 ZCode 原生设置 / Coding Plan。' : '切换 Provider 后，Model 选项会按该 Provider 的可用模型联动更新。') : (cli === 'codebuddy' ? 'WorkBuddy 使用自身账号与厂商配置。' : cli === 'dsh' ? 'DSH 使用 DeepSeek 自身凭证（DEEPSEEK_API_KEY 或 dsh 内置 credentials）。' : 'Qoder CN 使用自身账号与厂商配置。')}</div>
        <div id="ai-provider-section">
          <label style="display:block;font-size:12px;color:var(--chat-muted, #8b949e);margin-bottom:5px;">Provider</label>
          <select id="ai-provider" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;"></select>
        </div>
        <div id="ai-auto-section" style="display:none;"></div>
        <div id="ai-model-section">
          <label style="display:block;font-size:12px;color:var(--chat-muted, #8b949e);margin-bottom:5px;">Model</label>
          <select id="ai-model" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:8px;"></select>
          <input id="ai-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;">
        </div>
        <div id="ai-sub-section">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;color:var(--chat-text, #c9d1d9);white-space:nowrap;">子任务</span>
            <select id="ai-sub-provider" style="flex:1 1 0;min-width:0;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;"></select>
            <select id="ai-sub-model" style="flex:1 1 0;min-width:0;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;"></select>
          </div>
          <input id="ai-sub-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:8px;display:none;">
          <div style="font-size:11px;color:var(--chat-muted, #8b949e);line-height:1.45;margin-bottom:14px;">子 agent 走的 provider+model（经本地协议代理路由，与主进程隔离）。只挑线路不挑模型 = 没设，随主。</div>
        </div>
        <div id="ai-effort-section">
          <label id="ai-effort-label" style="display:block;font-size:12px;color:var(--chat-muted, #8b949e);margin-bottom:5px;">${effortLabel(cli)}</label>
          <select id="ai-effort" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;"></select>
        </div>
        <div id="ai-agent-section">
          <div style="height:1px;background:var(--chat-line, #30363d);margin:4px 0 14px;"></div>
          <div style="font-size:13px;font-weight:600;margin-bottom:2px;">${isClaudeCli(cli) ? (cli === 'claude-exp' ? 'Claude Agent SDK' : 'Claude Code') : cli === 'opencode' ? 'OpenCode' : cli === 'qoder' ? 'Qoder CN' : 'WorkBuddy'} Agent</div>
          <div style="font-size:11px;color:var(--chat-muted, #8b949e);line-height:1.45;margin-bottom:8px;">对应原生 <code>--agent</code>，用于选择该 CLI 已定义的主 agent；它不同于下面的子任务路由。留空使用 CLI 默认 agent。</div>
          <input id="ai-agent" type="text" list="ai-agent-list" maxlength="80" placeholder="${cli === 'opencode' ? '例如 build' : '已定义的 agent 名称'}" style="width:100%;background:var(--chat-canvas, #0d1117);border:1px solid var(--chat-line, #30363d);border-radius:6px;color:var(--chat-text, #c9d1d9);font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;">
          <datalist id="ai-agent-list">${cli === 'opencode' ? '<option value="build"></option>' : ''}</datalist>
        </div>`;
      footer.innerHTML = `
        <button id="ai-cancel" class="multicc-modal-btn" style="${MODAL_BTN_GHOST}">取消</button>
        <button id="ai-ok" class="multicc-modal-btn" style="${MODAL_BTN_PRIMARY}">保存</button>`;
      document.body.appendChild(overlay);

      const providerSelect = box.querySelector('#ai-provider');
      const providerSection = box.querySelector('#ai-provider-section');
      const autoSection = box.querySelector('#ai-auto-section');
      const modelSection = box.querySelector('#ai-model-section');
      const modelSelect = box.querySelector('#ai-model');
      const customModel = box.querySelector('#ai-model-custom');
      const effortSelect = box.querySelector('#ai-effort');
      const effortSection = box.querySelector('#ai-effort-section');
      const agentSection = box.querySelector('#ai-agent-section');
      const agentInput = box.querySelector('#ai-agent');
      const subSection = box.querySelector('#ai-sub-section');
      const defaultProvider = document.createElement('option');
      defaultProvider.value = '';
      defaultProvider.textContent = cli === 'zcode'
        ? 'ZCode 原生 / Coding Plan'
        : cli === 'opencode'
          ? 'OpenCode 原生配置（全部模型）'
          : translate(state, 'providerDefault');
      const providerAppType = isCodexCli(cli) ? 'codex' : cli;
      const officialProvider = providersOf(state).find(p => p.builtinOfficial && p.appType === providerAppType);
      if (!officialProvider) providerSelect.appendChild(defaultProvider);
      function syncOpenCodeNativeOptions() {
        if (cli !== 'opencode') return;
        let anchor = defaultProvider.parentNode ? defaultProvider : null;
        for (const native of openCodeNativeProviders()) {
          let option = [...providerSelect.options].find(o => o.value === native.value);
          if (!option) {
            option = document.createElement('option');
            option.value = native.value;
            option.textContent = native.label;
            providerSelect.insertBefore(option, anchor ? anchor.nextSibling : providerSelect.firstChild);
          }
          anchor = option;
        }
      }
      syncOpenCodeNativeOptions();
      for (const protocol of ['anthropic', 'openai_responses']) {
        if (autoProvidersForProtocol(protocol, providersOf(state)).length < 2) continue;
        const option = document.createElement('option');
        option.value = autoOptionValue(protocol);
        option.textContent = `⚡ Auto · ${autoProtocolLabel(protocol)}`;
        providerSelect.appendChild(option);
      }
      for (const provider of providersOf(state)) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, true) + providerLimitLabel(provider, state.translate, Date.now());
        providerSelect.appendChild(option);
      }
      const configuredAuto = config.providerSelection?.mode === 'auto' ? config.providerSelection : null;
      providerSelect.value = configuredAuto ? autoOptionValue(configuredAuto.protocol) : (config.provider || officialProvider?.id || '');
      const nativeFromModel = cli === 'opencode' && !config.provider && !configuredAuto
        && String(config.model || '').split('/')[0];
      if (nativeFromModel && [...providerSelect.options].some(o => o.value === OPENCODE_NATIVE_PREFIX + nativeFromModel)) {
        providerSelect.value = OPENCODE_NATIVE_PREFIX + nativeFromModel;
      }
      const effectiveProvider = value => (openCodeNativeProviderOf(value) ? '' : value);
      providerSection.style.display = supportsProvider ? '' : 'none';
      if (!supportsProvider) providerSelect.value = '';

      effortSection.style.display = choicesForEffort.length ? '' : 'none';
      agentSection.style.display = isClaudeCli(cli) || cli === 'opencode' || cli === 'qoder' || cli === 'codebuddy' ? '' : 'none';
      subSection.style.display = supportsSubagentCli(cli) ? '' : 'none';
      agentInput.value = isClaudeCli(cli) || cli === 'opencode' || cli === 'qoder' || cli === 'codebuddy' ? (config.agent || '') : '';
      for (const choice of choicesForEffort) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.desc ? `${choice.label} — ${choice.desc}` : choice.label;
        effortSelect.appendChild(option);
      }
      effortSelect.value = choicesForEffort.some(choice => choice.value === config.effort)
        ? config.effort
        : defaultEffort(cli);

      // 子任务：provider 配置后面的一行尾巴（线路 + 模型）。模型空 = 没设子任务，
      // 整条回落成「随主」。线路留空时模型候选跟主线路同源 —— Auto 档下主线路是
      // 池子里排第一的那条，所以候选要等 autoEditor 挂载完才能算准。
      const subProviderSelect = box.querySelector('#ai-sub-provider');
      const subModelSelect = box.querySelector('#ai-sub-model');
      const subCustomModel = box.querySelector('#ai-sub-model-custom');
      const subDefault = document.createElement('option');
      subDefault.value = '';
      subDefault.textContent = '随主';
      subProviderSelect.appendChild(subDefault);
      for (const provider of providersOf(state)) {
        if (isCodexCli(cli) && provider.isOfficial) continue;
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, false) + providerLimitLabel(provider, state.translate, Date.now());
        subProviderSelect.appendChild(option);
      }
      const initialSubagent = config.subagent && config.subagent.model ? config.subagent : null;
      subProviderSelect.value = initialSubagent?.providerId || '';
      let autoEditorRef = null;

      function primaryProviderId() {
        if (autoProtocolFromValue(providerSelect.value) && autoEditorRef) {
          const read = autoEditorRef.read({ remember: false });
          const first = read && read.ok ? read.value.candidates[0] : null;
          if (first && first.providerId) return first.providerId;
        }
        return effectiveProvider(providerSelect.value);
      }

      function syncSubCustom() {
        subCustomModel.style.display = subModelSelect.value === '__custom__' ? '' : 'none';
      }
      function rebuildSubModels(providerId, preferred) {
        // 首项固定是「不设置」：只挑线路不挑模型 = 没设，交上去就是 null。
        const choices = buildModelChoices(providerId, state)
          .filter(value => value && value !== '__custom__');
        const selected = normalizeModel(providerId, preferred || '', state);
        subModelSelect.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '不设置';
        subModelSelect.appendChild(none);
        for (const value of choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = modelChoiceLabel(value, providerId, state);
          subModelSelect.appendChild(option);
        }
        const custom = document.createElement('option');
        custom.value = '__custom__';
        custom.textContent = translate(state, 'custom');
        subModelSelect.appendChild(custom);
        const known = !!selected && choices.includes(selected);
        subModelSelect.value = known ? selected : (selected ? '__custom__' : '');
        subCustomModel.value = known ? '' : (selected && selected !== '__custom__' ? selected : '');
        syncSubCustom();
      }
      function refreshSubUi() {
        const line = subProviderSelect.value;
        const providerId = line || primaryProviderId();
        const preferred = initialSubagent && initialSubagent.providerId === providerId
          ? initialSubagent.model
          : '';
        rebuildSubModels(providerId, preferred);
      }
      subProviderSelect.onchange = refreshSubUi;
      subModelSelect.onchange = () => {
        syncSubCustom();
        if (subModelSelect.value === '__custom__') subCustomModel.focus();
      };

      const autoEditor = autoProviderEditorApi().mount({
        document,
        container: autoSection,
        providers: providersOf(state),
        protocol: autoProtocolFromValue(providerSelect.value),
        initialSelection: configuredAuto,
        // 池子里换人会让「随主」的模型候选跟着换 —— 尾巴得重算。
        onChange: () => refreshSubUi(),
        formatProvider: provider => providerLabel(provider, false)
          + providerLimitLabel(provider, state.translate, Date.now()),
      });
      autoEditorRef = autoEditor;
      refreshSubUi();
      checkRoutingKeyConfigured().then(routingKeyConfigured => autoEditor.setContext({ routingKeyConfigured }));

      function syncAutoEditor() {
        const protocol = autoProtocolFromValue(providerSelect.value);
        modelSection.style.display = protocol ? 'none' : '';
        autoEditor.setContext({
          providers: providersOf(state),
          protocol,
          initialSelection: configuredAuto?.protocol === protocol ? configuredAuto : null,
        });
      }

      function collectAutoSelection() {
        const result = autoEditor.read();
        return result.ok ? result.value : false;
      }

      function syncCustom() {
        customModel.style.display = modelSelect.value === '__custom__' ? '' : 'none';
      }
      function rebuildModels(providerId, preferred) {
        let selected = normalizeModel(providerId, preferred || '', state);
        const choices = buildModelChoices(providerId, state);
        modelSelect.innerHTML = '';
        for (const value of choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = modelChoiceLabel(value, providerId, state);
          modelSelect.appendChild(option);
        }
        if (!selected) selected = defaultModelChoice(providerId, state);
        const known = choices.includes(selected);
        modelSelect.value = known ? selected : (selected ? '__custom__' : choices[0]);
        customModel.value = known ? '' : selected;
        syncCustom();
      }
      rebuildModels(configuredAuto ? (config.provider || '') : providerSelect.value, config.model || '');
      syncAutoEditor();
      if (cli === 'opencode' && !openCodeNativeProviders().length) {
        // First open before the catalog landed: add the native rows (and
        // re-pick the saved one) once the fetch resolves.
        void refreshOpenCodeModels(() => {
          syncOpenCodeNativeOptions();
          const saved = String(config.model || '').split('/')[0];
          if (!config.provider && saved && [...providerSelect.options].some(o => o.value === OPENCODE_NATIVE_PREFIX + saved)
            && !providerSelect.value) providerSelect.value = OPENCODE_NATIVE_PREFIX + saved;
          if (!autoProtocolFromValue(providerSelect.value)) rebuildModels(providerSelect.value, modelSelect.value === '__custom__' ? customModel.value : modelSelect.value);
        });
      }
      providerSelect.onchange = () => {
        const autoProtocol = autoProtocolFromValue(providerSelect.value);
        if (!autoProtocol) rebuildModels(providerSelect.value, '');
        syncAutoEditor();
        if (isCodexCli(cli) && !providerSelect.value) subProviderSelect.value = '';
        refreshSubUi();
      };
      modelSelect.onchange = () => {
        syncCustom();
        if (modelSelect.value === '__custom__') customModel.focus();
      };

      const close = result => { autoEditor.destroy(); overlay.remove(); resolve(result); };
      box.querySelector('#ai-ok').onclick = () => {
        const providerSelection = collectAutoSelection();
        if (providerSelection === false) return;
        const selectedModel = modelSelect.value === '__custom__'
          ? customModel.value.trim()
          : modelSelect.value;
        // 尾巴：模型有值才算设了子任务。线路留空时落到这一轮实际生效的主
        // Provider 上（Auto 档下就是池子里排第一的那条，和上面的 provider 同一个）。
        const primary = providerSelection && providerSelection.candidates[0];
        const childModel = subModelSelect.value === '__custom__'
          ? subCustomModel.value.trim()
          : subModelSelect.value;
        close({
          provider: primary ? primary.providerId : effectiveProvider(providerSelect.value),
          providerSelection,
          model: primary ? primary.model || '' : selectedModel,
          effort: effortSelect.value,
          agent: isClaudeCli(cli) || cli === 'opencode' || cli === 'qoder' || cli === 'codebuddy' ? agentInput.value.trim() : null,
          subagent: resolveSubagent({ cli, providerId: subProviderSelect.value,
            primaryProviderId: primary ? primary.providerId : effectiveProvider(providerSelect.value), model: childModel }),
        });
      };
      box.querySelector('#ai-cancel').onclick = () => close(null);
      overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
  }

  async function showZcodeSetupPrompt(options = {}) {
    const status = await requiredApi(options).json('/api/zcode/auth/check');
    if (status && status.ok) return null;
    const document = documentOf(options);
    return new Promise(resolve => {
      ensureModalStyle(document);
      const { overlay, body, footer } = modalShell(document, 460, '.72');
      overlay.style.zIndex = '10020';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';
      title.textContent = '配置 ZCode 连接';
      const message = document.createElement('div');
      message.style.cssText = 'font-size:12px;color:var(--chat-muted, #8b949e);line-height:1.65;';
      message.textContent = '可选择 MultiCC 中已有的三协议 Provider；或配置 ZCode 原生连接，使用官方 Coding Plan / API Key。原生登录状态由 ZCode 自己维护。';
      const later = document.createElement('button');
      later.className = 'btn multicc-modal-btn';
      later.textContent = '稍后';
      const settings = document.createElement('button');
      settings.className = 'btn multicc-modal-btn';
      settings.textContent = '配置 Coding Plan / API Key';
      const provider = document.createElement('button');
      provider.className = 'btn btn-green multicc-modal-btn';
      provider.textContent = options.hasProviders ? '选择已有 Provider' : '创建 Provider';
      footer.append(later, settings, provider);
      body.append(title, message);
      document.body.appendChild(overlay);
      const close = action => {
        overlay.remove();
        resolve(action);
      };
      later.onclick = () => close(null);
      settings.onclick = () => close('settings');
      provider.onclick = () => close(options.hasProviders ? 'provider' : 'settings');
      overlay.onclick = event => { if (event.target === overlay) close(null); };
    });
  }

  async function maybePromptZcodeSetup(options = {}) {
    const sessionId = String(options.sessionId || '');
    if (options.cli !== 'zcode' || options.provider || !sessionId
        || ZCODE_SETUP_PROMPTED.has(sessionId)) return null;
    ZCODE_SETUP_PROMPTED.add(sessionId);
    try {
      const providers = typeof options.loadProviders === 'function'
        ? await options.loadProviders()
        : [];
      const action = await showZcodeSetupPrompt({
        ...options,
        hasProviders: Array.isArray(providers) && providers.length > 0,
      });
      if (action === 'provider' && typeof options.onProvider === 'function') options.onProvider();
      if (action === 'settings' && typeof options.onSettings === 'function') options.onSettings();
      return action;
    } catch (_) {
      return null;
    }
  }

  function requiredApi(options) {
    const api = options && options.api || (root && root.MultiCCApi);
    if (!api || typeof api.json !== 'function') throw new Error('MultiCCApi is unavailable');
    return api;
  }

  async function loadProviderList(cli, options = {}) {
    const api = requiredApi(options);
    const catalog = options.providerCatalog || (root && root.MultiCCProviderCatalog);
    if (!catalog || typeof catalog.normalizeCatalog !== 'function') {
      throw new Error('MultiCCProviderCatalog is unavailable');
    }
    const type = isCodexCli(cli) ? 'codex' : 'claude';
    const raw = await api.json(`/api/providers?cli=${encodeURIComponent(cli || 'claude')}`);
    const normalized = catalog.normalizeCatalog(raw);
    return Object.freeze({
      providers: Object.freeze(catalog.providersForCli(normalized, cli || 'claude')),
      defaults: normalized.defaults,
    });
  }

  function desiredConfig(info) {
    const pending = info && info.pendingConfiguration;
    return pending ? { ...info, ...pending.profile, cli: pending.cli,
      effectiveModel: pending.profile.model, effectiveEffort: pending.profile.effort } : info;
  }

  async function loadSession(sessionId, options = {}) {
    return requiredApi(options).json(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async function saveSession(sessionId, patch, options = {}) {
    return requiredApi(options).json(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      json: patch,
    });
  }

  return {
    desiredConfig,
    EFFORT_OPTIONS,
    CODEX_REASONING_OPTIONS,
    OPENCODE_VARIANT_OPTIONS,
    QODER_MODEL_OPTIONS,
    CODEBUDDY_MODEL_OPTIONS,
    DSH_MODEL_OPTIONS,
    defaultEffort,
    effortOptions,
    effortLabel,
    effortShortName,
    autoProtocolLabel,
    autoProtocolFromValue,
    autoOptionValue,
    autoProvidersForProtocol,
    autoSelectionCrossesTrust,
    autoCandidateModel,
    effectiveProviderId,
    providerShortName,
    providerModelOptions,
    providerAliasMap,
    providerAliasTiers,
    normalizeModel,
    buildModelChoices,
    openCodeNativeProviders,
    openCodeNativeProviderOf,
    stripModelSuffix,
    defaultModelChoice,
    modelChoiceLabel,
    modelDisplayName,
    providerLabel,
    providerLimitLabel,
    supportsSubagentCli,
    resolveSubagent,
    showLoadingOverlay,
    showEffortPicker,
    showProviderPicker,
    showAIConfigPicker,
    showZcodeSetupPrompt,
    maybePromptZcodeSetup,
    loadProviderList,
    loadSession,
    saveSession,
    refreshOpenCodeModels,
    refreshQoderModels,
    refreshCodebuddyModels,
    refreshClaudeModels,
    checkRoutingKeyConfigured,
  };
});

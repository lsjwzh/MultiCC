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
  const PI_THINKING_OPTIONS = Object.freeze([
    Object.freeze({ value: '', label: 'Default', desc: 'Follow Pi settings' }),
    ...['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(value => Object.freeze({ value, label: value })),
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
  // Gemini CLI / Grok Build model ids are free text; these are the current
  // headline ids as suggestions only (the picker always offers 自定义/__custom__).
  const GEMINI_MODEL_OPTIONS = Object.freeze(['', 'gemini-2.5-pro', 'gemini-2.5-flash']);
  // Offline fallback only: the live list comes from /api/grok/models.
  const GROK_MODEL_OPTIONS = Object.freeze(['', 'grok-4.6', 'grok-4.5']);
  // Offline fallback only: the live list comes from /api/commandcode/models.
  const COMMANDCODE_MODEL_OPTIONS = Object.freeze(['', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-flash']);
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

  // Difficulty routing reads its Jev key from the vault. The editor owns the
  // flow (check → paste → test) but every request goes through here: the list
  // call returns names only, a pasted key goes straight into the vault, and the
  // test route reads it in-process — the value never comes back to the page.
  //
  // Every call carries the selected gateway: the same three fields reach the
  // vault description and the test route, so the verdict the user sees was made
  // by the host they actually picked.
  function routingKeyApi() {
    const json = response => response.json().catch(() => ({}));
    return {
      check(name) {
        return fetch('/api/secrets').then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then(list => Array.isArray(list) && list.some(entry => entry && entry.name === name));
      },
      save(name, value, { gateway } = {}) {
        const description = autoProviderEditorApi().routingGatewayDescription(gateway);
        return fetch('/api/secrets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value, description, source: 'user' }),
        }).then(response => (response.ok ? null : json(response).then(body => Promise.reject(new Error(body.error || String(response.status))))));
      },
      test({ apiKeyName, gateway, endpoint, model, text }) {
        return fetch('/api/auto-provider/routing/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKeyName, gateway, endpoint, model, text }),
        }).then(response => (response.status === 404 ? { ok: false, code: 'test_unavailable' } : json(response)));
      },
    };
  }

  function defaultEffort(cli) {
    if (isCodexCli(cli)) return 'xhigh';
    if (isClaudeCli(cli)) return 'medium';
    return '';
  }

  function effortOptions(cli) {
    if (isCodexCli(cli)) return CODEX_REASONING_OPTIONS;
    if (cli === 'opencode') return OPENCODE_VARIANT_OPTIONS;
    if (cli === 'pi') return PI_THINKING_OPTIONS;
    if (cli === 'qoder') return QODER_REASONING_OPTIONS;
    if (cli === 'codebuddy') return CODEBUDDY_REASONING_OPTIONS;
    if (isClaudeCli(cli)) return EFFORT_OPTIONS;
    return [];
  }

  function effortLabel(cli) {
    if (isCodexCli(cli)) return 'Reasoning Level';
    if (cli === 'opencode') return 'Variant';
    if (cli === 'pi') return 'Thinking Level';
    if (cli === 'qoder' || cli === 'codebuddy') return 'Reasoning Effort';
    return 'Effort';
  }

  function effortShortName(cli, effort) {
    const value = effort || defaultEffort(cli);
    if (cli === 'zcode') return '';
    if (cli === 'pi') return value ? ({ off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' })[value] || value : '';
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
    if (!provider) return [];
    // 借道线路：静态 modelOptions 先顶上，warmProviderModels 拉回实时目录后
    // 这里优先读 1 小时缓存；缓存只存 live 结果，失败/编辑线路都会退回静态表。
    const live = readProviderModelsSync(provider.id || effectiveProviderId(providerId, state));
    if (live.length) return live.map(entry => entry.model).filter(Boolean);
    return Array.isArray(provider.modelOptions)
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

  // Claude 的共享目录仍可在构造选项时后台预热。Codex 目录按账号隔离，
  // 由选择器生命周期启动刷新与回填，不能在纯渲染中请求全局目录。
  function nudgeModelCatalog(state) {
    const cli = state && state.cli;
    try {
      // Codex 由选择器生命周期启动账号级刷新；纯渲染不能请求全局目录。
      if (isClaudeCli(cli) && typeof loadClaudeModels === 'function') void loadClaudeModels();
    } catch (_) { /* best-effort */ }
  }

  function buildModelChoices(providerId, state) {
    nudgeModelCatalog(state);
    if (state && state.cli === 'pi') return ['', '__custom__'];
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
      // No "default" row: MultiCC always resolves a concrete model from this
      // same list (see defaultModelChoice), so a blank option would only claim
      // the CLI's own config decides — exactly the terminal default we no
      // longer follow. Old sessions storing '' still resolve to the computed
      // model server-side.
      const cached = readClaudeModelsSync();
      if (cached.length) return [...cached.map(m => m.model), '__custom__'];
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
    if (state && state.cli === 'gemini') return [...GEMINI_MODEL_OPTIONS, '__custom__'];
    if (state && state.cli === 'commandcode') {
      // Live `commandcode --list-models` catalog (1-hour cache, grouped by the
      // vendor's own sections — see modelChoiceGroup); static list until it lands.
      const cached = readModelCacheSync('multicc.commandcode.models.v1', 60 * 60 * 1000);
      return cached.length ? ['', ...cached.map(m => m.model), '__custom__'] : [...COMMANDCODE_MODEL_OPTIONS, '__custom__'];
    }
    if (state && state.cli === 'grok') {
      const cached = readModelCacheSync('multicc.grok.models.v1', 60 * 60 * 1000);
      return cached.length ? ['', ...cached.map(m => m.model), '__custom__'] : [...GROK_MODEL_OPTIONS, '__custom__'];
    }
    if (state && state.cli === 'zcode') return [...ZCODE_MODEL_OPTIONS, '__custom__'];
    if (state && state.cli === 'opencode') {
      // No multicc-managed provider chosen: list the local opencode CLI's
      // available provider/model pairs. Sync-read the 1-hour localStorage cache
      // populated by loadOpenCodeModels() (see public/shared/models.js); the
      // first picker open may return [] here, then refreshOpenCodeModels()
      // fires a rebuild once the fetch resolves.
      const nativeId = openCodeNativeProviderOf(providerId);
      // 线路 id 会在配置改写时变（手写的 `opencodego` ↔ 内置 `opencode-go`）而
      // 模型不变：按「只留字母数字」对齐，旧会话选中的线路才不会在刷新后匹配
      // 不到任何模型、看起来像被清空。
      const nativeKey = openCodeNativeIdKey(nativeId);
      const cached = readOpenCodeModelsSync()
        .filter(m => !nativeId || openCodeNativeIdKey(m.provider) === nativeKey);
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
  const OPENCODE_NATIVE_NAMES = { opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go', opencodego: 'OpenCode Go' };
  function openCodeNativeProviderOf(value) {
    const text = String(value || '');
    return text.startsWith(OPENCODE_NATIVE_PREFIX) ? text.slice(OPENCODE_NATIVE_PREFIX.length) : '';
  }
  // OpenCode Go 的两种 id 指同一个线路：内置 `opencode-go`，以及早期安装指引让
  // 用户手写的 `opencodego`。配置改写可能让缓存/会话在两个 id 之间迁移，比对时
  // 只保留字母数字，避免把同一批模型当成「不存在」。
  function openCodeNativeIdKey(id) {
    return String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // 线路名只有一个来源（这张表）。模型缓存是冷的也答得出来：药丸只有
  // `<线路id>/<模型>` 这一条线索（见 run-config.js 的 openCodeRouteName）。
  function openCodeNativeProviderLabel(id) {
    const key = String(id || '');
    if (!key) return '';
    return OPENCODE_NATIVE_NAMES[key] || key;
  }
  function openCodeNativeProviders() {
    const ids = [...new Set(readOpenCodeModelsSync().map(m => m.provider).filter(Boolean))];
    return ids.map(id => ({ value: OPENCODE_NATIVE_PREFIX + id, label: `OpenCode 原生 · ${openCodeNativeProviderLabel(id)}` }));
  }
  // 把（可能带旧别名的）原生线路值对齐到当前模型目录里的真实 id；非原生线路或
  // 目录里找不到对应 id 时原样返回。刷新后旧会话的 `opencodego` 才能落到
  // `opencode-go` 上，而不是匹配不到任何模型。
  function resolveOpenCodeNativeLine(value) {
    const key = openCodeNativeIdKey(openCodeNativeProviderOf(value));
    if (!key) return String(value == null ? '' : value);
    const match = openCodeNativeProviders()
      .find(item => openCodeNativeIdKey(openCodeNativeProviderOf(item.value)) === key);
    return match ? match.value : value;
  }
  // 线路 id 改名时，`<旧id>/<模型>` 跟着改成 `<新id>/<模型>`；其余值原样返回。
  function rewriteOpenCodeNativeModel(model, fromId, toId) {
    const text = String(model == null ? '' : model).trim();
    const from = String(fromId || '');
    const to = String(toId || '');
    if (!from || !to || from === to) return text;
    const prefix = `${from}/`;
    return text.startsWith(prefix) ? `${to}/${text.slice(prefix.length)}` : text;
  }

  // Vendor-native lines: the CLI owns the account and the model catalog, so the
  // Auto Provider editor shows one synthetic line per lane (`<cli>-native:<cli>`)
  // and stores the vendor model id as the wire model. Mirrors
  // src/providers/native-vendor.js. OpenCode keeps its multi-provider form.
  const VENDOR_NATIVE_CLIS = Object.freeze(['qoder', 'codebuddy', 'gemini', 'pi', 'commandcode', 'dsh', 'grok']);
  const VENDOR_NATIVE_SET = new Set(VENDOR_NATIVE_CLIS);
  function vendorNativeName(cli) {
    const catalog = (root && root.MultiCCProviderCatalog)
      || (typeof require === 'function' ? require('./provider-catalog.js') : null);
    if (catalog && typeof catalog.cliDisplayName === 'function') {
      const name = catalog.cliDisplayName(cli);
      if (name) return String(name);
    }
    return String(cli || '');
  }
  function vendorNativeProviderOf(value) {
    const text = String(value || '');
    const at = text.indexOf('-native:');
    if (at <= 0) return '';
    const cli = text.slice(0, at);
    return VENDOR_NATIVE_SET.has(cli) ? cli : '';
  }
  function isVendorNativeProvider(value) {
    return vendorNativeProviderOf(value) !== '';
  }
  function vendorNativeModelIds(cli) {
    try {
      if (cli === 'commandcode') {
        const cached = readModelCacheSync('multicc.commandcode.models.v1', 60 * 60 * 1000);
        return (cached.length ? cached.map(m => m.model) : COMMANDCODE_MODEL_OPTIONS).filter(Boolean);
      }
      if (cli === 'qoder') {
        const cached = readQoderModelsSync();
        return (cached.length ? cached.map(m => m.model) : QODER_MODEL_OPTIONS).filter(Boolean);
      }
      if (cli === 'codebuddy') {
        const cached = readCodebuddyModelsSync();
        return (cached.length ? cached.map(m => m.model) : CODEBUDDY_MODEL_OPTIONS).filter(Boolean);
      }
      if (cli === 'grok') {
        const cached = readModelCacheSync('multicc.grok.models.v1', 60 * 60 * 1000);
        return (cached.length ? cached.map(m => m.model) : GROK_MODEL_OPTIONS).filter(Boolean);
      }
    } catch (_) { /* a cold cache is not a failure */ }
    if (cli === 'dsh') return DSH_MODEL_OPTIONS.filter(Boolean);
    if (cli === 'gemini') return GEMINI_MODEL_OPTIONS.filter(Boolean);
    return [];
  }
  function vendorNativeProvidersFor(cli) {
    const lane = String(cli || '');
    if (!VENDOR_NATIVE_SET.has(lane)) return [];
    return [{
      value: `${lane}-native:${lane}`,
      label: `${vendorNativeName(lane)}（本机 CLI / 官方账号）`,
      modelOptions: vendorNativeModelIds(lane),
    }];
  }
  const COMMANDCODE_NATIVE_LINE = 'commandcode-native:commandcode';
  function isCommandCodeNativeProvider(value) {
    return String(value || '').startsWith('commandcode-native:');
  }
  function commandCodeNativeProviderLabel() {
    return `${vendorNativeName('commandcode')}（本机 CLI / 官方账号）`;
  }
  function commandCodeModelIds() {
    return vendorNativeModelIds('commandcode');
  }
  function commandCodeNativeProviders() {
    return vendorNativeProvidersFor('commandcode');
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

  // ── Relay (借道) provider live model list ────────────────────────────────
  // GET /api/providers/:id/models asks the server to pull `{baseURL}/models`
  // from the provider's OWN stored config (the browser never supplies a base
  // URL). The picker renders the static `modelOptions` immediately and then
  // rebuilds once the live list lands; failures leave the static list intact.
  // Mirrored per provider for one hour, exactly like the other live catalogs.
  const PROVIDER_MODELS_TTL_MS = 60 * 60 * 1000;
  // A relay that cannot answer must not be re-probed on every keystroke/render;
  // force (刷新模型) always bypasses this.
  const PROVIDER_MODELS_FAILURE_TTL_MS = 60 * 1000;
  const PROVIDER_MODELS_KEY_PREFIX = 'multicc.provider.models.v1:';
  const OFFICIAL_PROVIDER_ID_RE = /^(?:claude|codex)-official(?:-[a-f0-9]{16})?$/;
  // CLIs that can bind a MultiCC provider AND appear on the refresh roster.
  const RELAY_PROVIDER_CLIS = Object.freeze(new Set([
    'claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'grok',
  ]));
  const providerModelsInflight = new Map();
  const providerModelsFailedAt = new Map();

  function providerModelsCacheKey(providerId) {
    return PROVIDER_MODELS_KEY_PREFIX + String(providerId || '');
  }

  function readProviderModelsCache(providerId) {
    try {
      const ls = root && root.localStorage;
      if (!ls) return null;
      const raw = ls.getItem(providerModelsCacheKey(providerId));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const at = Number(obj && obj.at) || 0;
      const models = obj && Array.isArray(obj.models) ? obj.models : [];
      if (!at || (Date.now() - at) >= PROVIDER_MODELS_TTL_MS || !models.length) return null;
      return { at, source: String(obj && obj.source || ''), models };
    } catch (_) { return null; }
  }

  // Only a live upstream answer is worth pinning; a fallback is just the static
  // provider list the caller already has, and caching it would hide provider
  // edits for an hour.
  function readProviderModelsSync(providerId) {
    const cached = readProviderModelsCache(providerId);
    return cached && cached.source === 'live' ? cached.models : [];
  }

  function writeProviderModelsCache(providerId, models) {
    try {
      const ls = root && root.localStorage;
      if (ls && Array.isArray(models) && models.length) {
        ls.setItem(providerModelsCacheKey(providerId), JSON.stringify({
          at: Date.now(), source: 'live', models,
        }));
      }
    } catch (_) { /* ignore quota / disabled storage */ }
  }

  function normalizeProviderModelEntry(entry) {
    if (typeof entry === 'string') {
      const model = entry.trim();
      return model ? { model, label: model } : null;
    }
    if (!entry || typeof entry !== 'object') return null;
    const model = String(entry.model || entry.id || '').trim();
    if (!model) return null;
    const label = String(entry.label || entry.name || entry.display_name || model).trim() || model;
    return { model, label };
  }

  // Anything that is NOT an official account (or an OpenCode-native row) is a
  // user-configured relay/custom provider with its own /models endpoint.
  function isRelayProviderId(providerId) {
    const id = String(providerId || '').trim();
    return !!id && !OFFICIAL_PROVIDER_ID_RE.test(id) && !id.startsWith(OPENCODE_NATIVE_PREFIX);
  }

  async function loadProviderModels(providerId, options) {
    const id = String(providerId || '').trim();
    if (!id) return [];
    const force = !!(options && options.force);
    if (!force) {
      const cached = readProviderModelsCache(id);
      if (cached && cached.source === 'live' && cached.models.length) return cached.models;
      const failedAt = providerModelsFailedAt.get(id) || 0;
      if (failedAt && (Date.now() - failedAt) < PROVIDER_MODELS_FAILURE_TTL_MS) return [];
      const active = providerModelsInflight.get(id);
      if (active) return active;
    }
    const fetchFn = root && typeof root.fetch === 'function'
      ? root.fetch.bind(root)
      : (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) return [];
    const promise = (async () => {
      try {
        const url = `/api/providers/${encodeURIComponent(id)}/models${force ? '?refresh=1' : ''}`;
        const response = await fetchFn(url, { credentials: 'same-origin' });
        if (!response || !response.ok) {
          providerModelsFailedAt.set(id, Date.now());
          return [];
        }
        const data = await response.json();
        const models = (data && Array.isArray(data.models) ? data.models : [])
          .map(normalizeProviderModelEntry).filter(Boolean);
        if (models.length && data && data.source === 'live') {
          writeProviderModelsCache(id, models);
          providerModelsFailedAt.delete(id);
        } else {
          providerModelsFailedAt.set(id, Date.now());
        }
        return models;
      } catch (_) {
        providerModelsFailedAt.set(id, Date.now());
        return [];
      } finally {
        providerModelsInflight.delete(id);
      }
    })();
    providerModelsInflight.set(id, promise);
    return promise;
  }

  // Same contract as refreshQoderModels, for a relay provider's live catalog.
  async function refreshProviderModels(providerId, rebuildCallback, options) {
    const force = !!(options && options.force);
    const prev = readProviderModelsSync(providerId);
    let models = [];
    try { models = await loadProviderModels(providerId, { force }); } catch (_) { models = []; }
    if (typeof rebuildCallback === 'function' && (force || prev.length === 0)) {
      try { rebuildCallback(); } catch (_) { /* noop */ }
    }
    return models;
  }

  // Picker-open warm: static modelOptions render first, then this refreshes in
  // the background and the caller rebuilds. Never waits, never throws.
  async function warmProviderModels(providerId, rebuildCallback) {
    if (!isRelayProviderId(providerId)) return [];
    const cached = readProviderModelsSync(providerId);
    if (cached.length) return cached;
    return refreshProviderModels(providerId, rebuildCallback, {});
  }

  // The CLIs whose picker is fed by a live catalog endpoint and therefore gets
  // the 刷新模型 button. Everything else (dsh / gemini / zcode / kimi / pi) is
  // a static or provider-catalog list with nothing to re-read. Keep this as the
  // single roster; run-config.js reads it off this module.
  const REFRESHABLE_MODEL_CLIS = Object.freeze(new Set([
    'opencode', 'qoder', 'codebuddy', 'commandcode', 'grok',
    'claude', 'claude-exp', 'codex', 'codex-exp',
  ]));

  // Resolve a loader exposed by shared/models.js. In the browser that is
  // window.<name>; in node tests the module has no root, so fall back to
  // globalThis. Missing loaders stay null (callers keep their fallback list).
  function catalogLoader(name) {
    const fromRoot = root && root[name];
    if (typeof fromRoot === 'function') return fromRoot;
    return typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function'
      ? globalThis[name] : null;
  }

  // Background-refresh the OpenCode model list (1-hour cache, shared with
  // shared/models.js via the same localStorage key). The chat page should call
  // this once on init when `cli === 'opencode'`; on completion it triggers a
  // UI re-resolve so the picker shows the freshly fetched entries.
  // `options.force` is the user pressing 刷新模型: skip both caches and rebuild
  // even though a list is already on screen (that list may name models
  // opencode has since retired). The fetched entries are returned so the
  // caller can report how many it got.
  async function refreshOpenCodeModels(rebuildCallback, options) {
    const force = !!(options && options.force);
    try {
      const loader = catalogLoader('loadOpenCodeModels');
      if (!loader) return [];
      const prev = readOpenCodeModelsSync();
      const models = await loader({ force });
      if (typeof rebuildCallback === 'function' && (force || prev.length === 0)) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
      return Array.isArray(models) ? models : [];
    } catch (_) { return []; /* swallow — picker keeps the placeholder */ }
  }

  // Same contract as refreshOpenCodeModels, for the Qoder CN catalog. The chat
  // page calls this on init when `cli === 'qoder'` so the picker upgrades from
  // the built-in tiers to the account's real model list. `options.force` is the
  // 刷新模型 button: pass refresh=1 through and repaint even with a warm list.
  async function refreshQoderModels(rebuildCallback, options) {
    const force = !!(options && options.force);
    try {
      const loader = catalogLoader('loadQoderModels');
      if (!loader) return [];
      const prev = readQoderModelsSync();
      const models = await loader({ force });
      if (typeof rebuildCallback === 'function' && (force || prev.length === 0)) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
      return Array.isArray(models) ? models : [];
    } catch (_) { return []; /* swallow — picker keeps the tier fallback */ }
  }

  // Same contract as refreshQoderModels, for the Claude CLI-bundle model list.
  // The chat page calls this on init / CLI switch when `cli === 'claude'` so
  // the picker upgrades from the static table to the CLI's real model ids.
  async function refreshClaudeModels(rebuildCallback, options) {
    const force = !!(options && options.force);
    try {
      const loader = catalogLoader('loadClaudeModels');
      if (!loader) return [];
      const prev = readClaudeModelsSync();
      const models = await loader({ force });
      if (typeof rebuildCallback === 'function' && (force || prev.length === 0)) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
      return Array.isArray(models) ? models : [];
    } catch (_) { return []; /* swallow — picker keeps the static table */ }
  }

  // Same contract as refreshQoderModels, for the WorkBuddy catalog. The chat
  // page calls this on init / CLI switch when `cli === 'codebuddy'` so the
  // picker upgrades from the fallback snapshot to the installed CLI's ids.
  async function refreshCodebuddyModels(rebuildCallback, options) {
    const force = !!(options && options.force);
    try {
      const loader = catalogLoader('loadCodebuddyModels');
      if (!loader) return [];
      const prev = readCodebuddyModelsSync();
      const models = await loader({ force });
      if (typeof rebuildCallback === 'function' && (force || prev.length === 0)) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
      return Array.isArray(models) ? models : [];
    } catch (_) { return []; /* swallow — picker keeps the fallback snapshot */ }
  }

  // Same contract as refreshCodebuddyModels, for Command Code / Grok.
  function liveCatalogRefresher(loaderName, cacheKey) {
    return async function refresh(rebuildCallback, options) {
      const force = !!(options && options.force);
      try {
        const loader = catalogLoader(loaderName);
        if (!loader) return [];
        const had = readModelCacheSync(cacheKey, 60 * 60 * 1000).length > 0;
        const models = await loader({ force });
        if (typeof rebuildCallback === 'function' && (force || !had)) {
          try { rebuildCallback(); } catch (_) { /* noop */ }
        }
        return Array.isArray(models) ? models : [];
      } catch (_) { return []; /* swallow — picker keeps the static fallback */ }
    };
  }
  const refreshCommandcodeModels = liveCatalogRefresher('loadCommandcodeModels', 'multicc.commandcode.models.v1');
  const refreshGrokModels = liveCatalogRefresher('loadGrokModels', 'multicc.grok.models.v1');

  // Codex's catalog is per account: force asks the server to re-check the CLI
  // version / one-day cache for the provider the picker currently has selected.
  async function refreshCodexModels(rebuildCallback, options) {
    const force = !!(options && options.force);
    try {
      const loader = catalogLoader('loadCodexModels');
      if (!loader) return [];
      // The picker keeps the account catalog in memory (not localStorage), so
      // "already had a list" is read from that catalog before the fetch.
      const reader = catalogLoader('readCodexModelCatalogSync');
      let prev = false;
      try { prev = !!(reader && (((reader(options) || {}).models) || []).length); } catch (_) {}
      const catalog = await loader({ force, providerId: options && options.providerId });
      const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
      if (typeof rebuildCallback === 'function' && (force || !prev)) {
        try { rebuildCallback(); } catch (_) { /* noop */ }
      }
      return models;
    } catch (_) { return []; }
  }

  // One 刷新模型 entry point for every dynamic CLI. `options.force` bypasses
  // both browser and server caches; `options.providerId` is only meaningful for
  // Codex. Returns the freshly fetched entries so the caller can report a count.
  const MODEL_REFRESHERS = Object.freeze({
    opencode: refreshOpenCodeModels,
    qoder: refreshQoderModels,
    codebuddy: refreshCodebuddyModels,
    commandcode: refreshCommandcodeModels,
    grok: refreshGrokModels,
    claude: refreshClaudeModels,
    'claude-exp': refreshClaudeModels,
    codex: refreshCodexModels,
    'codex-exp': refreshCodexModels,
  });

  function refreshModelsForCli(cli, rebuildCallback, options) {
    const name = String(cli || '');
    const refresh = MODEL_REFRESHERS[name];
    const providerId = options && options.providerId;
    // 借道线路的模型表属于 provider，不属于 CLI：claude/codex 等挂在自定义
    // provider 上时，刷新按钮必须请求 /api/providers/:id/models，而不是去读本机
    // 官方账号目录（codex 旧路径会直接报「账号线路不存在」）。
    if (providerId && RELAY_PROVIDER_CLIS.has(name) && isRelayProviderId(providerId)) {
      return refreshProviderModels(providerId, rebuildCallback, options).then(models => {
        if (models.length) return models;
        // A provider that has no pullable catalog (or was deleted) keeps its old
        // CLI-specific behaviour instead of breaking the button.
        return refresh ? refresh(rebuildCallback, options) : [];
      });
    }
    return refresh ? refresh(rebuildCallback, options) : Promise.resolve([]);
  }

  // The vendor's own section for a model (Command Code groups its catalog as
  // Open Source / Anthropic / OpenAI / Google / xAI / ...). '' = ungrouped.
  function modelChoiceGroup(value, state) {
    if (!state || state.cli !== 'commandcode' || !value || value === '__custom__') return '';
    const hit = readModelCacheSync('multicc.commandcode.models.v1', 60 * 60 * 1000).find(m => m && m.model === value);
    return hit && hit.group ? String(hit.group) : '';
  }

  function stripModelSuffix(model) {
    return String(model || '').replace(/\[[^\]]*\]$/, '').trim();
  }

  // The highlighted model when the session has no explicit selection. The
  // server computes it from the lane's model list and this user's explicit
  // selections on that line (never from terminal config); the session payload
  // carries it as `effectiveModel`. When the dialog is pointed at a different
  // provider/CLI than the session, that value no longer describes the list on
  // screen, so only a matching line may use it.
  // 官方线路是「每个已登录账号一条」：裸 <pool>-official 与服务端归一化后的
  // <pool>-official-<16 位账号 id> 是同一条线，算好的默认模型不能因为写法不同丢掉。
  function sameProviderLine(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (left === right) return true;
    return OFFICIAL_PROVIDER_ID_RE.test(left)
      && OFFICIAL_PROVIDER_ID_RE.test(right)
      && left.split('-')[0] === right.split('-')[0];
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
    if (provider && provider.model) return provider.model;
    // The highlighted value has to be one the dropdown actually renders; a
    // stale effective model (catalog changed under an old session) falls back
    // to list order instead of blanking the select.
    const choices = buildModelChoices(providerId, state)
      .filter(value => value !== '__custom__');
    const effective = state && state.effectiveModel;
    const sameLine = effective && sameProviderLine(state.effectiveProvider || '', providerId || '');
    if (sameLine && choices.includes(effective)) return effective;
    return choices[0] || options[0] || '';
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
      if (state && state.cli === 'pi') return localized(state, 'aiConfigDefaultFollowPi', '默认（跟随 Pi 配置）');
      if (state && state.cli === 'gemini') return localized(state, 'aiConfigDefaultFollowGemini', '默认（跟随 Gemini 配置）');
      if (state && state.cli === 'commandcode') return '默认（DeepSeek Flash）';
      if (state && state.cli === 'grok') return localized(state, 'aiConfigDefaultFollowGrok', '默认（跟随 Grok 配置）');
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
    if (state && (state.cli === 'dsh' || state.cli === 'gemini' || state.cli === 'grok')) {
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
    // Relay live catalogs carry the upstream's display name (or just the id).
    const relay = readProviderModelsSync(effectiveProviderId(providerId, state))
      .find(entry => entry && entry.model === value);
    if (relay && relay.label && relay.label !== value) return relay.label;
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
    const view = quotaBarView();
    if (view) {
      const resolved = view.resolveProviderLimit(limit, { now: nowMs,
        translate: typeof tr === 'function' ? (key, params, fallback) => {
          const translated = tr(key, params);
          return translated && translated !== key ? translated : fallback;
        } : undefined,
        rolled: typeof tr === 'function' ? tr('quotaRolledWindow') : undefined });
      return resolved.text ? ` · ${resolved.text}` : '';
    }
    return '';
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

  /* Phones: a tall panel would push its action row below the screen edge with
   * nothing to scroll, so the save button becomes unreachable. Build every
   * dialog as a flex column whose body scrolls and whose footer stays pinned
   * inside the visible box. */
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
    GEMINI_MODEL_OPTIONS,
    GROK_MODEL_OPTIONS,
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
    openCodeNativeProviderLabel,
    openCodeNativeIdKey,
    commandCodeNativeProviders,
    commandCodeNativeProviderLabel,
    commandCodeModelIds,
    isCommandCodeNativeProvider,
    vendorNativeProvidersFor,
    vendorNativeProviderOf,
    vendorNativeModelIds,
    isVendorNativeProvider,
    VENDOR_NATIVE_CLIS,
    resolveOpenCodeNativeLine,
    rewriteOpenCodeNativeModel,
    stripModelSuffix,
    defaultModelChoice,
    modelChoiceLabel,
    modelDisplayName,
    providerLabel,
    providerLimitLabel,
    supportsSubagentCli,
    resolveSubagent,
    showLoadingOverlay,
    showZcodeSetupPrompt,
    maybePromptZcodeSetup,
    loadProviderList,
    loadSession,
    saveSession,
    REFRESHABLE_MODEL_CLIS,
    refreshModelsForCli,
    refreshProviderModels,
    warmProviderModels,
    isRelayProviderId,
    refreshOpenCodeModels,
    refreshCodexModels,
    refreshQoderModels,
    refreshCodebuddyModels,
    refreshCommandcodeModels,
    refreshGrokModels,
    modelChoiceGroup,
    refreshClaudeModels,
    routingKeyApi,
  };
});

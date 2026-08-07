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
  // Provider-less ZCode follows its native config/Coding Plan. Do not hardcode
  // a vendor/model pair here: the native provider may be Z.ai, BigModel, Start
  // Plan, Team Plan, or a user-defined provider.
  const ZCODE_MODEL_OPTIONS = Object.freeze(['']);
  const ZCODE_SETUP_PROMPTED = new Set();

  function defaultEffort(cli) {
    if (cli === 'codex') return 'xhigh';
    if (cli === 'claude') return 'medium';
    return '';
  }

  function effortOptions(cli) {
    if (cli === 'codex') return CODEX_REASONING_OPTIONS;
    if (cli === 'opencode') return OPENCODE_VARIANT_OPTIONS;
    if (cli === 'qoder') return QODER_REASONING_OPTIONS;
    if (cli === 'claude') return EFFORT_OPTIONS;
    return [];
  }

  function effortLabel(cli) {
    if (cli === 'codex') return 'Reasoning Level';
    if (cli === 'opencode') return 'Variant';
    if (cli === 'qoder') return 'Reasoning Effort';
    return 'Effort';
  }

  function effortShortName(cli, effort) {
    const value = effort || defaultEffort(cli);
    if (cli === 'zcode') return '';
    if (cli === 'opencode') return value ? `Variant ${value}` : '';
    if (cli === 'codex' || cli === 'qoder') {
      return ({
        xhigh: 'Extra high', low: 'Low', medium: 'Medium', high: 'High',
        max: 'Max', ultra: 'Ultra',
      })[value] || value;
    }
    return value;
  }

  function providersOf(state) {
    return state && Array.isArray(state.providers) ? state.providers : [];
  }

  function translate(state, key) {
    return state && typeof state.translate === 'function' ? state.translate(key) : key;
  }

  function effectiveProviderId(providerId, state) {
    const defaults = state && state.defaults && typeof state.defaults === 'object' ? state.defaults : {};
    return providerId || defaults[(state && state.cli) || 'claude'] || '';
  }

  function findProvider(providerId, state) {
    const id = effectiveProviderId(providerId, state);
    return id ? providersOf(state).find(provider => provider && provider.id === id) || null : null;
  }

  function providerShortName(providerId, state) {
    if (!providerId) return translate(state, 'default');
    const provider = providersOf(state).find(item => item && item.id === providerId);
    return provider
      ? provider.name
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

  function buildModelChoices(providerId, state) {
    const tiers = providerAliasTiers(providerId, state);
    if (tiers.length) return [...tiers.map(([tier]) => tier), '__custom__'];
    const options = providerModelOptions(providerId, state);
    if (options.length) return [...options, '__custom__'];
    if (state && state.cli === 'claude') {
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
    if (state && state.cli === 'zcode') return [...ZCODE_MODEL_OPTIONS, '__custom__'];
    if (state && state.cli === 'opencode') {
      // No multicc-managed provider chosen: list the local opencode CLI's
      // available provider/model pairs. Sync-read the 1-day localStorage cache
      // populated by loadOpenCodeModels() (see public/shared/models.js); the
      // first picker open may return [] here, then refreshOpenCodeModels()
      // fires a rebuild once the fetch resolves.
      const cached = readOpenCodeModelsSync();
      if (cached.length) return ['', ...cached.map(m => `${m.provider}/${m.model}`), '__custom__'];
      return ['', '__custom__'];
    }
    return ['', '__custom__'];
  }

  // Synchronous read of a CLI model cache populated by shared/models.js
  // (loadOpenCodeModels / loadQoderModels). Returns [] when the cache is
  // missing/stale so callers can render a placeholder option without blocking.
  function readModelCacheSync(key) {
    try {
      const ls = root && root.localStorage;
      if (!ls) return [];
      const raw = ls.getItem(key);
      if (!raw) return [];
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return [];
      const at = Number(obj.at) || 0;
      const models = Array.isArray(obj.models) ? obj.models : [];
      const TTL = 24 * 60 * 60 * 1000;
      if (!at || (Date.now() - at) >= TTL) return [];
      return models;
    } catch (_) { return []; }
  }

  function readOpenCodeModelsSync() {
    return readModelCacheSync('multicc.opencode.models.v1');
  }

  function readQoderModelsSync() {
    return readModelCacheSync('multicc.qoder.models.v1');
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
      if (state && state.cli === 'codex') return '默认（跟随 Provider）';
      if (state && state.cli === 'qoder') return '默认（跟随 Qoder CN 设置）';
      if (state && state.cli === 'zcode') return '默认（跟随 ZCode 设置）';
      return translate(state, 'default');
    }
    if (state && state.cli === 'qoder') {
      return ({
        auto: 'Auto（智能路由）', ultimate: 'Ultimate（极致）',
        performance: 'Performance（性能）', efficient: 'Efficient（经济）',
        lite: 'Lite（轻量）',
      })[value] || (value === '__custom__' ? translate(state, 'custom') : value);
    }
    const named = (state && state.claudeModelOptions || []).find(option => option.value === value);
    if (named) return named.labelKey ? translate(state, named.labelKey) : named.label;
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
    const protocol = provider.apiFormat === 'openai_chat'
      ? ' [Chat→Responses]'
      : (provider.apiFormat === 'openai_responses' ? ' [Responses]' : ' [Anthropic]');
    const endpoint = provider.isOfficial
      ? ' · 订阅'
      : (provider.baseUrl ? ' · ' + provider.baseUrl.replace(/^https?:\/\//, '') : '');
    return provider.name + protocol + endpoint + (includeModel && provider.model ? ' · ' + provider.model : '');
  }

  function documentOf(options) {
    const document = options && options.document || (root && root.document);
    if (!document) throw new Error('Chat AI config picker requires a document');
    return document;
  }

  function showLoadingOverlay(text, options = {}) {
    const document = documentOf(options);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px 22px;color:#c9d1d9;font-size:13px;display:flex;align-items:center;gap:10px;';
    const spinner = document.createElement('span');
    spinner.style.cssText = 'width:14px;height:14px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;display:inline-block;animation:multiccSpin .8s linear infinite;';
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
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:380px;max-width:94vw;color:#c9d1d9;';
      box.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">选择努力程度（下一轮生效）</div>
        <div style="font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:12px;">Claude 支持 low / medium / high / xhigh / max。ultracode 会向 Claude 传 xhigh，并启用 MultiCC 跨会话 workflow 编排。</div>
        <select id="effort-select" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;">
          ${choices.map(option => `<option value="${option.value}">${option.label}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="effort-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">取消</button>
          <button id="effort-ok" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">保存</button>
        </div>`;
      overlay.appendChild(box);
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
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:400px;max-width:94vw;';
      const message = document.createElement('div');
      message.style.cssText = 'font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:12px;';
      message.textContent = t('providerTitle');
      box.appendChild(message);
      const select = document.createElement('select');
      select.style.cssText = 'width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;';
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = t('providerDefault');
      select.appendChild(defaultOption);
      for (const provider of list || []) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, true);
        select.appendChild(option);
      }
      select.value = current || '';
      box.appendChild(select);
      if (!list || !list.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:12px;color:#8b949e;margin-bottom:12px;';
        empty.textContent = t('providerEmpty');
        box.appendChild(empty);
      }
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancel = document.createElement('button');
      cancel.textContent = t('cancel');
      cancel.style.cssText = 'background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;';
      const save = document.createElement('button');
      save.textContent = t('save');
      save.style.cssText = 'background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;';
      row.append(cancel, save);
      box.appendChild(row);
      overlay.appendChild(box);
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
    const supportsProvider = cli !== 'qoder';
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:480px;max-width:94vw;color:#c9d1d9;';
      box.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">AI 配置（下一轮生效）</div>
        <div style="font-size:12px;color:#8b949e;line-height:1.5;margin-bottom:12px;">${supportsProvider ? 'Provider、' : ''}Model${choicesForEffort.length ? `、${effortLabel(cli)}` : ''} 会一起保存。${supportsProvider ? (cli === 'zcode' ? '选择 Provider 时使用 MultiCC 的三协议隔离配置；选择默认时跟随 ZCode 原生设置 / Coding Plan。' : '切换 Provider 后，Model 选项会按该 Provider 的可用模型联动更新。') : 'Qoder CN 使用自身账号与厂商配置。'}</div>
        <div id="ai-provider-section">
          <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">Provider</label>
          <select id="ai-provider" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;"></select>
        </div>
        <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">Model</label>
        <select id="ai-model" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:8px;"></select>
        <input id="ai-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:12px;display:none;">
        <div id="ai-effort-section">
          <label id="ai-effort-label" style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">${effortLabel(cli)}</label>
          <select id="ai-effort" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;"></select>
        </div>
        <div id="ai-agent-section">
          <div style="height:1px;background:#30363d;margin:4px 0 14px;"></div>
          <div style="font-size:13px;font-weight:600;margin-bottom:2px;">${cli === 'claude' ? 'Claude Code' : cli === 'opencode' ? 'OpenCode' : 'Qoder CN'} Agent</div>
          <div style="font-size:11px;color:#8b949e;line-height:1.45;margin-bottom:8px;">对应原生 <code>--agent</code>，用于选择该 CLI 已定义的主 agent；它不同于下面的子任务路由。留空使用 CLI 默认 agent。</div>
          <input id="ai-agent" type="text" list="ai-agent-list" maxlength="80" placeholder="${cli === 'opencode' ? '例如 build' : '已定义的 agent 名称'}" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;">
          <datalist id="ai-agent-list">${cli === 'opencode' ? '<option value="build"></option>' : ''}</datalist>
        </div>
        <div id="ai-sub-section">
          <div style="height:1px;background:#30363d;margin:4px 0 14px;"></div>
          <div style="font-size:13px;font-weight:600;margin-bottom:2px;">子任务 (subagent)</div>
          <div style="font-size:11px;color:#8b949e;line-height:1.45;margin-bottom:10px;">子 agent 走的 provider+model（经本地协议代理路由，与主进程隔离）。留空=随主。</div>
          <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">子任务 Provider</label>
          <select id="ai-sub-provider" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:10px;"></select>
          <label style="display:block;font-size:12px;color:#8b949e;margin-bottom:5px;">子任务 Model</label>
          <select id="ai-sub-model" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:6px;"></select>
          <input id="ai-sub-model-custom" type="text" placeholder="模型 ID" style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:8px 10px;outline:none;margin-bottom:14px;display:none;">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="ai-cancel" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:13px;padding:6px 14px;cursor:pointer;">取消</button>
          <button id="ai-ok" style="background:#238636;border:1px solid #2ea043;border-radius:6px;color:#fff;font-size:13px;padding:6px 14px;cursor:pointer;">保存</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const providerSelect = box.querySelector('#ai-provider');
      const providerSection = box.querySelector('#ai-provider-section');
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
          ? 'OpenCode 原生配置（OpenCode Go 等）'
          : translate(state, 'providerDefault');
      providerSelect.appendChild(defaultProvider);
      for (const provider of providersOf(state)) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, true);
        providerSelect.appendChild(option);
      }
      providerSelect.value = config.provider || '';
      providerSection.style.display = supportsProvider ? '' : 'none';
      if (!supportsProvider) providerSelect.value = '';

      effortSection.style.display = choicesForEffort.length ? '' : 'none';
      agentSection.style.display = cli === 'claude' || cli === 'opencode' || cli === 'qoder' ? '' : 'none';
      subSection.style.display = cli === 'claude' || cli === 'codex' ? '' : 'none';
      agentInput.value = cli === 'claude' || cli === 'opencode' || cli === 'qoder' ? (config.agent || '') : '';
      for (const choice of choicesForEffort) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.desc ? `${choice.label} — ${choice.desc}` : choice.label;
        effortSelect.appendChild(option);
      }
      effortSelect.value = choicesForEffort.some(choice => choice.value === config.effort)
        ? config.effort
        : defaultEffort(cli);

      const subProviderSelect = box.querySelector('#ai-sub-provider');
      const subModelSelect = box.querySelector('#ai-sub-model');
      const subCustomModel = box.querySelector('#ai-sub-model-custom');
      const subDefault = document.createElement('option');
      subDefault.value = '';
      subDefault.textContent = '默认（随主）';
      subProviderSelect.appendChild(subDefault);
      for (const provider of providersOf(state)) {
        if (cli === 'codex' && provider.isOfficial) continue;
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider, false);
        subProviderSelect.appendChild(option);
      }
      const initialSubagent = config.subagent && config.subagent.providerId ? config.subagent : null;
      subProviderSelect.value = initialSubagent ? initialSubagent.providerId : '';

      function syncSubCustom() {
        subCustomModel.style.display = subModelSelect.value === '__custom__' ? '' : 'none';
      }
      function rebuildSubModels(providerId, preferred) {
        let selected = normalizeModel(providerId, preferred || '', state);
        const choices = buildModelChoices(providerId, state);
        subModelSelect.innerHTML = '';
        for (const value of choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = modelChoiceLabel(value, providerId, state);
          subModelSelect.appendChild(option);
        }
        if (!selected) selected = defaultModelChoice(providerId, state);
        const known = choices.includes(selected);
        subModelSelect.value = known ? selected : (selected ? '__custom__' : choices[0]);
        subCustomModel.value = known ? '' : selected;
        syncSubCustom();
      }
      function refreshSubUi() {
        const providerId = subProviderSelect.value;
        subModelSelect.disabled = !providerId;
        subCustomModel.disabled = !providerId;
        if (providerId) {
          const preferred = initialSubagent && providerId === initialSubagent.providerId
            ? initialSubagent.model
            : '';
          rebuildSubModels(providerId, preferred);
        } else {
          subModelSelect.innerHTML = '<option value="">（随主）</option>';
          subModelSelect.value = '';
          syncSubCustom();
        }
      }
      refreshSubUi();
      subProviderSelect.onchange = refreshSubUi;
      subModelSelect.onchange = () => {
        syncSubCustom();
        if (subModelSelect.value === '__custom__') subCustomModel.focus();
      };

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
      rebuildModels(providerSelect.value, config.model || '');
      providerSelect.onchange = () => {
        rebuildModels(providerSelect.value, '');
        if (cli === 'codex' && !providerSelect.value) subProviderSelect.value = '';
        refreshSubUi();
      };
      modelSelect.onchange = () => {
        syncCustom();
        if (modelSelect.value === '__custom__') customModel.focus();
      };

      const close = result => { overlay.remove(); resolve(result); };
      box.querySelector('#ai-ok').onclick = () => {
        const selectedModel = modelSelect.value === '__custom__'
          ? customModel.value.trim()
          : modelSelect.value;
        const childProviderId = subProviderSelect.value;
        const childModel = childProviderId
          ? (subModelSelect.value === '__custom__' ? subCustomModel.value.trim() : subModelSelect.value)
          : '';
        close({
          provider: providerSelect.value,
          model: selectedModel,
          effort: effortSelect.value,
          agent: cli === 'claude' || cli === 'opencode' || cli === 'qoder' ? agentInput.value.trim() : null,
          subagent: (cli === 'claude' || cli === 'codex') && childProviderId && childModel
            ? { providerId: childProviderId, model: childModel }
            : null,
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
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10020;display:flex;align-items:center;justify-content:center;padding:16px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px;width:460px;max-width:94vw;color:#c9d1d9;';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';
      title.textContent = '配置 ZCode 连接';
      const message = document.createElement('div');
      message.style.cssText = 'font-size:12px;color:#8b949e;line-height:1.65;margin-bottom:14px;';
      message.textContent = '可选择 MultiCC 中已有的三协议 Provider；或配置 ZCode 原生连接，使用官方 Coding Plan / API Key。原生登录状态由 ZCode 自己维护。';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
      const later = document.createElement('button');
      later.className = 'btn';
      later.textContent = '稍后';
      const settings = document.createElement('button');
      settings.className = 'btn';
      settings.textContent = '配置 Coding Plan / API Key';
      const provider = document.createElement('button');
      provider.className = 'btn btn-green';
      provider.textContent = options.hasProviders ? '选择已有 Provider' : '创建 Provider';
      row.append(later, settings, provider);
      box.append(title, message, row);
      overlay.appendChild(box);
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
    const type = cli === 'codex' ? 'codex' : 'claude';
    const raw = await api.json(`/api/providers?cli=${encodeURIComponent(cli || 'claude')}`);
    const normalized = catalog.normalizeCatalog(raw);
    return Object.freeze({
      providers: Object.freeze(catalog.providersForCli(normalized, cli || 'claude')),
      defaults: normalized.defaults,
    });
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
    EFFORT_OPTIONS,
    CODEX_REASONING_OPTIONS,
    OPENCODE_VARIANT_OPTIONS,
    defaultEffort,
    effortOptions,
    effortLabel,
    effortShortName,
    effectiveProviderId,
    providerShortName,
    providerModelOptions,
    providerAliasMap,
    providerAliasTiers,
    normalizeModel,
    buildModelChoices,
    stripModelSuffix,
    defaultModelChoice,
    modelChoiceLabel,
    modelDisplayName,
    providerLabel,
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
  };
});

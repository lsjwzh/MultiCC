'use strict';

(function initAirProvider(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const catalogApi = root.MultiCCProviderCatalog;
  // 内置官方供应商的名字是服务端数据（'Codex 官方'），展示时按身份翻译；编辑框里
  // 仍读原始 name，免得把英文写回记录。见 public/provider-catalog.js。
  const displayName = provider => (catalogApi && catalogApi.providerDisplayName
    ? catalogApi.providerDisplayName(provider) : (provider && provider.name) || '');
  const protocols = [
    ['all', t('airProviderProtocolAll')],
    ['anthropic', 'Anthropic Messages'],
    ['openai_responses', 'OpenAI Responses'],
  ];
  // ── 模板（provider templates）────────────────────────────────────────────
  // 模板只预填表单（CLI / 协议 / Base URL / 模型 / 档位别名），永远不含 key。
  // 本地内置一份保证第一次打开就有内容；GitHub 上的
  // public/provider-presets.json 是同一份目录的独立可更新版本，拉下来按 id
  // 覆盖同名模板、追加新模板，本地独有的保留。远端目录是不可信输入，字段
  // 白名单化在 provider-catalog.js 的 normalizePresetCatalog 里做。
  const PRESET_CACHE_KEY = 'multicc.providerPresets.v1';
  const PRESET_REMOTE_URLS = Object.freeze([
    'https://raw.githubusercontent.com/lsjwzh/MultiCC/main/public/provider-presets.json',
    'https://cdn.jsdelivr.net/gh/lsjwzh/MultiCC@main/public/provider-presets.json',
  ]);
  const PRESET_REFRESH_MS = 24 * 60 * 60 * 1000;
  const PRESET_FETCH_TIMEOUT_MS = 6000;
  // 与 public/provider-presets.json 同步（同 version、同条目；test-provider-catalog 校验）。
  const BUNDLED_PRESET_VERSION = '2026-10-27';
  const LOCAL_PRESETS = [
    { id: 'claude-api', appType: 'claude', name: t('airProviderPresetClaudeApi'), nameKey: 'airProviderPresetClaudeApi', baseUrl: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic' },
    { id: 'claude-glm', appType: 'claude', name: t('airProviderPresetGlm'), nameKey: 'airProviderPresetGlm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', models: ['glm-5.3', 'glm-5.2'], apiFormat: 'anthropic', aliasMap: { fable: { model: 'glm-5.3', name: 'GLM5.3' } } },
    { id: 'claude-deepseek', appType: 'claude', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro', 'deepseek-flash'], apiFormat: 'anthropic' },
    { id: 'claude-kimi', appType: 'claude', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3.1-pro', models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code'], apiFormat: 'anthropic' },
    { id: 'claude-minimax', appType: 'claude', name: 'MiniMax', baseUrl: 'https://api.minimax.cn/anthropic', model: 'MiniMax-M3', models: ['MiniMax-M3', 'MiniMax-M3.1-Flash'], apiFormat: 'anthropic' },
    { id: 'claude-qwen', appType: 'claude', name: t('airProviderPresetQwen'), nameKey: 'airProviderPresetQwen', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3.7-plus', models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash'], apiFormat: 'anthropic' },
    { id: 'claude-openrouter', appType: 'claude', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-5.5', models: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5'], apiFormat: 'anthropic' },
    { id: 'codex-deepseek', appType: 'codex', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro', 'deepseek-flash'], apiFormat: 'openai_responses' },
    { id: 'codex-glm', appType: 'codex', name: t('airProviderPresetGlm'), nameKey: 'airProviderPresetGlm', baseUrl: 'https://open.bigmodel.cn/api/v1', model: 'glm-5.3', models: ['glm-5.3', 'glm-5.2'], apiFormat: 'openai_responses' },
    { id: 'codex-kimi', appType: 'codex', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro', models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code'], apiFormat: 'openai_responses' },
    { id: 'codex-qwen', appType: 'codex', name: t('airProviderPresetQwen'), nameKey: 'airProviderPresetQwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus', models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash'], apiFormat: 'openai_responses' },
    { id: 'codex-xf-maas', appType: 'codex', name: t('airProviderPresetXfMaas'), nameKey: 'airProviderPresetXfMaas', baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1', model: 'xopglm52', apiFormat: 'openai_responses' },
  ];
  const localPresetCatalog = presetCatalogOf({ version: BUNDLED_PRESET_VERSION, presets: LOCAL_PRESETS });
  let presetCatalog = localPresetCatalog;
  let presetSource = 'local';
  let presetSyncedAt = 0;
  let presetStatusNote = '';
  let presetRefreshInFlight = null;
  let presetLastAttemptAt = 0;
  let context = null;
  let data = null;
  let activeProtocol = 'all';
  // 官方账号的「专用出口」来自这个插件里的身份（每个身份一套隔离的代理出口）。
  const EGRESS_PLUGIN_ID = 'chrome-proxy-launcher';
  // 每次打开编辑框都自增：异步拉回来的身份清单只能填进「当前这一次」打开的框，
  // 否则快速连点两条线路时会拿 A 的清单覆盖 B 的下拉。
  let egressLoadToken = 0;
  const requestedConnection = (() => {
    try {
      const value = new URLSearchParams(root.location?.search || '').get('providerConnection') || '';
      return ['device', 'native'].includes(value) ? value : '';
    } catch (_) { return ''; }
  })();
  let advancedOpen = !!requestedConnection;
  const latency = new Map();
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, handler, className = '') => {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  };
  const protocolName = value => ({ anthropic: 'Anthropic Messages', openai_responses: 'OpenAI Responses' }[value] || value);
  // CLI 展示名走共享 CLI 目录（权威表：服务端 src/cli/cli-capability.js）。这里原本
  // 只列了 claude/codex/opencode/zcode 四个，其余 CLI（含 kimi、claude-exp）在线路上
  // 只能显示内部 id。
  const cliName = value => (catalogApi && catalogApi.cliDisplayName ? catalogApi.cliDisplayName(value) : value);

  function presetCatalogOf(value) {
    if (catalogApi && typeof catalogApi.normalizePresetCatalog === 'function') {
      return catalogApi.normalizePresetCatalog(value);
    }
    return value && Array.isArray(value.presets) ? value : null;
  }

  function presetList() {
    return presetCatalog && Array.isArray(presetCatalog.presets) ? presetCatalog.presets : [];
  }

  function presetById(id) {
    return presetList().find(preset => preset.id === id) || null;
  }

  function presetLabel(preset) {
    if (!preset) return '';
    if (preset.nameKey && typeof root.t === 'function') {
      const localized = root.t(preset.nameKey);
      if (localized && localized !== preset.nameKey) return localized;
    }
    return preset.name || preset.id;
  }

  // 下拉每次从目录重建：远端模板可能新增/改写了条目，硬编码的 option 列表
  // 只会在下一次发版前一直显示旧名字。当前选中项如果还在就保留。
  function renderPresetOptions() {
    const form = el('air-provider-form');
    const select = form && form.elements.preset;
    if (!select) return;
    const current = select.value;
    const custom = make('option', t('airProviderPresetCustom'));
    custom.value = '';
    const groups = new Map();
    for (const preset of presetList()) {
      if (!groups.has(preset.appType)) groups.set(preset.appType, []);
      groups.get(preset.appType).push(preset);
    }
    const options = [custom];
    for (const appType of ['claude', 'codex']) {
      const list = groups.get(appType) || [];
      if (!list.length) continue;
      const group = document.createElement('optgroup');
      group.label = t(appType === 'claude' ? 'airProviderPresetGroupClaude' : 'airProviderPresetGroupCodex');
      for (const preset of list) {
        const option = make('option', presetLabel(preset));
        option.value = preset.id;
        group.append(option);
      }
      options.push(group);
    }
    select.replaceChildren(...options);
    select.value = presetById(current) ? current : '';
  }

  function renderPresetStatus() {
    const node = el('air-provider-preset-status');
    if (!node) return;
    const base = presetSource === 'github'
      ? t('airProviderPresetSourceGithub', { time: new Date(presetSyncedAt).toLocaleString() })
      : t('airProviderPresetSourceLocal', { count: presetList().length });
    node.textContent = presetStatusNote ? `${base} · ${presetStatusNote}` : base;
  }

  function readPresetCache() {
    try {
      const raw = root.localStorage ? root.localStorage.getItem(PRESET_CACHE_KEY) : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const catalog = presetCatalogOf(parsed && parsed.catalog);
      if (!catalog) return null;
      return { catalog, fetchedAt: Number(parsed.fetchedAt) || 0 };
    } catch (_) { return null; }
  }

  function writePresetCache(catalog, fetchedAt) {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(PRESET_CACHE_KEY, JSON.stringify({ fetchedAt, catalog }));
      }
    } catch (_) { /* the cache is best-effort; the dialog still works without it */ }
  }

  function applyRemoteCatalog(catalog, fetchedAt) {
    const merged = catalogApi && typeof catalogApi.mergePresetCatalogs === 'function'
      ? catalogApi.mergePresetCatalogs(localPresetCatalog, catalog)
      : catalog;
    presetCatalog = merged || catalog || localPresetCatalog;
    presetSource = 'github';
    presetSyncedAt = fetchedAt;
    presetStatusNote = '';
    renderPresetOptions();
    renderPresetStatus();
  }

  function refreshPresets(manual) {
    if (presetRefreshInFlight) return presetRefreshInFlight;
    const fetchFn = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    if (!fetchFn) return Promise.resolve(false);
    const button = el('air-provider-preset-refresh');
    if (button) button.disabled = true;
    if (manual) {
      presetStatusNote = '';
      const node = el('air-provider-preset-status');
      if (node) node.textContent = t('airProviderPresetRefreshing');
    }
    presetRefreshInFlight = (async () => {
      for (const url of PRESET_REMOTE_URLS) {
        const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
        const timer = controller ? root.setTimeout(() => controller.abort(), PRESET_FETCH_TIMEOUT_MS) : null;
        try {
          const response = await fetchFn(`${url}?ts=${Date.now()}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            ...(controller ? { signal: controller.signal } : {}),
          });
          if (!response || !response.ok) continue;
          const catalog = presetCatalogOf(await response.json());
          if (!catalog) continue;
          const fetchedAt = Date.now();
          writePresetCache(catalog, fetchedAt);
          applyRemoteCatalog(catalog, fetchedAt);
          if (manual && context && typeof context.notice === 'function') {
            context.notice(t('airProviderPresetRefreshDone', { count: presetList().length }));
          }
          return true;
        } catch (_) { /* mirror unreachable: try the next one */ }
        finally { if (timer) root.clearTimeout(timer); }
      }
      presetStatusNote = t('airProviderPresetRefreshFailed');
      renderPresetStatus();
      return false;
    })().finally(() => {
      presetRefreshInFlight = null;
      const node = el('air-provider-preset-refresh');
      if (node) node.disabled = false;
    });
    return presetRefreshInFlight;
  }

  // 「自己连 GitHub 更新」：打开对话框时如果本地缓存已超过一天就静默拉一次。
  // 失败不影响任何操作 —— 继续用上一次成功拉到的目录，或内置的那份。
  function maybeRefreshPresets() {
    const now = Date.now();
    const cached = readPresetCache();
    if (cached && now - cached.fetchedAt < PRESET_REFRESH_MS) return;
    // Offline / blocked mirror: don't retry on every dialog open.
    if (now - presetLastAttemptAt < 60 * 60 * 1000) return;
    presetLastAttemptAt = now;
    void refreshPresets(false);
  }

  const cachedPresets = readPresetCache();
  if (cachedPresets) applyRemoteCatalog(cachedPresets.catalog, cachedPresets.fetchedAt);

  function ensureDialog() {
    if (el('air-provider-dialog')) return el('air-provider-dialog');
    const dialog = make('dialog', null, 'provider-dialog service-dialog');
    dialog.id = 'air-provider-dialog';
    dialog.innerHTML = `
      <form id="air-provider-form">
        <div class="section-heading"><div><span class="eyebrow">${t('airAdminPanelProvider')}</span><h2 id="air-provider-form-title">${t('airProviderFormTitleNew')}</h2></div><button type="button" id="air-provider-close" aria-label="${t('airProviderClose')}">×</button></div>
        <p>${t('airProviderFormIntro')}</p>
        <div id="air-provider-create-choice" class="air-provider-create-choice">
          <section><strong>${t('airProviderAddByKey')}</strong><span>${t('airProviderAddByKeyDesc')}</span><div><button type="button" data-provider-key="claude">Claude · Anthropic</button><button type="button" data-provider-key="codex">Codex · OpenAI</button></div></section>
          <section><strong>${t('airProviderAddAccount')}</strong><span>${t('airProviderAddAccountDesc')}</span><div><button type="button" data-provider-account="claude">Claude</button><button type="button" data-provider-account="codex">Codex</button></div></section>
        </div>
        <div id="air-provider-api-fields">
        <p id="air-provider-official-hint" class="air-migration-note" hidden>${t('airProviderOfficialLockedHint')}</p>
        <input type="hidden" name="providerId">
        <label>${t('airProviderPresetLabel')}<select name="preset"><option value="">${t('airProviderPresetCustom')}</option></select></label>
        <div id="air-provider-preset-sync" class="air-provider-preset-sync">
          <span id="air-provider-preset-status"></span>
          <button type="button" id="air-provider-preset-refresh">${t('airProviderPresetRefresh')}</button>
        </div>
        <div class="form-row"><label>CLI<select name="appType"><option value="claude">Claude</option><option value="codex">Codex</option></select></label><label>${t('airProviderUpstreamProtocol')}<select name="apiFormat" disabled><option value="anthropic">Anthropic Messages</option><option value="openai_responses">OpenAI Responses</option></select></label></div>
        <p id="air-provider-protocol-hint" class="air-provider-protocol-hint"></p>
        <label>${t('airProviderName')}<input name="name" required maxlength="240" placeholder="${t('airProviderNamePlaceholder')}"></label>
        <label>Base URL<input name="baseUrl" maxlength="2048" placeholder="${t('airProviderBaseUrlPlaceholder')}"></label>
        <label>API Key<input name="authToken" type="password" maxlength="4096" autocomplete="off" placeholder="${t('airProviderTokenPlaceholder')}"></label>
        <label>${t('airProviderDefaultModel')}<input name="model" maxlength="240" placeholder="${t('airProviderModelPlaceholder')}"></label>
        <label>${t('airProviderOptionalModels')}<textarea name="models" rows="3" placeholder="${t('airProviderModelsPlaceholder')}"></textarea></label>
        <details id="air-provider-aliases"><summary>${t('airProviderAliasSummary')}</summary><div class="provider-alias-grid"><span>${t('airProviderTierColumn')}</span><span>${t('airProviderDisplayNameColumn')}</span><span>${t('airProviderRealModelColumn')}</span></div></details>
        <details id="air-provider-egress-ip"><summary>${t('airProviderEgressIpSummary')}</summary><p>${t('airProviderEgressIpBody')}</p><textarea name="egressIpAllowlist" rows="3" placeholder="${t('airProviderEgressIpPlaceholder')}"></textarea></details>
        <details id="air-provider-egress-binding"><summary>${t('airProviderEgressBindingSummary')}</summary><p>${t('airProviderEgressBindingBody')}</p><p id="air-provider-egress-binding-hint" class="air-migration-note" hidden></p><label>${t('airProviderEgressBindingLabel')}<select name="egressBinding"><option value="">${t('airProviderEgressBindingOff')}</option></select></label></details>
        <p id="air-provider-form-error" role="alert"></p>
        <div class="schedule-form-actions"><button type="button" id="air-provider-cancel">${t('airProviderCancel')}</button><button type="submit" id="air-provider-save" class="primary">${t('airProviderCreate')}</button></div>
        </div>
      </form>`;
    const aliases = dialog.querySelector('#air-provider-aliases');
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
      const row = make('div', null, 'provider-alias-grid provider-alias-row');
      row.append(make('strong', tier[0].toUpperCase() + tier.slice(1)));
      const name = make('input'); name.name = `alias-${tier}-name`; name.placeholder = t('airProviderAliasNamePlaceholder');
      const model = make('input'); model.name = `alias-${tier}-model`; model.placeholder = t('airProviderAliasModelPlaceholder');
      row.append(name, model); aliases.append(row);
    }
    document.body.append(dialog);
    const form = el('air-provider-form');
    el('air-provider-close').onclick = () => dialog.close();
    el('air-provider-cancel').onclick = () => dialog.close();
    form.elements.preset.onchange = () => applyPreset(form.elements.preset.value);
    form.elements.appType.onchange = changeDialogAppType;
    renderPresetOptions();
    renderPresetStatus();
    el('air-provider-preset-refresh').onclick = () => { void refreshPresets(true); };
    form.onsubmit = saveEditor;
    dialog.querySelectorAll('[data-provider-key]').forEach(control => {
      control.onclick = () => {
        form.elements.appType.value = control.dataset.providerKey;
        el('air-provider-create-choice').hidden = true;
        el('air-provider-api-fields').hidden = false;
        syncDialogProtocol();
        form.elements.preset.focus();
      };
    });
    dialog.querySelectorAll('[data-provider-account]').forEach(control => {
      control.onclick = () => {
        dialog.close();
        root.MultiCCOfficialAccounts?.add(control.dataset.providerAccount);
      };
    });
    return dialog;
  }

  // 协议不是独立选项：claude 线路存 ANTHROPIC_* env、codex 线路存 wire_api=responses
  // 的 config.toml，服务端（core.js apiFormatForAppType）按线路池定死协议并拒收
  // 矛盾组合。这里只把结果显示出来，下拉永远只读。
  function protocolForAppType(appType) {
    return appType === 'claude' ? 'anthropic' : 'openai_responses';
  }

  function syncDialogProtocol() {
    const form = el('air-provider-form');
    if (!form) return;
    const claude = form.elements.appType.value === 'claude';
    form.elements.apiFormat.value = protocolForAppType(form.elements.appType.value);
    form.elements.apiFormat.disabled = true;
    el('air-provider-protocol-hint').textContent = t(claude ? 'airProviderProtocolHintClaude' : 'airProviderProtocolHintCodex');
    el('air-provider-aliases').hidden = !claude;
  }

  // 同一厂商两种协议的模板按 id 约定成对：`claude-<vendor>` / `codex-<vendor>`。
  function siblingPreset(preset, appType) {
    const vendor = String(preset && preset.id || '').replace(/^(claude|codex)-/, '');
    return vendor ? presetById(`${appType}-${vendor}`) : null;
  }

  // 套了模板后再切 CLI：模板里的 Base URL / 模型是另一种协议的，留着就会把
  // Anthropic 地址存进 Codex 线路。有同厂商另一协议的模板就整套换过去（已填的
  // API Key 保留），没有就清掉模板带进来的字段，回到自定义。
  function changeDialogAppType() {
    const form = el('air-provider-form');
    if (!form) return;
    const appType = form.elements.appType.value;
    const current = presetById(form.elements.preset.value);
    if (current && current.appType !== appType) {
      const sibling = siblingPreset(current, appType);
      if (sibling) {
        form.elements.preset.value = sibling.id;
        applyPreset(sibling.id);
        return;
      }
      form.elements.preset.value = '';
      if (form.elements.baseUrl.value.trim() === (current.baseUrl || '')) form.elements.baseUrl.value = '';
      if (form.elements.model.value.trim() === (current.model || '')) form.elements.model.value = '';
      form.elements.models.value = '';
      fillAliases(form, null);
    }
    syncDialogProtocol();
  }

  function applyPreset(key) {
    const preset = presetById(key);
    const form = el('air-provider-form');
    if (!preset || !form) return;
    form.elements.appType.value = preset.appType;
    form.elements.name.value = presetLabel(preset);
    form.elements.baseUrl.value = preset.baseUrl || '';
    form.elements.model.value = preset.model || '';
    form.elements.apiFormat.value = protocolForAppType(preset.appType);
    form.elements.models.value = (preset.models && preset.models.length ? preset.models : [preset.model])
      .filter(Boolean).join('\n');
    fillAliases(form, preset.aliasMap || null);
    syncDialogProtocol();
    form.elements.authToken.focus();
  }

  function aliasMapFrom(form) {
    const aliases = {};
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
      const model = form.elements[`alias-${tier}-model`].value.trim();
      const name = form.elements[`alias-${tier}-name`].value.trim();
      if (model) aliases[tier] = { model, name };
    }
    return aliases;
  }

  function fillAliases(form, values) {
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
      form.elements[`alias-${tier}-model`].value = values?.[tier]?.model || '';
      form.elements[`alias-${tier}-name`].value = values?.[tier]?.name || '';
    }
  }

  // 「专用出口」下拉：插件里的身份清单是活的（用户可能刚在插件页面里改名、
  // 删除），所以每次打开编辑框都重新拉一次。插件不在 / 二进制缺失 / 还没有
  // 身份，都停在说明文案上；已保存但插件里已经删掉的身份保留成一个占位项，
  // 保存时不会因为「下拉里没有它」被静默清掉。
  async function fillEgressBinding(binding) {
    const form = el('air-provider-form');
    const select = form && form.elements.egressBinding;
    const hint = el('air-provider-egress-binding-hint');
    if (!select || !hint) return;
    const token = ++egressLoadToken;
    const saved = binding && binding.profileId;
    // 只有真正读到了身份清单才算「可写」：插件缺失/二进制不可用时保存不提交
    // egressBinding（PATCH 里缺省=不动），免得出一次故障就把绑定清掉。
    form.dataset.egressBindingState = 'unavailable';
    const off = make('option', t('airProviderEgressBindingOff'));
    off.value = '';
    select.replaceChildren(off);
    select.value = '';
    select.disabled = true;
    hint.hidden = false;
    hint.textContent = t('airProviderEgressBindingLoading');
    let entry = null;
    try {
      const payload = await context.api('/api/plugins');
      entry = (payload.plugins || []).find(item => item && item.id === EGRESS_PLUGIN_ID) || null;
    } catch (error) {
      if (token !== egressLoadToken) return;
      hint.textContent = t('airProviderEgressBindingLoadFailed', { message: error.message });
      return;
    }
    if (token !== egressLoadToken) return;
    if (!entry) {
      hint.textContent = t('airProviderEgressBindingNoPlugin');
      return;
    }
    if (!entry.engine || !entry.engine.available) {
      hint.textContent = (entry.engine && entry.engine.reason) || t('airProviderEgressBindingNoPlugin');
      return;
    }
    let profiles = [];
    try {
      const listed = await context.api(`/api/plugins/${EGRESS_PLUGIN_ID}/run`, { command: 'list', input: {} });
      profiles = Array.isArray(listed && listed.profiles) ? listed.profiles : [];
    } catch (error) {
      if (token !== egressLoadToken) return;
      hint.textContent = t('airProviderEgressBindingLoadFailed', { message: error.message });
      return;
    }
    if (token !== egressLoadToken) return;
    const seen = new Set();
    const options = [off];
    for (const profile of profiles) {
      if (!profile || typeof profile.id !== 'string' || !profile.id) continue;
      seen.add(profile.id);
      const option = make('option', `${profile.name || profile.id}${profile.egressText ? ` · ${profile.egressText}` : ''}`);
      option.value = profile.id;
      options.push(option);
    }
    // 已绑定但插件里找不到：保留占位项并标出来，别把配置悄悄改掉。
    if (saved && !seen.has(saved)) {
      const missing = make('option', t('airProviderEgressBindingSaved', { id: saved }));
      missing.value = saved;
      options.push(missing);
    }
    select.replaceChildren(...options);
    select.value = saved || '';
    // 清单读到了就算「可写」—— 没有身份也允许把已有绑定清成「不使用」。
    form.dataset.egressBindingState = 'ready';
    select.disabled = !profiles.length && !saved;
    hint.hidden = !!profiles.length;
    hint.textContent = profiles.length ? '' : t('airProviderEgressBindingNoProfiles');
  }

  function openEditor(provider = null) {
    const dialog = ensureDialog();
    const form = el('air-provider-form');
    form.reset();
    el('air-provider-create-choice').hidden = !!provider;
    el('air-provider-api-fields').hidden = !provider;
    const locked = !!provider?.isOfficial;
    form.elements.providerId.value = provider?.id || '';
    form.elements.appType.value = provider?.appType || 'claude';
    form.elements.appType.disabled = !!provider;
    form.elements.apiFormat.value = protocolForAppType(form.elements.appType.value);
    form.elements.name.value = provider?.name || '';
    form.elements.baseUrl.value = provider?.baseUrl || '';
    form.elements.model.value = provider?.model || '';
    form.elements.models.value = (provider?.modelOptions || []).join('\n');
    form.elements.authToken.placeholder = provider?.hasToken ? t('airProviderTokenKeep', { mask: provider.tokenMask || t('airProviderSet') }) : t('airProviderTokenUnset');
    fillAliases(form, provider?.aliasMap);
    const egressIpAllowlist = provider?.egressIpAllowlist || [];
    form.elements.egressIpAllowlist.value = egressIpAllowlist.join('\n');
    el('air-provider-egress-ip').open = egressIpAllowlist.length > 0;
    // 专用出口只对官方账号线路开放（别的线路自己就指明了上游）。
    const binding = locked && provider?.egressBinding ? provider.egressBinding : null;
    el('air-provider-egress-binding').hidden = !locked;
    el('air-provider-egress-binding').open = !!(binding && binding.profileId);
    if (locked) void fillEgressBinding(binding);
    else form.dataset.egressBindingState = '';
    syncDialogProtocol();
    // Official providers are OAuth-managed: identity/credential fields are read-only
    // here (login/account switching lives in the dedicated official-account flow),
    // leaving only the advanced settings below (egress-IP allowlist) editable.
    form.dataset.official = locked ? '1' : '';
    form.elements.preset.disabled = locked;
    form.elements.name.disabled = locked;
    form.elements.baseUrl.disabled = locked;
    form.elements.authToken.disabled = locked;
    form.elements.model.disabled = locked;
    form.elements.models.disabled = locked;
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
      form.elements[`alias-${tier}-model`].disabled = locked;
      form.elements[`alias-${tier}-name`].disabled = locked;
    }
    el('air-provider-official-hint').hidden = !locked;
    el('air-provider-form-title').textContent = provider ? t('airProviderEditTitle', { name: displayName(provider) }) : t('airProviderFormTitleNew');
    el('air-provider-save').textContent = provider ? t('airProviderSave') : t('airProviderCreate');
    el('air-provider-form-error').textContent = '';
    // 模板只用于新建线路；编辑已有 Provider 时不打扰远端。
    if (!provider) maybeRefreshPresets();
    dialog.showModal();
  }

  async function saveEditor(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const save = el('air-provider-save');
    const error = el('air-provider-form-error');
    const providerId = form.elements.providerId.value;
    const appType = form.elements.appType.value;
    const egressIpAllowlist = form.elements.egressIpAllowlist.value
      .split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    let body;
    if (form.dataset.official === '1') {
      // OAuth-managed identity: only the advanced settings below are ours to write.
      body = { egressIpAllowlist };
      // 身份清单没读到（插件缺失/二进制不可用）就别提交绑定字段：PATCH 里缺省
      // 表示「不动」，提交一个空值反而会把已有绑定清掉。
      if (form.dataset.egressBindingState === 'ready') {
        const profileId = form.elements.egressBinding.value.trim();
        body.egressBinding = profileId ? { pluginId: EGRESS_PLUGIN_ID, profileId } : null;
      }
    } else {
      const model = form.elements.model.value.trim();
      body = {
        name: form.elements.name.value.trim(),
        baseUrl: form.elements.baseUrl.value.trim(),
        model,
        models: catalogApi.normalizeModelOptions(form.elements.models.value, model),
        apiFormat: protocolForAppType(appType),
        egressIpAllowlist,
      };
      const token = form.elements.authToken.value.trim();
      if (!providerId || token) body.authToken = token;
      if (appType === 'claude') body.aliasMap = aliasMapFrom(form);
      if (!providerId) body.appType = appType;
    }
    save.disabled = true; error.textContent = '';
    try {
      const path = providerId ? `/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(providerId)}` : '/api/providers';
      await context.api(path, body, providerId ? 'PATCH' : 'POST');
      el('air-provider-dialog').close();
      context.notice(providerId ? t('airProviderUpdated') : t('airProviderCreated'));
      await load();
    } catch (reason) { error.textContent = reason.message; }
    finally { save.disabled = false; }
  }

  function providerStat(provider) {
    const stat = (data?.stats || []).find(item => item.providerId === provider.id);
    if (!stat) return t('airProviderNoUsage');
    return t('airProviderUsageStat', {
      tokens: catalogApi.formatCompactTokens(stat.totalTokens),
      turns: stat.turnCount,
      sessions: stat.sessionCount,
    });
  }

  function renderProviderCard(provider) {
    const terminal = provider.id === `${provider.appType}-official` && !provider.officialAccountId;
    const account = !!provider.officialAccountId;
    const card = make('article', null, 'air-provider-card');
    card.dataset.providerId = provider.id;
    const head = make('div', null, 'air-provider-card-head');
    const title = make('div');
    title.append(make('span', provider.appType === 'claude' ? 'C' : 'O', `provider-cli-mark ${provider.appType}`));
    const copy = make('span'); copy.append(make('strong', displayName(provider)), make('small', `${cliName(provider.appType)} · ${protocolName(provider.apiFormat)}`));
    title.append(copy);
    const tags = make('div', null, 'air-provider-tags');
    if (data.defaults[provider.appType] === provider.id) tags.append(make('span', t('airProviderGlobalDefault'), 'default'));
    if (terminal) tags.append(make('span', t('airProviderTerminalTag')));
    else if (account) tags.append(make('span', t('airProviderAccountTag')));
    if (provider.hasToken) tags.append(make('span', t('airProviderKeyConfigured')));
    // 专用出口：卡片上标出来，免得要逐个点开编辑框才知道这个账号从哪个 IP 出去。
    if (provider.egressBinding && provider.egressBinding.profileId) {
      const tag = make('span', t('airProviderEgressBindingTag'));
      tag.title = provider.egressBinding.profileId;
      tags.append(tag);
    }
    head.append(title, tags);
    const endpoint = make('p', provider.baseUrl || (terminal
      ? t('airProviderTerminalRoute', { cli: cliName(provider.appType) })
      : t('airProviderAccountRoute')), 'air-provider-endpoint');
    const facts = make('div', null, 'air-provider-facts');
    facts.append(
      fact(t('airProviderDefaultModel'), provider.model || t('airProviderModelFollowCatalog')),
      fact(t('airProviderOptionalModels'), provider.modelOptions.length ? t('airProviderModelCount', { count: provider.modelOptions.length }) : t('airProviderDynamicDiscovery')),
      fact(t('airProviderAvailableCli'), provider.compatibleClis.map(cliName).join(' / ') || cliName(provider.appType)),
      fact(t('airProviderTotalUsage'), providerStat(provider)),
    );
    card.append(head, endpoint, facts);
    const limitView = resolveLimit(provider);
    if (limitView?.text) {
      const limit = make('p', limitView.text, 'air-provider-limit');
      limit.title = limitView.title;
      limit.style.color = limitView.color;
      card.append(limit);
    }
    const actions = make('div', null, 'air-provider-card-actions');
    if (account || terminal) {
      const subscription = make('div', null, 'air-provider-subscription');
      card.append(subscription);
      root.MultiCCProviderSubscription?.mount(subscription, { vendor: provider.appType,
        accountId: provider.officialAccountId, subscription: provider.subscription, api: path => context.api(path) });
    }
    const speed = button(latency.has(provider.id) ? latency.get(provider.id) : t('airProviderSpeedTest'), () => speedTest(provider, speed));
    actions.append(speed);
    // 批量迁移：把「主线路绑在这条线路上的所有会话」一次搬到另一条兼容线路上。
    // 每个会话走的仍是 AI 配置弹窗那条 PATCH（src/provider-reassign.js），所以
    // 模型替换 / Auto 会话跳过 / 忙会话下一轮生效这些口径都一致。
    actions.append(button(t('airProviderReassignAction'), () => openReassign(provider)));
    // 官方线路也要有「编辑」：登录身份由 OAuth 管，对话框对它们只放开「限定出口 IP」
    // （openEditor 的 locked 分支，服务端 updateProvider 的官方分支同样只收这一项）。
    // 去掉它，官方线路就再也够不到出口 IP 白名单 —— 而官方账号恰恰是最需要它的。
    actions.append(button(t('airProviderEdit'), () => openEditor(provider)));
    // 终端登录的内置官方线路（无账号库条目）同样要能重登：401 时最常见的就是这一条，
    // 用 'global' 走 /api/<vendor>/oauth/login，开出终端会话完成 CLI 登录。
    if (account || terminal) actions.append(button(t('airProviderRelogin'), () => root.MultiCCOfficialAccounts?.relogin(provider.appType, account ? provider.officialAccountId : 'global')));
    // 生成一份带独立令牌的借道分享码（manage-provider-relay.js，弹层自带样式）。
    // 官方 Provider 同样可借道：出借方在本机用官方登录 / OAuth 凭证代发请求，
    // 接收方只拿到分享码里的 provider 范围凭据，永远看不到上游 key 或 OAuth token
    // （服务端 relay-share 与代理链路都支持，见 docs/configuration.md 的
    // Remote provider relay）。删除仍是官方入口的禁区（内置线路不可删）。
    actions.append(button(t('airProviderRelayShare'), () => {
      root.MultiCCAirProviderAdvanced?.prepare(context);
      root.shareRelayProvider?.(provider.appType, provider.id);
    }));
    // 通过分享码导入的线路：把原始导入信息再复制出来，转给别人时不必回到出借方重新生成。
    if (root.isRelayImportProvider?.(provider)) {
      actions.append(button(t('airProviderRelayCopyImport'), () => root.copyRelayImportInfo?.(provider.appType, provider.id)));
    }
    if (!terminal) {
      actions.append(button(t('airProviderDelete'), () => removeProvider(provider), 'danger'));
    }
    card.append(actions);
    return card;
  }

  function fact(label, value) {
    const node = make('span');
    node.append(make('small', label), make('strong', value));
    return node;
  }

  function renderDefaults() {
    const panel = el('air-provider-defaults');
    if (!panel || !data) return;
    panel.replaceChildren();
    for (const cli of ['claude', 'codex']) {
      const label = make('label');
      label.append(make('span', t('airProviderDefaultRoute', { cli: cliName(cli) })));
      const select = make('select'); select.dataset.cli = cli;
      for (const provider of data.providers.filter(item => item.appType === cli)) {
        const option = make('option', `${displayName(provider)} · ${protocolName(provider.apiFormat)}${provider.model ? ` · ${provider.model}` : ''}`);
        option.value = provider.id; select.append(option);
      }
      select.value = data.defaults[cli] || `${cli}-official`;
      label.append(select); panel.append(label);
    }
    panel.append(button(t('airProviderSaveDefaults'), saveDefaults, 'primary'));
  }

  function renderCards() {
    const grid = el('air-provider-cards');
    if (!grid || !data) return;
    const rows = activeProtocol === 'all' ? data.providers : data.providers.filter(item => item.apiFormat === activeProtocol);
    grid.replaceChildren(...rows.map(renderProviderCard));
    if (!rows.length) grid.append(make('p', t('airProviderEmptyProtocol'), 'admin-empty'));
    el('air-provider-count').textContent = t('airProviderCount', {
      routes: data.providers.length,
      credentials: data.providers.filter(item => item.hasToken || item.isOfficial).length,
    });
  }

  function setProtocol(value) {
    activeProtocol = value;
    document.querySelectorAll('.air-provider-tab').forEach(item => item.classList.toggle('active', item.dataset.protocol === value));
    renderCards();
  }

  async function saveDefaults() {
    const body = {};
    document.querySelectorAll('#air-provider-defaults select').forEach(select => { body[select.dataset.cli] = select.value; });
    try {
      const result = await context.api('/api/provider-defaults', body, 'PUT');
      data = Object.freeze({ ...data, defaults: catalogApi.normalizeDefaults(result.defaults) });
      context.notice(t('airProviderDefaultsSaved'));
      renderDefaults(); renderCards();
    } catch (error) { context.notice(error.message); }
  }

  async function speedTest(provider, control) {
    control.disabled = true; control.textContent = t('airProviderSpeedTesting');
    try {
      const result = await context.api(`/api/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}/speedtest`, {}, 'POST');
      latency.set(provider.id, result.ok ? `${result.ms} ms` : `${t('airProviderFailed')}${result.status ? ` ${result.status}` : ''}`);
    } catch (error) { latency.set(provider.id, `${t('airProviderFailed')}${error.status ? ` ${error.status}` : ''}`); }
    renderCards();
  }

  const refKinds = ['main', 'auto_candidate', 'subagent', 'default', 'aux', 'session'];
  const refKey = kind => kind.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());

  // 409 PROVIDER_IN_USE / PROVIDER_DETACH_FAILED 的引用清单：按类型分组，每组写明
  // 强制删除时会怎么解除（服务端 src/providers/force-detach.js 的口径）。
  function showReferences(provider, refs, failed) {
    const dialog = make('dialog', null, 'provider-dialog service-dialog air-provider-refs-dialog');
    const form = make('form'); form.method = 'dialog';
    const head = make('div', null, 'section-heading');
    const title = make('div');
    title.append(make('span', t('airAdminPanelProvider'), 'eyebrow'), make('h2', t('airProviderInUseTitle', { name: displayName(provider), count: refs.count })));
    head.append(title, button('×', () => dialog.close()));
    form.append(head, make('p', failed ? t('airProviderInUseDetachFailed') : t('airProviderInUseBody')));
    for (const kind of refKinds) {
      const items = refs.items.filter(item => item.kind === kind);
      if (!items.length) continue;
      const group = make('section', null, 'air-provider-ref-group');
      const groupHead = make('header');
      groupHead.append(make('strong', `${t(`airProviderRefKind${refKey(kind)}`)} · ${items.length}`));
      if (!failed && kind !== 'session') groupHead.append(make('small', t(`airProviderRefEffect${refKey(kind)}`)));
      const list = make('ul');
      for (const item of items) {
        const row = make('li');
        row.append(make('span', item.title));
        if (item.error || (item.detail && item.detail !== item.title)) row.append(make('code', item.error || item.detail));
        list.append(row);
      }
      group.append(groupHead, list); form.append(group);
    }
    const sessionRefs = refs.items.some(item => item.detail);
    if (!failed && refs.forceable && sessionRefs) form.append(make('p', t('airProviderInUseRunningWarn'), 'air-provider-ref-warn'));
    const actions = make('div', null, 'schedule-form-actions');
    actions.append(button(t('airProviderInUseCancel'), () => dialog.close()));
    if (!failed && refs.forceable) {
      actions.append(button(t('airProviderForceDelete'), async (event) => {
        event.currentTarget.disabled = true;
        dialog.close();
        await deleteProvider(provider, true);
      }, 'danger'));
    }
    form.append(actions); dialog.append(form);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog); dialog.showModal();
  }

  async function deleteProvider(provider, force) {
    const path = `/api/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}${force ? '?force=1' : ''}`;
    try {
      const result = await context.api(path, undefined, 'DELETE');
      const detached = Array.isArray(result.detached) ? result.detached : [];
      const deferred = detached.filter(item => item && item.deferred).length;
      context.notice(result.forced
        ? `${t('airProviderForceDeleted', { name: displayName(provider), count: detached.length })}${deferred ? t('airProviderForceDeletedDeferred', { count: deferred }) : ''}`
        : t('airProviderDeleted', { name: displayName(provider) }));
      await load();
    } catch (error) {
      const refs = catalogApi.deleteReferenceDisplayData(error);
      if (refs.count && (error.code === 'PROVIDER_IN_USE' || error.code === 'PROVIDER_DETACH_FAILED')) {
        context.notice('');
        showReferences(provider, refs, error.code === 'PROVIDER_DETACH_FAILED');
        if (error.code === 'PROVIDER_DETACH_FAILED') await load();
        return;
      }
      context.notice(`${error.message}${refs.count ? t('airProviderStillReferenced', { items: refs.items.map(item => item.title).join(t('airProviderListSeparator')) }) : ''}`);
    }
  }

  async function removeProvider(provider) {
    if (!confirm(t('airProviderDeleteConfirm', { name: displayName(provider) }))) return;
    await deleteProvider(provider, false);
  }

  // ── 批量迁移会话 ───────────────────────────────────────────────────────────
  //
  // 把「主线路绑在这条线路上的所有会话」一次搬到另一条兼容线路上。服务端契约
  // （src/provider-reassign.js，与 AI 配置弹窗同一套 PATCH）：
  //   POST .../reassign-sessions {}                             → 列出会话 + 兼容目标
  //   POST .../reassign-sessions {targetProviderId, dryRun:true} → 逐会话预演
  //   POST .../reassign-sessions {targetProviderId}              → 真迁移
  // Auto 选择会话不会被搬（单会话 PATCH 会顺手退出 Auto），子任务/默认线路也不动，
  // 服务端只把它们计入 otherReferences —— 弹层里照实说明。
  const reassignReasonKeys = {
    auto_selection: 'airProviderReassignReasonAutoSelection',
    cli_incompatible: 'airProviderReassignReasonCliIncompatible',
    system_session: 'airProviderReassignReasonSystemSession',
    patch_rejected: 'airProviderReassignReasonPatchRejected',
  };
  const reassignReason = item => (item.reason
    ? t(reassignReasonKeys[item.reason] || 'airProviderReassignReasonUnknown')
    : '');

  function openReassign(provider) {
    const path = `/api/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}/reassign-sessions`;
    const dialog = make('dialog', null, 'provider-dialog service-dialog air-provider-refs-dialog');
    const form = make('form'); form.method = 'dialog';
    const head = make('div', null, 'section-heading');
    const title = make('div');
    title.append(make('span', t('airAdminPanelProvider'), 'eyebrow'),
      make('h2', t('airProviderReassignTitle', { name: displayName(provider) })));
    head.append(title, button('×', () => dialog.close()));
    const host = make('div');
    const error = make('p', null, 'air-provider-ref-warn');
    const actions = make('div', null, 'schedule-form-actions');
    const confirm = button(t('airProviderReassignConfirm'), () => apply(), 'primary');
    confirm.disabled = true;
    actions.append(button(t('airProviderReassignClose'), () => dialog.close()), confirm);
    form.append(head, make('p', t('airProviderReassignIntro')), host, error, actions);
    dialog.append(form);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();

    let plan = null;
    let preview = null;
    let target = '';

    function group(titleText, rows, options = {}) {
      const section = make('section', null, 'air-provider-ref-group');
      const header = make('header');
      header.append(make('strong', `${titleText} · ${rows.length}`));
      if (options.note) header.append(make('small', options.note));
      const list = make('ul');
      for (const row of rows) {
        const item = make('li');
        item.append(make('span', row.label));
        if (row.detail) item.append(make('code', row.detail));
        list.append(item);
      }
      section.append(header, list);
      return section;
    }

    function sessionDetail(session) {
      const bits = [cliName(session.cli)];
      if (session.model) bits.push(session.model);
      return bits.join(' · ');
    }

    // 目标下拉：只列服务端算过「至少有一个会话搬得过去」的线路。选项里带上
    // 可迁移/将跳过的条数，用户不用点开就知道这条目标会漏掉谁。
    function targetPicker() {
      const label = make('label');
      label.append(make('span', t('airProviderReassignTargetLabel')));
      const select = make('select');
      const placeholder = make('option', plan.targets.length
        ? t('airProviderReassignTargetPlaceholder') : t('airProviderReassignNoTargets'));
      placeholder.value = ''; select.append(placeholder);
      for (const item of plan.targets) {
        // 目标线路有余量缓存就挂在选项后面，挑目标时顺带看清还剩多少。
        const targetProvider = data?.providers.find(entry => entry.id === item.id && entry.appType === provider.appType);
        const limitText = targetProvider?.limit ? resolveLimit(targetProvider)?.text : '';
        const option = make('option', t('airProviderReassignTargetOption', {
          name: item.name, count: item.compatibleSessions,
        }) + (limitText ? ` · ${limitText}` : ''));
        option.value = item.id;
        if (item.skippedSessions) option.title = t('airProviderReassignTargetSkip', { count: item.skippedSessions });
        select.append(option);
      }
      select.value = target;
      select.disabled = !plan.targets.length;
      select.onchange = async () => {
        target = select.value;
        preview = null;
        if (target) {
          try { preview = await context.api(path, { targetProviderId: target, dryRun: true }, 'POST'); }
          catch (reason) { setError(t('airProviderReassignFailed', { message: reason.message })); }
        }
        render();
      };
      label.append(select);
      return label;
    }

    function setError(message) { error.textContent = message || ''; }

    function render() {
      host.replaceChildren();
      if (!plan) { host.append(make('p', t('airProviderReassignLoading'), 'admin-empty')); return; }
      if (!plan.total) {
        host.append(make('p', t('airProviderReassignEmpty'), 'admin-empty'));
        confirm.disabled = true;
        return;
      }
      host.append(make('p', t('airProviderReassignCount', { count: plan.total })));
      const other = plan.otherReferences || {};
      const otherCount = (other.auto_candidate || 0) + (other.subagent || 0) + (other.default || 0) + (other.aux || 0);
      if (otherCount) host.append(make('p', t('airProviderReassignOtherRefs', { count: otherCount }), 'admin-empty'));
      const rows = (preview && preview.results
        ? preview.results.map(item => ({
          status: item.status,
          label: item.label,
          detail: [sessionDetail(item), item.modelReset
            ? t('airProviderReassignModelReset', {
              from: item.modelBefore || t('airProviderReassignModelDefault'),
              to: item.modelAfter || t('airProviderReassignModelDefault'),
            }) : ''].filter(Boolean).join(' · '),
        }))
        : plan.sessions.map(item => ({
          status: item.reason ? 'skipped' : 'bound',
          label: item.label,
          detail: item.reason ? reassignReason(item) : sessionDetail(item),
        })));
      host.append(group(t('airProviderReassignBoundTitle'), rows, { note: t('airProviderReassignModelNote') }));
      host.append(targetPicker());
      if (preview) {
        host.append(group(t('airProviderReassignWillSwitch'),
          rows.filter(item => item.status === 'switched'), {
            note: preview.deferred ? t('airProviderReassignDeferredCount', { count: preview.deferred }) : '',
          }));
        host.append(group(t('airProviderReassignWillSkip'), rows.filter(item => item.status === 'skipped')));
      }
      if (plan.truncated) host.append(make('p', t('airProviderReassignTruncated', { count: plan.sessions.length }), 'admin-empty'));
      confirm.disabled = !target;
    }

    async function apply() {
      if (!target) return;
      confirm.disabled = true;
      setError('');
      try {
        const result = await context.api(path, { targetProviderId: target }, 'POST');
        const skipped = result.results.filter(item => item.status === 'skipped');
        dialog.close();
        context.notice(`${t('airProviderReassignDone', {
          count: result.switched, skipped: result.skipped,
        })}${result.deferred ? t('airProviderReassignDoneDeferred', { count: result.deferred }) : ''}`
          + (skipped.length ? ` · ${t('airProviderReassignSkippedList', {
            items: skipped.map(item => `${item.label}(${reassignReason(item) || t('airProviderReassignReasonUnknown')})`).join(t('airProviderListSeparator')),
          })}` : ''));
        await load();
      } catch (reason) {
        confirm.disabled = false;
        setError(t('airProviderReassignFailed', { message: reason.message }));
      }
    }

    render();
    context.api(path, { dryRun: true }, 'POST')
      .then(result => { plan = result; render(); })
      .catch(reason => {
        plan = { total: 0, results: [], targets: [], sessions: [], otherReferences: {} };
        setError(t('airProviderReassignFailed', { message: reason.message }));
        render();
      });
  }

  async function importProviders() {
    const control = el('air-provider-import');
    control.disabled = true;
    try {
      const result = await context.api('/api/providers/import', {}, 'POST');
      context.notice(t('airProviderSyncDone', { imported: result.imported, updated: result.updated }));
      await load();
    } catch (error) { context.notice(error.message); }
    finally { control.disabled = data?.ccSwitchStatus?.available === false; }
  }

  // ── 官方账号额度保护 ────────────────────────────────────────────────────────
  //
  // 阈值落在数据根目录的 quota-guard.json（服务端闸门约 5 秒热读取），所以这里
  // 只负责读写一份设置，不参与拦截本身。放在线路卡下面而不是设置中心：它守的
  // 就是上面这些官方线路，摆在同一页才好对上号。

  function quotaGuardField(id, labelKey) {
    const label = make('label');
    label.append(make('span', t(labelKey)));
    const input = make('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.step = '1'; input.id = id;
    label.append(input);
    return label;
  }

  function quotaGuardCard() {
    const panel = make('section', null, 'admin-panel');
    panel.id = 'air-quota-guard-card';
    const head = make('div', null, 'admin-panel-head');
    const title = make('div');
    title.append(make('span', t('airQuotaGuardEyebrow'), 'eyebrow'), make('h3', t('airQuotaGuardTitle')));
    head.append(title, make('span', t('airQuotaGuardDesc'), 'admin-panel-note'));
    const body = make('div', null, 'air-quota-guard-body');
    const enabledRow = make('label', null, 'air-quota-guard-toggle');
    const enabled = make('input');
    enabled.type = 'checkbox'; enabled.id = 'air-quota-guard-enabled';
    enabledRow.append(enabled, make('span', t('airQuotaGuardEnabled')));
    const fields = make('div', null, 'form-row');
    fields.append(
      quotaGuardField('air-quota-guard-five-hour', 'airQuotaGuardFiveHour'),
      quotaGuardField('air-quota-guard-weekly', 'airQuotaGuardWeekly'),
      quotaGuardField('air-quota-guard-monthly', 'airQuotaGuardMonthly'),
    );
    const scopeRow = make('div', null, 'form-row');
    const scopeLabel = make('label');
    scopeLabel.append(make('span', t('airQuotaGuardScope')));
    const scope = make('select'); scope.id = 'air-quota-guard-scope';
    for (const [value, key] of [['official', 'airQuotaGuardScopeOfficial'], ['all', 'airQuotaGuardScopeAll']]) {
      const option = make('option', t(key)); option.value = value; scope.append(option);
    }
    scopeLabel.append(scope);
    scopeRow.append(scopeLabel);
    const note = make('p', '', 'admin-panel-note'); note.id = 'air-quota-guard-note'; note.hidden = true;
    const foot = make('div', null, 'form-row');
    const save = button(t('airQuotaGuardSave'), () => { void saveQuotaGuard(); }, 'btn btn-green');
    save.id = 'air-quota-guard-save';
    const status = make('span', '', 'status-text'); status.id = 'air-quota-guard-status';
    foot.append(save, status);
    body.append(enabledRow, fields, scopeRow, note, foot);
    panel.append(head, body);
    return panel;
  }

  function paintQuotaGuard(data) {
    const config = (data && data.config) || {};
    const enabled = el('air-quota-guard-enabled');
    if (enabled) enabled.checked = config.enabled !== false;
    const put = (id, value) => { const node = el(id); if (node) node.value = String(value == null ? '' : value); };
    put('air-quota-guard-five-hour', config.fiveHourPercent);
    put('air-quota-guard-weekly', config.weeklyPercent);
    put('air-quota-guard-monthly', config.monthlyPercent);
    const scope = el('air-quota-guard-scope');
    if (scope) scope.value = config.scope === 'all' ? 'all' : 'official';
    const note = el('air-quota-guard-note');
    if (note) {
      const overrides = data && Array.isArray(data.envOverrides) ? data.envOverrides : [];
      note.textContent = overrides.length ? t('airQuotaGuardEnvNote', { keys: overrides.join(', ') }) : '';
      note.hidden = !overrides.length;
    }
  }

  async function loadQuotaGuard() {
    const status = el('air-quota-guard-status');
    if (status) { status.textContent = t('airQuotaGuardLoading'); status.className = 'status-text'; }
    try {
      paintQuotaGuard(await context.api('/api/settings/quota-guard'));
      if (status) status.textContent = '';
    } catch (error) {
      if (status) {
        status.textContent = t('airQuotaGuardLoadFailed', { message: error.message });
        status.className = 'status-text err';
      }
    }
  }

  async function saveQuotaGuard() {
    const save = el('air-quota-guard-save');
    const status = el('air-quota-guard-status');
    const read = (id) => { const node = el(id); return node ? node.value : ''; };
    if (save) save.disabled = true;
    if (status) { status.textContent = t('airQuotaGuardSaving'); status.className = 'status-text'; }
    try {
      const result = await context.api('/api/settings/quota-guard', {
        enabled: !!el('air-quota-guard-enabled')?.checked,
        fiveHourPercent: read('air-quota-guard-five-hour'),
        weeklyPercent: read('air-quota-guard-weekly'),
        monthlyPercent: read('air-quota-guard-monthly'),
        scope: read('air-quota-guard-scope') || 'official',
      }, 'PUT');
      paintQuotaGuard(result);
      if (status) { status.textContent = t('airQuotaGuardSaved'); status.className = 'status-text ok'; }
    } catch (error) {
      if (status) {
        status.textContent = t('airQuotaGuardSaveFailed', { message: error.message });
        status.className = 'status-text err';
      }
    } finally {
      if (save) save.disabled = false;
    }
  }

  function renderShell() {
    const page = make('div', null, 'air-provider-page');
    const intro = make('section', null, 'admin-panel air-provider-intro');
    const introCopy = make('div');
    introCopy.append(make('span', t('airAdminPanelProvider'), 'eyebrow'), make('h3', t('airProviderIntroTitle')), make('p', t('airProviderIntroBody')));
    const count = make('strong', t('airProviderLoadingCount')); count.id = 'air-provider-count'; intro.append(introCopy, count);
    const defaults = make('section', null, 'admin-panel');
    const defaultsHead = make('div', null, 'admin-panel-head'); defaultsHead.append(make('h3', t('airProviderDefaultsTitle')));
    const defaultsBody = make('div', null, 'air-provider-defaults'); defaultsBody.id = 'air-provider-defaults'; defaults.append(defaultsHead, defaultsBody);
    const toolbar = make('div', null, 'air-provider-toolbar');
    const tabs = make('div', null, 'air-provider-tabs');
    for (const [value, label] of protocols) { const tab = button(label, () => setProtocol(value), 'air-provider-tab'); tab.dataset.protocol = value; tabs.append(tab); }
    const importButton = button(t('airProviderImportFromCcSwitch'), importProviders); importButton.id = 'air-provider-import';
    toolbar.append(tabs, importButton);
    const cards = make('div', null, 'air-provider-cards'); cards.id = 'air-provider-cards';
    const advanced = make('section', null, 'air-provider-advanced'); advanced.id = 'air-provider-advanced'; advanced.hidden = !advancedOpen;
    const note = make('div', null, 'air-migration-note'); note.append(make('strong', t('airProviderAdvancedTitle')), make('span', t('airProviderAdvancedBody')));
    // 官方多账号 / 借道 / ZCode / Kimi 那四块正文由 air-provider-advanced.js 画进这个空壳，
    // 而且要等真正展开才画：它开四个接口，默认折叠的那一格不该替用户付这笔。
    const advancedBody = make('div'); advancedBody.id = 'air-provider-advanced-body';
    advanced.append(note, advancedBody);
    page.append(intro, defaults, toolbar, cards, quotaGuardCard(), advanced);
    el('admin-content').replaceChildren(page);
    void loadQuotaGuard();
    setProtocol(activeProtocol);
    if (advancedOpen) {
      root.MultiCCAirProviderAdvanced?.render(advancedBody, context);
      if (requestedConnection) root.MultiCCAirProviderAdvanced?.select(requestedConnection);
    }
    // 用量统计挂在线路下面：它说的是「这台机器的 CLI 到底烧了多少」，和上面
    // 那些线路卡是两回事，但同属 Provider 页（旧页里也是 Provider 的一个子页）。
    void root.MultiCCAirUsage?.render(page, context);
  }

  async function load() {
    const grid = el('air-provider-cards');
    if (grid) grid.replaceChildren(make('p', t('airProviderLoadingList'), 'admin-empty'));
    try {
      data = catalogApi.normalizeCatalog(await context.api('/api/providers'));
      root._providerData = data; // manage-provider-relay.js 的 shareRelayProvider 只认这个裸全局
      renderDefaults(); renderCards();
      const control = el('air-provider-import');
      if (control) {
        control.disabled = !data.ccSwitchStatus.available;
        control.title = data.ccSwitchStatus.available ? t('airProviderImportTitle') : (data.ccSwitchStatus.message || t('airProviderImportUnavailable'));
      }
    } catch (error) {
      if (grid) grid.replaceChildren(make('p', t('airProviderLoadFailed', { message: error.message }), 'admin-empty error'));
    }
  }

  function render(nextContext) {
    context = nextContext;
    ensureDialog();
    renderShell();
    void load();
  }

  function toggleAdvanced() {
    advancedOpen = !advancedOpen;
    const advanced = el('air-provider-advanced');
    if (!advanced) return;
    advanced.hidden = !advancedOpen;
    const host = el('air-provider-advanced-body');
    // 第一次展开才建那四块；之后每次展开只复读一遍状态（账号可能刚在终端里登录过），
    // 不重建 DOM —— 重建会把用户填到一半的 API Key 表单清掉。
    if (advancedOpen && host) {
      if (host.childElementCount) root.MultiCCAirProviderAdvanced?.refresh();
      else root.MultiCCAirProviderAdvanced?.render(host, context);
    }
    if (advancedOpen) advanced.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 顶栏的「刷新」两处一起刷：线路和用量都会变，只刷一半会让人以为没生效。
  function refresh() {
    void load();
    return root.MultiCCAirUsage?.reload();
  }

  function resolveLimit(provider) {
    return root.QuotaBarView?.resolveProviderLimit(provider.limit, {
      translate: (key, params, fallback) => {
        const translated = t(key, params);
        return translated && translated !== key ? translated : fallback;
      },
      rolled: t('quotaRolledWindow'),
    });
  }

  // Repaint time tokens without fetching quotas or rebuilding card controls.
  root.setInterval(() => {
    if (document.hidden || !data) return;
    document.querySelectorAll('.air-provider-card[data-provider-id]').forEach(card => {
      const provider = data.providers.find(item => item.id === card.dataset.providerId);
      const limit = card.querySelector('.air-provider-limit');
      const view = provider && limit && resolveLimit(provider);
      if (view) { limit.textContent = view.text; limit.title = view.title; limit.style.color = view.color; }
    });
  }, 30_000);

  root.MultiCCAirProvider = Object.freeze({ render, refresh, openEditor, toggleAdvanced });
})(typeof window !== 'undefined' ? window : null);

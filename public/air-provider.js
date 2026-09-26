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
  const presets = {
    'claude-subscription': { appType: 'claude', name: t('airProviderPresetClaudeSubscription'), baseUrl: '', model: '', apiFormat: 'anthropic' },
    'claude-api': { appType: 'claude', name: t('airProviderPresetClaudeApi'), baseUrl: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic' },
    'claude-glm': { appType: 'claude', name: t('airProviderPresetGlm'), baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.2', apiFormat: 'anthropic', aliasMap: { fable: { model: 'glm-5.3', name: 'GLM5.3' } } },
    'claude-deepseek': { appType: 'claude', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', apiFormat: 'anthropic' },
    'claude-minimax': { appType: 'claude', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M2', apiFormat: 'anthropic' },
    'claude-qwen': { appType: 'claude', name: t('airProviderPresetQwen'), baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3-coder-plus', apiFormat: 'anthropic' },
    'claude-openrouter': { appType: 'claude', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4.5', apiFormat: 'anthropic' },
    'codex-official': { appType: 'codex', name: t('airProviderPresetCodexOfficial'), baseUrl: '', model: '', apiFormat: 'openai_responses' },
    'codex-xf-maas': { appType: 'codex', name: t('airProviderPresetXfMaas'), baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1', model: 'xopglm52', apiFormat: 'openai_responses' },
  };
  let context = null;
  let data = null;
  let activeProtocol = 'all';
  let advancedOpen = false;
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

  function ensureDialog() {
    if (el('air-provider-dialog')) return el('air-provider-dialog');
    const dialog = make('dialog', null, 'provider-dialog service-dialog');
    dialog.id = 'air-provider-dialog';
    dialog.innerHTML = `
      <form id="air-provider-form">
        <div class="section-heading"><div><span class="eyebrow">AIR PROVIDER</span><h2 id="air-provider-form-title">${t('airProviderFormTitleNew')}</h2></div><button type="button" id="air-provider-close" aria-label="${t('airProviderClose')}">×</button></div>
        <p>${t('airProviderFormIntro')}</p>
        <input type="hidden" name="providerId">
        <label>${t('airProviderPresetLabel')}<select name="preset"><option value="">${t('airProviderPresetCustom')}</option><optgroup label="Claude"><option value="claude-subscription">${t('airProviderPresetClaudeSubscription')}</option><option value="claude-api">${t('airProviderPresetClaudeApi')}</option><option value="claude-glm">${t('airProviderPresetGlm')}</option><option value="claude-deepseek">DeepSeek</option><option value="claude-minimax">MiniMax</option><option value="claude-qwen">${t('airProviderPresetQwen')}</option><option value="claude-openrouter">OpenRouter</option></optgroup><optgroup label="Codex"><option value="codex-official">${t('airProviderPresetCodexOfficial')}</option><option value="codex-xf-maas">${t('airProviderPresetXfMaas')}</option></optgroup></select></label>
        <div class="form-row"><label>CLI<select name="appType"><option value="claude">Claude</option><option value="codex">Codex</option></select></label><label>${t('airProviderUpstreamProtocol')}<select name="apiFormat"><option value="anthropic">Anthropic Messages</option><option value="openai_responses">OpenAI Responses</option></select></label></div>
        <label>${t('airProviderName')}<input name="name" required maxlength="240" placeholder="${t('airProviderNamePlaceholder')}"></label>
        <label>Base URL<input name="baseUrl" maxlength="2048" placeholder="${t('airProviderBaseUrlPlaceholder')}"></label>
        <label>API Key<input name="authToken" type="password" maxlength="4096" autocomplete="off" placeholder="${t('airProviderTokenPlaceholder')}"></label>
        <label>${t('airProviderDefaultModel')}<input name="model" maxlength="240" placeholder="${t('airProviderModelPlaceholder')}"></label>
        <label>${t('airProviderOptionalModels')}<textarea name="models" rows="3" placeholder="${t('airProviderModelsPlaceholder')}"></textarea></label>
        <details id="air-provider-aliases"><summary>${t('airProviderAliasSummary')}</summary><div class="provider-alias-grid"><span>${t('airProviderTierColumn')}</span><span>${t('airProviderDisplayNameColumn')}</span><span>${t('airProviderRealModelColumn')}</span></div></details>
        <p id="air-provider-form-error" role="alert"></p>
        <div class="schedule-form-actions"><button type="button" id="air-provider-cancel">${t('airProviderCancel')}</button><button type="submit" id="air-provider-save" class="primary">${t('airProviderCreate')}</button></div>
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
    form.elements.appType.onchange = syncDialogProtocol;
    form.onsubmit = saveEditor;
    return dialog;
  }

  function syncDialogProtocol() {
    const form = el('air-provider-form');
    if (!form) return;
    const claude = form.elements.appType.value === 'claude';
    form.elements.apiFormat.disabled = claude;
    if (claude) form.elements.apiFormat.value = 'anthropic';
    el('air-provider-aliases').hidden = !claude;
  }

  function applyPreset(key) {
    const preset = presets[key];
    const form = el('air-provider-form');
    if (!preset || !form) return;
    for (const name of ['appType', 'name', 'baseUrl', 'model', 'apiFormat']) form.elements[name].value = preset[name];
    form.elements.models.value = preset.model || '';
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

  function openEditor(provider = null) {
    const dialog = ensureDialog();
    const form = el('air-provider-form');
    form.reset();
    form.elements.providerId.value = provider?.id || '';
    form.elements.appType.value = provider?.appType || 'claude';
    form.elements.appType.disabled = !!provider;
    form.elements.apiFormat.value = provider?.apiFormat || (provider?.appType === 'codex' ? 'openai_responses' : 'anthropic');
    form.elements.name.value = provider?.name || '';
    form.elements.baseUrl.value = provider?.baseUrl || '';
    form.elements.model.value = provider?.model || '';
    form.elements.models.value = (provider?.modelOptions || []).join('\n');
    form.elements.authToken.placeholder = provider?.hasToken ? t('airProviderTokenKeep', { mask: provider.tokenMask || t('airProviderSet') }) : t('airProviderTokenUnset');
    fillAliases(form, provider?.aliasMap);
    syncDialogProtocol();
    el('air-provider-form-title').textContent = provider ? t('airProviderEditTitle', { name: displayName(provider) }) : t('airProviderFormTitleNew');
    el('air-provider-save').textContent = provider ? t('airProviderSave') : t('airProviderCreate');
    el('air-provider-form-error').textContent = '';
    dialog.showModal();
  }

  async function saveEditor(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const save = el('air-provider-save');
    const error = el('air-provider-form-error');
    const providerId = form.elements.providerId.value;
    const appType = form.elements.appType.value;
    const model = form.elements.model.value.trim();
    const body = {
      name: form.elements.name.value.trim(),
      baseUrl: form.elements.baseUrl.value.trim(),
      model,
      models: catalogApi.normalizeModelOptions(form.elements.models.value, model),
      apiFormat: form.elements.apiFormat.value,
    };
    const token = form.elements.authToken.value.trim();
    if (!providerId || token) body.authToken = token;
    if (appType === 'claude') body.aliasMap = aliasMapFrom(form);
    if (!providerId) body.appType = appType;
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
    const card = make('article', null, 'air-provider-card');
    const head = make('div', null, 'air-provider-card-head');
    const title = make('div');
    title.append(make('span', provider.appType === 'claude' ? 'C' : 'O', `provider-cli-mark ${provider.appType}`));
    const copy = make('span'); copy.append(make('strong', displayName(provider)), make('small', `${cliName(provider.appType)} · ${protocolName(provider.apiFormat)}`));
    title.append(copy);
    const tags = make('div', null, 'air-provider-tags');
    if (data.defaults[provider.appType] === provider.id) tags.append(make('span', t('airProviderGlobalDefault'), 'default'));
    if (provider.isOfficial) tags.append(make('span', t('airProviderOfficial')));
    if (provider.hasToken) tags.append(make('span', t('airProviderKeyConfigured')));
    head.append(title, tags);
    const endpoint = make('p', provider.baseUrl || t('airProviderNativeRoute'), 'air-provider-endpoint');
    const facts = make('div', null, 'air-provider-facts');
    facts.append(
      fact(t('airProviderDefaultModel'), provider.model || t('airProviderModelFollowCatalog')),
      fact(t('airProviderOptionalModels'), provider.modelOptions.length ? t('airProviderModelCount', { count: provider.modelOptions.length }) : t('airProviderDynamicDiscovery')),
      fact(t('airProviderAvailableCli'), provider.compatibleClis.map(cliName).join(' / ') || cliName(provider.appType)),
      fact(t('airProviderTotalUsage'), providerStat(provider)),
    );
    if (provider.limit?.summaryText) card.append(head, endpoint, facts, make('p', `${provider.limit.stale ? t('airProviderQuotaStale') : t('airProviderQuota')}${provider.limit.summaryText}`, 'air-provider-limit'));
    else card.append(head, endpoint, facts);
    const actions = make('div', null, 'air-provider-card-actions');
    const speed = button(latency.has(provider.id) ? latency.get(provider.id) : t('airProviderSpeedTest'), () => speedTest(provider, speed));
    actions.append(speed);
    if (!provider.isOfficial) {
      actions.append(
        button(t('airProviderEdit'), () => openEditor(provider)),
        // 生成一份带独立令牌的借道分享码（manage-provider-relay.js，弹层自带样式）。
        button(t('airProviderRelayShare'), () => {
          root.MultiCCAirProviderAdvanced?.prepare(context);
          root.shareRelayProvider?.(provider.appType, provider.id);
        }),
        button(t('airProviderDelete'), () => removeProvider(provider), 'danger'));
    } else actions.append(make('span', t('airProviderOfficialSwitchHint')));
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
      const native = make('option', t('airProviderDefaultNative', { cli: cliName(cli) })); native.value = ''; select.append(native);
      for (const provider of data.providers.filter(item => item.appType === cli)) {
        const option = make('option', `${displayName(provider)} · ${protocolName(provider.apiFormat)}${provider.model ? ` · ${provider.model}` : ''}`);
        option.value = provider.id; select.append(option);
      }
      select.value = data.defaults[cli] || '';
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
    title.append(make('span', 'PROVIDER IN USE', 'eyebrow'), make('h2', t('airProviderInUseTitle', { name: displayName(provider), count: refs.count })));
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

  function renderShell() {
    const page = make('div', null, 'air-provider-page');
    const intro = make('section', null, 'admin-panel air-provider-intro');
    const introCopy = make('div');
    introCopy.append(make('span', 'ROUTING CATALOG', 'eyebrow'), make('h3', t('airProviderIntroTitle')), make('p', t('airProviderIntroBody')));
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
    page.append(intro, defaults, toolbar, cards, advanced);
    el('admin-content').replaceChildren(page);
    setProtocol(activeProtocol);
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

  root.MultiCCAirProvider = Object.freeze({ render, refresh, openEditor, toggleAdvanced });
})(typeof window !== 'undefined' ? window : null);

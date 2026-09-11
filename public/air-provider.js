'use strict';

(function initAirProvider(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const catalogApi = root.MultiCCProviderCatalog;
  const protocols = [
    ['all', '全部线路'],
    ['anthropic', 'Anthropic Messages'],
    ['openai_responses', 'OpenAI Responses'],
    ['openai_chat', 'OpenAI Chat'],
  ];
  const presets = {
    'claude-subscription': { appType: 'claude', name: 'Claude 官方订阅', baseUrl: '', model: '', apiFormat: 'anthropic' },
    'claude-api': { appType: 'claude', name: 'Claude 官方 API', baseUrl: 'https://api.anthropic.com', model: '', apiFormat: 'anthropic' },
    'claude-glm': { appType: 'claude', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.2', apiFormat: 'anthropic' },
    'claude-deepseek': { appType: 'claude', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', apiFormat: 'anthropic' },
    'claude-minimax': { appType: 'claude', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M2', apiFormat: 'anthropic' },
    'claude-qwen': { appType: 'claude', name: 'Qwen 通义千问', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', model: 'qwen3-coder-plus', apiFormat: 'anthropic' },
    'claude-openrouter': { appType: 'claude', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4.5', apiFormat: 'anthropic' },
    'codex-official': { appType: 'codex', name: 'OpenAI（Codex 官方）', baseUrl: '', model: '', apiFormat: 'openai_responses' },
    'codex-xf-maas': { appType: 'codex', name: '讯飞 MaaS Coding', baseUrl: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/v1', model: 'xopglm52', apiFormat: 'openai_responses' },
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
  const protocolName = value => ({ anthropic: 'Anthropic Messages', openai_responses: 'OpenAI Responses', openai_chat: 'OpenAI Chat → Responses' }[value] || value);
  const cliName = value => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode' }[value] || value);

  function ensureDialog() {
    if (el('air-provider-dialog')) return el('air-provider-dialog');
    const dialog = make('dialog', null, 'provider-dialog service-dialog');
    dialog.id = 'air-provider-dialog';
    dialog.innerHTML = `
      <form id="air-provider-form">
        <div class="section-heading"><div><span class="eyebrow">AIR PROVIDER</span><h2 id="air-provider-form-title">新增 Provider</h2></div><button type="button" id="air-provider-close" aria-label="关闭">×</button></div>
        <p>沿用原设置页的 CLI → 协议 → 模型结构。API Key 只提交给服务端，不会回显到页面。</p>
        <input type="hidden" name="providerId">
        <label>模板<select name="preset"><option value="">自定义（手动填写）</option><optgroup label="Claude"><option value="claude-subscription">Claude 官方订阅</option><option value="claude-api">Claude 官方 API</option><option value="claude-glm">智谱 GLM</option><option value="claude-deepseek">DeepSeek</option><option value="claude-minimax">MiniMax</option><option value="claude-qwen">Qwen 通义千问</option><option value="claude-openrouter">OpenRouter</option></optgroup><optgroup label="Codex"><option value="codex-official">OpenAI（Codex 官方）</option><option value="codex-xf-maas">讯飞 MaaS Coding</option></optgroup></select></label>
        <div class="form-row"><label>CLI<select name="appType"><option value="claude">Claude</option><option value="codex">Codex</option></select></label><label>上游协议<select name="apiFormat"><option value="anthropic">Anthropic Messages</option><option value="openai_responses">OpenAI Responses</option><option value="openai_chat">OpenAI Chat（自动转换）</option></select></label></div>
        <label>名称<input name="name" required maxlength="240" placeholder="例如：DeepSeek / OpenRouter"></label>
        <label>Base URL<input name="baseUrl" maxlength="2048" placeholder="留空表示官方登录或订阅线路"></label>
        <label>API Key<input name="authToken" type="password" maxlength="4096" autocomplete="off" placeholder="创建时填写；编辑时留空保留原 Key"></label>
        <label>默认模型<input name="model" maxlength="240" placeholder="例如：glm-5.2"></label>
        <label>可选模型<textarea name="models" rows="3" placeholder="每行一个；默认模型会自动并入列表"></textarea></label>
        <details id="air-provider-aliases"><summary>Claude 模型分级映射（可选）</summary><div class="provider-alias-grid"><span>级别</span><span>显示名</span><span>真实模型 ID</span></div></details>
        <p id="air-provider-form-error" role="alert"></p>
        <div class="schedule-form-actions"><button type="button" id="air-provider-cancel">取消</button><button type="submit" id="air-provider-save" class="primary">创建 Provider</button></div>
      </form>`;
    const aliases = dialog.querySelector('#air-provider-aliases');
    for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
      const row = make('div', null, 'provider-alias-grid provider-alias-row');
      row.append(make('strong', tier[0].toUpperCase() + tier.slice(1)));
      const name = make('input'); name.name = `alias-${tier}-name`; name.placeholder = '可选显示名';
      const model = make('input'); model.name = `alias-${tier}-model`; model.placeholder = '例如 glm-5.2';
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
    form.elements.authToken.placeholder = provider?.hasToken ? `留空保留原 Key（${provider.tokenMask || '已设置'}）` : '尚未设置 API Key';
    fillAliases(form, provider?.aliasMap);
    syncDialogProtocol();
    el('air-provider-form-title').textContent = provider ? `编辑 ${provider.name}` : '新增 Provider';
    el('air-provider-save').textContent = provider ? '保存修改' : '创建 Provider';
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
      context.notice(providerId ? 'Provider 已更新。' : 'Provider 已创建。');
      await load();
    } catch (reason) { error.textContent = reason.message; }
    finally { save.disabled = false; }
  }

  function providerStat(provider) {
    const stat = (data?.stats || []).find(item => item.providerId === provider.id);
    if (!stat) return '尚无用量记录';
    return `${catalogApi.formatCompactTokens(stat.totalTokens)} token · ${stat.turnCount} 轮 · ${stat.sessionCount} 会话`;
  }

  function renderProviderCard(provider) {
    const card = make('article', null, 'air-provider-card');
    const head = make('div', null, 'air-provider-card-head');
    const title = make('div');
    title.append(make('span', provider.appType === 'claude' ? 'C' : 'O', `provider-cli-mark ${provider.appType}`));
    const copy = make('span'); copy.append(make('strong', provider.name), make('small', `${cliName(provider.appType)} · ${protocolName(provider.apiFormat)}`));
    title.append(copy);
    const tags = make('div', null, 'air-provider-tags');
    if (data.defaults[provider.appType] === provider.id) tags.append(make('span', '全局默认', 'default'));
    if (provider.isOfficial) tags.append(make('span', '官方'));
    if (provider.hasToken) tags.append(make('span', 'Key 已配置'));
    head.append(title, tags);
    const endpoint = make('p', provider.baseUrl || '使用本机官方登录 / 订阅', 'air-provider-endpoint');
    const facts = make('div', null, 'air-provider-facts');
    facts.append(
      fact('默认模型', provider.model || '跟随官方目录'),
      fact('可选模型', provider.modelOptions.length ? `${provider.modelOptions.length} 个` : '动态发现'),
      fact('可用 CLI', provider.compatibleClis.map(cliName).join(' / ') || cliName(provider.appType)),
      fact('累计用量', providerStat(provider)),
    );
    if (provider.limit?.summaryText) card.append(head, endpoint, facts, make('p', `${provider.limit.stale ? '上次余量 · ' : '余量 · '}${provider.limit.summaryText}`, 'air-provider-limit'));
    else card.append(head, endpoint, facts);
    const actions = make('div', null, 'air-provider-card-actions');
    const speed = button(latency.has(provider.id) ? latency.get(provider.id) : '测速', () => speedTest(provider, speed));
    actions.append(speed);
    if (!provider.isOfficial) {
      actions.append(button('编辑', () => openEditor(provider)), button('删除', () => removeProvider(provider), 'danger'));
    } else actions.append(make('span', '官方账号切换请进入高级设置'));
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
      label.append(make('span', `${cliName(cli)} 默认线路`));
      const select = make('select'); select.dataset.cli = cli;
      const native = make('option', `${cliName(cli)} 官方登录 / 订阅（不覆盖）`); native.value = ''; select.append(native);
      for (const provider of data.providers.filter(item => item.appType === cli)) {
        const option = make('option', `${provider.name} · ${protocolName(provider.apiFormat)}${provider.model ? ` · ${provider.model}` : ''}`);
        option.value = provider.id; select.append(option);
      }
      select.value = data.defaults[cli] || '';
      label.append(select); panel.append(label);
    }
    panel.append(button('保存全局默认', saveDefaults, 'primary'));
  }

  function renderCards() {
    const grid = el('air-provider-cards');
    if (!grid || !data) return;
    const rows = activeProtocol === 'all' ? data.providers : data.providers.filter(item => item.apiFormat === activeProtocol);
    grid.replaceChildren(...rows.map(renderProviderCard));
    if (!rows.length) grid.append(make('p', '该协议下还没有 Provider，可以从右上角新增。', 'admin-empty'));
    el('air-provider-count').textContent = `${data.providers.length} 条线路 · ${data.providers.filter(item => item.hasToken || item.isOfficial).length} 条可用凭据`;
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
      context.notice('全局默认 Provider 已保存。');
      renderDefaults(); renderCards();
    } catch (error) { context.notice(error.message); }
  }

  async function speedTest(provider, control) {
    control.disabled = true; control.textContent = '测速中…';
    try {
      const result = await context.api(`/api/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}/speedtest`, {}, 'POST');
      latency.set(provider.id, result.ok ? `${result.ms} ms` : `失败${result.status ? ` ${result.status}` : ''}`);
    } catch (error) { latency.set(provider.id, `失败${error.status ? ` ${error.status}` : ''}`); }
    renderCards();
  }

  async function removeProvider(provider) {
    if (!confirm(`删除 Provider“${provider.name}”？正在被任务或默认设置引用时，服务端会拒绝删除。`)) return;
    try {
      await context.api(`/api/providers/${encodeURIComponent(provider.appType)}/${encodeURIComponent(provider.id)}`, undefined, 'DELETE');
      context.notice(`已删除 ${provider.name}。`);
      await load();
    } catch (error) {
      const refs = catalogApi.deleteReferenceDisplayData(error);
      context.notice(`${error.message}${refs.count ? `；仍被 ${refs.items.map(item => item.title).join('、')} 引用` : ''}`);
    }
  }

  async function importProviders() {
    const control = el('air-provider-import');
    control.disabled = true;
    try {
      const result = await context.api('/api/providers/import', {}, 'POST');
      context.notice(`cc-switch 同步完成：新增 ${result.imported}，刷新 ${result.updated}。`);
      await load();
    } catch (error) { context.notice(error.message); }
    finally { control.disabled = data?.ccSwitchStatus?.available === false; }
  }

  function renderShell() {
    const page = make('div', null, 'air-provider-page');
    const intro = make('section', null, 'admin-panel air-provider-intro');
    const introCopy = make('div');
    introCopy.append(make('span', 'ROUTING CATALOG', 'eyebrow'), make('h3', '全局线路与 CLI 默认值'), make('p', 'MultiCC 自己保存 Provider。任务只引用线路 ID，密钥不会进入 Air 数据或任务历史。'));
    const count = make('strong', '正在读取…'); count.id = 'air-provider-count'; intro.append(introCopy, count);
    const defaults = make('section', null, 'admin-panel');
    const defaultsHead = make('div', null, 'admin-panel-head'); defaultsHead.append(make('h3', '新任务默认线路'));
    const defaultsBody = make('div', null, 'air-provider-defaults'); defaultsBody.id = 'air-provider-defaults'; defaults.append(defaultsHead, defaultsBody);
    const toolbar = make('div', null, 'air-provider-toolbar');
    const tabs = make('div', null, 'air-provider-tabs');
    for (const [value, label] of protocols) { const tab = button(label, () => setProtocol(value), 'air-provider-tab'); tab.dataset.protocol = value; tabs.append(tab); }
    const importButton = button('从 cc-switch 同步', importProviders); importButton.id = 'air-provider-import';
    toolbar.append(tabs, importButton);
    const cards = make('div', null, 'air-provider-cards'); cards.id = 'air-provider-cards';
    const advanced = make('section', null, 'air-provider-advanced'); advanced.id = 'air-provider-advanced'; advanced.hidden = !advancedOpen;
    const note = make('div', null, 'air-migration-note'); note.append(make('strong', '高级连接'), make('span', '官方多账号、借道分享、ZCode / Kimi 原生登录与完整用量统计暂沿用原控制器。'));
    const frame = make('iframe', null, 'air-legacy-frame'); frame.title = 'Provider 高级设置'; frame.dataset.src = '/manage.html?view=provider&embed=air';
    advanced.append(note, frame);
    page.append(intro, defaults, toolbar, cards, advanced);
    el('admin-content').replaceChildren(page);
    setProtocol(activeProtocol);
  }

  async function load() {
    const grid = el('air-provider-cards');
    if (grid) grid.replaceChildren(make('p', '正在读取 Provider…', 'admin-empty'));
    try {
      data = catalogApi.normalizeCatalog(await context.api('/api/providers'));
      renderDefaults(); renderCards();
      const control = el('air-provider-import');
      if (control) {
        control.disabled = !data.ccSwitchStatus.available;
        control.title = data.ccSwitchStatus.available ? '从只读 cc-switch 数据库同步' : (data.ccSwitchStatus.message || 'cc-switch 当前不可导入');
      }
    } catch (error) {
      if (grid) grid.replaceChildren(make('p', `读取失败：${error.message}`, 'admin-empty error'));
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
    const frame = advanced.querySelector('iframe');
    if (advancedOpen && !frame.src) frame.src = frame.dataset.src;
    if (advancedOpen) advanced.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  root.MultiCCAirProvider = Object.freeze({ render, refresh: load, openEditor, toggleAdvanced });
})(typeof window !== 'undefined' ? window : null);

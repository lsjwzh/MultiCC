(function () {
  'use strict';

  const CLI_LABELS = Object.freeze({
    claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode',
    qoder: 'Qoder CN', codebuddy: 'WorkBuddy', dsh: 'DSH', kimi: 'Kimi Code',
  });
  const CLI_MARKS = Object.freeze({
    claude: 'C', codex: 'X', opencode: 'O', zcode: 'Z', qoder: 'Q',
    codebuddy: 'W', dsh: 'D', kimi: 'K',
  });
  const PROVIDERLESS_CLIS = new Set(['qoder', 'codebuddy', 'dsh']);
  const EFFORT_LABELS = Object.freeze({
    claude: '思考强度', codex: '推理等级', opencode: '模型 Variant',
    qoder: '推理强度', codebuddy: '推理强度',
  });

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  function dialog(title, build) {
    const d = node('dialog'), form = node('form'), error = node('p');
    error.setAttribute('role', 'alert');
    const cancel = node('button', '取消'), submit = node('button', '保存');
    cancel.type = 'button'; submit.className = 'primary';
    cancel.onclick = () => d.close(); form.append(node('h2', title));
    const save = build(form); form.append(error, cancel, submit);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = '';
      try { await save(); d.close(); }
      catch (e) { error.textContent = e.message; }
      finally { submit.disabled = false; }
    };
    d.onclose = () => d.remove(); d.append(form); document.body.append(d); d.showModal();
  }

  function field(form, title, tag = 'input') {
    const label = node('label', title), input = node(tag);
    label.append(input); form.append(label); return input;
  }

  async function request(url, body, method = 'POST') {
    const options = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw new Error(`服务返回了无法识别的内容（HTTP ${response.status}）`); }
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || result.error || result.code || `请求失败（HTTP ${response.status}）`);
    }
    return result;
  }

  function section(title, note) {
    const box = node('section', null, 'air-config-section');
    const head = node('div', null, 'air-config-section-head');
    head.append(node('h3', title), node('p', note));
    box.append(head);
    return box;
  }

  function nativeProviderCopy(cli) {
    if (cli === 'zcode') return ['ZCode 原生 / Coding Plan', '使用 ZCode 自己维护的登录与连接配置'];
    if (cli === 'opencode') return ['OpenCode 原生配置', '使用本机 OpenCode Go 或原生 provider/model'];
    if (cli === 'kimi') return ['Kimi Code 原生连接', '使用 Kimi Code 自己维护的凭证'];
    if (PROVIDERLESS_CLIS.has(cli)) return ['CLI 原生账号', '此 CLI 不通过 MultiCC Provider 路由'];
    return ['默认登录 / 官方账号', '使用该 CLI 当前的本机订阅或 OAuth'];
  }

  function configuration(entry, clis, onSaved) {
    const catalogApi = window.MultiCCProviderCatalog;
    const autoApi = window.MultiCCAutoProviderEditor;
    const aiApi = window.MultiCCChatAiConfig;
    if (!catalogApi || !autoApi || !aiApi) {
      throw new Error('AI 配置组件未加载，请刷新页面后重试。');
    }

    // Draft mode: no session yet (the directory's new-task composer). The same
    // dialog then has nothing to persist — it hands the chosen runtime back to
    // the caller, which pins it onto the task at creation. One dialog, one
    // implementation, two surfaces.
    const draft = !entry.sessionId;
    const storedConfig = entry.configuration || {};
    const pending = storedConfig.pendingConfiguration;
    // The editor always opens on the user's desired next-turn route. This keeps
    // a second edit from accidentally overwriting a configuration that was
    // already staged while the current runner was busy.
    const config = pending
      ? { ...storedConfig, ...(pending.profile || {}), cli: pending.cli || storedConfig.cli }
      : storedConfig;
    const d = node('dialog', null, 'air-config-dialog');
    const form = node('form', null, 'air-config-form');
    const header = node('header', null, 'air-config-head');
    const heading = node('div');
    heading.append(node('span', 'TASK ROUTING', 'eyebrow'), node('h2', '任务 AI 配置'));
    const close = node('button', '×', 'air-config-close');
    close.type = 'button'; close.setAttribute('aria-label', '关闭 AI 配置'); close.onclick = () => d.close();
    header.append(heading, close);
    form.append(header, node('p', draft
      ? `为新任务选择执行工具与请求线路。创建任务时写入，第一条消息即按此执行。`
      : `为「${entry.task?.title || '当前任务'}」选择执行工具与请求线路。更改从下一轮开始生效。`, 'air-config-intro'));

    const cliSection = section('1 · CLI', '先选择负责执行任务的命令行工具');
    const cliGrid = node('div', null, 'air-cli-grid');
    cliGrid.setAttribute('role', 'radiogroup'); cliGrid.setAttribute('aria-label', 'CLI');
    cliSection.append(cliGrid); form.append(cliSection);

    const providerSection = section('2 · Provider', '选择这个任务使用的账号或 API 路由');
    const providerStatus = node('p', '', 'air-config-status');
    providerStatus.setAttribute('role', 'status');
    const providerField = node('label', null, 'air-config-field');
    providerField.append(node('span', 'Provider'));
    const providerSelect = node('select'); providerSelect.setAttribute('aria-label', 'Provider');
    providerField.append(providerSelect);
    const autoHost = node('div', null, 'air-auto-host');
    providerSection.append(providerStatus, providerField, autoHost); form.append(providerSection);

    const runtimeSection = section('3 · 模型与推理', '模型会随 Provider 联动；推理强度按 CLI 能力显示');
    const runtimeGrid = node('div', null, 'air-runtime-grid');
    const modelField = node('label', null, 'air-config-field');
    modelField.append(node('span', '模型'));
    const modelSelect = node('select'); modelSelect.setAttribute('aria-label', '模型');
    const customModel = node('input'); customModel.maxLength = 100; customModel.placeholder = '输入模型 ID';
    customModel.setAttribute('aria-label', '自定义模型 ID'); customModel.hidden = true;
    modelField.append(modelSelect, customModel);
    const effortField = node('label', null, 'air-config-field');
    const effortLabel = node('span', '推理强度');
    const effortSelect = node('select'); effortSelect.setAttribute('aria-label', '推理强度');
    effortField.append(effortLabel, effortSelect);
    runtimeGrid.append(modelField, effortField);
    // 子任务：Provider 配置后面的一行尾巴（线路 + 模型）。它和 chat 的 AI 配置面板
    // 是同一个字段、同一套判定，只是不再有独立的外显面板 —— 只挑线路不挑模型等于
    // 没设，交上去就是 null（随主）。只有 Claude 与 Codex 支持把子 agent 换线。
    const subRow = node('div', null, 'air-sub');
    const subGrid = node('div', null, 'air-sub-grid');
    const subProviderField = node('label', null, 'air-config-field');
    subProviderField.append(node('span', '子任务线路'));
    const subProviderSelect = node('select'); subProviderSelect.setAttribute('aria-label', '子任务线路');
    subProviderField.append(subProviderSelect);
    const subModelField = node('label', null, 'air-config-field');
    subModelField.append(node('span', '子任务模型'));
    const subModelSelect = node('select'); subModelSelect.setAttribute('aria-label', '子任务模型');
    const subCustomModel = node('input'); subCustomModel.maxLength = 100; subCustomModel.placeholder = '输入模型 ID';
    subCustomModel.setAttribute('aria-label', '子任务自定义模型 ID'); subCustomModel.hidden = true;
    subModelField.append(subModelSelect, subCustomModel);
    subGrid.append(subProviderField, subModelField);
    subRow.append(subGrid, node('p', '子 agent 走的 provider + model（经本地协议代理路由，与主进程隔离）。只挑线路不挑模型 = 没设，随主。', 'air-sub-hint'));
    runtimeSection.append(runtimeGrid, subRow); form.append(runtimeSection);

    const error = node('p', '', 'air-config-error'); error.setAttribute('role', 'alert');
    const foot = node('footer', null, 'air-config-footer');
    const footCopy = node('p', draft ? '这一选择只在创建这个任务时使用。' : '任务历史、角色与工作区保持不变。');
    const actions = node('div');
    const cancel = node('button', '取消'); cancel.type = 'button'; cancel.onclick = () => d.close();
    const submit = node('button', draft ? '使用此配置' : '保存配置', 'primary'); submit.type = 'submit';
    actions.append(cancel, submit); foot.append(footCopy, actions);
    form.append(error, foot); d.append(form); document.body.append(d); d.showModal();

    const cliList = [...new Set([config.cli || 'claude', ...(Array.isArray(clis) ? clis : [])].filter(Boolean))];
    const cache = new Map();
    let currentCli = config.cli || cliList[0] || 'claude';
    let currentCatalog = null;
    let providers = [];
    let providerValue = '';
    let autoEditor = null;
    let loading = false;
    let loadEpoch = 0;
    // 子任务尾巴的模型候选跟着「生效线路」走：显式选了就用它，留空（随主）时用主
    // 线路 —— Auto 档下主线路是池子里排第一的那条，所以要等 autoEditor 挂载/改选
    // 之后再算。subLineProvider 记着上一次算过的线路，线路没变就不重建模型列表，
    // 免得把用户刚挑的（或刚手填的）模型冲掉。
    let subLineProvider = null;
    let subReady = false;

    const supportsSubagent = () => aiApi.supportsSubagentCli(currentCli);

    function modelState() {
      return { cli: currentCli, providers, defaults: currentCatalog?.defaults || {},
        translate: key => ({ default: '默认模型', custom: '自定义模型…' })[key] || key };
    }

    function setBusy(value) {
      loading = value; submit.disabled = value;
      cliGrid.querySelectorAll('button').forEach(button => { button.disabled = value; });
      for (const control of [providerSelect, modelSelect, customModel, effortSelect, subProviderSelect, subModelSelect, subCustomModel]) {
        control.disabled = value;
      }
    }

    function renderCliButtons() {
      cliGrid.replaceChildren(...cliList.map(cli => {
        const button = node('button', null, 'air-cli-option'); button.type = 'button';
        button.dataset.cli = cli; button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(cli === currentCli));
        button.classList.toggle('selected', cli === currentCli);
        button.append(node('span', CLI_MARKS[cli] || cli.slice(0, 1).toUpperCase(), 'air-cli-mark'));
        const copy = node('span'); copy.append(node('strong', CLI_LABELS[cli] || cli), node('small', cli));
        button.append(copy);
        button.onclick = () => { if (cli !== currentCli && !loading) selectCli(cli, false); };
        return button;
      }));
    }

    function renderEffort(preferred) {
      const options = aiApi.effortOptions(currentCli);
      effortField.hidden = !options.length;
      effortLabel.textContent = EFFORT_LABELS[currentCli] || aiApi.effortLabel(currentCli) || '推理强度';
      effortSelect.replaceChildren(...options.map(choice => {
        const option = node('option', choice.desc ? `${choice.label} — ${choice.desc}` : choice.label);
        option.value = choice.value; return option;
      }));
      const value = preferred == null ? aiApi.defaultEffort(currentCli) : preferred;
      effortSelect.value = options.some(option => option.value === value) ? value : aiApi.defaultEffort(currentCli);
    }

    function renderModel(preferred) {
      const protocol = autoApi.protocolFromValue(providerValue);
      modelField.hidden = !!protocol;
      if (protocol) return;
      const state = modelState();
      let choices = aiApi.buildModelChoices(providerValue, state);
      if (!Array.isArray(choices) || !choices.length) choices = ['', '__custom__'];
      choices = [...new Set(choices)];
      modelSelect.replaceChildren(...choices.map(value => {
        const option = node('option', value === '__custom__' ? '自定义模型…' : aiApi.modelChoiceLabel(value, providerValue, state));
        option.value = value; return option;
      }));
      let selected = aiApi.normalizeModel(providerValue, preferred || '', state);
      if (!selected) selected = aiApi.defaultModelChoice(providerValue, state) || '';
      const known = choices.includes(selected);
      modelSelect.value = known ? selected : (selected && choices.includes('__custom__') ? '__custom__' : choices[0]);
      customModel.value = known ? '' : selected;
      customModel.hidden = modelSelect.value !== '__custom__';
    }

    // ── 子任务尾巴 ────────────────────────────────────────────────────────────
    // 线路下拉永远是「随主」在前，后面是本 CLI 可用的 Provider（Codex 排掉官方
    // 账号：它没有可调用的 HTTP 端点，服务端也会拒）。
    function renderSubProviders() {
      const head = node('option', '随主'); head.value = '';
      const items = [head];
      if (!PROVIDERLESS_CLIS.has(currentCli)) {
        for (const provider of providers) {
          if (currentCli === 'codex' && provider.isOfficial) continue;
          const option = node('option', aiApi.providerLabel(provider, false) + aiApi.providerLimitLabel(provider));
          option.value = provider.id; items.push(option);
        }
      }
      subProviderSelect.replaceChildren(...items);
      return items;
    }

    function rebuildSubModels(preferred) {
      const state = modelState();
      const providerId = subProviderSelect.value || primaryProviderId();
      // 用户手填过的自定义模型必须留着：切换线路时 DOM 里只有一个 '__custom__'，
      // 真值在这个输入框里。
      const current = subModelSelect.value === '__custom__' ? subCustomModel.value.trim() : subModelSelect.value;
      const choices = [...new Set(aiApi.buildModelChoices(providerId, state))]
        .filter(value => value && value !== '__custom__');
      const selected = aiApi.normalizeModel(providerId, (preferred || current || '').toString().trim(), state);
      const none = node('option', '不设置'); none.value = '';
      const custom = node('option', '自定义模型…'); custom.value = '__custom__';
      subModelSelect.replaceChildren(none, ...choices.map(value => {
        const option = node('option', aiApi.modelChoiceLabel(value, providerId, state));
        option.value = value; return option;
      }), custom);
      const known = !!selected && choices.includes(selected);
      subModelSelect.value = known ? selected : (selected ? '__custom__' : '');
      subCustomModel.value = known ? '' : (selected || '');
      subCustomModel.hidden = subModelSelect.value !== '__custom__';
    }

    function primaryProviderId() {
      if (autoApi.protocolFromValue(providerValue) && autoEditor) {
        const read = autoEditor.read();
        const first = read && read.ok ? read.value.candidates[0] : null;
        if (first && first.providerId) return first.providerId;
      }
      return providerValue;
    }

    function refreshSubLine(preferred) {
      if (!subReady) return;
      const effective = subProviderSelect.value || primaryProviderId();
      if (preferred == null && effective === subLineProvider) return;
      subLineProvider = effective;
      rebuildSubModels(preferred || '');
    }

    function renderSub(initial) {
      subReady = false; subLineProvider = null;
      subRow.hidden = !supportsSubagent();
      if (subRow.hidden) {
        subProviderSelect.replaceChildren(); subModelSelect.replaceChildren();
        subCustomModel.hidden = true;
        return;
      }
      const items = renderSubProviders();
      const saved = initial && config.subagent && config.subagent.model ? config.subagent : null;
      const wanted = saved?.providerId || '';
      subProviderSelect.value = items.some(option => option.value === wanted) ? wanted : '';
      subReady = true;
      refreshSubLine(saved ? saved.model : '');
    }

    // 提交时把尾巴折成服务端要的形状：模型为空就是没设（清空），判定与 chat 的
    // AI 配置面板共用 aiApi.resolveSubagent。
    function collectSubagent(primary) {
      const model = subModelSelect.value === '__custom__' ? subCustomModel.value.trim() : subModelSelect.value;
      return aiApi.resolveSubagent({ cli: currentCli, providerId: subProviderSelect.value,
        primaryProviderId: primary ? primary.providerId : providerValue, model });
    }

    function syncAutoEditor() {
      if (autoEditor) { autoEditor.destroy(); autoEditor = null; }
      const protocol = autoApi.protocolFromValue(providerValue);
      autoHost.hidden = !protocol;
      if (!protocol) return;
      autoEditor = autoApi.mount({
        document, container: autoHost, providers, protocol,
        initialSelection: config.providerSelection?.mode === 'auto' && config.providerSelection.protocol === protocol
          ? config.providerSelection : null,
        formatProvider: provider => `${provider.name || provider.id}${provider.model ? ` · ${provider.model}` : ''}`,
        // 池子里换人会让「随主」的模型候选跟着换 —— 尾巴得重算。
        onChange: () => refreshSubLine(),
      });
    }

    function chooseProvider(value, preferredModel = '') {
      providerValue = value;
      if (providerSelect.value !== value) providerSelect.value = value;
      syncAutoEditor(); renderModel(preferredModel); refreshSubLine();
    }

    function renderProviders(initial) {
      const [nativeTitle] = nativeProviderCopy(currentCli);
      const head = node('option', nativeTitle); head.value = '';
      const options = [head];
      if (!PROVIDERLESS_CLIS.has(currentCli)) {
        for (const auto of autoApi.availableProtocols(providers)) {
          if (!autoApi.defaultSelection(providers, auto.protocol)
              && config.providerSelection?.protocol !== auto.protocol) continue;
          const option = node('option', `⚡ Auto · ${auto.label}（${auto.count} 个同协议 Provider，可按优先级自动切换）`);
          option.value = autoApi.optionValue(auto.protocol); options.push(option);
        }
        for (const provider of providers) {
          const option = node('option', aiApi.providerLabel(provider, true) + aiApi.providerLimitLabel(provider));
          option.value = provider.id; options.push(option);
        }
      }
      providerSelect.replaceChildren(...options);
      const initialAuto = initial && config.providerSelection?.mode === 'auto'
        ? autoApi.optionValue(config.providerSelection.protocol) : '';
      let desired = initialAuto || (initial ? config.provider || '' : currentCatalog?.defaults?.[currentCli] || '');
      if (!options.some(option => option.value === desired)) desired = '';
      const desiredProvider = providers.find(provider => provider.id === desired);
      chooseProvider(desired, initial ? config.model || '' : desiredProvider?.model || '');
      providerStatus.textContent = PROVIDERLESS_CLIS.has(currentCli)
        ? `${CLI_LABELS[currentCli] || currentCli} 使用原生账号配置，无需选择 MultiCC Provider。`
        : providers.length ? `已读取 ${providers.length} 个与 ${CLI_LABELS[currentCli] || currentCli} 兼容的 Provider。`
          : '没有兼容的自管 Provider；当前任务将使用 CLI 原生登录。';
    }

    async function loadCatalog(cli) {
      if (cache.has(cli)) return cache.get(cli);
      const raw = await request(`/api/providers?cli=${encodeURIComponent(cli)}`, undefined, 'GET');
      const normalized = catalogApi.normalizeCatalog(raw);
      cache.set(cli, normalized); return normalized;
    }

    async function selectCli(cli, initial) {
      const epoch = ++loadEpoch; currentCli = cli; renderCliButtons(); setBusy(true);
      providerStatus.textContent = '正在读取 Provider 配置…'; providerSelect.replaceChildren();
      if (autoEditor) { autoEditor.destroy(); autoEditor = null; }
      autoHost.hidden = true; error.textContent = '';
      try {
        const catalog = await loadCatalog(cli);
        if (epoch !== loadEpoch) return;
        currentCatalog = catalog;
        providers = catalogApi.providersForCli(catalog, cli);
        renderProviders(initial); renderSub(initial); renderEffort(initial ? config.effort : null);
      } catch (cause) {
        if (epoch !== loadEpoch) return;
        currentCatalog = null; providers = [];
        const retry = node('button', '重新读取'); retry.type = 'button'; retry.onclick = () => selectCli(cli, initial);
        providerStatus.replaceChildren(`Provider 读取失败：${cause.message} `, retry);
        providerSelect.replaceChildren();
        error.textContent = 'Provider 配置未加载，暂不能保存，避免覆盖当前线路。';
      } finally {
        if (epoch === loadEpoch) setBusy(currentCatalog == null);
      }
    }

    modelSelect.onchange = () => {
      customModel.hidden = modelSelect.value !== '__custom__';
      if (!customModel.hidden) customModel.focus();
    };
    providerSelect.onchange = () => { if (!loading) chooseProvider(providerSelect.value, ''); };
    subProviderSelect.onchange = () => refreshSubLine();
    subModelSelect.onchange = () => {
      subCustomModel.hidden = subModelSelect.value !== '__custom__';
      if (!subCustomModel.hidden) subCustomModel.focus();
    };

    form.onsubmit = async event => {
      event.preventDefault();
      if (loading) return;
      submit.disabled = true; error.textContent = '';
      try {
        const autoProtocol = autoApi.protocolFromValue(providerValue);
        let providerSelection = null;
        let provider = providerValue || null;
        let model = modelSelect.value === '__custom__' ? customModel.value.trim() : modelSelect.value;
        if (autoProtocol) {
          const selection = autoEditor?.read();
          if (!selection?.ok) throw new Error(selection?.error || 'Auto Provider 配置无效。');
          providerSelection = selection.value;
          const primary = providerSelection.candidates[0];
          provider = primary.providerId; model = primary.model || null;
        }
        const subagent = collectSubagent(providerSelection?.candidates[0] || null);
        if (draft) {
          await onSaved({ cli: currentCli, provider, providerSelection, model: model || null,
            effort: effortField.hidden ? null : effortSelect.value || null,
            providerName: providers.find(candidate => candidate.id === provider)?.name || null, subagent });
          d.close();
          return;
        }
        const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
        if (currentCli !== config.cli) await request(base + '/switch-cli', { cli: currentCli });
        if (!PROVIDERLESS_CLIS.has(currentCli)) {
          // Provider mutation may assign its default model. Persist the chosen
          // model in a second transaction so the provider default cannot win.
          await request(base, { provider, providerSelection }, 'PATCH');
        }
        await request(base, {
          model: model || null,
          effort: effortField.hidden ? null : effortSelect.value || null,
          // 子任务跟着同一笔 PATCH 走：它校验的是刚写下去的主 Provider
          // （Codex 要求主线路有可调用的 HTTP 端点），顺序不能颠倒。
          subagent,
        }, 'PATCH');
        await onSaved(); d.close();
      } catch (cause) {
        error.textContent = cause.message;
      } finally { submit.disabled = false; }
    };

    d.onclose = () => { if (autoEditor) autoEditor.destroy(); d.remove(); };
    renderCliButtons(); selectCli(currentCli, true);
  }

  window.MultiCCAirSettings = {
    directory(onSaved) {
      dialog('添加工作目录', form => {
        const name = field(form, '名称'), path = field(form, '本机绝对路径'); name.required = path.required = true;
        name.maxLength = 100; path.placeholder = '/Users/you/projects/example';
        form.append(node('p', '添加目录后，可在其中创建任务并按需附加角色。'));
        return async () => { const result = await request('/api/directories', { name: name.value, path: path.value, create: false }); await onSaved(result); };
      });
    },
    configuration,
  };
})();

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

  function providerMeta(provider) {
    const protocol = {
      anthropic: 'Anthropic Messages',
      openai_responses: 'OpenAI Responses',
    }[provider.apiFormat || provider.protocol] || 'Managed Provider';
    const bits = [protocol];
    if (provider.isOfficial) bits.push('Official');
    if (provider.model) bits.push(provider.model);
    return bits.join(' · ');
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
    const providerList = node('div', null, 'air-provider-list');
    providerList.setAttribute('role', 'radiogroup'); providerList.setAttribute('aria-label', 'Provider');
    const autoHost = node('div', null, 'air-auto-host');
    providerSection.append(providerStatus, providerList, autoHost); form.append(providerSection);

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
    runtimeGrid.append(modelField, effortField); runtimeSection.append(runtimeGrid); form.append(runtimeSection);

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

    function setBusy(value) {
      loading = value; submit.disabled = value;
      cliGrid.querySelectorAll('button').forEach(button => { button.disabled = value; });
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
      const state = { cli: currentCli, providers, defaults: currentCatalog?.defaults || {},
        translate: key => ({ default: '默认模型', custom: '自定义模型…' })[key] || key };
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
      });
    }

    function chooseProvider(value, preferredModel = '') {
      providerValue = value;
      providerList.querySelectorAll('.air-provider-option').forEach(card => {
        const selected = card.dataset.value === value;
        card.classList.toggle('selected', selected);
        card.querySelector('input').checked = selected;
      });
      syncAutoEditor(); renderModel(preferredModel);
    }

    function providerCard(value, title, meta, badge) {
      const card = node('label', null, 'air-provider-option'); card.dataset.value = value;
      const radio = node('input'); radio.type = 'radio'; radio.name = 'air-provider'; radio.value = value;
      const copy = node('span', null, 'air-provider-copy'); copy.append(node('strong', title), node('small', meta));
      card.append(radio, copy);
      if (badge) card.append(node('span', badge, 'air-provider-badge'));
      radio.onchange = () => { if (radio.checked) chooseProvider(value, ''); };
      return card;
    }

    function renderProviders(initial) {
      const cards = [];
      const [nativeTitle, nativeMeta] = nativeProviderCopy(currentCli);
      cards.push(providerCard('', nativeTitle, nativeMeta, 'NATIVE'));
      if (!PROVIDERLESS_CLIS.has(currentCli)) {
        for (const auto of autoApi.availableProtocols(providers)) {
          if (!autoApi.defaultSelection(providers, auto.protocol)
              && config.providerSelection?.protocol !== auto.protocol) continue;
          cards.push(providerCard(autoApi.optionValue(auto.protocol), `Auto · ${auto.label}`,
            `${auto.count} 个同协议 Provider，可按优先级自动切换`, 'AUTO'));
        }
        for (const provider of providers) {
          cards.push(providerCard(provider.id, provider.name || provider.id, providerMeta(provider), provider.isOfficial ? 'OFFICIAL' : 'MANAGED'));
        }
      }
      providerList.replaceChildren(...cards);
      const initialAuto = initial && config.providerSelection?.mode === 'auto'
        ? autoApi.optionValue(config.providerSelection.protocol) : '';
      let desired = initialAuto || (initial ? config.provider || '' : currentCatalog?.defaults?.[currentCli] || '');
      if (!cards.some(card => card.dataset.value === desired)) desired = '';
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
      providerStatus.textContent = '正在读取 Provider 配置…'; providerList.replaceChildren();
      if (autoEditor) { autoEditor.destroy(); autoEditor = null; }
      autoHost.hidden = true; error.textContent = '';
      try {
        const catalog = await loadCatalog(cli);
        if (epoch !== loadEpoch) return;
        currentCatalog = catalog;
        providers = catalogApi.providersForCli(catalog, cli);
        renderProviders(initial); renderEffort(initial ? config.effort : null);
      } catch (cause) {
        if (epoch !== loadEpoch) return;
        currentCatalog = null; providers = [];
        providerStatus.textContent = `Provider 读取失败：${cause.message}`;
        const retry = node('button', '重新读取'); retry.type = 'button'; retry.onclick = () => selectCli(cli, initial);
        providerList.replaceChildren(retry); error.textContent = 'Provider 配置未加载，暂不能保存，避免覆盖当前线路。';
      } finally {
        if (epoch === loadEpoch) setBusy(currentCatalog == null);
      }
    }

    modelSelect.onchange = () => {
      customModel.hidden = modelSelect.value !== '__custom__';
      if (!customModel.hidden) customModel.focus();
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
        if (draft) {
          await onSaved({ cli: currentCli, provider, providerSelection, model: model || null,
            effort: effortField.hidden ? null : effortSelect.value || null,
            providerName: providers.find(candidate => candidate.id === provider)?.name || null });
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

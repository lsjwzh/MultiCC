(function () {
  'use strict';

  // 展示名、短标记、是否自持账号三列都取自共享 CLI 目录（public/provider-catalog.js，
  // 权威表在服务端 src/cli/cli-capability.js）—— 这里原本各抄了一份副本。
  const cliLabel = cli => window.MultiCCProviderCatalog.cliDisplayName(cli);
  const cliMark = cli => window.MultiCCProviderCatalog.cliShortMark(cli);
  const isProviderless = cli => window.MultiCCProviderCatalog.cliProviderless(cli);
  const EFFORT_LABELS = Object.freeze({
    claude: t('airTaskSettingsEffortClaude'), 'claude-exp': t('airTaskSettingsEffortClaude'), codex: t('airTaskSettingsEffortCodex'), 'codex-exp': t('airTaskSettingsEffortCodex'), opencode: t('airTaskSettingsEffortOpenCode'),
    qoder: t('airTaskSettingsEffortLabel'), codebuddy: t('airTaskSettingsEffortLabel'),
  });

  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  // Some failures have exactly one command that repairs them. Rather than
  // printing it and hoping the user opens a terminal, render the button that
  // runs it — on macOS `xcode-select --install` only raises the system's own
  // "Install" dialog, so the click the user makes is still the deciding one.
  const FIX_ACTIONS = {
    'install-developer-tools': {
      label: () => t('airTaskSettingsInstallDevTools'),
      url: '/api/system/developer-tools/install',
      message: result => (result.status === 'already-installed'
        ? t('airTaskSettingsInstallDevToolsInstalled')
        : result.status === 'already-requested'
          ? t('airTaskSettingsInstallDevToolsPending')
          : t('airTaskSettingsInstallDevToolsRequested')),
      failure: () => t('airTaskSettingsInstallDevToolsFailed'),
    },
    // macOS privacy cannot be granted programmatically — only the user, in
    // System Settings, can do it. The button opens the right pane and then
    // names the exact program to add, which is the part people get wrong.
    'open-disk-access': {
      label: () => t('airTaskSettingsOpenDiskAccess'),
      url: '/api/system/disk-access/open',
      working: () => t('airTaskSettingsOpenDiskAccessWorking'),
      message: () => t('airTaskSettingsOpenDiskAccessOpened'),
      failure: () => t('airTaskSettingsOpenDiskAccessFailed'),
      detail: async () => {
        const info = await request('/api/system/disk-access', undefined, 'GET');
        return info && info.target ? t('airTaskSettingsOpenDiskAccessTarget') + info.target : null;
      },
    },
  };

  function renderFix(container, fix) {
    const action = FIX_ACTIONS[fix];
    if (!action) return;
    const wrap = node('p', null, 'air-fix-action');
    const button = node('button', action.label());
    button.type = 'button';
    const status = node('span', '', 'air-fix-status');
    const detail = node('code', '', 'air-fix-detail');
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = (action.working || (() => t('airTaskSettingsInstallDevToolsWorking')))();
      try {
        const result = await request(action.url, {});
        status.textContent = action.message(result);
        // Best-effort: the action already succeeded, so a detail lookup that
        // fails must not turn it into a reported failure.
        if (action.detail) {
          try { detail.textContent = (await action.detail()) || ''; } catch { detail.textContent = ''; }
        }
      } catch (cause) {
        // Keep the button live: a headless launchd host cannot draw the system
        // dialog, and the user may want to retry after starting MultiCC from a
        // logged-in session.
        button.disabled = false;
        status.textContent = cause.message || action.failure();
      }
    };
    wrap.append(button, status, detail);
    container.append(wrap);
  }

  function dialog(title, build) {
    const d = node('dialog'), form = node('form'), error = node('p'), fixBox = node('div');
    error.setAttribute('role', 'alert');
    const cancel = node('button', t('airTaskSettingsCancel')), submit = node('button', t('airTaskSettingsSave'));
    cancel.type = 'button'; submit.className = 'primary';
    cancel.onclick = () => d.close(); form.append(node('h2', title));
    const save = build(form); form.append(error, fixBox, cancel, submit);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = ''; fixBox.replaceChildren();
      try { await save(); d.close(); }
      catch (e) { error.textContent = e.message; if (e.fix) renderFix(fixBox, e.fix); }
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
    catch (_) { throw new Error(t('airTaskSettingsBadResponse', { status: response.status })); }
    if (!response.ok || result.ok === false) {
      const failure = new Error(result.message || result.error || result.code || t('airTaskSettingsRequestFailed', { status: response.status }));
      // Server-named remedy (see src/directory/service.js). Carried on the Error
      // so the dialog can offer a button instead of prose the user must retype.
      if (result.fix) failure.fix = result.fix;
      throw failure;
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
    if (cli === 'zcode') return [t('airTaskSettingsNativeZcodeTitle'), t('airTaskSettingsNativeZcodeNote')];
    if (cli === 'opencode') return [t('airTaskSettingsNativeOpenCodeTitle'), t('airTaskSettingsNativeOpenCodeNote')];
    if (cli === 'kimi') return [t('airTaskSettingsNativeKimiTitle'), t('airTaskSettingsNativeKimiNote')];
    if (isProviderless(cli)) return [t('airTaskSettingsNativeCliTitle'), t('airTaskSettingsNativeCliNote')];
    return [t('airTaskSettingsNativeDefaultTitle'), t('airTaskSettingsNativeDefaultNote')];
  }

  function configuration(entry, clis, onSaved) {
    const catalogApi = window.MultiCCProviderCatalog;
    const autoApi = window.MultiCCAutoProviderEditor;
    const aiApi = window.MultiCCChatAiConfig;
    if (!catalogApi || !autoApi || !aiApi) {
      throw new Error(t('airTaskSettingsComponentsMissing'));
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
    heading.append(node('span', 'TASK ROUTING', 'eyebrow'), node('h2', t('airTaskSettingsHeading')));
    const close = node('button', '×', 'air-config-close');
    close.type = 'button'; close.setAttribute('aria-label', t('airTaskSettingsCloseAria')); close.onclick = () => d.close();
    header.append(heading, close);
    form.append(header, node('p', draft
      ? t('airTaskSettingsIntroDraft')
      : t('airTaskSettingsIntroTask', { title: entry.task?.title || t('airTaskSettingsCurrentTask') }), 'air-config-intro'));

    const cliSection = section('1 · CLI', t('airTaskSettingsCliNote'));
    const cliGrid = node('div', null, 'air-cli-grid');
    cliGrid.setAttribute('role', 'radiogroup'); cliGrid.setAttribute('aria-label', 'CLI');
    cliSection.append(cliGrid); form.append(cliSection);

    const providerSection = section('2 · Provider', t('airTaskSettingsProviderNote'));
    const providerStatus = node('p', '', 'air-config-status');
    providerStatus.setAttribute('role', 'status');
    const providerField = node('label', null, 'air-config-field');
    providerField.append(node('span', 'Provider'));
    const providerSelect = node('select'); providerSelect.setAttribute('aria-label', 'Provider');
    providerField.append(providerSelect);
    const autoHost = node('div', null, 'air-auto-host');
    providerSection.append(providerStatus, providerField, autoHost); form.append(providerSection);

    const runtimeSection = section(t('airTaskSettingsRuntimeSection'), t('airTaskSettingsRuntimeNote'));
    const runtimeGrid = node('div', null, 'air-runtime-grid');
    const modelField = node('label', null, 'air-config-field');
    modelField.append(node('span', t('airTaskSettingsModelLabel')));
    const modelSelect = node('select'); modelSelect.setAttribute('aria-label', t('airTaskSettingsModelLabel'));
    const customModel = node('input'); customModel.maxLength = 100; customModel.placeholder = t('airTaskSettingsModelPlaceholder');
    customModel.setAttribute('aria-label', t('airTaskSettingsCustomModelAria')); customModel.hidden = true;
    modelField.append(modelSelect, customModel);
    const effortField = node('label', null, 'air-config-field');
    const effortLabel = node('span', t('airTaskSettingsEffortLabel'));
    const effortSelect = node('select'); effortSelect.setAttribute('aria-label', t('airTaskSettingsEffortLabel'));
    effortField.append(effortLabel, effortSelect);
    runtimeGrid.append(modelField, effortField);
    // 子任务：Provider 配置后面的一行尾巴（线路 + 模型）。它和 chat 的 AI 配置面板
    // 是同一个字段、同一套判定，只是不再有独立的外显面板 —— 只挑线路不挑模型等于
    // 没设，交上去就是 null（随主）。只有 Claude 与 Codex 支持把子 agent 换线。
    const subRow = node('div', null, 'air-sub');
    const subGrid = node('div', null, 'air-sub-grid');
    const subProviderField = node('label', null, 'air-config-field');
    subProviderField.append(node('span', t('airTaskSettingsSubProviderLabel')));
    const subProviderSelect = node('select'); subProviderSelect.setAttribute('aria-label', t('airTaskSettingsSubProviderLabel'));
    subProviderField.append(subProviderSelect);
    const subModelField = node('label', null, 'air-config-field');
    subModelField.append(node('span', t('airTaskSettingsSubModelLabel')));
    const subModelSelect = node('select'); subModelSelect.setAttribute('aria-label', t('airTaskSettingsSubModelLabel'));
    const subCustomModel = node('input'); subCustomModel.maxLength = 100; subCustomModel.placeholder = t('airTaskSettingsModelPlaceholder');
    subCustomModel.setAttribute('aria-label', t('airTaskSettingsSubCustomModelAria')); subCustomModel.hidden = true;
    subModelField.append(subModelSelect, subCustomModel);
    subGrid.append(subProviderField, subModelField);
    subRow.append(subGrid, node('p', t('airTaskSettingsSubHint'), 'air-sub-hint'));
    runtimeSection.append(runtimeGrid, subRow); form.append(runtimeSection);

    const error = node('p', '', 'air-config-error'); error.setAttribute('role', 'alert');
    const foot = node('footer', null, 'air-config-footer');
    const footCopy = node('p', draft ? t('airTaskSettingsFootDraft') : t('airTaskSettingsFootTask'));
    const actions = node('div');
    const cancel = node('button', t('airTaskSettingsCancel')); cancel.type = 'button'; cancel.onclick = () => d.close();
    const submit = node('button', draft ? t('airTaskSettingsUseConfig') : t('airTaskSettingsSaveConfig'), 'primary'); submit.type = 'submit';
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
        translate: key => ({ default: t('airTaskSettingsDefaultModel'), custom: t('airTaskSettingsCustomModelOption') })[key] || key };
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
        button.append(node('span', cliMark(cli), 'air-cli-mark'));
        const copy = node('span'); copy.append(node('strong', cliLabel(cli)), node('small', cli));
        button.append(copy);
        button.onclick = () => { if (cli !== currentCli && !loading) selectCli(cli, false); };
        return button;
      }));
    }

    function renderEffort(preferred) {
      const options = aiApi.effortOptions(currentCli);
      effortField.hidden = !options.length;
      effortLabel.textContent = EFFORT_LABELS[currentCli] || aiApi.effortLabel(currentCli) || t('airTaskSettingsEffortLabel');
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
        const option = node('option', value === '__custom__' ? t('airTaskSettingsCustomModelOption') : aiApi.modelChoiceLabel(value, providerValue, state));
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
      const head = node('option', t('airTaskSettingsFollowPrimary')); head.value = '';
      const items = [head];
      if (!isProviderless(currentCli)) {
        for (const provider of providers) {
          if ((currentCli === 'codex' || currentCli === 'codex-exp') && provider.isOfficial) continue;
          // tr 要传进去：缓存里那条「更新于 / 查询失败 / 过期」的尾巴不传就永远是中文。
          const option = node('option', aiApi.providerLabel(provider, false) + aiApi.providerLimitLabel(provider, t));
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
      const none = node('option', t('airTaskSettingsNotSet')); none.value = '';
      const custom = node('option', t('airTaskSettingsCustomModelOption')); custom.value = '__custom__';
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
        const read = autoEditor.read({ remember: false });
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
      const mounted = autoApi.mount({
        document, container: autoHost, providers, protocol,
        initialSelection: config.providerSelection?.mode === 'auto' && config.providerSelection.protocol === protocol
          ? config.providerSelection : null,
        formatProvider: provider => `${provider.name || provider.id}${provider.model ? ` · ${provider.model}` : ''}`,
        // 池子里换人会让「随主」的模型候选跟着换 —— 尾巴得重算。
        onChange: () => refreshSubLine(),
        routingKey: typeof fetch === 'function' ? aiApi.routingKeyApi() : null,
      });
      autoEditor = mounted;
    }

    function chooseProvider(value, preferredModel = '') {
      providerValue = value;
      if (providerSelect.value !== value) providerSelect.value = value;
      syncAutoEditor(); renderModel(preferredModel); refreshSubLine();
    }

    function renderProviders(initial) {
      const official = providers.find(provider => catalogApi.officialProviderKind(provider) === (currentCli.startsWith('codex') ? 'codex' : 'claude'));
      const options = [];
      // 支持 Provider 的 CLI 已经有一条真实的内置 Official Provider：空值
      // 「Default login / official account」只是旧 UI 对同一件事的第二种说法，
      // 会让人以为它是另一条线路。Providerless CLI 仍保留自身的原生项。
      if (isProviderless(currentCli) || !official) {
        const [nativeTitle] = nativeProviderCopy(currentCli);
        const head = node('option', nativeTitle); head.value = '';
        options.push(head);
      }
      if (!isProviderless(currentCli)) {
        for (const auto of autoApi.availableProtocols(providers)) {
          if (!autoApi.defaultSelection(providers, auto.protocol)
              && config.providerSelection?.protocol !== auto.protocol) continue;
          const option = node('option', t('airTaskSettingsAutoOption', { label: auto.label, count: auto.count }));
          option.value = autoApi.optionValue(auto.protocol); options.push(option);
        }
        for (const provider of providers) {
          const option = node('option', aiApi.providerLabel(provider, true) + aiApi.providerLimitLabel(provider, t));
          option.value = provider.id; options.push(option);
        }
      }
      providerSelect.replaceChildren(...options);
      const initialAuto = initial && config.providerSelection?.mode === 'auto'
        ? autoApi.optionValue(config.providerSelection.protocol) : '';
      let desired = initialAuto || (initial ? config.provider || '' : currentCatalog?.defaults?.[currentCli] || '');
      if (!desired && official) desired = official.id;
      if (!options.some(option => option.value === desired)) desired = official?.id || '';
      const desiredProvider = providers.find(provider => provider.id === desired);
      chooseProvider(desired, initial ? config.model || '' : desiredProvider?.model || '');
      providerStatus.textContent = isProviderless(currentCli)
        ? t('airTaskSettingsStatusNative', { cli: cliLabel(currentCli) })
        : providers.length ? t('airTaskSettingsProvidersLoaded', { n: providers.length, cli: cliLabel(currentCli) })
          : t('airTaskSettingsNoProviders');
    }

    async function loadCatalog(cli) {
      if (cache.has(cli)) return cache.get(cli);
      const raw = await request(`/api/providers?cli=${encodeURIComponent(cli)}`, undefined, 'GET');
      const normalized = catalogApi.normalizeCatalog(raw);
      cache.set(cli, normalized); return normalized;
    }

    async function selectCli(cli, initial) {
      const epoch = ++loadEpoch; currentCli = cli; renderCliButtons(); setBusy(true);
      providerStatus.textContent = t('airTaskSettingsLoadingProviders'); providerSelect.replaceChildren();
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
        const retry = node('button', t('airTaskSettingsRetry')); retry.type = 'button'; retry.onclick = () => selectCli(cli, initial);
        providerStatus.replaceChildren(t('airTaskSettingsLoadFailed', { message: cause.message }), retry);
        providerSelect.replaceChildren();
        error.textContent = t('airTaskSettingsProviderNotLoaded');
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
          if (!selection?.ok) throw new Error(selection?.error || t('airTaskSettingsAutoInvalid'));
          providerSelection = selection.value;
          const primary = providerSelection.candidates[0];
          provider = primary.providerId; model = primary.model || null;
        }
        const subagent = collectSubagent(providerSelection?.candidates[0] || null);
        if (draft) {
          await onSaved({ cli: currentCli, provider, providerSelection, model: model || null,
            effort: effortField.hidden ? null : effortSelect.value || null,
            providerName: catalogApi.providerDisplayName(providers.find(candidate => candidate.id === provider) || {}) || null, subagent });
          d.close();
          return;
        }
        const base = `/api/sessions/${encodeURIComponent(entry.sessionId)}`;
        if (currentCli !== config.cli) await request(base + '/switch-cli', { cli: currentCli });
        if (!isProviderless(currentCli)) {
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
      dialog(t('airTaskSettingsAddDirectory'), form => {
        const name = field(form, t('airTaskSettingsName')), path = field(form, t('airTaskSettingsAbsolutePath')); name.required = path.required = true;
        name.maxLength = 100; path.placeholder = '/Users/you/projects/example';
        const create = node('input'); create.type = 'checkbox'; create.checked = true;
        const createLabel = node('label', t('airTaskSettingsCreateIfMissing')); createLabel.prepend(create);
        form.append(createLabel);
        form.append(node('p', t('airTaskSettingsAddDirectoryNote')));
        return async () => { const result = await request('/api/directories', { name: name.value, path: path.value, create: create.checked }); await onSaved(result); };
      });
    },
    configuration,
  };
})();

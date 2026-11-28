'use strict';

// Dialog-local request ownership and stable controls. Rendering never starts a
// request; empty/error results settle, and invalidated requests cannot publish.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCRunConfigControls = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function createCatalogLoader({ request, normalize, onLoaded }) {
    const catalogs = new Map(), errors = new Map(), pending = new Map();
    let generation = 0, closed = false;
    function invalidate() { ++generation; catalogs.clear(); errors.clear(); pending.clear(); }
    function load(cli) {
      if (closed) return Promise.reject(new Error('catalog_closed'));
      if (catalogs.has(cli)) return Promise.resolve(catalogs.get(cli));
      if (errors.has(cli)) return Promise.reject(errors.get(cli));
      if (pending.has(cli)) return pending.get(cli);
      const started = generation;
      const promise = Promise.resolve().then(() => {
        if (closed) throw new Error('catalog_closed');
        return started === generation ? request(cli) : load(cli);
      }).then(raw => {
        if (closed) throw new Error('catalog_closed');
        if (started !== generation) return load(cli);
        const catalog = normalize(raw);
        catalogs.set(cli, catalog);
        onLoaded(catalog);
        return catalog;
      }).catch(error => {
        if (!closed && started !== generation) return load(cli);
        if (!closed) errors.set(cli, error);
        throw error;
      }).finally(() => { if (pending.get(cli) === promise) pending.delete(cli); });
      pending.set(cli, promise);
      return promise;
    }
    return { catalogs, errors, load, invalidate, close() { closed = true; invalidate(); } };
  }

  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function setValue(node, value) { if (node.value !== value) node.value = value; }
  function syncChildren(host, nodes) {
    const keep = new Set(nodes);
    for (const child of [...host.children]) if (!keep.has(child)) child.remove();
    nodes.forEach((node, index) => {
      const before = host.children[index] || null;
      if (before === node) return;
      if (host.moveBefore && node.parentNode === host) host.moveBefore(node, before);
      else host.insertBefore(node, before);
    });
  }

  // Reuse option/group nodes, including when a genuine catalog change adds or
  // removes models. Unchanged polling responses perform no child mutations.
  function syncOptions(select, entries) {
    const oldOptions = new Map([...select.options].map(node => [node.value, node]));
    const oldGroups = new Map([...select.children].filter(node => node.tagName === 'OPTGROUP')
      .map(node => [node.label, node]));
    const children = [], groups = new Map();
    for (const entry of entries) {
      const node = oldOptions.get(entry.value) || select.ownerDocument.createElement('option');
      // An explicit empty value differs from an absent value attribute: without
      // it, changing the label also changes the option's submitted value.
      if (node.getAttribute('value') !== entry.value) node.value = entry.value;
      text(node, entry.label);
      if (node.disabled !== !!entry.disabled) node.disabled = !!entry.disabled;
      if (!entry.group) { children.push(node); continue; }
      if (!groups.has(entry.group)) {
        const group = oldGroups.get(entry.group) || select.ownerDocument.createElement('optgroup');
        if (group.label !== entry.group) group.label = entry.group;
        groups.set(entry.group, { node: group, children: [] });
        children.push(group);
      }
      groups.get(entry.group).children.push(node);
    }
    for (const group of groups.values()) syncChildren(group.node, group.children);
    syncChildren(select, children);
  }

  const effortLabels = Object.freeze({
    '': '默认', default: '默认', minimal: '最低', low: '低', medium: '中',
    high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra', none: '无', off: '关闭',
  });

  function effortChoiceLabel(choice) {
    return Object.hasOwn(effortLabels, choice.value) ? effortLabels[choice.value] : choice.label;
  }

  function toggle(doc, className, title, checked) {
    const label = doc.createElement('label');
    label.className = 'rc-check';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.className = className;
    input.checked = checked;
    label.append(input, doc.createTextNode(title));
    return { label, input };
  }

  // 会话里存的是线路池本身；胶囊上的预设名靠两件事找回：保存时记下的
  // presetId，和给老数据兜底的池子指纹。指纹只比真正决定路由的三件事 ——
  // 线路、模型、是否自动挑模型 —— 加上优先级顺序；cli 只在两边都写了时才比：
  // 老版 Auto Provider 编辑器存预设时会把 cli 丢掉（rememberPreset 只留
  // providerId/model/priority），拿空串和真实车道全等会让旧预设永远匹配不上。
  function poolRows(list, clean) {
    return (Array.isArray(list) ? list : [])
      .filter(item => item && item.enabled !== false)
      .slice()
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      .map(item => ({
        providerId: clean(item.providerId), model: clean(item.model), ...reasoningValues(item),
        autoModel: item.autoModel === true, cli: clean(item.cli),
      }));
  }

  function reasoningValues(record) {
    const legacy = record.effort === 'ultracode';
    return { effort: legacy ? 'xhigh' : String(record.effort || '').trim(), claudeWorkflow: record.claudeWorkflow === true || legacy };
  }

  function sameRow(row, other) {
    return !!row && !!other && row.providerId === other.providerId && row.model === other.model
      && row.effort === other.effort && row.claudeWorkflow === other.claudeWorkflow && row.autoModel === other.autoModel && (!row.cli || !other.cli || row.cli === other.cli);
  }

  function samePool(left, right) {
    return left.length === right.length && left.every((row, index) => sameRow(row, right[index]));
  }

  // 池子是预设的子集：从预设里删掉一条（或那条当时跑不了）之后，剩下的线路
  // 仍按原优先级顺序出现在预设里。
  function poolIsSubset(pool, preset) {
    let index = 0;
    for (const row of pool) {
      while (index < preset.length && !sameRow(row, preset[index])) index += 1;
      if (index >= preset.length) return false;
      index += 1;
    }
    return pool.length > 0;
  }

  function reasoningPreferences(doc, config, tt) {
    const legacy = config.effort === 'ultracode';
    const workflow = toggle(doc, 'rc-workflow', tt('claudeDynamicWorkflow', 'Claude 动态工作流'), config.claudeWorkflow === true || legacy);
    const subtasks = toggle(doc, 'rc-prefer-subtasks', tt('preferSubtasks', '多用子任务'), config.preferSubtasks === true);
    return { workflow, subtasks, fields(allowWorkflow) {
      const enabled = allowWorkflow && workflow.input.checked;
      return {
        ...(enabled || config.claudeWorkflow || legacy ? { claudeWorkflow: enabled } : {}),
        ...(subtasks.input.checked || config.preferSubtasks ? { preferSubtasks: subtasks.input.checked } : {}),
      };
    } };
  }

  function renderEffortPicker(host, segButton, options, selected, fallback, onSelect) {
    host.replaceChildren();
    if (!options.length) return null;
    const values = options.map(choice => choice.value);
    if (!values.includes(selected)) selected = values.includes(fallback) ? fallback : values[0];
    for (const choice of options) {
      const button = segButton(host.ownerDocument, host, `rc-effort-${choice.value}`, effortChoiceLabel(choice), choice.desc);
      button.dataset.value = choice.value;
      button.onclick = () => onSelect(choice.value);
      button.setAttribute('aria-checked', String(choice.value === selected));
      button.classList.toggle('on', choice.value === selected);
    }
    return selected;
  }

  function createModelPicker({ select, custom, search, ai, customLabel }) {
    let binding = null, entries = [], customEdited = false;
    select.addEventListener('change', () => { customEdited = select.value === '__custom__'; });
    custom.addEventListener('input', () => { customEdited = true; });
    function paint(keep) {
      const needle = search.value.trim().toLowerCase();
      syncOptions(select, entries.filter(item => !needle || !item.value
        || item.value === '__custom__' || item.value === keep
        || `${item.label} ${item.value}`.toLowerCase().includes(needle)));
    }
    search.oninput = () => { const keep = select.value; paint(keep); setValue(select, keep); };
    return {
      update(value, cli, preferred, state) {
        const key = JSON.stringify([cli, value]);
        const same = key === binding;
        const editing = same && (customEdited || custom.ownerDocument.activeElement === custom)
          && select.value === '__custom__' && custom.value.trim() === preferred;
        binding = key;
        if (!same) { setValue(search, ''); customEdited = false; }
        let choices = ai.buildModelChoices(value, state);
        choices = [...new Set(Array.isArray(choices) && choices.length ? choices : ['', '__custom__'])];
        entries = choices.map(choice => ({ value: choice,
          label: choice === '__custom__' ? customLabel() : ai.modelChoiceLabel(choice, value, state),
          group: ai.modelChoiceGroup ? ai.modelChoiceGroup(choice, state) : '',
        }));
        search.hidden = !search.value && choices.filter(choice => choice && choice !== '__custom__').length <= 12;
        let wanted = ai.normalizeModel(value, preferred || '', state);
        if (!wanted) wanted = ai.defaultModelChoice(value, state) || '';
        const known = choices.includes(wanted);
        const chosen = editing ? '__custom__' : known ? wanted
          : wanted && choices.includes('__custom__') ? '__custom__' : choices[0];
        paint(chosen);
        setValue(select, chosen);
        if (!editing) setValue(custom, known ? '' : wanted);
        custom.hidden = select.value !== '__custom__';
      },
    };
  }

  // A row's draft object is its identity, so duplicate providers and reordering
  // stay distinct. Event handlers read the latest projection, never an old index.
  function createPoolList({ host, el, mark, tt, onCli, onModel, onCustom, onEffort, onWorkflow, onTier, onRemove, onMove }) {
    const doc = host.ownerDocument, views = new Map();
    let dragged = null;
    function create() {
      const node = el(doc, 'div', 'rc-row'), rank = el(doc, 'span', 'rc-rank');
      node.draggable = true;
      const main = el(doc, 'div', 'rc-row-main'), first = el(doc, 'div', 'rc-row-l1');
      const chip = el(doc, 'span', 'rc-cli-chip'), cli = el(doc, 'select', 'rc-chip rc-row-cli');
      cli.setAttribute('aria-label', tt('runConfigRowCli', '用哪个 CLI 跑这条线路'));
      chip.append(cli);
      const name = el(doc, 'b', 'rc-line-name');
      first.append(chip, name);
      const second = el(doc, 'div', 'rc-row-l2'), issue = el(doc, 'span', 'rc-issue');
      const model = el(doc, 'select', 'rc-select rc-row-model'), custom = el(doc, 'input', 'rc-row-model-custom');
      model.setAttribute('aria-label', tt('runConfigRowModel', '模型'));
      custom.maxLength = 100;
      const effort = el(doc, 'select', 'rc-select rc-row-effort');
      effort.setAttribute('aria-label', tt('runConfigEffortLabel', '推理强度'));
      const workflow = toggle(doc, 'rc-row-workflow', tt('claudeDynamicWorkflow', 'Claude 动态工作流'), false);
      const tier = el(doc, 'select', 'rc-select rc-row-tier');
      tier.setAttribute('aria-label', tt('runConfigRowTier', '档位'));
      const ops = el(doc, 'span', 'rc-ops'), handle = el(doc, 'button', 'rc-handle', '⠿');
      handle.type = 'button'; handle.title = tt('runConfigRowDrag', '拖动排序');
      const remove = el(doc, 'button', 'rc-remove', '✕');
      remove.type = 'button'; remove.title = tt('runConfigRowRemove', '移除这条线路');
      ops.append(handle, remove); main.append(first, second); node.append(rank, main, ops);
      const view = { node, rank, chip, cli, name, first, second, issue, model, custom, effort, workflow, tier, item: null, badge: null, icon: null };
      cli.onchange = () => onCli(view.item.key, cli.value);
      model.onchange = () => { view.customEdited = model.value === '__custom__'; if (view.customEdited) custom.value = ''; custom.hidden = !view.customEdited; onModel(view.item.key, model.value); };
      custom.oninput = () => { view.customEdited = true; onCustom(view.item.key, custom.value); };
      workflow.input.onchange = () => onWorkflow(view.item.key, workflow.input.checked);
      effort.onchange = () => onEffort(view.item.key, effort.value);
      tier.onchange = () => onTier(view.item.key, tier.value);
      remove.onclick = () => onRemove(view.item.key);
      node.ondragstart = event => { dragged = view.item.key; if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
      node.ondragover = event => { event.preventDefault(); node.classList.add('rc-drop'); };
      node.ondragleave = () => node.classList.remove('rc-drop');
      node.ondragend = () => { dragged = null; node.classList.remove('rc-drop'); };
      node.ondrop = event => {
        event.preventDefault(); node.classList.remove('rc-drop');
        if (dragged) onMove(dragged, view.item.key);
        dragged = null;
      };
      return view;
    }
    return {
      update(items) {
        const keys = new Set(items.map(item => item.key));
        for (const [key, view] of views) if (!keys.has(key)) { view.node.remove(); views.delete(key); }
        const nodes = items.map((item, index) => {
          const view = views.get(item.key) || create();
          views.set(item.key, view);
          const same = view.item && view.item.cli === item.cli;
          const editing = same && (view.customEdited || doc.activeElement === view.custom)
            && view.model.value === '__custom__' && view.custom.value.trim() === item.wanted;
          if (!same) view.customEdited = false;
          view.item = item;
          view.node.dataset.providerId = item.id; view.node.dataset.cli = item.cli;
          text(view.rank, String(index + 1)); text(view.name, item.name);
          if (!same) { view.icon?.remove(); view.icon = mark(doc, item.cli, 's'); view.chip.insertBefore(view.icon, view.cli); }
          syncOptions(view.cli, item.clis); setValue(view.cli, item.cli);
          if (view.cli.title !== item.cliTitle) view.cli.title = item.cliTitle;
          if (item.badge) {
            if (!view.badge) { view.badge = item.badge; view.first.append(view.badge); }
            else { text(view.badge, item.badge.textContent); view.badge.title = item.badge.title; view.badge.style.cssText = item.badge.style.cssText; }
          } else { view.badge?.remove(); view.badge = null; }
          view.node.classList.toggle('rc-warn', !!item.issue);
          if (item.issue) {
            text(view.issue, `⚠ ${item.issue}`); syncChildren(view.second, [view.issue]);
          } else {
            syncOptions(view.model, item.models);
            const known = item.models.some(choice => choice.value === item.wanted);
            const chosen = editing ? '__custom__' : known ? item.wanted : item.wanted ? '__custom__' : item.models[0].value;
            setValue(view.model, chosen);
            if (!editing) setValue(view.custom, known ? '' : item.wanted);
            view.custom.hidden = chosen !== '__custom__';
            view.workflow.input.checked = item.workflowEnabled;
            syncOptions(view.effort, item.efforts); setValue(view.effort, item.effort);
            syncOptions(view.tier, item.tiers); setValue(view.tier, item.tier);
            syncChildren(view.second, [view.model, view.custom, ...(item.efforts.length ? [view.effort] : []), ...(item.showWorkflow ? [view.workflow.label] : []), ...(item.tiers.length ? [view.tier] : [])]);
          }
          return view.node;
        });
        const scroll = host.scrollTop;
        syncChildren(host, nodes);
        host.scrollTop = scroll;
      },
    };
  }

  function createSubagentSummaries({ tt, clean, subagentFamilyLabel }) {
    // 同步预览（dry run）→ 状态行文案。preview 的形状：
    //   { state:'loading' }
    //   { state:'ready', family, counts:{applied,deferred,unchanged,skipped,kept} }
    //   { state:'error', error }
    //   { state:'unavailable' }   ← 503：服务端加载的原生模块还是旧的，没有同步接口
    // 只产出 {tone, text}，不碰 DOM —— tests/test-run-config.js 直接调。
    function syncSummary(preview) {
      if (!preview || typeof preview !== 'object') return { tone: 'idle', text: '' };
      if (preview.state === 'loading') {
        return { tone: 'loading', text: tt('runConfigSyncChecking', '正在检查要更新的任务…') };
      }
      if (preview.state === 'error') {
        return { tone: 'error', text: tt('runConfigSyncPreviewFailed', '无法读取同步预览：{error}', { error: clean(preview.error) }) };
      }
      if (preview.state === 'unavailable') {
        return { tone: 'error', text: tt('runConfigSyncUnavailable', '服务端加载的原生模块是旧版本，暂不支持同步。重启一次 MultiCC 会自动按当前代码重新编译加载，之后改这个设置不需要再重启。') };
      }
      const counts = preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
      const applied = Number(counts.applied) || 0;
      const deferred = Number(counts.deferred) || 0;
      const skipped = Number(counts.skipped) || 0;
      const kept = Number(counts.kept) || 0;
      const total = applied + deferred;
      // 单独设置过子 agent 的任务同步不碰：单独说一句，免得以为漏了。
      const suffix = (kept > 0 ? tt('runConfigSyncKeptSuffix', '，{k} 个单独设置过的保持不变', { k: kept }) : '')
        + (skipped > 0 ? tt('runConfigSyncSkippedSuffix', '，{k} 个跳过', { k: skipped }) : '');
      if (total > 0) {
        return {
          tone: 'ready',
          text: (total === 1
            ? tt('runConfigSyncPreviewOne', '将更新 1 个任务')
            : tt('runConfigSyncPreview', '将更新 {n} 个任务', { n: total })) + suffix,
        };
      }
      return {
        tone: 'ready',
        text: tt('runConfigSyncNothing', '没有需要更新的 {cli} 任务',
          { cli: subagentFamilyLabel(preview.family) || '' }) + suffix,
      };
    }

    // 清除全局默认前的确认文案（清除的 dry run 计数）：恢复随主的是跟随全局的任务。
    function clearSummary(preview) {
      const counts = preview && preview.counts && typeof preview.counts === 'object' ? preview.counts : {};
      return tt('runConfigClearPreview', '清除后 {n} 个跟随全局的 {cli} 任务恢复随主，新建任务也不再默认使用；单独设置过的 {k} 个不受影响。', {
        n: (Number(counts.applied) || 0) + (Number(counts.deferred) || 0), k: Number(counts.kept) || 0,
        cli: subagentFamilyLabel(preview && preview.family) || '' });
    }

    return { syncSummary, clearSummary };
  }

  // ── 会话账户行（Command Code / OpenCode API Key 账户 + Antigravity HOME 隔离账号）──
  const ACCOUNT_CLIS = Object.freeze(['commandcode', 'opencode', 'agy']);
  const OPENCODE_ACCOUNT_LINES = Object.freeze(['opencode', 'opencode-go', 'opencodego']);
  const ACCOUNT_ADD_VALUE = '__add_account__';
  const AGY_ID_RE = /^[a-f0-9]{16}$/;

  function createAccountSection({
    doc, el, option, show, tt, scope, request, entry, config, fixedStatus,
    getCli, getProvider, isNativeLine, nativeLineId, providerless, cliLabel, onChanged, onModelCatalog, isAlive,
  }) {
    let accountPicks = { ...(config.cliAccounts || {}) };
    let accountPicksReady = !entry.sessionId || config.cliAccounts !== undefined;
    const accountTouched = new Set();
    const accountLists = new Map(); // cli → 账户数组 | null（加载中）| Error
    let accountVanished = '';
    let commandcodeLogin;
    let commandcodeLoginLoading = false;
    let catalogAccount = '';
    let pinnedCatalog = null;
    let catalogRequest = 0;
    let loadingCatalog = false;
    async function loadPinnedCatalog(force = false) {
      const id = lane() === 'agy' ? accountPicks.agy || '' : '';
      if (!force && id === catalogAccount) return pinnedCatalog?.models || [];
      const marker = ++catalogRequest;
      catalogAccount = id;
      pinnedCatalog = id ? { models: [] } : null;
      loadingCatalog = !!id;
      if (id) {
        try {
          const data = await request('/api/agy/models?accountId=' + encodeURIComponent(id) +
            (force ? '&refresh=1' : ''), undefined, 'GET');
          if (marker !== catalogRequest) return [];
          if (Array.isArray(data?.models)) {
            pinnedCatalog = data;
            scope()?.MultiCCProviderCatalog?.readAgyEfforts(data.efforts?.agy, id);
          }
        } catch (_) { /* The picker falls back to the offline options. */ }
      }
      if (marker === catalogRequest) {
        loadingCatalog = false;
        if (!isAlive || isAlive()) onModelCatalog?.();
      }
      return pinnedCatalog?.models || [];
    }
    let agyMeta = null; // { active, local }
    let agyLoading = false;

    const field = el(doc, 'div', 'rc-field rc-account-field');
    field.append(el(doc, 'span', null, tt('runConfigAccountLabel', '账户')));
    const row = el(doc, 'div', 'rc-account-row');
    const select = el(doc, 'select', 'rc-account');
    select.setAttribute('aria-label', tt('runConfigAccountLabel', '账户'));
    const remove = el(doc, 'button', 'rc-account-delete', tt('runConfigAccountDelete', '删除'));
    remove.type = 'button';
    row.append(select, remove);

    const loginRow = el(doc, 'div', 'rc-account-login-row');
    const loginStatus = el(doc, 'span', 'rc-login-status');
    loginStatus.setAttribute('role', 'status');
    const loginBtn = el(doc, 'button', 'rc-account-login', tt('runConfigAccountLogin', '登录官方账号'));
    const loginRefresh = el(doc, 'button', 'rc-account-login-refresh', tt('runConfigAccountRefresh', '刷新登录状态'));
    loginBtn.type = loginRefresh.type = 'button';
    const loginLink = el(doc, 'a', 'rc-account-login-link', tt('runConfigAccountLoginOpen', '打开登录终端'));
    loginLink.target = '_blank';
    loginLink.rel = 'noopener';
    show(loginLink, false);
    loginRow.append(loginStatus, loginBtn, loginRefresh, loginLink);
    show(loginRow, false);

    // 内联添加表单：API Key 车道收名称+密钥；agy 车道只收名称，支持新建并登录或导入本机账号。
    const form = el(doc, 'div', 'rc-account-form');
    const nameInput = el(doc, 'input', 'rc-account-name');
    nameInput.type = 'text';
    nameInput.maxLength = 64;
    nameInput.placeholder = tt('runConfigAccountName', '名称（可选）');
    nameInput.setAttribute('aria-label', tt('runConfigAccountName', '名称（可选）'));
    const keyInput = el(doc, 'input', 'rc-account-key');
    keyInput.type = 'password';
    keyInput.maxLength = 512;
    keyInput.autocomplete = 'new-password';
    keyInput.placeholder = tt('runConfigAccountKey', 'API Key');
    keyInput.setAttribute('aria-label', tt('runConfigAccountKey', 'API Key'));
    const saveBtn = el(doc, 'button', 'rc-account-save primary', tt('runConfigAccountSave', '保存账户'));
    saveBtn.type = 'button';
    const importBtn = el(doc, 'button', 'rc-account-import', tt('airOfficialAcctAgyImport', '导入本机账号'));
    importBtn.type = 'button';
    show(importBtn, false);
    const cancelBtn = el(doc, 'button', 'rc-account-cancel', tt('runConfigCancel', '取消'));
    cancelBtn.type = 'button';
    form.append(nameInput, keyInput, saveBtn, importBtn, cancelBtn);
    show(form, false);

    const note = el(doc, 'p', 'rc-note');
    field.append(row, loginRow, form, note);

    function lane() {
      const cli = getCli();
      if (!ACCOUNT_CLIS.includes(cli)) return '';
      const provider = getProvider();
      // 挑了 MultiCC 线路或别家的原生线路时，opencode.ai 的 key 用不上，账户行就不摆出来。
      if (cli === 'opencode' && provider
        && !(isNativeLine(provider) && OPENCODE_ACCOUNT_LINES.includes(nativeLineId(provider)))) return '';
      return cli;
    }

    function applyAgyPayload(result) {
      const list = Array.isArray(result && result.accounts)
        ? result.accounts.filter(item => item && AGY_ID_RE.test(String(item.id || '')))
        : [];
      agyMeta = {
        active: (result && result.active) || null,
        local: (result && result.local) || null,
        cli: (result && result.cli) || null,
      };
      accountLists.set('agy', list);
      return list;
    }

    function title(account, cli = lane()) {
      const fallback = cli === 'agy'
        ? tt('airOfficialAcctAgyAccount', '反重力账号 {id}', { id: String(account.id).slice(0, 6) })
        : tt('runConfigAccountUnnamed', '账户 {id}', { id: String(account.id).slice(0, 6) });
      const name = account.label || fallback;
      if (cli === 'agy') {
        const suffix = account.loggedIn
          ? (account.email || tt('airOfficialAcctSignedIn', '已登录'))
          : tt('airOfficialAcctSignedOut', '未登录');
        return `${name} · ${suffix}`;
      }
      return [name, account.keyHint].filter(Boolean).join(' · ');
    }

    function picked() {
      const cli = lane();
      const list = cli ? accountLists.get(cli) : null;
      return Array.isArray(list) ? list.find(account => account.id === accountPicks[cli]) || null : null;
    }

    function loadAccounts(cli, force = false) {
      if (!force && accountLists.has(cli)) return;
      if (cli === 'agy') {
        if (agyLoading) return;
        agyLoading = true;
        if (!accountLists.has('agy')) accountLists.set('agy', null);
        request('/api/agy/accounts', undefined, 'GET').then(
          result => { applyAgyPayload(result); },
          cause => { accountLists.set('agy', cause instanceof Error ? cause : new Error(String(cause))); },
        ).then(() => {
          agyLoading = false;
          if ((!isAlive || isAlive()) && lane() === 'agy') { render(); onChanged(); }
        });
        return;
      }
      accountLists.set(cli, null);
      request(`/api/cli-accounts/${encodeURIComponent(cli)}`, undefined, 'GET').then(
        result => { accountLists.set(cli, Array.isArray(result.accounts) ? result.accounts : []); },
        cause => { accountLists.set(cli, cause instanceof Error ? cause : new Error(String(cause))); },
      ).then(() => { if ((!isAlive || isAlive()) && lane() === cli) { render(); onChanged(); } });
    }

    function refreshCommandcodeLogin() {
      if (commandcodeLoginLoading) return;
      commandcodeLoginLoading = true;
      commandcodeLogin = null;
      request('/api/commandcode/auth/status', undefined, 'GET').then(
        result => { commandcodeLogin = result; },
        cause => { commandcodeLogin = cause instanceof Error ? cause : new Error(String(cause)); },
      ).then(() => {
        commandcodeLoginLoading = false;
        if ((!isAlive || isAlive()) && lane() === 'commandcode') render();
      });
    }

    function openAgyLogin(id) {
      if (!id) return;
      const win = scope();
      const popup = win && typeof win.open === 'function' ? win.open('about:blank', '_blank') : null;
      if (popup) popup.opener = null;
      loginBtn.disabled = true;
      request(`/api/agy/accounts/${encodeURIComponent(id)}/login-terminal`, {}).then(result => {
        const url = (result && result.url) || (result && result.id ? `/?id=${encodeURIComponent(result.id)}` : '');
        if (url) {
          loginLink.href = url;
          show(loginLink, true);
          const target = (win && win.MultiCCMachineScope?.navigation(url)) || url;
          if (popup) popup.location.replace(target);
        } else if (popup) {
          popup.close();
        }
        loginStatus.textContent = tt('airOfficialAcctAgyLoginOpened', '已打开登录终端，请在其中完成 Google 登录，完成后点击“刷新状态”。');
      }, cause => {
        if (popup) popup.close();
        loginStatus.textContent = cause.message;
      }).then(() => { loginBtn.disabled = false; });
    }

    function defaultOptionLabel(cli, known) {
      if (cli !== 'agy') return tt('runConfigAccountLocal', '本机 CLI 登录（默认）');
      const activeId = agyMeta && agyMeta.active;
      if (activeId) {
        const activeAccount = known.find(item => item.id === activeId);
        const activeName = activeAccount
          ? (activeAccount.label || activeAccount.email || activeId.slice(0, 6))
          : activeId.slice(0, 6);
        return `跟随全局默认（${activeName}）`;
      }
      const localEmail = agyMeta && agyMeta.local && agyMeta.local.loggedIn && agyMeta.local.email;
      return localEmail ? `本机 agy 登录（${localEmail}）` : '本机 agy 登录（默认）';
    }

    function render() {
      const currentCli = getCli();
      const cli = lane();
      void loadPinnedCatalog();
      show(field, !!cli);
      if (!cli) {
        show(form, false);
        show(loginLink, false);
        fixedStatus.textContent = providerless(currentCli)
          ? tt('runConfigStatusOwn', '使用 {name} 自己的账号', { name: cliLabel(currentCli) }) : '';
        return;
      }
      loadAccounts(cli);
      const list = accountLists.get(cli);
      const known = Array.isArray(list) ? list : [];
      const currentPick = accountPicks[cli] || '';
      // 会话选过、账户文件却没了：保存时改回默认登录，并且说出来 —— 否则下一轮
      // 服务端会拒绝启动（它不会悄悄换成本机账户扣费）。
      if (currentPick && Array.isArray(list) && !known.some(account => account.id === currentPick)) {
        accountPicks = { ...accountPicks, [cli]: null };
        accountTouched.add(cli);
        accountVanished = cli;
      }
      const items = [option(doc, '', defaultOptionLabel(cli, known))];
      for (const account of known) items.push(option(doc, account.id, title(account, cli)));
      if (accountPicks[cli] && !Array.isArray(list)) items.push(option(doc, accountPicks[cli], tt('runConfigAccountLoading', '加载中…')));
      items.push(option(doc, ACCOUNT_ADD_VALUE, tt('runConfigAccountAdd', '＋ 添加账户…')));
      select.replaceChildren(...items);
      select.value = accountPicks[cli] || '';
      select.disabled = !accountPicksReady;

      const account = picked();
      show(remove, !!account);
      show(keyInput, cli !== 'agy');
      show(importBtn, cli === 'agy');
      saveBtn.textContent = cli === 'agy'
        ? tt('airOfficialAcctAgyCreate', '新建账号')
        : tt('runConfigAccountSave', '保存账户');

      show(loginRow, cli === 'commandcode' || cli === 'agy');
      if (cli === 'commandcode') {
        show(loginBtn, true);
        if (commandcodeLogin === undefined) refreshCommandcodeLogin();
        loginRefresh.disabled = commandcodeLoginLoading;
        loginRefresh.textContent = tt('runConfigAccountRefresh', '刷新登录状态');
        loginBtn.textContent = tt(commandcodeLogin && commandcodeLogin.credentialSaved ? 'runConfigAccountRelogin' : 'runConfigAccountLogin',
          commandcodeLogin && commandcodeLogin.credentialSaved ? '查看／登录官方账号' : '登录官方账号');
        loginStatus.textContent = commandcodeLogin instanceof Error
          ? tt('runConfigAccountLoginFailed', '无法读取登录状态，请重试。')
          : commandcodeLogin && commandcodeLogin.environmentKey
            ? tt('runConfigAccountLoginEnv', '当前默认使用环境变量中的 API Key，优先于本机账号。')
            : commandcodeLogin && commandcodeLogin.credentialSaved
              ? tt('runConfigAccountLoginSaved', '本机已保存登录：{name}（有效性以实际调用为准）', { name: commandcodeLogin.userName || 'Command Code' })
              : tt('runConfigAccountLoginMissing', '本机尚未保存官方账号登录。');
        if (commandcodeLoginLoading) loginStatus.textContent = tt('runConfigAccountLoading', '加载中…');
      } else if (cli === 'agy') {
        loginRefresh.disabled = agyLoading;
        loginRefresh.textContent = tt('runConfigAccountRefresh', '刷新登录状态');
        const agyCliMissing = !!(agyMeta && agyMeta.cli && agyMeta.cli.installed === false);
        const agyInstallCmd = (agyMeta && agyMeta.cli && agyMeta.cli.installCommand)
          || 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
        show(loginBtn, !!account && !agyCliMissing);
        if (agyCliMissing && (!account || account.kind !== 'remote')) {
          loginStatus.textContent = tt(
            'airOfficialAcctAgyCliMissingRunConfig',
            '本机尚未安装 Antigravity CLI（agy），请先运行 {command} 安装（或在 Provider 面板一键安装）。',
            { command: agyInstallCmd },
          );
        } else if (account) {
          loginBtn.textContent = tt(account.loggedIn ? 'airOfficialAcctAgyRelogin' : 'airOfficialAcctAgyLogin',
            account.loggedIn ? '重新登录' : '登录');
          const expired = account.loggedIn && account.expiresAt && account.expiresAt <= Date.now();
          loginStatus.textContent = agyLoading
            ? tt('runConfigAccountLoading', '加载中…')
            : account.loggedIn
              ? `已登录：${account.email || account.label || account.id.slice(0, 6)}${expired ? '（凭据已过期）' : ''}`
              : '该账号尚未完成 Google 登录，点击右侧按钮打开登录终端。';
        } else {
          const activeId = agyMeta && agyMeta.active;
          const activeAccount = activeId ? known.find(item => item.id === activeId) : null;
          loginStatus.textContent = agyLoading
            ? tt('runConfigAccountLoading', '加载中…')
            : activeId
              ? `当前全局默认：${activeAccount ? (activeAccount.label || activeAccount.email || activeId.slice(0, 6)) : activeId.slice(0, 6)}`
              : agyMeta && agyMeta.local && agyMeta.local.loggedIn
                ? `本机已登录：${agyMeta.local.email || 'Antigravity'}`
                : tt('airOfficialAcctAgyNoLocal', '本机还没有 agy 登录');
        }
      }

      note.textContent = list instanceof Error
        ? tt('runConfigAccountLoadFailed', '账户列表加载失败')
        : accountVanished === cli
          ? tt('runConfigAccountVanished', '之前选的账户已不存在，保存后改用本机 CLI 登录。')
          : cli === 'agy'
            ? '每个反重力账号使用独立 HOME（~/.gemini）隔离；此处选择仅作用于当前会话，留空则跟随全局默认。'
            : cli === 'opencode'
              ? tt('runConfigAccountHintOpencode', '添加时填 opencode.ai 的 API Key，Zen 与 Go 共用；只用于这个会话，不改本机配置。')
              : tt('runConfigAccountHintCommandcode', '官方账号通过登录按钮授权，选择“本机 CLI 登录”并保存后使用；影响所有复用本机登录的会话。添加 API Key 账户只用于所选会话。');
      fixedStatus.textContent = account
        ? tt('runConfigStatusAccount', '使用 {name} 账户「{account}」', { name: cliLabel(currentCli), account: account.label || String(account.id).slice(0, 6) })
        : providerless(currentCli) ? tt('runConfigStatusOwn', '使用 {name} 自己的账号', { name: cliLabel(currentCli) }) : '';
    }

    function setPick(cli, id) {
      accountPicks = { ...accountPicks, [cli]: id || null };
      accountTouched.add(cli);
      if (accountVanished === cli) accountVanished = '';
      show(loginLink, false);
      render();
      onChanged();
    }

    loginRefresh.onclick = () => {
      const cli = lane();
      if (cli === 'agy') { loadAccounts('agy', true); render(); }
      else { refreshCommandcodeLogin(); render(); }
    };
    loginBtn.onclick = () => {
      const cli = lane();
      if (cli === 'agy') {
        const account = picked();
        if (account) openAgyLogin(account.id);
        return;
      }
      const win = scope();
      const popup = win && typeof win.open === 'function' ? win.open('about:blank', '_blank') : null;
      if (popup) popup.opener = null;
      loginBtn.disabled = true;
      request('/api/commandcode/auth/login', {}).then(result => {
        const url = `/?id=${encodeURIComponent(result.sessionId)}`;
        loginLink.href = url;
        show(loginLink, true);
        if (popup) popup.location.replace((win && win.MultiCCMachineScope?.navigation(url)) || url);
        loginStatus.textContent = tt('runConfigAccountLoginHint', '在登录终端完成浏览器授权，回来点击“刷新登录状态”。远程访问时，请在运行 MultiCC 的电脑上完成授权。');
      }, cause => {
        if (popup) popup.close();
        loginStatus.textContent = cause.message;
      }).then(() => { loginBtn.disabled = false; });
    };

    select.onchange = () => {
      const cli = lane();
      if (!cli) return;
      if (select.value === ACCOUNT_ADD_VALUE) {
        select.value = accountPicks[cli] || '';
        show(form, true);
        nameInput.focus();
        return;
      }
      setPick(cli, select.value);
    };
    cancelBtn.onclick = () => {
      nameInput.value = '';
      keyInput.value = '';
      show(form, false);
      render();
    };
    saveBtn.onclick = () => {
      const cli = lane();
      if (!cli) return;
      if (cli === 'agy') {
        const before = new Set((Array.isArray(accountLists.get('agy')) ? accountLists.get('agy') : []).map(item => item.id));
        saveBtn.disabled = importBtn.disabled = true;
        request('/api/agy/accounts', { label: nameInput.value }).then(result => {
          const list = applyAgyPayload(result);
          const created = list.find(item => !before.has(item.id)) || list[list.length - 1] || null;
          nameInput.value = '';
          show(form, false);
          if (lane() === 'agy' && created) {
            setPick('agy', created.id);
            if (!(agyMeta && agyMeta.cli && agyMeta.cli.installed === false)) openAgyLogin(created.id);
          }
        }, cause => { note.textContent = cause.message; })
          .then(() => { saveBtn.disabled = importBtn.disabled = false; });
        return;
      }
      const apiKey = keyInput.value.trim();
      if (!apiKey) {
        note.textContent = tt('runConfigAccountKeyRequired', '先填 API Key。');
        keyInput.focus();
        return;
      }
      saveBtn.disabled = true;
      request(`/api/cli-accounts/${encodeURIComponent(cli)}`, { label: nameInput.value, apiKey }).then(result => {
        const list = accountLists.get(cli);
        accountLists.set(cli, [...(Array.isArray(list) ? list : []), result.account]);
        nameInput.value = '';
        keyInput.value = '';
        show(form, false);
        if (lane() === cli) setPick(cli, result.account.id);
      }, cause => { note.textContent = cause.message; })
        .then(() => { saveBtn.disabled = false; });
    };
    importBtn.onclick = () => {
      if (lane() !== 'agy') return;
      const before = new Set((Array.isArray(accountLists.get('agy')) ? accountLists.get('agy') : []).map(item => item.id));
      saveBtn.disabled = importBtn.disabled = true;
      request('/api/agy/accounts/import', { label: nameInput.value }).then(result => {
        const list = applyAgyPayload(result);
        const created = list.find(item => !before.has(item.id)) || list[list.length - 1] || null;
        nameInput.value = '';
        show(form, false);
        if (lane() === 'agy' && created) setPick('agy', created.id);
      }, cause => { note.textContent = cause.message; })
        .then(() => { saveBtn.disabled = importBtn.disabled = false; });
    };
    for (const input of [nameInput, keyInput]) {
      input.onkeydown = event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveBtn.click();
      };
    }
    remove.onclick = () => {
      const cli = lane();
      const account = picked();
      if (!cli || !account) return;
      const confirmFn = scope() && typeof scope().confirm === 'function' ? scope().confirm : (typeof confirm === 'function' ? confirm : null);
      const confirmed = !confirmFn || confirmFn(tt('runConfigAccountDeleteConfirm',
        '删除账户「{name}」？选了它的会话都会改回本机 CLI 登录。', { name: title(account, cli) }));
      if (!confirmed) return;
      remove.disabled = true;
      const deleteUrl = cli === 'agy'
        ? `/api/agy/accounts/${encodeURIComponent(account.id)}`
        : `/api/cli-accounts/${encodeURIComponent(cli)}/${encodeURIComponent(account.id)}`;
      request(deleteUrl, undefined, 'DELETE').then(result => {
        if (cli === 'agy' && result && Array.isArray(result.accounts)) {
          applyAgyPayload(result);
        } else {
          const list = accountLists.get(cli);
          accountLists.set(cli, (Array.isArray(list) ? list : []).filter(item => item.id !== account.id));
        }
        accountPicks = { ...accountPicks, [cli]: null };
        show(loginLink, false);
        render();
        onChanged();
      }, cause => { note.textContent = cause.message; })
        .then(() => { remove.disabled = false; });
    };

    return {
      field,
      render,
      picked,
      title,
      patch() {
        const cli = lane();
        return cli && accountTouched.has(cli) ? { [cli]: accountPicks[cli] || null } : null;
      },
      get agyCatalog() { return pinnedCatalog; }, loadPinnedCatalog,
      awaitingAgy(cli) {
        return cli === 'agy' && (!accountPicksReady || loadingCatalog || (accountPicks.agy && accountPicks.agy !== catalogAccount));
      },
      effortOptions(ai, cli, model) {
        const id = cli === 'agy' && accountPicks.agy;
        return ai.effortOptions(cli, model || (id && pinnedCatalog?.current?.model), id
          ? scope()?.MultiCCProviderCatalog?.agyAccountEfforts(id) : undefined);
      },
      draftPicks() {
        const picks = Object.fromEntries(Object.entries(accountPicks).filter(([, id]) => id));
        return Object.keys(picks).length ? picks : null;
      },
      boot() {
        if (accountPicksReady) return;
        request(`/api/sessions/${encodeURIComponent(entry.sessionId)}`, undefined, 'GET').then(
          detail => { accountPicks = { ...(detail && detail.cliAccounts || {}), ...accountPicks }; },
          () => { /* 读不到现值：只写用户动过的车道，保持安全 */ },
        ).then(() => { accountPicksReady = true; render(); if (lane() === 'agy' && !accountPicks.agy) onModelCatalog?.(); onChanged(); });
      },
    };
  }

  return Object.freeze({ createAccountSection, createCatalogLoader, createModelPicker, createPoolList, createSubagentSummaries, effortChoiceLabel, poolRows, reasoningValues, samePool, poolIsSubset, reasoningPreferences, renderEffortPicker, syncOptions });
});

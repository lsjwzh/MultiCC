'use strict';

// ── 钩子（事件触发器）规则表单（public/hook-editor.js）─────────────────────────
// 会话页头的 🪝 和定时任务中心「触发器」tab 共用的唯一一张表单：
//   当 [事件…] 发生时 → 执行 [动作] → 然后依次执行 [后续步骤…]（链式，见 src/events/engine.js）
// 两个入口只在默认范围上不同（会话入口固定为本会话，触发器 tab 可选全局/指定会话），
// 所以表单、校验、保存、测试都只写这一份，免得两边漂移。后端见 src/events/。
//
// 自带 <dialog> 与样式、不依赖宿主页面的 HTML：chat.html 与 air.html 都只需要
// 引一个 <script>。传给下一个动作的参数是后端拼好的固定信封（来源会话 id、事件、
// 目标、状态、上一轮结论…），这里不让用户定义变量，只写「你的指令」。
(function initHookEditor(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const tr = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const client = () => root.MultiCCApi;
  const request = (path, options) => client().json(path, options);
  const errorText = error => (client() && typeof client().errorText === 'function'
    ? client().errorText(error) : (error && error.message) || String(error));

  // 别名放最前（两个最常用的“组合”），其后是单个事件。value 是后端的事件模式。
  const EVENT_OPTIONS = Object.freeze([
    ['task.done', 'hookEvDone'],
    ['task.attention', 'hookEvAttention'],
    ['task.achieved', 'hookEvAchieved'],
    ['task.needs_interaction', 'hookEvNeeds'],
    ['task.finished', 'hookEvFinished'],
    ['task.waiting_user', 'hookEvWaitingUser'],
    ['task.waiting_background', 'hookEvWaitingBg'],
    ['task.failed', 'hookEvFailed'],
    ['task.running', 'hookEvRunning'],
    ['turn.completed', 'hookEvTurn'],
  ]);
  const NEW_SESSION = '__new__'; // 「注入到」里代表“每次触发新建一个会话”的哨兵值
  const MAX_CHAIN_STEPS = 9;     // 与 src/events/rules.js 一致
  const ACTION_OPTIONS = Object.freeze([
    ['notify', 'hookActNotify'],
    ['webhook', 'hookActWebhook'],
    ['inject-prompt', 'hookActInject'],
    ['channel', 'hookActChannel'],   // 发到渠道（微信等通知渠道插件，design 10.4）
  ]);

  // 选择器都带 dialog.hook-dialog 前缀：Air 的全局 `input{width:100%}`、`dialog label{margin-top}`
  // 与 chat 页各自的表单样式都比单个类名更“具体”，不压住它们复选框会被撑成整行。
  const STYLE = `
dialog.hook-dialog{width:calc(100% - 32px);max-width:560px;padding:0;border:1px solid #d6e2ee;border-radius:14px;background:#fbfdff;color:#294760;font-size:13px}
dialog.hook-dialog::backdrop{background:rgba(32,52,74,.35)}
dialog.hook-dialog form{display:flex;flex-direction:column;gap:12px;padding:20px 22px;margin:0}
dialog.hook-dialog h2{margin:0;font-size:17px}
dialog.hook-dialog label,dialog.hook-dialog fieldset{display:flex;flex-direction:column;align-items:stretch;gap:5px;margin:0;padding:0;border:0;font-size:13px}
dialog.hook-dialog legend{padding:0;margin:0 0 6px;font-size:13px;font-weight:600}
dialog.hook-dialog label>span{display:block}
dialog.hook-dialog input:not([type=checkbox]),dialog.hook-dialog select,dialog.hook-dialog textarea{box-sizing:border-box;width:100%;margin:0;font:inherit;padding:8px 10px;border:1px solid #c9d7e5;border-radius:8px;background:#fff;color:inherit}
dialog.hook-dialog .hook-events{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-bottom:8px}
dialog.hook-dialog label.hook-check{flex-direction:row;align-items:center;justify-content:flex-start;gap:8px}
dialog.hook-dialog label.hook-check>input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;margin:0;padding:0}
dialog.hook-dialog label.hook-check>span{flex:1;min-width:0}
dialog.hook-dialog [data-kind],dialog.hook-dialog [data-newsession]{display:flex;flex-direction:column;gap:12px}
dialog.hook-dialog [hidden]{display:none !important}
dialog.hook-dialog .hook-note{margin:0;color:#6b7f93;font-size:12px;line-height:1.5}
dialog.hook-dialog .hook-error{margin:0;min-height:1em;color:#c0392b;font-size:12px}
dialog.hook-dialog .hook-actions{display:flex;justify-content:flex-end;gap:8px}
dialog.hook-dialog .hook-head{display:flex;justify-content:space-between;align-items:center}
dialog.hook-dialog .hook-head button{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#718398}
dialog.hook-dialog .hook-chain-step{display:flex;gap:6px;align-items:flex-start}
dialog.hook-dialog .hook-chain-step>b{flex:0 0 auto;padding-top:8px;min-width:18px;color:#6b7f93}
dialog.hook-dialog .hook-chain-step>textarea,dialog.hook-dialog .hook-chain-step>span{flex:1;min-width:0}
dialog.hook-dialog .hook-chain-step>span{padding-top:8px}
dialog.hook-dialog .hook-chain-step>button{flex:0 0 auto;border:0;background:transparent;font-size:18px;line-height:1;padding:6px 4px;cursor:pointer;color:#c0392b}
dialog.hook-dialog #hook-chain{display:flex;flex-direction:column;gap:6px}
dialog.hook-dialog #hook-chain-add{align-self:flex-start;font:inherit;padding:4px 10px;border:1px dashed #9fb5ca;border-radius:8px;background:#fff;color:inherit;cursor:pointer}
@media (max-width:520px){dialog.hook-dialog .hook-events{grid-template-columns:1fr}}
`;

  function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'text') element.textContent = value;
      else if (key === 'class') element.className = value;
      else element.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child) element.append(child);
    return element;
  }

  let dialog = null;
  let form = null;
  let session = null;   // { id, label } fixed owner when opened from a chat page
  let editing = null;   // the item being edited: { scope, sessionId, rule }
  let sessionChoices = [];
  let channels = [];   // [{ plugin, label, labelEn, ready, error?, targets:[{id,name,status}] }]
  let dirChoices = [];
  let cliChoices = [];
  let onSaved = null;

  function ensureDialog() {
    if (dialog) return;
    const style = h('style');
    style.textContent = STYLE;
    document.head.append(style);

    const events = h('div', { class: 'hook-events' }, EVENT_OPTIONS.map(([value, key]) => h('label', { class: 'hook-check' },
      h('input', { type: 'checkbox', name: 'ev', value }), h('span', { text: tr(key) }))));
    form = h('form', { method: 'dialog' },
      h('div', { class: 'hook-head' }, h('h2', { id: 'hook-title' }),
        h('button', { type: 'button', id: 'hook-close', 'aria-label': tr('airDlgClose') }, '×')),
      h('label', { id: 'hook-scope-row' }, h('span', { text: tr('hookScope') }),
        h('select', { name: 'scope' }),
        h('input', { type: 'search', name: 'scopeFilter', placeholder: tr('hookSessionSearch'), autocomplete: 'off' }),
        h('select', { name: 'scopeSession' })),
      h('label', {}, h('span', { text: tr('hookName') }), h('input', { type: 'text', name: 'name', maxlength: '80' })),
      h('fieldset', {}, h('legend', { text: tr('hookWhen') }), events,
        h('label', { class: 'hook-check' }, h('input', { type: 'checkbox', name: 'skipCancelled' }),
          h('span', { text: tr('hookSkipCancelled') }))),
      h('label', {}, h('span', { text: tr('hookThen') }),
        h('select', { name: 'kind' }, ACTION_OPTIONS.map(([value, key]) => h('option', { value, text: tr(key) })))),
      h('div', { 'data-kind': 'notify' }, h('label', {}, h('span', { text: tr('hookNotifyMessage') }),
        h('input', { type: 'text', name: 'message', maxlength: '400' }))),
      h('div', { 'data-kind': 'webhook' },
        h('label', {}, h('span', { text: tr('hookWebhookUrl') }),
          h('input', { type: 'url', name: 'url', maxlength: '2000', placeholder: 'https://' })),
        h('label', {}, h('span', { text: tr('hookWebhookSecret') }), h('select', { name: 'secretName' })),
        h('label', { class: 'hook-check' }, h('input', { type: 'checkbox', name: 'includeConclusion' }),
          h('span', { text: tr('hookIncludeConclusion') }))),
      h('div', { 'data-kind': 'channel' },
        h('label', {}, h('span', { text: tr('hookChannelPlugin') }), h('select', { name: 'channelPlugin' })),
        h('label', {}, h('span', { text: tr('hookChannelTarget') }), h('select', { name: 'channelTarget' })),
        h('p', { class: 'hook-error', id: 'hook-channel-problem', role: 'status' }),
        h('label', {}, h('span', { text: tr('hookChannelMessage') }),
          h('textarea', { name: 'channelMessage', rows: '2', maxlength: '400', placeholder: tr('hookChannelMessagePh') })),
        h('p', { class: 'hook-note', text: tr('hookChannelHint') })),
      h('div', { 'data-kind': 'inject-prompt' },
        h('label', {}, h('span', { text: tr('hookInjectTarget') }),
          h('input', { type: 'search', name: 'targetFilter', placeholder: tr('hookSessionSearch'), autocomplete: 'off' }),
          h('select', { name: 'target' })),
        h('div', { 'data-newsession': true },
          h('label', {}, h('span', { text: tr('hookNewDir') }), h('select', { name: 'newDir' })),
          h('label', {}, h('span', { text: tr('hookNewCli') }), h('select', { name: 'newCli' })),
          h('label', {}, h('span', { text: tr('hookNewTitle') }), h('input', { type: 'text', name: 'newTitle', maxlength: '120' })),
          h('p', { class: 'hook-note', text: tr('hookNewHint') })),
        h('label', {}, h('span', { text: tr('hookInjectPrompt') }),
          h('textarea', { name: 'prompt', rows: '4', maxlength: '4000', placeholder: tr('hookInjectPromptPh') })),
        h('p', { class: 'hook-note', text: tr('hookInjectHint') })),
      h('fieldset', {}, h('legend', { text: tr('hookChain') }),
        h('div', { id: 'hook-chain' }),
        h('button', { type: 'button', id: 'hook-chain-add', text: tr('hookChainAdd') }),
        h('p', { class: 'hook-note', text: tr('hookChainHint') })),
      h('label', {}, h('span', { text: tr('hookCooldown') }),
        h('input', { type: 'number', name: 'cooldown', min: '0', max: '86400', step: '1' })),
      h('label', { class: 'hook-check' }, h('input', { type: 'checkbox', name: 'once' }),
        h('span', { text: tr('hookOnce') })),
      h('p', { class: 'hook-note', text: tr('hookOnceHint') }),
      h('label', { class: 'hook-check' }, h('input', { type: 'checkbox', name: 'enabled', checked: true }),
        h('span', { text: tr('hookEnabled') })),
      h('p', { class: 'hook-error', id: 'hook-error', role: 'alert' }),
      h('div', { class: 'hook-actions' },
        h('button', { type: 'button', id: 'hook-cancel', text: tr('cancel') }),
        h('button', { type: 'submit', id: 'hook-save', class: 'primary', text: tr('hookSave') })));
    dialog = h('dialog', { class: 'hook-dialog' }, form);
    document.body.append(dialog);

    form.elements.kind.onchange = syncKind;
    form.elements.channelPlugin.onchange = () => syncChannel('');
    form.elements.channelTarget.onchange = () => syncChannel(form.elements.channelTarget.value);
    form.elements.target.onchange = syncTarget;
    form.elements.targetFilter.oninput = () => renderFiltered(form.elements.target);
    form.elements.scopeFilter.oninput = () => renderFiltered(form.elements.scopeSession);
    form.elements.scope.onchange = syncScope;
    form.querySelector('#hook-chain-add').onclick = () => { addChainStep({ kind: 'inject-prompt', prompt: '' }).querySelector('textarea').focus(); };
    form.querySelector('#hook-close').onclick = () => dialog.close();
    form.querySelector('#hook-cancel').onclick = () => dialog.close();
    form.onsubmit = event => { event.preventDefault(); void save(); };
  }

  // 后续步骤：表单里只编辑「注入指令」（注入到上一步所在的会话）；经 API 建的
  // 通知 / Webhook / 指定目标步骤原样保留、只能删除，免得编辑一次就把它们抹掉。
  function addChainStep(step) {
    const list = form.querySelector('#hook-chain');
    const editable = step.kind === 'inject-prompt' && !step.targetSessionId && !step.newSession;
    const row = h('div', { class: 'hook-chain-step' }, h('b'),
      editable
        ? h('textarea', { name: 'chainPrompt', rows: '2', maxlength: '4000' })
        : h('span', { text: tr('hookChainKept', { kind: actionName(step.kind) }) }),
      h('button', { type: 'button', 'aria-label': tr('hookChainRemove'), title: tr('hookChainRemove'), text: '×' }));
    row._step = step;
    if (editable) row.querySelector('textarea').value = step.prompt || '';
    row.querySelector('button').onclick = () => { row.remove(); syncChain(); };
    list.append(row);
    syncChain();
    return row;
  }

  function syncChain() {
    const rows = [...form.querySelectorAll('.hook-chain-step')];
    rows.forEach((row, index) => {
      row.querySelector('b').textContent = `${index + 2}.`;
      const area = row.querySelector('textarea');
      if (area) area.placeholder = tr('hookChainStepPh', { n: index + 2 });
    });
    form.querySelector('#hook-chain-add').hidden = rows.length >= MAX_CHAIN_STEPS;
  }

  function collectChain() {
    const steps = [];
    for (const row of form.querySelectorAll('.hook-chain-step')) {
      const area = row.querySelector('textarea');
      if (!area) { steps.push(row._step); continue; }
      const prompt = area.value.trim();
      if (!prompt) throw invalid(tr('hookErrChainEmpty'));
      steps.push({ kind: 'inject-prompt', prompt });
    }
    return steps;
  }

  function channelLabel(item) {
    const en = typeof root.getLang === 'function' && root.getLang() === 'en';
    return (en && item.labelEn) || item.label || item.name || item.plugin;
  }

  const targetStatus = status => (root.MultiCCPluginChannels ? root.MultiCCPluginChannels.statusText(status) : (status || ''));

  // 接收人下拉：来自插件的接收人簿。规则里的接收人已经不在了（或插件没在运行），保留它的
  // 编号当选项并标红，免得静默改成别人（保存时后端会拒绝，见 src/events/rules.js）。
  function syncChannel(selected) {
    const plugin = channels.find(item => item.plugin === form.elements.channelPlugin.value);
    const targets = plugin ? plugin.targets : [];
    const options = targets.map(target => [target.id,
      target.status === 'active' ? target.name : `${target.name}（${targetStatus(target.status)}）`]);
    const gone = selected && !targets.some(target => target.id === selected);
    if (gone) options.push([selected, `${selected}（${tr(plugin && plugin.ready !== false && !plugin.error ? 'hookChannelMissing' : 'hookChannelDown')}）`]);
    fillOptions(form.elements.channelTarget, options, selected || (options[0] || [''])[0]);
    const current = targets.find(target => target.id === form.elements.channelTarget.value);
    let problem = '';
    if (!plugin || plugin.error || plugin.ready === false) problem = tr('hookChannelDown');
    else if (!form.elements.channelTarget.value) problem = tr('hookChannelNoTargets');
    else if (!current) problem = tr('hookChannelMissing');
    else if (current.status !== 'active') problem = tr('hookChannelNotActive', { status: targetStatus(current.status) });
    form.querySelector('#hook-channel-problem').textContent = problem;
  }

  async function loadChannels() {
    try {
      const data = await request('/api/channels/targets');
      return Array.isArray(data && data.channels) ? data.channels : [];
    } catch (_) { return []; }
  }

  function actionName(kind) {
    const hit = ACTION_OPTIONS.find(([value]) => value === kind);
    return hit ? tr(hit[1]) : kind;
  }

  function syncKind() {
    const kind = form.elements.kind.value;
    for (const part of form.querySelectorAll('[data-kind]')) part.hidden = part.dataset.kind !== kind;
    syncTarget();
  }

  // 「注入到」选“新建会话”时才露出工作区 / CLI / 标题三项。
  function syncTarget() {
    const part = form.querySelector('[data-newsession]');
    if (part) part.hidden = form.elements.kind.value !== 'inject-prompt' || form.elements.target.value !== NEW_SESSION;
  }

  function syncScope() {
    const scoped = form.elements.scope.value === 'session' && !session;
    form.elements.scopeSession.hidden = !scoped;
    form.elements.scopeFilter.hidden = !scoped || (form.elements.scopeSession._rest || []).length < 2;
  }

  function fillOptions(select, options, selected) {
    select.textContent = '';
    for (const [value, label] of options) select.append(h('option', { value, text: label }));
    select.value = selected;
    if (select.value !== selected) select.value = options.length ? options[0][0] : '';
  }

  // 能接收注入的是聊天会话：它们是任务专属会话（task.sessionId），不在 /api/sessions 里；
  // 那里只有终端 / 登录终端 / aux，终端收不了指令，所以不能拿它当来源。
  async function loadSessions() {
    try {
      const air = await request('/api/air');
      const dirName = new Map(((air && air.directories) || []).map(dir => [dir.id, dir.name]));
      return ((air && air.tasks) || [])
        .filter(task => task && task.sessionId && !task.readOnly && task.status !== 'archived')
        .sort((a, b) => (b.lastMessageAt || b.updatedAt || 0) - (a.lastMessageAt || a.updatedAt || 0))
        .map(task => ({ id: task.sessionId, label: `${task.title || task.sessionId}（${dirName.get(task.dirId) || '—'}）` }));
    } catch (_) { return []; }
  }

  async function loadDirs() {
    try {
      const list = await request('/api/directories');
      return (Array.isArray(list) ? list : []).filter(entry => entry && entry.id).map(entry => [entry.id, entry.name || entry.id]);
    } catch (_) { return []; }
  }

  async function loadClis() {
    try {
      const catalog = await request('/api/events/catalog');
      return Array.isArray(catalog && catalog.clis) ? catalog.clis : [];
    } catch (_) { return []; }
  }

  // 会话很多时靠过滤框找：固定项（沿用 / 新建 / 全局）与当前选中项永远保留，其余按
  // 标题或工作区名做不区分大小写的子串匹配。选项全集挂在 select 上，输入时重建。
  function fillFiltered(select, filter, pinned, rest, selected) {
    select._pinned = pinned;
    select._rest = rest;
    filter.value = '';
    fillOptions(select, [...pinned, ...rest], selected);
    filter.hidden = rest.length < 2;
  }

  function renderFiltered(select) {
    const filter = form.elements[select.name === 'target' ? 'targetFilter' : 'scopeFilter'];
    const query = filter.value.trim().toLowerCase();
    const current = select.value;
    const matched = (select._rest || []).filter(([value, label]) =>
      !query || value === current || String(label).toLowerCase().includes(query));
    fillOptions(select, [...(select._pinned || []), ...matched], current);
  }

  async function loadSecrets() {
    try {
      const list = await request('/api/secrets');
      return (Array.isArray(list) ? list : []).map(entry => entry.name).filter(Boolean);
    } catch (_) { return []; }
  }

  function fillForm(item) {
    const rule = item ? item.rule : null;
    const action = rule ? rule.action : { kind: 'notify' };
    form.reset();
    form.querySelector('#hook-title').textContent = tr(item ? 'hookDialogEdit' : 'hookDialogNew');
    const on = new Set(rule ? rule.on : ['task.attention']);
    for (const box of form.querySelectorAll('input[name=ev]')) box.checked = on.has(box.value);
    form.elements.name.value = rule ? (rule.name || '') : '';
    form.elements.skipCancelled.checked = Boolean(rule && rule.filter && rule.filter.cancelled === false);
    form.elements.kind.value = action.kind;
    form.elements.message.value = action.message || '';
    form.elements.url.value = action.url || '';
    form.elements.includeConclusion.checked = action.includeConclusion === true;
    form.elements.prompt.value = action.prompt || '';
    form.elements.channelMessage.value = action.kind === 'channel' ? (action.message || '') : '';
    // 没装渠道插件时不给选「发到渠道」；已有的渠道规则照常能编辑。
    const channelOption = form.elements.kind.querySelector('option[value=channel]');
    channelOption.hidden = !channels.length && action.kind !== 'channel';
    channelOption.disabled = channelOption.hidden;
    const plugins = channels.map(item => [item.plugin, channelLabel(item)]);
    if (action.kind === 'channel' && action.plugin && !plugins.some(([id]) => id === action.plugin)) plugins.push([action.plugin, action.plugin]);
    fillOptions(form.elements.channelPlugin, plugins, action.kind === 'channel' ? action.plugin : (plugins[0] || [''])[0]);
    syncChannel(action.kind === 'channel' ? action.target : '');
    form.elements.cooldown.value = rule && rule.cooldownMs ? String(Math.round(rule.cooldownMs / 1000)) : '';
    form.elements.once.checked = Boolean(rule && rule.once);
    form.elements.enabled.checked = rule ? rule.enabled !== false : true;
    form.querySelector('#hook-error').textContent = '';
    form.querySelector('#hook-chain').textContent = '';
    for (const step of (rule && Array.isArray(rule.then) ? rule.then : [])) addChainStep(step);
    syncChain();

    const scopeRow = form.querySelector('#hook-scope-row');
    scopeRow.hidden = Boolean(session);
    fillOptions(form.elements.scope, [['global', tr('hookScopeGlobal')], ['session', tr('hookScopeSession')]],
      item ? item.scope : 'global');
    fillFiltered(form.elements.scopeSession, form.elements.scopeFilter, [], sessionChoices, item && item.sessionId ? item.sessionId : '');
    form.elements.scope.disabled = Boolean(item);
    form.elements.scopeSession.disabled = Boolean(item);

    // 编辑时目标会话可能已被删除：保留它的 id 当选项，免得静默改成“触发事件的会话”。
    const rest = sessionChoices.slice();
    if (action.targetSessionId && !rest.some(([value]) => value === action.targetSessionId)) {
      rest.push([action.targetSessionId, action.targetSessionId]);
    }
    fillFiltered(form.elements.target, form.elements.targetFilter,
      [['', tr('hookInjectSource')], [NEW_SESSION, tr('hookInjectNew')]], rest,
      action.newSession ? NEW_SESSION : (action.targetSessionId || ''));
    const spec = action.newSession || {};
    fillOptions(form.elements.newDir, [['', tr('hookNewDirSource')], ...dirChoices], spec.dirId || '');
    fillOptions(form.elements.newCli, [['', tr('hookNewCliSource')], ...cliChoices.map(cli => [cli, cli])], spec.cli || '');
    form.elements.newTitle.value = spec.title || '';
    syncKind();
    syncScope();
  }

  function expandedType(pattern) {
    if (pattern === 'task.done') return 'task.achieved';
    if (pattern === 'task.attention') return 'task.failed';
    if (pattern === '*' || pattern.endsWith('.*')) return 'task.finished';
    return pattern;
  }

  const invalid = message => Object.assign(new Error(message), { hookValidation: true });

  function collect() {
    const on = [...form.querySelectorAll('input[name=ev]:checked')].map(box => box.value);
    if (!on.length) throw invalid(tr('hookErrNeedEvent'));
    const kind = form.elements.kind.value;
    const action = { kind };
    if (kind === 'notify') action.message = form.elements.message.value.trim();
    else if (kind === 'channel') {
      action.plugin = form.elements.channelPlugin.value;
      action.target = form.elements.channelTarget.value;
      if (!action.plugin || !action.target) throw invalid(tr('hookErrChannel'));
      action.message = form.elements.channelMessage.value.trim();
    } else if (kind === 'webhook') {
      action.url = form.elements.url.value.trim();
      if (!action.url) throw invalid(tr('hookErrUrl'));
      if (form.elements.secretName.value) action.secretName = form.elements.secretName.value;
      action.includeConclusion = form.elements.includeConclusion.checked;
    } else {
      action.prompt = form.elements.prompt.value.trim();
      const target = form.elements.target.value;
      if (target === NEW_SESSION) {
        action.newSession = {
          dirId: form.elements.newDir.value, cli: form.elements.newCli.value, title: form.elements.newTitle.value.trim(),
        };
      } else if (target) action.targetSessionId = target;
    }
    const filter = { ...((editing && editing.rule.filter) || {}) };
    if (form.elements.skipCancelled.checked) filter.cancelled = false;
    else delete filter.cancelled;
    const body = {
      type: 'event', name: form.elements.name.value.trim(), on, filter, action, then: collectChain(),
      enabled: form.elements.enabled.checked,
      once: form.elements.once.checked,
    };
    const cooldown = form.elements.cooldown.value;
    if (cooldown !== '') body.cooldownMs = Math.max(0, parseInt(cooldown, 10) || 0) * 1000;
    return body;
  }

  async function save() {
    const error = form.querySelector('#hook-error');
    error.textContent = '';
    try {
      const body = collect();
      const owner = editing ? editing.sessionId
        : (session ? session.id : (form.elements.scope.value === 'session' ? form.elements.scopeSession.value : null));
      if (!editing && form.elements.scope.value === 'session' && !session && !owner) throw invalid(tr('hookErrNeedSession'));
      const id = editing ? editing.rule.id : null;
      if (owner) {
        const base = `/api/sessions/${encodeURIComponent(owner)}/triggers`;
        await request(id ? `${base}/${encodeURIComponent(id)}` : base, { method: id ? 'PUT' : 'POST', json: body });
      } else {
        await request(id ? `/api/event-rules/${encodeURIComponent(id)}` : '/api/event-rules',
          { method: id ? 'PUT' : 'POST', json: body });
      }
      dialog.close();
      if (typeof onSaved === 'function') onSaved();
    } catch (failure) {
      // 本地校验的提示原样显示；只有请求失败才套“保存失败：…”。
      error.textContent = failure && failure.hookValidation ? failure.message : tr('hookSaveFailed', { msg: errorText(failure) });
    }
  }

  // opts: { session:{id,label}  固定归属（会话页头入口）, item  编辑已有规则,
  //         sessions:[{id,label}]  触发器 tab 的会话选择, onSaved }
  async function open(opts = {}) {
    ensureDialog();
    session = opts.session || null;
    editing = opts.item || null;
    onSaved = opts.onSaved || null;
    // 会话 / 工作区 / CLI 由编辑器自己取，两个入口（会话页头、触发器 tab）选项一致。
    const [sessions, dirs, clis, channelList] = await Promise.all([
      opts.sessions ? Promise.resolve(opts.sessions) : loadSessions(), loadDirs(), loadClis(), loadChannels()]);
    channels = channelList;
    sessionChoices = sessions.map(entry => [entry.id, entry.label || entry.id]);
    dirChoices = dirs;
    cliChoices = clis;
    fillForm(editing);
    if (session) {
      form.elements.scope.value = 'session';
      form.elements.scopeSession.value = session.id;
    }
    const secrets = await loadSecrets();
    fillOptions(form.elements.secretName, [['', tr('hookNoSecret')], ...secrets.map(name => [name, name])],
      (editing && editing.rule.action.secretName) || '');
    if (!dialog.open) dialog.showModal();
  }

  // 触发器列表与会话页头共用的“当前会话有多少个钩子”。
  async function listForSession(sessionId) {
    const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}/triggers`);
    return ((data && data.triggers) || []).filter(trigger => trigger.type === 'event');
  }

  async function removeItem(item) {
    const base = item.sessionId
      ? `/api/sessions/${encodeURIComponent(item.sessionId)}/triggers/${encodeURIComponent(item.rule.id)}`
      : `/api/event-rules/${encodeURIComponent(item.rule.id)}`;
    await request(base, { method: 'DELETE' });
  }

  async function setEnabled(item, enabled) {
    const base = item.sessionId
      ? `/api/sessions/${encodeURIComponent(item.sessionId)}/triggers/${encodeURIComponent(item.rule.id)}`
      : `/api/event-rules/${encodeURIComponent(item.rule.id)}`;
    await request(base, { method: 'PUT', json: { enabled } });
  }

  // 空跑：发一个模拟事件，让这条规则真的走一遍匹配与动作。
  async function testItem(item) {
    const type = expandedType(item.rule.on[0]);
    const goalState = (item.rule.filter && item.rule.filter.goalState)
      || (type === 'task.achieved' ? 'achieved' : (type === 'task.needs_interaction' ? 'interact' : null));
    await request('/api/events/test', {
      method: 'POST', json: { type, sessionId: item.sessionId || undefined, goalState, goal: tr('hookTestGoal') },
    });
  }

  root.MultiCCHookEditor = Object.freeze({
    EVENT_OPTIONS, ACTION_OPTIONS, open, listForSession, removeItem, setEnabled, testItem, expandedType, loadChannels,
  });
})(typeof window !== 'undefined' ? window : null);

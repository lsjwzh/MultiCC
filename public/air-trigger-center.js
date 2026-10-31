'use strict';

// ── 触发器任务（public/air-trigger-center.js）─────────────────────────────────
// 定时任务中心的第二个 tab：列出所有“事件 → 动作”规则（全局 + 各会话），
// 增删改与测试都走共用表单 hook-editor.js。会话页头 🪝 建的规则也在这里出现。
// 数据来自 GET /api/event-triggers（后端把全局规则、各会话 type=event 的触发器
// 与最近一次执行结果合并成一张表）。第一个 tab（定时）原样不动，仍归
// air-schedule-center.js；这里只负责 tab 切换、顶部“新建”按钮的分流与第二个列表。
(function initAirTriggerCenter(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const t = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const request = (path, options) => root.MultiCCApi.json(path, options);
  const errorText = error => (root.MultiCCApi && typeof root.MultiCCApi.errorText === 'function'
    ? root.MultiCCApi.errorText(error) : (error && error.message) || String(error));
  const editor = () => root.MultiCCHookEditor;

  let ctx = {};
  let items = [];
  let channels = [];   // 渠道插件的接收人（标出「发到渠道」引用了已删除的接收人）
  let tab = 'cron';
  let loading = false;
  const notice = text => { if (typeof ctx.notice === 'function') ctx.notice(text); };

  const eventLabel = pattern => {
    const hit = editor().EVENT_OPTIONS.find(([value]) => value === pattern);
    return hit ? t(hit[1]) : pattern;
  };
  const actionLabel = kind => {
    const hit = editor().ACTION_OPTIONS.find(([value]) => value === kind);
    return hit ? t(hit[1]) : kind;
  };
  const when = value => (value ? new Intl.DateTimeFormat(typeof root.getLocale === 'function' ? root.getLocale() : undefined, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value)) : '—');

  function button(text, action, className = '') {
    const element = node('button', text, className);
    element.type = 'button';
    element.onclick = action;
    return element;
  }

  async function openEditor(item) {
    editor().open({ item: item || null, onSaved: load });
  }

  async function act(label, work) {
    try { await work(); await load(); } catch (error) { notice(t(label, { msg: errorText(error) })); }
  }

  function card(item) {
    const { rule } = item;
    const article = node('article', null, 'schedule-card');
    const head = node('header', null, 'schedule-card-head');
    const title = node('div');
    title.append(node('span', 'HOOK', 'eyebrow'), node('h3', rule.name || rule.on.map(eventLabel).join(' / ')));
    // 一次性钩子必须在列表里一眼可见：用掉之后显示「已触发」而不是只剩一个灰的
    // 「已停用」，否则用户只会以为规则自己坏了/消失了（这就是加 once 的原因）。
    const spent = Boolean(rule.once && !rule.enabled && rule.firedAt);
    head.append(title);
    if (rule.once) {
      head.append(node('span', spent ? t('hookOnceUsed') : t('hookOnceBadge'),
        `schedule-badge${spent ? '' : ' enabled'}`));
    }
    head.append(node('span', rule.enabled ? t('airScheduleEnabled') : t('airScheduleDisabled'),
      `schedule-badge ${rule.enabled ? 'enabled' : ''}`));

    const flow = node('div', null, 'hook-flow');
    flow.append(node('span', rule.on.map(eventLabel).join(' · ')), node('b', '→'),
      node('strong', actionLabel(rule.action.kind)));

    const owner = node('div', null, 'schedule-state');
    owner.append(node('span', item.scope === 'global' ? t('hookOwnerGlobal') : t('hookOwnerSession', { name: item.sessionLabel || item.sessionId })));
    const run = item.lastRun;
    owner.append(node('small', run
      ? `${t('hookLastRun')} ${when(run.ts)}${run.steps ? ` · ${run.step}/${run.steps}` : ''} · ${run.ok ? t('hookRunOk') : t('hookRunFail', { msg: run.error || '' })}`
      : (rule.lastFiredAt ? `${t('hookLastRun')} ${when(rule.lastFiredAt)}` : t('hookNeverRan'))));
    if (spent) owner.append(node('small', t('hookOnceFiredAt', { time: when(rule.firedAt) })));

    const actions = node('footer', null, 'schedule-actions');
    actions.append(
      button(t('hookTest'), () => testRule(item), 'primary subtle'),
      button(rule.enabled ? t('airSchedulePause') : t('airScheduleEnable'),
        () => act('hookToggleFailed', () => editor().setEnabled(item, !rule.enabled))),
      button(t('airScheduleEdit'), () => openEditor(item)),
      node('span'),
      button(t('airScheduleDelete'), () => {
        if (root.confirm(t('hookDeleteConfirm'))) act('hookDeleteFailed', () => editor().removeItem(item));
      }, 'danger'));
    article.append(head, flow, owner, actions);
    // 发到渠道：写明发给谁；接收人已从插件里删掉、或插件没在运行，整张卡标红（design 13 节）。
    for (const action of [rule.action, ...(rule.then || [])].filter(step => step && step.kind === 'channel')) {
      const channel = channels.find(item => item.plugin === action.plugin);
      const target = channel && channel.targets.find(item => item.id === action.target);
      const problem = !channel || channel.error || channel.ready === false ? t('hookChannelDown') : (target ? '' : t('hookChannelMissing'));
      flow.append(node('small', `（${channel ? channel.label || channel.plugin : action.plugin} → ${target ? target.name : action.target}${problem ? ` · ${problem}` : ''}）`,
        problem ? 'hook-channel-bad' : ''));
      if (problem) article.classList.add('hook-channel-broken');
    }
    if (rule.action.kind === 'inject-prompt') {
      const target = rule.action.newSession ? t('hookTargetNew') : (rule.action.targetSessionId
        ? t('hookTargetSession', { id: rule.action.targetSessionId }) : t('hookInjectSource'));
      flow.append(node('small', `（${target}）`));
      if (rule.action.prompt) article.insertBefore(node('p', rule.action.prompt, 'schedule-prompt'), actions);
    }
    // 链式钩子：标出总步数，后续步骤的指令按序号列在第一步下面。
    const then = rule.then || [];
    if (then.length) {
      flow.append(node('small', t('hookChainSteps', { n: then.length + 1 })));
      then.forEach((step, index) => article.insertBefore(
        node('p', `${index + 2}. ${step.prompt || actionLabel(step.kind)}`, 'schedule-prompt'), actions));
    }
    return article;
  }

  async function testRule(item) {
    const target = item.scope === 'global' ? t('hookOwnerGlobal') : (item.sessionLabel || item.sessionId);
    if (!root.confirm(t('hookTestConfirm', { target }))) return;
    try {
      await editor().testItem(item);
      notice(t('hookTested'));
      setTimeout(load, 800);
    } catch (error) { notice(t('hookTestFailed', { msg: errorText(error) })); }
  }

  function render() {
    const list = $('hook-list');
    if (!list) return;
    const enabled = items.filter(item => item.rule.enabled).length;
    $('hook-summary').replaceChildren(
      node('span', t('hookSummaryCount', { n: items.length })), node('span', t('airScheduleEnabledCount', { n: enabled })));
    list.replaceChildren();
    if (!items.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', t('hookEmptyTitle')), node('p', t('hookEmptyHint')));
      list.append(empty);
      return;
    }
    for (const item of items) list.append(card(item));
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const [value, channelList] = await Promise.all([request('/api/event-triggers'), editor().loadChannels()]);
      items = Array.isArray(value && value.items) ? value.items : [];
      channels = channelList;
      render();
    } catch (error) {
      notice(t('hookLoadFailed', { msg: errorText(error) }));
    } finally { loading = false; }
  }

  function setTab(next) {
    tab = next === 'hooks' ? 'hooks' : 'cron';
    for (const element of document.querySelectorAll('[data-schedule-tab]')) {
      const active = element.dataset.scheduleTab === tab;
      element.setAttribute('aria-selected', String(active));
      element.classList.toggle('active', active);
    }
    const hooks = tab === 'hooks';
    for (const id of ['schedule-summary', 'schedule-list']) if ($(id)) $(id).hidden = hooks;
    for (const id of ['hook-summary', 'hook-list']) if ($(id)) $(id).hidden = !hooks;
    const create = $('schedule-create');
    const label = create && create.querySelector('[data-i18n]');
    if (label) {
      label.dataset.i18n = hooks ? 'hookNewTrigger' : 'airNewScheduledTask';
      label.textContent = t(label.dataset.i18n);
    }
    if (hooks) void load();
  }

  function bind(context) {
    ctx = context || {};
    for (const element of document.querySelectorAll('[data-schedule-tab]')) {
      element.onclick = () => setTab(element.dataset.scheduleTab);
    }
    // 顶部同一颗“新建”按钮按 tab 分流：定时 tab 保持原行为（air-schedule-center 已绑好）。
    const create = $('schedule-create');
    if (create) {
      const original = create.onclick;
      create.onclick = event => (tab === 'hooks' ? void openEditor(null) : (original && original.call(create, event)));
    }
    // 中心从隐藏变可见（切到“定时任务”页）时，停在触发器 tab 就顺手刷新一次。
    const center = $('schedule-center');
    if (center && typeof root.MutationObserver === 'function') {
      new root.MutationObserver(() => { if (!center.hidden && tab === 'hooks') void load(); })
        .observe(center, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  root.MultiCCAirHooks = Object.freeze({ bind, refresh: load, setTab, items: () => items });
})(typeof window !== 'undefined' ? window : null);

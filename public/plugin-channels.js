'use strict';

// 通知渠道插件（微信……）在 MultiCC 页面里的两处（docs/notification-channel-plugin-design.md 10.3）：
//   ① 推送设置的「插件渠道」一栏：按插件分组列出接收人，勾收哪几类、开关、测试。写的是推送层
//      的订阅（/api/push/channel-subscriptions），插件面板的「快速接入」写的也是这一份，两边一致。
//   ② Air 顶部横幅：渠道插件有没恢复的告警，或者有订阅、钩子指望它但它没在运行。
// 接收人的增删改只在插件面板里（MultiCC 只存接收人编号，名字在插件里）。没装渠道插件时
// 两处都不出现。后端：src/push/channel-subscriptions.js、src/routes/plugins.js 的 /api/channels*。
(function initPluginChannels(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const tr = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  const english = () => typeof root.getLang === 'function' && root.getLang() === 'en';
  const request = (path, options) => root.MultiCCApi.json(path, options);
  const errorText = error => (root.MultiCCApi && typeof root.MultiCCApi.errorText === 'function'
    ? root.MultiCCApi.errorText(error) : (error && error.message) || String(error));

  const CATEGORIES = Object.freeze([
    ['done', 'pcCatDone'], ['question', 'pcCatQuestion'], ['background', 'pcCatBackground'], ['error', 'pcCatError'],
  ]);
  const TARGET_STATUS = Object.freeze({
    active: 'pcTargetActive', pending: 'pcTargetPending', testing: 'pcTargetTesting',
    disabled: 'pcTargetDisabled', recheck: 'pcTargetRecheck',
  });
  const statusText = status => (TARGET_STATUS[status] ? tr(TARGET_STATUS[status]) : (status || '—'));
  const channelName = item => {
    const channel = (item && item.channel) || {};
    return (english() ? channel.labelEn || item.nameEn : null) || channel.label || (item && item.name) || (item && item.id) || '';
  };

  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  let styleNode = null;
  function style() {
    if (styleNode) return styleNode;
    styleNode = make('style');
    styleNode.textContent = `
      .pc-group { display: grid; gap: 8px; margin-top: 12px; }
      .pc-group-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .pc-group-head h3 { margin: 0; font-size: 12.5px; }
      .pc-state { color: var(--muted); font-size: 10.5px; }
      .pc-state.bad, .pc-row.bad .pc-target-state { color: var(--danger, #c0392b); font-weight: 600; }
      .pc-row { display: grid; gap: 6px; padding: 9px 11px; border: 1px solid var(--line, #d6e2ee); border-radius: 9px; }
      .pc-row.bad { border-color: var(--danger, #c0392b); }
      .pc-row-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .pc-row-head strong { font-size: 12px; }
      .pc-target-state { color: var(--muted); font-size: 10.5px; }
      .pc-cats { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; }
      .pc-cats label, .pc-row-actions label { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; margin: 0; }
      .pc-cats input, .pc-row-actions input { width: auto; margin: 0; }
      .pc-row-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .pc-row-actions small { color: var(--muted); font-size: 10.5px; }
      .pc-warn { margin: 8px 0 0; color: var(--danger, #c0392b); font-size: 11.5px; line-height: 1.6; }
      .pc-banner { position: fixed; z-index: 2147483000; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 12px; max-width: min(720px, calc(100vw - 24px)); padding: 9px 14px;
        border-radius: 10px; background: #fff7e6; color: #6b4a00; border: 1px solid #f0c36d;
        box-shadow: 0 6px 20px rgba(32, 52, 74, .18); font-size: 12px; line-height: 1.5; }
      .pc-banner.critical { background: #fdecea; color: #8a1f11; border-color: #e8a29a; }
      .pc-banner a { color: inherit; font-weight: 600; white-space: nowrap; }
      .pc-banner button { flex: 0 0 auto; border: 0; background: transparent; color: inherit; font-size: 15px; cursor: pointer; }
      .schedule-card.hook-channel-broken { border-color: var(--danger, #c0392b); }
      .hook-channel-bad { color: var(--danger, #c0392b); font-weight: 600; }`;
    return styleNode;
  }

  // /api/channels：哪些插件声明了渠道、是否就绪、未恢复的告警、有没有人在用；
  // /api/channels/targets：各渠道的接收人。
  async function load() {
    const [status, targets] = await Promise.all([
      request('/api/channels'), request('/api/channels/targets').catch(() => ({ channels: [] })),
    ]);
    const plugins = ((status && status.plugins) || []).filter(item => item && item.channel);
    const lists = new Map(((targets && targets.channels) || []).map(item => [item.plugin || item.id, item]));
    return plugins.map(item => ({ ...item, targets: (lists.get(item.id) || {}).targets || [], targetsError: (lists.get(item.id) || {}).error || null }));
  }

  // ① 推送设置的「插件渠道」一栏。host 由 air-push.js 给；没装渠道插件就藏起来。
  async function renderPush(host) {
    if (!host) return;
    // 先看有没有渠道插件，有才读订阅：没装插件时推送面板的请求和以前一模一样。
    let plugins;
    let subs;
    try {
      plugins = await load();
      if (plugins.length) subs = await request('/api/push/channel-subscriptions');
    } catch (_) {
      host.hidden = true;   // 老服务端没有这些接口：这一栏不出现
      return;
    }
    if (!plugins.length) { host.hidden = true; host.replaceChildren(); return; }
    host.hidden = false;
    const section = make('section', null, 'admin-panel air-plugin-channels');
    // 样式只放 head 一份（横幅和触发器卡片也用它）：放进面板里会跟着面板重画被拆掉。
    if (!style().isConnected) document.head.append(style());
    section.append(make('h2', tr('pcTitle')), make('p', tr('pcNote'), 'air-push-note'));
    const status = make('p', '', 'air-push-status');
    status.setAttribute('role', 'status');

    const paint = data => {
      subs = data;
      for (const node of [...section.querySelectorAll('.pc-group, .pc-warn')]) node.remove();
      const list = subs.subscriptions || [];
      if (list.some(item => item.enabled) && subs.otherChannels && subs.otherChannels.any === false) {
        section.insertBefore(make('p', tr('pcOnlyChannel'), 'pc-warn'), status);
      }
      for (const plugin of plugins) section.insertBefore(group(plugin, list), status);
    };

    const save = async (body, note) => {
      status.textContent = '';
      try { paint(await request('/api/push/channel-subscriptions', { method: 'POST', json: body })); if (note) note.textContent = ''; }
      catch (error) { status.textContent = tr('pcSaveFailed', { msg: errorText(error) }); paint(subs); }
    };
    const remove = async sub => {
      try { paint(await request(`/api/push/channel-subscriptions/${encodeURIComponent(sub.id)}`, { method: 'DELETE' })); }
      catch (error) { status.textContent = tr('pcSaveFailed', { msg: errorText(error) }); }
    };
    const test = async (plugin, target, note) => {
      note.textContent = '…';
      try {
        const result = await request('/api/push/test-channel', { method: 'POST', json: { plugin: plugin.id, target } });
        const id = result && result.receipt && result.receipt.deliveryId;
        note.textContent = tr('pcTestQueued', { id: id == null ? '—' : id });
      } catch (error) { note.textContent = tr('pcTestFailed', { msg: errorText(error) }); }
    };

    function row(plugin, target, sub, gone) {
      const active = target && target.status === 'active';
      const item = make('div', null, `pc-row${gone ? ' bad' : ''}`);
      item.dataset.target = target ? target.id : sub.target;
      const head = make('div', null, 'pc-row-head');
      head.append(make('strong', target ? target.name : sub.target),
        make('span', gone ? tr('pcTargetGone') : statusText(target.status), 'pc-target-state'));
      const chosen = new Set(sub ? sub.categories : (subs.defaults || ['error', 'question']));
      const cats = make('div', null, 'pc-cats');
      const note = make('small');
      const locked = gone || (!active && !sub) || !plugin.ready;
      for (const [value, key] of CATEGORIES) {
        const label = make('label');
        const box = make('input');
        box.type = 'checkbox';
        box.value = value;
        box.checked = chosen.has(value);
        box.disabled = locked;
        box.onchange = () => {
          const next = CATEGORIES.map(([id]) => id).filter(id => (id === value ? box.checked : chosen.has(id)));
          if (!next.length) { box.checked = true; note.textContent = tr('pcNeedCategory'); return; }
          void save({ plugin: plugin.id, target: item.dataset.target, categories: next, enabled: sub ? sub.enabled : true }, note);
        };
        label.append(box, make('span', tr(key)));
        cats.append(label);
      }
      const actions = make('div', null, 'pc-row-actions');
      const toggle = make('label');
      const on = make('input');
      on.type = 'checkbox';
      on.checked = Boolean(sub && sub.enabled);
      on.disabled = locked && !(sub && sub.enabled);
      on.onchange = () => void save({ plugin: plugin.id, target: item.dataset.target, categories: CATEGORIES.map(([id]) => id).filter(id => chosen.has(id)), enabled: on.checked }, note);
      toggle.append(on, make('span', tr('pcEnabled')));
      actions.append(toggle);
      if (!gone) {
        const testButton = make('button', tr('pcTest'));
        testButton.type = 'button';
        testButton.disabled = !active || !plugin.ready;
        testButton.onclick = () => void test(plugin, target.id, note);
        actions.append(testButton);
      }
      if (sub && (gone || !active)) {
        const drop = make('button', tr('pcRemove'), 'danger');
        drop.type = 'button';
        drop.onclick = () => void remove(sub);
        actions.append(drop);
      }
      actions.append(note);
      item.append(head, cats, actions);
      return item;
    }

    function group(plugin, list) {
      const box = make('div', null, 'pc-group');
      const head = make('div', null, 'pc-group-head');
      head.append(make('h3', channelName(plugin)),
        make('span', plugin.ready ? tr('pcPluginReady') : tr('pcPluginDown'), `pc-state${plugin.ready ? '' : ' bad'}`));
      if (plugin.ui) {
        const link = make('a', tr('pcManage'));
        link.href = plugin.ui;
        link.target = '_blank';
        link.rel = 'noopener';
        head.append(link);
      }
      box.append(head);
      const mine = list.filter(sub => sub.plugin === plugin.id);
      for (const target of plugin.targets) box.append(row(plugin, target, mine.find(sub => sub.target === target.id) || null, false));
      // 订阅还在、接收人已经从插件里删了（或插件没运行、列不出来）：标红，给删除。
      for (const sub of mine) {
        if (!plugin.targets.some(target => target.id === sub.target)) box.append(row(plugin, null, sub, plugin.ready));
      }
      if (!plugin.targets.length && !mine.length) box.append(make('p', tr('pcNoTargets'), 'air-push-note'));
      return box;
    }

    section.append(status);
    host.replaceChildren(section);
    paint(subs);
  }

  // ② Air 顶部横幅：未恢复的告警，或者有人指望它（订阅、钩子）但它没在运行。
  // 关掉后同一组问题这次打开页面内不再出现；问题变了（新告警）会再出现。
  const BANNER_POLL_MS = 60_000;
  let bannerNode = null;
  let bannerTimer = null;
  function problems(plugins) {
    const out = [];
    for (const plugin of plugins) {
      const name = channelName(plugin);
      for (const alert of plugin.alerts || []) {
        out.push({ key: `${plugin.id}:${alert.key}:${alert.at || ''}`, level: alert.level, ui: plugin.ui,
          text: tr('pcBannerAlert', { name, title: alert.title || alert.key }) });
      }
      if (plugin.inUse && !plugin.ready && !(plugin.alerts || []).length) {
        out.push({ key: `${plugin.id}:down`, level: 'critical', ui: plugin.ui, text: tr('pcBannerDown', { name }) });
      }
    }
    return out;
  }
  function dismissedKey() {
    try { return root.sessionStorage.getItem('multicc_channel_banner_dismissed') || ''; } catch (_) { return ''; }
  }
  function paintBanner(list) {
    const key = list.map(item => item.key).sort().join('|');
    if (!list.length || key === dismissedKey()) { if (bannerNode) bannerNode.hidden = true; return; }
    if (!bannerNode) {
      bannerNode = make('div', null, 'pc-banner');
      bannerNode.setAttribute('role', 'alert');
      if (!style().isConnected) document.head.append(style());
      document.body.append(bannerNode);
    }
    const first = list[0];
    bannerNode.className = `pc-banner${list.some(item => item.level === 'critical') ? ' critical' : ''}`;
    bannerNode.hidden = false;
    const text = make('span', list.length > 1 ? `${first.text}（+${list.length - 1}）` : first.text);
    const parts = [text];
    if (first.ui) {
      const link = make('a', tr('pcBannerOpen'));
      link.href = first.ui;
      link.target = '_blank';
      link.rel = 'noopener';
      parts.push(link);
    }
    const close = make('button', '×');
    close.type = 'button';
    close.title = tr('pcBannerDismiss');
    close.setAttribute('aria-label', tr('pcBannerDismiss'));
    close.onclick = () => {
      try { root.sessionStorage.setItem('multicc_channel_banner_dismissed', key); } catch (_) {}
      bannerNode.hidden = true;
    };
    parts.push(close);
    bannerNode.replaceChildren(...parts);
  }
  async function checkBanner() {
    if (document.hidden) return;
    try {
      const status = await request('/api/channels');
      paintBanner(problems(((status && status.plugins) || []).filter(item => item && item.channel)));
    } catch (_) { /* 老服务端没有这个接口，或者暂时连不上：不出横幅 */ }
  }
  function startBanner() {
    if (bannerTimer) return;
    bannerTimer = root.setInterval(checkBanner, BANNER_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkBanner(); });
    void checkBanner();
  }

  root.MultiCCPluginChannels = Object.freeze({ CATEGORIES, statusText, channelName, load, renderPush, startBanner, problems });
  // Air 页面自己起横幅（air.html 才有 data-air-view 路由）；聊天页只用到上面的工具函数。
  const boot = () => {
    if (!document.querySelector('[data-air-view]') || !root.MultiCCApi) return;
    document.head.append(style());   // 触发器卡片的「接收人已不存在」标红也用这份样式
    startBanner();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(typeof window !== 'undefined' ? window : null);

'use strict';

// Air「插件」面板 —— 侧栏「资料与插件」区的插件入口页。
// 这一层只做两件事：把 /api/plugins/catalog 画成按状态分组的卡片（本机插件 /
// 可安装 / 收起的「不支持本机」），每张卡写清要求和第一条不满足的原因；点
// 「打开」后用 iframe 嵌插件自带的 UI（/plugins/<id>/<manifest.ui>）。插件的全部
// 交互都发生在它自己的页面里（再经 /api/plugins/<id>/run 与它的二进制对话）。
// 列表来自 GitHub 上签名的 index.json（docs/plugin-catalog-design.md），这一版只读：
// 一键安装是下一步。
// 后端契约见 src/routes/plugins.js：
//   GET  /api/plugins/catalog        POST /api/plugins/catalog/refresh
//   静态 /plugins/<id>/<ui 子树>
(function initAirPlugins(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  // 当前打开的插件 id 存模块上：面板每次重开都重建 DOM（air-admin.js 的
  // renderNative 走 render(host, ctx)），iframe 不能跟着整页重绘被拆掉重来。
  let activeId = null;
  let plugins = null;
  let catalogInfo = null;
  let conflicts = [];
  let category = null;
  let refreshing = false;
  let styleNode = null;

  function styleSheet() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
.air-plugins { display: grid; gap: 12px; }
.air-plugins-list { display: grid; gap: 10px; }
.air-plugins-card { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; box-shadow: var(--shadow-1); }
.air-plugins-icon { flex: 0 0 auto; font-size: 20px; }
.air-plugins-copy { min-width: 0; flex: 1 1 220px; }
.air-plugins-name { color: #2f536f; font-size: 12.5px; font-weight: 650; }
.air-plugins-version { margin-left: 8px; color: var(--faint); font-size: 9.5px; font-weight: 500; }
.air-plugins-desc { margin-top: 3px; color: #56718b; font-size: 10.5px; line-height: 1.45; }
.air-plugins-open { flex: 0 0 auto; min-height: 32px; padding: 4px 14px; color: #fff; border: 1px solid transparent; border-radius: 9px; background: #3d8bd8; font-size: 10.5px; }
.air-plugins-open:hover:not(:disabled) { background: #2f7ac4; }
.air-plugins-open:disabled { cursor: not-allowed; opacity: .55; }
.air-plugins-badge { flex: 0 0 auto; padding: 3px 8px; border-radius: 6px; background: #fdf4f1; color: #a6533c; font-size: 9.5px; }
.air-plugins-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.air-plugins-back { min-height: 32px; padding: 4px 12px; color: #2f536f; border: 1px solid var(--hairline); border-radius: 9px; background: #f6f9fc; font-size: 10.5px; }
.air-plugins-back:hover { background: #eef5fd; }
.air-plugins-frame { width: 100%; height: min(78vh, 900px); border: 1px solid var(--hairline); border-radius: 12px; background: #fff; }
.air-plugins-hint { margin: 0; color: var(--muted); font-size: 10px; }
.air-plugins-empty { padding: 26px 18px; text-align: center; border: 1px dashed var(--hairline); border-radius: 12px; }
.air-plugins-empty-title { color: #2f536f; font-size: 12.5px; font-weight: 650; }
.air-plugins-empty-hint { margin: 8px auto 0; max-width: 46em; color: #56718b; font-size: 10.5px; line-height: 1.6; }
.air-plugins-empty-hint code { padding: 1px 5px; border-radius: 5px; background: #eef3f8; color: #40607e; font-size: 10px; }
.air-plugins-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.air-plugins-bar .air-plugins-hint { flex: 1 1 260px; }
.air-plugins-bar .air-plugins-hint.is-warn { color: #a6533c; }
.air-plugins-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.air-plugins-chip { min-height: 26px; padding: 2px 10px; color: #40607e; border: 1px solid var(--hairline); border-radius: 999px; background: #f6f9fc; font-size: 10px; }
.air-plugins-chip.is-on { color: #fff; border-color: transparent; background: #3d8bd8; }
.air-plugins-group { margin: 6px 0 0; color: #40607e; font-size: 11px; font-weight: 650; }
.air-plugins-more > summary { cursor: pointer; color: #56718b; font-size: 10.5px; }
.air-plugins-more[open] > summary { margin-bottom: 10px; }
.air-plugins-tags { display: inline-flex; flex-wrap: wrap; gap: 5px; margin-left: 8px; vertical-align: 1px; }
.air-plugins-tag { padding: 1px 7px; border-radius: 6px; background: #eef3f8; color: #40607e; font-size: 9px; font-weight: 550; }
.air-plugins-tag.is-update, .air-plugins-tag.is-installable { background: #e8f3fd; color: #2f6fae; }
.air-plugins-tag.is-incompatible { background: #fdf6e3; color: #8a6414; }
.air-plugins-tag.is-unsupported { background: #f1f3f5; color: #7b8794; }
.air-plugins-meta { margin-top: 4px; color: #6b8299; font-size: 9.5px; line-height: 1.45; }
.air-plugins-why { margin-top: 4px; color: #a6533c; font-size: 10px; line-height: 1.45; }
.air-plugins-card.is-incompatible .air-plugins-why { color: #8a6414; }
.air-plugins-card.is-unsupported { background: #fafbfc; box-shadow: none; }
.air-plugins-card.is-unsupported .air-plugins-name { color: #6b8299; }
.air-plugins-link { flex: 0 0 auto; color: #2f7ac4; font-size: 10.5px; text-decoration: none; }
.air-plugins-link:hover { text-decoration: underline; }
`;
    return styleNode;
  }

  function button(text, handler, className) {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 插件名/描述跟随界面语言：manifest 里的 nameEn/descriptionEn 是给英文界面
  // 的降级位，没写就回落到主文案（多数插件只有一份中文文案）。
  function pickText(entry, base, en) {
    const lang = (typeof root.getLang === 'function' && root.getLang()) || 'zh';
    return (lang === 'en' && entry[en]) ? entry[en] : entry[base];
  }

  const OS_NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  const osName = os => OS_NAMES[os] || os;
  const CATEGORY_KEYS = { channel: 'airPluginsCategoryChannel', browser: 'airPluginsCategoryBrowser' };
  const categoryName = id => (CATEGORY_KEYS[id] ? t(CATEGORY_KEYS[id]) : id);
  const PERMISSION_KEYS = { accessibility: 'airPluginsPermAccessibility', screenRecording: 'airPluginsPermScreenRecording' };
  const LOCAL_STATES = new Set(['update', 'incompatible', 'builtin', 'installed']);

  function appName(item) {
    return pickText(item, 'name', 'nameEn') || item.app || item.id;
  }

  // 服务端只给原因码和参数（src/plugins/catalog.js unmetRequirement），文案在这里按语言拼。
  function reasonText(reason) {
    if (!reason) return '';
    const r = reason;
    switch (r.code) {
      case 'os': return t('airPluginsWhyOs', { supported: r.supported.map(osName).join(' / ') });
      case 'arch': return t('airPluginsWhyArch', { current: r.current, supported: r.supported.join(' / ') });
      case 'minOS': return t('airPluginsWhyMinOS', { os: osName(r.os), required: r.required, current: r.current || '?' });
      case 'multicc': return t('airPluginsWhyMultiCC', { required: r.required, current: r.current });
      case 'pluginApi': return t('airPluginsWhyPluginApi', { required: r.required, current: r.current });
      case 'agentMissing': return t('airPluginsWhyAgentMissing');
      case 'agentBuild': return t('airPluginsWhyAgentBuild', { required: r.required, current: r.current });
      case 'appMissing': return r.required ? t('airPluginsWhyAppMissingMin', { name: appName(r), required: r.required }) : t('airPluginsWhyAppMissing', { name: appName(r) });
      case 'appVersion': return t('airPluginsWhyAppVersion', { name: appName(r), required: r.required, current: r.current || '?' });
      case 'builtinInNewer': return t('airPluginsWhyBuiltinInNewer', { required: r.required, current: r.current });
      case 'builtinMissing': return t('airPluginsWhyBuiltinMissing');
      case 'noAsset': return t('airPluginsWhyNoAsset', { platform: r.platform });
      default: return t('airPluginsWhyUnknown');
    }
  }

  // 「需要：macOS 13.0 或更高 · MultiCC >=2.13.0 · 微信 4.0.0 或更高 · 辅助功能权限」
  function requirementText(requires) {
    if (!requires) return '';
    const parts = [];
    for (const platform of requires.platforms || []) {
      parts.push(platform.minOS ? t('airPluginsNeedsMin', { name: osName(platform.os), version: platform.minOS }) : osName(platform.os));
    }
    if (requires.multicc) parts.push(`MultiCC ${requires.multicc}`);
    if (requires.agentBuild) parts.push(t('airPluginsNeedsAgent', { range: requires.agentBuild }));
    for (const app of requires.apps || []) {
      parts.push(app.minVersion ? t('airPluginsNeedsMin', { name: appName(app), version: app.minVersion }) : appName(app));
    }
    for (const permission of requires.permissions || []) parts.push(PERMISSION_KEYS[permission] ? t(PERMISSION_KEYS[permission]) : permission);
    return parts.length ? t('airPluginsNeeds', { list: parts.join(' · ') }) : '';
  }

  function stateTag(row) {
    const tags = make('span', null, 'air-plugins-tags');
    const label = {
      builtin: t('airPluginsStateBuiltin'),
      installed: t('airPluginsStateInstalled'),
      update: t('airPluginsStateUpdate', { version: row.candidate }),
      installable: t('airPluginsStateInstallable', { version: row.candidate }),
      incompatible: t('airPluginsStateIncompatible'),
      unsupported: t('airPluginsStateUnsupported'),
    }[row.state];
    tags.append(make('span', label, `air-plugins-tag is-${row.state}`));
    // listed 为 null = 还没拿到列表，说不上在不在里面。
    if (row.listed === false) tags.append(make('span', t('airPluginsUnlisted'), 'air-plugins-tag'));
    return tags;
  }

  function renderCard(row) {
    const local = row.local;
    const card = make('article', null, `air-plugins-card is-${row.state}`);
    card.dataset.pluginId = row.id;
    card.dataset.state = row.state;
    card.append(make('span', row.icon || '🧩', 'air-plugins-icon'));
    const copy = make('div', null, 'air-plugins-copy');
    const title = make('div', null, 'air-plugins-name');
    title.append(document.createTextNode(pickText(row, 'name', 'nameEn')));
    const version = row.installedVersion || row.candidate || row.latest;
    if (version) title.append(make('span', 'v' + version, 'air-plugins-version'));
    title.append(stateTag(row));
    copy.append(title, make('div', pickText(row, 'summary', 'summaryEn'), 'air-plugins-desc'));
    const needs = LOCAL_STATES.has(row.state) && row.state !== 'incompatible' ? '' : requirementText(row.requires);
    if (needs) copy.append(make('div', needs, 'air-plugins-meta'));
    if (row.reason) copy.append(make('div', reasonText(row.reason), 'air-plugins-why'));
    if (row.state === 'installable' || row.state === 'update') copy.append(make('div', t('airPluginsInstallLater'), 'air-plugins-meta'));
    if (local && !local.engine.available) {
      copy.append(make('div', local.engine.reason || t('airPluginsEngineMissing'), 'air-plugins-badge'));
    }
    card.append(copy);
    if (row.homepage) {
      const link = make('a', t('airPluginsHomepage'), 'air-plugins-link');
      link.href = row.homepage;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      card.append(link);
    }
    if (local) {
      const open = button(t('airPluginsOpen'), () => { activeId = row.id; paint(document.getElementById('admin-content'), contextRef); }, 'air-plugins-open');
      open.disabled = !local.engine.available || !local.ui;
      if (!local.ui) open.title = t('airPluginsNoUi');
      card.append(open);
    }
    return card;
  }

  function catalogLine() {
    const info = catalogInfo || {};
    const when = iso => {
      const ms = Date.parse(iso || '');
      if (!Number.isFinite(ms)) return '';
      return typeof root.formatRelativeTime === 'function' ? root.formatRelativeTime(ms) : String(iso).slice(0, 10);
    };
    if (refreshing) return { text: t('airPluginsRefreshing'), warn: false };
    if (info.legacy) return { text: t('airPluginsCatalogUnavailable'), warn: true };
    if (!info.available) return { text: t('airPluginsCatalogMissing'), warn: Boolean(info.error) };
    if (info.error) return { text: t('airPluginsCatalogStale', { time: when(info.fetchedAt) }), warn: true };
    return { text: t('airPluginsCatalogUpdated', { time: when(info.fetchedAt) }), warn: false };
  }

  function toolbar(host, rows) {
    const bar = make('div', null, 'air-plugins-bar');
    const line = catalogLine();
    const status = make('p', line.text, 'air-plugins-hint' + (line.warn ? ' is-warn' : ''));
    status.id = 'air-plugins-catalog-status';
    if (catalogInfo && catalogInfo.error) status.title = catalogInfo.error.message;
    bar.append(status);
    if (catalogInfo && catalogInfo.configured) {
      const refresh = button(t('airPluginsRefresh'), () => { void refreshCatalog(); }, 'air-plugins-back');
      refresh.id = 'air-plugins-refresh';
      refresh.disabled = refreshing;
      bar.append(refresh);
    }
    const categories = [...new Set(rows.map(row => row.category).filter(Boolean))].sort();
    if (categories.length < 2) return [bar];
    const chips = make('div', null, 'air-plugins-chips');
    for (const id of [null, ...categories]) {
      const chip = button(id ? categoryName(id) : t('airPluginsFilterAll'), () => { category = id; paint(host, contextRef); },
        'air-plugins-chip' + (category === id ? ' is-on' : ''));
      chip.dataset.category = id || '';
      chips.append(chip);
    }
    return [bar, chips];
  }

  function renderDetail(host, entry) {
    const wrap = make('section', null, 'air-plugins');
    const head = make('div', null, 'air-plugins-head');
    head.append(button(t('airPluginsBack'), () => { activeId = null; paint(host, contextRef); }, 'air-plugins-back'));
    head.append(make('strong', `${entry.icon || '🧩'} ${pickText(entry, 'name', 'nameEn')}`));
    head.append(make('span', 'v' + (entry.version || ''), 'air-plugins-version'));
    head.append(make('span', entry.engine.reason || t('airPluginsFrameHint'), 'air-plugins-hint'));
    const frame = make('iframe', null, 'air-plugins-frame');
    frame.src = `/plugins/${encodeURIComponent(entry.id)}/${(entry.ui || '').replace(/^\/+/, '')}`;
    frame.title = pickText(entry, 'name', 'nameEn');
    wrap.append(head, frame);
    host.replaceChildren(styleSheet(), wrap);
  }

  let contextRef = null;

  function paint(host, context) {
    if (!host) return;
    if (context) contextRef = context;
    if (activeId && plugins) {
      const row = plugins.find(plugin => plugin.id === activeId);
      const entry = row && row.local;
      if (entry && entry.engine.available && entry.ui) return renderDetail(host, entry);
      activeId = null; // 插件被移除或引擎失效：回清单，别把用户留在空 iframe 上
    }
    const wrap = make('section', null, 'air-plugins');
    if (plugins == null) {
      const loading = make('p', t('airPluginsLoading'), 'air-plugins-hint');
      wrap.append(loading);
      host.replaceChildren(styleSheet(), wrap);
      return;
    }
    if (!plugins.length) {
      const empty = make('div', null, 'air-plugins-empty');
      empty.append(make('div', t('airPluginsEmptyTitle'), 'air-plugins-empty-title'));
      const hint = make('p', null, 'air-plugins-empty-hint');
      hint.append(document.createTextNode(t('airPluginsEmptyHintA')));
      hint.append(make('code', 'plugin.json'));
      hint.append(document.createTextNode(t('airPluginsEmptyHintB')));
      empty.append(hint);
      wrap.append(empty);
      host.replaceChildren(styleSheet(), wrap);
      return;
    }
    wrap.append(...toolbar(host, plugins));
    if (conflicts.length) wrap.append(make('p', t('airPluginsConflict', { ids: conflicts.join(', ') }), 'air-plugins-hint is-warn'));
    const shown = plugins.filter(row => !category || row.category === category);
    const group = (title, rows, id) => {
      if (!rows.length) return;
      const list = make('div', null, 'air-plugins-list');
      list.id = id;
      rows.forEach(row => list.append(renderCard(row)));
      wrap.append(make('h3', title, 'air-plugins-group'), list);
    };
    group(t('airPluginsGroupLocal'), shown.filter(row => LOCAL_STATES.has(row.state)), 'air-plugins-local');
    group(t('airPluginsGroupInstallable'), shown.filter(row => row.state === 'installable'), 'air-plugins-installable');
    const unsupported = shown.filter(row => row.state === 'unsupported');
    if (unsupported.length) {
      const more = make('details', null, 'air-plugins-more');
      more.id = 'air-plugins-unsupported';
      more.append(make('summary', t('airPluginsGroupUnsupported', { count: unsupported.length })));
      const list = make('div', null, 'air-plugins-list');
      unsupported.forEach(row => list.append(renderCard(row)));
      more.append(list);
      wrap.append(more);
    }
    host.replaceChildren(styleSheet(), wrap);
  }

  function accept(payload) {
    plugins = Array.isArray(payload && payload.plugins) ? payload.plugins : [];
    catalogInfo = (payload && payload.catalog) || null;
    conflicts = Array.isArray(payload && payload.conflicts) ? payload.conflicts : [];
  }

  // 旧接口 /api/plugins 的清单 → 面板的行。只知道本机装了什么：内置与否、
  // 在不在列表里都说不上（listed: null），所以一律是「已安装」。
  function fromLegacyList(payload) {
    const list = Array.isArray(payload && payload.plugins) ? payload.plugins : [];
    return {
      catalog: { available: false, configured: false, legacy: true, error: null },
      conflicts: Array.isArray(payload && payload.conflicts) ? payload.conflicts : [],
      plugins: list.map(local => ({
        id: local.id, name: local.name, nameEn: local.nameEn || null, icon: local.icon, category: local.category || null,
        summary: local.description || '', summaryEn: local.descriptionEn || null, homepage: null, listed: null, local,
        state: 'installed', reason: null, installedVersion: local.version || null, candidate: null, latest: null, requires: null,
      })),
    };
  }

  async function load(context) {
    try {
      accept(await context.api('/api/plugins/catalog'));
    } catch (error) {
      // 源码运行合并新代码后、服务重启前，网页已是新的而服务端还没有
      // /api/plugins/catalog：退回旧清单接口照常列出本机插件，状态行写明原因，
      // 不让整页变成「加载失败 / 还没有安装插件」。
      try {
        accept(fromLegacyList(await context.api('/api/plugins')));
      } catch (_) {
        plugins = [];
        context.notice?.(t('airPluginsLoadFail') + (error && error.message ? '：' + error.message : ''));
      }
    }
    paint(document.getElementById('admin-content'), context);
  }

  async function refreshCatalog() {
    if (refreshing || !contextRef) return;
    refreshing = true;
    paint(document.getElementById('admin-content'));
    try {
      accept(await contextRef.api('/api/plugins/catalog/refresh', {}, 'POST'));
    } catch (error) {
      contextRef.notice?.(t('airPluginsLoadFail') + (error && error.message ? '：' + error.message : ''));
    } finally {
      refreshing = false;
      paint(document.getElementById('admin-content'));
    }
  }

  // air-admin.js renderNative 的契约：panel.render(host, ctx) + panel.refresh()。
  function render(host, context) {
    paint(host, context);
    if (plugins == null) void load(context);
  }
  function refresh() {
    plugins = null;
    const host = document.getElementById('admin-content');
    if (host && contextRef) void load(contextRef);
  }

  root.MultiCCAirPlugins = { render, refresh };
})(typeof window !== 'undefined' ? window : globalThis);

/* Shared by scoped console, chat, terminal and settings documents. */
(function (root) {
  'use strict';
  const params = new URLSearchParams(location.search);
  let id = params.get('machine') || '';
  let target = (params.get('machineName') || '').slice(0, 200);
  let targetOrigin = params.get('machineOrigin') || '';
  try {
    if (parent !== root) {
      if (!id) id = parent.MultiCCMachineScope?.id || '';
      if (!target && parent.MultiCCMachineScope?.id === id) target = parent.MultiCCMachineScope.name || '';
      if (!targetOrigin && parent.MultiCCMachineScope?.id === id) targetOrigin = parent.MultiCCMachineScope.origin || '';
    }
  } catch (_) { /* same origin only */ }
  if (!id) return;
  try { const url = new URL(targetOrigin); targetOrigin = /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : ''; } catch (_) { targetOrigin = ''; }
  const valid = /^machine_[A-Za-z0-9_-]{1,100}$/.test(id);
  const prefix = `/api/machines/${encodeURIComponent(id)}`;
  // Pages without i18n.js (or before it loads) must still get scoped DOM
  // rewriting: read window.t defensively and fall back to the zh copy.
  const FALLBACK = {
    airMachinesUnavailable: '连接不可用',
    airMachinesTargetPrefix: '当前操作电脑：',
    airAdminBackToConsole: '返回控制台',
    airMachinesSaveTo: '保存到 {name}',
  };
  function t(key, params) {
    let text = '';
    try { text = typeof root.t === 'function' ? root.t(key, params) : ''; } catch (_) { text = ''; }
    if (!text || text === key) text = FALLBACK[key] || key;
    return params ? String(text).replace(/\{(\w+)\}/g, (match, name) => params[name] != null ? String(params[name]) : match) : text;
  }
  function http(input) {
    if (!valid) throw new Error('电脑标识无效，请返回多电脑页面重新打开');
    const url = new URL(input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/exchange' && !url.pathname.startsWith(`${prefix}/`)) {
      url.pathname = `${prefix}/proxy${url.pathname}`;
      // The entry computer's bootstrap token never belongs in a proxied URL: the
      // target authenticates the proxy with the grant ticket instead.
      url.searchParams.delete('token');
    }
    return url.href;
  }
  // Outermost same-origin window that is still this computer's scope (the
  // scoped /air frame). Scripts that mean "go to another page of this
  // computer" must navigate here, not window.top (the entry console).
  function rootWindow() {
    let win = root;
    try {
      while (win.parent && win.parent !== win && win.parent.MultiCCMachineScope?.id === id) win = win.parent;
    } catch (_) { /* a cross-origin parent ends the walk */ }
    return win;
  }
  root.MultiCCMachineScope = Object.freeze({ id, prefix, http, origin: targetOrigin, navigation: input => navigation(input), rootWindow, get name() { return target; } });
  // Task ids and directory ids may repeat on separate computers. Preference
  // storage stays shared only for presentation settings on this viewing device.
  for (const kind of ['localStorage', 'sessionStorage']) {
    const original = root[kind];
    const shared = key => /^(?:multicc_lang|multicc-language|multicc:lang|lang|theme|chat:width|chat:font|multicc_font|multicc:chat-layout|multicc:notify:)/.test(key);
    const keyFor = key => shared(String(key)) ? String(key) : `machine:${id}:${key}`;
    const storage = {
      getItem: key => original.getItem(keyFor(key)),
      setItem: (key, value) => original.setItem(keyFor(key), value),
      removeItem: key => original.removeItem(keyFor(key)),
      key: n => Object.keys(original).filter(k => k.startsWith(`machine:${id}:`))[n]?.slice(`machine:${id}:`.length) ?? null,
      clear: () => Object.keys(original).filter(k => k.startsWith(`machine:${id}:`)).forEach(k => original.removeItem(k)),
      get length() { return Object.keys(original).filter(k => k.startsWith(`machine:${id}:`)).length; },
    };
    Object.defineProperty(root, kind, { value: storage, configurable: true });
  }
  document.documentElement.dataset.machineScope = id;
  const navigation = input => {
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) return url.href;
    if (url.pathname.startsWith('/api/')) return http(url.href);
    if (/^\/(artifacts|services|plugins)\//.test(url.pathname)) {
      if (targetOrigin) return new URL(url.pathname + url.search + url.hash, targetOrigin).href;
      throw new Error(t('airMachinesUnavailable'));
    }
    url.searchParams.set('machine', id); if (target) url.searchParams.set('machineName', target); if (targetOrigin) url.searchParams.set('machineOrigin', targetOrigin); return url.href;
  };
  const open = root.open;
  root.open = function (url, ...args) { return open.call(root, url ? navigation(url) : url, ...args); };
  const EventSource = root.EventSource;
  if (EventSource) root.EventSource = class extends EventSource { constructor(url, options) { super(http(url), options); } };
  const xhrOpen = root.XMLHttpRequest.prototype.open;
  root.XMLHttpRequest.prototype.open = function (method, url, ...args) { return xhrOpen.call(this, method, http(url), ...args); };
  // Fire-and-forget POSTs (chat-diff cancels an aux summary this way) must not
  // land on the entry computer either.
  const sendBeacon = root.navigator && root.navigator.sendBeacon;
  if (sendBeacon) root.navigator.sendBeacon = function (url, data) { return sendBeacon.call(this, url ? http(url) : url, data); };
  document.addEventListener('DOMContentLoaded', async () => {
    if (params.has('machineDownload')) {
      await root.multiccAuthReady;
      const query = new URLSearchParams({ path: params.get('machineDownload') });
      if (params.get('inline') === '1') query.set('inline', '1');
      root.location.replace(http(`/api/download?${query}`));
      return;
    }
    update(document.documentElement);
    try {
      const response = await root.fetch('/api/machines/self');
      if (response.ok && !target) target = (await response.json()).name;
      markSaves(document.documentElement);
      if (root === root.top) {
        const bar = document.createElement('div');
        bar.id = 'machine-target-banner';
        bar.style.cssText = 'position:sticky;top:0;z-index:9999;padding:12px;background:#eaf4ff;color:#20314a;display:flex;gap:12px;align-items:center';
        bar.append(document.createTextNode(t('airMachinesTargetPrefix') + target));
        const back = document.createElement('button'); back.type = 'button'; back.textContent = t('airAdminBackToConsole');
        back.onclick = () => { root.location.href = '/air'; };
        bar.append(back); document.body.prepend(bar);
      }
    } catch (_) { /* parent target label remains visible during an outage */ }
  });
  function markSaves(element) {
    if (!target) return;
    for (const button of [ ...(element.matches?.('button') ? [element] : []), ...element.querySelectorAll('button') ]) {
      if (!button.dataset.machineSave && !/^(保存|保存配置|Save|Save settings)$/.test(button.textContent.trim())) continue;
      button.dataset.machineSave = '1';
      button.textContent = t('airMachinesSaveTo', { name: target });
      button.removeAttribute('data-i18n');
    }
  }
  // i18n re-applies [data-i18n] text on a language switch; run after it so the
  // "save to X" labels follow the new language instead of staying in the old
  // one (the attribute itself stays removed so applyI18n never resets it).
  const patchI18n = () => {
    const apply = root.applyI18n;
    if (typeof apply !== 'function' || apply.machineScope) return;
    const wrapped = scope => { const result = apply.call(root, scope); markSaves(document.documentElement); return result; };
    wrapped.machineScope = true;
    root.applyI18n = wrapped;
  };
  patchI18n();
  document.addEventListener('DOMContentLoaded', patchI18n);
  // Keep downloads and navigation in scope, including dynamically created chat
  // frames. A scoped frame cannot silently load the entry computer's data.
  function update(element) {
    for (const [selector, attr] of [['a[href]', 'href'], ['iframe[src]', 'src']]) {
      const nodes = [...(element.matches?.(selector) ? [element] : []), ...element.querySelectorAll(selector)];
      for (const node of nodes) {
        const raw = node.getAttribute(attr);
        if (!raw || raw.startsWith('#')) continue;
        const url = new URL(raw, location.href);
        if (url.origin !== location.origin) continue;
        if (url.pathname.startsWith('/api/')) url.href = http(url.href);
        else if (/^\/(artifacts|services|plugins)\//.test(url.pathname) || !/\.(png|jpg|svg|css|js)$/i.test(url.pathname)) {
          try { url.href = navigation(url.href); } catch (_) { node.removeAttribute(attr); node.setAttribute('title', t('airMachinesUnavailable')); continue; }
        }
        if (url.href !== new URL(raw, location.href).href) node.setAttribute(attr, url.href);
      }
    }
    // Images and media an agent points at /api/… must be fetched through the
    // proxy too (chat.js rewrites local files to /api/download?inline=1, the
    // lightbox reuses that URL). Static assets stay on the entry origin, and
    // the "append machine params" rule above must not apply to media.
    const media = 'img[src],source[src],video[src],audio[src],video[poster]';
    for (const node of [...(element.matches?.(media) ? [element] : []), ...element.querySelectorAll(media)]) {
      for (const attr of node.localName === 'video' ? ['src', 'poster'] : ['src']) {
        const raw = node.getAttribute(attr);
        if (!raw || raw.startsWith('#')) continue;
        const url = new URL(raw, location.href);
        if (url.origin !== location.origin) continue;
        if (url.pathname.startsWith('/api/')) url.href = http(url.href);
        else if (/^\/(artifacts|services|plugins)\//.test(url.pathname)) {
          if (!targetOrigin) { node.removeAttribute(attr); node.setAttribute('title', t('airMachinesUnavailable')); continue; }
          url.href = new URL(url.pathname + url.search + url.hash, targetOrigin).href;
        } else continue;
        if (url.href !== new URL(raw, location.href).href) node.setAttribute(attr, url.href);
      }
    }
    markSaves(element);
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') update(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === 1) update(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'src', 'poster'] });
})(window);

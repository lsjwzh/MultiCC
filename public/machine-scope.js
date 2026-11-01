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
  function http(input) {
    if (!valid) throw new Error('电脑标识无效，请返回多电脑页面重新打开');
    const url = new URL(input, location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/exchange' && !url.pathname.startsWith(`${prefix}/`)) {
      url.pathname = `${prefix}/proxy${url.pathname}`;
    }
    return url.href;
  }
  root.MultiCCMachineScope = Object.freeze({ id, prefix, http, origin: targetOrigin, navigation: input => navigation(input), get name() { return target; } });
  // Task ids and directory ids may repeat on separate computers. Preference
  // storage stays shared only for presentation settings on this viewing device.
  for (const kind of ['localStorage', 'sessionStorage']) {
    const original = root[kind];
    const shared = key => /^(?:multicc_lang|multicc-language|multicc:lang|lang|theme|chat:width|chat:font|multicc_font|multicc:chat-layout)/.test(key);
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
      throw new Error(root.t?.('airMachinesUnavailable') || '电脑连接不可用');
    }
    url.searchParams.set('machine', id); if (target) url.searchParams.set('machineName', target); if (targetOrigin) url.searchParams.set('machineOrigin', targetOrigin); return url.href;
  };
  const open = root.open;
  root.open = function (url, ...args) { return open.call(root, url ? navigation(url) : url, ...args); };
  const EventSource = root.EventSource;
  if (EventSource) root.EventSource = class extends EventSource { constructor(url, options) { super(http(url), options); } };
  const xhrOpen = root.XMLHttpRequest.prototype.open;
  root.XMLHttpRequest.prototype.open = function (method, url, ...args) { return xhrOpen.call(this, method, http(url), ...args); };
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
        bar.append(document.createTextNode(root.t('airMachinesTargetPrefix') + target));
        const back = document.createElement('button'); back.type = 'button'; back.textContent = root.t('airAdminBackToConsole');
        back.onclick = () => { root.location.href = '/air'; };
        bar.append(back); document.body.prepend(bar);
      }
    } catch (_) { /* parent target label remains visible during an outage */ }
  });
  function markSaves(element) {
    if (!target) return;
    for (const button of [ ...(element.matches?.('button') ? [element] : []), ...element.querySelectorAll('button') ]) {
      if (/^(保存|保存配置|Save|Save settings)$/.test(button.textContent.trim())) {
        button.textContent = root.t('airMachinesSaveTo', { name: target });
        button.removeAttribute('data-i18n');
      }
    }
  }
  // Keep downloads and navigation in scope, including dynamically created chat
  // frames. A scoped frame cannot silently load the entry computer's data.
  function update(element) {
    markSaves(element);
    for (const [selector, attr] of [['a[href]', 'href'], ['iframe[src]', 'src']]) {
      const nodes = [...(element.matches?.(selector) ? [element] : []), ...element.querySelectorAll(selector)];
      for (const node of nodes) {
        const raw = node.getAttribute(attr);
        if (!raw || raw.startsWith('#')) continue;
        const url = new URL(raw, location.href);
        if (url.origin !== location.origin) continue;
        if (url.pathname.startsWith('/api/')) url.href = http(url.href);
        else if (/^\/(artifacts|services|plugins)\//.test(url.pathname) || !/\.(png|jpg|svg|css|js)$/i.test(url.pathname)) {
          try { url.href = navigation(url.href); } catch (_) { node.removeAttribute(attr); continue; }
        }
        if (url.href !== new URL(raw, location.href).href) node.setAttribute(attr, url.href);
      }
    }
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') update(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === 1) update(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'src'] });
})(window);

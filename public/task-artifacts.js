(function (root) {
  'use strict';
  let scope = null, taskId = null, items = [], query = '', opened = false, stopped = false;
  let timer, request, generation = 0, pollEpoch = 0, signature = '', toggle, panel, list, search, status, title;
  const t = key => root.t('taskArtifacts' + key);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function ensureUi() {
    if (toggle) return;
    toggle = node('button', t('Title'), 'task-artifacts-toggle'); toggle.type = 'button';
    toggle.id = 'task-artifacts-toggle'; toggle.setAttribute('aria-controls', 'task-artifacts-panel');
    toggle.onclick = () => setOpen(!opened);
    const header = document.getElementById('header');
    if (header) header.insertBefore(toggle, header.querySelector('.hdr-spacer'));
    else { const bar = node('div', null, 'task-artifacts-tools'); bar.append(toggle); document.querySelector('main').insertBefore(bar, document.getElementById('history')); }
    panel = node('aside'); panel.id = 'task-artifacts-panel'; panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'task-artifacts-heading');
    const head = node('div', null, 'task-artifacts-head');
    const heading = node('h2', t('Title')); heading.id = 'task-artifacts-heading';
    const close = node('button', '×'); close.type = 'button'; close.id = 'task-artifacts-close';
    close.setAttribute('aria-label', t('Collapse')); close.onclick = () => setOpen(false);
    head.append(heading, close); title = node('p', '', 'task-artifacts-task');
    search = node('input'); search.type = 'search'; search.placeholder = t('Search'); search.setAttribute('aria-label', t('Search'));
    search.oninput = () => { query = search.value.toLowerCase(); renderList(); };
    const tools = node('div', null, 'task-artifacts-actions'), refresh = node('button', t('Refresh'));
    refresh.type = 'button'; refresh.id = 'task-artifacts-refresh'; refresh.onclick = () => { signature = ''; void refreshList(); };
    const manage = node('a', t('Manage')); manage.href = '/manage?view=docs'; manage.target = '_blank'; manage.rel = 'noopener noreferrer';
    tools.append(refresh, manage); status = node('p', '', 'task-artifacts-status'); status.setAttribute('role', 'status');
    list = node('ul'); list.id = 'task-artifacts-list';
    panel.append(head, title, search, tools, status, list); document.body.append(panel);
    document.body.classList.toggle('task-artifacts-chat', !!header);
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && opened) { event.preventDefault(); setOpen(false); }
    });
  }
  function setOpen(value, persist = true) {
    ensureUi(); opened = value; panel.hidden = !opened;
    document.body.classList.toggle('task-artifacts-open', opened);
    toggle.setAttribute('aria-expanded', String(opened));
    toggle.setAttribute('aria-label', t(opened ? 'Collapse' : 'Expand'));
    if (persist && taskId) try { localStorage.setItem(`task-artifacts:${taskId}`, String(opened)); } catch (_) {}
    if (persist) {
      if (opened) { search.focus(); void refreshList(); } else toggle.focus();
    }
  }
  async function copy(url) {
    const value = new URL(url, location.origin).href, previous = document.activeElement;
    try {
      try { await navigator.clipboard.writeText(value); }
      catch (_) {
        const input = node('textarea'); input.value = value; input.className = 'task-artifacts-copy-buffer'; panel.append(input);
        try { input.select(); if (!document.execCommand('copy')) throw new Error('copy'); } finally { input.remove(); previous?.focus(); }
      }
      status.textContent = t('Copied');
    } catch (_) { status.textContent = t('CopyFailed'); }
  }
  function renderList() {
    const visible = items.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(query));
    list.replaceChildren(...visible.map(item => {
      const row = node('li'), link = node('a', item.title, 'task-artifacts-link');
      link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = item.url;
      const path = node('small', item.url, 'task-artifacts-path');
      const meta = node('div', null, 'task-artifacts-meta');
      const time = item.createdAt ? new Date(item.createdAt) : null;
      meta.append(node('span', [t(item.kind === 'page' ? 'Page' : 'File'), time && !Number.isNaN(+time) ? time.toLocaleDateString() : ''].filter(Boolean).join(' · ')));
      if (item.expired) meta.append(node('span', t('Expired'), 'task-artifacts-expired'));
      const button = node('button', t('Copy')); button.type = 'button'; button.setAttribute('aria-label', `${t('Copy')} · ${item.title}`); button.onclick = () => copy(item.url);
      meta.append(button); row.append(link, path, meta); return row;
    }));
    if (!visible.length) list.append(node('li', t(query ? 'NoMatch' : 'Empty'), 'task-artifacts-empty'));
  }
  async function refreshList() {
    if (!scope || stopped || request) return;
    const current = generation, controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = scope.shellId ? `/api/task-shells/${encodeURIComponent(scope.shellId)}/artifacts`
        : `/api/task-shell-tasks/${encodeURIComponent(scope.taskId)}/artifacts`;
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (current !== generation || stopped) return;
      ensureUi();
      if (taskId !== data.taskId) {
        taskId = data.taskId; query = ''; search.value = ''; signature = '';
        let preferred = false; try { preferred = localStorage.getItem(`task-artifacts:${taskId}`) === 'true'; } catch (_) {}
        setOpen(preferred, false);
      }
      title.textContent = data.title || t('NoTask');
      items = (data.items || []).filter(item => typeof item.url === 'string' && /^\/artifacts\/[\w-]+(?:\/[\w./@+-]*)?(?:[?#][^\s\\]*)?$/.test(item.url)
        && !item.url.split(/[?#]/)[0].split('/').some(p => p === '.' || p === '..'));
      toggle.textContent = `${t('Title')} ${items.length}`;
      const next = JSON.stringify(items);
      if (signature !== next) { signature = next; renderList(); }
      status.textContent = '';
    } catch (error) {
      if (current === generation && !stopped && toggle) status.textContent = t('LoadFailed');
    } finally { clearTimeout(timeout); if (request === controller) request = null; }
  }
  function setScope(value) {
    if (!value?.shellId && !value?.taskId) return;
    if (JSON.stringify(scope) === JSON.stringify(value)) return;
    scope = value; generation++; request?.abort(); request = null; items = []; signature = ''; taskId = null;
    ensureUi(); query = ''; search.value = ''; title.textContent = ''; toggle.textContent = t('Title'); status.textContent = t('Loading');
    setOpen(false, false); renderList(); void refreshList();
  }
  async function poll(epoch = pollEpoch) {
    if (stopped || epoch !== pollEpoch) return;
    if (!document.hidden) await refreshList();
    if (!stopped && epoch === pollEpoch) timer = setTimeout(() => poll(epoch), opened ? 5000 : 15000);
  }
  root.addEventListener('pagehide', () => { stopped = true; generation++; pollEpoch++; clearTimeout(timer); request?.abort(); request = null; });
  root.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void poll(); } });
  root.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshList(); });
  root.MultiCCTaskArtifacts = Object.freeze({ setScope, refresh: refreshList });
  void poll();
})(window);

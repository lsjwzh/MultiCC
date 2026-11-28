'use strict';

window.MultiCCAirDetailMessages = (() => {
  const key = m => m.messageKey || m.contextMessageId || m.id;
  let state;

  function render(root, page, api, t) {
    const task = page.task.id;
    const items = page.messages || [];
    if (!state || state.task !== task || !root.firstChild) {
      const heading = document.createElement('h3');
      heading.textContent = t('airDetailMessages');
      const list = document.createElement('div');
      list.className = 'detail-message-list';
      list.tabIndex = 0;
      root.replaceChildren(heading, list);
      state = { task, list, items: [], cursor: null, loading: false, expanded: new Map() };
      list.onscroll = () => { if (list.scrollTop < 36 && list.scrollHeight > list.clientHeight) older(); };
    }
    const s = state;
    const path = '/api/air/tasks/' + encodeURIComponent(task);
    const overlap = items.length ? s.items.findIndex(m => key(m) === key(items[0])) : -1;
    const atBottom = s.list.scrollHeight - s.list.scrollTop - s.list.clientHeight < 32;
    const scrolled = s.list.scrollTop;
    for (const m of items) {
      if (s.expanded.has(key(m))) {
        const old = s.items.find(row => key(row) === key(m));
        if (!old || old.inProgress || JSON.stringify(old) !== JSON.stringify(m)) s.expanded.delete(key(m));
      }
    }
    s.items = overlap > 0 ? [...s.items.slice(0, overlap), ...items] : items;
    if (overlap <= 0) s.cursor = page.hasMore && page.before;
    root.hidden = !s.items.length;
    s.alignOnOpen = !s.list.clientHeight && (atBottom || overlap < 0);
    paint();
    s.list.scrollTop = atBottom || overlap < 0 ? s.list.scrollHeight : scrolled;

    function button(label, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = async () => {
        b.disabled = true;
        try { await fn(); } finally { b.disabled = false; }
      };
      return b;
    }
    async function older() {
      if (s !== state || !s.cursor || s.loading) return;
      s.loading = true;
      const cursor = s.cursor;
      try {
        const page = await api(path + '?before=' + encodeURIComponent(cursor));
        if (s !== state || cursor !== s.cursor) return;
        const known = new Set(s.items.map(key));
        const rows = (page.messages || []).filter(m => !known.has(key(m)));
        const height = s.list.scrollHeight;
        const top = s.list.scrollTop;
        s.items.unshift(...rows);
        s.cursor = page.hasMore && page.before !== cursor && page.before;
        paint();
        s.list.scrollTop = top + s.list.scrollHeight - height;
      } catch (e) { showError(e); } finally { s.loading = false; }
    }
    function showError(error) {
      if (s !== state) return;
      const status = s.list.querySelector('[role=status]') || document.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent = error.message;
      s.list.prepend(status);
    }
    function paint() {
      const nodes = [];
      if (s.cursor) nodes.push(button(t('airDetailOlderMessages'), older));
      for (const preview of s.items) {
        const id = key(preview);
        const m = s.expanded.get(id) || preview;
        const article = document.createElement('article');
        const body = document.createElement('pre');
        body.textContent = [typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          m.toolsExcerpt || (m.tools?.length ? JSON.stringify(m.tools, null, 2) : '')].filter(Boolean).join('\n');
        const role = document.createElement('strong');
        role.textContent = m.role || '';
        article.append(role, body);
        if (m.truncated && m.canExpand !== false && id && !s.expanded.has(id)) {
          article.append(button(t('airDetailExpandMessage'), async () => {
            try {
              const result = await api(path + '?messageId=' + encodeURIComponent(id));
              if (s !== state || !result.message) return;
              s.expanded.set(id, result.message);
              paint();
            } catch (e) { showError(e); }
          }));
        }
        nodes.push(article);
      }
      s.list.replaceChildren(...nodes);
    }
  }
  function reset(root) {
    state = null;
    root.replaceChildren();
    root.hidden = true;
  }
  function shown() {
    if (state?.alignOnOpen) {
      state.list.scrollTop = state.list.scrollHeight;
      state.alignOnOpen = false;
    }
  }
  return { render, reset, shown };
})();

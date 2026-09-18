(function (root) {
  'use strict';

  const CODE_RE = /^[0-9A-Z]{4}$/;

  function text(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function createController(options = {}) {
    const doc = options.document || root.document;
    const messages = options.messagesEl;
    if (!doc || !messages) throw new TypeError('document and messagesEl are required');
    const storage = options.storage || root.localStorage;
    const translate = typeof options.translate === 'function'
      ? options.translate : key => key === 'taskIndexToggle' ? '任务索引' : key;
    const detach = typeof options.onDetach === 'function' ? options.onDetach : null;
    let open = false;
    try { open = storage?.getItem('multicc:task-index-open') === '1'; } catch (_) {}
    let highlighted = null;
    let timer = null;

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.id = 'task-index-toggle';
    toggle.className = 'task-index-toggle';
    toggle.textContent = '☷';
    toggle.title = translate('taskIndexToggle');
    toggle.setAttribute('aria-label', translate('taskIndexToggle'));
    toggle.setAttribute('aria-expanded', 'false');

    const rail = doc.createElement('aside');
    rail.id = 'task-index-rail';
    rail.className = 'task-index-rail';
    rail.hidden = true;
    rail.setAttribute('aria-label', translate('taskIndexLabel'));

    function clearHighlight() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      highlighted?.classList?.remove('task-index-target');
      highlighted = null;
    }

    function entries() {
      const found = new Map();
      for (const node of messages.querySelectorAll('.msg[data-task-short-code]')) {
        const code = text(node.dataset.taskShortCode).trim().toUpperCase();
        if (!CODE_RE.test(code) || found.has(code)) continue;
        found.set(code, {
          code,
          node,
          taskId: text(node.dataset.taskId).trim(),
          title: text(node.dataset.taskName).trim(),
        });
      }
      return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
    }

    function focus(entry) {
      if (!entry?.node) return;
      clearHighlight();
      highlighted = entry.node;
      highlighted.classList.add('task-index-target');
      highlighted.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      timer = setTimeout(clearHighlight, 3200);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function render() {
      const list = entries();
      toggle.hidden = list.length === 0;
      rail.hidden = !open || list.length === 0;
      toggle.setAttribute('aria-expanded', String(!rail.hidden));
      rail.replaceChildren(...list.map(entry => {
        const row = doc.createElement('div');
        row.className = 'task-index-row';
        const button = doc.createElement('button');
        button.type = 'button'; button.className = 'task-index-item';
        button.textContent = entry.code;
        button.title = entry.title ? `${entry.code} · ${entry.title}` : entry.code;
        button.setAttribute('aria-label', button.title);
        button.onclick = () => focus(entry);
        row.append(button);
        if (entry.taskId && detach) {
          const action = doc.createElement('button');
          action.type = 'button'; action.className = 'task-index-detach';
          action.textContent = '⤴';
          action.title = translate('taskIndexDetach');
          action.setAttribute('aria-label', `${translate('taskIndexDetach')} ${entry.code}`);
          action.onclick = event => { event.stopPropagation(); void detach(entry); };
          row.append(action);
        }
        return row;
      }));
    }

    toggle.onclick = () => {
      open = !open;
      try { storage?.setItem('multicc:task-index-open', open ? '1' : '0'); } catch (_) {}
      render();
    };
    doc.body.append(toggle, rail);
    const Observer = root.MutationObserver;
    const observer = typeof Observer === 'function'
      ? new Observer(() => render()) : null;
    observer?.observe(messages, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-task-short-code', 'data-task-id', 'data-task-name'] });
    render();

    return Object.freeze({
      refresh: render,
      dispose() { observer?.disconnect(); clearHighlight(); toggle.remove(); rail.remove(); },
      toggle() { toggle.click(); },
      focusCode(code) { const value = entries().find(entry => entry.code === text(code).toUpperCase()); focus(value); },
      isOpen: () => open,
    });
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);

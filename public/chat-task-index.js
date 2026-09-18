(function (root) {
  'use strict';

  const CODE_RE = /^[0-9A-Z]{4}$/;

  function text(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function codeOf(value) {
    const code = text(value).trim().toUpperCase();
    return CODE_RE.test(code) ? code : '';
  }

  function refId(ref) {
    return text(ref?.id || ref?.sourceMessageId || '').trim();
  }

  // Page-level glue for an index jump, kept here so the fallback order is
  // testable: the requested segment's anchor first, then the task's own
  // boundaries — when a message was deleted, the nearest still-visible record is
  // one of those. Returns false only when nothing could be located, which is the
  // signal that the row should be reported as dead instead of looking live.
  function createAnchorJump({ findById, fetchAround, merge, locate, report = () => {} }) {
    return async function jump(ref, entry) {
      const anchors = [];
      const push = value => {
        const id = refId(value);
        if (id && !anchors.includes(id)) anchors.push(id);
      };
      push(ref);
      push(entry?.segments?.[0]?.firstMessageRef);
      push(entry?.firstMessageRef);
      push(entry?.lastMessageRef);
      for (const id of anchors) {
        try {
          if (!findById(id)) {
            const page = await fetchAround(id);
            if (page?.found !== true) continue;
            merge(page.messages, page);
          }
          if (locate(id) === true) return true;
        } catch (error) { report(error); }
      }
      return false;
    };
  }

  function createController(options = {}) {
    const doc = options.document || root.document;
    const messages = options.messagesEl;
    if (!doc || !messages) throw new TypeError('document and messagesEl are required');
    const storage = options.storage || root.localStorage;
    const translate = typeof options.translate === 'function'
      ? options.translate : key => key === 'taskIndexToggle' ? '任务索引' : key;
    const detach = typeof options.onDetach === 'function' ? options.onDetach : null;
    const loadIndex = typeof options.loadIndex === 'function' ? options.loadIndex : null;
    const navigate = typeof options.navigate === 'function' ? options.navigate : null;
    const onMissing = typeof options.onMissing === 'function' ? options.onMissing : null;
    let open = false;
    try { open = storage?.getItem('multicc:task-index-open') === '1'; } catch (_) {}
    let highlighted = null;
    let timer = null;
    let index = null;
    let loading = null;
    let pendingRef = null;
    let signature = '';
    // Codes whose anchors could not be located in this conversation. They stay
    // in the directory (the task exists) but must not keep looking live.
    const dead = new Set();

    function isStale(entry) {
      return entry?.stale === true || (entry?.code ? dead.has(entry.code) : false);
    }

    function markDead(entry) {
      if (!entry?.code || dead.has(entry.code)) return;
      dead.add(entry.code);
      render();
    }

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

    function nodeFor(messageId) {
      if (!messageId) return null;
      const found = messages.querySelectorAll?.('.msg[data-msg-id]') || [];
      for (const node of found) if (node?.dataset?.msgId === messageId) return node;
      return null;
    }

    function domEntries() {
      const found = new Map();
      for (const node of messages.querySelectorAll('.msg[data-task-short-code]')) {
        const code = codeOf(node.dataset?.taskShortCode);
        if (!code || found.has(code)) continue;
        found.set(code, { code, node, taskId: text(node.dataset?.taskId).trim(),
          title: text(node.dataset?.taskName).trim(), segments: [], capabilities: {} });
      }
      return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
    }

    // Server entries keep the conversation order (first appearance) so the list
    // matches scrolling; the DOM fallback keeps its historical code order.
    function serverEntries() {
      const tasks = Array.isArray(index?.tasks) ? index.tasks : [];
      return tasks
        .filter(task => task && (codeOf(task.shortCode) || task.taskId))
        .map(task => ({
          code: codeOf(task.shortCode) || text(task.taskId).slice(-4).toUpperCase(),
          taskId: text(task.taskId).trim(),
          title: text(task.title).trim(),
          segments: Array.isArray(task.segments) ? task.segments : [],
          capabilities: task.capabilities && typeof task.capabilities === 'object' ? task.capabilities : {},
          stale: task.stale === true,
          node: null,
        }));
    }

    function entries() {
      return index && Array.isArray(index.tasks) ? serverEntries() : domEntries();
    }

    function activate(node) {
      if (!node) return false;
      clearHighlight();
      highlighted = node;
      highlighted.classList.add('task-index-target');
      highlighted.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      timer = setTimeout(clearHighlight, 3200);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return true;
    }

    function locate(entry, segment) {
      const ref = segment?.firstMessageRef || entry?.segments?.[0]?.firstMessageRef || null;
      const direct = entry?.node || nodeFor(refId(ref));
      if (direct) { pendingRef = null; return activate(direct); }
      if (!ref || !navigate) { markDead(entry); onMissing?.(entry); return false; }
      pendingRef = ref;
      let result;
      try { result = navigate(ref, entry); }
      catch (_) { pendingRef = null; markDead(entry); onMissing?.(entry); return false; }
      // The host paginates asynchronously: a jump into unloaded history only
      // proves it landed once the fetch says so. Reporting "missing" here is
      // what turns a silent dead click into something the user can understand.
      if (result && typeof result.then === 'function') {
        const attempt = pendingRef;
        void Promise.resolve(result).then(ok => {
          if (ok !== false) return;
          if (pendingRef === attempt) pendingRef = null;
          markDead(entry);
          onMissing?.(entry);
        }).catch(() => {
          if (pendingRef === attempt) pendingRef = null;
          markDead(entry);
          onMissing?.(entry);
        });
      } else if (result === false) {
        pendingRef = null;
        markDead(entry);
        onMissing?.(entry);
        return false;
      }
      return true;
    }

    function render() {
      const list = entries();
      const next = JSON.stringify(list.map(entry => [entry.code, entry.taskId, entry.title,
        isStale(entry), entry.capabilities?.canDetach === true, entry.segments.length]));
      if (next === signature) { toggle.hidden = list.length === 0; rail.hidden = !open || list.length === 0;
        toggle.setAttribute('aria-expanded', String(!rail.hidden)); return; }
      signature = next;
      toggle.hidden = list.length === 0;
      rail.hidden = !open || list.length === 0;
      toggle.setAttribute('aria-expanded', String(!rail.hidden));
      rail.replaceChildren(...list.map(entry => {
        const row = doc.createElement('div');
        row.className = 'task-index-row';
        // A task whose history was trimmed or whose anchors were deleted still
        // belongs in the directory, but its row must not look like a live one.
        if (isStale(entry)) row.dataset.stale = 'true';
        const button = doc.createElement('button');
        button.type = 'button'; button.className = 'task-index-item';
        button.textContent = entry.code;
        button.title = entry.title ? `${entry.code} · ${entry.title}` : entry.code;
        button.setAttribute('aria-label', button.title);
        button.onclick = () => locate(entry, null);
        row.append(button);
        if (entry.segments.length > 1) {
          const strip = doc.createElement('span');
          strip.className = 'task-index-segments';
          entry.segments.forEach((segment, position) => {
            const dot = doc.createElement('button');
            dot.type = 'button'; dot.className = 'task-index-segment';
            dot.textContent = '·';
            dot.title = translate('taskIndexSegmentLabel').replace('{n}', String(position + 1));
            dot.setAttribute('aria-label', `${entry.code} ${dot.title}`);
            dot.onclick = event => { event.stopPropagation?.(); locate(entry, segment); };
            strip.append(dot);
          });
          row.append(strip);
        }
        if (entry.taskId && detach && entry.capabilities?.canDetach !== false) {
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

    function reload() {
      if (!loadIndex) return null;
      if (loading) return loading;
      loading = Promise.resolve().then(loadIndex).then(value => {
        if (value && Array.isArray(value.tasks)) { index = value; render(); }
        return value;
      }).catch(() => null).finally(() => { loading = null; });
      return loading;
    }

    toggle.onclick = () => {
      open = !open;
      try { storage?.setItem('multicc:task-index-open', open ? '1' : '0'); } catch (_) {}
      if (open) void reload();
      render();
    };
    doc.body.append(toggle, rail);
    const Observer = root.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => {
      if (pendingRef) {
        const node = nodeFor(refId(pendingRef));
        if (node) { pendingRef = null; activate(node); }
      }
      render();
    }) : null;
    observer?.observe(messages, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-task-short-code', 'data-task-id', 'data-task-name', 'data-msg-id'] });
    render();
    if (open) void reload();

    return Object.freeze({
      refresh: render,
      reload,
      dispose() { observer?.disconnect(); clearHighlight(); toggle.remove(); rail.remove(); },
      toggle() { toggle.click(); },
      focusCode(code) {
        const value = entries().find(entry => entry.code === codeOf(code));
        return locate(value, null);
      },
      // Called by the host once an anchor fetched through history pagination is
      // in the DOM, so a jump to an unloaded turn still lands and highlights.
      markLocated(messageId) {
        const node = nodeFor(messageId);
        if (!node) return false;
        pendingRef = null;
        return activate(node);
      },
      isOpen: () => open,
      index: () => index,
    });
  }

  // Fork action for one index entry. The operation id is minted once per
  // attempt and reused on retry, so a lost response cannot create a duplicate
  // copy; the server dedupes on the same clientMsgId.
  function createDetachAction({ request, openUrl, confirm, alert, translate = key => key }) {
    const attempts = new Map();
    return async function detach(entry) {
      const taskId = text(entry?.taskId).trim();
      if (!taskId) return false;
      const code = codeOf(entry?.code) || taskId.slice(-4).toUpperCase();
      if (typeof confirm === 'function'
        && !(await confirm(translate('taskIndexDetachConfirm').replace('{code}', code), { okText: translate('taskIndexDetach') }))) return false;
      let clientMsgId = attempts.get(taskId);
      if (!clientMsgId) {
        clientMsgId = `index-${taskId}-${Date.now().toString(36)}`;
        attempts.set(taskId, clientMsgId);
      }
      try {
        const result = await request(`/api/task-shell-tasks/${encodeURIComponent(taskId)}/fork`, { clientMsgId });
        attempts.delete(taskId);
        const url = text(result?.url) || (result?.taskId ? `/air?task=${encodeURIComponent(result.taskId)}` : '');
        if (url) {
          if (typeof openUrl !== 'function' || !openUrl(url)) {
            alert?.(translate('taskIndexDetachOpen').replace('{url}', url));
          }
        }
        return true;
      } catch (error) {
        // The attempt id is intentionally kept for retry, so a response lost in
        // transit resolves to the same server-side operation instead of a copy.
        alert?.(translate('taskIndexDetachFailed').replace('{error}', text(error?.message || error)));
        return false;
      }
    };
  }

  const api = { createController, createDetachAction, createAnchorJump };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCTaskIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);

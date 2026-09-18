(function (root) {
  'use strict';

  // Manual whole-turn re-attribution, the client half of the P1 overlay.
  //
  // The server owns the decision: this module only collects whole turns, asks
  // for a preview, and applies the same operation it previewed. Nothing here
  // edits a transcript, moves code, or starts an execution — moving a turn
  // changes which logical task it answers to and nothing else.
  //
  // Turns, not messages, are the unit. A bubble belongs to a turn only when the
  // server stamped both the turn id and its source session on it; messages
  // without that provenance (inherited history, live tails) are not movable and
  // deliberately get no pick control.

  const TURN_SELECTOR = '.msg[data-msg-id][data-turn-id]';

  function text(value) {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
  }

  function turnKeyOf(node) {
    const sessionId = text(node?.dataset?.sourceSessionId).trim();
    const turnId = text(node?.dataset?.turnId).trim();
    return sessionId && turnId ? `${sessionId}:${turnId}` : '';
  }

  function createController(options = {}) {
    const doc = options.document || root.document;
    const messages = options.messagesEl;
    if (!doc || !messages) throw new TypeError('document and messagesEl are required');
    const t = typeof options.translate === 'function' ? options.translate : key => key;
    const request = typeof options.request === 'function' ? options.request : null;
    const scope = typeof options.scope === 'function' ? options.scope : null;
    const loadIndex = typeof options.loadIndex === 'function' ? options.loadIndex : null;
    const onApplied = typeof options.onApplied === 'function' ? options.onApplied : null;
    const report = typeof options.report === 'function' ? options.report : () => {};
    const makeId = typeof options.makeId === 'function' ? options.makeId
      : () => `attr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const picks = new Map();       // turnKey → { node, pick, taskId }
    const selected = new Set();
    let enabled = false;
    let busy = false;
    let preview = null;
    let targetId = '';
    let tasks = [];
    let toast = null;
    let toastTimer = null;

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.id = 'task-attribution-toggle';
    toggle.className = 'task-attribution-toggle';
    toggle.textContent = '⇄';
    toggle.hidden = true;
    toggle.title = t('taskAttributionToggle');
    toggle.setAttribute('aria-label', t('taskAttributionToggle'));
    toggle.setAttribute('aria-expanded', 'false');

    const bar = doc.createElement('div');
    bar.id = 'task-attribution-bar';
    bar.className = 'task-attribution-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('taskAttributionToggle'));

    const hint = doc.createElement('span');
    hint.className = 'task-attribution-hint';
    const count = doc.createElement('span');
    count.className = 'task-attribution-count';
    const select = doc.createElement('select');
    select.className = 'task-attribution-target';
    select.setAttribute('aria-label', t('taskAttributionTarget'));
    const summary = doc.createElement('span');
    summary.className = 'task-attribution-summary';
    const apply = doc.createElement('button');
    apply.type = 'button';
    apply.className = 'task-attribution-apply';
    apply.textContent = t('taskAttributionApply');
    apply.disabled = true;
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'task-attribution-cancel';
    cancel.textContent = t('taskAttributionCancel');
    bar.append(hint, count, select, summary, apply, cancel);

    function labelOf(task) {
      const code = text(task?.shortCode).trim().toUpperCase();
      const title = text(task?.title).trim();
      return [code, title].filter(Boolean).join(' · ') || text(task?.taskId).slice(-4).toUpperCase();
    }

    function targetLabel() {
      const task = tasks.find(entry => entry.taskId === targetId);
      return task ? labelOf(task) : text(targetId);
    }

    function setSummary(value, tone) {
      summary.textContent = value || '';
      summary.dataset.tone = tone || '';
    }

    function renderBar() {
      bar.hidden = !enabled;
      toggle.setAttribute('aria-expanded', String(enabled));
      toggle.classList.toggle('active', enabled);
      count.textContent = t('taskAttributionSelected').replace('{n}', String(selected.size));
      hint.textContent = t('taskAttributionHint');
      select.hidden = tasks.length === 0;
      apply.disabled = busy || !preview || preview.changed === 0 || (preview.blocked || []).length > 0
        || selected.size === 0 || !targetId;
      cancel.disabled = busy;
    }

    function blockedText(blocked) {
      const reasons = [...new Set((blocked || []).map(item => text(item?.reason)))].filter(Boolean);
      const words = reasons.map(reason => reason === 'turn_busy' ? t('taskAttributionReasonBusy')
        : reason === 'turn_not_found' ? t('taskAttributionReasonMissing') : reason);
      return words.join(' / ');
    }

    function clearPreview() {
      preview = null;
      setSummary('');
    }

    function syncPicks() {
      for (const [key, entry] of picks) {
        const on = selected.has(key);
        entry.pick.textContent = on ? '●' : '○';
        entry.pick.classList.toggle('picked', on);
        entry.pick.setAttribute('aria-pressed', String(on));
      }
    }

    function selectTurn(taskId) {
      const list = tasks.length ? tasks : [];
      select.replaceChildren(...list.map(task => {
        const option = doc.createElement('option');
        option.value = text(task.taskId);
        option.textContent = labelOf(task);
        return option;
      }));
      // Default to the task of the first picked turn: moving a turn back is the
      // common repair, and a wrong default is one click away either way.
      if (!targetId && list.length) targetId = text(list[0].taskId);
      select.value = targetId;
    }

    async function loadTasks() {
      if (!loadIndex || !scope) return;
      try {
        const { shellId } = await scope();
        const index = await loadIndex(shellId);
        const rows = Array.isArray(index?.tasks) ? index.tasks : [];
        tasks = rows.filter(task => task && text(task.taskId));
        if (!tasks.some(task => text(task.taskId) === targetId)) {
          targetId = tasks.length ? text(tasks[0].taskId) : '';
        }
        selectTurn();
      } catch (error) {
        tasks = [];
        selectTurn();
      }
    }

    function taskOfTurn(key) {
      return picks.get(key)?.taskId || '';
    }

    async function refreshPreview() {
      if (!enabled || selected.size === 0 || !targetId || !scope || !request) { clearPreview(); renderBar(); return; }
      const turns = [...selected].map(key => {
        const split = key.indexOf(':');
        return { sessionId: key.slice(0, split), turnId: key.slice(split + 1) };
      });
      try {
        const { shellId } = await scope();
        preview = await request('POST', `/api/task-shells/${encodeURIComponent(shellId)}/task-operations/preview`, {
          turns, target: { taskId: targetId },
        });
        const blocked = preview?.blocked || [];
        if (blocked.length) setSummary(t('taskAttributionBlocked').replace('{reason}', blockedText(blocked)), 'warn');
        else if (preview?.changed > 0) setSummary(t('taskAttributionPreview').replace('{n}', String(preview.changed)), 'ok');
        else setSummary(t('taskAttributionNothing'), 'muted');
      } catch (error) {
        clearPreview();
        setSummary(error?.message || String(error), 'error');
      }
      renderBar();
    }

    function pick(key) {
      if (!enabled) return;
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      clearPreview();
      syncPicks();
      renderBar();
      void refreshPreview();
    }

    // The toggle must appear as soon as the conversation has a movable turn —
    // that is a property of the history, not of the mode. Picks themselves only
    // exist while the mode is on.
    function decorate() {
      const first = new Map();
      for (const node of messages.querySelectorAll?.(TURN_SELECTOR) || []) {
        const key = turnKeyOf(node);
        if (!key || first.has(key)) continue;
        first.set(key, node);
      }
      if (!enabled) {
        for (const [, entry] of picks) entry.pick.remove();
        picks.clear();
        selected.clear();
        toggle.hidden = first.size === 0;
        renderBar();
        return;
      }
      for (const [key, entry] of [...picks]) {
        const node = first.get(key);
        if (!node) {
          entry.pick.remove();
          picks.delete(key);
          selected.delete(key);
          continue;
        }
        if (node !== entry.node) {
          // A prepended older page can reorder which bubble starts the turn.
          entry.pick.remove();
          entry.node = node;
          node.insertBefore(entry.pick, node.firstChild);
          entry.taskId = text(node.dataset?.taskId).trim();
        }
      }
      for (const [key, node] of first) {
        if (picks.has(key)) continue;
        const control = doc.createElement('button');
        control.type = 'button';
        control.className = 'task-attribution-pick';
        control.textContent = selected.has(key) ? '●' : '○';
        control.setAttribute('aria-pressed', String(selected.has(key)));
        const code = text(node.dataset?.taskShortCode).trim().toUpperCase();
        const name = text(node.dataset?.taskName).trim();
        control.title = [code, name].filter(Boolean).join(' · ') || t('taskAttributionToggle');
        control.setAttribute('aria-label', control.title);
        control.onclick = event => { event.stopPropagation?.(); pick(key); };
        node.insertBefore(control, node.firstChild);
        picks.set(key, { node, pick: control, taskId: text(node.dataset?.taskId).trim() });
      }
      toggle.hidden = picks.size === 0 && first.size === 0;
      renderBar();
    }

    function closeToast() {
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = null;
      toast?.remove();
      toast = null;
    }

    function showToast(message, action) {
      closeToast();
      toast = doc.createElement('div');
      toast.className = 'task-attribution-toast';
      toast.setAttribute('role', 'status');
      const label = doc.createElement('span');
      label.textContent = message;
      toast.append(label);
      if (action) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'task-attribution-undo';
        button.textContent = t('taskAttributionUndo');
        button.onclick = () => { void action(); };
        toast.append(button);
      }
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'task-attribution-toast-close';
      close.textContent = '×';
      close.setAttribute('aria-label', t('taskAttributionCancel'));
      close.onclick = closeToast;
      toast.append(close);
      doc.body.append(toast);
      toastTimer = setTimeout(closeToast, 12000);
      if (toastTimer && typeof toastTimer.unref === 'function') toastTimer.unref();
    }

    async function undo(operationId) {
      try {
        const result = await request('POST', `/api/task-operations/${encodeURIComponent(operationId)}/undo`, { clientMsgId: makeId() });
        closeToast();
        showToast(t('taskAttributionUndone'));
        onApplied?.(result, { undone: true });
      } catch (error) {
        closeToast();
        showToast(t('taskAttributionUndoFailed').replace('{error}', text(error?.message || error)));
      }
    }

    async function applyNow() {
      if (busy || !preview || !targetId || !scope || !request) return null;
      busy = true;
      renderBar();
      apply.disabled = true;
      const turns = [...selected].map(key => {
        const split = key.indexOf(':');
        return { sessionId: key.slice(0, split), turnId: key.slice(split + 1) };
      });
      try {
        const { shellId } = await scope();
        const result = await request('POST', `/api/task-shells/${encodeURIComponent(shellId)}/task-operations`, {
          turns, target: { taskId: targetId }, clientMsgId: makeId(),
          previewToken: preview.previewToken, expectedRevision: preview.scopeRevision,
        });
        const moved = (result?.effects || []).length;
        selected.clear();
        clearPreview();
        syncPicks();
        showToast(t('taskAttributionApplied').replace('{n}', String(moved)).replace('{task}', targetLabel()),
          result?.id ? () => undo(result.id) : null);
        onApplied?.(result, { undone: false });
        return result;
      } catch (error) {
        setSummary(t('taskAttributionFailed').replace('{error}', text(error?.message || error)), 'error');
        report(error);
        return null;
      } finally {
        busy = false;
        await refreshPreview();
      }
    }

    function setEnabled(next) {
      const value = next === true;
      if (value === enabled) return enabled;
      enabled = value;
      if (!enabled) {
        selected.clear();
        clearPreview();
        for (const [, entry] of picks) entry.pick.remove();
        picks.clear();
      } else {
        void loadTasks().then(decorate);
      }
      decorate();
      renderBar();
      return enabled;
    }

    toggle.onclick = () => setEnabled(!enabled);
    cancel.onclick = () => setEnabled(false);
    apply.onclick = () => { void applyNow(); };
    select.onchange = () => { targetId = text(select.value); clearPreview(); renderBar(); void refreshPreview(); };

    doc.body.append(toggle, bar);
    const Observer = root.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(() => decorate()) : null;
    observer?.observe(messages, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-turn-id', 'data-msg-id', 'data-task-id'] });
    decorate();

    const api = {
      refresh: decorate,
      setEnabled,
      isEnabled: () => enabled,
      selected: () => [...selected],
      turns: () => picks.size,
      applyNow,
      dispose() { closeToast(); observer?.disconnect(); toggle.remove(); bar.remove(); },
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
  }

  const exported = { createController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.MultiCCTaskAttribution = exported;
})(typeof window !== 'undefined' ? window : globalThis);

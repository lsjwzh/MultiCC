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
    const loadSuggestions = typeof options.loadSuggestions === 'function' ? options.loadSuggestions : null;
    const onApplied = typeof options.onApplied === 'function' ? options.onApplied : null;
    const confirmContinue = typeof options.confirmContinue === 'function' ? options.confirmContinue : null;
    const openUrl = typeof options.openUrl === 'function' ? options.openUrl : null;
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
    let suggestions = [];
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
    // 独立继续（P3）作用于选中的目标任务本身，与「移动哪些轮次」无关，
    // 所以它自己的按钮不参与勾选状态。
    const resume = doc.createElement('button');
    resume.type = 'button';
    resume.className = 'task-attribution-continue';
    resume.textContent = t('taskAttributionContinue');
    resume.disabled = true;
    // Automatic suggestions (P2 `suggest` tier) live above the picker: they are
    // the same verdict the picker would produce by hand, already recorded and
    // waiting for a yes or no.
    const proposals = doc.createElement('div');
    proposals.className = 'task-attribution-suggestions';
    proposals.hidden = true;
    bar.append(proposals, hint, count, select, summary, apply, cancel, resume);

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
      // The toggle carries the count so a suggestion is visible without
      // entering the mode at all.
      toggle.dataset.suggestions = String(suggestions.length);
      toggle.title = suggestions.length
        ? `${t('taskAttributionToggle')} · ${t('taskAttributionSuggestions').replace('{n}', String(suggestions.length))}`
        : t('taskAttributionToggle');
      count.textContent = t('taskAttributionSelected').replace('{n}', String(selected.size));
      hint.textContent = t('taskAttributionHint');
      select.hidden = tasks.length === 0;
      apply.disabled = busy || !preview || preview.changed === 0 || (preview.blocked || []).length > 0
        || selected.size === 0 || !targetId;
      cancel.disabled = busy;
      resume.disabled = busy || !targetId || !request || !scope;
      resume.title = targetId
        ? t('taskAttributionContinueConfirm').replace('{task}', targetLabel())
        : t('taskAttributionContinue');
    }

    function taskLabel(taskId) {
      const task = tasks.find(entry => text(entry.taskId) === text(taskId));
      return task ? labelOf(task) : text(taskId).slice(-4).toUpperCase();
    }

    function renderSuggestions() {
      const pending = suggestions.filter(item => item?.state === 'pending');
      proposals.hidden = pending.length === 0;
      proposals.replaceChildren(...pending.map(item => {
        const row = doc.createElement('div');
        row.className = 'task-attribution-suggestion';
        const label = doc.createElement('span');
        label.className = 'task-attribution-suggestion-label';
        label.textContent = t('taskAttributionSuggestion')
          .replace('{from}', taskLabel(item.fromTaskId)).replace('{to}', taskLabel(item.toTaskId));
        row.append(label);
        for (const [key, action] of [['taskAttributionAccept', 'accept'], ['taskAttributionDismiss', 'dismiss']]) {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = `task-attribution-suggestion-${action}`;
          button.textContent = t(key);
          button.onclick = () => { void decideSuggestion(item, action, button); };
          row.append(button);
        }
        return row;
      }));
      renderBar();
    }

    async function decideSuggestion(item, action, button) {
      if (busy || !scope || !request) return;
      busy = true;
      if (button) button.disabled = true;
      renderBar();
      try {
        const { shellId } = await scope();
        const path = `/api/task-shells/${encodeURIComponent(shellId)}/attribution-decisions/${encodeURIComponent(item.id)}/${action}`;
        const result = await request('POST', path, action === 'accept' ? { clientMsgId: makeId() } : {});
        closeToast();
        showToast(action === 'accept'
          ? t('taskAttributionApplied').replace('{n}', '1').replace('{task}', taskLabel(result?.toTaskId || item.toTaskId))
          : t('taskAttributionDismissed'));
        suggestions = suggestions.filter(entry => entry.id !== item.id);
        onApplied?.(result, { undone: false });
      } catch (error) {
        setSummary(t('taskAttributionFailed').replace('{error}', text(error?.message || error)), 'error');
        report(error);
      } finally {
        busy = false;
        await refreshSuggestions();
      }
    }

    async function refreshSuggestions() {
      if (!loadSuggestions || !scope) { suggestions = []; renderSuggestions(); return []; }
      try {
        const { shellId } = await scope();
        const data = await loadSuggestions(shellId);
        suggestions = (Array.isArray(data?.decisions) ? data.decisions : []).filter(item => item?.state === 'pending');
      } catch (_) {
        suggestions = [];
      }
      renderSuggestions();
      return suggestions;
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

    // Independent continuation never waits on the browser: the request is a
    // durable server-side operation, and a `waiting` answer is an outcome, not
    // an error. The operation id is minted once per task and reused on retry,
    // so a lost response cannot prepare two environments.
    const attempts = new Map();
    function reasonLabel(reason) {
      switch (text(reason)) {
        case 'turn_busy': return t('taskAttributionWaitTurnBusy');
        case 'awaiting_answer': return t('taskAttributionWaitAnswer');
        case 'queued_work': return t('taskAttributionWaitQueued');
        case 'uncommitted_changes': return t('taskAttributionWaitDirty');
        case 'undelivered_changes': return t('taskAttributionWaitUndelivered');
        case 'capacity': return t('taskAttributionWaitCapacity');
        case 'workspace_missing': return t('taskAttributionWaitWorkspace');
        default: return text(reason) || t('taskAttributionWaitWorkspace');
      }
    }

    async function continueTask() {
      if (busy || !targetId || !request || !scope) return null;
      const taskId = targetId;
      const label = targetLabel();
      if (confirmContinue && !(await confirmContinue(t('taskAttributionContinueConfirm').replace('{task}', label)))) return null;
      busy = true;
      renderBar();
      try {
        const { shellId } = await scope();
        let clientMsgId = attempts.get(taskId);
        if (!clientMsgId) { clientMsgId = makeId(); attempts.set(taskId, clientMsgId); }
        const base = `/api/task-shells/${encodeURIComponent(shellId)}/tasks/${encodeURIComponent(taskId)}`;
        let operation = await request('POST', `${base}/independent-continue`, { clientMsgId });
        if (operation?.state === 'waiting' || operation?.state === 'requested') {
          setSummary(t('taskAttributionContinueWaiting')
            .replace('{task}', label).replace('{reason}', reasonLabel(operation.reason)), 'warn');
          return operation;
        }
        if (operation?.state === 'preparing') {
          setSummary(t('taskAttributionContinuePreparing').replace('{task}', label), 'warn');
          return operation;
        }
        if (operation?.state !== 'ready' && operation?.state !== 'applied') {
          throw Object.assign(new Error(operation?.reason || operation?.error?.code || 'continuation_failed'), { code: 'continuation_failed' });
        }
        if (operation.state === 'ready') {
          operation = await request('POST', `/api/task-continuations/${encodeURIComponent(operation.id)}/apply`, {});
        }
        attempts.delete(taskId);
        setSummary('');
        showToast(t('taskAttributionContinueApplied').replace('{task}', label), null);
        const url = operation?.taskId ? `/air?task=${encodeURIComponent(operation.taskId)}` : '';
        if (url) openUrl?.(url);
        onApplied?.(operation, { undone: false });
        return operation;
      } catch (error) {
        setSummary(t('taskAttributionContinueFailed').replace('{error}', text(error?.message || error)), 'error');
        report(error);
        return null;
      } finally {
        busy = false;
        renderBar();
      }
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
        void refreshSuggestions();
      }
      decorate();
      renderBar();
      return enabled;
    }

    toggle.onclick = () => setEnabled(!enabled);
    cancel.onclick = () => setEnabled(false);
    apply.onclick = () => { void applyNow(); };
    resume.onclick = () => { void continueTask(); };
    select.onchange = () => { targetId = text(select.value); clearPreview(); renderBar(); void refreshPreview(); };

    doc.body.append(toggle, bar);
    // Suggestions are visible (and counted on the toggle) even while the mode
    // is off: the whole point of the suggest tier is not needing to look.
    void refreshSuggestions();
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
      suggestions: () => [...suggestions],
      refreshSuggestions,
      applyNow,
      continueTask,
      dispose() { closeToast(); observer?.disconnect(); toggle.remove(); bar.remove(); },
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
  }

  const exported = { createController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.MultiCCTaskAttribution = exported;
})(typeof window !== 'undefined' ? window : globalThis);

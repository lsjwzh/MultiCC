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
    // 手选多轮的排队行与归属建议共用这张列表（同一个「排队中」状态）。
    const loadOperations = typeof options.loadOperations === 'function' ? options.loadOperations : null;
    const onApplied = typeof options.onApplied === 'function' ? options.onApplied : null;
    const onExternalApply = typeof options.onExternalApply === 'function' ? options.onExternalApply : null;
    const confirmContinue = typeof options.confirmContinue === 'function' ? options.confirmContinue : null;
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
    // Decisions made on this page are already reflected locally; the broadcast
    // exists for the other pages that had the same card open.
    const resolvedHere = new Set();

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
      const waiting = unresolved().length;
      toggle.dataset.suggestions = String(waiting);
      toggle.title = waiting
        ? `${t('taskAttributionToggle')} · ${t('taskAttributionSuggestions').replace('{n}', String(waiting))}`
        : t('taskAttributionToggle');
      count.textContent = t('taskAttributionSelected').replace('{n}', String(selected.size));
      hint.textContent = t('taskAttributionHint');
      select.hidden = tasks.length === 0;
      // 「这一轮还在跑」不再禁用应用：服务端会把它排成 pending，轮次结束后生效。
      apply.disabled = busy || !preview || preview.changed === 0 || selected.size === 0 || !targetId;
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

    // Everything the user has not decided yet, including what they postponed.
    function unresolved() {
      return suggestions.filter(item => item?.state === 'pending' || item?.state === 'unclassified'
        || item?.state === 'deferred' || item?.state === 'queued');
    }

    function renderSuggestions() {
      const open = suggestions.filter(item => item?.state === 'pending' || item?.state === 'unclassified');
      // `deferred` is the user's "later": still unresolved and still counted on
      // the toggle, but folded out of the way until the bar is open — the bar is
      // the durable pending entry a postponed card collapses into.
      const deferred = suggestions.filter(item => item?.state === 'deferred');
      // `queued` is an accepted change the host is holding until the turn that
      // made it busy closes. It stays visible with a way to withdraw it, because
      // "already accepted, not applied yet" must never look like "done".
      const queued = suggestions.filter(item => item?.state === 'queued');
      const listed = enabled ? [...open, ...queued, ...deferred] : [...open, ...queued];
      proposals.hidden = listed.length === 0;
      proposals.replaceChildren(...listed.map(item => {
        const row = doc.createElement('div');
        row.className = 'task-attribution-suggestion';
        row.dataset.state = text(item?.state);
        const label = doc.createElement('span');
        label.className = 'task-attribution-suggestion-label';
        // An unclassified verdict has no target, so it is only ever presented
        // as "could not classify": offering accept would promise a change that
        // cannot be written.
        const unclassified = item?.state === 'unclassified';
        const waiting = item?.state === 'queued';
        const queuedTurns = Array.isArray(item?.turns) ? item.turns.length : 0;
        label.textContent = unclassified
          ? t('taskAttributionUnclassified').replace('{task}', taskLabel(item.fromTaskId))
          : waiting
            ? (queuedTurns
              // A hand-picked multi-turn request says how much it will move;
              // a single-turn suggestion does not need to.
              ? t('taskAttributionQueuedTurns').replace('{n}', String(queuedTurns)).replace('{task}', taskLabel(item.toTaskId))
              : t('taskAttributionQueued').replace('{task}', taskLabel(item.toTaskId)))
            : t('taskAttributionSuggestion')
              .replace('{from}', taskLabel(item.fromTaskId)).replace('{to}', taskLabel(item.toTaskId));
        row.append(label);
        const actions = unclassified
          ? [['taskAttributionDismiss', 'dismiss']]
          : waiting
            ? [['taskAttributionQueueCancel', 'cancel']]
            : item?.state === 'deferred'
              ? [['taskAttributionAccept', 'accept'], ['taskAttributionDismiss', 'dismiss']]
              : [['taskAttributionAccept', 'accept'], ['taskAttributionDismiss', 'dismiss'], ['taskAttributionLater', 'defer']];
        for (const [key, action] of actions) {
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
        // Withdrawing a queued change is the same durable "dismiss": the row
        // stops counting as waiting work and the host never applies it.
        const call = action === 'cancel' ? 'dismiss' : action;
        // 手选多轮的排队行走 task-operations 自己的取消路由；归属建议的排队行
        // 仍然是同一套 decision 接口（取消 = dismiss）。
        const result = item.source === 'operation'
          ? await request('POST', `/api/task-operations/${encodeURIComponent(item.id)}/cancel`, { clientMsgId: makeId() })
          : await request('POST',
            `/api/task-shells/${encodeURIComponent(shellId)}/attribution-decisions/${encodeURIComponent(item.id)}/${call}`,
            call === 'accept' ? { clientMsgId: makeId() } : {});
        closeToast();
        const postponed = action === 'defer';
        const queued = action === 'accept' && result?.state === 'queued';
        resolvedHere.add(item.id);
        showToast(queued
          ? t('taskAttributionQueued').replace('{task}', taskLabel(result?.toTaskId || item.toTaskId))
          : action === 'accept'
            ? t('taskAttributionApplied').replace('{n}', '1').replace('{task}', taskLabel(result?.toTaskId || item.toTaskId))
            : postponed ? t('taskAttributionDeferred')
              : action === 'cancel' ? t('taskAttributionQueueCancelled') : t('taskAttributionDismissed'));
        // A postponed or queued row stays in the queue; accept/dismiss clear it.
        suggestions = postponed || (queued && item.source !== 'operation')
          ? suggestions.map(entry => entry.id === item.id ? { ...entry, state: queued ? 'queued' : 'deferred' } : entry)
          : suggestions.filter(entry => entry.id !== item.id);
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
        const [data, pending] = await Promise.all([
          loadSuggestions(shellId),
          loadOperations ? Promise.resolve(loadOperations(shellId)).catch(() => null) : null,
        ]);
        // Unclassified rows are the verdicts the host could not read. They are
        // shown so the turn is never silently treated as a permanent "same".
        // Postponed rows stay in the queue too — "later" is not a decision.
        const decisions = (Array.isArray(data?.decisions) ? data.decisions : [])
          .filter(item => item?.state === 'pending' || item?.state === 'unclassified'
            || item?.state === 'deferred' || item?.state === 'queued');
        // 手选多轮的归属调整也在同一张队列里排队：它同样是「已经接受、还没生效」，
        // 所以并排显示、同样能取消，而不是关掉面板就再也看不见。
        const operations = (Array.isArray(pending?.operations) ? pending.operations : [])
          .filter(row => row?.status === 'queued')
          .map(row => ({ id: row.id, source: 'operation', state: 'queued', toTaskId: row.targetTaskId,
            turns: Array.isArray(row.turns) ? row.turns : [] }));
        suggestions = [...decisions, ...operations];
      } catch (_) {
        suggestions = [];
      }
      renderSuggestions();
      return suggestions;
    }

    // Server broadcast: the same suggestion may have been decided on another
    // page, and an applied/undone change also moved a turn, so the other page's
    // history projection is stale. Announcing both is what makes two open tabs
    // agree without either one guessing.
    function onBroadcast(message) {
      if (message?.decisionId && resolvedHere.has(message.decisionId)) return;
      void refreshSuggestions();
      if (message?.kind === 'applied' || message?.kind === 'reverted') onExternalApply?.();
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
        case 'execution_shared': return t('taskAttributionWaitShared');
        case 'role_snapshot_changed': return t('taskAttributionWaitRole');
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
        // `needs_attention` is not a failure: the request is durable and the
        // reason is actionable (another task still owns this execution, the
        // role snapshot moved). Reporting it as an error would invite a second
        // request for something that only needs the condition cleared.
        if (operation?.state === 'needs_attention') {
          setSummary(t('taskAttributionContinueAttention')
            .replace('{task}', label).replace('{reason}', reasonLabel(operation.reason)), 'warn');
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
        // The result link goes inside the toast instead of being opened here:
        // this runs after a network round-trip, and window.open at that point is
        // exactly what browsers block as an unsolicited popup.
        const url = operation?.taskId ? `/air?task=${encodeURIComponent(operation.taskId)}` : '';
        showToast(t('taskAttributionContinueApplied').replace('{task}', label), null,
          url ? { url, label: t('taskAttributionOpenTask') } : null);
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

    // `link` is rendered as a real anchor inside the toast. Anything that
    // happens after an await must not rely on window.open: browsers block a
    // popup that was not opened by the click itself.
    function showToast(message, action, link, actionLabel) {
      closeToast();
      toast = doc.createElement('div');
      toast.className = 'task-attribution-toast';
      toast.setAttribute('role', 'status');
      const label = doc.createElement('span');
      label.textContent = message;
      toast.append(label);
      if (link && link.url) {
        const anchor = doc.createElement('a');
        anchor.className = 'task-attribution-link';
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.textContent = link.label || link.url;
        toast.append(anchor);
      }
      if (action) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'task-attribution-undo';
        button.textContent = actionLabel || t('taskAttributionUndo');
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

    // A queued request is the user's to take back; the row is durable, so this
    // works from any page and long after the toast would have expired.
    async function cancelQueued(operationId) {
      try {
        await request('POST', `/api/task-operations/${encodeURIComponent(operationId)}/cancel`, { clientMsgId: makeId() });
        closeToast();
        setSummary(t('taskAttributionQueueCancelled'), 'muted');
      } catch (error) {
        closeToast();
        showToast(t('taskAttributionFailed').replace('{error}', text(error?.message || error)));
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
      // The queued line is re-stated after the panel reset below; otherwise the
      // post-apply refresh (which clears the summary) would hide it instantly.
      let queueNotice = null;
      try {
        const { shellId } = await scope();
        const result = await request('POST', `/api/task-shells/${encodeURIComponent(shellId)}/task-operations`, {
          turns, target: { taskId: targetId }, clientMsgId: makeId(),
          previewToken: preview.previewToken, expectedRevision: preview.scopeRevision,
          // 预览已经说了这几轮在跑：这次请求是排队，不是「再被拒一次」。
          queue: (preview.blocked || []).length > 0,
        });
        if (result?.status === 'queued') {
          const waiting = (result.turns || []).length;
          selected.clear();
          clearPreview();
          syncPicks();
          queueNotice = t('taskAttributionQueuedTurns').replace('{n}', String(waiting)).replace('{task}', targetLabel());
          showToast(t('taskAttributionQueuedToast'),
            result?.id ? () => cancelQueued(result.id) : null, null, t('taskAttributionQueueCancel'));
          // It belongs in the panel's queue right away, not only after a reload.
          void refreshSuggestions();
          return result;
        }
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
        if (queueNotice) setSummary(queueNotice, 'warn');
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
      renderSuggestions();
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
      onBroadcast,
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

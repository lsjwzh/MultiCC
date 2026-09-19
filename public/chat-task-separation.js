(function (root) {
  'use strict';
  function adapt(handle) {
    if (typeof handle === 'function') return { close: handle, collapse: null };
    return { close: typeof handle?.close === 'function' ? handle.close : () => {},
      collapse: typeof handle?.collapse === 'function' ? handle.collapse : null };
  }
  function createController({ getSession, request, show, showPill = () => {}, navigate, report = () => {} }) {
    let loading = false, again = false, displayed = null, handle = null;
    function clear() { try { handle?.close?.(); } catch (_) {} handle = null; displayed = null; }
    function open(suggestion) {
      const session = getSession();
      const decide = async decision => {
        if (session !== getSession()) throw new Error('separation_stale');
        const result = await request(`/api/sessions/${encodeURIComponent(session)}/task-separation/${encodeURIComponent(suggestion.id)}`, {
          method: 'POST', json: { decision },
        });
        if (decision === 'defer') { collapse(); return; }
        clear();
        if (result.decision === 'separate') navigate(result.url);
      };
      function expandCard() {
        const previous = handle;
        handle = adapt(show(suggestion, decide, collapse));
        previous?.close?.();
      }
      // Esc or the collapse control only puts the suggestion away; the durable
      // server record keeps it findable instead of forcing a decision.
      function collapse() {
        const previous = handle;
        handle = adapt(showPill({ ...suggestion, deferred: true }, decide, expandCard));
        previous?.close?.();
      }
      if (suggestion.deferred) handle = adapt(showPill(suggestion, decide, expandCard));
      else expandCard();
    }
    async function refresh() {
      if (loading) { again = true; return; }
      const session = getSession();
      if (!session) return;
      loading = true;
      try {
        const { suggestion } = await request(`/api/sessions/${encodeURIComponent(session)}/task-separation`);
        if (session !== getSession()) { again = true; return; }
        if (!suggestion || displayed !== suggestion.id) clear();
        if (!suggestion || displayed === suggestion.id) return;
        displayed = suggestion.id;
        open(suggestion);
      } catch (error) {
        if (error.status !== 404) report(error);
      } finally {
        loading = false;
        if (again) { again = false; void refresh(); }
      }
    }
    return { refresh };
  }
  function text(value) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
  // 服务端拒绝带稳定 code（fork_source_busy 等），裸英文 message 可读性差；
  // 按码翻译，翻译缺失时回落原文。
  function errorText(t, error) {
    const code = text(error && error.code);
    const keyByCode = {
      fork_source_busy: 'taskSeparationErrBusy',
      separation_stale: 'taskSeparationErrStale',
      fork_source_dirty: 'taskSeparationErrDirty',
      integration_receipt_required: 'taskSeparationErrDelivery',
      baseline_revalidation_required: 'taskSeparationErrDelivery',
      final_run_result_required: 'taskSeparationErrDelivery',
      run_not_succeeded: 'taskSeparationErrDelivery',
      code_observation_required: 'taskSeparationErrDelivery',
    };
    const key = keyByCode[code];
    const translated = key ? t(key) : '';
    return (translated && translated !== key) ? translated : (text(error && error.message) || code || 'separation_failed');
  }
  function showDialog(suggestion, decide, collapse) {
    const t = root.t || (key => key), doc = root.document;
    const dialog = doc.createElement('dialog');
    dialog.className = 'task-separation-dialog';
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-live', 'polite');
    // Intentionally non-modal: a suggestion is a durable, optional decision and
    // must never make the conversation or header controls inert.
    dialog.style.cssText = 'max-width:440px;width:calc(100% - 40px);padding:20px;border:1px solid var(--chat-line,#30363d);border-radius:14px;background:var(--chat-surface,#161b22);color:var(--chat-text,#c9d1d9);position:fixed;right:16px;bottom:92px;margin:0;z-index:10000;box-shadow:var(--chat-shadow,0 16px 40px rgba(0,0,0,.35));';
    const title = doc.createElement('h3'); title.textContent = t('taskSeparationTitle');
    const description = doc.createElement('p'); description.textContent = t('taskSeparationBody');
    const names = doc.createElement('p'); names.textContent = `${suggestion.sourceTitle || ''} → ${suggestion.title}`;
    const reason = doc.createElement('p'); reason.textContent = suggestion.reason || '';
    const hint = doc.createElement('p'); hint.className = 'task-separation-hint';
    hint.textContent = suggestion.stale === true ? t('taskSeparationStaleHint') : t('taskSeparationPendingHint');
    const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.style.color = 'var(--red,#c33)';
    dialog.append(title, description, names, reason, hint, error);
    const buttons = [];
    async function submit(decision) {
      buttons.forEach(button => { button.disabled = true; }); error.textContent = '';
      try { await decide(decision); }
      catch (e) { error.textContent = errorText(t, e); }
      finally { buttons.forEach(button => { button.disabled = false; }); }
    }
    const actions = [['keep', 'taskSeparationKeep'], ['separate', 'taskSeparationAccept'], ['defer', 'taskSeparationLater']];
    if (suggestion.stale === true) actions.shift();
    for (const [decision, key] of actions) {
      const button = doc.createElement('button'); button.className = 'hdr-btn'; button.style.marginRight = '8px';
      button.textContent = t(key); button.onclick = () => void submit(decision); dialog.append(button); buttons.push(button);
    }
    // Escape never chooses an answer and never blocks: it only collapses the
    // card into the pending pill.
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (typeof collapse === 'function') collapse(); });
    doc.body.append(dialog);
    if (typeof dialog.show === 'function') dialog.show();
    else if (typeof dialog.showModal === 'function') dialog.showModal();
    return { close() { dialog.close(); dialog.remove(); } };
  }
  function showPill(suggestion, decide, onExpand) {
    const t = root.t || (key => key), doc = root.document;
    const pill = doc.createElement('div');
    pill.className = 'task-separation-pill';
    pill.setAttribute('role', 'status');
    pill.style.cssText = 'position:fixed;right:16px;bottom:92px;z-index:9999;display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--chat-line,#30363d);border-radius:999px;background:var(--chat-surface,#161b22);color:var(--chat-muted,#8b949e);font-size:12px;box-shadow:var(--chat-shadow,0 10px 24px rgba(0,0,0,.3));';
    const label = doc.createElement('span');
    label.textContent = `${t(suggestion.stale === true ? 'taskSeparationStale' : 'taskSeparationDeferred')}${suggestion.title ? ' · ' + text(suggestion.title) : ''}`;
    pill.append(label);
    const actions = [];
    if (suggestion.stale !== true && typeof onExpand === 'function') actions.push(['taskSeparationExpand', () => onExpand()]);
    if (suggestion.stale === true) actions.push(['taskSeparationDiscard', () => decide('keep')]);
    for (const [key, run] of actions) {
      const button = doc.createElement('button'); button.className = 'hdr-btn';
      button.textContent = t(key); button.onclick = () => { try { run(); } catch (_) {} };
      pill.append(button);
    }
    doc.body.append(pill);
    return { close() { pill.remove(); }, expand: onExpand };
  }
  root.MultiCCTaskSeparation = { createController, showDialog, showPill };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MultiCCTaskSeparation;
})(typeof window !== 'undefined' ? window : globalThis);

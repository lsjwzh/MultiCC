(function (root) {
  'use strict';
  function createController({ getSession, request, show, navigate, report = () => {} }) {
    let loading = false, again = false, displayed = null, close = null;
    async function refresh() {
      if (loading) { again = true; return; }
      const session = getSession();
      if (!session) return;
      loading = true;
      try {
        const { suggestion } = await request(`/api/sessions/${encodeURIComponent(session)}/task-separation`);
        if (session !== getSession()) { again = true; return; }
        if (!suggestion || suggestion.id !== displayed) { close?.(); close = null; displayed = null; }
        if (!suggestion || displayed === suggestion.id) return;
        displayed = suggestion.id;
        close = show(suggestion, async decision => {
          if (session !== getSession()) throw new Error('separation_stale');
          const result = await request(`/api/sessions/${encodeURIComponent(session)}/task-separation/${encodeURIComponent(suggestion.id)}`, {
            method: 'POST', json: { decision },
          });
          close?.(); close = null; displayed = null;
          if (result.decision === 'separate') navigate(result.url);
        });
      } catch (error) {
        if (error.status !== 404) report(error);
      } finally {
        loading = false;
        if (again) { again = false; void refresh(); }
      }
    }
    return { refresh };
  }
  function showDialog(suggestion, decide) {
    const t = root.t || (key => key), doc = root.document;
    const dialog = doc.createElement('dialog');
    dialog.style.cssText = 'max-width:440px;width:calc(100% - 40px);padding:24px;border:1px solid var(--border,#ddd);border-radius:14px;background:var(--bg,#fff);color:var(--text,#222);margin:auto;';
    const title = doc.createElement('h3'); title.textContent = t('taskSeparationTitle');
    const description = doc.createElement('p'); description.textContent = t('taskSeparationBody');
    const names = doc.createElement('p'); names.textContent = `${suggestion.sourceTitle || ''} → ${suggestion.title}`;
    const reason = doc.createElement('p'); reason.textContent = suggestion.reason || '';
    const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.style.color = 'var(--red,#c33)';
    dialog.append(title, description, names, reason, error);
    const buttons = [];
    async function submit(decision) {
      buttons.forEach(button => { button.disabled = true; }); error.textContent = '';
      try { await decide(decision); }
      catch (e) { error.textContent = e.message || String(e); }
      finally { buttons.forEach(button => { button.disabled = false; }); }
    }
    for (const [decision, key] of [['keep', 'taskSeparationKeep'], ['separate', 'taskSeparationAccept']]) {
      const button = doc.createElement('button'); button.className = 'hdr-btn'; button.style.marginRight = '8px';
      button.textContent = t(key); button.onclick = () => void submit(decision); dialog.append(button); buttons.push(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!buttons[0].disabled) void submit('keep'); });
    doc.body.append(dialog); dialog.showModal();
    return () => { dialog.close(); dialog.remove(); };
  }
  root.MultiCCTaskSeparation = { createController, showDialog };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MultiCCTaskSeparation;
})(typeof window !== 'undefined' ? window : globalThis);

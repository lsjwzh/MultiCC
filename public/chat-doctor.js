(function (global) {
  'use strict';
  // "会话医生": one click asks a small tool-using model agent (server-side, no CLI
  // process involved) to diagnose this session. Shift/Alt-click also lets it fix
  // things in the MultiCC main checkout (or the session's worktree). offer() puts the same action next
  // to an abnormal output (error line, upstream-error bar) so it is one tap away
  // exactly when the session misbehaves.
  const POLL_MS = 2000;
  const MAX_POLLS = 3600; // ~2h; the run itself has no turn cap

  function formatReport(run, translate) {
    const tr = translate || (key => key);
    const r = run.report || {};
    const head = tr(run.status === 'done' ? 'doctorReportDone' : 'doctorReportIncomplete', { summary: r.summary || tr('doctorNoConclusion') });
    const lines = [head, tr('doctorRootCause', { cause: r.rootCause || tr('doctorUnconfirmed') })];
    if (r.evidence && r.evidence.length) lines.push(`${tr('doctorEvidence')}\n- ${r.evidence.join('\n- ')}`);
    if (run.actions && run.actions.length) lines.push(`${tr('doctorActions')}\n- ${run.actions.map(a => `${a.kind}: ${a.detail}`).join('\n- ')}`);
    if (r.nextSteps && r.nextSteps.length) lines.push(`${tr('doctorNextSteps')}\n- ${r.nextSteps.join('\n- ')}`);
    if (!run.autofix && r.rootCause && !/未确认|unconfirmed/i.test(r.rootCause)) lines.push(tr('doctorFixHint'));
    return lines.join('\n');
  }

  function create(options) {
    const doc = options.document;
    const tr = options.translate || (key => key);
    const fetchImpl = options.fetch || global.fetch.bind(global);
    const sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    let running = false;
    let panel = null;

    // The diagnosis itself is a stream of tool names, not conversation. Show it
    // in one small floating box instead of a stack of centred system messages
    // that keep pushing the real chat content up.
    function ensurePanel() {
      if (panel) {
        if (panel.timer) { clearTimeout(panel.timer); panel.timer = null; }
        panel.host.classList.remove('done', 'failed');
        return panel;
      }
      if (!doc || typeof doc.createElement !== 'function' || !doc.body) return null;
      doc.getElementById?.('doctor-process-panel')?.remove();
      const host = doc.createElement('section');
      host.id = 'doctor-process-panel';
      host.className = 'doctor-panel';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      const head = doc.createElement('div'); head.className = 'doctor-panel-head';
      const title = doc.createElement('span'); title.className = 'doctor-panel-title';
      title.textContent = tr('doctorPanelTitle');
      const status = doc.createElement('span'); status.className = 'doctor-panel-status';
      status.textContent = tr('doctorPanelRunning');
      const body = doc.createElement('div'); body.className = 'doctor-panel-body';
      head.appendChild(title); head.appendChild(status);
      host.appendChild(head); host.appendChild(body);
      doc.body.appendChild(host);
      panel = { host, body, status, timer: null };
      return panel;
    }

    function clearPanel() {
      if (!panel) return;
      if (panel.timer) clearTimeout(panel.timer);
      panel.host?.remove?.();
      panel = null;
    }

    function finishPanel(done) {
      if (!panel) return;
      panel.host.classList.add(done ? 'done' : 'failed');
      panel.status.textContent = done ? tr('doctorPanelDone') : tr('doctorPanelFailed');
      if (panel.timer) clearTimeout(panel.timer);
      panel.timer = setTimeout(() => { clearPanel(); }, 1500);
      if (panel.timer && typeof panel.timer.unref === 'function') panel.timer.unref();
    }

    function showProgress(text) {
      const box = ensurePanel();
      if (!box) { options.addSystemMsg(text); return; }
      if (box.status.textContent !== tr('doctorPanelRunning')) box.status.textContent = tr('doctorPanelRunning');
      const row = doc.createElement('div'); row.className = 'doctor-panel-line';
      row.textContent = text;
      box.body.appendChild(row);
      box.body.scrollTop = box.body.scrollHeight;
    }

    async function diagnose({ autofix = false } = {}) {
      const id = options.getSessionName();
      if (!id) { options.addSystemMsg(tr('doctorNoSession')); return { ok: false }; }
      if (running) return { ok: false, reason: 'running' };
      running = true;
      try {
        const res = await fetchImpl(options.withToken(`/api/sessions/${encodeURIComponent(id)}/doctor`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autofix }),
        });
        const started = await res.json().catch(() => ({}));
        if (!res.ok || !started.runId) {
          options.addSystemMsg(tr('doctorStartFailed', { error: started.error || res.status }));
          return { ok: false };
        }
        const startedText = tr(autofix ? 'doctorStartedFix' : 'doctorStarted');
        if (ensurePanel()) showProgress(startedText);
        else options.addSystemMsg(startedText);
        let seen = 0;
        for (let i = 0; i < MAX_POLLS; i++) {
          await sleep(POLL_MS);
          const r = await fetchImpl(options.withToken(`/api/doctor/runs/${started.runId}`));
          const data = await r.json().catch(() => ({}));
          const run = data.run;
          if (!run) continue;
          const tools = run.events.filter(e => e.type === 'tool');
          if (tools.length > seen) {
            showProgress(`🩺 ${tools.slice(seen).map(e => e.name).join(' → ')}`);
            seen = tools.length;
          }
          if (run.status !== 'running') {
            finishPanel(run.status === 'done');
            const line = options.addSystemMsg(run.status === 'error' ? tr('doctorFailed', { error: run.error })
              : run.status === 'cancelled' ? tr('doctorCancelled') : formatReport(run, tr));
            if (run.issue) offerIssue(line, run.issue);
            return { ok: run.status === 'done', run };
          }
        }
        finishPanel(false);
        options.addSystemMsg(tr('doctorTimeout'));
        return { ok: false, reason: 'timeout' };
      } catch (error) {
        clearPanel();
        options.addSystemMsg(tr('doctorFailed', { error: error.message }));
        return { ok: false };
      } finally { running = false; }
    }

    // The model could not solve it: let the human send what was collected to
    // GitHub. Nothing leaves the machine until they confirm the preview; the
    // click then only opens a pre-filled issue page they still have to submit.
    function offerIssue(el, issue) {
      if (!el || typeof el.appendChild !== 'function' || !issue || !issue.url) return null;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'doctor-issue';
      button.textContent = tr('doctorIssueButton');
      button.title = tr('doctorIssueTitle', { repo: issue.repo });
      button.style.cssText = 'display:block;margin-top:8px;padding:4px 12px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer';
      button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const preview = `${issue.title}\n\n${issue.body.slice(0, 1800)}${issue.body.length > 1800 ? '\n…' : ''}`;
        const ok = options.confirm ? await options.confirm(tr('doctorIssueConfirm', { repo: issue.repo, preview }), {
          title: tr('doctorIssueButton'), okText: tr('doctorIssueOk'), cancelText: tr('doctorIssueCancel'),
        }) : true;
        if (!ok) return;
        if (issue.truncated && global.navigator?.clipboard?.writeText) {
          await global.navigator.clipboard.writeText(`${issue.title}\n\n${issue.body}`).catch(() => {});
        }
        (options.open || ((url) => global.open(url, '_blank', 'noopener')))(issue.url);
        options.addSystemMsg(tr(issue.truncated ? 'doctorIssueOpenedLong' : 'doctorIssueOpened'));
      });
      el.appendChild(button);
      return button;
    }

    const onClick = event => {
      options.closeMoreMenu?.();
      return diagnose({ autofix: !!(event.shiftKey || event.altKey) });
    };
    const btn = doc.getElementById('doctor-btn');
    if (btn) btn.addEventListener('click', onClick);

    // Attach a one-tap "diagnose" button to an abnormal-output element.
    function offer(el) {
      if (!el || typeof el.appendChild !== 'function' || el.querySelector?.('.doctor-offer')) return null;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'doctor-offer';
      button.textContent = tr('doctorOffer');
      button.title = tr('doctorOfferTitle');
      button.style.cssText = 'margin-left:8px;padding:2px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); onClick(event); });
      el.appendChild(button);
      return button;
    }

    return Object.freeze({ diagnose, offer, offerIssue });
  }

  const api = Object.freeze({ create, formatReport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatDoctor = api;
}(typeof window !== 'undefined' ? window : globalThis));

(function () {
  'use strict';
  const $ = id => document.getElementById(id), t = key => window.t(key);
  let shellId, focused = '', detail = null, control = null, client, busy = false, timer, stopped = false;
  const params = new URLSearchParams(location.search);
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.code || `HTTP ${response.status}`), {
      notReserved: data.notDelivered === true || (!data.receiptId && ['invalid_input', 'invalid_text', 'invalid_intent',
        'invalid_control', 'context_requires_new_task', 'dependency_not_ready', 'stale_control'].includes(data.code)),
    });
    return data;
  }
  function notice(text) { $('notice').textContent = text; }
  function option(value, label) { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; }
  function fill(select, tasks, blank) {
    const values = new Set([...select.selectedOptions].map(o => o.value));
    select.replaceChildren(...(blank ? [option('', t(blank))] : []), ...tasks.map(task => option(task.id, task.title || task.id)));
    for (const opt of select.options) opt.selected = values.has(opt.value);
  }
  function inputMode(intent) {
    if (client?.pending()) return notice(t('taskShellRetryFirst'));
    if (intent === 'work') control = null;
    else {
      if (!detail?.execution.turnId || !focused) return;
      control = { intent, taskId: focused, turnId: detail.execution.turnId,
        ...(intent === 'answer' ? { requestId: detail.execution.pending?.requestId } : {}) };
    }
    $('input-label').textContent = t(intent === 'answer' ? 'taskShellAnswer' : intent === 'steer' ? 'taskShellSteer' : 'taskShellWork');
    $('message').focus();
  }
  function refreshButtons() {
    const pending = !!client?.pending();
    $('send').disabled = busy || pending;
    $('retry').hidden = !pending;
    $('retry').disabled = busy;
    $('cancel').disabled = busy || pending || !detail?.execution.busy || !detail?.execution.turnId;
    $('steer').disabled = busy || pending || !detail?.execution.turnId || !!detail?.execution.pending;
  }
  async function action(callback) {
    if (busy) return;
    busy = true; refreshButtons();
    try {
      const result = await callback();
      if (result?.taskId) {
        focused = result.taskId; control = null; $('message').value = '';
        $('input-label').textContent = t('taskShellWork');
        notice(t(result.decision === 'fork' ? 'taskShellForked' : 'taskShellAccepted'));
      }
      await refresh();
    } catch (error) { notice(error.message); }
    finally { busy = false; refreshButtons(); }
  }
  function renderMessages(messages) {
    const history = $('history'), nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 70;
    const signature = JSON.stringify(messages);
    if (history.dataset.signature === signature) return;
    history.dataset.signature = signature;
    history.replaceChildren(...messages.map(message => {
      const article = document.createElement('article'); article.className = message.role === 'user' ? 'user' : 'assistant';
      const role = document.createElement('div'); role.className = 'role'; role.textContent = message.role;
      const content = document.createElement('div');
      content.innerHTML = window.MultiCCSafeMarkdown.render(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      article.append(role, content);
      if (message.tools?.length) {
        const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
        summary.textContent = t('taskShellEvidence'); pre.textContent = JSON.stringify(message.tools, null, 2);
        details.append(summary, pre); article.append(details);
      }
      return article;
    }));
    if (nearBottom) history.scrollTop = history.scrollHeight;
  }
  async function refresh() {
    if (!shellId || stopped) return;
    sessionStorage.setItem(`task-shell-focus:${shellId}`, focused);
    const view = await api(`/api/task-shells/${shellId}`);
    fill($('tasks'), view.tasks, 'taskShellNew'); $('tasks').value = focused;
    fill($('available'), view.availableTasks.filter(task => !view.tasks.some(linked => linked.id === task.id)), 'taskShellSelect');
    fill($('references'), view.tasks, null);
    $('receipts').replaceChildren(...view.receipts.filter(receipt => receipt.status !== 'accepted').map(receipt => {
      const row = document.createElement('div'), retry = document.createElement('button');
      row.textContent = `${receipt.taskId} · ${receipt.error?.message || receipt.status} `;
      retry.textContent = t('taskShellRetry'); retry.disabled = receipt.status === 'rejected' || !!client?.pending() || busy || !view.enabled;
      retry.onclick = () => action(() => api(`/api/task-shells/${shellId}/receipts/${receipt.id}/retry`, {})); row.append(retry); return row;
    }));
    const target = focused;
    const nextDetail = target ? await api(`/api/task-shells/${shellId}/tasks/${target}`) : null;
    if (target !== focused) return;
    detail = nextDetail;
    renderMessages(detail?.messages || []);
    $('state').textContent = detail ? `${detail.task.title} · ${detail.execution.status || (detail.execution.busy ? t('running') : t('idle'))}` : t('taskShellNew');
    $('origin').textContent = detail ? `${detail.task.parentTaskId ? t('taskShellFrom') + ' ' + detail.task.parentTaskId + ' · ' : ''}${t('taskShellReferences')}: ${detail.task.snapshotIds.length}` : '';
    $('snapshot-details').hidden = !detail?.snapshots.length;
    $('snapshot-info').replaceChildren(...(detail?.snapshots || []).map(snapshot => {
      const row = document.createElement('p');
      row.textContent = window.t('taskShellSnapshotSummary', { task: snapshot.taskId, hash: snapshot.hash.slice(0, 12),
        included: snapshot.messages.length / 2, omitted: snapshot.omittedExchanges });
      return row;
    }));
    const pending = detail?.execution.pending;
    $('question').hidden = !pending;
    if (pending) {
      $('question-text').textContent = pending.question;
      $('choices').replaceChildren(...(pending.options || []).map(value => {
        const button = document.createElement('button'); const label = typeof value === 'string' ? value : value.label || value.value;
        button.textContent = label; button.onclick = () => { inputMode('answer'); $('message').value = label; }; return button;
      }));
    }
    refreshButtons();
    if (!view.enabled) { $('send').disabled = true; notice(t('taskShellDisabled')); }
  }
  $('tasks').onchange = () => { focused = $('tasks').value; control = null; detail = null; inputMode('work'); refresh().catch(e => notice(e.message)); };
  $('attach').onclick = () => action(async () => {
    const taskId = $('available').value; if (!taskId) return;
    await api(`/api/task-shells/${shellId}/links`, { taskId }); focused = taskId;
  });
  $('work').onclick = () => inputMode('work'); $('steer').onclick = () => inputMode('steer'); $('answer').onclick = () => inputMode('answer');
  $('composer').onsubmit = event => {
    event.preventDefault();
    const refs = [...$('references').selectedOptions].map(o => o.value);
    if (refs.length > 3) return notice(t('taskShellReferenceLimit'));
    if (refs.length && (control || focused)) return notice(t('taskShellReferencesHelp'));
    const payload = { text: $('message').value, taskId: focused || null, intent: 'work',
      ...control, ...($('dependency').checked ? { dependsOn: refs } : { contextTaskIds: refs }) };
    action(() => client.send(shellId, payload));
  };
  $('cancel').onclick = () => {
    const target = { taskId: focused, turnId: detail?.execution.turnId };
    if (window.confirm(t('taskShellCancelConfirm'))) action(() => client.send(shellId, { ...target, intent: 'cancel', text: '' }));
  };
  $('retry').onclick = () => action(() => client.retry(shellId));
  $('detach').onclick = () => {
    if (window.confirm(t('taskShellDetachConfirm'))) action(async () => {
      await api(`/api/task-shells/${shellId}`, undefined, 'DELETE'); stopped = true; clearTimeout(timer); location.href = '/manage';
    });
  };
  async function poll() {
    if (stopped) return;
    if (!document.hidden && !busy) try { await refresh(); } catch (e) { notice(e.message); }
    timer = setTimeout(poll, 2000);
  }
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  (async () => {
    try {
      const shell = params.get('shell') ? await api(`/api/task-shells/${encodeURIComponent(params.get('shell'))}`)
        : await api('/api/task-shells', { sessionId: params.get('session') });
      shellId = shell.id; history.replaceState(null, '', `?shell=${encodeURIComponent(shellId)}`);
      focused = sessionStorage.getItem(`task-shell-focus:${shellId}`) || '';
      client = window.MultiCCTaskShellClient.createClient({ request: api, storage: sessionStorage, key: `task-shell-pending:${shellId}`, randomId: () => crypto.randomUUID() });
      await refresh(); poll();
    } catch (e) { notice(e.message); $('send').disabled = true; }
  })();
})();

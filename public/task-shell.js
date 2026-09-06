(function () {
  'use strict';
  const $ = id => document.getElementById(id), t = key => window.t(key);
  let shellId, focused = '', detail = null, control = null, client, busy = false, timer, stopped = false, newTask = false;
  const params = new URLSearchParams(location.search);
  let requestedTask = params.get('task') || '';
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
  function inputMode(intent) {
    if (client?.pending()) return notice(t('taskShellRetryFirst'));
    if (intent === 'work') { control = null; newTask = false; }
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
    $('new-task').disabled = busy || pending;
  }
  async function action(callback) {
    if (busy) return;
    busy = true; refreshButtons();
    try {
      const result = await callback();
      if (result?.taskId) {
        focused = result.taskId; control = null; newTask = false; $('message').value = '';
        $('input-label').textContent = t('taskShellWork');
        notice(t(result.decision === 'new' ? 'taskShellNewAccepted' : 'taskShellAccepted'));
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
    focused = requestedTask || view.currentTaskId || focused;
    requestedTask = '';
    $('receipts').replaceChildren(...view.receipts.filter(receipt => receipt.status !== 'accepted').map(receipt => {
      const row = document.createElement('div'), retry = document.createElement('button');
      row.textContent = `${receipt.taskId} · ${receipt.error?.message || receipt.status} `;
      retry.textContent = t('taskShellRetry'); retry.disabled = receipt.status === 'rejected' || !!client?.pending() || busy;
      retry.onclick = () => action(() => api(`/api/task-shells/${shellId}/receipts/${receipt.id}/retry`, {})); row.append(retry); return row;
    }));
    const target = focused;
    const nextDetail = target ? await api(`/api/task-shells/${shellId}/tasks/${target}`) : null;
    if (target !== focused) return;
    detail = nextDetail;
    renderMessages(detail?.messages || []);
    $('state').textContent = detail ? `${detail.task.title} · ${detail.execution.status || (detail.execution.busy ? t('running') : t('idle'))}` : t('taskShellNew');
    $('origin').textContent = detail ? `${detail.task.parentTaskId ? t('taskShellFrom') + ' ' + detail.task.parentTaskId + ' · ' : ''}${t('taskShellReferences')}: ${detail.task.snapshotIds.length}` : '';
    const savings = view.tokenSavings;
    $('token-savings').hidden = !savings;
    if (savings) $('token-savings').textContent = savings.contextRefilled
      ? t('taskShellTokensRefilled', { tokens: Number(savings.originalEstimatedTokens || 0).toLocaleString() })
      : t('taskShellTokensSaved', { tokens: Number(savings.estimatedTokens || 0).toLocaleString() });
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
  }
  $('work').onclick = () => inputMode('work'); $('steer').onclick = () => inputMode('steer'); $('answer').onclick = () => inputMode('answer');
  $('new-task').onclick = () => {
    if (client?.pending() || busy) return;
    control = null; newTask = true;
    $('input-label').textContent = t('taskShellNewPrompt');
    notice(t('taskShellNewReady'));
    $('message').focus();
  };
  $('composer').onsubmit = event => {
    event.preventDefault();
    const payload = { text: $('message').value, taskId: focused || null, intent: 'work',
      ...(newTask ? { newTask: true, taskId: null } : {}), ...control };
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
      shellId = shell.id;
      const canonical = new URLSearchParams({ shell: shellId });
      if (params.get('task')) canonical.set('task', params.get('task'));
      if (params.get('external')) canonical.set('external', params.get('external'));
      history.replaceState(null, '', '?' + canonical);
      focused = requestedTask || shell.currentTaskId || shell.defaultTaskId || '';
      const archive = $('source-history');
      const archiveParams = new URLSearchParams({ session: shell.sourceSessionId, historyScope: 'archive', readOnly: '1' });
      if (params.get('external')) archiveParams.set('external', params.get('external'));
      archive.href = '/chat.html?' + archiveParams;
      client = window.MultiCCTaskShellClient.createClient({ request: api, storage: sessionStorage, key: `task-shell-pending:${shellId}`, randomId: () => crypto.randomUUID() });
      await refresh(); poll();
    } catch (e) { notice(e.message); $('send').disabled = true; }
  })();
})();

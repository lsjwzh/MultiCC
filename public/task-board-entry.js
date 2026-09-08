(function (root) {
  'use strict';
  async function start(taskId) {
    const $ = id => document.getElementById(id), t = key => root.t(key);
    let entry, stopped = false, busy = false, control = null;
    const key = `task-board-fork:${taskId}`;
    const api = async (url, body) => {
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.error || data.code), data, { notReserved: data.notDelivered === true || (!data.receiptId && response.status >= 400 && response.status < 500) });
      return data;
    };
    const base = `/api/task-shell-tasks/${encodeURIComponent(taskId)}`;
    const client = root.MultiCCTaskShellClient.createClient({ storage: sessionStorage,
      key: `task-board-input:${taskId}`, randomId: () => crypto.randomUUID(), request: (_url, body) => api(`${base}/messages`, body) });
    const errorText = error => error.code === 'fork_source_busy' ? t('taskBoardForkSourceBusy')
      : error.code === 'fork_source_dirty' ? t('taskBoardForkSourceDirty') : error.message;
    $('composer').hidden = true; $('question').hidden = true; $('board-actions').hidden = true;
    $('new-task').hidden = true; $('detach').hidden = true;
    async function refresh() {
      entry = await api(base);
      $('state').textContent = `${entry.task.title} · ${entry.execution.status || ''}`;
      $('composer').hidden = entry.readOnly;
      $('board-actions').hidden = !entry.readOnly;
      $('fork-task').hidden = entry.status === 'archived';
      $('question').hidden = entry.readOnly || !entry.execution.pending;
      $('source-history').hidden = true;
      const back = $('return-conversation'); back.hidden = !entry.returnUrl; back.href = entry.returnUrl || '#';
      $('history').replaceChildren(...entry.messages.map(message => {
        const article = document.createElement('article'); article.className = message.role === 'user' ? 'user' : 'assistant';
        article.innerHTML = root.MultiCCSafeMarkdown.render(typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''));
        if (message.tools?.length) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(message.tools, null, 2); article.append(pre); }
        return article;
      }));
      if (entry.execution.pending) $('question-text').textContent = entry.execution.pending.question;
      $('retry').hidden = !client.pending();
      $('send').disabled = busy || !!client.pending();
      $('cancel').disabled = busy || !entry.execution.turnId;
      $('steer').disabled = busy || !entry.execution.turnId;
    }
    async function action(fn) {
      if (busy) return;
      busy = true;
      try { await fn(); await refresh(); } catch (e) { $('notice').textContent = errorText(e); }
      finally { busy = false; $('fork-task').disabled = false; $('send').disabled = !!client.pending(); }
    }
    $('fork-task').onclick = () => action(async () => {
      $('fork-task').disabled = true; $('notice').textContent = t('taskBoardForking');
      let clientMsgId = sessionStorage.getItem(key);
      if (!clientMsgId) { clientMsgId = crypto.randomUUID(); sessionStorage.setItem(key, clientMsgId); }
      const fork = await api(`${base}/fork`, { clientMsgId });
      sessionStorage.removeItem(key); stopped = true; location.assign(fork.url);
    });
    const mode = intent => { control = { intent, taskId, turnId: entry.execution.turnId,
      ...(intent === 'answer' ? { requestId: entry.execution.pending?.requestId } : {}) }; };
    $('answer').onclick = () => mode('answer'); $('steer').onclick = () => mode('steer'); $('work').onclick = () => { control = null; };
    $('composer').onsubmit = event => { event.preventDefault(); if (entry.readOnly) return;
      action(async () => { await client.send(entry.ownerShellId, { text: $('message').value, taskId, intent: 'work', ...control }); $('message').value = ''; control = null; }); };
    $('cancel').onclick = () => { if (!entry.readOnly) action(() => client.send(entry.ownerShellId, { text: '', taskId, turnId: entry.execution.turnId, intent: 'cancel' })); };
    $('retry').onclick = () => action(() => client.retry(entry.ownerShellId));
    window.addEventListener('pagehide', () => { stopped = true; });
    async function poll() { if (stopped) return; if (!busy && !document.hidden) try { await refresh(); } catch (e) { $('notice').textContent = errorText(e); } if (!stopped) setTimeout(poll, 2000); }
    await poll();
  }
  root.MultiCCTaskBoardEntry = { start };
})(typeof window === 'undefined' ? globalThis : window);

(function (root) {
  'use strict';
  async function start(taskId) {
    const $ = id => document.getElementById(id), t = key => root.t(key);
    let entry, stopped = false, busy = false, control = null, pollEpoch = 0, timer, historySignature = '', planInitialized = false;
    const key = `task-board-fork:${taskId}`;
    const api = async (url, body) => {
      const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch (_) { throw Object.assign(new Error(/<!doctype|<html/i.test(raw) ? 'Air 服务接口尚未加载，请重启 MultiCC 后刷新。' : `HTTP ${response.status}`), { code: 'invalid_response' }); }
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.error || data.code), data, { notReserved: data.notDelivered === true || (!data.receiptId && response.status >= 400 && response.status < 500) });
      return data;
    };
    root.MultiCCTaskArtifacts?.setScope({ taskId });
    const base = `/api/task-shell-tasks/${encodeURIComponent(taskId)}`;
    const client = root.MultiCCTaskShellClient.createClient({ storage: sessionStorage,
      key: `task-board-input:${taskId}`, randomId: () => crypto.randomUUID(), request: (_url, body) => api(`${base}/messages`, body) });
    const errorText = error => error.code === 'fork_source_busy' ? t('taskBoardForkSourceBusy')
      : error.code === 'fork_source_dirty' ? t('taskBoardForkSourceDirty') : error.message;
    function appendTaskTail(article, message) {
      const code = String(message?.taskShortCode || entry?.task?.taskShortCode || '').trim().toUpperCase();
      if (!/^[0-9A-Z]{4}$/.test(code)) return;
      const name = String(message?.taskName || entry?.task?.title || '').trim();
      const chars = Array.from(name), preview = chars.length > 10 ? `${chars.slice(0, 10).join('')}…` : name;
      const tail = document.createElement('div'); tail.className = 'msg-task-tail';
      tail.textContent = `#${code}${preview ? ` · ${preview}` : ''}`;
      tail.title = `#${code}${name ? ` · ${name}` : ''}`;
      article.append(tail);
    }
    $('composer').hidden = true; $('question').hidden = true; $('board-actions').hidden = true;
    $('new-task').hidden = true; $('detach').hidden = true;
    function renderMessages(messages) {
      const history = $('history'), signature = JSON.stringify(messages || []);
      if (signature === historySignature) return;
      const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
      const previousTop = history.scrollTop;
      historySignature = signature;
      history.replaceChildren(...(messages || []).map(message => {
        const article = document.createElement('article');
        article.className = message.role === 'user' ? 'user' : 'assistant';
        if (message.role !== 'user') {
          const role = document.createElement('div'); role.className = 'role'; role.textContent = 'MultiCC · 本轮结果'; article.append(role);
        }
        const content = document.createElement('div');
        content.innerHTML = root.MultiCCSafeMarkdown.render(typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''));
        article.append(content);
        if (message.tools?.length) { const evidence = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre'); summary.textContent = t('taskShellEvidence'); pre.textContent = JSON.stringify(message.tools, null, 2); evidence.append(summary, pre); article.append(evidence); }
        appendTaskTail(article, message);
        return article;
      }));
      if (nearBottom) history.scrollTop = history.scrollHeight;
      else history.scrollTop = Math.min(previousTop, Math.max(0, history.scrollHeight - history.clientHeight));
    }
    function renderPlan(task, messages) {
      const plan = $('task-plan'), planned = task?.recordType === 'planned';
      plan.hidden = !planned;
      if (!planned) return;
      const empty = !(messages || []).length;
      const stages = { inbox: '待处理', doing: '进行中', done: '已完成' };
      $('task-plan-label').textContent = empty ? '计划任务 · 尚未执行' : '任务计划';
      $('task-plan-stage').textContent = stages[task.workflowStage] || task.workflowStage || '';
      $('task-plan-description').innerHTML = root.MultiCCSafeMarkdown.render(task.description || '尚未填写任务说明。');
      $('task-plan-acceptance').innerHTML = root.MultiCCSafeMarkdown.render(task.acceptanceCriteria || '');
      $('task-plan-acceptance-wrap').hidden = !task.acceptanceCriteria;
      if (!planInitialized) { plan.open = empty; planInitialized = true; }
      $('input-label').textContent = empty ? '开始执行计划' : t('taskShellWork');
      $('work').textContent = empty ? '开始执行计划' : t('taskShellWork');
      $('message').placeholder = empty ? `补充或开始执行「${task.title}」…` : t('taskShellPlaceholder');
    }
    async function refresh() {
      entry = await api(base);
      const unstartedPlan = entry.task.recordType === 'planned' && !entry.messages.length;
      $('state').textContent = `${entry.task.title} · ${unstartedPlan ? '计划任务 · 尚未执行' : entry.execution.status || ''}`;
      $('composer').hidden = entry.readOnly;
      $('board-actions').hidden = !entry.readOnly;
      $('fork-task').hidden = entry.status === 'archived';
      $('question').hidden = entry.readOnly || !entry.execution.pending;
      $('source-history').hidden = true;
      const back = $('return-conversation'); back.hidden = !entry.returnUrl; back.href = entry.returnUrl || '#';
      renderPlan(entry.task, entry.messages);
      renderMessages(entry.messages);
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
      action(async () => { await client.send(entry.ownerShellId, { text: $('message').value, taskId, intent: 'work', ...control }); $('message').value = ''; $('message').dispatchEvent(new Event('input', { bubbles: true })); control = null; }); };
    $('cancel').onclick = () => { if (!entry.readOnly) action(() => client.send(entry.ownerShellId, { text: '', taskId, turnId: entry.execution.turnId, intent: 'cancel' })); };
    $('retry').onclick = () => action(() => client.retry(entry.ownerShellId));
    window.addEventListener('pagehide', () => { stopped = true; pollEpoch++; clearTimeout(timer); });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      stopped = false; pollEpoch++; clearTimeout(timer); poll();
    });
    async function poll(epoch = pollEpoch) {
      if (stopped || epoch !== pollEpoch) return;
      if (!busy && (!document.hidden || !entry)) try { await refresh(); } catch (e) { $('notice').textContent = errorText(e); }
      if (!stopped && epoch === pollEpoch) timer = setTimeout(() => poll(epoch), 2000);
    }
    root.MultiCCTaskBoardEntry.refresh = () => !stopped && !busy ? refresh() : Promise.resolve();
    await poll();
  }
  root.MultiCCTaskBoardEntry = { start };
})(typeof window === 'undefined' ? globalThis : window);

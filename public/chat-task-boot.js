'use strict';

function shellMessageOwner(element) {
  if (element.dataset.sourceSessionId && element.dataset.sourceMessageId) {
    return { sessionId: element.dataset.sourceSessionId, messageId: element.dataset.sourceMessageId };
  }
  const id = element.dataset.msgId || '';
  const split = shellChatView.shellId ? id.indexOf(':') : -1;
  return split < 0 ? { sessionId: _sessionName, messageId: id }
    : { sessionId: id.slice(0, split), messageId: id.slice(split + 1) };
}

// 分享页启动：同一个渲染器，只按分享的权限收敛。
//
// 页面的权限来自 /api/share/<token>/entry，所以启动比普通页多一步等待 —— 等不到
// 答复就不连接、不发消息（chat-share-mode.js 只认答复，不猜）。三种拿不到权限的
// 情况（要密码 / 链接失效 / 这次没问到）都是覆盖层，页面本身不做第二套错误界面。
async function bootShareEntry() {
  const share = window.MultiCCShareMode;
  const resolved = await share.prepare();
  share.applyChrome();
  share.mountOverlay();
  if (resolved.state !== 'ok') {
    statusEl.textContent = resolved.state === 'locked' ? '需要访问密码'
      : resolved.state === 'gone' ? '链接无效' : '暂时打不开';
    statusEl.className = resolved.state === 'error' ? 'error' : '';
    return;
  }
  updateTabIdentity(resolved.label || '分享会话', resolved.label || resolved.token);
  document.title = `${resolved.label || '分享会话'} — MultiCC`;
  resetHistoryPagination();
  chatHistoryView.clearMessages();
  if (resolved.type === 'messages') {
    // 消息快照是一次性内容：没有活会话，没有 WS，也没有下一页。
    applyHistoryPlan(chatHistoryStore.acceptHistory({ messages: resolved.messages, hasMore: false }, []));
    addSystemMsg('这是分享的消息快照（只读）。');
    statusEl.textContent = '消息快照';
    statusEl.className = '';
    return;
  }
  addSystemMsg(resolved.access === 'operate'
    ? '这是分享的会话，你可以继续对话。'
    : '这是分享的会话（只读）。');
  // 和普通页同一条启动路径（含可见性/网络恢复后的重连），只是推迟到权限确定之后。
  chatTransport.startLifecycle();
}

// Task-board links resolve their bound execution once, then use the exact same
// full chat renderer as every ordinary conversation. Task-shell routing is a
// transport concern and must never replace the UI.
async function bootChatEntry() {
  if (window.MultiCCShareMode?.active()) return bootShareEntry();
  if (_params.get('readOnly') === '1') {
    for (const id of ['input-bar', 'pre-input-bar', 'pending-user-input-card']) {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    }
    document.body.classList.add('chat-read-only');
    try {
      const response = await window.fetch(`/api/task-shell-tasks/${encodeURIComponent(_taskId)}/history?limit=50&historyScope=archive`, { cache: 'no-store' });
      const snapshot = await response.json().catch(() => ({}));
      if (!response.ok || snapshot.ok === false) throw new Error(snapshot.message || snapshot.error || snapshot.code || `HTTP ${response.status}`);
      updateTabIdentity(snapshot.task?.title || _taskId, _taskId);
      resetHistoryPagination(); chatHistoryView.clearMessages();
      applyHistoryPlan(chatHistoryStore.acceptHistory(snapshot, []));
      const queue = snapshot.execution?.queue || {};
      window.MultiCCChatSessionQueue?.render(queue.queued || [], queue, document);
      const classify = snapshot.execution?.classify;
      if (classify?.state) renderAuxClassify(classify.goal, classify.phase, classify.state);
      window.MultiCCTaskArtifacts?.setScope({ taskId: _taskId });
      statusEl.textContent = '只读历史'; statusEl.className = '';
    } catch (error) {
      addSystemMsg(error.message); statusEl.textContent = error.message; statusEl.className = 'error';
    }
    return;
  }
  if (!_taskId) {
    connect();
    return;
  }
  try {
    const target = await window.MultiCCChatShellEntry.resolve({
      sessionId: _sessionName, taskId: _taskId, fetch: window.fetch.bind(window),
      air: _params.get('air') === '1',
    });
    if (target) {
      // The resolver may return a read-only task entry without a session.
      // Preserve that route and its parameters instead of rebuilding a chat URL.
      const url = new URL(target, location.href);
      if (_params.get('external')) url.searchParams.set('external', _params.get('external'));
      location.replace(url.href);
    } else connect();
  } catch (error) {
    addSystemMsg(error.message);
    statusEl.textContent = error.message;
    statusEl.className = 'error';
  }
}

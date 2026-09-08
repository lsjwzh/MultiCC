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

// Task-board links resolve their bound execution once, then use the exact same
// full chat renderer as every ordinary conversation. Task-shell routing is a
// transport concern and must never replace the UI.
async function bootChatEntry() {
  if (_params.get('readOnly') === '1') {
    for (const id of ['input-bar', 'pre-input-bar', 'pending-user-input-card']) {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    }
    connect();
    return;
  }
  if (!_taskId) {
    connect();
    return;
  }
  try {
    const target = await window.MultiCCChatShellEntry.resolve({
      sessionId: _sessionName, taskId: _taskId, fetch: window.fetch.bind(window),
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

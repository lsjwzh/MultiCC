'use strict';

// The full chat renderer is retained for archives and system sessions. User
// conversations enter the task shell; an entry error must never send elsewhere.
async function bootChatEntry() {
  if (_params.get('readOnly') === '1') {
    for (const id of ['input-bar', 'pre-input-bar', 'pending-user-input-card']) {
      const element = document.getElementById(id);
      if (element) element.style.display = 'none';
    }
    connect();
    return;
  }
  try {
    const target = await window.MultiCCChatShellEntry.resolve({
      sessionId: _sessionName, taskId: _taskId, fetch: window.fetch.bind(window),
    });
    if (target) {
      const url = new URL(target, location.href);
      if (_params.get('external')) url.searchParams.set('external', _params.get('external'));
      location.replace(url.pathname + url.search);
    } else connect(); // Only system/auxiliary sessions have no task shell.
  } catch (error) {
    addSystemMsg(error.message);
    statusEl.textContent = error.message;
    statusEl.className = 'error';
  }
}

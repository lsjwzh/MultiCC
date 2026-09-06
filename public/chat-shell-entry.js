(function (root) {
  'use strict';
  async function resolve({ sessionId, taskId, fetch }) {
    async function post(url, body) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.message || data.error || data.code || `HTTP ${response.status}`), { code: data.code });
      return data;
    }
    if (taskId) {
      const bound = await post(`/api/task-board/tasks/${encodeURIComponent(taskId)}/chat-session`);
      if (!bound.sessionId) throw new Error('chat_session_missing');
      sessionId = bound.sessionId;
    }
    if (!sessionId) throw new Error('session_required');
    let shell;
    try { shell = await post('/api/task-shells', { sessionId }); }
    catch (error) {
      if (!taskId && error.code === 'unsupported_source') return null;
      throw error;
    }
    if (!shell.id) throw new Error('shell_missing');
    let resolvedTaskId = '';
    if (taskId) {
      const task = await post(`/api/task-shells/${encodeURIComponent(shell.id)}/tasks/resolve`, { taskId });
      resolvedTaskId = task.id || taskId;
    }
    const params = new URLSearchParams({ shell: shell.id });
    if (resolvedTaskId) params.set('task', resolvedTaskId);
    return `/task-shell.html?${params.toString()}`;
  }
  const api = { resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MultiCCChatShellEntry = api;
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';

// Task lifecycle state is deliberately irrelevant: an archived card still
// owns its evidence, including merged aliases and messages shared by tasks.
function createTaskHistoryRetention({ getBoard, getRecord, loadHistory }) {
  function tasks() { return Object.values(getBoard().tasks || {}).filter(task => !task.deleting); }
  function isMessageProtected(sessionId, message) {
    if (message.taskId && !getBoard().tasks?.[message.taskId]?.deleting) return true; // includes a provisional task awaiting classification
    return tasks().some(task => (task.refs || []).some(ref =>
      ref.sessionId === sessionId && (!ref.userMsgId && !ref.assistantMsgId
        || ref.userMsgId === message.id || ref.assistantMsgId === message.id)));
  }
  function canDeleteSession(sessionId) {
    // Legacy execution slots are disposable copies. Their host seals the run
    // ledger before resetSlot; ordinary/bound chats have no such guarantee.
    if (getRecord(sessionId)?.taskExecutionSlot === true) return true;
    const linked = tasks().some(task => task.chatSessionId === sessionId
      || task.routing?.workerSessionId === sessionId
      || (task.refs || []).some(ref => ref.sessionId === sessionId));
    if (linked) return false;
    const ids = new Set(tasks().map(task => task.id));
    let messages;
    try { messages = loadHistory(sessionId); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    return !messages.some(message => ids.has(message.taskId));
  }
  // Names the tasks that pin a session's history, mirroring canDeleteSession's
  // two linkage conditions, so a refusal can tell the user which task to delete
  // instead of only reporting an opaque TASK_HISTORY_REFERENCED code.
  function referencingTasks(sessionId) {
    const all = tasks();
    const byId = new Map(all.map(task => [task.id, task]));
    const found = [];
    const seen = new Set();
    const add = task => {
      if (!task || !task.id || seen.has(task.id)) return;
      seen.add(task.id);
      found.push({ id: task.id, title: task.title || task.id });
    };
    for (const task of all) {
      if (task.chatSessionId === sessionId
        || task.routing?.workerSessionId === sessionId
        || (task.refs || []).some(ref => ref.sessionId === sessionId)) add(task);
    }
    let messages;
    try { messages = loadHistory(sessionId); }
    catch (error) { if (error.code !== 'ENOENT') throw error; messages = []; }
    for (const message of messages) {
      if (message && message.taskId && byId.has(message.taskId)) add(byId.get(message.taskId));
    }
    return found;
  }
  return Object.freeze({ canDeleteSession, isMessageProtected, referencingTasks });
}

// Shapes a retention refusal into the cascade/HTTP result body, naming the tasks
// that pin the history so the UI can tell the user exactly what to delete
// instead of surfacing a bare TASK_HISTORY_REFERENCED code.
function taskHistoryRefusal(error = {}) {
  const tasks = Array.isArray(error.tasks) ? error.tasks : [];
  const names = tasks.map(task => task.title || task.id).filter(Boolean);
  const hint = '请删除对应任务，或先在会话内「清空历史」再删。';
  return {
    ok: false,
    code: error.code || 'history_check_failed',
    blocked: true,
    reasons: ['task_history_referenced'],
    tasks,
    taskIds: tasks.map(task => task.id).filter(Boolean),
    error: names.length
      ? `会话历史仍被任务引用，无法删除：${names.map(name => `「${name}」`).join('、')}。${hint}`
      : `会话历史仍被任务引用，无法删除。${hint}`,
  };
}

module.exports = { createTaskHistoryRetention, taskHistoryRefusal };

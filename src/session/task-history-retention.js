'use strict';

// Task lifecycle state is deliberately irrelevant: an archived card still
// owns its evidence, including merged aliases and messages shared by tasks.
function createTaskHistoryRetention({ getBoard, getRecord, loadHistory }) {
  function tasks() { return Object.values(getBoard().tasks || {}).filter(task => !task.deleting); }
  function isMessageProtected(sessionId, message) {
    // A stamp naming a task that is absent from the board but present in the
    // deletedTaskIds suppression set is an orphan: its owner is already gone,
    // so it must not block disposal forever. A stamp absent from BOTH is a
    // provisional task awaiting classification and stays protected.
    if (message.taskId && !getBoard().tasks?.[message.taskId]?.deleting
      && !(getBoard().deletedTaskIds || []).includes(message.taskId)) return true;
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
  // instead of only reporting an opaque TASK_HISTORY_REFERENCED code. Each task
  // carries `via`: 'session' means it formally owns/links the whole session
  // (an external or bound task), 'messages' means it only has stamped messages
  // inside this conversation (a sibling task sharing the same shell) — the UI
  // uses that to separate "delete those first" from "they live right here".
  function referencingTasks(sessionId) {
    const all = tasks();
    const byId = new Map(all.map(task => [task.id, task]));
    const found = [];
    const seen = new Set();
    const add = (task, via) => {
      if (!task || !task.id || seen.has(task.id)) return;
      seen.add(task.id);
      found.push({ id: task.id, title: task.title || task.id, via });
    };
    for (const task of all) {
      if (task.chatSessionId === sessionId
        || task.routing?.workerSessionId === sessionId
        || (task.refs || []).some(ref => ref.sessionId === sessionId)) add(task, 'session');
    }
    let messages;
    try { messages = loadHistory(sessionId); }
    catch (error) { if (error.code !== 'ENOENT') throw error; messages = []; }
    for (const message of messages) {
      if (message && message.taskId && byId.has(message.taskId)) add(byId.get(message.taskId), 'messages');
    }
    return found;
  }
  return Object.freeze({ canDeleteSession, isMessageProtected, referencingTasks });
}

// Shapes a retention refusal into the cascade/HTTP result body, naming the tasks
// that pin the history so the UI can tell the user exactly what to delete
// instead of surfacing a bare TASK_HISTORY_REFERENCED code. Tasks are grouped
// by linkage kind: tasks that formally reference the session vs. sibling tasks
// whose messages simply live in the same conversation.
function taskHistoryRefusal(error = {}) {
  const tasks = Array.isArray(error.tasks) ? error.tasks : [];
  const name = task => task.title || task.id;
  const quote = list => list.map(item => `「${item}」`).join('、');
  const external = tasks.filter(task => task && task.via !== 'messages').map(name).filter(Boolean);
  const colocated = tasks.filter(task => task && task.via === 'messages').map(name).filter(Boolean);
  const groups = [
    ...(external.length ? [`引用它的任务：${quote(external)}`] : []),
    ...(colocated.length ? [`同一对话中的任务：${quote(colocated)}`] : []),
  ];
  const hint = '请先删除这些任务，或在会话内「清空历史」再删。';
  return {
    ok: false,
    code: error.code || 'history_check_failed',
    blocked: true,
    reasons: ['task_history_referenced'],
    tasks,
    taskIds: tasks.map(task => task.id).filter(Boolean),
    error: groups.length
      ? `会话历史仍被任务引用，无法删除（${groups.join('；')}）。${hint}`
      : `会话历史仍被任务引用，无法删除。${hint}`,
  };
}

module.exports = { createTaskHistoryRetention, taskHistoryRefusal };

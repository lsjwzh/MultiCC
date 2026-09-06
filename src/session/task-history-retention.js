'use strict';

// Task lifecycle state is deliberately irrelevant: an archived card still
// owns its evidence, including merged aliases and messages shared by tasks.
function createTaskHistoryRetention({ getBoard, getRecord, loadHistory }) {
  function tasks() { return Object.values(getBoard().tasks || {}); }
  function isMessageProtected(sessionId, message) {
    if (message.taskId) return true; // includes a provisional task awaiting classification
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
  return Object.freeze({ canDeleteSession, isMessageProtected });
}

module.exports = { createTaskHistoryRetention };

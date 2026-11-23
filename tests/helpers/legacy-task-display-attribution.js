'use strict';

function shortCode(codeFor, taskId) {
  if (typeof codeFor !== 'function' || !taskId) return '';
  const code = String(codeFor(taskId) || '').trim().toUpperCase();
  return /^[0-9A-Z]{4}$/.test(code) ? code : '';
}

function taskFields(task, codeFor) {
  const code = shortCode(codeFor, task?.id);
  return code ? { taskShortCode: code } : {};
}

function displayTask(task, codeFor) {
  if (!task || typeof task !== 'object') return task;
  const fields = taskFields(task, codeFor);
  return Object.keys(fields).length ? { ...task, ...fields } : task;
}

function displayMessages(messages, fallbackTask, { getTask = () => null, codeFor } = {}) {
  if (typeof codeFor !== 'function') return messages;
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return message;
    const taskId = message.taskId || fallbackTask?.id;
    const source = getTask(taskId) || (taskId === fallbackTask?.id ? fallbackTask : null);
    const code = shortCode(codeFor, taskId);
    if (!taskId || !code) return message;
    return { ...message, taskId, taskName: message.taskName || source?.title || taskId, taskShortCode: code };
  });
}

module.exports = { displayMessages, displayTask, shortCode, taskFields };

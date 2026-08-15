'use strict';

const PHASE_ALIASES = Object.freeze({
  planning: 'planning', '规划中': 'planning',
  implementing: 'implementing', '实现中': 'implementing',
  verifying: 'verifying', '验证中': 'verifying',
  wrapping: 'wrapping', '收尾中': 'wrapping',
  done: 'done', '已完成': 'done',
});

function cleanName(value) {
  const name = String(value || '').trim().replace(/^[-—]+$/, '');
  if (name.length < 2) return '';
  return name.slice(0, 60);
}

function stripThinking(text) {
  let clean = String(text || '');
  const marker = '<｜end▁of▁thinking｜>';
  const markerIndex = clean.indexOf(marker);
  if (markerIndex !== -1) clean = clean.slice(markerIndex + marker.length);
  return clean.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseJsonObject(text) {
  const clean = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(clean.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function parseTaskAttribution(text, { fallbackTaskId = null, allowedTaskIds = null } = {}) {
  const object = parseJsonObject(text);
  if (object) {
    const relation = String(object.relation || '').toLowerCase() === 'new' ? 'new' : 'same';
    const requestedTaskId = String(object.taskId || '').trim();
    const allowed = allowedTaskIds == null ? null : new Set(allowedTaskIds);
    const existingTaskId = requestedTaskId && (!allowed || allowed.has(requestedTaskId))
      ? requestedTaskId : fallbackTaskId || null;
    return {
      taskName: cleanName(object.taskName || object.goal || object.title),
      phase: PHASE_ALIASES[String(object.phase || '').trim()] || null,
      relation,
      taskId: relation === 'same' ? existingTaskId : null,
    };
  }

  // Backward-compatible replay of historical three-line Aux output. Old runs
  // did not carry a relation, so they can refine the current task name but may
  // never invent a new identity during a backtest.
  const lines = stripThinking(text).split('\n').map(line => line.trim()).filter(Boolean);
  return {
    taskName: cleanName((lines[0] || '').replace(/^(目标|task|goal)[:：]\s*/i, '')),
    phase: PHASE_ALIASES[(lines[1] || '').replace(/^(阶段|phase)[:：]\s*/i, '').trim()] || null,
    relation: 'same',
    taskId: fallbackTaskId || null,
  };
}

function recentTaskContext(history, { limit = 6 } = {}) {
  const tasks = [];
  const byId = new Map();
  const source = Array.isArray(history) ? history : [];
  for (let index = source.length - 1; index >= 0 && tasks.length < limit; index -= 1) {
    const message = source[index];
    const taskId = String(message?.taskId || '').trim();
    if (!taskId) continue;
    const taskName = cleanName(message.taskName || message.taskText || '');
    if (byId.has(taskId)) {
      const task = byId.get(taskId);
      if (!task.taskName && taskName) task.taskName = taskName;
      continue;
    }
    const task = { taskId, taskName };
    byId.set(taskId, task);
    tasks.push(task);
  }
  return tasks;
}

function buildTaskAttributionSystemPrompt({ recentTasks = [], currentTaskId = null } = {}) {
  const known = recentTasks.length
    ? recentTasks.map(task => `- ${task.taskId}: ${task.taskName || '（名称待提取）'}`).join('\n')
    : '- 无';
  return `你是任务归集器，只负责给消息归属任务，不负责判断 turn 的运行状态。\n\n最近任务：\n${known}\n当前任务ID：${currentTaskId || '无'}\n\n判断最新一轮是真正的新任务，还是最近某个任务的继续、追问、修订或衍生。继续/衍生必须复用原任务名和 taskId；只有目标确实不同才 relation=new。\n\n只输出一个 JSON 对象：\n{"taskName":"简短任务名","phase":"planning|implementing|verifying|wrapping|done","relation":"same|new","taskId":"same 时填写上面的既有 ID；new 时为 null"}\n不要输出状态字母、解释或 Markdown。`;
}

function buildTaskAttributionConversation(history, reply = '') {
  const source = Array.isArray(history) ? history : [];
  const parts = [];
  let count = 0;
  for (let index = source.length - 1; index >= 0 && count < 20; index -= 1) {
    const message = source[index];
    if (!message || !['user', 'assistant'].includes(message.role) || !message.content) continue;
    const task = message.taskId
      ? ` [任务 ${message.taskName || '名称待提取'} | ${message.taskId}]` : '';
    parts.unshift(`${message.role === 'user' ? '用户' : '助手'}${task}：${String(message.content)}`);
    count += 1;
  }
  if (reply && String(source.at(-1)?.content || '') !== String(reply)) {
    parts.push(`助手：${String(reply)}`);
  }
  return `对话记录：\n${parts.join('\n\n')}`;
}

module.exports = {
  buildTaskAttributionConversation,
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  recentTaskContext,
};

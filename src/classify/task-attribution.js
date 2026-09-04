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
    const requestedRelatedTaskId = String(object.relatedTaskId || '').trim();
    const allowed = allowedTaskIds == null ? null : new Set(allowedTaskIds);
    const existingTaskId = requestedTaskId && (!allowed || allowed.has(requestedTaskId))
      ? requestedTaskId : fallbackTaskId || null;
    const relatedTaskId = relation === 'new' && requestedRelatedTaskId
      && requestedRelatedTaskId !== fallbackTaskId
      && (!allowed || allowed.has(requestedRelatedTaskId))
      ? requestedRelatedTaskId : null;
    return {
      taskName: cleanName(object.taskName || object.goal || object.title),
      phase: PHASE_ALIASES[String(object.phase || '').trim()] || null,
      relation,
      taskId: relation === 'same' ? existingTaskId : null,
      relatedTaskId,
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
    relatedTaskId: null,
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

function buildTaskAttributionSystemPrompt({
  recentTasks = [], currentTaskId = null, provisionalTaskId = null, identityLocked = false,
} = {}) {
  const known = recentTasks.length
    ? recentTasks.map(task => `- ${task.taskId}: ${task.taskName || '（名称待提取）'}`).join('\n')
    : '- 无';
  const identityRule = identityLocked
    ? `任务身份已由明确任务卡或 #CODE 锁定为 ${currentTaskId}；输出 relation=same、该 taskId、relatedTaskId=null，只精炼名称与阶段。`
    : provisionalTaskId
      ? `${provisionalTaskId} 是本轮候选 ID：若目标不同输出 relation=new/taskId=null（候选 ID 会升格）；若新任务由某个旧任务衍生或与其属于同一工作主题，把该旧 ID 填入 relatedTaskId；若完全无关则 relatedTaskId=null。若是同一任务续作，relation=same 必须选择最近任务中另一个既有 canonical taskId，relatedTaskId=null。`
      : '';
  return `你是任务归集器，只负责给消息归属任务，不负责判断 turn 的运行状态。\n\n最近任务：\n${known}\n当前任务ID：${currentTaskId || '无'}${identityRule ? `\n${identityRule}` : ''}\n\n判断最新一轮是真正的新任务，还是最近某个任务的继续、追问或修订。同一交付目标的继续才复用原任务名和 taskId。产生独立交付物、子任务或衍生任务时 relation=new，保留新任务身份；若它与某个旧任务属于同一工作主题，用 relatedTaskId 指向该旧任务，仅供任务面板归组。\n\n只输出一个 JSON 对象：\n{"taskName":"简短任务名","phase":"planning|implementing|verifying|wrapping|done","relation":"same|new","taskId":"same 时填写上面的既有 ID；new 时为 null","relatedTaskId":"new 且相关时填写既有 ID；否则 null"}\n不要输出状态字母、解释或 Markdown。`;
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

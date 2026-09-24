'use strict';

const { cleanMemoryCandidate } = require('../memory/task-distill');
const taskSearch = require('../task-board/search');

// How much of the current turn is used as the retrieval query. The user message
// states the intent in a sentence or two; the reply is long and mostly narration,
// so it is only allowed to contribute its own bounded slice.
const RETRIEVAL_USER_CHARS = 400;
const RETRIEVAL_REPLY_CHARS = 400;
const RETRIEVAL_LIMIT = 5;
// Relevance floor, relative to the best hit of this same query: corpus size and
// idf scale move the absolute numbers around, so an absolute threshold would be a
// different filter on every board. Hits the model cannot use are worse than no
// hits — they invite a wrong `relation=same`.
const RETRIEVAL_RELATIVE_FLOOR = 0.35;
const RETRIEVAL_SNIPPET_CHARS = 90;

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
    // relation=new：relatedTaskId 指向衍生来源（父任务候选）。
    // relation=same：relatedTaskId 只形成弱分组边（taskGroups），不改变归属，
    // 且绝不允许指向任务自己。
    const ownId = relation === 'same' ? existingTaskId : fallbackTaskId;
    const relatedTaskId = requestedRelatedTaskId
      && requestedRelatedTaskId !== ownId
      && (!allowed || allowed.has(requestedRelatedTaskId))
      ? requestedRelatedTaskId : null;
    return {
      taskName: cleanName(object.taskName || object.goal || object.title),
      phase: PHASE_ALIASES[String(object.phase || '').trim()] || null,
      relation,
      taskId: relation === 'same' ? existingTaskId : null,
      relatedTaskId,
      memoryCandidate: cleanMemoryCandidate(object.memory_candidate || object.memoryCandidate),
      ...(object.contextRelevance === 'low' && cleanName(object.splitTaskName) ? {
        separation: { title: cleanName(object.splitTaskName),
          reason: String(object.relevanceReason || '').trim().slice(0, 240) },
      } : {}),
    };
  }

  // Backward-compatible replay of historical three-line Aux output. Old runs
  // did not carry a relation, so they can refine the current task name but may
  // never invent a new identity during a backtest.
  // Fallback for text that is not the JSON contract at all. The legacy
  // three-line shape keeps working, but an answer that *tried* to be JSON and
  // did not parse (or produced no usable name) is reported as `unclassified`
  // instead of being silently recorded as a permanent `same`.
  const cleaned = stripThinking(text);
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  const taskName = cleanName((lines[0] || '').replace(/^(目标|task|goal)[:：]\s*/i, ''));
  // "Tried to be JSON and did not parse" is the signal, not "contains a brace":
  // a legacy three-line answer is allowed to mention {name} in its goal without
  // being reclassified as unreadable.
  const looksStructured = /^\s*[{[]/.test(cleaned) || /"(relation|taskId|taskName|goal)"\s*:/.test(cleaned);
  return {
    taskName,
    phase: PHASE_ALIASES[(lines[1] || '').replace(/^(阶段|phase)[:：]\s*/i, '').trim()] || null,
    relation: 'same',
    taskId: fallbackTaskId || null,
    relatedTaskId: null,
    memoryCandidate: null,
    // Only present when the answer was unusable, so a legacy three-line verdict
    // keeps exactly the shape existing readers expect.
    ...(taskName && !looksStructured ? {} : { unclassified: true }),
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

// The text a turn is retrieved against: the user's own words first (they state
// the intent), then a bounded slice of the reply (it names the files and
// subsystems the turn actually touched).
function attributionQueryText({ userText = '', replyText = '' } = {}) {
  const user = String(userText || '').trim().slice(0, RETRIEVAL_USER_CHARS);
  const reply = String(replyText || '').trim().slice(0, RETRIEVAL_REPLY_CHARS);
  return [user, reply].filter(Boolean).join('\n');
}

// Tasks whose *content* matches this turn, retrieved from the whole board rather
// than from the session's own recent history. This is what lets a turn be
// attributed to a task this session never mentioned: "把上次那个搜索再改一下"
// carries no title to match, only content.
//
// Pure and best-effort by construction: no board, no real word in the query, or a
// throwing index all degrade to "no candidates" — never to a failed attribution,
// and never to a wrong identity.
function retrieveRelatedTasks(board, {
  userText = '', replyText = '', excludeTaskIds = [], limit = RETRIEVAL_LIMIT,
} = {}) {
  const query = attributionQueryText({ userText, replyText });
  if (!board || !query) return [];
  const exclusions = new Set((Array.isArray(excludeTaskIds) ? excludeTaskIds : []).map(String));
  let hits = [];
  try {
    // A query made only of lone CJK characters is far too common to be evidence.
    if (!taskSearch.analyzeQuery(query).strong.length) return [];
    hits = taskSearch.searchBoard(board, query, { limit: Math.max(1, limit) * 3 + exclusions.size });
  } catch (_) {
    return [];
  }
  // The floor is measured against the best match these words have on this board —
  // *before* the session's own recent tasks are removed. Otherwise excluding the
  // best match would lower the bar and promote a coincidence into the prompt.
  const top = Number(hits[0]?.score) || 0;
  if (top <= 0) return [];
  return hits
    .filter(hit => !exclusions.has(String(hit.taskId)))
    .filter(hit => Number(hit.score) >= top * RETRIEVAL_RELATIVE_FLOOR)
    .slice(0, Math.max(1, limit))
    .map(hit => ({
      taskId: hit.taskId,
      taskName: cleanName(hit.title),
      score: hit.score,
      // The matched passage is the evidence the model judges with; it is shown
      // quoted under the candidate so a title-only coincidence cannot be mistaken
      // for the same work.
      snippet: String(hit.snippet?.text || '').replace(/\s+/g, ' ').trim().slice(0, RETRIEVAL_SNIPPET_CHARS),
    }));
}

function buildTaskAttributionSystemPrompt({
  recentTasks = [], relatedTasks = [], currentTaskId = null, provisionalTaskId = null,
  identityLocked = false,
} = {}) {
  const known = recentTasks.length
    ? recentTasks.map(task => `- ${task.taskId}: ${task.taskName || '（名称待提取）'}`).join('\n')
    : '- 无';
  // Retrieval by content, shown apart from the recency list precisely because it
  // means something weaker: same material, not necessarily the same deliverable.
  const related = relatedTasks.length
    ? `\n\n内容相关任务（按最新一轮内容从整个任务板检索出来的历史任务；括号里是命中的原文片段，只说明内容相关，不证明是同一个任务）：\n${
      relatedTasks.map(task => `- ${task.taskId}: ${task.taskName || '（名称待提取）'}${task.snippet ? `（${task.snippet}）` : ''}`).join('\n')}`
    : '';
  const identityRule = identityLocked
    ? `任务身份已由明确任务卡或 #CODE 锁定为 ${currentTaskId}；输出 relation=same、该 taskId、relatedTaskId=null，只精炼名称与阶段。`
    : provisionalTaskId
      ? `${provisionalTaskId} 是本轮候选 ID：若目标不同输出 relation=new/taskId=null（候选 ID 会升格）；若新任务由某个旧任务衍生或与其属于同一工作主题，把该旧 ID 填入 relatedTaskId；若完全无关则 relatedTaskId=null。若是同一任务续作，relation=same 必须选择最近任务（或内容相关任务）中另一个既有 canonical taskId，relatedTaskId=null。`
      : '';
  const relevanceRule = '另外独立判断最新一轮与当前聊天窗口前序工作的关联度 contextRelevance（high|medium|low）。即使任务身份锁定，也必须判断关联度；锁定只约束 taskId/relation。最新一轮明确转向与前序不同的交付目标时判 low——同一仓库、同一产品内的不同功能或问题也算不同交付目标；只有同一交付目标的继续/追问/纠正/状态询问，或首轮无前序工作，才不判 low；拿不准时用 medium。low 时 splitTaskName 给出新目标的简短名称，relevanceReason 用一句话说明区别，taskName 保留原任务名称；其余两字段填 null。这只是建议，只有用户确认才会分离。';
  const relatedRule = relatedTasks.length
    ? `\n\n「内容相关任务」是按最新一轮内容从整个任务板检索出来的，可能包含本次会话从没提过的任务。命中只说明材料/主题相关：若最新一轮确实是其中某个任务的继续、追问或修订，可以 relation=same 并填它的 id；若它与最新一轮属于同一工作主题但交付物不同，relation=new 并把它的 id 填进 relatedTaskId；判定不了就忽略它。不要仅因命中就复用它的 taskId。`
    : '';
  return `你是任务归集器，只负责给消息归属任务，不负责判断 turn 的运行状态。\n\n最近任务：\n${known}${related}${relatedRule}\n当前任务ID：${currentTaskId || '无'}${identityRule ? `\n${identityRule}` : ''}\n\n判断最新一轮是真正的新任务，还是最近某个任务的继续、追问或修订。同一交付目标的继续才复用原任务名和 taskId。产生独立交付物、子任务或衍生任务时 relation=new，保留新任务身份；若它与某个旧任务属于同一工作主题，用 relatedTaskId 指向该旧任务，仅供任务面板归组。relation=same 时也可填 relatedTaskId 表示弱关联（同主题分组），但不能指向当前任务自己。\n\n${relevanceRule}\n\n同时提炼 memory_candidate：本轮对话中值得沉淀进任务长期记忆的稳定事实、决策或结论（接口约定、踩坑、方案取舍），一句话、不含过程描述；没有值得记的就填 null。\n\n只输出一个 JSON 对象：\n{"taskName":"简短任务名","phase":"planning|implementing|verifying|wrapping|done","relation":"same|new","taskId":"same 时填写上面的既有 ID；new 时为 null","relatedTaskId":"相关时填写既有 ID；否则 null","contextRelevance":"high|medium|low","splitTaskName":null,"relevanceReason":null,"memory_candidate":"值得记的一条结论，或 null"}\n不要输出状态字母、解释或 Markdown。`;
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
  attributionQueryText,
  buildTaskAttributionConversation,
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  recentTaskContext,
  retrieveRelatedTasks,
  RETRIEVAL_LIMIT,
  RETRIEVAL_RELATIVE_FLOOR,
};

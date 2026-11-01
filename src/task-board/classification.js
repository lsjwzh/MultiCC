'use strict';
const { randomUUID } = require('node:crypto');
const { boardRule } = require('./native-bridge');
const { MAX_TASKS_IN_PROMPT } = require('./normalize');
// 提示词里的现有任务清单：一次规则调用排好序，不在比较器里逐次调原生。
const promptTasks = board => boardRule('recentTaskIds', { board, limit: MAX_TASKS_IN_PROMPT }).map(id => board.tasks[id]);
// 提示词文本与宿主输入适配保留；解析和所有任务/模块变更由 Rust 执行。
function buildTagSystemPrompt() {
  return [
    '你是 multicc 的任务归档器。multicc 同时运行多个 AI 会话，你负责把每轮对话归档到「模块-任务」两级任务板上。',
    '输入包含：现有模块与任务清单、本轮对话（用户消息+助手回复）。',
    '输出严格 JSON（不要 markdown 围栏、不要任何解释文字）：',
    '{"tasks":[{"id":"现有任务id或new","title":"任务标题","module":"模块名","areas":["代码路径或功能区域"]}]}',
    '',
    '规则：',
    '1. 一轮对话可归入多个任务（最多3个），也可以不归入任何任务：闲聊、寒暄、状态询问、纯知识问答输出 {"tasks":[]}。',
    '2. 优先归入现有任务：延续同一目标/同一代码区域，或只是标题措辞不同但实际工作同类 → 必须复用现有任务id（此时 title/module 可省略），不要重复建卡。',
    '3. 确属新工作才建新任务：id 填 "new"，title ≤20字、概括任务目标（如「实现任务板后端」），不要写成本轮动作（如「回答了问题」）。',
    '4. module 是任务的上层分组，按子系统/目录聚合（例：「服务端」「前端 UI」「移动 App」「发布运维」「文档」）。优先复用现有模块名，确实不匹配才新建。',
    '5. areas 列本轮涉及的代码路径/文件/功能区（≤5项），没有就给空数组。',
  ].join('\n');
}

function buildTagUserPrompt({ board, sessionLabel, dirLabel, userText, replyText }) {
  const moduleLines = Object.values(board.modules).map(m => `- ${m.name}`);
  const taskList = promptTasks(board)
    .map(t => {
      const mod = board.modules[t.moduleId];
      return `- ${t.id} | ${mod ? mod.name : '?'} | ${t.title} | ${t.areas.slice(0, 3).join(', ')}`;
    });
  return [
    '【现有模块】',
    moduleLines.length ? moduleLines.join('\n') : '（空）',
    '',
    '【现有任务】（id | 模块 | 标题 | 区域）',
    taskList.length ? taskList.join('\n') : '（空）',
    '',
    `【本轮对话】会话：${sessionLabel || '?'}${dirLabel ? `（目录：${dirLabel}）` : ''}`,
    `用户：${String(userText || '').slice(0, 1200)}`,
    `助手：${String(replyText || '').slice(0, 1800)}`,
    '',
    '请输出 JSON。',
  ].join('\n');
}

// ── Backfill prompts (one aux call per session, whole recent history) ───────
// Unlike per-turn tagging, backfill sees numbered turns and assigns each task
// the turn numbers that belong to it, so one call archives a whole session.

function buildBackfillSystemPrompt() {
  return [
    '你是 multicc 的任务归档器。multicc 同时运行多个 AI 会话，现在要把一个会话的历史对话批量归档到「模块-任务」两级任务板上。',
    '输入包含：现有模块与任务清单、该会话的编号轮次列表（每轮=用户消息+助手回复摘要）。',
    '输出严格 JSON（不要 markdown 围栏、不要任何解释文字）：',
    '{"tasks":[{"id":"现有任务id或new","title":"任务标题","module":"模块名","areas":["代码路径或功能区域"],"turns":[轮次编号]}]}',
    '',
    '规则：',
    '1. turns 列出属于该任务的轮次编号（整数，来自输入）。一个轮次可属于多个任务；闲聊、寒暄、状态询问轮次不要归入任何任务。',
    '2. 相邻多轮做同一件事 → 归成一个任务，不要一轮一个任务。整个会话通常归出 1-5 个任务。',
    '3. 优先归入现有任务：目标/代码区域相同，或只是标题措辞不同但实际工作同类时，必须复用现有任务id（title/module 可省略）；确属新工作才 id:"new"。',
    '4. title ≤20字、概括任务目标；module 按子系统/目录聚合（例：「服务端」「前端 UI」「移动 App」「发布运维」「文档」），优先复用现有模块名。',
    '5. areas 列该任务涉及的代码路径/文件/功能区（≤5项）。',
  ].join('\n');
}

function buildBackfillUserPrompt({ board, sessionLabel, dirLabel, turns }) {
  const moduleLines = Object.values(board.modules).map(m => `- ${m.name}`);
  const taskList = promptTasks(board)
    .map(t => {
      const mod = board.modules[t.moduleId];
      return `- ${t.id} | ${mod ? mod.name : '?'} | ${t.title}`;
    });
  const turnLines = turns.map(t => [
    `【轮次 ${t.n}】`,
    `用户：${String(t.user || '').slice(0, 500)}`,
    `助手：${String(t.reply || '').slice(0, 700)}`,
  ].join('\n'));
  return [
    '【现有模块】',
    moduleLines.length ? moduleLines.join('\n') : '（空）',
    '',
    '【现有任务】（id | 模块 | 标题）',
    taskList.length ? taskList.join('\n') : '（空）',
    '',
    `【会话】${sessionLabel || '?'}${dirLabel ? `（目录：${dirLabel}）` : ''}，共 ${turns.length} 轮：`,
    turnLines.join('\n\n'),
    '',
    '请输出 JSON。',
  ].join('\n');
}


function call(action, args = {}) {
  const newIds = Array.from({ length: 32 }, () => randomUUID().replace(/-/g, ''));
  const idOrder = Object.values(args.board?.taskGroups || {}).map(group => group.id).sort((a, b) => a.localeCompare(b));
  return boardRule(action, { op: 'classification', ...args, newIds, idOrder });
}
const parseTagResult = value => call('parseTagResult', { value });
const parseBackfillResult = value => call('parseBackfillResult', { value });
function findTaskByTitle(board, moduleId, value, options = {}) { const task = call('findTaskByTitle', { board, moduleId, value, options }); return task ? board.tasks[task.id] : null; }
function createPendingTask(board, input) { const task = call('createPendingTask', { board, input: { now: Date.now(), ...input } }); return task ? board.tasks[task.id] : null; }
const applyTaskClassification = (board, taskId, entry, ref, now = Date.now(), options = {}) => call('applyTaskClassification', { board, taskId, entry, ref, now, options });
const applyTagResult = (board, entries, ref, now = Date.now(), options = {}) => call('applyTagResult', { board, entries, ref, now, options });
const applyBackfillResult = (board, entries, refByTurn, now = Date.now()) => call('applyBackfillResult', { board, entries, refByTurn: Object.fromEntries(refByTurn), now });
const mergeTasks = (board, input = {}) => call('mergeTasks', { board, input: { now: Date.now(), ...input } });
module.exports = { buildTagSystemPrompt, buildTagUserPrompt, buildBackfillSystemPrompt, buildBackfillUserPrompt,
  parseTagResult, parseBackfillResult, applyTagResult, applyBackfillResult, findTaskByTitle, mergeTasks, createPendingTask, applyTaskClassification };

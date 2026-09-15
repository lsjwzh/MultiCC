'use strict';

// 任务图谱上下文构建（P3 输出侧）：按任务关联图谱做 ≤2 跳的邻接收集，
// 把对当前任务最有用的关联信息拼成一段带 token 预算的上下文块。
//   · 父任务（第 1 跳）：标题 + 任务级记忆（tasks/<id>/MEMORY.md 节选）；
//     祖父（第 2 跳）：仅标题，避免链条越长噪声越大。
//   · 同组任务（taskGroups）：标题 + 一句话摘要（board 描述 / refs excerpt）。
//   · 同壳前序任务（shell-link 邻接）：标题 + handoff 快照里最后一条助手结论。
// 纯函数、依赖全注入：runtime 侧只负责把 taskId 交进来，图谱数据、记忆
// 读取、token 估算全部由宿主注入，便于单测与降级（任何一环缺失就少一段，
// 整体为空时不注入空段）。
// detail 版本同时返回 sources（引用了哪些任务/哪份记忆、注入了哪一行），
// 落进 receipt 后由 contextTrace 呈现在「引用来源」面板。

const { estimateTokens, hash } = require('./context');
const { relevance, selectContext } = require('../context/selection');

const DEFAULT_TOKEN_BUDGET = 1200;
const PARENT_MEMORY_CHARS = 700;
const SUMMARY_CHARS = 200;
const CONCLUSION_CHARS = 260;

function clipText(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 从快照里捞最后一条助手结论：优先完整 content，超长时用 evidenceExcerpt。
function lastAssistantText(snapshot) {
  const messages = Array.isArray(snapshot && snapshot.messages) ? snapshot.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant' || message.partial || message.error || message.cancelled || message._interim || message.inProgress) continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content;
    if (typeof message.evidenceExcerpt === 'string' && message.evidenceExcerpt.trim()) {
      return message.evidenceExcerpt;
    }
  }
  return '';
}

// ports: {
//   task(id)            -> shell 任务记录 | null
//   boardTask(id)       -> board 任务卡 | null
//   groupOf(taskId)     -> { taskIds: [...] } | null
//   linkedTaskIds(id)   -> [taskId]（同壳邻接，含自己）
//   snapshot(id)        -> 快照 | null
//   readTaskMemory(dirId, taskId) -> string（'' 表示没有任务级记忆）
// }
function buildTaskGraphContextDetail(ports, { taskId, tokenBudget = DEFAULT_TOKEN_BUDGET, query = '' } = {}) {
  if (!ports || typeof taskId !== 'string' || !taskId) return { text: '', sources: [] };
  for (const name of ['task', 'boardTask', 'groupOf', 'linkedTaskIds', 'snapshot', 'readTaskMemory']) {
    if (typeof ports[name] !== 'function') return { text: '', sources: [] };
  }
  const self = ports.task(taskId);
  const boardSelf = ports.boardTask(taskId);
  const dirId = (self && self.dirId) || (boardSelf && boardSelf.dirId) || null;
  const titleOf = (id) => {
    const record = ports.task(id) || ports.boardTask(id);
    return (record && clipText(record.title, 120)) || id;
  };
  // 一条引用来源：哪个任务、以什么身份（父任务/记忆/同组/同壳）、注入了哪一行。
  const sourceOf = (id, kind, excerpt) => ({
    id: `graph:${kind}:${id}`, mode: `graph:${kind}`, version: hash(excerpt),
    taskId: id, taskName: titleOf(id), kind, excerpt, truncated: excerpt.includes('…'), estimatedTokens: estimateTokens(excerpt),
  });

  const sections = [];

  // ── 父任务（≤2 跳）───────────────────────────────────────────────────
  const parentId = (self && self.parentTaskId) || (boardSelf && boardSelf.parentTaskId) || null;
  if (parentId) {
    const parent = ports.task(parentId);
    const titleLine = `· 父任务 ${titleOf(parentId)}`;
    const lines = [titleLine];
    const sources = [sourceOf(parentId, 'parent', titleLine)];
    const memory = parent ? clipText(ports.readTaskMemory(parent.dirId || dirId, parentId), PARENT_MEMORY_CHARS) : '';
    if (memory) {
      const line = `  父任务记忆（节选）：${memory}`;
      lines.push(line);
      sources.push(sourceOf(parentId, 'memory', line));
    }
    if (parent && parent.parentTaskId) {
      const line = `· 祖父任务 ${titleOf(parent.parentTaskId)}（仅标题）`;
      lines.push(line);
      sources.push(sourceOf(parent.parentTaskId, 'grandparent', line));
    }
    sections.push({ kind: 'parent', text: lines.join('\n'), sources });
  }

  // ── 同组任务：标题 + 一句话摘要 ──────────────────────────────────────
  const group = ports.groupOf(taskId);
  if (group && Array.isArray(group.taskIds)) {
    const members = group.taskIds.filter(id => id !== taskId);
    const lines = [];
    const sources = [];
    for (const id of members) {
      const board = ports.boardTask(id);
      const summary = clipText(
        (board && (board.description || (Array.isArray(board.refs) && board.refs.length
          && board.refs[board.refs.length - 1].excerpt)))
        || '',
        SUMMARY_CHARS,
      );
      const line = `· 同组 ${titleOf(id)}${summary ? `：${summary}` : ''}`;
      lines.push(line);
      sources.push(sourceOf(id, 'group', line));
    }
    if (lines.length) sections.push({ kind: 'group', text: lines.join('\n'), sources });
  }

  // ── 同壳前序任务：标题 + handoff 最后结论 ────────────────────────────
  const siblingIds = (ports.linkedTaskIds(taskId) || [])
    .filter(id => id !== taskId && id !== parentId)
    ;
  {
    const lines = [];
    const sources = [];
    for (const id of siblingIds) {
      const record = ports.task(id);
      const snapshotIds = [...(record && record.handoffSnapshotIds) || [], ...(record && record.snapshotIds) || []];
      let conclusion = '';
      for (let i = snapshotIds.length - 1; i >= 0 && !conclusion; i--) {
        conclusion = clipText(lastAssistantText(ports.snapshot(snapshotIds[i])), CONCLUSION_CHARS);
      }
      const line = `· 同壳前序 ${titleOf(id)}${conclusion ? `：${conclusion}` : ''}`;
      lines.push(line);
      sources.push(sourceOf(id, 'shell', line));
    }
    if (lines.length) sections.push({ kind: 'shell', text: lines.join('\n'), sources });
  }

  if (!sections.length) return { text: '', sources: [] };

  const seen = new Set([taskId]);
  const allowed = id => {
    const other = ports.task(id) || ports.boardTask(id);
    return other && (!other.dirId || !dirId || other.dirId === dirId);
  };
  const candidates = sections.flatMap(section => section.sources).filter(source => {
    if (!allowed(source.taskId)) return false;
    if (source.kind !== 'memory' && seen.has(source.taskId)) return false;
    if (source.kind !== 'memory') seen.add(source.taskId);
    return true;
  }).map(source => ({ ...source, atomic: true,
    priority: ({ parent: 500, memory: 450, grandparent: 300, group: 200, shell: 100 }[source.kind] || 0)
      + Math.min(15, relevance(query, source.excerpt)) * 10,
    reason: relevance(query, source.excerpt) ? 'query_and_relation' : 'relation',
  }));
  const selected = selectContext(candidates, { budget: tokenBudget,
    header: `[任务图谱上下文｜相关历史资料，请核验状态] 当前任务 ${titleOf(taskId)}\n`,
    footer: '[任务图谱上下文结束]\n' });
  return { ...selected, candidates };

}

function buildTaskGraphContext(ports, options = {}) {
  return buildTaskGraphContextDetail(ports, options).text;
}

// 宿主侧工厂：把 board + shell store + 记忆读取接成 ports。
// deps: { getBoard, taskGraphData, readTaskMemory }，全部可选降级。
function createTaskGraphContextService(deps) {
  return function taskGraphContextOf(taskId, options) {
    const diagnostics = [];
    const read = (fn, fallback) => {
      try { return fn?.() || fallback; } catch (error) { diagnostics.push({ reason: error.message }); return fallback; }
    };
    const board = read(deps.getBoard, {}), state = read(deps.taskGraphData, {});
    const tasks = new Map((state.tasks || []).map(task => [task.id, task]));
    const shells = new Set((state.links || []).filter(l => l.taskId === taskId).map(l => l.shellId));
    const links = [...new Set((state.links || []).filter(l => shells.has(l.shellId)).map(l => l.taskId))];
    const detail = buildTaskGraphContextDetail({
      task: id => tasks.get(id) || null,
      boardTask: id => {
        const task = board.tasks?.[id];
        return task ? { ...task, dirId: task.dirId || board.modules?.[task.moduleId]?.dirId } : null;
      },
      groupOf: id => require('../task-board/core').relatedTaskGroup(board, id),
      linkedTaskIds: () => links.sort((a, b) => (tasks.get(b)?.createdAt || 0) - (tasks.get(a)?.createdAt || 0)),
      snapshot: id => read(() => deps.getSnapshot?.(id), null),
      readTaskMemory: (dirId, id) => read(() => deps.readTaskMemory?.(dirId, id), ''),
    }, { taskId, ...(options || {}) });
    return { ...detail, diagnostics };
  };

}

module.exports = {
  DEFAULT_TOKEN_BUDGET,
  buildTaskGraphContext,
  buildTaskGraphContextDetail,
  createTaskGraphContextService,
  lastAssistantText,
};

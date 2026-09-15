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

const { estimateTokens } = require('./context');

const DEFAULT_TOKEN_BUDGET = 1200;
const PARENT_MEMORY_CHARS = 700;
const SUMMARY_CHARS = 200;
const CONCLUSION_CHARS = 260;
const MAX_SIBLINGS = 4;
const MAX_GROUP_MEMBERS = 5;

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
    if (!message || message.role !== 'assistant') continue;
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
function buildTaskGraphContextDetail(ports, { taskId, tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
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
    taskId: id, taskName: titleOf(id), kind, excerpt, estimatedTokens: estimateTokens(excerpt),
  });

  const sections = [];
  let used = 0;
  const overBudget = (text) => {
    used += estimateTokens(text);
    return used > tokenBudget;
  };

  // ── 父任务（≤2 跳）───────────────────────────────────────────────────
  const parentId = (self && self.parentTaskId) || null;
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
    const members = group.taskIds.filter(id => id !== taskId).slice(0, MAX_GROUP_MEMBERS);
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
    .slice(0, MAX_SIBLINGS);
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

  // ── 预算裁剪：按 父任务 → 同组 → 同壳 的优先级收进预算 ────────────────
  const order = { parent: 0, group: 1, shell: 2 };
  sections.sort((a, b) => order[a.kind] - order[b.kind]);
  const kept = [];
  let keptSources = [];
  let truncated = false;
  for (const section of sections) {
    if (overBudget(section.text)) { truncated = true; break; }
    kept.push(section.text);
    keptSources.push(...section.sources);
  }
  if (!kept.length) {
    // 连第一段都超预算：至少给出关联任务的标题行（最便宜的图谱信号）。
    const names = sections.map(section => clipText(section.text.split('\n')[0], 160));
    kept.push(names.join('\n'));
    // 兜底只注入了标题行：来源仍全列（图谱关系是真的），但标记被截断。
    keptSources = sections.flatMap(section => section.sources.map(source => ({ ...source, truncated: true })));
    truncated = true;
  }

  const header = `[任务图谱上下文｜按图谱邻接注入，预算 ~${tokenBudget} tokens] 当前任务 ${titleOf(taskId)}${dirId ? `（${dirId}）` : ''}`;
  return {
    text: `${header}\n${kept.join('\n')}${truncated ? '\n（超出 token 预算，已截断）' : ''}\n[任务图谱上下文结束]\n`,
    sources: keptSources,
  };
}

function buildTaskGraphContext(ports, options = {}) {
  return buildTaskGraphContextDetail(ports, options).text;
}

// 宿主侧工厂：把 board + shell store + 记忆读取接成 ports。
// deps: { getBoard, taskGraphData, readTaskMemory }，全部可选降级。
function createTaskGraphContextService(deps) {
  const board = () => {
    try { return deps.getBoard() || {}; } catch (_) { return {}; }
  };
  const shellState = () => {
    try { return deps.taskGraphData() || {}; } catch (_) { return {}; }
  };
  const shellTaskIndex = () => new Map(
    (shellState().tasks || []).filter(Boolean).map(task => [task.id, task]),
  );
  const linkIndex = () => {
    // taskId -> 同壳邻接任务集合（含自己）。
    const byShell = new Map();
    for (const link of shellState().links || []) {
      if (!link || typeof link.shellId !== 'string' || typeof link.taskId !== 'string') continue;
      if (!byShell.has(link.shellId)) byShell.set(link.shellId, []);
      byShell.get(link.shellId).push(link.taskId);
    }
    const byTask = new Map();
    for (const taskIds of byShell.values()) {
      for (const id of taskIds) {
        byTask.set(id, [...new Set([...(byTask.get(id) || []), ...taskIds])]);
      }
    }
    return byTask;
  };
  const groupOf = (taskId) => {
    try {
      const { relatedTaskGroup } = require('../task-board/core');
      return relatedTaskGroup(board(), taskId);
    } catch (_) { return null; }
  };
  return function taskGraphContextOf(taskId, options) {
    return buildTaskGraphContextDetail({
      task: id => shellTaskIndex().get(id) || null,
      boardTask: id => (board().tasks || {})[id] || null,
      groupOf,
      linkedTaskIds: id => linkIndex().get(id) || [],
      snapshot: id => {
        try {
          const value = deps.getSnapshot ? deps.getSnapshot(id) : null;
          return value && !value.__missing ? value : null;
        } catch (_) { return null; }
      },
      readTaskMemory: (dirId, id) => {
        try { return deps.readTaskMemory(dirId, id) || ''; } catch (_) { return ''; }
      },
    }, { taskId, ...(options || {}) });
  };
}

module.exports = {
  DEFAULT_TOKEN_BUDGET,
  buildTaskGraphContext,
  buildTaskGraphContextDetail,
  createTaskGraphContextService,
  lastAssistantText,
};

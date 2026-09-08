'use strict';

const crypto = require('crypto');
const planning = require('./planning');
const {
  MAX_AREAS_PER_TASK,
  MAX_MODULE_LEN,
  MAX_REFS_PER_TASK,
  MAX_TAGS_PER_TURN,
  MAX_TASKS_IN_PROMPT,
  MAX_TITLE_LEN,
  CLASSIFY_PENDING_MODULE_NAME,
  PENDING_TASK_TITLE,
  TASK_ORIGINS,
  addRefToTask,
  canonicalTaskTitle,
  deriveTaskTitle,
  findModuleByName,
  legacyTaskOrigin,
  newId,
  ownTask,
  reconcileTaskGroups,
  resolveTask,
  taskDirId,
  taskLastTs,
  taskTitleSimilarity,
} = require('./normalize');
// AI classification layer: tag/backfill prompts, tolerant parsers, and the
// board mutations they drive (pending cards, merges, module moves).
// All shape/lookup helpers come from ./normalize; identity stays taskId.
// ── AI tagging prompts ──────────────────────────────────────────────────────

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
  const taskList = Object.values(board.tasks)
    .filter(t => t.status !== 'archived' && !t.moduleAssignment)
    .sort((a, b) => taskLastTs(b) - taskLastTs(a))
    .slice(0, MAX_TASKS_IN_PROMPT)
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
  const taskList = Object.values(board.tasks)
    .filter(t => t.status !== 'archived' && !t.moduleAssignment)
    .sort((a, b) => taskLastTs(b) - taskLastTs(a))
    .slice(0, MAX_TASKS_IN_PROMPT)
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

function parseBackfillResult(text) {
  let clean = String(text || '');
  const thinkEnd = clean.indexOf('<｜end▁of▁thinking｜>');
  if (thinkEnd !== -1) clean = clean.slice(thinkEnd + '<｜end▁of▁thinking｜>'.length);
  clean = clean.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '');
  clean = clean.replace(/```(?:json)?/gi, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(clean); } catch (_) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(clean.slice(start, end + 1)); } catch (_) { parsed = null; }
    }
  }
  const list = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, MAX_TITLE_LEN) : '';
    const module = typeof e.module === 'string' ? e.module.trim().slice(0, MAX_MODULE_LEN) : '';
    const areas = Array.isArray(e.areas)
      ? e.areas.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 80)).slice(0, 5)
      : [];
    const turns = Array.isArray(e.turns)
      ? [...new Set(e.turns.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0))]
      : [];
    if ((!id && !title) || !turns.length) continue;
    tasks.push({ id, title, module, areas, turns });
    if (tasks.length >= 8) break;
  }
  return { tasks };
}

// Apply a backfill verdict: for each entry, attach every listed turn's ref.
// Reuses the task id created for the first referenced turn. This groups the
// model's explicit backfill entry without treating its title as identity.
function stableLegacyBackfillTaskId(entry, entryIndex, refByTurn) {
  const refs = (entry?.turns || [])
    .map(n => refByTurn.get(n))
    .filter(Boolean)
    .map(ref => [
      ref.sessionId || '',
      ref.dirId || '',
      ref.userMsgId || '',
      ref.assistantMsgId || '',
    ].join('\u001f'));
  if (!refs.length) return null;
  const digest = crypto.createHash('sha256')
    .update(`${entryIndex}\u001e${refs.join('\u001d')}`)
    .digest('hex')
    .slice(0, 24);
  return `tsk-legacy-${digest}`;
}

function applyBackfillResult(board, entries, refByTurn, now = Date.now()) {
  const touched = new Set();
  for (const [entryIndex, e] of (entries || []).entries()) {
    const suppliedId = e.id && e.id !== 'new' ? e.id : null;
    const legacyId = suppliedId || stableLegacyBackfillTaskId(e, entryIndex, refByTurn);
    let stableEntry = legacyId ? { ...e, id: legacyId } : e;
    for (const n of e.turns || []) {
      const ref = refByTurn.get(n);
      if (!ref) continue;
      const changed = applyTagResult(board, [stableEntry], ref, now, { newTaskId: legacyId });
      for (const id of changed) touched.add(id);
      if ((!stableEntry.id || stableEntry.id === 'new') && changed[0]) {
        stableEntry = { ...stableEntry, id: changed[0] };
      }
    }
  }
  return [...touched];
}

// ── AI output parsing (two-stage tolerant, mirrors classify/goal parsers) ───

function parseTagResult(text) {
  let clean = String(text || '');
  const thinkEnd = clean.indexOf('<｜end▁of▁thinking｜>');
  if (thinkEnd !== -1) clean = clean.slice(thinkEnd + '<｜end▁of▁thinking｜>'.length);
  clean = clean.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\/?think>/g, '');
  clean = clean.replace(/```(?:json)?/gi, '').trim();

  let parsed = null;
  try { parsed = JSON.parse(clean); } catch (_) {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(clean.slice(start, end + 1)); } catch (_) { parsed = null; }
    }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : []);
  const tasks = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, MAX_TITLE_LEN) : '';
    const module = typeof e.module === 'string' ? e.module.trim().slice(0, MAX_MODULE_LEN) : '';
    const areas = Array.isArray(e.areas)
      ? e.areas.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 80)).slice(0, 5)
      : [];
    if (!id && !title) continue;
    tasks.push({ id, title, module, areas });
    if (tasks.length >= MAX_TAGS_PER_TURN) break;
  }
  return { tasks };
}

function findTaskByTitle(board, moduleId, title, { dirId = null, similar = false } = {}) {
  const key = canonicalTaskTitle(title);
  if (!key) return null;
  let best = null;
  let bestScore = 0;
  for (const t of Object.values(board.tasks)) {
    if (t.status === 'archived' || t.deleting) continue;
    const sameModule = !!moduleId && t.moduleId === moduleId;
    const sameDir = !!dirId && taskDirId(board, t) === dirId;
    if (!sameModule && !sameDir) continue;
    const score = taskTitleSimilarity(t.title, title);
    const threshold = similar ? 0.78 : 1;
    if (score < threshold) continue;
    // Prefer the requested module, then the closest title, then the freshest.
    const rank = score + (sameModule ? 2 : 0);
    const bestRank = bestScore + (best && moduleId && best.moduleId === moduleId ? 2 : 0);
    if (!best || rank > bestRank || (rank === bestRank && taskLastTs(t) > taskLastTs(best))) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

// Explicit, user-confirmed identity merge.  Sources become durable archived
// aliases instead of being deleted: their hidden bound sessions and SQLite
// task-run rows keep their original ownership, while read projections can
// follow the lineage from the surviving target.  The target's user-selected
// identity fields (id/title/module/routing/chatSession/worktree) always win.
function mergeTasks(board, {
  targetTaskId, sourceTaskIds, now = Date.now(),
} = {}) {
  const target = ownTask(board, targetTaskId);
  if (!target) return { ok: false, error: 'task_not_found', taskId: targetTaskId || null };
  if (target.mergedInto) return { ok: false, error: 'target_already_merged' };
  if (target.status === 'archived' || target.deleting) return { ok: false, error: 'target_not_mergeable' };

  const requested = [...new Set((Array.isArray(sourceTaskIds) ? sourceTaskIds : [])
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => id.trim()))];
  if (!requested.length || requested.length > 100) {
    return { ok: false, error: 'invalid_merge_request' };
  }

  const sources = [];
  const alreadyMerged = [];
  for (const id of requested) {
    if (id === target.id) return { ok: false, error: 'invalid_merge_request', taskId: id };
    const source = ownTask(board, id);
    if (!source) return { ok: false, error: 'task_not_found', taskId: id };
    if (source.mergedInto) {
      if (resolveTask(board, id)?.id === target.id) {
        alreadyMerged.push(id);
        continue;
      }
      return { ok: false, error: 'source_already_merged', taskId: id };
    }
    if (source.status === 'archived' || source.deleting) {
      return { ok: false, error: 'source_not_mergeable', taskId: id };
    }
    const targetOrigin = TASK_ORIGINS.has(target.origin) ? target.origin : legacyTaskOrigin(target.id);
    const sourceOrigin = TASK_ORIGINS.has(source.origin) ? source.origin : legacyTaskOrigin(source.id);
    if (sourceOrigin !== targetOrigin) {
      return { ok: false, error: 'task_origin_mismatch', taskId: id };
    }
    const targetDir = taskDirId(board, target);
    const sourceDir = taskDirId(board, source);
    if (targetDir && sourceDir && targetDir !== sourceDir) {
      return { ok: false, error: 'task_directory_mismatch', taskId: id };
    }
    sources.push(source);
  }
  if (!sources.length) {
    return {
      ok: true, changed: false, taskId: target.id,
      mergedTaskIds: [], alreadyMergedTaskIds: alreadyMerged,
      touched: [target.id, ...alreadyMerged],
    };
  }

  // Include aliases already owned by a source and flatten them directly onto
  // the new target.  This keeps lineage lookup and archive-time release simple.
  const sourceRoots = new Set(sources.map(task => task.id));
  const tombstones = Object.values(board.tasks).filter(task => {
    if (!task.mergedInto) return false;
    const resolved = resolveTask(board, task.id);
    return resolved && sourceRoots.has(resolved.id);
  });
  const mergedRecords = [...sources, ...tombstones];

  // Rebuild all durable refs chronologically through the canonical deduper.
  const allRefs = [target, ...sources]
    .flatMap(task => task.refs || [])
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const refAccumulator = { refs: [], status: 'active', updatedAt: 0 };
  // Do not apply the ordinary per-task cap while merging. A later duplicate
  // may upgrade an old ref's timestamp; trimming before that upgrade can evict
  // the now-new evidence merely because it still occupies an early array slot.
  for (const ref of allRefs) addRefToTask(refAccumulator, ref, now, Infinity);
  target.refs = refAccumulator.refs
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-MAX_REFS_PER_TASK);

  for (const source of sources) {
    for (const area of source.areas || []) {
      if (!target.areas.includes(area) && target.areas.length < MAX_AREAS_PER_TASK) {
        target.areas.push(area);
      }
    }
  }
  const lifecycle = [target, ...sources].map(task => task.status);
  target.status = lifecycle.every(status => status === 'done') ? 'done' : 'active';
  planning.alignStageWithStatus(target, target.status, now, board);
  const created = [target, ...sources].map(task => Number(task.createdAt) || 0).filter(Boolean);
  if (created.length) target.createdAt = Math.min(...created);
  target.updatedAt = now;

  for (const source of mergedRecords) {
    source.mergedInto = target.id;
    source.mergedAt = now;
    source.status = 'archived';
    source.updatedAt = now;
    // A hidden tombstone must never be picked up by the manual pending-task
    // batch again.  Its historical assignment receipt has no live meaning.
    if (source.moduleAssignment?.running !== true) delete source.moduleAssignment;
  }
  // Group membership is display metadata. If an explicitly merged identity was
  // present in a family, point that membership at the surviving id and collapse
  // any overlap; never copy the source task's identity or execution state.
  reconcileTaskGroups(board);

  return {
    ok: true, changed: true, taskId: target.id,
    mergedTaskIds: sources.map(task => task.id),
    alreadyMergedTaskIds: alreadyMerged,
    touched: [target.id, ...mergedRecords.map(task => task.id), ...alreadyMerged],
  };
}

// Create the durable card shown immediately after a board-level send. Identity
// is always taskId; the canonical text only supplies an immediate display title.
function createPendingTask(board, {
  taskId = null, dirId = null, sessionId, taskText = '', origin = null, now = Date.now(),
}) {
  if (!sessionId) return null;
  const id = typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(taskId)
    ? taskId : newId('tsk');
  if (board.tasks[id]) return board.tasks[id];
  if (board.deletedTaskIds?.includes(id)) return null;
  let mod = Object.values(board.modules).find(m =>
    m.source === 'classify' && m.name === CLASSIFY_PENDING_MODULE_NAME
      && (m.dirId || null) === (dirId || null));
  if (!mod) {
    mod = {
      id: newId('mod'), name: CLASSIFY_PENDING_MODULE_NAME, source: 'classify',
      dirId: dirId || null, createdAt: now, updatedAt: now,
    };
    board.modules[mod.id] = mod;
  }
  const task = {
    id, moduleId: mod.id, title: deriveTaskTitle(taskText),
    status: 'active', areas: [], createdAt: now, updatedAt: now,
    origin: TASK_ORIGINS.has(origin) ? origin : 'session',
    refs: [{
      sessionId, dirId: dirId || null, userMsgId: null, assistantMsgId: null,
      ts: now, excerpt: '',
    }],
    runState: 'running',
    moduleAssignment: {
      running: false, attempts: 0, lastAttemptAt: 0,
      lastError: '',
    },
  };
  planning.normalizePlanningTask(task, { origin: task.origin, dirId });
  if (task.recordType === 'planned') {
    task.description = String(taskText || '').trim().slice(0, 20_000);
    task.workflowStage = 'doing';
    task.rank = planning.rankAtEnd(board, 'doing', null, task.dirId);
  }
  board.tasks[task.id] = task;
  mod.updatedAt = now;
  return task;
}

function deleteEmptyModule(board, moduleId) {
  if (!moduleId || !board.modules[moduleId]) return;
  if (!Object.values(board.tasks).some(t => t.moduleId === moduleId)) delete board.modules[moduleId];
}

// Converge a placeholder/classify card in place. Identity merging is disabled
// by default and requires an explicit future user-confirmed allowIdentityMerge
// action; ordinary classification only changes module/title metadata.
function applyTaskClassification(board, pendingTaskId, entry, ref, now = Date.now(), options = {}) {
  const pending = board.tasks[pendingTaskId];
  if (!pending) return { ok: false, error: 'task_not_found' };
  const title = String(entry?.title || '').trim().slice(0, MAX_TITLE_LEN);
  const explicitCandidate = entry?.id && entry.id !== 'new' && entry.id !== pendingTaskId
    ? board.tasks[entry.id] : null;
  const explicitTarget = options.allowIdentityMerge === true
    && explicitCandidate && !explicitCandidate.moduleAssignment ? explicitCandidate : null;
  const classificationHint = explicitCandidate && !explicitCandidate.moduleAssignment
    ? explicitCandidate : null;
  const resolvedTitle = title || classificationHint?.title || '';
  const explicitModule = classificationHint?.moduleId ? board.modules[classificationHint.moduleId] : null;
  const moduleName = String(entry?.module || explicitModule?.name || '').trim().slice(0, MAX_MODULE_LEN);
  if ((!resolvedTitle && !explicitTarget) || !moduleName || moduleName === CLASSIFY_PENDING_MODULE_NAME) {
    return { ok: false, error: 'invalid_classification' };
  }

  const dirId = taskDirId(board, pending) || ref?.dirId || null;
  let mod = explicitModule || findModuleByName(board, moduleName, dirId);
  if (!mod || mod.source === 'classify') {
    mod = {
      id: newId('mod'), name: moduleName, source: 'ai', dirId,
      createdAt: now, updatedAt: now,
    };
    board.modules[mod.id] = mod;
  }

  // An explicit existing id is structured classification evidence. Title
  // similarity alone is never identity: it may be shown as a diagnostic hint,
  // but it cannot delete a canonical card or collapse two user admissions.
  const target = explicitTarget;

  const oldModuleId = pending.moduleId;
  if (target && target.id !== pendingTaskId) {
    for (const pendingRef of pending.refs) addRefToTask(target, pendingRef, now);
    if (ref) addRefToTask(target, ref, now);
    for (const area of entry?.areas || []) {
      const clean = typeof area === 'string' ? area.trim().slice(0, 80) : '';
      if (clean && !target.areas.includes(clean) && target.areas.length < MAX_AREAS_PER_TASK) target.areas.push(clean);
    }
    target.updatedAt = now;
    if (pending.routing && (!target.routing || pending.routing.routedAt >= target.routing.routedAt)) {
      target.routing = pending.routing;
    }
    if (target.status === 'done') {
      target.status = 'active';
      planning.alignStageWithStatus(target, 'active', now, board);
    }
    delete board.tasks[pendingTaskId];
    deleteEmptyModule(board, oldModuleId);
    return { ok: true, taskId: target.id, removedTaskId: pendingTaskId, touched: [target.id, pendingTaskId] };
  }

  pending.title = resolvedTitle || pending.title;
  pending.moduleId = mod.id;
  pending.updatedAt = now;
  for (const area of entry?.areas || []) {
    const clean = typeof area === 'string' ? area.trim().slice(0, 80) : '';
    if (clean && !pending.areas.includes(clean) && pending.areas.length < MAX_AREAS_PER_TASK) pending.areas.push(clean);
  }
  if (ref) addRefToTask(pending, ref, now);
  delete pending.moduleAssignment;
  mod.updatedAt = now;
  deleteEmptyModule(board, oldModuleId);
  return { ok: true, taskId: pending.id, removedTaskId: null, touched: [pending.id] };
}

// Apply a parsed tag result to the board. Returns the ids of tasks that
// changed (created or got a new ref / new areas). Mutates `board`.
function applyTagResult(board, entries, ref, now = Date.now(), options = {}) {
  const touched = new Set();
  for (const e of (entries || []).slice(0, MAX_TAGS_PER_TURN)) {
    let task = e.id && e.id !== 'new' ? board.tasks[e.id] : null;
    if (!task) {
      const modName = (e.module || '').trim() || (ref.dirLabel || '未分组');
      let mod = findModuleByName(board, modName, ref.dirId || null);
      task = options.legacyMergeByTitle === true
        ? findTaskByTitle(board, mod?.id || null, e.title, {
            dirId: ref.dirId || null,
            similar: false,
          })
        : null;
      const taskMod = task?.moduleId ? board.modules[task.moduleId] : null;
      const needsRealModule = task && taskMod?.source === 'classify'
        && options.moduleSource !== 'classify' && !!(e.module || '').trim();
      if (!mod && task && taskMod?.source === 'classify' && options.moduleSource === 'classify') {
        taskMod.name = modName.slice(0, MAX_MODULE_LEN);
        taskMod.updatedAt = now;
        mod = taskMod;
        touched.add(task.id);
      }
      if (!mod && (!task || needsRealModule)) {
        mod = {
          id: newId('mod'), name: modName.slice(0, MAX_MODULE_LEN),
          source: options.moduleSource === 'classify' ? 'classify' : 'ai',
          dirId: ref.dirId || null, createdAt: now, updatedAt: now,
        };
        board.modules[mod.id] = mod;
      }
      if (!task) {
        if (!e.title) continue;   // an unknown id with no title is unusable
        task = {
          id: options.newTaskId || newId('tsk'), moduleId: mod.id, title: e.title.slice(0, MAX_TITLE_LEN),
          status: 'active', areas: [], createdAt: now, updatedAt: now, refs: [],
          origin: 'session', recordType: 'observed',
        };
        board.tasks[task.id] = task;
        touched.add(task.id);
      } else if (mod && task.moduleId !== mod.id) {
        const oldMod = task.moduleId ? board.modules[task.moduleId] : null;
        // Classify cards first converge on one 待归类 module per directory;
        // the richer turn-end tag can then move that same card to its real module.
        if (oldMod?.source === 'classify'
          && (mod.source !== 'classify' || options.moduleSource === 'classify')) {
          task.moduleId = mod.id;
          touched.add(task.id);
          if (!Object.values(board.tasks).some(t => t.moduleId === oldMod.id)) delete board.modules[oldMod.id];
        }
      }
      if (mod) mod.updatedAt = now;
    }
    for (const a of e.areas || []) {
      if (!task.areas.includes(a) && task.areas.length < MAX_AREAS_PER_TASK) {
        task.areas.push(a);
        touched.add(task.id);
      }
    }
    if (addRefToTask(task, ref, now)) touched.add(task.id);
  }
  return [...touched];
}

module.exports = {
  buildTagSystemPrompt,
  buildTagUserPrompt,
  buildBackfillSystemPrompt,
  buildBackfillUserPrompt,
  parseTagResult,
  parseBackfillResult,
  applyTagResult,
  applyBackfillResult,
  findTaskByTitle,
  mergeTasks,
  createPendingTask,
  applyTaskClassification,
};

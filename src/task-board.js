'use strict';

const crypto = require('crypto');

// Task board core — pure logic for the AI-tagged module→task board shown in
// the fleet panel (meta.html). No I/O and no host state: given a board object
// and inputs, every function here is deterministic, so the whole tagging /
// aggregation / routing surface is unit-testable without a server.
//
// Board shape (persisted as plain JSON via atomicWriteJson):
//   {
//     modules: { <moduleId>: { id, name, source:'ai'|'directory'|'classify', dirId, createdAt, updatedAt } },
//     tasks:   { <taskId>:   { id, moduleId, title, status:'active'|'done'|'archived',
//                              areas:[], createdAt, updatedAt, moduleAssignment?:{},
//                              refs:[{ sessionId, dirId, userMsgId, assistantMsgId, ts, excerpt }] } }
//   }
// A ref is one chat turn (user message + assistant reply) tagged onto the task;
// the same turn may appear under several tasks (multi-label by design).

const MAX_TAGS_PER_TURN = 3;
const MAX_AREAS_PER_TASK = 8;
const MAX_REFS_PER_TASK = 500;
const MAX_TASKS_IN_PROMPT = 50;
const MAX_TITLE_LEN = 40;
const MAX_MODULE_LEN = 20;
const CLASSIFY_PENDING_MODULE_NAME = '待归类';
const PENDING_TASK_TITLE = '新任务';
// Runtime projection is deliberately separate from task.status lifecycle.
// `succeeded` says the latest turn succeeded; only explicit user action writes
// task.status = 'done'. Legacy runState done/completed is migrated below.
const TASK_RUN_STATES = new Set(['queued', 'running', 'waiting', 'succeeded', 'error', 'idle']);
const MAX_ROUTING_ATTEMPTS = 50;

// Where the card came from, so the board can tell the two admissions apart at
// a glance. 'board' = an explicit send from the task board / Commander (an
// independent task that owns a task-bound session); 'session' = the task
// surfaced inside an ongoing chat (classify, the retroactive backfill scan, or
// a router-tool dispatch landing in a live worker). Purely informational:
// nothing branches on it.
const TASK_ORIGINS = new Set(['board', 'session']);
const BOARD_TASK_SOURCES = new Set(['task-board', 'commander']);

function taskOriginForSource(source) {
  return BOARD_TASK_SOURCES.has(String(source || '')) ? 'board' : 'session';
}

// Cards persisted before the marker existed. The board send is the only path
// that mints a stableTaskId (sha256 digest), so its shape is an exact witness;
// every other generator (newId, the router's tsk-router-*, classify's tsk_*)
// means the card was born inside a session.
function legacyTaskOrigin(id) {
  return /^tsk-[0-9a-f]{32}$/.test(String(id || '')) ? 'board' : 'session';
}

function safeClassificationError(value) {
  const code = typeof value === 'string' ? value.slice(0, 80) : '';
  return !code || /^[a-z0-9_:-]+$/i.test(code) ? code : 'classification_failed';
}

function createEmptyBoard() {
  return { modules: {}, tasks: {} };
}

function normalizeModuleName(module) {
  const name = module.name.trim().slice(0, MAX_MODULE_LEN);
  const dirId = typeof module.dirId === 'string' ? module.dirId.trim() : '';
  const isLegacyDirName = module.source === 'classify'
    && dirId.length >= 12 && name.length >= 12 && dirId.startsWith(name);
  if (module.source === 'classify' && (name === '未分类' || isLegacyDirName)) {
    return CLASSIFY_PENDING_MODULE_NAME;
  }
  return name;
}

// Load-time validation: keep only well-formed entries so one corrupt record
// can't break every later board operation.
function normalizeBoard(raw) {
  const board = createEmptyBoard();
  if (!raw || typeof raw !== 'object') return board;
  const modules = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
  for (const [id, m] of Object.entries(modules)) {
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !m.name.trim()) continue;
    const source = ['directory', 'classify'].includes(m.source) ? m.source : 'ai';
    const dirId = typeof m.dirId === 'string' ? m.dirId : null;
    board.modules[id] = {
      id,
      name: normalizeModuleName({ ...m, source, dirId }),
      source,
      dirId,
      createdAt: Number(m.createdAt) || 0,
      updatedAt: Number(m.updatedAt) || 0,
    };
  }
  const tasks = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  for (const [id, t] of Object.entries(tasks)) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) continue;
    const task = {
      id,
      moduleId: typeof t.moduleId === 'string' ? t.moduleId : null,
      title: t.title.trim().slice(0, MAX_TITLE_LEN),
      status: ['active', 'done', 'archived'].includes(t.status) ? t.status : 'active',
      areas: Array.isArray(t.areas)
        ? t.areas.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim().slice(0, 80)).slice(0, MAX_AREAS_PER_TASK)
        : [],
      createdAt: Number(t.createdAt) || 0,
      updatedAt: Number(t.updatedAt) || 0,
      refs: Array.isArray(t.refs)
        ? t.refs.filter(r => r && typeof r === 'object' && typeof r.sessionId === 'string').map(r => ({
            sessionId: r.sessionId,
            dirId: typeof r.dirId === 'string' ? r.dirId : null,
            userMsgId: typeof r.userMsgId === 'string' ? r.userMsgId : null,
            assistantMsgId: typeof r.assistantMsgId === 'string' ? r.assistantMsgId : null,
            ts: Number(r.ts) || 0,
            excerpt: typeof r.excerpt === 'string' ? r.excerpt.slice(0, 200) : '',
          })).slice(-MAX_REFS_PER_TASK)
        : [],
    };
    // Origin marker. Absent on every card written before it existed, so fall
    // back to the id shape rather than guessing 'session' for old board sends.
    task.origin = TASK_ORIGINS.has(t.origin) ? t.origin : legacyTaskOrigin(id);
    const runState = ['done', 'completed'].includes(t.runState) ? 'succeeded' : t.runState;
    if (TASK_RUN_STATES.has(runState)) task.runState = runState;
    // Monotonic stamp of the queue event that produced runState. Survives a
    // reload so a heartbeat replayed after restart cannot un-cancel a card.
    if (Number(t.runStateAt) > 0) task.runStateAt = Number(t.runStateAt);
    // M3 per-task worktree ledger: where the task's work lives between runs.
    // Absent until the first run creates it; non-strings are dropped.
    if (typeof t.worktreePath === 'string' && t.worktreePath.trim()) {
      task.worktreePath = t.worktreePath.trim();
    }
    if (typeof t.branch === 'string' && t.branch.trim()) task.branch = t.branch.trim();
    // P1 task-bound hidden session: the 1:1 chat session this task owns. The
    // session record (taskBoundTaskId) is authoritative for hiding; this is
    // the reverse pointer so the task chat view can deep-link it. Absent
    // until the view first creates it; non-strings are dropped.
    if (typeof t.chatSessionId === 'string' && t.chatSessionId.trim()) {
      task.chatSessionId = t.chatSessionId.trim().slice(0, 160);
    }
    // `classification.state` was an older module-assignment retry state that
    // was easily confused with the session classify state (A/B/C/D/W/P).
    // Migrate it into non-status operation metadata. The module itself is the
    // source of truth for whether the card is still 「待归类」.
    const legacyAssignment = t.moduleAssignment && typeof t.moduleAssignment === 'object'
      ? t.moduleAssignment
      : t.classification && typeof t.classification === 'object' ? t.classification : null;
    const isPendingModule = board.modules[task.moduleId]?.source === 'classify';
    if (legacyAssignment || isPendingModule) {
      task.moduleAssignment = {
        running: legacyAssignment?.running === true || legacyAssignment?.state === 'running',
        attempts: Math.max(0, Math.floor(Number(legacyAssignment?.attempts) || 0)),
        lastAttemptAt: Number(legacyAssignment?.lastAttemptAt) || 0,
        lastError: safeClassificationError(legacyAssignment?.lastError),
      };
      if (typeof legacyAssignment?.seed === 'string' && legacyAssignment.seed) {
        task.moduleAssignment.seed = legacyAssignment.seed.slice(0, 1200);
      }
    }
    const routing = normalizeTaskRouting(t.routing);
    if (routing) task.routing = routing;
    board.tasks[id] = task;
  }
  return board;
}

// Persist only the small, public routing receipt needed by the task card.  In
// particular, never copy a session record or dispatch payload into the board:
// those may contain paths, prompts or provider credentials.
function normalizeTaskRouting(value) {
  if (!value || typeof value !== 'object') return null;
  const mode = value.mode === 'commander' ? 'commander'
    : value.mode === 'manual' ? 'manual'
      : value.mode === 'router-tool' ? 'router-tool' : null;
  const targetSessionId = typeof value.targetSessionId === 'string'
    ? value.targetSessionId.trim().slice(0, 200) : '';
  if (!mode || !targetSessionId) return null;
  const routing = {
    mode,
    targetSessionId,
    routedAt: Math.max(0, Number(value.routedAt) || 0),
  };
  const workerSessionId = typeof value.workerSessionId === 'string'
    ? value.workerSessionId.trim().slice(0, 200) : '';
  const operationId = typeof value.operationId === 'string'
    ? value.operationId.trim().slice(0, 200) : '';
  const status = typeof value.status === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value.status)
    ? value.status : '';
  if (workerSessionId) routing.workerSessionId = workerSessionId;
  if (operationId) routing.operationId = operationId;
  if (status) routing.status = status;
  if (value.oneWay === true) routing.oneWay = true;
  if (value.elasticWorkerCreated === true) routing.elasticWorkerCreated = true;
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  routing.attempts = attempts
    .filter(attempt => attempt && typeof attempt === 'object'
      && typeof attempt.operationId === 'string' && attempt.operationId.trim())
    .map(attempt => ({
      operationId: attempt.operationId.trim().slice(0, 200),
      workerSessionId: typeof attempt.workerSessionId === 'string'
        ? attempt.workerSessionId.trim().slice(0, 200) : '',
      status: typeof attempt.status === 'string' && /^[a-z0-9_-]{1,40}$/i.test(attempt.status)
        ? attempt.status : 'admitted',
      at: Math.max(0, Number(attempt.at) || 0),
    }))
    .slice(-MAX_ROUTING_ATTEMPTS);
  if (operationId && !routing.attempts.some(attempt => attempt.operationId === operationId)) {
    routing.attempts.push({
      operationId,
      workerSessionId,
      status: status || 'admitted',
      at: routing.routedAt,
    });
  }
  return routing;
}

function setTaskRouting(task, value) {
  const routing = normalizeTaskRouting(value);
  if (!task || !routing) return false;
  const previous = normalizeTaskRouting(task.routing);
  if (previous?.attempts?.length) {
    const attempts = new Map(previous.attempts.map(attempt => [attempt.operationId, attempt]));
    for (const attempt of routing.attempts || []) attempts.set(attempt.operationId, attempt);
    routing.attempts = [...attempts.values()]
      .sort((a, b) => a.at - b.at || a.operationId.localeCompare(b.operationId))
      .slice(-MAX_ROUTING_ATTEMPTS);
  }
  task.routing = routing;
  task.updatedAt = Math.max(task.updatedAt || 0, routing.routedAt || Date.now());
  return true;
}

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

// ── Aggregation ─────────────────────────────────────────────────────────────

function normalizeName(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// Task titles are short, so exact strings are too brittle ("删除 [tiktok] …"
// vs "清理 tiktok …") while unconstrained fuzzy matching is too risky. Keep
// the action intent as a canonical family, remove connective noise, then use a
// deliberately high similarity threshold. Opposite actions such as 删除/恢复
// remain different because only words in the same family collapse together.
const TASK_ACTION_FAMILIES = [
  ['建设', ['实现', '设计', '开发', '构建', '新增', '添加', '接入', '集成', '支持']],
  ['修复', ['修复', '解决', '排查', '诊断']],
  ['优化', ['优化', '完善', '改进', '重构', '升级', '更新', '改造', '切换']],
  ['删除', ['删除', '清理', '移除', '废弃']],
  ['恢复', ['恢复', '还原', '保留']],
  ['启用', ['启用', '开启']],
  ['停用', ['停用', '关闭', '禁用']],
  ['验证', ['验证', '测试', '审计', '检查']],
  ['研究', ['研究', '分析', '调研']],
];

function canonicalTaskTitle(title) {
  let key = normalizeName(title).replace(/[的和与及]/g, '');
  for (const [family, words] of TASK_ACTION_FAMILIES) {
    const word = words.find(w => key.startsWith(w));
    if (word) {
      key = family + key.slice(word.length);
      break;
    }
  }
  return key;
}

function bigramDice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      out.set(gram, (out.get(gram) || 0) + 1);
    }
    return out;
  };
  const aa = counts(a);
  const bb = counts(b);
  let overlap = 0;
  for (const [gram, count] of aa) overlap += Math.min(count, bb.get(gram) || 0);
  return (2 * overlap) / ((a.length - 1) + (b.length - 1));
}

function taskTitleSimilarity(a, b) {
  const aa = canonicalTaskTitle(a);
  const bb = canonicalTaskTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const actionOf = key => TASK_ACTION_FAMILIES.find(([family]) => key.startsWith(family))?.[0] || null;
  const actionA = actionOf(aa);
  const actionB = actionOf(bb);
  if (actionA && actionB && actionA !== actionB) return 0;
  const shorter = aa.length <= bb.length ? aa : bb;
  const longer = aa.length > bb.length ? aa : bb;
  if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) {
    return shorter.length / longer.length;
  }
  return bigramDice(aa, bb);
}

function findModuleByName(board, name, dirId = null) {
  const key = normalizeName(name);
  if (!key) return null;
  for (const m of Object.values(board.modules)) {
    if (dirId && m.dirId && m.dirId !== dirId) continue;
    if (normalizeName(m.name) === key) return m;
  }
  return null;
}

function taskDirId(board, task) {
  const modDir = task.moduleId ? board.modules[task.moduleId]?.dirId : null;
  if (modDir) return modDir;
  return task.refs.find(r => r.dirId)?.dirId || null;
}

function findTaskByTitle(board, moduleId, title, { dirId = null, similar = false } = {}) {
  const key = canonicalTaskTitle(title);
  if (!key) return null;
  let best = null;
  let bestScore = 0;
  for (const t of Object.values(board.tasks)) {
    if (t.status === 'archived') continue;
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

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function taskLastTs(task) {
  const last = task.refs.length ? task.refs[task.refs.length - 1].ts : 0;
  return Math.max(last || 0, task.updatedAt || 0, task.createdAt || 0);
}

// Titles are display summaries, never task identity. Derive a useful initial
// title from the canonical task-start message so cards do not pile up as
// indistinguishable "新任务" placeholders while module classification remains
// explicitly pending. No derived title participates in task merging.
function deriveTaskTitle(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  let declared = '';
  for (const raw of lines) {
    const taskHeader = raw.trim().match(/^【任务[：:]\s*([^】|｜]+)(?:[|｜][^】]*)?】$/u);
    if (!taskHeader) continue;
    const candidate = taskHeader[1].trim();
    if (candidate && candidate !== PENDING_TASK_TITLE) declared = candidate;
  }
  if (declared) return declared.slice(0, MAX_TITLE_LEN);
  for (const raw of lines) {
    const line = raw.trim()
      .replace(/^(?:#{1,6}|[-*+]|\d+[.)]|>)\s*/u, '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, '')
      .trim();
    if (!line || /^【[^】]+】$/u.test(line)) continue;
    if (/^(?:这是宿主路由器|请在当前 worker 会话|结果保留在当前 worker|不会自动回灌 Commander)/u.test(line)) continue;
    if (/^(?:任务|新任务)\s*[:：]?\s*$/u.test(line)) continue;
    return line.slice(0, MAX_TITLE_LEN);
  }
  return PENDING_TASK_TITLE;
}

// Attach one turn ref to a task; dedup on either message id so an in-flight
// user-only ref can be enriched with its final assistant message in place.
function addRefToTask(task, ref, now) {
  const existing = task.refs.find(r =>
    (ref.assistantMsgId && r.assistantMsgId === ref.assistantMsgId) ||
    (ref.userMsgId && r.userMsgId === ref.userMsgId) ||
    (ref.userMsgId && !r.userMsgId && !r.assistantMsgId && r.sessionId === ref.sessionId));
  if (existing) {
    let changed = false;
    // An immediate in-flight card initially has only the user id. Upgrade that
    // same ref at turn end instead of adding a duplicate row.
    if (!existing.assistantMsgId && ref.assistantMsgId) {
      existing.assistantMsgId = ref.assistantMsgId;
      changed = true;
    }
    if (!existing.userMsgId && ref.userMsgId) {
      existing.userMsgId = ref.userMsgId;
      changed = true;
    }
    if (!existing.dirId && ref.dirId) { existing.dirId = ref.dirId; changed = true; }
    if (ref.ts && ref.ts > (existing.ts || 0)) { existing.ts = ref.ts; changed = true; }
    if (ref.excerpt && ref.excerpt !== existing.excerpt) {
      existing.excerpt = String(ref.excerpt).slice(0, 200);
      changed = true;
    }
    if (changed) task.updatedAt = now;
    if (task.status === 'done') { task.status = 'active'; changed = true; }
    return changed;
  }
  task.refs.push({
    sessionId: ref.sessionId,
    dirId: ref.dirId || null,
    userMsgId: ref.userMsgId || null,
    assistantMsgId: ref.assistantMsgId || null,
    ts: ref.ts || now,
    excerpt: String(ref.excerpt || '').slice(0, 200),
  });
  if (task.refs.length > MAX_REFS_PER_TASK) task.refs.splice(0, task.refs.length - MAX_REFS_PER_TASK);
  task.updatedAt = now;
  // A done task that receives new conversation is live again.
  if (task.status === 'done') task.status = 'active';
  return true;
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
    if (target.status === 'done') target.status = 'active';
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
          origin: 'session',
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

// ── Panel-input routing ─────────────────────────────────────────────────────
// The task panel's composer is not attached to any session. Automatic routing
// resolves the directory's typed Commander below. These semantic worker
// ranking helpers remain for explicit/manual routing and Commander-side use.

function isRoutableRecord(rec) {
  return !!rec && rec.kind === 'chat' && rec.type !== 'aux' && rec.type !== 'gateway' && rec.type !== 'commander' && !rec.ephemeral;
}

// Automatic task-board routing has one authority boundary: the typed
// commander owned by the same directory.  Runtime label guessing is
// deliberately forbidden.  Older installations are migrated once at boot by
// server.js (exact legacy labels -> type='commander'); if migration cannot
// establish a single typed record, routing fails closed here.
function resolveDirectoryCommander(records, dirId) {
  const directoryId = typeof dirId === 'string' ? dirId.trim() : '';
  if (!directoryId) return { ok: false, code: 'directory_required' };
  const matches = [];
  for (const [sessionId, rec] of records || []) {
    if (!rec || rec.kind !== 'chat' || rec.type !== 'commander' || rec.ephemeral) continue;
    if (rec.dirId !== directoryId) continue;
    matches.push({ sessionId, record: rec });
  }
  matches.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
  if (!matches.length) return { ok: false, code: 'commander_not_found' };
  if (matches.length > 1) return { ok: false, code: 'commander_ambiguous' };
  return { ok: true, ...matches[0] };
}

function recordActivityMs(rec) {
  const v = rec && (rec.lastActivity || rec.createdAt);
  const ms = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(ms) ? ms : 0;
}

const ROUTING_STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'task', 'session',
  '任务', '会话', '功能', '项目', '代码', '处理', '相关', '进行', '支持', '实现', '修复', '优化',
]);

// Conservative terms only: task metadata and a whitelisted session profile.
// Han bigrams let a short role such as "前端" match a longer task title.
function routingTerms(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase().slice(0, 1200);
  const out = new Set();
  const chunks = text.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || [];
  for (const chunk of chunks) {
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2 && !ROUTING_STOP_TERMS.has(chunk)) out.add(chunk);
      continue;
    }
    if (chunk.length >= 2 && chunk.length <= 16 && !ROUTING_STOP_TERMS.has(chunk)) out.add(chunk);
    for (let i = 0; i < chunk.length - 1; i++) {
      const gram = chunk.slice(i, i + 2);
      if (!ROUTING_STOP_TERMS.has(gram)) out.add(gram);
    }
  }
  return out;
}

function addWeightedTerms(target, value, weight) {
  for (const term of routingTerms(value)) target.set(term, (target.get(term) || 0) + weight);
}

function buildRoutingContext({ board = null, task = null, queryText = '' } = {}) {
  const terms = new Map();
  addWeightedTerms(terms, queryText, 7);
  if (task) {
    addWeightedTerms(terms, task.title, 6);
    for (const area of Array.isArray(task.areas) ? task.areas : []) addWeightedTerms(terms, area, 7);
    const mod = task.moduleId && board?.modules ? board.modules[task.moduleId] : null;
    if (mod) addWeightedTerms(terms, mod.name, 5);
  }
  return terms;
}

function buildSessionRoutingProfile(rec) {
  const terms = new Map();
  if (!rec || typeof rec !== 'object') return terms;
  addWeightedTerms(terms, rec.label, 7);
  addWeightedTerms(terms, rec.rolePrompt, 5);
  if (typeof rec.agent === 'string') addWeightedTerms(terms, rec.agent, 6);
  else if (rec.agent && typeof rec.agent === 'object') {
    // Never stringify the full agent/provider object: it may gain credentials.
    for (const key of ['name', 'label', 'role', 'description']) addWeightedTerms(terms, rec.agent[key], 6);
  }
  const state = rec.taskState && typeof rec.taskState === 'object' ? rec.taskState : null;
  if (state) {
    addWeightedTerms(terms, state.goal, 5);
    addWeightedTerms(terms, state.summary, 3);
    addWeightedTerms(terms, state.lastSummary, 3);
  }
  return terms;
}

function routingRelevanceScore(contextTerms, rec) {
  const profile = buildSessionRoutingProfile(rec);
  let score = 0;
  for (const [term, contextWeight] of contextTerms || []) {
    const profileWeight = profile.get(term);
    if (profileWeight) score += contextWeight * profileWeight;
  }
  return score;
}

function recordAppearsAvailable(rec, sid, options = {}) {
  try {
    if (typeof options.isAvailable === 'function') return !!options.isAvailable(sid, rec);
  } catch (_) {
    return false;
  }
  if (!rec || rec.active === true || rec.busy === true) return false;
  const state = String(rec.runState || rec.status || rec.taskState?.runState || '').toLowerCase();
  if (['active', 'busy', 'running', 'thinking', 'editing', 'working', 'starting'].includes(state)) return false;
  return !['A', 'P'].includes(rec.taskState?.classifyState);
}

function rankRoutingCandidates(records, {
  dirId = null,
  contextTerms = new Map(),
  affinitySessionIds = new Set(),
  options = {},
} = {}) {
  const ranked = [];
  for (const [sid, rec] of records || []) {
    if (!isRoutableRecord(rec) || !recordAppearsAvailable(rec, sid, options)) continue;
    if (dirId && rec.dirId !== dirId) continue;
    const score = routingRelevanceScore(contextTerms, rec) + (affinitySessionIds.has(sid) ? 24 : 0);
    if (score <= 0) continue;
    ranked.push({ sid, score, activity: recordActivityMs(rec) });
  }
  ranked.sort((a, b) => b.score - a.score
    || b.activity - a.activity
    || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  return ranked;
}

function explicitRoutingTarget(records, explicitTarget, options) {
  if (!explicitTarget) return null;
  const rec = records.get(explicitTarget);
  return isRoutableRecord(rec) && recordAppearsAvailable(rec, explicitTarget, options)
    ? explicitTarget : null;
}

function pickDirTarget(records, dirId, explicitTarget, options = {}) {
  if (explicitTarget) return explicitRoutingTarget(records, explicitTarget, options);
  const ranked = rankRoutingCandidates(records, {
    dirId,
    contextTerms: buildRoutingContext({ queryText: options.queryText }),
    options,
  });
  return ranked[0]?.sid || null;
}

function pickRouteTarget(board, task, records, explicitTarget, options = {}) {
  if (explicitTarget) return explicitRoutingTarget(records, explicitTarget, options);
  const affinitySessionIds = new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean));
  const ranked = rankRoutingCandidates(records, {
    dirId: taskDirId(board, task),
    contextTerms: buildRoutingContext({ board, task, queryText: options.queryText }),
    affinitySessionIds,
    options,
  });
  return ranked[0]?.sid || null;
}

// taskId is transport metadata, never user-visible prompt text. Keeping the
// prompt free of identity markers avoids a second parser/source of truth.
function buildRoutedMessage(task, text) {
  return `【任务：${task.title}】\n${text}`;
}

function buildCommanderRoutedMessage(task, text) {
  const routed = buildRoutedMessage(task, text);
  return [
    '【Commander 单向路由任务】',
    '这是宿主路由器直接投递的执行任务。请在当前 worker 会话完成，不要再次分发。',
    '结果保留在当前 worker 与任务卡中，不会自动回灌 Commander。',
    '',
    routed,
  ].join('\n');
}

function extractTaskMarker(text) {
  const m = /｜tb:([A-Za-z0-9_-]+)】/.exec(String(text || ''));
  return m ? m[1] : null;
}

// ── DTO / message helpers ───────────────────────────────────────────────────

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// Aggregate turn run-state from a task's sessions: running > waiting > error > idle;
// succeeded only when all sessions succeeded. This never mutates task.status.
function aggregateTaskRunState(sessionIds, getSessionRunState) {
  if (!getSessionRunState || !sessionIds.length) return 'idle';
  const states = sessionIds.map(sid => getSessionRunState(sid)).filter(Boolean)
    .map(state => ['done', 'completed'].includes(state) ? 'succeeded' : state);
  if (!states.length) return 'idle';
  if (states.some(s => s === 'running')) return 'running';
  if (states.some(s => s === 'queued')) return 'queued';
  if (states.some(s => s === 'waiting')) return 'waiting';
  if (states.some(s => s === 'error')) return 'error';
  if (states.every(s => s === 'succeeded')) return 'succeeded';
  return 'idle';
}

function buildBoardDto(board, getSessionRunState) {
  const tasks = Object.values(board.tasks).map(t => {
    const sessionIds = [...new Set(t.refs.map(r => r.sessionId))];
    const routing = normalizeTaskRouting(t.routing);
    // A Commander one-way route is executed by the admitted worker. Commander
    // is only the router and must not make a running worker appear "waiting".
    const runSessionIds = routing?.oneWay && routing.workerSessionId
      ? [routing.workerSessionId]
      : sessionIds;
    return {
      id: t.id,
      moduleId: t.moduleId,
      title: t.title,
      status: t.status,
      areas: t.areas,
      refCount: t.refs.length,
      sessionIds,
      dirIds: [...new Set(t.refs.map(r => r.dirId).filter(Boolean))],
      lastTs: taskLastTs(t),
      createdAt: t.createdAt,
      origin: TASK_ORIGINS.has(t.origin) ? t.origin : legacyTaskOrigin(t.id),
      runState: TASK_RUN_STATES.has(t.runState)
        ? t.runState
        : aggregateTaskRunState(runSessionIds, getSessionRunState),
      moduleAssignment: t.moduleAssignment ? {
        running: t.moduleAssignment.running === true,
        attempts: t.moduleAssignment.attempts || 0,
        lastAttemptAt: t.moduleAssignment.lastAttemptAt || 0,
        lastError: safeClassificationError(t.moduleAssignment.lastError),
      } : null,
      routing,
      attemptCount: routing?.attempts?.length || 0,
      // M3 ledger surfaced so detail views can offer diff/merge/cleanup
      // without a second fetch; absent until the first run creates it.
      worktreePath: typeof t.worktreePath === 'string' ? t.worktreePath : null,
      branch: typeof t.branch === 'string' ? t.branch : null,
      // P1 reverse pointer to the task-bound hidden chat session (the session
      // record's taskBoundTaskId is the authoritative hiding marker). The task
      // chat view deep-links this through ordinary session APIs.
      chatSessionId: typeof t.chatSessionId === 'string' ? t.chatSessionId : null,
    };
  }).sort((a, b) => b.lastTs - a.lastTs);
  const countByModule = new Map();
  const lastByModule = new Map();
  for (const t of tasks) {
    countByModule.set(t.moduleId, (countByModule.get(t.moduleId) || 0) + 1);
    lastByModule.set(t.moduleId, Math.max(lastByModule.get(t.moduleId) || 0, t.lastTs));
  }
  const modules = Object.values(board.modules).map(m => ({
    id: m.id,
    name: m.name,
    source: m.source,
    dirId: m.dirId,
    taskCount: countByModule.get(m.id) || 0,
    lastTs: lastByModule.get(m.id) || m.updatedAt || 0,
  })).sort((a, b) => b.lastTs - a.lastTs);
  return { modules, tasks };
}

module.exports = {
  MAX_TAGS_PER_TURN,
  MAX_REFS_PER_TASK,
  CLASSIFY_PENDING_MODULE_NAME,
  PENDING_TASK_TITLE,
  TASK_ORIGINS,
  taskOriginForSource,
  legacyTaskOrigin,
  deriveTaskTitle,
  createEmptyBoard,
  normalizeBoard,
  buildTagSystemPrompt,
  buildTagUserPrompt,
  buildBackfillSystemPrompt,
  buildBackfillUserPrompt,
  parseTagResult,
  parseBackfillResult,
  applyTagResult,
  applyBackfillResult,
  addRefToTask,
  createPendingTask,
  applyTaskClassification,
  canonicalTaskTitle,
  taskTitleSimilarity,
  findModuleByName,
  findTaskByTitle,
  taskLastTs,
  taskDirId,
  pickRouteTarget,
  pickDirTarget,
  resolveDirectoryCommander,
  isRoutableRecord,
  routingTerms,
  buildRoutingContext,
  buildSessionRoutingProfile,
  routingRelevanceScore,
  recordAppearsAvailable,
  rankRoutingCandidates,
  buildRoutedMessage,
  buildCommanderRoutedMessage,
  extractTaskMarker,
  messageText,
  buildBoardDto,
  normalizeTaskRouting,
  setTaskRouting,
};

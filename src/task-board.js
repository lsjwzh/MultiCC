'use strict';

// Task board core — pure logic for the AI-tagged module→task board shown in
// the fleet panel (meta.html). No I/O and no host state: given a board object
// and inputs, every function here is deterministic, so the whole tagging /
// aggregation / routing surface is unit-testable without a server.
//
// Board shape (persisted as plain JSON via atomicWriteJson):
//   {
//     modules: { <moduleId>: { id, name, source:'ai'|'directory'|'classify', dirId, createdAt, updatedAt } },
//     tasks:   { <taskId>:   { id, moduleId, title, status:'active'|'done'|'archived',
//                              areas:[], createdAt, updatedAt,
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

function createEmptyBoard() {
  return { modules: {}, tasks: {} };
}

// Load-time validation: keep only well-formed entries so one corrupt record
// can't break every later board operation.
function normalizeBoard(raw) {
  const board = createEmptyBoard();
  if (!raw || typeof raw !== 'object') return board;
  const modules = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
  for (const [id, m] of Object.entries(modules)) {
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !m.name.trim()) continue;
    board.modules[id] = {
      id,
      name: m.name.trim().slice(0, MAX_MODULE_LEN),
      source: ['directory', 'classify'].includes(m.source) ? m.source : 'ai',
      dirId: typeof m.dirId === 'string' ? m.dirId : null,
      createdAt: Number(m.createdAt) || 0,
      updatedAt: Number(m.updatedAt) || 0,
    };
  }
  const tasks = raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  for (const [id, t] of Object.entries(tasks)) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || !t.title.trim()) continue;
    board.tasks[id] = {
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
  }
  return board;
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
    .filter(t => t.status !== 'archived')
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
    .filter(t => t.status !== 'archived')
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
// Reuses applyTagResult per turn — title/module normalization dedups the task
// across turns, addRefToTask dedups refs across repeated backfills.
function applyBackfillResult(board, entries, refByTurn, now = Date.now()) {
  const touched = new Set();
  for (const e of entries || []) {
    for (const n of e.turns || []) {
      const ref = refByTurn.get(n);
      if (!ref) continue;
      for (const id of applyTagResult(board, [e], ref, now)) touched.add(id);
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

// Attach one turn ref to a task; dedup on either message id so an in-flight
// user-only ref can be enriched with its final assistant message in place.
function addRefToTask(task, ref, now) {
  const existing = task.refs.find(r =>
    (ref.assistantMsgId && r.assistantMsgId === ref.assistantMsgId) ||
    (ref.userMsgId && r.userMsgId === ref.userMsgId));
  if (existing) {
    let changed = false;
    // An immediate in-flight card initially has only the user id. Upgrade that
    // same ref at turn end instead of adding a duplicate row.
    if (!existing.assistantMsgId && ref.assistantMsgId) {
      existing.assistantMsgId = ref.assistantMsgId;
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

// Apply a parsed tag result to the board. Returns the ids of tasks that
// changed (created or got a new ref / new areas). Mutates `board`.
function applyTagResult(board, entries, ref, now = Date.now(), options = {}) {
  const touched = new Set();
  for (const e of (entries || []).slice(0, MAX_TAGS_PER_TURN)) {
    let task = e.id && e.id !== 'new' ? board.tasks[e.id] : null;
    if (!task) {
      const modName = (e.module || '').trim() || (ref.dirLabel || '未分组');
      let mod = findModuleByName(board, modName, ref.dirId || null);
      task = findTaskByTitle(board, mod?.id || null, e.title, {
        dirId: ref.dirId || null,
        similar: options.mergeSimilar !== false,
      });
      const taskMod = task?.moduleId ? board.modules[task.moduleId] : null;
      const needsRealModule = task && taskMod?.source === 'classify'
        && options.moduleSource !== 'classify' && !!(e.module || '').trim();
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
          id: newId('tsk'), moduleId: mod.id, title: e.title.slice(0, MAX_TITLE_LEN),
          status: 'active', areas: [], createdAt: now, updatedAt: now, refs: [],
        };
        board.tasks[task.id] = task;
        touched.add(task.id);
      } else if (mod && task.moduleId !== mod.id) {
        const oldMod = task.moduleId ? board.modules[task.moduleId] : null;
        // The immediate classifier can only put a card in 待归类. Once the
        // richer turn-end tag arrives, move that same card into its real module.
        if (oldMod?.source === 'classify' && mod.source !== 'classify') {
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
// The task panel's composer is not attached to any session; the backend picks
// a target for it: explicit override → most recent session that worked on the
// task → any chat session in the task's module directory.

function isRoutableRecord(rec) {
  return !!rec && rec.kind === 'chat' && rec.type !== 'aux' && rec.type !== 'gateway' && !rec.ephemeral;
}

// Directory-level routing for the board composer (no task context): explicit
// override → most recently active routable chat session in the directory.
function recordActivityMs(rec) {
  const v = rec && (rec.lastActivity || rec.createdAt);
  const ms = typeof v === 'number' ? v : Date.parse(v || '');
  return Number.isFinite(ms) ? ms : 0;
}

function pickDirTarget(records, dirId, explicitTarget) {
  if (explicitTarget && isRoutableRecord(records.get(explicitTarget))) return explicitTarget;
  let best = null;
  let bestMs = -1;
  for (const [sid, rec] of records) {
    if (!isRoutableRecord(rec)) continue;
    if (dirId && rec.dirId !== dirId) continue;
    const ms = recordActivityMs(rec);
    if (ms > bestMs) { bestMs = ms; best = sid; }
  }
  return best;
}

function pickRouteTarget(board, task, records, explicitTarget) {
  if (explicitTarget && isRoutableRecord(records.get(explicitTarget))) return explicitTarget;
  const seen = new Set();
  for (let i = task.refs.length - 1; i >= 0; i--) {
    const sid = task.refs[i].sessionId;
    if (seen.has(sid)) continue;
    seen.add(sid);
    if (isRoutableRecord(records.get(sid))) return sid;
  }
  const mod = task.moduleId ? board.modules[task.moduleId] : null;
  for (const [sid, rec] of records) {
    if (!isRoutableRecord(rec)) continue;
    if (mod && mod.dirId && rec.dirId !== mod.dirId) continue;
    return sid;
  }
  return null;
}

// Routed messages carry a marker so the turn-end tagger can deterministically
// attach the resulting turn back to this task (no AI round-trip needed).
function buildRoutedMessage(task, text) {
  return `【任务：${task.title}｜tb:${task.id}】\n${text}`;
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

// Aggregate classify run-state from a task's sessions: running > waiting > error > idle;
// done only when all sessions are done. getSessionRunState(sid) → 'running'|'waiting'|'done'|'error'|'idle'|null.
function aggregateTaskRunState(sessionIds, getSessionRunState) {
  if (!getSessionRunState || !sessionIds.length) return 'idle';
  const states = sessionIds.map(sid => getSessionRunState(sid)).filter(Boolean);
  if (!states.length) return 'idle';
  if (states.some(s => s === 'running')) return 'running';
  if (states.some(s => s === 'waiting')) return 'waiting';
  if (states.some(s => s === 'error')) return 'error';
  if (states.every(s => s === 'done')) return 'done';
  return 'idle';
}

function buildBoardDto(board, getSessionRunState) {
  const tasks = Object.values(board.tasks).map(t => {
    const sessionIds = [...new Set(t.refs.map(r => r.sessionId))];
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
      runState: aggregateTaskRunState(sessionIds, getSessionRunState),
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
  canonicalTaskTitle,
  taskTitleSimilarity,
  findModuleByName,
  findTaskByTitle,
  taskLastTs,
  pickRouteTarget,
  pickDirTarget,
  isRoutableRecord,
  buildRoutedMessage,
  extractTaskMarker,
  messageText,
  buildBoardDto,
};

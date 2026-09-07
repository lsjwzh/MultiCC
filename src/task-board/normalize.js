'use strict';

const crypto = require('crypto');
const planning = require('./planning');
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
//                              refs:[{ sessionId, dirId, userMsgId, assistantMsgId, ts, excerpt }] } },
//     taskGroups: { <groupId>: { id, rootTaskId, taskIds:[], createdAt, updatedAt } }
//   }
// A ref is one chat turn (user message + assistant reply) tagged onto the task;
// the same turn may appear under several tasks (multi-label by design).
// A task group is presentation-only: every member keeps its own taskId, runs,
// short code and lifecycle. It must never be interpreted as an identity merge.

const MAX_TAGS_PER_TURN = 3;
const MAX_AREAS_PER_TASK = 8;
// References are durable ownership, not a display window. Never age them out.
const MAX_REFS_PER_TASK = Infinity;
const MAX_TASKS_IN_PROMPT = 50;
const MAX_TITLE_LEN = 40;
const MAX_MODULE_LEN = 20;
const MAX_TASKS_PER_GROUP = 100;
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
// a router-tool dispatch landing in a live worker). The UI uses this durable
// distinction for source filtering and for independent-task-only activity
// aggregation; it must not be inferred from recordType or chatSessionId.
const TASK_ORIGINS = new Set(['board', 'session']);
const BOARD_TASK_SOURCES = new Set(['task-board', 'commander', 'task-shell']);

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
  return {
    schemaVersion: planning.TASK_BOARD_SCHEMA_VERSION,
    revision: 0,
    modules: {},
    tasks: {},
    taskGroups: {},
  };
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
  board.revision = Number.isSafeInteger(Number(raw.revision)) && Number(raw.revision) >= 0
    ? Number(raw.revision) : 0;
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
    for (const key of [
      'recordType', 'dirId', 'description', 'workflowStage', 'rank',
      'priority', 'dueAt', 'acceptanceCriteria', 'planningRevision',
    ]) {
      if (Object.prototype.hasOwnProperty.call(t, key)) task[key] = t[key];
    }
    planning.normalizePlanningTask(task, {
      origin: task.origin,
      dirId: typeof t.dirId === 'string' && t.dirId.trim()
        ? t.dirId.trim()
        : board.modules[task.moduleId]?.dirId
          || task.refs.find(ref => ref.dirId)?.dirId
          || null,
    });
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
    // Explicit user-confirmed task merge tombstone.  The source record stays
    // durable (and hidden through its archived status) so its task-run ledger
    // and task-bound session remain readable from the surviving task.  This is
    // intentionally an alias, not a title-based identity guess.
    if (typeof t.mergedInto === 'string' && t.mergedInto.trim()
        && t.mergedInto.trim() !== id) {
      task.mergedInto = t.mergedInto.trim().slice(0, 128);
      task.mergedAt = Math.max(0, Number(t.mergedAt) || 0);
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
  // A corrupt/dangling merge pointer must never make a live task disappear.
  // Drop aliases that do not resolve to another task or that form a cycle.
  for (const task of Object.values(board.tasks)) {
    if (!task.mergedInto) continue;
    const seen = new Set([task.id]);
    let cursor = task;
    let valid = true;
    while (cursor.mergedInto) {
      if (seen.has(cursor.mergedInto)
          || !Object.prototype.hasOwnProperty.call(board.tasks, cursor.mergedInto)) {
        valid = false;
        break;
      }
      seen.add(cursor.mergedInto);
      cursor = board.tasks[cursor.mergedInto];
    }
    if (!valid) {
      delete task.mergedInto;
      delete task.mergedAt;
    } else {
      task.status = 'archived';
    }
  }
  const taskGroups = raw.taskGroups && typeof raw.taskGroups === 'object'
    ? raw.taskGroups : {};
  for (const [id, value] of Object.entries(taskGroups)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !value || typeof value !== 'object') continue;
    const taskIds = [...new Set((Array.isArray(value.taskIds) ? value.taskIds : [])
      .filter(taskId => typeof taskId === 'string' && taskId.trim())
      .map(taskId => taskId.trim().slice(0, 128)))]
      .slice(0, MAX_TASKS_PER_GROUP);
    board.taskGroups[id] = {
      id,
      rootTaskId: typeof value.rootTaskId === 'string'
        ? value.rootTaskId.trim().slice(0, 128) : '',
      taskIds,
      createdAt: Math.max(0, Number(value.createdAt) || 0),
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    };
  }
  reconcileTaskGroups(board);
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
  if (typeof task.dirId === 'string' && task.dirId.trim()) return task.dirId.trim();
  const modDir = task.moduleId ? board.modules[task.moduleId]?.dirId : null;
  if (modDir) return modDir;
  return (task.refs || []).find(r => r.dirId)?.dirId || null;
}

function ownTask(board, taskId) {
  const tasks = board?.tasks;
  return tasks && Object.prototype.hasOwnProperty.call(tasks, taskId)
    ? tasks[taskId] : null;
}

// Resolve an old task id through explicit merge tombstones.  Returning null on
// a corrupt cycle is fail-closed: callers must not accidentally resurrect or
// mutate an arbitrary member of a broken alias chain.
function resolveTask(board, taskId) {
  let task = ownTask(board, taskId);
  const seen = new Set();
  while (task?.mergedInto) {
    if (seen.has(task.id)) return null;
    seen.add(task.id);
    task = ownTask(board, task.mergedInto);
  }
  return task;
}

function taskLineageIds(board, taskId) {
  const target = resolveTask(board, taskId);
  if (!target) return [];
  const ids = [target.id];
  for (const task of Object.values(board.tasks || {})) {
    if (task.id === target.id || !task.mergedInto) continue;
    if (resolveTask(board, task.id)?.id === target.id) ids.push(task.id);
  }
  return ids;
}

// Keep presentation groups well-formed without attaching group identity to a
// task record. Canonicalising explicit merge tombstones here is only cleanup of
// a user-requested identity merge; creating a group never merges task ids.
function reconcileTaskGroups(board) {
  if (!board || typeof board !== 'object') return {};
  if (!board.taskGroups || typeof board.taskGroups !== 'object') board.taskGroups = {};
  const ordered = Object.values(board.taskGroups)
    .filter(group => group && typeof group === 'object'
      && /^[A-Za-z0-9_-]{1,128}$/.test(String(group.id || '')))
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
  const clean = {};
  const ownerByTaskId = new Map();
  for (const raw of ordered) {
    const ids = [];
    for (const value of Array.isArray(raw.taskIds) ? raw.taskIds : []) {
      const resolved = resolveTask(board, String(value || '').trim());
      if (!resolved || ids.includes(resolved.id)) continue;
      ids.push(resolved.id);
      if (ids.length >= MAX_TASKS_PER_GROUP) break;
    }
    if (ids.length < 2) continue;
    const requestedRoot = resolveTask(board, String(raw.rootTaskId || '').trim())?.id || null;
    const overlaps = [...new Set(ids.map(id => ownerByTaskId.get(id)).filter(Boolean))];
    let group = overlaps.length ? clean[overlaps[0]] : null;
    if (!group) {
      const id = String(raw.id);
      group = {
        id,
        rootTaskId: requestedRoot && ids.includes(requestedRoot) ? requestedRoot : ids[0],
        taskIds: [],
        createdAt: Math.max(0, Number(raw.createdAt) || 0),
        updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
      };
      clean[id] = group;
    }
    for (const overlapId of overlaps.slice(1)) {
      const secondary = clean[overlapId];
      if (!secondary) continue;
      for (const id of secondary.taskIds) {
        if (!group.taskIds.includes(id) && group.taskIds.length < MAX_TASKS_PER_GROUP) {
          group.taskIds.push(id);
        }
      }
      group.createdAt = Math.min(group.createdAt || 0, secondary.createdAt || 0);
      group.updatedAt = Math.max(group.updatedAt || 0, secondary.updatedAt || 0);
      delete clean[overlapId];
    }
    for (const id of ids) {
      if (!group.taskIds.includes(id) && group.taskIds.length < MAX_TASKS_PER_GROUP) {
        group.taskIds.push(id);
      }
    }
    group.updatedAt = Math.max(group.updatedAt, Number(raw.updatedAt) || 0);
    for (const taskId of group.taskIds) ownerByTaskId.set(taskId, group.id);
  }
  board.taskGroups = clean;
  return clean;
}

function relatedTaskGroup(board, taskId) {
  const resolved = resolveTask(board, taskId);
  if (!resolved) return null;
  return Object.values(board.taskGroups || {})
    .find(group => Array.isArray(group.taskIds) && group.taskIds.includes(resolved.id)) || null;
}

// Add two distinct tasks to one display family. This is intentionally the only
// mutation: task records, task ids, short codes, refs and run ledgers are left
// byte-for-byte untouched.
function groupRelatedTasks(board, taskId, relatedTaskId, now = Date.now()) {
  const task = resolveTask(board, String(taskId || '').trim());
  const related = resolveTask(board, String(relatedTaskId || '').trim());
  if (!task || !related) return { ok: false, error: 'task_not_found' };
  if (task.id === related.id) return { ok: false, error: 'same_task' };
  const taskDir = taskDirId(board, task);
  const relatedDir = taskDirId(board, related);
  if (taskDir && relatedDir && taskDir !== relatedDir) {
    return { ok: false, error: 'task_directory_mismatch' };
  }
  reconcileTaskGroups(board);
  const taskGroup = relatedTaskGroup(board, task.id);
  const relatedGroup = relatedTaskGroup(board, related.id);
  if (taskGroup && relatedGroup && taskGroup.id === relatedGroup.id) {
    return { ok: true, changed: false, groupId: taskGroup.id, taskIds: [...taskGroup.taskIds] };
  }
  const desiredTaskIds = new Set([
    ...(taskGroup?.taskIds || []),
    ...(relatedGroup?.taskIds || []),
    task.id,
    related.id,
  ]);
  if (desiredTaskIds.size > MAX_TASKS_PER_GROUP) {
    return { ok: false, error: 'task_group_full' };
  }

  let group = relatedGroup || taskGroup;
  if (!group) {
    const digest = crypto.createHash('sha256')
      .update([task.id, related.id].sort().join('\u001f'))
      .digest('hex')
      .slice(0, 24);
    group = {
      id: `grp-${digest}`,
      rootTaskId: related.id,
      taskIds: [related.id, task.id],
      createdAt: now,
      updatedAt: now,
    };
    board.taskGroups[group.id] = group;
  } else {
    const additions = [related.id, task.id].filter(id => !group.taskIds.includes(id));
    group.taskIds.push(...additions);
    group.updatedAt = now;
  }
  const secondary = relatedGroup && taskGroup && relatedGroup.id !== taskGroup.id
    ? taskGroup : null;
  if (secondary) {
    for (const id of secondary.taskIds) {
      if (!group.taskIds.includes(id)) group.taskIds.push(id);
    }
    group.createdAt = Math.min(group.createdAt || now, secondary.createdAt || now);
    group.updatedAt = now;
    delete board.taskGroups[secondary.id];
  }
  reconcileTaskGroups(board);
  group = relatedTaskGroup(board, task.id);
  return { ok: true, changed: true, groupId: group.id, taskIds: [...group.taskIds] };
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
function addRefToTask(task, ref, now, maxRefs = MAX_REFS_PER_TASK) {
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
    if (task.status === 'done') {
      task.status = 'active';
      planning.alignStageWithStatus(task, 'active', now);
      changed = true;
    }
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
  if (Number.isFinite(maxRefs) && task.refs.length > maxRefs) {
    task.refs.splice(0, task.refs.length - maxRefs);
  }
  task.updatedAt = now;
  // A done task that receives new conversation is live again.
  if (task.status === 'done') {
    task.status = 'active';
    planning.alignStageWithStatus(task, 'active', now);
  }
  return true;
}

module.exports = {
  MAX_TAGS_PER_TURN,
  MAX_AREAS_PER_TASK,
  MAX_REFS_PER_TASK,
  MAX_TASKS_IN_PROMPT,
  MAX_TITLE_LEN,
  MAX_MODULE_LEN,
  MAX_TASKS_PER_GROUP,
  CLASSIFY_PENDING_MODULE_NAME,
  PENDING_TASK_TITLE,
  TASK_RUN_STATES,
  TASK_ORIGINS,
  taskOriginForSource,
  legacyTaskOrigin,
  safeClassificationError,
  createEmptyBoard,
  normalizeModuleName,
  normalizeBoard,
  normalizeTaskRouting,
  setTaskRouting,
  normalizeName,
  canonicalTaskTitle,
  taskTitleSimilarity,
  findModuleByName,
  taskDirId,
  ownTask,
  resolveTask,
  taskLineageIds,
  reconcileTaskGroups,
  relatedTaskGroup,
  groupRelatedTasks,
  newId,
  taskLastTs,
  deriveTaskTitle,
  addRefToTask,
};

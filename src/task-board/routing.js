'use strict';

const { taskDirId } = require('./normalize');
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

module.exports = {
  isRoutableRecord,
  resolveDirectoryCommander,
  routingTerms,
  buildRoutingContext,
  buildSessionRoutingProfile,
  routingRelevanceScore,
  recordAppearsAvailable,
  rankRoutingCandidates,
  pickDirTarget,
  pickRouteTarget,
  buildRoutedMessage,
  buildCommanderRoutedMessage,
  extractTaskMarker,
  messageText,
};

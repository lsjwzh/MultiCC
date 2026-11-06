'use strict';

const search = require('../task-board/search');
const runtime = require('./runtime');
const FIELD_NAMES = Object.keys(search.FIELD_WEIGHTS);

function prepare(board, options = {}) {
  const deleted = new Set(Array.isArray(board?.deletedTaskIds) ? board.deletedTaskIds : []);
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? new Set(options.statuses.map(String)) : null;
  const docs = new Map();
  for (const task of Object.values(board?.tasks || {})) {
    if (!task || typeof task.id !== 'string' || !task.id || deleted.has(task.id)
        || task.mergedInto || task.deleting) continue;
    if (statuses && !statuses.has(String(task.status || 'active'))) continue;
    if (docs.has(task.id)) throw new Error('duplicate_search_document_id');
    const fields = search.taskSearchFields(board, task);
    docs.set(task.id, {
      taskId: task.id, title: fields.title,
      dirId: typeof task.dirId === 'string' && task.dirId.trim() ? task.dirId.trim()
        : (Array.isArray(task.refs) ? task.refs.find(ref => ref?.dirId)?.dirId || null : null),
      status: typeof task.status === 'string' ? task.status : 'active',
      updatedAt: Number(task.updatedAt) || Number(task.createdAt) || 0,
      fields,
    });
  }
  // 包含原始文本和显示字段：即使规范化后相同，也不能复用旧的高亮片段或排序时间。
  return { docs, key: JSON.stringify([...docs.values()]) };
}
async function buildPrepared(prepared, addon) {
  const payload = [...prepared.docs.values()].map(doc => ({
    taskId: doc.taskId, dirId: doc.dirId, status: doc.status,
    fields: FIELD_NAMES.map(name => search.normalizeText(doc.fields[name])),
  }));
  const native = await runtime.runNative(() => addon.buildSearchIndex(JSON.stringify(payload)));
  return { backend: 'rust', native, docs: prepared.docs, timings: { buildNativeMs: native.buildMs } };
}
async function buildIndex(board, options = {}) {
  const addon = runtime.getNative();
  return buildPrepared(prepare(board, options), addon);
}
function stringSet(value, emptyIsNull = true) {
  return Array.isArray(value) && (!emptyIsNull || value.length) ? value.map(String) : null;
}
async function searchIndex(index, query, options = {}) {
  const parsed = typeof query === 'string' || query == null ? search.analyzeQuery(query) : query;
  if (!parsed.terms.length) return [];
  const input = JSON.stringify({
    terms: parsed.terms, strong: parsed.strong, phrase: parsed.phrase,
    dirId: options.dirId ? String(options.dirId) : null,
    dirIds: stringSet(options.dirIds), statuses: stringSet(options.statuses),
    taskIds: options.taskIds ? Array.from(options.taskIds, String) : null,
    excludeTaskIds: options.excludeTaskIds ? Array.from(options.excludeTaskIds, String) : null,
    minScore: Number(options.minScore) > 0 ? Number(options.minScore) : 0,
  });
  const raw = await runtime.runNative(() => index.native.search(input));
  index.timings.searchNativeMs = raw.computeMs;
  const hits = JSON.parse(raw.result).map(hit => {
    const doc = index.docs.get(hit.taskId);
    return { ...hit, title: doc.title, dirId: doc.dirId, status: doc.status, updatedAt: doc.updatedAt };
  });
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const result = hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt
    || a.taskId.localeCompare(b.taskId)).slice(0, limit)
    .map(hit => ({ ...hit, snippet: search.buildSnippet(index.docs.get(hit.taskId), parsed) }));
  runtime.record('search');
  return result;
}
function createTaskSearchBackend() {
  let cached = null;
  return async function searchTasks(board, query, options = {}) {
    const addon = runtime.getNative();
    const prepared = prepare(board, options);
    if (!cached || cached.key !== prepared.key) {
      const entry = { key: prepared.key, promise: buildPrepared(prepared, addon) };
      cached = entry;
      // 失败不缓存；较旧请求的完成不能抹掉较新快照。
      entry.promise.catch(() => { if (cached === entry) cached = null; });
    }
    return searchIndex(await cached.promise, query, options);
  };
}
module.exports = { buildIndex, searchIndex, createTaskSearchBackend };

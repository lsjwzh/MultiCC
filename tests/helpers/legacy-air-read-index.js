'use strict';

// Test oracle only (was src/workspace/air-read-index.js). Production builds the Air
// read model through src/workspace/air-index-port.js, i.e. the Rust index; nothing in
// src/ or server.js imports this file. It stays as the pre-migration Node baseline the
// Air differential tests compare against.

const { randomUUID, createHash } = require('node:crypto');
const status = require('../../public/status-presentation');

// 可重建读模型。请求只读这里，不调用任务板、Git、权属查询或快照生成器。
function createAirReadIndex({ historyLimit = 256, maxDeltaBytes = 256 * 1024 } = {}) {
  const epoch = randomUUID();
  let revision = 0, floor = 0, metadata = {}, metaBody = '', rows = new Map(), history = [];
  let ordered = [], counters = {}, ready = false;
  const memo = new Map();
  const eventSizes = new WeakMap();
  let encoded = null;
  const cursor = () => `${epoch}:${revision}`;
  const clone = value => JSON.parse(JSON.stringify(value));
  const at = task => Number(task.lastMessageAt || task.updatedAt || 0);
  function needs(task, todos, ignored) {
    if (task.status === 'archived' || ignored.has(task.id)) return false;
    const state = status.taskStatus(task);
    return todos.has(task.id) || ['waiting', 'error'].includes(state)
      || (state === 'succeeded' && task.goalState === 'interact');
  }
  function rebuild() {
    ordered = [...rows.values()].map(item => item.task).sort((a, b) => at(b) - at(a)
      || Number(b.updatedAt || 0) - Number(a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
    const todos = new Set(metadata.taskTodos), ignored = new Set(metadata.taskTodoIgnored);
    counters = {};
    for (const task of ordered) {
      for (const key of ['all', task.dirId]) {
        const c = counters[key] ||= { total: 0, open: 0, running: 0, needs: 0, todo: 0, error: 0, archived: 0 };
        c.total++; c.open += !['done', 'archived'].includes(task.status);
        c.running += status.taskStatus(task) === 'running';
        c.error += status.taskStatus(task) === 'error'; c.archived += task.status === 'archived';
        c.needs += needs(task, todos, ignored);
        c.todo += task.status !== 'archived' && todos.has(task.id);
      }
    }
    memo.clear(); encoded = null;
  }
  function apply(snapshot, { partial = false, removed = [] } = {}) {
    const { tasks = [], ...meta } = snapshot;
    const nextMeta = JSON.stringify(meta), changed = [], deleted = [];
    const present = new Set(tasks.map(t => t.id));
    if (!partial) for (const id of rows.keys()) if (!present.has(id)) { rows.delete(id); deleted.push(id); }
    if (partial) for (const id of removed) if (rows.delete(id)) deleted.push(id);
    for (const task of tasks) {
      const body = JSON.stringify(task);
      if (rows.get(task.id)?.body === body) continue;
      const detached = JSON.parse(body);
      rows.set(task.id, { task: detached, body }); changed.push(detached);
    }
    const metaChanged = nextMeta !== metaBody;
    if (!ready || changed.length || deleted.length || metaChanged) {
      metadata = clone(meta); metaBody = nextMeta; revision++;
      rebuild();
      const event = { type: 'air_delta', cursor: cursor(), previous: `${epoch}:${revision - 1}`,
        tasks: changed, deleted, ...(metaChanged ? { metadata } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (!ready || bytes > maxDeltaBytes) {
        history = []; floor = revision; ready = true;
        return { type: 'air_reset', cursor: cursor() };
      }
      eventSizes.set(event, bytes);
      history.push(event);
      while (history.length > historyLimit) floor = Number(history.shift().cursor.split(':').at(-1));
      return event;
    }
    return null;
  }
  function changes(since) {
    if (!ready) return { ok: false, code: 'air_warming' };
    const [id, raw] = String(since || '').split(':'), n = Number(raw);
    if (id !== epoch || !Number.isSafeInteger(n) || n < floor || n > revision) {
      return { ok: true, reset: true, cursor: cursor() };
    }
    const events = history.filter(e => Number(e.cursor.split(':').at(-1)) > n);
    if (events.length > 64 || events.reduce((sum, event) => sum + eventSizes.get(event), 0) > maxDeltaBytes) {
      return { ok: true, reset: true, cursor: cursor() };
    }
    if (events.length <= 1) return { ok: true, cursor: cursor(), events };
    // 重连只交付各任务的最终摘要，避免把离线期间的中间状态逐帧重画。
    const tasks = new Map(), deleted = new Set(); let meta;
    for (const event of events) {
      for (const id of event.deleted) { tasks.delete(id); deleted.add(id); }
      for (const task of event.tasks) { tasks.set(task.id, task); deleted.delete(task.id); }
      if (event.metadata) meta = event.metadata;
    }
    return { ok: true, cursor: cursor(), events: [{ type: 'air_delta', previous: String(since), cursor: cursor(),
      tasks: [...tasks.values()], deleted: [...deleted], ...(meta ? { metadata: meta } : {}) }] };
  }
  function stats(dayStart) {
    const key = `stats:${dayStart}`;
    if (memo.has(key)) return memo.get(key);
    const counts = clone(counters);
    for (const task of ordered) if ((status.taskStatus(task) === 'succeeded' || task.status === 'done')
        && Number(task.updatedAt || 0) >= dayStart) {
      for (const key of ['all', task.dirId]) counts[key].today = (counts[key].today || 0) + 1;
    }
    if (memo.size < 128) memo.set(key, counts);
    return counts;
  }
  function page(options = {}) {
    const size = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
    const dir = options.dirId || '', filter = options.status || 'open';
    const needle = String(options.query || '').slice(0, 200).toLowerCase();
    const dayStart = Number(options.dayStart) || 0;
    const ids = Array.isArray(options.ids) ? options.ids.slice(0, 200) : null;
    const pins = new Map((metadata.taskPins || []).map((id, i) => [id, i]));
    const todos = new Set(metadata.taskTodos), ignored = new Set(metadata.taskTodoIgnored);
    const rank = ids && new Map(ids.map((id, i) => [id, i]));
    const visits = options.visits || {};
    const key = JSON.stringify([revision, dir, filter, needle, dayStart, ids, options.sort, visits, options.page, size]);
    if (memo.has(key)) return memo.get(key);
    let list = ordered.filter(task => (!dir || task.dirId === dir) && (!rank || rank.has(task.id)));
    list = list.filter(task => {
      const state = status.taskStatus(task);
      if (needle && !`${task.title} ${metadata.directories?.find(d => d.id === task.dirId)?.name || ''}`.toLowerCase().includes(needle)) return false;
      if (filter === 'all') return true;
      if (filter === 'recent') return task.status !== 'archived';
      if (filter === 'archived') return task.status === 'archived';
      if (filter === 'today') return (state === 'succeeded' || task.status === 'done') && Number(task.updatedAt || 0) >= dayStart;
      if (filter === 'needs' || filter === 'waiting') return needs(task, todos, ignored);
      if (filter === 'waitingReply') return state === 'waiting';
      if (filter === 'todo') return task.status !== 'archived' && todos.has(task.id);
      if (filter === 'achieved' || filter === 'interact') return state === 'succeeded' && task.goalState === filter;
      if (['running', 'error', 'succeeded'].includes(filter)) return state === filter;
      return !['done', 'archived'].includes(task.status);
    });
    const direction = options.sort === 'oldest' || ['needs', 'todo', 'waiting'].includes(filter) ? 1 : -1;
    list.sort((a, b) => rank ? rank.get(a.id) - rank.get(b.id)
      : (pins.has(a.id) || pins.has(b.id)) ? (pins.get(a.id) ?? Infinity) - (pins.get(b.id) ?? Infinity)
        : (options.sort === 'visit' ? direction * ((Number(visits[a.id]) || 0) - (Number(visits[b.id]) || 0)) : 0)
          || direction * (at(a) - at(b)) || String(a.id).localeCompare(String(b.id)));
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.max(1, Math.min(pages, Math.floor(Number(options.page) || 1)));
    const result = { ok: true, cursor: cursor(), page: p, pages, total: list.length,
      tasks: list.slice((p - 1) * size, p * size) };
    if (memo.size >= 128) memo.delete(memo.keys().next().value);
    memo.set(key, result); return result;
  }
  function bootstrap({ include = [], dayStart = 0 } = {}) {
    const recent = ordered.filter(t => t.status !== 'archived').slice(0, 30);
    const ids = new Set([...recent.map(t => t.id), ...(metadata.taskPins || []), ...include.slice(0, 50)]);
    return { ...metadata, ok: true, cursor: cursor(), taskStats: stats(dayStart),
      tasks: [...ids].flatMap(id => rows.has(id) ? [rows.get(id).task] : []),
      // 通知只需关注仍未读的任务；不把其余历史卡片带到首屏。
      attentionTasks: ordered.filter(t => t.attention).slice(0, 50) };
  }
  return { apply, changes, page, bootstrap, cursor, stats, isReady: () => ready,
    snapshot: () => ({ ...metadata, tasks: ordered }),
    serialized: () => {
      if (!encoded) { const body = JSON.stringify({ ...metadata, tasks: ordered });
        encoded = { body, etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` }; }
      return encoded;
    } };
}
module.exports = { createAirReadIndex };

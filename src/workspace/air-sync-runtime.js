'use strict';
const { createAirIndex } = require('./air-index-port');

// One producer supplies host-authorized cards. The Rust index owns summaries;
// this host owns socket lifetimes and the atomic replay-to-live handoff.
function createAirSyncRuntime({ build, subscribe, taskIdsForSession = () => [], send,
  logger = console, reconcileMs = 30_000, debounceMs = 100, index = createAirIndex(), maxPending = 64 }) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256) throw Error('invalid_air_queue_limit');
  const clients = new Map(), attaching = new Set();
  let stopped = false, inFlight = null, timer = null, dueAt = Infinity, full = true, dirty = new Set(), metaDirty = false;
  let lastError = null, checkedAt = 0, retryAt = 0, tail = Promise.resolve(), pending = 0, closePromise;
  const unavailable = code => Object.assign(new Error('首页摘要暂不可用，请稍后重试'), { status: 503, code });
  function serial(operation, internal = false) {
    if (stopped) return Promise.reject(unavailable('air_closed'));
    if (!internal && pending >= maxPending) return Promise.reject(unavailable('air_busy'));
    pending++;
    const result = tail.then(() => {
      if (stopped) throw unavailable('air_closed');
      return operation();
    }).finally(() => { pending--; });
    tail = result.then(() => {}, () => {});
    return result;
  }
  function schedule(ms = debounceMs) {
    const delay = Math.max(ms, retryAt - Date.now());
    if (stopped || (timer && dueAt <= Date.now() + delay)) return;
    clearTimeout(timer); dueAt = Date.now() + delay;
    timer = setTimeout(() => { timer = null; dueAt = Infinity; void flush(); }, delay); timer.unref?.();
  }
  // null means full reconciliation; [] changes metadata only; other IDs refresh
  // the selected cards. Stream tokens and heartbeat events never rebuild cards.
  function invalidate(ids) {
    if (stopped) return;
    if (!ids) full = true;
    else if (!ids.length) metaDirty = true;
    else for (const id of ids) dirty.add(id);
    schedule();
  }
  async function applyAndPublish(snapshot, options) {
    const days = [...new Set(clients.values())];
    let event, stats;
    if (index.publish) {
      const result = await index.publish(snapshot, options, days);
      event = result.event; stats = new Map(result.stats);
    } else {
      // Explicit legacy/injected index adapter only. No projection lives here.
      event = await index.apply(snapshot, options); stats = new Map();
      for (const day of days) stats.set(day, await index.stats(day));
    }
    if (stopped) return;
    checkedAt = Date.now(); lastError = null; retryAt = 0;
    if (!event) return;
    for (const [socket, day] of clients) {
      if (socket.readyState !== 1) continue;
      try { send(socket, { ...event, taskStats: stats.get(day) }); }
      catch (_) { try { socket.close?.(); } catch (_) {} }
    }
  }
  function flush() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer); timer = null; dueAt = Infinity;
    const all = full || !index.isReady() || (!dirty.size && !metaDirty), ids = [...dirty];
    full = false; dirty.clear(); metaDirty = false;
    inFlight = (async () => {
      try {
        const snapshot = await build(all ? null : ids);
        if (stopped) return;
        const present = new Set(snapshot.tasks.map(task => task.id));
        // The producer has one reserved queue slot, so a full read queue cannot
        // prevent commits forever. Builds remain outside the handoff barrier.
        await serial(() => applyAndPublish(snapshot, { partial: !all, removed: all ? [] : ids.filter(id => !present.has(id)) }), true);
      } catch (error) {
        full = true; lastError = error; retryAt = Date.now() + 5000;
        logger.warn?.('air_sync_refresh_failed', { code: error?.code || 'refresh_failed' });
      } finally {
        inFlight = null;
        schedule(lastError ? 5000 : (full || dirty.size || metaDirty ? debounceMs : reconcileMs));
      }
    })();
    return inFlight;
  }
  async function ensureReady() {
    if (stopped) throw unavailable('air_closed');
    if (!index.isReady()) await (inFlight || flush());
    if (stopped || !index.isReady()) throw unavailable(stopped ? 'air_closed' : 'air_warming');
  }
  const unsubscribe = subscribe?.((dirId, event) => {
    if (['task_board_update', 'task_state', 'status', 'summary', 'session_queue_status', 'session_configuration_applied',
      'session_created', 'session_deleted', 'session_renamed', 'merge_state', 'workspace_state'].includes(event?.type)) {
      const ids = event.taskIds || (event.sessionId ? taskIdsForSession(event.sessionId) : null);
      invalidate(ids);
    }
  });
  async function readSync(since, day) {
    if (index.sync) return index.sync(since, day);
    return { ...await index.changes(since), taskStats: await index.stats(day) };
  }
  function attach(socket, url) {
    attaching.add(socket);
    socket.once('close', () => { clients.delete(socket); attaching.delete(socket); });
    return ensureReady().then(() => serial(async () => {
      if (stopped || socket.readyState !== 1) return;
      const day = Number(url.searchParams.get('dayStart')) || 0;
      const response = await readSync(url.searchParams.get('cursor'), day);
      if (stopped || socket.readyState !== 1) return;
      // This whole async operation shares the producer barrier. A commit is
      // either included in replay or published after subscription, never lost.
      if (response.reset) send(socket, { type: 'air_reset', cursor: response.cursor });
      else {
        for (const event of response.events) send(socket, { ...event, taskStats: response.taskStats });
        send(socket, { type: 'air_synced', cursor: response.cursor, checkedAt, degraded: !!lastError });
      }
      clients.set(socket, day);
    })).catch(() => { try { if (socket.readyState === 1) socket.close(1013, '首页摘要正在准备'); } catch (_) {} }).finally(() => attaching.delete(socket));
  }
  async function query(method, ...args) {
    await ensureReady();
    return serial(() => index[method](...args));
  }
  function mount(app, route) {
    app.get('/api/air/sync', route(async req => {
      await ensureReady();
      const q = req.query || {}, day = Number(q.dayStart) || 0;
      return serial(async () => ({ ...(q.cursor ? await readSync(q.cursor, day)
        : await index.bootstrap({ include: String(q.include || '').split(',').filter(Boolean), dayStart: day })),
      checkedAt, degraded: !!lastError }));
    }));
    app.get('/api/air/page', route(async req => {
      const q = req.query || {};
      let visits = {};
      try { visits = JSON.parse(String(q.visits || '{}').slice(0, 10_000)); } catch (_) {}
      return query('page', { ...q, visits, ids: q.ids === undefined ? null : String(q.ids).split(',').filter(Boolean) });
    }));
  }
  schedule(0);
  return { index, ensureReady, invalidate, attach, mount, flush, query,
    serialized: () => query('serialized'),
    close() {
      if (closePromise) return closePromise;
      stopped = true; clearTimeout(timer); unsubscribe?.();
      for (const socket of new Set([...clients.keys(), ...attaching])) { try { socket.close?.(1001, '服务关闭'); } catch (_) {} }
      clients.clear(); attaching.clear();
      closePromise = (async () => { await inFlight; await tail; await index.close?.(); })();
      return closePromise;
    } };
}
module.exports = { createAirSyncRuntime };

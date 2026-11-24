'use strict';
const { createAirIndex, describeAirIssue } = require('./air-index-port');

// One producer supplies host-authorized cards. The Rust index owns summaries;
// this host owns socket lifetimes and the atomic replay-to-live handoff.
function createAirSyncRuntime({ build, subscribe, taskIdsForSession = () => [], send,
  logger = console, reconcileMs = 30_000, debounceMs = 100, index = createAirIndex(), maxPending = 64,
  retryBaseMs = 5_000, retryMaxMs = 60_000, storageNotice = () => null }) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256) throw Error('invalid_air_queue_limit');
  const clients = new Map(), attaching = new Set();
  let stopped = false, inFlight = null, timer = null, dueAt = Infinity, full = true, dirty = new Set(), metaDirty = false;
  // Metadata writes and the Rust projection have separate lifetimes. Reads
  // started after an acknowledged write must not return the old projection.
  let metadataVersion = 0, publishedMetadataVersion = 0;
  let lastError = null, checkedAt = 0, retryAt = 0, failures = 0, tail = Promise.resolve(), pending = 0, closePromise;
  const unavailable = code => Object.assign(new Error('首页摘要暂不可用，请稍后重试'), { status: 503, code });
  let publishedIssueCode = null;
  function currentIssue() {
    // Persistence reports can arrive independently of a failed refresh. Keep
    // an observed write failure visible even when the session owner is busy.
    return storageNotice() || lastError;
  }
  function statusFields() {
    const issue = currentIssue();
    return { degraded: !!issue, ...(issue ? { issue } : {}) };
  }
  function publishStatus() {
    if (stopped) return;
    const fields = statusFields();
    const code = fields.issue?.code || null;
    if (code === publishedIssueCode) return;
    publishedIssueCode = code;
    for (const socket of clients.keys()) {
      if (socket.readyState === 1) {
        try { send(socket, { type: 'air_status', ...fields }); }
        catch (_) { try { socket.close?.(); } catch (_) {} }
      }
    }
  }
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
    else if (!ids.length) { metaDirty = true; metadataVersion++; }
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
    const metaOnly = !all && !ids.length;
    const metadataAtStart = metadataVersion;
    full = false; dirty.clear(); metaDirty = false;
    inFlight = (async () => {
      try {
        const snapshot = await build(all ? null : ids);
        if (stopped) return;
        const present = new Set(snapshot.tasks.map(task => task.id));
        // The producer has one reserved queue slot, so a full read queue cannot
        // prevent commits forever. Builds remain outside the handoff barrier.
        await serial(() => applyAndPublish(snapshot, { partial: !all, removed: all ? [] : ids.filter(id => !present.has(id)) }), true);
        publishedMetadataVersion = Math.max(publishedMetadataVersion, metadataAtStart);
        checkedAt = Date.now(); lastError = null; retryAt = 0; failures = 0;
      } catch (error) {
        lastError = describeAirIssue(error);
        // 局部失败只重试这几张卡；只有全量/元数据档失败才需要下一轮全量核对。
        // 退避按失败次数翻倍，避免 owner 暂时不可用时每 5 秒重建一次全部卡片。
        failures += 1;
        retryAt = Date.now() + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(failures - 1, 4));
        if (all) full = true;
        else if (metaOnly) metaDirty = true;
        else for (const id of ids) dirty.add(id);
        logger.warn?.('air_sync_refresh_failed', { code: error?.code || 'refresh_failed',
          reason: String(error?.message || error || 'unknown').slice(0, 500), failures,
          retryInMs: Math.max(0, retryAt - Date.now()), full: all });
      } finally {
        inFlight = null;
        publishStatus();
        schedule(lastError ? Math.max(0, retryAt - Date.now())
          : (full || dirty.size || metaDirty ? debounceMs : reconcileMs));
      }
    })();
    return inFlight;
  }
  async function ensureReady() {
    if (stopped) throw unavailable('air_closed');
    if (!index.isReady() && (inFlight || Date.now() >= retryAt)) await (inFlight || flush());
    if (stopped) throw unavailable('air_closed');
    if (!index.isReady()) {
      const issue = currentIssue();
      if (issue) throw Object.assign(new Error(issue.message), {
        code: issue.code, status: ['ENOSPC', 'SQLITE_FULL'].includes(issue.code) ? 507 : 503,
      });
      throw unavailable('air_warming');
    }
  }
  async function ensureMetadataCurrent() {
    const required = metadataVersion;
    const deadline = Date.now() + 2000;
    while (publishedMetadataVersion < required) {
      if (stopped || lastError || Date.now() >= deadline) throw unavailable('air_refresh_pending');
      let timeout;
      const completed = await Promise.race([
        flush().then(() => true),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now())); }),
      ]).finally(() => clearTimeout(timeout));
      if (!completed || stopped || (lastError && publishedMetadataVersion < required)) {
        throw unavailable('air_refresh_pending');
      }
    }
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
    return ensureReady().then(ensureMetadataCurrent).then(() => serial(async () => {
      if (stopped || socket.readyState !== 1) return;
      const day = Number(url.searchParams.get('dayStart')) || 0;
      const response = await readSync(url.searchParams.get('cursor'), day);
      if (stopped || socket.readyState !== 1) return;
      // This whole async operation shares the producer barrier. A commit is
      // either included in replay or published after subscription, never lost.
      if (response.reset) send(socket, { type: 'air_reset', cursor: response.cursor });
      else {
        for (const event of response.events) send(socket, { ...event, taskStats: response.taskStats });
        send(socket, { type: 'air_synced', cursor: response.cursor, checkedAt, ...statusFields() });
      }
      clients.set(socket, day);
    })).catch(() => { try { if (socket.readyState === 1) socket.close(1013, '首页摘要正在准备'); } catch (_) {} }).finally(() => attaching.delete(socket));
  }
  async function query(method, ...args) {
    await ensureReady();
    await ensureMetadataCurrent();
    return serial(() => index[method](...args));
  }
  // GET /api/air/sync 与 GET /api/air/page 的处理器原体：公开注册已迁到
  // Rust 前门（native/gateway/src/app/air_routes.rs），前门按 qs 语义抽取
  // 查询键后经宿主端口调进来；这里的入参 q 就是原 req.query 的同形 JSON。
  // 两条都是只读：route() 对 GET 不做失效，错误信封规则由宿主端口与内核
  // error_body 复刻。
  async function syncHttp(q = {}) {
    await ensureReady();
    await ensureMetadataCurrent();
    const day = Number(q.dayStart) || 0;
    return serial(async () => ({ ...(q.cursor ? await readSync(q.cursor, day)
      : await index.bootstrap({ include: String(q.include || '').split(',').filter(Boolean), dayStart: day })),
    checkedAt, ...statusFields() }));
  }
  async function pageHttp(q = {}) {
    let visits = {};
    try { visits = JSON.parse(String(q.visits || '{}').slice(0, 10_000)); } catch (_) {}
    return query('page', { ...q, visits, ids: q.ids === undefined ? null : String(q.ids).split(',').filter(Boolean) });
  }
  schedule(0);
  return { index, ensureReady, invalidate, attach, syncHttp, pageHttp, flush, query, publishStatus,
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

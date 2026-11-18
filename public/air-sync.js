(function (root) {
  'use strict';
  const number = cursor => Number(String(cursor).split(':').at(-1));
  const generation = cursor => String(cursor).split(':')[0];
  // onIssue 默认写首页的持久化告警条（#air-sync-issue，仅 air.html 有）；测试与
  // 其他页面可传自己的回调覆盖。
  const defaultIssue = issue => {
    const el = root.document && root.document.getElementById('air-sync-issue');
    if (el) el.textContent = (issue && issue.message) || '';
  };
  function create({ request, getInclude = () => [], onChange = () => {}, onStatus = () => {}, onIssue = defaultIssue,
    socketUrl, Socket = root.WebSocket, random = Math.random,
    schedule = setTimeout, cancel = clearTimeout, isVisible = () => true }) {
    let snapshot = null, cursor = '', inflight = null, socket = null, connecting = false, socketDay = 0;
    let closed = false, paused = false, failures = 0, reconnectTimer = null, retryTimer = null, pageTimer = null, serial = 0, freshNeeded = false, viewVersion = 0;
    const pool = new Map(), versions = new Map(), pages = new Map(), pending = new Map();
    const initialIds = new Set(), attention = new Map();
    const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const query = options => new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
    function put(task, version) {
      if (generation(version) === generation(cursor) && (versions.get(task.id) || 0) <= number(version)) {
        pool.set(task.id, task); versions.set(task.id, number(version));
      }
    }
    function trim() {
      const recent = [...initialIds].map(id => pool.get(id)).filter(t => t && t.status !== 'archived')
        .sort((a, b) => Number(b.lastMessageAt || b.updatedAt || 0) - Number(a.lastMessageAt || a.updatedAt || 0)).slice(0, 30);
      initialIds.clear(); for (const task of recent) initialIds.add(task.id);
      const keep = new Set([...initialIds, ...getInclude(), ...(snapshot?.taskPins || [])]);
      for (const value of pages.values()) for (const task of value.tasks) keep.add(task.id);
      for (const id of pool.keys()) if (!keep.has(id)) { pool.delete(id); versions.delete(id); }
    }
    function current() {
      if (!snapshot) return null;
      return { ...snapshot, cursor, viewVersion, tasks: [...pool.values()], attentionTasks: [...attention.values()] };
    }
    function changed() {
      while (attention.size > 50) attention.delete(attention.keys().next().value);
      trim(); if (!paused && !closed) onChange(current());
    }
    function delta(event) {
      if (!Number.isSafeInteger(number(event.cursor)) || !Number.isSafeInteger(number(event.previous))) return false;
      if (!snapshot || generation(event.cursor) !== generation(cursor)) return false;
      if (number(event.cursor) <= number(cursor)) return true; // 重放/重复帧。
      if (generation(event.previous) !== generation(cursor) || number(event.previous) > number(cursor)) return false;
      cursor = event.cursor;
      if (event.metadata) snapshot = { ...snapshot, ...event.metadata };
      if (event.taskStats) snapshot.taskStats = event.taskStats;
      for (const task of event.tasks || []) {
        put(task, cursor); initialIds.add(task.id);
        if (task.attention) attention.set(task.id, task); else attention.delete(task.id);
      }
      for (const id of event.deleted || []) {
        pool.delete(id); versions.delete(id); initialIds.delete(id); attention.delete(id);
      }
      return true;
    }
    async function sync({ fresh = false } = {}) {
      if (closed) return current();
      if (fresh) freshNeeded = true;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const before = cursor, beforeStats = JSON.stringify(snapshot?.taskStats);
          const q = { dayStart: dayStart(), ...(snapshot && !freshNeeded ? { cursor } : { include: getInclude().slice(0, 50).join(',') }) };
          freshNeeded = false;
          let result = await request('/api/air/sync?' + query(q));
          if (closed) return current();
          if (result.reset) result = await request('/api/air/sync?' + query({ dayStart: dayStart(), include: getInclude().slice(0, 50).join(',') }));
          if (closed) return current();
          if (result.tasks) {
            if (snapshot && generation(result.cursor) === generation(cursor) && number(result.cursor) < number(cursor)) return current();
            snapshot = result; cursor = result.cursor; serial++;
            pool.clear(); versions.clear(); initialIds.clear(); pages.clear(); pending.clear(); attention.clear();
            for (const task of result.tasks) { initialIds.add(task.id); put(task, cursor); }
            for (const task of result.attentionTasks || []) attention.set(task.id, task);
          } else {
            for (const event of result.events || []) {
              // 与 HTTP 同时到来的 WS 帧可能已经推进游标；旧帧安全跳过。
              if (!delta(event)) { freshNeeded = true; throw new Error('首页同步版本不连续'); }
            }
            if (result.cursor === cursor && result.taskStats) snapshot.taskStats = result.taskStats;
          }
          onIssue(result.issue || null);
          failures = 0; onStatus(result.degraded ? 'degraded' : socket?.readyState === 1 ? 'live' : 'connecting');
          if (before !== cursor || beforeStats !== JSON.stringify(snapshot?.taskStats)) changed();
          const missing = getInclude().slice(0, 50).filter(id => !pool.has(id));
          if (missing.length) page('include', { status: 'all', ids: missing, limit: 50 });
          if (socket && socketDay !== dayStart()) { const old = socket; socket = null; old.close(); }
          return current();
        } catch (error) {
          failures++; onStatus('offline');
          if (!closed && !paused) onIssue(error);
          if (!retryTimer && !closed && !paused) retryTimer = schedule(() => { retryTimer = null; void sync().catch(() => {}); }, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (0.8 + random() * 0.4));
          throw error;
        } finally {
          inflight = null;
          if (!closed && !paused && freshNeeded && !retryTimer) void sync().catch(() => {});
          if (!closed && snapshot) void connect();
        }
      })();
      return inflight;
    }
    async function connect() {
      if (closed || paused || connecting || !Socket || !socketUrl || !isVisible() || socket?.readyState <= 1 || reconnectTimer) return;
      connecting = true; const attempt = serial;
      try {
        const day = dayStart();
        const url = await socketUrl(`/ws/meta?air=1&cursor=${encodeURIComponent(cursor)}&dayStart=${day}`);
        if (closed || paused || attempt !== serial || !isVisible()) return;
        const next = new Socket(url); socket = next; socketDay = day;
        next.onopen = () => { if (socket === next) { failures = 0; onStatus('live'); } };
        next.onmessage = message => {
          if (closed || socket !== next) return;
          let event; try { event = JSON.parse(message.data); } catch (_) { return; }
          if (event.type === 'air_reset') { void sync({ fresh: true }).catch(() => {}); return; }
          if (event.type === 'air_delta') {
            const before = cursor;
            if (!delta(event)) { void sync().catch(() => {}); return; }
            if (before !== cursor) changed();
          }
          if (event.type === 'air_synced' || event.type === 'air_status') {
            onIssue(event.issue || null);
            onStatus(event.degraded ? 'degraded' : 'live');
          }
        };
        next.onclose = () => { if (socket === next) { socket = null; onStatus('connecting'); retryConnect(); } };
        next.onerror = () => { try { next.close(); } catch (_) {} };
      } catch (_) { retryConnect(); }
      finally { connecting = false; if (!socket && !closed && !paused) retryConnect(); }
    }
    function retryConnect() {
      if (closed || paused || reconnectTimer) return;
      failures++;
      reconnectTimer = schedule(() => { reconnectTimer = null; void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (0.8 + random() * 0.4));
    }
    // 页面独立缓存：切目录、筛选、翻页不会让迟到响应替换当前视图。
    function page(key, options, notify = onChange) {
      const q = { limit: 20, ...options, dayStart: dayStart() };
      const signature = JSON.stringify(q), cached = pages.get(key);
      if (!closed && !paused && (!cached || cached.signature !== signature || number(cached.cursor) < number(cursor))
          && (cached?.signature !== signature || !cached?.errorAt || Date.now() - cached.errorAt >= 5000) && !pending.has(key)) {
        const attempt = serial;
        const promise = request('/api/air/page?' + query({ ...q, ...(q.ids ? { ids: q.ids.join(',') } : {}) })).then(result => {
          if (closed || attempt !== serial) return;
          if (generation(result.cursor) !== generation(cursor)) { void sync({ fresh: true }).catch(() => {}); return; }
          if (number(result.cursor) < number(cursor)) return;
          for (const task of result.tasks) put(task, result.cursor);
          const tasks = result.tasks.map(task => pool.get(task.id) || task);
          if (pages.size >= 16 && !pages.has(key)) pages.delete(pages.keys().next().value);
          pages.set(key, { ...result, tasks, signature });
          viewVersion++;
          trim();
        }).catch(() => {
          if (closed || attempt !== serial) return;
          onStatus('offline'); pages.set(key, { signature, cursor, tasks: cached?.tasks || [], total: cached?.total || 0,
            page: Number(q.page) || 1, pages: cached?.pages || 1, errorAt: Date.now() });
          if (!pageTimer) pageTimer = schedule(() => { pageTimer = null; if (!closed && !paused) notify(current()); }, 5100);
        }).finally(() => {
          if (pending.get(key) === promise) pending.delete(key);
          if (!closed && !paused && attempt === serial) notify(current());
        });
        pending.set(key, promise);
      }
      return cached?.signature === signature ? { ...cached, tasks: cached.tasks.map(t => pool.get(t.id)).filter(Boolean) }
        : { tasks: [], total: cached?.total || 0, pages: cached?.pages || 1, page: Number(q.page) || 1, loading: true };
    }
    function resume() {
      closed = false; paused = false;
      cancel(reconnectTimer); reconnectTimer = null;
      if (snapshot) changed();
      void sync().catch(() => {});
    }
    function pause() {
      paused = true; serial++; pending.clear();
      cancel(reconnectTimer); reconnectTimer = null; cancel(retryTimer); retryTimer = null;
      cancel(pageTimer); pageTimer = null;
      const previous = socket; socket = null; previous?.close();
    }
    function close() { closed = true; pause(); cancel(retryTimer); retryTimer = null; }
    return { sync, current, page, resume, pause, close, delta,
      invalidate: () => { serial++; pages.clear(); pending.clear(); changed(); void sync().catch(() => {}); } };
  }
  function searchIds(result) {
    if (!result) return undefined;
    return [...new Set([...(result.hits || []).map(hit => hit.taskId),
      ...(result.messageHits || []).flatMap(hit => hit.taskIds || [])].filter(Boolean))];
  }
  root.MultiCCAirSync = { create, searchIds };
  if (typeof module !== 'undefined') module.exports = { create, searchIds };
})(typeof window === 'undefined' ? globalThis : window);

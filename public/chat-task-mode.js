'use strict';

// M2 · task-mode adapter for the unified chat view
// (docs/chat-view-unification-design.md §3-M2). chat.html?task=<id> boots the
// session-view host (chat.js) with this adapter instead of the chat WS:
//
//   boot              → GET /api/task-board/tasks/:id (identity) + first
//                       transcript page through the shared history-store →
//                       applyHistoryPlan pipeline, then subscribe to the dir
//                       workspace WS (manage.js pattern, multiccWsUrl ticket).
//   handleWorkspaceMessage → unwraps M1 `task_run_stream` envelopes (slot
//                       events are fed byte-identical to the same event
//                       controller; run-id changes render a run separator) and
//                       debounces `task_board_update` into identity refreshes.
//                       The slot session id never appears in an envelope (I5).
//   transportSend     → the composer transport contract: user_message POSTs
//                       to the board send endpoint with the idempotency key,
//                       cancel terminates the open run (POST status done —
//                       the same semantics as the board's ✅ button), typing
//                       is a no-op, clear_history resets the view only.
//   reconnect         → onclose backs off and reconnects; a reconnect open
//                       reconciles by re-fetching task + first page after a
//                       view reset (the ledger is the source of truth, I1).
//
// No DOM in here — the host renders separators/identity/status. UMD so the
// node test suite can require() it headless.

(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    factory(module.exports);
  } else {
    const exports = {};
    factory(exports);
    global.MultiCCChatTaskMode = exports;
  }
}(typeof self !== 'undefined' ? self : this, (exports) => {

  const TASK_PAGE_SIZE = 50;
  const REFRESH_DEBOUNCE_MS = 400;
  const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000];

  // P2 · task chat = ordinary chat. Get-or-create the task's 1:1 bound hidden
  // session (P1 server side) and return its id so the host can hand off to the
  // plain session chat — the task view then IS the ordinary chat view (tool
  // cards, usage, memory injection, resume continuity) instead of the ledger
  // projection below. Fails soft: ANY error (old server 501, gone task 404,
  // no directory 409, failed create 502, network down, malformed body) returns
  // null and the host boots the legacy projection, so the task view is never
  // stranded by the handoff itself.
  async function resolveBoundSession({ taskId, fetch, withToken }) {
    try {
      const bare = `/api/task-board/tasks/${encodeURIComponent(taskId)}/chat-session`;
      const url = typeof withToken === 'function' ? withToken(bare) : bare;
      const r = await fetch(url, { method: 'POST' });
      if (!r || !r.ok) return null;
      const d = await r.json();
      return d && d.ok === true && typeof d.sessionId === 'string' && d.sessionId
        ? d.sessionId : null;
    } catch (_) {
      return null;
    }
  }

  function createTaskMode(deps) {
    // Every dep is read lazily off the shared object: the host may inject
    // optional ports (unstageUserMessage, translate) after construction.
    let task = null;
    let socket = null;
    let socketEverOpened = false;
    let connecting = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let refreshTimer = null;
    let lastRunId = null;
    let runCount = 0;

    const t = text => (typeof deps.translate === 'function' ? deps.translate(text) : text);
    const say = text => { if (typeof deps.addSystemMsg === 'function') deps.addSystemMsg(text); };
    const status = (text, kind) => { if (typeof deps.statusUpdate === 'function') deps.statusUpdate(text, kind); };
    const debug = (...args) => { if (typeof deps.debug === 'function') deps.debug(...args); };

    function taskId() { return String(deps.taskId || ''); }

    function api(pathname) {
      const loc = (deps.window && deps.window.location) || {};
      const host = loc.host || 'localhost';
      const protocol = loc.protocol === 'http:' ? 'http:' : 'https:';
      return `${protocol}//${host}${pathname}`;
    }

    function wsScheme() {
      const protocol = (deps.window && deps.window.location && deps.window.location.protocol) || 'https:';
      return protocol === 'http:' ? 'ws:' : 'wss:';
    }

    async function fetchJson(url, init) {
      const target = typeof deps.withToken === 'function' ? deps.withToken(url) : url;
      const response = await deps.fetch(target, init);
      let body = {};
      try { body = await response.json(); } catch (_) { /* non-JSON error body */ }
      if (!response.ok || body.ok === false) {
        const error = new Error(body && body.error ? body.error : `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function errorMessage(err) {
      return err && err.message ? String(err.message) : String(err);
    }

    /* ── bootstrap ── */

    async function boot() {
      await refreshTask();
      await loadInitialPage();
      await connectWorkspace();
    }

    async function refreshTask() {
      try {
        const body = await fetchJson(
          api(`/api/task-board/tasks/${encodeURIComponent(taskId())}?include=body&include=runs`));
        const dto = body && body.task ? body.task : null;
        if (!dto) throw new Error('task_not_found');
        task = dto;
        if (typeof deps.updateTaskIdentity === 'function') deps.updateTaskIdentity(dto);
      } catch (err) {
        debug('task refresh failed', err);
        say(`${t('任务信息加载失败')}: ${errorMessage(err)}`);
      }
    }

    async function loadInitialPage() {
      try {
        const page = await fetchJson(
          api(`/api/task-board/tasks/${encodeURIComponent(taskId())}/messages?limit=${TASK_PAGE_SIZE}`));
        applyPage(page);
      } catch (err) {
        debug('task transcript load failed', err);
        say(`${t('任务记录加载失败')}: ${errorMessage(err)}`);
      }
    }

    // Page → shared history pipeline (the same acceptHistory → applyHistoryPlan
    // pair the event controller drives on chat_history), then re-derive run
    // boundaries so the fresh view shows one separator per run.
    function applyPage(page) {
      const payload = {
        messages: Array.isArray(page && page.messages) ? page.messages : [],
        hasMore: !!(page && page.hasMore),
      };
      const plan = deps.historyStore.acceptHistory(payload, []);
      deps.applyHistoryPlan(plan);
      renderPageSeparators(payload.messages);
    }

    function renderPageSeparators(messages) {
      const runs = task && Array.isArray(task.runs) ? task.runs : [];
      const runById = new Map(runs.map(run => [run.runId, run]));
      const seen = new Set();
      let count = 0;
      for (const message of messages) {
        const runId = message && message.taskRunId;
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        count += 1;
        const run = runById.get(runId) || {};
        emitSeparator({
          runId,
          n: count,
          beforeMessageId: message.id != null ? message.id : null,
          status: run.executionStatus || 'running',
          startedAt: run.startedAt != null ? run.startedAt : null,
        });
        lastRunId = runId;
      }
      // Empty page: still seed the counters from the task's run list so the
      // next live run gets separator n = runs + 1, not n = 1.
      if (count === 0) {
        runCount = runs.length;
        lastRunId = runs.length ? runs[runs.length - 1].runId : null;
        return;
      }
      runCount = Math.max(count, runs.length);
    }

    function emitSeparator(info) {
      if (typeof deps.renderRunSeparator === 'function') deps.renderRunSeparator(info);
    }

    // A run-id change in the live stream starts a new visible run: one
    // separator before its first event, then the events flow unchanged.
    function maybeLiveSeparator(runId) {
      if (!runId || runId === lastRunId) return;
      runCount += 1;
      lastRunId = runId;
      emitSeparator({ runId, n: runCount, beforeMessageId: null, status: 'running', startedAt: null });
    }

    /* ── dir workspace WS ── */

    // Resolves once the socket exists (or the no-WS / failure path settled) —
    // boot awaits it so a freshly booted view has its transport in place.
    function connectWorkspace() {
      if (connecting || socket) return Promise.resolve();
      const dirId = task && Array.isArray(task.dirIds) && task.dirIds[0];
      if (!dirId) {
        say(t('任务未绑定目录，无法订阅实时更新（只读模式，发送仍可用）'));
        return Promise.resolve();
      }
      connecting = true;
      const raw = `${wsScheme()}//${deps.window.location.host}/ws/workspace?dirId=${encodeURIComponent(dirId)}`;
      const ticketed = typeof deps.multiccWsUrl === 'function'
        ? Promise.resolve().then(() => deps.multiccWsUrl(raw))
        : Promise.resolve(raw);
      return ticketed.then(url => {
        if (!connecting) return;
        const Socket = deps.WebSocket;
        socket = new Socket(url);
        wireSocket(socket);
      }).catch(err => {
        connecting = false;
        debug('workspace ws ticket failed', err);
        status(t('连接失败，正在重连…'), 'error');
        scheduleReconnect();
      });
    }

    function wireSocket(sock) {
      sock.onopen = () => {
        connecting = false;
        reconnectAttempt = 0;
        if (typeof deps.setWs === 'function') deps.setWs(sock);
        status(t('Connected'), 'connected');
        if (socketEverOpened) reconcile();
        socketEverOpened = true;
      };
      sock.onmessage = raw => {
        let message = null;
        try {
          message = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data;
        } catch (_) { return; }
        handleWorkspaceMessage(message);
      };
      sock.onclose = () => {
        if (socket !== sock) return;
        socket = null;
        connecting = false;
        if (typeof deps.setWs === 'function') deps.setWs(null);
        status(t('连接已断开，正在重连…'), 'error');
        scheduleReconnect();
      };
      sock.onerror = () => { /* onclose follows */ };
    }

    function scheduleReconnect() {
      if (reconnectTimer != null) return;
      const delay = typeof deps.reconnectDelayMs === 'function'
        ? deps.reconnectDelayMs(reconnectAttempt)
        : RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = deps.setTimeoutFn(() => {
        reconnectTimer = null;
        connectWorkspace();
      }, delay);
    }

    // After a drop the view may have missed events: reset and re-read the
    // ledger's first page (the ledger, not the socket, is the truth — I1).
    async function reconcile() {
      try {
        if (typeof deps.resetHistoryView === 'function') deps.resetHistoryView();
        await Promise.all([refreshTask(), loadInitialPage()]);
      } catch (err) {
        debug('reconcile failed', err);
      }
    }

    /* ── inbound workspace messages ── */

    function boardUpdateTouchesTask(message) {
      if (Array.isArray(message.taskIds)) return message.taskIds.includes(taskId());
      if (message.taskId != null) return String(message.taskId) === taskId();
      return true; // board-wide notice without ids: refresh conservatively
    }

    function scheduleRefresh() {
      if (refreshTimer != null) return;
      refreshTimer = deps.setTimeoutFn(() => {
        refreshTimer = null;
        Promise.resolve(refreshTask()).catch(() => {});
      }, REFRESH_DEBOUNCE_MS);
    }

    function handleWorkspaceMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'task_run_stream') {
        if (String(message.taskId || '') !== taskId()) return;
        // The run's engine gates delta folding in the shared controller
        // (part_delta is a no-op under claude; codex snapshots append), so
        // the envelope's cli must land before its first slot event.
        if (message.cli != null && typeof deps.setCli === 'function') {
          deps.setCli(String(message.cli));
        }
        const events = Array.isArray(message.slotEvents) && message.slotEvents.length
          ? message.slotEvents
          : (message.slotEvent ? [message.slotEvent] : []);
        if (!events.length) return;
        maybeLiveSeparator(message.runId != null ? String(message.runId) : null);
        const generation = typeof deps.getGeneration === 'function' ? deps.getGeneration() : 0;
        for (const event of events) deps.handleEvent(event, generation);
        return;
      }
      if (message.type === 'task_board_update') {
        if (!boardUpdateTouchesTask(message)) return;
        scheduleRefresh();
      }
      // Everything else on the dir channel is session-scoped noise for us.
    }

    /* ── composer transport ── */

    function transportSend(payload) {
      if (!payload || typeof payload !== 'object') return true;
      if (payload.type === 'user_message') {
        sendUserMessage(payload);
      } else if (payload.type === 'cancel') {
        cancelOpenRun();
      } else if (payload.type === 'clear_history') {
        if (typeof deps.resetHistoryView === 'function') deps.resetHistoryView();
      }
      // typing (and unknown types) are no-ops; truthy lets the composer proceed.
      return true;
    }

    function sendUserMessage(payload) {
      const body = { text: String(payload.text || '') };
      if (payload.clientMsgId) body.clientMsgId = String(payload.clientMsgId).slice(0, 128);
      // M4-T1: a composer answer to a pending question rides the same send
      // transport with the chat-side requestId; the ingress resolves the
      // pending run instead of opening a followup.
      if (payload.userInputRequestId) body.userInputRequestId = String(payload.userInputRequestId).slice(0, 160);
      if (payload.goal) {
        body.goal = payload.goal;
        if (payload.goalLimits && typeof payload.goalLimits === 'object') body.goalLimits = payload.goalLimits;
      }
      fetchJson(api(`/api/task-board/tasks/${encodeURIComponent(taskId())}/send`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(err => {
        say(`${t('发送失败')}: ${errorMessage(err)}`);
        if (payload.clientMsgId && typeof deps.unstageUserMessage === 'function') {
          deps.unstageUserMessage(String(payload.clientMsgId));
        }
      });
    }

    // Cancelling a task view = stopping the open run only (A3 split): the
    // card keeps its lifecycle state; marking done stays with the board's ✅.
    function cancelOpenRun() {
      fetchJson(api(`/api/task-board/tasks/${encodeURIComponent(taskId())}/cancel-run`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(err => {
        say(`${t('停止失败')}: ${errorMessage(err)}`);
      });
    }

    function historyPageUrl({ before, limit } = {}) {
      const params = new URLSearchParams();
      if (before) params.set('before', String(before));
      params.set('limit', String(limit || TASK_PAGE_SIZE));
      return `/api/task-board/tasks/${encodeURIComponent(taskId())}/messages?${params.toString()}`;
    }

    function disconnect() {
      if (reconnectTimer != null) {
        deps.clearTimeoutFn(reconnectTimer);
        reconnectTimer = null;
      }
      if (refreshTimer != null) {
        deps.clearTimeoutFn(refreshTimer);
        refreshTimer = null;
      }
      connecting = false;
      const sock = socket;
      socket = null;
      if (sock) {
        sock.onclose = () => {};
        try { sock.close(); } catch (_) { /* already closing */ }
      }
    }

    return {
      boot,
      transportSend,
      historyPageUrl,
      handleWorkspaceMessage,
      refreshTask,
      disconnect,
    };
  }

  exports.createTaskMode = createTaskMode;
  exports.resolveBoundSession = resolveBoundSession;
}));

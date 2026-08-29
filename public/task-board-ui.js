(function attachMultiCCTaskBoardUi(global) {
  'use strict';

  function sessionChatUrl(sessionId, messageId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const params = new URLSearchParams();
    params.set('session', id);
    const target = String(messageId || '').trim();
    if (target) params.set('message', target);
    return `/chat.html?${params.toString()}`;
  }

  function compareText(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  }

  function sortModules(modules) {
    return [...(Array.isArray(modules) ? modules : [])].sort((a, b) => {
      const aPending = a?.source === 'classify' || a?.name === '待归类';
      const bPending = b?.source === 'classify' || b?.name === '待归类';
      if (aPending !== bPending) return aPending ? -1 : 1;
      return compareText(a?.name, b?.name) || compareText(a?.id, b?.id);
    });
  }

  function sortTasks(tasks) {
    return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) => {
      const byActivity = (Number(b?.lastTs) || 0) - (Number(a?.lastTs) || 0);
      return byActivity || compareText(a?.title, b?.title) || compareText(a?.id, b?.id);
    });
  }

  // Full snapshots replace local state. Indexing by canonical taskId makes WS
  // delta replay/reconnect idempotent and automatically prunes cards absent
  // from the latest authoritative snapshot. It deliberately never compares
  // titles or bodies: two explicit user admissions with the same text remain
  // two tasks.
  function reconcileSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const byId = (items) => {
      const map = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        const id = String(item?.id || '').trim();
        if (!id) continue;
        const existing = map.get(id);
        const currentTs = Number(item?.lastTs || item?.updatedAt || item?.createdAt) || 0;
        const existingTs = Number(existing?.lastTs || existing?.updatedAt || existing?.createdAt) || 0;
        if (!existing || currentTs >= existingTs) map.set(id, item);
      }
      return [...map.values()];
    };
    return {
      ...source,
      modules: byId(source.modules),
      tasks: byId(source.tasks),
    };
  }

  function partitionTaskIdentity(tasks) {
    const result = { canonical: [], unresolved: [] };
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (task?.identityState === 'orphaned_admission'
          || task?.identityState === 'legacy_unresolved') {
        result.unresolved.push(task);
      } else {
        result.canonical.push(task);
      }
    }
    return result;
  }

  function statusRegistry() {
    return global.MultiCCStatusPresentation || (typeof require === 'function'
      ? require('./status-presentation.js')
      : null);
  }

  function translate(key) {
    return typeof global.t === 'function' ? global.t(key) : key;
  }

  // Task-card status. The vocabulary, icons, tones and animation policy all come
  // from the shared registry (public/status-presentation.js) — this only keeps the
  // legacy `{done, running}` shape the existing card templates and CSS bind to.
  function taskDisplayState(task) {
    const registry = statusRegistry();
    const status = registry.taskStatus({ status: task?.status, runState: task?.runState });
    const spec = registry.presentation('task', status);
    return {
      key: status,
      status,
      icon: spec.icon,
      tone: spec.tone,
      label: translate(spec.labelKey),
      ariaLabel: translate(spec.ariaKey),
      // `running` gates the blink/spin CSS, so it must follow the registry's
      // spinner policy rather than the status name: error never animates.
      running: spec.spinner,
      done: spec.terminal && status === 'done',
    };
  }

  // Where the card came from. The board mixes two admissions that otherwise
  // look identical on the row: an independent task started from the board (it
  // owns a task-bound session) and a task that surfaced inside an ongoing
  // chat. The server stamps `origin`; older cards fall back to the id shape a
  // board send mints (see legacyTaskOrigin in src/task-board.js).
  function taskOrigin(task) {
    const origin = task?.origin === 'board' || task?.origin === 'session'
      ? task.origin
      : /^tsk-[0-9a-f]{32}$/.test(String(task?.id || '')) ? 'board' : 'session';
    return origin === 'board'
      ? { key: 'board', icon: '\uD83D\uDCCB', label: '\u72EC\u7ACB\u4EFB\u52A1', title: '\u5728\u4EFB\u52A1\u677F\u521B\u5EFA\uFF0C\u8DD1\u5728\u5B83\u81EA\u5DF1\u7684\u4EFB\u52A1\u4F1A\u8BDD\u91CC' }
      : { key: 'session', icon: '\uD83D\uDCAC', label: '\u4F1A\u8BDD\u4EFB\u52A1', title: '\u5728\u4F1A\u8BDD\u5BF9\u8BDD\u4E2D\u4EA7\u751F\u7684\u4EFB\u52A1' };
  }

  function taskRoutingLabel(task) {
    // The task card intentionally hides the Commander→worker routing chip: a card
    // should read as just "新任务 · 进行中" and let its title/runState sync from the
    // worker's own classify. The routing data itself is kept on task.routing (it
    // anchors runState to the worker and drives the detail composer) — this only
    // suppresses the display. Return the old label below to re-enable the chip.
    return '';
    /* eslint-disable no-unreachable */
    const routing = task?.routing;
    if (!routing || routing.mode !== 'commander' || !routing.targetSessionId) return '';
    const id = routing.targetSessionId;
    const label = routing.targetLabel || id;
    const commander = `已交给 Commander · ${label}${label === id ? '' : ` (${id})`}`;
    if (!routing.workerSessionId) return commander;
    const workerId = routing.workerSessionId;
    const workerLabel = routing.workerLabel || workerId;
    const elastic = routing.elasticWorkerCreated ? ' · 动态扩容' : '';
    return `${commander} → ${workerLabel}${workerLabel === workerId ? '' : ` (${workerId})`}${elastic}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[character]));
  }

  // M4 (design D3): the task-side pending-question card and the durable
  // run-summary renderer were the detail modal's UI; both retired with it.
  // The unified chat view renders pending questions (chat-user-input-card.js
  // over the forwarded user_input_* events) and run boundaries (run
  // separators). The server still projects the pending question into the run
  // DTO for other clients (App).
  const api = Object.freeze({
    sessionChatUrl,
    sortModules,
    sortTasks,
    reconcileSnapshot,
    partitionTaskIdentity,
    taskDisplayState,
    taskOrigin,
    taskRoutingLabel,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCTaskBoardUi = api;
})(typeof window !== 'undefined' ? window : globalThis);

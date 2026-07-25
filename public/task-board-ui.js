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

  const api = Object.freeze({ sessionChatUrl, sortModules, sortTasks, taskDisplayState, taskRoutingLabel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCTaskBoardUi = api;
})(typeof window !== 'undefined' ? window : globalThis);

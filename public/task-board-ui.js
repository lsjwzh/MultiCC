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

  function taskDisplayState(task) {
    const status = String(task?.status || 'active');
    const runState = String(task?.runState || 'idle');
    if (status === 'archived') return { key: 'archived', icon: '🗄', label: '已归档', done: false, running: false };
    if (status === 'done' || runState === 'done') return { key: 'done', icon: '✅', label: '已完成', done: true, running: false };
    if (runState === 'running') return { key: 'running', icon: '🟢', label: '进行中', done: false, running: true };
    if (runState === 'waiting') return { key: 'waiting', icon: '⏳', label: '等待中', done: false, running: false };
    if (runState === 'error') return { key: 'error', icon: '❌', label: '异常', done: false, running: false };
    return { key: 'idle', icon: '⚪', label: '待处理', done: false, running: false };
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

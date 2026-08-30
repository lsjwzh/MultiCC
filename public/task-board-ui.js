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

  function sameTaskOrigin(first, second) {
    if (!first || !second) return false;
    return taskOrigin(first).key === taskOrigin(second).key;
  }

  function taskMergeEligibility(task, options) {
    if (!task || !String(task.id || '').trim()) return { ok: false, reason: 'missing_task' };
    if (['running', 'queued', 'waiting'].includes(String(task.runState || ''))) {
      return { ok: false, reason: 'task_busy' };
    }
    if (task.moduleAssignment?.running === true) {
      return { ok: false, reason: 'task_classifying' };
    }
    if (options?.asSource && (task.worktreePath || task.branch)) {
      return { ok: false, reason: 'source_workspace' };
    }
    return { ok: true, reason: null };
  }

  function taskMergeCompatibility(target, candidate, options) {
    const targetState = taskMergeEligibility(target);
    if (!targetState.ok) return targetState;
    const candidateState = taskMergeEligibility(candidate, { asSource: true });
    if (!candidateState.ok) return candidateState;
    if (!sameTaskOrigin(target, candidate)) return { ok: false, reason: 'origin_mismatch' };
    const targetDirId = String(options?.targetDirId || '').trim();
    const candidateDirId = String(options?.candidateDirId || '').trim();
    if (targetDirId && candidateDirId && targetDirId !== candidateDirId) {
      return { ok: false, reason: 'directory_mismatch' };
    }
    return { ok: true, reason: null };
  }

  function taskHomeDirId(task, modules) {
    const module = (Array.isArray(modules) ? modules : [])
      .find(item => item?.id === task?.moduleId);
    return String(module?.dirId || task?.dirIds?.[0] || '').trim() || null;
  }

  // A manual merge is directional: the first selected task survives and every
  // later selection is folded into it. Keep this tiny plan builder shared by
  // both web task-board surfaces so legacy-origin fallback and validation never
  // drift between manage.html and meta.html.
  function taskMergePlan(tasks, options) {
    const selected = [];
    const seen = new Set();
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const id = String(task?.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      selected.push(task);
    }
    const target = selected[0] || null;
    const sources = selected.slice(1);
    const origin = target ? taskOrigin(target) : null;
    if (!target) {
      return { ok: false, reason: 'empty', target, sources, origin, targetId: null, sourceTaskIds: [] };
    }
    const targetState = taskMergeEligibility(target);
    if (!targetState.ok) {
      return {
        ok: false, reason: targetState.reason, target, sources, origin, blockedTask: target,
        targetId: target.id, sourceTaskIds: sources.map(task => task.id),
      };
    }
    const dirIdOf = typeof options?.dirIdOf === 'function' ? options.dirIdOf : () => null;
    const blockedTask = sources.find(task => !taskMergeCompatibility(target, task, {
      targetDirId: dirIdOf(target),
      candidateDirId: dirIdOf(task),
    }).ok);
    if (blockedTask) {
      const compatibility = taskMergeCompatibility(target, blockedTask, {
        targetDirId: dirIdOf(target),
        candidateDirId: dirIdOf(blockedTask),
      });
      return {
        ok: false, reason: compatibility.reason, target, sources, origin, blockedTask,
        targetId: target.id, sourceTaskIds: sources.map(task => task.id),
      };
    }
    return {
      ok: sources.length > 0,
      reason: sources.length ? null : 'too_few',
      target,
      sources,
      origin,
      targetId: target.id,
      sourceTaskIds: sources.map(task => task.id),
    };
  }

  function taskMergeErrorMessage(value) {
    const payload = value && typeof value === 'object' ? value : {};
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    if (note) return note;
    const code = String(typeof value === 'string' ? value
      : payload.error || payload.code || payload.message || '').trim();
    const messages = {
      invalid_merge_request: '合并请求无效，请刷新任务板后重试',
      task_not_found: '有任务已不存在，请刷新后重新选择',
      target_already_merged: '保留任务已被并入其他任务，请刷新后重新选择',
      target_not_mergeable: '保留任务已归档或不可合并',
      source_already_merged: '有待并入任务已合并到其他任务，请刷新后重新选择',
      source_not_mergeable: '有待并入任务已归档或不可合并',
      task_origin_mismatch: '独立任务与会话任务不能互相合并',
      task_directory_mismatch: '暂不支持跨 Fleet 合并任务',
      task_busy: '有任务正在执行、排队或等待，请稍后重试',
      task_worktree_conflict: '待并入任务仍有 worktree/分支；请先清理，或把它作为首个保留任务',
      task_merge_persist_failed: '合并结果保存失败，原任务未变更，请重试',
    };
    if (messages[code]) return messages[code];
    if (/failed to fetch|networkerror|network request failed/i.test(code)) {
      return '网络请求失败，请检查连接后重试';
    }
    // A caller may wrap an already-localized server message in Error before the
    // shared catch path sees it. Preserve that text instead of wrapping it a
    // second time as “任务合并失败（中文文案）”.
    if (/[㐀-鿿]/.test(code)) return code;
    if (code) return `任务合并失败（${code}）`;
    if (payload.status) return `任务合并失败（HTTP ${payload.status}）`;
    return '任务合并失败，请稍后重试';
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
    sameTaskOrigin,
    taskMergeEligibility,
    taskMergeCompatibility,
    taskHomeDirId,
    taskMergePlan,
    taskMergeErrorMessage,
    taskRoutingLabel,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCTaskBoardUi = api;
})(typeof window !== 'undefined' ? window : globalThis);

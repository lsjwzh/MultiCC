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
      taskGroups: byId(source.taskGroups),
    };
  }

  // Resolve presentation-only task families against the currently visible
  // task set. A filtered/archived family with fewer than two visible members is
  // left as ordinary rows; grouping never changes task identity or ordering.
  function partitionTaskGroups(tasks, groups) {
    const source = Array.isArray(tasks) ? tasks : [];
    const taskById = new Map(source.map(task => [String(task?.id || ''), task]));
    const claimed = new Set();
    const related = [];
    const orderedGroups = [...(Array.isArray(groups) ? groups : [])].sort((a, b) =>
      (Number(b?.lastTs || b?.updatedAt) || 0) - (Number(a?.lastTs || a?.updatedAt) || 0)
        || compareText(a?.id, b?.id));
    for (const group of orderedGroups) {
      const members = [];
      for (const taskId of Array.isArray(group?.taskIds) ? group.taskIds : []) {
        const id = String(taskId || '');
        const task = taskById.get(id);
        if (!task || claimed.has(id) || members.includes(task)) continue;
        members.push(task);
      }
      if (members.length < 2) continue;
      const sorted = sortTasks(members);
      for (const task of sorted) claimed.add(String(task.id));
      related.push({ ...group, tasks: sorted });
    }
    return {
      groups: related,
      ungrouped: source.filter(task => !claimed.has(String(task?.id || ''))),
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

  function translate(key, params) {
    return typeof global.t === 'function' ? global.t(key, params) : key;
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

  // Fleet-level activity belongs only to independent board tasks. Session
  // tasks keep their row-level status, but an ordinary chat doing work must not
  // light the Fleet card or the Task Board tab as if a dedicated task run were
  // active. A human-completed board task with stale `runState: running` is also
  // excluded by the shared presentation rule.
  function runningTaskCount(tasks) {
    return (Array.isArray(tasks) ? tasks : []).reduce((count, task) =>
      count + (taskOrigin(task).key === 'board' && taskDisplayState(task).running ? 1 : 0), 0);
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
      ? { key: 'board', icon: '\uD83D\uDCCB', label: translate('tbOriginBoard'), title: translate('tbOriginBoardHint') }
      : { key: 'session', icon: '\uD83D\uDCAC', label: translate('tbOriginSession'), title: translate('tbOriginSessionHint') };
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
      invalid_merge_request: 'tbMergeErrInvalidRequest',
      task_not_found: 'tbMergeErrTaskNotFound',
      target_already_merged: 'tbMergeErrTargetAlreadyMerged',
      target_not_mergeable: 'tbMergeErrTargetNotMergeable',
      source_already_merged: 'tbMergeErrSourceAlreadyMerged',
      source_not_mergeable: 'tbMergeErrSourceNotMergeable',
      task_origin_mismatch: 'tbMergeErrOriginMismatch',
      task_directory_mismatch: 'tbMergeErrDirectoryMismatch',
      task_busy: 'tbMergeErrBusy',
      task_worktree_conflict: 'tbMergeErrWorktreeConflict',
      task_merge_persist_failed: 'tbMergeErrPersistFailed',
    };
    if (messages[code]) return translate(messages[code]);
    if (/failed to fetch|networkerror|network request failed/i.test(code)) {
      return translate('tbMergeErrNetwork');
    }
    // A caller may wrap an already-localized server message in Error before the
    // shared catch path sees it. Preserve that text instead of wrapping it a
    // second time as “任务合并失败（中文文案）”.
    if (/[㐀-鿿]/.test(code)) return code;
    if (code) return translate('tbMergeErrFailedWith', { code });
    if (payload.status) return translate('tbMergeErrFailedHttp', { status: payload.status });
    return translate('tbMergeErrGeneric');
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
    // 这一块眼下被上面那句 return '' 挡住了，但文案照样走词典：谁哪天把 chip 放回来，
    // 不该顺手把两行中文带回英文界面。
    const commander = `${translate('tbRoutingCommander', { label })}${label === id ? '' : ` (${id})`}`;
    if (!routing.workerSessionId) return commander;
    const workerId = routing.workerSessionId;
    const workerLabel = routing.workerLabel || workerId;
    const elastic = routing.elasticWorkerCreated ? translate('tbRoutingElastic') : '';
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
    partitionTaskGroups,
    partitionTaskIdentity,
    taskDisplayState,
    runningTaskCount,
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

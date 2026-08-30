'use strict';

function aggregateTaskUsages(taskId, usages) {
  const totals = {
    freshInput: 0, cacheRead: 0, cacheWrite: 0,
    consumedInput: 0, output: 0, reasoning: 0, total: 0,
  };
  const executionStatuses = {};
  const dimensions = new Map();
  let runCount = 0;
  let observedEvents = 0;
  let unobservableEvents = 0;
  const accountingModes = new Set();
  let breakdownMayOverlapTotal = false;
  for (const usage of usages) {
    if (!usage) continue;
    runCount += Number(usage.runCount) || 0;
    observedEvents += Number(usage.observedEvents) || 0;
    unobservableEvents += Number(usage.unobservableEvents) || 0;
    for (const key of Object.keys(totals)) totals[key] += Number(usage.tokens?.[key]) || 0;
    for (const [status, count] of Object.entries(usage.executionStatuses || {})) {
      executionStatuses[status] = (executionStatuses[status] || 0) + (Number(count) || 0);
    }
    const usageRunCount = Number(usage.runCount) || 0;
    if (usageRunCount > 0 && usage.accountingMode) accountingModes.add(usage.accountingMode);
    if (usageRunCount > 0 && usage.breakdownMayOverlapTotal) breakdownMayOverlapTotal = true;
    for (const dimension of usage.dimensions || []) {
      const key = [dimension.providerId, dimension.model, dimension.roleKind, dimension.routeName].join('\0');
      if (!dimensions.has(key)) dimensions.set(key, {
        providerId: dimension.providerId,
        providerName: dimension.providerName,
        model: dimension.model,
        roleKind: dimension.roleKind,
        routeName: dimension.routeName,
        freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
        observedEvents: 0, unobservableEvents: 0,
      });
      const aggregate = dimensions.get(key);
      for (const field of [
        'freshInput', 'cacheRead', 'cacheWrite', 'output', 'reasoning',
        'observedEvents', 'unobservableEvents',
      ]) aggregate[field] += Number(dimension[field]) || 0;
    }
  }
  return {
    taskId,
    runCount,
    executionStatuses,
    coverage: observedEvents > 0 ? (unobservableEvents > 0 ? 'partial' : 'observed') : 'unobservable',
    hasKnownUsage: observedEvents > 0,
    isLowerBound: observedEvents > 0 && unobservableEvents > 0,
    observedEvents,
    unobservableEvents,
    tokens: totals,
    accountingMode: accountingModes.size <= 1
      ? (accountingModes.values().next().value || 'additive') : 'mixed',
    breakdownMayOverlapTotal,
    dimensions: [...dimensions.values()],
  };
}

function restoreBoardInPlace(board, snapshot) {
  const restoreRecords = (current, previous) => {
    for (const id of Object.keys(current)) {
      if (!Object.prototype.hasOwnProperty.call(previous, id)) delete current[id];
    }
    for (const [id, record] of Object.entries(previous)) {
      if (!current[id] || typeof current[id] !== 'object') {
        current[id] = record;
        continue;
      }
      for (const key of Object.keys(current[id])) delete current[id][key];
      Object.assign(current[id], record);
    }
  };
  restoreRecords(board.modules, snapshot.modules || {});
  restoreRecords(board.tasks, snapshot.tasks || {});
}

function createTaskMergeHandler({
  board,
  core,
  taskRuns,
  getSessionRunState,
  isOpenTaskRun,
  activeTaskOperations,
  taskIdentityIds,
  resolvedTask,
  taskDto,
  persist,
  notify,
  logger,
}) {
  function taskMergeBusy(task) {
    if (!task) return false;
    if (taskIdentityIds(task).some(id => activeTaskOperations.has(id))) return true;
    if (task.moduleAssignment?.running === true) return true;
    const projection = core.buildBoardDto({
      modules: board.modules,
      tasks: { [task.id]: task },
    }, getSessionRunState).tasks[0];
    if (['queued', 'running', 'waiting'].includes(projection?.runState)) return true;
    if (!taskRuns) return false;
    try {
      return taskIdentityIds(task).some(identityId => (
        taskRuns.listTaskRuns(identityId).some(isOpenTaskRun)
      ));
    } catch (_) {
      // Identity changes fail closed when durable run state is unavailable.
      return true;
    }
  }

  function taskHasWorktree(task) {
    return taskIdentityIds(task).some(identityId => {
      const member = board.tasks[identityId];
      return !!(member?.worktreePath || member?.branch);
    });
  }

  return function handleMergeTasks(req, res) {
    const targetTaskId = String(req.params?.targetTaskId || '').trim();
    const rawSources = req.body?.sourceTaskIds;
    if (!targetTaskId || !Array.isArray(rawSources)
        || !rawSources.length || rawSources.length > 100
        || rawSources.some(id => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ error: 'invalid_merge_request' });
    }
    const sourceTaskIds = [...new Set(rawSources.map(id => id.trim()))];
    const previousBoard = JSON.parse(JSON.stringify(board));
    const nextBoard = core.normalizeBoard(JSON.parse(JSON.stringify(board)));
    const mergedAt = Date.now();
    const merged = core.mergeTasks(nextBoard, { targetTaskId, sourceTaskIds, now: mergedAt });
    if (!merged.ok) {
      const status = merged.error === 'invalid_merge_request' ? 400
        : merged.error === 'task_not_found' ? 404 : 409;
      return res.status(status).json({
        error: merged.error,
        ...(merged.taskId ? { taskId: merged.taskId } : {}),
      });
    }
    // An idempotent replay stays read-only even if the target has since become busy.
    if (!merged.changed) {
      const target = resolvedTask(targetTaskId);
      return res.json({
        ok: true,
        targetTaskId: target.id,
        mergedTaskIds: [],
        alreadyMergedTaskIds: merged.alreadyMergedTaskIds,
        task: taskDto(target),
      });
    }

    const target = board.tasks[targetTaskId];
    const newSources = merged.mergedTaskIds.map(id => board.tasks[id]).filter(Boolean);
    const busy = [target, ...newSources].find(taskMergeBusy);
    if (busy) return res.status(409).json({ error: 'task_busy', taskId: busy.id });
    const worktreeSource = newSources.find(taskHasWorktree);
    if (worktreeSource) {
      return res.status(409).json({
        error: 'task_worktree_conflict',
        taskId: worktreeSource.id,
        note: '请先清理该来源任务的 worktree，或把它选为第一个保留任务',
      });
    }

    // Mutate the existing graph so handlers holding task references see tombstones.
    const committed = core.mergeTasks(board, { targetTaskId, sourceTaskIds, now: mergedAt });
    if (!committed.ok || !committed.changed) {
      restoreBoardInPlace(board, previousBoard);
      return res.status(409).json({ error: committed.error || 'task_merge_conflict' });
    }
    try {
      persist();
    } catch (error) {
      restoreBoardInPlace(board, previousBoard);
      logger.log(`[multicc/taskboard] task merge save failed: ${error?.message || error}`);
      return res.status(500).json({ error: 'task_merge_persist_failed' });
    }
    notify(null, committed.touched, 'merged');
    return res.json({
      ok: true,
      targetTaskId: committed.taskId,
      mergedTaskIds: committed.mergedTaskIds,
      alreadyMergedTaskIds: committed.alreadyMergedTaskIds,
      task: taskDto(board.tasks[committed.taskId]),
    });
  };
}

module.exports = { aggregateTaskUsages, createTaskMergeHandler };

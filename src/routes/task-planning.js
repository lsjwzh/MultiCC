'use strict';

const planning = require('../task-planning');

function responseStatus(error) {
  if (error === 'task_not_found') return 404;
  if (error === 'persistence_failed') return 500;
  if (['revision_conflict', 'task_not_planned', 'task_archived', 'task_exists',
    'move_anchor_not_found', 'invalid_move_anchor_order', 'invalid_move_anchor',
    'record_type_immutable'].includes(error)) return 409;
  return 400;
}

function expectedRevision(body) {
  return body?.expectedRevision ?? body?.revision;
}

function createTaskPlanningRuntime({
  getBoard,
  commitMutation,
  taskDto,
  resolveTask,
  taskDirId,
  notify,
  beforeStageChange = async () => ({ ok: true }),
  hasDirectory = null,
  logger = console,
} = {}) {
  if (typeof getBoard !== 'function' || typeof commitMutation !== 'function'
      || typeof taskDto !== 'function' || typeof resolveTask !== 'function') {
    throw new Error('[task-planning] invalid runtime ports');
  }
  const operationTails = new Map();

  async function withTaskLock(taskId, work) {
    const id = String(taskId || '');
    const previous = operationTails.get(id) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    operationTails.set(id, tail);
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (operationTails.get(id) === tail) operationTails.delete(id);
    }
  }

  function fail(res, result) {
    return res.status(responseStatus(result?.error)).json(result || { error: 'invalid_request' });
  }

  function success(res, task) {
    const board = getBoard();
    return res.json({ ok: true, task: taskDto(task), revision: board.revision });
  }

  function createInput(body) {
    const input = { ...(body && typeof body === 'object' ? body : {}) };
    const sourceId = String(input.sourceTaskId || '').trim();
    if (!sourceId) return { ok: true, input };
    const source = resolveTask(sourceId);
    if (!source) return { ok: false, error: 'task_not_found' };
    const sourceDirId = taskDirId(source);
    return {
      ok: true,
      input: {
        title: source.title,
        description: source.description || source.title,
        dirId: sourceDirId,
        priority: source.priority ?? null,
        dueAt: source.dueAt ?? null,
        acceptanceCriteria: source.acceptanceCriteria || '',
        ...input,
        recordType: 'planned',
      },
    };
  }

  function handleCreate(req, res) {
    const prepared = createInput(req.body);
    if (!prepared.ok) return fail(res, prepared);
    const dirId = String(prepared.input.dirId || '').trim();
    if (dirId && typeof hasDirectory === 'function' && !hasDirectory(dirId)) {
      return res.status(409).json({ error: 'directory_not_found' });
    }
    const committed = commitMutation(candidate => planning.createPlannedTask(candidate, prepared.input));
    if (!committed.ok) return fail(res, committed);
    const task = getBoard().tasks[committed.taskId];
    notify(task.dirId, [task.id], 'created');
    return success(res, task);
  }

  async function prepareStageChange(task, stage) {
    if (!stage || stage === task.workflowStage || stage !== 'done') return { ok: true };
    return beforeStageChange(task, stage);
  }

  async function handleUpdate(req, res) {
    const task = resolveTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.dirId !== undefined && typeof hasDirectory === 'function'
        && !hasDirectory(String(body.dirId || '').trim())) {
      return res.status(409).json({ error: 'directory_not_found' });
    }
    const probe = planning.updatePlannedTask(
      JSON.parse(JSON.stringify(getBoard())), task.id, body,
      { expectedRevision: expectedRevision(body) },
    );
    if (!probe.ok) return fail(res, probe);
    const prepared = await prepareStageChange(task, body.workflowStage);
    if (!prepared?.ok) return res.status(prepared.status || 409)
      .json(prepared.body || { error: prepared.error || 'stage_change_blocked' });
    const committed = commitMutation(candidate => planning.updatePlannedTask(
      candidate,
      task.id,
      body,
      { expectedRevision: expectedRevision(body) },
    ));
    if (!committed.ok) return fail(res, committed);
    const updated = getBoard().tasks[committed.taskId];
    notify(updated.dirId, [updated.id]);
    return success(res, updated);
  }

  async function handleMove(req, res) {
    const task = resolveTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const probe = planning.movePlannedTask(
      JSON.parse(JSON.stringify(getBoard())), task.id, body,
      { expectedRevision: expectedRevision(body) },
    );
    if (!probe.ok) return fail(res, probe);
    const prepared = await prepareStageChange(task, body.workflowStage);
    if (!prepared?.ok) return res.status(prepared.status || 409)
      .json(prepared.body || { error: prepared.error || 'stage_change_blocked' });
    const committed = commitMutation(candidate => planning.movePlannedTask(
      candidate,
      task.id,
      body,
      { expectedRevision: expectedRevision(body) },
    ));
    if (!committed.ok) return fail(res, committed);
    const moved = getBoard().tasks[committed.taskId];
    notify(moved.dirId, [moved.id]);
    return success(res, moved);
  }

  function wrap(handler, label) {
    return (req, res) => Promise.resolve(handler(req, res)).catch(error => {
      logger.log(`[multicc/task-planning] ${label} failed: ${error?.message || error}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  }

  function mountRoutes(app) {
    app.post('/api/task-board/tasks', wrap(handleCreate, 'create'));
    app.post('/api/task-board/tasks/:taskId/update', wrap(
      (req, res) => withTaskLock(req.params.taskId, () => handleUpdate(req, res)), 'update'));
    // Compatibility alias for early planning clients.
    app.post('/api/task-board/tasks/:taskId/planning', wrap(
      (req, res) => withTaskLock(req.params.taskId, () => handleUpdate(req, res)), 'update'));
    app.post('/api/task-board/tasks/:taskId/move', wrap(
      (req, res) => withTaskLock(req.params.taskId, () => handleMove(req, res)), 'move'));
  }

  return Object.freeze({ mountRoutes, handleCreate, handleUpdate, handleMove });
}

module.exports = { createTaskPlanningRuntime };

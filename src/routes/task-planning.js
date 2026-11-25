'use strict';

const planning = require('../task-board/planning');
const { cloneBoard } = require('../native/task-domain');
const { defaultStatus, codes } = require('../../native/core/src/task_planning_status.json');
const planningStatuses = new Map(Object.entries(codes));

function responseStatus(error) {
  return planningStatuses.get(error) ?? defaultStatus;
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
  afterRename = null,
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
    if (source.status === 'archived' || source.deleting) return { ok: false, error: 'task_archived' };
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
      cloneBoard(getBoard()), task.id, body,
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
      cloneBoard(getBoard()), task.id, body,
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

  async function handleRename(req, res) {
    const task = resolveTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const committed = commitMutation(candidate => planning.renameTask(
      candidate, task.id, body.title,
    ));
    if (!committed.ok) return fail(res, committed);
    const updated = getBoard().tasks[committed.taskId];
    if (typeof afterRename === 'function') {
      try { await afterRename(updated); }
      catch (error) { logger.log(`[multicc/task-planning] title sync failed: ${error?.message || error}`); }
    }
    notify(taskDirId(updated), [updated.id], 'renamed');
    return success(res, updated);
  }

  // 五条 planning 路由（含 `/planning` 兼容别名）已由 Rust 前门独占；路径匹配、
  // 请求体读取、`responseStatus()` 的状态码阶梯与 `{ok,task,revision}` 信封都在
  // native/gateway/src/app/task_routes.rs 与 native/core/src/task_routes.rs。
  // 这里保留处理器本身和按任务的串行锁，供回环宿主端口
  // （src/routes/task-routes-host.js）调用；处理器仍用 `res.status().json(...)`
  // 表达结果，宿主端口用捕获器取走。
  return Object.freeze({ withTaskLock, handleCreate, handleUpdate, handleRename, handleMove });
}

module.exports = { createTaskPlanningRuntime, responseStatus, expectedRevision };

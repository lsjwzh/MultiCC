'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const core = require('../../native/binding').taskBoardCore;
const planning = require('../../task-board/planning');
const { recentTaskIds } = require('../../task-board/native-bridge');
const { taskAttention: attention, createTaskBoardRepository } = require('../../native/task-domain');
const { isVoiceRouterRecord } = require('../../native/binding').voiceRouter;
const { runStateForFreezeReason } = require('../../native/binding').sessionWork;
const { runStateForClassify: runStateForLetter } = require('../../classify/vocab');
const { createTaskWorktreeService } = require('../../task-worktree');
const { createTaskRetention } = require('../../task-board/retention');
const { createTaskPlanningRuntime } = require('../task-planning');
const { openBoardStore } = require('../../task-board/board-store');
const { createBoardTaskLifecycle } = require('../../task-board/lifecycle');
const { createTaskRelocate } = require('../../task-board/relocate');
const { getNative } = require('../../native/binding');

function assertTaskBoardDeps(deps) { return getNative().taskBoardAssertDeps(deps); }

function createTaskBoardRuntime(deps) {
  assertTaskBoardDeps(deps);
  const { file, records, auxQueue, loadHistory, dispatchToSession, sendSessionMessage,
    workspaceBroadcast, isSystemInjected, getSessionRunState } = deps;
  const native = getNative();
  const logger = deps.logger || console;
  const repository = deps.taskBoardRepository || createTaskBoardRepository(file);
  const loaded = repository.load();
  if (loaded.restored) logger.log('[multicc/taskboard] restored planning board from v2 recovery sidecar');
  if (loaded.quarantined?.length) (logger.warn || logger.log).call(logger,
    `[multicc/taskboard] quarantined ${loaded.quarantined.length} unreadable board file(s): ${loaded.quarantined.join(', ')}`);
  const boardStore = openBoardStore({ raw: loaded.raw, repository, logger });
  const board = boardStore.board;
  const activeTaskOperations = new Map();
  const resolveSessionQueue = typeof deps.resolveSessionQueue === 'function'
    ? deps.resolveSessionQueue : async () => ({ ok: false, code: 'no_active_task' });
  const createSessionRecord = typeof deps.createSessionRecord === 'function' ? deps.createSessionRecord : null;
  const resolveDirectoryPort = deps.directories instanceof Map ? id => deps.directories.get(id)
    : typeof deps.directories === 'function' ? deps.directories : null;
  const ports = { native, deps, records, board, boardStore, activeTaskOperations, core, planning,
    attention, crypto, logger, recentTaskIds, loadHistory, workspaceBroadcast, getSessionRunState,
    resolveSessionQueue, createSessionRecord, resolveDirectoryPort, runStateForFreezeReason,
    runStateForLetter, isVoiceRouterRecord };
  Object.assign(ports, native.taskBoardStateApi(ports), native.taskBoardProjectionApi(ports),
    native.taskBoardLifecycleApi(ports));
  const { save, resolvedTask, taskIdentityIds, holdTaskOperation, notify, updateBoardTask,
    taskDto, ensureTaskIndex, ensureBoundChatSession, commitPlanningMutation } = ports;
  const taskDirId = task => core.taskDirId(board, task);
  const getBoard = () => board;
  const taskWorktree = resolveDirectoryPort && typeof deps.gitWorktreeAdd === 'function' &&
    typeof deps.gitWorktreeRemove === 'function' && typeof deps.gitMergeBack === 'function'
    ? createTaskWorktreeService({
      ...native.taskBoardWorktreePorts(ports), getDirectory: resolveDirectoryPort, taskDirIdOf: taskDirId,
      updateTask: (id, patch) => updateBoardTask(id, patch, { requirePersist: true }),
      gitWorktreeAdd: deps.gitWorktreeAdd, gitWorktreeRemove: deps.gitWorktreeRemove, gitMergeBack: deps.gitMergeBack,
      existsSync: typeof deps.existsSync === 'function' ? deps.existsSync : fs.existsSync,
      beginTaskOperation: holdTaskOperation, logger,
    }) : null;

  const classification = new native.TaskBoardClassification();
  const classificationPorts = {
    board, records, core, recentTaskIds, loadHistory, isSystemInjected, resolvedTask, save, notify,
    noteRunState: attention.noteRunState, randomUUID: () => crypto.randomUUID(),
    cancel: id => auxQueue.cancel(id),
    enqueue(message, ref, taskId, jobId) {
      const job = auxQueue.enqueue(message);
      Promise.resolve(job).then(result => classification.complete(classificationPorts, taskId, jobId, ref, result))
        .catch(error => classification.rejected(classificationPorts, taskId, jobId, error));
    },
    logFailure: (action, taskId, error) => logger.log(`[multicc/taskboard] classify ${action} for ${taskId}: ${error?.message || error}`),
    logGoal: (taskId, session, phase) => logger.log(`[multicc/taskboard] onClassifyGoal: updated task ${taskId} for ${session} phase=${phase || '?'}`),
  };
  Object.assign(ports, { classification, classificationPorts });
  const scanPendingClassifications = (now = Date.now()) => classification.scan(classificationPorts, now);
  const taskLifecycle = createBoardTaskLifecycle({ deps, getBoard, resolveTask: resolvedTask, taskIdentityIds,
    commit: commitPlanningMutation, taskDto, notify, taskDirId, activeOperations: activeTaskOperations });
  const isTaskBusy = id => taskLifecycle.isBusy(id);
  const retention = createTaskRetention({ getBoard, records, getPinnedTaskIds: () => deps.getPinnedTaskIds(),
    getRunState: id => getSessionRunState(id), isSessionBusy: id => deps.isSessionBusy?.(id) === true,
    isTaskBusy: id => isTaskBusy(id) || !!activeTaskOperations.get(id), taskDirId, taskLineageIds: taskIdentityIds,
    prepareDelete: (task, ids, options) => deps.prepareTaskDelete(task, ids, options),
    deleteById: (id, options) => taskLifecycle.deleteById(id, options) });
  const taskRelocate = createTaskRelocate({ deps, resolveTask: resolvedTask, taskIdentityIds, commit: commitPlanningMutation,
    taskDto, notify, taskDirId, isBusy: isTaskBusy, logger });
  const planningRuntime = createTaskPlanningRuntime({ getBoard, commitMutation: commitPlanningMutation, taskDto,
    resolveTask: resolvedTask, taskDirId, notify, afterRename: typeof deps.syncTaskTitle === 'function' ? deps.syncTaskTitle : null,
    hasDirectory: resolveDirectoryPort ? id => !!resolveDirectoryPort(id) : null,
    beforeStageChange: task => ports.resolveLegacySessionQueues(task, '当前任务仍在执行；请先取消，或等待其进入冻结状态后再移动到已完成。'), logger });
  const followupPorts = { board, core, planning, records, crypto, logger, loadHistory, resolvedTask, ensureBoundChatSession,
    sendSessionMessage, save, notify, isTaskBusy, buildTaskRunContext: deps.buildTaskRunContext };
  const startPorts = { board, core, records, crypto, logger, createSessionRecord, ensureBoundChatSession,
    sendSessionMessage, dispatchToSession, ensureTaskIndex, updateBoardTask, save, notify };
  Object.assign(ports, { taskLifecycle, retention, taskRelocate, planningRuntime, followupPorts, startPorts });
  const routePorts = native.taskBoardRoutePorts(ports);
  const startupTimer = setTimeout(() => scanPendingClassifications(), 1_000);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  return Object.freeze({
    registerShellTask: ports.registerShellTask, routePorts, isTaskLifecycleBusy: isTaskBusy,
    evictOldestSafeTask: (dirId, list, atCapacity, excludedIds) => retention.evict(dirId, list, atCapacity, excludedIds),
    onMessagePersisted: ports.onMessagePersisted, onQueueEvent: ports.onQueueEvent,
    reconcileRunState: ports.reconcileRunState, recordRouterAdmission: ports.recordRouterAdmission,
    onTurnEnd(cs, sessionName) {
      try { native.taskBoardTurnEnd(classificationPorts, sessionName, cs); }
      catch (e) { logger.log(`[multicc/taskboard] onTurnEnd error: ${e?.message || e}`); }
    },
    onClassifyGoal(sessionName, goal, phase, turn = {}) {
      try { native.taskBoardClassifyGoal(classificationPorts, sessionName, goal, phase, turn); }
      catch (e) { logger.log(`[multicc/taskboard] onClassifyGoal error: ${e?.message || e}`); }
    },
    onTaskAttributionSettled: (name, id, messages = [], meta = {}) => classification.settled(classificationPorts, name, id, messages, meta),
    linkRelatedTasks: native.taskBoardLinkRelated.bind(null, { board, groupRelatedTasks: core.groupRelatedTasks, save, notify, now: Date.now }),
    reassignTurnTask: ports.reassignTurnTask, scanPendingClassifications, routeCommanderInput: ports.routeCommanderInput,
    routeCommanderFollowup: ports.routeCommanderFollowup, markTaskSeen: ports.markTaskSeen, getBoard, save,
    archiveTasks: ports.archiveTasks, taskWorktree,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

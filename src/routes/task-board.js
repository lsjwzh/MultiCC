'use strict';

// Task-board runtime: persistence, classification, dispatch and REST wiring.

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board/core');
const planning = require('../task-board/planning');
const { recentTaskIds } = require('../task-board/native-bridge');
const attention = require('../native/task-domain').taskAttention;
const { isVoiceRouterRecord } = require('../voice/router');
const { runStateForFreezeReason } = require('../session-work/scheduler');
const { runStateForClassify: runStateForLetter } = require('../classify/vocab');
const { createTaskWorktreeService } = require('../task-worktree');
const { createTaskRetention } = require('../task-board/retention');
const { createTaskPlanningRuntime } = require('./task-planning');
const { openBoardStore } = require('../task-board/board-store');
const { getNative } = require('../native/runtime');

function assertTaskBoardDeps(deps) { return getNative().taskBoardAssertDeps(deps); }

function createTaskBoardRuntime(deps) {
  assertTaskBoardDeps(deps);
  const {
    file, auxQueue, records, loadHistory, dispatchToSession,
    sendSessionMessage,
    workspaceBroadcast, atomicWriteJson, isSystemInjected,
    getSessionRunState,
  } = deps;
  const resolveSessionQueue = typeof deps.resolveSessionQueue === 'function'
    ? deps.resolveSessionQueue
    : async () => ({ ok: false, code: 'no_active_task' });
  // P1 task-bound hidden sessions: creates ordinary chat records carrying the
  // taskBoundTaskId marker. Optional in reduced hosts/tests — without it the
  // chat-session endpoint answers an explicit 501 instead of crashing.
  const createSessionRecord = typeof deps.createSessionRecord === 'function'
    ? deps.createSessionRecord : null;
  const logger = deps.logger || console;

  const repository = deps.taskBoardRepository || require('../native/task-domain').createTaskBoardRepository(file);
  const loaded = repository.load();
  if (loaded.restored) logger.log('[multicc/taskboard] restored planning board from v2 recovery sidecar');
  if (loaded.quarantined?.length) {
    (logger.warn || logger.log).call(logger,
      `[multicc/taskboard] quarantined ${loaded.quarantined.length} unreadable board file(s): ${loaded.quarantined.join(', ')}`);
  }
  // 任务板常驻 Rust：规则调用只上送变更，落盘直接写常驻副本（见 board-store.js）。
  const boardStore = openBoardStore({ raw: loaded.raw, repository, logger });
  const board = boardStore.board;
  const persistWithRecovery = expectedRevision => {
    // preserve：磁盘 revision 被外部写者推高时不丢改动，先备份磁盘主档再改写 revision。
    const persisted = boardStore.persist(expectedRevision);
    if (persisted?.conflict) {
      (logger.warn || logger.log).call(logger,
        `[multicc/taskboard] revision conflict: disk=${persisted.conflict.diskRevision}, backup=${persisted.conflict.backup}`);
    }
    return persisted;
  };

  function save() {
    const previousRevision = Number(board.revision) || 0;
    board.schemaVersion = planning.TASK_BOARD_SCHEMA_VERSION;
    board.revision = previousRevision + 1;
    try {
      const persisted = persistWithRecovery(previousRevision);
      if (Number.isFinite(Number(persisted?.revision))) board.revision = Number(persisted.revision);
      return true;
    } catch (e) {
      board.revision = previousRevision;
      logger.log(`[multicc/taskboard] save failed: ${e.message}`);
      return false;
    }
  }

  // 规划类变更在活板上就地执行、落盘成功才算数；任何失败按前像回滚（含 revision），
  // 与旧的"整板深拷贝候选 → 落盘 → 回填"对外语义一致。
  function commitPlanningMutation(mutate) {
    return boardStore.transaction(rollback => {
      let result;
      try { result = mutate(board); }
      catch (error) { rollback(); return { ok: false, error: error?.code || 'invalid_request' }; }
      if (!result?.ok) { rollback(); return result || { ok: false, error: 'invalid_request' }; }
      const previousRevision = Number(board.revision) || 0;
      board.schemaVersion = planning.TASK_BOARD_SCHEMA_VERSION;
      board.revision = previousRevision + 1;
      try {
        const persisted = persistWithRecovery(previousRevision);
        if (Number.isFinite(Number(persisted?.revision))) board.revision = Number(persisted.revision);
      } catch (error) {
        logger.log(`[multicc/taskboard] planning save failed: ${error?.message || error}`);
        rollback();
        return { ok: false, error: 'persistence_failed' };
      }
      return { ...result, taskId: result.task?.id || null };
    });
  }

  function resolvedTask(taskId) {
    return core.resolveTask(board, String(taskId || ''));
  }

  function taskIdentityIds(task) {
    return task ? core.taskLineageIds(board, task.id) : [];
  }

  const activeTaskOperations = new Map();
  function holdTaskOperation(taskId) {
    const task = resolvedTask(taskId);
    const id = task?.id || String(taskId || '').trim();
    if (!id) return () => {};
    activeTaskOperations.set(id, (activeTaskOperations.get(id) || 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const next = (activeTaskOperations.get(id) || 1) - 1;
      if (next > 0) activeTaskOperations.set(id, next);
      else activeTaskOperations.delete(id);
    };
  }

  function notify(dirId, taskIds, kind) {
    // Directory broadcasts also mirror to Meta; created drives locate animation.
    const payload = { type: 'task_board_update', taskIds };
    if (kind) payload.kind = kind;
    const dirs = new Set();
    if (dirId) dirs.add(dirId);
    for (const id of Array.isArray(taskIds) ? taskIds : []) {
      const task = board.tasks[id];
      if (!task) continue;
      let resolved = null;
      try { resolved = core.taskDirId(board, task); } catch (_) { resolved = null; }
      if (resolved) dirs.add(resolved);
    }
    // No known directory: Meta still gets it (dirId=null is the Meta-only path).
    try {
      if (!dirs.size) workspaceBroadcast(null, payload);
      else for (const dir of dirs) workspaceBroadcast(dir, payload);
    } catch (_) {}
  }

  // Optional per-task worktree service.
  function updateBoardTask(id, patch, { requirePersist = false } = {}) {
    const task = board.tasks[id];
    if (!task) return;
    const previous = { ...task };
    Object.assign(task, patch);
    task.updatedAt = Date.now();
    if (!save() && requirePersist) {
      for (const key of Object.keys(task)) delete task[key];
      Object.assign(task, previous);
      throw Object.assign(new Error('task state could not be persisted'), { code: 'TASK_PERSISTENCE_FAILED' });
    }
    notify(null, [id]);
  }
  const resolveDirectoryPort = deps.directories instanceof Map
    ? dirId => deps.directories.get(dirId)
    : (typeof deps.directories === 'function' ? deps.directories : null);
  const taskWorktree = (resolveDirectoryPort
    && typeof deps.gitWorktreeAdd === 'function'
    && typeof deps.gitWorktreeRemove === 'function'
    && typeof deps.gitMergeBack === 'function')
    ? createTaskWorktreeService({
        // A merged source is a historical alias, never a workspace owner. An
        // old tab must not be able to create a fresh worktree on its tombstone.
        getBoardTask: id => {
          const task = Object.prototype.hasOwnProperty.call(board.tasks, id)
            ? board.tasks[id] : null;
          return task && !task.mergedInto ? task : null;
        },
        updateTask: (id, patch) => updateBoardTask(id, patch, { requirePersist: true }),
        getDirectory: resolveDirectoryPort,
        taskDirIdOf: task => core.taskDirId(board, task),
        gitWorktreeAdd: deps.gitWorktreeAdd,
        gitWorktreeRemove: deps.gitWorktreeRemove,
        gitMergeBack: deps.gitMergeBack,
        existsSync: typeof deps.existsSync === 'function' ? deps.existsSync : fs.existsSync,
        beginTaskOperation: holdTaskOperation,
        withCleanup: async (task, remove, complete) => {
          if (typeof deps.withTaskWorktreeCleanup === 'function') return deps.withTaskWorktreeCleanup(task, remove, complete);
          if ([...records.values()].some(record => record.worktreePath === task.worktreePath)) {
            return { ok: false, code: 'workspace_cleanup_unavailable' };
          }
          return complete(await remove({}));
        },
        logger,
      })
    : null;


  // The transcript projections are native-owned. The member views passed
  // across the bridge keep the retired helpers' exact board reads: one
  // `board.tasks[taskId]` per identity id in Set order, then `refs` and
  // `routing` on that member object (the native side re-reads the view's own
  // properties with the retired read counts).
  function transcriptArgs(task, identityIdsOverride = null) {
    const identityIds = [...new Set(identityIdsOverride || taskIdentityIds(task))];
    const members = identityIds.map(taskId => {
      const member = board.tasks[taskId];
      return member ? { refs: member.refs, routing: member.routing } : null;
    });
    return { identityIds, members };
  }

  function canonicalMessages(task, identityIdsOverride = null) {
    const { identityIds, members } = transcriptArgs(task, identityIdsOverride);
    return getNative().taskBoardCanonicalMessages(members, identityIds, loadHistory);
  }

  function canonicalTaskBody(task) {
    const { identityIds, members } = transcriptArgs(task);
    return getNative().taskBoardCanonicalTaskBody(
      members, identityIds, task, loadHistory, core.messageText);
  }
  function ensureTaskIndex({
    taskId, dirId, sessionId, routing, taskText = '', origin = null, now = Date.now(),
  }) {
    const rawExisting = board.tasks[taskId];
    const existing = rawExisting ? resolvedTask(taskId) : null;
    const task = existing || core.createPendingTask(board, {
      taskId, dirId, sessionId, taskText, origin, now,
    });
    if (!task) return { task: null, created: false };
    // A board send persists its taskStart message before it indexes the card,
    // so onMessagePersisted can win the race and create the card first. Both
    // callers read the origin off the same trusted taskSource, so re-stamping
    // is idempotent whichever one got there first.
    if (core.TASK_ORIGINS.has(origin) && task.origin !== origin) task.origin = origin;
    if (sessionId && !(task.refs || []).some(ref => ref.sessionId === sessionId)) {
      core.addRefToTask(task, {
        sessionId, dirId, userMsgId: null, assistantMsgId: null,
        ts: now, excerpt: '',
      }, now);
    }
    if (routing) core.setTaskRouting(task, routing);
    return { task, created: !rawExisting };
  }

  function onMessagePersisted(sessionId, message) {
    try {
      if (!message?.taskId || !message.role) return false;
      const rec = records.get(sessionId);
      if (!rec || rec.type === 'commander' || rec.type === 'aux' || rec.type === 'gateway') return false;
      let task = resolvedTask(message.taskId);
      const created = !task && message.role === 'user' && message.taskStart === true;
      if (created) {
        task = ensureTaskIndex({
          taskId: message.taskId,
          dirId: rec.dirId || null,
          sessionId,
          taskText: message.taskText || core.messageText(message),
          origin: core.taskOriginForSource(message.taskSource),
          now: message.ts || Date.now(),
        }).task;
      }
      if (!task) return false;
      const identityIds = new Set(taskIdentityIds(task));
      const history = loadHistory(sessionId) || [];
      const index = history.findIndex(candidate => candidate?.id === message.id);
      let userMessage = message.role === 'user' ? message : null;
      if (!userMessage && index !== -1) {
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const candidate = history[cursor];
          if (candidate?.role === 'user' && identityIds.has(candidate.taskId)) {
            userMessage = candidate;
            break;
          }
        }
      }
      let changed = core.addRefToTask(task, {
        sessionId,
        dirId: rec.dirId || null,
        userMsgId: userMessage?.id || null,
        assistantMsgId: message.role === 'assistant' ? message.id || null : null,
        ts: message.ts || Date.now(),
        excerpt: '',
      }, message.ts || Date.now());
      if (task.titleSource !== 'manual' && task.title === core.PENDING_TASK_TITLE && userMessage) {
        const derived = core.deriveTaskTitle(userMessage.taskText || core.messageText(userMessage));
        if (derived !== core.PENDING_TASK_TITLE) {
          task.title = derived;
          task.updatedAt = message.ts || Date.now();
          changed = true;
        }
      }
      const stateChanged = message.role === 'user' && task.runState !== 'running';
      if (stateChanged) {
        task.runState = 'running';
      }
      if (created || changed || stateChanged) {
        save();
        notify(rec.dirId || null, [task.id], created ? 'created' : undefined);
      }
      return true;
    } catch (error) {
      logger.log(`[multicc/taskboard] canonical projection failed: ${error?.message || error}`);
      return false;
    }
  }

  function recordRouterAdmission(admission = {}) {
    const caller = records.get(admission.callerSessionId);
    const worker = records.get(admission.targetSessionId);
    const taskId = String(admission.taskId || '').trim();
    const operationId = String(admission.operationId || '').trim();
    const globalVoiceRoute = isVoiceRouterRecord(caller) && caller.dirId == null;
    const sameDirectory = !!caller?.dirId && caller.dirId === worker?.dirId;
    // Ordinary sessions and Commanders remain confined to their own Fleet. A
    // Host-owned Voice Router is the one capability allowed here to project a
    // worker admission across Fleets; that card belongs to the *worker's* Fleet.
    // This mirrors router-tool-runtime's admission boundary without turning the
    // task board into a second dispatcher.
    if (!caller || !worker || !taskId || !operationId
        || (!sameDirectory && !globalVoiceRoute)
        || !worker.dirId
        || worker.type === 'aux' || worker.type === 'gateway' || worker.type === 'commander') {
      return false;
    }
    const existing = board.tasks[taskId];
    if (existing?.routing?.operationId
        && existing.routing.operationId === operationId) return true;
    const commanderRoute = caller.type === 'commander';
    const indexed = ensureTaskIndex({
      taskId,
      dirId: worker.dirId || null,
      sessionId: worker.id || admission.targetSessionId,
      taskText: admission.taskText || '',
      routing: {
        mode: commanderRoute ? 'commander' : 'router-tool',
        callerSessionId: caller.id || admission.callerSessionId || null,
        targetSessionId: commanderRoute
          ? (caller.id || admission.callerSessionId)
          : (worker.id || admission.targetSessionId),
        workerSessionId: worker.id || admission.targetSessionId,
        // The card observes the already-durable dispatch; it must retain the
        // exact operation id returned by that admission, never mint another one.
        operationId,
        status: admission.status || 'admitted',
        oneWay: admission.resultMode !== 'tool',
        routedAt: Date.now(),
      },
    });
    if (!indexed.task) return false;
    indexed.task.runState = admission.status === 'running' ? 'running' : 'queued';
    save();
    notify(worker.dirId || null, [taskId], indexed.created ? 'created' : undefined);
    return true;
  }

  // Aux 返回宿主 Promise。Rust 持有作业身份并消费回执，同步广播仍使用本看板的存储。
  const classification = new (getNative().TaskBoardClassification)();
  const classificationPorts = {
    board, records, core, recentTaskIds, loadHistory, isSystemInjected, resolvedTask, save, notify,
    noteRunState: attention.noteRunState,
    randomUUID: () => crypto.randomUUID(),
    cancel: jobId => auxQueue.cancel(jobId),
    enqueue(message, ref, taskId, jobId) {
      const job = auxQueue.enqueue(message);
      Promise.resolve(job)
        .then(result => classification.complete(classificationPorts, taskId, jobId, ref, result))
        .catch(error => classification.rejected(classificationPorts, taskId, jobId, error));
    },
    logFailure: (action, taskId, error) =>
      logger.log(`[multicc/taskboard] classify ${action} for ${taskId}: ${error?.message || error}`),
    logGoal: (taskId, session, phase) =>
      logger.log(`[multicc/taskboard] onClassifyGoal: updated task ${taskId} for ${session} phase=${phase || '?'}`),
  };

  function scanPendingClassifications(now = Date.now()) {
    return classification.scan(classificationPorts, now);
  }

  function onTaskAttributionSettled(sessionName, taskId, messages = [], meta = {}) {
    return classification.settled(classificationPorts, sessionName, taskId, messages, meta);
  }

  const linkRelatedTasks = getNative().taskBoardLinkRelated.bind(null, {
    board, groupRelatedTasks: core.groupRelatedTasks, save, notify, now: Date.now,
  });

  // Turn-end hook — called from classifyTurnEnd alongside the classify pass.
  // Only task-aware canonical messages participate. Ordinary chats are not
  // inferred into tasks; legacy marker records remain attachable for migration.
  function onTurnEnd(cs, sessionName) {
    try {
      getNative().taskBoardTurnEnd(classificationPorts, sessionName, cs);
    } catch (e) {
      logger.log(`[multicc/taskboard] onTurnEnd error: ${e?.message || e}`);
    }
  }

  // Aux may discover after persistence that the latest turn starts a genuinely
  // new task (or continues an older task in this session). Move the exact turn
  // ref between canonical task ids; title similarity never merges identity.
  function reassignTurnTask(sessionName, oldTaskId, newTaskId, messages = [], meta = {}) {
    try {
      if (!newTaskId || oldTaskId === newTaskId) return false;
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway' || rec.type === 'commander') return false;
      // A task-bound room is the resume file for one explicit board identity.
      // Intent attribution may rename/classify it, but must never split that
      // identity or leave the binding attached to a different card.
      if (rec.taskBoundTaskId && newTaskId !== rec.taskBoundTaskId) return false;
      const userMsg = messages.find(message => message?.role === 'user') || null;
      const assistantMsg = [...messages].reverse().find(message => message?.role === 'assistant') || null;
      const messageIds = new Set(messages.map(message => message?.id).filter(Boolean));
      const oldTask = oldTaskId ? resolvedTask(oldTaskId) : null;
      let oldChanged = false;
      if (oldTask && messageIds.size) {
        const before = oldTask.refs.length;
        oldTask.refs = oldTask.refs.filter(ref =>
          !messageIds.has(ref.userMsgId) && !messageIds.has(ref.assistantMsgId));
        oldChanged = oldTask.refs.length !== before;
        if (oldChanged) oldTask.updatedAt = Date.now();
      }

      const indexed = ensureTaskIndex({
        taskId: newTaskId,
        dirId: rec.dirId || null,
        sessionId: sessionName,
        taskText: meta.taskText || userMsg?.content || '',
        now: userMsg?.ts || Date.now(),
      });
      const task = indexed.task;
      if (!task) return false;
      const now = Date.now();
      let changed = core.addRefToTask(task, {
        sessionId: sessionName,
        dirId: rec.dirId || null,
        userMsgId: userMsg?.id || null,
        assistantMsgId: assistantMsg?.id || null,
        ts: assistantMsg?.ts || userMsg?.ts || now,
        excerpt: '',
      }, now);
      const title = String(meta.taskName || '').trim().slice(0, 40);
      if (task.titleSource !== 'manual' && title && task.title !== title) {
        task.title = title;
        task.updatedAt = now;
        changed = true;
      }
      if (!changed && !oldChanged && !indexed.created) return false;
      save();
      notify(rec.dirId || null, [newTaskId, ...(oldTaskId ? [oldTaskId] : [])]);
      // A provisional card can lose its only turn when Aux decides this is a new
      // canonical task. Do not leave that zero-ref shell behind as a permanent
      // missing_context row.
      if (oldTask && oldChanged && oldTask.refs.length === 0
          && oldTask.moduleAssignment && oldTask.status !== 'archived'
          && oldTask.origin === 'session' && !oldTask.chatSessionId
          && !oldTask.routing && !oldTask.worktreePath && !oldTask.branch) {
        classification.archiveMissing(classificationPorts, oldTask);
      }
      return true;
    } catch (error) {
      logger.log(`[multicc/taskboard] reassignTurnTask error: ${error?.message || error}`);
      return false;
    }
  }

  // classify enriches the already-indexed task selected by canonical taskId.
  // It never creates a task for marker-less/ordinary chat.
  function onClassifyGoal(sessionName, goal, phase, turn = {}) {
    try {
      getNative().taskBoardClassifyGoal(classificationPorts, sessionName, goal, phase, turn);
    } catch (e) {
      logger.log(`[multicc/taskboard] onClassifyGoal error: ${e?.message || e}`);
    }
  }

  // A task-bound worker session runs exactly one task for its entire life, so
  // every queue event it emits belongs to that task. Per-turn lineage alone is
  // not enough: an E verdict (cancel, abnormal end) ends the turn that carried
  // the taskId, and the next turn is admitted with taskId null — its 'started'
  // event would then find no task and the card would stay frozen on the
  // cancelled verdict while the session is visibly running again. Both
  // directions must agree; a half-released binding attributes nothing.
  function boundTaskId(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    const bound = records.get(id)?.taskBoundTaskId;
    if (typeof bound !== 'string' || !bound) return '';
    const boundTask = board.tasks[bound];
    if (boundTask?.chatSessionId !== id) return '';
    return resolvedTask(bound)?.id || '';
  }

  // `claim_released` 是「调度器把一次占用交还回来」，不是「有东西在排队」——
  // 两者被当成同一件事，就是卡片永远停在「排队中」的原因：delivery_deferred
  // 的投递重试每分钟 claimed → claim_released 各一次，每次 release 都把卡片刷
  // 成「排队中」，而事件自己写着 queued:0 / queuedItems:[]。重试停下之后没人再
  // 写这张卡，它就把最后那一笔「排队」一直挂下去。事件里带着 release 之后调度
  // 器的真实样子；整条事件类型→runState 分支链在
  // native/core/src/task_board_queue.rs（活值查表仍走下方宿主回调）。

  function onQueueEvent(event = {}) {
    const taskId = String(event.taskId || '') || boundTaskId(event.sessionId);
    const task = taskId ? resolvedTask(taskId) : null;
    if (!task) return { ok: false, code: 'task_not_found' };
    const type = String(event.type || '');
    // A one-way routed card is executed by its worker alone (view
    // taskRunSessionIds). Another session's queue events carrying this taskId
    // — the dispatcher waking on the worker's result — are not this run.
    if (type !== 'reconcile' && core.foreignRunSession(task, event.sessionId)) {
      return { ok: true, changed: false, code: 'foreign_session_event' };
    }
    let runState = null;
    if (type === 'queued' && event.workKind !== 'task') {
      return { ok: true, changed: false };
    }
    // 事件类型→runState 的整条分支链（completed 的 turnOutcome 显式投影、
    // reconcile 的正式重发布、frozen/claim_released 的冻结原因映射）在
    // native/core/src/task_board_queue.rs；冻结原因与分类字母的活值查表仍以
    // 宿主回调传入，JS 值同一性与异常行为不变。`completed` 只是调度簿记，
    // 永不改 task.status；能标记完成的只有 handleStatus 的用户动作。
    runState = getNative().taskBoardQueueRunState(type, event,
      runStateForFreezeReason, runStateForLetter);
    if (!runState) return { ok: true, changed: false };
    // Monotonic guard: a heartbeat that was already in flight when the turn
    // reached a terminal verdict must not resurrect `running`. `at` is the
    // scheduler's own clock; reconcile carries the newest one by construction.
    const at = Number(event.at) || Date.now();
    if (task.runStateAt && at < task.runStateAt && type !== 'reconcile') {
      return { ok: true, changed: false, code: 'stale_queue_event' };
    }
    if (task.runState === runState && type !== 'reconcile') {
      task.runStateAt = Math.max(task.runStateAt || 0, at);
      return { ok: true, changed: false };
    }
    const changed = task.runState !== runState;
    if (changed) attention.noteRunState(task, task.runState, runState);
    task.runState = runState;
    task.runStateAt = Math.max(task.runStateAt || 0, at);
    task.updatedAt = Date.now();
    if (task.routing) {
      task.routing.status = runState;
      task.routing.freezeReason = event.freezeReason || null;
    }
    save();
    const dirId = core.taskDirId(board, task);
    notify(dirId || null, [task.id]);
    return { ok: true, changed, republished: !changed };
  }

  // Re-publish the canonical run state for a task through the same reducer the
  // scheduler feeds. Callers submit the classify verdict; they never assemble a
  // broadcast themselves.
  function reconcileRunState(taskId, { classifyState = null, reason = '' } = {}) {
    return onQueueEvent({
      type: 'reconcile',
      taskId,
      classifyState,
      reason,
      at: Date.now(),
    });
  }

  // ── REST ──────────────────────────────────────────────────────────────────
  // Authentication/authorization is owned by the app-level API gate, which is
  // mounted before this runtime. Task-board mutations are ordinary product
  // operations and must work for authenticated remote administrators; do not
  // add a transport-locality check here.

  // 卡片自愈的证据：会话记录里拿不出受理物证 = 这一轮从来没被受理过（见
  // task-board/core.js 的 sessionHasTurn / deadDispatchClaim）。读侧把这类卡片的
  // 乐观「执行中」投影成空闲 —— 只影响这一份 DTO，卡片本身与落盘数据都不动。
  const sessionHasTurn = sessionId => core.sessionHasTurn(records.get(sessionId));

  function taskDto(task) {
    const dto = core.buildBoardDto({
      modules: board.modules,
      tasks: { [task.id]: task },
      taskGroups: board.taskGroups,
    }, getSessionRunState, { sessionHasTurn }).tasks[0];
    dto.mergedTaskCount = Math.max(0, taskIdentityIds(task).length - 1);
    Object.assign(dto, getNative().taskDisplayFields(task, deps.taskShortCode));
    const body = canonicalTaskBody(task);
    if (dto.title === core.PENDING_TASK_TITLE && body.text) {
      dto.title = core.deriveTaskTitle(body.text);
    }
    dto.body = body.text;
    dto.bodyMessageId = body.messageId;
    dto.bodySessionId = body.sessionId;
    dto.legacy = body.legacy;
    dto.identityState = body.text
      ? body.legacy ? 'legacy' : 'canonical'
      : task.routing?.operationId ? 'orphaned_admission' : 'legacy_unresolved';
    if (dto?.routing) {
      dto.routing.targetLabel = records.get(dto.routing.targetSessionId)?.label || dto.routing.targetSessionId;
      if (dto.routing.workerSessionId) {
        const worker = records.get(dto.routing.workerSessionId);
        if (worker?.taskExecutionSlot === true) {
          delete dto.routing.workerSessionId;
          dto.routing.internalExecution = true;
        } else {
          dto.routing.workerLabel = worker?.label || dto.routing.workerSessionId;
        }
      }
    }
    dto.sessionIds = (dto.sessionIds || [])
      .filter(sessionId => records.get(sessionId)?.taskExecutionSlot !== true);
    attachBoundWorkspace(dto);
    return dto;
  }

  function attachBoundWorkspace(dto) {
    if (deps.taskShellTaskAccess) Object.assign(dto, deps.taskShellTaskAccess(board.tasks[dto.id] || dto));
    const bound = dto?.chatSessionId && records.get(dto.chatSessionId);
    dto.workspaceState = !bound ? null
      : ['hibernated', 'hibernating', 'thawing'].includes(bound.workspaceState) ? 'hibernated' : 'awake';
    dto.lastWorkAt = bound?.lastWorkAt || bound?.createdAt || null;
    dto.hibernatedAt = bound?.hibernatedAt || null;
    return dto;
  }

  const followupPorts = { board, core, planning, records, crypto, logger, loadHistory,
    resolvedTask, ensureBoundChatSession, sendSessionMessage, save, notify,
    isTaskBusy: id => taskLifecycle.isBusy(id), buildTaskRunContext: deps.buildTaskRunContext };

  async function sendBoundSessionFollowupUnlocked(owner, input) {
    return owner.sent(input, await owner.send(input));
  }

  async function sendBoundSessionFollowup(owner, input) {
    const release = holdTaskOperation(input.task.id);
    try { return await sendBoundSessionFollowupUnlocked(owner, input); }
    finally { release(); }
  }

  async function routeCommanderFollowup(commanderId, taskId, text, options = {}) {
    const owner = getNative().TaskBoardFollowup;
    const input = owner.prepare(followupPorts, commanderId, taskId, text, options);
    if (input.ok === false) return input;
    const failure = owner.bound(input, await input.pending);
    if (failure) return failure;
    return sendBoundSessionFollowup(owner, input);
  }

  const startPorts = { board, core, records, crypto, logger, createSessionRecord,
    ensureBoundChatSession, sendSessionMessage, dispatchToSession, ensureTaskIndex, updateBoardTask, save, notify };

  // 会话端口仍返回宿主 Promise。Rust 在每个 await 的两侧读取活卡片，
  // 旧工作会话的异常映射只覆盖派发和回执装饰，写板异常继续向上传播。
  async function dispatchTaskStartUnlocked(start, input) {
    const route = start.route(input);
    if (route.kind === 'bind') {
      const send = start.bound(input, await route.pending);
      if (send.kind === 'send') return start.sent(input, await send.pending);
      return send.result;
    }
    if (route.kind === 'worker') {
      let receipt;
      try {
        const delivery = start.worker(input);
        receipt = delivery.kind === 'dispatch'
          ? start.receipt(input, await delivery.pending)
          : delivery.result;
      } catch (error) {
        receipt = start.failure(error);
      }
      return start.complete(input, receipt);
    }
    return route.result;
  }

  async function dispatchTaskStart(start, input) {
    const release = holdTaskOperation(input.taskId);
    try { return await dispatchTaskStartUnlocked(start, input); }
    finally { release(); }
  }

  async function routeCommanderInput(commanderId, text, options = {}) {
    const start = getNative().TaskBoardStart;
    const input = start.prepare(startPorts, commanderId, text, options);
    if (input.ok === false) return input;
    return dispatchTaskStart(start, input);
  }

  // Legacy (non-slot) sessions keep their own active-task queue entry; a
  // stopped run must release it or the session stays occupied by a dead run.
  async function resolveLegacySessionQueues(task, note) {
    const routedWorker = task.routing?.workerSessionId;
    const sessionIds = routedWorker
      ? [routedWorker]
      : [...new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean))];
    for (const sessionId of sessionIds) {
      if (records.get(sessionId)?.taskExecutionSlot === true) continue;
      const resolved = await resolveSessionQueue(sessionId, task.id);
      if (resolved && resolved.ok === false
          && !['no_active_task', 'active_task_mismatch'].includes(resolved.code)) {
        return { ok: false, status: 409, body: {
          error: resolved.code || 'queue_resolution_failed',
          note,
        } };
      }
    }
    return { ok: true };
  }

  // Get or create the task's 1:1 hidden chat, healing dangling bindings.
  async function ensureBoundChatSessionUnlocked(task, { dirId = null, runtime = null, adoptOrigin = false } = {}) {
    // Resolution-only paths (live binding, reverse heal, origin adoption) need
    // no creation port; the guard lives on the create branch so a reduced
    // host can still follow up on tasks that are already bound.
    const boundId = typeof task.chatSessionId === 'string' ? task.chatSessionId : '';
    if (boundId && records.get(boundId)) {
      return { ok: true, sessionId: boundId, created: false };
    }
    // Reverse heal: a record already carrying this task's marker (e.g. a
    // previous attempt crashed between CREATE and card persist) is reused,
    // never duplicated — the binding is 1:1 over retries by construction.
    if (!boundId && typeof records?.values === 'function') {
      for (const rec of records.values()) {
        if (rec?.taskBoundTaskId === task.id) {
          if (board.tasks[task.id] && !board.tasks[task.id].chatSessionId) {
            updateBoardTask(task.id, { chatSessionId: rec.id });
          }
          return { ok: true, sessionId: rec.id, created: false };
        }
      }
    }
    // A click may adopt the newest live ordinary session that owns the task.
    if (adoptOrigin && typeof records?.get === 'function') {
      const refs = [...(task.refs || [])]
        .filter(ref => ref?.sessionId)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      for (const ref of refs) {
        const rec = records.get(ref.sessionId);
        if (!rec || rec.kind !== 'chat') continue;
        if (rec.taskExecutionSlot || rec.taskBoundTaskId) continue;
        if (!sessionTranscriptHoldsTask(ref.sessionId, task.id)) continue;
        return { ok: true, sessionId: rec.id, created: false, adopted: true };
      }
    }
    const resolvedDirId = dirId || core.taskDirId(board, task);
    const dir = resolvedDirId && resolveDirectoryPort ? resolveDirectoryPort(resolvedDirId) : null;
    if (!dir) return { ok: false, code: 'directory_not_found' };
    if (!createSessionRecord) return { ok: false, code: 'chat_session_unavailable' };
    // Inherit the directory commander's runtime (cli/model/provider/effort)
    // exactly like elastic workers do, so the bound session runs what the
    // fleet runs; commander-less directories fall back to host defaults.
    // Composer picks (runtime) override the inheritance at creation only —
    // once bound, the session's runtime is the resume file's, changed solely
    // through the ordinary per-session settings.
    const commander = core.resolveDirectoryCommander(records, resolvedDirId);
    const commanderRec = commander.ok ? commander.record : null;
    // Runtime fields are cli-scoped: a provider/effort/model configured for
    // one CLI is invalid or meaningless on another. Inherit the commander's
    // picks only when the final cli matches its cli (#37a — a commander that
    // switched CLI must not poison bound-session CREATEs into a validator
    // rejection); otherwise the host defaults apply.
    const cli = runtime?.cli || commanderRec?.cli || 'claude';
    const inheritCommander = !commanderRec || commanderRec.cli === cli;
    // An Auto pick carries a pool instead of a provider id: leave `provider`
    // unset so createSessionRecord derives the concrete manual fallback from
    // the pool's primary candidate (the rule the chat picker already follows).
    const autoSelection = runtime?.providerSelection || null;
    const created = await createSessionRecord({
      dir,
      cli,
      kind: 'chat',
      label: `任务 · ${String(task.title || '').slice(0, 40)}`,
      model: runtime?.model ?? (inheritCommander ? commanderRec?.model || null : null),
      provider: autoSelection && !runtime?.provider
        ? undefined
        : (runtime?.provider ?? (inheritCommander ? commanderRec?.provider || '' : '')),
      ...(autoSelection ? { providerSelection: autoSelection } : {}),
      effort: inheritCommander ? commanderRec?.effort || null : null,
      taskBoundTaskId: task.id,
      persistence: 'required',
      persistenceSource: 'runtime.task-chat-session-create',
    });
    if (!created?.ok) {
      return { ok: false, code: created?.error || 'chat_session_create_failed' };
    }
    updateBoardTask(task.id, { chatSessionId: created.id });
    return { ok: true, sessionId: created.id, created: true };
  }

  async function ensureBoundChatSession(task, options = {}) {
    const release = holdTaskOperation(task?.id);
    try { return await ensureBoundChatSessionUnlocked(task, options); }
    finally { release(); }
  }

  // Adopt only sessions whose transcript still owns this task; reads fail open.
  function sessionTranscriptHoldsTask(sessionId, taskId) {
    try {
      const task = resolvedTask(taskId);
      const identityIds = new Set(task ? taskIdentityIds(task) : [taskId]);
      return (loadHistory(sessionId) || []).some(message => identityIds.has(message?.taskId));
    } catch (_) {
      return true;
    }
  }

  // Return the task-bound ordinary chat used by the unified task view.
  async function handleChatSession(req, res) {
    if (!createSessionRecord) {
      return res.status(501).json({ error: 'chat_session_unavailable' });
    }
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    if (deps.taskShellTaskEntry) { const entry = await deps.taskShellTaskEntry(task.id); if (entry.readOnly) return res.json({ ...entry, sessionId: null }); }
    const bound = await ensureBoundChatSession(task, { adoptOrigin: true });
    if (!bound.ok) {
      const status = bound.code === 'chat_session_unavailable' ? 501
        : bound.code === 'directory_not_found' ? 409 : 502;
      return res.status(status).json({ error: bound.code });
    }
    return res.json({ ok: true, sessionId: bound.sessionId, created: bound.created,
      ...(bound.adopted ? { adopted: true } : {}) });
  }

  async function handleStatusUnlocked(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const status = String(req.body?.status || '');
    if (!['active', 'done', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    const expectedPlanningRevision = req.body?.expectedRevision ?? req.body?.revision;
    const planningRevisionAtStart = task.recordType === 'planned'
      ? planning.planningRevision(task.planningRevision) : null;
    if (planningRevisionAtStart != null && expectedPlanningRevision != null) {
      const checked = planning.validateExpectedRevision(task, expectedPlanningRevision);
      if (!checked.ok) {
        const code = checked.error === 'revision_conflict' ? 409 : 400;
        return res.status(code).json(checked);
      }
    }
    const beforeMutation = JSON.parse(JSON.stringify(task));
    if (status === 'done') {
      // Done is a lifecycle finalization: legacy queues resolve even when the
      // task has only plain session refs.
      const queues = await resolveLegacySessionQueues(task,
        '当前任务仍在执行；请先取消，或等待其进入冻结状态后再明确标记完成。');
      if (!queues.ok) return res.status(queues.status).json(queues.body);
    }
    if (planningRevisionAtStart != null
        && planning.planningRevision(task.planningRevision) !== planningRevisionAtStart) {
      return res.status(409).json({
        error: 'revision_conflict',
        expectedRevision: planningRevisionAtStart,
        actualRevision: planning.planningRevision(task.planningRevision),
      });
    }
    task.status = status;
    const statusAt = Date.now();
    task.updatedAt = statusAt;
    const stageChanged = planning.alignStageWithStatus(task, status, statusAt, board);
    if (planningRevisionAtStart != null && !stageChanged) {
      task.planningRevision = planningRevisionAtStart + 1;
    }
    // Archiving only changes lifecycle visibility; the task still owns its history.
    const releasedSessions = 0;
    if (!save()) {
      for (const key of Object.keys(task)) delete task[key];
      Object.assign(task, beforeMutation);
      return res.status(500).json({ error: 'persistence_failed' });
    }
    const mod = task.moduleId ? board.modules[task.moduleId] : null;
    notify(mod?.dirId || null, [task.id]);
    res.json({
      ok: true,
      releasedSession: releasedSessions > 0,
      releasedSessions,
      task: taskDto(task),
      revision: board.revision,
    });
  }

  async function handleStatus(req, res) {
    if (!['active', 'done', 'archived'].includes(req.body?.status)) return res.status(400).json({ error: 'invalid_status' });
    if (req.body?.status === 'archived') return taskLifecycle.archive(req, res);
    if (resolvedTask(req.params?.taskId)?.status === 'archived' && req.body?.status === 'active') return taskLifecycle.restore(req, res);
    if (rejectShellOperation(req, res)) return;
    const release = holdTaskOperation(req.params?.taskId); try { return await handleStatusUnlocked(req, res); }
    finally { release(); }
  }

  function rejectShellOperation(req, res) {
    const task = resolvedTask(req.params?.taskId);
    if (taskLifecycle.isBusy(task?.id)) { res.status(409).json({ error: 'task_busy' }); return true; }
    if (task?.status === 'archived' || task?.deleting) { res.status(409).json({ error: task.deleting ? 'task_deleting' : 'task_archived' }); return true; }
    if (task && deps.taskShellTaskAccess?.(task)?.readOnly) { res.status(409).json({ error: 'task_board_read_only' }); return true; }
    if (!deps.isTaskShellSession?.(resolvedTask(req.params?.taskId)?.chatSessionId)) return false;
    res.status(409).json({ error: 'task_shell_route_required' }); return true;
  }

  const taskLifecycle = require('../task-board/lifecycle').createBoardTaskLifecycle({ deps, getBoard: () => board,
    resolveTask: resolvedTask, taskIdentityIds, commit: commitPlanningMutation, taskDto, notify,
    taskDirId: task => core.taskDirId(board, task), activeOperations: activeTaskOperations });
  const retention = createTaskRetention({ getBoard: () => board, records,
    getPinnedTaskIds: () => deps.getPinnedTaskIds(), getRunState: id => getSessionRunState(id),
    isSessionBusy: id => deps.isSessionBusy?.(id) === true,
    isTaskBusy: id => taskLifecycle.isBusy(id) || !!activeTaskOperations.get(id),
    taskDirId: task => core.taskDirId(board, task), taskLineageIds: task => taskIdentityIds(task),
    prepareDelete: (task, ids, options) => deps.prepareTaskDelete(task, ids, options),
    deleteById: (id, options) => taskLifecycle.deleteById(id, options) });

  // Air 任务「移动」：编排会话工作区搬迁（带未提交改动）、shell 指针与板块记录。
  const taskRelocate = require('../task-board/relocate').createTaskRelocate({ deps, resolveTask: resolvedTask,
    taskIdentityIds, commit: commitPlanningMutation, taskDto, notify, taskDirId: task => core.taskDirId(board, task), isBusy: id => taskLifecycle.isBusy(id), logger });

  const planningRuntime = createTaskPlanningRuntime({
    getBoard: () => board,
    commitMutation: commitPlanningMutation,
    taskDto,
    resolveTask: resolvedTask,
    taskDirId: task => core.taskDirId(board, task),
    notify, afterRename: typeof deps.syncTaskTitle === 'function' ? deps.syncTaskTitle : null,
    hasDirectory: resolveDirectoryPort ? dirId => !!resolveDirectoryPort(dirId) : null,
    beforeStageChange: task => resolveLegacySessionQueues(task,
      '当前任务仍在执行；请先取消，或等待其进入冻结状态后再移动到已完成。'),
    logger,
  });

  // 任务板的 11 条公开路由（5 条 planning、2 条保留策略、status、DELETE、
  // relocate、chat-session）已由 Rust 前门独占；路径匹配、参数解码、状态码
  // 决策树与响应信封都在 native/gateway/src/app/task_routes.rs 与
  // native/core/src/task_routes.rs。这里保留 Node 独有的事实：任务库写入、
  // 任务锁、聊天会话绑定、保留策略预检与会话索引，以及处理器原样写
  // `res.status().json(...)` 的形态 —— 宿主端口（src/routes/task-routes-host.js）
  // 用捕获器取走 body，交给 Rust 决定最终信封。
  function fakeRequest({ taskId = '', dirId = '', body = undefined } = {}) {
    return { params: { taskId, dirId }, body };
  }

  // 与退休的 mountRoutes 内联 catch 逐字一致：同一行日志、同一个兜底 body。
  function guardedRoute(label, run) {
    return (context, res) => Promise.resolve()
      .then(() => run(context, res))
      .catch(error => {
        logger.log(`[multicc/taskboard] ${label} failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
  }

  const retentionRoute = handler => async (context, res) => {
    try {
      const dirId = context.dirId;
      if (!deps.directories?.get(dirId)) return res.status(404).json({ ok: false, code: 'directory_not_found' });
      if (typeof deps.listShellTasks !== 'function') return res.status(503).json({ ok: false, code: 'task_inventory_unavailable' });
      return res.json({ ok: true, ...await handler(dirId, () => deps.listShellTasks(), context) });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, code: error.code || 'retention_failed' });
    }
  };

  const routePorts = Object.freeze({
    planningCreate: (context, res) => planningRuntime.handleCreate(fakeRequest(context), res),
    planningUpdate: (context, res) => planningRuntime.withTaskLock(context.taskId,
      () => planningRuntime.handleUpdate(fakeRequest(context), res)),
    planningRename: (context, res) => planningRuntime.withTaskLock(context.taskId,
      () => planningRuntime.handleRename(fakeRequest(context), res)),
    planningMove: (context, res) => planningRuntime.withTaskLock(context.taskId,
      () => planningRuntime.handleMove(fakeRequest(context), res)),
    retentionPreview: retentionRoute((dirId, list) => retention.preview(dirId, list)),
    retentionDelete: retentionRoute((dirId, list, context) =>
      retention.deleteSelected(dirId, list, context.body?.taskIds)),
    status: guardedRoute('status update', (context, res) => handleStatus(fakeRequest(context), res)),
    delete: (context, res) => taskLifecycle.delete(fakeRequest(context), res),
    relocate: guardedRoute('relocate', (context, res) => taskRelocate.relocate(fakeRequest(context), res)),
    chatSession: guardedRoute('chat-session', (context, res) => handleChatSession(fakeRequest(context), res)),
  });

  // Recover interrupted module assignment and retire already-confirmed stale
  // cards once after startup. Fresh automatic work is driven by the settled
  // task-attribution hook, so startup never floods the shared serial Aux lane.
  const startupTimer = setTimeout(() => scanPendingClassifications(), 1_000);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  return Object.freeze({
    registerShellTask: input => commitPlanningMutation(draft => {
      if (draft.deletedTaskIds?.includes(input.id)) return { ok: false, error: 'task_deleted' };
      let task = draft.tasks[input.id];
      if (task && (task.mergedIntoTaskId || (task.chatSessionId && task.chatSessionId !== input.sessionId))) {
        return { ok: false, error: 'task_identity_conflict' };
      }
      task ||= core.createPendingTask(draft, { taskId: input.id, dirId: input.dirId,
        sessionId: input.sessionId, taskText: input.title, origin: 'manual', now: input.createdAt });
      if (!task) return { ok: false, error: 'task_index_failed' };
      task.chatSessionId = input.sessionId;
      task.ownerShellId = input.ownerShellId; task.forkedFromTaskId = input.forkedFromTaskId || null;
      if (input.ownerShellId && !input.forkedFromTaskId && !task.routing) task.origin = 'session';
      core.setTaskRouting(task, { mode: 'task-bound', workerSessionId: input.sessionId, oneWay: true });
      return { ok: true };
    }),
    routePorts, isTaskLifecycleBusy: id => taskLifecycle.isBusy(id),
    evictOldestSafeTask: (dirId, listShellTasks, atCapacity, excludedIds) => retention.evict(dirId, listShellTasks, atCapacity, excludedIds),
    onMessagePersisted,
    onQueueEvent,
    reconcileRunState,
    recordRouterAdmission,
    onTurnEnd,
    onClassifyGoal,
    onTaskAttributionSettled,
    linkRelatedTasks,
    reassignTurnTask,
    scanPendingClassifications,
    routeCommanderInput,
    routeCommanderFollowup,
    // Someone put the task on screen: its unseen result is consumed for every
    // client. Writes (and broadcasts) only when that actually cleared a mark.
    markTaskSeen: taskId => {
      const task = resolvedTask(String(taskId || ''));
      if (!attention.markSeen(task)) return false;
      save();
      notify(core.taskDirId(board, task) || null, [task.id]);
      return true;
    },
    // test/introspection surface
    getBoard: () => board,
    save,
    // Batch archive for host-owned one-time data migrations (cron fan-out
    // cleanup). It is not a route: the same "never touch a running task" rule
    // as the lifecycle endpoints applies, and all ids land in one board write
    // because a legacy board can hold hundreds of residue tasks.
    archiveTasks: async taskIds => {
      const wanted = [...new Set((taskIds || []).map(id => String(id || '')).filter(Boolean))];
      const ids = wanted.filter(id => {
        const task = board.tasks[id];
        if (!task || task.status === 'archived' || task.deleting) return false;
        if (taskLifecycle.isBusy(id)) return false;
        return true;
      });
      const skipped = wanted.filter(id => !ids.includes(id)).map(taskId => ({ taskId, error: 'task_busy_or_missing' }));
      if (!ids.length) return { ok: true, archived: [], skipped };
      const result = commitPlanningMutation(draft => {
        const at = Date.now();
        for (const id of ids) {
          const task = draft.tasks[id];
          if (task.status !== 'archived') task.archivedFromStatus = task.status;
          task.status = 'archived';
          task.updatedAt = at;
          if (task.recordType === 'planned') task.planningRevision = (task.planningRevision || 1) + 1;
        }
        return { ok: true };
      });
      if (!result?.ok) {
        return { ok: false, archived: [], skipped: wanted.map(taskId => ({ taskId, error: result?.error || 'persistence_failed' })) };
      }
      notify(null, ids);
      return { ok: true, archived: ids, skipped };
    },
    // M3: null unless git deps were injected — callers must feature-check.
    taskWorktree,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

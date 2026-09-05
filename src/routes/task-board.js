'use strict';

// Task-board runtime: persistence, classification, dispatch and REST wiring.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('../task-board');
const planning = require('../task-planning');
const { createPaths } = require('../paths');
const { isVoiceRouterRecord } = require('../voice-router');
const { runStateForFreezeReason } = require('../session-work-scheduler');
const { classifyDisplay } = require('../classify/vocab');
const { publicRunDto } = require('./task-runs');
const {
  buildTaskRunContext: defaultBuildTaskRunContext,
  isTaskRunWrapperText,
} = require('../task-run-context');
const { recordRunError, runErrorOf } = require('../task-run-errors');
const { createTaskWorktreeService } = require('../task-worktree');
const {
  taskTranscriptMessages,
  paginateTranscript,
} = require('../task-transcript-repository');
const {
  aggregateTaskUsages,
  createTaskMergeHandler,
} = require('../task-board-merge-runtime');
const { assertTaskBoardDeps, createRelatedTaskLinker } = require('../task-board-runtime-helpers');
const { createTaskPlanningRuntime } = require('./task-planning');

function createTaskBoardRuntime(deps) {
  assertTaskBoardDeps(deps);
  const {
    file, auxQueue, records, loadHistory, dispatchToSession,
    sendSessionMessage,
    workspaceBroadcast, atomicWriteJson, isSystemInjected,
    getSessionRunState,
  } = deps;
  const taskRuns = deps.taskRuns && typeof deps.taskRuns.beginRun === 'function'
    ? deps.taskRuns : null;
  const buildTaskRunContext = deps.buildTaskRunContext || defaultBuildTaskRunContext;
  const resolveSessionQueue = typeof deps.resolveSessionQueue === 'function'
    ? deps.resolveSessionQueue
    : async () => ({ ok: false, code: 'no_active_task' });
  const terminateTaskRun = typeof deps.terminateTaskRun === 'function'
    ? deps.terminateTaskRun : null;
  const cancelUndeliveredTaskRun = typeof deps.cancelUndeliveredTaskRun === 'function'
    ? deps.cancelUndeliveredTaskRun : null;
  const getCommanderMigrationStatus = typeof deps.getCommanderMigrationStatus === 'function'
    ? deps.getCommanderMigrationStatus : null;
  // P1 task-bound hidden sessions: creates ordinary chat records carrying the
  // taskBoundTaskId marker. Optional in reduced hosts/tests — without it the
  // chat-session endpoint answers an explicit 501 instead of crashing.
  const createSessionRecord = typeof deps.createSessionRecord === 'function'
    ? deps.createSessionRecord : null;
  // Composer runtime picks · where the suggested-runtime endpoint reads recent
  // activity from. Optional in reduced hosts/tests; production derives the same
  // chat_history dir the history service writes to.
  const chatHistoryDir = typeof deps.chatHistoryDir === 'string' && deps.chatHistoryDir
    ? deps.chatHistoryDir : null;
  const logger = deps.logger || console;
  const taskRunAnswers = new Map();
  // Optional goal-mode note ports.
  const resolveGoalLimits = typeof deps.resolveGoalLimits === 'function' ? deps.resolveGoalLimits : null;
  const buildGoalLimitNote = typeof deps.buildGoalLimitNote === 'function' ? deps.buildGoalLimitNote : null;

  function goalNoteFor(body) {
    if (!body || !body.goal || !resolveGoalLimits || !buildGoalLimitNote) return '';
    try { return buildGoalLimitNote(resolveGoalLimits(body.goalLimits)) || ''; }
    catch (_) { return ''; }
  }

  const recoveryFile = file.replace(/\.json$/i, '') + '.planning-v2.json';
  let rawBoard = null;
  try { rawBoard = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { /* absent/corrupt legacy file starts empty, as before */ }
  let recoveryBoard = null;
  try { recoveryBoard = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')); }
  catch (_) { /* recovery sidecar is additive */ }
  const rawSchemaValue = Math.max(0, Math.floor(Number(rawBoard?.schemaVersion) || 0));
  const recoverySchema = Math.max(0, Math.floor(Number(recoveryBoard?.schemaVersion) || 0));
  if (recoverySchema === planning.TASK_BOARD_SCHEMA_VERSION
      && (!rawBoard || rawSchemaValue < planning.TASK_BOARD_SCHEMA_VERSION)) {
    logger.log('[multicc/taskboard] restored planning board from v2 recovery sidecar');
    rawBoard = recoveryBoard;
  }
  let board;
  if (rawBoard && typeof rawBoard === 'object') {
    const rawSchema = Math.max(0, Math.floor(Number(rawBoard?.schemaVersion) || 0));
    if (rawSchema > planning.TASK_BOARD_SCHEMA_VERSION) {
      throw Object.assign(new Error(`[taskboard] unsupported schemaVersion ${rawSchema}`), {
        code: 'TASK_BOARD_SCHEMA_UNSUPPORTED',
      });
    }
    if (rawSchema < planning.TASK_BOARD_SCHEMA_VERSION
        && (Object.keys(rawBoard?.tasks || {}).length || Object.keys(rawBoard?.modules || {}).length)) {
      const backup = file.replace(/\.json$/i, '') + '.pre-planning-v1.json';
      if (!fs.existsSync(backup)) atomicWriteJson(backup, rawBoard);
    }
    board = core.normalizeBoard(rawBoard);
  } else board = core.createEmptyBoard();

  function persistWithRecovery(value) {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    atomicWriteJson(file, value);
    try { atomicWriteJson(recoveryFile, value); }
    catch (error) {
      try { previous ? atomicWriteJson(file, previous) : fs.unlinkSync(file); }
      catch (_) {}
      throw error;
    }
  }

  function save() {
    const previousRevision = Number(board.revision) || 0;
    board.schemaVersion = planning.TASK_BOARD_SCHEMA_VERSION;
    board.revision = previousRevision + 1;
    try {
      persistWithRecovery(board);
      return true;
    } catch (e) {
      board.revision = previousRevision;
      logger.log(`[multicc/taskboard] save failed: ${e.message}`);
      return false;
    }
  }

  // Persist planning candidates before reconciling them into the live board.
  function commitPlanningMutation(mutate) {
    const candidate = JSON.parse(JSON.stringify(board));
    let result;
    try { result = mutate(candidate); }
    catch (error) { return { ok: false, error: error?.code || 'invalid_request' }; }
    if (!result?.ok) return result || { ok: false, error: 'invalid_request' };
    candidate.schemaVersion = planning.TASK_BOARD_SCHEMA_VERSION;
    candidate.revision = (Number(board.revision) || 0) + 1;
    try { persistWithRecovery(candidate); }
    catch (error) {
      logger.log(`[multicc/taskboard] planning save failed: ${error?.message || error}`);
      return { ok: false, error: 'persistence_failed' };
    }
    const reconcileMap = (target, source) => {
      for (const id of Object.keys(target)) if (!source[id]) delete target[id];
      for (const [id, value] of Object.entries(source)) {
        if (!target[id]) { target[id] = value; continue; }
        for (const key of Object.keys(target[id])) delete target[id][key];
        Object.assign(target[id], value);
      }
    };
    reconcileMap(board.modules, candidate.modules);
    reconcileMap(board.tasks, candidate.tasks);
    reconcileMap(board.taskGroups, candidate.taskGroups || {});
    board.schemaVersion = candidate.schemaVersion;
    board.revision = candidate.revision;
    return { ...result, taskId: result.task?.id || null };
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
  function updateBoardTask(id, patch) {
    const task = board.tasks[id];
    if (!task) return;
    Object.assign(task, patch);
    task.updatedAt = Date.now();
    save();
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
        updateTask: updateBoardTask,
        getDirectory: resolveDirectoryPort,
        taskDirIdOf: task => core.taskDirId(board, task),
        gitWorktreeAdd: deps.gitWorktreeAdd,
        gitWorktreeRemove: deps.gitWorktreeRemove,
        gitMergeBack: deps.gitMergeBack,
        existsSync: typeof deps.existsSync === 'function' ? deps.existsSync : fs.existsSync,
        isTaskRunning: taskRuns ? id => taskRuns.listTaskRuns(id).some(isOpenTaskRun) : null,
        beginTaskOperation: holdTaskOperation,
        logger,
      })
    : null;


  // Retry each retryable failed delivery once, without retry chains.
  async function autoRetryTaskRun({ taskId, runId } = {}) {
    if (!taskRuns) return { ok: false, code: 'task_runs_unavailable' };
    const id = String(taskId || '').trim();
    const task = resolvedTask(id);
    if (!task) return { ok: false, code: 'task_not_found' };
    const failedRunId = String(runId || '').trim();
    let runs;
    try {
      runs = taskRuns.listTaskRuns(id);
    } catch (_) {
      return { ok: false, code: 'task_runs_unavailable' };
    }
    const failedRun = runs.find(run => run.runId === failedRunId) || null;
    if (!failedRun || failedRun.executionStatus !== 'failed') {
      return { ok: false, code: 'run_not_failed' };
    }
    if (failedRun.metadata?.retryOf
        || runs.some(run => run.metadata?.retryOf === failedRunId)) {
      return { ok: true, skipped: true, code: 'retry_cap_reached' };
    }
    const errorInfo = runErrorOf(taskRuns, failedRunId);
    if (errorInfo?.retryable !== true) {
      return { ok: true, skipped: true, code: 'not_retryable' };
    }
    const admission = (taskRuns.getRunMessages(failedRunId) || [])
      .find(message => message.kind === 'admission');
    const text = core.messageText({ content: admission?.content }).trim();
    if (!text) return { ok: false, code: 'admission_missing' };
    const commander = core.resolveDirectoryCommander(records, core.taskDirId(board, task));
    if (!commander.ok) return { ok: false, code: commander.code || 'commander_not_found' };
    logger.log(`[multicc/taskboard] auto-retrying failed task run ${failedRunId} (${errorInfo.code})`);
    const result = await routeCommanderFollowup(commander.sessionId, id, text, {
      clientMsgId: `auto-retry:${failedRunId}`,
      source: 'task-board',
    });
    return result;
  }

  function notifyTaskRun(taskId) {
    const id = String(taskId || '').trim();
    const task = resolvedTask(id);
    if (!task) return false;
    notify(core.taskDirId(board, task), [...new Set([task.id, id])]);
    return true;
  }

  function stableTaskId(source, requestKey) {
    const digest = crypto.createHash('sha256')
      .update(`${source}\0${requestKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return `tsk-${digest}`;
  }

  function requestKey(req) {
    const bodyKey = String(req?.body?.clientMsgId || '').trim();
    const headerKey = typeof req?.get === 'function'
      ? String(req.get('Idempotency-Key') || '').trim()
      : String(req?.headers?.['idempotency-key'] || '').trim();
    return (bodyKey || headerKey).slice(0, 128) || crypto.randomUUID();
  }

  function canonicalMessages(task, identityIdsOverride = null) {
    const identityIds = new Set(identityIdsOverride || taskIdentityIds(task));
    const sessionIds = new Set();
    for (const taskId of identityIds) {
      const member = board.tasks[taskId];
      for (const ref of member?.refs || []) if (ref.sessionId) sessionIds.add(ref.sessionId);
      if (member?.routing?.workerSessionId) sessionIds.add(member.routing.workerSessionId);
      if (member?.routing?.mode === 'manual' && member.routing.targetSessionId) {
        sessionIds.add(member.routing.targetSessionId);
      }
    }
    const messages = [];
    for (const sessionId of sessionIds) {
      let history = [];
      try { history = loadHistory(sessionId) || []; } catch (_) {}
      for (const message of history) {
        if (!identityIds.has(message?.taskId)) continue;
        messages.push({ sessionId, message });
      }
    }
    return messages.sort((a, b) => (a.message.ts || 0) - (b.message.ts || 0));
  }

  function legacyImportMessages(task, { identityIds = null } = {}) {
    const imported = new Map();
    const add = (sessionId, message, {
      excerpt = '', canonicalBody = false, createdAt: fallbackCreatedAt = 0,
    } = {}) => {
      const role = String(message?.role || (canonicalBody ? 'user' : '')).toLowerCase();
      if (!['user', 'assistant'].includes(role)) return;
      const content = message?.content ?? excerpt;
      const text = core.messageText({ content });
      if (!text && role !== 'assistant') return;
      const sourceMessageId = String(message?.id || '').trim();
      const createdAt = Number(message?.ts) || Number(fallbackCreatedAt) || 0;
      const identity = sourceMessageId
        ? `${sessionId}\0id:${sourceMessageId}`
        : `${sessionId}\0${role}\0${createdAt}\0${text}`;
      const messageId = `legacy:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
      if (imported.has(messageId)) {
        if (canonicalBody) imported.get(messageId).metadata.canonicalBody = true;
        return;
      }
      imported.set(messageId, {
        messageId,
        role,
        kind: 'legacy_import',
        content,
        metadata: {
          sourceSessionId: String(sessionId || '').slice(0, 256),
          sourceMessageId: sourceMessageId.slice(0, 256) || null,
          canonicalBody: canonicalBody || message?.taskStart === true,
          lost: !message,
        },
        createdAt,
      });
    };

    for (const entry of canonicalMessages(task, identityIds)) {
      add(entry.sessionId, entry.message, {
        canonicalBody: entry.message?.role === 'user' && entry.message?.taskStart === true,
      });
    }
    const historyCache = new Map();
    const historyFor = sessionId => {
      if (!historyCache.has(sessionId)) {
        try { historyCache.set(sessionId, loadHistory(sessionId) || []); }
        catch (_) { historyCache.set(sessionId, []); }
      }
      return historyCache.get(sessionId);
    };
    for (const ref of task.refs || []) {
      const history = historyFor(ref.sessionId);
      const user = ref.userMsgId
        ? history.find(message => message?.id === ref.userMsgId) : null;
      const assistant = ref.assistantMsgId
        ? history.find(message => message?.id === ref.assistantMsgId) : null;
      if (user) add(ref.sessionId, user, { canonicalBody: true });
      else if (ref.excerpt) add(ref.sessionId, null, {
        excerpt: ref.excerpt, canonicalBody: true, createdAt: ref.ts,
      });
      if (assistant) add(ref.sessionId, assistant);
    }
    return [...imported.values()].sort((left, right) => (
      left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId)
    ));
  }

  function contextMessages(messages) {
    return messages.map(message => ({
      id: message.messageId,
      role: message.role,
      ts: message.createdAt,
      text: core.messageText({ content: message.content }),
    }));
  }
  function canonicalTaskBody(task) {
    if (taskRuns) {
      try {
        for (const taskId of taskIdentityIds(task)) {
          for (const run of taskRuns.listTaskRuns(taskId)) {
            const messages = taskRuns.getRunMessages(run.runId);
            const canonical = messages.find(message => message.role === 'user'
                && message.kind === 'legacy_import' && message.metadata?.canonicalBody === true)
              || messages.find(message => message.role === 'user'
                && message.kind === 'legacy_import')
              || messages.find(message => message.role === 'user' && message.kind === 'admission');
            if (canonical) {
              const imported = canonical.kind === 'legacy_import';
              return {
                text: core.messageText({ content: canonical.content }),
                messageId: imported
                  ? canonical.metadata?.sourceMessageId || null
                  : canonical.messageId || null,
                sessionId: imported
                  ? canonical.metadata?.sourceSessionId || null
                  : null,
                legacy: false,
              };
            }
          }
        }
      } catch (_) { /* legacy history remains the compatibility fallback */ }
    }
    const start = canonicalMessages(task)
      .find(entry => entry.message.role === 'user' && entry.message.taskStart === true);
    if (start) {
      return {
        text: String(start.message.taskText || core.messageText(start.message)),
        messageId: start.message.id || null,
        sessionId: start.sessionId,
        legacy: false,
      };
    }
    if (task.recordType === 'planned') {
      const description = String(task.description || task.title || '').trim();
      if (description) return { text: description, messageId: null,
        sessionId: task.chatSessionId || null, legacy: false };
    }
    // Old cards predate taskId metadata; their ref remains a read-only fallback.
    for (const ref of task.refs || []) {
      let history = [];
      try { history = loadHistory(ref.sessionId) || []; } catch (_) {}
      const message = ref.userMsgId
        ? history.find(candidate => candidate?.id === ref.userMsgId)
        : null;
      if (message) {
        return {
          text: core.messageText(message),
          messageId: message.id || null,
          sessionId: ref.sessionId,
          legacy: true,
        };
      }
    }
    return { text: '', messageId: null, sessionId: null, legacy: true };
  }
  // Transport wrappers are not conversation; metadata plus text catch old and new rows.
  function isWrapperLedgerMessage(message) {
    if (!message || message.role !== 'user') return false;
    if (message.metadata?.wrapper === true) return true;
    return isTaskRunWrapperText(core.messageText({ content: message.content }));
  }
  function storedTaskMessages(taskId, excludeRunId = null) {
    if (!taskRuns) return [];
    const items = [];
    const task = resolvedTask(taskId);
    const ids = task ? taskIdentityIds(task) : [taskId];
    for (const identityId of ids) {
      for (const run of taskRuns.listTaskRuns(identityId)) {
        if (run.runId === excludeRunId) continue;
        for (const message of taskRuns.getRunMessages(run.runId)) {
          if (isWrapperLedgerMessage(message)) continue;
          items.push({
            id: message.messageId,
            role: message.role,
            ts: message.createdAt,
            text: core.messageText({ content: message.content }),
          });
        }
      }
    }
    return items;
  }

  function isOpenTaskRun(run) {
    return !!run && run.executionStatus === 'running'
      && run.usageStatus === 'collecting' && run.cleanupState === 'blocked';
  }

  function latestOpenTaskRun(taskId, knownRuns = null) {
    if (!taskRuns) return null;
    const task = resolvedTask(taskId);
    const runs = Array.isArray(knownRuns) ? knownRuns
      : (task ? taskIdentityIds(task) : [taskId])
        .flatMap(identityId => taskRuns.listTaskRuns(identityId));
    return runs.filter(isOpenTaskRun).sort((left, right) => (
      (Number(left.startedAt) || 0) - (Number(right.startedAt) || 0)
        || String(left.runId || '').localeCompare(String(right.runId || ''))
    )).at(-1) || null;
  }

  function exactTaskRunTarget(taskId, knownRuns = null) {
    if (!taskRuns) return { ok: false, code: 'task_run_unavailable' };
    let run;
    try { run = latestOpenTaskRun(taskId, knownRuns); }
    catch (_) { return { ok: false, code: 'task_run_unavailable' }; }
    if (!run) return { ok: false, code: 'task_run_not_waiting' };
    const slotId = String(run.slotId || '').trim();
    const leaseEpoch = Number(run.leaseEpoch);
    if (!slotId || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
      return { ok: false, code: 'task_run_lease_stale' };
    }
    const record = records.get(slotId);
    const projected = record?.taskRunLease;
    if (!record?.taskExecutionSlot || record.taskRunQuarantined
        || projected?.runId !== run.runId || Number(projected?.leaseEpoch) !== leaseEpoch) {
      return { ok: false, code: 'task_run_lease_stale' };
    }
    if (typeof taskRuns.getSlotLease !== 'function') {
      return { ok: false, code: 'task_run_lease_stale' };
    }
    let lease;
    try { lease = taskRuns.getSlotLease(slotId); }
    catch (_) { return { ok: false, code: 'task_run_lease_stale' }; }
    if (!lease || lease.runId !== run.runId || Number(lease.leaseEpoch) !== leaseEpoch
        || lease.state !== 'active' || lease.phase !== 'ready') {
      return { ok: false, code: 'task_run_lease_stale' };
    }
    const pending = record.taskState?.pendingUserInput || null;
    if (!pending || String(pending.taskId || '') !== String(taskId)) {
      return { ok: false, code: 'no_pending_question' };
    }
    return { ok: true, run, slotId, leaseEpoch, record, pending };
  }

  function publicPendingQuestion(pending) {
    if (!pending || pending.resolved === true) return null;
    const requestId = String(pending.requestId || '').trim().slice(0, 160);
    const question = String(pending.question || '').trim().slice(0, 16 * 1024);
    if (!requestId || !question) return null;
    const options = [];
    const seen = new Set();
    for (const raw of Array.isArray(pending.options) ? pending.options : []) {
      const option = String(raw == null ? '' : raw).trim().slice(0, 512);
      if (!option || seen.has(option)) continue;
      seen.add(option);
      options.push(option);
      if (options.length >= 12) break;
    }
    return {
      requestId,
      question,
      reason: String(pending.reason || '').trim().slice(0, 4 * 1024),
      options,
      allowMultiple: pending.allowMultiple === true && options.length >= 2,
      createdAt: Math.max(0, Number(pending.createdAt) || 0),
    };
  }

  function taskRunDtos(taskId) {
    if (!taskRuns) return { runs: [], usage: null };
    try {
      const task = resolvedTask(taskId);
      const identityIds = task ? taskIdentityIds(task) : [taskId];
      const runsByTask = identityIds.map(id => ({
        id,
        runs: taskRuns.listTaskRuns(id),
        usage: taskRuns.getTaskUsage(id),
      }));
      const targetRuns = runsByTask.find(item => item.id === task?.id)?.runs || [];
      const storedRuns = runsByTask.flatMap(item => item.runs).sort((left, right) => (
        (Number(left.startedAt) || 0) - (Number(right.startedAt) || 0)
          || String(left.runId || '').localeCompare(String(right.runId || ''))
      ));
      const answerTarget = exactTaskRunTarget(task?.id || taskId, targetRuns);
      const pendingQuestion = answerTarget.ok
        ? publicPendingQuestion(answerTarget.pending) : null;
      const runs = storedRuns.slice(-5).reverse().map(run => ({
        ...publicRunDto(run), usage: taskRuns.getRunUsage(run.runId),
        ...(run.executionStatus === 'failed'
          ? { error: runErrorOf(taskRuns, run.runId) } : {}),
        ...(pendingQuestion && run.runId === answerTarget.run.runId
          ? { pendingQuestion } : {}),
      }));
      return {
        runs,
        usage: aggregateTaskUsages(task?.id || taskId, runsByTask.map(item => item.usage)),
      };
    } catch (error) {
      logger.log(`[multicc/taskboard] task-run projection failed: ${error?.code || 'unknown'}`);
      return { runs: [], usage: null };
    }
  }

  // #38 · the pooled admission machinery (beginTaskRun/rejectTaskRun) is
  // retired with the slot dispatch: new work only ever enters through the
  // bound chat session, and the ledger's read side (projection, answers,
  // cancel, bounded auto-retry) keeps serving the legacy cards.

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
      if (task.title === core.PENDING_TASK_TITLE && userMessage) {
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

  const pendingModuleAssignmentByTask = new Map();
  const automaticAttributionByTask = new Map();

  // Resolve the current turn even while it is still streaming. Looking for the
  // last committed assistant first is wrong mid-turn: it pairs the previous
  // turn instead of the current user message. Anchor on currentUserText (or the
  // latest user as a fallback), then accept only an assistant after that user.
  function resolveTurnRefs(history, currentUserText = '') {
    const wanted = String(currentUserText || '').trim();
    let userIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (!m || m.role !== 'user') continue;
      if (!wanted || core.messageText(m).trim() === wanted) { userIdx = i; break; }
    }
    if (userIdx === -1 && wanted) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.role === 'user') { userIdx = i; break; }
      }
    }
    let asstIdx = -1;
    for (let i = userIdx + 1; userIdx !== -1 && i < history.length; i++) {
      const m = history[i];
      if (m?.role === 'user') break;
      if (m?.role === 'assistant' && !m._interim && !m.error) asstIdx = i;
    }
    return {
      userMsg: userIdx === -1 ? null : history[userIdx],
      assistantMsg: asstIdx === -1 ? null : history[asstIdx],
    };
  }

  function resolveTaskClassificationInput(task) {
    let partial = null;
    let unreadable = false;
    for (let ri = task.refs.length - 1; ri >= 0; ri--) {
      const storedRef = task.refs[ri];
      let history;
      try {
        history = loadHistory(storedRef.sessionId) || [];
      } catch (_) {
        unreadable = true;
        continue;
      }
      let userIdx = storedRef.userMsgId
        ? history.findIndex(m => m && m.id === storedRef.userMsgId) : -1;
      if (userIdx === -1) {
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i]?.role === 'user' && history[i]?.taskId === task.id) {
            userIdx = i;
            break;
          }
        }
      }
      if (userIdx === -1) {
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i]?.role === 'user'
            && core.extractTaskMarker(core.messageText(history[i])) === task.id) {
            userIdx = i;
            break;
          }
        }
      }
      let assistantIdx = storedRef.assistantMsgId
        ? history.findIndex(m => m && m.id === storedRef.assistantMsgId) : -1;
      if (assistantIdx === -1 && userIdx !== -1) {
        for (let i = userIdx + 1; i < history.length; i++) {
          const m = history[i];
          if (m?.role === 'user') break;
          if (m?.role === 'assistant' && !m._interim && !m.error) assistantIdx = i;
        }
      }
      const userMsg = userIdx === -1 ? null : history[userIdx];
      const assistantMsg = assistantIdx === -1 ? null : history[assistantIdx];
      const userText = core.messageText(userMsg).trim() || task.moduleAssignment?.seed || storedRef.excerpt || '';
      const replyText = core.messageText(assistantMsg).trim();
      if (userText && !partial) {
        partial = {
          userText,
          replyText: '',
          ref: {
            sessionId: storedRef.sessionId,
            dirId: storedRef.dirId || records.get(storedRef.sessionId)?.dirId || null,
            dirLabel: null,
            userMsgId: userMsg?.id || storedRef.userMsgId || null,
            assistantMsgId: storedRef.assistantMsgId || null,
            ts: userMsg?.ts || storedRef.ts || Date.now(),
            excerpt: (task.moduleAssignment?.seed || storedRef.excerpt || userText).slice(0, 140),
          },
        };
      }
      if (userText && replyText) {
        return {
          userText,
          replyText,
          ref: {
            sessionId: storedRef.sessionId,
            dirId: storedRef.dirId || records.get(storedRef.sessionId)?.dirId || null,
            dirLabel: null,
            userMsgId: userMsg?.id || storedRef.userMsgId || null,
            assistantMsgId: assistantMsg?.id || storedRef.assistantMsgId || null,
            ts: assistantMsg?.ts || userMsg?.ts || storedRef.ts || Date.now(),
            excerpt: (task.moduleAssignment?.seed || storedRef.excerpt || userText).slice(0, 140),
          },
        };
      }
    }
    return partial || (unreadable ? { unreadable: true } : null);
  }

  function saveModuleAssignment(task, patch) {
    const previous = task.moduleAssignment || {};
    task.moduleAssignment = {
      running: false, attempts: 0, lastAttemptAt: 0,
      lastError: '', seed: '',
      ...previous,
      ...patch,
    };
    task.updatedAt = Date.now();
    save();
    const mod = task.moduleId ? board.modules[task.moduleId] : null;
    notify(mod?.dirId || task.refs.find(r => r.dirId)?.dirId || null, [task.id]);
  }

  function recordModuleAssignmentFailure(taskId, error) {
    const task = board.tasks[taskId];
    if (!task?.moduleAssignment) return;
    saveModuleAssignment(task, {
      running: false,
      lastError: String(error || 'classification_failed').slice(0, 200),
    });
  }

  function archiveMissingContextTask(task) {
    if (!task?.moduleAssignment) return { ok: false, error: 'not_pending' };
    if (task.status === 'archived') return { ok: false, error: 'task_archived' };
    const pendingJobId = pendingModuleAssignmentByTask.get(task.id);
    if (pendingJobId) {
      pendingModuleAssignmentByTask.delete(task.id);
      try { auxQueue.cancel(pendingJobId); } catch (_) {}
    }
    const dirId = core.taskDirId(board, task);
    task.status = 'archived';
    task.moduleAssignment.running = false;
    task.moduleAssignment.lastError = 'missing_context';
    task.updatedAt = Date.now();
    save();
    notify(dirId || null, [task.id]);
    automaticAttributionByTask.delete(task.id);

    // Missing-context cleanup is inferred from transcript evidence, unlike the
    // explicit lifecycle archive endpoint. Hide the dead card, but retain any
    // bound session/worktree pointer so a false positive remains recoverable and
    // can never destroy user work or chat history.
    return {
      ok: true,
      queued: false,
      archived: true,
      reason: 'missing_context',
    };
  }

  function targetedTagPrompt(task, input) {
    return [
      core.buildTagUserPrompt({
        board,
        sessionLabel: records.get(input.ref.sessionId)?.label || input.ref.sessionId,
        dirLabel: null,
        userText: input.userText,
        replyText: input.replyText,
      }),
      '',
      '【本次要求】',
      `这是用户已确认创建的任务，占位任务 id 为 ${task.id}。`,
      `必须输出恰好一个任务并保留 id "${task.id}"；这里只做模块/标题归类，不合并任务身份。`,
      '必须给出最终 title、module 和 areas，不能返回空 tasks。',
    ].join('\n');
  }

  function queueTaskClassification(taskId, options = {}) {
    const task = board.tasks[taskId];
    if (!task?.moduleAssignment) return { ok: false, error: 'not_pending' };
    if (task.status === 'archived') return { ok: false, error: 'task_archived' };
    if (pendingModuleAssignmentByTask.has(taskId)) return { ok: false, error: 'classification_running' };
    // Automatic module assignment is admitted only after task attribution has
    // settled on the final canonical task id. Manual single/bulk retry remains
    // available for failed cards. Any future call site must choose one path.
    if (!options.manual && !options.automatic) {
      return { ok: false, error: 'classification_trigger_required' };
    }
    // Automatic failures get one later-turn retry, then wait for an explicit
    // user retry. This keeps a persistently malformed model response from
    // spending Aux capacity on every subsequent turn forever.
    if (options.automatic && (task.moduleAssignment.attempts || 0) >= 2) {
      return { ok: false, error: 'automatic_attempt_limit' };
    }

    const input = options.input || resolveTaskClassificationInput(task);
    if (!input?.userText) {
      if (input?.unreadable) return { ok: false, error: 'context_unavailable' };
      // A manual single/bulk request is an explicit reconciliation pass and may
      // retire a dead card. Automatic attribution can observe a partially
      // persisted turn, so missing input there is never proof that the card is
      // stale and must not hide it.
      return options.manual
        ? archiveMissingContextTask(task)
        : { ok: false, error: 'missing_context' };
    }
    if (!input.replyText) input.replyText = '（尚无助手回复，仅根据用户提交的任务信息归类）';
    if (auxQueue.isUnhealthy && auxQueue.isUnhealthy()) {
      saveModuleAssignment(task, {
        running: false,
        lastError: 'aux_unhealthy',
      });
      return { ok: false, error: 'aux_unhealthy' };
    }

    const jobId = crypto.randomUUID();
    pendingModuleAssignmentByTask.set(taskId, jobId);
    saveModuleAssignment(task, {
      running: true,
      attempts: (task.moduleAssignment.attempts || 0) + 1,
      lastAttemptAt: Date.now(),
      lastError: '',
    });

    let promise;
    try {
      promise = auxQueue.enqueue({
        id: jobId,
        type: 'task_tag',
        systemPrompt: core.buildTagSystemPrompt(),
        prompt: targetedTagPrompt(task, input),
        meta: { sessionName: input.ref.sessionId, sessionId: input.ref.sessionId, taskId },
      });
    } catch (e) {
      pendingModuleAssignmentByTask.delete(taskId);
      logger.log(`[multicc/taskboard] classify enqueue failed for ${taskId}: ${e?.message || e}`);
      recordModuleAssignmentFailure(taskId, 'enqueue_failed');
      return { ok: false, error: 'enqueue_failed' };
    }

    Promise.resolve(promise).then(result => {
      if (pendingModuleAssignmentByTask.get(taskId) !== jobId) return;
      pendingModuleAssignmentByTask.delete(taskId);
      const current = board.tasks[taskId];
      if (!current || !current.moduleAssignment) return;
      if (current.status === 'archived') {
        saveModuleAssignment(current, {
          running: false,
          lastError: 'classification_cancelled',
        });
        return;
      }
      if (!result || result.cancelled) {
        recordModuleAssignmentFailure(taskId, 'classification_cancelled');
        return;
      }
      const parsed = core.parseTagResult(result.text);
      const entry = parsed.tasks.find(t => t.id === taskId || (t.id && board.tasks[t.id])) || parsed.tasks[0];
      if (!entry) {
        recordModuleAssignmentFailure(taskId, 'empty_classification');
        return;
      }
      const applied = core.applyTaskClassification(board, taskId, entry, input.ref, Date.now());
      if (!applied.ok) {
        recordModuleAssignmentFailure(taskId, applied.error);
        return;
      }
      automaticAttributionByTask.delete(taskId);
      save();
      notify(input.ref.dirId, applied.touched);
    }).catch(e => {
      if (pendingModuleAssignmentByTask.get(taskId) !== jobId) return;
      pendingModuleAssignmentByTask.delete(taskId);
      logger.log(`[multicc/taskboard] classify failed for ${taskId}: ${e?.message || e}`);
      recordModuleAssignmentFailure(taskId, 'classification_failed');
    });
    return { ok: true, queued: true };
  }

  function scanPendingClassifications(now = Date.now()) {
    // Startup recovery has two bounded jobs only: retire cards already proven
    // to have no usable context, and mark operations that were in flight when
    // the process stopped as interrupted. Untouched historical backlog is not bulk-queued
    // here because Aux is a shared serial lane; new turns enter automatically
    // through onTaskAttributionSettled below.
    const changed = [];
    for (const task of Object.values(board.tasks)) {
      const assignment = task.moduleAssignment;
      if (!assignment || task.status === 'archived') continue;
      if (assignment.lastError === 'missing_context') {
        // History may have been temporarily unreadable when the error was
        // recorded. Re-prove the absence before hiding the card.
        const input = resolveTaskClassificationInput(task);
        if (input?.unreadable) {
          assignment.lastError = 'context_unavailable';
          task.updatedAt = now;
          save();
          notify(core.taskDirId(board, task) || null, [task.id]);
          changed.push(task.id);
        } else if (!input?.userText) {
          const archived = archiveMissingContextTask(task);
          if (archived.archived) changed.push(task.id);
        } else {
          assignment.lastError = '';
          task.updatedAt = now;
          save();
          notify(core.taskDirId(board, task) || null, [task.id]);
          changed.push(task.id);
        }
        continue;
      }
      if (!assignment.running || pendingModuleAssignmentByTask.has(task.id)) continue;
      assignment.running = false;
      assignment.lastError = 'classification_interrupted';
      task.updatedAt = now;
      save();
      notify(core.taskDirId(board, task) || null, [task.id]);
      changed.push(task.id);
    }
    return changed.length;
  }

  function onTaskAttributionSettled(sessionName, taskId, messages = [], meta = {}) {
    const task = taskId ? board.tasks[taskId] : null;
    if (!task?.moduleAssignment || task.status === 'archived') {
      return { ok: false, error: task ? 'not_pending' : 'task_not_found' };
    }
    const turn = Array.isArray(messages) ? messages : [];
    const userMsg = turn.find(message => message?.role === 'user') || null;
    const assistantMsg = [...turn].reverse().find(message =>
      message?.role === 'assistant' && !message._interim && !message.error) || null;
    // This hook runs only after intent attribution has settled. A failed or
    // cancelled turn may have no final assistant message; the module model can
    // still classify the user's request, using the same explicit placeholder as
    // manual classification.
    const userText = core.messageText(userMsg).trim();
    const rec = records.get(sessionName);
    const fallback = userText ? null : resolveTaskClassificationInput(task);
    if (fallback?.unreadable) return { ok: false, error: 'context_unavailable' };
    const resolvedUserText = userText || fallback?.userText || '';
    if (!resolvedUserText) return { ok: false, error: 'missing_context' };
    const ref = fallback?.ref || {
      sessionId: sessionName,
      dirId: rec?.dirId || core.taskDirId(board, task) || null,
      dirLabel: null,
      userMsgId: userMsg?.id || null,
      assistantMsgId: assistantMsg?.id || null,
      ts: assistantMsg?.ts || userMsg?.ts || Date.now(),
      excerpt: resolvedUserText.slice(0, 140),
    };
    const attributionKey = String(meta.runId || [
      userMsg?.id || ref.userMsgId || '',
      assistantMsg?.id || ref.assistantMsgId || '',
    ].join(':'));
    if (attributionKey && automaticAttributionByTask.get(task.id) === attributionKey) {
      return { ok: false, error: 'attribution_already_handled' };
    }
    const result = queueTaskClassification(task.id, {
      automatic: true,
      input: {
        userText: resolvedUserText,
        replyText: fallback?.replyText || core.messageText(assistantMsg).trim(),
        ref,
      },
    });
    if (result.queued && attributionKey) {
      automaticAttributionByTask.set(task.id, attributionKey);
    }
    return result;
  }

  const linkRelatedTasks = createRelatedTaskLinker({
    board, groupRelatedTasks: core.groupRelatedTasks, save, notify,
  });

  // Turn-end hook — called from classifyTurnEnd alongside the classify pass.
  // Only task-aware canonical messages participate. Ordinary chats are not
  // inferred into tasks; legacy marker records remain attachable for migration.
  function onTurnEnd(cs, sessionName) {
    try {
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway' || rec.type === 'commander') return;
      const userText = String(cs?.currentUserText || '').trim();
      if (!userText) return;
      if (isSystemInjected(userText)) return;

      const history = loadHistory(sessionName) || [];
      const { userMsg, assistantMsg } = resolveTurnRefs(history, userText);
      if (!userMsg && !assistantMsg) return;
      const taskId = userMsg?.taskId || assistantMsg?.taskId
        || cs?._currentTaskId || core.extractTaskMarker(userText);
      const task = taskId ? resolvedTask(taskId) : null;
      if (!task) return;
      const now = Date.now();
      const ref = {
        sessionId: sessionName,
        dirId: rec.dirId || null,
        dirLabel: null,
        userMsgId: userMsg?.id || null,
        assistantMsgId: assistantMsg?.id || null,
        ts: assistantMsg?.ts || userMsg?.ts || now,
        excerpt: userMsg?.taskId ? '' : userText.slice(0, 140),
      };
      if (core.addRefToTask(task, ref, now)) {
        save();
        notify(ref.dirId, [task.id]);
      }
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
      if (title && task.title !== title) {
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
        archiveMissingContextTask(oldTask);
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
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway' || rec.type === 'commander') return;

      const history = loadHistory(sessionName) || [];
      const currentUserText = String(turn.currentUserText || '').trim();
      const { userMsg, assistantMsg } = resolveTurnRefs(history, currentUserText);
      if (!userMsg && !assistantMsg) return;
      const taskId = turn.taskId || userMsg?.taskId || assistantMsg?.taskId
        || core.extractTaskMarker(currentUserText);
      const task = taskId ? resolvedTask(taskId) : null;
      if (!task) return;

      const now = Date.now();
      const ref = {
        sessionId: sessionName,
        dirId: rec.dirId || null,
        dirLabel: null,
        userMsgId: userMsg?.id || null,
        assistantMsgId: assistantMsg?.id || null,
        ts: assistantMsg?.ts || userMsg?.ts || now,
        excerpt: userMsg?.taskId ? '' : String(goal || '').slice(0, 200),
      };
      let changed = core.addRefToTask(task, ref, now);
      const rawTitle = String(goal || '').trim();
      const nextTitle = rawTitle && rawTitle !== core.PENDING_TASK_TITLE
        ? rawTitle.slice(0, 40)
        : '';
      if (task.title === core.PENDING_TASK_TITLE && nextTitle) {
        task.title = nextTitle;
        changed = true;
      }
      if (turn.runState && task.runState !== turn.runState) {
        task.runState = turn.runState;
        task.updatedAt = now;
        changed = true;
      }
      if (changed) {
        save();
        notify(ref.dirId, [task.id]);
      }
      logger.log(`[multicc/taskboard] onClassifyGoal: updated task ${task.id} for ${sessionName} phase=${phase || '?'}`);
    } catch (e) {
      logger.log(`[multicc/taskboard] onClassifyGoal error: ${e?.message || e}`);
    }
  }

  // Classify letter → turn run state. Same fold as session-work-host.getRunState
  // and task-context-host.runState, so the task card, the session card and the
  // chat bar cannot disagree about what one verdict means.
  function runStateForClassify(classifyState) {
    return classifyDisplay(classifyState || 'D').cardStatus;
  }

  function runStateForTurnOutcome(turnOutcome, classifyState) {
    if (turnOutcome === 'succeeded') return 'succeeded';
    if (turnOutcome === 'failed') return 'error';
    if (turnOutcome === 'waiting_user' || turnOutcome === 'waiting_background') return 'waiting';
    if (turnOutcome === 'running') return 'running';
    return runStateForClassify(classifyState);
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

  function onQueueEvent(event = {}) {
    const taskId = String(event.taskId || '') || boundTaskId(event.sessionId);
    const task = taskId ? resolvedTask(taskId) : null;
    if (!task) return { ok: false, code: 'task_not_found' };
    const type = String(event.type || '');
    let runState = null;
    if (type === 'queued' && event.workKind !== 'task') {
      return { ok: true, changed: false };
    }
    if (type === 'queued' || type === 'claim_released') runState = 'queued';
    else if (type === 'claimed' || type === 'started' || type === 'resumed') runState = 'running';
    else if (type === 'completed') {
      // `completed` is scheduler bookkeeping: the active slot was released.
      // The explicit turnOutcome drives this runtime projection; it NEVER
      // changes task.status. Only handleStatus's user action can mark done.
      runState = runStateForTurnOutcome(event.turnOutcome, event.classifyState);
    } else if (type === 'reconcile') {
      // Formal re-publish: the canonical state was recomputed elsewhere (e.g. a
      // cancel that found no active scheduler entry). Always notifies, even when
      // the value is unchanged, so a stale projection is repaired rather than
      // silently kept — and no caller has to hand-roll a second broadcast.
      runState = runStateForClassify(event.classifyState);
    } else if (type === 'frozen') {
      // Explicit reason→state map, shared with getRunState. Not the old substring
      // heuristic (mislabelled interruption/recovery/settling as "waiting").
      runState = runStateForFreezeReason(event.freezeReason);
    } else if (type === 'cancelled' || type === 'skipped') runState = 'idle';
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

  // ── Backfill (scan existing chat history into the board) ─────────────────

  // Pair user→assistant turns from a history array, skipping system-injected
  // user messages and interim/error assistant messages. Returns the last
  // `limit` pairs in chronological order.
  function extractTurnPairs(history, limit) {
    const pairs = [];
    let pendingUser = null;
    for (const m of history) {
      if (!m || !m.role) continue;
      if (m.role === 'user') {
        const text = core.messageText(m).trim();
        if (!text || isSystemInjected(text)) { pendingUser = null; continue; }
        pendingUser = m;
      } else if (m.role === 'assistant') {
        if (m._interim || m.error) continue;
        const text = core.messageText(m).trim();
        if (!text || !pendingUser) continue;
        pairs.push({ userMsg: pendingUser, assistantMsg: m });
        pendingUser = null;
      }
    }
    return pairs.slice(-limit);
  }

  // Backfill state — one run at a time; progress readable via GET board route.
  const backfillState = { running: false, queued: 0, done: 0, startedAt: null };

  function backfillSession(sessionId, rec, turnLimit) {
    const history = loadHistory(sessionId) || [];
    const pairs = extractTurnPairs(history, turnLimit);
    if (!pairs.length) return null;
    const turns = pairs.map((p, i) => ({
      n: i + 1,
      user: core.messageText(p.userMsg),
      reply: core.messageText(p.assistantMsg),
    }));
    const refByTurn = new Map(pairs.map((p, i) => [i + 1, {
      sessionId,
      dirId: rec.dirId || null,
      dirLabel: null,
      userMsgId: p.userMsg.id || null,
      assistantMsgId: p.assistantMsg.id || null,
      ts: p.assistantMsg.ts || p.userMsg.ts || Date.now(),
      excerpt: core.messageText(p.userMsg).trim().slice(0, 140),
    }]));
    return auxQueue.enqueue({
      type: 'task_backfill',
      systemPrompt: core.buildBackfillSystemPrompt(),
      prompt: core.buildBackfillUserPrompt({
        board, sessionLabel: rec.label || sessionId, dirLabel: null, turns,
      }),
      meta: { sessionName: sessionId, sessionId: rec.id || sessionId },
    }).then(result => {
      if (!result || result.cancelled) return { sessionId, tagged: 0 };
      const parsed = core.parseBackfillResult(result.text);
      const touched = core.applyBackfillResult(board, parsed.tasks, refByTurn, Date.now());
      if (touched.length) {
        save();
        notify(rec.dirId || null, touched);
      }
      return { sessionId, tagged: touched.length };
    });
  }

  async function handleBackfill(req, res) {
    if (backfillState.running) {
      return res.status(409).json({ error: 'backfill_running', state: { ...backfillState } });
    }
    if (auxQueue.isUnhealthy && auxQueue.isUnhealthy()) {
      return res.status(503).json({ error: 'aux_unhealthy' });
    }
    const dirId = String(req.body?.dirId || '').trim() || null;
    const turnLimit = Math.min(Math.max(Number(req.body?.turnLimit) || 12, 1), 30);
    const candidates = [];
    for (const [sid, rec] of records) {
      if (!rec || rec.kind !== 'chat') continue;
      if (rec.type === 'aux' || rec.type === 'gateway' || rec.type === 'commander' || rec.ephemeral) continue;
      if (dirId && rec.dirId !== dirId) continue;
      candidates.push([sid, rec]);
    }
    backfillState.running = true;
    backfillState.queued = 0;
    backfillState.done = 0;
    backfillState.startedAt = Date.now();
    const jobs = [];
    for (const [sid, rec] of candidates) {
      try {
        const job = backfillSession(sid, rec, turnLimit);
        if (job) {
          backfillState.queued++;
          jobs.push(job.then(r => { backfillState.done++; return r; })
            .catch(e => { backfillState.done++; return { sessionId: sid, error: e?.message || String(e) }; }));
        }
      } catch (e) {
        logger.log(`[multicc/taskboard] backfill enqueue failed for ${sid}: ${e?.message || e}`);
      }
    }
    Promise.allSettled(jobs).then(() => { backfillState.running = false; });
    res.json({ ok: true, queued: backfillState.queued, note: `已入队 ${backfillState.queued} 个会话的历史归档（aux 串行处理，完成后任务板自动刷新）` });
  }

  // ── REST ──────────────────────────────────────────────────────────────────
  // Authentication/authorization is owned by the app-level API gate, which is
  // mounted before this runtime. Task-board mutations are ordinary product
  // operations and must work for authenticated remote administrators; do not
  // add a transport-locality check here.

  function commanderFailure(res, code) {
    const notes = {
      directory_required: '自动路由必须指定任务所属工作区',
      commander_not_found: '该工作区没有带稳定角色元数据的 Agent Commander，请先创建或修复 Commander 会话',
      commander_ambiguous: '该工作区存在多个 Agent Commander，无法安全确定唯一入口，请先修复角色配置',
    };
    return res.status(code === 'directory_required' ? 400 : 409).json({
      error: code || 'commander_unavailable',
      note: notes[code] || 'Agent Commander 当前不可用',
    });
  }

  function commanderMigrationFailure(res, dirId) {
    if (!getCommanderMigrationStatus || !dirId) return false;
    const status = getCommanderMigrationStatus(dirId);
    if (status && status.ready === true) return false;
    const code = status?.code || 'commander_migration_pending';
    res.status(503).json({
      error: code,
      directoryId: dirId,
      note: code === 'commander_migration_pending'
        ? 'Agent Commander 升级迁移尚未完成，自动路由暂不可用'
        : '该工作区的 Agent Commander 迁移未安全完成，请查看 readiness 并修复后重试',
    });
    return true;
  }

  function taskDto(task) {
    const dto = core.buildBoardDto({
      modules: board.modules,
      tasks: { [task.id]: task },
      taskGroups: board.taskGroups,
    }, getSessionRunState).tasks[0];
    dto.mergedTaskCount = Math.max(0, taskIdentityIds(task).length - 1);
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
    Object.assign(dto, taskRunDtos(task.id));
    return dto;
  }

  function attachBoundWorkspace(dto) {
    const bound = dto?.chatSessionId && records.get(dto.chatSessionId);
    dto.workspaceState = !bound ? null
      : ['hibernated', 'hibernating', 'thawing'].includes(bound.workspaceState) ? 'hibernated' : 'awake';
    dto.lastWorkAt = bound?.lastWorkAt || bound?.createdAt || null;
    dto.hibernatedAt = bound?.hibernatedAt || null;
    return dto;
  }

  // M2 T1 · single-task bootstrap for a task-mode chat view: the per-task
  // slice of handleBoard's projection (title/body/identity, routing, dirIds,
  // runs) without fetching the whole board. Additive-only (I3).
  function handleTask(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    res.json({ ok: true, task: taskDto(task) });
  }

  function handleBoard(req, res) {
    const dto = core.buildBoardDto(board, getSessionRunState);
    const labels = {};
    for (const t of dto.tasks) {
      const body = canonicalTaskBody(board.tasks[t.id]);
      if (t.title === core.PENDING_TASK_TITLE && body.text) {
        t.title = core.deriveTaskTitle(body.text);
      }
      t.body = body.text;
      t.bodyMessageId = body.messageId;
      t.bodySessionId = body.sessionId;
      t.legacy = body.legacy;
      t.identityState = body.text
        ? body.legacy ? 'legacy' : 'canonical'
        : board.tasks[t.id]?.routing?.operationId ? 'orphaned_admission' : 'legacy_unresolved';
      if (t.routing) {
        const sid = t.routing.targetSessionId;
        labels[sid] = records.get(sid)?.label || sid;
        t.routing.targetLabel = labels[sid];
        if (t.routing.workerSessionId) {
          const workerId = t.routing.workerSessionId;
          const worker = records.get(workerId);
          if (worker?.taskExecutionSlot === true) {
            delete t.routing.workerSessionId;
            t.routing.internalExecution = true;
          } else {
            labels[workerId] = worker?.label || workerId;
            t.routing.workerLabel = labels[workerId];
          }
        }
      }
      t.sessionIds = (t.sessionIds || [])
        .filter(sessionId => records.get(sessionId)?.taskExecutionSlot !== true);
      attachBoundWorkspace(t);
      for (const sid of t.sessionIds) {
        if (!(sid in labels)) labels[sid] = records.get(sid)?.label || sid;
      }
      Object.assign(t, taskRunDtos(t.id));
    }
    res.json({ ok: true, ...dto, sessionLabels: labels, backfill: { ...backfillState } });
  }

  // M0 · chat-history-style pagination over the same wrapper-filtered
  // transcript the legacy `items` projection serves, so a task-mode chat view
  // pages a task exactly like a session (docs/chat-view-unification-design.md
  // §3-M0). The session contract: tail page by default, `before` pages older,
  // `around` centres on one id and adds found/hasNewer.
  function transcriptPagePayload(messages, req) {
    const query = req.query || {};
    const page = paginateTranscript(messages, {
      before: query.before && String(query.before),
      around: query.around && String(query.around),
      limit: query.limit && String(query.limit),
    });
    const payload = { messages: page.messages, hasMore: page.hasMore };
    if (query.around) {
      payload.found = page.found === true;
      payload.hasNewer = page.hasNewer === true;
    }
    return payload;
  }

  function handleMessages(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const runProjection = taskRunDtos(task.id);
    if (taskRuns && runProjection.runs.length) {
      const items = [];
      try {
        const transcript = [];
        const itemKeys = new Set();
        const pushItem = item => {
          const key = item.messageId
            ? `${item.sessionId || ''}\0${item.messageId}`
            : `${item.taskRunId || ''}\0${item.role}\0${item.ts}\0${item.text}`;
          if (itemKeys.has(key)) return;
          itemKeys.add(key);
          items.push(item);
        };
        const sessionImports = [];
        for (const identityId of taskIdentityIds(task)) {
          const identityRuns = taskRuns.listTaskRuns(identityId);
          for (const run of identityRuns) {
            for (const message of taskRuns.getRunMessages(run.runId)) {
              if (isWrapperLedgerMessage(message)) continue;
              const text = core.messageText({ content: message.content });
              if (!text && message.role !== 'assistant') continue;
              const imported = message.kind === 'legacy_import';
              const sourceSessionId = imported
                ? String(message.metadata?.sourceSessionId || '') || null
                : null;
              pushItem({
                sessionId: sourceSessionId,
                sessionLabel: sourceSessionId
                  ? records.get(sourceSessionId)?.label || sourceSessionId
                  : '临时执行',
                taskRunId: run.runId,
                role: message.role,
                messageId: imported
                  ? message.metadata?.sourceMessageId || null
                  : message.messageId || null,
                ts: message.createdAt || 0,
                text,
                ...(message.metadata?.partial === true ? { partial: true } : {}),
                ...(imported && message.metadata?.lost === true ? { lost: true } : {}),
              });
            }
          }
          transcript.push(...taskTranscriptMessages({
            taskRuns, messageText: core.messageText, isWrapperText: isTaskRunWrapperText,
          }, identityId));
          if (!identityRuns.length) {
            const member = board.tasks[identityId];
            if (member) sessionImports.push(...legacyImportMessages(member, {
              identityIds: [identityId],
            }));
          }
        }
        // A merge can combine a modern bound-session task with a legacy
        // ledger task.  Keep both histories: synthesize the session-backed
        // side through the same stable legacy ids and deduplicate any rows the
        // ledger had already imported.
        for (const message of sessionImports) {
          const sourceSessionId = String(message.metadata?.sourceSessionId || '') || null;
          const sourceMessageId = message.metadata?.sourceMessageId || null;
          const text = core.messageText({ content: message.content });
          pushItem({
            sessionId: sourceSessionId,
            sessionLabel: sourceSessionId
              ? records.get(sourceSessionId)?.label || sourceSessionId : '历史记录',
            role: message.role,
            messageId: sourceMessageId,
            ts: message.createdAt || 0,
            text,
            ...(message.metadata?.lost === true ? { lost: true } : {}),
          });
          transcript.push({
            id: message.messageId,
            role: message.role,
            content: text,
            ts: message.createdAt || 0,
            kind: 'legacy_import',
          });
          }
        items.sort((left, right) => (left.ts || 0) - (right.ts || 0));
        const transcriptById = new Map();
        for (const message of transcript.sort((left, right) => (left.ts || 0) - (right.ts || 0))) {
          if (!transcriptById.has(message.id)) transcriptById.set(message.id, message);
        }
        return res.json({
          ok: true, task: taskDto(task), items, ...runProjection,
          ...transcriptPagePayload([...transcriptById.values()], req),
        });
      } catch (error) {
        logger.log(`[multicc/taskboard] task-run messages failed: ${error?.code || 'unknown'}`);
      }
    }
    const cache = new Map();
    const historyFor = (sid) => {
      if (!cache.has(sid)) {
        try { cache.set(sid, loadHistory(sid) || []); }
        catch (_) { cache.set(sid, []); }
      }
      return cache.get(sid);
    };
    const items = [];
    const seenItems = new Set();
    const pushHistoryItem = item => {
      const key = item.messageId
        ? `${item.sessionId || ''}\0${item.messageId}`
        : `${item.sessionId || ''}\0${item.role}\0${item.ts}\0${item.text}`;
      if (seenItems.has(key)) return;
      seenItems.add(key);
      items.push(item);
    };
    const canonical = canonicalMessages(task);
    for (const entry of canonical) {
      const { sessionId, message } = entry;
      const label = records.get(sessionId)?.label || sessionId;
      const text = message.role === 'user' && message.taskStart
        ? String(message.taskText || core.messageText(message))
        : core.messageText(message);
      if (!text && message.role !== 'assistant') continue;
      if (isTaskRunWrapperText(text)) continue;
      pushHistoryItem({
        sessionId,
        sessionLabel: label,
        role: message.role,
        messageId: message.id || null,
        ts: message.ts || 0,
        text,
      });
    }
    // Legacy members of a merged lineage may have no taskId metadata even
    // when the target has canonical messages.  Always walk refs and dedup
    // against the canonical rows instead of dropping that side of history.
    for (const ref of task.refs) {
      const label = records.get(ref.sessionId)?.label || ref.sessionId;
      const history = historyFor(ref.sessionId);
      const um = ref.userMsgId ? history.find(m => m && m.id === ref.userMsgId) : null;
      const am = ref.assistantMsgId ? history.find(m => m && m.id === ref.assistantMsgId) : null;
      if (um) {
        pushHistoryItem({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: um.id || ref.userMsgId || null,
                     ts: um.ts || ref.ts, text: core.messageText(um) });
      } else if (ref.excerpt) {
        // The message may have been trimmed out of history — keep the excerpt.
        pushHistoryItem({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: null, ts: ref.ts, text: ref.excerpt, lost: true });
      }
      if (am) {
        pushHistoryItem({ sessionId: ref.sessionId, sessionLabel: label, role: 'assistant',
                     messageId: am.id || ref.assistantMsgId || null,
                     ts: am.ts || ref.ts, text: core.messageText(am) });
      }
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    // Legacy ref-backed tasks share the pagination contract: ref history is
    // frozen, so index-derived ids are stable and the task-mode chat view can
    // open any historical task without a ledger.
    res.json({
      ok: true, task: taskDto(task), items, ...runProjection,
      ...transcriptPagePayload(items.map((item, index) => ({
        id: item.messageId || `legacy-${index}`,
        role: item.role,
        content: item.text,
        ts: item.ts || 0,
      })), req),
    });
  }

  function answerResult(res, target, result = {}, duplicate = false) {
    return res.json({
      ok: true,
      taskId: target.run.taskId,
      taskRunId: target.run.runId,
      requestId: String(target.pending.requestId || ''),
      queued: result.queued === true,
      status: 'answered',
      operationId: result.operationId || null,
      duplicate: duplicate || result.duplicate === true,
    });
  }

  async function handleAnswer(req, res) {
    const task = resolvedTask(req.params?.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const taskId = task.id;
    const requestId = String(req.body?.requestId || '').trim().slice(0, 160);
    const text = String(req.body?.text || '').trim().slice(0, 64 * 1024);
    const clientMsgId = String(req.body?.clientMsgId || '').trim().slice(0, 160);
    if (!requestId) return res.status(400).json({ error: 'request_id_required' });
    if (!text) return res.status(400).json({ error: 'empty_text' });
    if (!clientMsgId) return res.status(400).json({ error: 'client_msg_id_required' });
    const target = exactTaskRunTarget(taskId);
    if (!target.ok) return res.status(target.code === 'task_run_unavailable' ? 503 : 409)
      .json({ error: target.code });
    if (String(target.pending.requestId || '') !== requestId) {
      return res.status(409).json({ error: 'pending_request_mismatch' });
    }
    const key = `${target.run.runId}\0${requestId}`;
    const answerHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const receiptIdentity = {
      runId: target.run.runId, requestId, clientMsgId, answerHash,
    };
    if (!taskRuns || typeof taskRuns.reserveAnswerReceipt !== 'function'
        || typeof taskRuns.markAnswerAccepted !== 'function'
        || typeof taskRuns.getAnswerReceipt !== 'function') {
      return res.status(503).json({ error: 'task_run_answer_receipt_unavailable' });
    }

    if (target.pending.resolved === true) {
      let receipt;
      try { receipt = taskRuns.getAnswerReceipt(receiptIdentity); }
      catch (error) {
        logger.log(`[multicc/taskboard] answer receipt read failed: ${error?.code || 'unknown'}`);
        return res.status(503).json({ error: 'task_run_answer_receipt_unavailable' });
      }
      if (!receipt) return res.status(409).json({ error: 'answer_receipt_missing' });
      if (receipt.clientMsgId !== clientMsgId || receipt.answerHash !== answerHash) {
        return res.status(409).json({ error: 'idempotency_conflict' });
      }
      if (receipt.state === 'accepted') return answerResult(res, target, {}, true);
      // A crash may land after the canonical ingress accepted the clientMsgId
      // but before this receipt advanced. Retry the exact payload through that
      // ingress: its durable clientMsgId dedupe proves the enqueue before we
      // mark this receipt accepted.
    }

    let reservation;
    try { reservation = taskRuns.reserveAnswerReceipt(receiptIdentity); }
    catch (error) {
      if (error?.code === 'TASK_RUN_ANSWER_CONFLICT') {
        return res.status(409).json({ error: 'idempotency_conflict' });
      }
      logger.log(`[multicc/taskboard] answer receipt reserve failed: ${error?.code || 'unknown'}`);
      return res.status(503).json({ error: 'task_run_answer_receipt_unavailable' });
    }
    if (reservation.state === 'accepted') return answerResult(res, target, {}, true);

    const current = taskRunAnswers.get(key);
    if (current) {
      if (current.clientMsgId !== clientMsgId) {
        return res.status(409).json({ error: 'answer_in_progress' });
      }
      if (current.answerHash !== answerHash) {
        return res.status(409).json({ error: 'idempotency_conflict' });
      }
      try {
        const replay = await current.promise;
        if (!replay?.ok) {
          return res.status(502).json({ error: replay?.code || replay?.error || 'answer_failed' });
        }
        return answerResult(res, target, replay, true);
      } catch (error) {
        logger.log(`[multicc/taskboard] answer failed: ${error?.code || error?.message || 'unknown'}`);
        return res.status(502).json({ error: 'answer_failed' });
      }
    }

    const promise = Promise.resolve()
      .then(() => sendSessionMessage(target.slotId, text, {
        userInputRequestId: requestId,
        taskId,
        taskRunId: target.run.runId,
        leaseEpoch: target.leaseEpoch,
        originContinue: true,
        taskSource: 'task-board',
        clientMsgId,
      }))
      .then(result => {
        if (result?.ok) taskRuns.markAnswerAccepted(receiptIdentity);
        return result;
      });
    taskRunAnswers.set(key, { clientMsgId, answerHash, promise });
    try {
      const result = await promise;
      if (!result?.ok) {
        return res.status(502).json({ error: result?.code || result?.error || 'answer_failed' });
      }
      notify(core.taskDirId(board, task), [taskId]);
      return answerResult(res, target, result);
    } catch (error) {
      logger.log(`[multicc/taskboard] answer failed: ${error?.code || error?.message || 'unknown'}`);
      return res.status(502).json({ error: 'answer_failed' });
    } finally {
      if (taskRunAnswers.get(key)?.promise === promise) taskRunAnswers.delete(key);
    }
  }

  // Seed a not-yet-native bound session from durable task history.
  function coldStartSeed(boundId, task) {
    if (records.get(boundId)?.cliSessionId) return '';
    try {
      const identityIds = taskIdentityIds(task);
      const runBacked = new Map(identityIds.map(identityId => [
        identityId,
        taskRuns ? taskRuns.listTaskRuns(identityId).length > 0 : false,
      ]));
      // A surviving target already carries the union of source refs, and a
      // source that survived an earlier merge may itself carry descendant
      // refs. Assign each historical ref to the most specific member first
      // (fewest refs; canonical target last). Run-backed members still claim
      // their refs so the same turn is not injected again through an ancestor's
      // legacy fallback.
      const claimedRefs = new Set();
      const refsByIdentity = new Map();
      const claimOrder = identityIds.map(identityId => board.tasks[identityId])
        .filter(Boolean)
        .sort((left, right) => {
          if (left.id === task.id) return 1;
          if (right.id === task.id) return -1;
          return Number(runBacked.get(left.id)) - Number(runBacked.get(right.id))
            || (left.refs?.length || 0) - (right.refs?.length || 0)
            || String(left.id).localeCompare(String(right.id));
        });
      for (const member of claimOrder) {
        const owned = [];
        for (const ref of member.refs || []) {
          const sid = String(ref?.sessionId || '');
          const userKey = ref?.userMsgId ? `u\0${sid}\0${ref.userMsgId}` : '';
          const assistantKey = ref?.assistantMsgId ? `a\0${sid}\0${ref.assistantMsgId}` : '';
          if (userKey || assistantKey) {
            const projected = { ...ref,
              userMsgId: userKey && !claimedRefs.has(userKey) ? ref.userMsgId : null,
              assistantMsgId: assistantKey && !claimedRefs.has(assistantKey) ? ref.assistantMsgId : null,
              excerpt: userKey && claimedRefs.has(userKey) ? '' : ref.excerpt };
            if (userKey) claimedRefs.add(userKey);
            if (assistantKey) claimedRefs.add(assistantKey);
            if (projected.userMsgId || projected.assistantMsgId) owned.push(projected);
          } else {
            const key = `l\0${sid}\0${Number(ref?.ts) || 0}\0${String(ref?.excerpt || '')}`;
            if (!claimedRefs.has(key)) owned.push(ref);
            claimedRefs.add(key);
          }
        }
        refsByIdentity.set(member.id, owned);
      }
      const legacyById = new Map(identityIds.flatMap(identityId => {
        if (runBacked.get(identityId)) return [];
        const member = board.tasks[identityId];
        return member ? legacyImportMessages({
          ...member,
          refs: refsByIdentity.get(identityId) || [],
        }, { identityIds: [identityId] }) : [];
      }).map(message => [message.messageId, message]));
      const imports = contextMessages([...legacyById.values()]);
      const context = buildTaskRunContext({
        task,
        messages: [...storedTaskMessages(task.id), ...imports],
        includeCurrent: false,
      });
      // Layers concatenate with no separator, so the seed carries its own.
      return context.text.trim() ? `${context.text}\n\n` : '';
    } catch (_) { return ''; /* best-effort: the bare text always sends */ }
  }

  async function sendBoundSessionFollowupUnlocked(boundId, task, messageText, {
    clientKey, source, goalNote = '', commanderId = null,
  } = {}) {
    const beforeBoardMutation = JSON.parse(JSON.stringify(task));
    const taskContextSeed = coldStartSeed(boundId, task);
    const result = await sendSessionMessage(boundId, goalNote + messageText, {
      taskId: task.id,
      taskSource: source,
      clientMsgId: clientKey,
      ...(taskContextSeed ? { taskContextSeed } : {}),
    });
    if (!result || result.ok === false) {
      return result || { ok: false, code: 'dispatch_failed' };
    }
    // Project run state from the bound worker, not a drained legacy slot.
    core.setTaskRouting(task, {
      mode: 'commander',
      targetSessionId: commanderId || boundId,
      workerSessionId: boundId,
      operationId: result.operationId || '',
      status: 'admitted',
      oneWay: true,
      routedAt: Date.now(),
    });
    planning.markPlannedTaskStarted(task);
    if (!save()) {
      for (const key of Object.keys(task)) delete task[key];
      Object.assign(task, beforeBoardMutation);
      return { ok: false, code: 'persistence_failed', delivered: true };
    }
    notify(core.taskDirId(board, task), [task.id]);
    return {
      ...result, ok: result.ok !== false, taskId: task.id, taskBound: true,
      targetSessionId: boundId, workerSessionId: boundId, taskStart: false,
    };
  }

  async function sendBoundSessionFollowup(boundId, task, messageText, options = {}) {
    const release = holdTaskOperation(task?.id);
    try { return await sendBoundSessionFollowupUnlocked(boundId, task, messageText, options); }
    finally { release(); }
  }

  async function routeCommanderFollowup(commanderId, taskId, text, options = {}) {
    const commander = records.get(commanderId);
    const task = resolvedTask(taskId);
    if (!commander || commander.type !== 'commander' || commander.kind !== 'chat') {
      return { ok: false, code: 'commander_not_found' };
    }
    if (!task) return { ok: false, code: 'task_not_found' };
    const messageText = String(text || '').trim();
    if (!messageText) return { ok: false, code: 'empty_text' };
    const clientKey = String(options.clientMsgId || '').trim() || crypto.randomUUID();
    const source = options.source === 'commander' ? 'commander' : 'task-board';
    // Follow up through the bound chat; refuse while a legacy run owns it.
    if (latestOpenTaskRun(task.id)) {
      return {
        ok: false, code: 'task_run_open',
        error: '任务仍有池化旧运行未结束：请等它结束或先取消，再继续追问',
      };
    }
    const bound = await ensureBoundChatSession(task, { dirId: commander.dirId });
    if (!bound?.ok) {
      logger.log(`[multicc/taskboard] follow-up bound-session resolve failed for ${taskId}: ${bound?.code || 'unknown'}`);
      return bound || { ok: false, code: 'chat_session_create_failed' };
    }
    return sendBoundSessionFollowup(bound.sessionId, task, messageText, {
      clientKey, source, goalNote: String(options.goalNote || ''), commanderId,
    });
  }

  async function handleSend(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const userAnswerRequestId = String(req.body?.userInputRequestId || '').trim().slice(0, 160);
    if (userAnswerRequestId) {
      req.body.requestId = userAnswerRequestId;
      return handleAnswer(req, res);
    }
    const expected = req.body?.expectedRevision ?? req.body?.revision;
    if (task.recordType === 'planned' && expected != null) {
      const checked = planning.validateExpectedRevision(task, expected);
      if (!checked.ok) return res.status(checked.error === 'revision_conflict' ? 409 : 400).json(checked);
    }
    const text = String(req.body?.text ?? req.body?.message ?? '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const explicit = String(req.body?.target || '').trim() || null;
    if (explicit) {
      // Task-board input always enters the task's virtual session; there is no
      // session picking on this ingress.
      return res.status(409).json({
        error: 'manual_target_unsupported',
        note: '任务板消息一律进入任务的虚拟会话，不支持指定会话',
      });
    }
    const followupKey = requestKey(req);
    const routeMode = 'commander';
    const dirId = core.taskDirId(board, task);
    if (commanderMigrationFailure(res, dirId)) return;
    const commander = core.resolveDirectoryCommander(records, dirId);
    if (!commander.ok) return commanderFailure(res, commander.code);
    const target = commander.sessionId;
    const result = await routeCommanderFollowup(target, task.id, text, {
      clientMsgId: followupKey,
      source: 'task-board',
      goalNote: goalNoteFor(req.body),
    });
    if (!result?.ok) {
      const busy = result?.code === 'target_busy' || result?.error === 'target_busy'
        || result?.code === 'task_run_open';
      return res.status(busy ? 409 : result?.code === 'persistence_failed' ? 500 : 502)
        .json({ error: result?.code || result?.error || 'dispatch_failed' });
    }
    if (result.taskBound === true) {
      // P1-b1: the follow-up went straight to the task-bound chat session —
      // no commander, no slot, no TaskRun ledger row. The card's runState now
      // aggregates the bound session's classify state like any legacy ref.
      return res.json({
        ok: true,
        taskBound: true,
        target: result.targetSessionId,
        targetLabel: records.get(result.targetSessionId)?.label || result.targetSessionId,
        routingMode: 'task-bound',
        commanderSessionId: null,
        workerSessionId: result.targetSessionId,
        workerLabel: records.get(result.targetSessionId)?.label || null,
        queued: result.queued === true,
        chatId: result.chatId,
        operationId: result.operationId || null,
        taskRunId: null,
        task: taskDto(task),
        revision: board.revision,
      });
    }
    res.json({
      ok: true,
      target,
      targetLabel: records.get(target)?.label || target,
      routingMode: routeMode,
      commanderSessionId: routeMode === 'commander' ? target : null,
      workerSessionId: routeMode === 'commander' ? result.workerSessionId || result.targetSessionId : null,
      workerLabel: routeMode === 'commander' ? result.targetLabel : null,
      queued: routeMode === 'commander' && result.queued === true,
      chatId: result.chatId,
      operationId: result.operationId || null,
      taskRunId: null,
      task: taskDto(task),
      revision: board.revision,
    });
  }

  async function dispatchTaskStartUnlocked({
    source, dirId, target, routeMode, text, clientKey, goalNote = '',
    runtime = null,
  }) {
    const taskId = stableTaskId(`${source}:${dirId || ''}`, clientKey);
    const existing = board.tasks[taskId];
    if (existing?.routing?.operationId) {
      const routeChanged = existing.routing.mode !== routeMode
        || (routeMode === 'manual' && existing.routing.targetSessionId !== target);
      if (routeChanged) {
        return {
          ok: false,
          code: 'idempotency_conflict',
          error: 'idempotency key reused with different routing',
        };
      }
    }
    const effectiveRouteMode = existing?.routing?.mode || routeMode;
    const effectiveTarget = existing?.routing?.targetSessionId || target;
    if (effectiveRouteMode === 'manual'
        && records.get(effectiveTarget)?.taskExecutionSlot === true) {
      return { ok: false, code: 'no_relevant_target' };
    }
    const taskShape = { id: taskId, title: core.PENDING_TASK_TITLE };
    const replayOperationId = existing?.routing?.operationId || null;
    // A fresh Commander route binds a hidden chat and uses canonical ingress.
    if (effectiveRouteMode === 'commander' && !replayOperationId) {
      if (existing && latestOpenTaskRun(taskId)) {
        return {
          ok: false, code: 'task_run_open',
          error: '任务仍有池化旧运行未结束：请等它结束或先取消，再重新发送',
        };
      }
      if (!createSessionRecord) {
        return { ok: false, code: 'chat_session_unavailable' };
      }
      // Bind first, card second: createPendingTask requires a sessionId (the
      // provenance ref), and the session needs the deterministic taskId for
      // its taskBoundTaskId marker. For a fresh task a shim stands in; an
      // existing card (e.g. classify-seeded) binds through its live record.
      const bindTarget = existing
        || { id: taskId, title: core.PENDING_TASK_TITLE, refs: [] };
      const bound = await ensureBoundChatSession(bindTarget, { dirId, runtime });
      if (!bound?.ok) {
        logger.log(`[multicc/taskboard] bound-session create failed for ${taskId}: ${bound?.code || 'unknown'}`);
        return bound || { ok: false, code: 'chat_session_create_failed' };
      }
      const sent = await sendSessionMessage(bound.sessionId, goalNote + text, {
        taskId,
        taskStart: true,
        taskSource: source,
        taskText: text,
        clientMsgId: clientKey,
      });
      if (!sent || sent.ok === false) {
        return sent || { ok: false, code: 'dispatch_failed' };
      }
      // The card's provenance ref IS the bound session: the task transcript
      // projection and this chat view then read the same history.
      const pre = ensureTaskIndex({
        taskId, dirId, sessionId: bound.sessionId, taskText: text,
        // Only a card this send brings into being is a board task. Re-sending
        // into a card that already existed (a classify-seeded one, say) routes
        // it; it does not rewrite where it came from.
        origin: existing ? null : core.taskOriginForSource(source),
        routing: null, now: Date.now(),
      });
      if (!pre.task) {
        return { ok: false, code: 'dispatch_failed' };
      }
      if (!pre.task.chatSessionId) {
        updateBoardTask(taskId, { chatSessionId: bound.sessionId });
      }
      // Synthetic stable operation id: the chat FIFO owns real delivery
      // idempotency; this marker only lets a replayed taskStart recognise
      // the bound routing receipt and answer duplicate without resending.
      const receiptOperationId = sent.operationId || `task-bound:${taskId}`;
      core.setTaskRouting(pre.task, {
        mode: 'commander',
        targetSessionId: effectiveTarget,
        workerSessionId: bound.sessionId,
        operationId: receiptOperationId,
        status: sent.queued === true ? 'queued' : 'admitted',
        oneWay: true,
        routedAt: Date.now(),
      });
      save();
      notify(dirId, [taskId], pre.created ? 'created' : undefined);
      return {
        ...sent,
        ok: true,
        taskId,
        taskBound: true,
        taskStart: true,
        routeMode: 'task-bound',
        target: bound.sessionId,
        targetSessionId: bound.sessionId,
        workerSessionId: bound.sessionId,
        operationId: receiptOperationId,
      };
    }
    // Replay (the task already routed): never re-admit a run. The recorded
    // operation id reproduces the original idempotency key (it is the run id
    // for legacy pooled routes); a fresh manual route is the only non-replay
    // path left below — the pooled Commander admission is gone (#38).
    let replayRun = null;
    if (replayOperationId && effectiveRouteMode === 'commander' && taskRuns) {
      try {
        replayRun = (taskRuns.listTaskRuns(taskId) || [])
          .find(run => run.runId === replayOperationId) || null;
      } catch (_) { replayRun = null; }
    }
    const routed = effectiveRouteMode === 'commander'
      ? core.buildCommanderRoutedMessage(taskShape, text)
      : core.buildRoutedMessage(taskShape, text);
    const message = goalNote + routed;
    const idempotencyKey = replayOperationId && effectiveRouteMode === 'commander'
      ? `task-run:${replayOperationId}`
      : `task-start:${taskId}`;
    const taskContext = {
      taskId,
      taskStart: true,
      taskSource: source,
      taskText: text,
    };
    let result;
    try {
      if (existing?.routing?.operationId) {
        const originalWorker = existing.routing.workerSessionId
          || existing.routing.targetSessionId;
        if (records.get(originalWorker)?.taskBoundTaskId === taskId) {
          // Bound-session receipt: the chat FIFO owns the real idempotency —
          // a replay answers duplicate from the recorded routing, never a
          // second turn and never the one-way slot dispatch below.
          result = {
            ok: true,
            duplicate: true,
            taskBound: true,
            targetSessionId: originalWorker,
            targetLabel: records.get(originalWorker)?.label || originalWorker,
            queued: existing.routing.status === 'queued',
            status: existing.routing.status || 'admitted',
            operationId: existing.routing.operationId,
          };
        } else if (replayRun) {
          // The durable queue already holds this operation; a replay must not
          // re-admit it (the lease may have advanced since, which the outbox
          // would rightfully reject as a payload conflict). Answer from the
          // recorded routing instead.
          result = {
            ok: true,
            duplicate: true,
            targetSessionId: originalWorker,
            targetLabel: records.get(originalWorker)?.label || originalWorker,
            queued: existing.routing.status === 'queued',
            status: existing.routing.status || 'admitted',
            operationId: existing.routing.operationId,
          };
        } else {
          result = await dispatchToSession(originalWorker, message, {
            ownerSessionId: existing.routing.mode === 'commander'
              ? existing.routing.targetSessionId
              : undefined,
            idempotencyKey,
            oneWay: true,
            requireIdle: false,
            ...taskContext,
          });
          if (result?.ok) {
            result = {
              ...result,
              duplicate: true,
              targetSessionId: originalWorker,
              targetLabel: records.get(originalWorker)?.label || originalWorker,
              queued: existing.routing.status === 'queued',
            };
          }
        }
      } else {
        result = await dispatchToSession(effectiveTarget, message, {
          idempotencyKey, oneWay: true, requireIdle: false, ...taskContext,
        });
      }
    } catch (error) {
      result = {
        ok: false,
        code: error?.code === 'OPERATION_CONFLICT'
          ? 'idempotency_conflict'
          : error?.code || null,
        error: error?.message || 'dispatch_failed',
      };
    }
    if (!result?.ok) {
      return result || { ok: false, error: 'dispatch_failed' };
    }
    const workerSessionId = effectiveRouteMode === 'commander'
      ? result.targetSessionId
      : result.chatId || effectiveTarget;
    const routedAt = Date.now();
    const indexed = ensureTaskIndex({
      taskId,
      taskRunId: null,
      leaseEpoch: null,
      dirId,
      sessionId: workerSessionId,
      taskText: text,
      routing: {
        mode: effectiveRouteMode,
        targetSessionId: effectiveTarget,
        workerSessionId: effectiveRouteMode === 'commander' ? workerSessionId : '',
        operationId: result.operationId || '',
        status: result.status || 'admitted',
        oneWay: true,
        routedAt,
      },
      now: routedAt,
    });
    if (indexed.task) {
      indexed.task.runState = result.status === 'running' ? 'running' : 'queued';
    }
    save();
    notify(dirId, [taskId], indexed.created ? 'created' : undefined);
    return {
      ...result,
      taskId,
      target: effectiveTarget,
      routeMode: effectiveRouteMode,
      workerSessionId,
    };
  }

  async function dispatchTaskStart(options = {}) {
    const taskId = stableTaskId(
      `${options.source || ''}:${options.dirId || ''}`,
      options.clientKey,
    );
    const release = holdTaskOperation(taskId);
    try { return await dispatchTaskStartUnlocked(options); }
    finally { release(); }
  }

  // Board input always enters the task's virtual session: dispatchTaskStart opens
  // a TaskRun and routes through the Commander host router, so the Commander LLM
  // is never in the routing decision loop and there is no session picking.
  async function handleBoardSend(req, res) {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const dirId = String(req.body?.dirId || '').trim() || null;
    const explicit = String(req.body?.target || '').trim() || null;
    if (explicit) {
      return res.status(409).json({
        error: 'manual_target_unsupported',
        note: '任务板消息一律进入任务的虚拟会话，不支持指定会话',
      });
    }
    if (commanderMigrationFailure(res, dirId)) return;
    const commander = core.resolveDirectoryCommander(records, dirId);
    if (!commander.ok) return commanderFailure(res, commander.code);
    const target = commander.sessionId;
    const routeMode = 'commander';
    const clientKey = requestKey(req);
    // Composer runtime picks (指定 cli/provider): applied at bound-session
    // creation only; empty strings mean "no pick" (commander inheritance).
    const pickCli = String(req.body?.cli || '').trim();
    const pickProvider = String(req.body?.provider || '').trim();
    const pickModel = String(req.body?.model || '').trim();
    // Auto Provider pick: a virtual pool, not a provider id. It is passed
    // through untouched — createSessionRecord owns the one validator (catalog,
    // protocol, trust domain, attempt budget) and rejects a bad pool there.
    const rawSelection = req.body?.providerSelection;
    const pickSelection = rawSelection && typeof rawSelection === 'object' && !Array.isArray(rawSelection)
      ? rawSelection
      : null;
    const runtime = (pickCli || pickProvider || pickModel || pickSelection)
      ? {
        ...(pickCli ? { cli: pickCli } : {}),
        ...(pickProvider ? { provider: pickProvider } : {}),
        ...(pickModel ? { model: pickModel } : {}),
        ...(pickSelection ? { providerSelection: pickSelection } : {}),
      }
      : null;
    const result = await dispatchTaskStart({
      source: 'task-board',
      dirId: routeMode === 'commander' ? (records.get(target)?.dirId || dirId) : dirId,
      target,
      routeMode,
      text,
      clientKey,
      goalNote: goalNoteFor(req.body),
      ...(runtime ? { runtime } : {}),
    });
    if (!result.ok) {
      const conflict = result.code === 'idempotency_conflict';
      const busy = result.code === 'target_busy' || result.error === 'target_busy'
        || result.code === 'task_run_open';
      return res.status(busy || conflict ? 409 : 502).json({
        error: result.code || result.error || 'dispatch_failed',
      });
    }
    if (result.taskBound === true) {
      // P1-b2: first turn opened on the task-bound hidden chat session — no
      // commander hop, no slot, no TaskRun ledger row.
      return res.json({
        ok: true,
        taskId: result.taskId,
        taskBound: true,
        target: result.targetSessionId,
        targetLabel: records.get(result.targetSessionId)?.label || result.targetSessionId,
        routingMode: 'task-bound',
        commanderSessionId: null,
        workerSessionId: result.targetSessionId,
        workerLabel: records.get(result.targetSessionId)?.label || null,
        queued: result.queued === true,
        chatId: result.chatId || result.targetSessionId,
        operationId: result.operationId || null,
        duplicate: result.duplicate === true,
      });
    }
    // Fallback when no TaskRun store is wired: the task is still created and
    // routed deterministically, only the run receipt is skipped.
    res.json({
      ok: true,
      taskId: result.taskId,
      target,
      targetLabel: records.get(target)?.label || target,
      routingMode: 'commander',
      commanderSessionId: target,
      workerSessionId: result.workerSessionId || null,
      workerLabel: result.workerSessionId
        ? records.get(result.workerSessionId)?.label || result.workerSessionId
        : null,
      queued: result.queued === true,
      chatId: target,
      operationId: result.operationId || null,
      duplicate: result.duplicate === true,
    });
  }

  // Stopping a task's open run is shared by two entries: marking the task
  // done (lifecycle change) and the chat view's stop button (cancel-run, no
  // lifecycle change). One path, one 409 surface — only the status write
  // differs. Returns { ok:true, openRun|null } or { ok:false, status, body }.
  async function cancelOpenTaskRun(task) {
    let openRun = null;
    try { openRun = latestOpenTaskRun(task.id); }
    catch (_) {
      return { ok: false, status: 409, body: { error: 'task_run_state_unavailable' } };
    }
    if (!openRun) return { ok: true, openRun: null };
    const operationId = String(task.routing?.operationId || '').trim();
    if (!openRun.slotId) {
      if (!operationId || !cancelUndeliveredTaskRun) {
        return { ok: false, status: 409, body: { error: 'task_run_cancel_unavailable' } };
      }
      let cancelled;
      try {
        cancelled = await cancelUndeliveredTaskRun(operationId, {
          taskId: task.id, runId: openRun.runId,
        });
      } catch (error) {
        logger.log(`[multicc/taskboard] task-run dispatch cancel failed: ${error?.code || error?.message || 'unknown'}`);
        return { ok: false, status: 409, body: { error: 'task_run_cancel_failed' } };
      }
      if (!(cancelled?.ok === true && cancelled?.neverDelivered === true)) {
        return { ok: false, status: 409, body: {
          error: cancelled?.code || 'task_run_delivery_not_cancellable',
        } };
      }
    }
    if (!terminateTaskRun) {
      return { ok: false, status: 409, body: { error: 'task_run_termination_unavailable' } };
    }
    let terminated;
    try {
      terminated = await terminateTaskRun({
        taskId: task.id,
        runId: openRun.runId,
        leaseEpoch: Number(openRun.leaseEpoch) || null,
        ...(openRun.slotId
          ? { slotId: openRun.slotId }
          : { neverDelivered: true }),
      });
    } catch (error) {
      logger.log(`[multicc/taskboard] task-run termination failed: ${error?.code || error?.message || 'unknown'}`);
      return { ok: false, status: 409, body: { error: 'task_run_termination_failed' } };
    }
    const alreadyTerminal = terminated?.duplicate === true
      || ['already_terminal', 'task_run_closed'].includes(terminated?.code);
    if (!(terminated === true || terminated?.ok === true || alreadyTerminal)) {
      return { ok: false, status: 409, body: {
        error: terminated?.code || 'task_run_termination_failed',
      } };
    }
    return { ok: true, openRun };
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
    const bound = await ensureBoundChatSession(task, { adoptOrigin: true });
    if (!bound.ok) {
      const status = bound.code === 'chat_session_unavailable' ? 501
        : bound.code === 'directory_not_found' ? 409 : 502;
      return res.status(status).json({ error: bound.code });
    }
    return res.json({ ok: true, sessionId: bound.sessionId, created: bound.created,
      ...(bound.adopted ? { adopted: true } : {}) });
  }

  async function handleCancelRunUnlocked(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const stopped = await cancelOpenTaskRun(task);
    if (!stopped.ok) return res.status(stopped.status).json(stopped.body);
    if (!stopped.openRun) {
      return res.json({ ok: true, cancelled: false, task: taskDto(task) });
    }
    const queues = await resolveLegacySessionQueues(task,
      '会话仍占用该任务；请稍后重试。');
    if (!queues.ok) return res.status(queues.status).json(queues.body);
    res.json({
      ok: true, cancelled: true, runId: stopped.openRun.runId, task: taskDto(task),
    });
  }

  async function handleCancelRun(req, res) {
    const release = holdTaskOperation(req.params?.taskId);
    try { return await handleCancelRunUnlocked(req, res); }
    finally { release(); }
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
      const stopped = await cancelOpenTaskRun(task);
      if (!stopped.ok) return res.status(stopped.status).json(stopped.body);
      // Done is a lifecycle finalization: legacy queues resolve even when no
      // open run exists (e.g. pre-TaskRun tasks with plain session refs).
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
    const release = holdTaskOperation(req.params?.taskId);
    try { return await handleStatusUnlocked(req, res); }
    finally { release(); }
  }

  const handleMergeTasks = createTaskMergeHandler({
    board, core, taskRuns, getSessionRunState, isOpenTaskRun,
    activeTaskOperations, taskIdentityIds, resolvedTask, taskDto,
    persist: () => { if (!save()) throw new Error('persistence_failed'); },
    notify, logger,
  });

  async function handleArchiveCompleted(req, res) {
    const dirId = String(req.body?.dirId || '').trim() || null;
    const taskIds = [];
    const now = Date.now();
    for (const task of Object.values(board.tasks)) {
      if (task.status === 'archived') continue;
      if (dirId && core.taskDirId(board, task) !== dirId) continue;
      // Archive is a lifecycle operation. A succeeded turn is not a completed
      // task, so only an explicit user-set `done` status is eligible.
      if (task.status !== 'done') continue;
      task.status = 'archived';
      task.updatedAt = now;
      taskIds.push(task.id);
    }
    const releasedSessions = 0;
    if (taskIds.length) {
      save();
      notify(dirId, taskIds);
    }
    res.json({ ok: true, archivedCount: taskIds.length, releasedSessions, taskIds });
  }

  function handleReclassify(req, res) {
    const task = resolvedTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    if (!task.moduleAssignment) return res.status(409).json({ error: 'not_pending' });
    const result = queueTaskClassification(task.id, { manual: true });
    if (!result.ok) {
      const status = ['aux_unhealthy', 'context_unavailable'].includes(result.error) ? 503 : 409;
      const note = result.error === 'aux_unhealthy'
        ? '归类服务（aux）暂不可用，请稍后重试'
        : result.error === 'context_unavailable'
          ? '任务上下文暂时无法读取，请稍后重试'
        : null;
      return res.status(status).json({ error: result.error, note });
    }
    res.json({ ...result, task: taskDto(task) });
  }

  function handleReclassifyPending(req, res) {
    const dirId = String(req.body?.dirId || '').trim() || null;
    let queued = 0;
    let archived = 0;
    let skipped = 0;
    for (const task of Object.values(board.tasks)) {
      if (!task.moduleAssignment || task.status === 'archived') continue;
      const mod = task.moduleId ? board.modules[task.moduleId] : null;
      const taskDirId = mod?.dirId || task.refs.find(r => r.dirId)?.dirId || null;
      if (dirId && taskDirId !== dirId) continue;
      const result = queueTaskClassification(task.id, { manual: true });
      if (result.queued) queued++;
      else if (result.archived) archived++;
      else skipped++;
    }
    res.json({ ok: true, queued, archived, skipped });
  }

  const planningRuntime = createTaskPlanningRuntime({
    getBoard: () => board,
    commitMutation: commitPlanningMutation,
    taskDto,
    resolveTask: resolvedTask,
    taskDirId: task => core.taskDirId(board, task),
    notify,
    hasDirectory: resolveDirectoryPort ? dirId => !!resolveDirectoryPort(dirId) : null,
    beforeStageChange: async task => {
      const stopped = await cancelOpenTaskRun(task);
      if (!stopped.ok) return stopped;
      return resolveLegacySessionQueues(task,
        '当前任务仍在执行；请先取消，或等待其进入冻结状态后再移动到已完成。');
    },
    logger,
  });

  function mountRoutes(app) {
    planningRuntime.mountRoutes(app);
    app.get('/api/task-board', handleBoard);
    // Composer runtime suggestion: "recently active" = the newest mtime in the
    // chat_history store maps to a live chat record — its (cli, provider, model)
    // is what the user last actually ran, which is a better default than any
    // configured constant. Synthetic histories (__aux__/__gateway__) and
    // execution slots are never a provider source.
    app.get('/api/task-board/suggested-runtime', (req, res) => {
      try {
        const dir = chatHistoryDir
          || createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).chatHistoryDir;
        let newest = null;
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.json') || name.startsWith('__')) continue;
          const id = name.slice(0, -'.json'.length);
          const record = records.get(id);
          if (!record || record.kind !== 'chat' || record.taskExecutionSlot) continue;
          const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { mtime, record };
        }
        if (newest) {
          const r = newest.record;
          return res.json({
            ok: true, source: 'recent',
            cli: r.cli || 'claude', provider: r.provider || '', model: r.model || null,
          });
        }
      } catch (_) { /* fall through to defaults */ }
      res.json({ ok: true, source: 'default', cli: 'claude', provider: '', model: null });
    });
    app.get('/api/task-board/tasks/:taskId', handleTask);
    app.get('/api/task-board/tasks/:taskId/messages', handleMessages);
    app.post('/api/task-board/tasks/:taskId/send', (req, res) => {
      handleSend(req, res).catch(e => {
        logger.log(`[multicc/taskboard] send failed: ${e?.message || e}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/tasks/:taskId/answer', (req, res) => {
      handleAnswer(req, res).catch(e => {
        logger.log(`[multicc/taskboard] answer failed: ${e?.message || e}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/tasks/:taskId/status', (req, res) => {
      // Return the promise so harness callers can await the full handler.
      return handleStatus(req, res).catch(error => {
        logger.log(`[multicc/taskboard] status update failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/tasks/:taskId/cancel-run', (req, res) => {
      handleCancelRun(req, res).catch(error => {
        logger.log(`[multicc/taskboard] cancel-run failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/tasks/:taskId/chat-session', (req, res) => {
      // Return the promise so harness callers can await the full handler.
      return handleChatSession(req, res).catch(error => {
        logger.log(`[multicc/taskboard] chat-session failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/tasks/:targetTaskId/merge-tasks', handleMergeTasks);
    app.post('/api/task-board/archive-completed', handleArchiveCompleted);
    app.post('/api/task-board/tasks/:taskId/reclassify', handleReclassify);
    app.post('/api/task-board/send', (req, res) => {
      // Return the promise so harness callers can await the full handler.
      return handleBoardSend(req, res).catch(e => {
        logger.log(`[multicc/taskboard] board send failed: ${e?.message || e}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/backfill', (req, res) => {
      handleBackfill(req, res).catch(e => {
        logger.log(`[multicc/taskboard] backfill failed: ${e?.message || e}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/reclassify-pending', handleReclassifyPending);
  }

  // Recover interrupted module assignment and retire already-confirmed stale
  // cards once after startup. Fresh automatic work is driven by the settled
  // task-attribution hook, so startup never floods the shared serial Aux lane.
  const startupTimer = setTimeout(() => scanPendingClassifications(), 1_000);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  return Object.freeze({
    mountRoutes,
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
    routeCommanderInput: async (commanderId, text, options = {}) => {
      const commander = records.get(commanderId);
      if (!commander || commander.type !== 'commander' || commander.kind !== 'chat') {
        return { ok: false, code: 'commander_not_found' };
      }
      const messageText = String(text || '').trim();
      if (!messageText) return { ok: false, code: 'empty_text' };
      const clientKey = String(options.clientMsgId || options.idempotencyKey || '').trim()
        || crypto.randomUUID();
      const source = options.source === 'task-board' ? 'task-board' : 'commander';
      return dispatchTaskStart({
        source,
        dirId: commander.dirId,
        target: commanderId,
        routeMode: 'commander',
        text: messageText,
        clientKey,
        goalNote: String(options.goalNote || ''),
      });
    },
    routeCommanderFollowup,
    autoRetryTaskRun,
    notifyTaskRun,
    // test/introspection surface
    getBoard: () => board,
    save,
    // M3: null unless git deps were injected — callers must feature-check.
    taskWorktree,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

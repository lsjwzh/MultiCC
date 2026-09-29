'use strict';

// Task-board runtime: persistence, classification, dispatch and REST wiring.

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board/core');
const planning = require('../task-board/planning');
const attention = require('../task-board/attention');
const { isVoiceRouterRecord } = require('../voice/router');
const { runStateForFreezeReason } = require('../session-work/scheduler');
const { runStateForClassify: runStateForLetter } = require('../classify/vocab');
const { buildTaskRunContext: defaultBuildTaskRunContext } = require('../task-board/turn-context');
const { createTaskWorktreeService } = require('../task-worktree');
const { taskFields } = require('../task-display-attribution');
const { assertTaskBoardDeps, createRelatedTaskLinker } = require('../task-board/runtime-helpers');
const { createColdStartSeed } = require('../task-board/cold-start-seed');
const { createTaskRetention } = require('../task-board/retention');
const { createTaskPlanningRuntime } = require('./task-planning');

function createTaskBoardRuntime(deps) {
  assertTaskBoardDeps(deps);
  const {
    file, auxQueue, records, loadHistory, dispatchToSession,
    sendSessionMessage,
    workspaceBroadcast, atomicWriteJson, isSystemInjected,
    getSessionRunState,
  } = deps;
  const buildTaskRunContext = deps.buildTaskRunContext || defaultBuildTaskRunContext;
  const resolveSessionQueue = typeof deps.resolveSessionQueue === 'function'
    ? deps.resolveSessionQueue
    : async () => ({ ok: false, code: 'no_active_task' });
  // P1 task-bound hidden sessions: creates ordinary chat records carrying the
  // taskBoundTaskId marker. Optional in reduced hosts/tests — without it the
  // chat-session endpoint answers an explicit 501 instead of crashing.
  const createSessionRecord = typeof deps.createSessionRecord === 'function'
    ? deps.createSessionRecord : null;
  const logger = deps.logger || console;

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
    board.deletedTaskIds = candidate.deletedTaskIds || [];
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
        beginTaskOperation: holdTaskOperation,
        logger,
      })
    : null;


  function stableTaskId(source, requestKey) {
    const digest = crypto.createHash('sha256')
      .update(`${source}\0${requestKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return `tsk-${digest}`;
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
    if (task.status === 'archived' || task.deleting) return { ok: false, error: 'task_archived' };
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
      if (current.deleting) return;
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
      if (!assignment || task.status === 'archived' || task.deleting) continue;
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
      if (task.titleSource !== 'manual' && task.title === core.PENDING_TASK_TITLE && nextTitle) {
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
    return runStateForLetter(classifyState || 'D');
  }

  function runStateForTurnOutcome(turnOutcome, classifyState) {
    if (turnOutcome === 'succeeded') return 'succeeded';
    if (turnOutcome === 'failed') return 'error';
    // Same projection as the classify letter it came from, so a turn that idled
    // on a background job reads `background` here too — never `waiting`, which
    // would tell the user to answer something nobody asked.
    if (turnOutcome === 'waiting_user') return runStateForLetter('W');
    if (turnOutcome === 'waiting_background') return runStateForLetter('B');
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

  // `claim_released` 是「调度器把一次占用交还回来」，不是「有东西在排队」——
  // 两者被当成同一件事，就是卡片永远停在「排队中」的原因：delivery_deferred
  // 的投递重试每分钟 claimed → claim_released 各一次，每次 release 都把卡片刷
  // 成「排队中」，而事件自己写着 queued:0 / queuedItems:[]。重试停下之后没人再
  // 写这张卡，它就把最后那一笔「排队」一直挂下去。
  //
  // 事件里带着 release 之后调度器的真实样子，所以这里不需要猜。
  function runStateForClaimReleased(event) {
    // 中途释放那一支不是清空而是冻结（调度器会继续往前推，对 UI 就是 running）；
    // 原因→状态走和 `frozen` 事件同一张共享映射表。
    if (event.freezeReason) return runStateForFreezeReason(event.freezeReason);
    // 释放之后还压着东西 —— 那才叫排队。
    const depth = Array.isArray(event.queuedItems) ? event.queuedItems.length : null;
    // 读不到深度时保守退回旧投影，不猜。当前没有生产者会漏 queuedItems。
    if (depth === null || depth > 0) return 'queued';
    // 一条都不剩：卡片读这个会话真正落定的判定 —— 交还的占用不等于排队。
    return runStateForClassify(event.queueSummary?.classifyState);
  }

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
    if (type === 'claim_released') runState = runStateForClaimReleased(event);
    else if (type === 'queued') runState = 'queued';
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
  // task-board/view.js 的 sessionHasTurn / deadDispatchClaim）。读侧把这类卡片的
  // 乐观「执行中」投影成空闲 —— 只影响这一份 DTO，卡片本身与落盘数据都不动。
  const sessionHasTurn = sessionId => core.sessionHasTurn(records.get(sessionId));

  function taskDto(task) {
    const dto = core.buildBoardDto({
      modules: board.modules,
      tasks: { [task.id]: task },
      taskGroups: board.taskGroups,
    }, getSessionRunState, { sessionHasTurn }).tasks[0];
    dto.mergedTaskCount = Math.max(0, taskIdentityIds(task).length - 1); Object.assign(dto, taskFields(task, deps.taskShortCode));
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

  const coldStartSeed = createColdStartSeed({
    records, board, buildTaskRunContext,
    taskIdentityIds, legacyImportMessages, contextMessages,
  });

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
    if (task.status === 'archived' || task.deleting || taskLifecycle.isBusy(task.id)) return { ok: false, code: 'task_archived' };
    if (!messageText) return { ok: false, code: 'empty_text' };
    const clientKey = String(options.clientMsgId || '').trim() || crypto.randomUUID();
    const source = options.source === 'commander' ? 'commander' : 'task-board';
    const bound = await ensureBoundChatSession(task, { dirId: commander.dirId });
    if (!bound?.ok) {
      logger.log(`[multicc/taskboard] follow-up bound-session resolve failed for ${taskId}: ${bound?.code || 'unknown'}`);
      return bound || { ok: false, code: 'chat_session_create_failed' };
    }
    return sendBoundSessionFollowup(bound.sessionId, task, messageText, {
      clientKey, source, goalNote: String(options.goalNote || ''), commanderId,
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

  function mountRoutes(app) {
    planningRuntime.mountRoutes(app);
    const retentionRoute = handler => async (req, res) => {
      try {
        const dirId = req.params.dirId;
        if (!deps.directories?.get(dirId)) return res.status(404).json({ ok: false, code: 'directory_not_found' });
        if (typeof deps.listShellTasks !== 'function') return res.status(503).json({ ok: false, code: 'task_inventory_unavailable' });
        return res.json({ ok: true, ...await handler(dirId, () => deps.listShellTasks(), req) });
      } catch (error) {
        return res.status(error.status || 500).json({ ok: false, code: error.code || 'retention_failed' });
      }
    };
    app.get('/api/task-board/directories/:dirId/retention', retentionRoute((dirId, list) => retention.preview(dirId, list)));
    app.post('/api/task-board/directories/:dirId/retention', retentionRoute((dirId, list, req) =>
      retention.deleteSelected(dirId, list, req.body?.taskIds)));
    app.post('/api/task-board/tasks/:taskId/status', (req, res) => {
      // Return the promise so harness callers can await the full handler.
      return handleStatus(req, res).catch(error => {
        logger.log(`[multicc/taskboard] status update failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.delete?.('/api/task-board/tasks/:taskId', taskLifecycle.delete);
    app.post('/api/task-board/tasks/:taskId/relocate', (req, res) => taskRelocate.relocate(req, res)
      .catch(error => { logger.log(`[multicc/taskboard] relocate failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' }); }));
    app.post('/api/task-board/tasks/:taskId/chat-session', (req, res) => {
      // Return the promise so harness callers can await the full handler.
      return handleChatSession(req, res).catch(error => {
        logger.log(`[multicc/taskboard] chat-session failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
  }

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
    mountRoutes, isTaskLifecycleBusy: id => taskLifecycle.isBusy(id),
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

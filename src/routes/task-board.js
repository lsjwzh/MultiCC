'use strict';

// Task board runtime — wires the pure core (src/task-board.js) to the host:
// aux-queue tagging at turn end, atomic persistence, REST routes for the
// fleet panel, the panel composer's auto-routed dispatch, and manual module
// assignment for cards that remain under 「待归类」.
//
// Host contract (all deps injected by server.js):
//   file               — task_board.json path (from createPaths)
//   auxQueue           — { enqueue, cancel, isUnhealthy } from mountAuxGoalRoutes
//   records            — persistedSessions Map (sessionId → record)
//   loadHistory        — sessionId → message[] (READ-ONLY view, NOT a copy: the
//                        array and its messages are shared with the chat history
//                        cache. Board code may only read them; anything kept
//                        beyond the call must be a copied primitive, which is
//                        why refs store ids and timestamps rather than messages.
//                        This route scans a transcript per task, so cloning here
//                        cost O(tasks × sessions × transcript) per board load.)
//   dispatchToSession  — durable dispatch; Commander access requires an internal flag
//   sendSessionMessage  — canonical per-session ingress used by WebSocket and task board
//   workspaceBroadcast — (dirId, payload) → void (reaches /ws/meta clients)
//   atomicWriteJson    — (file, value) → void
//   isSystemInjected   — msgText → bool (skip recovery/nudge turns)

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board');
const { isVoiceRouterRecord } = require('../voice-router');
const { runStateForFreezeReason } = require('../session-work-scheduler');
const { classifyDisplay } = require('../classify/vocab');
const { publicRunDto } = require('./task-runs');
const {
  buildTaskRunContext: defaultBuildTaskRunContext,
  isTaskRunWrapperText,
  stableTaskRunId: defaultStableTaskRunId,
} = require('../task-run-context');
const { recordRunError, runErrorOf } = require('../task-run-errors');

const REQUIRED_DEPS = [
  'file', 'auxQueue', 'records', 'loadHistory', 'dispatchToSession',
  'routeCommanderTask', 'sendSessionMessage',
  'workspaceBroadcast', 'atomicWriteJson', 'isSystemInjected',
  'getSessionRunState',
];

function assertTaskBoardDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('[taskboard] deps object required');
  for (const name of REQUIRED_DEPS) {
    if (deps[name] === undefined || deps[name] === null) {
      throw new Error(`[taskboard] missing dep: ${name}`);
    }
  }
}

function createTaskBoardRuntime(deps) {
  assertTaskBoardDeps(deps);
  const {
    file, auxQueue, records, loadHistory, dispatchToSession, routeCommanderTask,
    sendSessionMessage,
    workspaceBroadcast, atomicWriteJson, isSystemInjected,
    getSessionRunState,
  } = deps;
  const taskRuns = deps.taskRuns && typeof deps.taskRuns.beginRun === 'function'
    ? deps.taskRuns : null;
  const buildTaskRunContext = deps.buildTaskRunContext || defaultBuildTaskRunContext;
  const stableTaskRunId = deps.stableTaskRunId || defaultStableTaskRunId;
  const resolveSessionQueue = typeof deps.resolveSessionQueue === 'function'
    ? deps.resolveSessionQueue
    : async () => ({ ok: false, code: 'no_active_task' });
  const terminateTaskRun = typeof deps.terminateTaskRun === 'function'
    ? deps.terminateTaskRun : null;
  const cancelUndeliveredTaskRun = typeof deps.cancelUndeliveredTaskRun === 'function'
    ? deps.cancelUndeliveredTaskRun : null;
  const getCommanderMigrationStatus = typeof deps.getCommanderMigrationStatus === 'function'
    ? deps.getCommanderMigrationStatus : null;
  const logger = deps.logger || console;
  const taskRunAnswers = new Map();
  // Optional goal-mode helpers (from aux-goal). When present, a goal-flagged
  // send gets the same "[Goal 模式限制]…" note text-prepended that the chat
  // composer's goal mode produces — dispatch is text-only, so text parity is
  // full parity (message-composer just prepends the note as a context layer).
  const resolveGoalLimits = typeof deps.resolveGoalLimits === 'function' ? deps.resolveGoalLimits : null;
  const buildGoalLimitNote = typeof deps.buildGoalLimitNote === 'function' ? deps.buildGoalLimitNote : null;

  function goalNoteFor(body) {
    if (!body || !body.goal || !resolveGoalLimits || !buildGoalLimitNote) return '';
    try { return buildGoalLimitNote(resolveGoalLimits(body.goalLimits)) || ''; }
    catch (_) { return ''; }
  }

  let board;
  try {
    board = core.normalizeBoard(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    board = core.createEmptyBoard();
  }

  function save() {
    try { atomicWriteJson(file, board); }
    catch (e) { logger.log(`[multicc/taskboard] save failed: ${e.message}`); }
  }

  function notify(dirId, taskIds, kind) {
    // Always broadcast to metaClients (dirId=null) so meta.html always gets updates.
    // kind='created' signals a new task was just tagged, for归拢中→定位 animation.
    const payload = { type: 'task_board_update', taskIds };
    if (kind) payload.kind = kind;
    try { workspaceBroadcast(null, payload); }
    catch (_) {}
  }


  // Bounded failure recovery (design doc §3.3): a retryable terminal failure
  // is re-admitted exactly once as a brand-new run — new lease epoch, fresh
  // slot cleanup, compiled context that already contains the failure entry.
  // The cap is per failed DELIVERY: a retry run carries metadata.retryOf and
  // can therefore never earn another retry (no chains), while a later,
  // independently failed delivery still gets its own single chance.
  async function autoRetryTaskRun({ taskId, runId } = {}) {
    if (!taskRuns) return { ok: false, code: 'task_runs_unavailable' };
    const id = String(taskId || '').trim();
    const task = board.tasks[id];
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
      retryOf: failedRunId,
    });
    return result;
  }

  function notifyTaskRun(taskId) {
    const id = String(taskId || '').trim();
    const task = board.tasks[id];
    if (!task) return false;
    notify(core.taskDirId(board, task), [id]);
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

  function canonicalMessages(task) {
    const sessionIds = new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean));
    if (task.routing?.workerSessionId) sessionIds.add(task.routing.workerSessionId);
    if (task.routing?.mode === 'manual' && task.routing.targetSessionId) {
      sessionIds.add(task.routing.targetSessionId);
    }
    const messages = [];
    for (const sessionId of sessionIds) {
      let history = [];
      try { history = loadHistory(sessionId) || []; } catch (_) {}
      for (const message of history) {
        if (message?.taskId !== task.id) continue;
        messages.push({ sessionId, message });
      }
    }
    return messages.sort((a, b) => (a.message.ts || 0) - (b.message.ts || 0));
  }

  function legacyImportMessages(task) {
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

    for (const entry of canonicalMessages(task)) {
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
        for (const run of taskRuns.listTaskRuns(task.id)) {
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
    // Old cards predate taskId metadata. Their ref remains a read-only fallback;
    // no new write path stores task text in the board.
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

  // Transport wrappers (compiled context wall / routed scaffold) are not
  // conversation. The write-time metadata flag is the structural signal; the
  // text predicate catches rows written before the flag existed.
  function isWrapperLedgerMessage(message) {
    if (!message || message.role !== 'user') return false;
    if (message.metadata?.wrapper === true) return true;
    return isTaskRunWrapperText(core.messageText({ content: message.content }));
  }

  function storedTaskMessages(taskId, excludeRunId = null) {
    if (!taskRuns) return [];
    const items = [];
    for (const run of taskRuns.listTaskRuns(taskId)) {
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
    return items;
  }

  function isOpenTaskRun(run) {
    return !!run && run.executionStatus === 'running'
      && run.usageStatus === 'collecting' && run.cleanupState === 'blocked';
  }

  function latestOpenTaskRun(taskId, knownRuns = null) {
    if (!taskRuns) return null;
    const runs = Array.isArray(knownRuns) ? knownRuns : taskRuns.listTaskRuns(taskId);
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
      const storedRuns = taskRuns.listTaskRuns(taskId);
      const answerTarget = exactTaskRunTarget(taskId, storedRuns);
      const pendingQuestion = answerTarget.ok
        ? publicPendingQuestion(answerTarget.pending) : null;
      const runs = storedRuns.slice(-5).reverse().map(run => ({
        ...publicRunDto(run), usage: taskRuns.getRunUsage(run.runId),
        ...(run.executionStatus === 'failed'
          ? { error: runErrorOf(taskRuns, run.runId) } : {}),
        ...(pendingQuestion && run.runId === answerTarget.run.runId
          ? { pendingQuestion } : {}),
      }));
      return { runs, usage: taskRuns.getTaskUsage(taskId) };
    } catch (error) {
      logger.log(`[multicc/taskboard] task-run projection failed: ${error?.code || 'unknown'}`);
      return { runs: [], usage: null };
    }
  }

  function beginTaskRun({ taskId, task, text, clientKey, source, retryOf = null }) {
    if (!taskRuns) return null;
    const runId = stableTaskRunId(taskId, clientKey);
    const existingRuns = taskRuns.listTaskRuns(taskId);
    const existingRun = existingRuns.find(run => run.runId === runId) || null;
    const created = !existingRun;
    const firstRun = existingRuns.length === 0 || existingRuns[0]?.runId === runId;
    const imports = firstRun
      ? (existingRun
          ? taskRuns.getRunMessages(runId).filter(message => message.kind === 'legacy_import')
          : legacyImportMessages(task || { id: taskId, refs: [] }))
      : [];
    const context = buildTaskRunContext({
      task: task || { id: taskId, title: core.PENDING_TASK_TITLE, status: 'active' },
      messages: [...storedTaskMessages(taskId, runId), ...contextMessages(imports)],
      currentText: text,
    });
    const startedAt = existingRun?.startedAt || Date.now();
    const runInput = {
      runId,
      taskId,
      attemptId: runId,
      slotId: null,
      startedAt,
      metadata: {
        source: retryOf ? 'auto-retry' : String(source || 'task-board').slice(0, 40),
        contextHash: context.hash,
        contextManifest: context.manifest,
        // Bounded auto-retry lineage: the single automatic retry is the only
        // run that ever carries retryOf, and autoRetryTaskRun refuses to
        // admit another run once any run in the task has it.
        ...(retryOf ? { retryOf: String(retryOf).slice(0, 64) } : {}),
      },
    };
    const admission = {
      messageId: `admission:${runId}`,
      role: 'user',
      kind: 'admission',
      content: text,
      metadata: { contextHash: context.hash },
      createdAt: startedAt,
      atRunStart: true,
    };
    let run;
    if (typeof taskRuns.admitRun === 'function') {
      ({ run } = taskRuns.admitRun({ run: runInput, messages: [...imports, admission] }));
    } else {
      run = taskRuns.beginRun(runInput);
      for (const message of imports) taskRuns.appendMessage({ runId, ...message });
      taskRuns.appendMessage({ runId, ...admission, createdAt: run.startedAt });
    }
    const closed = run.executionStatus !== 'running' || run.usageStatus !== 'collecting'
      || run.cleanupState !== 'blocked';
    return { runId, leaseEpoch: run.leaseEpoch, context, created, closed };
  }

  function rejectTaskRun(taskRun, errorCode) {
    if (!taskRun?.created || !taskRuns) return false;
    try {
      const runId = taskRun.runId;
      taskRuns.observeUsage({ runId, event: {
        eventId: `admission-rejected:${runId}`, occurredAt: Date.now(),
        providerId: '_none_', providerName: 'No provider', cli: '', protocol: '', model: '',
        roleKind: 'main', routeName: 'main', source: 'exact', coverage: 'observed', status: 'error',
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        errorCode: String(errorCode || 'DISPATCH_REJECTED').slice(0, 128),
      } });
      recordRunError(taskRuns, {
        runId,
        code: String(errorCode || 'DISPATCH_REJECTED').slice(0, 128),
        category: 'dispatch',
        retryable: false,
        message: `任务未能投递到执行槽（${String(errorCode || 'DISPATCH_REJECTED')}）。请重新发送。`,
      });
      taskRuns.sealUsage({ runId, executionStatus: 'failed', outcomeDurable: true,
        producersDrained: true, nativeTranscriptChecked: true });
      const permit = taskRuns.getCleanupPermit(runId);
      if (!permit) return false;
      taskRuns.markCleanup({ runId, permit, state: 'deleting' });
      taskRuns.markCleanup({ runId, permit, state: 'done' });
      return true;
    } catch (error) {
      logger.log(`[multicc/taskboard] rejected task-run finalization failed: ${error?.code || 'unknown'}`);
      return false;
    }
  }

  function ensureTaskIndex({
    taskId, dirId, sessionId, routing, taskText = '', now = Date.now(),
  }) {
    const existing = board.tasks[taskId];
    const task = existing || core.createPendingTask(board, {
      taskId, dirId, sessionId, taskText, now,
    });
    if (!task) return { task: null, created: false };
    if (sessionId && !(task.refs || []).some(ref => ref.sessionId === sessionId)) {
      core.addRefToTask(task, {
        sessionId, dirId, userMsgId: null, assistantMsgId: null,
        ts: now, excerpt: '',
      }, now);
    }
    if (routing) core.setTaskRouting(task, routing);
    return { task, created: !existing };
  }

  function onMessagePersisted(sessionId, message) {
    try {
      if (!message?.taskId || !message.role) return false;
      const rec = records.get(sessionId);
      if (!rec || rec.type === 'commander' || rec.type === 'aux' || rec.type === 'gateway') return false;
      let task = board.tasks[message.taskId];
      const created = !task && message.role === 'user' && message.taskStart === true;
      if (created) {
        task = ensureTaskIndex({
          taskId: message.taskId,
          dirId: rec.dirId || null,
          sessionId,
          taskText: message.taskText || core.messageText(message),
          now: message.ts || Date.now(),
        }).task;
      }
      if (!task) return false;
      const history = loadHistory(sessionId) || [];
      const index = history.findIndex(candidate => candidate?.id === message.id);
      let userMessage = message.role === 'user' ? message : null;
      if (!userMessage && index !== -1) {
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          const candidate = history[cursor];
          if (candidate?.role === 'user' && candidate.taskId === task.id) {
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
    for (let ri = task.refs.length - 1; ri >= 0; ri--) {
      const storedRef = task.refs[ri];
      const history = loadHistory(storedRef.sessionId) || [];
      let userIdx = storedRef.userMsgId
        ? history.findIndex(m => m && m.id === storedRef.userMsgId) : -1;
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
    return partial;
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
    if (pendingModuleAssignmentByTask.has(taskId)) return { ok: false, error: 'classification_running' };
    // 方案A（手动归类）：自动调用方（turn-end 钩子、retry 扫描）一律不得把「待归类」
    // 卡片自动分到真实模块——只有用户点击「归类/重新归类」的端点会传 { manual: true }。
    // 这是唯一权威闸门：任何未来新增的自动调用点都会被这里挡住。
    if (!options.manual) return { ok: false, error: 'auto_classify_disabled' };

    const input = options.input || resolveTaskClassificationInput(task);
    if (!input?.userText) {
      saveModuleAssignment(task, {
        running: false,
        lastError: 'missing_context',
      });
      return { ok: false, error: 'missing_context' };
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
    // Module assignment is manual. This pass only recovers a persisted
    // in-flight operation after restart; it never queues a new Aux request.
    const recovered = [];
    for (const task of Object.values(board.tasks)) {
      const assignment = task.moduleAssignment;
      if (!assignment?.running || pendingModuleAssignmentByTask.has(task.id)) continue;
      assignment.running = false;
      assignment.lastError = 'classification_interrupted';
      task.updatedAt = now;
      recovered.push(task.id);
    }
    if (recovered.length) {
      save();
      for (const taskId of recovered) {
        const task = board.tasks[taskId];
        const mod = task?.moduleId ? board.modules[task.moduleId] : null;
        notify(mod?.dirId || task?.refs.find(r => r.dirId)?.dirId || null, [taskId]);
      }
    }
    return recovered.length;
  }

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
      const task = taskId ? board.tasks[taskId] : null;
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
      const userMsg = messages.find(message => message?.role === 'user') || null;
      const assistantMsg = [...messages].reverse().find(message => message?.role === 'assistant') || null;
      const messageIds = new Set(messages.map(message => message?.id).filter(Boolean));
      const oldTask = oldTaskId ? board.tasks[oldTaskId] : null;
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
      const task = taskId ? board.tasks[taskId] : null;
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

  function onQueueEvent(event = {}) {
    const taskId = String(event.taskId || '');
    const task = taskId ? board.tasks[taskId] : null;
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
      directory_required: '自动路由必须指定任务所属 Fleet',
      commander_not_found: '该 Fleet 没有带稳定角色元数据的 Agent Commander，请先创建或修复 Commander 会话',
      commander_ambiguous: '该 Fleet 存在多个 Agent Commander，无法安全确定唯一入口，请先修复角色配置',
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
        : '该 Fleet 的 Agent Commander 迁移未安全完成，请查看 readiness 并修复后重试',
    });
    return true;
  }

  function taskDto(task) {
    const dto = core.buildBoardDto({ modules: board.modules, tasks: { [task.id]: task } }, getSessionRunState).tasks[0];
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
    Object.assign(dto, taskRunDtos(task.id));
    return dto;
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
      for (const sid of t.sessionIds) {
        if (!(sid in labels)) labels[sid] = records.get(sid)?.label || sid;
      }
      Object.assign(t, taskRunDtos(t.id));
    }
    res.json({ ok: true, ...dto, sessionLabels: labels, backfill: { ...backfillState } });
  }

  function handleMessages(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const runProjection = taskRunDtos(task.id);
    if (taskRuns && runProjection.runs.length) {
      const items = [];
      try {
        for (const run of taskRuns.listTaskRuns(task.id)) {
          for (const message of taskRuns.getRunMessages(run.runId)) {
            if (isWrapperLedgerMessage(message)) continue;
            const text = core.messageText({ content: message.content });
            if (!text && message.role !== 'assistant') continue;
            const imported = message.kind === 'legacy_import';
            const sourceSessionId = imported
              ? String(message.metadata?.sourceSessionId || '') || null
              : null;
            items.push({
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
        items.sort((left, right) => (left.ts || 0) - (right.ts || 0));
        return res.json({ ok: true, task: taskDto(task), items, ...runProjection });
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
    const canonical = canonicalMessages(task);
    for (const entry of canonical) {
      const { sessionId, message } = entry;
      const label = records.get(sessionId)?.label || sessionId;
      const text = message.role === 'user' && message.taskStart
        ? String(message.taskText || core.messageText(message))
        : core.messageText(message);
      if (!text && message.role !== 'assistant') continue;
      if (isTaskRunWrapperText(text)) continue;
      items.push({
        sessionId,
        sessionLabel: label,
        role: message.role,
        messageId: message.id || null,
        ts: message.ts || 0,
        text,
      });
    }
    // Legacy cards have no taskId metadata and continue to resolve through refs.
    if (!canonical.length) for (const ref of task.refs) {
      const label = records.get(ref.sessionId)?.label || ref.sessionId;
      const history = historyFor(ref.sessionId);
      const um = ref.userMsgId ? history.find(m => m && m.id === ref.userMsgId) : null;
      const am = ref.assistantMsgId ? history.find(m => m && m.id === ref.assistantMsgId) : null;
      if (um) {
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: um.id || ref.userMsgId || null,
                     ts: um.ts || ref.ts, text: core.messageText(um) });
      } else if (ref.excerpt) {
        // The message may have been trimmed out of history — keep the excerpt.
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: null, ts: ref.ts, text: ref.excerpt, lost: true });
      }
      if (am) {
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'assistant',
                     messageId: am.id || ref.assistantMsgId || null,
                     ts: am.ts || ref.ts, text: core.messageText(am) });
      }
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    res.json({ ok: true, task: taskDto(task), items, ...runProjection });
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
    const taskId = String(req.params?.taskId || '').trim();
    if (!board.tasks[taskId]) return res.status(404).json({ error: 'task_not_found' });
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
      notify(core.taskDirId(board, board.tasks[taskId]), [taskId]);
      return answerResult(res, target, result);
    } catch (error) {
      logger.log(`[multicc/taskboard] answer failed: ${error?.code || error?.message || 'unknown'}`);
      return res.status(502).json({ error: 'answer_failed' });
    } finally {
      if (taskRunAnswers.get(key)?.promise === promise) taskRunAnswers.delete(key);
    }
  }

  function taskRunDispatchResult(result, {
    taskId, taskRunId, commanderSessionId = null,
  }) {
    const receipt = {
      ok: true,
      taskId,
      taskRunId,
      queued: result?.queued === true,
      status: String(result?.status || 'admitted'),
      operationId: result?.operationId || taskRunId,
    };
    if (commanderSessionId && records.get(commanderSessionId)?.type === 'commander') {
      receipt.commanderSessionId = commanderSessionId;
      receipt.commanderLabel = records.get(commanderSessionId)?.label || commanderSessionId;
    }
    return receipt;
  }

  async function routeCommanderFollowup(commanderId, taskId, text, options = {}) {
    const commander = records.get(commanderId);
    const task = board.tasks[taskId];
    if (!commander || commander.type !== 'commander' || commander.kind !== 'chat') {
      return { ok: false, code: 'commander_not_found' };
    }
    if (!task) return { ok: false, code: 'task_not_found' };
    const messageText = String(text || '').trim();
    if (!messageText) return { ok: false, code: 'empty_text' };
    const clientKey = String(options.clientMsgId || '').trim() || crypto.randomUUID();
    const source = options.source === 'commander' ? 'commander' : 'task-board';
    const retryOf = String(options.retryOf || '').trim() || null;
    const taskRun = beginTaskRun({
      taskId: task.id, task, text: messageText,
      clientKey: `followup:${clientKey}`, source,
      ...(retryOf ? { retryOf } : {}),
    });
    if (taskRun?.closed) return { ok: false, code: 'task_run_closed' };
    const message = String(options.goalNote || '')
      + core.buildCommanderRoutedMessage(task, taskRun?.context.text || messageText);
    const result = await routeCommanderTask({
      commanderId,
      message,
      idempotencyKey: taskRun ? `task-run:${taskRun.runId}`
        : `taskboard-followup:${task.id}:${clientKey}`,
      operationId: taskRun?.runId,
      taskId: task.id,
      taskRunId: taskRun?.runId,
      leaseEpoch: taskRun?.leaseEpoch,
      taskStart: false,
      taskSource: source,
    });
    if (!result?.ok) {
      rejectTaskRun(taskRun, result?.code || result?.error);
      return result || { ok: false, code: 'dispatch_failed' };
    }
    core.setTaskRouting(task, {
      mode: 'commander',
      targetSessionId: commanderId,
      workerSessionId: result.targetSessionId || '',
      operationId: result.operationId || '',
      status: result.status || 'admitted',
      oneWay: true,
      elasticWorkerCreated: result.elasticWorkerCreated === true,
      routedAt: Date.now(),
    });
    save();
    notify(core.taskDirId(board, task), [task.id]);
    if (taskRun) return {
      ...taskRunDispatchResult(result, {
        taskId: task.id,
        taskRunId: taskRun.runId,
        commanderSessionId: commanderId,
      }),
      taskStart: false,
    };
    return { ...result, taskId: task.id, taskStart: false,
      target: commanderId, routeMode: 'commander' };
  }

  async function handleSend(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const text = String(req.body?.text || '').trim();
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
      const busy = result?.code === 'target_busy' || result?.error === 'target_busy';
      return res.status(busy ? 409 : 502).json({ error: result?.code || result?.error || 'dispatch_failed' });
    }
    if (result.taskRunId) {
      return res.json(taskRunDispatchResult(result, {
        taskId: task.id,
        taskRunId: result.taskRunId,
        commanderSessionId: routeMode === 'commander' ? target : null,
        taskStart: false,
      }));
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
      elasticWorkerCreated: routeMode === 'commander' && result.elasticWorkerCreated === true,
      chatId: result.chatId,
      operationId: result.operationId || null,
      taskRunId: null,
    });
  }

  async function dispatchTaskStart({
    source, dirId, target, routeMode, text, clientKey, goalNote = '',
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
    // Replay (the task already routed): never re-admit the run. The ledger
    // already holds the original admission, so re-running beginTaskRun would
    // rewrite it under a fresh context hash and trip the store's content
    // conflict guard. The recorded operation id reproduces the original
    // idempotency key (it is the run id on the Commander path).
    const taskRun = !replayOperationId && effectiveRouteMode === 'commander'
      ? beginTaskRun({
          taskId, task: existing || taskShape, text,
          clientKey: `start:${clientKey}`, source,
        })
      : null;
    if (taskRun?.closed) {
      return { ok: false, code: 'task_run_closed' };
    }
    let replayRun = null;
    if (replayOperationId && effectiveRouteMode === 'commander' && taskRuns) {
      try {
        replayRun = (taskRuns.listTaskRuns(taskId) || [])
          .find(run => run.runId === replayOperationId) || null;
      } catch (_) { replayRun = null; }
    }
    const executionText = taskRun?.context.text || text;
    const routed = effectiveRouteMode === 'commander'
      ? core.buildCommanderRoutedMessage(taskShape, executionText)
      : core.buildRoutedMessage(taskShape, executionText);
    const message = goalNote + routed;
    const idempotencyKey = taskRun
      ? `task-run:${taskRun.runId}`
      : replayOperationId && effectiveRouteMode === 'commander'
        ? `task-run:${replayOperationId}`
        : `task-start:${taskId}`;
    const taskContext = {
      taskId,
      ...(taskRun ? {
        taskRunId: taskRun.runId,
        leaseEpoch: taskRun.leaseEpoch,
        operationId: taskRun.runId,
      } : {}),
      taskStart: true,
      taskSource: source,
      taskText: text,
    };
    let result;
    try {
      if (existing?.routing?.operationId) {
        const originalWorker = existing.routing.workerSessionId
          || existing.routing.targetSessionId;
        if (replayRun) {
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
        result = effectiveRouteMode === 'commander'
          ? await routeCommanderTask({
              commanderId: effectiveTarget, message, idempotencyKey, ...taskContext,
            })
          : await dispatchToSession(effectiveTarget, message, {
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
      rejectTaskRun(taskRun, result?.code || result?.error);
      return result || { ok: false, error: 'dispatch_failed' };
    }
    const workerSessionId = effectiveRouteMode === 'commander'
      ? result.targetSessionId
      : result.chatId || effectiveTarget;
    const routedAt = Date.now();
    const indexed = ensureTaskIndex({
      taskId,
      taskRunId: taskRun?.runId || null,
      leaseEpoch: taskRun?.leaseEpoch || null,
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
        elasticWorkerCreated: result.elasticWorkerCreated === true,
        routedAt,
      },
      now: routedAt,
    });
    if (indexed.task) {
      indexed.task.runState = result.status === 'running' ? 'running' : 'queued';
    }
    save();
    notify(dirId, [taskId], indexed.created ? 'created' : undefined);
    if (taskRun) return {
      ...taskRunDispatchResult(result, {
        taskId,
        taskRunId: taskRun.runId,
        commanderSessionId: effectiveTarget,
      }),
      taskStart: true,
    };
    return {
      ...result,
      taskId,
      target: effectiveTarget,
      routeMode: effectiveRouteMode,
      workerSessionId,
    };
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
    const result = await dispatchTaskStart({
      source: 'task-board',
      dirId: routeMode === 'commander' ? (records.get(target)?.dirId || dirId) : dirId,
      target,
      routeMode,
      text,
      clientKey,
      goalNote: goalNoteFor(req.body),
    });
    if (!result.ok) {
      const conflict = result.code === 'idempotency_conflict';
      const busy = result.code === 'target_busy' || result.error === 'target_busy';
      return res.status(busy || conflict ? 409 : 502).json({
        error: result.code || result.error || 'dispatch_failed',
      });
    }
    if (result.taskRunId) {
      return res.json(taskRunDispatchResult(result, {
        taskId: result.taskId,
        taskRunId: result.taskRunId,
        commanderSessionId: target,
        taskStart: true,
      }));
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
      elasticWorkerCreated: result.elasticWorkerCreated === true,
      chatId: target,
      operationId: result.operationId || null,
      duplicate: result.duplicate === true,
    });
  }

  async function handleStatus(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const status = String(req.body?.status || '');
    if (!['active', 'done', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    if (status === 'done') {
      let openRun = null;
      try { openRun = latestOpenTaskRun(task.id); }
      catch (_) {
        return res.status(409).json({ error: 'task_run_state_unavailable' });
      }
      if (openRun) {
        const operationId = String(task.routing?.operationId || '').trim();
        if (!openRun.slotId) {
          if (!operationId || !cancelUndeliveredTaskRun) {
            return res.status(409).json({ error: 'task_run_cancel_unavailable' });
          }
          let cancelled;
          try {
            cancelled = await cancelUndeliveredTaskRun(operationId, {
              taskId: task.id, runId: openRun.runId,
            });
          } catch (error) {
            logger.log(`[multicc/taskboard] task-run dispatch cancel failed: ${error?.code || error?.message || 'unknown'}`);
            return res.status(409).json({ error: 'task_run_cancel_failed' });
          }
          if (!(cancelled?.ok === true && cancelled?.neverDelivered === true)) {
            return res.status(409).json({
              error: cancelled?.code || 'task_run_delivery_not_cancellable',
            });
          }
        }
        if (!terminateTaskRun) {
          return res.status(409).json({ error: 'task_run_termination_unavailable' });
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
          return res.status(409).json({ error: 'task_run_termination_failed' });
        }
        const alreadyTerminal = terminated?.duplicate === true
          || ['already_terminal', 'task_run_closed'].includes(terminated?.code);
        if (!(terminated === true || terminated?.ok === true || alreadyTerminal)) {
          return res.status(409).json({
            error: terminated?.code || 'task_run_termination_failed',
          });
        }
      }
      const routedWorker = task.routing?.workerSessionId;
      const sessionIds = routedWorker
        ? [routedWorker]
        : [...new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean))];
      for (const sessionId of sessionIds) {
        if (records.get(sessionId)?.taskExecutionSlot === true) continue;
        const resolved = await resolveSessionQueue(sessionId, task.id);
        if (resolved && resolved.ok === false
            && !['no_active_task', 'active_task_mismatch'].includes(resolved.code)) {
          return res.status(409).json({
            error: resolved.code || 'queue_resolution_failed',
            note: '当前任务仍在执行；请先取消，或等待其进入冻结状态后再明确标记完成。',
          });
        }
      }
    }
    task.status = status;
    task.updatedAt = Date.now();
    save();
    const mod = task.moduleId ? board.modules[task.moduleId] : null;
    notify(mod?.dirId || null, [task.id]);
    res.json({ ok: true, task: taskDto(task) });
  }

  function handleArchiveCompleted(req, res) {
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
    if (taskIds.length) {
      save();
      notify(dirId, taskIds);
    }
    res.json({ ok: true, archivedCount: taskIds.length, taskIds });
  }

  function handleReclassify(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    if (!task.moduleAssignment) return res.status(409).json({ error: 'not_pending' });
    const result = queueTaskClassification(task.id, { manual: true });
    if (!result.ok) {
      const status = result.error === 'aux_unhealthy' ? 503 : 409;
      // A card with no resolvable input can never be classified — tell the user
      // it's a dead card they can delete, not just that content is "missing".
      const note = result.error === 'missing_context'
        ? '该任务卡没有可归类的对话内容（无有效会话引用），无法归类，可手动删除此卡'
        : result.error === 'aux_unhealthy'
        ? '归类服务（aux）暂不可用，请稍后重试'
        : null;
      return res.status(status).json({ error: result.error, note });
    }
    res.json({ ok: true, queued: true, task: taskDto(task) });
  }

  function handleReclassifyPending(req, res) {
    if (auxQueue.isUnhealthy && auxQueue.isUnhealthy()) {
      return res.status(503).json({ error: 'aux_unhealthy' });
    }
    const dirId = String(req.body?.dirId || '').trim() || null;
    let queued = 0;
    let skipped = 0;
    for (const task of Object.values(board.tasks)) {
      if (!task.moduleAssignment) continue;
      const mod = task.moduleId ? board.modules[task.moduleId] : null;
      const taskDirId = mod?.dirId || task.refs.find(r => r.dirId)?.dirId || null;
      if (dirId && taskDirId !== dirId) continue;
      const result = queueTaskClassification(task.id, { manual: true });
      if (result.ok) queued++;
      else skipped++;
    }
    res.json({ ok: true, queued, skipped });
  }

  function mountRoutes(app) {
    app.get('/api/task-board', handleBoard);
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
      handleStatus(req, res).catch(error => {
        logger.log(`[multicc/taskboard] status update failed: ${error?.message || error}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    });
    app.post('/api/task-board/archive-completed', handleArchiveCompleted);
    app.post('/api/task-board/tasks/:taskId/reclassify', handleReclassify);
    app.post('/api/task-board/send', (req, res) => {
      handleBoardSend(req, res).catch(e => {
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

  // Recover interrupted manual module assignment once after startup. Pending
  // cards stay under 「待归类」 until the user explicitly assigns them.
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
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

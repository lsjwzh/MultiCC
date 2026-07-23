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
//   loadHistory        — sessionId → message[] (deep copy)
//   dispatchToSession  — durable dispatch; Commander access requires an internal flag
//   sendSessionMessage  — canonical per-session ingress used by WebSocket and task board
//   workspaceBroadcast — (dirId, payload) → void (reaches /ws/meta clients)
//   atomicWriteJson    — (file, value) → void
//   isSystemInjected   — msgText → bool (skip recovery/nudge turns)

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board');

const REQUIRED_DEPS = [
  'file', 'auxQueue', 'records', 'loadHistory', 'dispatchToSession',
  'routeCommanderTask', 'sendSessionMessage',
  'workspaceBroadcast', 'atomicWriteJson', 'isSystemInjected',
  'getSessionRunState', 'isSessionBusy',
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
    getSessionRunState, isSessionBusy,
  } = deps;
  const getCommanderMigrationStatus = typeof deps.getCommanderMigrationStatus === 'function'
    ? deps.getCommanderMigrationStatus : null;
  const logger = deps.logger || console;
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

  function ensureTaskIndex({ taskId, dirId, sessionId, routing, now = Date.now() }) {
    const existing = board.tasks[taskId];
    const task = existing || core.createPendingTask(board, {
      taskId, dirId, sessionId, now,
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
      const changed = core.addRefToTask(task, {
        sessionId,
        dirId: rec.dirId || null,
        userMsgId: userMessage?.id || null,
        assistantMsgId: message.role === 'assistant' ? message.id || null : null,
        ts: message.ts || Date.now(),
        excerpt: '',
      }, message.ts || Date.now());
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
      `必须输出恰好一个任务；若属于现有任务可返回其 id，否则返回 id "${task.id}"。`,
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
    dto.body = body.text;
    dto.bodyMessageId = body.messageId;
    dto.bodySessionId = body.sessionId;
    dto.legacy = body.legacy;
    if (dto?.routing) {
      dto.routing.targetLabel = records.get(dto.routing.targetSessionId)?.label || dto.routing.targetSessionId;
      if (dto.routing.workerSessionId) {
        dto.routing.workerLabel = records.get(dto.routing.workerSessionId)?.label || dto.routing.workerSessionId;
      }
    }
    return dto;
  }

  function handleBoard(req, res) {
    const dto = core.buildBoardDto(board, getSessionRunState);
    const labels = {};
    for (const t of dto.tasks) {
      const body = canonicalTaskBody(board.tasks[t.id]);
      t.body = body.text;
      t.bodyMessageId = body.messageId;
      t.bodySessionId = body.sessionId;
      t.legacy = body.legacy;
      if (t.routing) {
        const sid = t.routing.targetSessionId;
        labels[sid] = records.get(sid)?.label || sid;
        t.routing.targetLabel = labels[sid];
        if (t.routing.workerSessionId) {
          const workerId = t.routing.workerSessionId;
          labels[workerId] = records.get(workerId)?.label || workerId;
          t.routing.workerLabel = labels[workerId];
        }
      }
      for (const sid of t.sessionIds) {
        if (!(sid in labels)) labels[sid] = records.get(sid)?.label || sid;
      }
    }
    res.json({ ok: true, ...dto, sessionLabels: labels, backfill: { ...backfillState } });
  }

  function handleMessages(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
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
    res.json({ ok: true, task: taskDto(task), items });
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
    const message = String(options.goalNote || '') + core.buildCommanderRoutedMessage(task, messageText);
    const result = await routeCommanderTask({
      commanderId,
      message,
      idempotencyKey: `taskboard-followup:${task.id}:${clientKey}`,
      taskId: task.id,
      taskStart: false,
      taskSource: source,
    });
    if (!result?.ok) return result || { ok: false, code: 'dispatch_failed' };
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
    return {
      ...result,
      taskId: task.id,
      taskStart: false,
      target: commanderId,
      routeMode: 'commander',
      workerSessionId: result.targetSessionId || null,
    };
  }

  async function handleSend(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const explicit = String(req.body?.target || '').trim() || null;
    const followupKey = requestKey(req);
    let target;
    let routeMode;
    let result;
    if (explicit) {
      if (isSessionBusy(explicit)) {
        return res.status(409).json({ error: 'target_busy', note: '指定会话正在执行任务，请等待其空闲后再发送' });
      }
      target = core.pickRouteTarget(board, task, records, explicit, {
        queryText: text,
        isAvailable: sid => !isSessionBusy(sid),
      });
      if (!target) return res.status(409).json({ error: 'no_idle_relevant_target', note: '指定会话不可路由或不属于任务所在 Fleet' });
      if (isSessionBusy(target)) return res.status(409).json({ error: 'target_busy', note: '目标会话刚刚开始执行其他任务，请重试' });
      routeMode = 'manual';
      result = await dispatchToSession(target,
        goalNoteFor(req.body) + core.buildRoutedMessage(task, text), {
          idempotencyKey: `taskboard-followup:${task.id}:${followupKey}`,
          oneWay: true,
          requireIdle: true,
          taskId: task.id,
          taskStart: false,
          taskSource: 'task-board',
        });
      if (result?.ok) {
        core.setTaskRouting(task, {
          mode: routeMode,
          targetSessionId: target,
          operationId: result.operationId || '',
          status: result.status || 'admitted',
          oneWay: true,
          routedAt: Date.now(),
        });
        save();
        notify(core.taskDirId(board, task), [task.id]);
      }
    } else {
      const dirId = core.taskDirId(board, task);
      if (commanderMigrationFailure(res, dirId)) return;
      const commander = core.resolveDirectoryCommander(records, dirId);
      if (!commander.ok) return commanderFailure(res, commander.code);
      target = commander.sessionId;
      routeMode = 'commander';
      result = await sendSessionMessage(target, text, {
        clientMsgId: followupKey,
        taskId: task.id,
        taskStart: false,
        taskSource: 'task-board',
        goalNote: goalNoteFor(req.body),
      });
    }
    if (!result?.ok) {
      const busy = result?.code === 'target_busy' || result?.error === 'target_busy';
      return res.status(busy ? 409 : 502).json({ error: result?.code || result?.error || 'dispatch_failed' });
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
    const taskShape = { id: taskId, title: core.PENDING_TASK_TITLE };
    const routed = effectiveRouteMode === 'commander'
      ? core.buildCommanderRoutedMessage(taskShape, text)
      : core.buildRoutedMessage(taskShape, text);
    const message = goalNote + routed;
    const idempotencyKey = `task-start:${taskId}`;
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
      } else {
        result = effectiveRouteMode === 'commander'
          ? await routeCommanderTask({
              commanderId: effectiveTarget, message, idempotencyKey, ...taskContext,
            })
          : await dispatchToSession(effectiveTarget, message, {
              idempotencyKey, oneWay: true, requireIdle: true, ...taskContext,
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
    if (!result?.ok) return result || { ok: false, error: 'dispatch_failed' };
    const workerSessionId = effectiveRouteMode === 'commander'
      ? result.targetSessionId
      : result.chatId || effectiveTarget;
    const routedAt = Date.now();
    const indexed = ensureTaskIndex({
      taskId,
      dirId,
      sessionId: workerSessionId,
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

  // Automatic board input first enters the Commander session through the same
  // ingress as its WebSocket chat. Commander policy then calls dispatchTaskStart
  // to force-forward the task; manual targets continue to dispatch directly.
  async function handleBoardSend(req, res) {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const dirId = String(req.body?.dirId || '').trim() || null;
    const explicit = String(req.body?.target || '').trim() || null;
    let target;
    let routeMode;
    if (explicit) {
      if (isSessionBusy(explicit)) {
        return res.status(409).json({ error: 'target_busy', note: '指定会话正在执行任务，请等待其空闲后再发送' });
      }
      target = core.pickDirTarget(records, dirId, explicit, {
        queryText: text,
        isAvailable: sid => !isSessionBusy(sid),
      });
      if (!target) return res.status(409).json({ error: 'no_idle_relevant_target', note: '指定会话不可路由或不属于该 Fleet' });
      if (isSessionBusy(target)) return res.status(409).json({ error: 'target_busy', note: '目标会话刚刚开始执行其他任务，请重试' });
      routeMode = 'manual';
    } else {
      if (commanderMigrationFailure(res, dirId)) return;
      const commander = core.resolveDirectoryCommander(records, dirId);
      if (!commander.ok) return commanderFailure(res, commander.code);
      target = commander.sessionId;
      routeMode = 'commander';
    }
    const clientKey = requestKey(req);
    const result = routeMode === 'commander'
      ? await sendSessionMessage(target, text, {
          clientMsgId: clientKey,
          taskSource: 'task-board',
          goalNote: goalNoteFor(req.body),
        })
      : await dispatchTaskStart({
          source: 'task-board',
          dirId,
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
    if (routeMode === 'commander') {
      // Commander receives the message and routes asynchronously via <<route>> markers.
      res.json({
        ok: true,
        taskId: null,
        target,
        targetLabel: records.get(target)?.label || target,
        routingMode: 'commander',
        commanderSessionId: target,
        workerSessionId: null,
        workerLabel: null,
        queued: false,
        elasticWorkerCreated: false,
        chatId: target,
        operationId: null,
        duplicate: false,
      });
    } else {
      res.json({
        ok: true,
        taskId: result.taskId,
        target: result.target,
        targetLabel: records.get(result.target)?.label || result.target,
        routingMode: result.routeMode || routeMode,
        commanderSessionId: null,
        workerSessionId: null,
        workerLabel: null,
        queued: false,
        elasticWorkerCreated: false,
        chatId: result.chatId,
        operationId: result.operationId || null,
        duplicate: result.duplicate === true,
      });
    }
  }

  function handleStatus(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const status = String(req.body?.status || '');
    if (!['active', 'done', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
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
    const displayStateByTaskId = new Map(
      core.buildBoardDto(board, getSessionRunState).tasks.map(task => [task.id, task.runState]),
    );
    for (const task of Object.values(board.tasks)) {
      if (task.status === 'archived') continue;
      if (dirId && core.taskDirId(board, task) !== dirId) continue;
      // Keep this predicate aligned with taskDisplayState(): an explicit
      // completed status wins, while canonical classify state may also finish
      // a still-active card.
      if (task.status !== 'done' && displayStateByTaskId.get(task.id) !== 'done') continue;
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
    app.post('/api/task-board/tasks/:taskId/status', handleStatus);
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
    onTurnEnd,
    onClassifyGoal,
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
    // test/introspection surface
    getBoard: () => board,
    save,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

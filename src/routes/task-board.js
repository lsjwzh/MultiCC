'use strict';

// Task board runtime — wires the pure core (src/task-board.js) to the host:
// aux-queue tagging at turn end, atomic persistence, REST routes for the
// fleet panel, the panel composer's auto-routed dispatch, and pending-card
// classification retries.
//
// Host contract (all deps injected by server.js):
//   file               — task_board.json path (from createPaths)
//   auxQueue           — { enqueue, cancel, isUnhealthy } from mountAuxGoalRoutes
//   records            — persistedSessions Map (sessionId → record)
//   loadHistory        — sessionId → message[] (deep copy)
//   dispatchToSession  — durable dispatch; Commander access requires an internal flag
//   workspaceBroadcast — (dirId, payload) → void (reaches /ws/meta clients)
//   atomicWriteJson    — (file, value) → void
//   isSystemInjected   — msgText → bool (skip recovery/nudge turns)

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board');

const REQUIRED_DEPS = [
  'file', 'auxQueue', 'records', 'loadHistory', 'dispatchToSession',
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
    file, auxQueue, records, loadHistory, dispatchToSession,
    workspaceBroadcast, atomicWriteJson, isSystemInjected,
    getSessionRunState, isSessionBusy,
  } = deps;
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

  // One in-flight tag per session: a newer turn supersedes the queued tag for
  // the same session (mirrors runClassifyNow's cancelClassifyFor pattern).
  const pendingTagBySession = new Map();
  const pendingClassificationByTask = new Map();
  const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  const MAX_AUTO_ATTEMPTS = 5;

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

  function pendingTaskForRef(ref, markedTaskId = null) {
    if (markedTaskId && board.tasks[markedTaskId]?.classification) return board.tasks[markedTaskId];
    return Object.values(board.tasks).find(task => task.classification && task.refs.some(r =>
      (ref.userMsgId && r.userMsgId === ref.userMsgId)
        || (ref.assistantMsgId && r.assistantMsgId === ref.assistantMsgId))) || null;
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
      const userText = core.messageText(userMsg).trim() || task.classification?.seed || storedRef.excerpt || '';
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
            excerpt: (task.classification?.seed || storedRef.excerpt || userText).slice(0, 140),
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
            excerpt: (task.classification?.seed || storedRef.excerpt || userText).slice(0, 140),
          },
        };
      }
    }
    return partial;
  }

  function saveClassificationState(task, patch) {
    const previous = task.classification || {};
    task.classification = {
      state: 'pending', attempts: 0, lastAttemptAt: 0,
      nextRetryAt: 0, lastError: '', seed: '',
      ...previous,
      ...patch,
    };
    task.updatedAt = Date.now();
    save();
    const mod = task.moduleId ? board.modules[task.moduleId] : null;
    notify(mod?.dirId || task.refs.find(r => r.dirId)?.dirId || null, [task.id]);
  }

  function recordClassificationFailure(taskId, error) {
    const task = board.tasks[taskId];
    if (!task?.classification) return;
    const attempts = task.classification.attempts || 0;
    const exhausted = attempts >= MAX_AUTO_ATTEMPTS;
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
    saveClassificationState(task, {
      state: exhausted ? 'failed' : 'retry_wait',
      nextRetryAt: exhausted ? 0 : Date.now() + delay,
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
    if (!task?.classification) return { ok: false, error: 'not_pending' };
    if (pendingClassificationByTask.has(taskId)) return { ok: false, error: 'classification_running' };
    if (options.manual) task.classification.attempts = 0;

    const input = options.input || resolveTaskClassificationInput(task);
    if (!input?.userText) {
      saveClassificationState(task, {
        state: 'waiting_reply', nextRetryAt: Date.now() + 60_000,
        lastError: '',
      });
      return { ok: false, error: 'waiting_reply' };
    }
    if (!input.replyText) input.replyText = '（尚无助手回复，仅根据用户提交的任务信息归类）';
    if (auxQueue.isUnhealthy && auxQueue.isUnhealthy()) {
      saveClassificationState(task, {
        state: 'retry_wait', nextRetryAt: Date.now() + 60_000,
        lastError: 'aux_unhealthy',
      });
      return { ok: false, error: 'aux_unhealthy' };
    }

    const jobId = crypto.randomUUID();
    pendingClassificationByTask.set(taskId, jobId);
    saveClassificationState(task, {
      state: 'running',
      attempts: (task.classification.attempts || 0) + 1,
      lastAttemptAt: Date.now(),
      nextRetryAt: 0,
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
      pendingClassificationByTask.delete(taskId);
      logger.log(`[multicc/taskboard] classify enqueue failed for ${taskId}: ${e?.message || e}`);
      recordClassificationFailure(taskId, 'enqueue_failed');
      return { ok: false, error: 'enqueue_failed' };
    }

    Promise.resolve(promise).then(result => {
      if (pendingClassificationByTask.get(taskId) !== jobId) return;
      pendingClassificationByTask.delete(taskId);
      if (!result || result.cancelled) {
        recordClassificationFailure(taskId, 'classification_cancelled');
        return;
      }
      const parsed = core.parseTagResult(result.text);
      const entry = parsed.tasks.find(t => t.id === taskId || (t.id && board.tasks[t.id])) || parsed.tasks[0];
      if (!entry) {
        recordClassificationFailure(taskId, 'empty_classification');
        return;
      }
      const applied = core.applyTaskClassification(board, taskId, entry, input.ref, Date.now());
      if (!applied.ok) {
        recordClassificationFailure(taskId, applied.error);
        return;
      }
      save();
      notify(input.ref.dirId, applied.touched);
    }).catch(e => {
      if (pendingClassificationByTask.get(taskId) !== jobId) return;
      pendingClassificationByTask.delete(taskId);
      logger.log(`[multicc/taskboard] classify failed for ${taskId}: ${e?.message || e}`);
      recordClassificationFailure(taskId, 'classification_failed');
    });
    return { ok: true, queued: true };
  }

  function scanPendingClassifications(now = Date.now()) {
    let queued = 0;
    for (const task of Object.values(board.tasks)) {
      const c = task.classification;
      if (!c || c.state === 'failed' || pendingClassificationByTask.has(task.id)) continue;
      if (c.state === 'running') {
        c.state = 'retry_wait';
        c.nextRetryAt = now;
      }
      if (c.nextRetryAt && c.nextRetryAt > now) continue;
      const result = queueTaskClassification(task.id);
      if (result.ok) queued++;
    }
    return queued;
  }

  // Turn-end hook — called from classifyTurnEnd alongside the classify pass.
  // Never throws: tagging is best-effort decoration over the chat loop.
  function onTurnEnd(cs, sessionName) {
    try {
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway') return;
      const userText = String(cs?.currentUserText || '').trim();
      const replyText = String(cs?.currentAssistantText || '').trim();
      if (!userText) return;
      if (isSystemInjected(userText)) return;

      const history = loadHistory(sessionName) || [];
      const { userMsg, assistantMsg } = resolveTurnRefs(history, userText);
      if (!userMsg && !assistantMsg) return;
      const now = Date.now();
      const ref = {
        sessionId: sessionName,
        dirId: rec.dirId || null,
        dirLabel: null,
        userMsgId: userMsg?.id || null,
        assistantMsgId: assistantMsg?.id || null,
        ts: assistantMsg?.ts || userMsg?.ts || now,
        excerpt: userText.slice(0, 140),
      };

      // Deterministic path: turns routed from the task panel carry a marker;
      // attach them to their task without waiting for the AI verdict (and
      // regardless of reply length — a routed turn always belongs to its task).
      const markedTaskId = core.extractTaskMarker(userText);
      if (markedTaskId && board.tasks[markedTaskId]) {
        if (core.addRefToTask(board.tasks[markedTaskId], ref, now)) {
          save();
          notify(ref.dirId, [markedTaskId]);
        }
      }

      const pendingTask = pendingTaskForRef(ref, markedTaskId);
      if (pendingTask) {
        queueTaskClassification(pendingTask.id, { input: { userText, replyText, ref } });
        return;
      }

      // AI tagging needs a substantive reply to judge from.
      // Tool-heavy turns (Read/Edit/Bash) are substantive even with short text.
      const hasTools = assistantMsg && Array.isArray(assistantMsg.toolCalls) && assistantMsg.toolCalls.length > 0;
      if (replyText.length < 30 && !hasTools) return;
      if (auxQueue.isUnhealthy && auxQueue.isUnhealthy()) return;

      const prior = pendingTagBySession.get(sessionName);
      if (prior) auxQueue.cancel(prior);
      const taskId = crypto.randomUUID();
      pendingTagBySession.set(sessionName, taskId);

      auxQueue.enqueue({
        id: taskId,
        type: 'task_tag',
        systemPrompt: core.buildTagSystemPrompt(),
        prompt: core.buildTagUserPrompt({
          board,
          sessionLabel: rec.label || sessionName,
          dirLabel: null,
          userText,
          replyText,
        }),
        meta: { sessionName, sessionId: rec.id || sessionName },
      }).then(result => {
        if (pendingTagBySession.get(sessionName) === taskId) pendingTagBySession.delete(sessionName);
        if (!result || result.cancelled) return;
        const parsed = core.parseTagResult(result.text);
        if (!parsed.tasks.length) return;
        const beforeIds = new Set(Object.keys(board.tasks));
        const touched = core.applyTagResult(board, parsed.tasks, ref, Date.now());
        if (touched.length) {
          save();
          const created = touched.filter(id => !beforeIds.has(id));
          notify(ref.dirId, touched, created.length ? 'created' : undefined);
        }
      }).catch(e => {
        if (pendingTagBySession.get(sessionName) === taskId) pendingTagBySession.delete(sessionName);
        if (e && e.cancelled) return;
        logger.log(`[multicc/taskboard] tag failed for ${sessionName}: ${e?.message || e}`);
      });
    } catch (e) {
      logger.log(`[multicc/taskboard] onTurnEnd error: ${e?.message || e}`);
    }
  }

  // ── classify 识别出 goal 时立即创建/更新任务 ─────────────────────────
  function onClassifyGoal(sessionName, goal, phase, turn = {}) {
    try {
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway') return;

      const history = loadHistory(sessionName) || [];
      const currentUserText = String(turn.currentUserText || '').trim();
      const { userMsg, assistantMsg } = resolveTurnRefs(history, currentUserText);
      if (!userMsg && !assistantMsg) return;

      const now = Date.now();
      const ref = {
        sessionId: sessionName,
        dirId: rec.dirId || null,
        dirLabel: null,
        userMsgId: userMsg?.id || null,
        assistantMsgId: assistantMsg?.id || null,
        ts: assistantMsg?.ts || userMsg?.ts || now,
        excerpt: goal, // 用 goal 作为摘要
      };

      // A board-routed turn already owns a durable card. The marker is the
      // authoritative identity: reusing it avoids briefly creating a second
      // semantically-equivalent card before turn-end task_tag can reconcile.
      const markedTaskId = core.extractTaskMarker(currentUserText);
      const markedTask = markedTaskId ? board.tasks[markedTaskId] : null;
      if (markedTask) {
        let changed = core.addRefToTask(markedTask, ref, now);
        if (markedTask.classification) {
          const nextTitle = String(goal || '').trim().slice(0, 40);
          if (markedTask.title === core.PENDING_TASK_TITLE && nextTitle) {
            markedTask.title = nextTitle;
            changed = true;
          }
          markedTask.classification = {
            state: 'waiting_reply', attempts: 0, lastAttemptAt: 0,
            nextRetryAt: now + 60_000, lastError: '', seed: String(goal || '').slice(0, 1200),
          };
          markedTask.updatedAt = now;
          changed = true;
        }
        if (changed) {
          save();
          notify(ref.dirId, [markedTask.id]);
        }
        logger.log(`[multicc/taskboard] onClassifyGoal: reused marked task ${markedTask.id} for ${sessionName} phase=${phase || '?'}`);
        return;
      }

      const beforeIds = new Set(Object.keys(board.tasks));
      const touched = core.applyTagResult(board, [{
        id: 'new', title: goal, module: core.CLASSIFY_PENDING_MODULE_NAME, areas: [],
      }], ref, now, { moduleSource: 'classify', mergeSimilar: true });
      if (touched.length) {
        for (const taskId of touched) {
          const task = board.tasks[taskId];
          if (task && board.modules[task.moduleId]?.source === 'classify') {
            task.classification = {
              state: 'waiting_reply', attempts: 0, lastAttemptAt: 0,
              nextRetryAt: now + 60_000, lastError: '', seed: goal.slice(0, 1200),
            };
          }
        }
        save();
        const created = touched.filter(id => !beforeIds.has(id));
        notify(ref.dirId, touched, created.length ? 'created' : undefined);
        logger.log(`[multicc/taskboard] onClassifyGoal: ${created.length ? 'created' : 'merged'} task "${goal}" for ${sessionName} phase=${phase || '?'}`);
      }
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

  function taskDto(task) {
    const dto = core.buildBoardDto({ modules: board.modules, tasks: { [task.id]: task } }, getSessionRunState).tasks[0];
    if (dto?.routing) {
      dto.routing.targetLabel = records.get(dto.routing.targetSessionId)?.label || dto.routing.targetSessionId;
    }
    return dto;
  }

  function handleBoard(req, res) {
    const dto = core.buildBoardDto(board, getSessionRunState);
    const labels = {};
    for (const t of dto.tasks) {
      if (t.routing) {
        const sid = t.routing.targetSessionId;
        labels[sid] = records.get(sid)?.label || sid;
        t.routing.targetLabel = labels[sid];
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
    for (const ref of task.refs) {
      const label = records.get(ref.sessionId)?.label || ref.sessionId;
      const history = historyFor(ref.sessionId);
      const um = ref.userMsgId ? history.find(m => m && m.id === ref.userMsgId) : null;
      const am = ref.assistantMsgId ? history.find(m => m && m.id === ref.assistantMsgId) : null;
      if (um) {
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: um.id || ref.userMsgId || null,
                     ts: um.ts || ref.ts, text: core.messageText(um).slice(0, 4000) });
      } else if (ref.excerpt) {
        // The message may have been trimmed out of history — keep the excerpt.
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     messageId: null, ts: ref.ts, text: ref.excerpt, lost: true });
      }
      if (am) {
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'assistant',
                     messageId: am.id || ref.assistantMsgId || null,
                     ts: am.ts || ref.ts, text: core.messageText(am).slice(0, 4000) });
      }
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    res.json({ ok: true, task: taskDto(task), items });
  }

  async function handleSend(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const explicit = String(req.body?.target || '').trim() || null;
    let target;
    let routeMode;
    let wasBusy = false;
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
    } else {
      const commander = core.resolveDirectoryCommander(records, core.taskDirId(board, task));
      if (!commander.ok) return commanderFailure(res, commander.code);
      target = commander.sessionId;
      routeMode = 'commander';
      wasBusy = isSessionBusy(target);
    }
    const routed = routeMode === 'commander'
      ? core.buildCommanderRoutedMessage(task, text)
      : core.buildRoutedMessage(task, text);
    const message = goalNoteFor(req.body) + routed;
    const result = await dispatchToSession(target, message, {
      idempotencyKey: `taskboard:${task.id}:${crypto.randomUUID()}`,
      requireIdle: routeMode === 'manual',
      queueIfBusy: routeMode === 'commander',
      allowCommander: routeMode === 'commander',
    });
    if (!result.ok) {
      const busy = result.code === 'target_busy' || result.error === 'target_busy';
      return res.status(busy ? 409 : 502).json({ error: result.code || result.error || 'dispatch_failed' });
    }
    core.setTaskRouting(task, {
      mode: routeMode,
      targetSessionId: target,
      operationId: result.operationId || '',
      status: wasBusy ? 'queued' : (result.status || 'admitted'),
      routedAt: Date.now(),
    });
    save();
    notify(core.taskDirId(board, task), [task.id]);
    res.json({
      ok: true,
      target,
      targetLabel: records.get(target)?.label || target,
      routingMode: routeMode,
      commanderSessionId: routeMode === 'commander' ? target : null,
      queued: routeMode === 'commander' && wasBusy,
      chatId: result.chatId,
      operationId: result.operationId || null,
    });
  }

  // Board-level composer: reserve a visible card first, then route either to
  // the explicitly selected idle worker or the directory's typed Commander.
  // The marker lets turn-end classification converge that same card in place.
  async function handleBoardSend(req, res) {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const dirId = String(req.body?.dirId || '').trim() || null;
    const explicit = String(req.body?.target || '').trim() || null;
    let target;
    let routeMode;
    let wasBusy = false;
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
      const commander = core.resolveDirectoryCommander(records, dirId);
      if (!commander.ok) return commanderFailure(res, commander.code);
      target = commander.sessionId;
      routeMode = 'commander';
      wasBusy = isSessionBusy(target);
    }
    const pending = core.createPendingTask(board, { dirId, sessionId: target, seed: text });
    const routedAt = Date.now();
    core.setTaskRouting(pending, {
      mode: routeMode, targetSessionId: target,
      status: wasBusy ? 'queued' : 'admitted', routedAt,
    });
    save();
    notify(dirId, [pending.id], 'created');
    let result;
    try {
      const routed = routeMode === 'commander'
        ? core.buildCommanderRoutedMessage(pending, text)
        : core.buildRoutedMessage(pending, text);
      result = await dispatchToSession(target, goalNoteFor(req.body) + routed, {
        idempotencyKey: `taskboard:${pending.id}:${crypto.randomUUID()}`,
        requireIdle: routeMode === 'manual',
        queueIfBusy: routeMode === 'commander',
        allowCommander: routeMode === 'commander',
      });
    } catch (e) {
      result = { ok: false, error: e?.message || 'dispatch_failed' };
    }
    if (!result.ok) {
      const moduleId = pending.moduleId;
      delete board.tasks[pending.id];
      if (!Object.values(board.tasks).some(t => t.moduleId === moduleId)) delete board.modules[moduleId];
      save();
      notify(dirId, [pending.id]);
      const busy = result.code === 'target_busy' || result.error === 'target_busy';
      return res.status(busy ? 409 : 502).json({ error: result.code || result.error || 'dispatch_failed' });
    }
    core.setTaskRouting(pending, {
      mode: routeMode,
      targetSessionId: target,
      operationId: result.operationId || '',
      status: wasBusy ? 'queued' : (result.status || 'admitted'),
      routedAt,
    });
    save();
    notify(dirId, [pending.id]);
    res.json({
      ok: true,
      taskId: pending.id,
      target,
      targetLabel: records.get(target)?.label || target,
      routingMode: routeMode,
      commanderSessionId: routeMode === 'commander' ? target : null,
      queued: routeMode === 'commander' && wasBusy,
      chatId: result.chatId,
      operationId: result.operationId || null,
    });
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

  function handleReclassify(req, res) {
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    if (!task.classification) return res.status(409).json({ error: 'not_pending' });
    const result = queueTaskClassification(task.id, { manual: true });
    if (!result.ok) {
      const status = result.error === 'aux_unhealthy' ? 503 : 409;
      const note = result.error === 'waiting_reply' ? '任务仍在执行，回复完成后会自动归类' : null;
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
      if (!task.classification) continue;
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

  const retryTimer = setInterval(() => scanPendingClassifications(), 60_000);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
  const startupTimer = setTimeout(() => scanPendingClassifications(), 1_000);
  if (typeof startupTimer.unref === 'function') startupTimer.unref();

  return Object.freeze({
    mountRoutes,
    onTurnEnd,
    onClassifyGoal,
    scanPendingClassifications,
    // test/introspection surface
    getBoard: () => board,
    save,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

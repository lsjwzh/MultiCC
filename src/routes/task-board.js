'use strict';

// Task board runtime — wires the pure core (src/task-board.js) to the host:
// aux-queue tagging at turn end, atomic persistence, REST routes for the
// fleet panel, and the panel composer's auto-routed dispatch.
//
// Host contract (all deps injected by server.js):
//   file               — task_board.json path (from createPaths)
//   auxQueue           — { enqueue, cancel, isUnhealthy } from mountAuxGoalRoutes
//   records            — persistedSessions Map (sessionId → record)
//   loadHistory        — sessionId → message[] (deep copy)
//   dispatchToSession  — (targetId, message, opts) → Promise<{ok,...}>
//   workspaceBroadcast — (dirId, payload) → void (reaches /ws/meta clients)
//   isLocalRequest     — req → bool (mutation gate, same as host-write)
//   atomicWriteJson    — (file, value) → void
//   isSystemInjected   — msgText → bool (skip recovery/nudge turns)

const fs = require('fs');
const crypto = require('crypto');
const core = require('../task-board');

const REQUIRED_DEPS = [
  'file', 'auxQueue', 'records', 'loadHistory', 'dispatchToSession',
  'workspaceBroadcast', 'isLocalRequest', 'atomicWriteJson', 'isSystemInjected',
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
    file, auxQueue, records, loadHistory, dispatchToSession,
    workspaceBroadcast, isLocalRequest, atomicWriteJson, isSystemInjected,
    getSessionRunState,
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

  // Resolve the just-persisted turn's message ids from the history tail: the
  // last non-interim assistant message and the nearest user message before it.
  function resolveTurnRefs(history) {
    let asstIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.role === 'assistant' && !m._interim && !m.error) { asstIdx = i; break; }
    }
    let userIdx = -1;
    for (let i = (asstIdx === -1 ? history.length : asstIdx) - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.role === 'user') { userIdx = i; break; }
    }
    return {
      userMsg: userIdx === -1 ? null : history[userIdx],
      assistantMsg: asstIdx === -1 ? null : history[asstIdx],
    };
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
      const { userMsg, assistantMsg } = resolveTurnRefs(history);
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
  function onClassifyGoal(sessionName, goal, phase) {
    try {
      const rec = records.get(sessionName);
      if (!rec || rec.type === 'aux' || rec.type === 'gateway') return;

      const history = loadHistory(sessionName) || [];
      const { userMsg, assistantMsg } = resolveTurnRefs(history);
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

      // 查找或创建任务：用 goal 作为 title 的归一化 key
      const moduleId = rec.dirId || '_default';
      let module = board.modules[moduleId];
      if (!module) {
        module = { id: moduleId, name: rec.dirId || '默认', source: 'classify', dirId: rec.dirId, createdAt: now, updatedAt: now };
        board.modules[moduleId] = module;
      }

      // 查找同名任务（goal 相同视为同一任务）
      let task = Object.values(board.tasks).find(t => t.moduleId === moduleId && t.title === goal);
      if (!task) {
        const taskId = crypto.randomUUID();
        task = { id: taskId, moduleId, title: goal, status: 'open', areas: [], refs: [], createdAt: now, updatedAt: now };
        board.tasks[taskId] = task;
      }

      // 添加 ref（去重）
      if (core.addRefToTask(task, ref, now)) {
        task.updatedAt = now;
        module.updatedAt = now;
        save();
        notify(ref.dirId, [task.id], 'created');
        logger.log(`[multicc/taskboard] onClassifyGoal: created/updated task "${goal}" for ${sessionName}`);
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
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
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
      if (rec.type === 'aux' || rec.type === 'gateway' || rec.ephemeral) continue;
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

  function taskDto(task) {
    return core.buildBoardDto({ modules: board.modules, tasks: { [task.id]: task } }, getSessionRunState).tasks[0];
  }

  function handleBoard(req, res) {
    const dto = core.buildBoardDto(board, getSessionRunState);
    const labels = {};
    for (const t of dto.tasks) {
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
                     ts: um.ts || ref.ts, text: core.messageText(um).slice(0, 4000) });
      } else if (ref.excerpt) {
        // The message may have been trimmed out of history — keep the excerpt.
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'user',
                     ts: ref.ts, text: ref.excerpt, lost: true });
      }
      if (am) {
        items.push({ sessionId: ref.sessionId, sessionLabel: label, role: 'assistant',
                     ts: am.ts || ref.ts, text: core.messageText(am).slice(0, 4000) });
      }
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    res.json({ ok: true, task: taskDto(task), items });
  }

  async function handleSend(req, res) {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
    const task = board.tasks[req.params.taskId];
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const explicit = String(req.body?.target || '').trim() || null;
    const target = core.pickRouteTarget(board, task, records, explicit);
    if (!target) return res.status(409).json({ error: 'no_route_target', note: '没有可路由的会话：该任务还没有参与会话，且模块目录下无可用 chat 会话' });
    const message = goalNoteFor(req.body) + core.buildRoutedMessage(task, text);
    const result = await dispatchToSession(target, message, {
      idempotencyKey: `taskboard:${task.id}:${crypto.randomUUID()}`,
    });
    if (!result.ok) return res.status(502).json({ error: result.error || 'dispatch_failed' });
    res.json({
      ok: true,
      target,
      targetLabel: records.get(target)?.label || target,
      chatId: result.chatId,
      operationId: result.operationId || null,
    });
  }

  // Board-level composer: not bound to any task. Routes to the explicit
  // target or the most recently active chat session in the directory; the
  // resulting turn gets archived onto tasks by the normal turn-end tagger.
  async function handleBoardSend(req, res) {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_text' });
    const dirId = String(req.body?.dirId || '').trim() || null;
    const explicit = String(req.body?.target || '').trim() || null;
    const target = core.pickDirTarget(records, dirId, explicit);
    if (!target) return res.status(409).json({ error: 'no_route_target', note: '该目录下没有可路由的 chat 会话' });
    const result = await dispatchToSession(target, goalNoteFor(req.body) + text, {
      idempotencyKey: `taskboard:dir:${crypto.randomUUID()}`,
    });
    if (!result.ok) return res.status(502).json({ error: result.error || 'dispatch_failed' });
    res.json({
      ok: true,
      target,
      targetLabel: records.get(target)?.label || target,
      chatId: result.chatId,
      operationId: result.operationId || null,
    });
  }

  function handleStatus(req, res) {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'forbidden' });
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
  }

  return Object.freeze({
    mountRoutes,
    onTurnEnd,
    onClassifyGoal,
    // test/introspection surface
    getBoard: () => board,
    save,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

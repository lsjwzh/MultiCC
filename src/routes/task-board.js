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
  } = deps;
  const logger = deps.logger || console;

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

  function notify(dirId, taskIds) {
    try { workspaceBroadcast(dirId || null, { type: 'task_board_update', taskIds }); }
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
      if (replyText.length < 30) return;
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
        const touched = core.applyTagResult(board, parsed.tasks, ref, Date.now());
        if (touched.length) {
          save();
          notify(ref.dirId, touched);
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

  // ── REST ──────────────────────────────────────────────────────────────────

  function taskDto(task) {
    return core.buildBoardDto({ modules: board.modules, tasks: { [task.id]: task } }).tasks[0];
  }

  function handleBoard(req, res) {
    const dto = core.buildBoardDto(board);
    const labels = {};
    for (const t of dto.tasks) {
      for (const sid of t.sessionIds) {
        if (!(sid in labels)) labels[sid] = records.get(sid)?.label || sid;
      }
    }
    res.json({ ok: true, ...dto, sessionLabels: labels });
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
    const message = core.buildRoutedMessage(task, text);
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
  }

  return Object.freeze({
    mountRoutes,
    onTurnEnd,
    // test/introspection surface
    getBoard: () => board,
    save,
  });
}

module.exports = { createTaskBoardRuntime, assertTaskBoardDeps };

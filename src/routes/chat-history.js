'use strict';

const crypto = require('node:crypto');
const { createChatHistoryService } = require('../session/chat-history-service');
const { sanitizePublicText } = require('../http/public-safety');

const DEFAULT_HISTORY_PAGE_SIZE = 5;
const DEFAULT_HISTORY_LIMIT = 10000;
const DEFAULT_MEMORY_DISTILL_BATCH = 10;
const DEFAULT_INCREMENTAL_SAVE_DELAY_MS = 5000;

function requireFunction(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw new TypeError(`chat history dependency missing: ${name}`);
  }
}

function assertChatHistoryDeps(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('chat history dependencies are required');
  }
  if (!deps.history || typeof deps.history !== 'object') {
    throw new TypeError('chat history dependency missing: history');
  }
  for (const method of ['read', 'write', 'deleteSession', 'hasPersistedDelivery']) {
    if (typeof deps.history[method] !== 'function') {
      throw new TypeError(`chat history dependency missing: history.${method}`);
    }
  }
  if (!deps.persistedSessions || typeof deps.persistedSessions.get !== 'function') {
    throw new TypeError('chat history dependency missing: persistedSessions');
  }
  if (!deps.chatSessions || typeof deps.chatSessions.get !== 'function') {
    throw new TypeError('chat history dependency missing: chatSessions');
  }
  for (const name of [
    'idFactory',
    'chatBroadcast',
    'distillHistoryIntoMemory',
    'maybeSchedulePeriodicMemoryReview',
    'cliSwitchGitSnapshot',
    'clearAllNativeCliStates',
    'buildHandoffCheckpoint',
    'rememberActiveCliState',
    'saveBestEffort',
    'trackPendingMemoryDistill',
  ]) requireFunction(deps, name);
  if (!deps.chatStream || typeof deps.chatStream.close !== 'function') {
    throw new TypeError('chat history dependency missing: chatStream.close');
  }
  if (deps.projectMessages != null && typeof deps.projectMessages !== 'function') {
    throw new TypeError('chat history dependency invalid: projectMessages');
  }
  // Optional: only the context water-level readout needs it, and a host that does
  // not supply it just gets `unsupported` from that one route.
  if (deps.cwdForSession != null && typeof deps.cwdForSession !== 'function') {
    throw new TypeError('chat history dependency invalid: cwdForSession');
  }
  return deps;
}

function assertApp(app) {
  for (const method of ['get', 'delete']) {
    if (!app || typeof app[method] !== 'function') {
      throw new TypeError(`Express app.${method} is required`);
    }
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function publicError(error, fallback) {
  return sanitizePublicText(error && error.message, fallback);
}

function publicCommittedMessage(message) {
  if (!message || message.role !== 'user' || !message.id) return null;
  const projected = {
    id: String(message.id).slice(0, 160),
    role: 'user',
    content: String(message.content || ''),
    ts: Number.isFinite(Number(message.ts)) ? Number(message.ts) : null,
  };
  if (typeof message.clientMsgId === 'string' && message.clientMsgId) {
    projected.clientMsgId = message.clientMsgId.slice(0, 160);
  }
  // Surface the wait_for_user_answer settlement marker so multi-window clients
  // can close the prompt card from the message itself (live or replay), not just
  // from the user_input_resolved event. Metadata-only; never reaches the model.
  if (typeof message.answeredQuestionId === 'string' && message.answeredQuestionId) {
    projected.answeredQuestionId = message.answeredQuestionId.slice(0, 160);
  }
  if (Array.isArray(message.bgToolUseIds) && message.bgToolUseIds.length) {
    projected.bgToolUseIds = message.bgToolUseIds
      .filter(value => typeof value === 'string' && value)
      .slice(0, 64)
      .map(value => value.slice(0, 160));
  }
  for (const field of ['turnId', 'taskId', 'taskName', 'auxRunId']) {
    if (typeof message[field] === 'string' && message[field]) {
      projected[field] = message[field].slice(0, 160);
    }
  }
  return Object.freeze(projected);
}

// Build the authoritative reconnect page without representing one live turn
// twice. Incremental crash-safety persistence may already have placed a
// trailing `_interim` assistant in the canonical page; in that case promote
// that same stable-id message to the live streaming tail instead of appending
// a second id-less copy containing the cumulative text again.
function buildReplayMessages(pageMessages, state, now = Date.now) {
  const messages = Array.isArray(pageMessages)
    ? pageMessages.map(message => ({ ...message }))
    : [];
  const text = String(state?.currentAssistantText || '');
  const tools = Array.isArray(state?.currentToolCalls) ? state.currentToolCalls : [];
  const hasInProgress = !state?._resultSaved && !!(text || tools.length);
  if (!hasInProgress) return messages;

  const live = {
    role: 'assistant',
    content: text,
    tools: tools.length ? tools : undefined,
    ts: now(),
    streaming: state?.isStreaming === true,
  };
  if (state?._currentTaskId) live.taskId = state._currentTaskId;
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last._interim) {
    messages[messages.length - 1] = { ...last, ...live, id: last.id };
  } else {
    messages.push(live);
  }
  return messages;
}

function createChatHistoryRuntime(rawDeps) {
  const deps = assertChatHistoryDeps(rawDeps);
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const scheduleImmediate = typeof deps.setImmediate === 'function' ? deps.setImmediate : setImmediate;
  const setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
  const clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
  const randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : crypto.randomBytes;
  const historyPageSize = positiveInteger(deps.historyPageSize, DEFAULT_HISTORY_PAGE_SIZE);
  const memoryDistillBatch = positiveInteger(deps.memoryDistillBatch, DEFAULT_MEMORY_DISTILL_BATCH);
  const incrementalSaveDelayMs = Number.isFinite(deps.incrementalSaveDelayMs)
    && deps.incrementalSaveDelayMs >= 0
    ? deps.incrementalSaveDelayMs
    : DEFAULT_INCREMENTAL_SAVE_DELAY_MS;
  const droppedForMemory = new Map();
  const incrementalSaveTimers = new Map();
  let stopped = false;
  // Lazy: the OpenCode SQLite reader is only constructed when an opencode
  // session actually asks for its context water level.
  let opencodeContextReader = null;

  function logFailure(event, error, sessionId) {
    const payload = {
      error: publicError(error, 'chat history operation failed'),
    };
    if (sessionId) payload.sessionId = sanitizePublicText(String(sessionId), 'unknown_session').slice(0, 128);
    try {
      if (typeof logger.warn === 'function') logger.warn(event, payload);
      else if (typeof logger.error === 'function') logger.error(event, payload);
    } catch (_) {}
  }

  function startMemoryDistill(sessionId, messages) {
    let result;
    try {
      result = deps.distillHistoryIntoMemory(sessionId, messages);
    } catch (error) {
      logFailure('chat_history_memory_distill_failed', error, sessionId);
      return null;
    }
    Promise.resolve(result).catch(error => {
      logFailure('chat_history_memory_distill_failed', error, sessionId);
    });
    return result;
  }

  function handleCommittedHistoryEvent(event) {
    if (!event || !event.sessionId) return;
    if (event.type === 'append') {
      for (const dropped of event.dropped || []) {
        if (event.sessionId === deps.auxSessionId || !dropped) continue;
        const buffer = droppedForMemory.get(event.sessionId) || [];
        buffer.push(dropped);
        if (buffer.length >= memoryDistillBatch) {
          startMemoryDistill(event.sessionId, buffer.slice());
          droppedForMemory.set(event.sessionId, []);
        } else {
          droppedForMemory.set(event.sessionId, buffer);
        }
      }

      const message = event.message;
      if (message) {
        const committedMessage = publicCommittedMessage(message);
        deps.chatBroadcast(event.sessionId, {
          type: 'chat_msg_meta',
          id: message.id,
          role: message.role,
          ts: message.ts,
          clientMsgId: message.clientMsgId || null,
          // Backward-compatible expansion: older clients consume only the
          // metadata above, while multi-window clients can render the committed
          // message immediately instead of waiting for a reconnect page.
          message: committedMessage || undefined,
        });
        if (!event.deduplicated && message.role === 'assistant' && !message._interim
            && !message.cancelled && !message.partial && !message.error) {
          scheduleImmediate(() => {
            if (stopped) return;
            try { deps.maybeSchedulePeriodicMemoryReview(event.sessionId); }
            catch (error) {
              logFailure('chat_history_memory_review_schedule_failed', error, event.sessionId);
            }
          });
        }
      }
      return;
    }
    if (event.type === 'remove' && event.message) {
      deps.chatBroadcast(event.sessionId, {
        type: 'chat_msg_deleted',
        id: event.message.id,
      });
    }
  }

  const service = createChatHistoryService({
    history: deps.history,
    idFactory: deps.idFactory,
    clock: now,
    maxMessages: positiveInteger(deps.maxMessages, DEFAULT_HISTORY_LIMIT),
    retentionPolicy: typeof deps.retentionPolicy === 'function' ? deps.retentionPolicy : null,
    postPersist: handleCommittedHistoryEvent,
    onPostPersistError: (error, event) => {
      logFailure('chat_history_post_persist_failed', error, event && event.sessionId);
    },
  });

  function load(sessionId) {
    return service.read(sessionId);
  }

  // Read-only transcript for callers that only measure it (token totals,
  // context level) and never hand the messages on. load()'s deep clone buys
  // them nothing: summarizing a codex session's usage on every WS connect was
  // cloning the whole transcript to add up numbers.
  function viewHistory(sessionId) {
    return service.view(sessionId);
  }

  // Deep-copy a page before it leaves this module, so a caller can never reach
  // back into the service cache through the messages it was handed. Cloning one
  // page is bounded work; cloning the transcript it came from was not.
  function isolate(messages) {
    return JSON.parse(JSON.stringify(messages));
  }

  // Read-only: the result may share messages with the service cache, so every
  // caller must clone whatever it hands out. Projection is copy-on-write, and
  // paginate() clones only the page it returns — deep-cloning the whole
  // transcript here to then slice five messages out of it was the single
  // hottest thing the WS replay did.
  function projectedMessages(sessionId) {
    const messages = service.view(sessionId);
    if (!deps.projectMessages) return messages;
    try {
      const projected = deps.projectMessages(String(sessionId), messages);
      return Array.isArray(projected) ? projected : messages;
    } catch (error) {
      logFailure('chat_history_projection_failed', error, sessionId);
      return messages;
    }
  }

  function paginate(sessionId, { before, around, limit = historyPageSize } = {}) {
    const messages = projectedMessages(sessionId);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || historyPageSize));
    if (around) {
      const targetId = String(around).slice(0, 160);
      const targetIndex = messages.findIndex(message => message.id === targetId);
      if (targetIndex < 0) {
        return Object.freeze({
          messages: [], hasMore: false, before: null, found: false, hasNewer: false,
        });
      }
      const halfWindow = Math.floor((pageSize - 1) / 2);
      let start = Math.max(0, targetIndex - halfWindow);
      const end = Math.min(messages.length, start + pageSize);
      start = Math.max(0, end - pageSize);
      return Object.freeze({
        messages: isolate(messages.slice(start, end)),
        hasMore: start > 0,
        before: start > 0 ? messages[start].id : null,
        found: true,
        hasNewer: end < messages.length,
      });
    }
    let end = messages.length;
    if (before) {
      const index = messages.findIndex(message => message.id === before);
      if (index < 0) return Object.freeze({ messages: [], hasMore: false, before: null });
      end = index;
    }
    const start = Math.max(0, end - pageSize);
    return Object.freeze({
      messages: isolate(messages.slice(start, end)),
      hasMore: start > 0,
      before: start > 0 ? messages[start].id : null,
    });
  }

  function latestAssistantAt(sessionId) {
    return service.latestAssistantAt(sessionId);
  }

  function lastActivity(sessionId, activeChat) {
    const saved = latestAssistantAt(sessionId);
    const live = activeChat && activeChat.lastActivity
      ? new Date(activeChat.lastActivity)
      : null;
    const liveValid = live && Number.isFinite(live.getTime());
    if (saved && liveValid) return saved.getTime() >= live.getTime() ? saved : live;
    return saved || (liveValid ? live : null);
  }

  function appendMessage(sessionId, message) {
    if (!message || typeof message !== 'object') return false;
    if (!message.id) message.id = deps.idFactory();
    // Stamp the task this message belongs to. The interim save path has always
    // done this; doing it here covers user messages and finals too, which is
    // what makes a transcript groupable by task instead of only by session.
    // An explicit taskId on the message wins — callers replaying or importing
    // history know better than the live session pointer.
    if (message.taskId == null) {
      const owner = deps.chatSessions.get(sessionId);
      if (owner && owner._currentTaskId) message.taskId = owner._currentTaskId;
    }
    if (message.turnId == null) {
      const owner = deps.chatSessions.get(sessionId);
      if (owner?._activeTurn?.turnId) message.turnId = owner._activeTurn.turnId;
    }
    let afterCommit;
    if (message.role === 'assistant') {
      const stamp = Number(message.ts);
      const at = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp) : new Date(now());
      const state = deps.chatSessions.get(sessionId);
      if (message.durationMs == null && state && state.turnStartedAt) {
        message.durationMs = Math.max(0, at.getTime() - state.turnStartedAt);
      }
      afterCommit = () => { if (state) state.lastActivity = at; };
    }
    try {
      service.append(sessionId, message, { afterCommit });
      return true;
    } catch (error) {
      logFailure('chat_history_append_failed', error, sessionId);
      return false;
    }
  }

  function clearIncrementalSave(sessionId) {
    const key = String(sessionId);
    const timer = incrementalSaveTimers.get(key);
    if (!timer) return false;
    clearTimeoutFn(timer);
    incrementalSaveTimers.delete(key);
    return true;
  }

  function annotateTurn(sessionId, turnId, patch = {}, { anchorMessageId = null } = {}) {
    const history = service.read(sessionId);
    let selected = new Set();
    if (turnId) {
      selected = new Set(history.filter(message => message?.turnId === turnId).map(message => message.id));
    }
    // Legacy/fallback path for a just-finished turn that predates turnId: anchor
    // on the judged assistant and include the nearest preceding user message.
    if (!selected.size && anchorMessageId) {
      const anchor = history.findIndex(message => message?.id === anchorMessageId);
      if (anchor !== -1) {
        let start = anchor;
        while (start >= 0 && history[start]?.role !== 'user') start -= 1;
        for (let index = Math.max(0, start); index <= anchor; index += 1) {
          if (history[index]?.id) selected.add(history[index].id);
        }
      }
    }
    if (!selected.size) return [];

    const changed = [];
    const next = history.map(message => {
      if (!selected.has(message?.id)) return message;
      const updated = { ...message };
      for (const field of ['taskId', 'taskName', 'auxRunId']) {
        if (patch[field] !== undefined) updated[field] = patch[field];
      }
      if (message.role === 'user') {
        for (const field of ['taskStart', 'taskSource', 'taskText']) {
          if (patch[field] !== undefined) updated[field] = patch[field];
        }
      }
      changed.push(updated);
      return updated;
    });
    try {
      service.replace(sessionId, next, { reason: 'aux-task-attribution' });
      deps.chatBroadcast(String(sessionId), {
        type: 'chat_history_annotation',
        messages: changed.map(message => ({
          id: message.id,
          turnId: message.turnId || null,
          taskId: message.taskId || null,
          taskName: message.taskName || null,
          auxRunId: message.auxRunId || null,
        })),
      });
      return changed;
    } catch (error) {
      logFailure('chat_history_annotation_failed', error, sessionId);
      return [];
    }
  }

  function clearAllIncrementalSaves() {
    for (const timer of incrementalSaveTimers.values()) clearTimeoutFn(timer);
    const count = incrementalSaveTimers.size;
    incrementalSaveTimers.clear();
    return count;
  }

  function scheduleIncrementalSave(sessionId, state) {
    const key = String(sessionId);
    if (stopped || incrementalSaveTimers.has(key)) return false;
    const timer = setTimeoutFn(() => {
      incrementalSaveTimers.delete(key);
      if (stopped || !state || !state.currentAssistantText
          || state.currentAssistantText.length < 20) return;
      const tools = Array.isArray(state.currentToolCalls) && state.currentToolCalls.length
        ? state.currentToolCalls
        : undefined;
      try {
        const interim = {
          role: 'assistant',
          content: state.currentAssistantText,
          tools,
          ts: now(),
          _interim: true,
        };
        if (state._currentTaskId) interim.taskId = state._currentTaskId;
        service.upsertInterim(key, interim);
      } catch (error) {
        logFailure('chat_history_interim_save_failed', error, key);
      }
    }, incrementalSaveDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    incrementalSaveTimers.set(key, timer);
    return true;
  }

  async function clearHistoryUnsafe(sessionId, message, chatState) {
    const key = String(sessionId);
    const history = load(key);
    const keep = Math.max(0, parseInt(message && message.keep || '0', 10) || 0);
    const persisted = deps.persistedSessions.get(key);
    const gitSnapshot = persisted && keep > 0
      ? await deps.cliSwitchGitSnapshot(persisted)
      : null;
    const split = keep > 0 ? Math.max(0, history.length - keep) : history.length;
    const removed = history.slice(0, split);
    const retained = history.slice(split);
    let memoryDistill = null;

    // replace() writes the full new array before afterCommit runs. Therefore no
    // client reset or native-context mutation can happen without durable proof.
    service.replace(key, retained, {
      reason: 'clear-history',
      afterCommit: () => {
        if (removed.length) memoryDistill = startMemoryDistill(key, removed);
        const canonicalPage = service.paginate(key, { limit: historyPageSize });
        const page = deps.projectMessages
          ? paginate(key, { limit: historyPageSize })
          : canonicalPage;
        deps.chatBroadcast(key, {
          type: 'chat_history_reset',
          messages: page.messages,
          hasMore: page.hasMore,
          keep,
          removedCount: removed.length,
          retainedCount: retained.length,
        });
      },
    });

    let clearedNativeSessions = 0;
    if (persisted) {
      deps.chatStream.close(key);
      delete persisted.pendingCliHandoff;
      clearedNativeSessions = deps.clearAllNativeCliStates(persisted);
      if (keep > 0 && retained.length) {
        const cli = chatState && chatState.cli;
        const checkpoint = deps.buildHandoffCheckpoint({
          session: persisted,
          fromCli: cli,
          toCli: cli,
          history: retained,
          git: gitSnapshot,
        });
        checkpoint.reason = 'history_clear_keep';
        persisted.pendingCliHandoff = {
          id: `checkpoint_${randomBytes(8).toString('hex')}`,
          fromCli: cli,
          toCli: cli,
          createdAt: checkpoint.createdAt,
          status: 'pending',
          reason: 'history_clear_keep',
          reusedTarget: false,
          checkpoint,
        };
      }
      deps.rememberActiveCliState(persisted);
      deps.saveBestEffort('websocket.clear-native-session-state');
    }
    if (chatState) chatState.chatTurnCount = 0;
    if (memoryDistill) deps.trackPendingMemoryDistill(key, memoryDistill);
    return Object.freeze({
      keep,
      removedCount: removed.length,
      retainedCount: retained.length,
      clearedNativeSessions,
    });
  }

  async function clearHistory(sessionId, message, chatState) {
    if (message && message.preserveHistory === true) {
      return rotateNativeContext(sessionId, chatState);
    }
    try {
      return await clearHistoryUnsafe(sessionId, message, chatState);
    } catch (error) {
      logFailure('chat_history_clear_failed', error, sessionId);
      const failure = new Error('chat history clear failed');
      failure.code = 'CHAT_HISTORY_CLEAR_FAILED';
      throw failure;
    }
  }

  async function rotateNativeContextUnsafe(sessionId, chatState) {
    const key = String(sessionId);
    const persisted = deps.persistedSessions.get(key);
    if (!persisted) {
      return Object.freeze({ ok: false, code: 'session_not_found' });
    }
    if (persisted.kind && persisted.kind !== 'chat') {
      return Object.freeze({ ok: false, code: 'not_chat_session' });
    }

    const existing = persisted.pendingCliHandoff;
    if (existing && existing.status === 'pending') {
      if (existing.reason !== 'manual_native_context_rotate') {
        deps.chatBroadcast(key, {
          type: 'native_context_rotation_rejected',
          code: 'handoff_pending',
        });
        return Object.freeze({ ok: false, code: 'handoff_pending' });
      }
      const reused = Object.freeze({
        ok: true,
        reused: true,
        checkpointId: existing.id,
        clearedNativeSessions: 0,
      });
      deps.chatBroadcast(key, {
        type: 'native_context_rotated',
        checkpointId: existing.id,
        clearedNativeSessions: 0,
        historyPreserved: true,
        reused: true,
      });
      return reused;
    }

    const rotationReady = typeof deps.getSessionRunState === 'function'
      && typeof deps.getActiveBackgroundTasks === 'function'
      && typeof deps.sessionPersistence?.mutate === 'function';
    const runState = rotationReady ? deps.getSessionRunState(key) : 'running';
    const activeBackground = rotationReady ? deps.getActiveBackgroundTasks(key) : [];
    // Classify alone gates rotation. 'assessing' stays blocked here (unlike the
    // dispatch predicate): rotation rewrites native context, so waiting for the
    // verdict is the safe side, and a user can always retry.
    const blockCode = !rotationReady
      || ['queued', 'running', 'assessing'].includes(runState)
      ? 'session_busy'
      : Array.isArray(activeBackground) && activeBackground.length
        ? 'background_tasks_running'
        : null;
    if (blockCode) {
      deps.chatBroadcast(key, {
        type: 'native_context_rotation_rejected',
        code: blockCode,
      });
      return Object.freeze({
        ok: false,
        code: blockCode,
      });
    }

    const history = load(key);
    const gitSnapshot = await deps.cliSwitchGitSnapshot(persisted);
    const cli = (chatState && chatState.cli) || persisted.cli;
    const checkpoint = deps.buildHandoffCheckpoint({
      session: persisted,
      fromCli: cli,
      toCli: cli,
      history,
      git: gitSnapshot,
    });
    checkpoint.reason = 'manual_native_context_rotate';
    const handoff = {
      id: `checkpoint_${randomBytes(8).toString('hex')}`,
      fromCli: cli,
      toCli: cli,
      createdAt: checkpoint.createdAt,
      status: 'pending',
      reason: 'manual_native_context_rotate',
      reusedTarget: false,
      checkpoint,
    };

    const clearedNativeSessions = deps.sessionPersistence.mutate(
      'websocket.rotate-native-context',
      () => {
        const cleared = deps.clearAllNativeCliStates(persisted);
        persisted.pendingCliHandoff = handoff;
        deps.rememberActiveCliState(persisted);
        return cleared;
      },
    );
    deps.chatStream.close(key);
    if (chatState) chatState.chatTurnCount = 0;
    deps.chatBroadcast(key, {
      type: 'native_context_rotated',
      checkpointId: handoff.id,
      clearedNativeSessions,
      historyPreserved: true,
      reused: false,
    });
    return Object.freeze({
      ok: true,
      reused: false,
      checkpointId: handoff.id,
      clearedNativeSessions,
    });
  }

  async function rotateNativeContext(sessionId, chatState) {
    try {
      return await rotateNativeContextUnsafe(sessionId, chatState);
    } catch (error) {
      logFailure('native_context_rotation_failed', error, sessionId);
      const failure = new Error('native context rotation failed');
      failure.code = 'NATIVE_CONTEXT_ROTATION_FAILED';
      throw failure;
    }
  }

  function mountRoutes(app) {
    assertApp(app);
    app.delete('/api/sessions/:id/messages/:msgId', (req, res, next) => {
      const sessionId = req.params.id;
      if (!deps.persistedSessions.get(sessionId)) {
        return res.status(404).json({ error: 'session not found' });
      }
      try {
        const result = service.remove(sessionId, req.params.msgId);
        if (!result.removed) return res.status(404).json({ error: 'message not found' });
        return res.json({ ok: true });
      } catch (error) {
        logFailure('chat_history_delete_failed', error, sessionId);
        if (typeof next === 'function') return next(new Error('chat history operation failed'));
        return res.status(500).json({ error: 'chat history delete failed' });
      }
    });

    app.get('/api/sessions/:id/history', (req, res, next) => {
      const sessionId = req.params.id;
      if (!deps.persistedSessions.get(sessionId)) {
        return res.status(404).json({ error: 'session not found' });
      }
      try {
        const page = paginate(sessionId, {
          before: req.query.before && String(req.query.before),
          around: req.query.around && String(req.query.around),
          limit: req.query.limit && String(req.query.limit),
        });
        const response = { messages: page.messages, hasMore: page.hasMore };
        if (req.query.around) {
          response.found = page.found === true;
          response.hasNewer = page.hasNewer === true;
        }
        return res.json(response);
      } catch (error) {
        logFailure('chat_history_page_failed', error, sessionId);
        if (typeof next === 'function') return next(new Error('chat history operation failed'));
        return res.status(500).json({ error: 'chat history load failed' });
      }
    });

    // Context water level. Read-only: it never rewrites the transcript, so it is
    // safe to poll from the UI. `?plan=1` additionally runs a forced dry-run prune
    // to answer "what would trimming actually cost", which is O(file) and therefore
    // opt-in. The transcript path is deliberately never returned — responses must
    // not leak absolute filesystem paths.
    app.get('/api/sessions/:id/context-level', (req, res, next) => {
      const sessionId = req.params.id;
      const persisted = deps.persistedSessions.get(sessionId);
      if (!persisted) return res.status(404).json({ error: 'session not found' });
      try {
        if (typeof deps.cwdForSession !== 'function') {
          return res.json({ ok: true, supported: false, reason: 'no-cwd-resolver' });
        }
        // OpenCode native context lives in its SQLite store, not a transcript
        // file. The water level is the latest message's token usage for the
        // EXACT native session id MultiCC captured — never a sibling session
        // that merely shares the working directory.
        if (persisted.cli === 'opencode') {
          if (!opencodeContextReader) {
            opencodeContextReader = deps.opencodeContextReader
              || require('../chat/opencode-context').createOpencodeContextReader({
                logger: deps.logger,
              });
          }
          const cliSessionId = persisted._streamSessionId || persisted.cliSessionId || null;
          const usage = opencodeContextReader.read(cliSessionId, persisted.model || null);
          return res.json({ ok: true, supported: true, cli: 'opencode', native: usage });
        }
        if (persisted.cli !== 'claude') {
          return res.json({ ok: true, supported: false, reason: 'cli-not-claude', cli: persisted.cli || null });
        }
        const { measure, maybePrune } = require('../chat/transcript-prune');
        const cwd = deps.cwdForSession(persisted);
        // The streaming path is where a chat session's context actually lives; the
        // per-turn id is the fallback for sessions that never streamed.
        const cliSessionId = persisted._streamSessionId || persisted.cliSessionId || null;
        const transcript = measure(cwd, cliSessionId);
        const body = { ok: true, supported: true, cli: 'claude', transcript };
        const status = typeof deps.chatStream.status === 'function'
          ? deps.chatStream.status(sessionId)
          : null;
        if (status) {
          // A warm process holds its own copy of the conversation, so a trim on
          // disk only lands after a recycle — surface whether one is pending.
          body.process = {
            alive: status.alive === true,
            busy: status.busy === true,
            recycleRequested: status.recycleRequested === true,
          };
        }
        if (transcript.found && (req.query.plan === '1' || req.query.plan === 'true')) {
          const report = maybePrune(cwd, cliSessionId, { dryRun: true, force: true }) || null;
          if (report) {
            const { file: _omitted, ...plan } = report;
            body.plan = plan;
          } else {
            body.plan = null;
          }
        }
        return res.json(body);
      } catch (error) {
        logFailure('context_level_failed', error, sessionId);
        if (typeof next === 'function') return next(new Error('chat history operation failed'));
        return res.status(500).json({ error: 'context level failed' });
      }
    });

    return app;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    clearAllIncrementalSaves();
    droppedForMemory.clear();
    return true;
  }

  return Object.freeze({
    appendMessage,
    annotateTurn,
    clearAllIncrementalSaves,
    clearHistory,
    clearIncrementalSave,
    hasIncrementalSave: sessionId => incrementalSaveTimers.has(String(sessionId)),
    lastActivity,
    latestAssistantAt,
    load,
    viewHistory,
    mountRoutes,
    paginate,
    rotateNativeContext,
    scheduleIncrementalSave,
    service,
    stop,
  });
}

module.exports = {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HISTORY_PAGE_SIZE,
  DEFAULT_INCREMENTAL_SAVE_DELAY_MS,
  DEFAULT_MEMORY_DISTILL_BATCH,
  createChatHistoryRuntime,
  buildReplayMessages,
  publicCommittedMessage,
};

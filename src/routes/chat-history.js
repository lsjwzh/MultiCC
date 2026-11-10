'use strict';

// 历史宿主运行时的同步核心（可见性缓存、蒸馏批次、增量保存定时器、追加/分页/
// 标注）已全部归 Rust 的 `RustChatHistoryRuntime`。本文件只剩三件事：
//   1. 依赖校验与常量（保持对外形状和报错文案）；
//   2. 运行时的构造接线（把既有服务所有者、端口和惰性路由依赖传进去）；
//   3. 仍必须留在 Node 的异步/流程代码：clearHistory 的 await 顺序、
//      原生上下文轮换的 handoff 事务、Express 路由与 context-level 读取。
// 这里不复制历史状态：服务（RustChatHistory）和运行时共用同一个原生实例。

const crypto = require('node:crypto');
const { createChatHistoryServiceWithOwner } = require('../session/chat-history-service');
const { sanitizePublicText } = require('../http/public-safety');
const { getNative } = require('../native/runtime');

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
  // saveBestEffort / trackPendingMemoryDistill 从未被运行时使用；它们仍是
  // 其他运行时的依赖，但不再属于本运行时的必需注入。
  for (const name of [
    'idFactory',
    'chatBroadcast',
    'distillHistoryIntoMemory',
    'maybeSchedulePeriodicMemoryReview',
    'cliSwitchGitSnapshot',
    'clearAllNativeCliStates',
    'buildHandoffCheckpoint',
    'rememberActiveCliState',
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
  if (deps.taskShortCode != null && typeof deps.taskShortCode !== 'function') {
    throw new TypeError('chat history dependency invalid: taskShortCode');
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

// 投影规则在 Rust 中只有一份；这里的导出保持既有名字与调用形状。
function publicCommittedMessage(message) {
  return getNative().chatHistoryPublicCommittedMessage(message);
}

function buildReplayMessages(pageMessages, state, now = Date.now) {
  return getNative().chatHistoryBuildReplayMessages(pageMessages, state, now);
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
  // Lazy: the OpenCode SQLite reader is only constructed when an opencode
  // session actually asks for its context water level.
  let opencodeContextReader = null;

  let runtime = null;
  let runtimeAnchor = null;

  // postPersist 仍是 JS 端口：RustChatHistory 的外部契约就是调用
  // `ports.postPersist`，这里只把事件原样交给运行时所有者。
  function handleCommittedHistoryEvent(event) {
    runtime.run(runtimeAnchor, 'handleCommittedHistoryEvent', [event]);
  }

  function onPostPersistError(error, event) {
    runtime.run(runtimeAnchor, 'postPersistError', [error, event]);
  }

  // 历史服务只构造一次；运行时通过它的 `run` 派发，绝不复制服务缓存。
  const { service, owner: serviceOwner, anchor: serviceAnchor } = createChatHistoryServiceWithOwner({
    history: deps.history,
    idFactory: deps.idFactory,
    clock: now,
    maxMessages: positiveInteger(deps.maxMessages, DEFAULT_HISTORY_LIMIT),
    retentionPolicy: typeof deps.retentionPolicy === 'function' ? deps.retentionPolicy : null,
    canDeleteSession: deps.canDeleteSession,
    isMessageProtected: deps.isMessageProtected,
    referencingTasks: deps.referencingTasks,
    postPersist: handleCommittedHistoryEvent,
    onPostPersistError,
  });

  function run(method, ...args) {
    return runtime.run(runtimeAnchor, method, args);
  }

  // 零参回调由 Rust 用 `fn.bind(null, ...)` 生成；这些函数只做一次转发，
  // 让定时器与 Promise 拒绝处理重新进入同一个所有者。
  function runIncrementalSave(sessionId, state) {
    run('incrementalSaveTick', sessionId, state);
  }
  function runPeriodicReview(sessionId) {
    run('runPeriodicReview', sessionId);
  }
  function runDistillFailure(sessionId, error) {
    run('distillFailed', sessionId, error);
  }
  function afterCommitTick(state, at) {
    run('lastActivityCommit', state, at);
  }
  function logFailure(event, error, sessionId) {
    run('logFailure', event, error, sessionId);
  }

  runtimeAnchor = {
    ports: {
      history: deps.history,
      service: serviceOwner,
      serviceAnchor,
      chatSessions: deps.chatSessions,
      idFactory: deps.idFactory,
      clock: now,
      chatBroadcast: deps.chatBroadcast,
      distillHistoryIntoMemory: deps.distillHistoryIntoMemory,
      maybeSchedulePeriodicMemoryReview: deps.maybeSchedulePeriodicMemoryReview,
      auxSessionId: deps.auxSessionId,
      taskShortCode: typeof deps.taskShortCode === 'function' ? deps.taskShortCode : null,
      projectMessages: typeof deps.projectMessages === 'function' ? deps.projectMessages : null,
      retentionPolicy: typeof deps.retentionPolicy === 'function' ? deps.retentionPolicy : null,
      maxMessages: deps.maxMessages,
      historyPageSize,
      memoryDistillBatch,
      incrementalSaveDelayMs,
      logger,
      sanitizePublicText,
      setImmediate: scheduleImmediate,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      runIncrementalSave,
      runPeriodicReview,
      runDistillFailure,
      afterCommitTick,
    },
  };
  runtime = new (getNative().RustChatHistoryRuntime)(runtimeAnchor);

  function load(sessionId) {
    return run('load', sessionId);
  }

  function viewHistory(sessionId) {
    return run('viewHistory', sessionId);
  }

  function projectedMessages(sessionId, includeHidden = false) {
    return run('projectedMessages', sessionId, includeHidden);
  }

  function paginate(sessionId, options = {}) {
    return run('paginate', sessionId, options);
  }

  function hideMessages(sessionId, ids, options = {}) {
    return run('hideMessages', sessionId, ids, options);
  }

  function latestAssistantAt(sessionId) {
    return run('latestAssistantAt', sessionId);
  }

  function lastActivity(sessionId, activeChat) {
    return run('lastActivity', sessionId, activeChat);
  }

  const appendQueues = new Map();
  async function appendOne(sessionId, message) {
    const prepared = run('prepareAppendMessage', sessionId, message);
    if (!prepared) return false;
    try {
      if (typeof deps.history.writeAsync === 'function') {
        await deps.history.writeAsync(sessionId, prepared.messagesJson);
      } else {
        // Injected legacy ports still expose only the synchronous write. The
        // production file repository always takes the Promise branch above.
        deps.history.write(sessionId, prepared.messages);
      }
      return run('commitAppendMessage', prepared.operationId);
    } catch (error) {
      try { run('discardAppendMessage', sessionId, prepared.operationId, error); } catch (_) {}
      return false;
    }
  }
  function appendMessage(sessionId, message) {
    const id = String(sessionId);
    const previous = appendQueues.get(id) || Promise.resolve();
    // History mutations for one session are ordered in the adapter. Rust owns
    // the message rules, durable write, cache publication, callbacks and ACK;
    // this queue only prevents two async filesystem replacements from racing.
    const current = previous.catch(() => {}).then(() => appendOne(sessionId, message));
    appendQueues.set(id, current);
    const clear = () => { if (appendQueues.get(id) === current) appendQueues.delete(id); };
    current.then(clear, clear);
    return current;
  }
  function appendMessageSync(sessionId, message) {
    // A synchronous caller cannot join the Promise queue. Letting it write
    // through the same file while an asynchronous replacement is in flight can
    // make the older worker overwrite the newer snapshot. Fail closed instead;
    // once the queue drains this compatibility door remains fully synchronous.
    if (appendQueues.has(String(sessionId))) return false;
    return run('appendMessage', sessionId, message);
  }

  function clearIncrementalSave(sessionId) {
    return run('clearIncrementalSave', sessionId);
  }

  function annotateTurn(sessionId, turnId, patch = {}, options = {}) {
    return run('annotateTurn', sessionId, turnId, patch, options);
  }

  function clearAllIncrementalSaves() {
    return run('clearAllIncrementalSaves');
  }

  function scheduleIncrementalSave(sessionId, state) {
    return run('scheduleIncrementalSave', sessionId, state);
  }

  async function clearHistoryUnsafe(sessionId, message, chatState) {
    const key = String(sessionId);
    const keep = Math.max(0, parseInt(message?.keep || '0', 10) || 0);
    // 可见性写入、持久化 id 与缓存更新都在运行时所有者内部完成。
    const result = run('clearVisibility', key, keep);
    const page = paginate(key, { limit: historyPageSize });
    deps.chatBroadcast(key, {
      type: 'chat_history_reset',
      messages: buildReplayMessages(page.messages, chatState),
      hasMore: page.hasMore,
      ...result,
      displayOnly: true,
    });
    return Object.freeze({ ...result, clearedNativeSessions: 0 });
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
        const removed = run('removeVisibility', sessionId, req.params.msgId);
        if (!removed) return res.status(404).json({ error: 'message not found' });
        deps.chatBroadcast(sessionId, { type: 'chat_msg_deleted', id: req.params.msgId, displayOnly: true });
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
          includeHidden: req.query.historyScope === 'archive',
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
    app.get('/api/sessions/:id/context-level', async (req, res, next) => {
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
          const usage = await opencodeContextReader.read(cliSessionId, persisted.model || null);
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
    return run('stop');
  }

  const api = {
    appendMessage,
    annotateTurn,
    clearAllIncrementalSaves,
    clearHistory,
    clearIncrementalSave,
    hasIncrementalSave: sessionId => run('hasIncrementalSave', sessionId),
    hideMessages,
    lastActivity,
    latestAssistantAt,
    load,
    viewHistory,
    projectedMessages,
    mountRoutes,
    paginate,
    rotateNativeContext,
    scheduleIncrementalSave,
    service,
    stop,
  };
  // The Rust chat-event reducer still requires a synchronous final-answer
  // persistence verdict. Keep that compatibility door explicit until the event
  // reducer migrates to a Promise-aware ACK.
  Object.defineProperty(api, 'appendMessageSync', {
    value: appendMessageSync,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(api);
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

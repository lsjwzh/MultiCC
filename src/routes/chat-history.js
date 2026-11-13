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
  for (const method of ['read', 'writeAsync', 'writeVisibilityAsync', 'deleteSession', 'hasPersistedDelivery']) {
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
  function runIncrementalSave(sessionId, state, generation, epoch) {
    const enqueued = run('incrementalSaveTick', sessionId, state, generation, epoch);
    if (enqueued) driveSession(String(sessionId)).catch(() => {});
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
      // 真相由服务判定，这里只提供事实（谁以何种方式引用该会话）。
      sessionDeletionFacts: deps.sessionDeletionFacts,
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

  // 标注/隐藏/删除/清空与追加走同一条按会话 FIFO：先排进 Rust 队列，再由单飞
  // 驱动器逐步落盘。返回的 Promise 在 Rust 发布缓存、产出广播之后才解决。
  function hideMessages(sessionId, ids, options = {}) {
    return mutate(sessionId, options && options.quiet ? 'removeMany' : 'hide', [ids]);
  }

  function latestAssistantAt(sessionId) {
    return run('latestAssistantAt', sessionId);
  }

  function lastActivity(sessionId, activeChat) {
    return run('lastActivity', sessionId, activeChat);
  }

  // ── 变更驱动 ──────────────────────────────────────────────────────────────
  // Rust 拥有每个会话的变更 FIFO、快照时刻、缓存发布与广播内容。这里只是单飞
  // 驱动：取下一步 → 等待落盘 → 回报成败 → 执行 Rust 给出的广播。没有第二个
  // 排序层，也不复制历史状态。
  const drivers = new Map();
  const waiters = new Map();

  function settleWaiter(sessionId, operationId, settle) {
    const pending = waiters.get(sessionId);
    if (!pending) return;
    const waiting = pending.get(operationId);
    if (!waiting) return;
    pending.delete(operationId);
    if (!pending.size) waiters.delete(sessionId);
    // Interim coalescing reuses the same operationId for several callers, so a
    // slot is a list: every caller waiting on that job settles together.
    for (const waiter of waiting) settle(waiter);
  }
  function failSession(sessionId, error) {
    const pending = waiters.get(sessionId);
    waiters.delete(sessionId);
    if (!pending) return;
    for (const waiting of pending.values()) for (const waiter of waiting) waiter.reject(error);
  }
  // Effects are already-committed broadcasts produced by Rust; running them is
  // the only part that must stay here. A throwing broadcast never unwinds a
  // mutation (the durable write already happened), it is logged with the event
  // name Rust attached, and the *first* failure is reported back so callers can
  // reproduce the legacy result shape (an annotation whose broadcast failed
  // resolves to an empty list).
  function applyEffects(sessionId, effects) {
    if (!Array.isArray(effects)) return null;
    let firstFailure = null;
    for (const effect of effects) {
      try {
        deps.chatBroadcast(sessionId, effect.payload);
      } catch (error) {
        if (!firstFailure) firstFailure = { logEvent: effect.logEvent, error };
        try { logFailure(effect.logEvent || 'chat_history_broadcast_failed', error, sessionId); } catch (_) {}
      }
    }
    return firstFailure;
  }
  async function performStep(step) {
    if (step.method === 'transcript') {
      // 字符串=整份快照；对象=尾部增量（尾巴 JSON + 字节账本）。
      if (typeof step.payload === 'string') {
        return deps.history.writeAsync(step.sessionId, step.payload);
      }
      const appended = await deps.history.appendAsync(step.sessionId, step.payload);
      if (appended && appended.conflict === true) {
        throw Object.assign(new Error('chat history changed during append'), {
          code: 'CHAT_HISTORY_CONCURRENT_MODIFICATION',
        });
      }
      if (appended && appended.appended === false) {
        // 文件消失或文件系统不支持写时复制：沿用完整快照回退。
        const resend = run('resendPendingWrite', step.operationId);
        return deps.history.writeAsync(step.sessionId, resend.messagesJson);
      }
      return appended;
    }
    if (step.method === 'visibility') {
      return deps.history.writeVisibilityAsync(step.sessionId, step.payload);
    }
    return Promise.reject(new Error(`unknown chat history write step: ${step.method}`));
  }
  function driveSession(sessionId) {
    const existing = drivers.get(sessionId);
    if (existing) return existing.loop;
    const entry = { loop: null };
    // Detach at the idle boundary in the same synchronous turn: the caller that
    // was just woken by this driver always gets a fresh driver for its own
    // mutation instead of piggybacking on one that is already leaving.
    drivers.set(sessionId, entry);
    entry.loop = (async () => {
      try {
        for (;;) {
          const step = run('nextMutationStep', sessionId);
          if (!step || step.type === 'idle') return;
          if (step.type === 'done') {
            // A committed delete cancels the unstarted jobs behind it; their
            // callers only learn the session is gone now, not at enqueue time.
            if (Array.isArray(step.cancelled)) {
              for (const operationId of step.cancelled) {
                settleWaiter(sessionId, operationId, waiter => waiter.reject(sessionDeletedError()));
              }
            }
            settleWaiter(sessionId, step.operationId, waiter => (
              step.failed === true ? waiter.reject(step.error) : waiter.resolve(step.result)
            ));
            continue;
          }
          let ok = true;
          let failure = null;
          let writeMeta = null;
          try {
            writeMeta = await performStep(step);
          } catch (error) {
            ok = false;
            failure = error;
          }
          const after = run('completeMutationStep', sessionId, step.operationId, ok, failure, writeMeta);
          if (failure?.code === 'CHAT_HISTORY_CONCURRENT_MODIFICATION') {
            // The failed snapshot was never published. Drop its stale base so
            // the next queue head reloads the external writer's committed data.
            service.invalidate(sessionId);
          }
          const effectFailure = applyEffects(sessionId, after.effects);
          if (after.finished === true) {
            settleWaiter(sessionId, step.operationId, waiter => {
              if (after.failed === true) return waiter.reject(failure || after.result);
              // 旧实现里标注与广播同处一个 try：广播抛错时整体返回空列表，
              // 写入与缓存发布仍然生效。
              if (effectFailure && effectFailure.logEvent === 'chat_history_annotation_failed') {
                return waiter.resolve([]);
              }
              return waiter.resolve(after.result);
            });
          }
        }
      } finally {
        if (drivers.get(sessionId) === entry) drivers.delete(sessionId);
      }
    })();
    entry.loop.catch(error => failSession(sessionId, error));
    return entry.loop;
  }
  function sessionDeletedError() {
    return Object.assign(new Error('chat_history_session_deleted'), {
      code: 'CHAT_HISTORY_SESSION_DELETED',
    });
  }
  function mutate(sessionId, kind, payload) {
    const id = String(sessionId);
    let enqueued;
    try {
      enqueued = run('enqueueMutation', id, kind, payload);
    } catch (error) {
      // A tombstoned session must surface the same code whether the caller
      // awaits this promise or the rejection came from a cancelled job.
      if (String(error && error.message) === 'chat_history_session_deleted') {
        return Promise.reject(sessionDeletedError());
      }
      throw error;
    }
    // 删除会丢弃尚未开始的 job：它们的 waiter 必须在这里结清，否则调用方会
    // 一直等到关停截止时间才知道这项工作已被删除取代。
    const cancelled = Array.isArray(enqueued && enqueued.cancelled) ? enqueued.cancelled : [];
    for (const operationId of cancelled) {
      settleWaiter(id, operationId, waiter => waiter.reject(sessionDeletedError()));
    }
    // 幂等的重复删除没有新 job，直接返回。
    if (enqueued.operationId === null || enqueued.operationId === undefined) {
      return Promise.resolve(true);
    }
    const { operationId } = enqueued;
    const settled = new Promise((resolve, reject) => {
      let pending = waiters.get(id);
      if (!pending) {
        pending = new Map();
        waiters.set(id, pending);
      }
      const waiting = pending.get(operationId);
      if (waiting) waiting.push({ resolve, reject });
      else pending.set(operationId, [{ resolve, reject }]);
    });
    // The driver settles this waiter; it is not the caller's scheduling layer.
    driveSession(id).catch(() => {});
    return settled;
  }
  // Shutdown: drain every driver and any queue that is still non-empty under the
  // caller's own deadline. Returns false when the deadline passes first.
  //
  // The thing to wait on is each driver's own loop Promise (re-read every round:
  // a driver deletes itself in `finally`), not the `{loop}` wrapper. A round
  // number cannot bound an fsync that never returns, so the only limit is the
  // absolute deadline the shutdown coordinator already owns.
  const DEFAULT_SETTLE_TIMEOUT_MS = 60000;
  const SETTLE_TIMEOUT = Symbol('chat-history-settle-timeout');
  async function settle(options = {}) {
    const deadline = Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + (Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : DEFAULT_SETTLE_TIMEOUT_MS);
    for (;;) {
      // A timer-driven enqueue may have raced ahead of its driver. Ask Rust for
      // the sessions that still have queued work and make sure each has one.
      for (const sessionId of run('pendingMutationSessions') || []) {
        driveSession(String(sessionId)).catch(() => {});
      }
      const pending = [];
      for (const entry of drivers.values()) {
        if (entry && entry.loop) pending.push(entry.loop);
      }
      if (pending.length) {
        const remaining = deadline - Date.now();
        if (!(remaining > 0)) return false;
        let timer = null;
        const timeout = new Promise(resolve => {
          timer = setTimeout(() => resolve(SETTLE_TIMEOUT), remaining);
        });
        let outcome;
        try {
          outcome = await Promise.race([Promise.allSettled(pending), timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (outcome === SETTLE_TIMEOUT) return false;
        continue;
      }
      if (!run('hasPendingMutations')) return true;
      const remaining = deadline - Date.now();
      if (!(remaining > 0)) return false;
      // Queued work without a driver should be impossible (the loop above kicks
      // one); yield once so a driver that is detaching in its `finally` can be
      // observed instead of spinning.
      await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)));
    }
  }

  function appendMessage(sessionId, message) {
    return mutate(sessionId, 'append', [message]);
  }

  function clearIncrementalSave(sessionId) {
    return run('clearIncrementalSave', sessionId);
  }

  function annotateTurn(sessionId, turnId, patch = {}, options = {}) {
    return mutate(sessionId, 'replace', [turnId, patch, options]);
  }

  // 整份历史替换（fork 新会话）。调用方 await 它；磁盘写入仍由仓库完成。
  function replaceHistory(sessionId, messages, options = {}) {
    return mutate(sessionId, 'replaceAll', [messages, options || {}]);
  }

  // 按 id 删除若干条消息（任务删除裁剪）：Node 只给 id 集合，当前 transcript
  // 由 Rust 在队首读取后在最新状态上过滤，不会漏掉在飞追加。
  function dropMessages(sessionId, ids, options = {}) {
    return mutate(sessionId, 'dropMessages', [ids, options || {}]);
  }

  // 上下文包合并导入：底稿 + 导入消息由 Rust 在队首基于最新状态合并。
  function mergeHistory(sessionId, messages, options = {}) {
    return mutate(sessionId, 'mergeAll', [messages, options || {}]);
  }

  // 删除会话：入队只标记“正在删除”并把删除插在在飞写入之后、未开始写入之
  // 前；删除成功才落墓碑并取消后面排队的 job，删除被拒则撤销标记、排队写入
  // 照常执行，一条都不丢。
  function removeSession(sessionId) {
    return mutate(sessionId, 'removeSession', []);
  }

  // 删除资格由 Rust 判定；这里只转发结果（false=任务历史引用）。
  function canDeleteSession(sessionId) {
    return run('canDeleteSession', String(sessionId)) === true;
  }

  // 结构化删除结论：Rust 依据 Node 提供的引用事实判定 ok / shared /
  // referenced。任务删除按 reason 行事：shared 保持会话原样，referenced
  // 中止并保持可重试。
  function deletionVerdict(sessionId) {
    return run('deletionVerdict', String(sessionId));
  }

  // 会话（重新）注册时清墓碑，固定 id 的辅助会话删除后重建才能继续写入。
  function registerSession(sessionId) {
    return run('registerSession', String(sessionId));
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
    // 清空排在同一个会话 FIFO 里：await 到可见性落盘、缓存已发布之后才分页并
    // 广播。这样既不会用旧快照覆盖更新的追加，也不会用旧缓存生成广播。
    const result = await mutate(key, 'clear', [keep]);
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

  // ── 原生上下文轮换 ────────────────────────────────────────────────────────
  // 两段式：Node 只把事实（会话是否存在、类型、待生效的手递、运行态、后台任务
  // 数、端口是否可用）交给 Rust；拒绝 / 复用 / 继续由 Rust 判定，Rust 给出要执行
  // 的副作用清单。git 快照 await 之后用同一份事实再判一次，Rust 在判定通过后
  // 才装配 handoff 与 checkpoint，避免用过期事实覆盖新一轮。
  function rotationRequest(op, input) {
    return JSON.parse(getNative().chatContextRotationRequest(op, JSON.stringify(input)));
  }

  // 只读事实快照。存在性与待生效手递先行；只有真正要继续时才读运行态端口，
  // 与旧实现的短路顺序一致。
  function rotationFacts(key) {
    const persisted = deps.persistedSessions.get(key);
    if (!persisted) {
      return {
        exists: false,
        kind: '',
        pending: null,
        rotationReady: false,
        runState: 'running',
        backgroundCount: 0,
      };
    }
    const existing = persisted.pendingCliHandoff;
    // The kind check comes before any run-state port, exactly as before.
    if (persisted.kind && persisted.kind !== 'chat') {
      return {
        exists: true,
        kind: String(persisted.kind),
        pending: null,
        rotationReady: false,
        runState: 'running',
        backgroundCount: 0,
      };
    }
    const pending = existing && existing.status === 'pending'
      ? {
        id: existing.id,
        status: 'pending',
        reason: existing.reason === undefined ? null : String(existing.reason),
      }
      : null;
    const rotationReady = typeof deps.getSessionRunState === 'function'
      && typeof deps.getActiveBackgroundTasks === 'function'
      && typeof deps.sessionPersistence?.mutate === 'function';
    let runState = 'running';
    let backgroundCount = 0;
    if (!pending && rotationReady) {
      runState = String(deps.getSessionRunState(key));
      const active = deps.getActiveBackgroundTasks(key);
      backgroundCount = Array.isArray(active) ? active.length : 0;
    }
    return {
      exists: true,
      kind: persisted.kind ? String(persisted.kind) : '',
      pending,
      rotationReady,
      runState,
      backgroundCount,
    };
  }

  // 副作用必须在 await 之后重新取记录：mutate 本身要写回同一个持久化对象。
  // `clearedNativeSessions` 只有 Node 端口知道（清理原生 CLI 状态的返回值），
  // Rust 在广播载荷里留 null 占位，这里用同一份事务结果补上。
  function applyRotationEffects(key, effects, plan) {
    if (!Array.isArray(effects)) return undefined;
    let clearedNativeSessions;
    for (const effect of effects) {
      switch (effect.type) {
        case 'broadcast': {
          const event = effect.event;
          if (event && event.type === 'native_context_rotated' && event.reused !== true) {
            event.clearedNativeSessions = clearedNativeSessions === undefined ? null : clearedNativeSessions;
          }
          deps.chatBroadcast(key, event);
          break;
        }
        case 'mutate': {
          const { persisted, handoff } = plan;
          clearedNativeSessions = deps.sessionPersistence.mutate(effect.operation, () => {
            const cleared = deps.clearAllNativeCliStates(persisted);
            persisted.pendingCliHandoff = handoff;
            deps.rememberActiveCliState(persisted);
            return cleared;
          });
          break;
        }
        case 'closeStream':
          deps.chatStream.close(key);
          break;
        case 'zeroChatTurnCount':
          if (plan.chatState) plan.chatState.chatTurnCount = 0;
          break;
        default:
          break;
      }
    }
    return clearedNativeSessions;
  }

  async function rotateNativeContextUnsafe(sessionId, chatState) {
    const key = String(sessionId);
    const before = rotationFacts(key);
    const verdict = rotationRequest('decision', before);
    applyRotationEffects(key, verdict.effects);
    if (verdict.ok !== true) {
      return Object.freeze({ ok: false, code: verdict.code });
    }
    if (verdict.reused === true) {
      return Object.freeze({
        ok: true,
        reused: true,
        checkpointId: verdict.checkpointId,
        clearedNativeSessions: 0,
      });
    }

    const persisted = deps.persistedSessions.get(key);
    const history = load(key);
    const gitSnapshot = await deps.cliSwitchGitSnapshot(persisted);
    // 快照期间可能开始新一轮、冒出别的手递或删掉会话：按同一套事实重判。
    // 快照本身只在首判通过后才发起；若重判被拒，不会装配 checkpoint、不会
    // 提交 handoff，也不会产生任何写盘或广播——这次快照是唯一的既有开销。
    const after = rotationFacts(key);
    const second = rotationRequest('decision', after);
    applyRotationEffects(key, second.effects);
    if (second.ok !== true) {
      return Object.freeze({ ok: false, code: second.code });
    }
    if (second.reused === true) {
      return Object.freeze({
        ok: true,
        reused: true,
        checkpointId: second.checkpointId,
        clearedNativeSessions: 0,
      });
    }
    const cli = (chatState && chatState.cli) || persisted.cli;
    const checkpoint = deps.buildHandoffCheckpoint({
      session: persisted,
      fromCli: cli,
      toCli: cli,
      history,
      git: gitSnapshot,
    });
    const committed = rotationRequest('commit', {
      ...after,
      cli: cli == null ? '' : String(cli),
      checkpoint,
      randomHex: randomBytes(8).toString('hex'),
    });
    if (committed.ok !== true) {
      applyRotationEffects(key, committed.effects);
      return Object.freeze({ ok: false, code: committed.code });
    }
    if (committed.reused === true) {
      applyRotationEffects(key, committed.effects);
      return Object.freeze({
        ok: true,
        reused: true,
        checkpointId: committed.checkpointId,
        clearedNativeSessions: 0,
      });
    }
    const clearedNativeSessions = applyRotationEffects(key, committed.effects, {
      persisted,
      handoff: committed.handoff,
      chatState,
    });
    return Object.freeze({
      ok: true,
      reused: false,
      checkpointId: committed.checkpointId,
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
    // 删除与追加/清空共用同一条会话 FIFO；只有落盘并发布缓存之后才广播，
    // 因此客户端看到的顺序与磁盘一致。
    app.delete('/api/sessions/:id/messages/:msgId', async (req, res, next) => {
      const sessionId = req.params.id;
      if (!deps.persistedSessions.get(sessionId)) {
        return res.status(404).json({ error: 'session not found' });
      }
      try {
        const removed = await mutate(sessionId, 'remove', [req.params.msgId]);
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
    canDeleteSession,
    deletionVerdict,
    dropMessages,
    mergeHistory,
    registerSession,
    removeSession,
    replaceHistory,
    rotateNativeContext,
    scheduleIncrementalSave,
    service,
    settle,
    stop,
  };
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

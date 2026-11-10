'use strict';

// ── Host process lifecycle: graceful shutdown + service timers ──
// Extracted from server.js. This owns the shutdown coordinator, the set of
// tracked service timers, and the SIGINT/SIGTERM handlers. Everything it touches
// is a host runtime injected via `deps`; nothing here is read at construction
// time except the coordinator itself — all runtime access happens inside the
// coordinator callbacks (checkpoint/drain/close) and the named helpers, which
// only run during shutdown. Two host `let` bindings the moved code mutates
// (`_shuttingDown`, `serviceReady`) stay in server.js because many other
// readers consult them; the module receives accessors instead of the raw refs.
const { createShutdownCoordinator } = require('./shutdown');

const SHUTDOWN_GRACE_MS = 60000;   // max time to let in-flight turns finish
// A shutdown partial checkpoint writes every unsaved turn to disk. Those writes
// are now durable fsyncs, so they are awaited — but only within this cap, so a
// wedged filesystem can never hang shutdown forever.
const PARTIAL_FLUSH_TIMEOUT_MS = 10000;

function createHostLifecycle(deps) {
  // The CLI lane table is a dependency-free leaf, but this module's require set is
  // deliberately pinned by tests/test-host-lifecycle-task-run-close.js, so the
  // predicate arrives as a port like every other runtime here.
  if (typeof deps?.isResidentSession !== 'function') throw new TypeError('[host-lifecycle] isResidentSession port is required');
  const {
    isResidentSession,
    // Host state accessors (server.js keeps the source of truth).
    getShuttingDown,
    setShuttingDown,
    setServiceReady,
    getChatHistoryRuntime,
    getOrchestrationRuntime,
    // Session/turn state.
    chatSessions,
    sessions,
    auxQueue,
    appendChatMessage,
    isCurrentTurnRunner,
    recordPartialCheckpoint,
    assistantCheckpointKey,
    savePersistedSessionsBestEffort,
    // Work sources quiesced before drain.
    waitInjector,
    cronTasks,
    tunnel,
    skillSyncRuntime,
    triggerRuntime,
    pushRuntime,
    lanDiscovery,
    // Messaging bridges.
    wechatBridge,
    feishuBridge,
    telegramBridge,
    discordBridge,
    slackBridge,
    // Network + session runtimes closed during shutdown.
    wss,
    server,
    turnProgressHeartbeat,
    backgroundTaskRuntime,
    cancelClassify,
    assignKillReason,
    finishProviderAttempt,
    chatStream,
    cleanupPushMonitor,
    stopOutputCapture,
    routerToolHost,
    sessionPersistence,
    qwenAudioSupervisor,
    sessionHibernationRuntime,
    log = console,
  } = deps;
  if (typeof finishProviderAttempt !== 'function') {
    throw new TypeError('[host-lifecycle] finishProviderAttempt is required');
  }
  // Tests inject a small cap; production keeps the fixed shutdown budget.
  const partialFlushTimeoutMs = Number.isFinite(deps.chatFlushTimeoutMs)
    ? deps.chatFlushTimeoutMs
    : PARTIAL_FLUSH_TIMEOUT_MS;

  // Graceful shutdown checkpoints partial turns, drains, then closes dependencies.
  // `deadline`/`timeoutMs` come from the shutdown coordinator's shared total
  // budget: the write wait is the smaller of its own 10s cap and what is left.
  async function flushInFlightChats({ deadline = null, timeoutMs = partialFlushTimeoutMs } = {}) {
    // Prevent a delayed interim write from landing after the shutdown partial
    // checkpoint and recreating a trailing duplicate message.
    const chatHistoryRuntime = getChatHistoryRuntime();
    if (chatHistoryRuntime) chatHistoryRuntime.clearAllIncrementalSaves();
    const writes = [];
    for (const [name, cs] of chatSessions) {
      if (!cs || cs._resultSaved) continue;
      const hasText = !!(cs.currentAssistantText && cs.currentAssistantText.length);
      const hasTools = !!(cs.currentToolCalls && cs.currentToolCalls.length);
      if (!hasText && !hasTools) continue;
      const turn = cs._activeTurn;
      const runner = cs._activeRunner;
      let pending;
      try {
        pending = appendChatMessage(name, {
          role: 'assistant',
          content: cs.currentAssistantText || '',
          tools: hasTools ? cs.currentToolCalls : undefined,
          cost: cs.currentCost,
          ts: Date.now(),
          partial: true,   // saved mid-turn on shutdown; may be incomplete
        });
      } catch (_) {
        continue;
      }
      writes.push(Promise.resolve(pending).then(saved => {
        if (!saved) return false;
        if (turn && runner && isCurrentTurnRunner(cs, turn, runner)) {
          recordPartialCheckpoint(turn, runner, {
            current: true, persisted: true, checkpointKey: assistantCheckpointKey(cs),
          });
        }
        cs._resultSaved = true;
        return true;
      }, () => false));
    }
    if (writes.length === 0) return 0;
    // Bound the wait. The overall drain gets its own grace window, but an fsync
    // that never returns must not wedge shutdown — and it must never push the
    // total past the coordinator's deadline.
    const budget = Math.min(
      partialFlushTimeoutMs,
      Number.isFinite(timeoutMs) ? timeoutMs : partialFlushTimeoutMs,
      deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now(),
    );
    if (!(budget > 0)) {
      log.warn?.('[multicc] shutdown partial flush skipped: no time left in the total budget');
      return 0;
    }
    let timer = null;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); });
    const settled = await Promise.race([Promise.allSettled(writes), timeout]);
    if (timer) clearTimeout(timer);
    if (settled === 'timeout') {
      log.warn?.(`[multicc] shutdown partial flush exceeded ${Math.round(budget)}ms — some writes may not have landed`);
      return 0;
    }
    let n = 0;
    for (const result of settled) if (result.status === 'fulfilled' && result.value === true) n += 1;
    return n;
  }

  const shutdownCoordinator = createShutdownCoordinator({ logger: log });
  const serviceTimers = new Set();

  function trackServiceTimer(timer) {
    if (!timer) return timer;
    serviceTimers.add(timer);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function clearServiceTimers() {
    for (const timer of serviceTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    serviceTimers.clear();
  }

  async function quiesceRuntimeSources() {
    setServiceReady(false);
    try { waitInjector.stop(); } catch (_) {}
    try { cronTasks.stop(); } catch (_) {}
    try { tunnel.stop(); } catch (_) {}
    try { await skillSyncRuntime.stop(); } catch (_) {}
    try { await triggerRuntime.stop(); } catch (_) {}
    try { await sessionHibernationRuntime?.stop?.(); } catch (_) {}
    try { pushRuntime.stop(); } catch (_) {}
    try { await lanDiscovery?.stop?.(); } catch (_) {}
    const chatHistoryRuntime = getChatHistoryRuntime();
    try { if (chatHistoryRuntime) chatHistoryRuntime.stop(); } catch (_) {}
    clearServiceTimers();
  }

  async function stopBridgeRuntime() {
    const bridges = [wechatBridge, feishuBridge, telegramBridge, discordBridge, slackBridge];
    await Promise.allSettled(bridges.map(bridge => {
      if (!bridge || typeof bridge.stopBridge !== 'function') return undefined;
      return bridge.stopBridge();
    }));
  }

  function closeWebSocketRuntime() {
    return new Promise(resolve => {
      try {
        for (const client of wss.clients) {
          try { client.close(1012, 'server restarting'); } catch (_) {}
          try { client.terminate(); } catch (_) {}
        }
        wss.close(() => resolve());
        const fallback = setTimeout(resolve, 1000);
        if (fallback.unref) fallback.unref();
      } catch (_) { resolve(); }
    });
  }

  async function closeSessionRuntime() {
    turnProgressHeartbeat.stopAll();
    for (const [name, cs] of chatSessions) {
      try { cancelClassify(cs); } catch (_) {}
      if (cs) assignKillReason(cs._activeRunner, 'shutdown');
      if (cs?._activeRunner?.providerAttempt) {
        try {
          finishProviderAttempt(cs._activeRunner.providerAttempt, {
            outcome: 'failed', errorCategory: 'cancelled', reasonCode: 'shutdown',
          });
        } catch (_) {}
      }
      try { backgroundTaskRuntime.reapSessionShadows(name, { reason: 'shutdown' }); } catch (_) {}
      try { chatStream.close(name); } catch (_) {}
      if (cs && cs.claudeProc) {
        try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
        cs.claudeProc = null;
      }
      if (cs && cs.clients) cs.clients.clear();
    }
    // Reaping consumes live shadows first; stopAll then clears correlation
    // state and any orphan session not represented in chatSessions.
    backgroundTaskRuntime.stopAll();

    const captures = [];
    for (const [id, session] of sessions) {
      sessions.delete(id); // prevents onStreamEnd from re-opening the FIFO
      if (session.captureTimer) clearInterval(session.captureTimer);
      if (session.exitCheckTimer) clearInterval(session.exitCheckTimer);
      if (session._statusIdleTimer) clearTimeout(session._statusIdleTimer);
      try { cleanupPushMonitor(id); } catch (_) {}
      captures.push(Promise.resolve(stopOutputCapture(session)).catch(() => {}));
    }
    await Promise.allSettled(captures);
  }

  function stopAuxQueue() {
    const error = Object.assign(new Error('server is shutting down'), { code: 'SERVER_SHUTTING_DOWN' });
    for (const task of auxQueue.queue.splice(0)) {
      task.cancelled = true;
      try { task.reject(error); } catch (_) {}
    }
    // 并发池：每一个在跑的槽都要标脏，不能只标第一个（旧的 currentTask 语义）。
    // `|| []` 保持对测试替身（只给 queue/currentTask 的对象）的兼容。
    for (const task of auxQueue.running || []) task.cancelled = true;
    if (auxQueue.currentTask) auxQueue.currentTask.cancelled = true;
  }

  // Bridge legacy _shuttingDown flag callers still consult (e.g. the restart
  // endpoint) to the coordinator's readiness bit. They stay wire-compatible.
  Object.defineProperty(global, '_shuttingDownCoordinated', {
    get: () => shutdownCoordinator.isShuttingDown(),
  });

  // Checkpoint FIRST: partial-in-memory-only state → disk. The flush now awaits
  // its durable writes (bounded by PARTIAL_FLUSH_TIMEOUT_MS).
  shutdownCoordinator.onCheckpoint(async () => {
    try { await flushInFlightChats(); }
    catch (e) { log.error(`[multicc] shutdown flush error: ${e.message}`); }
    // Teardown is explicitly best-effort: make one final attempt to flush any
    // dirty runtime session snapshot, but never turn a transient EIO into an
    // uncaught shutdown failure.
    savePersistedSessionsBestEffort('teardown.checkpoint');
  });
  // Stop every source of NEW work before drain. Existing turns are left alive and
  // may still complete naturally during the grace window.
  shutdownCoordinator.onCheckpoint(() => quiesceRuntimeSources());

  // Drain: give live turns time to reach their natural `result` event so their
  // FULL assistant message is persisted (not a half-written partial). Two kinds
  // of in-flight turn:
  //   • legacy per-turn child proc — alive until proc 'close' nulls cs.claudeProc
  //     after the result is saved.
  //   • streaming turn — NO per-turn child; it runs on the persistent chatStream
  //     process and its liveness is chatStream.status(name).busy (not cs.claudeProc).
  shutdownCoordinator.onDrain(async ({ graceMs }) => {
    const isStreamingBusy = (name, cs) => cs && isResidentSession(cs.cli, cs) && !!chatStream.status(name)?.busy;
    const draining = new Set();
    for (const [name, cs] of chatSessions) {
      if (cs && (cs.claudeProc || isStreamingBusy(name, cs))) draining.add(name);
    }
    const auxBusy = () => !!(auxQueue.processing || auxQueue.queue.length);
    if (draining.size === 0 && !auxBusy()) return;
    log.log(`[multicc] shutdown → draining ${draining.size} chat turn(s)${auxBusy() ? ' + aux queue' : ''} (grace ${graceMs}ms)`);
    const t0 = Date.now();
    await new Promise(resolve => {
      const timer = setInterval(() => {
        for (const name of [...draining]) {
          const cs = chatSessions.get(name);
          if (!cs || (!cs.claudeProc && !isStreamingBusy(name, cs))) draining.delete(name);
        }
        if (draining.size === 0 && !auxBusy()) { clearInterval(timer); resolve(); }
        else if (Date.now() - t0 > graceMs) { clearInterval(timer); resolve(); }
      }, 300);
    });
  });

  // Second checkpoint pass: any turns that hadn't reached `result` by the end of
  // the drain get their partial saved so restart still shows what the agent had
  // streamed. It runs inside the same total deadline as the drain and closers.
  shutdownCoordinator.onFinalFlush(async ({ deadline, timeoutMs }) => {
    try {
      const n = await flushInFlightChats({ deadline, timeoutMs });
      if (n) log.log(`[multicc] shutdown flushed ${n} partial message(s) after drain`);
    } catch (e) { log.error(`[multicc] post-drain flush error: ${e.message}`); }
  });

  // Closers: HTTP server first (stop accepting new turns) → chokidar watchers
  // (below where they are created, they call shutdownCoordinator.onClose(fn)).
  // Wired here for the HTTP server itself.
  shutdownCoordinator.onClose(() => new Promise(resolve => {
    try {
      if (server && server.listening) {
        server.close(() => resolve());
        // If close() doesn't finish in 2s (long-poll clients hanging on), don't
        // block PM2's kill_timeout — hard-close remaining sockets.
        setTimeout(() => { try { server.closeAllConnections?.(); } catch (_) {} resolve(); }, 2000).unref();
      } else {
        resolve();
      }
    } catch (_) { resolve(); }
  }));

  shutdownCoordinator.onClose(() => stopBridgeRuntime());
  shutdownCoordinator.onClose(() => qwenAudioSupervisor?.stopAll?.());
  shutdownCoordinator.onClose(() => closeWebSocketRuntime());
  shutdownCoordinator.onClose(async () => {
    stopAuxQueue();
    await closeSessionRuntime();
  });

  shutdownCoordinator.onClose(() => {
    routerToolHost.clear();
    const orchestrationRuntime = getOrchestrationRuntime();
    if (!orchestrationRuntime) return undefined;
    return typeof orchestrationRuntime.dispose === 'function'
      ? orchestrationRuntime.dispose()
      : orchestrationRuntime.stop();
  });
  shutdownCoordinator.onClose(() => sessionPersistence.stop());

  function gracefulShutdown(sig) {
    if (getShuttingDown()) return;
    setShuttingDown(true);
    shutdownCoordinator.shutdown({ reason: sig, graceMs: SHUTDOWN_GRACE_MS, exitCode: 0 })
      .catch(e => { log.error(`[multicc] shutdown driver error: ${e && e.message}`); process.exit(1); });
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return { shutdownCoordinator, trackServiceTimer, gracefulShutdown };
}

module.exports = { createHostLifecycle, SHUTDOWN_GRACE_MS };

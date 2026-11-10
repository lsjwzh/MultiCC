'use strict';
// ShutdownCoordinator — one place to hang graceful-shutdown wiring off.
//
// Before this module, server.js handled SIGINT/SIGTERM by:
//   • flipping a `_shuttingDown` flag,
//   • ignoring SIGTERM (!),
//   • draining in-flight chat turns,
//   • flushing partial assistant text,
//   • calling process.exit(0).
//
// That skipped a bunch of things a real shutdown needs to do — closing HTTP
// listeners, WS connections, chokidar watchers, timers, child processes — and
// couldn't be tested because the exit was hard-coded.
//
// This coordinator:
//   • runs on both SIGINT and SIGTERM (PM2 sends SIGINT itself by default;
//     kill_timeout in ecosystem.config.js is expected to exceed the grace),
//   • flips a readiness flag first so a health probe can steer traffic away,
//   • immediately checkpoints partial state via a caller-supplied hook,
//   • drains in-flight work via caller-supplied hook (with grace timeout),
//   • closes an ordered list of resources (HTTP → WS → watchers → timers → children),
//   • is fully injectable for tests — no process.exit unless `exit` is passed.
//
// Ordering matters. HTTP close first so no new turns land while we drain; then
// WS so open clients get a `close` frame; then watchers/timers/children which
// might otherwise keep the event loop alive.

const DEFAULT_GRACE_MS = 60_000;
// PM2 sends SIGKILL at `kill_timeout` (ecosystem.config.js: 75s). Checkpoint
// flush, drain, post-drain flush and closers all draw from ONE total deadline
// so their individual caps cannot add up past it. 70s leaves 5s for the process
// to exit; the drain cannot spend the last 15s reserved for the final flush and
// the closers.
const DEFAULT_TOTAL_BUDGET_MS = 70_000;
const FINAL_FLUSH_RESERVE_MS = 10_000;
const CLOSER_RESERVE_MS = 5_000;

function createShutdownCoordinator({
  logger = console,
  now = () => Date.now(),
  exit = null,          // (code) => void; omit to skip process.exit — for tests
  process: proc = process,
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  finalFlushReserveMs = FINAL_FLUSH_RESERVE_MS,
  closerReserveMs = CLOSER_RESERVE_MS,
} = {}) {
  const state = {
    ready: true,
    started: false,
    finished: false,
    checkpoints: [],
    drains: [],
    finalFlushes: [],
    closers: [],
    totalBudgetMs,
    finalFlushReserveMs,
    closerReserveMs,
  };

  // Public: HTTP readiness probe hook. Return `!coordinator.ready()` to steer
  // traffic away as soon as shutdown starts, before drain even begins.
  function ready() { return state.ready; }
  function isShuttingDown() { return state.started; }

  // Register a synchronous checkpoint. Runs FIRST, immediately after readiness
  // flips to false. Meant for "flush whatever partial in-memory state exists so
  // even a hard kill in the next 10 ms doesn't lose it".
  //
  //   coordinator.onCheckpoint(() => flushInFlightChats())
  function onCheckpoint(fn) {
    if (typeof fn !== 'function') throw new TypeError('onCheckpoint requires a function');
    state.checkpoints.push(fn);
  }

  // Register a drain phase. Given the deadline, return a Promise that resolves
  // when in-flight work is complete (or rejects to abort drain — coordinator
  // still moves on to close). Multiple drains run in parallel.
  //
  //   coordinator.onDrain(({ deadline }) => waitForTurns(deadline))
  function onDrain(fn) {
    if (typeof fn !== 'function') throw new TypeError('onDrain requires a function');
    state.drains.push(fn);
  }

  // Register a post-drain flush. Runs after the drain window and before the
  // closers, inside the same total shutdown deadline. This is where a last
  // partial assistant write gets one bounded chance to land.
  //
  //   coordinator.onFinalFlush(({ deadline, timeoutMs }) => flushInFlightChats())
  function onFinalFlush(fn) {
    if (typeof fn !== 'function') throw new TypeError('onFinalFlush requires a function');
    state.finalFlushes.push(fn);
  }

  // Register a closer. Called during the "shut things down" phase, in the order
  // they were registered. Each may return a Promise; failures are logged but
  // don't stop the sequence.
  //
  //   coordinator.onClose(() => new Promise(r => httpServer.close(r)))
  function onClose(fn) {
    if (typeof fn !== 'function') throw new TypeError('onClose requires a function');
    state.closers.push(fn);
  }

  async function runCheckpoints() {
    for (const fn of state.checkpoints) {
      try { await fn(); }
      catch (e) { logger.error(`[shutdown] checkpoint error: ${e && e.message}`); }
    }
  }

  function remaining(deadline) { return Math.max(0, deadline - now()); }

  // Race a phase against the remaining total budget. Timed-out work is NOT
  // cancelled (a durable fsync cannot be aborted); the phase is simply
  // abandoned so the closers and process exit still fit under kill_timeout.
  async function withinBudget(work, ms, label) {
    if (!(ms > 0)) {
      logger.warn(`[shutdown] ${label} skipped: no time left in the total budget`);
      return 'expired';
    }
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), ms);
      // Deliberately not unref'd: a hung phase must still wake us so the
      // closers run and the process exits instead of sitting forever.
    });
    const result = await Promise.race([work.then(() => 'done'), timeout]);
    if (timer) clearTimeout(timer);
    if (result === 'timeout') logger.warn(`[shutdown] ${label} exceeded ${Math.round(ms)}ms — moving on`);
    return result;
  }

  async function runDrains(graceMs, deadline) {
    if (state.drains.length === 0) return;
    // Leave the final flush and the closers their reserves; the drain gets at
    // most its configured grace window and never more than what is left.
    const budget = remaining(deadline) - state.finalFlushReserveMs - state.closerReserveMs;
    const waitMs = Math.max(0, Math.min(graceMs, budget));
    if (waitMs <= 0) {
      logger.warn('[shutdown] drain skipped: no time left in the total budget');
      return;
    }
    const drainDeadline = now() + waitMs;
    let timeoutHandle = null;
    const drainPromise = Promise.allSettled(state.drains.map(fn => {
      try { return Promise.resolve(fn({ deadline: drainDeadline, graceMs: waitMs, totalDeadline: deadline })); }
      catch (e) { return Promise.reject(e); }
    }));
    const timeoutPromise = new Promise(resolve => {
      timeoutHandle = setTimeout(() => resolve('timeout'), waitMs);
      // DO NOT unref this timer. If we do, and a drain hooks a promise that
      // never resolves (deliberately, e.g. a chat stream that got stuck), the
      // event loop exits before the timeout fires and the coordinator sits
      // there forever without running closers or calling exit.
    });
    const which = await Promise.race([drainPromise.then(() => 'drained'), timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (which === 'timeout') logger.warn(`[shutdown] drain grace ${waitMs}ms exceeded — moving on`);
  }

  async function runFinalFlushes(deadline) {
    if (state.finalFlushes.length === 0) return;
    const budget = remaining(deadline) - state.closerReserveMs;
    await withinBudget((async () => {
      for (const fn of state.finalFlushes) {
        try { await fn({ deadline: now() + Math.max(0, budget), timeoutMs: Math.max(0, budget), totalDeadline: deadline }); }
        catch (e) { logger.error(`[shutdown] final flush error: ${e && e.message}`); }
      }
    })(), budget, 'final flush');
  }

  async function runClosers() {
    for (const fn of state.closers) {
      try { await fn(); }
      catch (e) { logger.error(`[shutdown] closer error: ${e && e.message}`); }
    }
  }

  // The main shutdown driver. Idempotent — a second SIGINT during shutdown is
  // ignored (users often mash Ctrl+C; PM2 also occasionally double-signals).
  async function shutdown({
    reason = 'unknown', graceMs = DEFAULT_GRACE_MS, exitCode = 0, budgetMs = state.totalBudgetMs,
  } = {}) {
    if (state.started) return;
    state.started = true;
    state.ready = false;
    // Every phase below is measured against this one deadline.
    const deadline = now() + (Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : state.totalBudgetMs);
    logger.log(`[shutdown] starting (${reason}); grace ${graceMs}ms, total budget ${Math.round(remaining(deadline))}ms`);

    await withinBudget(
      runCheckpoints(),
      remaining(deadline) - state.finalFlushReserveMs - state.closerReserveMs,
      'checkpoints',
    );
    await runDrains(graceMs, deadline);
    await runFinalFlushes(deadline);
    await withinBudget(runClosers(), remaining(deadline), 'closers');

    state.finished = true;
    logger.log(`[shutdown] done (${reason})`);
    if (exit) exit(exitCode);
    else if (proc && typeof proc.exit === 'function') proc.exit(exitCode);
  }

  // Wire the coordinator into signals. Called by server.js at bootstrap time.
  // For tests, don't call this — invoke shutdown() directly.
  function installSignalHandlers({ signals = ['SIGINT', 'SIGTERM'], graceMs } = {}) {
    for (const sig of signals) {
      proc.on(sig, () => {
        shutdown({ reason: sig, graceMs }).catch(e => {
          logger.error(`[shutdown] driver error: ${e && e.message}`);
          if (exit) exit(1);
          else proc.exit(1);
        });
      });
    }
  }

  return {
    ready,
    isShuttingDown,
    onCheckpoint,
    onDrain,
    onFinalFlush,
    onClose,
    shutdown,
    installSignalHandlers,
  };
}

module.exports = {
  createShutdownCoordinator, DEFAULT_GRACE_MS, DEFAULT_TOTAL_BUDGET_MS,
  FINAL_FLUSH_RESERVE_MS, CLOSER_RESERVE_MS,
};

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

function createShutdownCoordinator({
  logger = console,
  now = () => Date.now(),
  exit = null,          // (code) => void; omit to skip process.exit — for tests
  process: proc = process,
} = {}) {
  const state = {
    ready: true,
    started: false,
    finished: false,
    checkpoints: [],
    drains: [],
    closers: [],
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

  async function runDrains(graceMs) {
    if (state.drains.length === 0) return;
    const deadline = now() + graceMs;
    const timers = [];
    const drainPromise = Promise.allSettled(state.drains.map(fn => {
      try { return Promise.resolve(fn({ deadline, graceMs })); }
      catch (e) { return Promise.reject(e); }
    }));
    const timeoutPromise = new Promise(resolve => {
      const t = setTimeout(() => resolve('timeout'), graceMs);
      // Don't keep the event loop alive on its own — if drains finish first
      // this timer is unref'd out.
      if (t.unref) t.unref();
      timers.push(t);
    });
    const which = await Promise.race([drainPromise.then(() => 'drained'), timeoutPromise]);
    for (const t of timers) clearTimeout(t);
    if (which === 'timeout') logger.warn(`[shutdown] drain grace ${graceMs}ms exceeded — moving on`);
  }

  async function runClosers() {
    for (const fn of state.closers) {
      try { await fn(); }
      catch (e) { logger.error(`[shutdown] closer error: ${e && e.message}`); }
    }
  }

  // The main shutdown driver. Idempotent — a second SIGINT during shutdown is
  // ignored (users often mash Ctrl+C; PM2 also occasionally double-signals).
  async function shutdown({ reason = 'unknown', graceMs = DEFAULT_GRACE_MS, exitCode = 0 } = {}) {
    if (state.started) return;
    state.started = true;
    state.ready = false;
    logger.log(`[shutdown] starting (${reason}); grace ${graceMs}ms`);

    await runCheckpoints();
    await runDrains(graceMs);
    await runClosers();

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
    onClose,
    shutdown,
    installSignalHandlers,
  };
}

module.exports = { createShutdownCoordinator, DEFAULT_GRACE_MS };

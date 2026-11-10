'use strict';

// Background hold — JavaScript facade.
//
// The state machine lives in native/addon/src/background_hold.rs over
// multicc_core::background_hold. This file only supplies the host facts the
// kernel cannot know (`isMainResult` from the CLI adapter, `hasBackground` from
// the background-task runtime), arms one unref'd interval and the cap timer, and
// forwards the released event to the caller's `release` port. No bookkeeping
// state may return here — Node is frozen.
//
// A resident Claude turn ends at the CLI's main `result`, but background work it
// started (Agent, run_in_background Bash, Monitor) completes later and the CLI
// wakes itself with a <task-notification> query. Holding the host turn open
// until that work is done lets those queries run inside the turn (admitted
// provider route, live stream consumer) instead of being re-queued as a
// separate 🔇 turn.
//
// Background work is part of the turn: the turn ends when that work ends (or the
// user cancels). The cap (`MULTICC_BACKGROUND_HOLD_MAX_MS`) is no longer a
// release trigger — it only makes the host say out loud that a turn has been
// held longer than expected, so a never-ending task cannot keep the turn open
// silently.

const { isMainResult } = require('../cli-adapters/result-completion');
const { getNative } = require('../native/runtime');

const QUIET_MS = 5000;
const TICK_MS = 1000;

function holdMaxMs(env = process.env) {
  return getNative().backgroundHoldMaxMs(env.MULTICC_BACKGROUND_HOLD_MAX_MS);
}

function backgroundActive(hasBackground) {
  try { return !!hasBackground?.(); } catch (_) { return false; }
}

function createBackgroundHold({ hasBackground, release, quietMs = QUIET_MS, tickMs = TICK_MS,
  maxMs = holdMaxMs(), onCapReached = null, onBoundary = null } = {}) {
  const owner = new (getNative().RustBackgroundHold)({ quietMs, tickMs, maxMs });
  let ticker = null, capTimer = null, done = false;
  if (onBoundary) owner.requireAnswerHistory();
  function flushBoundaries() {
    if (!onBoundary) return;
    for (const event of owner.pendingBoundaries()) {
      try { onBoundary({ ...event, acknowledge: () => owner.acknowledgeAnswer(event.held_result_id) }); } catch (_) {}
    }
  }

  function clear() {
    clearInterval(ticker); clearTimeout(capTimer);
    ticker = capTimer = null;
  }
  function finish() {
    if (done) return null;
    const result = owner.flush();
    if (!result) return null;
    done = true;
    clear();
    release(result);
    return result;
  }
  function tick() {
    flushBoundaries();
    const result = owner.tick({ now: Date.now(), backgroundActive: backgroundActive(hasBackground) });
    if (!result) return;
    done = true;
    clear();
    release(result);
  }
  function noteCap() {
    if (!owner.capReached(backgroundActive(hasBackground))) return;
    try { onCapReached?.(owner.maxMs); } catch (_) {}
  }

  return {
    get held() { return owner.held; },
    get injectionsInFlight() { return owner.injections; },
    // Returns true when `event` (a main result) is held instead of ending the turn.
    start(event) {
      if (done) return false;
      const started = owner.start(event, {
        mainResult: isMainResult(event),
        backgroundActive: backgroundActive(hasBackground),
      });
      if (!started) return false;
      flushBoundaries();
      ticker = setInterval(tick, tickMs);
      ticker.unref?.();
      // Visibility, not release: the cap timer only unlocks one notice.
      if (Number.isFinite(maxMs) && maxMs > 0) {
        capTimer = setTimeout(noteCap, maxMs);
        capTimer.unref?.();
      }
      return true;
    },
    // Returns true when a held turn swallows `event` (self-wake / injected query).
    observe(event) { const swallowed = owner.observe(event); flushBoundaries(); return swallowed; },
    // Register a delivery identity BEFORE the line is written. The answer is
    // `{ action: 'write' | 'append_only' | 'refuse', uuid?, reason? }`: only
    // 'write' may touch stdin, 'append_only' just re-appends the history row of
    // a line that was already written, 'refuse' waits for a normal turn.
    beginInjection(identity, uuid) { return owner.beginInjection(String(identity ?? ''), String(uuid ?? '')); },
    confirmInjection(identity, uuid) { return owner.confirmInjection(identity, uuid); },
    acknowledgeHistory(identity, uuid) { return owner.acknowledgeHistory(identity, uuid); },
    historyWritten(identity) { return owner.historyWritten(identity); },
    interruptInjections() { owner.interruptInjections(); flushBoundaries(); },
    historyPending(identity) { return owner.historyPending(identity); },
    abortInjection(identity) { owner.abortInjection(String(identity ?? '')); },
    // Release now (cancel / insert-now): the held answer is complete.
    flush: finish,
    dispose() { done = true; owner.dispose(); clear(); },
  };
}

// Pure predicate: may this typed message be delivered INTO the held turn?
// Every fact is supplied by the host; the rule itself lives in Rust.
function mayInjectIntoHeldTurn(facts) {
  return getNative().backgroundHoldMayInject(facts);
}

// "A human typed this in the chat box" (excludes dispatch, triggers, machine
// continuations and task-page messages). The rule lives in Rust.
function isDirectUserTyped(item, opts) {
  return getNative().backgroundHoldUserTyped(item ?? null, opts ?? null) === true;
}

// One staleness comparison for both the stream pump and the injectable
// predicate. `{ routeChanged, configChanged, vaultStale, stale }`.
function processStale(running, wanted) {
  return getNative().backgroundHoldProcessStale(running || {}, wanted || {});
}

// Stable digest of the facts that decide which process serves a turn.
function spawnContract(facts) {
  return getNative().backgroundHoldSpawnContract(facts);
}

module.exports = {
  createBackgroundHold, holdMaxMs, mayInjectIntoHeldTurn, isDirectUserTyped, processStale,
  spawnContract,
};

'use strict';

const { isMainResult } = require('../cli-adapters/result-completion');

// A resident Claude turn ends at the CLI's main `result`, but background work it
// started (Agent, run_in_background Bash, Monitor) completes later and the CLI
// wakes itself with a <task-notification> query. Holding the host turn open
// until that work is done lets those queries run inside the turn (admitted
// provider route, live stream consumer) instead of being re-queued as a
// separate 🔇 turn. The cap is the backstop for work that never ends; after it,
// completions fall back to the queued notice.
const QUIET_MS = 5000;
const TICK_MS = 1000;
const DEFAULT_MAX_MS = 60 * 60 * 1000;
const BUSY_OVERRUN_MS = 10 * 60 * 1000;

function holdMaxMs(env = process.env) {
  const n = Number(env.MULTICC_BACKGROUND_HOLD_MAX_MS);
  return env.MULTICC_BACKGROUND_HOLD_MAX_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_MS;
}

const succeeded = event => event?.subtype === 'success' && event.is_error === false;
const CONTINUATION = new Set(['assistant', 'user', 'stream_event']);

// The released event keeps the held main result's identity (it is what the
// completion tracker adjudicates) and takes the final answer, usage and cost
// from the last successful self-wake query.
function merge(held, latest) {
  if (!latest) return held;
  const pick = key => (latest[key] !== undefined ? latest[key] : held[key]);
  return { ...held, result: pick('result'), usage: pick('usage'), modelUsage: pick('modelUsage'),
    total_cost_usd: pick('total_cost_usd') };
}

function createBackgroundHold({ hasBackground, release, quietMs = QUIET_MS, tickMs = TICK_MS,
  maxMs = holdMaxMs() } = {}) {
  let held = null, latest = null, busy = false, expired = false, quietSince = 0, done = false;
  let ticker = null, capTimer = null, overrunTimer = null;

  function clear() {
    clearInterval(ticker); clearTimeout(capTimer); clearTimeout(overrunTimer);
    ticker = capTimer = overrunTimer = null;
  }
  function finish() {
    if (done || !held) return null;
    done = true;
    clear();
    const result = merge(held, latest);
    held = latest = null;
    release(result);
    return result;
  }
  function tick() {
    if (!held || busy) { quietSince = 0; return; }
    if (expired) { finish(); return; }
    let active = true;
    try { active = !!hasBackground(); } catch (_) {}
    if (active) { quietSince = 0; return; }
    if (!quietSince) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs) finish();
  }

  return {
    get held() { return !!held; },
    // Returns true when `event` (a main result) is held instead of ending the turn.
    start(event) {
      if (done || held || !isMainResult(event) || !succeeded(event)) return false;
      let active = false;
      try { active = !!hasBackground(); } catch (_) {}
      if (!active) return false;
      held = event;
      ticker = setInterval(tick, tickMs);
      ticker.unref?.();
      capTimer = setTimeout(() => {
        expired = true;
        tick();
        overrunTimer = setTimeout(finish, BUSY_OVERRUN_MS);
        overrunTimer.unref?.();
      }, maxMs);
      capTimer.unref?.();
      return true;
    },
    // Returns true when a held turn swallows `event` (self-wake query results).
    observe(event) {
      if (!held) return false;
      if (event?.type === 'result') {
        busy = false;
        quietSince = 0;
        if (succeeded(event)) latest = event;
        tick();
        return true;
      }
      if (CONTINUATION.has(event?.type) || (event?.type === 'system' && event.subtype === 'init')) {
        busy = true;
        quietSince = 0;
      }
      return false;
    },
    // Release now (cancel / insert-now): the held answer is complete.
    flush: finish,
    dispose() { done = true; held = latest = null; clear(); },
  };
}

module.exports = { createBackgroundHold, holdMaxMs };

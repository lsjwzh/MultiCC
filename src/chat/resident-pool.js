'use strict';

// The residency pool: how many warm resident children this host is willing to
// pay for at once, and which one gives up its place when that number is passed.
//
// A resident lane buys latency with a child held across turns. That child is a
// LEASE THE HOST MAY REVOKE, not a promise the session keeps. It is claimed by
// the turn that needs it, and it becomes a candidate for reclaim the moment that
// turn ends — nothing here is ever evicted while a turn is in flight or queued,
// because `busy`/`queued` IS the claimed lease (stream-router's residents()).
//
// Reclaim is a request, not a kill. The pool asks the lane to replace the child
// at a turn boundary (`recycle`), so a turn that starts in the same tick wins:
// the backend turns the request into a deferred one and the child retires after
// the turn instead of under it. Nothing in this module terminates a process, and
// no lane-specific knowledge is needed — a reap, a crash or a lifecycle caller
// closing the child simply removes it from residents().
//
// That request is also why reclaiming is affordable: the conversation does not
// live in the child. claude resumes its native session id and codex re-attaches
// to its app-server thread, so an evicted child costs one respawn.
//
// The idle threshold is deliberately NOT here. Each lane already reclaims its own
// child after DEFAULT_IDLE_MS of no turns (chat-stream / claude-sdk-stream /
// codex-app-stream), and the legacy lane additionally holds a child past idle
// while it still owns live background work, up to a hard ceiling. That policy is
// per-child and needs backend-internal knowledge (background activity, exit
// handling); this module only bounds the COUNT, which no backend can see.
//
// Every other closer keeps its own authority and is not routed through here:
// deleting a session, rotating native context, separating a task, a
// hibernation/workspace handoff, a task-run slot ending, and service shutdown
// each call the facade directly. Those are statements about the session; the
// pool only ever makes statements about capacity.

// Processes, not on-disk workspaces: the pool's cap is machine-wide, where
// hibernation's awakeLimit is per directory. Kept well under the number of warm
// children a burst of sessions would otherwise leave behind (each CLI child is a
// real Node process), and high enough that ordinary parallel work never fights
// the cap.
const DEFAULT_LIMIT = 8;
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

function numericOption(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Pure decision, so the policy can be read and tested without a clock, a process
// or a backend. Returns [{ name, reason }] for the children to retire, oldest
// use first. Only the ORDER of lastUsedAt matters here, never the wall clock —
// the idle threshold is the lanes' (see the header).
//
// `blocked(name)` returns why a warm child must be left alone (or null). It is
// the caller's list, because it is the caller that knows what a child is still
// carrying: the host wires background tasks, workspace leases and running slots.
function selectEvictions({ residents, limit, blocked = () => null }) {
  const warm = Array.isArray(residents) ? residents.filter(Boolean) : [];
  if (limit <= 0) return [];
  const excess = warm.length - limit;
  if (excess <= 0) return [];
  const retirable = warm.filter(resident => resident.name
    && !resident.busy && !resident.queued
    && !blocked(resident.name));
  // Least-recently-used first: the child that has gone unused the longest is the
  // first the host stops paying for. Ties break on name so a sweep is stable.
  retirable.sort((left, right) =>
    (left.lastUsedAt || 0) - (right.lastUsedAt || 0) || String(left.name).localeCompare(String(right.name)));
  // A sweep's worth of busy children can make the cap unreachable; retire what
  // can be retired and leave the rest for a later sweep rather than queueing a
  // deferred reclaim that would land mid-turn.
  return retirable.slice(0, excess).map(resident => ({ name: resident.name, reason: 'resident_pool_evict' }));
}

function createResidentPool(options = {}) {
  const {
    residents,
    reclaim,
    blocked = () => null,
    onEvent = () => {},
    logger = console,
  } = options;
  if (typeof residents !== 'function') throw new TypeError('[resident-pool] residents port is required');
  if (typeof reclaim !== 'function') throw new TypeError('[resident-pool] reclaim port is required');
  const limit = Math.max(0, Math.trunc(numericOption(options.limit, DEFAULT_LIMIT)));
  const sweepMs = Math.max(0, Math.trunc(numericOption(options.sweepMs, DEFAULT_SWEEP_MS)));
  let sweeping = null;

  function publish(action, name, reason, warm) {
    const event = Object.freeze({ type: 'resident_pool', action, reason, sessionId: name || null, warm });
    try { onEvent(event); } catch (_) {}
  }

  function runSweep() {
    let warm = [];
    try { warm = residents() || []; } catch (error) {
      logger.warn?.('resident_pool_list_failed', { error: error && error.message });
      return { ok: false, warm: 0, reclaimed: [] };
    }
    let chosen;
    try { chosen = selectEvictions({ residents: warm, limit, blocked }); } catch (error) {
      logger.warn?.('resident_pool_select_failed', { error: error && error.message });
      return { ok: false, warm: warm.length, reclaimed: [] };
    }
    if (chosen.length === 0) return { ok: true, warm: warm.length, reclaimed: [] };
    const reclaimed = [];
    for (const item of chosen) {
      let landed = null;
      try { landed = reclaim(item.name, item.reason); } catch (error) {
        logger.warn?.('resident_pool_reclaim_failed', { sessionId: item.name, error: error && error.message });
        continue;
      }
      // 'deferred-boundary' / 'deferred-background' are successes for the pool:
      // the child retires when the turn (or the work) that took it finishes.
      // 'not-running' is one too — there is nothing left to pay for. Only a
      // request the lane could not place at all is reported as a failure.
      const applied = landed && typeof landed === 'object' ? landed.applied : null;
      if (applied === 'kill-failed' || applied === 'unknown-session') {
        logger.warn?.('resident_pool_reclaim_failed', { sessionId: item.name, applied });
        continue;
      }
      reclaimed.push({ name: item.name, applied: applied || 'unknown' });
      publish('reclaim', item.name, item.reason, warm.length);
    }
    return { ok: true, warm: warm.length, reclaimed };
  }

  // One sweep at a time, and a sweep never rejects: it runs from a service timer,
  // where an unreachable backend or a lane that refuses the request must not turn
  // into an unhandled rejection that ends the whole schedule.
  function sweep() {
    if (sweeping) return sweeping;
    sweeping = Promise.resolve()
      .then(runSweep)
      .catch(error => {
        logger.warn?.('resident_pool_sweep_failed', { error: error && error.message });
        return { ok: false, warm: 0, reclaimed: [] };
      })
      .finally(() => { sweeping = null; });
    return sweeping;
  }

  return Object.freeze({
    sweep,
    // Observability: how full the pool is, and how long the least recently used
    // child has been idle. The number a panel shows for the idle threshold comes
    // from the lane that enforces it; this is the pool's own view of the same
    // children, which is what makes the two comparable.
    status() {
      let warm = null;
      let oldestIdleMs = null;
      try {
        const list = residents() || [];
        warm = list.length;
        if (warm) {
          const oldest = Math.min(...list.map(entry => entry.lastUsedAt || 0));
          oldestIdleMs = oldest ? Math.max(0, Date.now() - oldest) : null;
        }
      } catch (_) { warm = null; }
      return Object.freeze({ limit, warm, oldestIdleMs });
    },
    policy: () => Object.freeze({ limit, sweepMs, enabled: limit > 0 }),
  });
}

module.exports = { DEFAULT_LIMIT, DEFAULT_SWEEP_MS, createResidentPool, selectEvictions };

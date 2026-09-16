'use strict';

// Every surface that shows a judgement — the chat bar, the Air deck, the
// roster cards, the app dashboard — renders Aux's LAST verdict about a session.
// That verdict is only meaningful while Aux is answering: when Aux itself is
// unhealthy it stops changing, and a two-day-old goal keeps being presented as
// "what the assistant currently thinks this session is doing". The user reads
// it as a live judgement and asks why nothing moved.
//
// So a verdict travels with its own freshness. `task_state` payloads (the one
// channel all those surfaces already consume) therefore carry two facts:
// whether Aux is healthy, and since when it has not been. The judgement itself
// is deliberately NOT blanked: it is still the best description available, and
// throwing it away would lose real information. It just stops claiming to be
// current.
//
// Aux's queue is constructed per app (mountAuxGoalRoutes), not module-level, so
// the health source is installed at bootstrap — the same shape as the
// task-short-code registry. A caller that never installs one (unit tests,
// one-off scripts) reads "healthy", which is the honest default for a process
// with no Aux at all.
let healthProvider = null;

function installAuxHealthProvider(fn) {
  healthProvider = typeof fn === 'function' ? fn : null;
}

function readAuxHealth() {
  if (!healthProvider) return null;
  try {
    const health = healthProvider();
    return health && typeof health === 'object' ? health : null;
  } catch (_) {
    return null;
  }
}

// `{ auxUnhealthy, auxUnhealthySince }` — spread into a task_state payload.
//
// It deliberately carries no diagnosis (no category, no upstream error text):
// task_state is fanned out to every client subscribed to a session, a shared
// session's sharees included, and Aux's upstream failure is provider plumbing
// that says nothing about the conversation. "The judgement is paused" is the
// whole fact a viewer needs; /manage's aux panel is where the operator reads
// the reason.
function auxVerdictStaleness() {
  const health = readAuxHealth();
  if (!health || !health.unhealthy) return { auxUnhealthy: false, auxUnhealthySince: null };
  return { auxUnhealthy: true, auxUnhealthySince: health.sinceAt || null };
}

// A frozen judgement produces no further `task_state`, which is exactly the
// situation this signals: a page already open would keep rendering the verdict
// as current until its next reload. So on a health TRANSITION the freshness fact
// is pushed on its own to every session that is showing a judgement.
//
// Two things make this worth a function rather than a loop at the call site.
// The selection rule ("who is showing a judgement") lives next to the fact it
// describes, so a new surface cannot invent its own; and the ports are injected,
// so the rule is testable without a live server. Returns how many sessions were
// told, so a caller can log or assert it.
function fanOutAuxVerdictStaleness({ sessions, getTaskState, chatBroadcast, workspaceBroadcast }) {
  const payload = { type: 'aux_verdict_staleness', ...auxVerdictStaleness() };
  let told = 0;
  for (const [sessionId, record] of sessions) {
    // The aux/gateway pseudo-sessions are plumbing, not cards the user reads.
    if (!record || record.type === 'aux' || record.type === 'gateway') continue;
    const task = getTaskState(record);
    if (!task.goal && !task.classifyState) continue;
    try { chatBroadcast(sessionId, payload); } catch (_) {}
    if (record.dirId) {
      try { workspaceBroadcast(record.dirId, { ...payload, sessionId }); } catch (_) {}
    }
    told += 1;
  }
  return told;
}

module.exports = { installAuxHealthProvider, auxVerdictStaleness, fanOutAuxVerdictStaleness };

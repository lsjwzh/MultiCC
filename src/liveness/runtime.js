'use strict';

// Session liveness: tell "working" (producing / waiting on the model) apart from
// "idle" (between turns) and "stalled" (claims to be busy but nothing is moving).
//
// The hard problem this solves: chat_history mtime and UI status fields update
// only at turn boundaries and can go stale, so a session that is silently making
// progress looks identical to one that has died. This runtime fuses several
// live signals instead of trusting any single coarse one:
//
//   1. cli-provider-router `onActivity` events (request / first_byte / end) —
//      the most precise signal for provider-backed sessions: the proxy sits in
//      the request path and reports the exact moment bytes start flowing. Fed in
//      via recordProxyActivity(); metadata only (no bodies/tokens).
//   2. The host's own streaming flags (cs.isStreaming, chatStream busy) and the
//      turn progress heartbeat's silentMs — a turn that is running but quiet.
//   3. An optional process-level probe (probeSession) for sessions that bypass
//      the proxy (default-login / claude-official direct): an ESTABLISHED
//      outbound HTTPS connection or a growing codex rollout file proves work.
//
// Verdict precedence, most authoritative first: an in-flight turn or fresh proxy
// activity or a live outbound connection ⇒ `working`; a turn that claims to be
// in flight yet has been silent past the stall threshold with no outbound
// connection ⇒ `stalled`; otherwise recent-but-quiet ⇒ `idle`.

const DEFAULTS = Object.freeze({
  // A proxy `request`/`first_byte` within this window ⇒ actively working.
  proxyActiveMs: 90_000,
  // A running turn silent longer than this, with no corroborating outbound
  // signal, is treated as stalled rather than working.
  stallSilentMs: 180_000,
  // Activity (any kind) more recent than this ⇒ at least idle, not dormant.
  idleRecentMs: 10 * 60_000,
});

function assertFn(value, name) {
  if (typeof value !== 'function') throw new TypeError(`[liveness] ${name} must be a function`);
}

function createLivenessRuntime(deps = {}) {
  const {
    now = Date.now,
    records,
    chatSessions,
    chatStreamStatus = () => null,
    probeSession = null,
    thresholds = {},
  } = deps;

  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[liveness] records must be a map-like session registry');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[liveness] chatSessions must be map-like');
  }
  assertFn(now, 'now');
  assertFn(chatStreamStatus, 'chatStreamStatus');
  if (probeSession !== null) assertFn(probeSession, 'probeSession');

  const cfg = { ...DEFAULTS, ...thresholds };

  // Per-session proxy-activity ledger. Only the last event per session matters;
  // this never grows without bound (one entry per active session).
  const proxyLedger = new Map();

  // Fed from cli-provider-router onActivity. Metadata only.
  function recordProxyActivity(event) {
    if (!event || !event.sessionId) return;
    const phase = event.phase;
    if (phase !== 'request' && phase !== 'first_byte' && phase !== 'end') return;
    const at = Number.isFinite(event.at) ? event.at : now();
    proxyLedger.set(event.sessionId, {
      phase,
      at,
      role: event.role || null,
      providerId: event.providerId || null,
    });
  }

  function forget(sessionId) {
    proxyLedger.delete(sessionId);
  }

  function processHandleAlive(child) {
    return !!child
      && child.killed !== true
      && child.exitCode == null
      && child.signalCode == null;
  }

  // Fast, side-effect-free ownership proof used by classify. This deliberately
  // answers a narrower question than verdict(): may a W/D/E candidate cross the
  // scheduler boundary right now? Absence of traffic is never treated as proof
  // that a turn ended. Only a live owned runner proves active; a stopped runner
  // or an idle persistent stream proves inactive; contradictory/missing facts
  // fail closed as unknown.
  function ownership(sessionId) {
    const record = records.get(sessionId);
    if (!record) return { state: 'unknown', reason: 'no_such_session' };
    const cs = chatSessions.get(sessionId);
    if (!cs) return { state: 'unknown', reason: 'no_chat_runtime' };
    if (cs._activeRunner?.retryPlanned) {
      return { state: 'active', reason: 'owned_retry_pending' };
    }
    const cli = record.cli || cs.cli || null;
    if (cli === 'claude') {
      const stream = (() => {
        try { return chatStreamStatus(sessionId) || null; } catch (_) { return null; }
      })();
      if (stream?.busy) return { state: 'active', reason: 'persistent_stream_busy' };
      if (stream && stream.busy === false) {
        return { state: 'inactive', reason: 'persistent_stream_idle' };
      }
      return cs.isStreaming
        ? { state: 'unknown', reason: 'stream_status_missing' }
        : { state: 'inactive', reason: 'no_owned_turn' };
    }
    if (processHandleAlive(cs.claudeProc)) {
      return { state: 'active', reason: 'owned_process_alive' };
    }
    if (cs.claudeProc) {
      return { state: 'inactive', reason: 'owned_process_exited' };
    }
    return cs.isStreaming
      ? { state: 'unknown', reason: 'streaming_without_process' }
      : { state: 'inactive', reason: 'no_owned_turn' };
  }

  // Snapshot the raw signals for one session (no verdict). Useful for the
  // endpoint payload and for tests to assert the inputs.
  function signals(sessionId) {
    const t = now();
    const cs = chatSessions.get(sessionId) || null;
    const streamStatus = (() => {
      try { return chatStreamStatus(sessionId) || null; } catch (_) { return null; }
    })();
    const isStreaming = !!(cs && cs.isStreaming);
    const busy = !!(streamStatus && streamStatus.busy);
    const lastStreamAt = cs && Number.isFinite(cs.lastStreamAt) ? cs.lastStreamAt : null;
    const turnStartedAt = cs && Number.isFinite(cs.turnStartedAt) ? cs.turnStartedAt : null;
    const proxy = proxyLedger.get(sessionId) || null;
    const proxyAgeMs = proxy ? Math.max(0, t - proxy.at) : null;
    // silentMs: how long since the last user-visible byte for the in-flight turn.
    // Prefer an explicit host-provided heartbeat value on the chat session; fall
    // back to lastStreamAt.
    const heartbeatSilentMs = cs && Number.isFinite(cs.heartbeatSilentMs)
      ? cs.heartbeatSilentMs
      : (lastStreamAt != null && (isStreaming || busy) ? Math.max(0, t - lastStreamAt) : null);
    const pid = (streamStatus && Number.isInteger(streamStatus.pid)) ? streamStatus.pid
      : (cs && cs.claudeProc && Number.isInteger(cs.claudeProc.pid)) ? cs.claudeProc.pid
        : null;
    return {
      at: t, isStreaming, busy, pid,
      lastStreamAt, turnStartedAt, heartbeatSilentMs,
      proxyPhase: proxy ? proxy.phase : null,
      proxyAgeMs,
      phase: cs && cs.currentTask && cs.currentTask.phase ? cs.currentTask.phase : null,
    };
  }

  // Assess one session into { state, reason, ...signals }. `probe` is the result
  // of probeSession(sessionId) when the caller opted into process-level checks;
  // pass null to skip (cheap, event-only assessment).
  function verdict(sessionId, probe = null) {
    const rec = records.get(sessionId);
    if (!rec) return { state: 'unknown', reason: 'no_such_session' };
    const s = signals(sessionId);
    const inFlight = s.isStreaming || s.busy;
    const proxyActive = s.proxyAgeMs != null && s.proxyPhase !== 'end' && s.proxyAgeMs <= cfg.proxyActiveMs;
    const outbound = !!(probe && probe.hasOutboundConnection);
    const rolloutGrowing = !!(probe && probe.rolloutGrowing);

    // ── working: something is demonstrably moving ─────────────────────────
    if (proxyActive) {
      return { state: 'working', reason: `proxy_${s.proxyPhase}`, ...s, probe };
    }
    if (inFlight) {
      const silent = s.heartbeatSilentMs;
      // A turn that claims to be in flight but has been silent past the stall
      // threshold AND shows no corroborating outbound/rollout signal is stalled.
      if (silent != null && silent >= cfg.stallSilentMs && !outbound && !rolloutGrowing) {
        return { state: 'stalled', reason: `silent_${Math.round(silent / 1000)}s`, ...s, probe };
      }
      const reason = s.phase ? `turn_${s.phase}` : (outbound ? 'outbound_connection' : 'in_flight');
      return { state: 'working', reason, ...s, probe };
    }
    if (outbound || rolloutGrowing) {
      // No host-visible turn, but the process is demonstrably talking to an
      // upstream / writing its rollout — a direct (non-proxy) session working.
      return { state: 'working', reason: outbound ? 'outbound_connection' : 'rollout_growing', ...s, probe };
    }

    // ── idle vs dormant ───────────────────────────────────────────────────
    const lastKnown = Math.max(
      s.lastStreamAt || 0,
      s.proxyAgeMs != null ? (s.at - s.proxyAgeMs) : 0,
    );
    if (lastKnown > 0 && (s.at - lastKnown) <= cfg.idleRecentMs) {
      return { state: 'idle', reason: 'recent_activity', ...s, probe };
    }
    return { state: 'idle', reason: 'no_recent_activity', ...s, probe };
  }

  // Convenience: assess with an async process probe when available.
  async function assess(sessionId, { probe = probeSession !== null } = {}) {
    let probeResult = null;
    if (probe && probeSession) {
      const s = signals(sessionId);
      try { probeResult = await probeSession(sessionId, s); } catch (_) { probeResult = null; }
    }
    return verdict(sessionId, probeResult);
  }

  return { recordProxyActivity, forget, signals, ownership, verdict, assess, thresholds: cfg };
}

module.exports = { createLivenessRuntime, LIVENESS_DEFAULTS: DEFAULTS };

'use strict';

const { getNative } = require('../native/runtime');
const {
  createExactSecretStreamRedactor, redactProviderRouteCapability, maybeRouteCapability,
} = require('../observability');

const FENCE_ORDER = Object.freeze({
  none: 0,
  visible_output: 1,
  tool_intent: 2,
  side_effect: 3,
});
// Host-only proof that one complete assistant snapshot is a provider-owned
// error envelope, not model output. The Symbol is intentionally module-private:
// upstream JSON/model data cannot forge it, and the non-enumerable descriptor
// keeps it out of client frames, logs, persistence and object spreads.
const HOST_ERROR_ENVELOPE = Symbol('multicc.hostErrorEnvelope');
const PROVIDER_ROUTE_OWNABLE_EVENT_TYPES = new Set([
  'part_delta', 'stream_event', 'assistant', 'user', 'result', 'error',
  'api_error_policy', 'provider_token_stats', 'rate_limit_event',
]);

class ProviderAttemptError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderAttemptError';
    this.code = code || 'PROVIDER_ATTEMPT_INVALID';
  }
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function required(value, label) {
  return getNative().providerRequiredIdentity(value, label, ProviderAttemptError);
}

function createProviderRevision(input = {}) {
  return getNative().providerRevision(input, ProviderAttemptError);
}

function providerAttemptFields(reference) {
  return getNative().providerAttemptFields(reference, ProviderAttemptError);
}

function tagProviderAttemptEvent(event, reference) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new ProviderAttemptError('provider event is required', 'PROVIDER_ATTEMPT_EVENT_INVALID');
  }
  return Object.freeze({
    ...redactProviderRouteCapability(event), ...providerAttemptFields(reference),
  });
}

function scopeHostProviderEvent(event) {
  const safe = redactProviderRouteCapability(event);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)
      || !PROVIDER_ROUTE_OWNABLE_EVENT_TYPES.has(safe.type)
      || safe.providerRouteScope != null) return safe;
  return { ...safe, providerRouteScope: 'host' };
}

function markHostErrorEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || event.type !== 'assistant') return event;
  const marked = { ...event };
  Object.defineProperty(marked, HOST_ERROR_ENVELOPE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return marked;
}

function fenceForEvent(event) {
  return getNative().providerEventFence(event, HOST_ERROR_ENVELOPE);
}

function sameAttempt(record, reference) {
  return !!(record && reference && record.lifecycle.matches(reference));
}

function encodeProxySessionId(sessionId, token) {
  return getNative().providerEncodeProxySession(sessionId, token);
}

function decodeProxySessionId(value) {
  return getNative().providerDecodeProxySession(value);
}

// The clone, descriptor walk and write-back are one native call
// (native/addon/src/provider_scrub.rs). It returns the event itself when
// nothing changed.
const SEMANTIC_SCRUB_TYPES = new Set([
  'assistant', 'user', 'tool_start', 'tool_update', 'tool_result',
]);

function scrubProviderSemanticStructure(event, secrets) {
  if (!event || typeof event !== 'object') {
    return redactProviderRouteCapability(event);
  }
  // An event type without model-controlled parts can only change through the
  // route rule, which rewrites each string on its own: a structure with no
  // route anchor anywhere is proven unchanged without a native call (the
  // anchors come from Rust). Semantic types always take the native call
  // because a secret can be split across descriptors, so no per-string anchor
  // check is a safe precondition for the exact-secret passes.
  if (!SEMANTIC_SCRUB_TYPES.has(event.type) && !maybeRouteCapability(event)) return event;
  return getNative().providerScrubSemanticStructure(event, secrets);
}

function createProviderAttemptRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // An injected id minter is a test override channel only. Without one the
  // Rust owner mints capabilities itself (native/addon provider_attempt_creation).
  const nextId = typeof options.nextId === 'function' ? options.nextId : null;
  const emit = typeof options.emit === 'function' ? options.emit : null;
  const audit = typeof options.audit === 'function' ? options.audit : null;
  const resolveProviderRevision = typeof options.resolveProviderRevision === 'function'
    ? options.resolveProviderRevision : null;
  // 终端会话（tmux 里的长活 CLI）没有回合，它的路由能力存在会话记录上，由宿主注入
  // 一个只读反查（见 native/addon/src/provider_terminal_routes.rs）。没有这个端口时，终端路由照旧
  // 按「查不到 attempt」拒绝。
  const resolveTerminalRoute = typeof options.resolveTerminalRoute === 'function'
    ? options.resolveTerminalRoute : null;
  // Account protection, injected by the host (src/quota/quota-guard): holds a
  // provider whose subscription window is at the configured ceiling. Optional —
  // absent means the gate does not exist, which is what every test runtime and
  // every non-official install gets.
  const quotaGuard = options.quotaGuard && typeof options.quotaGuard.check === 'function'
    ? options.quotaGuard : null;
  // A proxied request whose downstream CLI consumer died mid-stream never
  // emits the proxy 'end' that drains its producer. After this grace the
  // entry is provably orphaned (the attempt gate below already guarantees no
  // attempt is 'running'), so a new attempt force-releases it instead of
  // wedging the session until a server restart.
  const producerStaleGraceMs = Math.min(600_000, Math.max(5_000,
    Number.isFinite(Number(options.producerStaleGraceMs)) && Number(options.producerStaleGraceMs) > 0
      ? Number(options.producerStaleGraceMs) : 30_000));
  const runtimeEpoch = required(
    options.runtimeEpoch || getNative().providerMintPrefixedId('runtime'),
    'runtimeEpoch',
  );
  const currentBySession = new (getNative().RustCurrentAttempts)();
  const generations = new (getNative().RustProviderAttemptGenerations)();
  const proxyProducers = new (getNative().RustMainProducers)();
  const nonMainProxyProducers = new (getNative().RustNonMainProducers)();
  const streamRedactors = new Map();
  // Live host ports only: Rust owns admission, snapshot assembly, route event
  // dispatch and finish coordination. The snapshot and nextId members are
  // native commands or test overrides, never Node logic; emit/auditOnly/now
  // stay host callbacks because the subscriber and ledger live in Node.
  const proxyPort = Object.freeze({
    runtimeEpoch, quotaGuard, resolveTerminalRoute, resolveProviderRevision,
    snapshot: getNative().providerAttemptSnapshot,
    auditOnly, poisonProxyAttempt, now, producerStaleGraceMs,
    proxyProducers, nonMainProxyProducers, ProviderAttemptError,
    currentBySession, proxyContext, nextId, emit, streamRedactors,
  });

  function streamRedactor(record, channel) {
    let channels = streamRedactors.get(record.routeAttemptId);
    if (!channels) {
      channels = new Map();
      streamRedactors.set(record.routeAttemptId, channels);
    }
    let redactor = channels.get(channel);
    if (!redactor) {
      redactor = createExactSecretStreamRedactor([
        encodeProxySessionId(record.sessionId, record.proxyRouteToken),
        record.proxyRouteToken,
      ]);
      channels.set(channel, redactor);
    }
    return redactor;
  }

  function scrubStreamText(record, channel, value) {
    if (typeof value !== 'string') return value;
    return streamRedactor(record, channel).push(value);
  }

  function scrubAttemptStructure(reference, event) {
    const record = currentBySession.get(clean(reference && reference.sessionId));
    if (!sameAttempt(record, reference)) return redactProviderRouteCapability(event);
    return scrubProviderSemanticStructure(event, [
      encodeProxySessionId(record.sessionId, record.proxyRouteToken),
      record.proxyRouteToken,
    ]);
  }

  function scrubAttemptEvent(reference, event) {
    const safe = scrubAttemptStructure(reference, event);
    const record = currentBySession.get(clean(reference && reference.sessionId));
    if (!safe || typeof safe !== 'object' || !sameAttempt(record, reference)) return safe;
    if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
      const rawNested = event.event;
      const rawDelta = rawNested.delta;
      if (!rawDelta || typeof rawDelta !== 'object') return safe;
      const nested = safe.event || rawNested;
      const delta = nested.delta || rawDelta;
      const index = rawNested.index == null ? 'unknown' : String(rawNested.index);
      if (rawDelta.type === 'text_delta' && typeof rawDelta.text === 'string') {
        return { ...safe, event: { ...nested, delta: { ...delta,
          text: scrubStreamText(record, `stream:${index}:text`, rawDelta.text),
        } } };
      }
      if (rawDelta.type === 'thinking_delta' && typeof rawDelta.thinking === 'string') {
        return { ...safe, event: { ...nested, delta: { ...delta,
          thinking: scrubStreamText(record, `stream:${index}:thinking`, rawDelta.thinking),
        } } };
      }
      if (rawDelta.type === 'input_json_delta' && typeof rawDelta.partial_json === 'string') {
        return { ...safe, event: { ...nested, delta: { ...delta,
          partial_json: scrubStreamText(record, `stream:${index}:tool-json`, rawDelta.partial_json),
        } } };
      }
      return safe;
    }
    if (event.type === 'part_delta') {
      const rawDelta = event.delta && typeof event.delta === 'object' ? event.delta : null;
      if (!rawDelta) return safe;
      const delta = safe.delta || rawDelta;
      const id = clean(rawDelta.toolId || rawDelta.id || rawDelta.type) || 'unknown';
      if (typeof rawDelta.text === 'string') {
        return { ...safe, delta: { ...delta,
          text: scrubStreamText(record, `part:${id}:text`, rawDelta.text),
        } };
      }
      if (rawDelta.tool && typeof rawDelta.tool === 'object'
          && typeof rawDelta.tool.arguments === 'string') {
        return { ...safe, delta: { ...delta, tool: { ...(delta.tool || rawDelta.tool),
          arguments: scrubStreamText(record, `part:${id}:tool-json`, rawDelta.tool.arguments),
        } } };
      }
    }
    return safe;
  }

  function auditOnly(sessionId, event) {
    if (!audit || !sessionId) return;
    try { audit(sessionId, Object.freeze({ ...event, ts: Number(now()) })); } catch (_) {}
  }

  function beginAttempt(input = {}) {
    return getNative().providerBeginAttempt(currentBySession, generations, input, proxyPort);
  }

  // Snapshot assembly, staleness audit, lifecycle finalization, route event
  // dispatch and redactor cleanup are one native command
  // (native/addon provider_attempt_route). The frozen result and its key order
  // are unchanged.
  function finishAttempt(reference, facts = {}) {
    return getNative().providerFinishAttempt(currentBySession, reference, facts, proxyPort);
  }

  function acceptEvent(reference) {
    const sessionId = clean(reference && reference.sessionId);
    const record = currentBySession.get(sessionId);
    if (sameAttempt(record, reference) && record.lifecycle.running()) return true;
    auditOnly(sessionId, {
      type: 'provider_attempt_late_ignored', operation: 'event_admission',
      runtimeEpoch: clean(reference && reference.runtimeEpoch) || null,
      turnId: clean(reference && reference.turnId) || null,
      routeAttemptId: clean(reference && reference.routeAttemptId) || null,
      routeGeneration: Number(reference && reference.routeGeneration) || null,
      currentRouteAttemptId: record ? record.routeAttemptId : null,
      currentRouteGeneration: record ? record.routeGeneration : null,
    });
    return false;
  }

  function observeEvent(reference, event) {
    const sessionId = clean(reference && reference.sessionId);
    const record = currentBySession.get(sessionId);
    if (!sameAttempt(record, reference) || !record.lifecycle.running()) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'event',
        runtimeEpoch: clean(reference && reference.runtimeEpoch) || null,
        turnId: clean(reference && reference.turnId) || null,
        routeAttemptId: clean(reference && reference.routeAttemptId) || null,
        routeGeneration: Number(reference && reference.routeGeneration) || null,
        currentRouteAttemptId: record ? record.routeAttemptId : null,
        currentRouteGeneration: record ? record.routeGeneration : null,
      });
      return Object.freeze({ accepted: false, code: 'stale_attempt' });
    }
    // Anthropic-compatible CLIs can stream the text of an upstream HTTP error
    // through ordinary text_delta events, then finish with one authoritative
    // assistant snapshot containing only that error envelope. The deltas have
    // already advanced the replay fence, but the host-only marker proves that
    // none of that text was model output. Re-open only this narrow case; tool
    // intent and side effects remain irreversible.
    const trustedError = getNative().providerHostTextEnvelope(event, HOST_ERROR_ENVELOPE);
    const previousFence = record.lifecycle.snapshot().replayFence;
    if (trustedError && record.lifecycle.reconcileHostError(event)) {
      if (previousFence !== 'none') {
        auditOnly(sessionId, {
          type: 'provider_fence_reconciled', runtimeEpoch: record.runtimeEpoch,
          turnId: record.turnId, routeAttemptId: record.routeAttemptId,
          routeGeneration: record.routeGeneration, providerId: record.providerId,
          fromFence: previousFence, replayFence: 'none', reasonCode: 'host_error_envelope',
        });
      }
      return Object.freeze({ accepted: true, code: null, ...getNative().providerAttemptSnapshot(record) });
    }
    const fence = record.lifecycle.observeFence(event, HOST_ERROR_ENVELOPE);
    if (fence) {
      auditOnly(sessionId, {
        type: 'provider_fence_advanced', runtimeEpoch: record.runtimeEpoch,
        turnId: record.turnId, routeAttemptId: record.routeAttemptId,
        routeGeneration: record.routeGeneration, providerId: record.providerId,
        fromFence: previousFence, replayFence: fence,
      });
    }
    return Object.freeze({ accepted: true, code: null, ...getNative().providerAttemptSnapshot(record) });
  }

  function proxyContext(input = {}) {
    const decoded = decodeProxySessionId(input.sessionId);
    const record = currentBySession.get(decoded.sessionId);
    return {
      sessionId: decoded.sessionId,
      token: decoded.token,
      // 段里到底有没有带能力令牌。`exact` 还要再对上内存里那条 attempt；终端没有
      // attempt，它只能看这一位加会话记录上的令牌。
      encoded: decoded.encoded === true,
      record,
      exact: !!(record && decoded.encoded && decoded.token === record.proxyRouteToken),
    };
  }

  function proxySessionId(reference) {
    const record = currentBySession.get(clean(reference && reference.sessionId));
    if (!sameAttempt(record, reference)) {
      throw new ProviderAttemptError('provider attempt is not current', 'PROVIDER_ATTEMPT_STALE');
    }
    return encodeProxySessionId(record.sessionId, record.proxyRouteToken);
  }

  function resolveProxySessionId(value) {
    return decodeProxySessionId(value).sessionId || null;
  }

  function poisonProxyAttempt(record, reasonCode) {
    if (!record || !record.lifecycle.running()) return;
    finishAttempt(getNative().providerAttemptSnapshot(record), {
      outcome: 'failed', errorCategory: 'adapter_configuration', reasonCode,
    });
  }

  function authorizeProxyRequest(input = {}) {
    return getNative().providerAuthorizeProxyRequest(input, proxyContext(input), proxyPort);
  }

  async function authorizeProxyRequestAsync(input = {}) {
    const method = clean(input.method).toUpperCase();
    if (!quotaGuard || (method && method !== 'POST')) return authorizeProxyRequest(input);
    if (typeof quotaGuard.checkAsync !== 'function') return authorizeProxyRequest(input);
    const verdict = await quotaGuard.checkAsync({ providerId: clean(input.providerId) });
    // Re-read the attempt after awaiting the database. A turn may have ended
    // or switched routes while the quota request was in flight.
    const port = { ...proxyPort, quotaGuard: { check: () => verdict } };
    return getNative().providerAuthorizeProxyRequest(input, proxyContext(input), port);
  }

  function forceReleaseProducers(sessionId, reason = 'force_release') {
    return getNative().providerForceReleaseProducers(sessionId, reason, proxyPort);
  }

  function onProxyActivity(event = {}) {
    return getNative().providerProxyActivity(event, proxyContext(event), proxyPort);
  }

  function boundProxyAttempt(input = {}) {
    return getNative().providerBoundProxyAttempt(input, proxyContext(input), proxyPort);
  }

  function observeProxyDelta(delta, context = {}) {
    const attempt = boundProxyAttempt(context);
    if (!attempt) {
      const sessionId = resolveProxySessionId(context.sessionId);
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'proxy_delta',
        runtimeEpoch, turnId: null, routeAttemptId: null, routeGeneration: null,
        providerId: clean(context.providerId) || null,
        currentRouteAttemptId: snapshotSession(sessionId)?.routeAttemptId || null,
        currentRouteGeneration: snapshotSession(sessionId)?.routeGeneration || null,
      });
      return Object.freeze({ accepted: false, code: 'proxy_attempt_unbound' });
    }
    return observeEvent(attempt, { type: 'part_delta', delta });
  }

  function attributeProxyUsage(event = {}) {
    return getNative().providerAttributeProxyUsage(event, proxyPort);
  }

  // The host reports each physical request independently of token accounting.
  // Bind its purpose and terminal evidence to the admitted attempt so probes,
  // late responses, and provider-rendered text cannot decide another turn.
  function observeProxyOutcome(event = {}) {
    return getNative().providerObserveProxyOutcome(event, proxyPort);
  }

  function proxyFailure(reference, facts = {}) {
    return getNative().providerProxyFailure(reference, facts, proxyPort);
  }

  function snapshotSession(sessionId) {
    return getNative().providerAttemptSnapshot(currentBySession.get(clean(sessionId)));
  }

  return Object.freeze({
    beginAttempt,
    finishAttempt,
    acceptEvent,
    forceReleaseProducers,
    observeEvent,
    observeProxyDelta,
    boundProxyAttempt,
    scrubAttemptStructure,
    scrubAttemptEvent,
    authorizeProxyRequest, authorizeProxyRequestAsync,
    onProxyActivity,
    attributeProxyUsage,
    observeProxyOutcome,
    proxyFailure,
    proxySessionId,
    resolveProxySessionId,
    // 终端那条路由（长活会话，没有回合）自己拼能力段：与 proxySessionId 同一种形状，
    // 只是令牌来自会话记录而不是内存里的 attempt（见 native/addon/src/provider_terminal_routes.rs）。
    encodeProxyRoute: (sessionId, token) => encodeProxySessionId(clean(sessionId), clean(token)),
    snapshot: snapshotSession,
  });
}

module.exports = {
  FENCE_ORDER,
  ProviderAttemptError,
  createProviderRevision,
  createProviderAttemptRuntime,
  fenceForEvent,
  markHostErrorEnvelope,
  providerAttemptFields,
  scopeHostProviderEvent,
  tagProviderAttemptEvent,
};

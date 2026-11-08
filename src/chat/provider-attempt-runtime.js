'use strict';

const crypto = require('node:crypto');
const { getNative } = require('../native/runtime');
const { isResident } = require('../cli/cli-capability');
const {
  createExactSecretStreamRedactor, redactExactSecretFragments, redactProviderRouteCapability,
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

function positiveInteger(value, label) {
  return getNative().providerPositiveInteger(value, label, ProviderAttemptError);
}

// Optional per-attempt idle budget for the host-side stall watchdog. 0 (the
// default, and what every non-Auto route passes) means "no watchdog at all".
// Anything malformed degrades to 0 rather than throwing: a diagnostics budget
// must never be the reason a turn cannot start.
function stallTimeoutBudget(value) {
  return getNative().providerTimeoutBudget(value);
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

function snapshot(record) {
  if (!record) return null;
  const fence = record.lifecycle.snapshot();
  const budget = record.lifecycle.budget();
  const status = record.lifecycle.status();
  return Object.freeze({
    runtimeEpoch: record.runtimeEpoch,
    decisionId: record.decisionId,
    routeAttemptId: record.routeAttemptId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    cli: record.cli,
    providerId: record.providerId,
    providerName: record.providerName,
    protocol: record.protocol,
    model: record.model,
    providerRevision: record.providerRevision,
    attemptNo: record.attemptNo,
    routeGeneration: record.routeGeneration,
    // The idle budget the proxy watchdog enforces for this physical route, and
    // whether it has already fired. A stalled attempt is not a route to replay.
    stallTimeoutMs: record.stallTimeoutMs,
    requestTimeoutMs: record.requestTimeoutMs,
    connectTimeoutMs: record.connectTimeoutMs,
    requestDeadlineAt: budget.requestDeadlineAt ?? null,
    requestFailures: budget.requestFailures,
    stalled: budget.stalled,
    ...fence,
    safeToReplay: fence.replayFence === 'none',
    outcome: status.outcome,
    errorCategory: status.errorCategory ?? null,
    selectedAt: record.selectedAt,
    finishedAt: status.finishedAt ?? null,
  });
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

function cloneStructuredValue(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: cloneStructuredValue(item, seen),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return output;
}

function addStringDescriptor(descriptors, parent, key) {
  if (parent && typeof parent[key] === 'string') {
    descriptors.push({ kind: 'value', parent, key, value: parent[key] });
  }
}

function collectModelControlled(node, parent, key, descriptors, seen = new WeakSet()) {
  if (typeof node === 'string') {
    addStringDescriptor(descriptors, parent, key);
    return;
  }
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      collectModelControlled(node[index], node, index, descriptors, seen);
    }
    return;
  }
  for (const objectKey of Object.keys(node)) {
    descriptors.push({ kind: 'key', parent: node, key: objectKey, value: objectKey });
    collectModelControlled(node[objectKey], node, objectKey, descriptors, seen);
  }
}

function collectToolResultContent(content, parent, key, descriptors) {
  if (typeof content === 'string') {
    addStringDescriptor(descriptors, parent, key);
    return;
  }
  if (!content || typeof content !== 'object') return;
  if (!Array.isArray(content)) {
    collectModelControlled(content, parent, key, descriptors);
    return;
  }
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (typeof block === 'string') {
      addStringDescriptor(descriptors, content, index);
    } else if (block && typeof block === 'object' && typeof block.text === 'string') {
      addStringDescriptor(descriptors, block, 'text');
    } else if (block && typeof block === 'object' && block.content != null) {
      collectToolResultContent(block.content, block, 'content', descriptors);
    } else {
      collectModelControlled(block, content, index, descriptors);
    }
  }
}

function collectMessageContent(content, descriptors, contentParent = null, contentKey = null) {
  if (typeof content === 'string') {
    addStringDescriptor(descriptors, contentParent, contentKey);
    return;
  }
  const blocks = Array.isArray(content) ? content : [content];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const parent = Array.isArray(content) ? content : null;
    const key = Array.isArray(content) ? index : null;
    if (typeof block === 'string') {
      if (parent) addStringDescriptor(descriptors, parent, key);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'thinking')
        && typeof block[block.type] === 'string') {
      addStringDescriptor(descriptors, block, block.type);
    } else if (block.type === 'tool_use') {
      collectModelControlled(block.input, block, 'input', descriptors);
    } else if (block.type === 'tool_result') {
      collectToolResultContent(block.content, block, 'content', descriptors);
    } else {
      for (const field of ['text', 'thinking']) addStringDescriptor(descriptors, block, field);
      if (block.input != null) collectModelControlled(block.input, block, 'input', descriptors);
      if (block.content != null) collectToolResultContent(block.content, block, 'content', descriptors);
    }
  }
}

function applySemanticRedactions(descriptors, secrets) {
  for (const descriptor of descriptors) descriptor.redacted = descriptor.value;
  // Consumers flatten structures in different legitimate ways: display code
  // joins values/content blocks, diagnostic code may enumerate keys, and JSON
  // inspectors see a key followed by its value. Cover all three exact semantic
  // projections without treating protocol metadata as model-controlled text.
  for (const select of [
    descriptor => descriptor.kind === 'value',
    descriptor => descriptor.kind === 'key',
    () => true,
  ]) {
    const selected = descriptors.filter(select);
    const redacted = redactExactSecretFragments(selected.map(item => item.redacted), secrets);
    selected.forEach((descriptor, index) => { descriptor.redacted = redacted[index]; });
  }
  if (!descriptors.some(descriptor => descriptor.redacted !== descriptor.value)) return false;
  // Values must move before keys: a later key rename would otherwise make a
  // value write recreate the original secret-bearing property name.
  descriptors.forEach((descriptor) => {
    if (descriptor.kind === 'value' && descriptor.redacted !== descriptor.value) {
      descriptor.parent[descriptor.key] = descriptor.redacted;
    }
  });
  descriptors.forEach((descriptor) => {
    if (descriptor.kind !== 'key' || descriptor.redacted === descriptor.value) return;
    const property = Object.getOwnPropertyDescriptor(descriptor.parent, descriptor.key);
    if (!property) return;
    let targetKey = descriptor.redacted;
    let collision = 2;
    while (Object.prototype.hasOwnProperty.call(descriptor.parent, targetKey)
        && targetKey !== descriptor.key) {
      targetKey = `${descriptor.redacted}#${collision++}`;
    }
    delete descriptor.parent[descriptor.key];
    Object.defineProperty(descriptor.parent, targetKey, property);
  });
  return true;
}

function scrubProviderSemanticStructure(event, secrets) {
  if (!event || typeof event !== 'object') return redactProviderRouteCapability(event);
  const output = cloneStructuredValue(event);
  const descriptors = [];
  if ((output.type === 'assistant' || output.type === 'user') && output.message?.content != null) {
    collectMessageContent(output.message.content, descriptors, output.message, 'content');
  } else if (output.type === 'tool_start' || output.type === 'tool_update') {
    collectModelControlled(output.input, output, 'input', descriptors);
  } else if (output.type === 'tool_result') {
    collectToolResultContent(output.content, output, 'content', descriptors);
  }
  const changed = applySemanticRedactions(descriptors, secrets);
  return redactProviderRouteCapability(changed ? output : event);
}

function createProviderAttemptRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const nextId = typeof options.nextId === 'function'
    ? options.nextId
    : prefix => `${prefix}_${crypto.randomUUID()}`;
  const emit = typeof options.emit === 'function' ? options.emit : null;
  const audit = typeof options.audit === 'function' ? options.audit : null;
  const resolveProviderRevision = typeof options.resolveProviderRevision === 'function'
    ? options.resolveProviderRevision : null;
  // 终端会话（tmux 里的长活 CLI）没有回合，它的路由能力存在会话记录上，由宿主注入
  // 一个只读反查（见 src/providers/terminal-route.js）。没有这个端口时，终端路由照旧
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
    options.runtimeEpoch || `runtime_${crypto.randomUUID()}`,
    'runtimeEpoch',
  );
  const currentBySession = new (getNative().RustCurrentAttempts)();
  const generations = new (getNative().RustProviderAttemptGenerations)();
  const proxyProducers = new (getNative().RustMainProducers)();
  const nonMainProxyProducers = new (getNative().RustNonMainProducers)();
  const streamRedactors = new Map();
  // Live host ports only: Rust owns admission; callbacks retain the current
  // record identity until runner, audit and quota effects move out of Node.
  // Usage attribution and proxy outcomes (provider_outcome.rs) also read the
  // current record table and a fresh proxyContext per lookup.
  const proxyPort = Object.freeze({
    runtimeEpoch, quotaGuard, resolveTerminalRoute, resolveProviderRevision,
    snapshot, auditOnly, poisonProxyAttempt, now, producerStaleGraceMs,
    proxyProducers, nonMainProxyProducers, ProviderAttemptError,
    currentBySession, proxyContext,
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

  // Wire key `routePhase` (was `phase`): the attempt lifecycle enum used to
  // collide with the heartbeat and auto-route enums under one key. The local
  // argument keeps the name `phase`.
  function emitRoute(record, phase, extra = {}) {
    if (!emit || !record) return;
    const fence = record.lifecycle.snapshot();
    const event = Object.freeze({
      type: 'provider_route_event',
      version: 1,
      providerRouteScope: 'attempt',
      runtimeEpoch: record.runtimeEpoch,
      routePhase: phase,
      sessionId: record.sessionId,
      turnId: record.turnId,
      cli: record.cli,
      decisionId: record.decisionId,
      routeAttemptId: record.routeAttemptId,
      routeGeneration: record.routeGeneration,
      attemptNo: record.attemptNo,
      providerId: record.providerId,
      providerName: record.providerName,
      protocol: record.protocol,
      model: record.model,
      providerRevision: record.providerRevision,
      replayFence: fence.replayFence,
      safeToReplay: fence.replayFence === 'none',
      ts: Number(now()),
      ...extra,
    });
    try { emit(record.sessionId, event); } catch (_) {}
  }

  function beginAttempt(input = {}) {
    const sessionId = required(input.sessionId, 'sessionId');
    if (!currentBySession.beginAdmission(sessionId)) {
      throw new ProviderAttemptError('provider attempt is still running', 'PROVIDER_ATTEMPT_IN_FLIGHT');
    }
    let admitted = true;
    const releaseAdmission = () => {
      if (!admitted) return;
      admitted = false;
      currentBySession.endAdmission(sessionId);
    };
    try {
      return beginAttemptAdmitted(input, sessionId, releaseAdmission);
    } finally {
      releaseAdmission();
    }
  }

  function beginAttemptAdmitted(input, sessionId, releaseAdmission) {
    const turnId = required(input.turnId, 'turnId');
    const cli = required(input.cli, 'cli').toLowerCase();
    const providerId = required(input.providerId, 'providerId');
    const providerName = clean(input.providerName) || providerId;
    const protocol = required(input.protocol, 'protocol');
    const model = clean(input.model);
    const providerRevision = required(input.providerRevision, 'providerRevision');
    const subagentProviderId = clean(input.subagentProviderId);
    if (subagentProviderId) required(subagentProviderId, 'subagentProviderId');
    const attemptNo = positiveInteger(input.attemptNo, 'attemptNo');
    const continuation = input.continuation === true;
    const previous = currentBySession.get(sessionId) || null;
    const previousFence = previous?.lifecycle.snapshot();
    const previousBudget = previous?.lifecycle.budget();
    const producer = proxyProducers.getActive(sessionId);

    getNative().providerDrainStaleProducers(sessionId, turnId, producer, proxyPort);

    getNative().providerValidateAttemptTransition(previous, previousFence,
      { turnId, continuation, providerId, model, protocol, attemptNo }, ProviderAttemptError);

    const routeGeneration = generations.next(sessionId);
    // This is a route capability, and for a resident lane it is scoped to the
    // spawn contract rather than to the physical attempt. A resident child bakes
    // its route at spawn — Claude through ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN
    // and its --model argv, codex through CODEX_HOME's managed config.toml — and
    // the lane recycles the warm process the moment any of that changes. A
    // capability that rotated at every attempt would therefore respawn the child
    // on every turn and residency could never take effect. The caller that
    // builds the spawn (provider-invocation) passes the hash of exactly what it
    // bakes; a resident lane keeps its capability while that hash is unchanged
    // and mints a fresh one the moment it moves (provider, revision, model,
    // effort, agent, argv). Per-turn lanes, having no warm process to protect,
    // still rotate at every physical attempt, and a caller that declines to
    // prove its spawn contract gets that same rotation.
    //
    // Attempt identity does not rest on this token: sameAttempt() compares
    // routeAttemptId/routeGeneration/turnId, which keep incrementing. What a
    // stable capability gives up is only the provable staleness of an orphaned
    // child belonging to an *earlier* attempt of the same spawn contract — such
    // a child can now reach the proxy during a later attempt. That is
    // attribution scope, not credential exposure: the child only ever holds this
    // opaque capability, never a real upstream key.
    const spawnKey = clean(input.spawnKey);
    const proxyRouteToken = isResident(cli) && spawnKey && previous
      && previous.proxyRouteToken && previous.spawnKey === spawnKey
      ? previous.proxyRouteToken
      : required(nextId('proxy-route'), 'proxyRouteToken');
    const decisionId = previous && previous.turnId === turnId
      ? previous.decisionId : required(nextId('route-decision'), 'decisionId');
    const routeAttemptId = required(nextId('route-attempt'), 'routeAttemptId');
    const record = {
      runtimeEpoch,
      decisionId,
      routeAttemptId,
      sessionId,
      turnId,
      cli,
      providerId,
      providerName,
      protocol,
      model,
      providerRevision,
      allowedSubProviderIds: Object.freeze([...new Set(
        [providerId, subagentProviderId].filter(Boolean),
      )]),
      attemptNo,
      routeGeneration,
      proxyRouteToken,
      spawnKey,
      stallTimeoutMs: stallTimeoutBudget(input.stallTimeoutMs),
      requestTimeoutMs: stallTimeoutBudget(input.requestTimeoutMs),
      connectTimeoutMs: stallTimeoutBudget(input.connectTimeoutMs),
      lifecycle: new (getNative().RustProviderAttemptLifecycle)(
        continuation && previous ? previousFence.replayFence : 'none',
        !!(continuation && previousFence?.visibleOutputObserved),
        !!(continuation && previousFence?.toolIntentObserved),
        !!(continuation && previousFence?.sideEffectObserved),
        previous?.turnId === turnId ? previousBudget.requestDeadlineAt ?? null : null,
        previous?.turnId === turnId ? previousBudget.requestFailures : 0,
        { runtimeEpoch, routeAttemptId, routeGeneration, turnId }),
      proxyFailure: null,
      selectedAt: Number(now()),
    };
    currentBySession.set(sessionId, record);
    // The installed record now owns the session. Event callbacks may finish it
    // and synchronously start the next attempt, as they could before admission
    // acquired its own guard.
    releaseAdmission();
    const switched = previous && previous.turnId === turnId
      && (previous.providerId !== providerId || previous.model !== model);
    emitRoute(record, continuation ? 'continued' : switched ? 'switched' : 'selected', switched ? {
      fromProviderId: previous.providerId,
      fromModel: previous.model,
      reasonCode: clean(input.reasonCode) || 'attempt_failover',
    } : { reasonCode: clean(input.reasonCode) || 'route_resolved' });
    return snapshot(record);
  }

  function finishAttempt(reference, facts = {}) {
    const sessionId = clean(reference && reference.sessionId);
    const record = currentBySession.get(sessionId);
    if (!sameAttempt(record, reference)) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'finish',
        runtimeEpoch: clean(reference && reference.runtimeEpoch) || null,
        turnId: clean(reference && reference.turnId) || null,
        routeAttemptId: clean(reference && reference.routeAttemptId) || null,
        routeGeneration: Number(reference && reference.routeGeneration) || null,
        currentRouteAttemptId: record ? record.routeAttemptId : null,
        currentRouteGeneration: record ? record.routeGeneration : null,
      });
      return Object.freeze({ ok: false, code: 'stale_attempt', attempt: snapshot(record) });
    }
    if (!record.lifecycle.running()) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'finish',
        runtimeEpoch: record.runtimeEpoch, turnId: record.turnId,
        routeAttemptId: record.routeAttemptId, routeGeneration: record.routeGeneration,
        currentRouteAttemptId: record.routeAttemptId,
        currentRouteGeneration: record.routeGeneration,
      });
      return Object.freeze({ ok: false, code: 'attempt_not_running', attempt: snapshot(record) });
    }
    const outcome = clean(facts.outcome) || 'released';
    record.lifecycle.setOutcome(outcome);
    const errorCategory = clean(facts.errorCategory) || null;
    record.lifecycle.setErrorCategory(errorCategory);
    record.lifecycle.setFinishedAt(Number(now()));
    emitRoute(record, outcome === 'failed' ? 'failed'
      : outcome === 'succeeded' ? 'succeeded' : 'released', {
      errorCategory,
      reasonCode: clean(facts.reasonCode) || null,
    });
    streamRedactors.delete(record.routeAttemptId);
    return Object.freeze({ ok: true, code: null, attempt: snapshot(record) });
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
    if (trustedError && record.lifecycle.reconcileHostError()) {
      if (previousFence !== 'none') {
        auditOnly(sessionId, {
          type: 'provider_fence_reconciled', runtimeEpoch: record.runtimeEpoch,
          turnId: record.turnId, routeAttemptId: record.routeAttemptId,
          routeGeneration: record.routeGeneration, providerId: record.providerId,
          fromFence: previousFence, replayFence: 'none', reasonCode: 'host_error_envelope',
        });
      }
      return Object.freeze({ accepted: true, code: null, ...snapshot(record) });
    }
    const fence = fenceForEvent(event);
    if (record.lifecycle.advance(fence)) {
      auditOnly(sessionId, {
        type: 'provider_fence_advanced', runtimeEpoch: record.runtimeEpoch,
        turnId: record.turnId, routeAttemptId: record.routeAttemptId,
        routeGeneration: record.routeGeneration, providerId: record.providerId,
        fromFence: previousFence, replayFence: fence,
      });
    }
    return Object.freeze({ accepted: true, code: null, ...snapshot(record) });
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
    finishAttempt(snapshot(record), {
      outcome: 'failed', errorCategory: 'adapter_configuration', reasonCode,
    });
  }

  function authorizeProxyRequest(input = {}) {
    return getNative().providerAuthorizeProxyRequest(input, proxyContext(input), proxyPort);
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
    return snapshot(currentBySession.get(clean(sessionId)));
  }

  return Object.freeze({
    beginAttempt,
    finishAttempt,
    acceptEvent,
    forceReleaseProducers,
    observeEvent,
    observeProxyDelta,
    scrubAttemptStructure,
    scrubAttemptEvent,
    authorizeProxyRequest,
    onProxyActivity,
    attributeProxyUsage,
    observeProxyOutcome,
    proxyFailure,
    proxySessionId,
    resolveProxySessionId,
    // 终端那条路由（长活会话，没有回合）自己拼能力段：与 proxySessionId 同一种形状，
    // 只是令牌来自会话记录而不是内存里的 attempt（见 src/providers/terminal-route.js）。
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

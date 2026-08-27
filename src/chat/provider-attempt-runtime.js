'use strict';

const crypto = require('node:crypto');
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
  const text = clean(value);
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ProviderAttemptError(`${label} is required`, 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ProviderAttemptError(`${label} must be a positive integer`, 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return number;
}

function createProviderRevision(input = {}) {
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const aliasMap = summary.aliasMap && typeof summary.aliasMap === 'object'
    ? Object.fromEntries(Object.keys(summary.aliasMap).sort().map(key => [key, summary.aliasMap[key]]))
    : {};
  const safeRoute = {
    cli: required(input.cli, 'cli').toLowerCase(),
    providerId: required(input.providerId, 'providerId'),
    protocol: required(input.protocol, 'protocol'),
    model: required(input.model, 'model'),
    appType: clean(summary.appType) || null,
    baseUrl: clean(summary.baseUrl) || null,
    source: clean(summary.source) || null,
    apiFormat: clean(summary.apiFormat) || null,
    wireApi: clean(summary.wireApi) || null,
    aliasMap,
    useChatResponsesProxy: summary.useChatResponsesProxy === true,
    isOfficial: summary.isOfficial === true,
  };
  return `prv_${crypto.createHash('sha256').update(JSON.stringify(safeRoute)).digest('hex').slice(0, 24)}`;
}

function providerAttemptFields(reference) {
  if (!reference || typeof reference !== 'object') {
    throw new ProviderAttemptError('provider attempt is required', 'PROVIDER_ATTEMPT_IDENTITY_INVALID');
  }
  return Object.freeze({
    providerRouteProtocolVersion: 1,
    providerRouteScope: 'attempt',
    cli: required(reference.cli, 'cli'),
    runtimeEpoch: required(reference.runtimeEpoch, 'runtimeEpoch'),
    turnId: required(reference.turnId, 'turnId'),
    decisionId: required(reference.decisionId, 'decisionId'),
    routeAttemptId: required(reference.routeAttemptId, 'routeAttemptId'),
    routeGeneration: positiveInteger(reference.routeGeneration, 'routeGeneration'),
    attemptNo: positiveInteger(reference.attemptNo, 'attemptNo'),
    providerId: required(reference.providerId, 'providerId'),
    providerRevision: required(reference.providerRevision, 'providerRevision'),
  });
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

function contentBlocks(event) {
  const content = event && event.message && event.message.content;
  return Array.isArray(content) ? content : [];
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
  if (!event || typeof event !== 'object') return 'none';
  if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
    const nested = event.event;
    const block = nested.content_block;
    const delta = nested.delta;
    if (nested.type === 'content_block_start' && block && block.type === 'tool_use') {
      return 'tool_intent';
    }
    if (nested.type === 'content_block_delta' && delta) {
      if (delta.type === 'input_json_delta') return 'tool_intent';
      if ((delta.type === 'text_delta' || delta.type === 'thinking_delta')
          && clean(delta.text || delta.thinking)) return 'visible_output';
    }
  }
  if (event.type === 'part_delta') {
    const delta = event.delta && typeof event.delta === 'object' ? event.delta : event;
    if (delta.type === 'tool' || delta.tool || delta.toolId) return 'tool_intent';
    if (delta.type === 'text' || delta.type === 'reasoning' || delta.type === 'source') {
      return 'visible_output';
    }
    return 'none';
  }
  if (event.type === 'reasoning' && clean(event.text)) return 'visible_output';
  if (event.type === 'assistant_text' && clean(event.text)) return 'visible_output';
  if (event.type === 'tool_start' || event.type === 'tool_update') return 'tool_intent';
  if (event.type === 'tool_result') return 'side_effect';
  if (event.type === 'assistant') {
    const blocks = contentBlocks(event);
    if (blocks.length > 0 && blocks.every(block => block && block.type === 'text')
        && event[HOST_ERROR_ENVELOPE] === true) return 'none';
    if (blocks.some(block => block && block.type === 'tool_use')) return 'tool_intent';
    if (blocks.some(block => block && block.type === 'thinking'
        && clean(block.thinking || block.text))) return 'visible_output';
    if (blocks.some(block => block && block.type === 'text' && clean(block.text))) return 'visible_output';
  }
  if (event.type === 'user'
      && contentBlocks(event).some(block => block && block.type === 'tool_result')) {
    return 'side_effect';
  }
  return 'none';
}

function snapshot(record) {
  if (!record) return null;
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
    replayFence: record.replayFence,
    visibleOutputObserved: record.visibleOutputObserved,
    toolIntentObserved: record.toolIntentObserved,
    sideEffectObserved: record.sideEffectObserved,
    safeToReplay: record.replayFence === 'none',
    outcome: record.outcome,
    errorCategory: record.errorCategory,
    selectedAt: record.selectedAt,
    finishedAt: record.finishedAt,
  });
}

function sameAttempt(record, reference) {
  return !!(record && reference
    && record.runtimeEpoch === reference.runtimeEpoch
    && record.routeAttemptId === reference.routeAttemptId
    && record.routeGeneration === Number(reference.routeGeneration)
    && record.turnId === reference.turnId);
}

function encodeProxySessionId(sessionId, token) {
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64url');
  return `pr1.${encode(sessionId)}.${encode(token)}`;
}

function decodeProxySessionId(value) {
  const raw = clean(value);
  if (!raw.startsWith('pr1.')) return { sessionId: raw, token: null, encoded: false };
  const parts = raw.split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return { sessionId: '', token: null, encoded: true };
  try {
    const sessionId = Buffer.from(parts[1], 'base64url').toString('utf8');
    const token = Buffer.from(parts[2], 'base64url').toString('utf8');
    if (!sessionId || !token || sessionId.length > 256 || token.length > 256
        || /[\u0000-\u001f\u007f]/.test(sessionId + token)) {
      return { sessionId: '', token: null, encoded: true };
    }
    return { sessionId, token, encoded: true };
  } catch (_) {
    return { sessionId: '', token: null, encoded: true };
  }
}

function reattributedUsage(event, facts) {
  const source = { ...event };
  // ProviderRouterPort has already normalized CPR input once. Its derived `uo_*`
  // id hashes the encoded process capability; changing that session to the real
  // one requires downstream validation to derive a fresh id from sourceEventId.
  if (/^uo_[a-f0-9]{32}$/.test(clean(source.eventId))) delete source.eventId;
  return Object.freeze({ ...source, ...facts });
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
  const currentBySession = new Map();
  const generationBySession = new Map();
  const proxyProducers = new Map();
  const endedProxyProducers = new Map();
  const nonMainProxyProducers = new Map();
  const endedNonMainProxyProducers = new Map();
  const streamRedactors = new Map();

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

  function emitRoute(record, phase, extra = {}) {
    if (!emit || !record) return;
    const event = Object.freeze({
      type: 'provider_route_event',
      version: 1,
      providerRouteScope: 'attempt',
      runtimeEpoch: record.runtimeEpoch,
      phase,
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
      replayFence: record.replayFence,
      safeToReplay: record.replayFence === 'none',
      ts: Number(now()),
      ...extra,
    });
    try { emit(record.sessionId, event); } catch (_) {}
  }

  function beginAttempt(input = {}) {
    const sessionId = required(input.sessionId, 'sessionId');
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
    const producer = proxyProducers.get(sessionId);

    if (producer && producer.count > 0) {
      const ageMs = Number(now()) - (Number(producer.lastRequestAt) || 0);
      // Draining normally requires the proxy 'end'. A request whose CLI
      // consumer was killed or crashed mid-stream never gets one, so waiting
      // forever would wedge every later attempt of this session (the in-memory
      // counter previously only cleared on server restart). Past the grace the
      // entry is orphaned: proxyRouteToken rotation already makes any late
      // traffic from it unattributable to the new attempt.
      if (Number.isFinite(ageMs) && producer.lastRequestAt
          && ageMs >= producerStaleGraceMs) {
        auditOnly(sessionId, {
          type: 'provider_producer_force_drained',
          runtimeEpoch,
          turnId,
          count: producer.count,
          ageMs,
          graceMs: producerStaleGraceMs,
          reason: 'stale_producer_grace',
        });
        proxyProducers.delete(sessionId);
        endedProxyProducers.delete(sessionId);
      } else {
        throw new ProviderAttemptError(
          'previous provider request has not drained',
          'PROVIDER_PRODUCER_NOT_DRAINED',
        );
      }
    }

    if (previous && previous.turnId === turnId
        && previous.replayFence !== 'none' && !continuation) {
      throw new ProviderAttemptError(
        'provider attempt cannot be replayed after observable output or tool intent',
        'PROVIDER_REPLAY_FENCE_CLOSED',
      );
    }
    if (previous && previous.outcome === 'running') {
      throw new ProviderAttemptError('provider attempt is still running', 'PROVIDER_ATTEMPT_IN_FLIGHT');
    }
    if (previous && previous.turnId === turnId) {
      if (previous.outcome === 'succeeded') {
        throw new ProviderAttemptError(
          'a succeeded turn cannot start another provider attempt',
          'PROVIDER_TURN_ALREADY_SUCCEEDED',
        );
      }
      if (continuation && (previous.providerId !== providerId
          || previous.model !== model || previous.protocol !== protocol)) {
        throw new ProviderAttemptError(
          'a continuation must retain the concrete provider route',
          'PROVIDER_CONTINUATION_ROUTE_CHANGED',
        );
      }
      if (attemptNo <= previous.attemptNo) {
        throw new ProviderAttemptError('attemptNo must increase within one turn', 'PROVIDER_ATTEMPT_SEQUENCE_INVALID');
      }
    }

    const routeGeneration = (generationBySession.get(sessionId) || 0) + 1;
    generationBySession.set(sessionId, routeGeneration);
    // This is an invocation-attempt capability, never a warm-process identity.
    // Rotating at every physical attempt makes an old main/background producer
    // unambiguously stale. Claude's chat-stream already fingerprints ANTHROPIC_*
    // env and recycles the idle process with --resume when this URL changes.
    const proxyRouteToken = required(nextId('proxy-route'), 'proxyRouteToken');
    const record = {
      runtimeEpoch,
      decisionId: previous && previous.turnId === turnId
        ? previous.decisionId : required(nextId('route-decision'), 'decisionId'),
      routeAttemptId: required(nextId('route-attempt'), 'routeAttemptId'),
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
      replayFence: continuation && previous ? previous.replayFence : 'none',
      visibleOutputObserved: !!(continuation && previous && previous.visibleOutputObserved),
      toolIntentObserved: !!(continuation && previous && previous.toolIntentObserved),
      sideEffectObserved: !!(continuation && previous && previous.sideEffectObserved),
      outcome: 'running',
      errorCategory: null,
      selectedAt: Number(now()),
      finishedAt: null,
    };
    currentBySession.set(sessionId, record);
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
    if (record.outcome !== 'running') {
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
    record.outcome = outcome;
    record.errorCategory = clean(facts.errorCategory) || null;
    record.finishedAt = Number(now());
    emitRoute(record, outcome === 'failed' ? 'failed'
      : outcome === 'succeeded' ? 'succeeded' : 'released', {
      errorCategory: record.errorCategory,
      reasonCode: clean(facts.reasonCode) || null,
    });
    streamRedactors.delete(record.routeAttemptId);
    return Object.freeze({ ok: true, code: null, attempt: snapshot(record) });
  }

  function acceptEvent(reference) {
    const sessionId = clean(reference && reference.sessionId);
    const record = currentBySession.get(sessionId);
    if (sameAttempt(record, reference) && record.outcome === 'running') return true;
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
    if (!sameAttempt(record, reference) || record.outcome !== 'running') {
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
    const fence = fenceForEvent(event);
    const previousFence = record.replayFence;
    if (FENCE_ORDER[fence] > FENCE_ORDER[previousFence]) {
      record.replayFence = fence;
      auditOnly(sessionId, {
        type: 'provider_fence_advanced', runtimeEpoch: record.runtimeEpoch,
        turnId: record.turnId, routeAttemptId: record.routeAttemptId,
        routeGeneration: record.routeGeneration, providerId: record.providerId,
        fromFence: previousFence, replayFence: fence,
      });
    }
    if (FENCE_ORDER[fence] >= FENCE_ORDER.visible_output) record.visibleOutputObserved = true;
    if (FENCE_ORDER[fence] >= FENCE_ORDER.tool_intent) record.toolIntentObserved = true;
    if (FENCE_ORDER[fence] >= FENCE_ORDER.side_effect) record.sideEffectObserved = true;
    return Object.freeze({ accepted: true, code: null, ...snapshot(record) });
  }

  function proxyContext(input = {}) {
    const decoded = decodeProxySessionId(input.sessionId);
    const record = currentBySession.get(decoded.sessionId);
    return {
      sessionId: decoded.sessionId,
      token: decoded.token,
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
    if (!record || record.outcome !== 'running') return;
    finishAttempt(snapshot(record), {
      outcome: 'failed', errorCategory: 'adapter_configuration', reasonCode,
    });
  }

  function authorizeProxyRequest(input = {}) {
    const context = proxyContext(input);
    const { sessionId, record } = context;
    const reject = (code, poison = false) => {
      if (poison) poisonProxyAttempt(record, code);
      auditOnly(sessionId, {
        type: 'provider_proxy_request_rejected', operation: 'proxy_preflight', code,
        runtimeEpoch: record ? record.runtimeEpoch : runtimeEpoch,
        turnId: record ? record.turnId : null,
        routeAttemptId: record ? record.routeAttemptId : null,
        routeGeneration: record ? record.routeGeneration : null,
        providerId: clean(input.providerId) || null,
      });
      return Object.freeze({ ok: false, code, sessionId: sessionId || null });
    };
    if (!sessionId || !context.exact) return reject('proxy_route_capability_mismatch');
    if (!record || record.outcome !== 'running') return reject('proxy_attempt_not_running');
    const role = clean(input.role || input.roleKind || 'main').toLowerCase();
    if (role === 'main' && clean(input.providerId)
        && clean(input.providerId) !== record.providerId) {
      return reject('provider_route_mismatch', true);
    }
    if (role !== 'main' && role !== 'aux' && clean(input.providerId)
        && !record.allowedSubProviderIds.includes(clean(input.providerId))) {
      return reject('provider_subroute_not_allowed', true);
    }
    if (resolveProviderRevision) {
      let revisionMatches = false;
      try { revisionMatches = clean(resolveProviderRevision(record, input)) === record.providerRevision; }
      catch (_) {}
      if (!revisionMatches) return reject('provider_revision_mismatch', true);
    }
    return Object.freeze({ ok: true, code: null, sessionId, attempt: snapshot(record) });
  }

  function markAmbiguousProducer(sessionId) {
    const producer = proxyProducers.get(sessionId);
    if (producer && producer.count > 0) {
      producer.count += 1;
      producer.ambiguous = true;
      producer.lastRequestAt = Number(now());
    } else {
      proxyProducers.set(sessionId, {
        attempt: null, proxyRouteToken: null, count: 1, ambiguous: true,
        lastRequestAt: Number(now()),
      });
    }
  }

  // Cancel/kill hook: the stopped CLI process was the proxy request's only
  // downstream consumer, so its in-flight upstream can no longer produce a
  // meaningful 'end'. Release the session's MAIN producer accounting
  // immediately (non-main/background producers are untouched: background work
  // legitimately outlives the cancelled turn). Attributability stays safe
  // because proxyRouteToken rotates on every physical attempt.
  function forceReleaseProducers(sessionId, reason = 'force_release') {
    const id = clean(sessionId);
    if (!id) return Object.freeze({ ok: false, code: 'invalid_session' });
    const producer = proxyProducers.get(id);
    if (!producer || producer.count <= 0) {
      return Object.freeze({ ok: true, code: 'no_producers', released: 0 });
    }
    const released = producer.count;
    auditOnly(id, {
      type: 'provider_producer_force_drained',
      runtimeEpoch,
      turnId: producer.attempt ? producer.attempt.turnId : null,
      count: released,
      ageMs: Number(now()) - (Number(producer.lastRequestAt) || 0),
      reason: clean(reason) || 'force_release',
    });
    proxyProducers.delete(id);
    endedProxyProducers.delete(id);
    return Object.freeze({ ok: true, code: 'released', released });
  }

  function nonMainProducerKey(context, event, role) {
    return [context.sessionId, context.token || (role === 'aux' ? 'aux' : ''),
      role, clean(event.providerId)].join('\u0000');
  }

  function onNonMainProxyActivity(context, event, role, phase) {
    const { sessionId, record } = context;
    const key = nonMainProducerKey(context, event, role);
    if (phase === 'request') {
      if (role !== 'aux' && (!context.exact || !record || record.outcome !== 'running')) return null;
      endedNonMainProxyProducers.delete(key);
      const producer = nonMainProxyProducers.get(key);
      if (producer) {
        producer.count += 1;
        producer.ambiguous = true;
      } else {
        nonMainProxyProducers.set(key, {
          sessionId, count: 1, ambiguous: false,
        });
      }
      return Object.freeze({ sessionId });
    }
    const producer = nonMainProxyProducers.get(key);
    if (!producer) return null;
    if (phase === 'end') {
      producer.count = Math.max(0, producer.count - 1);
      if (producer.count === 0) {
        nonMainProxyProducers.delete(key);
        if (!producer.ambiguous) {
          endedNonMainProxyProducers.set(key, Object.freeze({ sessionId }));
          if (endedNonMainProxyProducers.size > 2_048) {
            endedNonMainProxyProducers.delete(endedNonMainProxyProducers.keys().next().value);
          }
        }
      }
    }
    return Object.freeze({ sessionId });
  }

  function onProxyActivity(event = {}) {
    const context = proxyContext(event);
    const { sessionId, record } = context;
    if (!sessionId) return null;
    const role = clean(event.role || event.roleKind).toLowerCase();
    const phase = clean(event.phase).toLowerCase();
    if (role && role !== 'main') {
      return onNonMainProxyActivity(context, event, role, phase);
    }
    if (!context.exact) {
      if (phase === 'request') {
        markAmbiguousProducer(sessionId);
        poisonProxyAttempt(record, 'proxy_route_token_mismatch');
      } else if (phase === 'end') {
        const producer = proxyProducers.get(sessionId);
        if (producer) {
          producer.count = Math.max(0, producer.count - 1);
          if (producer.count === 0) proxyProducers.delete(sessionId);
        }
      }
      return null;
    }
    if (role !== 'main') return record && record.outcome === 'running' ? snapshot(record) : null;
    if (phase === 'request') {
      endedProxyProducers.delete(sessionId);
      const producer = proxyProducers.get(sessionId);
      let revisionMatches = true;
      if (record && resolveProviderRevision) {
        try { revisionMatches = clean(resolveProviderRevision(record, event)) === record.providerRevision; }
        catch (_) { revisionMatches = false; }
      }
      if (!record || record.outcome !== 'running'
          || !revisionMatches
          || (clean(event.providerId) && clean(event.providerId) !== record.providerId)) {
        markAmbiguousProducer(sessionId);
        poisonProxyAttempt(record, !revisionMatches
          ? 'provider_revision_mismatch' : 'provider_route_mismatch');
        return null;
      }
      if (producer && producer.count > 0) {
        producer.count += 1;
        producer.ambiguous = true;
        producer.lastRequestAt = Number(now());
      } else {
        proxyProducers.set(sessionId, {
          attempt: snapshot(record), proxyRouteToken: record.proxyRouteToken,
          count: 1, ambiguous: false, lastRequestAt: Number(now()),
        });
      }
      return snapshot(record);
    }
    if (phase === 'end') {
      const producer = proxyProducers.get(sessionId);
      if (!producer) return null;
      producer.count = Math.max(0, producer.count - 1);
      if (producer.count === 0) {
        proxyProducers.delete(sessionId);
        if (!producer.ambiguous && producer.attempt) {
          endedProxyProducers.set(sessionId, {
            attempt: producer.attempt, proxyRouteToken: producer.proxyRouteToken,
          });
        } else {
          endedProxyProducers.delete(sessionId);
        }
      }
      return producer.attempt || null;
    }
    return record && record.outcome === 'running' ? snapshot(record) : null;
  }

  function boundProxyAttempt(input = {}) {
    const context = proxyContext(input);
    if (!context.exact) return null;
    const producer = proxyProducers.get(context.sessionId);
    if (!producer || producer.count !== 1 || producer.ambiguous || !producer.attempt
        || producer.proxyRouteToken !== context.token) return null;
    const record = context.record;
    if (!sameAttempt(record, producer.attempt) || record.outcome !== 'running') return null;
    if (clean(input.providerId) && clean(input.providerId) !== record.providerId) return null;
    if (clean(input.role || input.roleKind).toLowerCase() !== 'main') return null;
    return snapshot(record);
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
    const context = proxyContext(event);
    const sessionId = context.sessionId;
    const role = clean(event.role || event.roleKind).toLowerCase();
    // A warm Claude process may finish its main result while a background/sub
    // request is still pending. The process capability proves the real session,
    // but not which logical turn owns that non-main request, so never fabricate a
    // complete main-attempt tuple for it. The host still records its session-level
    // usage while excluding it from attempt/TaskRun attribution.
    if (role !== 'main') {
      const key = nonMainProducerKey(context, event, role);
      const active = nonMainProxyProducers.get(key);
      let producerBound = !!(active && active.count === 1 && !active.ambiguous);
      if (!producerBound && endedNonMainProxyProducers.has(key)) {
        producerBound = true;
        endedNonMainProxyProducers.delete(key);
      }
      return reattributedUsage(event, {
        sessionId, routeAttribution: 'ambiguous', producerBound,
      });
    }
    let attempt = boundProxyAttempt(event);
    if (!attempt) {
      const ended = endedProxyProducers.get(sessionId);
      const record = currentBySession.get(sessionId);
      if (ended && context.token === ended.proxyRouteToken
          && sameAttempt(record, ended.attempt)
          && (!clean(event.providerId) || clean(event.providerId) === ended.attempt.providerId)) {
        attempt = ended.attempt;
        endedProxyProducers.delete(sessionId);
      }
    }
    if (!attempt) {
      auditOnly(sessionId, {
        type: 'provider_attempt_late_ignored', operation: 'proxy_usage',
        runtimeEpoch, turnId: null, routeAttemptId: null, routeGeneration: null,
        providerId: clean(event.providerId) || null,
        currentRouteAttemptId: snapshotSession(sessionId)?.routeAttemptId || null,
        currentRouteGeneration: snapshotSession(sessionId)?.routeGeneration || null,
      });
      return reattributedUsage(event, {
        sessionId,
        routeAttribution: 'ambiguous',
      });
    }
    return reattributedUsage(event, {
      sessionId,
      turnId: attempt.turnId,
      runtimeEpoch: attempt.runtimeEpoch,
      decisionId: attempt.decisionId,
      routeAttemptId: attempt.routeAttemptId,
      routeGeneration: attempt.routeGeneration,
      attemptNo: attempt.attemptNo,
      routeAttribution: 'exact',
      providerRevision: attempt.providerRevision,
    });
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
    proxySessionId,
    resolveProxySessionId,
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

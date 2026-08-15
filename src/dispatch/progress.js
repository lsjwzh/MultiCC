'use strict';

const MAX_PROGRESS_CHARS = 4_000;
const MAX_SEEN = 128;
const MAX_REASONING_MEMORY_CHARS = 16_000;

function cleanChunk(value) {
  // Progress crosses a session boundary. Accept only provider-normalized string
  // leaves; coercing arbitrary objects would risk surfacing tool payloads or raw
  // protocol envelopes as "[object Object]" (or through a custom toString()).
  const text = typeof value === 'string' ? value : '';
  return text ? text.slice(0, MAX_PROGRESS_CHARS) : '';
}

function textDeltaFromPart(delta) {
  if (!delta || typeof delta !== 'object') return '';
  const type = String(delta.type || '');
  if (type === 'text') return cleanChunk(delta.text);
  if (type === 'content_block_delta' && delta.delta?.type === 'text_delta') {
    return cleanChunk(delta.delta.text);
  }
  if (type === 'text_delta') return cleanChunk(delta.text);
  if (type === 'response.output_text.delta' || type === 'output_text_delta') {
    return cleanChunk(delta.delta);
  }
  return '';
}

function reasoningDeltaFromPart(delta) {
  if (!delta || typeof delta !== 'object') return '';
  const type = String(delta.type || '');

  // MultiCC's provider proxy normalizes Codex/OpenCode reasoning to this shape.
  if (type === 'reasoning') return cleanChunk(delta.text);

  // Claude stream-json emits an Anthropic content_block_delta wrapper. Only the
  // public thinking text is forwarded; signatures and redacted_thinking blocks
  // deliberately have no allow-listed path here.
  if (type === 'content_block_delta' && delta.delta?.type === 'thinking_delta') {
    return cleanChunk(delta.delta.thinking);
  }
  if (type === 'thinking_delta') return cleanChunk(delta.thinking);

  // Keep exact Responses API reasoning-summary variants for proxy versions that
  // have not yet normalized them to { type: 'reasoning', text }.
  if (type === 'response.reasoning_summary_text.delta'
      || type === 'response.reasoning_text.delta') {
    return cleanChunk(delta.delta);
  }
  return '';
}

function createSafeProgressReducer(onProgress, options = {}) {
  if (typeof onProgress !== 'function') {
    throw new TypeError('dispatch progress callback is required');
  }
  const sourceCli = typeof options.cli === 'string' ? options.cli : '';
  let snapshot = '';
  let reasoningMemory = '';
  const seen = new Set();

  function emit(kind, message) {
    const text = cleanChunk(message);
    if (!text) return;
    const key = `${kind}\0${text}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_SEEN) seen.delete(seen.values().next().value);
    seen.add(key);
    try { onProgress({ kind, message: text }); } catch (_) {}
  }

  function rememberReasoning(text) {
    reasoningMemory = `${reasoningMemory}${text}`.slice(-MAX_REASONING_MEMORY_CHARS);
  }

  function emitReasoning(value, { snapshot: isSnapshot = false } = {}) {
    const text = cleanChunk(value);
    if (!text) return;

    // Codex/OpenCode can first stream reasoning deltas and later emit the same
    // reasoning as a completed item. Claude can do the equivalent with a final
    // thinking block. Suppress that completed replay without suppressing the
    // live fragments the caller is already seeing.
    if (isSnapshot && reasoningMemory.includes(text)) return;
    emit('reasoning', text);
    rememberReasoning(text);
  }

  function pushPart(part) {
    const reasoning = reasoningDeltaFromPart(part);
    if (reasoning) emitReasoning(reasoning);
    else emit('text', textDeltaFromPart(part));
  }

  function push(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'part_delta') {
      // Claude's proxy sidecar duplicates its native stream_event. Match the
      // Web/App consumer and keep the native stream as the single authority.
      if (sourceCli === 'claude') return;
      pushPart(event.delta);
      return;
    }
    if (event.type === 'stream_event') {
      pushPart(event.event);
      return;
    }
    if (event.type === 'reasoning' || event.type === 'thinking') {
      emitReasoning(event.text, { snapshot: event.snapshot !== false });
      return;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const text = event.message.content
        .filter(block => block?.type === 'text')
        .map(block => cleanChunk(block.text))
        .join('');
      if (event.message.textSnapshot === true) {
        const delta = text.startsWith(snapshot) ? text.slice(snapshot.length) : text;
        snapshot = text;
        emit('text', delta);
      } else {
        snapshot += text;
        emit('text', text);
      }
      const reasoning = event.message.content
        .filter(block => block?.type === 'thinking')
        .map(block => cleanChunk(block.thinking))
        .filter(Boolean)
        .join('');
      emitReasoning(reasoning, { snapshot: true });
      const tools = event.message.content
        .filter(block => block?.type === 'tool_use'
          && typeof block.name === 'string'
          && block.name !== 'Thinking')
        .map(block => block.name.slice(0, 120));
      for (const name of tools) emit('tool', `正在执行：${name}`);
      return;
    }
    if (event.type === 'progress_heartbeat') {
      const phase = String(event.phase || '').trim();
      const tool = String(event.safeToolKind || '').trim();
      emit('status', tool ? `${phase || 'working'} · ${tool}` : phase);
      return;
    }
    if (event.type === 'error') {
      emit('error', event.error || event.message || 'worker error');
    }
  }

  return Object.freeze({ push });
}

// Server wiring for the sync dispatch progress bridge: subscribe to the
// normalized chat stream, filtered down to one dispatch operation's target
// session. Extracted from server.js — accessors keep it decoupled from the
// server's session maps (cliOf: persisted metadata, activeTurnOf/streamReplayOf:
// live in-memory state).
function createDispatchProgressSubscription({
  bus,
  createReducer = createSafeProgressReducer,
  cliOf,
  activeTurnOf,
  streamReplayOf,
} = {}) {
  if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') {
    throw new TypeError('dispatch progress subscription requires a bus');
  }
  return function subscribeDispatchProgress({ operationId, targetSessionId, onProgress } = {}) {
    const reducer = createReducer(onProgress, { cli: cliOf(targetSessionId) });
    const belongsToOperation = () => {
      const turn = activeTurnOf(targetSessionId);
      return turn?.lineage?.kind === 'dispatch'
        && turn.lineage.operationId === operationId;
    };
    const handle = (sessionId, payload) => {
      if (sessionId !== targetSessionId || !belongsToOperation()) return;
      try { reducer.push(payload); } catch (_) {}
    };
    bus.on('chat:stream-progress', handle);

    // Admission may start an idle worker before dispatch_master has returned
    // far enough to attach this listener. Replay the bounded current-turn
    // stream once so the first deltas are not lost; the reducer suppresses
    // duplicates.
    if (belongsToOperation()) {
      const replay = streamReplayOf(targetSessionId);
      if (Array.isArray(replay)) {
        for (const event of replay) reducer.push(event);
      }
    }
    return () => bus.off('chat:stream-progress', handle);
  };
}

module.exports = {
  createSafeProgressReducer,
  createDispatchProgressSubscription,
  reasoningDeltaFromPart,
  textDeltaFromPart,
};

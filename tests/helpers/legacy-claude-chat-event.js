'use strict';

// Frozen oracle for the pre-migration chat reducer. This is the Node
// implementation of applyClaudeChatEvent, its claude-api-error-message state
// machine and its normalization helpers, copied before the move to
// native/addon/src/chat_events.rs. Host effects go through the same `ports`
// names the native reducer uses, so a differential run compares decisions,
// mutations and ordering — not I/O. Do not "improve" this file: it is the
// reference the Rust reducer must match byte-for-byte.
//
// Unchanged kernels that were already native before this batch (route
// redaction, error-envelope detection, completion persistence, recordResultEvent)
// are imported, exactly as the old code imported them.
const { detectErrorEnvelope, envelopeSourceFor } = require('../../src/chat/api-error-policy');
const { redactProviderRouteCapability } = require('../../src/observability');
const { recordResultEvent } = require('../../src/chat/turn-lifecycle');
const { canPersistAdapterCompletion } = require('../../src/chat/adapter-completion');

function statusOf(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 100 && number <= 599 ? Math.round(number) : null;
}

function apiErrorMessageOf(evt) {
  if (!evt || evt.type !== 'assistant' || !Array.isArray(evt.message?.content)) return null;
  const flagged = evt.is_api_error_message === true || evt.isApiErrorMessage === true
    || (typeof evt.error === 'string' && evt.error !== '' && evt.message.model === '<synthetic>');
  if (!flagged) return null;
  const text = evt.message.content
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text || '')).join('');
  const requestId = evt.request_id || evt.requestId || null;
  return {
    text,
    httpStatus: statusOf(evt.api_error_status ?? evt.apiErrorStatus),
    cliError: typeof evt.error === 'string' && evt.error ? evt.error : null,
    requestId,
    key: evt.uuid ? String(evt.uuid) : requestId ? `${requestId}\0${text}` : null,
  };
}

function stateOf(runner) {
  if (!runner || typeof runner !== 'object') return null;
  if (!runner.claudeApiError) runner.claudeApiError = { seen: new Set(), pending: null };
  return runner.claudeApiError;
}

function intercept(ports, runner, evt, cs, context = {}) {
  const info = apiErrorMessageOf(evt);
  if (!info) return null;
  const state = stateOf(runner);
  if (!state) return null;
  if (info.key && state.seen.has(info.key)) {
    ports.logger?.info?.('claude_api_error_message_dedup', {
      sessionId: context.sessionId, turnId: context.turnId, requestId: info.requestId,
    });
    return 'drop';
  }
  if (info.key) state.seen.add(info.key);
  const baseText = state.pending?.appended
    ? String(state.pending.bodyBefore || '') : String(cs.currentAssistantText || '');
  const errorOnly = !baseText.trim()
    && !(Array.isArray(cs.currentToolCalls) ? cs.currentToolCalls.length : 0);
  state.pending = { ...info, appended: errorOnly, bodyBefore: errorOnly ? '' : null };
  ports.logger?.info?.('claude_api_error_message', {
    sessionId: context.sessionId, turnId: context.turnId, httpStatus: info.httpStatus,
    cliError: info.cliError, appended: errorOnly,
  });
  return errorOnly ? 'append' : 'suppress';
}

function recoverPendingEvent(ports, runner, cs, evt, context = {}) {
  if (!evt || evt.type !== 'assistant' || !Array.isArray(evt.message?.content)) return false;
  const hasOutput = evt.message.content.some(block => (block?.type === 'text' && String(block.text || '').trim())
    || block?.type === 'tool_use');
  if (!hasOutput) return false;
  const state = stateOf(runner);
  if (!state || !state.pending) return false;
  const pending = state.pending;
  state.pending = null;
  if (pending.appended) cs.currentAssistantText = String(pending.bodyBefore || '');
  ports.logger?.info?.('claude_api_error_recovered', {
    sessionId: context.sessionId, turnId: context.turnId, httpStatus: pending.httpStatus,
  });
  return true;
}

function apiErrorEnvelope(runner, providerName, currentText) {
  const pending = stateOf(runner)?.pending;
  if (!pending) return null;
  const text = String(pending.text || '');
  const parsed = detectErrorEnvelope(providerName, text);
  const body = pending.appended
    ? (String(pending.bodyBefore || '').trim() ? pending.bodyBefore : null)
    : (String(currentText || '').trim() ? currentText : null);
  return Object.freeze({
    source: envelopeSourceFor(providerName),
    provider: String(providerName || 'claude').toLowerCase(),
    message: text,
    httpStatus: pending.httpStatus ?? parsed?.httpStatus ?? null,
    body,
    structured: true,
    cliError: pending.cliError,
  });
}

function normalizeClaudeToolResultContent(content) {
  if (!Array.isArray(content)) {
    const text = typeof content === 'string' ? content : JSON.stringify(content == null ? '' : content);
    const safeText = redactProviderRouteCapability(text);
    return { text: safeText, content: safeText };
  }
  const joined = content.map(item => item && typeof item.text === 'string' ? item.text : '').join('');
  const safeText = redactProviderRouteCapability(joined);
  const nonText = content.filter(item => !item || typeof item.text !== 'string')
    .map(item => redactProviderRouteCapability(item));
  return {
    text: safeText,
    content: [...(safeText ? [{ type: 'text', text: safeText }] : []), ...nonText],
  };
}

function normalizeClaudeAssistantSnapshot(event, currentText) {
  if (!event || event.type !== 'assistant' || !Array.isArray(event.message?.content)) return event;
  const nonText = event.message.content.filter(block => block?.type !== 'text');
  return {
    ...event,
    message: {
      ...event.message,
      textSnapshot: true,
      content: [
        ...(currentText ? [{ type: 'text', text: redactProviderRouteCapability(currentText) }] : []),
        ...nonText,
      ],
    },
  };
}

function closeOpenThinkingTool(cs) {
  const tools = cs && Array.isArray(cs.currentToolCalls) ? cs.currentToolCalls : [];
  const at = Date.now();
  for (const tool of tools) {
    if (!tool || tool.name !== 'Thinking') continue;
    if (!Number.isFinite(tool.startedAt) || Number.isFinite(tool.endedAt)) continue;
    tool.endedAt = at;
  }
}

function markReplaySafeAssistantEnvelope(ports, event, providerName) {
  if (!event || event.type !== 'assistant' || !Array.isArray(event.message?.content)) return event;
  const blocks = event.message.content;
  if (!blocks.length || !blocks.every(block => block && block.type === 'text')) return event;
  const envelope = detectErrorEnvelope(providerName, blocks.map(block => String(block.text || '')).join(''));
  return envelope && envelope.body == null ? ports.markHostEnvelope(event) : event;
}

function applyClaudeChatEventLegacy(ports, cs, sessionName, evt, forward, turn, runner, providerName = 'claude') {
  if (!ports.isCurrent(cs, turn, runner)) return;
  evt = ports.scrub(runner.providerAttempt, evt);
  ports.touchActivity(sessionName, turn.turnId); ports.observeClaude(cs, evt);
  const apiErrorMode = intercept(ports, runner, evt, cs, { sessionId: sessionName, turnId: turn.turnId, logger: ports.logger });
  if (apiErrorMode === 'drop' || apiErrorMode === 'suppress') return;
  if (evt.type === 'assistant' && evt.message?.model) ports.noteReportedModel(sessionName, evt.message.model);
  if (evt.type === 'assistant' && evt.message?.content) {
    if (apiErrorMode !== 'append') recoverPendingEvent(ports, runner, cs, evt, { sessionId: sessionName, turnId: turn.turnId, logger: ports.logger });
    for (const block of evt.message.content) {
      if (block.type === 'text') {
        ports.updatePhase(sessionName, turn.turnId, 'thinking');
        cs.currentAssistantText = redactProviderRouteCapability(
          cs.currentAssistantText + String(block.text || ''),
        );
        ports.setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        ports.scheduleIncrementalSave(sessionName, cs);
      }
      if (block.type === 'tool_use') {
        ports.updatePhase(sessionName, turn.turnId, 'tool', block.name);
        cs.currentToolCalls.push({ name: block.name, input: block.input, id: block.id, startedAt: Date.now() });
        ports.backgroundRecordToolUseId(sessionName, block.id);
        if (block.name === 'TaskOutput') ports.backgroundMarkTaskOutputAwaiting(sessionName, block.input);
        const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
        if (editTools.includes(block.name)) {
          ports.setSessionStatus(sessionName, { status: 'editing', currentFile: block.input?.file_path || null });
        } else if (block.name === 'Bash') {
          ports.setSessionStatus(sessionName, { status: 'running', currentFile: null });
        } else {
          ports.setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        }
      }
    }
  }
  if (evt.type === 'user' && evt.message?.content) {
    const contentWasArray = Array.isArray(evt.message.content);
    const normalizedContent = [];
    for (const r of (contentWasArray ? evt.message.content : [evt.message.content])) {
      if (r.type === 'tool_result') {
        ports.updatePhase(sessionName, turn.turnId, 'thinking');
        const tc = cs.currentToolCalls.find(t => t.id === r.tool_use_id);
        const normalized = normalizeClaudeToolResultContent(r.content);
        if (tc) {
          tc.result = normalized.text;
          tc.is_error = r.is_error || false;
          tc.endedAt = Date.now();
          if (tc.result && tc.result.length > 1000) tc.result = tc.result.slice(0, 1000) + '...';
        }
        normalizedContent.push({ ...r, content: normalized.content });
      } else {
        normalizedContent.push(r);
      }
    }
    evt = { ...evt, message: { ...evt.message,
      content: contentWasArray ? normalizedContent : normalizedContent[0],
    } };
  }
  if (evt.type === 'result') {
    if (!runner.completionOutcome) {
      runner.pendingClaudeResult = evt;
      recordResultEvent(turn, runner, { current: true, persisted: false });
      return;
    }
    ports.updatePhase(sessionName, turn.turnId, 'finalizing');
    closeOpenThinkingTool(cs);
    cs.currentCost = evt.total_cost_usd || null;
    const resultCompletion = runner.completionOutcome;
    const resultSucceeded = canPersistAdapterCompletion(resultCompletion, ports.proxyFailure(runner.providerAttempt));
    const apiFailure = resultCompletion.state === 'failed' && resultCompletion.source === 'protocol';
    const detectedErrorEnvelope = apiErrorEnvelope(runner, providerName, cs.currentAssistantText) || detectErrorEnvelope(providerName, cs.currentAssistantText);
    const envelopeError = apiFailure ? null : detectedErrorEnvelope;
    if (envelopeError && envelopeError.body != null) {
      cs.currentAssistantText = envelopeError.body;
    }
    if (apiFailure || envelopeError) {
      ports.clearIncrementalSave(sessionName);
      cs._sawApiError = true;
      runner.sawApiError = true;
      const detail = evt.error && typeof evt.error === 'object' ? evt.error : {};
      runner.apiErrorRaw = detectedErrorEnvelope || {
        source: envelopeSourceFor(providerName),
        provider: providerName,
        code: evt.startup_failure_reason || detail.code || evt.subtype || detail.type, errors: evt.errors,
        httpStatus: detail.http_status || detail.status_code || detail.status || evt.http_status || evt.status_code || evt.status || evt.api_error_status,
        headers: detail.headers || evt.headers, requestId: detail.request_id || evt.request_id,
        message: detail.message || evt.result || evt.subtype || 'api_error',
      };
    }
    const usage = evt.usage || {};
    const contextTrace = ports.contextTrace(sessionName, cs);
    runner.pendingUsage = usage;
    if (resultSucceeded && !envelopeError && (cs.currentAssistantText || cs.currentToolCalls.length)) {
      const wasMapped = ports.isMapped(sessionName, cs);
      const resultDurable = ports.persistFinal(sessionName, cs, turn, runner, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        cost: cs.currentCost, usage: Object.keys(usage).length ? usage : undefined, ts: Date.now(),
        ...(contextTrace ? { contextTrace } : {}),
        turnTimings: ports.turnTimings(sessionName, turn.turnId),
      }, { resultEvent: true });
      if (!ports.isCurrent(cs, turn, runner) || (wasMapped && !ports.isMapped(sessionName, cs))) return;
      if (resultDurable) {
        ports.recordDurableUsage(sessionName, runner, usage);
        if (!ports.isCurrent(cs, turn, runner) || (wasMapped && !ports.isMapped(sessionName, cs))) return;
        cs.chatTurnCount++;
        cs._resultSaved = true;
      }
      ports.clearIncrementalSave(sessionName);
    } else {
      recordResultEvent(turn, runner, { current: true, persisted: false });
    }
    const _resultDurationMs = cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined;
    forward({ type: 'result', total_cost_usd: evt.total_cost_usd, usage, durationMs: _resultDurationMs,
      num_turns: cs.chatTurnCount, ...(contextTrace ? { contextTrace } : {}),
      ...ports.modelAttribution(cs, turn, runner), ...ports.timelineField(cs) });
    ports.onTurnComplete(sessionName);
  }
  if (evt.type === 'system' && evt.subtype === 'init') { ports.noteReportedModel(sessionName, evt.model); return; }
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    const snapshot = normalizeClaudeAssistantSnapshot(evt, cs.currentAssistantText);
    forward(markReplaySafeAssistantEnvelope(ports, snapshot, providerName));
    return;
  }
  forward(evt);
}

module.exports = { applyClaudeChatEventLegacy, apiErrorMessageOf, statusOf };

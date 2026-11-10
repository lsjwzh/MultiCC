'use strict';

// The resident Claude CLI (`claude`, whose retired `claude-exp` id is an alias)
// renders an upstream
// failure as a synthetic assistant message (model "<synthetic>",
// is_api_error_message/api_error_status on the event, or the camelCase local
// transcript spelling). Its only content is an "API Error: …" envelope, and it
// is followed by a result carrying the real failure evidence.
//
// Treating that text as model output is wrong once the turn already has an
// answer: a background self-wake (task-notification) that gets rate limited
// would append the envelope to the persisted answer. The text regex at the
// turn boundary is the last line of defence and misses chains glued after an
// ASCII '.', so the host keeps the structured fact here instead. Classification
// still runs from message text + HTTP status exactly like the text envelope —
// the CLI labels every 429 "rate_limit", and feeding that label through as a
// code would override the quota-wall wording (see decideApiErrorPolicy).
const { detectErrorEnvelope, envelopeSourceFor } = require('./api-error-policy');

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
    // No uuid and no request id means no identity to deduplicate on.
    key: evt.uuid ? String(evt.uuid) : requestId ? `${requestId}\0${text}` : null,
  };
}

function stateOf(runner) {
  if (!runner || typeof runner !== 'object') return null;
  if (!runner.claudeApiError) runner.claudeApiError = { seen: new Set(), pending: null };
  return runner.claudeApiError;
}

// Returns null (not an API-error message), 'drop' (duplicate delivery),
// 'suppress' (turn already has output — keep the text out of the answer), or
// 'append' (error-only turn — keep today's behaviour so the error bubble and
// the safe-retry eligibility are unchanged).
function intercept(runner, evt, cs, context = {}) {
  const info = apiErrorMessageOf(evt);
  if (!info) return null;
  const state = stateOf(runner);
  if (!state) return null;
  if (info.key && state.seen.has(info.key)) {
    context.logger?.info?.('claude_api_error_message_dedup', {
      sessionId: context.sessionId, turnId: context.turnId, requestId: info.requestId,
    });
    return 'drop';
  }
  if (info.key) state.seen.add(info.key);
  // A pending appended envelope is the whole current text, so it must not count
  // as model output when a second envelope is glued onto it.
  const baseText = state.pending?.appended
    ? String(state.pending.bodyBefore || '') : String(cs.currentAssistantText || '');
  const errorOnly = !baseText.trim()
    && !(Array.isArray(cs.currentToolCalls) ? cs.currentToolCalls.length : 0);
  state.pending = { ...info, appended: errorOnly, bodyBefore: errorOnly ? '' : null };
  context.logger?.info?.('claude_api_error_message', {
    sessionId: context.sessionId, turnId: context.turnId, httpStatus: info.httpStatus,
    cliError: info.cliError, appended: errorOnly,
  });
  return errorOnly ? 'append' : 'suppress';
}

// A later real answer (text or tool_use) proves the failure was retried inside
// the CLI: forget the pending envelope and, in the error-only case, remove the
// text that was appended to the assistant state so it cannot reach a successful
// answer.
function recoverPendingEvent(runner, cs, evt, context = {}) {
  if (!evt || evt.type !== 'assistant' || !Array.isArray(evt.message?.content)) return false;
  const hasOutput = evt.message.content.some(block => (block?.type === 'text' && String(block.text || '').trim())
    || block?.type === 'tool_use');
  if (!hasOutput) return false;
  const state = stateOf(runner);
  if (!state || !state.pending) return false;
  const pending = state.pending;
  state.pending = null;
  if (pending.appended) cs.currentAssistantText = String(pending.bodyBefore || '');
  context.logger?.info?.('claude_api_error_recovered', {
    sessionId: context.sessionId, turnId: context.turnId, httpStatus: pending.httpStatus,
  });
  return true;
}

// Envelope-compatible with detectErrorEnvelope ({source, provider, message,
// httpStatus, body}) so every existing classifier and persistence path treats
// it identically. `body` is null for the whole-message (error-only) form.
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

// Boundary helper: returns the structured envelope and strips the envelope text
// from the assistant state whenever a partial body remains, so the persisted
// partial is the model answer and never "answer + API Error: …".
function boundaryEnvelope(runner, providerName, cs) {
  const envelope = apiErrorEnvelope(runner, providerName, cs?.currentAssistantText);
  if (envelope && envelope.body != null) cs.currentAssistantText = envelope.body;
  return envelope;
}

module.exports = { apiErrorMessageOf, intercept, recoverPendingEvent, apiErrorEnvelope, boundaryEnvelope };

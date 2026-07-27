'use strict';

const { assertDtoSafe } = require('./session-dto');

const API_VERSION = 'v1';
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeId(value, fallback = 'unknown') {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : fallback;
}

function requestContext(req, res) {
  const requestId = safeId((res && res.locals && res.locals.requestId) || (req && req.id));
  const correlationId = safeId(
    (res && res.locals && res.locals.correlationId) || (req && req.correlationId),
    requestId,
  );
  return { requestId, correlationId };
}

function withApiMeta(payload, context = {}) {
  const requestId = safeId(context.requestId);
  return {
    ...(payload && typeof payload === 'object' ? payload : { data: payload }),
    apiVersion: API_VERSION,
    requestId,
    correlationId: safeId(context.correlationId, requestId),
  };
}

function sanitizeErrorMessage(value, fallback = 'request_error') {
  let message = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\){1,}[^\s]*/g, '[path]')
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[path]');
  return message.slice(0, 240);
}

function createErrorDto({ message, code, requestId, correlationId } = {}) {
  const body = {
    ok: false,
    error: sanitizeErrorMessage(message),
    code: typeof code === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(code) ? code : 'request_error',
  };
  return withApiMeta(body, { requestId, correlationId });
}

function toProviderDto(source = {}) {
  const dto = {
    id: String(source.id || ''),
    appType: source.appType === 'codex' ? 'codex' : 'claude',
    protocol: ['anthropic', 'openai_responses', 'openai_chat'].includes(source.protocol) ? source.protocol : 'anthropic',
    apiFormat: ['anthropic', 'openai_responses', 'openai_chat'].includes(source.apiFormat) ? source.apiFormat : 'anthropic',
    wireApi: ['messages', 'responses', 'chat-completions', 'chat_completions'].includes(source.wireApi) ? source.wireApi : null,
    name: String(source.name || '').slice(0, 160),
    source: source.source === 'ccswitch' ? 'ccswitch' : 'local',
    model: typeof source.model === 'string' && source.model ? source.model.slice(0, 160) : null,
    modelOptions: Array.isArray(source.modelOptions)
      ? [...new Set(source.modelOptions.filter(item => typeof item === 'string').map(item => item.slice(0, 160)))].slice(0, 100)
      : [],
    aliasOnly: !!source.aliasOnly,
    useChatResponsesProxy: !!source.useChatResponsesProxy,
    compatibleClis: Array.isArray(source.compatibleClis) ? source.compatibleClis.filter(item => ['claude', 'codex', 'opencode'].includes(item)) : [],
    requiresConversionFor: Array.isArray(source.requiresConversionFor) ? source.requiresConversionFor.filter(item => ['codex'].includes(item)) : [],
    hasCredentials: !!source.hasToken,
    isOfficial: !!source.isOfficial,
  };
  if (!dto.id || !dto.name) throw new TypeError('provider DTO requires id and name');
  return assertDtoSafe(dto);
}

function toWaitDto(source = {}) {
  const dto = {
    id: String(source.id || ''),
    sessionId: String(source.sessionId || source.session || ''),
    mode: ['callback', 'delay'].includes(source.mode) ? source.mode : 'poll',
    checks: Math.max(0, Math.floor(Number(source.checks) || 0)),
    maxChecks: source.maxChecks == null ? null : Math.max(1, Math.floor(Number(source.maxChecks) || 1)),
    intervalSec: source.intervalSec == null ? null : Math.max(1, Number(source.intervalSec) || 1),
    createdAt: Number.isFinite(Number(source.createdAt)) ? new Date(Number(source.createdAt)).toISOString() : null,
  };
  if (!dto.id || !dto.sessionId) throw new TypeError('wait DTO requires id and sessionId');
  return assertDtoSafe(dto);
}

function toDispatchResultDto(source = {}) {
  const dto = {
    ok: source.ok === true,
    target: typeof source.target === 'string' ? source.target.slice(0, 160) : null,
    chatId: typeof source.chatId === 'string' ? source.chatId.slice(0, 160) : null,
    note: typeof source.note === 'string' ? source.note.slice(0, 240) : null,
  };
  return assertDtoSafe(dto);
}

// Compatibility WS envelope: event fields remain top-level so existing clients
// keep working; v1 consumers can key on apiVersion + type. Request/correlation
// ids are included when the originating operation supplies them.
function createWsEnvelope(payload = {}, context = {}) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    throw new TypeError('WebSocket envelope requires a string type');
  }
  const envelope = { ...payload, apiVersion: API_VERSION };
  if (context.requestId) envelope.requestId = safeId(context.requestId);
  if (context.correlationId) envelope.correlationId = safeId(context.correlationId, envelope.requestId || 'unknown');
  return envelope;
}

module.exports = {
  API_VERSION,
  createErrorDto,
  createWsEnvelope,
  requestContext,
  safeId,
  sanitizeErrorMessage,
  toDispatchResultDto,
  toProviderDto,
  toWaitDto,
  withApiMeta,
};

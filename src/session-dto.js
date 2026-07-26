'use strict';

// Public session contract. This boundary deliberately excludes filesystem and
// native-CLI implementation details (cwd/worktreePath/cliSessionId), large
// prompt/memory blobs, credentials, and Error objects.

const SUPPORTED_CLIS = new Set(['claude', 'codex', 'opencode', 'zcode', 'qoder']);
const SUPPORTED_KINDS = new Set(['chat', 'terminal']);
const SENSITIVE_KEY = /(?:token|secret|password|stack|(?:^|_)path|cwd|cliSessionId|worktree)/i;

function sanitizePublicText(value, max = 1000) {
  if (value === undefined || value === null || value === '') return null;
  return String(value)
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*([:=])\s*["']?[^\s,;"']+/gi, '$1$2[redacted]')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\){1,}[^\s]*/g, '[path]')
    .replace(/(?:\/[A-Za-z0-9._~@+-]+){2,}/g, '[path]')
    .slice(0, max);
}

function nullableString(value, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function subagentDto(value) {
  if (!value || typeof value !== 'object') return null;
  const providerId = nullableString(value.providerId, 160);
  const model = nullableString(value.model, 160);
  if (!providerId || !model) return null;
  return {
    providerId,
    model,
    effectiveModel: nullableString(value.effectiveModel, 160),
  };
}

function mergeStateDto(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ahead: Math.max(0, Number(value.ahead) || 0),
    behind: Math.max(0, Number(value.behind) || 0),
    dirty: !!value.dirty,
    mergeReady: !!value.mergeReady,
    rebaseInProgress: !!value.rebaseInProgress,
  };
}

function assertDtoSafe(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDtoSafe(item, `${location}[${index}]`));
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive DTO key at ${location}.${key}`);
    assertDtoSafe(child, `${location}.${key}`);
  }
  return value;
}

function toSessionDto(source = {}) {
  const cli = SUPPORTED_CLIS.has(source.cli) ? source.cli : 'claude';
  const kind = SUPPORTED_KINDS.has(source.kind) ? source.kind : 'terminal';
  const dto = {
    id: String(source.id || ''),
    dirId: nullableString(source.dirId, 160),
    type: 'session',
    cli,
    kind,
    label: nullableString(source.label, 160),
    model: nullableString(source.model, 160),
    effectiveModel: nullableString(source.effectiveModel, 160),
    effort: nullableString(source.effort, 80),
    effectiveEffort: nullableString(source.effectiveEffort, 80),
    agent: nullableString(source.agent, 160),
    provider: nullableString(source.provider, 160),
    experimentalMode: nullableString(source.experimentalMode, 80),
    subagent: subagentDto(source.subagent),
    autoCommit: !!source.autoCommit,
    autoDispatch: !!source.autoDispatch,
    createdAt: timestamp(source.createdAt),
    lastActivity: timestamp(source.lastActivity),
    clients: Math.max(0, Math.floor(Number(source.clients) || 0)),
    active: !!source.active,
    mergeState: mergeStateDto(source.mergeState),
  };
  if (!dto.id) throw new TypeError('session DTO requires id');
  return assertDtoSafe(dto);
}

module.exports = {
  SUPPORTED_CLIS,
  SUPPORTED_KINDS,
  assertDtoSafe,
  sanitizePublicText,
  toSessionDto,
};

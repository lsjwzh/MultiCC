'use strict';

const { providerSelectionDto } = require('./providers/auto-provider-config');

// Public session contract. This boundary deliberately excludes filesystem and
// native-CLI implementation details (cwd/worktreePath/cliSessionId), large
// prompt/memory blobs, credentials, and Error objects.

const SUPPORTED_CLIS = new Set(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok', 'commandcode', 'pi']);
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
    ...(value.inherited === true ? { inherited: true } : {}),
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

// Unattended mode state (docs/unattended-mode.md). Only the bounded public
// fields; counts are clamped the same way the Rust kernel clamps them.
const UNATTENDED_STATUSES = new Set(['active', 'achieved', 'needs_human', 'exhausted', 'stopped', 'error']);
const UNATTENDED_VERDICTS = new Set(['achieved', 'continue', 'needs_human']);

function unattendedDto(value) {
  if (!value || typeof value !== 'object') return null;
  const status = UNATTENDED_STATUSES.has(value.status) ? value.status : 'stopped';
  const criteria = Array.isArray(value.criteria)
    ? value.criteria.slice(0, 12).map(item => nullableString(item, 300)).filter(Boolean)
    : [];
  const history = Array.isArray(value.history)
    ? value.history.slice(-10).map(row => ({
      at: Math.max(0, Number(row && row.at) || 0),
      verdict: UNATTENDED_VERDICTS.has(row && row.verdict) ? row.verdict : 'continue',
      reason: nullableString(row && row.reason, 1000) || '',
    })) : [];
  const lastVerdict = value.lastVerdict && typeof value.lastVerdict === 'object'
    ? {
      verdict: UNATTENDED_VERDICTS.has(value.lastVerdict.verdict) ? value.lastVerdict.verdict : 'continue',
      reason: nullableString(value.lastVerdict.reason, 1000) || '',
      nextInstruction: nullableString(value.lastVerdict.nextInstruction, 4000) || '',
      humanReason: nullableString(value.lastVerdict.humanReason, 1000) || '',
      at: Math.max(0, Number(value.lastVerdict.at) || 0),
    } : null;
  const stall = value.stall && typeof value.stall === 'object' ? {
    sameInstruction: Math.max(0, Math.floor(Number(value.stall.sameInstruction) || 0)),
    auxFailures: Math.max(0, Math.floor(Number(value.stall.auxFailures) || 0)),
  } : { sameInstruction: 0, auxFailures: 0 };
  return {
    status,
    goal: nullableString(value.goal, 2000) || '',
    criteria,
    maxRounds: Math.min(200, Math.max(1, Math.floor(Number(value.maxRounds) || 30))),
    rounds: Math.max(0, Math.floor(Number(value.rounds) || 0)),
    startedAt: Math.max(0, Number(value.startedAt) || 0),
    updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    lastVerdict,
    history,
    stall,
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
    providerSelection: providerSelectionDto(source.providerSelection),
    experimentalMode: nullableString(source.experimentalMode, 80),
    subagent: subagentDto(source.subagent),
    autoCommit: source.autoCommit !== false,
    createdAt: timestamp(source.createdAt),
    lastActivity: timestamp(source.lastActivity),
    clients: Math.max(0, Math.floor(Number(source.clients) || 0)),
    active: !!source.active,
    workspaceState: ['planned', 'hibernated', 'hibernating', 'thawing'].includes(source.workspaceState)
      ? 'hibernated' : 'awake',
    lastWorkAt: timestamp(source.lastWorkAt || source.createdAt),
    hibernatedAt: timestamp(source.hibernatedAt),
    mergeState: mergeStateDto(source.mergeState),
    unattended: unattendedDto(source.unattended),
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
  unattendedDto,
};

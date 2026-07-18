'use strict';

// Narrow, immutable host-to-router DTO. A persisted MultiCC session must never
// cross the provider-router boundary: callers explicitly select only the fields
// the routing and usage contracts need.

const BINDING_BRAND = Symbol('MultiCC.ProviderBinding');
const ALLOWED_KEYS = new Set([
  'sessionId', 'cli', 'providerId', 'model',
  'roleKind', 'agentRole', 'routeName',
]);
const SUPPORTED_CLIS = new Set(['claude', 'codex', 'opencode', 'zcode']);
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const AGENT_ROLES = new Set(['default', 'worker', 'explorer', 'custom']);

class ProviderBindingError extends Error {
  constructor(message, code = 'INVALID_PROVIDER_BINDING') {
    super(message);
    this.name = 'ProviderBindingError';
    this.code = code;
  }
}

function assertRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderBindingError('ProviderBinding input must be an object');
  }
}

function cleanString(value, label, { required = false, max = 256 } = {}) {
  if (value == null || value === '') {
    if (required) throw new ProviderBindingError(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!text && required) throw new ProviderBindingError(`${label} is required`);
  if (!text) return null;
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ProviderBindingError(`${label} is invalid`);
  }
  return text;
}

function createProviderBinding(input) {
  assertRecord(input);
  const unexpected = Object.keys(input).filter(key => !ALLOWED_KEYS.has(key));
  if (unexpected.length) {
    throw new ProviderBindingError(
      `ProviderBinding rejects session fields: ${unexpected.sort().join(', ')}`,
      'PROVIDER_BINDING_TOO_BROAD',
    );
  }

  const sessionId = cleanString(input.sessionId, 'sessionId', { required: true });
  const cli = cleanString(input.cli, 'cli', { required: true, max: 32 }).toLowerCase();
  if (!SUPPORTED_CLIS.has(cli)) {
    throw new ProviderBindingError(`unsupported cli: ${cli}`);
  }
  const providerId = cleanString(input.providerId, 'providerId');
  const model = cleanString(input.model, 'model');
  const roleKind = cleanString(input.roleKind || 'main', 'roleKind', { required: true, max: 16 }).toLowerCase();
  if (!ROLE_KINDS.has(roleKind)) {
    throw new ProviderBindingError('roleKind must be main, sub, or aux');
  }

  let agentRole = cleanString(input.agentRole, 'agentRole', { max: 32 });
  let routeName = cleanString(input.routeName, 'routeName', { max: 64 });
  if (roleKind === 'sub') {
    agentRole = (agentRole || 'default').toLowerCase();
    if (!AGENT_ROLES.has(agentRole)) {
      throw new ProviderBindingError('sub agentRole must be default, worker, explorer, or custom');
    }
    routeName = (routeName || agentRole).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(routeName)) {
      throw new ProviderBindingError('routeName must be a valid agent route');
    }
  } else {
    if (agentRole) throw new ProviderBindingError(`agentRole is only valid for sub bindings`);
    if (routeName && routeName.toLowerCase() !== roleKind) {
      throw new ProviderBindingError(`${roleKind} routeName must be ${roleKind}`);
    }
    agentRole = null;
    routeName = roleKind;
  }

  const binding = {
    sessionId,
    cli,
    providerId,
    model,
    roleKind,
    agentRole,
    routeName,
  };
  Object.defineProperty(binding, BINDING_BRAND, { value: true });
  return Object.freeze(binding);
}

function isProviderBinding(value) {
  return !!(value && value[BINDING_BRAND] === true && Object.isFrozen(value));
}

function assertProviderBinding(value) {
  if (!isProviderBinding(value)) {
    throw new ProviderBindingError('a ProviderBinding created by createProviderBinding is required');
  }
  return value;
}

// Compatibility view for MultiCC's current providers module. This is still a
// narrow DTO: it deliberately omits labels, paths, tokens, task state and every
// other persisted-session field.
function toLegacyProviderView(value) {
  const binding = assertProviderBinding(value);
  return Object.freeze({
    id: binding.sessionId,
    cli: binding.cli,
    provider: binding.providerId,
    model: binding.model,
    roleKind: binding.roleKind,
    agentRole: binding.agentRole,
    routeName: binding.routeName,
  });
}

module.exports = {
  AGENT_ROLES,
  ROLE_KINDS,
  SUPPORTED_CLIS,
  ProviderBindingError,
  assertProviderBinding,
  createProviderBinding,
  isProviderBinding,
  toLegacyProviderView,
};

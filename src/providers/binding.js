'use strict';

// Narrow, immutable host-to-router DTO. A persisted MultiCC session must never
// cross the provider-router boundary: callers explicitly select only the fields
// the routing and usage contracts need.

const { getNative } = require('../native/binding');

const BINDING_BRAND = Symbol('MultiCC.ProviderBinding');
// Must track the chat CLI roster (cli-switch.js SUPPORTED_CHAT_CLIS). Providerless
// CLIs (qoder, codebuddy, dsh, gemini, grok) still cross this boundary; omitting
// one makes its sessions fail turn preparation with "unsupported cli".
const SUPPORTED_CLIS = new Set(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok', 'agy', 'commandcode', 'pi']);
const ROLE_KINDS = new Set(['main', 'sub', 'aux']);
const AGENT_ROLES = new Set(['default', 'worker', 'explorer', 'custom']);

class ProviderBindingError extends Error {
  constructor(message, code = 'INVALID_PROVIDER_BINDING') {
    super(message);
    this.name = 'ProviderBindingError';
    this.code = code;
  }
}

// Consumers can extend the exported sets and catch this exact error class.
const policyHost = { SUPPORTED_CLIS, ROLE_KINDS, AGENT_ROLES, ProviderBindingError };

function createProviderBinding(input) {
  const binding = getNative().normalizeProviderBinding(input, policyHost);
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
  return Object.freeze(getNative().legacyProviderBindingView(binding));
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

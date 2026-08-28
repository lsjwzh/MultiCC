'use strict';

// Persisted Auto Provider contract. The virtual selection never becomes
// session.provider: every physical invocation still resolves to one concrete
// provider id before the spawn proof is issued.

const PROTOCOLS = new Set(['anthropic', 'openai_responses', 'openai_chat']);
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MODEL_ID = /^[A-Za-z0-9._:/\[\]-]{1,100}$/;
const MAX_CANDIDATES = 12;
const MAX_ATTEMPTS = 4;

function fail(error, code = 'invalid_provider_selection') {
  return Object.freeze({ ok: false, value: null, error, code });
}

function protocolOf(provider) {
  const value = provider && (provider.protocol || provider.apiFormat);
  return PROTOCOLS.has(value) ? value : null;
}

function trustDomainOf(provider) {
  // Official login/subscription routes and user-managed API routes are separate
  // trust domains. Different user-managed vendors may fail over between one
  // another because the user explicitly placed them in the same candidate pool.
  return provider && provider.isOfficial ? 'official' : 'user-managed';
}

function catalogFor(options) {
  const providers = options && options.providers;
  const cli = String(options && options.cli || '');
  if (!providers || typeof providers.listProviders !== 'function'
      || typeof providers.appTypeForCli !== 'function') return null;
  const appType = providers.appTypeForCli(cli);
  const resolvedAppTypes = typeof providers.appTypesForCli === 'function'
    ? providers.appTypesForCli(cli)
    : (cli === 'opencode' || cli === 'zcode' ? ['claude', 'codex'] : (appType ? [appType] : []));
  const appTypes = Array.isArray(resolvedAppTypes) ? [...new Set(resolvedAppTypes)] : [];
  const list = appTypes.length
    ? appTypes.flatMap(type => providers.listProviders(type))
    : providers.listProviders(appType);
  return {
    appType,
    providers,
    cli,
    byId: new Map((Array.isArray(list) ? list : []).map(item => [String(item.id), item])),
  };
}

function validateCandidate(raw, index, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(`candidate ${index + 1} must be an object`, 'invalid_provider_candidate');
  }
  const providerId = String(raw.providerId || '').trim();
  if (!PROVIDER_ID.test(providerId) || /^auto(?::|$)/i.test(providerId)) {
    return fail(`candidate ${index + 1} has an invalid providerId`, 'invalid_provider_candidate');
  }
  const model = raw.model == null ? null : String(raw.model).trim() || null;
  if (model && !MODEL_ID.test(model)) {
    return fail(`candidate ${index + 1} has an invalid model`, 'invalid_provider_candidate');
  }
  const priority = raw.priority == null ? index + 1 : Number(raw.priority);
  if (!Number.isSafeInteger(priority) || priority < 1 || priority > 100) {
    return fail(`candidate ${index + 1} priority must be an integer from 1 to 100`, 'invalid_provider_candidate');
  }
  const enabled = raw.enabled !== false;
  let trustDomain = null;
  if (context.catalog) {
    const provider = context.catalog.byId.get(providerId);
    if (!provider) return fail(`provider ${providerId} was not found`, 'provider_not_found');
    const supports = typeof context.catalog.providers.providerSupportsCli === 'function'
      ? context.catalog.providers.providerSupportsCli(provider, context.catalog.cli)
      : Array.isArray(provider.compatibleClis) && provider.compatibleClis.includes(context.catalog.cli);
    if (!supports) return fail(`provider ${providerId} does not support ${context.catalog.cli}`, 'provider_cli_mismatch');
    if (protocolOf(provider) !== context.protocol) {
      return fail(`provider ${providerId} does not use ${context.protocol}`, 'provider_protocol_mismatch');
    }
    if (model && typeof context.catalog.providers.modelValidForProvider === 'function'
        && !context.catalog.providers.modelValidForProvider(provider.appType || context.catalog.appType, providerId, model)) {
      return fail(`model ${model} is not available for provider ${providerId}`, 'provider_model_mismatch');
    }
    trustDomain = trustDomainOf(provider);
  }
  return Object.freeze({ ok: true, value: Object.freeze({ providerId, model, priority, enabled }), trustDomain });
}

function validateProviderSelection(input, options = {}) {
  if (input == null || input === '' || (input && input.mode === 'manual')) {
    return Object.freeze({ ok: true, value: null, error: null, code: null });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.mode !== 'auto') {
    return fail('providerSelection must be null/manual or an Auto Provider object');
  }
  if (input.version != null && input.version !== 1) return fail('unsupported providerSelection version');
  const protocol = String(input.protocol || '').trim();
  if (!PROTOCOLS.has(protocol)) return fail('invalid Auto Provider protocol', 'invalid_provider_protocol');
  if (!Array.isArray(input.candidates) || input.candidates.length < 2
      || input.candidates.length > MAX_CANDIDATES) {
    return fail(`Auto Provider requires 2-${MAX_CANDIDATES} candidates`, 'invalid_provider_candidates');
  }
  // Missing/false keeps the v1 fail-closed behavior. A true value is the
  // persisted user authorization for a mixed Official/user-managed pool.
  const allowCrossTrust = input.allowCrossTrust === true;
  const catalog = catalogFor(options);
  const candidates = [];
  const ids = new Set();
  const trustDomains = new Set();
  for (let index = 0; index < input.candidates.length; index += 1) {
    const result = validateCandidate(input.candidates[index], index, { protocol, catalog });
    if (!result.ok) return result;
    if (ids.has(result.value.providerId)) {
      return fail(`provider ${result.value.providerId} appears more than once`, 'duplicate_provider_candidate');
    }
    ids.add(result.value.providerId);
    candidates.push(result.value);
    if (result.value.enabled && result.trustDomain) trustDomains.add(result.trustDomain);
  }
  const enabledCount = candidates.filter(candidate => candidate.enabled).length;
  if (enabledCount < 2) return fail('Auto Provider requires at least two enabled candidates', 'insufficient_provider_candidates');
  if (trustDomains.size > 1 && !allowCrossTrust) {
    return fail('Auto Provider candidates cross trust domains', 'provider_trust_mismatch');
  }
  const maxAttempts = input.maxAttempts == null ? Math.min(3, enabledCount) : Number(input.maxAttempts);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2
      || maxAttempts > Math.min(MAX_ATTEMPTS, enabledCount)) {
    return fail(`maxAttempts must be between 2 and ${Math.min(MAX_ATTEMPTS, enabledCount)}`, 'invalid_provider_attempt_budget');
  }
  const value = Object.freeze({
    version: 1,
    mode: 'auto',
    protocol,
    candidates: Object.freeze(candidates),
    maxAttempts,
    sticky: input.sticky !== false,
    allowCrossTrust,
  });
  return Object.freeze({ ok: true, value, error: null, code: null });
}

function primaryProviderCandidate(selection) {
  const candidates = selection && Array.isArray(selection.candidates) ? selection.candidates : [];
  let primary = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.enabled === false) continue;
    if (!primary || candidate.priority < primary.priority) primary = candidate;
  }
  return primary;
}

function normalizeStoredProviderSelection(input) {
  const result = validateProviderSelection(input);
  return result.ok ? result.value : null;
}

function providerSelectionDto(input) {
  const value = normalizeStoredProviderSelection(input);
  if (!value) return null;
  return {
    version: 1,
    mode: 'auto',
    protocol: value.protocol,
    candidates: value.candidates.map(candidate => ({ ...candidate })),
    maxAttempts: value.maxAttempts,
    sticky: value.sticky,
    allowCrossTrust: value.allowCrossTrust,
  };
}

module.exports = {
  MAX_ATTEMPTS,
  MAX_CANDIDATES,
  PROTOCOLS,
  normalizeStoredProviderSelection,
  primaryProviderCandidate,
  protocolOf,
  providerSelectionDto,
  trustDomainOf,
  validateProviderSelection,
};

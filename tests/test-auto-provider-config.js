'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  primaryProviderCandidate,
  providerSelectionDto,
  validateProviderSelection,
} = require('../src/auto-provider-config');

function catalog() {
  const list = [
    { id: 'empty', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], modelOptions: ['bad-model'] },
    { id: 'backup', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], modelOptions: ['good-model'] },
    { id: 'official', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], isOfficial: true, modelOptions: [] },
    { id: 'codex-only', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], modelOptions: [] },
    { id: 'responses-a', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex', 'opencode', 'zcode'], modelOptions: ['gpt-a'] },
    { id: 'responses-b', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex', 'opencode', 'zcode'], modelOptions: ['gpt-b'] },
  ];
  return {
    appTypeForCli: cli => cli === 'codex' ? 'codex' : 'claude',
    appTypesForCli: cli => cli === 'opencode' || cli === 'zcode'
      ? ['claude', 'codex'] : [cli === 'codex' ? 'codex' : 'claude'],
    listProviders: appType => list.filter(item => item.appType === appType),
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (_appType, providerId, model) => {
      const provider = list.find(item => item.id === providerId);
      return !!provider && provider.modelOptions.includes(model);
    },
  };
}

function selection(overrides = {}) {
  return {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1 },
      { providerId: 'backup', model: 'good-model', priority: 2 },
    ],
    maxAttempts: 2,
    sticky: true,
    ...overrides,
  };
}

test('Auto Provider validates a same-protocol concrete candidate pool', () => {
  const result = validateProviderSelection(selection(), { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, true);
  assert.deepEqual(providerSelectionDto(result.value), {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1, enabled: true },
      { providerId: 'backup', model: 'good-model', priority: 2, enabled: true },
    ],
    maxAttempts: 2,
    sticky: true,
    allowCrossTrust: false,
  });
});

test('Auto Provider rejects virtual, duplicate and cross-trust routes', () => {
  const providers = catalog();
  assert.equal(validateProviderSelection(selection({
    candidates: [{ providerId: 'auto:balanced' }, { providerId: 'backup' }],
  }), { cli: 'claude', providers }).code, 'invalid_provider_candidate');
  assert.equal(validateProviderSelection(selection({
    candidates: [{ providerId: 'empty' }, { providerId: 'empty' }],
  }), { cli: 'claude', providers }).code, 'duplicate_provider_candidate');
  assert.equal(validateProviderSelection(selection({
    candidates: [{ providerId: 'empty' }, { providerId: 'official' }],
  }), { cli: 'claude', providers }).code, 'provider_trust_mismatch');
  assert.equal(validateProviderSelection(selection({
    candidates: [{ providerId: 'empty' }, { providerId: 'codex-only' }],
  }), { cli: 'claude', providers }).code, 'provider_not_found');
});

test('manual mode clears Auto Provider without changing the concrete provider contract', () => {
  assert.deepEqual(validateProviderSelection(null), { ok: true, value: null, error: null, code: null });
  assert.deepEqual(validateProviderSelection({ mode: 'manual' }), { ok: true, value: null, error: null, code: null });
});

test('primary concrete fallback follows priority with original order as the tie-breaker', () => {
  const candidates = [
    { providerId: 'array-first', priority: 20, enabled: true },
    { providerId: 'priority-first', priority: 1, enabled: true },
    { providerId: 'same-priority-later', priority: 1, enabled: true },
  ];
  assert.equal(primaryProviderCandidate({ candidates }).providerId, 'priority-first');
  assert.equal(primaryProviderCandidate({ candidates: [{ ...candidates[0], enabled: false }, ...candidates.slice(1)] }).providerId, 'priority-first');
  assert.equal(primaryProviderCandidate(null), null);
});

test('OpenCode and ZCode Auto pools resolve both provider stores and validate models in the provider own store', () => {
  for (const cli of ['opencode', 'zcode']) {
    const providers = catalog();
    if (cli === 'zcode') delete providers.appTypesForCli;
    const checks = [];
    const validateModel = providers.modelValidForProvider;
    providers.modelValidForProvider = (appType, providerId, model) => {
      checks.push({ appType, providerId, model });
      return validateModel(appType, providerId, model);
    };
    const result = validateProviderSelection(selection({
      protocol: 'openai_responses',
      candidates: [
        { providerId: 'responses-a', model: 'gpt-a', priority: 1 },
        { providerId: 'responses-b', model: 'gpt-b', priority: 2 },
      ],
    }), { cli, providers });
    assert.equal(result.ok, true, `${cli}: ${result.error || 'valid'}`);
    assert.deepEqual(checks.map(item => item.appType), ['codex', 'codex']);
  }
});

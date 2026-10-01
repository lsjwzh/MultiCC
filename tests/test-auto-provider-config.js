'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  primaryProviderCandidate,
  providerSelectionDto,
  selectionClis,
  validateProviderSelection,
} = require('../src/providers/auto-provider-config');

function catalog() {
  const list = [
    { id: 'empty', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], modelOptions: ['bad-model'] },
    { id: 'backup', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], modelOptions: ['good-model'] },
    { id: 'official', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], isOfficial: true, modelOptions: [] },
    { id: 'codex-only', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], modelOptions: [] },
    { id: 'responses-a', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex', 'opencode', 'zcode'], modelOptions: ['gpt-a'] },
    { id: 'responses-b', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex', 'opencode', 'zcode'], modelOptions: ['gpt-b'] },
    // Cross-CLI fixtures: a claude-format route that also serves the opencode
    // lane (so one lane can be made to mix protocols), and a codex-format route
    // that speaks only a sibling lane of its app type (so a lane can refuse it
    // as a CLI mismatch rather than as a missing provider).
    { id: 'claude-multi', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude', 'opencode', 'codex'], modelOptions: ['multi-model'] },
    { id: 'codex-locked', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex-exp'], modelOptions: [] },
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

test('Auto Provider rejects virtual, duplicate and implicit cross-trust routes', () => {
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
    candidates: [{ providerId: 'empty' }, { providerId: 'official' }],
    allowCrossTrust: false,
  }), { cli: 'claude', providers }).code, 'provider_trust_mismatch');
  assert.equal(validateProviderSelection(selection({
    candidates: [{ providerId: 'empty' }, { providerId: 'codex-only' }],
  }), { cli: 'claude', providers }).code, 'provider_not_found');
});

test('Auto Provider permits an explicitly authorized cross-trust pool and preserves the flag in its DTO', () => {
  const result = validateProviderSelection(selection({
    candidates: [
      { providerId: 'official', priority: 1 },
      { providerId: 'backup', model: 'good-model', priority: 2 },
    ],
    allowCrossTrust: true,
  }), { cli: 'claude', providers: catalog() });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.allowCrossTrust, true);
  assert.equal(providerSelectionDto(result.value).allowCrossTrust, true);
});

test('a disabled candidate in another trust domain does not require cross-trust authorization', () => {
  const result = validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1 },
      { providerId: 'backup', model: 'good-model', priority: 2 },
      { providerId: 'official', priority: 3, enabled: false },
    ],
    allowCrossTrust: false,
  }), { cli: 'claude', providers: catalog() });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.allowCrossTrust, false);
  assert.equal(result.value.candidates.at(-1).enabled, false);
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

// ── cross-CLI pools ──────────────────────────────────────────────────────────
//
// A pool may span more than one CLI lane. A pool is cross-CLI as soon as one
// candidate names its lane; the others then belong to the session's current one.
// Everything is still resolved per lane: the catalog a candidate is checked
// against, the protocol it speaks and the key it is de-duplicated by.

function crossCliSelection(overrides = {}) {
  return {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    maxAttempts: 2,
    sticky: true,
    candidates: [
      { providerId: 'backup', model: 'good-model', priority: 1 },
      { providerId: 'codex-only', priority: 2, cli: 'codex' },
    ],
    ...overrides,
  };
}

test('a cross-CLI pool fills the home lane into the candidates that stay silent', () => {
  const result = validateProviderSelection(crossCliSelection(), { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, true, result.error);
  // Written out rather than left implicit: the stored pool has to read the same
  // whichever lane the session happens to be on later.
  assert.deepEqual(result.value.candidates.map(candidate => candidate.cli), ['claude', 'codex']);
  assert.deepEqual(selectionClis(result.value), ['claude', 'codex']);
  assert.equal(result.value.cliSwitch, 'failover');
  // The resolver keeps the home lane explicit on every candidate, so a target
  // lane can be scoped without re-deriving "which lane is implicit here".
  assert.equal(primaryProviderCandidate(result.value, 'claude').providerId, 'backup');
  assert.equal(primaryProviderCandidate(result.value, 'codex').providerId, 'codex-only');
});

test('a cross-CLI pool without a usable home lane rejects the candidates that stay silent', () => {
  const providers = catalog();
  const missing = validateProviderSelection(crossCliSelection(), { providers });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'invalid_provider_candidate');
  assert.match(missing.error, /candidate 1 must name its cli/);
  // A lane name the pool cannot switch to is no better than no lane at all.
  assert.equal(validateProviderSelection(crossCliSelection(), { cli: 'gemini', providers }).code,
    'invalid_provider_candidate');
});

test('every lane of a cross-CLI pool is checked against its own catalog', () => {
  const providers = catalog();
  // A codex route does not exist in the claude lane's store...
  assert.equal(validateProviderSelection(crossCliSelection({
    candidates: [
      { providerId: 'backup', model: 'good-model', priority: 1, cli: 'claude' },
      { providerId: 'codex-only', priority: 2, cli: 'claude' },
    ],
  }), { cli: 'claude', providers }).code, 'provider_not_found');
  // ...and a provider that exists but does not serve the lane is a CLI mismatch,
  // not a missing route.
  assert.equal(validateProviderSelection(crossCliSelection({
    candidates: [
      { providerId: 'codex-locked', priority: 1, cli: 'codex' },
      { providerId: 'responses-a', model: 'gpt-a', priority: 2, cli: 'codex' },
    ],
  }), { cli: 'claude', providers }).code, 'provider_cli_mismatch');
});

test('one route may serve two lanes but never twice in the same lane', () => {
  const providers = catalog();
  assert.equal(validateProviderSelection(crossCliSelection({
    protocol: 'openai_responses',
    candidates: [
      { providerId: 'responses-a', model: 'gpt-a', priority: 1, cli: 'codex' },
      { providerId: 'responses-a', model: 'gpt-a', priority: 2, cli: 'codex' },
    ],
  }), { cli: 'claude', providers }).code, 'duplicate_provider_candidate');
  // The same Anthropic-format key can be sold by two lanes; that is one route
  // per lane, which is exactly what the pool is allowed to express.
  const shared = validateProviderSelection(crossCliSelection({
    protocol: 'openai_responses',
    candidates: [
      { providerId: 'responses-a', model: 'gpt-a', priority: 1, cli: 'codex' },
      { providerId: 'responses-a', model: 'gpt-a', priority: 2, cli: 'opencode' },
    ],
  }), { cli: 'claude', providers });
  assert.equal(shared.ok, true, shared.error);
  assert.deepEqual(selectionClis(shared.value), ['codex', 'opencode']);
});

test('a lane may not mix protocols, and the pool must use its declared one', () => {
  const providers = catalog();
  const mixed = validateProviderSelection(crossCliSelection({
    protocol: 'openai_responses',
    candidates: [
      { providerId: 'responses-a', model: 'gpt-a', priority: 1, cli: 'opencode' },
      { providerId: 'claude-multi', priority: 2, cli: 'opencode' },
    ],
  }), { cli: 'claude', providers });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, 'provider_protocol_mismatch');
  assert.match(mixed.error, /candidates on opencode mix protocols/);
  // Every lane may agree with itself and still leave the declared protocol
  // unused — the pool would then spawn on a wire format it never declared.
  assert.equal(validateProviderSelection(crossCliSelection({
    protocol: 'openai_responses',
    candidates: [
      { providerId: 'backup', model: 'good-model', priority: 1, cli: 'claude' },
      { providerId: 'empty', model: 'bad-model', priority: 2, cli: 'claude' },
    ],
  }), { cli: 'claude', providers }).code, 'provider_protocol_mismatch');
});

test('cliSwitch is written only for a cross-CLI pool and defaults to failover', () => {
  const providers = catalog();
  assert.equal(validateProviderSelection(crossCliSelection(), { cli: 'claude', providers })
    .value.cliSwitch, 'failover');
  assert.equal(validateProviderSelection(crossCliSelection({ cliSwitch: 'routing' }), { cli: 'claude', providers })
    .value.cliSwitch, 'routing');
  assert.equal(validateProviderSelection(crossCliSelection({ cliSwitch: 'sometimes' }), { cli: 'claude', providers }).code,
    'invalid_provider_selection');
  // A single-lane pool never carries the key, so its wire JSON is unchanged.
  const legacy = validateProviderSelection(selection(), { cli: 'claude', providers });
  assert.equal('cliSwitch' in legacy.value, false);
  assert.equal('cliSwitch' in providerSelectionDto(legacy.value), false);
});

test('price tiering is accepted only without a hand-tagged ladder', () => {
  const providers = catalog();
  const priced = validateProviderSelection(selection({
    routing: { provider: 'jev', tiering: 'price' },
  }), { cli: 'claude', providers });
  assert.equal(priced.ok, true, priced.error);
  assert.equal(priced.value.routing.tiering, 'price');
  assert.deepEqual(priced.value.routing.tiers, []);
  // The ladder is recomputed from the price table every turn, so a hand-tagged
  // tier or a declared ladder next to it is a second ladder nobody reads.
  assert.equal(validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1, tier: 'weak' },
      { providerId: 'backup', model: 'good-model', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev', tiering: 'price' },
  }), { cli: 'claude', providers }).code, 'provider_routing_tier_mismatch');
  assert.equal(validateProviderSelection(selection({
    routing: { provider: 'jev', tiering: 'price', tiers: ['weak', 'strong'] },
  }), { cli: 'claude', providers }).code, 'provider_routing_tier_mismatch');
  // A manual pool keeps its DTO byte-identical: no tiering key at all.
  const manual = validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1, tier: 'weak' },
      { providerId: 'backup', model: 'good-model', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev' },
  }), { cli: 'claude', providers });
  assert.equal('tiering' in manual.value.routing, false);
});

test('an auto-model line needs routing before it can pick a model per turn', () => {
  const providers = catalog();
  const pinned = validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1, autoModel: true },
      { providerId: 'backup', model: 'good-model', priority: 2 },
    ],
  }), { cli: 'claude', providers });
  assert.equal(pinned.code, 'invalid_provider_candidate');
  assert.match(pinned.error, /cannot pin a model and pick one automatically/);
  // Without routing there is nothing to pick by: "the provider's first model" is
  // not a decision, so the line is refused rather than defaulted.
  assert.equal(validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', priority: 1, autoModel: true },
      { providerId: 'backup', model: 'good-model', priority: 2 },
    ],
  }), { cli: 'claude', providers }).code, 'provider_auto_model_requires_routing');
  // Either ladder gives the turn a tier to land on, so a hand-tagged pool takes
  // an auto-model line exactly like a price-tiered one does.
  const manual = validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', priority: 1, autoModel: true, tier: 'weak' },
      { providerId: 'backup', model: 'good-model', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev' },
  }), { cli: 'claude', providers });
  assert.equal(manual.ok, true, manual.error);
  assert.equal(manual.value.candidates[0].autoModel, true);
  const priced = validateProviderSelection(selection({
    candidates: [
      { providerId: 'empty', priority: 1, autoModel: true },
      { providerId: 'backup', model: 'good-model', priority: 2 },
    ],
    routing: { provider: 'jev', tiering: 'price' },
  }), { cli: 'claude', providers });
  assert.equal(priced.ok, true, priced.error);
  assert.equal(priced.value.candidates[0].autoModel, true);
});

test('the DTO round-trips the cross-CLI lane fields', () => {
  const providers = catalog();
  const first = validateProviderSelection(crossCliSelection({
    sticky: false,
    cliSwitch: 'routing',
    candidates: [
      { providerId: 'empty', priority: 1, autoModel: true, cli: 'claude' },
      { providerId: 'codex-only', priority: 2, cli: 'codex' },
    ],
    routing: { provider: 'jev', tiering: 'price' },
  }), { cli: 'claude', providers });
  assert.equal(first.ok, true, first.error);
  const dto = providerSelectionDto(first.value);
  assert.deepEqual(dto.candidates.map(candidate => [candidate.cli, candidate.autoModel === true]),
    [['claude', true], ['codex', false]]);
  assert.equal(dto.cliSwitch, 'routing');
  assert.equal(dto.routing.tiering, 'price');
  assert.deepEqual(dto.routing.tiers, []);
  assert.deepEqual(selectionClis(dto), ['claude', 'codex']);
  // Re-validating what the DTO handed out is how the editor saves: it has to be
  // a fixed point, or saving an untouched panel would reshuffle the pool.
  const again = validateProviderSelection(dto, { providers });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(again.value, first.value);
});

test('a legacy single-lane pool DTO keeps its exact key set', () => {
  const value = validateProviderSelection(selection(), { cli: 'claude', providers: catalog() }).value;
  const dto = providerSelectionDto(value);
  assert.deepEqual(Object.keys(dto).sort(),
    ['allowCrossTrust', 'candidates', 'maxAttempts', 'mode', 'protocol', 'sticky', 'version']);
  assert.deepEqual(Object.keys(dto.candidates[0]).sort(), ['enabled', 'model', 'priority', 'providerId']);
  assert.equal('tier' in dto.candidates[0], false);
  assert.equal('autoModel' in dto.candidates[0], false);
});

test('primaryProviderCandidate can be scoped to one lane of a cross-CLI pool', () => {
  const candidates = [
    { providerId: 'codex-fast', priority: 1, enabled: true, cli: 'codex' },
    { providerId: 'claude-primary', priority: 5, enabled: true, cli: 'claude' },
    { providerId: 'plain', priority: 9, enabled: true },
  ];
  assert.equal(primaryProviderCandidate({ candidates }).providerId, 'codex-fast');
  assert.equal(primaryProviderCandidate({ candidates }, 'claude').providerId, 'claude-primary');
  assert.equal(primaryProviderCandidate({ candidates }, 'codex').providerId, 'codex-fast');
  // A candidate that never named a lane is not another lane's: it stays eligible
  // on every lane, which is how a lane-less legacy candidate keeps working.
  assert.equal(primaryProviderCandidate({ candidates: [candidates[2]] }, 'kimi').providerId, 'plain');
});

// ── derived protocol ─────────────────────────────────────────────────────────
//
// The redesigned client writes `cli` on every candidate and may omit
// `protocol` entirely; the server reads it off the pool instead of demanding it.

test('the protocol is derived from the pool when the client omits it', () => {
  const providers = catalog();
  const derived = validateProviderSelection(selection({ protocol: undefined }), { cli: 'claude', providers });
  assert.equal(derived.ok, true, derived.error);
  assert.equal(derived.value.protocol, 'anthropic');
  // The stored DTO still carries the resolved protocol, so an old client never
  // reads an empty field back.
  assert.equal(providerSelectionDto(derived.value).protocol, 'anthropic');

  // A cross-CLI pool derives from the first enabled line that has one.
  const cross = validateProviderSelection({
    version: 1, mode: 'auto', maxAttempts: 2,
    candidates: [
      { providerId: 'claude-multi', cli: 'claude', model: 'multi-model' },
      { providerId: 'responses-a', model: 'gpt-a', cli: 'codex' },
    ],
  }, { cli: 'claude', providers });
  assert.equal(cross.ok, true, cross.error);
  assert.equal(cross.value.protocol, 'anthropic');

  // An explicit but unknown value is still refused.
  assert.equal(validateProviderSelection(selection({ protocol: 'bogus' }), { cli: 'claude', providers }).code,
    'invalid_provider_protocol');
});

test('a pool of only native OpenCode lines derives the neutral default protocol', () => {
  const result = validateProviderSelection({
    version: 1, mode: 'auto', maxAttempts: 2,
    candidates: [
      { providerId: 'opencode-native:opencode', cli: 'opencode', model: 'opencode/big-pickle' },
      { providerId: 'opencode-native:opencodego', cli: 'opencode', model: 'opencodego/kimi-k2' },
    ],
  }, { cli: 'opencode', providers: catalog() });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.protocol, 'anthropic');
});

// ── OpenCode native pool candidates ──────────────────────────────────────────

test('an OpenCode native candidate is validated structurally, without the live model list', () => {
  const providers = catalog();
  const pool = candidates => ({ version: 1, mode: 'auto', maxAttempts: 2, candidates });
  const ok = validateProviderSelection(pool([
    { providerId: 'opencode-native:opencode', cli: 'opencode', model: 'opencode/big-pickle' },
    { providerId: 'opencode-native:opencodego', cli: 'opencode', model: 'opencodego/kimi-k2' },
  ]), { cli: 'claude', providers });
  assert.equal(ok.ok, true, ok.error);
  // The native lines are never looked up in a provider store and read as
  // user-managed (they cross no trust domain with each other).
  assert.equal(ok.value.candidates.every(candidate => candidate.cli === 'opencode'), true);

  // An unusable id, a foreign lane and a model outside the provider namespace
  // are all refused before OpenCode is ever asked for its models.
  const badId = validateProviderSelection(pool([
    { providerId: 'opencode-native:-bad', cli: 'opencode' },
    { providerId: 'opencode-native:opencodego', cli: 'opencode' },
  ]), { cli: 'claude', providers });
  assert.equal(badId.code, 'invalid_provider_candidate');
  assert.match(badId.error, /invalid OpenCode provider id/);
  const wrongLane = validateProviderSelection(pool([
    { providerId: 'opencode-native:opencode', cli: 'claude' },
    { providerId: 'opencode-native:opencodego', cli: 'opencode' },
  ]), { cli: 'claude', providers });
  assert.equal(wrongLane.code, 'invalid_provider_candidate');
  assert.match(wrongLane.error, /only usable on the opencode cli/);
  const wrongModel = validateProviderSelection(pool([
    { providerId: 'opencode-native:opencode', cli: 'opencode', model: 'opencodego/kimi-k2' },
    { providerId: 'opencode-native:opencodego', cli: 'opencode' },
  ]), { cli: 'claude', providers });
  assert.equal(wrongModel.code, 'invalid_provider_candidate');
  assert.match(wrongModel.error, /must start with "opencode\/"/);
});

test('a native OpenCode line is the same route whether or not it names its cli', () => {
  const providers = catalog();
  // On the opencode lane the cli may stay implicit, exactly like a managed line.
  const implicit = validateProviderSelection({
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'opencode-native:opencode', model: 'opencode/big-pickle' },
      { providerId: 'opencode-native:opencodego', model: 'opencodego/kimi-k2' },
    ],
  }, { cli: 'opencode', providers });
  assert.equal(implicit.ok, true, implicit.error);
  assert.equal('cli' in implicit.value.candidates[0], false);
});

// ── the redesigned client's pools ────────────────────────────────────────────

test('a cross-CLI new-UI pool validates with no protocol field and a price ladder', () => {
  const result = validateProviderSelection({
    version: 1, mode: 'auto', maxAttempts: 3,
    candidates: [
      { providerId: 'claude-multi', cli: 'claude', model: 'multi-model' },
      { providerId: 'opencode-native:opencode', cli: 'opencode', autoModel: true },
      { providerId: 'claude-multi', cli: 'opencode' },
    ],
    cliSwitch: 'routing',
    routing: { provider: 'jev', tiering: 'price' },
  }, { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.protocol, 'anthropic');
  assert.equal(result.value.cliSwitch, 'routing');
  assert.deepEqual(selectionClis(result.value), ['claude', 'opencode']);
  // The round-trip the editor performs must be a fixed point.
  const dto = providerSelectionDto(result.value);
  const again = validateProviderSelection(dto, { cli: 'claude', providers: catalog() });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(again.value, result.value);
});

test('an in-order failover pool of concrete models needs no routing', () => {
  const result = validateProviderSelection({
    version: 1, mode: 'auto', maxAttempts: 2,
    candidates: [
      { providerId: 'claude-multi', cli: 'claude', model: 'multi-model' },
      { providerId: 'responses-a', cli: 'codex', model: 'gpt-a' },
    ],
    cliSwitch: 'failover',
  }, { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.cliSwitch, 'failover');
  assert.equal('routing' in result.value, false);
});

test('a manual ladder takes an auto-model line and keeps the weakest-first tier order', () => {
  const result = validateProviderSelection(selection({
    protocol: undefined,
    candidates: [
      { providerId: 'empty', model: 'bad-model', priority: 1, tier: 'simple' },
      { providerId: 'backup', priority: 2, tier: 'medium', autoModel: true },
      { providerId: 'claude-multi', model: 'multi-model', priority: 3, tier: 'complex' },
    ],
    routing: { provider: 'jev', tiers: ['simple', 'medium', 'complex'] },
  }), { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value.routing.tiers, ['simple', 'medium', 'complex']);
  assert.equal(result.value.candidates[1].autoModel, true);
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

'use strict';

// Difficulty routing: the tier verdict decides which candidate a turn starts on,
// where the verdict comes from, and what happens when it never arrives. The
// pool, the store and the runtime are exercised together because the invariants
// that matter (tier beats priority, a dead gateway never loses a turn, failover
// escalates out of a broken tier) only exist in the seams between them.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');
const { createAutoProviderRouting, textHash } = require('../src/chat/auto-provider-routing');
const {
  providerSelectionDto,
  validateProviderSelection,
} = require('../src/providers/auto-provider-config');
const { JEV_GATEWAYS } = require('../src/providers/jev-client');

const NOW = 2_000_000;

function catalog() {
  const list = [
    { id: 'weakp', name: 'Weak', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'weak-model', modelOptions: ['weak-model'] },
    { id: 'strongp', name: 'Strong', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'strong-model', modelOptions: ['strong-model'] },
    { id: 'spare', name: 'Spare', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'spare-model', modelOptions: ['spare-model'] },
  ];
  return {
    appTypeForCli: () => 'claude',
    appTypesForCli: () => ['claude'],
    listProviders: () => list,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (_appType, providerId, model) => list.some(item => item.id === providerId && item.model === model),
  };
}

function pool({ router, tiers = [], maxAttempts = 3, exhausted = [] } = {}) {
  const providers = catalog();
  const events = [];
  const now = () => NOW;
  const routing = createAutoProviderRouting({
    jev: router,
    now,
    ttlMs: 60_000,
  });
  const runtime = createAutoProviderRuntime({
    providers,
    routing,
    now,
    limitCacheStaleMs: 60_000,
    providerLimitCache: {
      get: (_appType, id) => (exhausted.includes(id)
        ? { status: 'ok', kind: 'balance', fetchedAt: NOW, summary: { kind: 'balance', available: false }, summaryText: '余额不足' }
        : null),
    },
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's1',
    cli: 'claude',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts, sticky: true,
      candidates: [
        { providerId: 'weakp', priority: 1, tier: 'weak' },
        { providerId: 'strongp', priority: 2, tier: 'strong' },
        { providerId: 'spare', priority: 3, tier: 'strong' },
      ],
      routing: { provider: 'jev', apiKeyName: 'vercel-api-key', ...(tiers.length ? { tiers } : {}) },
    },
  };
  return { runtime, routing, session, events, providers };
}

function jev(answer) {
  const calls = [];
  return {
    calls,
    classify: async ({ text }) => {
      calls.push(text);
      const verdict = typeof answer === 'function' ? await answer(text) : answer;
      return { ok: true, source: 'jev', tier: 'weak', reasonCode: 'jev_choice', latencyMs: 7, ...verdict };
    },
  };
}

const WEAK = { tier: 'weak', reasonCode: 'jev_choice' };
const STRONG = { tier: 'strong', reasonCode: 'jev_complexity_escalation', escalated: true };

function quotaDecision() {
  return {
    action: 'wait_reset', reason: 'quota_reset_required', delayMs: 60_000,
    error: { category: 'billing_quota', phase: 'before_first_token', partialOutput: false, sideEffects: false },
  };
}

function openAttempt(providerId) {
  return {
    providerId, replayFence: 'none',
    visibleOutputObserved: false, toolIntentObserved: false, sideEffectObserved: false,
  };
}

// ── config contract ──────────────────────────────────────────────────────────

test('a pool cannot claim to route difficulty without two distinct tiers', () => {
  const base = {
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'weakp', priority: 1, tier: 'weak' },
      { providerId: 'strongp', priority: 2 },
    ],
    routing: { provider: 'jev' },
  };
  const result = validateProviderSelection(base, { cli: 'claude', providers: catalog() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'provider_routing_requires_tiers');
});

test('declared tiers must name exactly the tiers the pool uses, in ladder order', () => {
  const build = routing => ({
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'strongp', priority: 1, tier: 'strong' },
      { providerId: 'weakp', priority: 2, tier: 'weak' },
    ],
    routing,
  });
  // Priority order is not capability order here, so the ladder must be declared.
  const declared = validateProviderSelection(
    build({ provider: 'jev', tiers: ['weak', 'strong'] }),
    { cli: 'claude', providers: catalog() },
  );
  assert.equal(declared.ok, true);
  assert.deepEqual(declared.value.routing.tiers, ['weak', 'strong']);
  // Derived (no declaration) follows priority, which is why declaring matters.
  const derived = validateProviderSelection(build({ provider: 'jev' }), { cli: 'claude', providers: catalog() });
  assert.deepEqual(derived.value.routing.tiers, ['strong', 'weak']);
  assert.equal(validateProviderSelection(
    build({ provider: 'jev', tiers: ['weak'] }), { cli: 'claude', providers: catalog() },
  ).code, 'provider_routing_tier_mismatch');
  assert.equal(validateProviderSelection(
    build({ provider: 'jev', tiers: ['weak', 'medium'] }), { cli: 'claude', providers: catalog() },
  ).code, 'provider_routing_tier_mismatch');
});

test('routing rejects unsupported knobs instead of ignoring them', () => {
  const build = routing => ({
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'weakp', priority: 1, tier: 'weak' },
      { providerId: 'strongp', priority: 2, tier: 'strong' },
    ],
    routing,
  });
  const options = { cli: 'claude', providers: catalog() };
  for (const routing of [
    { provider: 'openai' },
    { provider: 'jev', onUnknown: 'medium' },
    { provider: 'jev', timeoutMs: 10 },
    { provider: 'jev', timeoutMs: 60_000 },
    { provider: 'jev', apiKeyName: 'not a vault name' },
    { provider: 'jev', escalation: { minConfidence: 2 } },
    // The planning signal was measured as noise and removed; a pool that still
    // asks for it must fail loudly rather than be silently ignored.
    { provider: 'jev', escalation: { planningProbability: 0.6 } },
    { provider: 'jev', version: 2 },
  ]) {
    const result = validateProviderSelection(build(routing), options);
    assert.equal(result.ok, false, JSON.stringify(routing));
    assert.equal(result.code, 'invalid_provider_routing', JSON.stringify(routing));
  }
});

// ── picking the gateway ──────────────────────────────────────────────────────
//
// The same evaluation is sold by three gateways and self-hosted behind a fourth
// ("custom"). Only the host, the model id and the vault entry differ, so the
// pool stores a gateway *name* — never a copy of the table — and a name the
// table does not know is refused rather than silently treated as Vercel.

function gatewayPool(routing) {
  return {
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'weakp', priority: 1, tier: 'weak' },
      { providerId: 'strongp', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev', ...routing },
  };
}

function validatedRouting(routing) {
  const result = validateProviderSelection(gatewayPool(routing), { cli: 'claude', providers: catalog() });
  return result.ok ? result.value.routing : result;
}

test('a pool without a gateway is a Vercel pool, and the table supplies its model', () => {
  const routing = validatedRouting({});
  assert.equal(routing.gateway, 'vercel');
  assert.equal(routing.model, JEV_GATEWAYS.vercel.model);
  assert.equal(routing.apiKeyName, JEV_GATEWAYS.vercel.apiKeyName);
  // A preset's endpoint is never written down: a persisted copy would outlive a
  // table update and quietly keep calling the old host.
  assert.equal('endpoint' in routing, false);
});

test('a preset gateway brings its own model and vault entry', () => {
  for (const gateway of ['openrouter', 'typesafe']) {
    const routing = validatedRouting({ gateway });
    assert.equal(routing.gateway, gateway);
    assert.equal(routing.model, JEV_GATEWAYS[gateway].model, gateway);
    assert.equal(routing.apiKeyName, JEV_GATEWAYS[gateway].apiKeyName, gateway);
    assert.equal('endpoint' in routing, false, gateway);
  }
  // `~typesafe/jev-latest` is why a routing model id may carry a tilde.
  assert.equal(validatedRouting({ gateway: 'openrouter' }).model, '~typesafe/jev-latest');
});

test('a preset gateway may not carry an endpoint of its own', () => {
  const result = validateProviderSelection(gatewayPool({
    gateway: 'openrouter', endpoint: 'https://evil.example/v1/evaluate',
  }), { cli: 'claude', providers: catalog() });
  // Refused, not ignored: a caller that attached a URL to a preset would
  // otherwise believe its key was being sent there. `custom` says that out loud.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_provider_routing');
});

test('the custom gateway owns its address, and only under the documented rules', () => {
  const valid = validatedRouting({
    gateway: 'custom', endpoint: 'https://jev.example/v1/evaluate', model: 'my-jev',
  });
  assert.equal(valid.gateway, 'custom');
  assert.equal(valid.endpoint, 'https://jev.example/v1/evaluate');
  assert.equal(valid.model, 'my-jev');
  // No model named: the endpoint is the user's, the model id is a guess they
  // cannot act on, so the documented default is used instead of a save error.
  assert.equal(validatedRouting({ gateway: 'custom', endpoint: 'https://jev.example/x' }).model, 'jev-latest');
  const rejects = [
    ['missing address', { gateway: 'custom' }],
    ['not a URL', { gateway: 'custom', endpoint: 'jev.example/v1' }],
    ['plain http off-loopback', { gateway: 'custom', endpoint: 'http://jev.example/v1' }],
    ['credentials in the address', { gateway: 'custom', endpoint: 'https://user:pw@jev.example/v1' }],
    ['an unknown gateway', { gateway: 'anthropic' }],
    ['an over-long address', { gateway: 'custom', endpoint: `https://jev.example/${'x'.repeat(400)}` }],
  ];
  for (const [label, routing] of rejects) {
    const result = validateProviderSelection(gatewayPool(routing), { cli: 'claude', providers: catalog() });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, 'invalid_provider_routing', label);
  }
  // A local deployment is reachable over plain http on purpose.
  assert.equal(validatedRouting({
    gateway: 'custom', endpoint: 'http://127.0.0.1:8080/v1/evaluate', model: 'jev-latest',
  }).endpoint, 'http://127.0.0.1:8080/v1/evaluate');
});

// The endpoint of a custom gateway is whatever the config says, and configs can
// be written through the API. The key, though, is read by entry NAME, so without
// this rule a config could name `github_token` and have its value posted to a
// host of its choosing.
test('a custom gateway can only read keys from its own vault namespace', () => {
  const base = { gateway: 'custom', endpoint: 'https://jev.example/v1', model: 'jev-latest' };
  assert.equal(validatedRouting({ ...base, apiKeyName: 'jev-mine' }).apiKeyName, 'jev-mine');
  assert.equal(validatedRouting(base).apiKeyName, 'jev-custom-api-key');
  for (const apiKeyName of ['github_token', 'vercel-api-key', 'my-key']) {
    const result = validateProviderSelection(gatewayPool({ ...base, apiKeyName }),
      { cli: 'claude', providers: catalog() });
    assert.equal(result.ok, false, apiKeyName);
    assert.equal(result.code, 'invalid_provider_routing', apiKeyName);
  }
  // The presets keep the older, laxer rule: they are not config-supplied hosts.
  assert.equal(validatedRouting({ apiKeyName: 'my-key' }).apiKeyName, 'my-key');
});

test('the DTO carries the gateway through a round-trip', () => {
  const value = validateProviderSelection(gatewayPool({
    gateway: 'custom', endpoint: 'https://jev.example/v1', model: 'my-jev',
  }), { cli: 'claude', providers: catalog() }).value;
  const dto = providerSelectionDto(value);
  assert.equal(dto.routing.gateway, 'custom');
  assert.equal(dto.routing.endpoint, 'https://jev.example/v1');
  assert.equal(dto.routing.model, 'my-jev');
  // Re-validating what the DTO handed out is how the editor saves: it must be a
  // fixed point, or saving an unchanged panel would reshuffle the config.
  const again = validateProviderSelection(dto, { cli: 'claude', providers: catalog() });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(again.value.routing, value.routing);
});

test('the DTO round-trips tiers and routing, and an unrouted pool is unchanged', () => {
  const routed = providerSelectionDto({
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [
      { providerId: 'weakp', priority: 1, tier: 'weak' },
      { providerId: 'strongp', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev', onUnknown: 'weak', escalation: { minConfidence: 0.7 } },
  });
  assert.equal(routed.candidates[0].tier, 'weak');
  assert.deepEqual(routed.routing.tiers, ['weak', 'strong']);
  assert.equal(routed.routing.onUnknown, 'weak');
  assert.equal(routed.routing.apiKeyName, 'vercel-api-key');
  assert.equal(routed.routing.escalation.minConfidence, 0.7);
  // Legacy pool: no routing key at all, so existing wire JSON is byte-identical.
  const plain = providerSelectionDto({
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    candidates: [{ providerId: 'weakp', priority: 1 }, { providerId: 'strongp', priority: 2 }],
  });
  assert.equal('routing' in plain, false);
  assert.equal('tier' in plain.candidates[0], false);
});

// ── the verdict store ────────────────────────────────────────────────────────

test('a verdict belongs to its own message and expires', async () => {
  let clock = NOW;
  const routing = createAutoProviderRouting({
    jev: jev(WEAK),
    now: () => clock,
    ttlMs: 1_000,
  });
  const providers = catalog();
  const session = pool().session;
  const first = routing.prepareTurn({ session, text: '改个 typo', providers });
  assert.ok(first && typeof first.then === 'function', 'a prepared turn returns its verdict promise');
  await first;
  assert.equal(routing.consume({ sessionId: 's1', text: '改个 typo' }).tier, 'weak');
  // A different message cannot inherit the previous verdict.
  assert.equal(routing.consume({ sessionId: 's1', text: '重构整个 provider 层' }), null);
  clock += 5_000;
  assert.equal(routing.consume({ sessionId: 's1', text: '改个 typo' }), null);
});

test('a queued message keeps its verdict while the next one is judged', async () => {
  const routing = createAutoProviderRouting({
    jev: { classify: async ({ text }) => ({ ok: true, tier: text.includes('重构') ? 'strong' : 'weak' }) },
    now: () => NOW,
  });
  const session = pool().session;
  await routing.prepareTurn({ session, text: '改个 typo', providers: catalog() });
  await routing.prepareTurn({ session, text: '重构整个 provider 层', providers: catalog() });
  assert.equal(routing.consume({ sessionId: 's1', text: '改个 typo' }).tier, 'weak');
  assert.equal(routing.consume({ sessionId: 's1', text: '重构整个 provider 层' }).tier, 'strong');
  routing.clearSession('s1');
  assert.equal(routing.consume({ sessionId: 's1', text: '改个 typo' }), null);
  assert.equal(routing.size(), 0);
});

test('a resolved tier reports where it sits on the ladder', () => {
  const routing = createAutoProviderRouting({ jev: jev(WEAK), now: () => NOW });
  const selection = { routing: { tiers: ['weak', 'mid', 'strong'], onUnknown: 'weak' } };
  const judged = routing.resolveTier({ selection, verdict: { ok: true, tier: 'mid' } });
  assert.deepEqual([judged.tierIndex, judged.tierCount], [1, 3]);
  const fallback = routing.resolveTier({ selection, verdict: { ok: false, code: 'jev_timeout' } });
  assert.deepEqual([fallback.tierIndex, fallback.tierCount, fallback.onUnknown], [0, 3, 'weak']);
  const ordered = routing.resolveTier({
    selection: { routing: { tiers: ['weak', 'strong'], onUnknown: 'priority' } }, verdict: null,
  });
  assert.deepEqual([ordered.tier, ordered.tierIndex, ordered.onUnknown], [null, null, 'priority']);
});

test('identical in-flight messages share one evaluation', async () => {
  const router = jev(WEAK);
  const routing = createAutoProviderRouting({ jev: router, now: () => NOW });
  const session = pool().session;
  await Promise.all([
    routing.prepareTurn({ session, text: '同一个问题', providers: catalog() }),
    routing.prepareTurn({ session, text: '同一个问题', providers: catalog() }),
  ]);
  assert.equal(router.calls.length, 1);
});

test('a routing store never rejects, even when the evaluator throws', async () => {
  const routing = createAutoProviderRouting({
    jev: { classify: async () => { throw new Error('boom'); } },
    now: () => NOW,
  });
  const session = pool().session;
  const verdict = await routing.prepareTurn({ session, text: 'hi', providers: catalog() });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'jev_client_failed');
  assert.equal(routing.consume({ sessionId: 's1', text: 'hi' }).ok, false);
});

test('the pool\'s tuned knobs are handed to the evaluation it triggers', async () => {
  const seen = [];
  const routing = createAutoProviderRouting({
    now: () => NOW,
    jev: { classify: async args => { seen.push(args); return { ok: true, tier: 'weak' }; } },
  });
  const session = pool().session;
  session.providerSelection.routing.timeoutMs = 9_000;
  session.providerSelection.routing.model = 'typesafe-ai/jev-preview';
  session.providerSelection.routing.escalation = { minTierProbability: 0.7 };
  await routing.prepareTurn({ session, text: '改个 typo', providers: catalog() });
  assert.equal(seen.length, 1);
  // Validated as meaningful upstream (validateRouting), so they have to arrive:
  // an evaluator that never sees them would route by defaults the pool did not pick.
  assert.equal(seen[0].timeoutMs, 9_000);
  assert.equal(seen[0].model, 'typesafe-ai/jev-preview');
  assert.deepEqual(seen[0].escalation, { minTierProbability: 0.7 });
  assert.deepEqual(seen[0].tiers, ['weak', 'strong']);
  assert.equal(seen[0].apiKeyName, 'vercel-api-key');
});

test('prepareTurn evaluates through the gateway the pool picked', async () => {
  const seen = [];
  const routing = createAutoProviderRouting({
    now: () => NOW,
    jev: { classify: async args => { seen.push(args); return { ok: true, tier: 'weak' }; } },
  });
  const session = pool().session;
  await routing.prepareTurn({ session, text: '改个 typo', providers: catalog() });
  // No gateway in the config: the Vercel host and model, exactly as before the
  // table existed — a pool that never heard of gateways must not change host.
  assert.equal(seen[0].endpoint, JEV_GATEWAYS.vercel.endpoint);
  assert.equal(seen[0].model, JEV_GATEWAYS.vercel.model);
  assert.equal(seen[0].apiKeyName, 'vercel-api-key');

  seen.length = 0;
  session.providerSelection.routing.gateway = 'openrouter';
  session.providerSelection.routing.model = '~typesafe/jev-latest';
  delete session.providerSelection.routing.apiKeyName;
  await routing.prepareTurn({ session, text: '重构整个 provider 层', providers: catalog() });
  assert.equal(seen[0].endpoint, JEV_GATEWAYS.openrouter.endpoint);
  assert.equal(seen[0].model, '~typesafe/jev-latest');
  assert.equal(seen[0].apiKeyName, 'openrouter-api-key');

  seen.length = 0;
  session.providerSelection.routing.gateway = 'custom';
  session.providerSelection.routing.endpoint = 'http://127.0.0.1:8080/v1/evaluate';
  session.providerSelection.routing.model = 'my-jev';
  session.providerSelection.routing.apiKeyName = 'jev-mine';
  await routing.prepareTurn({ session, text: '再改一个 typo', providers: catalog() });
  assert.equal(seen[0].endpoint, 'http://127.0.0.1:8080/v1/evaluate');
  assert.equal(seen[0].model, 'my-jev');
  assert.equal(seen[0].apiKeyName, 'jev-mine');
});

test('sessions without routing pay nothing', async () => {
  const router = jev(WEAK);
  const routing = createAutoProviderRouting({ jev: router, now: () => NOW });
  const session = { id: 's2', cli: 'claude', providerSelection: { version: 1, mode: 'auto', protocol: 'anthropic', candidates: [], maxAttempts: 2 } };
  assert.equal(routing.prepareTurn({ session, text: 'hi' }), null);
  assert.equal(await routing.prepareTurn({ session: { id: 's3' }, text: '' }), null);
  assert.equal(router.calls.length, 0);
});

test('an unusable verdict resolves through onUnknown, never through the pool order', () => {
  const selection = { routing: { tiers: ['weak', 'strong'], onUnknown: 'strong' } };
  const routing = createAutoProviderRouting({ jev: jev(WEAK), now: () => NOW });
  assert.deepEqual(
    { tier: routing.resolveTier({ selection, verdict: { ok: false, code: 'jev_http_403' } }).tier, source: routing.resolveTier({ selection, verdict: { ok: false, code: 'jev_http_403' } }).source },
    { tier: 'strong', source: 'fallback' },
  );
  assert.equal(routing.resolveTier({ selection, verdict: null }).tier, 'strong');
  assert.equal(routing.resolveTier({
    selection: { routing: { tiers: ['weak', 'strong'], onUnknown: 'weak' } }, verdict: null,
  }).tier, 'weak');
  assert.equal(routing.resolveTier({
    selection: { routing: { tiers: ['weak', 'strong'], onUnknown: 'priority' } }, verdict: null,
  }).tier, null);
  assert.equal(routing.resolveTier({ selection, verdict: { ok: true, tier: 'weak' } }).source, 'jev');
});

// ── runtime integration ──────────────────────────────────────────────────────

test('the tier beats priority, and the decision is auditable on the route event', async () => {
  const { runtime, session, events } = pool({ router: jev(STRONG) });
  await runtime.prepareTurn({ session, text: '重构整个 provider 层', providers: catalog() });
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '重构整个 provider 层' });
  assert.equal(turn.initial().providerId, 'strongp');
  assert.equal(events[0].preferredTier, 'strong');
  assert.equal(events[0].routing.source, 'jev');
  assert.equal(events[0].routing.code, 'jev_complexity_escalation');
  assert.equal(events[0].routing.escalated, true);
  // What the chat note needs: the judged tier's rung and the picked line's tier.
  assert.equal(events[0].tier, 'strong');
  assert.equal(events[0].routing.tierIndex, events[0].routing.tierCount - 1);
});

test('a weak verdict sends a trivial request to the cheap candidate', async () => {
  const { runtime, session } = pool({ router: jev(WEAK) });
  await runtime.prepareTurn({ session, text: '改个 typo', providers: catalog() });
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '改个 typo' });
  assert.equal(turn.initial().providerId, 'weakp');
});

test('a verdict that never arrived fails to the conservative tier, not to priority', () => {
  const { runtime, session } = pool({ router: jev(WEAK), tiers: [] });
  // No prepareTurn call at all: the gateway was down before the turn existed.
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '改个 typo' });
  assert.equal(turn.initial().providerId, 'strongp');
  assert.equal(turn.routing.source, 'fallback');
  assert.equal(turn.routing.code, 'jev_not_prepared');
});

test('onUnknown=priority keeps the legacy ordering when the verdict is missing', () => {
  const { runtime, session } = pool({ router: jev(WEAK) });
  session.providerSelection.routing.onUnknown = 'priority';
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '改个 typo' });
  assert.equal(turn.initial().providerId, 'weakp');
  assert.equal(turn.routing.tier, null);
});

test('failover escalates out of a broken tier instead of wedging the turn', async () => {
  const { runtime, session, events } = pool({ router: jev(WEAK) });
  await runtime.prepareTurn({ session, text: '改个 typo', providers: catalog() });
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '改个 typo' });
  assert.equal(turn.initial().providerId, 'weakp');
  const next = turn.failover(quotaDecision(), openAttempt('weakp'));
  assert.equal(next.invocationOptions.providerId, 'strongp');
  // The tier is pinned for the whole logical turn: a switch does not re-roll it.
  assert.deepEqual(events.map(event => [event.phase, event.preferredTier]), [
    ['selected', 'weak'], ['switched', 'weak'],
  ]);
});

test('a tier is a preference, not a filter: an exhausted tier still fails over', async () => {
  const { runtime, session } = pool({ router: jev(STRONG), exhausted: ['strongp', 'spare'] });
  await runtime.prepareTurn({ session, text: '很难的任务', providers: catalog() });
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '很难的任务' });
  // Every strong candidate is out of quota; running on the weak tier beats failing.
  assert.equal(turn.initial().providerId, 'weakp');
});

test('an unrouted pool keeps its exact previous behaviour', () => {
  const { runtime, session, events } = pool({ router: jev(WEAK) });
  delete session.providerSelection.routing;
  delete session.providerSelection.candidates[0].tier;
  const turn = runtime.beginTurn({ session, turnId: 't1', promptText: '改个 typo' });
  assert.equal(turn.routing, null);
  assert.equal(turn.initial().providerId, 'weakp');
  assert.equal('preferredTier' in events[0], true);
  assert.equal(events[0].preferredTier, null);
  assert.equal(events[0].routing, null);
});

test('textHash is stable and text-sensitive', () => {
  assert.equal(textHash('abc'), textHash('abc'));
  assert.notEqual(textHash('abc'), textHash('abd'));
  assert.notEqual(textHash('ab'), textHash('ba'));
  assert.equal(textHash(null), textHash(''));
});

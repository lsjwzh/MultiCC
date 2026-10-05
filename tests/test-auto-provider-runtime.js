'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');
const { createAutoProviderRouting } = require('../src/chat/auto-provider-routing');
const { selectionKey } = require('../src/chat/auto-provider-selection-key');

function fixture({
  emptyFetchedAt = 0, thirdFetchedAt = null, maxAttempts = 3, backgroundActive = false,
} = {}) {
  const now = 1_000_000;
  const clock = { now };
  const catalog = [
    { id: 'empty', name: 'Empty', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'empty-model', modelOptions: ['empty-model'] },
    { id: 'backup', name: 'Backup', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'backup-model', modelOptions: ['backup-model'] },
    { id: 'third', name: 'Third', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'third-model', modelOptions: ['third-model'] },
    { id: 'official', name: 'Official', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], isOfficial: true, model: 'official-model', modelOptions: ['official-model'] },
  ];
  const limits = new Map([
    ['empty', {
      status: 'ok', kind: 'balance', fetchedAt: emptyFetchedAt,
      summary: { kind: 'balance', available: false, total: -0.05 },
      summaryText: '余额不足',
    }],
  ]);
  if (thirdFetchedAt != null) {
    limits.set('third', {
      status: 'ok', kind: 'window', fetchedAt: thirdFetchedAt,
      summary: { kind: 'window', status: 'rejected', usedPercentage: 90 },
      summaryText: '5h 0%',
    });
  }
  const events = [];
  const providers = {
    appTypeForCli: () => 'claude',
    listProviders: () => catalog,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (_appType, providerId, model) => catalog.some(item => item.id === providerId && item.model === model),
  };
  const runtime = createAutoProviderRuntime({
    providers,
    providerLimitCache: { get: (_appType, id) => limits.get(id) || null },
    limitCacheStaleMs: 60_000,
    now: () => clock.now,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => backgroundActive,
  });
  const session = {
    id: 's1', cli: 'claude', provider: 'legacy-concrete',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts, sticky: true,
      candidates: [
        { providerId: 'empty', priority: 1 },
        { providerId: 'backup', priority: 2 },
        { providerId: 'third', priority: 3 },
      ],
    },
  };
  return { runtime, session, events, limits, providers, clock };
}

// A pool that spans two lanes needs a catalog whose answer depends on the lane:
// which providers exist, which protocol they speak and which CLI they serve.
function laneProviders() {
  const laneCatalog = {
    claude: [
      { id: 'claude-a', name: 'Claude A', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'claude-a-model', modelOptions: ['claude-a-model'] },
      { id: 'claude-b', name: 'Claude B', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'claude-b-model', modelOptions: ['claude-b-model'] },
    ],
    codex: [
      { id: 'codex-a', name: 'Codex A', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'codex-a-model', modelOptions: ['codex-a-model'] },
      { id: 'codex-b', name: 'Codex B', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'codex-b-model', modelOptions: ['codex-b-model'] },
    ],
  };
  return {
    laneCatalog,
    providers: {
      appTypeForCli: cli => (cli.startsWith('codex') ? 'codex' : 'claude'),
      appTypesForCli: cli => [cli.startsWith('codex') ? 'codex' : 'claude'],
      listProviders: appType => laneCatalog[appType] || [],
      providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
      modelValidForProvider: (appType, providerId, model) => (laneCatalog[appType] || [])
        .some(provider => provider.id === providerId && provider.modelOptions.includes(model)),
    },
  };
}

function exhaust(limits, ids, now = 1_000_000) {
  for (const id of ids) {
    limits.set(id, {
      status: 'ok', kind: 'balance', fetchedAt: now,
      summary: { kind: 'balance', available: false, total: 0 },
      summaryText: '余额不足',
    });
  }
}

function crossFixture({
  cli = 'claude', cliSwitch = 'failover', maxAttempts = 2, exhausted = [], candidates = null,
  routingStore = null, selectionRouting = null,
} = {}) {
  const now = 1_000_000;
  const { providers } = laneProviders();
  const limits = new Map();
  exhaust(limits, exhausted);
  const events = [];
  const state = { disabledCli: null };
  const runtime = createAutoProviderRuntime({
    providers,
    providerLimitCache: { get: (_appType, id) => limits.get(id) || null },
    limitCacheStaleMs: 60_000,
    now: () => now,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
    isCliAvailable: lane => lane !== state.disabledCli,
    ...(routingStore ? { routing: routingStore } : {}),
  });
  const session = {
    id: 's-lanes', cli, provider: 'legacy-concrete',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts, sticky: true, cliSwitch,
      candidates: candidates || [
        { providerId: 'claude-a', priority: 2, cli: 'claude' },
        { providerId: 'claude-b', priority: 3, cli: 'claude' },
        { providerId: 'codex-a', priority: 5, cli: 'codex' },
        { providerId: 'codex-b', priority: 1, cli: 'codex' },
      ],
      ...(selectionRouting ? { routing: selectionRouting } : {}),
    },
  };
  return { runtime, session, events, limits, state, providers };
}

function quotaDecision() {
  return {
    action: 'wait_reset', reason: 'quota_reset_required', delayMs: 60_000,
    error: {
      category: 'billing_quota', phase: 'before_first_token',
      partialOutput: false, sideEffects: false,
    },
  };
}

function openAttempt(providerId = 'empty') {
  return {
    providerId,
    replayFence: 'none',
    visibleOutputObserved: false,
    toolIntentObserved: false,
    sideEffectObserved: false,
  };
}

test('stale zero balance is probed first, then quota failure switches to the next provider', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-1' });
  assert.deepEqual(turn.initial(), {
    providerId: 'empty', model: 'empty-model', reasonCode: 'auto_initial_selection',
  });
  const next = turn.failover(quotaDecision(), openAttempt());
  assert.equal(next.invocationOptions.providerId, 'backup');
  assert.equal(next.decision.action, 'retry');
  assert.equal(next.decision.reason, 'provider_failover');
  assert.deepEqual(next.decision.providerFailover, {
    fromProviderId: 'empty', toProviderId: 'backup',
    fromTrustDomain: 'user-managed', toTrustDomain: 'user-managed',
    category: 'billing_quota',
  });
  assert.deepEqual(events.map(event => event.routePhase), ['selected', 'switched']);
  assert.deepEqual(events.map(event => [event.trustDomain, event.fromTrustDomain]), [
    ['user-managed', null],
    ['user-managed', 'user-managed'],
  ]);
});

test('an explicitly authorized mixed pool switches from user-managed to Official and audits both trust domains', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000, maxAttempts: 2 });
  session.providerSelection = {
    version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2,
    sticky: true, allowCrossTrust: true,
    candidates: [
      { providerId: 'empty', priority: 1 },
      { providerId: 'official', priority: 2 },
    ],
  };
  const turn = runtime.beginTurn({ session, turnId: 'turn-cross-trust' });

  assert.equal(turn.initial().providerId, 'empty');
  const next = turn.failover(quotaDecision(), openAttempt());
  assert.equal(next.invocationOptions.providerId, 'official');
  assert.deepEqual(next.decision.providerFailover, {
    fromProviderId: 'empty',
    toProviderId: 'official',
    fromTrustDomain: 'user-managed',
    toTrustDomain: 'official',
    category: 'billing_quota',
  });
  assert.equal(events[0].trustDomain, 'user-managed');
  assert.equal(events[0].fromTrustDomain, null);
  assert.equal(events[1].trustDomain, 'official');
  assert.equal(events[1].fromTrustDomain, 'user-managed');
});

test('fresh known exhausted provider is skipped before the physical attempt', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 990_000 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-1' });
  assert.equal(turn.initial().providerId, 'backup');
  assert.deepEqual(events[0].skipped, [{ providerId: 'empty', reason: 'fresh_limit_exhausted' }]);
});

test('a fresh terminal cache status is skipped even without a balance summary', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  assert.deepEqual(limitState({ status: 'quota_exhausted', fetchedAt: 990_000 }, {
    now: 1_000_000, staleAfterMs: 60_000,
  }), { state: 'exhausted', reason: 'fresh_limit_exhausted', usedPercent: null });
});

test('a fresh rejected window summary is exhausted even below 100 percent', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  assert.deepEqual(limitState({
    status: 'ok', fetchedAt: 990_000,
    summary: { kind: 'window', status: 'rejected', usedPercentage: 90 },
    summaryText: '5h 0%',
  }, { now: 1_000_000, staleAfterMs: 60_000 }), {
    state: 'exhausted', reason: 'fresh_limit_exhausted', usedPercent: 90,
  });
});

test('an active provider cooldown is skipped and expiry permits a fresh probe', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  const entry = {
    status: 'ok', fetchedAt: 990_000,
    summary: {
      kind: 'availability', status: 'rejected', category: 'rate_limit',
      httpStatus: 429, blockedUntilMs: 1_010_000, observedAtMs: 990_000,
    },
  };
  assert.deepEqual(limitState(entry, { now: 1_000_000, staleAfterMs: 60_000 }), {
    state: 'exhausted', reason: 'provider_cooldown_active', usedPercent: null,
  });
  assert.deepEqual(limitState(entry, { now: 1_020_000, staleAfterMs: 60_000 }), {
    state: 'stale', reason: 'provider_cooldown_expired', usedPercent: null,
  });
});

// Revocation is not a cooldown: it does not lapse, because nothing multicc can
// do repairs it — only a human logging in does. The flag must therefore outrank
// the timestamp, or a clock change would quietly hand Auto back an account the
// server has already killed.
test('a revoked credential never returns to the pool on a timer', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  const entry = {
    status: 'ok', fetchedAt: 990_000,
    summary: {
      kind: 'availability', status: 'rejected', category: 'authentication_permission',
      httpStatus: 401, revoked: true, blockedUntilMs: Number.MAX_SAFE_INTEGER, observedAtMs: 990_000,
    },
  };
  assert.deepEqual(limitState(entry, { now: 1_000_000, staleAfterMs: 60_000 }), {
    state: 'exhausted', reason: 'provider_credential_revoked', usedPercent: null,
  });
  assert.equal(limitState(entry, { now: 4_000_000_000_000, staleAfterMs: 60_000 }).state, 'exhausted',
    'skipped for as long as the grant is dead, not until a timer lapses');
  const backdated = { ...entry, summary: { ...entry.summary, blockedUntilMs: 1 } };
  assert.equal(limitState(backdated, { now: 1_000_000, staleAfterMs: 60_000 }).state, 'exhausted',
    'the revoked flag outranks the timestamp');
});

test('an active cooldown overrides a sticky provider selection', () => {
  const { runtime, session, limits } = fixture({ emptyFetchedAt: 900_000 });
  const first = runtime.beginTurn({ session, turnId: 'sticky-source' });
  assert.equal(first.initial().providerId, 'empty');
  first.recordSuccess({ providerId: 'empty' });
  limits.set('empty', {
    status: 'ok', kind: 'availability', fetchedAt: 999_000,
    summary: {
      kind: 'availability', status: 'rejected', category: 'rate_limit',
      httpStatus: 429, blockedUntilMs: 1_100_000, observedAtMs: 999_000,
    },
  });
  assert.equal(runtime.beginTurn({ session, turnId: 'sticky-cooled' }).initial().providerId, 'backup');
});

test('OpenCode runtime discovers Codex-pool candidates and reads their own quota namespace', () => {
  const now = 1_000_000;
  const getCalls = [];
  const catalogByApp = {
    claude: [],
    codex: [
      { id: 'codex-empty', name: 'Codex Empty', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['opencode'], model: 'empty-model', modelOptions: ['empty-model'] },
      { id: 'codex-backup', name: 'Codex Backup', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['opencode'], model: 'backup-model', modelOptions: ['backup-model'] },
    ],
  };
  const providers = {
    appTypeForCli: () => 'claude',
    listProviders: appType => catalogByApp[appType] || [],
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (appType, providerId, model) => (
      (catalogByApp[appType] || []).some(provider => provider.id === providerId && provider.model === model)
    ),
  };
  const runtime = createAutoProviderRuntime({
    providers,
    providerLimitCache: {
      get(appType, providerId) {
        getCalls.push([appType, providerId]);
        if (providerId !== 'codex-empty') return null;
        return {
          status: 'ok', kind: 'balance', fetchedAt: now - 1_000,
          summary: { kind: 'balance', available: false, total: 0 },
        };
      },
    },
    limitCacheStaleMs: 60_000,
    now: () => now,
  });
  const turn = runtime.beginTurn({
    session: {
      id: 'opencode-session', cli: 'opencode',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'openai_responses', maxAttempts: 2,
        candidates: [
          { providerId: 'codex-empty', priority: 1 },
          { providerId: 'codex-backup', priority: 2 },
        ],
      },
    },
    turnId: 'opencode-turn',
  });

  assert.equal(turn.initial().providerId, 'codex-backup');
  assert.deepEqual(getCalls, [
    ['codex', 'codex-empty'],
    ['codex', 'codex-backup'],
  ]);
});

test('OpenCode and ZCode fail over across API dialects after a pool is saved and reloaded', () => {
  const { validateProviderSelection, providerSelectionDto } = require('../src/providers/auto-provider-config');
  for (const cli of ['opencode', 'zcode']) {
    const catalog = [
      { id: 'anthropic-route', appType: 'claude', apiFormat: 'anthropic', model: 'claude-model' },
      { id: 'responses-route', appType: 'codex', apiFormat: 'openai_responses', model: 'gpt-model' },
    ];
    const providers = {
      appTypeForCli: () => 'claude',
      appTypesForCli: () => ['claude', 'codex'],
      listProviders: appType => catalog.filter(provider => provider.appType === appType),
      providerSupportsCli: (_provider, lane) => lane === cli,
    };
    for (const explicit of [false, true]) {
      const saved = validateProviderSelection({
        mode: 'auto', sticky: false, candidates: catalog.map(provider => ({
          providerId: provider.id, ...(explicit ? { cli } : {}),
        })),
      }, { cli, providers });
      assert.equal(saved.ok, true, saved.error);
      const events = [];
      const runtime = createAutoProviderRuntime({
        providers, emit: (_sessionId, event) => events.push(event),
      });
      const turn = runtime.beginTurn({
        session: { id: `${cli}-${explicit}`, cli, providerSelection: providerSelectionDto(saved.value) },
        turnId: 'mixed-dialect',
      });
      assert.deepEqual(turn.initial(), {
        providerId: 'anthropic-route', model: 'claude-model', reasonCode: 'auto_initial_selection',
      });
      const next = turn.failover(quotaDecision(), openAttempt());
      assert.equal(next.decision.action, 'retry');
      assert.equal(next.invocationOptions.providerId, 'responses-route');
      assert.equal(next.invocationOptions.model, 'gpt-model');
      assert.deepEqual(events.map(event => event.protocol), ['anthropic', 'openai_responses']);
    }
  }
});

test('observable output and non-provider failures close the cross-provider replay boundary', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-1' });
  turn.initial();
  assert.equal(turn.failover(quotaDecision(), { ...openAttempt(), replayFence: 'visible_output' }), null);
  assert.equal(events.at(-1).reasonCode, 'provider_replay_fence_closed');

  const second = runtime.beginTurn({ session: { ...session, id: 's2' }, turnId: 'turn-2' });
  second.initial();
  assert.equal(second.failover({
    error: { category: 'invalid_request_model', phase: 'before_first_token', partialOutput: false, sideEffects: false },
  }, openAttempt()), null);
});

test('unsafe replay reserves a different provider for exactly one fresh handoff turn', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000 });
  session.providerSelection.sticky = false;
  const first = runtime.beginTurn({ session, turnId: 'turn-side-effect' });
  assert.equal(first.initial().providerId, 'empty');
  const attempt = { ...openAttempt(), replayFence: 'side_effect', sideEffectObserved: true };
  assert.equal(first.failover(quotaDecision(), attempt), null,
    'the original logical turn must never be replayed');
  const reservation = first.prepareHandoff(quotaDecision(), attempt);
  assert.equal(reservation.providerId, 'backup');
  assert.equal(events.at(-1).routePhase, 'handoff_pending');

  const handoff = runtime.beginTurn({ session, turnId: 'turn-handoff' });
  assert.equal(handoff.initial().providerId, 'backup');
  const later = runtime.beginTurn({ session, turnId: 'turn-later' });
  assert.equal(later.initial().providerId, 'empty', 'the reservation is one-shot');
});

test('unsafe replay does not prepare a handoff while background work is live', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000, backgroundActive: true });
  const turn = runtime.beginTurn({ session, turnId: 'turn-background-handoff' });
  turn.initial();
  const attempt = { ...openAttempt(), replayFence: 'side_effect', sideEffectObserved: true };
  assert.equal(turn.prepareHandoff(quotaDecision(), attempt), null);
});

test('handoff stops when every alternate provider is attempted or unavailable', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000, thirdFetchedAt: 990_000 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-no-alternate' });
  turn.initial();
  assert.equal(turn.failover(quotaDecision(), openAttempt()).invocationOptions.providerId, 'backup');
  const fenced = { ...openAttempt('backup'), replayFence: 'visible_output', visibleOutputObserved: true };
  assert.equal(turn.failover(quotaDecision(), fenced), null);
  assert.equal(turn.prepareHandoff(quotaDecision(), fenced), null);
});

test('every upstream HTTP 4xx can switch providers before output or side effects', () => {
  for (const httpStatus of [400, 401, 402, 403, 404, 405, 408, 409, 410, 422, 429, 451, 499]) {
    const { runtime, session } = fixture({ emptyFetchedAt: 900_000 });
    const turn = runtime.beginTurn({ session, turnId: `turn-${httpStatus}` });
    turn.initial();
    const next = turn.failover({
      action: 'fail_fast',
      error: {
        category: 'invalid_request_model', httpStatus,
        phase: 'before_first_token', partialOutput: false, sideEffects: false,
      },
    }, openAttempt());
    assert.equal(next.invocationOptions.providerId, 'backup', `HTTP ${httpStatus}`);
  }
});

test('HTTP 4xx still cannot cross visible-output, side-effect, or local-cancel fences', () => {
  const decision = {
    action: 'fail_fast',
    error: {
      category: 'invalid_request_model', httpStatus: 418,
      phase: 'before_first_token', partialOutput: false, sideEffects: false,
    },
  };
  const visible = fixture({ emptyFetchedAt: 900_000 });
  const visibleTurn = visible.runtime.beginTurn({ session: visible.session, turnId: 'visible' });
  visibleTurn.initial();
  assert.equal(visibleTurn.failover(decision, { ...openAttempt(), replayFence: 'visible_output' }), null);

  const cancelled = fixture({ emptyFetchedAt: 900_000 });
  const cancelledTurn = cancelled.runtime.beginTurn({ session: cancelled.session, turnId: 'cancelled' });
  cancelledTurn.initial();
  assert.equal(cancelledTurn.failover({
    ...decision, error: { ...decision.error, category: 'cancel_shutdown', httpStatus: 499 },
  }, openAttempt()), null);
});

test('attempt budget exhaustion is terminal and never falls back to same-provider retry', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000, maxAttempts: 2 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-budget' });
  turn.initial();
  assert.equal(turn.failover(quotaDecision(), openAttempt()).invocationOptions.providerId, 'backup');
  const exhausted = turn.failover(quotaDecision(), openAttempt('backup'));
  assert.equal(exhausted.terminal, true);
  assert.equal(exhausted.invocationOptions, null);
  assert.equal(exhausted.decision.action, 'fail_fast');
  assert.equal(exhausted.decision.reason, 'auto_attempt_budget_exhausted');
  assert.deepEqual(events.map(event => event.routePhase), ['selected', 'switched', 'exhausted']);
});

test('candidate pool exhaustion is terminal when remaining routes are freshly exhausted', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000, thirdFetchedAt: 990_000 });
  const turn = runtime.beginTurn({ session, turnId: 'turn-pool' });
  turn.initial();
  turn.failover(quotaDecision(), openAttempt());
  const exhausted = turn.failover(quotaDecision(), openAttempt('backup'));
  assert.equal(exhausted.terminal, true);
  assert.equal(exhausted.decision.action, 'fail_fast');
  assert.equal(exhausted.decision.reason, 'auto_candidate_pool_exhausted');
});

test('live background tasks fail closed before a provider route switch', () => {
  const { runtime, session, events } = fixture({
    emptyFetchedAt: 900_000, backgroundActive: true,
  });
  const turn = runtime.beginTurn({ session, turnId: 'turn-background' });
  turn.initial();
  const blocked = turn.failover(quotaDecision(), openAttempt());
  assert.equal(blocked.terminal, true);
  assert.equal(blocked.invocationOptions, null);
  assert.equal(blocked.decision.action, 'fail_fast');
  assert.equal(blocked.decision.reason, 'auto_background_tasks_active');
  assert.equal(events.at(-1).routePhase, 'blocked');
  assert.equal(events.at(-1).reasonCode, 'background_tasks_active');
});

test('a successful fallback becomes sticky on the next turn', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000 });
  const first = runtime.beginTurn({ session, turnId: 'turn-1' });
  first.initial();
  const next = first.failover(quotaDecision(), openAttempt());
  first.recordSuccess({ providerId: next.invocationOptions.providerId });
  const second = runtime.beginTurn({ session, turnId: 'turn-2' });
  assert.equal(second.initial().providerId, 'backup');
});

test('a fallback remains current across cloned selections and expired quota readings until it is exhausted', () => {
  const { runtime, session, limits, clock } = fixture({ emptyFetchedAt: 1_000_000 });
  const first = runtime.beginTurn({ session, turnId: 'initial-backup' });
  assert.equal(first.initial().providerId, 'backup');
  first.recordSuccess({ providerId: 'backup' });
  // The old exhausted reading ages out while the current account nears its
  // limit. Neither of these is a reason to retry the first account.
  for (const usedPercent of [89, 93, 99]) {
    clock.now += 61_000;
    limits.set('backup', {
      status: 'ok', fetchedAt: clock.now,
      summary: { windows: [{ usedPercent }] },
    });
    session.providerSelection = JSON.parse(JSON.stringify(session.providerSelection));
    const turn = runtime.beginTurn({ session, turnId: `usage-${usedPercent}` });
    assert.equal(turn.initial().providerId, 'backup');
    turn.recordSuccess({ providerId: 'backup' });
  }
  exhaust(limits, ['empty', 'backup'], clock.now);
  const final = runtime.beginTurn({ session, turnId: 'backup-exhausted' });
  assert.equal(final.initial().providerId, 'third');
});

test('a selected fallback survives a continuation without a successful turn outcome', () => {
  const { runtime, session } = fixture();
  const first = runtime.beginTurn({ session, turnId: 'partial-turn' });
  assert.equal(first.initial().providerId, 'empty');
  assert.equal(first.failover(quotaDecision(), openAttempt()).invocationOptions.providerId, 'backup');
  session.providerSelection = JSON.parse(JSON.stringify(session.providerSelection));
  assert.equal(runtime.beginTurn({ session, turnId: 'continuation' }).initial().providerId, 'backup');
});

test('a runtime restart restores only a last route whose policy signature still matches', () => {
  const { session, providers } = fixture();
  session.autoProviderLastRoute = {
    providerId: 'backup', cli: 'claude', selectionKey: selectionKey(session.providerSelection),
  };
  const restarted = createAutoProviderRuntime({ providers });
  assert.equal(restarted.beginTurn({ session, turnId: 'restored' }).initial().providerId, 'backup');

  session.providerSelection = {
    ...session.providerSelection,
    candidates: session.providerSelection.candidates.map(candidate => ({ ...candidate,
      priority: candidate.providerId === 'third' ? 1 : candidate.priority + 1,
    })),
  };
  const changed = createAutoProviderRuntime({ providers });
  assert.equal(changed.beginTurn({ session, turnId: 'changed-pool' }).initial().providerId, 'third');
  // The same policy change also invalidates a live runtime's sticky route.
  assert.equal(restarted.beginTurn({ session, turnId: 'changed-live' }).initial().providerId, 'third');
});

test('an unsigned legacy last route restores only an enabled line on its current lane and model', () => {
  const cases = [
    { label: 'valid', expected: 'backup' },
    { label: 'old-model', route: { model: 'removed-model' }, expected: 'empty' },
    { label: 'wrong-cli', route: { cli: 'codex' }, expected: 'empty' },
    { label: 'missing-provider', route: { providerId: 'removed' }, expected: 'empty' },
    { label: 'disabled', disable: true, expected: 'empty' },
    { label: 'sticky-off', sticky: false, expected: 'empty' },
  ];
  for (const item of cases) {
    const { session, providers } = fixture({ maxAttempts: 2 });
    session.autoProviderLastRoute = { providerId: 'backup', model: 'backup-model', ...item.route };
    if (item.disable) session.providerSelection.candidates[1].enabled = false;
    if (item.sticky === false) session.providerSelection.sticky = false;
    const runtime = createAutoProviderRuntime({ providers });
    assert.equal(runtime.beginTurn({ session, turnId: item.label }).initial().providerId,
      item.expected, item.label);
  }
});

test('a legacy auto-model route must match a model currently served by that provider', () => {
  for (const model of ['backup-alternate', 'removed-model', 'empty-model']) {
    const { session, providers } = fixture();
    providers.listProviders().find(provider => provider.id === 'backup').modelOptions.push('backup-alternate');
    session.providerSelection.candidates = session.providerSelection.candidates.map(candidate => ({
      ...candidate, tier: candidate.providerId === 'third' ? 'strong' : 'weak',
      ...(candidate.providerId === 'backup' ? { autoModel: true } : {}),
    }));
    session.providerSelection.routing = { provider: 'jev', tiers: ['weak', 'strong'], onUnknown: 'priority' };
    session.autoProviderLastRoute = { providerId: 'backup', model };
    const runtime = createAutoProviderRuntime({ providers, priceTable: null });
    const expected = model === 'backup-alternate' ? 'backup' : 'empty';
    assert.equal(runtime.beginTurn({ session, turnId: model }).initial().providerId, expected, model);
  }
});

test('a present null or wrong signature cannot use legacy route recovery', () => {
  for (const key of [null, 'another-pool', '']) {
    const { session, providers } = fixture();
    session.autoProviderLastRoute = {
      providerId: 'backup', model: 'backup-model', cli: 'claude', selectionKey: key,
    };
    const runtime = createAutoProviderRuntime({ providers });
    assert.equal(runtime.beginTurn({ session, turnId: `key-${key}` }).initial().providerId, 'empty');
  }
});

test('cloning a cross-CLI selection preserves a pending handoff reservation', () => {
  const { runtime, session } = crossFixture();
  const turn = runtime.beginTurn({ session, turnId: 'source' });
  assert.equal(turn.initial().providerId, 'claude-a');
  turn.failover(quotaDecision(), openAttempt('claude-a'));
  const pending = turn.prepareHandoff(quotaDecision(), openAttempt('claude-b'));
  assert.equal(pending.cli, 'codex');
  session.providerSelection = JSON.parse(JSON.stringify(session.providerSelection));
  assert.equal(runtime.planTurn({ session, text: '继续' }).cli, 'codex');
  session.cli = 'codex';
  session.providerSelection = JSON.parse(JSON.stringify(session.providerSelection));
  const next = runtime.beginTurn({ session, turnId: 'target' });
  assert.equal(next.initial().providerId, pending.providerId);
});

test('sticky=false re-enters priority order on every turn and after runtime restart', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000 });
  session.providerSelection = { ...session.providerSelection, sticky: false };
  const first = runtime.beginTurn({ session, turnId: 'turn-1' });
  assert.equal(first.initial().providerId, 'empty');
  const fallback = first.failover(quotaDecision(), openAttempt());
  assert.equal(fallback.invocationOptions.providerId, 'backup');
  first.recordSuccess({ providerId: 'backup' });
  assert.equal(runtime.beginTurn({ session, turnId: 'turn-2' }).initial().providerId, 'empty');

  const restarted = fixture({ emptyFetchedAt: 900_000 });
  restarted.session.providerSelection = { ...restarted.session.providerSelection, sticky: false };
  assert.equal(restarted.runtime.beginTurn({
    session: restarted.session, turnId: 'turn-after-restart',
  }).initial().providerId, 'empty');
});

test('replacing or clearing the selection resets in-memory stickiness and route state', () => {
  const { runtime, session } = fixture({ emptyFetchedAt: 900_000 });
  const first = runtime.beginTurn({ session, turnId: 'turn-1' });
  first.initial();
  const next = first.failover(quotaDecision(), openAttempt());
  first.recordSuccess({ providerId: next.invocationOptions.providerId });
  assert.equal(runtime.snapshot(session.id).providerId, 'backup');

  runtime.beginTurn({ session: { ...session, providerSelection: null }, turnId: 'manual' });
  assert.equal(runtime.snapshot(session.id), null);

  const replaced = runtime.beginTurn({
    session: { ...session, providerSelection: { ...session.providerSelection } },
    turnId: 'turn-2',
  });
  assert.equal(replaced.initial().providerId, 'empty');
});

// ── planning a lane switch (cross-CLI pools) ─────────────────────────────────

test('a failover pool stays on its lane while any line there is usable', () => {
  const { runtime, session, events } = crossFixture();
  assert.equal(runtime.planTurn({ session, text: '继续' }), null);
  assert.deepEqual(events, []);
});

test('a failover pool switches lanes once its own lane is spent', () => {
  const { runtime, session, events } = crossFixture({ exhausted: ['claude-a', 'claude-b'] });
  const planned = runtime.planTurn({ session, text: '继续' });
  assert.deepEqual(planned, {
    cli: 'codex', fromCli: 'claude', providerId: 'codex-b', providerName: 'Codex B',
    model: 'codex-b-model', reasonCode: 'auto_cli_failover',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_auto_route');
  assert.equal(events[0].routePhase, 'cli_switch_planned');
  assert.equal(events[0].cli, 'codex');
  assert.equal(events[0].fromCli, 'claude');
  assert.equal(events[0].providerId, 'codex-b');
  assert.equal(events[0].reasonCode, 'auto_cli_failover');
  assert.equal(events[0].tier, null);
  assert.equal(events[0].routing, null);
  // Nothing was priced: a planned lane switch carries no price fields.
  assert.equal('price' in events[0], false);
  // Re-planning is idempotent while the reservation stands.
  assert.deepEqual(runtime.planTurn({ session, text: '继续' }), planned);
});

const TIERED_CANDIDATES = [
  { providerId: 'claude-a', priority: 1, tier: 'strong', cli: 'claude' },
  { providerId: 'claude-b', priority: 2, tier: 'strong', cli: 'claude' },
  { providerId: 'codex-a', priority: 3, tier: 'weak', cli: 'codex' },
  { providerId: 'codex-b', priority: 4, tier: 'weak', cli: 'codex' },
];

function weakVerdictStore() {
  return createAutoProviderRouting({
    jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
    now: () => 1_000_000,
    ttlMs: 60_000,
  });
}

test('a routing pool follows a verdict that lives on another lane', async () => {
  const { runtime, session, events, providers } = crossFixture({
    cliSwitch: 'routing',
    candidates: TIERED_CANDIDATES,
    selectionRouting: { provider: 'jev', tiers: ['weak', 'strong'] },
    routingStore: weakVerdictStore(),
  });
  await runtime.prepareTurn({ session, text: '简单的问题', providers });
  // The verdict is what picks the lane: a routing pool does not wait for its
  // own lane to run dry the way a failover pool does.
  const planned = runtime.planTurn({ session, text: '简单的问题' });
  assert.equal(planned.cli, 'codex');
  assert.equal(planned.providerId, 'codex-a');
  assert.equal(planned.reasonCode, 'auto_cli_routing');
  assert.equal(events[0].routePhase, 'cli_switch_planned');
  assert.equal(events[0].reasonCode, 'auto_cli_routing');
});

test('a failover pool ignores a verdict from another lane while its own is usable', async () => {
  const { runtime, session, events, providers } = crossFixture({
    candidates: TIERED_CANDIDATES,
    selectionRouting: { provider: 'jev', tiers: ['weak', 'strong'] },
    routingStore: weakVerdictStore(),
  });
  await runtime.prepareTurn({ session, text: '简单的问题', providers });
  // The same verdict on a failover pool: the claude lane still has a line, and
  // switching lanes costs a handoff, so the weaker-but-local line wins.
  assert.equal(runtime.planTurn({ session, text: '简单的问题' }), null);
  assert.deepEqual(events, []);
});

test('a tie under routing policy stays on the lane the session already runs on', () => {
  const { runtime, session, events } = crossFixture({
    cliSwitch: 'routing',
    candidates: [
      { providerId: 'claude-a', priority: 1, cli: 'claude' },
      { providerId: 'claude-b', priority: 11, cli: 'claude' },
      { providerId: 'codex-a', priority: 1, cli: 'codex' },
      { providerId: 'codex-b', priority: 11, cli: 'codex' },
    ],
  });
  // Leaving the lane costs a handoff, so an equal pick must not.
  assert.equal(runtime.planTurn({ session, text: '随便看看' }), null);
  assert.deepEqual(events, []);
});

test('a lane that cannot be switched to is never planned, and a stale plan for it is dropped', () => {
  const { runtime, session, events, state } = crossFixture({
    exhausted: ['claude-a', 'claude-b'],
  });
  state.disabledCli = 'codex';
  assert.equal(runtime.planTurn({ session, text: '继续' }), null);
  assert.deepEqual(events, []);
  // The lane was up when the plan was made; by the next call it is gone, and
  // the session must stay where it actually is.
  state.disabledCli = null;
  assert.equal(runtime.planTurn({ session, text: '继续' }).cli, 'codex');
  state.disabledCli = 'codex';
  assert.equal(runtime.planTurn({ session, text: '继续' }), null);
});

test('the hop budget caps lane switches and a successful turn resets it', () => {
  const { runtime, session, limits } = crossFixture({
    exhausted: ['claude-a', 'claude-b'], maxAttempts: 2,
  });
  assert.equal(runtime.planTurn({ session, text: '继续' }).cli, 'codex');
  assert.equal(runtime.planTurn({ session, text: '继续' }).cli, 'codex');
  // Two switches is the whole budget: a pool with every lane failing would
  // otherwise hand the session back and forth forever.
  assert.equal(runtime.planTurn({ session, text: '继续' }), null);

  limits.clear();
  const turn = runtime.beginTurn({ session, turnId: 'turn-lane', promptText: '继续' });
  assert.equal(turn.initial().providerId, 'claude-a');
  turn.recordSuccess({ providerId: 'claude-a' });
  exhaust(limits, ['claude-a', 'claude-b']);
  assert.equal(runtime.planTurn({ session, text: '继续' }).cli, 'codex');
});

test('a background notification never plans a lane switch', () => {
  const { runtime, session, events } = crossFixture({ exhausted: ['claude-a', 'claude-b'] });
  // A background report belongs to the lane whose tools it reports on.
  assert.equal(runtime.planTurn({ session, text: '任务完成', turnOptions: { bgTaskIds: ['bg-1'] } }), null);
  assert.equal(runtime.planTurn({ session, text: '任务完成', turnOptions: { bgToolUseIds: ['tool-1'] } }), null);
  assert.deepEqual(events, []);
});

test('a continuation stays on its lane unless a handoff reserved another one', () => {
  const { runtime, session } = crossFixture({ exhausted: ['claude-a', 'claude-b'] });
  assert.equal(runtime.planTurn({ session, text: '继续', turnOptions: { originContinue: true } }), null);
  // A message the user actually sent is not a continuation, even when a
  // continuation turn carries it.
  assert.equal(runtime.planTurn({
    session, text: '继续', turnOptions: { originContinue: true, directUserInput: true },
  }).cli, 'codex');
  // ...and once a lane is reserved, the continuation follows the reservation.
  assert.equal(runtime.planTurn({ session, text: '继续', turnOptions: { originContinue: true } }).cli, 'codex');
});

test('the turn after a plan starts on the reserved line of the new lane', () => {
  // codex-b is the lane's first pick but is momentarily out of quota when the
  // plan is made, so the reservation is for codex-a.
  const { runtime, session, events, limits } = crossFixture({
    exhausted: ['claude-a', 'claude-b', 'codex-b'],
  });
  const planned = runtime.planTurn({ session, text: '继续' });
  assert.equal(planned.cli, 'codex');
  assert.equal(planned.providerId, 'codex-a');

  limits.clear();
  session.cli = 'codex'; // the switch runtime moved the session before the turn
  const turn = runtime.beginTurn({ session, turnId: 'turn-lane', promptText: '继续' });
  // Priority order would start on codex-b now that it is back; the reservation
  // outranks it, because the plan was made for this turn.
  assert.deepEqual(turn.initial(), {
    providerId: 'codex-a', model: 'codex-a-model', reasonCode: 'auto_initial_selection',
  });
  const selected = events.filter(event => event.routePhase === 'selected').at(-1);
  assert.equal(selected.providerId, 'codex-a');
  assert.equal(selected.cli, 'codex');
  assert.equal('price' in selected, false);
  // After the reservation is consumed, the selected route remains current.
  const later = runtime.beginTurn({ session, turnId: 'turn-next', promptText: '继续' });
  assert.equal(later.initial().providerId, 'codex-a');
});

test('a legacy single-lane pool never plans a switch and keeps its event shape', () => {
  const { runtime, session, events } = fixture({ emptyFetchedAt: 900_000 });
  assert.equal(runtime.planTurn({ session, text: '你好' }), null);
  const turn = runtime.beginTurn({ session, turnId: 'turn-legacy' });
  assert.equal(turn.initial().providerId, 'empty');
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal('cli' in event, false);
    assert.equal('price' in event, false);
    assert.equal('priceSource' in event, false);
  }
});

// ── price-tiered pools ───────────────────────────────────────────────────────

const PRICE_NOW = 3_000_000;

// Each spec is one route: its models are its own, and a plain line runs on the
// first of them. `ladder` stands in for the ladder the runtime derives from the
// price table (they are asserted to agree through the tier a turn lands on).
function pricePool({ specs, ladder, verdictTier = null, maxAttempts = 2 }) {
  const prices = {};
  const catalog = specs.map(spec => {
    const models = Object.keys(spec.prices);
    Object.assign(prices, spec.prices);
    return {
      id: spec.id, name: spec.id, appType: 'claude', apiFormat: 'anthropic',
      compatibleClis: ['claude'], model: models[0], modelOptions: models,
    };
  });
  const providers = {
    appTypeForCli: () => 'claude',
    appTypesForCli: () => ['claude'],
    listProviders: () => catalog,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: () => true,
  };
  const events = [];
  const routing = createAutoProviderRouting({
    jev: {
      classify: async () => ({
        ok: true, tier: verdictTier || ladder[0], reasonCode: 'jev_choice', latencyMs: 4,
      }),
    },
    now: () => PRICE_NOW,
    ttlMs: 60_000,
    resolveLadder: ({ selection }) => (
      selection.routing.tiering === 'price' ? ladder : selection.routing.tiers
    ),
  });
  const runtime = createAutoProviderRuntime({
    providers,
    routing,
    priceTable: {
      lookup: model => (model in prices
        ? { blended: prices[model], input: 0, output: 0, model, source: 'stub' }
        : null),
    },
    providerLimitCache: { get: () => null },
    limitCacheStaleMs: 60_000,
    now: () => PRICE_NOW,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's-price', cli: 'claude', provider: 'legacy-concrete',
    providerSelection: {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts, sticky: false,
      candidates: specs.map(spec => ({
        providerId: spec.id, priority: spec.priority, enabled: true,
        ...(spec.autoModel ? { autoModel: true } : {}),
      })),
      routing: { provider: 'jev', tiering: 'price' },
    },
  };
  return { runtime, session, events, providers };
}

async function priceTurn(pool, text = '改个 typo', turnId = 't1') {
  await pool.runtime.prepareTurn({ session: pool.session, text, providers: pool.providers });
  return pool.runtime.beginTurn({ session: pool.session, turnId, promptText: text });
}

test('a price-tiered turn runs on the line its ladder judged, and audits the price', async () => {
  const specs = [
    { id: 'cheap', priority: 1, prices: { 'cheap-m': 1 } },
    { id: 'pricey', priority: 2, prices: { 'pricey-m': 10 } },
  ];
  const easy = pricePool({ specs, ladder: ['p1', 'p2'], verdictTier: 'p1' });
  const easyTurn = await priceTurn(easy);
  assert.deepEqual(easyTurn.initial(), {
    providerId: 'cheap', model: 'cheap-m', reasonCode: 'auto_initial_selection',
  });
  assert.equal(easyTurn.routing.source, 'jev');
  assert.equal(easyTurn.routing.tier, 'p1');
  assert.equal(easyTurn.routing.tierCount, 2);
  const selected = easy.events.at(-1);
  assert.equal(selected.routePhase, 'selected');
  assert.equal(selected.tier, 'p1');
  assert.equal(selected.preferredTier, 'p1');
  assert.equal(selected.price, 1);
  assert.equal(selected.priceSource, 'stub');
  // Still one lane: no lane field on the event.
  assert.equal('cli' in selected, false);

  const hard = pricePool({ specs, ladder: ['p1', 'p2'], verdictTier: 'p2' });
  const hardTurn = await priceTurn(hard, '重构整个 provider 层', 't2');
  assert.equal(hardTurn.initial().providerId, 'pricey');
  assert.equal(hard.events.at(-1).price, 10);
});

test('inside one price tier the cheaper line wins, and priority only breaks its ties', async () => {
  // Six distinct prices over four rungs: the two cheapest share p1.
  const pool = pricePool({
    ladder: ['p1', 'p2', 'p3', 'p4'],
    verdictTier: 'p1',
    specs: [
      { id: 'p2-cheap', priority: 1, prices: { 'p2-cheap-m': 2 } },
      { id: 'p1-cheap', priority: 9, prices: { 'p1-cheap-m': 1 } },
      { id: 'p3', priority: 3, prices: { 'p3-m': 3 } },
      { id: 'p4', priority: 4, prices: { 'p4-m': 4 } },
      { id: 'p5', priority: 5, prices: { 'p5-m': 5 } },
      { id: 'p6', priority: 6, prices: { 'p6-m': 6 } },
    ],
  });
  const turn = await priceTurn(pool);
  // Priority would start on p2-cheap; the ladder says both are p1, and inside a
  // rung the cheaper line goes first.
  assert.equal(turn.initial().providerId, 'p1-cheap');
  assert.equal(turn.routing.tierCount, 4);
  assert.equal(pool.events.at(-1).price, 1);
});

// ── manual tiering with an auto-model line ───────────────────────────────────

function manualPool({ candidates, prices = {}, verdictTier = 'simple', catalog = null, tiers = null }) {
  const now = 1_000_000;
  const list = catalog || [
    { id: 'flex', name: 'Flex', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'flex-cheap', modelOptions: ['flex-cheap', 'flex-pricey'] },
    { id: 'fixed', name: 'Fixed', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'fixed-m', modelOptions: ['fixed-m'] },
    { id: 'heavy', name: 'Heavy', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'heavy-m', modelOptions: ['heavy-m'] },
  ];
  const providers = {
    appTypeForCli: () => 'claude',
    appTypesForCli: () => ['claude'],
    listProviders: () => list,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: () => true,
  };
  const events = [];
  const routing = createAutoProviderRouting({
    jev: { classify: async () => ({ ok: true, tier: verdictTier, reasonCode: 'jev_choice' }) },
    now: () => now,
    ttlMs: 60_000,
  });
  const runtime = createAutoProviderRuntime({
    providers,
    routing,
    // The manual ladder needs prices only as a sort key, so a stub keeps the
    // shared table (and its background refresh) out of the test.
    priceTable: { lookup: model => (model in prices
      ? { blended: prices[model], input: 0, output: 0, model, source: 'stub' } : null) },
    providerLimitCache: { get: () => null },
    limitCacheStaleMs: 60_000,
    now: () => now,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's-manual', cli: 'claude', provider: 'legacy-concrete',
    providerSelection: {
      version: 1, mode: 'auto', maxAttempts: 2, sticky: false, candidates,
      routing: { provider: 'jev', tiers: tiers || [...new Set(candidates.map(c => c.tier))] },
    },
  };
  return { runtime, session, providers, events };
}

test('a manual ladder expands an auto-model line and tries its cheapest model first', async () => {
  const pool = manualPool({
    prices: { 'flex-cheap': 1, 'flex-pricey': 9 },
    candidates: [
      { providerId: 'flex', priority: 1, autoModel: true, tier: 'simple' },
      { providerId: 'fixed', priority: 2, model: 'fixed-m', tier: 'complex' },
    ],
  });
  await pool.runtime.prepareTurn({ session: pool.session, text: '改个 typo', providers: pool.providers });
  const turn = pool.runtime.beginTurn({ session: pool.session, turnId: 't-manual', promptText: '改个 typo' });
  // The verdict lands on 'simple'; both variants of flex keep that tier, and the
  // cheaper one is tried first even though it is not the provider's default.
  assert.deepEqual(turn.initial(), {
    providerId: 'flex', model: 'flex-cheap', reasonCode: 'auto_initial_selection',
  });
  assert.equal(turn.routing.tier, 'simple');
  // The price that ordered the variants is an internal sort key: a manual pool
  // never reports one, unlike a price-tiered pool whose event audits it.
  const selected = pool.events.at(-1);
  assert.equal('price' in selected, false);
  assert.equal('priceSource' in selected, false);
});

test('a manual auto-model variant with no known price still runs, ranked last in its tier', async () => {
  const pool = manualPool({
    prices: { 'fixed-m': 2 },
    candidates: [
      { providerId: 'flex', priority: 1, autoModel: true, tier: 'simple' },
      { providerId: 'fixed', priority: 9, model: 'fixed-m', tier: 'simple' },
      { providerId: 'heavy', priority: 50, model: 'heavy-m', tier: 'complex' },
    ],
  });
  await pool.runtime.prepareTurn({ session: pool.session, text: '改个 typo', providers: pool.providers });
  // Both lines are hand-tagged 'simple', so the tier cannot separate them. The
  // auto-model line's models have no price, which only ranks them *last* inside
  // the tier — the line is still eligible, and never dropped for being unpriced.
  const turn = pool.runtime.beginTurn({ session: pool.session, turnId: 't-manual-noprice', promptText: '改个 typo' });
  const first = turn.initial();
  assert.equal(first.providerId, 'fixed');
  assert.equal(first.model, 'fixed-m');
});

// ── OpenCode native pool candidates ──────────────────────────────────────────

function opencodeProviders() {
  return {
    appTypeForCli: cli => (cli === 'codex' ? 'codex' : 'claude'),
    appTypesForCli: () => ['claude', 'codex'],
    listProviders: () => [],
    providerSupportsCli: () => true,
    modelValidForProvider: () => true,
  };
}

test('a native OpenCode line is a pool candidate whose models come from the opencode cache', async () => {
  const { _setCacheForTest, _resetCacheForTest } = require('../src/routes/opencode-models');
  _setCacheForTest(Date.now(), [
    { provider: 'opencode', model: 'big-pickle', label: 'opencode/big-pickle' },
    { provider: 'opencode', model: 'grok-code', label: 'opencode/grok-code' },
    { provider: 'opencodego', model: 'kimi-k2', label: 'opencodego/kimi-k2' },
  ]);
  try {
    const providers = opencodeProviders();
    const routing = createAutoProviderRouting({
      jev: { classify: async () => ({ ok: true, tier: 'simple', reasonCode: 'jev_choice' }) },
      now: () => 1_000_000,
      ttlMs: 60_000,
    });
    const runtime = createAutoProviderRuntime({
      providers,
      routing,
      priceTable: { lookup: () => null },
      providerLimitCache: { get: () => null },
      limitCacheStaleMs: 60_000,
      now: () => 1_000_000,
      emit: () => {},
      hasLiveBackgroundTasks: () => false,
    });
    const session = {
      id: 's-native', cli: 'opencode', provider: 'legacy-concrete',
      providerSelection: {
        version: 1, mode: 'auto', maxAttempts: 2, sticky: false,
        candidates: [
          { providerId: 'opencode-native:opencode', cli: 'opencode', autoModel: true, priority: 1, tier: 'simple' },
          { providerId: 'opencode-native:opencodego', cli: 'opencode', model: 'opencodego/kimi-k2', priority: 2, tier: 'complex' },
        ],
        routing: { provider: 'jev', tiers: ['simple', 'complex'] },
      },
    };
    await runtime.prepareTurn({ session, text: '改个 typo', providers });
    const turn = runtime.beginTurn({ session, turnId: 't-native', promptText: '改个 typo' });
    // The auto-model native line expands over the cache's `<id>/<model>` ids for
    // the id it names, and the verdict picks one of them.
    assert.deepEqual(turn.initial(), {
      providerId: 'opencode-native:opencode', model: 'opencode/big-pickle',
      reasonCode: 'auto_initial_selection',
    });
  } finally {
    _resetCacheForTest();
  }
});

test('a native OpenCode line without a cached model list still routes on its default', () => {
  const { _resetCacheForTest } = require('../src/routes/opencode-models');
  _resetCacheForTest();
  const providers = opencodeProviders();
  const events = [];
  const runtime = createAutoProviderRuntime({
    providers,
    priceTable: { lookup: () => null },
    providerLimitCache: { get: () => null },
    limitCacheStaleMs: 60_000,
    now: () => 1_000_000,
    emit: (_sessionId, event) => events.push(event),
    hasLiveBackgroundTasks: () => false,
  });
  const session = {
    id: 's-native-cold', cli: 'opencode',
    providerSelection: {
      version: 1, mode: 'auto', maxAttempts: 2, sticky: false,
      candidates: [
        { providerId: 'opencode-native:opencode', cli: 'opencode', priority: 1 },
        { providerId: 'opencode-native:opencodego', cli: 'opencode', model: 'opencodego/kimi-k2', priority: 2 },
      ],
    },
  };
  const turn = runtime.beginTurn({ session, turnId: 't-native-cold' });
  // No cache, no modelOptions: the line keeps a null model, so OpenCode runs its
  // own default rather than a fabricated one.
  assert.deepEqual(turn.initial(), {
    providerId: 'opencode-native:opencode', model: null, reasonCode: 'auto_initial_selection',
  });
  assert.equal(events[0].providerName, 'OpenCode Zen');
});

test('an auto-model line is expanded, and the judged tier picks the model', async () => {
  const specs = [
    { id: 'flex', priority: 1, autoModel: true, prices: { 'flex-cheap': 1, 'flex-pricey': 9 } },
    { id: 'fixed', priority: 2, prices: { 'fixed-m': 20 } },
  ];
  const easy = pricePool({ specs, ladder: ['p1', 'p2', 'p3'], verdictTier: 'p1' });
  const easyTurn = await priceTurn(easy);
  assert.deepEqual(easyTurn.initial(), {
    providerId: 'flex', model: 'flex-cheap', reasonCode: 'auto_initial_selection',
  });
  assert.equal(easyTurn.routing.tierCount, 3);

  const hard = pricePool({ specs, ladder: ['p1', 'p2', 'p3'], verdictTier: 'p2' });
  const hardTurn = await priceTurn(hard, '重构整个 provider 层', 't2');
  assert.deepEqual(hardTurn.initial(), {
    providerId: 'flex', model: 'flex-pricey', reasonCode: 'auto_initial_selection',
  });

  // The ladder spans every line of the pool, the unexpanded route included.
  const fixed = pricePool({ specs, ladder: ['p1', 'p2', 'p3'], verdictTier: 'p3' });
  const fixedTurn = await priceTurn(fixed, '更难的活', 't3');
  assert.equal(fixedTurn.initial().providerId, 'fixed');
  assert.equal(fixed.events.at(-1).price, 20);
});

// ── Official accounts: one provider per signed-in login, steered by quota ──

test('per-account usage windows feed limitState: fullest live window, reset windows ignored, 100% is exhausted', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  const entry = windows => ({ status: 'ok', fetchedAt: 990_000, summary: { kind: 'claude', status: 'ok', windows } });
  assert.deepEqual(limitState(entry([{ window: '5h', usedPercent: 40, resetMs: 2_000_000 }, { window: '7d', usedPercent: 72, resetMs: 9_000_000 }]),
    { now: 1_000_000, staleAfterMs: 60_000 }), { state: 'available', reason: 'fresh_limit_available', usedPercent: 72 });
  assert.equal(limitState(entry([{ window: '5h', usedPercent: 99, resetMs: 999_000 }, { window: '7d', usedPercent: 10 }]),
    { now: 1_000_000, staleAfterMs: 60_000 }).usedPercent, 10, 'a window past its reset no longer binds');
  assert.equal(limitState(entry([{ window: '5h', usedPercent: 100, resetMs: 2_000_000 }]),
    { now: 1_000_000, staleAfterMs: 60_000 }).state, 'exhausted');
  const stale = limitState(entry([{ window: '5h', usedPercent: 55 }]), { now: 990_000 + 10 * 60_000, staleAfterMs: 60_000 });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.usedPercent, 55, 'a sweeper reading stays a steering hint after it stops being a verdict');
  assert.equal(limitState(entry([{ window: '5h', usedPercent: 55 }]), { now: 990_000 + 31 * 60_000, staleAfterMs: 60_000 }).usedPercent, null);
});

test('chooseCandidate steers between official accounts by headroom without bouncing a sticky session', () => {
  const { chooseCandidate } = require('../src/chat/auto-provider-policy');
  const line = (providerId, usedPercent, index, extra = {}) => ({
    providerId, index, priority: 0, enabled: true, trustDomain: 'official', limitState: 'available', usedPercent, ...extra,
  });
  // No sticky route: the account with more headroom wins over pool order.
  assert.equal(chooseCandidate({ candidates: [line('acct-a', 70, 0), line('acct-b', 15, 1)] }).candidate.providerId, 'acct-b');
  // Within the same 20-point band, pool order stands.
  assert.equal(chooseCandidate({ candidates: [line('acct-a', 30, 0), line('acct-b', 25, 1)] }).candidate.providerId, 'acct-a');
  // Sticky wins while the account is usable, including near its limit.
  assert.equal(chooseCandidate({ candidates: [line('acct-a', 70, 0), line('acct-b', 15, 1)], stickyProviderId: 'acct-a' }).candidate.providerId, 'acct-a');
  assert.equal(chooseCandidate({ candidates: [line('acct-a', 93, 0), line('acct-b', 15, 1)], stickyProviderId: 'acct-a' }).candidate.providerId, 'acct-a');
  assert.equal(chooseCandidate({ candidates: [line('acct-a', 100, 0, { limitState: 'exhausted' }), line('acct-b', 15, 1)], stickyProviderId: 'acct-a' }).candidate.providerId, 'acct-b');
  // Unknown usage is never treated as headroom or pressure.
  assert.equal(chooseCandidate({ candidates: [line('acct-a', null, 0), line('acct-b', 15, 1)] }).candidate.providerId, 'acct-a');
  // Jev's tier verdict still comes first: quota only orders inside the preferred tier.
  assert.equal(chooseCandidate({
    candidates: [line('acct-a', 80, 0, { tier: 'strong' }), line('acct-b', 5, 1, { tier: 'weak' })],
    preferredTier: 'strong', stickyProviderId: 'acct-b',
  }).candidate.providerId, 'acct-a');
  // Non-official pools keep their legacy order regardless of usage.
  assert.equal(chooseCandidate({ candidates: [line('relay-a', 70, 0, { trustDomain: 'relay' }), line('relay-b', 5, 1, { trustDomain: 'relay' })] }).candidate.providerId, 'relay-a');
});

test('official account usage sweeper records every signed-in account under its own provider id', async () => {
  const { createOfficialAccountUsageSweeper, claudeUsageWindows } = require('../src/quota/official-account-usage');
  assert.deepEqual(claudeUsageWindows({ five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: null } }),
    [{ window: '5h', label: 'Current session', usedPercent: 42, resetMs: null }]);
  const recorded = [];
  const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';
  const sweeper = createOfficialAccountUsageSweeper({
    accounts: {
      listClaudeAccounts: () => [{ id: A, loggedIn: true }, { id: B, loggedIn: true }, { id: C, loggedIn: false }],
      listCodexAccounts: () => [{ id: A, loggedIn: true }],
    },
    credentials: { readAccountToken: async id => ({ token: `tok-${id}` }) },
    recorder: { recordOfficialWindows: (appType, providerId, data) => recorded.push([appType, providerId, data.windows[0].usedPercent]) },
    readClaudeUsage: async (_fetch, token) => {
      if (token === `tok-${B}`) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 60_000 });
      return { five_hour: { utilization: 12 } };
    },
    pollCodex: async () => { throw new Error('single codex account must not be polled'); },
    logger: { warn() {} },
    now: () => 1_000_000,
  });
  assert.equal(await sweeper.sweepOnce(), 1);
  assert.deepEqual(recorded, [['claude', `claude-official-${A}`, 12]]);
  recorded.length = 0;
  await sweeper.sweepOnce();
  assert.deepEqual(recorded, [['claude', `claude-official-${A}`, 12]], 'a throttled account is backed off, not hammered');
});

// ── pool memory: a fresh session starts on the line the pool last finished on ──

function poolMemoryFixture({ remembered, exhausted = [], ownRoute = null } = {}) {
  const base = fixture({ emptyFetchedAt: 1_000_000 });
  exhaust(base.limits, exhausted);
  const key = selectionKey(base.session.providerSelection);
  const asked = [];
  const runtime = createAutoProviderRuntime({
    providers: base.providers,
    providerLimitCache: { get: (_appType, id) => base.limits.get(id) || null },
    limitCacheStaleMs: 60_000,
    now: () => base.clock.now,
    emit: Object.assign((_sessionId, event) => base.events.push(event), {
      lastGoodRoute: (askedKey, sessionId) => {
        asked.push([askedKey, sessionId]);
        return askedKey === key ? remembered : null;
      },
    }),
  });
  if (ownRoute) base.session.autoProviderLastRoute = { ...ownRoute, selectionKey: key };
  return { ...base, runtime, asked, key };
}

test('a fresh session of the same pool starts on the line the pool last finished a turn on', () => {
  // Priority order would pick backup (empty is out of balance); the pool last
  // finished on third, so a new session starts there instead.
  const { runtime, session, asked, key } = poolMemoryFixture({
    remembered: { cli: 'claude', providerId: 'third', model: 'third-model', succeededAt: 900_000 },
  });
  assert.equal(runtime.beginTurn({ session, turnId: 'fresh' }).initial().providerId, 'third');
  assert.deepEqual(asked, [[key, 's1']]);
});

test('the remembered line is only a preference: exhausted it is skipped, a failure fails over', () => {
  const spent = poolMemoryFixture({
    remembered: { cli: 'claude', providerId: 'third', succeededAt: 900_000 }, exhausted: ['third'],
  });
  assert.equal(spent.runtime.beginTurn({ session: spent.session, turnId: 'spent' }).initial().providerId, 'backup');

  const failing = poolMemoryFixture({ remembered: { cli: 'claude', providerId: 'third', succeededAt: 900_000 } });
  const turn = failing.runtime.beginTurn({ session: failing.session, turnId: 'failing' });
  assert.equal(turn.initial().providerId, 'third');
  assert.equal(turn.failover(quotaDecision(), openAttempt()).invocationOptions.providerId, 'backup');
});

test('a session with its own line, an unknown line, or a different pool ignores the pool memory', () => {
  const own = poolMemoryFixture({
    remembered: { cli: 'claude', providerId: 'third', succeededAt: 900_000 },
    ownRoute: { cli: 'claude', providerId: 'backup' },
  });
  assert.equal(own.runtime.beginTurn({ session: own.session, turnId: 'own' }).initial().providerId, 'backup');
  assert.deepEqual(own.asked, []);

  const unknown = poolMemoryFixture({ remembered: { cli: 'claude', providerId: 'gone', succeededAt: 900_000 } });
  assert.equal(unknown.runtime.beginTurn({ session: unknown.session, turnId: 'gone' }).initial().providerId, 'backup');

  const other = poolMemoryFixture({ remembered: { cli: 'claude', providerId: 'third', succeededAt: 900_000 } });
  other.session.providerSelection = { ...other.session.providerSelection, maxAttempts: 2 };
  assert.equal(other.runtime.beginTurn({ session: other.session, turnId: 'other' }).initial().providerId, 'backup');
});

test('a remembered line on another lane moves a fresh failover session there before its first turn', () => {
  const { providers } = laneProviders();
  const limits = new Map();
  const events = [];
  const remembered = { cli: 'codex', providerId: 'codex-a', succeededAt: 900_000 };
  const make = () => createAutoProviderRuntime({
    providers,
    providerLimitCache: { get: (_appType, id) => limits.get(id) || null },
    limitCacheStaleMs: 60_000,
    now: () => 1_000_000,
    emit: Object.assign((_sessionId, event) => events.push(event), { lastGoodRoute: () => remembered }),
    isCliAvailable: () => true,
  });
  const { session } = crossFixture();
  const runtime = make();
  // claude-a is usable, so without the memory a failover pool would stay put.
  const planned = runtime.planTurn({ session, text: '你好' });
  assert.deepEqual(planned, {
    cli: 'codex', fromCli: 'claude', providerId: 'codex-a', providerName: 'Codex A',
    model: 'codex-a-model', reasonCode: 'auto_pool_memory',
  });
  session.cli = 'codex';
  assert.equal(runtime.beginTurn({ session, turnId: 'moved', promptText: '你好' }).initial().providerId, 'codex-a');

  // A remembered line the quota cache now marks spent is not moved to.
  exhaust(limits, ['codex-a']);
  const fresh = crossFixture().session;
  assert.equal(make().planTurn({ session: fresh, text: '你好' }), null);
});

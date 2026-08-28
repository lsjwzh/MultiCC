'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');

function fixture({
  emptyFetchedAt = 0, thirdFetchedAt = null, maxAttempts = 3, backgroundActive = false,
} = {}) {
  const now = 1_000_000;
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
    now: () => now,
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
  return { runtime, session, events };
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
  assert.deepEqual(events.map(event => event.phase), ['selected', 'switched']);
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
  }), { state: 'exhausted', reason: 'fresh_limit_exhausted' });
});

test('a fresh rejected window summary is exhausted even below 100 percent', () => {
  const { limitState } = require('../src/chat/auto-provider-policy');
  assert.deepEqual(limitState({
    status: 'ok', fetchedAt: 990_000,
    summary: { kind: 'window', status: 'rejected', usedPercentage: 90 },
    summaryText: '5h 0%',
  }, { now: 1_000_000, staleAfterMs: 60_000 }), {
    state: 'exhausted', reason: 'fresh_limit_exhausted',
  });
});

test('OpenCode runtime discovers Codex-pool candidates and reads their own quota namespace', () => {
  const now = 1_000_000;
  const getCalls = [];
  const catalogByApp = {
    claude: [],
    codex: [
      { id: 'codex-empty', name: 'Codex Empty', appType: 'codex', apiFormat: 'openai_chat', compatibleClis: ['opencode'], model: 'empty-model', modelOptions: ['empty-model'] },
      { id: 'codex-backup', name: 'Codex Backup', appType: 'codex', apiFormat: 'openai_chat', compatibleClis: ['opencode'], model: 'backup-model', modelOptions: ['backup-model'] },
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
        version: 1, mode: 'auto', protocol: 'openai_chat', maxAttempts: 2,
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
  assert.deepEqual(events.map(event => event.phase), ['selected', 'switched', 'exhausted']);
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
  assert.equal(events.at(-1).phase, 'blocked');
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

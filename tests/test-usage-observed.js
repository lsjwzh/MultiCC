'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderBinding } = require('../src/provider-binding');
const {
  UsageObservedError,
  createUsageObserved,
  validateUsageObserved,
} = require('../src/usage-observed');

function exactUsage(overrides = {}) {
  return {
    eventId: 'cpr-event-1',
    occurredAt: 1_750_000_000_000,
    sessionId: 'session-1',
    providerId: 'provider-1',
    roleKind: 'main',
    routeName: 'main',
    source: 'exact',
    coverage: 'observed',
    status: 'success',
    protocol: 'openai-responses',
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 },
    latencyMs: 25,
    ...overrides,
  };
}

test('UsageObserved has a stable eventId and idempotent validation', () => {
  const first = createUsageObserved(exactUsage());
  const second = createUsageObserved(exactUsage());
  assert.equal(first.eventId, second.eventId);
  assert.match(first.eventId, /^uo_[a-f0-9]{32}$/);
  assert.equal(first.sourceEventId, 'cpr-event-1');
  assert.deepEqual(first.tokens, { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, total: 15 });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.tokens), true);
  assert.equal(validateUsageObserved(first).eventId, first.eventId);
  assert.equal(
    createUsageObserved(exactUsage({ occurredAt: first.occurredAt + 5000, model: 'corrected-model' })).eventId,
    first.eventId,
    'upstream source id, not mutable delivery details, owns event identity',
  );

  const withoutSource = createUsageObserved(exactUsage({ eventId: undefined }));
  assert.equal(validateUsageObserved(withoutSource).eventId, withoutSource.eventId);
  assert.throws(
    () => validateUsageObserved({ ...withoutSource, eventId: `uo_${'0'.repeat(32)}` }),
    error => error.code === 'USAGE_EVENT_ID_MISMATCH',
  );
  assert.notEqual(
    createUsageObserved(exactUsage({ eventId: undefined, model: 'other' })).eventId,
    withoutSource.eventId,
  );
});

test('UsageObserved validates coverage, source, roleKind, agentRole, and routeName', () => {
  assert.throws(
    () => createUsageObserved(exactUsage({ coverage: 'observed', usage: null })),
    /tokens are required/,
  );
  assert.throws(
    () => createUsageObserved(exactUsage({ coverage: 'unobservable', status: 'unobservable' })),
    /must not contain token counts/,
  );
  assert.throws(() => createUsageObserved(exactUsage({ source: 'estimated' })), /source/);
  assert.throws(() => createUsageObserved(exactUsage({ roleKind: 'worker' })), /roleKind/);
  assert.throws(
    () => createUsageObserved(exactUsage({ roleKind: 'sub', routeName: 'Bad Route', agentRole: 'custom' })),
    /routeName/,
  );
  assert.throws(
    () => createUsageObserved(exactUsage({ roleKind: 'main', agentRole: 'default' })),
    /only valid for sub/,
  );

  const unobservable = createUsageObserved(exactUsage({
    coverage: 'unobservable', status: 'error', usage: null, errorCode: 'UPSTREAM_RESET',
  }));
  assert.equal(unobservable.tokens, null);
  assert.equal(unobservable.coverage, 'unobservable');
});

test('UsageObserved binds attribution and rejects conflicts', () => {
  const binding = createProviderBinding({
    sessionId: 'session-sub', cli: 'codex', providerId: 'provider-sub',
    roleKind: 'sub', agentRole: 'custom', routeName: 'reviewer',
  });
  const event = createUsageObserved({
    eventId: 'proxy-event-9',
    occurredAt: 1_750_000_001_000,
    source: 'exact',
    coverage: 'observed',
    status: 'success',
    protocol: 'anthropic-messages',
    tokens: { input: 2, output: 1 },
    authToken: 'ignored-secret-input',
  }, binding);
  assert.equal(event.sessionId, 'session-sub');
  assert.equal(event.providerId, 'provider-sub');
  assert.equal(event.roleKind, 'sub');
  assert.equal(event.agentRole, 'custom');
  assert.equal(event.routeName, 'reviewer');
  assert.equal(JSON.stringify(event).includes('ignored-secret-input'), false);

  assert.throws(
    () => createUsageObserved(exactUsage({ sessionId: 'wrong-session' }), binding),
    error => error instanceof UsageObservedError && error.code === 'USAGE_BINDING_MISMATCH',
  );
});

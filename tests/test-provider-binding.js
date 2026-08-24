'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderBindingError,
  createProviderBinding,
  isProviderBinding,
  toLegacyProviderView,
} = require('../src/provider-binding');

test('ProviderBinding is narrow, immutable, and maps to a narrow legacy view', () => {
  const binding = createProviderBinding({
    sessionId: 'session-1',
    cli: 'codex',
    providerId: 'provider-1',
    model: 'model-1',
  });
  assert.equal(isProviderBinding(binding), true);
  assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(Object.keys(binding), [
    'sessionId', 'cli', 'providerId', 'model', 'roleKind', 'agentRole', 'routeName',
  ]);
  assert.equal(binding.roleKind, 'main');
  assert.equal(binding.agentRole, null);
  assert.equal(binding.routeName, 'main');

  const legacy = toLegacyProviderView(binding);
  assert.deepEqual(Object.keys(legacy), [
    'id', 'cli', 'provider', 'model', 'roleKind', 'agentRole', 'routeName',
  ]);
  assert.equal(legacy.provider, 'provider-1');
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal('token' in legacy, false);
  assert.equal('worktreePath' in legacy, false);
});

test('ProviderBinding refuses a whole session or credentials', () => {
  assert.throws(
    () => createProviderBinding({
      sessionId: 'session-1', cli: 'claude', providerId: 'p',
      label: 'too broad', worktreePath: '/tmp/repo', authToken: 'must-not-cross',
    }),
    error => error instanceof ProviderBindingError && error.code === 'PROVIDER_BINDING_TOO_BROAD',
  );
});

test('sub-agent binding validates agentRole and routeName', () => {
  const binding = createProviderBinding({
    sessionId: 'session-2', cli: 'claude', providerId: 'p',
    roleKind: 'sub', agentRole: 'custom', routeName: 'reviewer_1',
  });
  assert.equal(binding.agentRole, 'custom');
  assert.equal(binding.routeName, 'reviewer_1');
  assert.throws(
    () => createProviderBinding({
      sessionId: 'session-2', cli: 'claude', roleKind: 'sub',
      agentRole: 'reviewer', routeName: 'reviewer',
    }),
    /agentRole/,
  );
  assert.throws(
    () => createProviderBinding({
      sessionId: 'session-2', cli: 'claude', roleKind: 'main', agentRole: 'default',
    }),
    /only valid for sub/,
  );
});

test('every production chat CLI, including Kimi, can cross the narrow binding boundary', () => {
  for (const cli of ['claude', 'codex', 'opencode', 'zcode', 'qoder', 'kimi']) {
    assert.equal(createProviderBinding({ sessionId: `session-${cli}`, cli }).cli, cli);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderBindingError,
  createProviderBinding,
  isProviderBinding,
  toLegacyProviderView,
} = require('../src/providers/binding');
const { SUPPORTED_CHAT_CLIS } = require('../src/cli-switch');

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
    'sessionId', 'cli', 'providerId', 'model', 'roleKind', 'agentRole', 'routeName', 'accountId',
  ]);
  assert.equal(binding.roleKind, 'main');
  assert.equal(binding.agentRole, null);
  assert.equal(binding.routeName, 'main');
  assert.equal(binding.accountId, null);

  const legacy = toLegacyProviderView(binding);
  assert.deepEqual(Object.keys(legacy), [
    'id', 'cli', 'provider', 'model', 'roleKind', 'agentRole', 'routeName', 'accountId',
  ]);
  assert.equal(legacy.provider, 'provider-1');
  assert.equal(legacy.accountId, null);
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal('token' in legacy, false);
  assert.equal('worktreePath' in legacy, false);
});

test('ProviderBinding carries optional accountId and validates control characters', () => {
  const binding = createProviderBinding({
    sessionId: 'session-agy',
    cli: 'agy',
    accountId: '  0123456789abcdef  ',
  });
  assert.equal(binding.accountId, '0123456789abcdef');
  assert.equal(toLegacyProviderView(binding).accountId, '0123456789abcdef');
  assert.equal(createProviderBinding({ sessionId: 'session-agy', cli: 'agy', accountId: '' }).accountId, null);
  assert.throws(
    () => createProviderBinding({ sessionId: 'session-agy', cli: 'agy', accountId: 'bad\nid' }),
    /accountId is invalid/,
  );
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

test('every production chat CLI can cross the narrow binding boundary', () => {
  for (const cli of SUPPORTED_CHAT_CLIS) {
    assert.equal(createProviderBinding({ sessionId: `session-${cli}`, cli }).cli, cli);
  }
});

const legacy = require('./helpers/legacy-provider-binding');
const current = require('../src/providers/binding');

function outcome(api, input) {
  try {
    const binding = api.createProviderBinding(input);
    return {
      value: { ...binding }, view: api.toLegacyProviderView(binding),
      branded: api.isProviderBinding(binding), frozen: Object.isFrozen(binding),
    };
  } catch (error) {
    assert.ok(error instanceof api.ProviderBindingError);
    return { name: error.name, code: error.code, message: error.message };
  }
}

test('provider binding matches the frozen implementation for roles, routes and UTF-16 field boundaries', t => {
  let count = 0;
  const compare = input => {
    assert.deepEqual(outcome(current, input), outcome(legacy, input));
    count++;
  };
  const base = { sessionId: 's', cli: 'codex' };
  for (const cli of [...legacy.SUPPORTED_CLIS, ' CODEX ', null, 'unknown', '\ud800', Symbol('cli')]) {
    for (const roleKind of [undefined, 'MAIN', 'sub', 'AUX', 'unknown', 0]) {
      for (const agentRole of [undefined, ' CUSTOM ', 'explorer', 'bad']) {
        for (const routeName of [undefined, 'MAIN', 'Reviewer_1', '0invalid', 'a'.repeat(64), 'a'.repeat(65)]) {
          compare({ ...base, cli, roleKind, agentRole, routeName });
        }
      }
    }
  }
  for (const [key, max] of Object.entries({
    sessionId: 256, cli: 32, providerId: 256, model: 256,
    accountId: 64, roleKind: 16, agentRole: 32, routeName: 64,
  })) {
    for (const value of [null, undefined, false, 0, 1n, Symbol('val'), [], {}, '\ufeff a \u2029',
      '\ud800', '\udc00', 'ab\0c', 'a\u007fb', '😀'.repeat(max / 2), 'a'.repeat(max), 'a'.repeat(max + 1)]) {
      compare({ ...base, [key]: value });
    }
  }
  for (const input of [null, undefined, false, 1, [], new Proxy([], {}), () => {}, Object.create(base),
    { ...base, '\udfff': 1, '\ud800': 2, extra: 3 }, { ...base, [Symbol('ignored')]: true }]) compare(input);
  t.diagnostic(`${count} differential inputs matched`);
});

test('provider binding preserves proxy reads, coercion order and the identity of thrown values', () => {
  const sentinel = Object.freeze({ failure: true });
  const keys = ['sessionId', 'cli', 'providerId', 'model', 'accountId', 'roleKind', 'agentRole', 'routeName'];
  function observe(api, failure) {
    const trace = [];
    const fields = ['session', ' CODEX ', 'p', 'm', 'a', 'sub', 'custom', 'Review_1'];
    const input = new Proxy(Object.fromEntries(keys.map((key, index) => [key, {
      [Symbol.toPrimitive](hint) {
        trace.push(['toPrimitive', key, hint]);
        if (failure === 'convert-' + key) throw sentinel;
        return fields[index];
      },
    }])), {
      ownKeys(target) { trace.push('ownKeys'); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) {
        trace.push(['descriptor', key]);
        if (failure === 'descriptor-' + key) throw sentinel;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key) {
        trace.push(['get', key]);
        if (failure === 'get-' + key) throw sentinel;
        return target[key];
      },
    });
    if (failure) assert.throws(() => api.createProviderBinding(input), error => error === sentinel);
    else api.createProviderBinding(input);
    return trace;
  }
  for (const failure of [null, ...keys.flatMap(key => ['descriptor-', 'get-', 'convert-'].map(prefix => prefix + key))]) {
    assert.deepEqual(observe(current, failure), observe(legacy, failure));
  }
});

test('provider binding uses each live policy set and retains branding, view order and error identity', () => {
  const sentinel = new Error('view getter failed');
  for (const api of [current, legacy]) {
    api.SUPPORTED_CLIS.add('extra'); api.AGENT_ROLES.add('tester'); api.ROLE_KINDS.add('other');
    try {
      const sub = api.createProviderBinding({ cli: 'EXTRA', sessionId: 's', roleKind: 'sub', agentRole: 'TESTER' });
      assert.equal(sub.routeName, 'tester');
      assert.equal(api.createProviderBinding({ cli: 'extra', sessionId: 's', roleKind: 'other' }).routeName, 'other');
      assert.equal(api.isProviderBinding({ ...sub }), false);
      const order = [];
      const branded = Object.create(sub);
      for (const key of Object.keys(sub)) {
        Object.defineProperty(branded, key, { get() {
          order.push(key);
          if (key === 'model') throw sentinel;
          return sub[key];
        } });
      }
      Object.freeze(branded);
      assert.throws(() => api.toLegacyProviderView(branded), error => error === sentinel);
      assert.deepEqual(order, ['sessionId', 'cli', 'providerId', 'model']);
    } finally {
      api.SUPPORTED_CLIS.delete('extra'); api.AGENT_ROLES.delete('tester'); api.ROLE_KINDS.delete('other');
    }
  }
});

'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { createUsageLimitWiring } = require('../src/chat/usage-limit-wiring');

function fakeProviders(target) {
  return {
    appTypeForCli: (cli) => (cli === 'codex' ? 'codex' : cli === 'claude' ? 'claude' : null),
    getProviderLimitTarget: () => target,
  };
}

// createPoller stub: capture the resolveTarget/broadcast it's built with, and
// expose a way to drive them like the real poller would.
function stubPoller() {
  let cfg = null;
  const factory = (c) => { cfg = c; return { cfg }; };
  return { factory, resolve: (s) => cfg.resolveTarget(s), emit: (s, dto) => cfg.broadcast(s, dto) };
}

test('resolveTarget maps session→provider limit target; null for vendor CLI', () => {
  const sessions = new Map([
    ['glm-s', { provider: 'p-glm', cli: 'codex' }],
    ['qoder-s', { provider: 'p-q', cli: 'qoder' }],
    ['noprov', { cli: 'codex' }],
  ]);
  const sp = stubPoller();
  createUsageLimitWiring({
    persistedSessions: sessions,
    providers: fakeProviders({ providerId: 'p-glm', strategy: 'glm-monitor' }),
    chatBroadcast: () => {},
    createPoller: sp.factory,
  });
  assert.deepStrictEqual(sp.resolve('glm-s'), { providerId: 'p-glm', strategy: 'glm-monitor' });
  assert.strictEqual(sp.resolve('qoder-s'), null, 'vendor CLI (appType null) → no target');
  assert.strictEqual(sp.resolve('noprov'), null, 'no provider → no target');
  assert.strictEqual(sp.resolve('missing'), null, 'unknown session → no target');
});

test('broadcast maps window DTO → rate_limit_event, balance DTO → usage_balance_event', () => {
  const events = [];
  const sp = stubPoller();
  createUsageLimitWiring({
    persistedSessions: new Map(),
    providers: fakeProviders(null),
    chatBroadcast: (s, p) => events.push({ s, p }),
    createPoller: sp.factory,
  });

  sp.emit('sess', { kind: 'window', provider: 'glm', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.44, resetsAt: 123 });
  assert.strictEqual(events[0].p.type, 'rate_limit_event');
  assert.deepStrictEqual(events[0].p.rate_limit_info, {
    rateLimitType: 'five_hour', status: 'allowed', utilization: 0.44, resetsAt: 123, provider: 'glm',
  });

  sp.emit('sess', { kind: 'balance', provider: 'deepseek', available: true, currency: 'CNY', total: 110 });
  assert.strictEqual(events[1].p.type, 'usage_balance_event');
  assert.strictEqual(events[1].p.balance_info.total, 110);

  // Unknown kind → no broadcast.
  sp.emit('sess', { kind: 'mystery' });
  assert.strictEqual(events.length, 2);
});

test('throws when required deps are missing', () => {
  assert.throws(() => createUsageLimitWiring({}), /requires/);
});

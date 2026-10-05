'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoRouteNotes } = require('../src/chat/auto-route-notes');
const { selectionKey } = require('../src/chat/auto-provider-selection-key');
const { createAutoProviderRuntime } = require('../src/chat/auto-provider-runtime');

function selected(extra = {}) {
  return {
    type: 'provider_auto_route', version: 1, mode: 'auto', sessionId: 's1', turnId: 'turn-1',
    protocol: 'openai_responses', routePhase: 'selected', attemptNo: 1,
    providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4-flash',
    tier: 't1', preferredTier: 't1', trustDomain: 'third_party',
    routing: { source: 'jev', code: 'jev_choice', tier: 't1', tierIndex: 0, tierCount: 2, latencyMs: 900, onUnknown: 'strong' },
    candidates: ['must not be persisted'],
    ...extra,
  };
}

function fixture() {
  const broadcasts = [];
  const appended = [];
  const saves = [];
  const record = { id: 's1', cli: 'codex-exp', model: 'gpt-5.5', providerSelection: {
    mode: 'auto', protocol: 'openai_responses', candidates: [
      { providerId: 'deepseek', priority: 1 }, { providerId: 'or', priority: 2 },
    ],
  } };
  const emit = createAutoRouteNotes({
    broadcast: (sessionId, event) => broadcasts.push([sessionId, event]),
    append: (sessionId, message) => { appended.push([sessionId, message]); return { message }; },
    records: new Map([['s1', record]]),
    save: source => saves.push(source),
    now: () => 1_790_000_000_000,
  });
  return { emit, broadcasts, appended, saves, record };
}

test('a routed pick is persisted as a display-only note and remembered on the session', () => {
  const f = fixture();
  f.emit('s1', selected());
  assert.equal(f.appended.length, 1);
  const [sessionId, note] = f.appended[0];
  assert.equal(sessionId, 's1');
  assert.equal(note.role, 'system');
  assert.equal(note.kind, 'auto_route');
  assert.equal(note.clientMsgId, 'auto-route-turn-1-1');
  assert.equal(note.content, 'Auto → DeepSeek · deepseek-v4-flash');
  assert.deepEqual(note.autoRoute, {
    routePhase: 'selected', protocol: 'openai_responses', providerId: 'deepseek', providerName: 'DeepSeek',
    model: 'deepseek-v4-flash', tier: 't1', preferredTier: 't1',
    routing: { source: 'jev', code: 'jev_choice', tierIndex: 0, tierCount: 2, latencyMs: 900, onUnknown: 'strong' },
  });
  assert.deepEqual(f.record.autoProviderLastRoute, {
    selectionKey: selectionKey(f.record.providerSelection), cli: 'codex-exp',
    providerId: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-v4-flash', tier: 't1', at: 1_790_000_000_000,
  });
  assert.deepEqual(f.saves, ['runtime.auto-provider-route']);
  // The live event names the persisted note so a replay adopts the live line.
  assert.equal(f.broadcasts[0][1].noteClientMsgId, 'auto-route-turn-1-1');
  assert.equal(f.broadcasts[0][1].providerName, 'DeepSeek');
});

test('turns nobody asked Jev about and non-route phases leave no note', () => {
  const f = fixture();
  f.emit('s1', selected({ routing: null }));
  f.emit('s1', selected({ routing: { source: 'fallback', code: 'jev_not_prepared', onUnknown: 'strong' } }));
  f.emit('s1', selected({ routePhase: 'succeeded' }));
  assert.equal(f.appended.length, 0);
  assert.equal(f.broadcasts.length, 3);
  assert.ok(f.broadcasts.every(([, event]) => !event.noteClientMsgId));
  // A pick without a verdict is still the line that answered.
  assert.equal(f.record.autoProviderLastRoute.model, 'deepseek-v4-flash');
});

test('a failover updates the remembered line without a second note', () => {
  const f = fixture();
  f.emit('s1', selected());
  f.emit('s1', selected({ routePhase: 'switched', attemptNo: 2, providerId: 'or', providerName: 'OpenRouter', model: 'gpt-5.5' }));
  assert.equal(f.appended.length, 1);
  assert.equal(f.record.autoProviderLastRoute.providerName, 'OpenRouter');
  assert.equal(f.record.autoProviderLastRoute.model, 'gpt-5.5');
});

test('a history write failure never blocks the live event', () => {
  const broadcasts = [];
  const emit = createAutoRouteNotes({
    broadcast: (sessionId, event) => broadcasts.push(event),
    append: () => { throw new Error('disk full'); },
  });
  emit('s1', selected());
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].noteClientMsgId, undefined);
});

test('持久化的换线记录让新运行时继续当前线路，额度缓存过期也不回池首', () => {
  const f = fixture();
  const providers = {
    appTypeForCli: () => 'codex',
    providerSupportsCli: () => true,
    listProviders: () => [
      { id: 'deepseek', appType: 'codex', protocol: 'openai_responses' },
      { id: 'or', appType: 'codex', protocol: 'openai_responses' },
    ],
  };
  const exhausted = 'deepseek';
  const limitCache = { get: (_type, id) => ({
    fetchedAt: 1000000, status: 'ok', summary: { usedPercentage: id === exhausted ? 100 : 95 },
  }) };
  const firstRuntime = createAutoProviderRuntime({ providers, providerLimitCache: limitCache,
    now: () => 1000000, emit: f.emit });
  const first = firstRuntime.beginTurn({ session: f.record, turnId: 'before-restart' });
  assert.equal(first.initial().providerId, 'or');
  // 模拟真实持久化和进程重建；旧额度缓存现在全部过期。
  const restored = JSON.parse(JSON.stringify(f.record));
  const secondRuntime = createAutoProviderRuntime({ providers, providerLimitCache: limitCache,
    now: () => 10000000, emit: () => {} });
  for (let i = 0; i < 3; i += 1) {
    restored.providerSelection = JSON.parse(JSON.stringify(restored.providerSelection));
    const turn = secondRuntime.beginTurn({ session: restored, turnId: `after-restart-${i}` });
    assert.equal(turn.initial().providerId, 'or');
  }
  assert.equal(restored.autoProviderLastRoute.cli, 'codex-exp');
  assert.ok(restored.autoProviderLastRoute.selectionKey);
});

test('a line that finishes a turn is stamped, and the pool lookup returns the latest such line', () => {
  const pool = {
    mode: 'auto', protocol: 'openai_responses', candidates: [
      { providerId: 'deepseek', priority: 1 }, { providerId: 'or', priority: 2 },
    ],
  };
  const records = new Map([
    ['s1', { id: 's1', cli: 'codex-exp', providerSelection: pool }],
    ['s2', { id: 's2', cli: 'codex-exp', providerSelection: JSON.parse(JSON.stringify(pool)) }],
    ['s3', { id: 's3', cli: 'codex-exp', providerSelection: { ...pool, maxAttempts: 4 } }],
  ]);
  let clock = 1_000;
  const saves = [];
  const emit = createAutoRouteNotes({
    broadcast: () => {}, records, save: source => saves.push(source), now: () => clock,
  });
  const key = selectionKey(pool);
  const lookup = emit.lastGoodRoute;
  assert.equal(typeof lookup, 'function');

  // Selected alone is not a success.
  emit('s1', selected({ sessionId: 's1', routing: null, providerId: 'deepseek' }));
  assert.equal(lookup(key), null);
  emit('s1', selected({ sessionId: 's1', routing: null, routePhase: 'succeeded', providerId: 'deepseek' }));
  assert.equal(records.get('s1').autoProviderLastRoute.succeededAt, 1_000);
  assert.deepEqual(lookup(key), { cli: 'codex-exp', providerId: 'deepseek', model: 'deepseek-v4-flash', succeededAt: 1_000 });

  // A later success in another session of the same pool wins; another pool never counts.
  clock = 2_000;
  emit('s2', selected({ sessionId: 's2', routing: null, routePhase: 'switched', providerId: 'or', providerName: 'OR', model: null }));
  emit('s2', selected({ sessionId: 's2', routing: null, routePhase: 'succeeded', providerId: 'or', providerName: 'OR', model: null }));
  clock = 3_000;
  emit('s3', selected({ sessionId: 's3', routing: null, providerId: 'deepseek' }));
  emit('s3', selected({ sessionId: 's3', routing: null, routePhase: 'succeeded', providerId: 'deepseek' }));
  assert.equal(lookup(key).providerId, 'or');
  assert.equal(lookup(key, 's2').providerId, 'deepseek');
  // A success for a line that is no longer the session's current one is ignored.
  emit('s1', selected({ sessionId: 's1', routing: null, routePhase: 'succeeded', providerId: 'or' }));
  assert.equal(records.get('s1').autoProviderLastRoute.succeededAt, 1_000);
});

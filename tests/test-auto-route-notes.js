'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutoRouteNotes } = require('../src/chat/auto-route-notes');

function selected(extra = {}) {
  return {
    type: 'provider_auto_route', version: 1, mode: 'auto', sessionId: 's1', turnId: 'turn-1',
    protocol: 'openai_responses', phase: 'selected', attemptNo: 1,
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
  const record = { id: 's1', model: 'gpt-5.5', providerSelection: { mode: 'auto' } };
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
    phase: 'selected', protocol: 'openai_responses', providerId: 'deepseek', providerName: 'DeepSeek',
    model: 'deepseek-v4-flash', tier: 't1', preferredTier: 't1',
    routing: { source: 'jev', code: 'jev_choice', tierIndex: 0, tierCount: 2, latencyMs: 900, onUnknown: 'strong' },
  });
  assert.deepEqual(f.record.autoProviderLastRoute, {
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
  f.emit('s1', selected({ phase: 'succeeded' }));
  assert.equal(f.appended.length, 0);
  assert.equal(f.broadcasts.length, 3);
  assert.ok(f.broadcasts.every(([, event]) => !event.noteClientMsgId));
  // A pick without a verdict is still the line that answered.
  assert.equal(f.record.autoProviderLastRoute.model, 'deepseek-v4-flash');
});

test('a failover updates the remembered line without a second note', () => {
  const f = fixture();
  f.emit('s1', selected());
  f.emit('s1', selected({ phase: 'switched', attemptNo: 2, providerId: 'or', providerName: 'OpenRouter', model: 'gpt-5.5' }));
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

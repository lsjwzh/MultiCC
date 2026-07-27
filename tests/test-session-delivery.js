'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SYSTEM_PREFIX,
  createSessionDelivery,
} = require('../src/session-delivery');

function harness() {
  const admissions = [];
  const logs = [];
  const delivery = createSessionDelivery({
    admit(sessionId, text, options) {
      admissions.push({ sessionId, text, options });
      return { ok: true };
    },
    log: message => logs.push(message),
  });
  return { admissions, delivery, logs };
}

test('system continuation is prefixed once and cannot be promoted to retry by metadata', async () => {
  const h = harness();
  await h.delivery.deliverSystem('session-1', 'background result', {
    retry: true,
    deliveryId: 'delivery-1',
  });
  assert.deepEqual(h.admissions, [{
    sessionId: 'session-1',
    text: `${SYSTEM_PREFIX}background result`,
    options: {
      deliveryId: 'delivery-1',
      originContinue: true,
    },
  }]);

  await h.delivery.deliverSystem('session-1', `${SYSTEM_PREFIX}already marked`);
  assert.equal(h.admissions[1].text, `${SYSTEM_PREFIX}already marked`);
});

test('API recovery is admitted as a typed retry with stable metadata', async () => {
  const h = harness();
  await h.delivery.deliverRetry('session-1', 'provider recovered', {
    idempotencyKey: 'api-recovery:session-1:1000',
    taskSource: 'api_recovery',
  });
  assert.deepEqual(h.admissions, [{
    sessionId: 'session-1',
    text: `${SYSTEM_PREFIX}provider recovered`,
    options: {
      idempotencyKey: 'api-recovery:session-1:1000',
      taskSource: 'api_recovery',
      originContinue: true,
      retry: true,
    },
  }]);
});

test('invalid delivery kind is rejected before reaching session admission', () => {
  const h = harness();
  assert.throws(
    () => h.delivery.deliver('session-1', 'payload', { kind: 'task' }),
    /unsupported kind/,
  );
  assert.equal(h.admissions.length, 0);
});

test('transport rejection is contained and reported to the host logger', async () => {
  const logs = [];
  const delivery = createSessionDelivery({
    admit: async () => { throw new Error('scheduler offline'); },
    log: message => logs.push(message),
  });
  const result = await delivery.deliverContinuation('session-1', 'payload');
  assert.deepEqual(result, { ok: false, code: 'delivery_failed' });
  assert.match(logs[0], /scheduler offline/);
});

test('scheduler rejection is returned and made observable', async () => {
  const logs = [];
  const delivery = createSessionDelivery({
    admit: async () => ({ ok: false, code: 'session_gate_closed' }),
    log: message => logs.push(message),
  });
  const result = await delivery.deliverContinuation('session-1', 'payload');
  assert.deepEqual(result, { ok: false, code: 'session_gate_closed' });
  assert.match(logs[0], /session_gate_closed/);
});

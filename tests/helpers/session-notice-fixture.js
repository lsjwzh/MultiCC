'use strict';

// Test ports only. Policy, text and scheduling all come from the supplied API.
async function exercise(api, input) {
  const events = [];
  const notices = api.createSessionNotices({
    now: () => 1234,
    appendChatMessage(id, message) {
      events.push(['append', id, message]);
      if (input.mode === 'throw') throw new Error('disk unavailable');
      if (input.mode === 'reject') return Promise.reject(new Error('disk unavailable'));
      if (input.mode === 'resolve') return Promise.resolve(true);
      if (input.mode === 'resolve-empty') return Promise.resolve(false);
      if (input.mode === 'thenable') return { then(resolve) { events.push(['then']); resolve(true); } };
      return input.mode !== 'empty';
    },
    chatBroadcast(id, frame) {
      events.push(['broadcast', id, frame]);
      if (input.mode === 'broadcast-throw') throw new Error('broadcast unavailable');
    },
    logger: { warn: (...args) => events.push(['warn', ...args]) },
  });
  const args = { sessionId: input.sessionId, error: { code: 'fixture_error', detail: 'remedy\nnext step' },
    reason: 'delivery_locked', reasons: ['delivery_locked'], waitedMs: 90000, minutes: 61, heldForBackground: input.method === 'held' };
  const method = { lost: 'notifyLostMessage', stuck: 'notifyStuckDelivery', held: 'notifyStuckDelivery', cap: 'notifyHoldCap' }[input.method];
  const pending = notices[method](args);
  const promise = pending instanceof Promise;
  const returned = await pending;
  return { returned: returned === undefined ? 'undefined' : returned, promise, events };
}
module.exports = { exercise };

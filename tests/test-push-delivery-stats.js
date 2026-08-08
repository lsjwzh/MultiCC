'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const { assertTestDir } = require('../src/paths');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-push-delivery-'));
const dataDir = assertTestDir(path.join(testRoot, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
process.env.MULTICC_DATA_DIR = dataDir;

const webpush = require('web-push');
const originalSendNotification = webpush.sendNotification;
const push = require('../src/push');

function subscription(endpoint) {
  return { endpoint, keys: { auth: 'test', p256dh: 'test' } };
}

beforeEach(() => {
  push.subscriptions.clear();
  push.healthStats.clear();
  Object.assign(push.globalStats, {
    totalSent: 0,
    totalSuccess: 0,
    totalFail: 0,
    lastPushTime: 0,
    lastPushType: '',
    lastPushSessionId: '',
  });
});

after(() => {
  webpush.sendNotification = originalSendNotification;
  assertTestDir(testRoot);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('sendPushToAll reports a truthful empty-subscriber result', async () => {
  webpush.sendNotification = async () => { throw new Error('must not send'); };
  assert.deepEqual(await push.sendPushToAll({ title: 'unused' }), {
    subscriberCount: 0,
    deliveryCount: 0,
    failureCount: 0,
    staleCount: 0,
    remainingSubscriberCount: 0,
  });
});

test('sendPushToAll reports success, failure, stale cleanup and cumulative health', async () => {
  for (const endpoint of ['https://push.test/ok', 'https://push.test/fail', 'https://push.test/stale']) {
    push.subscriptions.set(endpoint, subscription(endpoint));
  }
  webpush.sendNotification = async sub => {
    if (sub.endpoint.endsWith('/ok')) return;
    const error = new Error(sub.endpoint.endsWith('/stale') ? 'gone' : 'upstream failed');
    error.statusCode = sub.endpoint.endsWith('/stale') ? 410 : 500;
    throw error;
  };

  const result = await push.sendPushToAll({ title: '统计测试' });
  assert.deepEqual(result, {
    subscriberCount: 3,
    deliveryCount: 1,
    failureCount: 2,
    staleCount: 1,
    remainingSubscriberCount: 2,
  });
  assert.deepEqual({
    sent: push.globalStats.totalSent,
    success: push.globalStats.totalSuccess,
    fail: push.globalStats.totalFail,
  }, { sent: 3, success: 1, fail: 2 });
  assert.equal(push.subscriptions.has('https://push.test/stale'), false);
  assert.equal(push.healthStats.has('https://push.test/stale'), false);
  assert.equal(push.healthStats.get('https://push.test/fail').consecutiveFails, 1);

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'push_subscriptions.json'), 'utf8'));
  assert.deepEqual(persisted.map(item => item.endpoint).sort(), [
    'https://push.test/fail',
    'https://push.test/ok',
  ]);
});

test('payload factory errors are isolated to their subscription and counted', async () => {
  push.subscriptions.set('https://push.test/a', subscription('https://push.test/a'));
  push.subscriptions.set('https://push.test/b', subscription('https://push.test/b'));
  const sent = [];
  webpush.sendNotification = async (sub, payload) => { sent.push([sub.endpoint, payload]); };

  const result = await push.sendPushToAll(sub => {
    if (sub.endpoint.endsWith('/a')) throw new Error('locale payload failed');
    return { title: 'ok' };
  });
  assert.deepEqual(result, {
    subscriberCount: 2,
    deliveryCount: 1,
    failureCount: 1,
    staleCount: 0,
    remainingSubscriberCount: 2,
  });
  assert.deepEqual(sent, [['https://push.test/b', JSON.stringify({ title: 'ok' })]]);
});

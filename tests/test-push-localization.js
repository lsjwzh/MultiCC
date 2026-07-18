'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolvePushPayload } = require('../src/push');

test('push payload factory receives each subscription locale', () => {
  const factory = (subscription) => ({
    locale: subscription.locale,
    title: subscription.locale === 'en' ? 'Completed' : '完成',
  });

  assert.deepEqual(resolvePushPayload(factory, { locale: 'zh' }), {
    locale: 'zh',
    title: '完成',
  });
  assert.deepEqual(resolvePushPayload(factory, { locale: 'en' }), {
    locale: 'en',
    title: 'Completed',
  });
});

test('static push payloads remain supported', () => {
  const payload = { title: 'MultiCC Test' };
  assert.equal(resolvePushPayload(payload, { locale: 'en' }), payload);
});

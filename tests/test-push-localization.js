'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const { assertTestDir } = require('../src/paths');
const testRoot = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-push-localization-')));
process.env.MULTICC_DATA_DIR = assertTestDir(path.join(testRoot, 'data'));
const { resolvePushPayload } = require('../src/push');

after(() => {
  assertTestDir(testRoot);
  fs.rmSync(testRoot, { recursive: true, force: true });
});

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

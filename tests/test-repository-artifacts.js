'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluatePolicy, scanTrackedEntry } = require('../scripts/check-repository-artifacts');

function entry(path, content) {
  return { path, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content || '') };
}

test('artifact policy rejects new APKs, backups, runtime state and raw audit dumps', () => {
  const files = [
    entry('release.apk', Buffer.concat([Buffer.from([0]), Buffer.alloc(1024 * 1024 + 1)])),
    entry('server.js.bak.next', 'backup'),
    entry('sessions.json', '{}'),
    entry('npm-audit-new.json', '{}'),
  ];
  const result = evaluatePolicy(files, { accepted: {} });
  assert.ok(result.unexpected.some(item => item === 'tracked-apk:release.apk'));
  assert.ok(result.unexpected.some(item => item === 'large-binary:release.apk'));
  assert.ok(result.unexpected.some(item => item === 'backup:server.js.bak.next'));
  assert.ok(result.unexpected.some(item => item === 'runtime-state:sessions.json'));
  assert.ok(result.unexpected.some(item => item === 'raw-audit-dump:npm-audit-new.json'));
});

test('artifact policy detects high-confidence credentials without logging values', () => {
  const credential = 'AKIA' + 'A'.repeat(16);
  assert.deepEqual(scanTrackedEntry('tests/fixtures/live.txt', Buffer.from(credential)), [
    'credential-content', 'sensitive-fixture',
  ]);
});

test('reviewed baseline accepts exact findings and reports stale entries', () => {
  const files = [entry('old.apk', Buffer.from([0, 1]))];
  const accepted = evaluatePolicy(files, { accepted: { 'tracked-apk': ['old.apk'] } });
  assert.deepEqual(accepted.unexpected, []);
  assert.deepEqual(accepted.stale, []);
  const stale = evaluatePolicy([], { accepted: { 'tracked-apk': ['old.apk'] } });
  assert.deepEqual(stale.stale, ['tracked-apk:old.apk']);
});

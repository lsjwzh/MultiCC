'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPaths } = require('../src/paths');

test('share create and revoke publish memory only after the durable write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-share-store-'));
  const previousDataDir = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/share');
  process.env.MULTICC_DATA_DIR = root;
  delete require.cache[modulePath];

  try {
    const share = require('../src/share');
    const file = createPaths({ dataDir: root }).sharesFile;

    assert.throws(
      () => share.create('session-a', { expiresAt: 'not-a-timestamp' }),
      /invalid share expiry/,
    );
    assert.throws(
      () => share.create('session-a', { password: 'x'.repeat(4097) }),
      /share password is too long/,
    );

    // A directory at the target path deterministically makes atomic rename
    // fail on every supported platform without relying on user permissions.
    fs.mkdirSync(file, { recursive: true });
    assert.throws(
      () => share.create('session-a', { access: 'view', label: 'first' }),
      error => !!error && typeof error.code === 'string',
    );
    assert.deepEqual(share.listForSession('session-a'), [],
      'failed create must not leave an in-memory-only share');

    fs.rmSync(file, { recursive: true, force: true });
    const created = share.create('session-a', { access: 'view', label: 'durable' });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[created.token].label, 'durable');
    const protectedShare = share.create('session-a', { access: 'view', password: 'pw' });
    assert.equal(share.verifyPassword(protectedShare.token, 'x'.repeat(4097)), false);

    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.throws(
      () => share.remove(created.token),
      error => !!error && typeof error.code === 'string',
    );
    assert.equal(share.get(created.token).token, created.token,
      'failed revoke must keep the last durable in-memory snapshot');

    fs.rmSync(file, { recursive: true, force: true });
    assert.equal(share.remove(created.token), true);
    assert.equal(share.get(created.token), null);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(persisted, created.token), false);
    assert.equal(Object.hasOwn(persisted, protectedShare.token), true);
  } finally {
    delete require.cache[modulePath];
    if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

// macos-unlock-password: Keychain-backed lock password store. The /usr/bin/security
// process is faked so tests never touch the real keychain and never print secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnlockPassword, SERVICE, MAX_PASSWORD_LENGTH } = require('../src/macos-unlock-password');

function harness(scripted = {}) {
  const calls = [];
  const execFileFn = (file, args, opts, cb) => {
    calls.push({ file, args });
    const hit = scripted[args[0]];
    if (hit && hit.error) return cb(hit.error, hit.stdout || '', hit.stderr || '');
    return cb(null, (hit && hit.stdout) || '', (hit && hit.stderr) || '');
  };
  const make = (o = {}) => createUnlockPassword({ platform: 'darwin', execFileFn, account: 'zhuanz', ...o });
  return { calls, execFileFn, make };
}

test('unlock password is mac-only and probes presence without asking for the secret', async () => {
  const h = harness({ 'find-generic-password': { stdout: 'keychain: "login"\n' } });
  const linux = createUnlockPassword({ platform: 'linux', execFileFn: h.execFileFn });
  assert.equal(linux.isAvailable(), false);
  assert.equal(await linux.hasPassword(), false);

  const up = h.make();
  assert.equal(await up.hasPassword(), true);
  assert.equal(h.calls[0].file, '/usr/bin/security');
  assert.equal(h.calls[0].args[0], 'find-generic-password');
  assert.equal(h.calls[0].args.includes('-w'), false, 'presence probe never fetches the value');

  const missing = harness({ 'find-generic-password': { error: new Error('not found'), stderr: 'item not found' } });
  assert.equal(await missing.make().hasPassword(), false);
});

test('unlock password stores with add-generic-password -U and rejects invalid input', async () => {
  const h = harness();
  const up = h.make();
  await up.setPassword('s3cret');
  const add = h.calls.find(c => c.args[0] === 'add-generic-password');
  assert.ok(add);
  assert.ok(add.args.includes('-U'));
  assert.ok(add.args.includes('-s') && add.args.includes(SERVICE));
  assert.ok(add.args.includes('-a') && add.args.includes('zhuanz'));
  assert.ok(add.args.includes('-w') && add.args.includes('s3cret'));

  await assert.rejects(() => up.setPassword(''), /password is required/);
  await assert.rejects(() => up.setPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)), /too long/);

  // 失败消息只带安全 detail，绝不回显密码本身。
  const failing = harness({
    'add-generic-password': { error: new Error('EACCES'), stderr: 'errSecInteractionNotAllowed' },
  });
  const error = await failing.make().setPassword('topsecret').catch(e => e);
  assert.match(error.message, /errSecInteractionNotAllowed/);
  assert.ok(!String(error.message).includes('topsecret'));
});

test('unlock password clears via delete-generic-password and tolerates a missing entry', async () => {
  const h = harness({ 'delete-generic-password': { error: new Error('not found') } });
  const up = h.make();
  await up.clearPassword();
  assert.equal(h.calls[0].args[0], 'delete-generic-password');

  const linux = createUnlockPassword({ platform: 'linux', execFileFn: h.execFileFn });
  await linux.clearPassword();
  assert.equal(h.calls.length, 1, 'non-macOS clear is a no-op');
});
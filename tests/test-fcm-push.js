'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFcmDevices } = require('../src/push/fcm-devices');
const { createFcmTransport } = require('../src/push/fcm-transport');
const { assertTestDir } = require('../src/paths');
const device = (extra = {}) => ({ id: 'device_1234567890123456', binding: 'binding_12345678901234', token: 'fcm-token-12345678901234567890', projectId: 'multicc-test', ...extra });
function fixture(t, options = {}) {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-fcm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'devices.json');
  const calls = [];
  const transport = { projectId: 'multicc-test', send: async (token, data) => { calls.push({ token, data }); return { ok: true }; } };
  return { root, file, calls, transport, devices: createFcmDevices({ file, transport, ...options }) };
}
test('missing Firebase credentials disables only FCM without fetching', async t => {
  const { file } = fixture(t);
  const transport = createFcmTransport({ credentialsFile: `${file}.absent`, fetchImpl: () => { throw new Error('unexpected network'); } });
  const devices = createFcmDevices({ file, transport });
  assert.equal(devices.hasEnabled(), false);
  assert.equal(devices.register(device()).status, 503);
  assert.equal((await devices.send({ title: 'test' })).accepted, 0);
  assert.deepEqual(await transport.send('token', {}), { ok: false, code: 'not_configured' });
});
test('registration is durable, private, idempotent and rotates tokens', async t => {
  const { devices, file, calls, transport } = fixture(t);
  assert.equal(devices.register(device()).status, 200);
  devices.register(device({ token: 'replacement-token-1234567890' }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(devices.status().devices, 1);
  assert.ok(!JSON.stringify(devices.status()).includes('token'));
  const restored = createFcmDevices({ file, transport });
  assert.equal((await restored.send({ title: '完成', sessionId: 's1' })).accepted, 1);
  assert.equal(calls[0].token, 'replacement-token-1234567890');
  assert.equal(calls[0].data.binding, device().binding);
  assert.equal(calls[0].data.sessionId, 's1');
  assert.equal(typeof calls[0].data.eventId, 'string');
});
test('rejects invalid registrations and cross-project tokens; old binding cannot unregister new one', t => {
  const { devices } = fixture(t);
  for (const extra of [{ id: '' }, { token: '' }, { binding: '../bad' }]) assert.equal(devices.register(device(extra)).status, 400);
  assert.equal(devices.register(device({ projectId: 'other-project' })).status, 409);
  devices.register(device({ binding: 'new_binding_1234567890' }));
  devices.remove(device());
  assert.equal(devices.status().devices, 1);
  devices.remove(device({ binding: 'new_binding_1234567890' }));
  assert.equal(devices.status().devices, 0);
});
test('failed persistence never publishes an uncommitted subscription', t => {
  const { devices } = fixture(t, { write: () => { throw new Error('write failed'); } });
  assert.throws(() => devices.register(device()));
  assert.equal(devices.status().devices, 0);
});
test('corrupt storage is not overwritten and cannot send', async t => {
  const { file, transport } = fixture(t);
  fs.writeFileSync(file, '{bad');
  const devices = createFcmDevices({ file, transport });
  assert.throws(() => devices.register(device()), /FCM_STORAGE_UNAVAILABLE/);
  assert.equal(devices.hasEnabled(), false);
  assert.equal((await devices.send({})).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});
test('fanout isolates failures, bounds payload and removes only unregistered devices', async t => {
  const { devices, transport, calls } = fixture(t);
  devices.register(device());
  devices.register(device({ id: 'device_2234567890123456', token: 'token-b-12345678901234567890' }));
  transport.send = async (token, data) => { calls.push(data); return token.startsWith('token-b') ? { ok: false, code: 'unregistered' } : { ok: true }; };
  assert.deepEqual(await devices.send({ title: '好'.repeat(1000), body: '好'.repeat(4000) }), { ok: false, accepted: 1, failed: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(calls[0])) < 4096);
  assert.equal(devices.status().devices, 1);
  assert.equal((await devices.send({}, 'unknown')).ok, false);
});
test('stale in-flight response cannot delete refreshed token and expired devices are excluded', async t => {
  let now = 1000;
  const { devices, transport } = fixture(t, { now: () => now });
  devices.register(device());
  transport.send = async () => {
    devices.register(device({ token: 'new-token-12345678901234567890' }));
    return { ok: false, code: 'unregistered' };
  };
  await devices.send({});
  assert.equal(devices.status().devices, 1);
  now += 46 * 86400000;
  assert.equal(devices.hasEnabled(), false);
});
function credentials(root) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = path.join(root, 'service-account.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'service_account', project_id: 'multicc-test', client_email: 'test@multicc-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { file, publicKey };
}
test('HTTP v1 uses scoped signed OAuth, caches credentials and sends data-only high priority', async t => {
  const { root } = fixture(t);
  const { file, publicKey } = credentials(root);
  const requests = [];
  const transport = createFcmTransport({ credentialsFile: file, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.includes('oauth2')) {
      const jwt = new URLSearchParams(options.body).get('assertion');
      const [header, payload, signature] = jwt.split('.');
      assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return { ok: true, json: async () => ({ access_token: 'fake-access', expires_in: 3600 }) };
    }
    const message = JSON.parse(options.body).message;
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.android.ttl, '3600s');
    assert.equal(message.notification, undefined);
    assert.equal(options.headers.Authorization, 'Bearer fake-access');
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ name: 'projects/multicc-test/messages/fake' }) };
  } });
  assert.equal((await transport.send('fake-token', { binding: 'b' })).ok, true);
  assert.equal((await transport.send('fake-token', {})).ok, true);
  assert.equal(requests.filter(r => r.url.includes('oauth2')).length, 1);
});
test('network failures and Google errors return safe codes, no exception or secret text', async t => {
  const { root } = fixture(t);
  const { file } = credentials(root);
  const transport = createFcmTransport({ credentialsFile: file, fetchImpl: async () => { throw new Error('secret-token private-key'); } });
  assert.deepEqual(await transport.send('x', {}), { ok: false, code: 'unavailable' });
});
test('only explicit FCM UNREGISTERED expires a token, not generic 404 or permission errors', async t => {
  const { root } = fixture(t);
  const { file } = credentials(root);
  for (const stale of [false, true]) {
    const transport = createFcmTransport({ credentialsFile: file, fetchImpl: async url => url.includes('oauth2')
      ? { ok: true, json: async () => ({ access_token: 'fake' }) }
      : { status: 404, ok: false, json: async () => ({ error: { details: stale ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] : [] } }) } });
    assert.equal((await transport.send('x', {})).code, stale ? 'unregistered' : 'rejected');
  }
});

test('device routes expose no tokens and targeted tests report acceptance or failure truthfully', async t => {
  const { devices, transport } = fixture(t);
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, handler) => routes.set(`${method} ${url}`, handler)]));
  devices.mountRoutes(app, handler => handler);
  const invoke = async (method, path, body) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method} ${path}`)({ body }, res);
    return res;
  };
  assert.equal((await invoke('post', '/api/push/fcm', device())).statusCode, 200);
  const result = await invoke('get', '/api/push/fcm');
  assert.equal(result.body.devices, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /fcm-token|binding_123/);
  assert.equal((await invoke('post', '/api/push/fcm/test', { id: device().id })).body.accepted, 1);
  transport.send = async () => ({ ok: false, code: 'unavailable' });
  assert.equal((await invoke('post', '/api/push/fcm/test', { id: device().id })).statusCode, 502);
  await invoke('delete', '/api/push/fcm', device());
  assert.equal(devices.status().devices, 0);
});

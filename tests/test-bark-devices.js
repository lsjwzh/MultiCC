'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { assertTestDir } = require('../src/paths');
const { createBarkDevices, normalizeBarkUrl, deliverBark, mountBarkDeviceRoutes } = require('../src/push/bark-devices');

function setup(t, options = {}) {
  const dir = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-bark-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'devices.json');
  return { file, devices: createBarkDevices({ file, ...options }) };
}

test('legacy settings remain readable and removable across restarts without rewriting the env', t => {
  const legacy = 'https://api.day.app/legacy-secret';
  const { file, devices } = setup(t, { getLegacyUrl: () => legacy });
  assert.equal(devices.list()[0].id, 'legacy');
  assert.ok(!JSON.stringify(devices.list()).includes('legacy-secret'));
  const id = devices.add({ name: '工作手机', url: 'https://api.day.app/work-secret' });
  assert.equal(devices.list().length, 2);
  devices.update('legacy', { enabled: false, name: '旧 iPhone' });
  assert.equal(devices.list()[0].enabled, false);
  devices.remove('legacy');
  const reloaded = createBarkDevices({ file, getLegacyUrl: () => legacy });
  assert.deepEqual(reloaded.list().map(d => d.id), [id]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('adding devices never replaces another and duplicate official example URLs are rejected', t => {
  const { devices } = setup(t);
  const a = devices.add({ name: 'A', url: 'https://api.day.app/phone-one/示例文字?group=test' });
  const b = devices.add({ name: 'B', url: 'https://api.day.app/phone-two' });
  assert.throws(() => devices.add({ name: 'again', url: 'https://api.day.app/phone-one' }), /device_already_added/);
  devices.update(a, { enabled: false });
  devices.update(b, { name: 'renamed' });
  assert.deepEqual(devices.list().map(d => [d.id, d.name, d.enabled]), [[a, 'A', false], [b, 'renamed', true]]);
  assert.ok(!JSON.stringify(devices.list()).includes('phone-one'));
});

test('fanout skips paused phones, targeted tests send only to the selected phone, and errors stay isolated', async t => {
  const calls = [];
  const { devices } = setup(t, { deliver: async url => { calls.push(url); return { ok: !url.endsWith('bad') }; } });
  const a = devices.add({ name: 'A', url: 'https://api.day.app/good' });
  const b = devices.add({ name: 'B', url: 'https://api.day.app/bad' });
  devices.update(a, { enabled: false });
  assert.equal((await devices.send('t', 'b', '')).ok, false);
  assert.deepEqual(calls, ['https://api.day.app/bad']);
  calls.length = 0;
  assert.equal((await devices.send('t', 'b', '', a)).ok, true);
  assert.deepEqual(calls, ['https://api.day.app/good']);
  calls.length = 0;
  devices.update(a, { enabled: true });
  const result = await devices.send('t', 'b', '');
  assert.equal(result.accepted, 1);
  assert.equal(result.results.length, 2);
  assert.equal(devices.list().find(d => d.id === b).lastSuccess, false);
  await assert.rejects(devices.send('t', 'b', '', 'missing'), /device_not_found/);
});

test('storage errors cannot erase saved state or leak raw data', t => {
  let fail = false;
  const { devices, file } = setup(t, { write: (file, state) => {
    if (fail) throw new Error('secret private path');
    fs.writeFileSync(file, JSON.stringify(state));
  } });
  const id = devices.add({ name: 'A', url: 'https://api.day.app/phone-one' });
  fail = true;
  assert.throws(() => devices.remove(id), /^Error: bark_storage_unavailable$/);
  assert.equal(devices.list().length, 1);
  fs.writeFileSync(file, '{bad');
  const corrupt = createBarkDevices({ file });
  assert.throws(() => corrupt.add({ name: 'B', url: 'https://api.day.app/phone-two' }), /bark_storage_unavailable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('address validation rejects missing keys, credentials, masks and unsupported protocols', () => {
  for (const value of ['', 'https://api.day.app/', 'file:///key', 'https://user:pass@api.day.app/key', 'https://api.day.app/••••', 'https://api.day.app/YOUR_KEY']) {
    assert.throws(() => normalizeBarkUrl(value), /invalid_bark_address/);
  }
  assert.equal(normalizeBarkUrl(' http://localhost:9999/prefix/key/?x=1 '), 'http://localhost:9999/prefix/key');
});

test('Bark sender awaits response and rejects HTTP or application-level failures', async t => {
  let response = { status: 200, code: 200 };
  let requested;
  const server = http.createServer((req, res) => {
    requested = new URL(req.url, 'http://test');
    setTimeout(() => { res.writeHead(response.status); res.end(JSON.stringify({ code: response.code })); }, 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/test-key`;
  assert.equal((await deliverBark(url, '完成 / done', 'a?b', 'https://multicc.test')).ok, true);
  assert.equal(decodeURIComponent(requested.pathname), '/test-key/完成 / done/a?b');
  assert.equal(requested.searchParams.get('group'), 'multicc');
  response.code = 400;
  assert.equal((await deliverBark(url, 't', 'b', '')).ok, false);
  response = { status: 503, code: 200 };
  assert.equal((await deliverBark(url, 't', 'b', '')).ok, false);
});

test('device API uses opaque IDs, reports failed tests and does not return secrets', async t => {
  const { devices } = setup(t, { deliver: async () => ({ ok: false, error: 'network_error' }) });
  const handlers = {};
  mountBarkDeviceRoutes({ get: (p, h) => handlers['GET ' + p] = h, post: (p, h) => handlers['POST ' + p] = h }, devices, fn => fn);
  async function call(method, body) {
    let status = 200, result;
    await handlers[method + ' /api/push/bark-devices']({ body }, { status: n => { status = n; return { json: x => result = x }; }, json: x => result = x });
    return { status, result };
  }
  const added = await call('POST', { action: 'add', name: 'Phone', url: 'https://api.day.app/my-secret' });
  assert.equal(added.status, 200);
  assert.ok(!JSON.stringify(added).includes('my-secret'));
  assert.equal((await call('POST', { action: 'test', id: added.result.id })).status, 502);
  assert.equal((await call('POST', { action: 'test' })).status, 404);
  assert.equal((await call('POST', { action: 'update', id: added.result.id, enabled: 'false' })).status, 400);
});

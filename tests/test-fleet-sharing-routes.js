'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const gatewayFixture = require('./helpers/external-workspace-gateway');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const sourceContext = { directories: [{ id: 'source', name: 'Shared workspace' }], sessions: [] };
const recordToken = `fleet_share_${'q'.repeat(32)}`;
function sourceSeed(count = 1) {
  return { schemaVersion: 1, instanceId: 'source-test', shares: Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const token = i ? `fleet_share_${String(i).padStart(32, '0')}` : recordToken;
    return [token, { token, fleetId: 'source', createdAt: 1000 + i, expiresAt: 9000000000000,
      maxAccesses: 9, accessCount: i % 3, description: `中文😀\ud800 ${'x'.repeat(200)}`,
      accessGrant: 'not-for-public-list', salt: 'not-for-public-list', passwordHash: 'not-for-public-list' }];
  })) };
}
function comparable(reply) {
  const headers = { ...reply.headers };
  for (const key of ['date', 'connection', 'keep-alive']) delete headers[key];
  let body = reply.body;
  if (headers['content-encoding'] === 'gzip') {
    body = zlib.gunzipSync(reply.bytes).toString();
    delete headers['content-length']; // compressed bytes may differ
  }
  return { status: reply.status, headers, body };
}

test('source list/revoke HTTP matches the frozen Node contract and never enters Express', async t => {
  const native = await gatewayFixture.start(t, true, { source: sourceContext, shares: sourceSeed() });
  const legacy = await gatewayFixture.start(t, false, { source: sourceContext, shares: sourceSeed() });
  const request = (port, method, url, headers, body) => gatewayFixture.request(port, method, url, { 'x-access-token': 'fixture-token', ...headers }, body);
  const cases = [
    ['GET', '/api/fleets/source/shares'], ['HEAD', '/api/fleets/source/shares'],
    ['OPTIONS', '/api/fleets/source/shares'], ['OPTIONS', `/api/fleets/source/share/${recordToken}`],
    ['GET', '/API/FLEETS/source/SHARES/'], ['GET', '/api/fleets/sour%63e/shares'],
    ['GET', '/api/fleets/missing/shares'], ['GET', '/api/fleets/%2F/shares'],
    ['DELETE', `/api/fleets/wrong/share/${recordToken}`], ['DELETE', '/api/fleets/source/share/missing'],
    ['GET', '/api/fleets/%FF/shares'], ['OPTIONS', '/api/fleets/%FF/shares'],
    ['DELETE', '/api/fleets/source/share/%FF'], ['OPTIONS', '/api/fleets/source/share/%FF'],
    ['GET', '/api/fleets/source/shares', { 'content-type': 'application/json' }, '{'],
    ['GET', '/api/fleets/%FF/shares', { 'content-type': 'application/json' }, '{'],
    ['GET', '/api/fleets/source/shares', { 'accept-encoding': 'gzip' }],
  ];
  for (const forwarded of ['https', 'HTTPS , http', 'ftp, https', '', 'http, https']) {
    cases.push(['GET', '/api/fleets/source/shares', { 'x-forwarded-proto': forwarded }]);
  }
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    const url = method === 'GET' ? '/api/fleets/source/shares' : '/api/fleets/source/share/missing';
    for (const credential of ['', 'wrong', 'fixture-token']) {
      cases.push([method, url, { 'x-forwarded-for': '203.0.113.8', 'x-access-token': credential }]);
    }
  }
  const initial = await request(legacy.port, 'GET', '/api/fleets/source/shares');
  assert.equal(initial.status, 200);
  assert.equal(JSON.parse(initial.body).shares.length, 1);
  const tag = initial.headers.etag;
  cases.push(['GET', '/api/fleets/source/shares', { 'if-none-match': tag }]);
  cases.push(['HEAD', '/api/fleets/source/shares', { 'if-none-match': tag }]);
  cases.push(['DELETE', `/api/fleets/source/share/${recordToken}`]);
  cases.push(['GET', '/api/fleets/source/shares']);
  cases.push(['DELETE', `/api/fleets/source/share/${recordToken}`]);
  for (const [method, url, headers, body] of cases) {
    const expected = await request(legacy.port, method, url, headers, body);
    const actual = await request(native.port, method, url, headers, body);
    assert.deepEqual(comparable(actual), comparable(expected), `${method} ${url} ${JSON.stringify(headers)}`);
  }
  assert.deepEqual(JSON.parse((await request(native.port, 'GET', '/api/fleets/source/shares')).body).shares, []);
  await request(native.port, 'POST', '/fixture/shutdown');
  await request(legacy.port, 'POST', '/fixture/shutdown');
  for (const [method, url] of [['GET', '/api/fleets/source/shares'], ['DELETE', '/api/fleets/source/share/missing'],
    ['OPTIONS', '/api/fleets/source/shares'], ['GET', '/API/FLEETS/source/SHARES']]) {
    const actual = await request(native.port, method, url);
    assert.equal(actual.status, 503);
    assert.deepEqual(comparable(actual), comparable(await request(legacy.port, method, url)));
    cases.push([method, url]);
  }
  const state = JSON.parse((await request(native.port, 'GET', '/fixture/state')).body);
  assert.equal(state.hits.some(p => /\/api\/fleets\//i.test(p)), false);
  assert.equal(state.capabilityLeaked, false);
  console.log(`source administration HTTP differential: ${cases.length} cases`);
});

test('source bulk lists exceed a control frame; failed persistence never publishes revocation', async t => {
  const source = await gatewayFixture.start(t, true, { source: sourceContext, shares: sourceSeed(600) });
  const old = await gatewayFixture.start(t, false, { source: sourceContext, shares: sourceSeed(600) });
  const request = (port, method, url, headers, body) => gatewayFixture.request(port, method, url, { 'x-access-token': 'fixture-token', ...headers }, body);
  let response = await request(source.port, 'GET', '/api/fleets/source/shares');
  assert.equal(response.status, 200);
  assert.ok(response.bytes.length > 4 * 65536);
  assert.equal(JSON.parse(response.body).shares.length, 600);
  assert.equal(response.body.includes('not-for-public-list'), false);
  assert.equal(JSON.parse(response.body).shares[0].description.includes('\ud800'), true);
  assert.deepEqual(comparable(response), comparable(await request(old.port, 'GET', '/api/fleets/source/shares')));
  response = await request(source.port, 'GET', '/api/fleets/source/shares', { 'accept-encoding': 'gzip' });
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.deepEqual(comparable(response), comparable(await request(old.port, 'GET', '/api/fleets/source/shares', { 'accept-encoding': 'gzip' })));
  const file = path.join(source.dir, 'fleet-shares.json');
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  response = await request(source.port, 'DELETE', `/api/fleets/source/share/${recordToken}`);
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.body).code, 'INTERNAL_ERROR');
  assert.equal(JSON.parse((await request(source.port, 'GET', '/api/fleets/source/shares')).body).shares.length, 600);
  fs.rmdirSync(file);
  fs.renameSync(`${file}.saved`, file);
  assert.equal((await request(source.port, 'DELETE', `/api/fleets/source/share/${recordToken}`)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file)).shares[recordToken], undefined);
});

test('gateway revocation invalidates the same live source grant and survives child/gateway restart', async t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-source-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let source = await gatewayFixture.start(t, true, { dir, source: sourceContext });
  const request = (port, method, url, headers, body) => gatewayFixture.request(port, method, url, { 'x-access-token': 'fixture-token', ...headers }, body);
  const json = { 'content-type': 'application/json' };
  const share = JSON.parse((await request(source.port, 'POST', '/api/fleets/source/share', json,
    JSON.stringify({ password: 'test-password' }))).body);
  assert.equal(share.ok, true);
  const imported = JSON.parse((await request(source.port, 'POST', `/api/fleet-shares/${share.token}/import`, json,
    JSON.stringify({ password: 'test-password' }))).body);
  assert.ok(imported.capability.grant);
  const headers = { 'x-multicc-fleet-grant': imported.capability.grant };
  const url = `/api/fleet-shares/${share.token}/state`;
  assert.equal((await request(source.port, 'GET', url, headers)).status, 200);
  assert.equal(JSON.parse((await request(source.port, 'DELETE', `/api/fleets/source/share/${share.token}`)).body).ok, true);
  assert.equal((await request(source.port, 'GET', url, headers)).status, 404);
  const before = JSON.parse((await request(source.port, 'GET', '/fixture/state')).body).pid;
  await request(source.port, 'POST', '/fixture/crash');
  let changed = false;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 30));
    try {
      const state = JSON.parse((await request(source.port, 'GET', '/fixture/state')).body);
      if (state.pid !== before) { changed = true; break; }
    } catch {}
  }
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse((await request(source.port, 'GET', '/api/fleets/source/shares')).body).shares, []);
  assert.equal((await request(source.port, 'GET', url, headers)).status, 404);
  await source.close();
  source = await gatewayFixture.start(t, true, { dir, source: sourceContext });
  assert.deepEqual(JSON.parse((await request(source.port, 'GET', '/api/fleets/source/shares')).body).shares, []);
  assert.equal((await request(source.port, 'GET', url, headers)).status, 404);
});

test('source revocation rechecks authentication after a slow JSON body', async t => {
  const source = await gatewayFixture.start(t, true, { source: sourceContext, shares: sourceSeed() });
  const http = require('node:http');
  let upload;
  const answer = new Promise((resolve, reject) => {
    upload = http.request({ host: '127.0.0.1', port: source.port, method: 'DELETE',
      path: `/api/fleets/source/share/${recordToken}`,
      headers: { host: 'fixture.example', 'x-access-token': 'fixture-token', 'content-type': 'application/json', 'content-length': 2 },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    upload.on('error', reject); upload.write('{');
  });
  t.after(() => upload.destroy());
  await new Promise(r => setTimeout(r, 100));
  await gatewayFixture.request(source.port, 'POST', '/fixture/rotate', { 'content-type': 'text/plain' }, 'new-fixture-token');
  upload.end('}');
  assert.equal(await answer, 403);
  const remaining = await gatewayFixture.request(source.port, 'GET', '/api/fleets/source/shares', { 'x-access-token': 'new-fixture-token' });
  assert.equal(JSON.parse(remaining.body).shares.length, 1);
});

test('source creation HTTP matches legacy validation, headers and ordered DTOs', async t => {
  const next = await gatewayFixture.start(t, true, { source: sourceContext });
  const old = await gatewayFixture.start(t, false, { source: sourceContext });
  const headers = { 'x-access-token': 'fixture-token', 'content-type': 'application/json' };
  let compared = 0;
  const normalize = response => {
    const result = comparable(response);
    if (response.status === 200 && result.body.startsWith('{"ok":true')) {
      const value = JSON.parse(result.body);
      assert.match(value.token, /^fleet_share_[A-Za-z0-9_-]{32}$/);
      assert.equal(value.url.endsWith(`/fleet-share/${value.token}`), true);
      assert.ok(Math.abs(Date.now() - value.createdAt) < 30000);
      assert.ok(Number.isInteger((value.expiresAt - value.createdAt) / 86400000));
      // Random capabilities and the per-operation clock differ by design;
      // preserve all fields/order, the expiry interval and URL prefix.
      const token = value.token;
      value.token = 'TOKEN'; value.url = value.url.slice(0, -token.length) + 'TOKEN';
      value.expiresAt -= value.createdAt; value.createdAt = 0;
      assert.equal(response.headers.etag, `W/"${response.bytes.length.toString(16)}-${require('node:crypto').createHash('sha1').update(response.bytes).digest('base64').replace(/=+$/, '')}"`);
      result.body = JSON.stringify(value); delete result.headers.etag; delete result.headers['content-length'];
    }
    return result;
  };
  const cases = [
    ['POST', '/api/fleets/source/share', '{}'],
    ['POST', '/api/fleets/missing/share', '{}'],
    ['POST', '/api/fleets/%FF/share', '{'],
    ['POST', '/api/fleets/%FF/share', '{}'],
    ['OPTIONS', '/api/fleets/source/share', ''],
    ['OPTIONS', '/API/FLEETS/source/SHARE/', ''],
    ['OPTIONS', '/api/fleets/%FF/share', '{}'],
    ['POST', '/api/fleets/source/share', '[]'],
    ['POST', '/api/fleets/source/share', 'null'],
    ['POST', '/api/fleets/source/share', '{"password":"test-password","expiresInDays":1e400}'],
    ['POST', '/api/fleets/source/share', '{"password":"test-password","maxAccesses":1e400}'],
  ];
  for (const password of [null, 123456, {}, [], '', 'short', 'p'.repeat(1025), '中文中文', 'xx\ud800x']) {
    cases.push(['POST', '/api/fleets/source/share', JSON.stringify({ password })]);
  }
  for (const property of ['expiresInDays', 'maxAccesses']) {
    for (const value of [0, -1, 1.2, 'x', {}, [], '', null, '2', true, 1]) {
      cases.push(['POST', '/api/fleets/source/share', JSON.stringify({ password: 'test-password', [property]: value })]);
    }
  }
  for (const body of [
    { password: 'test-password', description: '  中文 \ud800\t😀  ', maxAccesses: '2', expiresInDays: '3' },
    { password: 'test-password', description: 'x'.repeat(2 * 1024 * 1024), ignored: { value: true } },
    { password: 'x'.repeat(100000) },
    { password: 'test-password', ignored: 'x'.repeat(200000) },
  ]) cases.push(['POST', '/API/FLEETS/sour%63e/SHARE/', JSON.stringify(body), { 'x-forwarded-proto': 'HTTPS, http' }]);
  for (const credential of ['', 'wrong']) {
    cases.push(['POST', '/api/fleets/source/share', '{', { 'x-access-token': credential }]);
  }
  for (const [method, url, body, extra] of cases) {
    const expected = await gatewayFixture.request(old.port, method, url, { ...headers, ...extra }, body);
    const actual = await gatewayFixture.request(next.port, method, url, { ...headers, ...extra }, body);
    assert.deepEqual(normalize(actual), normalize(expected), `${method} ${url} body=${body.slice(0, 100)}`);
    compared++;
  }
  const state = JSON.parse((await gatewayFixture.request(next.port, 'GET', '/fixture/state')).body);
  assert.equal(state.hits.some(p => /\/api\/fleets\//i.test(p)), false);
  assert.equal(state.capabilityLeaked, false);
  console.log(`source creation differential: ${compared} complete HTTP cases`);
});

test('source creation reads the live directory, fails closed on host errors and preserves durable state', async t => {
  const next = await gatewayFixture.start(t, true, { source: sourceContext });
  const json = { 'x-access-token': 'fixture-token', 'content-type': 'application/json' };
  const request = (method, url, body) => gatewayFixture.request(next.port, method, url, json, JSON.stringify(body || {}));
  await request('POST', '/fixture/directory', { id: 'source', remove: true });
  let result = await request('POST', '/api/fleets/source/share', { password: 'test-password' });
  assert.equal(result.status, 404);
  assert.equal(JSON.parse(result.body).code, 'FLEET_NOT_FOUND');
  await request('POST', '/fixture/directory', { id: 'source', name: 'Restored' });
  await request('POST', '/fixture/directory', { fail: true });
  result = await request('POST', '/api/fleets/source/share', { password: 'test-password' });
  assert.equal(result.status, 500);
  assert.equal(JSON.parse(result.body).code, 'INTERNAL_ERROR');
  assert.equal(result.body.includes('/private'), false);
  await request('POST', '/fixture/directory', { fail: false });
  const created = await Promise.all(Array.from({ length: 8 }, () => request('POST', '/api/fleets/source/share', { password: 'test-password' })));
  assert.ok(created.every(r => r.status === 200));
  const records = created.map(r => JSON.parse(r.body));
  assert.equal(new Set(records.map(r => r.token)).size, records.length);
  const removed = await Promise.all(records.slice(0, 4).map(r => request('DELETE', `/api/fleets/source/share/${r.token}`)));
  assert.ok(removed.every(r => JSON.parse(r.body).ok === true));
  let listed = JSON.parse((await request('GET', '/api/fleets/source/shares')).body).shares;
  assert.deepEqual(new Set(listed.map(r => r.token)), new Set(records.slice(4).map(r => r.token)));
  const file = path.join(next.dir, 'fleet-shares.json');
  fs.renameSync(file, `${file}.saved`); fs.mkdirSync(file);
  result = await request('POST', '/api/fleets/source/share', { password: 'test-password' });
  assert.equal(result.status, 500);
  listed = JSON.parse((await request('GET', '/api/fleets/source/shares')).body).shares;
  assert.equal(listed.length, 4);
  fs.rmdirSync(file); fs.renameSync(`${file}.saved`, file);
  assert.equal((await request('POST', '/api/fleets/source/share', { password: 'test-password' })).status, 200);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).shares).length, 5);
});

test('source control callback cycles are collectible and do not keep a child alive', () => {
  const result = require('node:child_process').spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-source-gc-'));
    const { createFleetSharing } = require('./src/fleet-sharing');
    (async () => {
      let weak;
      (() => {
        const holder = { auth: require('./src/auth-security').createAuthSecurity({ secret: 'gc-fixture' }) };
        holder.sharing = createFleetSharing({ sharesFile: path.join(root, 'shares.json'),
          getDirectory: () => holder.sharing ? { id: 'source' } : null, listSessions: () => [], authSecurity: holder.auth });
        weak = new WeakRef(holder);
      })();
      for (let i = 0; i < 40; i++) { await new Promise(r => setImmediate(r)); global.gc(); }
      assert.equal(weak.deref(), undefined);
    })().finally(() => fs.rmSync(root, { recursive: true, force: true }))
      .catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, MULTICC_GATEWAY_CHILD: '1', MULTICC_GATEWAY_PID: String(process.pid),
      MULTICC_GATEWAY_SOURCE_PORT: '1', MULTICC_GATEWAY_SOURCE_CAPABILITY: 'x'.repeat(43) } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

const stateGrant = 'g'.repeat(43);
function stateSeed() {
  const seed = sourceSeed();
  seed.shares[recordToken].accessGrant = stateGrant;
  for (const [suffix, fields] of [['expired', { expiresAt: 1 }], ['missing', { fleetId: 'deleted' }]]) {
    const token = `fleet_share_${suffix.padEnd(32, 'x')}`;
    seed.shares[token] = { ...seed.shares[recordToken], token, ...fields };
  }
  return seed;
}
function comparableState(response, method) {
  const result = comparable(response);
  if (result.headers['set-cookie']) {
    const security = require('../src/auth-security').createAuthSecurity({ secret: 'fixture-token' });
    result.headers['set-cookie'] = result.headers['set-cookie'].map(cookie => {
      assert.equal(security.verifyCookie(cookie.slice('multicc_auth='.length).split(';')[0]), true);
      return cookie.replace(/^multicc_auth=[^;]+/, 'multicc_auth=COOKIE');
    });
  }
  if (response.status === 200 && method !== 'OPTIONS') {
    assert.match(result.headers.etag, /^W\/"[a-f0-9]+-[A-Za-z0-9+/]+"$/);
    if (method === 'GET') {
      const value = JSON.parse(result.body);
      assert.ok(Math.abs(Date.now() - Date.parse(value.exportedAt)) < 30000);
      const bytes = Buffer.from(result.body);
      assert.equal(result.headers.etag, `W/"${bytes.length.toString(16)}-${require('node:crypto').createHash('sha1').update(bytes).digest('base64').replace(/=+$/, '')}"`);
      value.exportedAt = 'TIME'; result.body = JSON.stringify(value);
    }
    delete result.headers.etag;
  } else if (response.status === 304) {
    assert.match(result.headers.etag, /^W\//); delete result.headers.etag;
  }
  return result;
}

test('source state HTTP matches legacy auth, parsing and projection without entering Express', async t => {
  const source = { directories: [{ id: 'source', name: ' 中文\t工作区 ', createdAt: '2020-01-01', privateKey: 'hidden-directory' }],
    sessions: Array.from({ length: 505 }, (_, i) => ({ id: `session-${i}`, dirId: 'source', label: `中文😀\ud800 ${i}`, cli: i % 2 ? 'codex' : 'unsupported',
      kind: i % 2 ? 'terminal' : 'chat', type: i === 1 ? 'aux' : 'commander', createdAt: i === 2 ? 0 : '2020-01-01', active: i % 2 === 0,
      model: '  model  ', provider: '\tprovider', privateKey: 'hidden-session' })) };
  const next = await gatewayFixture.start(t, true, { source, shares: stateSeed() });
  const old = await gatewayFixture.start(t, false, { source, shares: stateSeed() });
  const url = `/api/fleet-shares/${recordToken}/state`;
  const headers = { 'x-access-token': 'fixture-token', 'x-multicc-fleet-grant': stateGrant };
  const cases = [];
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    cases.push([method, url], [method, `${url}/`], [method, url.replace('/api/fleet-shares/', '/API/FLEET-SHARES/')],
      [method, url.replace('fleet_share_', 'fleet%5Fshare_')], [method, '/api/fleet-shares/%FF/state']);
    for (const grant of ['', 'wrong']) cases.push([method, url, { 'x-multicc-fleet-grant': grant }]);
    cases.push([method, url, { 'if-none-match': '*' }]);
    cases.push([method, url, { 'content-type': 'application/json' }, '{']);
    cases.push([method, '/api/fleet-shares/%FF/state', { 'content-type': 'application/json' }, '{']);
  }
  for (const suffix of ['expired', 'missing', 'unknown']) cases.push(['GET', `/api/fleet-shares/fleet_share_${suffix.padEnd(32, 'x')}/state`]);
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    for (const grant of [stateGrant, 'wrong', '']) {
      cases.push([method, url, { 'x-access-token': '', 'x-multicc-fleet-token': recordToken, 'x-multicc-fleet-grant': grant }]);
    }
  }
  cases.push(['GET', url, { 'x-access-token': '', 'x-multicc-fleet-token': recordToken, 'x-multicc-machine-grant': 'bad-machine' }]);
  cases.push(['GET', url, { 'x-multicc-machine-grant': 'bad-machine' }]);
  cases.push(['GET', url, { 'x-access-token': '', 'x-multicc-fleet-token': 'different', accept: 'text/html' }]);
  cases.push(['GET', `${url}?x=1`, { 'x-access-token': '', 'x-multicc-fleet-token': recordToken }]);
  cases.push(['GET', `${url}/`, { 'x-access-token': '', 'x-multicc-fleet-token': recordToken }]);
  cases.push(['GET', url.replace('fleet_share_', 'fleet%5Fshare_'), { 'x-access-token': '', 'x-multicc-fleet-token': recordToken }]);
  cases.push(['GET', url, { 'accept-encoding': 'gzip' }]);
  for (const method of ['GET', 'HEAD']) {
    for (const prefix of ['/api/', '/API/']) cases.push([method,
      url.replace('/api/', prefix) + '?token=fixture-token', { 'x-access-token': '', 'x-multicc-machine-grant': 'bad-machine' }]);
  }
  cases.push(['GET', url.replace('/api/', '/API/') + '?token=fixture-token',
    { 'x-access-token': '', 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, '{']);
  cases.push(['GET', url.replace('/api/', '/API/') + '?token=fixture-token&token=fixture-token', { 'x-access-token': '' }]);
  for (const [method, target, extra, body] of cases) {
    const expected = await gatewayFixture.request(old.port, method, target, { ...headers, ...extra }, body);
    const actual = await gatewayFixture.request(next.port, method, target, { ...headers, ...extra }, body);
    assert.deepEqual(comparableState(actual, method), comparableState(expected, method), `${method} ${target} ${JSON.stringify(extra)}`);
  }
  const good = await gatewayFixture.request(next.port, 'GET', url, headers);
  const payload = JSON.parse(good.body);
  assert.equal(payload.fleet.sessionCount, 500);
  assert.equal(payload.fleet.sessions[0].label.includes('\ud800'), true);
  assert.equal(good.body.includes('hidden-directory'), false);
  assert.equal(good.body.includes('hidden-session'), false);
  const state = JSON.parse((await gatewayFixture.request(next.port, 'GET', '/fixture/state')).body);
  assert.equal(state.hits.some(p => /\/api\/fleet-shares\//i.test(p)), false);
  console.log(`source state HTTP differential: ${cases.length} cases`);
});

test('source state uses live directories and members, sanitizes host failure and observes revoke', async t => {
  const next = await gatewayFixture.start(t, true, { source: sourceContext, shares: stateSeed() });
  const old = await gatewayFixture.start(t, false, { source: sourceContext, shares: stateSeed() });
  const url = `/api/fleet-shares/${recordToken}/state`;
  const headers = { 'x-access-token': 'fixture-token', 'x-multicc-fleet-grant': stateGrant };
  const read = fixture => gatewayFixture.request(fixture.port, 'GET', url, headers);
  async function change(route, body) {
    for (const fixture of [old, next]) await gatewayFixture.request(fixture.port, 'POST', route,
      { ...headers, 'content-type': 'application/json' }, JSON.stringify(body));
    const actual = await read(next), expected = await read(old);
    assert.deepEqual(comparableState(actual, 'GET'), comparableState(expected, 'GET'));
    return actual;
  }
  let reply = await change('/fixture/session', { id: 'new-member', dirId: 'source', label: 'Current', cli: 'codex' });
  assert.equal(JSON.parse(reply.body).fleet.sessions[0].label, 'Current');
  reply = await change('/fixture/session', { id: 'new-member', dirId: 'other', label: 'Moved', cli: 'codex' });
  assert.equal(JSON.parse(reply.body).fleet.sessionCount, 0);
  reply = await change('/fixture/directory', { id: 'source', remove: true });
  assert.equal(reply.status, 404);
  reply = await change('/fixture/directory', { id: 'source', name: 'Restored\ud800' });
  assert.equal(JSON.parse(reply.body).fleet.name, 'Restored\ud800');
  reply = await change('/fixture/directory', { fail: true });
  assert.equal(reply.status, 500); assert.equal(reply.body.includes('/private'), false);
  reply = await change('/fixture/directory', { fail: false });
  assert.equal(reply.status, 200);
  for (const fixture of [old, next]) await gatewayFixture.request(fixture.port, 'DELETE', `/api/fleets/source/share/${recordToken}`, headers);
  assert.equal((await read(next)).status, 404);
  assert.deepEqual(comparableState(await read(next), 'GET'), comparableState(await read(old), 'GET'));
});

test('source state rechecks scoped credentials after slow body and rejects after shutdown', async t => {
  const source = await gatewayFixture.start(t, true, { source: sourceContext, shares: stateSeed() });
  const http = require('node:http');
  const url = `/api/fleet-shares/${recordToken}/state`;
  let upload;
  const answer = new Promise((resolve, reject) => {
    upload = http.request({ host: '127.0.0.1', port: source.port, method: 'GET', path: url,
      headers: { host: 'fixture.example', 'x-multicc-fleet-token': recordToken, 'x-multicc-fleet-grant': stateGrant,
        'content-type': 'application/json', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    upload.on('error', reject); upload.write('{');
  });
  t.after(() => upload.destroy());
  await new Promise(resolve => setTimeout(resolve, 100));
  await gatewayFixture.request(source.port, 'DELETE', `/api/fleets/source/share/${recordToken}`, { 'x-access-token': 'fixture-token' });
  upload.end('}');
  assert.equal(await answer, 403);
  await gatewayFixture.request(source.port, 'POST', '/fixture/shutdown');
  assert.equal((await gatewayFixture.request(source.port, 'GET', url, { 'x-access-token': 'fixture-token' })).status, 503);
});

const importPassword = 'native-import-password';
function importSeed(count = 1) {
  const seed = sourceSeed(count);
  const hash = require('node:crypto').scryptSync(importPassword, 'fixture-salt', 32).toString('hex');
  for (const row of Object.values(seed.shares)) {
    row.accessCount = 0; row.maxAccesses = 100;
    row.accessGrant = stateGrant; row.salt = 'fixture-salt';
    row.passwordHash = hash;
  }
  return seed;
}
function comparableImport(response) {
  const result = comparable(response);
  if (response.status === 200 && result.headers['content-type']?.includes('application/json')) {
    const value = JSON.parse(result.body);
    assert.ok(Math.abs(Date.now() - Date.parse(value.exportedAt)) < 30000);
    assert.equal(response.headers['cache-control'], 'no-store');
    const bytes = Buffer.from(result.body);
    assert.equal(response.headers.etag, `W/"${bytes.length.toString(16)}-${require('node:crypto').createHash('sha1').update(bytes).digest('base64').replace(/=+$/, '')}"`);
    value.exportedAt = 'TIME'; result.body = JSON.stringify(value); delete result.headers.etag;
  }
  return result;
}

test('source import HTTP runs natively with legacy password, admission and error contracts', async t => {
  const seed = importSeed(80);
  const source = { ...sourceContext, sessions: [{ id: 'member', dirId: 'source', label: '中文😀\ud800', cli: 'codex' }] };
  const next = await gatewayFixture.start(t, true, { source, shares: seed });
  const old = await gatewayFixture.start(t, false, { source, shares: seed });
  const tokens = Object.keys(seed.shares);
  const cases = [];
  const json = { 'content-type': 'application/json' };
  for (const password of [undefined,null,false,0,123456,{},[], '', 'short','wrong-password','x'.repeat(1025),importPassword]) {
    cases.push(['POST', '', json, JSON.stringify({password})]);
  }
  for (const body of ['{', 'null', '[]', '"password"', '{"password":1e400}', '{"password":"'+importPassword+'","ignored":"'+'x'.repeat(200000)+'"}']) cases.push(['POST','',json,body]);
  cases.push(['POST','',{},importPassword], ['POST','',json,''], ['POST','',json,JSON.stringify({password:importPassword}),{gzip:true}]);
  for (const method of ['POST','OPTIONS']) for (const credential of ['', 'wrong', 'fixture-token']) {
    for (const variant of ['normal','uppercase','slash','encoded','bad']) {
      cases.push([method,variant,{...json,'x-access-token':credential},JSON.stringify({password:importPassword})]);
    }
  }
  let comparisons = 0;
  for (const [method, variant, headers, body, options] of cases) {
    const token = tokens[comparisons];
    let url = `/api/fleet-shares/${token}/import`;
    if(variant==='uppercase')url=url.replace('/api/fleet-shares/','/API/FLEET-SHARES/');
    if(variant==='slash')url+='/';
    if(variant==='encoded')url=url.replace('fleet_share_','fleet%5Fshare_');
    if(variant==='bad')url='/api/fleet-shares/%FF/import';
    const extra=options?.gzip?{'accept-encoding':'gzip'}:{};
    const expected=await gatewayFixture.request(old.port,method,url,{...headers,...extra},body);
    const actual=await gatewayFixture.request(next.port,method,url,{...headers,...extra},body);
    assert.deepEqual(comparableImport(actual),comparableImport(expected), `${method} ${variant} case=${comparisons}`);
    comparisons++;
  }
  // A success clears earlier password failures. Non-password errors do not
  // count, and true peer identity ignores spoofed forwarding headers.
  const url=`/api/fleet-shares/${recordToken}/import`;
  async function compare(password, extra={}) {
    const body=JSON.stringify({password});
    const expected=await gatewayFixture.request(old.port,'POST',url,{...json,...extra},body);
    const actual=await gatewayFixture.request(next.port,'POST',url,{...json,...extra},body);
    assert.deepEqual(comparableImport(actual),comparableImport(expected));comparisons++;return actual;
  }
  // The first case already recorded one failure for this token.
  for(let i=0;i<8;i++)await compare('wrong');
  assert.equal((await compare(importPassword)).status,200);
  for(let i=0;i<10;i++)assert.equal((await compare('wrong',{'x-forwarded-for':`203.0.113.${i}`})).status,403);
  assert.equal((await compare(importPassword)).status,429);
  assert.equal(JSON.parse(fs.readFileSync(path.join(next.dir,'fleet-shares.json'))).shares[recordToken].accessCount,1);
  const state=JSON.parse((await gatewayFixture.request(next.port,'GET','/fixture/state')).body);
  assert.equal(state.hits.some(p=>/\/api\/fleet-shares\/.*\/import\/?$/i.test(p)),false);
  console.log(`source import HTTP differential: ${comparisons} cases`);
});

test('native source import serializes password failures and durable access budgets', async t => {
  const seed=importSeed(2);const tokens=Object.keys(seed.shares);seed.shares[tokens[1]].maxAccesses=2;
  const next=await gatewayFixture.start(t,true,{source:sourceContext,shares:seed});
  const post=(token,password)=>gatewayFixture.request(next.port,'POST',`/api/fleet-shares/${token}/import`,
    {'content-type':'application/json'},JSON.stringify({password}));
  const failed=await Promise.all(Array.from({length:14},()=>post(recordToken,'wrong')));
  assert.equal(failed.filter(r=>r.status===403).length,10);assert.equal(failed.filter(r=>r.status===429).length,4);
  const accepted=await Promise.all(Array.from({length:6},()=>post(tokens[1],importPassword)));
  assert.equal(accepted.filter(r=>r.status===200).length,2);assert.equal(accepted.filter(r=>r.status===410).length,4);
  const stored=JSON.parse(fs.readFileSync(path.join(next.dir,'fleet-shares.json')));
  assert.equal(stored.shares[recordToken].accessCount,0);assert.equal(stored.shares[tokens[1]].accessCount,2);
});

test('source import preserves context and persistence failure ordering and recovers', async t => {
  const next=await gatewayFixture.start(t,true,{source:sourceContext,shares:importSeed()});
  const old=await gatewayFixture.start(t,false,{source:sourceContext,shares:importSeed()});
  const json={'content-type':'application/json'};const url=`/api/fleet-shares/${recordToken}/import`;
  async function compare() {
    const actual=await gatewayFixture.request(next.port,'POST',url,json,JSON.stringify({password:importPassword}));
    const expected=await gatewayFixture.request(old.port,'POST',url,json,JSON.stringify({password:importPassword}));
    assert.deepEqual(comparableImport(actual),comparableImport(expected));return actual;
  }
  async function change(body){for(const s of [next,old])await gatewayFixture.request(s.port,'POST','/fixture/directory',json,JSON.stringify(body));}
  await change({id:'source',remove:true});assert.equal((await compare()).status,404);
  await change({id:'source',name:'Restored'});await change({fail:true});assert.equal((await compare()).status,500);
  await change({fail:false});
  for(const s of [next,old]) {const file=path.join(s.dir,'fleet-shares.json');fs.renameSync(file,`${file}.saved`);fs.mkdirSync(file);}
  assert.equal((await compare()).status,500);
  for(const s of [next,old]) {const file=path.join(s.dir,'fleet-shares.json');fs.rmdirSync(file);fs.renameSync(`${file}.saved`,file);}
  for(const s of [next,old])await gatewayFixture.request(s.port,'POST','/fixture/session',json,JSON.stringify({fail:true}));
  assert.equal((await compare()).status,500);
  for(const s of [next,old]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'fleet-shares.json'))).shares[recordToken].accessCount,1);
    await gatewayFixture.request(s.port,'POST','/fixture/session',json,JSON.stringify({fail:false}));
  }
  assert.equal((await compare()).status,200);
  for(const s of [next,old])assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir,'fleet-shares.json'))).shares[recordToken].accessCount,2);
});

test('source import rejects shutdown during a slow body without consuming access', async t => {
  const source = await gatewayFixture.start(t, true, { source: sourceContext, shares: importSeed() });
  const body = JSON.stringify({ password: importPassword });
  let upload;
  const answer = new Promise((resolve, reject) => {
    upload = require('node:http').request({ host: '127.0.0.1', port: source.port, method: 'POST',
      path: `/api/fleet-shares/${recordToken}/import`,
      headers: { host: 'fixture.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    upload.on('error', reject); upload.write(body.slice(0, -1));
  });
  t.after(() => upload.destroy());
  await new Promise(resolve => setTimeout(resolve, 100));
  await gatewayFixture.request(source.port, 'POST', '/fixture/shutdown');
  upload.end('}');
  assert.equal(await answer, 503);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source.dir, 'fleet-shares.json'))).shares[recordToken].accessCount, 0);
});

function comparableTicket(response) {
  const result = comparable(response);
  if (response.status === 200 && result.headers['content-type']?.includes('application/json')) {
    const value = JSON.parse(result.body);
    assert.match(value.ticket, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 30000);
    const bytes = Buffer.from(result.body);
    assert.equal(response.headers.etag, `W/"${bytes.length.toString(16)}-${require('node:crypto').createHash('sha1').update(bytes).digest('base64').replace(/=+$/, '')}"`);
    value.ticket = 'TICKET'; value.expiresAt = 0; result.body = JSON.stringify(value);
    delete result.headers.etag; delete result.headers['content-length'];
  }
  return result;
}

test('source WS ticket HTTP matches the frozen contract without entering Express', async t => {
  const source = { ...sourceContext, sessions: [
    { id: 'member', dirId: 'source' }, { id: '中文😀\ud800', dirId: 'source' },
    { id: 'auxiliary', dirId: 'source', type: 'aux' }, { id: 'foreign', dirId: 'other' },
  ] };
  const next = await gatewayFixture.start(t, true, { source, shares: stateSeed() });
  const old = await gatewayFixture.start(t, false, { source, shares: stateSeed() });
  const url = `/api/fleet-shares/${recordToken}/ws-ticket`;
  const json = { 'content-type': 'application/json', 'x-multicc-fleet-grant': stateGrant };
  const valid = JSON.stringify({ pathname: '/ws/chat', sessionId: 'member' });
  const cases = [];
  for (const pathname of ['/ws/chat', '/', '/ws/workspace', '/WS/CHAT', '/ws/test', '/ws/chat?x=1', '', null, [], {}, false]) {
    cases.push(['POST', url, json, JSON.stringify({ pathname, sessionId: 'member', directoryId: 'source' })]);
  }
  for (const sessionId of ['member', '中文😀\ud800', 'auxiliary', 'foreign', 'missing', '', null, 0, false, [], {}]) {
    cases.push(['POST', url, json, JSON.stringify({ pathname: '/ws/chat', sessionId })]);
  }
  for (const directoryId of ['source', 'other', null, [], {}]) {
    cases.push(['POST', url, json, JSON.stringify({ pathname: '/ws/workspace', directoryId })]);
  }
  for (const grant of ['', 'wrong', stateGrant]) cases.push(['POST', url, { ...json, 'x-multicc-fleet-grant': grant }, valid]);
  for (const body of ['', '{', 'null', '[]', '"x"', '{"pathname":"/ws/chat","sessionId":1e400}',
    '{"pathname":"/ws/chat","sessionId":"member","padding":"' + 'x'.repeat(100000) + '"}']) cases.push(['POST', url, json, body]);
  for (const method of ['POST', 'OPTIONS']) for (const credential of ['', 'wrong', 'fixture-token']) {
    for (const variant of [url, url.toUpperCase().replace(recordToken.toUpperCase(), recordToken), `${url}/`, url.replace('fleet_share_', 'fleet%5Fshare_'), '/api/fleet-shares/%FF/ws-ticket']) {
      cases.push([method, variant, { ...json, 'x-access-token': credential }, valid]);
    }
  }
  for (const proto of ['https', 'HTTPS , http', 'http', 'ftp,https']) cases.push(['POST', url, { ...json, 'x-forwarded-proto': proto }, valid]);
  cases.push(['POST', url, { ...json, 'content-encoding': 'gzip' }, zlib.gzipSync(valid)]);
  cases.push(['POST', url, { ...json, 'accept-encoding': 'gzip' }, valid]);
  for (const args of cases) {
    assert.deepEqual(comparableTicket(await gatewayFixture.request(next.port, ...args)), comparableTicket(await gatewayFixture.request(old.port, ...args)), `${args[0]} ${args[1]} ${JSON.stringify(args[2])}`);
  }
  const state = JSON.parse((await gatewayFixture.request(next.port, 'GET', '/fixture/state')).body);
  assert.equal(state.hits.some(p => /\/api\/fleet-shares\/.*\/ws-ticket\/?$/i.test(p)), false);
  assert.equal(state.capabilityLeaked, false);
  console.log(`source WS ticket HTTP differential: ${cases.length} cases`);
});

test('native source tickets share the live table, membership, scope and replay semantics', async t => {
  const source = { ...sourceContext, sessions: Array.from({ length: 502 }, (_, i) => ({ id: i === 501 ? '中文😀\ud800' : `member-${i}`, dirId: 'source' })) };
  const next = await gatewayFixture.start(t, true, { source, shares: stateSeed() });
  const old = await gatewayFixture.start(t, false, { source, shares: stateSeed() });
  const json = { 'content-type': 'application/json' };
  const url = `/api/fleet-shares/${recordToken}/ws-ticket`;
  const issue = (instance, body) => gatewayFixture.request(instance.port, 'POST', url, { ...json, 'x-multicc-fleet-grant': stateGrant }, JSON.stringify(body));
  const consume = async (instance, ticket, path) => JSON.parse((await gatewayFixture.request(instance.port, 'POST', '/fixture/consume', json, JSON.stringify({ ticket, path }))).body);
  const body = { pathname: '/ws/chat', sessionId: '中文😀\ud800' };
  let issued = JSON.parse((await issue(next, body)).body);
  let metadata = await consume(next, issued.ticket, '/ws/chat');
  assert.equal(metadata.fleetSessionId, body.sessionId);
  assert.deepEqual(Object.keys(metadata), ['fleetSessionId', 'path', 'expiresAt']);
  assert.equal(await consume(next, issued.ticket, '/ws/chat'), null);
  issued = JSON.parse((await issue(next, body)).body);
  assert.equal(await consume(next, issued.ticket, '/ws/workspace'), null);
  assert.equal(await consume(next, issued.ticket, '/ws/chat'), null);
  issued = JSON.parse((await issue(next, body)).body);
  assert.equal((await Promise.all(Array.from({ length: 12 }, () => consume(next, issued.ticket, '/ws/chat')))).filter(Boolean).length, 1);
  const { once } = require('node:events'), WebSocket = require('ws');
  issued = JSON.parse((await issue(next, body)).body);
  const ws = new WebSocket(`ws://127.0.0.1:${next.port}/ws/chat?ws_ticket=${issued.ticket}`);
  const closed = once(ws, 'close'), message = once(ws, 'message');
  assert.equal(JSON.parse((await message)[0]).fleetSessionId, body.sessionId); await closed;
  assert.equal(await consume(next, issued.ticket, '/ws/chat'), null);
  async function change(endpoint, body) {
    for (const instance of [next, old]) await gatewayFixture.request(instance.port, 'POST', endpoint, json, JSON.stringify(body));
  }
  async function compare(body, status) {
    const actual = await issue(next, body), expected = await issue(old, body);
    assert.equal(actual.status, status); assert.deepEqual(comparableTicket(actual), comparableTicket(expected));
  }
  await change('/fixture/session', { id: body.sessionId, dirId: 'other' }); await compare(body, 403);
  await change('/fixture/session', { id: body.sessionId, dirId: 'source' }); await compare(body, 200);
  await change('/fixture/session', { id: body.sessionId, dirId: 'source', opaqueCycle: true }); await compare(body, 200);
  await change('/fixture/session', { id: body.sessionId, dirId: 'source' });
  await change('/fixture/session', { fail: true }); await compare(body, 500);
  await compare({ pathname: '/ws/workspace', directoryId: 'source' }, 200);
  await change('/fixture/session', { fail: false });
  // Legacy membership authorization does not depend on directory existence.
  await change('/fixture/directory', { id: 'source', remove: true }); await compare(body, 200);
  await change('/fixture/directory', { fail: true }); await compare(body, 200);
  const outstanding = await Promise.all([next, old].map(async instance => JSON.parse((await issue(instance, body)).body)));
  for (const instance of [next, old]) await gatewayFixture.request(instance.port, 'DELETE', `/api/fleets/source/share/${recordToken}`, { 'x-access-token': 'fixture-token' });
  for (const [i, instance] of [next, old].entries()) assert.equal((await consume(instance, outstanding[i].ticket, '/ws/chat')).fleetSessionId, body.sessionId);
  await compare(body, 403); await compare({ pathname: '/ws/workspace', directoryId: 'source' }, 403);
});

test('source tickets reject revocation and shutdown during slow request bodies', async t => {
  for (const shutdown of [false, true]) {
    const source = await gatewayFixture.start(t, true, { source: sourceContext, shares: stateSeed() });
    const body = JSON.stringify({ pathname: '/ws/workspace', directoryId: 'source' });
    const http = require('node:http'); let upload;
    const answer = new Promise((resolve, reject) => {
      upload = http.request({ host: '127.0.0.1', port: source.port, method: 'POST', path: `/api/fleet-shares/${recordToken}/ws-ticket`,
        headers: { host: 'fixture.example', 'x-multicc-fleet-grant': stateGrant, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      upload.on('error', reject); upload.write(body.slice(0, 1));
    });
    t.after(() => upload.destroy());
    await new Promise(resolve => setTimeout(resolve, 100));
    if (shutdown) await gatewayFixture.request(source.port, 'POST', '/fixture/shutdown');
    else await gatewayFixture.request(source.port, 'DELETE', `/api/fleets/source/share/${recordToken}`, { 'x-access-token': 'fixture-token' });
    upload.end(body.slice(1)); assert.equal(await answer, shutdown ? 503 : 403);
    assert.equal(JSON.parse((await gatewayFixture.request(source.port, 'GET', '/fixture/state')).body).count, 0);
  }
});

function comparableLanding(reply) {
  const value = comparable(reply);
  if (value.headers['set-cookie']?.[0]?.startsWith('multicc_auth=')) {
    value.headers['set-cookie'] = value.headers['set-cookie'].map(c => c.replace(/^multicc_auth=[^;]+/, 'multicc_auth=<signed>'));
  }
  return value;
}

test('source landing HTTP matches file, authorization and conditional request contracts', async t => {
  const next = await gatewayFixture.start(t, true, { source: sourceContext });
  const old = await gatewayFixture.start(t, false, { source: sourceContext });
  const url = `/fleet-share/${recordToken}`;
  const initial = await gatewayFixture.request(old.port, 'GET', url);
  assert.equal(initial.status, 200);
  assert.equal(initial.body, fs.readFileSync(path.join(old.packageRoot, 'public/fleet-share.html'), 'utf8'));
  const { etag, 'last-modified': modified } = initial.headers;
  const cases = [];
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    for (const target of [url, `${url}/`, url.replace('fleet-share', 'FLEET-SHARE'), '/fleet-share/unknown', '/fleet-share/fleet_share_x',
      '/fleet-share/%FF', '/fleet-share/%00', '/fleet-share/a%2Fb', '/fleet-share/..%2Fsecret', '/fleet-share/x.json']) {
      for (const credential of ['', 'fixture-token']) cases.push([method, target, { 'x-access-token': credential }]);
    }
    cases.push([method, url, { 'x-access-token': 'wrong', 'x-multicc-machine-grant': 'invalid', 'x-forwarded-for': '203.0.113.99' }]);
    for (const body of ['{', 'null', '[]', '{}']) cases.push([method, url, { 'content-type': 'application/json' }, body]);
    for (const range of ['bytes=0-10', 'bytes=-10', 'bytes=10-', 'bytes=99999999-', 'bytes=1-0', 'bytes=0-1,5-6', 'bytes=0-4,3-8', 'units=1-2']) {
      if (method !== 'OPTIONS') cases.push([method, url, { range }]);
    }
    if (method !== 'OPTIONS') {
      for (const extra of [
        { 'if-none-match': etag }, { 'if-none-match': '*' }, { 'if-match': '"wrong"' }, { 'if-match': etag },
        { 'if-modified-since': modified }, { 'if-unmodified-since': 'Mon, 01 Jan 1990 00:00:00 GMT' },
        { 'if-none-match': etag, 'cache-control': 'no-cache' },
        { range: 'bytes=0-5', 'if-range': etag }, { range: 'bytes=0-5', 'if-range': '"wrong"' },
        { range: 'bytes=0-5', 'if-range': modified }, { 'accept-encoding': 'gzip' },
      ]) cases.push([method, url, extra]);
    }
  }
  cases.push(['GET', `${url}?token=fixture-token`, { 'x-forwarded-proto': 'https' }]);
  cases.push(['GET', '/FLEET-SHARE/unknown?token=fixture-token']);
  cases.push(['GET', '/fleet-share/%FF?token=fixture-token']);
  cases.push(['HEAD', `${url}?token=fixture-token`]);
  cases.push(['GET', url, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, zlib.gzipSync('{}')]);
  cases.push(['GET', url, { 'content-type': 'application/json; charset=latin1' }, '{}']);
  for (const args of cases) {
    const expected = await gatewayFixture.request(old.port, ...args);
    const actual = await gatewayFixture.request(next.port, ...args);
    assert.deepEqual(comparableLanding(actual), comparableLanding(expected), `${args[0]} ${args[1]} ${JSON.stringify(args[2])}`);
  }
  for (const instance of [next, old]) await gatewayFixture.request(instance.port, 'POST', '/fixture/shutdown');
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const actual = await gatewayFixture.request(next.port, method, url);
    assert.equal(actual.status, 200);
    assert.deepEqual(comparableLanding(actual), comparableLanding(await gatewayFixture.request(old.port, method, url)));
    cases.push([method, url]);
  }
  const state = JSON.parse((await gatewayFixture.request(next.port, 'GET', '/fixture/state')).body);
  assert.equal(state.hits.some(p => /^\/fleet-share\//i.test(p)), false);
  console.log(`source landing HTTP differential: ${cases.length} cases; none entered Express`);
});

test('landing file reads the package root and observes replacement, absence and directory errors', async t => {
  const next = await gatewayFixture.start(t, true, { source: sourceContext });
  const old = await gatewayFixture.start(t, false, { source: sourceContext });
  const url = `/fleet-share/${recordToken}`;
  // Neither cwd nor MULTICC_DATA_DIR may supply an alternate landing document.
  for (const instance of [next, old]) {
    fs.mkdirSync(path.join(instance.dir, 'public'));
    fs.writeFileSync(path.join(instance.dir, 'public/fleet-share.html'), 'WRONG DATA ROOT');
  }
  let comparisons = 0;
  async function compare(method = 'GET', extra = {}) {
    const actual = await gatewayFixture.request(next.port, method, url, extra);
    const expected = await gatewayFixture.request(old.port, method, url, extra);
    assert.deepEqual(comparableLanding(actual), comparableLanding(expected)); comparisons++;
    assert.equal(actual.body.includes('WRONG DATA ROOT'), false); return actual;
  }
  const first = await compare();
  for (const instance of [next, old]) {
    const page = path.join(instance.packageRoot, 'public/fleet-share.html');
    fs.renameSync(page, page + '.saved');
  }
  for (const method of ['GET', 'HEAD']) {
    const missing = await compare(method); assert.equal(missing.status, 404);
    if (method === 'GET') { assert.equal(JSON.parse(missing.body).code, 'ENOENT'); assert.equal(JSON.parse(missing.body).error, 'request_error'); assert.equal(missing.headers.vary, undefined); }
  }
  for (const instance of [next, old]) fs.mkdirSync(path.join(instance.packageRoot, 'public/fleet-share.html'));
  for (const method of ['GET', 'HEAD']) assert.equal((await compare(method)).status, 404);
  for (const instance of [next, old]) {
    const page = path.join(instance.packageRoot, 'public/fleet-share.html');
    fs.rmdirSync(page); fs.writeFileSync(page, '<!doctype html><title>replacement</title>中文😀'); fs.utimesSync(page, 1700000000, 1700000000);
  }
  const replacement = await compare('GET', { 'if-none-match': first.headers.etag });
  assert.equal(replacement.status, 200); assert.ok(replacement.body.includes('replacement'));
  assert.equal((await compare('HEAD', { 'if-none-match': replacement.headers.etag })).status, 304);
  for (const instance of [next, old]) {
    const page = path.join(instance.packageRoot, 'public/fleet-share.html');
    fs.writeFileSync(page, ''); fs.utimesSync(page, 1700000001, 1700000001);
  }
  const empty = await compare(); assert.equal(empty.status, 200); assert.equal(empty.body, '');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    for (const instance of [next, old]) {
      const page = path.join(instance.packageRoot, 'public/fleet-share.html');
      fs.writeFileSync(page, 'unreadable content'); fs.utimesSync(page, 1700000002, 1700000002); fs.chmodSync(page, 0);
    }
    try {
      for (const method of ['GET', 'HEAD']) assert.equal((await compare(method)).status, method === 'HEAD' ? 200 : 500, method);
    } finally {
      for (const instance of [next, old]) fs.chmodSync(path.join(instance.packageRoot, 'public/fleet-share.html'), 0o600);
    }
  }
  for (const instance of [next, old]) {
    const publicDir = path.join(instance.packageRoot, 'public');
    fs.renameSync(publicDir, publicDir + '.saved'); fs.writeFileSync(publicDir, 'not a directory');
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await compare(method)).status, 404);
  console.log(`source landing filesystem differential: ${comparisons} cases`);
});

test('landing streams exact large files and disconnects release the reader', async t => {
  const source = await gatewayFixture.start(t, true, { source: sourceContext });
  const page = path.join(source.packageRoot, 'public/fleet-share.html');
  const bytes = Buffer.alloc(12 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  fs.writeFileSync(page, bytes);
  const url = `/fleet-share/${recordToken}`;
  const response = await gatewayFixture.request(source.port, 'GET', url);
  assert.equal(response.status, 200);
  const hash = buffer => require('node:crypto').createHash('sha256').update(buffer).digest('hex');
  assert.equal(hash(response.bytes), hash(bytes));
  const partial = await gatewayFixture.request(source.port, 'GET', url, { range: 'bytes=65530-131080' });
  assert.equal(partial.status, 206); assert.equal(hash(partial.bytes), hash(bytes.subarray(65530, 131081)));
  const http = require('node:http');
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: source.port, path: url, headers: { host: 'fixture.example' } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.once('error', reject);
    });
    req.once('error', reject);
  });
  fs.renameSync(page, page + '.old'); fs.writeFileSync(page, 'after disconnect');
  assert.equal((await gatewayFixture.request(source.port, 'GET', url)).body, 'after disconnect');
  assert.equal((await gatewayFixture.request(source.port, 'GET', '/fixture/state')).status, 200);
});

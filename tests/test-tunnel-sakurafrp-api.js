'use strict';

// Hermetic tests for the SakuraFrp API client / token binding. No real network
// or filesystem: fetch and readFileSync are injected. The single most important
// invariant is TOKEN REDACTION — /user/info echoes the access token in plaintext
// and getUserInfo() must never let it escape. There is a dedicated assertion that
// the token substring appears nowhere in the returned object.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  API_BASE,
  readLauncherToken,
  sakuraRequest,
  getUserInfo,
  listTunnels,
  listNodes,
  describeTunnelAccess,
  discoverAccess,
} = require('../src/tunnel-sakurafrp-api');

const TOKEN = 'kbl' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4' + 'x3'; // 32 alnum chars

function fetchReturning(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => body, arrayBuffer: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function routedFetch(map) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const path = new URL(url).pathname;
    const hit = Object.prototype.hasOwnProperty.call(map, path);
    return { ok: hit, status: hit ? 200 : 404, json: async () => (hit ? map[path] : null) };
  };
  fn.calls = calls;
  return fn;
}

// ── readLauncherToken ────────────────────────────────────────────────────────

test('readLauncherToken reads a valid macOS launcher config', () => {
  const cfg = JSON.stringify({ version: '3.1.8', token: TOKEN, auto_start_tunnels: [28323244, null] });
  const r = readLauncherToken({ platform: 'darwin', home: '/Users/x', readFileSync: () => cfg });
  assert.equal(r.token, TOKEN);
  assert.deepEqual(r.autoStartTunnels, [28323244], 'null ids filtered out');
  assert.equal(r.launcherVersion, '3.1.8');
  assert.ok(r.source.includes('natfrp-service') && r.source.endsWith('config.json'));
});

test('readLauncherToken returns null (without reading) on non-darwin', () => {
  const boom = () => { throw new Error('must not be called'); };
  assert.equal(readLauncherToken({ platform: 'linux', home: '/home/x', readFileSync: boom }), null);
  assert.equal(readLauncherToken({ platform: 'win32', home: 'C:\\x', readFileSync: boom }), null);
});

test('readLauncherToken returns null on missing/malformed/invalid-token config', () => {
  const enoent = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.equal(readLauncherToken({ platform: 'darwin', home: '/x', readFileSync: enoent }), null);
  assert.equal(readLauncherToken({ platform: 'darwin', home: '/x', readFileSync: () => '{not json' }), null);
  assert.equal(readLauncherToken({ platform: 'darwin', home: '/x', readFileSync: () => JSON.stringify({ token: 'short' }) }), null);
  assert.equal(readLauncherToken({ platform: 'darwin', home: '/x', readFileSync: () => JSON.stringify({ token: 'has space and bang!!' }) }), null);
  assert.equal(readLauncherToken({ platform: 'darwin', home: '/x', readFileSync: () => JSON.stringify({}) }), null);
});

// ── sakuraRequest ────────────────────────────────────────────────────────────

test('sakuraRequest builds the v4 URL and sends Bearer auth', async () => {
  const fetch = fetchReturning({ ok: 1 });
  await sakuraRequest('/user/info', { token: TOKEN, fetch });
  assert.equal(fetch.calls[0].url, `${API_BASE}/user/info`);
  assert.equal(fetch.calls[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
});

test('sakuraRequest requires a token and surfaces non-2xx', async () => {
  await assert.rejects(sakuraRequest('/user/info', { fetch: fetchReturning({}) }), /需要访问密钥/);
  await assert.rejects(
    sakuraRequest('/user/info', { token: TOKEN, fetch: fetchReturning({}, { ok: false, status: 401 }) }),
    /响应 401/,
  );
});

// ── getUserInfo: TOKEN REDACTION ─────────────────────────────────────────────

test('getUserInfo strips the echoed plaintext token and normalizes fields', async () => {
  const apiBody = {
    id: 3925025, name: 'lsjwzh', avatar: 'https://x/a.png', token: TOKEN,
    speed: '10 Mbps', tunnels: 2, realname: 2, group: { name: '普通用户', level: 0 },
    traffic: [75546979, 3944613880], sign: { config: [1, 4], signed: false, last: '2026-09-16', days: 3, traffic: 9 },
    bandwidth: null,
  };
  const result = await getUserInfo({ token: TOKEN, fetch: fetchReturning(apiBody) });

  // The whole point: the token must not survive in any form.
  assert.equal(result.token, undefined);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false, 'full token must not appear');
  assert.equal(serialized.includes('kbl'), false, 'token prefix must not appear');
  assert.equal(serialized.includes(apiBody.avatar), false, 'non-allowlisted fields dropped');

  assert.equal(result.id, 3925025);
  assert.equal(result.name, 'lsjwzh');
  assert.equal(result.groupName, '普通用户');
  assert.equal(result.tunnelCount, 2);
  assert.equal(result.trafficUsed, 75546979);
  assert.equal(result.trafficTotal, 3944613880);
  assert.equal(result.signed, false);
  assert.equal(result.signDays, 3);
});

test('getUserInfo tolerates missing/odd fields', async () => {
  const result = await getUserInfo({ token: TOKEN, fetch: fetchReturning({ name: 'x' }) });
  assert.equal(result.id, null);
  assert.equal(result.trafficUsed, null);
  assert.equal(result.trafficTotal, null);
  assert.equal(result.signed, false);
  assert.equal(result.signDays, null);
});

// ── listTunnels / listNodes ──────────────────────────────────────────────────

test('listTunnels/listNodes normalize shape', async () => {
  assert.deepEqual(await listTunnels({ token: TOKEN, fetch: fetchReturning([{ id: 1 }]) }), [{ id: 1 }]);
  assert.deepEqual(await listTunnels({ token: TOKEN, fetch: fetchReturning({ nope: true }) }), []);
  assert.deepEqual(await listNodes({ token: TOKEN, fetch: fetchReturning({ '73': { host: 'h' } }) }), { '73': { host: 'h' } });
  assert.deepEqual(await listNodes({ token: TOKEN, fetch: fetchReturning([1, 2]) }), {});
});

// ── describeTunnelAccess: no fabricated HTTPS ────────────────────────────────

const NODES = { '73': { name: '新加坡1', host: 'frp-can.com', vip: 0 } };

test('auto_https tunnel: no public URL invented, needsBoundDomain flagged', () => {
  const d = describeTunnelAccess(
    { id: 28323244, name: 'multicc', node: 73, type: 'tcp', online: true, remote: '41080', local_port: 3000, extra: 'auto_https = auto' },
    NODES,
  );
  assert.equal(d.publicUrl, null, 'must NOT fabricate https://frp-can.com:41080 (cert mismatch)');
  assert.equal(d.needsBoundDomain, true);
  assert.equal(d.reason, 'auto_https_requires_bound_nyat_domain');
  assert.equal(d.authority, 'frp-can.com:41080');
  assert.equal(d.nodeHost, 'frp-can.com');
  assert.equal(d.nodeName, '新加坡1');
  assert.equal(d.autoHttps, true);
  assert.equal(d.online, true);
  assert.equal(d.tunnelId, 28323244);
});

test('non-auto_https tunnel derives a plain http URL', () => {
  const d = describeTunnelAccess({ id: 1, node: 73, type: 'tcp', online: true, remote: '41080', extra: '' }, NODES);
  assert.equal(d.publicUrl, 'http://frp-can.com:41080');
  assert.equal(d.needsBoundDomain, false);
  assert.equal(d.autoHttps, false);
  assert.equal(d.reason, null);
});

test('missing node host or remote yields no URL', () => {
  const noNode = describeTunnelAccess({ id: 1, node: 999, remote: '41080', extra: '' }, NODES);
  assert.equal(noNode.publicUrl, null);
  assert.equal(noNode.nodeHost, '');
  assert.equal(noNode.reason, 'missing_remote_or_node_host');

  const noRemote = describeTunnelAccess({ id: 1, node: 73, extra: 'auto_https = auto' }, NODES);
  assert.equal(noRemote.publicUrl, null);
  assert.equal(noRemote.authority, null);
  assert.equal(noRemote.reason, 'missing_remote_or_node_host');

  assert.equal(describeTunnelAccess(null, NODES), null);
});

// ── discoverAccess ───────────────────────────────────────────────────────────

test('discoverAccess picks the requested / online / first tunnel', async () => {
  const online = { id: 28323244, name: 'multicc', node: 73, type: 'tcp', online: true, remote: '41080', extra: 'auto_https = auto' };
  const offline = { id: 111, name: 'other', node: 73, type: 'tcp', online: false, remote: '40000', extra: '' };
  const routes = { '/v4/tunnels': [offline, online], '/v4/nodes': NODES };

  const byOnline = await discoverAccess({ token: TOKEN, fetch: routedFetch(routes) });
  assert.equal(byOnline.found, true);
  assert.equal(byOnline.tunnelCount, 2);
  assert.equal(byOnline.access.tunnelId, 28323244, 'prefers the online tunnel');

  const byId = await discoverAccess({ token: TOKEN, fetch: routedFetch(routes), tunnelId: 111 });
  assert.equal(byId.access.tunnelId, 111);

  const missing = await discoverAccess({ token: TOKEN, fetch: routedFetch(routes), tunnelId: 999 });
  assert.equal(missing.found, false);

  const empty = await discoverAccess({ token: TOKEN, fetch: routedFetch({ '/v4/tunnels': [], '/v4/nodes': {} }) });
  assert.equal(empty.found, false);
  assert.equal(empty.tunnelCount, 0);
});

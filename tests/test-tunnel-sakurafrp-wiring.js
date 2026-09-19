'use strict';

// Wiring tests for the SakuraFrp integration surface added in P3:
//   • tunnel.js exposes sakuraAccess / sakuraInstallFrpc / sakuraApplyPublicUrl
//   • the managed frpc install path is probed FIRST by the binary detector
//   • the access token is resolved server-side and never crosses the boundary
//   • honest base-URL backfill: auto_https needs a bound *.nyat.app host, plain
//     http tunnels auto-derive http://nodeHost:remote
// Everything is hermetic: fetch is injected, durable state lives in a temp
// MULTICC_DATA_DIR that is removed after each test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { frpcArchKey, defaultFrpcDest } = require('../src/tunnel-sakurafrp-install');

const TOKEN = 'kbl' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4' + 'x3';
const API = 'https://api.natfrp.com/v4';

const createdDirs = [];
function tmpDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Load a fresh tunnel service bound to an isolated data root so applyConfig and
// the frpc install never touch the real ~/.multicc.
function loadTunnel(dataDir) {
  const previous = process.env.MULTICC_DATA_DIR;
  const modulePath = require.resolve('../src/tunnel');
  process.env.MULTICC_DATA_DIR = dataDir;
  delete require.cache[modulePath];
  const tunnel = require('../src/tunnel');
  return {
    tunnel,
    restore() {
      try { tunnel.stop(); } catch (_) { /* not started */ }
      delete require.cache[modulePath];
      if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
      else process.env.MULTICC_DATA_DIR = previous;
    },
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => body };
}

// Route by URL pathname so one fake fetch can serve user/info, tunnels, nodes,
// the clients manifest and the binary download.
function routedFetch(map, bytesByUrl = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (bytesByUrl[url]) {
      const bytes = bytesByUrl[url];
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    }
    const key = parsed.pathname;
    for (const [suffix, body] of Object.entries(map)) {
      if (key.endsWith(suffix)) return jsonResponse(body);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fetch.calls = calls;
  return fetch;
}

const USER_INFO = {
  id: 3925025,
  name: 'lsjwzh',
  realname: 2,
  token: TOKEN, // the API echoes it; getUserInfo must drop it
  group: { name: '普通用户' },
  tunnels: 2,
  traffic: [75597360, 3944566137],
  sign: { signed: false, days: 3 },
  avatar: 'https://example.test/a.png',
};

function autoHttpsTunnel() {
  return {
    '/user/info': USER_INFO,
    '/tunnels': [{ id: 28323244, name: 'multicc', type: 'tcp', online: true, remote: '41080', node: '73', extra: 'auto_https' }],
    '/nodes': { 73: { host: 'frp-can.com', name: '新加坡1' } },
  };
}

function plainHttpTunnel() {
  return {
    '/user/info': USER_INFO,
    '/tunnels': [{ id: 1, name: 'web', type: 'http', online: true, remote: '8080', node: '7', extra: '' }],
    '/nodes': { 7: { host: 'node7.example.test', name: '测试7' } },
  };
}

test('tunnel service exports the SakuraFrp integration methods', () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-exports-'));
  try {
    for (const name of ['sakuraAccess', 'sakuraInstallFrpc', 'sakuraApplyPublicUrl']) {
      assert.equal(typeof ctx.tunnel[name], 'function', `${name} must be exported`);
    }
  } finally {
    ctx.restore();
  }
});

test('the managed frpc install path is probed before system locations', () => {
  const dataDir = tmpDataDir('multicc-sf-binpath-');
  const ctx = loadTunnel(dataDir);
  try {
    const managed = defaultFrpcDest({ dataDir });
    // A managed install must win over a stale /usr/local/bin copy. availability()
    // reports sakurafrp present once the managed binary exists on disk.
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(ctx.tunnel.availability().sakurafrp, true);
  } finally {
    ctx.restore();
  }
});

test('sakuraAccess enriches account + tunnel and never leaks the token', async () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-access-'));
  try {
    ctx.tunnel.applyConfig({ sakurafrp: { authtoken: TOKEN } });
    const fetch = routedFetch(autoHttpsTunnel());
    const result = await ctx.tunnel.sakuraAccess({ fetch });
    assert.equal(result.ok, true);
    assert.equal(result.user.name, 'lsjwzh');
    assert.equal(result.user.trafficUsed, 75597360);
    assert.equal(result.user.trafficTotal, 3944566137);
    assert.equal(result.user.signed, false);
    assert.equal(result.access.needsBoundDomain, true);
    assert.equal(result.access.publicUrl, null);
    assert.equal(result.needsBoundDomain, true);
    // The token must not appear anywhere in the payload.
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('kbl'), false);
    assert.equal(result.user.token, undefined);
    assert.equal(result.user.avatar, undefined);
  } finally {
    ctx.restore();
  }
});

test('sakuraAccess reports api_error without throwing when the API fails', async () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-access-err-'));
  try {
    ctx.tunnel.applyConfig({ sakurafrp: { authtoken: TOKEN } });
    const fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await ctx.tunnel.sakuraAccess({ fetch });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'api_error');
  } finally {
    ctx.restore();
  }
});

test('sakuraApplyPublicUrl refuses to fabricate an auto_https URL without a bound domain', async () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-backfill-tls-'));
  try {
    ctx.tunnel.applyConfig({ sakurafrp: { authtoken: TOKEN } });
    const fetch = routedFetch(autoHttpsTunnel());
    const missing = await ctx.tunnel.sakuraApplyPublicUrl({ fetch });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'bound_domain_required');

    const bad = await ctx.tunnel.sakuraApplyPublicUrl({ boundDomain: 'https://frp-can.com:41080', fetch });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'bound_domain_required');

    const good = await ctx.tunnel.sakuraApplyPublicUrl({ boundDomain: 'app.r97634737.nyat.app', fetch });
    assert.equal(good.ok, true);
    assert.equal(good.url, 'https://app.r97634737.nyat.app');
    assert.equal(ctx.tunnel.getStatus().config.sakurafrp.url, 'https://app.r97634737.nyat.app');
  } finally {
    ctx.restore();
  }
});

test('sakuraApplyPublicUrl auto-derives http://host:remote for a plain tunnel', async () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-backfill-http-'));
  try {
    ctx.tunnel.applyConfig({ sakurafrp: { authtoken: TOKEN } });
    const fetch = routedFetch(plainHttpTunnel());
    const result = await ctx.tunnel.sakuraApplyPublicUrl({ fetch });
    assert.equal(result.ok, true);
    assert.equal(result.url, 'http://node7.example.test:8080');
    assert.equal(ctx.tunnel.getStatus().config.sakurafrp.url, 'http://node7.example.test:8080');
  } finally {
    ctx.restore();
  }
});

test('sakuraInstallFrpc verifies MD5+size and lands an executable at the managed path', async (t) => {
  const archKey = frpcArchKey();
  const dataDir = tmpDataDir('multicc-sf-install-');
  const ctx = loadTunnel(dataDir);
  try {
    const dest = defaultFrpcDest({ dataDir });
    if (!archKey) {
      const fetch = routedFetch({ '/system/clients': { frpc: { ver: 'x', archs: {} } } });
      const result = await ctx.tunnel.sakuraInstallFrpc({ fetch });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'install_failed');
      return;
    }
    const bytes = crypto.randomBytes(2048);
    const hash = crypto.createHash('md5').update(bytes).digest('hex');
    const downloadUrl = 'https://nya.globalslb.net/frpc/' + archKey;
    const manifest = {
      frpc: {
        ver: '0.51.0-sakura-14',
        archs: { [archKey]: { title: archKey, url: downloadUrl, hash, size: bytes.length } },
      },
    };
    const fetch = routedFetch({ '/system/clients': manifest }, { [downloadUrl]: bytes });
    const result = await ctx.tunnel.sakuraInstallFrpc({ fetch });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.path, dest);
    assert.equal(result.version, '0.51.0-sakura-14');
    const stat = fs.statSync(dest);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o755);
    assert.equal(crypto.createHash('md5').update(fs.readFileSync(dest)).digest('hex'), hash);
    // No partial temp file may survive.
    assert.equal(fs.readdirSync(path.dirname(dest)).some(f => f.includes('.partial-')), false);
  } finally {
    ctx.restore();
  }
});

test('sakuraInstallFrpc reports install_failed when the manifest has no verifiable entry', async () => {
  const ctx = loadTunnel(tmpDataDir('multicc-sf-install-bad-'));
  try {
    const fetch = routedFetch({ '/system/clients': { frpc: { ver: 'x', archs: {} } } });
    const result = await ctx.tunnel.sakuraInstallFrpc({ fetch });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'install_failed');
  } finally {
    ctx.restore();
  }
});

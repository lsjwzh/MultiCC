'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-auth-locality-'));
const dataDir = assertTestDir(path.join(testRoot, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const sharedDirectory = path.join(testRoot, 'workspace');
fs.mkdirSync(sharedDirectory);
fs.writeFileSync(path.join(dataDir, 'directories.json'), JSON.stringify([
  { id: 'shared-workspace', name: 'Isolated workspace', path: sharedDirectory, createdAt: '2026-01-01T00:00:00.000Z' },
]));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitReady(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated locality server did not become ready');
}

function connectSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('WebSocket locality check timed out'));
    }, 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitDenied(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('external WebSocket was not denied'));
    }, 5000);
    ws.once('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 4003);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once('error', () => {});
  });
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(ROOT, 'native', 'prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
  const gateway = path.join(path.dirname(addon), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  const child = spawn(gateway, ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ACCESS_TOKEN: 'isolated-access-token',
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });

  try {
    await waitReady(base);

    const local = await connectSocket(`ws://127.0.0.1:${port}/ws/meta`);
    local.terminate();

    const notification = {
      title: '策略提醒测试',
      body: '鉴权边界验收，不含真实交易建议',
      type: 'strategy-test',
      tag: 'strategy-auth-test',
      url: '/manage',
      dedupeKey: 'auth:test:2026-08-08T00:00:00+08:00',
    };
    const localNotify = await fetch(`${base}/api/push/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
    });
    assert.equal(localNotify.status, 503, 'true loopback reaches the route without a token');
    assert.equal((await localNotify.json()).error, 'NO_PUSH_SUBSCRIBERS');

    const proxiedHttp = await fetch(`${base}/api/server-info`, {
      headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9' },
    });
    assert.equal(proxiedHttp.status, 403);

    const deniedNotify = await fetch(`${base}/api/push/notify`, {
      method: 'POST',
      headers: {
        Host: 'dashboard.example.test',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.9',
      },
      body: JSON.stringify(notification),
    });
    assert.equal(deniedNotify.status, 403, 'public-host request without credentials is denied');

    const authenticatedNotify = await fetch(`${base}/api/push/notify`, {
      method: 'POST',
      headers: {
        Host: 'dashboard.example.test',
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.9',
        'X-Access-Token': 'isolated-access-token',
      },
      body: JSON.stringify(notification),
    });
    assert.equal(authenticatedNotify.status, 503,
      'authenticated non-local request reaches the notification route');
    assert.equal((await authenticatedNotify.json()).error, 'NO_PUSH_SUBSCRIBERS');

    await waitDenied(`ws://127.0.0.1:${port}/ws/meta`, {
      headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9' },
    });
    await waitDenied(`ws://127.0.0.1:${port}/ws/meta`, {
      headers: { Host: 'dashboard.example.test' },
    });
    const issuedResponse = await fetch(`${base}/api/auth/ws-ticket`, {
      method: 'POST', headers: { Host: 'dashboard.example.test', 'X-Access-Token': 'isolated-access-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/ws/meta' }),
    });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/meta?ticket=${issued.ticket}`, { headers: { Host: 'dashboard.example.test' } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('ticket did not reach meta snapshot')); }, 5000);
      let accepted = false;
      socket.once('message', data => {
        clearTimeout(timer);
        try { assert.equal(JSON.parse(data).type, 'meta_snapshot'); accepted = true; socket.terminate(); resolve(); }
        catch (error) { socket.terminate(); reject(error); }
      });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); if (!accepted) reject(new Error('ticket rejected by WS host')); });
    });
    await waitDenied(`ws://127.0.0.1:${port}/ws/meta?ticket=${issued.ticket}`, { headers: { Host: 'dashboard.example.test' } });

    const shareResponse = await fetch(`${base}/api/fleets/shared-workspace/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'isolated-workspace-password', maxAccesses: 2 }),
    });
    assert.equal(shareResponse.status, 200);
    const share = await shareResponse.json();
    const externalHeaders = { Host: 'dashboard.example.test', 'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.9' };
    assert.equal((await fetch(`${base}/api/server-info`, { headers: externalHeaders })).status, 403,
      'sharing checks must exercise a genuinely external request, never loopback bypass');
    const landingUrl = `${base}/fleet-share/${share.token}`;
    const landing = await fetch(landingUrl, { headers: externalHeaders });
    assert.equal(landing.status, 200);
    assert.equal(await landing.text(), fs.readFileSync(path.join(ROOT, 'public/fleet-share.html'), 'utf8'));
    // Raw HTTP avoids Fetch adding Cache-Control: no-cache to a conditional request.
    const landingHead = await require('./helpers/external-workspace-gateway').request(port, 'HEAD', `/fleet-share/${share.token}`, { ...externalHeaders, 'if-none-match': landing.headers.get('etag') });
    assert.equal(landingHead.status, 304);
    assert.equal(landingHead.headers['content-length'], undefined);
    const accessResponse = await fetch(`${base}/api/fleet-shares/${share.token}/import`, {
      method: 'POST', headers: externalHeaders,
      body: JSON.stringify({ password: 'isolated-workspace-password' }),
    });
    assert.equal(accessResponse.status, 200);
    const shared = await accessResponse.json();
    assert.equal(shared.fleet.id, 'shared-workspace');
    const grantHeaders = { ...externalHeaders,
      'X-Multicc-Fleet-Token': share.token, 'X-Multicc-Fleet-Grant': shared.capability.grant };
    const stateResponse = await fetch(`${base}/api/fleet-shares/${share.token}/state`, { headers: grantHeaders });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
    const statePayload = await stateResponse.json();
    assert.equal(statePayload.fleet.id, 'shared-workspace');
    assert.deepEqual(statePayload.capability, shared.capability);
    assert.equal((await fetch(`${base}/api/directories/shared-workspace/sessions`, { headers: grantHeaders })).status, 200);
    assert.equal((await fetch(`${base}/api/directories/other-workspace/sessions`, { headers: grantHeaders })).status, 403);
    const scopedTicketResponse = await fetch(`${base}/api/fleet-shares/${share.token}/ws-ticket`, {
      method: 'POST', headers: grantHeaders,
      body: JSON.stringify({ pathname: '/ws/workspace', directoryId: 'shared-workspace' }),
    });
    assert.equal(scopedTicketResponse.status, 200);
    const scopedTicket = await scopedTicketResponse.json();
    const workspaceUrl = `ws://127.0.0.1:${port}/ws/workspace?dirId=shared-workspace&ticket=${scopedTicket.ticket}`;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(workspaceUrl, { headers: { Host: 'dashboard.example.test' } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('workspace ticket snapshot timed out')); }, 5000);
      let accepted = false;
      socket.once('message', data => {
        clearTimeout(timer);
        try {
          const snapshot = JSON.parse(data);
          assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.dirId, 'shared-workspace');
          accepted = true; socket.terminate(); resolve();
        } catch (error) { socket.terminate(); reject(error); }
      });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); if (!accepted) reject(new Error('workspace ticket rejected')); });
    });
    await waitDenied(workspaceUrl, { headers: { Host: 'dashboard.example.test' } });
    assert.equal((await fetch(`${base}/api/fleets/shared-workspace/share/${share.token}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/fleet-shares/${share.token}/state`, { headers: grantHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/directories/shared-workspace/sessions`, { headers: grantHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/fleet-shares/${share.token}/ws-ticket`, {
      method: 'POST', headers: grantHeaders,
      body: JSON.stringify({ pathname: '/ws/workspace', directoryId: 'shared-workspace' }),
    })).status, 403);

    const limitedShare = await (await fetch(`${base}/api/fleets/shared-workspace/share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'limited-workspace-password', maxAccesses: 2 }),
    })).json();
    const limitedUrl = `${base}/api/fleet-shares/${limitedShare.token}/import`;
    const burst = await Promise.all(Array.from({ length: 14 }, (_, i) => fetch(limitedUrl, {
      method: 'POST', headers: { ...externalHeaders, 'X-Forwarded-For': `203.0.113.${i + 1}` },
      body: JSON.stringify({ password: 'incorrect-password' }),
    })));
    assert.equal(burst.filter(r => r.status === 403).length, 10);
    assert.equal(burst.filter(r => r.status === 429).length, 4,
      'changing forwarded headers cannot split the real-peer password window');
    await Promise.all(burst.map(r => r.arrayBuffer()));
    const stillLimited = await fetch(limitedUrl, { method: 'POST', headers: externalHeaders,
      body: JSON.stringify({ password: 'limited-workspace-password' }) });
    assert.equal(stillLimited.status, 429);
    assert.equal((await stillLimited.json()).code, 'SHARE_RATE_LIMITED');
    const storedShare = JSON.parse(fs.readFileSync(path.join(dataDir, 'fleet-shares.json'))).shares[limitedShare.token];
    assert.equal(storedShare.accessCount, 0, 'failed or limited attempts never consume access');

    console.log('isolated gateway auth: locality, native auth/workspace tickets, real WS snapshots, scope denial, replay rejection durable sharing revocation and native password admission passed');
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    assertTestDir(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

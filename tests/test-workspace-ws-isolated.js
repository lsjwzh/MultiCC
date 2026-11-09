'use strict';

// Real gateway + real server, isolated data root: /ws/workspace and /ws/meta
// must terminate through the shared router into the native subscription owner,
// over loopback and over the LAN interface (token-bearing external clients).
// Never touches ~/.multicc or the main checkout's data directory.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const DATA_TOKEN = 'isolated-workspace-token';

function isPrivateLanIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function findLanIPv4() {
  const available = Object.values(os.networkInterfaces())
    .flatMap(entries => entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  const configured = String(process.env.MULTICC_TEST_LAN_IP || '').trim();
  if (configured) return isPrivateLanIPv4(configured) && available.includes(configured)
    ? configured : null;
  return available.find(isPrivateLanIPv4) || null;
}

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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated workspace server did not become ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = [];
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`WebSocket timed out: ${url}`));
    }, 8000);
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      for (const wake of waiters.splice(0)) wake();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({
        ws, frames,
        async until(predicate) {
          const started = Date.now();
          while (!predicate(frames)) {
            if (Date.now() - started > 8000) throw new Error(`frame timeout: ${url} ${JSON.stringify(frames)}`);
            await new Promise(resolve => {
              const fallback = setTimeout(resolve, 50);
              waiters.push(() => { clearTimeout(fallback); resolve(); });
            });
          }
        },
      });
    });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

function waitClose(ws) {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006 });
    ws.once('close', code => resolve({ code }));
  });
}

(async () => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ws-isolated-')));
  const dataDir = assertTestDir(path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(dataDir, 'directories.json'), JSON.stringify([{
    id: 'ws-dir',
    name: 'Isolated WS Directory',
    path: workspaceDir,
    createdAt: '2026-01-01T00:00:00.000Z',
  }]));

  const port = await freePort();
  const lanIp = findLanIPv4();
  const host = lanIp ? '0.0.0.0' : '127.0.0.1';
  const addon = process.env.MULTICC_RUST_ADDON
    || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(ROOT, 'native', 'prebuilt'),
      `${process.platform}-${process.arch}`, 'multicc_core.node');
  const gateway = path.join(path.dirname(addon),
    process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
  let output = '';
  const child = spawn(gateway, ['serve', '--cwd', ROOT, '--node', process.execPath, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: host,
      PORT: String(port),
      ACCESS_TOKEN: DATA_TOKEN,
      MULTICC_ALLOW_LEGACY_WS_TOKEN: '1',
      MULTICC_ALLOW_REMOTE: lanIp ? '1' : '0',
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
  const sockets = [];

  try {
    await waitReady(`http://127.0.0.1:${port}`);

    const first = await connect(`ws://127.0.0.1:${port}/ws/workspace?dirId=ws-dir`);
    sockets.push(first.ws);
    await first.until(frames => frames.length >= 1);
    const snapshot = first.frames[0];
    assert.deepEqual(Object.keys(snapshot),
      ['type', 'dirId', 'sessions', 'events', 'queues', 'apiVersion']);
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.dirId, 'ws-dir');
    assert.equal(Array.isArray(snapshot.sessions), true);
    assert.equal(Array.isArray(snapshot.events), true);
    assert.equal(Array.isArray(snapshot.queues), true);

    const reconnect = await connect(`ws://127.0.0.1:${port}/ws/workspace?dirId=ws-dir`);
    sockets.push(reconnect.ws);
    await reconnect.until(frames => frames.length >= 1);
    assert.deepEqual(reconnect.frames[0], snapshot, 'reconnect replays the same snapshot');

    const meta = await connect(`ws://127.0.0.1:${port}/ws/meta`);
    sockets.push(meta.ws);
    await meta.until(frames => frames.length >= 1);
    const metaSnapshot = meta.frames[0];
    assert.equal(metaSnapshot.type, 'meta_snapshot');
    assert.deepEqual(Object.keys(metaSnapshot), ['type', 'fleet', 'apiVersion']);
    const fleet = metaSnapshot.fleet.find(entry => entry.dirId === 'ws-dir');
    assert.ok(fleet, `meta fleet is missing ws-dir: ${JSON.stringify(metaSnapshot.fleet)}`);
    assert.deepEqual(Object.keys(fleet), ['dirId', 'dirLabel', 'sessions', 'events', 'queues']);
    // directories.json records carry `name`, while the frozen meta_snapshot
    // contract reads `directory.label`; the wire value is null on both sides.
    assert.equal(fleet.dirLabel, null);

    const missing = await connect(`ws://127.0.0.1:${port}/ws/workspace?dirId=not-a-directory`);
    sockets.push(missing.ws);
    await missing.until(frames => frames.length >= 1);
    assert.deepEqual(missing.frames[0], { type: 'error', error: 'unknown directory', apiVersion: 'v1' });
    const closed = await waitClose(missing.ws);
    assert.equal(closed.code, 1005);

    // Closing both live sockets must leave the registry empty without
    // disturbing the server; a fresh connection still works.
    for (const entry of [first, reconnect]) entry.ws.close();
    await Promise.all([waitClose(first.ws), waitClose(reconnect.ws)]);
    const third = await connect(`ws://127.0.0.1:${port}/ws/workspace?dirId=ws-dir`);
    sockets.push(third.ws);
    await third.until(frames => frames.length >= 1);
    assert.equal(third.frames[0].type, 'snapshot');

    if (lanIp) {
      const denied = new WebSocket(`ws://${lanIp}:${port}/ws/workspace?dirId=ws-dir`);
      const deniedFrames = [];
      denied.on('message', data => deniedFrames.push(String(data)));
      sockets.push(denied);
      const denial = await waitClose(denied);
      assert.equal(denial.code, 4003, 'external clients without a token stay denied');
      assert.deepEqual(deniedFrames, [], 'a denied client receives no snapshot');

      const lan = await connect(
        `ws://${lanIp}:${port}/ws/workspace?dirId=ws-dir&token=${DATA_TOKEN}`);
      sockets.push(lan.ws);
      await lan.until(frames => frames.length >= 1);
      assert.equal(lan.frames[0].type, 'snapshot');
      assert.equal(lan.frames[0].dirId, 'ws-dir');
      const lanMeta = await connect(`ws://${lanIp}:${port}/ws/meta?token=${DATA_TOKEN}`);
      sockets.push(lanMeta.ws);
      await lanMeta.until(frames => frames.length >= 1);
      assert.equal(lanMeta.frames[0].type, 'meta_snapshot');
      console.log(`LAN workspace/meta check used ${lanIp}`);
    } else {
      console.log('LAN workspace/meta check skipped: no RFC1918 address');
    }
    console.log('isolated gateway + server workspace WS check passed');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    for (const ws of sockets) {
      try { ws.terminate(); } catch (_) {}
    }
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGINT');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

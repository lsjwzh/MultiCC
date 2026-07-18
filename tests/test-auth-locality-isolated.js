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
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      ACCESS_TOKEN: '',
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

    const proxiedHttp = await fetch(`${base}/api/server-info`, {
      headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9' },
    });
    assert.equal(proxiedHttp.status, 403);

    await waitDenied(`ws://127.0.0.1:${port}/ws/meta`, {
      headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9' },
    });
    await waitDenied(`ws://127.0.0.1:${port}/ws/meta`, {
      headers: { Host: 'dashboard.example.test' },
    });

    console.log('isolated auth locality: local HTTP/WS allowed, forwarded/public-host requests denied');
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

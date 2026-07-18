'use strict';

// Isolated process-level proof that SIGTERM follows the real graceful shutdown
// path. The child owns a temporary MULTICC_DATA_DIR and never starts an AI turn.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { assertTestDir } = require('../src/paths');

const ROOT = path.join(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-shutdown-'));
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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('isolated shutdown server did not become ready');
}

function openMetaSocket(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/meta`);
    const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 5000);
    ws.once('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.once('error', reject);
  });
}

(async () => {
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      MULTICC_DATA_DIR: dataDir,
      MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  let ws = null;
  try {
    await waitReady(`http://127.0.0.1:${port}`);
    ws = await openMetaSocket(port);
    const wsClosed = new Promise(resolve => ws.once('close', (code) => resolve(code)));
    const startedAt = Date.now();
    child.kill('SIGTERM');
    const exit = await Promise.race([
      new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise(resolve => setTimeout(() => resolve(null), 10000)),
    ]);
    assert.ok(exit, `SIGTERM did not exit within 10s\n${output}`);
    assert.equal(exit.code, 0, `graceful child exit failed\n${output}`);
    assert.equal(exit.signal, null);
    assert.ok(Date.now() - startedAt < 10000);
    assert.match(output, /\[shutdown\] starting \(SIGTERM\)/);
    assert.match(output, /\[shutdown\] done \(SIGTERM\)/);
    const closeCode = await Promise.race([
      wsClosed,
      new Promise(resolve => setTimeout(() => resolve(null), 1000)),
    ]);
    assert.ok(closeCode === 1012 || closeCode === 1006 || closeCode === 1001,
      `unexpected WebSocket close code: ${closeCode}`);
    console.log('server graceful shutdown: SIGTERM + open WebSocket passed');
  } finally {
    try { ws?.terminate(); } catch (_) {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    assertTestDir(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});

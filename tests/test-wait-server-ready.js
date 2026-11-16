'use strict';

// 自测 tests/helpers/wait-server-ready.js：用 node:http 起一个假的宿主端口，
// 覆盖 ready / not-ready 后转 ready / 404 / 网络错 / 子进程提前退出 五种情形，
// 外加 token 头的发/不发。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { waitServerReady } = require('./helpers/wait-server-ready');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('resolves when the host port reports ok && ready', async () => {
  const seen = [];
  const { server, base } = await listen((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers['x-access-token'] || null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptimeSeconds: 3, ready: true, checks: null }));
  });
  try {
    await waitServerReady(base, { token: 'tok-1' });
    assert.equal(seen.length >= 1, true);
    assert.deepEqual(seen[0], { method: 'POST', url: '/api/__host/server-core', token: 'tok-1' });
  } finally {
    await close(server);
  }
});

test('retries while not ready and resolves once ready', async () => {
  let calls = 0;
  const { server, base } = await listen((req, res) => {
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: calls >= 3 }));
  });
  try {
    await waitServerReady(base, { attempts: 10, intervalMs: 10, token: '' });
    assert.equal(calls, 3);
  } finally {
    await close(server);
  }
});

test('omits the token header when no token is given', async () => {
  let tokenHeader = 'unset';
  const { server, base } = await listen((req, res) => {
    tokenHeader = req.headers['x-access-token'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: true }));
  });
  try {
    await waitServerReady(base, { token: '' });
    assert.equal(tokenHeader, undefined);
  } finally {
    await close(server);
  }
});

test('rejects after exhausting attempts when the route is 404', async () => {
  const { server, base } = await listen((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  try {
    await assert.rejects(
      waitServerReady(base, { attempts: 3, intervalMs: 5, token: '', message: 'custom timeout text' }),
      error => error instanceof Error && error.message === 'custom timeout text',
    );
  } finally {
    await close(server);
  }
});

test('rejects when nothing listens (network error)', async () => {
  const port = await freePort();
  await assert.rejects(
    waitServerReady(`http://127.0.0.1:${port}`, { attempts: 3, intervalMs: 5, token: '', message: 'nobody home' }),
    error => error instanceof Error && error.message === 'nobody home',
  );
});

test('rejects immediately when the child already exited', async () => {
  const port = await freePort();
  await assert.rejects(
    waitServerReady(`http://127.0.0.1:${port}`, {
      token: '', attempts: 50, intervalMs: 5, message: 'boot failed',
      child: { exitCode: 7 }, output: () => 'boom from child',
    }),
    error => error instanceof Error
      && error.message === 'boot failed: server.js exited early (7):\nboom from child',
  );
});

test('honours timeoutMs even with attempts left', async () => {
  const { server, base } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: false }));
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      waitServerReady(base, { attempts: 1000, intervalMs: 20, timeoutMs: 80, token: '', message: 'too slow' }),
      error => error instanceof Error && error.message === 'too slow',
    );
    assert.equal(Date.now() - startedAt < 2000, true);
  } finally {
    await close(server);
  }
});

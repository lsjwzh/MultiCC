'use strict';

// End-to-end test for the voice web reverse-proxy.
//
// A stub "Qwen child" (plain http.Server + ws) is stood up on a loopback port,
// and createVoiceGatewayWebProxy is mounted on a real express app in front of
// it. We assert the three things that matter for a phone opening the voice page
// through this server:
//   - the page and /api/* calls are forwarded (prefix stripped),
//   - the Origin/Referer headers are stripped so the child's enforceSameOrigin
//     sees a loopback caller with no Origin,
//   - the /api/realtime WebSocket upgrade is spliced end-to-end, and
//   - a stopped child yields 503 / a destroyed socket instead of a hang.

const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('node:http');
const test = require('node:test');

const express = require('express');
const WebSocket = require('ws');

const { createVoiceGatewayWebProxy, wireUpgrade } = require('../src/routes/voice-gateway-proxy');

function startStubChild() {
  const seenOrigins = [];
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/', (req, res) => {
    seenOrigins.push(req.headers.origin || null);
    res.type('html').send('<!doctype html><title>voice</title>');
  });
  app.get('/api/health', (req, res) => {
    seenOrigins.push(req.headers.origin || null);
    res.json({ ok: true, origin: req.headers.origin || null });
  });
  const server = createServer(app);
  const wss = new WebSocket.Server({ server, path: '/api/realtime' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        seenOrigins: () => seenOrigins.slice(),
      });
    });
  });
}

function startProxy(childUrl) {
  const app = express();
  const proxy = createVoiceGatewayWebProxy({
    runtime: { statusGlobal: () => ({ url: childUrl }) },
    log: { warn() {} },
  });
  proxy.mountRoutes(app);
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith(proxy.PREFIX)) proxy.handleUpgrade(req, socket, head);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server, prefix: proxy.PREFIX });
    });
  });
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

test('the proxy forwards the page and API calls and strips Origin', async () => {
  const child = await startStubChild();
  const proxy = await startProxy(child.url);
  try {
    const page = await fetchJson(`${proxy.url}${proxy.prefix}/`, { origin: 'https://funnel.example' });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>voice<\/title>/);

    const health = await fetchJson(`${proxy.url}${proxy.prefix}/api/health`, { origin: 'https://funnel.example' });
    assert.equal(health.status, 200);
    const parsed = JSON.parse(health.body);
    assert.equal(parsed.ok, true);
    // The child must see NO origin: enforceSameOrigin would otherwise 403 a
    // proxied request whose Origin is the public funnel host.
    assert.equal(parsed.origin, null);
    assert.deepEqual(child.seenOrigins(), [null, null], 'Origin and Referer are stripped before forwarding');
  } finally {
    proxy.server.close();
    child.server.close();
  }
});

test('the realtime WebSocket is spliced end-to-end through the prefix', async () => {
  const child = await startStubChild();
  const proxy = await startProxy(child.url);
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${proxy.url.replace('http', 'ws')}${proxy.prefix}/api/realtime`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('websocket echo timed out'));
      }, 3000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        try {
          assert.equal(data.toString(), 'echo:hello');
          clearTimeout(timeout);
          ws.close();
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  } finally {
    proxy.server.close();
    child.server.close();
  }
});

test('a stopped child yields 503 on HTTP and destroys the upgrade socket', async () => {
  const proxy = await startProxy(null); // statusGlobal().url === null
  try {
    const res = await fetchJson(`${proxy.url}${proxy.prefix}/api/health`);
    assert.equal(res.status, 503);

    await new Promise((resolve) => {
      const ws = new WebSocket(`${proxy.url.replace('http', 'ws')}${proxy.prefix}/api/realtime`);
      ws.on('error', () => resolve()); // destroyed socket surfaces as an error
      ws.on('open', () => { throw new Error('the upgrade must not succeed when the child is down'); });
      setTimeout(resolve, 1500);
    });
  } finally {
    proxy.server.close();
  }
});

test('wireUpgrade routes voice upgrades to the proxy and chat upgrades to the wss', async () => {
  const child = await startStubChild();
  // A noServer chat wss: its 'connection' event must fire only for non-voice
  // paths, proving the dispatcher does not let the chat wss race the proxy.
  const chatWss = new WebSocket.Server({ noServer: true });
  const chatConnections = [];
  chatWss.on('connection', (ws) => { chatConnections.push(ws); ws.close(); });

  const app = express();
  const webProxy = createVoiceGatewayWebProxy({
    runtime: { statusGlobal: () => ({ url: child.url }) },
    log: { warn() {} },
  });
  webProxy.mountRoutes(app);
  const server = createServer(app);
  wireUpgrade(server, chatWss, webProxy);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Voice path -> proxied to the stub child's realtime socket (echoes).
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}${webProxy.PREFIX}/api/realtime`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('voice upgrade timed out')); }, 3000);
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (data) => {
        assert.equal(data.toString(), 'echo:hi');
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    // Chat path -> the chat wss, NOT the proxy.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/chat`);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('chat upgrade timed out')); }, 3000);
      ws.on('open', () => { clearTimeout(timeout); ws.close(); resolve(); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
    assert.equal(chatConnections.length, 1, 'the chat wss received exactly the chat upgrade');
  } finally {
    server.close();
    chatWss.close();
    child.server.close();
  }
});

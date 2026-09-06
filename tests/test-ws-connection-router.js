'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { createLogger } = require('../src/observability');
const { mountWsConnectionRouter } = require('../src/ws/connection-router');

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  pings = 0;
  terminations = 0;
  _closeFrameReceived = false;
  _closeFrameSent = false;
  send(_data, _options, callback) { callback?.(); }
  ping() { this.pings += 1; }
  close() { this.readyState = WebSocket.CLOSING; }
  terminate() { this.terminations += 1; this.readyState = WebSocket.CLOSING; }
  finishClose(code = 1006, reason = '') {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
}

function harness(t, { realServer = false, overrides = {} } = {}) {
  const wss = realServer
    ? new WebSocketServer({ port: 0, host: '127.0.0.1' }) : new EventEmitter();
  if (!realServer) {
    wss.clients = new Set();
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    t.after(() => wss.emit('close'));
  } else {
    t.after(() => new Promise(resolve => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(resolve);
    }));
  }
  const logs = [];
  const record = line => logs.push(JSON.parse(line));
  const terminal = { id: 'terminal', clients: new Set() };
  mountWsConnectionRouter(wss, {
    metrics: { inc() {}, set() {} },
    logger: createLogger({ sink: { log: record, warn: record, error: record } }),
    share: { access: () => null },
    parseCookies: () => ({}),
    isLocalRequest: () => true,
    getShuttingDown: () => false,
    getAccessToken: () => '',
    persistedSessions: new Map(),
    sessions: new Map([['terminal', terminal]]),
    handleChatWs() {},
    voiceAsr: { handleVoiceWs() {} },
    ttsService: { handleTtsWs() {} },
    workspaceRuntime: { attachWorkspace() {}, attachMeta() {} },
    auxQueue: { attachClient() {}, getStatus() { return {}; } },
    loadChatHistory: () => [],
    sendWs() {},
    applyMaxClientSize() {},
    ...overrides,
  });
  return {
    wss, logs, terminal,
    tick: () => t.mock.timers.tick(30_000),
    async connect(url = '/ws/chat?session=chat', ws = new FakeSocket()) {
      wss.clients.add(ws);
      await wss.listeners('connection')[0](ws, {
        url, headers: {}, socket: { remoteAddress: '127.0.0.1' },
      });
      return ws;
    },
  };
}

const routes = [
  '/ws/chat?session=chat', '/ws/voice', '/ws/tts',
  '/ws/workspace?dirId=directory', '/ws/meta', '/ws/aux', '/ws?id=terminal',
];
for (const route of routes) {
  test(`${route}: tolerate three full unanswered ping windows before termination`, async t => {
    const h = harness(t);
    const ws = await h.connect(route);
    h.tick(); // First ping: no missed response yet.
    h.tick(); // First unanswered 30s window.
    h.tick(); // Second unanswered 30s window.
    assert.equal(ws.pings, 3);
    assert.equal(ws.terminations, 0);
    assert.deepEqual(h.logs, []);
    h.tick(); // Third unanswered window, 90s after the first ping.
    assert.equal(ws.pings, 3);
    assert.equal(ws.terminations, 1);
    const timeout = h.logs[0];
    assert.equal(timeout.event, 'ws_pong_timeout');
    assert.equal(timeout.level, 'warn');
    assert.equal(timeout.missedPongs, 3);
    assert.equal(timeout.path, route.split('?')[0]);
    assert.ok(timeout.connectionId);
    h.tick();
    assert.equal(ws.terminations, 1, 'do not repeatedly terminate a closing socket');
    ws.finishClose();
    const closed = h.logs[1];
    assert.equal(closed.event, 'ws_connection_closed');
    assert.equal(closed.connectionId, timeout.connectionId);
    assert.equal(closed.code, 1006);
    assert.equal(closed.reason, '');
    assert.equal(closed.wasClean, false);
    assert.equal(closed.heartbeatTimedOut, true);
    assert.equal(closed.missedPongs, 3);
    assert.equal(closed.durationMs, 150_000);
    assert.equal(h.terminal.clients.size, 0, 'terminal close still detaches its client');
  });
}

test('late pong resets consecutive misses and keeps healthy sibling connections alive', async t => {
  const h = harness(t);
  const delayed = await h.connect();
  const healthy = await h.connect('/ws/voice');
  const tick = () => { h.tick(); healthy.emit('pong'); };
  tick(); tick(); tick();
  delayed.emit('pong'); // Arrives after two missed windows, before termination.
  tick(); tick(); tick();
  assert.equal(delayed.terminations, 0, 'pong must reset both pending and missed state');
  assert.equal(healthy.terminations, 0);
  tick();
  assert.equal(delayed.terminations, 1);
  assert.equal(healthy.terminations, 0);
  assert.equal(h.logs.length, 1);
});

test('skip non-open sockets and cancel the heartbeat when the server closes', async t => {
  const h = harness(t);
  for (const state of [WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED]) {
    const ws = await h.connect();
    ws.readyState = state;
    for (let i = 0; i < 5; i++) h.tick();
    assert.equal(ws.pings, 0);
    assert.equal(ws.terminations, 0);
  }
  const open = await h.connect();
  h.wss.emit('close');
  for (let i = 0; i < 5; i++) h.tick();
  assert.equal(open.pings, 0);
  assert.equal(open.terminations, 0);
  assert.deepEqual(h.logs, []);
});

test('close diagnostics identify individual connections without logging auth query strings', async t => {
  const h = harness(t, { overrides: {
    getAccessToken: () => 'configured',
    authSecurity: { consumeWsTicket: () => ({ correlationId: 'request-correlation' }) },
  } });
  const first = await h.connect('/ws/chat?session=chat&ticket=secret-ticket&token=secret-token');
  const second = await h.connect('/ws/workspace?dirId=directory&ticket=secret-ticket');
  first._closeFrameReceived = true;
  first._closeFrameSent = true;
  h.tick();
  first.finishClose(1000, 'leaving');
  second.finishClose(1006);
  assert.equal(h.logs[0].sessionId, 'chat');
  assert.equal(h.logs[0].correlationId, 'request-correlation');
  assert.equal(h.logs[0].durationMs, 30_000);
  assert.equal(h.logs[0].reason, 'leaving');
  assert.equal(h.logs[0].wasClean, true);
  assert.equal(h.logs[0].heartbeatTimedOut, false);
  assert.equal(h.logs[1].directoryId, 'directory');
  assert.notEqual(h.logs[0].connectionId, h.logs[1].connectionId);
  assert.doesNotMatch(JSON.stringify(h.logs), /secret-ticket|secret-token|\?session/);
});

test('early admission rejections also emit close diagnostics', async t => {
  const h = harness(t, { overrides: { isRequestPeerAllowed: () => false } });
  const ws = await h.connect();
  ws.finishClose(4003, 'Direct public access disabled');
  assert.equal(h.logs[0].code, 4003);
  assert.equal(h.logs[0].heartbeatTimedOut, false);
});

test('real ws close events distinguish completed handshakes from abrupt peer loss', { timeout: 10_000 }, async t => {
  const h = harness(t, { realServer: true });
  await once(h.wss, 'listening');
  for (const code of [1000, 4003, 1006]) {
    const connected = once(h.wss, 'connection');
    const client = new WebSocket(`ws://127.0.0.1:${h.wss.address().port}/ws/chat?session=chat`);
    t.after(() => client.terminate());
    await once(client, 'open');
    const [serverSocket] = await connected;
    const closed = once(serverSocket, 'close');
    const clientClosed = once(client, 'close');
    let closeEvent;
    serverSocket.addEventListener('close', event => { closeEvent = event; });
    if (code === 1006) client.terminate();
    else client.close(code, 'peer leaving');
    await Promise.all([closed, clientClosed]);
    const log = h.logs.at(-1);
    assert.equal(log.code, code);
    assert.equal(log.reason, code === 1006 ? '' : 'peer leaving');
    assert.equal(log.wasClean, code !== 1006);
    assert.equal(log.wasClean, closeEvent.wasClean, 'match ws native CloseEvent semantics');
    assert.equal(log.heartbeatTimedOut, false);
    assert.ok(log.durationMs >= 0);
  }
});

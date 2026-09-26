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

test('terminal launch reports missing tmux without claiming Codex is missing', async t => {
  const messages = [];
  const h = harness(t, { overrides: {
    persistedSessions: new Map([['login', { id: 'login', cli: 'codex', kind: 'terminal' }]]),
    createSession: async () => { throw Object.assign(new Error('spawn tmux ENOENT'), {
      code: 'ENOENT', path: 'tmux',
    }); },
    sendWs: (_ws, message) => messages.push(message),
  } });
  await h.connect('/?id=login');
  const message = messages.find(m => m.type === 'error');
  assert.match(message.data, /tmux/);
  assert.doesNotMatch(message.data, /Make sure "codex"|CODEX_CMD/);
  assert.ok(h.logs.some(row => row.event === 'terminal_launch_failed' && row.dependency === 'tmux'));
});
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

// A share link opens the same page over a socket it is not logged in for. The
// token is the whole authority: no ticket exists for it, and the scope is one
// session. The renderer sends whatever it would send as the owner, so the next
// gate is `_sharePerm`, which the turn engine reads before acting on a message.
test('a share connection authorizes itself, is scoped to one session, and cannot claim more', async t => {
  const chatConnections = [];
  const shareCalls = [];
  const h = harness(t, { overrides: {
    share: {
      access: (token, { cookies }) => {
        shareCalls.push(token);
        if (token === 'open-token') return { access: 'view', sessionId: 'chat' };
        if (token === 'live-token' && cookies.multicc_share_live_token === 'proof') {
          return { access: 'view', sessionId: 'chat' };
        }
        if (token === 'operate-token') return { access: 'operate', sessionId: 'chat' };
        return null;
      },
    },
    // 管理员票据对分享连接必须完全不被需要：它压根没有票据。
    authSecurity: { consumeWsTicket: () => { throw new Error('a share must never need a ticket'); } },
    parseCookies: (header) => Object.fromEntries(String(header || '').split(';').map((pair) => {
      const [key, ...rest] = pair.trim().split('=');
      return key ? [key.trim(), rest.join('=').trim()] : null;
    }).filter(Boolean)),
    handleChatWs: (ws) => chatConnections.push(ws),
  } });

  // 只读分享：连上了，权限落在 socket 上给下游判。
  const view = await h.connect('/ws/chat?session=chat&share=open-token', new FakeSocket());
  assert.equal(view._sharePerm, 'view');
  assert.equal(chatConnections.at(-1), view);

  // 带密码的分享凭 cookie 授权（cookie 名和值都由分享存储决定）。
  const cookieClient = new FakeSocket();
  h.wss.clients.add(cookieClient);
  await h.wss.listeners('connection')[0](cookieClient, {
    url: '/ws/chat?session=chat&share=live-token',
    headers: { cookie: 'multicc_share_live_token=proof' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  assert.equal(cookieClient._sharePerm, 'view');

  // 密码不对就不是查看方，也不该回落到「本机所以放行」。
  const wrongPassword = await h.connect('/ws/chat?session=chat&share=live-token', new FakeSocket());
  assert.equal(wrongPassword._sharePerm, undefined);
  assert.equal(wrongPassword.readyState, WebSocket.CLOSING);

  // 可协作的分享拿到的是 operate，页面据此才放开输入区。
  const operate = await h.connect('/ws/chat?session=chat&share=operate-token', new FakeSocket());
  assert.equal(operate._sharePerm, 'operate');

  // token 只能用在它自己那一个会话上：换个 session 就是另一段对话。
  const otherSession = await h.connect('/ws/chat?session=elsewhere&share=open-token', new FakeSocket());
  assert.equal(otherSession._sharePerm, undefined, 'a rejected socket never gets a permission');
  assert.equal(otherSession.readyState, WebSocket.CLOSING, 'a token is scoped, not a skeleton key');

  // 认不出的 token 一样拒绝，而不是回落到「本机所以放行」。
  const unknown = await h.connect('/ws/chat?session=chat&share=forged', new FakeSocket());
  assert.equal(unknown.readyState, WebSocket.CLOSING);
  assert.equal(chatConnections.length, 3, 'only the three authorized connections reach the chat handler');

  // 非 /ws/chat 通道根本不看 share：一个分享 token 换不来终端或语音。
  // （这条本机请求是按「本机」那条规矩放行的，与分享无关；要断言的是分享根本没被问。）
  const shareCallsBefore = shareCalls.length;
  const workspace = await h.connect('/ws/workspace?dirId=directory&share=operate-token', new FakeSocket());
  assert.equal(workspace._sharePerm, undefined);
  assert.equal(shareCalls.length, shareCallsBefore, 'share is consulted for /ws/chat and nothing else');
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

// 终端 attach 的快照顺序。这三条守的是同一件事：重连时屏上要「就是服务端现在的样子」，
// 既不能被随后到来的重绘冲掉，也不能把重绘冲掉，更不能把一个已经走掉的客户端留在扇出里。
function terminalHarness(t, capture) {
  const order = [];
  let releaseCapture;
  const gate = new Promise(resolve => { releaseCapture = resolve; });
  const h = harness(t, { overrides: {
    sendWs: (_ws, message) => order.push(`send:${message.type}`),
    tmuxCaptureSnapshot: async () => { order.push('capture'); await gate; return capture; },
    tmuxResize: () => order.push('tmuxResize'),
    applyMaxClientSize: () => order.push('applyMaxClientSize'),
    pushOnInput: () => {},
  } });
  return { ...h, order, releaseCapture };
}

test('terminal attach: snapshot lands before the client resize that triggers a repaint', async t => {
  const h = terminalHarness(t, 'old screen\r\n');
  const ws = new FakeSocket();
  // The handler parks on capture-pane synchronously, so this resize is exactly the
  // one that would otherwise be applied — and repainted — before the snapshot.
  const connecting = h.connect('/ws?id=terminal', ws);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 80, rows: 24 })));
  assert.deepEqual(h.order, ['send:session_id', 'capture'], 'resize is held while capturing');
  h.releaseCapture();
  await connecting;
  assert.deepEqual(h.order, [
    'send:session_id', 'capture', 'send:snapshot', 'tmuxResize', 'applyMaxClientSize',
  ]);
  assert.equal(h.terminal.clients.size, 1, 'client joins the fan-out once the snapshot is out');
  assert.equal(ws._desiredCols, 80, 'the held resize is still applied');
});

test('terminal attach: an empty pane sends no snapshot but still attaches', async t => {
  const h = terminalHarness(t, '\r\n   \r\n');
  const ws = new FakeSocket();
  const connecting = h.connect('/ws?id=terminal', ws);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 80, rows: 24 })));
  h.releaseCapture();
  await connecting;
  assert.deepEqual(h.order, [
    'send:session_id', 'capture', 'tmuxResize', 'applyMaxClientSize',
  ], 'a blank capture would just push an empty screen down');
  assert.equal(h.terminal.clients.size, 1);
});

test('terminal attach: a client that leaves mid-capture is not left in the fan-out', async t => {
  const h = terminalHarness(t, 'old screen\r\n');
  const ws = new FakeSocket();
  const connecting = h.connect('/ws?id=terminal', ws);
  ws.finishClose();
  h.releaseCapture();
  await connecting;
  assert.deepEqual(h.order, ['send:session_id', 'capture', 'applyMaxClientSize'],
    'only the detach from the close handler runs — no snapshot to a closed socket');
  assert.ok(!h.order.includes('send:snapshot'), 'nothing is sent to a closed socket');
  assert.equal(h.terminal.clients.size, 0, 'no dead socket left behind to leak the session');
});

// 真 tmux capture-pane -p 的行尾是裸 "\n"、末尾还拖一串空行（实测）。原样写给 xterm 会
// 走成阶梯（LF 只下移不回车），末尾换行还会把最后一行屏幕顶出视口。
test('terminal snapshot: capture-pane text is reshaped for replay', () => {
  const { formatPaneSnapshot } = require('../src/tmux');
  const captured = 'aaa\nbbb\nccc\n\n\n\n\n\n\n\n';
  const out = formatPaneSnapshot(captured, { x: 0, y: 3, height: 10 });
  assert.ok(!/[^\r]\n/.test(out), 'every LF is preceded by CR');
  assert.ok(out.startsWith('aaa\r\nbbb\r\nccc\r\n'));
  assert.equal(out.split('\r\n').length, 10, '10 screen rows → 9 line breaks, none after the last row');
  assert.ok(out.endsWith('\x1b[0m\x1b[6A\x1b[1G'), 'cursor goes back to row 3 (6 up from the last of 10 rows), col 0');
  assert.equal(formatPaneSnapshot('\n   \n\n', { x: 0, y: 0, height: 3 }), '', 'blank pane → no snapshot');
  assert.ok(formatPaneSnapshot('x\n', {}).endsWith('x\x1b[0m'), 'missing cursor info → no cursor move');
});

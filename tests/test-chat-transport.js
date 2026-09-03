'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createTransport,
  credentialFreeUrl,
  safeDebugUrl,
  verifiedTicketUrl,
} = require('../public/chat-transport');

const ROOT = path.join(__dirname, '..');

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }

  message(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closeArgs = { code, reason };
    if (this.onclose) this.onclose({ code, reason });
  }

  send(data) { this.sent.push(data); }
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    setInterval(fn, ms) {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { if (timer) timer.cleared = true; },
    runNextTimeout() {
      const timer = timeouts.find(item => !item.cleared && !item.ran);
      assert.ok(timer, 'expected a pending timeout');
      timer.ran = true;
      timer.fn();
      return timer;
    },
  };
}

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, event = {}) {
      for (const fn of listeners.get(name) || []) fn(event);
    },
    count(name) { return listeners.get(name)?.size || 0; },
  };
}

function harness(overrides = {}) {
  FakeSocket.instances = [];
  const timers = fakeTimers();
  const document = eventTarget({ visibilityState: 'visible' });
  const window = eventTarget({
    document,
    location: {
      href: 'https://multicc.test/chat.html?session=s1',
      host: 'multicc.test',
      protocol: 'https:',
    },
  });
  const callbacks = { sockets: [], connecting: [], closes: [], messages: [], forced: [] };
  const ticketInputs = [];
  const transport = createTransport({
    window,
    document,
    WebSocket: FakeSocket,
    baseUrl: window.location.href,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    buildUrl: () => 'wss://multicc.test/ws/chat?session=s1&token=legacy-secret',
    ticketUrl: async raw => {
      ticketInputs.push(raw);
      return `${raw}&token=must-drop&ticket=single-use`;
    },
    onSocket: socket => callbacks.sockets.push(socket),
    onConnecting: info => callbacks.connecting.push(info),
    onMessage: event => callbacks.messages.push(event.data),
    onClose: info => { callbacks.closes.push(info); return true; },
    onForceReconnect: reason => callbacks.forced.push(reason),
    ...overrides,
  });
  return { transport, timers, document, window, callbacks, ticketInputs };
}

test('credential helper removes long-lived credentials and masks one-time tickets in diagnostics', () => {
  const raw = 'wss://user:password@multicc.test/ws/chat?Token=a&access_token=b&API_KEY=c&session=s1&Ticket=once';
  assert.equal(
    credentialFreeUrl(raw, 'https://multicc.test/chat.html'),
    'wss://multicc.test/ws/chat?session=s1&Ticket=once',
  );
  assert.equal(
    safeDebugUrl(raw, 'https://multicc.test/chat.html'),
    'wss://multicc.test/ws/chat?session=s1&Ticket=***',
  );
  assert.throws(
    () => verifiedTicketUrl('wss://outside.test/ws/chat?ticket=once', 'https://multicc.test/chat.html'),
    /same-origin/,
  );
  assert.throws(
    () => verifiedTicketUrl('ws://multicc.test/ws/chat?ticket=once', 'https://multicc.test/chat.html'),
    /secure transport/,
  );
  assert.throws(
    () => verifiedTicketUrl('wss://multicc.test/ws/chat', 'https://multicc.test/chat.html'),
    /ticket is required/,
  );
});

test('connect obtains a path-bound ticket without putting long-lived tokens on socket or debug URLs', async () => {
  const h = harness();
  const socket = await h.transport.connect();
  assert.equal(h.ticketInputs.length, 1);
  assert.equal(h.ticketInputs[0], 'wss://multicc.test/ws/chat?session=s1');
  assert.equal(socket.url, 'wss://multicc.test/ws/chat?session=s1&ticket=single-use');
  assert.equal(h.callbacks.connecting[0].debugUrl, 'wss://multicc.test/ws/chat?session=s1&ticket=***');
  assert.equal(JSON.stringify(h).includes('legacy-secret'), false);
  assert.equal(socket.url.includes('must-drop'), false);
});

test('message ordering, safe sends and reconnect backoff remain deterministic', async () => {
  const h = harness();
  const first = await h.transport.connect();
  first.open();
  first.message('{"type":"system"}');
  assert.equal(h.transport.send({ type: 'typing' }), true);
  assert.deepEqual(first.sent, ['{"type":"typing"}']);
  assert.deepEqual(h.callbacks.messages, ['{"type":"system"}']);

  first.close(1006, 'network');
  assert.equal(h.callbacks.closes[0].delay, 1000);
  assert.equal(h.callbacks.closes[0].envelope.code, 'WS_CLOSE_1006');
  assert.equal(h.callbacks.closes[0].envelope.family, 'network');
  assert.equal(h.callbacks.closes[0].envelope.message, 'network');
  assert.equal(h.timers.timeouts.at(-1).ms, 1000);
  h.timers.runNextTimeout();
  await Promise.resolve();
  await Promise.resolve();
  const second = FakeSocket.instances.at(-1);
  assert.notEqual(second, first);
  second.close(1006, 'network');
  assert.equal(h.callbacks.closes[1].delay, 2000);
  assert.equal(h.transport.send({ type: 'cancel' }), false);
});

test('ticket failures keep their original structured error for the host UI', async () => {
  const observed = [];
  const failure = Object.assign(new Error('remote Fleet refused the ticket'), {
    code: 'FLEET_SCOPE_FORBIDDEN',
    status: 403,
    category: 'authentication_permission',
    requestId: 'request-7',
    correlationId: 'correlation-7',
  });
  const h = harness({
    ticketUrl: async () => { throw failure; },
    onTicketError: (error, meta) => observed.push({ error, meta }),
  });

  assert.equal(await h.transport.connect(), null);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].error, failure);
  assert.equal(observed[0].meta.envelope.code, 'FLEET_SCOPE_FORBIDDEN');
  assert.equal(observed[0].meta.envelope.message, 'remote Fleet refused the ticket');
  assert.equal(observed[0].meta.envelope.family, 'auth');
  assert.equal(h.timers.timeouts.at(-1).ms, 1000);
});

test('force reconnect detaches the old socket and stale ticket resolutions cannot replace the winner', async () => {
  let releaseFirst;
  let calls = 0;
  const h = harness({
    ticketUrl: raw => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { releaseFirst = () => resolve(`${raw}&ticket=stale`); });
      return Promise.resolve(`${raw}&ticket=fresh`);
    },
  });
  const stale = h.transport.connect();
  h.transport.forceReconnect('network online');
  await Promise.resolve();
  await Promise.resolve();
  releaseFirst();
  assert.equal(await stale, null);
  await Promise.resolve();
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(FakeSocket.instances[0].url.endsWith('ticket=fresh'), true);
  assert.deepEqual(h.callbacks.forced, ['network online']);
});

test('lifecycle owns visibility, pageshow, focus, online and heartbeat cleanup', async () => {
  const h = harness();
  h.transport.startLifecycle();
  assert.equal(h.document.count('visibilitychange'), 1);
  assert.equal(h.window.count('pageshow'), 1);
  assert.equal(h.window.count('focus'), 1);
  assert.equal(h.window.count('online'), 1);
  assert.equal(h.timers.intervals[0].ms, 5000);

  h.window.emit('online');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(h.callbacks.forced, ['network online']);
  assert.equal(FakeSocket.instances.length, 1);

  h.transport.stopLifecycle();
  assert.equal(h.document.count('visibilitychange'), 0);
  assert.equal(h.window.count('online'), 0);
  assert.equal(h.timers.intervals[0].cleared, true);
});

test('chat page loads transport before chat and delegates socket ownership and sending', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
  assert.ok(
    html.indexOf('<script src="chat-transport.js"></script>')
      < html.indexOf('<script src="chat.js"></script>'),
  );
  assert.match(chat, /MultiCCChatTransport\.createTransport/);
  assert.match(chat, /chatTransport\.startLifecycle\(\)/);
  assert.doesNotMatch(chat, /new WebSocket\s*\(/);
  assert.doesNotMatch(chat, /ws\.send\s*\(/);
  assert.doesNotMatch(chat, /[?&]token=/);
  assert.match(chat, /multiccWsUrl\(rawWsUrl\)/, 'voice WebSockets must also use one-time tickets');
});

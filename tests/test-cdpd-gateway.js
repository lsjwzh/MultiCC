'use strict';

// The real multicc-cdpd binary against a fake Chrome. Covers what only shows up
// with processes and sockets in play: one approval for concurrent callers while
// Chrome is still asking, no dialog storm after a denial, a caller's sessions
// handed back when it disconnects, callers released promptly when Chrome quits,
// autostart, the WebSocket endpoint, and chrome-cdp end to end.
//
// Skipped when the binary has not been built (cargo build -p multicc-cdpd, or
// MULTICC_CDP_BIN=/path/to/multicc-cdpd).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');
const WebSocket = require('ws');

const cdpd = require('../src/cdpd');
const { openCdpSocket } = require('../src/cdp-relay');
const { createChromeCdp } = require('../src/chrome-cdp');

const ROOT = path.join(__dirname, '..');
const BINARY = [
  process.env.MULTICC_CDP_BIN,
  cdpd.binaryPath({ ...process.env, MULTICC_CDP_BIN: '' }),
  path.join(ROOT, 'native/target/release', cdpd.BIN_NAME),
  path.join(ROOT, 'native/target/debug', cdpd.BIN_NAME),
].find((file) => file && fs.existsSync(file));
const skip = BINARY ? false : 'multicc-cdpd is not built';
const quiet = { log() {}, warn() {} };

// --- a fake Chrome ---------------------------------------------------------

async function fakeChrome({ delayMs = 0, rejectWith = 0 } = {}) {
  const chrome = { attempts: 0, frames: [], sockets: new Set() };
  let counter = 0;
  const server = new WebSocket.Server({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, done) => {
      chrome.attempts += 1;
      setTimeout(() => (rejectWith ? done(false, rejectWith) : done(true)), delayMs);
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    chrome.sockets.add(socket);
    socket.on('close', () => chrome.sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      chrome.frames.push(frame);
      const reply = (result) => socket.send(JSON.stringify({ id: frame.id, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}), result }));
      const p = frame.params || {};
      switch (frame.method) {
        case 'Target.attachToBrowserTarget': return reply({ sessionId: `B${++counter}` });
        case 'Target.createTarget': return reply({ targetId: `T${++counter}` });
        case 'Target.attachToTarget': {
          const sessionId = `S${++counter}`;
          socket.send(JSON.stringify({ method: 'Target.attachedToTarget', ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
            params: { sessionId, targetInfo: { targetId: p.targetId, type: 'page' }, waitingForDebugger: false } }));
          return reply({ sessionId });
        }
        case 'Browser.getVersion': return reply({ product: 'FakeChrome/1' });
        case 'Runtime.evaluate': return reply({ result: { type: 'number', value: 42 } });
        default: return reply({});
      }
    });
  });
  chrome.url = `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`;
  chrome.quit = () => { for (const socket of chrome.sockets) socket.terminate(); };
  chrome.close = () => new Promise((resolve) => { chrome.quit(); server.close(resolve); });
  return chrome;
}

// --- the daemon -------------------------------------------------------------

function gatewayEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpgw-'));
  return {
    HOME: process.env.HOME, PATH: process.env.PATH,
    MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: BINARY,
    MULTICC_CDP_APPROVAL_TIMEOUT_SECS: '5', MULTICC_CDP_IDLE_EXIT_SECS: '120',
    ...extra,
  };
}

async function startDaemon(env) {
  const child = spawn(BINARY, ['serve'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (cdpd.protocolOf(await cdpd.request({ op: 'ping' }, { env })) === cdpd.PROTOCOL_VERSION) return child;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error('daemon did not start');
}

async function stopDaemon(env) {
  await cdpd.request({ op: 'shutdown', force: true }, { env });
  for (let i = 0; i < 50 && await cdpd.request({ op: 'ping' }, { env }); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// --- a tiny CDP client over openCdpSocket ------------------------------------

function connect(url, env, options = {}) {
  const socket = openCdpSocket(url, { env, provisioner: cdpd.createCdpdProvisioner({ env, logger: quiet }), pendingAfterMs: 100, ...options });
  let nextId = 0;
  const waiting = new Map();
  const events = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined && waiting.has(message.id)) {
      const { resolve } = waiting.get(message.id);
      waiting.delete(message.id);
      resolve(message);
    } else {
      events.push(message);
    }
  });
  const client = {
    socket, events,
    pending: false,
    call(method, params = {}, sessionId) {
      const id = ++nextId;
      const frame = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve) => { waiting.set(id, { resolve }); socket.send(JSON.stringify(frame)); });
    },
    closed: new Promise((resolve) => socket.on('close', resolve)),
  };
  socket.on('pending', () => { client.pending = true; });
  client.opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return client;
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// --- tests ----------------------------------------------------------------

test('the binary and src/cdpd.js agree on paths and protocol', { skip }, () => {
  const env = gatewayEnv();
  const printed = JSON.parse(spawnSync(BINARY, ['paths'], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(printed, cdpd.cdpdPaths(env));
  const version = spawnSync(BINARY, ['--version'], { encoding: 'utf8' }).stdout.trim();
  assert.match(version, new RegExp(`^multicc-cdpd ${cdpd.PROTOCOL_VERSION} `));
});

test('callers that arrive while Chrome is still asking share the one approval', { skip }, async () => {
  const chrome = await fakeChrome({ delayMs: 400 });
  const env = gatewayEnv();
  await startDaemon(env);
  try {
    const [a, b] = [connect(chrome.url, env), connect(chrome.url, env)];
    await Promise.all([a.opened, b.opened]);
    assert.ok(a.pending && b.pending, 'callers are told Chrome is waiting for the user');
    assert.equal(a.socket.transport, 'gateway');
    assert.equal(a.socket.mode, 'isolated');
    assert.equal((await a.call('Browser.getVersion')).result.product, 'FakeChrome/1');
    assert.equal((await b.call('Browser.getVersion')).result.product, 'FakeChrome/1');
    a.socket.close();
    b.socket.close();
    const c = connect(chrome.url, env);
    await c.opened;
    await c.call('Browser.getVersion');
    c.socket.close();
    assert.equal(chrome.attempts, 1, 'one WebSocket to Chrome, so one dialog, for every caller');
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('a caller\'s browser session is handed back when it disconnects, and its tab is its own', { skip }, async () => {
  const chrome = await fakeChrome();
  const env = gatewayEnv();
  await startDaemon(env);
  try {
    const a = connect(chrome.url, env);
    const b = connect(chrome.url, env);
    await Promise.all([a.opened, b.opened]);
    const { targetId } = (await a.call('Target.createTarget', { url: 'about:blank' })).result;
    const { sessionId } = (await a.call('Target.attachToTarget', { targetId, flatten: true })).result;
    assert.equal((await a.call('Runtime.evaluate', { expression: '6*7' }, sessionId)).result.result.value, 42);
    assert.ok(a.events.some((e) => e.method === 'Target.attachedToTarget' && !e.sessionId), 'root session is invisible to the caller');
    assert.ok(!b.events.some((e) => e.method === 'Target.attachedToTarget'), 'events stay with their owner');

    const busy = await b.call('Target.attachToTarget', { targetId, flatten: true });
    assert.match(busy.error.message, /^cdp-target-busy/);
    const borrowed = await b.call('Runtime.evaluate', { expression: '1' }, sessionId);
    assert.ok(borrowed.error, 'another caller cannot use the session');

    const roots = chrome.frames.filter((f) => f.method === 'Target.attachToBrowserTarget').length;
    assert.equal(roots, 2, 'each caller gets its own browser session');
    const rootOfA = chrome.frames.find((f) => f.method === 'Target.createTarget').sessionId;
    a.socket.close();
    assert.ok(await until(() => chrome.frames.some((f) => f.method === 'Target.detachFromTarget' && f.params.sessionId === rootOfA)),
      'disconnecting detaches the caller\'s browser session, as a closed WebSocket would');
    assert.ok(!(await b.call('Target.attachToTarget', { targetId, flatten: true })).error, 'and frees the tab');
    b.socket.close();
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('callers are released at once when Chrome goes away', { skip }, async () => {
  const chrome = await fakeChrome();
  const env = gatewayEnv();
  await startDaemon(env);
  try {
    const a = connect(chrome.url, env);
    await a.opened;
    const started = Date.now();
    chrome.quit();
    await a.closed;
    assert.ok(Date.now() - started < 2000, 'no waiting for a command timeout');
    assert.equal(a.socket.closeReason.error, 'cdp-upstream-closed');
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('a denied approval is not retried into a dialog storm, and never falls back to a direct socket', { skip }, async () => {
  const chrome = await fakeChrome({ rejectWith: 403 });
  const env = gatewayEnv();
  await startDaemon(env);
  try {
    const first = connect(chrome.url, env);
    await assert.rejects(first.opened, (error) => error.code === 'chrome_rejected');
    const second = connect(chrome.url, env);
    await assert.rejects(second.opened, (error) => error.code === 'chrome_cooldown' && error.retryAfterMs > 0);
    assert.equal(chrome.attempts, 1, 'one dialog, then silence until the cooldown ends');
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('the gateway is started on demand, then outlives its caller', { skip }, async () => {
  const chrome = await fakeChrome();
  const env = gatewayEnv();
  try {
    assert.equal(await cdpd.request({ op: 'ping' }, { env }), null);
    const a = connect(chrome.url, env);
    await a.opened;
    assert.equal(a.socket.transport, 'gateway');
    a.socket.close();
    const status = await cdpd.request({ op: 'status' }, { env });
    assert.equal(status.upstreams.length, 1, 'the approved connection stays after the caller left');
    assert.equal(status.upstreams[0].clients, 0);
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('off-the-shelf CDP clients can use the WebSocket endpoint; web pages cannot', { skip }, async () => {
  const chrome = await fakeChrome();
  const env = gatewayEnv();
  try {
    const printed = spawnSync(BINARY, ['endpoint', '--ws', chrome.url, '--lane', 'script-1'], { env, encoding: 'utf8' });
    const url = printed.stdout.trim();
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[0-9a-f]{48}\?ws=ws%3A%2F%2F127\.0\.0\.1.*&lane=script-1$/);

    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const reply = await new Promise((resolve) => {
      socket.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id === 1) resolve(m); });
      socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    assert.equal(reply.result.product, 'FakeChrome/1');
    socket.close();

    const fromPage = new WebSocket(url, { origin: 'https://evil.example' });
    const status = await new Promise((resolve) => fromPage.once('unexpected-response', (_req, res) => resolve(res.statusCode)));
    assert.equal(status, 403);
    const badToken = new WebSocket(url.replace(/\/cdp\/[0-9a-f]+/, '/cdp/0000'));
    assert.equal(await new Promise((resolve) => badToken.once('unexpected-response', (_req, res) => resolve(res.statusCode))), 404);

    // The named lane survives its connection: a one-shot CLI call reuses it.
    // (Async on purpose: spawnSync would block the fake Chrome in this process.)
    const stdout = await new Promise((resolve, reject) => execFile(BINARY,
      ['cdp', '{"method":"Browser.getVersion"}', '--ws', chrome.url, '--lane', 'script-1'], { env },
      (error, out) => (error ? reject(new Error(`${error.message}\n${out}`)) : resolve(out))));
    assert.equal(JSON.parse(stdout).result.product, 'FakeChrome/1');
    assert.equal(chrome.frames.filter((f) => f.method === 'Target.attachToBrowserTarget').length, 1, 'same lane, same browser session');
    assert.equal(chrome.attempts, 1);
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

test('chrome-cdp sends a default-profile browser through the gateway, by default only that one', { skip }, async () => {
  const chrome = await fakeChrome();
  const env = gatewayEnv();
  await startDaemon(env);
  // A DevToolsActivePort in a browser's default user-data dir: debugging was
  // switched on at runtime, so Chrome asks per connection.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profile-'));
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${new URL(chrome.url).port}\n/devtools/browser/fake\n`);
  try {
    const cdp = createChromeCdp({
      env,
      ports: [],
      profileDirs: [profile],
      gatedProfileDirs: [profile],
    });
    const value = await cdp.withPage((page) => page.evaluate('6*7'));
    assert.equal(value, 42);
    assert.ok(chrome.frames.some((f) => f.method === 'Target.closeTarget'), 'its tab is closed afterwards');
    assert.equal(chrome.attempts, 1);
  } finally {
    await stopDaemon(env);
    await chrome.close();
  }
});

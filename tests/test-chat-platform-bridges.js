'use strict';
// Synthetic SDKs and a private workspace exercise the native controller. No
// platform network, production credentials, real timers or host service needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const binding = require('../src/native/binding');
const addon = binding.getNative();

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response() {
  return { statusCode: 200, body: undefined, headers: {}, writes: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; }, flushHeaders() {},
    write(value) { this.writes.push(value); },
  };
}
function handler(bridge, verb, pathname) {
  const layer = bridge.router.stack.find(layer => layer.route?.path === pathname && layer.route.methods[verb.toLowerCase()]);
  assert.ok(layer, `${verb} ${pathname}`);
  return layer.route.stack.at(-1).handle;
}
async function request(h, verb, pathname, body, query = {}) {
  const req = Object.assign(new EventEmitter(), { body, query });
  const res = response();
  await handler(h.bridge, verb, pathname)(req, res);
  return res;
}
function harness(t, platform, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-platform-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const calls = [], clients = [], gateways = new Map();
  const storage = { config: options.config ?? { botToken: 'synthetic-bot' } };
  let sdkLoads = 0, wsOptions, clientOptions, writeError, lifecycleOptions;
  const clearBridgeHistory = sessionId => {
    calls.push(['history.clear', sessionId]);
    return options.clearBridgeHistory?.(sessionId);
  };
  const ws = {
    open: true, connect() { calls.push('ws.connect'); },
    disconnect() { calls.push('ws.disconnect'); }, reconnectIfRunning() { calls.push('ws.reconnect'); },
    isOpen() { return this.open; }, async ensureOpen(ms) { calls.push(['ws.ensureOpen', ms]); },
    sendUserMessage(text) { calls.push(['ws.send', text]); return this.open; },
  };
  const core = binding.bridgeGateway;
  const sdk = {
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Client: class extends EventEmitter {
      constructor(value) {
        super(); clientOptions = value; clients.push(this);
        this.user = { id: 'self', tag: 'test#0001' };
        this.channels = { fetch: async id => {
          calls.push(['fetch', id]);
          if (options.fetchError) throw options.fetchError;
          return options.channel ?? { send: async text => {
            calls.push(['discord.send', id, text]);
            if (options.sendError) throw options.sendError;
          } };
        } };
      }
      async login(token) {
        calls.push(['login', token]);
        if (options.startGate) await options.startGate.promise;
        if (options.startError) throw options.startError;
      }
      destroy() { calls.push('discord.destroy'); if (options.stopError) throw options.stopError; }
    },
  };
  const outboundFetch = () => {}, buildDiscordStrategy = () => {};
  const bridge = addon.chatPlatformBridgeApi({
    express: require('express'), path, os: { homedir: () => home }, bridgeDir: home,
    fs: { readFileSync: () => JSON.stringify(storage.config) },
    bridgeConfig: {
      bridgeConfigFile: name => path.join(home, name), bridgeHistoryFile: () => path.join(home, 'history.json'),
      saveBridgeConfig(file, value) { calls.push(['config.save', file]); if (writeError) throw writeError; storage.config = structuredClone(value); },
    },
    bridgeGateway: { ...core,
      createGatewayLifecycle(opts) { lifecycleOptions = opts; return core.createGatewayLifecycle(opts); },
      createChatWsClient(opts) { wsOptions = opts; return ws; },
    },
    createTelegramClient(value) {
      sdkLoads++; clientOptions = value; calls.push('telegram.construct');
      const client = {
        onMessage(fn) { this.message = fn; calls.push('telegram.listen'); },
        onPollingError(fn) { this.pollingError = fn; },
        async start() { calls.push('telegram.start'); if (options.startGate) await options.startGate.promise; if (options.startError) throw options.startError; },
        async stop() { calls.push('telegram.stop'); if (options.stopGate) await options.stopGate.promise; if (options.stopError) throw options.stopError; },
        async sendMessage(id, text) { calls.push(['telegram.send', id, text]); if (options.sendError) throw options.sendError; },
      };
      clients.push(client); return client;
    },
    loadDiscord() { sdkLoads++; if (options.loadError) throw options.loadError; return sdk; },
    outboundFetch, buildDiscordStrategy,
  }, platform);
  bridge.init({ persistedSessions: gateways, chatSessions: new Map(), savePersistedSessions: () => calls.push('gateway.save'), clearBridgeHistory, port: 4321 });
  t.after(async () => { options.startGate?.resolve(); options.stopGate?.resolve(); await bridge.stopBridge(); });
  const h = { platform, bridge, calls, clients, storage, ws, gateways, outboundFetch, buildDiscordStrategy, clearBridgeHistory,
    get lifecycleOptions() { return lifecycleOptions; },
    get sdkLoads() { return sdkLoads; }, get clientOptions() { return clientOptions; }, get wsOptions() { return wsOptions; },
    failConfigWrite(error) { writeError = error; },
    async create() { return (await request(h, 'PUT', '/gateway', { cli: 'claude' })).body; },
    async status() { return (await request(h, 'GET', '/status')).body; },
    async logs() { return (await request(h, 'GET', '/log')).body; },
    async inbound(value) {
      if (platform === 'telegram') await clients.at(-1).message(value);
      else {
        clients.at(-1).emit('messageCreate', value);
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  };
  return h;
}
for (const platform of ['telegram', 'discord']) {
  const targetKey = platform === 'telegram' ? 'chatId' : 'channelId';
  const statusKey = platform === 'telegram' ? 'currentChat' : 'currentChannel';
  const connectedKey = platform === 'telegram' ? 'polling' : 'wsConnected';
  test(`${platform}: native public shape, config views, live gateway identity and preflight`, async t => {
    const h = harness(t, platform);
    assert.deepEqual(Object.keys(h.bridge).sort(), ['router', 'init', 'loadConfig', 'startBridge', 'stopBridge'].sort());
    assert.equal(h.sdkLoads, 0);
    await assert.rejects(h.bridge.startBridge(), /gateway 未创建/);
    assert.equal(h.sdkLoads, 0);
    const created = await h.create();
    assert.equal(created, h.gateways.get(`__${platform}_gateway__`));
    assert.equal((await request(h, 'GET', '/gateway')).body, created);
    assert.equal((await request(h, 'PUT', '/gateway', { cli: 'wrong' })).statusCode, 400);
    assert.deepEqual((await request(h, 'GET', '/config')).body, platform === 'telegram' ? { configured: true } : { botToken: '***', configured: true });
    await request(h, 'POST', '/config', { botToken: '  replacement  ' });
    assert.equal(h.storage.config.botToken, 'replacement');
    const a = h.bridge.loadConfig(), b = h.bridge.loadConfig();
    assert.notEqual(a, b);
    h.storage.config.botToken = 'on-disk-only';
    await h.bridge.startBridge();
    assert.equal(platform === 'telegram' ? h.clientOptions.token : h.calls.find(x => x[0] === 'login')[1], 'replacement');
    assert.equal((await h.status())[connectedKey], true);
    assert.equal(h.wsOptions.port, 4321);
    assert.equal(h.wsOptions.hostLabel, platform === 'telegram' ? 'Telegram' : 'Discord');
    if (platform === 'discord') {
      assert.equal(h.clientOptions.rest.makeRequest, h.outboundFetch);
      assert.equal(h.clientOptions.ws.buildStrategy, h.buildDiscordStrategy);
      assert.deepEqual(h.clientOptions.intents, [1, 2, 4, 8]);
    } else assert.deepEqual(h.clientOptions, { token: 'replacement', transport: 'polling' });
    h.failConfigWrite(new Error('disk failure'));
    assert.throws(() => handler(h.bridge, 'POST', '/config')({ body: { botToken: '' } }, response()), /disk failure/);
    assert.equal((await request(h, 'GET', '/config')).body.configured, false);
    assert.equal(h.storage.config.botToken, 'on-disk-only');
  });
  test(`${platform}: inbound ordering, echo suppression, commands and gateway sends`, async t => {
    const h = harness(t, platform); await h.create(); await h.bridge.startBridge();
    const inbound = (text, id) => platform === 'telegram' ? { text, chat: { id } } : { content: text, channel: { id }, author: { id: 'human' } };
    await h.inbound(inbound('   ', 'blank-target'));
    assert.equal((await h.status())[statusKey][targetKey], 'blank-target');
    await h.inbound(inbound(' hello ', 'one'));
    assert.ok(h.calls.some(x => Array.isArray(x) && x[0] === 'ws.send' && x[1] === 'hello'));
    await request(h, 'POST', '/send', { target: platform, text: 'echo text', [targetKey]: 'one' });
    const before = (await h.logs()).length;
    await h.inbound(inbound('echo text', 'two'));
    assert.equal((await h.status())[statusKey][targetKey], 'two');
    assert.equal((await h.logs()).length, before);
    await h.inbound(inbound('/HELP extra', 'two'));
    assert.ok(h.calls.some(x => Array.isArray(x) && /\.send$/.test(x[0]) && String(x[2]).startsWith('📋 可用命令:')));
    await h.inbound(inbound('/reset@bot', 'two'));
    assert.ok(h.calls.some(x => Array.isArray(x) && /\.send$/.test(x[0]) && String(x[2]).includes('未知命令: /reset@bot')));
    await h.inbound(inbound('/reset', 'two'));
    assert.ok(h.gateways.get(`__${platform}_gateway__`).cliSessionId);
    h.ws.open = false;
    assert.equal((await request(h, 'POST', '/send', { text: 'manual', target: 'unknown' })).statusCode, 500);
    h.ws.open = true;
    assert.equal((await request(h, 'POST', '/send', { text: 'manual' })).statusCode, 200);
    assert.ok((await h.logs()).some(x => x.text === '[manual] manual'));
    if (platform === 'discord') {
      h.clients[0].emit('ready');
      await h.inbound({ content: 'ignored', channel: { id: 'bot-target' }, author: { bot: true } });
      await h.inbound({ content: 'ignored', channel: { id: 'self-target' }, author: { id: 'self' } });
      assert.equal((await h.status()).currentChannel.channelId, 'two');
    }
  });
  test(`${platform}: swallowed SDK send failure, empty/manual validation and retained target on stop`, async t => {
    const h = harness(t, platform, { sendError: new Error('synthetic send failure') });
    assert.equal((await request(h, 'POST', '/send', { text: '' })).statusCode, 400);
    assert.equal((await request(h, 'POST', '/send', { text: 'x', target: platform })).statusCode, 400);
    const stopped = await request(h, 'POST', '/send', { text: 'x', target: platform, [targetKey]: platform === 'telegram' ? '0042' : 'channel' });
    assert.equal(stopped.body.error, 'Bridge not started');
    assert.equal((await h.status())[statusKey][targetKey], platform === 'telegram' ? 42 : 'channel');
    await h.create(); await h.bridge.startBridge();
    const sent = await request(h, 'POST', '/send', { text: 'x', target: platform });
    assert.deepEqual(sent.body, { ok: true });
    assert.ok((await h.logs()).some(x => x.text.includes('send failed: synthetic send failure')));
    const started = (await h.status()).startTime;
    const stopResult = h.bridge.stopBridge();
    assert.equal(stopResult instanceof Promise, platform === 'telegram');
    await stopResult;
    const status = await h.status();
    assert.equal(status.running, false); assert.equal(status[connectedKey], false);
    assert.equal(status.startTime, started);
    assert.equal(status[statusKey][targetKey], platform === 'telegram' ? 42 : 'channel');
  });
  test(`${platform}: chunk order, continuation prefix, delay and target binding`, async t => {
    const originalSetTimeout = global.setTimeout;
    const delays = [];
    global.setTimeout = (resolve, ms) => { delays.push(ms); queueMicrotask(resolve); return {}; };
    t.after(() => { global.setTimeout = originalSetTimeout; });
    const h = harness(t, platform); await h.create(); await h.bridge.startBridge();
    await request(h, 'POST', '/send', { text: 'attach', target: platform, [targetKey]: 'old' });
    h.calls.length = 0;
    const max = platform === 'telegram' ? 3800 : 1900;
    const value = 'x'.repeat(max) + '\nend';
    await h.wsOptions.onTurn(value);
    const sent = h.calls.filter(x => Array.isArray(x) && x[0] === `${platform}.send`);
    assert.deepEqual(sent.map(x => x[2]), ['x'.repeat(max), '(续2) \nend']);
    assert.deepEqual(delays, [400]);
    if (platform === 'discord') assert.equal(h.calls.filter(x => x[0] === 'fetch').length, 1);
  });
  test(`${platform}: SSE only streams subsequent logs, filters since and removes on close`, async t => {
    const timers = [], cleared = [];
    const set = global.setInterval, clear = global.clearInterval;
    global.setInterval = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
    global.clearInterval = timer => cleared.push(timer);
    t.after(() => { global.setInterval = set; global.clearInterval = clear; });
    const h = harness(t, platform), req = new EventEmitter(), res = response();
    handler(h.bridge, 'GET', '/events')(req, res);
    assert.deepEqual(res.writes, []); assert.equal(res.headers['X-Accel-Buffering'], 'no');
    assert.equal(timers[0].ms, 5000); timers[0].fn();
    assert.equal(res.writes[0], ': heartbeat\n\n');
    await h.create(); assert.match(res.writes[1], /^data: /);
    const last = (await h.logs()).at(-1);
    assert.deepEqual((await request(h, 'GET', '/log', undefined, { since: String(Date.parse(last.ts)) })).body, []);
    req.emit('close'); assert.equal(cleared[0], timers[0]);
    const count = res.writes.length; await h.bridge.stopBridge(); assert.equal(res.writes.length, count);
  });
}
test('Telegram start rejection clears handle, awaits cleanup and preserves original cause', async t => {
  const failure = new Error('polling failed'), gate = deferred(), stop = deferred();
  const h = harness(t, 'telegram', { startError: failure, startGate: gate, stopGate: stop });
  await h.create(); const started = h.bridge.startBridge();
  assert.equal((await h.status()).running, false); assert.equal((await h.status()).polling, true);
  let settled = false; const rejection = assert.rejects(started, e => e === failure).then(() => { settled = true; });
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.status()).polling, false); assert.equal(settled, false);
  stop.resolve(); await rejection;
  assert.ok(h.calls.indexOf('telegram.listen') < h.calls.indexOf('telegram.start'));
  assert.equal(h.calls.includes('ws.connect'), false);
});
test('Discord login rejection keeps published running state until synchronous stop', async t => {
  const failure = new Error('login failed'), gate = deferred();
  const h = harness(t, 'discord', { startError: failure, startGate: gate });
  await h.create(); const started = h.bridge.startBridge();
  const rejection = assert.rejects(started, e => e === failure);
  assert.equal((await h.status()).running, true); assert.equal((await h.status()).wsConnected, true);
  gate.resolve(); await rejection;
  assert.equal((await h.status()).running, true);
  await assert.rejects(h.bridge.startBridge(), /already running/);
  assert.equal(h.bridge.stopBridge(), undefined);
  assert.equal((await h.status()).running, false);
});
test('Telegram stop waits for SDK cleanup and logs cleanup failure before stopped', async t => {
  const gate = deferred();
  const h = harness(t, 'telegram', { stopGate: gate, stopError: new Error('cleanup failed') });
  await h.create(); await h.bridge.startBridge();
  let settled = false; const stopping = h.bridge.stopBridge().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal((await h.status()).polling, false);
  gate.resolve(); await stopping;
  assert.deepEqual((await h.logs()).slice(-2).map(x => x.text), ['Telegram stop failed: cleanup failed', 'Telegram bridge stopped']);
});
test('Discord fetch errors and nontext channels are logged while manual HTTP remains successful', async t => {
  for (const options of [{ fetchError: new Error('fetch failed') }, { channel: {} }]) {
    const h = harness(t, 'discord', options); await h.create(); await h.bridge.startBridge();
    assert.equal((await request(h, 'POST', '/send', { target: 'discord', channelId: 'test', text: 'reply' })).statusCode, 200);
    assert.ok((await h.logs()).some(x => x.text.includes(options.fetchError ? 'channel fetch failed' : 'not textable')));
  }
});

for (const platform of ['telegram', 'discord']) {
  test(`${platform}: target changes during an awaited chunk preserve platform-specific binding`, { timeout: 3000 }, async t => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = resolve => { queueMicrotask(resolve); return {}; };
    t.after(() => { global.setTimeout = originalSetTimeout; });
    const calls = [], h = harness(t, platform);
    await h.create(); await h.bridge.startBridge();
    const key = platform === 'telegram' ? 'chatId' : 'channelId';
    await request(h, 'POST', '/send', { target: platform, [key]: 'old', text: 'attach' });
    const gate = deferred(), started = deferred();
    if (platform === 'telegram') {
      let count = 0;
      h.clients[0].sendMessage = async (id, text) => {
        calls.push([id, text]);
        if (++count === 1) { started.resolve(); await gate.promise; }
      };
    } else {
      // Replace fetch so the delivery pins this one channel even when inbound changes target.
      h.clients[0].channels.fetch = async id => ({ async send(text) {
        calls.push([id, text]);
        if (calls.length === 1) { started.resolve(); await gate.promise; }
      } });
    }
    calls.length = 0;
    const sending = h.wsOptions.onTurn('x'.repeat(platform === 'telegram' ? 3800 : 1900) + 'tail');
    await started.promise;
    await h.inbound(platform === 'telegram' ? { text: '   ', chat: { id: 'new' } } : { content: '   ', channel: { id: 'new' }, author: { id: 'human' } });
    gate.resolve(); await sending;
    assert.deepEqual(calls.map(x => x[0]), platform === 'telegram' ? ['old', 'new'] : ['old', 'old']);
  });
}
test('Telegram stop during pending start preserves the established late-start completion behaviour', async t => {
  const gate = deferred(), h = harness(t, 'telegram', { startGate: gate });
  await h.create(); const starting = h.bridge.startBridge();
  await h.bridge.stopBridge();
  assert.equal((await h.status()).polling, false);
  gate.resolve(); await starting;
  const status = await h.status();
  assert.equal(status.running, true); assert.equal(status.polling, false);
  assert.ok(h.calls.includes('ws.connect'));
});

for (const platform of ['telegram', 'discord']) {
  for (const fails of [false, true]) {
    const outcome = fails ? 'failure' : 'success';
    test(`${platform}: /reset command waits for owner clear ${outcome} before any success feedback`, { timeout: 3000 }, async t => {
      const clear = deferred(), entered = deferred();
      const h = harness(t, platform, { clearBridgeHistory(id) { entered.resolve(id); return clear.promise; } });
      t.after(() => clear.resolve());
      await h.create(); await h.bridge.startBridge();
      assert.equal(h.lifecycleOptions.clearBridgeHistory, h.clearBridgeHistory);
      const incoming = platform === 'telegram'
        ? { text: '/reset', chat: { id: 42 } }
        : { content: '/reset', channel: { id: 'human-channel' }, author: { id: 'human' } };
      const handled = h.inbound(incoming);
      assert.equal(await entered.promise, `__${platform}_gateway__`);
      const success = () => h.calls.filter(x => Array.isArray(x) && x[0] === `${platform}.send` && x[2] === '✅ 已清空对话历史');
      assert.equal(success().length, 0);
      assert.equal(h.gateways.get(`__${platform}_gateway__`).cliSessionId, null);
      assert.equal(h.calls.filter(x => x === 'gateway.save').length, 1);
      if (fails) clear.reject(new Error('synthetic owner write failure'));
      else clear.resolve();
      await handled;
      await new Promise(resolve => setImmediate(resolve));
      if (fails) {
        assert.equal(success().length, 0);
        assert.equal(h.gateways.get(`__${platform}_gateway__`).cliSessionId, null);
        assert.equal(h.calls.filter(x => x === 'gateway.save').length, 1);
        assert.ok((await h.logs()).some(x => x.type === 'error' && x.text.includes('synthetic owner write failure')));
        assert.equal((await h.logs()).some(x => x.text.endsWith('gateway history cleared')), false);
      } else {
        assert.equal(success().length, 1);
        assert.ok(h.gateways.get(`__${platform}_gateway__`).cliSessionId);
      }
    });
    test(`${platform}: POST /gateway/reset awaits owner clear and maps ${outcome}`, { timeout: 3000 }, async t => {
      const clear = deferred(), entered = deferred();
      const h = harness(t, platform, { clearBridgeHistory(id) { entered.resolve(id); return clear.promise; } });
      t.after(() => clear.resolve());
      await h.create();
      const res = response();
      const resetting = handler(h.bridge, 'POST', '/gateway/reset')({ body: {}, query: {} }, res);
      assert.equal(await entered.promise, `__${platform}_gateway__`);
      assert.equal(res.body, undefined);
      assert.equal(h.gateways.get(`__${platform}_gateway__`).cliSessionId, null);
      if (fails) clear.reject(new Error('synthetic owner write failure'));
      else clear.resolve();
      await resetting;
      if (fails) {
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'synthetic owner write failure' });
        assert.equal(h.gateways.get(`__${platform}_gateway__`).cliSessionId, null);
        assert.equal(h.calls.filter(x => x === 'gateway.save').length, 1);
      } else {
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: true });
        assert.ok(h.gateways.get(`__${platform}_gateway__`).cliSessionId);
      }
    });
  }
}

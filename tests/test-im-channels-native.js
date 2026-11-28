'use strict';

// Frozen 783f25a0 inputs remain executable only in this synthetic harness.
// Neither side loads shared production gateway state, user config or a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { getNative } = require('../src/native/binding');

const frozen = {
  wechat: ['wechat-ilink', 'cd966d16967dbb240ad91062a3c1a1c15925721d3a818729194ff9380490115a'],
  feishu: ['feishu-bridge', 'f1f4ec97815e3208d08e9f47d69c9138b181e303bf37aac91a025ff468e97a07'],
};
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(platform, legacy = false, initial = {}) {
  const events = [], sent = [], requests = [], inbound = [], polls = [], timers = new Set();
  let config = { ...(platform === 'wechat' ? { botToken: 'synthetic-token', baseUrl: '', outputIdle: 5000 } : { appId: 'synthetic-id', appSecret: 'synthetic-secret', domain: 'feishu' }), ...initial };
  let gateway = { id: platform === 'wechat' ? '__gateway__' : '__feishu_gateway__', cli: 'claude', cliSessionId: null };
  let dispatch, turn, saveError, sendError, sdkError, chunks;
  const records = new Map(), chats = new Map();
  const agent = {}, http = {}, sdkOptions = [];
  const logs = { entries: [], push(type, text) { this.entries.push({ type, text }); }, filterSince() { return this.entries.slice(); }, addClient(res) { this.client = res; }, removeClient(res) { assert.equal(this.client, res); this.client = null; } };
  const echo = { values: [], add(text) { this.values.push(text); }, isEcho(text) { return this.values.includes(text); } };
  const ws = { connect() { events.push('connect'); }, disconnect() { events.push('disconnect'); }, reconnectIfRunning() { events.push('reconnect'); }, isOpen: () => true,
    ensureOpen: async ms => { events.push(['ensure', ms]); }, sendUserMessage(text) { inbound.push(text); return true; } };
  const core = {
    deps: { fs: { readFileSync: () => JSON.stringify(config) } },
    createLogStore: () => logs, createEchoStore: () => echo,
    createGatewayLifecycle: () => ({ get: () => gateway, create(cli) { gateway = { id: 'created', cli }; return gateway; }, switchCli(cli) { gateway.cli = cli; return gateway; }, destroy() { gateway = null; }, resetHistory() { events.push('reset'); } }),
    createChatWsClient(options) { turn = options.onTurn; return ws; },
    chunkOutbound(text, options) { events.push(['chunks', options.max]); return chunks || [text]; },
  };
  const bridgeConfig = { bridgeConfigFile: name => '/synthetic/' + name, bridgeHistoryFile: id => '/synthetic/' + id + '.json',
    saveBridgeConfig(file, value) { events.push('save'); if (saveError) throw saveError; config = structuredClone(value); } };
  const Lark = {
    AppType: { SelfBuild: 1 }, Domain: { Feishu: 'https://feishu.invalid', Lark: 'https://lark.invalid' }, LoggerLevel: { info: 2 }, defaultHttpInstance: {},
    Client: class { constructor(options) { sdkOptions.push(options); this.im = { message: { create: async value => { if (sendError) throw sendError; sent.push(value); } } }; } },
    EventDispatcher: class { register(handlers) { dispatch = handlers['im.message.receive_v1']; return this; } },
    WSClient: class { constructor(options) { sdkOptions.push(options); } start() { if (sdkError) throw sdkError; events.push('sdk-start'); } close() { events.push('sdk-close'); } },
  };
  const response = value => ({ ok: true, json: async () => value });
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('get_bot_qrcode')) return response({ qrcode: 'synthetic-qr', qrcode_img_content: 'synthetic-image' });
    if (url.includes('get_qrcode_status')) return response({ status: 'confirmed', bot_token: 'synthetic-login', baseurl: 'https://ilink.invalid' });
    if (url.endsWith('/getupdates')) return new Promise((resolve, reject) => {
      polls.push(value => resolve(response(value)));
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })), { once: true });
    });
    if (url.endsWith('/sendmessage')) {
      if (sendError) return { ok: false, status: 502, text: async () => sendError.message };
      sent.push(JSON.parse(options.body));
    }
    return response({});
  };
  const ports = {
    express: require('express'), path, os: { homedir: () => '/synthetic-home' }, crypto,
    fs: core.deps.fs, legacyDir: '/synthetic-legacy', bridgeConfig, bridgeGateway: core,
    fetch, AbortController, AbortSignal, now: () => 120000,
    sleep: async ms => { events.push(['sleep', ms]); },
    setInterval(callback, ms) { const timer = { callback, ms }; timers.add(timer); return timer; }, clearInterval(timer) { timers.delete(timer); },
    loadLark: () => Lark, createLarkHttpInstance: () => http, outboundAgent: agent,
  };
  let bridge;
  if (legacy) {
    const [name, sha] = frozen[platform];
    const filename = path.join(__dirname, 'fixtures/batch17-channels', name + '.legacy.cjs');
    const source = fs.readFileSync(filename, 'utf8');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), sha, 'historical input is byte-frozen');
    const instance = new Module(filename, module), normal = Module.createRequire(filename);
    const mocks = { os: ports.os, './secure-config': bridgeConfig, './gateway-core': core,
      '../../src/native/binding': { outbound: { outboundAgent: agent } }, '../../src/network/sdk-bridges': { createLarkHttpInstance: () => http }, '@larksuiteoapi/node-sdk': Lark };
    instance.filename = filename; instance.paths = Module._nodeModulePaths(path.dirname(filename));
    instance.require = id => Object.hasOwn(mocks, id) ? mocks[id] : normal(id);
    instance._compile(source, filename); bridge = instance.exports;
  } else bridge = platform === 'wechat' ? getNative().wechatBridgeApi(ports) : getNative().feishuBridgeApi(ports);
  bridge.init({ persistedSessions: records, chatSessions: chats, savePersistedSessions() {}, chatBroadcast() {}, port: 4500 });
  function route(method, url) {
    const found = bridge.router.stack.find(x => x.route?.path === url && x.route.methods[method.toLowerCase()]);
    assert.ok(found, `${method} ${url}`); return found.route.stack.at(-1).handle;
  }
  async function request(method, url, body = {}, query = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await route(method, url)({ body, query }, res); return { status: res.statusCode, body: res.body };
  }
  return { bridge, events, sent, requests, inbound, polls, timers, logs, echo, records, chats, sdkOptions, agent, http, ports, request, route, fetch,
    onTurn: text => turn(text), onMessage: data => dispatch(data),
    chunks(value) { chunks = value; }, failSave(error) { saveError = error; }, failSend(error) { sendError = error; }, failSdk(error) { sdkError = error; },
    noGateway() { gateway = null; } };
}

function cleanup(t, h) { t.after(async () => { h.bridge.stopBridge(); await flush(); }); }

test('Feishu native adapter matches frozen route/config/inbound/chunk semantics', async t => {
  const results = [];
  for (const legacy of [true, false]) {
    const h = harness('feishu', legacy); cleanup(t, h);
    const keys = Object.keys(h.bridge);
    const before = await h.request('GET', '/config');
    await h.request('POST', '/config', { appId: ' new-id ', domain: 'lark' });
    await h.bridge.startBridge();
    await h.onMessage({ message: { chat_id: 'chat-one', message_type: 'text', content: JSON.stringify({ text: '@_user_21  你好😀' }) } });
    await h.onMessage({ message: { chat_id: 'chat-two', message_type: 'post', content: JSON.stringify({ en_us: { title: 'ignored', content: [[{ text: '段落' }, { text: 'A' }], [{ text: 'B' }]] } }) } });
    h.chunks(['chunk-one', '(续2) chunk-two']); await h.onTurn('reply');
    const status = await h.request('GET', '/status'); delete status.body.startTime;
    results.push({ keys, before, status, sent: h.sent, inbound: h.inbound,
      events: h.events.filter(event => !Array.isArray(event) || event[0] !== 'sleep'), echo: h.echo.values });
    if (!legacy) assert.ok(h.events.some(event => Array.isArray(event) && event[0] === 'sleep' && event[1] === 400));
    assert.equal(h.sdkOptions[0].domain, 'https://lark.invalid');
    assert.equal(h.sdkOptions[0].httpInstance, h.sdkOptions[1].httpInstance);
    assert.equal(h.sdkOptions[1].agent, h.agent);
    assert.deepEqual(h.inbound, ['你好😀', '段落A\nB']);
  }
  assert.deepEqual(results[1], results[0]);
});

test('Feishu keeps latest-chat-before-echo, partial send failure, and failed-start state', async t => {
  for (const legacy of [true, false]) {
    const h = harness('feishu', legacy); cleanup(t, h); await h.bridge.startBridge();
    h.echo.add('skip'); await h.onMessage({ message: { chat_id: 'echo-chat', message_type: 'text', content: '{"text":"skip"}' } });
    assert.equal((await h.request('GET', '/status')).body.currentChat.chatId, 'echo-chat');
    h.failSend(new Error('synthetic send failure'));
    const sent = await h.request('POST', '/send', { target: 'feishu', text: 'attempt' });
    assert.equal(sent.status, 500); assert.equal(sent.body.error, 'synthetic send failure');
    assert.ok(h.echo.values.includes('attempt'));
    h.bridge.stopBridge(); h.failSdk(new Error('synthetic start failure'));
    await assert.rejects(h.bridge.startBridge(), /synthetic start failure/);
    const status = (await h.request('GET', '/status')).body;
    assert.equal(status.running, true); assert.equal(status.wsConnected, true);
  }
});

test('config write failure preserves memory and caller error identity; loadConfig remains disk-based', async t => {
  for (const platform of ['wechat', 'feishu']) for (const legacy of [true, false]) {
    const h = harness(platform, legacy); cleanup(t, h);
    const original = new Error('synthetic disk full'); h.failSave(original);
    const body = platform === 'wechat' ? { outputIdle: -7 } : { appId: 'memory-only' };
    assert.throws(() => h.route('POST', '/config')({ body }, {}), error => error === original);
    const config = (await h.request('GET', '/config')).body;
    assert.equal(platform === 'wechat' ? config.outputIdle : config.appId, platform === 'wechat' ? -7 : 'memory-only');
    const disk = h.bridge.loadConfig(); assert.notEqual(disk, h.bridge.loadConfig());
    assert.equal(platform === 'wechat' ? disk.outputIdle : disk.appId, platform === 'wechat' ? 5000 : 'synthetic-id');
  }
});

test('WeChat native iLink QR/login/poll/send protocol is compatible without a live network', async t => {
  const h = harness('wechat'); cleanup(t, h);
  assert.deepEqual(await h.request('GET', '/login-status'), { status: 200, body: { status: 'no_qrcode' } });
  assert.deepEqual((await h.request('GET', '/qrcode')).body, { qrcode: 'synthetic-qr', image: 'synthetic-image' });
  assert.deepEqual((await h.request('GET', '/login-status')).body, { status: 'confirmed' });
  await h.bridge.startBridge(); await flush();
  h.polls.shift()({ get_updates_buf: 'cursor-one', msgs: [{ from_user_id: 'user-one', context_token: 'context-one', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] });
  await flush(); assert.deepEqual(h.inbound, ['hello']);
  assert.equal(JSON.parse(h.requests.filter(x => x.url.endsWith('/getupdates')).at(-1).options.body).get_updates_buf, 'cursor-one');
  const update = h.requests.find(x => x.url.endsWith('/getupdates'));
  assert.equal(update.options.headers.Authorization, 'Bearer synthetic-login');
  assert.match(Buffer.from(update.options.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.deepEqual(JSON.parse(update.options.body).base_info, { channel_version: '1.0.2' });
  h.chunks(['one', '(续2) two']); await h.onTurn('answer');
  assert.deepEqual(h.sent.map(x => x.msg.to_user_id), ['user-one', 'user-one']);
  assert.equal(h.sent[0].msg.context_token, 'context-one'); assert.equal(h.sent[0].msg.message_type, 2); assert.equal(h.sent[0].msg.message_state, 2);
  assert.match(h.sent[0].msg.client_id, /^multicc_120000_/);
  assert.deepEqual(h.sent[0].msg.item_list, [{ type: 1, text_item: { text: 'one' } }]);
  const manual = await h.request('POST', '/send', { target: 'wechat', text: 'manual' });
  assert.equal(manual.status, 200); assert.equal(h.sent.at(-1).msg.item_list[0].text_item.text, 'manual');
  h.bridge.stopBridge();
  assert.equal((await h.request('POST', '/send', { target: 'wechat', text: 'stopped' })).status, 500);
  await h.request('POST', '/logout'); assert.equal((await h.request('GET', '/status')).body.loggedIn, false);
});

test('WeChat frozen comparison covers session snapshots, ignored defaultSession and no-gateway responses', async t => {
  const results = [];
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  for (const legacy of [true, false]) {
    const h = harness('wechat', legacy); cleanup(t, h); if (legacy) globalThis.fetch = h.fetch;
    h.records.set('s-one', { id: 's-one', label: 'Synthetic task', kind: 'chat', cli: 'codex', cwd: '/synthetic/project' });
    await h.request('POST', '/config', { defaultSession: 'ignored', outputIdle: 0 });
    await h.bridge.startBridge(); await flush();
    h.polls.shift()({ msgs: [{ from_user_id: 'u', context_token: 'c', item_list: [{ type: 1, text_item: { text: '/sessions' } }] }] });
    await flush(); assert.equal(h.sent.at(-1).msg.item_list[0].text_item.text, '📂 Gateway 可见 chat session:\n  s-one / Synthetic task — idle');
    h.noGateway(); const denied = await h.request('POST', '/send', { text: 'gateway input' });
    results.push({ config: (await h.request('GET', '/config')).body, denied, replies: h.sent.map(x => x.msg.item_list) });
    h.bridge.stopBridge(); await flush(); globalThis.fetch = oldFetch;
  }
  assert.deepEqual(results[1], results[0]);
});

test('native SSE registers heartbeat and removes the same client on close', async t => {
  const h = harness('feishu'); cleanup(t, h);
  const req = new EventEmitter(), frames = [], headers = {};
  const res = { setHeader(key, value) { headers[key] = value; }, flushHeaders() {}, write(value) { frames.push(value); } };
  h.route('GET', '/events')(req, res);
  assert.equal(headers['X-Accel-Buffering'], 'no'); assert.equal(h.logs.client, res);
  assert.equal(h.timers.size, 1); const timer = [...h.timers][0]; assert.equal(timer.ms, 5000); timer.callback();
  assert.deepEqual(frames, [': heartbeat\n\n']); req.emit('close'); assert.equal(h.timers.size, 0); assert.equal(h.logs.client, null);
});

test('WeChat login save failure uses HTTP 200 error status and preserves memory update', async t => {
  const h = harness('wechat'); cleanup(t, h);
  await h.request('GET', '/qrcode'); h.failSave(new Error('synthetic login write failure'));
  assert.deepEqual(await h.request('GET', '/login-status'), { status: 200, body: { status: 'error', error: 'synthetic login write failure' } });
  assert.equal((await h.request('GET', '/status')).body.loggedIn, true);
  assert.equal(h.bridge.loadConfig().botToken, 'synthetic-token');
});

test('Feishu command replies and inbound logs retain isolated UTF-16 units', async t => {
  const results = [];
  for (const legacy of [true, false]) {
    const h = harness('feishu', legacy); cleanup(t, h); await h.bridge.startBridge();
    await h.onMessage({ message: { chat_id: 'synthetic-chat', message_type: 'text', content: JSON.stringify({ text: '/unknown\ud800' }) } });
    results.push({ sent: h.sent, inboundLog: h.logs.entries.find(row => row.type === 'in') });
  }
  assert.deepEqual(results[1], results[0]);
});

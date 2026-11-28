'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const WebSocket = require('ws');

function loadIsolated(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const normalRequire = Module.createRequire(filename);
  instance.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : normalRequire(id);
  instance._compile(fs.readFileSync(filename, 'utf8'), filename);
  return instance.exports;
}

function fakeSockets() {
  const sockets = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; sockets.push(this); }
    send() {}
    close() { this.emit('close'); }
  }
  return { Socket, sockets };
}

function peer() { const ws = new EventEmitter(); ws.send = () => {}; ws.readyState = 1; return ws; }

for (const provider of ['openai', 'volcano', 'funasr']) {
  test(`${provider} 语音识别连接传递统一代理并保留认证信息`, () => {
    const { Socket, sockets } = fakeSockets();
    const agent = {};
    const voice = loadIsolated('plugins/voice/voice-asr.js', {
      ws: Socket,
      '../../src/native/binding': { outbound: { outboundAgent: agent } },
      '../../src/voice/asr-local': {},
    });
    voice.applyConfig({ OPENAI_REALTIME_API_KEY: 'test-key', VOLC_ASR_APP_ID: 'test-app', VOLC_ASR_ACCESS_TOKEN: 'test-token', FUNASR_WS_URL: 'ws://127.0.0.1:10095' });
    const ws = peer();
    voice.handleVoiceWs(ws);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider })));
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].options.agent, agent);
    if (provider === 'openai') assert.equal(sockets[0].options.headers.Authorization, 'Bearer test-key');
    if (provider === 'volcano') assert.equal(sockets[0].options.headers['X-Api-Access-Key'], 'test-token');
    ws.emit('close');
  });
}

test('火山语音合成连接传递统一代理', () => {
  const { Socket, sockets } = fakeSockets();
  const agent = {};
  const tts = loadIsolated('src/voice/tts-service.js', { ws: Socket, '../native/binding': { outbound: { outboundAgent: agent } } });
  tts.applyConfig({ VOLC_TTS_APP_ID: 'test-app', VOLC_TTS_ACCESS_TOKEN: 'test-token' });
  const ws = peer();
  tts.handleTtsWs(ws);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider: 'volcano', text: '测试' })));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].options.agent, agent);
  ws.emit('close');
});

test('飞书 HTTP 适配保留 SDK 的响应行为且关闭 axios 二次代理', async () => {
  const agent = {};
  let options;
  const base = { request: async (value) => { options = value; return { preserved: true }; } };
  const { createLarkHttpInstance } = loadIsolated('src/network/sdk-bridges.js', { '../native/binding': { outbound: { outboundAgent: agent } } });
  const client = createLarkHttpInstance(base);
  assert.deepEqual(await client.post('https://example.invalid/auth', { test: true }, { $return_headers: true }), { preserved: true });
  assert.equal(options.httpAgent, agent);
  assert.equal(options.httpsAgent, agent);
  assert.equal(options.proxy, false);
  assert.equal(options.$return_headers, true);
  assert.equal(options.method, 'post');
  assert.equal(base.httpAgent, undefined);
});

function loadBridge(name, sdk, agent) {
  const noop = () => {};
  const captured = [];
  const gateway = { get: () => ({ id: 'test' }) };
  const core = {
    deps: { fs: { readFileSync: () => JSON.stringify({ botToken: 'test-bot', appToken: 'test-app', appId: 'test-id', appSecret: 'test-secret' }) } },
    createLogStore: () => ({ push: noop }), createEchoStore: () => ({}),
    createGatewayLifecycle: () => gateway,
    createChatWsClient: () => ({ connect: noop, disconnect: noop }),
  };
  let exports;
  if (name === 'discord') {
    exports = require('../src/native/binding').getNative().chatPlatformBridgeApi({
      express: require('express'), path, os: require('node:os'), fs: core.deps.fs,
      bridgeDir: path.resolve(__dirname, '../plugins/bridges'), bridgeGateway: core,
      bridgeConfig: { bridgeConfigFile: () => '', bridgeHistoryFile: noop, saveBridgeConfig: noop },
      loadDiscord: () => sdk(captured)['discord.js'], outboundFetch: noop, buildDiscordStrategy: noop,
    }, 'discord');
  } else if (name === 'feishu') {
    exports = require('../src/native/binding').imChannelHost.createFeishuBridge({
      fs: core.deps.fs,
      bridgeConfig: { bridgeConfigFile: () => '', bridgeHistoryFile: noop, saveBridgeConfig: noop },
      bridgeGateway: core,
      loadLark: () => sdk(captured)['@larksuiteoapi/node-sdk'],
      createLarkHttpInstance: () => ({}), outboundAgent: agent,
    });
  } else {
    exports = loadIsolated(`plugins/bridges/${name}-bridge.js`, {
      '../../src/native/binding': {
        outbound: { outboundAgent: agent, outboundFetch: noop },
        bridgeGateway: core,
        bridgeConfig: { bridgeConfigFile: () => '', bridgeHistoryFile: noop, saveBridgeConfig: noop },
      },
      '../../src/network/sdk-bridges': { createLarkHttpInstance: () => ({}), buildDiscordStrategy: noop },
      ...sdk(captured),
    });
  }
  exports.init({ persistedSessions: new Map(), chatSessions: new Map() });
  return { exports, captured };
}

test('Slack 的 REST 与 Socket Mode 两条路径均收到代理', async () => {
  const agent = {};
  const bridge = loadBridge('slack', (captured) => ({ '@slack/bolt': { App: class {
    constructor(options) { captured.push(options); this.client = { auth: { test: async () => ({}) } }; }
    event() {} async start() {} async stop() {}
  } } }), agent);
  await bridge.exports.startBridge();
  bridge.exports.stopBridge();
  const options = bridge.captured[0];
  assert.equal(options.agent, agent);
  assert.equal(options.installerOptions.clientOptions.agent, agent);
  // Verify the installed Bolt actually forwards that second path to SocketModeClient.
  const { App } = require('@slack/bolt');
  const app = new App({ ...options, deferInitialization: true, tokenVerificationEnabled: false });
  assert.equal(app.receiver.client.webClientOptions.agent, agent);
  await app.stop();
});

test('飞书事件发现请求和 WebSocket 握手共享配置', async () => {
  const agent = {};
  const bridge = loadBridge('feishu', (captured) => ({ '@larksuiteoapi/node-sdk': {
    AppType: { SelfBuild: 0 }, Domain: { Feishu: 'https://open.feishu.cn' }, LoggerLevel: { info: 2 },
    Client: class { constructor(options) { captured.push(options); } },
    WSClient: class { constructor(options) { captured.push(options); } start() {} close() {} },
    EventDispatcher: class { register() { return this; } },
  } }), agent);
  await bridge.exports.startBridge();
  bridge.exports.stopBridge();
  assert.equal(bridge.captured[1].agent, agent);
  assert.equal(bridge.captured[0].httpInstance, bridge.captured[1].httpInstance);
});

test('Discord 桥接同时接入统一 REST 和私有 WebSocket 策略', async () => {
  const agent = {};
  const bridge = loadBridge('discord', (captured) => ({ 'discord.js': {
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Client: class extends EventEmitter {
      constructor(options) { super(); captured.push(options); }
      async login() {} destroy() {}
    },
  } }), agent);
  await bridge.exports.startBridge();
  bridge.exports.stopBridge();
  assert.equal(typeof bridge.captured[0].rest.makeRequest, 'function');
  assert.equal(typeof bridge.captured[0].ws.buildStrategy, 'function');
});

test('Discord SDK 的真实握手使用注入代理，销毁连接且不污染全局模块', { timeout: 5000 }, async (t) => {
  let requests = 0;
  const agent = new http.Agent();
  const addRequest = agent.addRequest;
  agent.addRequest = function (...args) { requests++; return addRequest.apply(this, args); };
  const shared = require('@discordjs/ws');
  const sharedConstructor = WebSocket.WebSocket;
  const { buildDiscordStrategy } = loadIsolated('src/network/sdk-bridges.js', { '../native/binding': { outbound: { outboundAgent: agent } } });
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${server.address().port}`;
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'test', resume_gateway_url: url } }));
      if (message.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  const manager = new EventEmitter();
  manager.options = { ...shared.DefaultWebSocketManagerOptions, token: 'test', intents: 0, compression: null,
    retrieveSessionInfo: async () => null, updateSessionInfo: async () => {},
    buildIdentifyThrottler: async () => ({ waitForIdentify: async () => {} }),
  };
  manager.fetchGatewayInformation = async () => ({ url });
  manager.getShardCount = async () => 1;
  const strategy = buildDiscordStrategy(manager);
  t.after(async () => {
    await strategy.destroy();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    agent.destroy();
  });
  await strategy.spawn([0]);
  await strategy.connect();
  assert.equal(requests, 1);
  assert.equal((await strategy.fetchStatus()).get(0), 3);
  assert.equal(require('@discordjs/ws'), shared);
  assert.equal(require('ws').WebSocket, sharedConstructor);
  await strategy.destroy();
  assert.equal(strategy.shards.size, 0);
});

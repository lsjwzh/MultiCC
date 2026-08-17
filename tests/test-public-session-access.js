'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createErrorDto, requestContext } = require('../src/api-contract');
const {
  isInternalExecutionSlot,
  mountPublicSessionAccessGuard,
} = require('../src/session/public-session-access');
const { mountWsConnectionRouter } = require('../src/ws/connection-router');

function requestJson(server, pathname) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: address.port,
      path: pathname,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ status: response.statusCode, json });
      });
    });
    request.on('error', reject);
  });
}

test('public REST session guard hides internal execution slots on base and nested paths', async t => {
  const records = new Map([
    ['public-chat', { id: 'public-chat', kind: 'chat' }],
    ['slot-secret', { id: 'slot-secret', kind: 'chat', taskExecutionSlot: true }],
  ]);
  const app = express();
  mountPublicSessionAccessGuard(app, {
    records,
    v1NotFound: (req, res) => res.status(404).json(createErrorDto({
      ...requestContext(req, res),
      message: 'session not found',
      code: 'session_not_found',
    })),
  });
  app.get('/api/sessions/:id', (req, res) => res.json({ reached: req.params.id }));
  app.get('/api/sessions/:id/restart', (req, res) => res.json({ reached: req.params.id }));
  app.get('/api/v1/sessions/:id/waits', (req, res) => res.json({ reached: req.params.id }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  assert.deepEqual(await requestJson(server, '/api/sessions/public-chat'), {
    status: 200,
    json: { reached: 'public-chat' },
  });
  assert.deepEqual(await requestJson(server, '/api/sessions/missing/restart'), {
    status: 200,
    json: { reached: 'missing' },
  });
  assert.deepEqual(await requestJson(server, '/api/sessions/slot-secret'), {
    status: 404,
    json: { error: 'session not found' },
  });
  assert.deepEqual(await requestJson(server, '/api/sessions/slot-secret/restart'), {
    status: 404,
    json: { error: 'session not found' },
  });
  assert.deepEqual(await requestJson(server, '/api/v1/sessions/slot-secret/waits'), {
    status: 404,
    json: {
      ok: false,
      error: 'session not found',
      code: 'session_not_found',
      apiVersion: 'v1',
      requestId: 'unknown',
      correlationId: 'unknown',
    },
  });
});

test('internal execution slot discriminator is narrow and reusable by WS admission', () => {
  assert.equal(isInternalExecutionSlot(null), false);
  assert.equal(isInternalExecutionSlot({ taskExecutionSlot: false }), false);
  assert.equal(isInternalExecutionSlot({ taskExecutionSlot: true }), true);

  const turnEngine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'chat', 'turn-engine.js'), 'utf8');
  assert.match(turnEngine, /isInternalExecutionSlot\(persisted\)/,
    'WS chat admission must use the same internal-slot discriminator');
});

function wsRouterHarness(url) {
  const records = new Map([
    ['public-chat', { id: 'public-chat', kind: 'chat' }],
    ['slot-secret', { id: 'slot-secret', kind: 'chat', taskExecutionSlot: true }],
  ]);
  const wss = new EventEmitter();
  wss.clients = new Set();
  const ws = new EventEmitter();
  ws.bufferedAmount = 0;
  ws.send = (_data, _options, callback) => callback?.();
  const closes = [];
  ws.close = (...args) => { closes.push(args); };
  ws.terminate = () => {};
  const sent = [];
  let chatAdmissions = 0;
  let terminalSpawns = 0;

  mountWsConnectionRouter(wss, {
    metrics: { inc() {}, set() {} },
    logger: { warn() {} },
    share: { access: () => null },
    parseCookies: () => ({}),
    isLocalRequest: () => true,
    authSecurity: { consumeWsTicket: () => null, verifyCookie: () => false, verifyAccessToken: () => false },
    voiceAsr: { handleVoiceWs() { throw new Error('voice route reached'); } },
    ttsService: { handleTtsWs() { throw new Error('tts route reached'); } },
    workspaceRuntime: {
      attachWorkspace() { throw new Error('workspace route reached'); },
      attachMeta() { throw new Error('meta route reached'); },
    },
    auxQueue: { attachClient() { throw new Error('aux route reached'); } },
    auxSessionId: '__aux__',
    loadChatHistory: () => [],
    sessions: new Map(),
    persistedSessions: records,
    createSession: async () => { terminalSpawns += 1; return null; },
    sendWs: (_socket, payload) => { sent.push(payload); },
    resolveCwd: () => '/',
    tmuxWriteInput() {},
    tmuxResize() {},
    applyMaxClientSize() {},
    pushOnInput() {},
    handleChatWs: () => { chatAdmissions += 1; },
    getShuttingDown: () => false,
    getAccessToken: () => '',
    allowLegacyWsCookie: false,
    allowLegacyWsToken: false,
    fs,
    path,
    os: require('node:os'),
  });
  wss.emit('connection', ws, {
    url,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  wss.emit('close');
  return { sent, closes, chatAdmissions, terminalSpawns };
}

test('central WS router rejects internal slots before chat or terminal admission', () => {
  const chat = wsRouterHarness('/ws/chat?session=slot-secret');
  assert.equal(chat.chatAdmissions, 0);
  assert.equal(chat.terminalSpawns, 0);
  assert.equal(chat.closes.length, 1);
  assert.equal(chat.sent[0]?.type, 'error');
  assert.doesNotMatch(JSON.stringify(chat.sent), /slot-secret|taskExecutionSlot/);

  const terminal = wsRouterHarness('/?id=slot-secret');
  assert.equal(terminal.chatAdmissions, 0);
  assert.equal(terminal.terminalSpawns, 0);
  assert.equal(terminal.closes.length, 1);
  assert.equal(terminal.sent[0]?.type, 'error');
  assert.doesNotMatch(JSON.stringify(terminal.sent), /slot-secret|taskExecutionSlot/);

  const normal = wsRouterHarness('/ws/chat?session=public-chat');
  assert.equal(normal.chatAdmissions, 1);
  assert.equal(normal.closes.length, 0);
});

test('server mounts the public-session guard before any session route surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const guardIndex = source.indexOf('mountPublicSessionAccessGuard(app, { records: persistedSessions');
  assert.notEqual(guardIndex, -1, 'central public-session guard must be mounted');

  const firstSessionSurface = [
    "sessionAdmin.mountRoutes(app)",
    "mountSessionCreateRoutes({",
    "cliSwitchRuntime.mountRoutes(app",
    "sessionGitRuntime.mountRoutes(app)",
  ].map(marker => source.indexOf(marker)).filter(index => index >= 0).sort((a, b) => a - b)[0];
  assert.ok(Number.isInteger(firstSessionSurface));
  assert.ok(guardIndex < firstSessionSurface,
    'central guard must run before lifecycle/profile/admin session routes');
});

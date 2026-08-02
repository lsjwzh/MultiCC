'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const {
  bindingState,
  createVoiceGatewayService,
  isVoiceGatewayRecord,
  resolveVoiceGateway,
  voiceGatewayId,
} = require('../src/voice-gateway');
const { createVoiceGatewayRoutes } = require('../src/routes/voice-gateway');
const {
  createVoiceAcpBridge,
  stableQueueEntryId,
  textFromPrompt,
  validateTransportSecurity,
} = require('../src/voice-acp-bridge');

function commander(id = 'commander-1', dirId = 'dir-1') {
  return {
    id,
    dirId,
    type: 'commander',
    kind: 'chat',
    label: `Commander ${id}`,
  };
}

function createServiceHarness(records = new Map([['commander-1', commander()]])) {
  const directories = new Map([['dir-1', { id: 'dir-1', path: '/tmp/project' }]]);
  const mutations = [];
  const service = createVoiceGatewayService({
    records,
    directories,
    mutate(source, operation) {
      mutations.push(source);
      return operation(records);
    },
    now: () => '2026-07-31T00:00:00.000Z',
  });
  return { directories, mutations, records, service };
}

test('voice gateway is one hidden gateway resource bound to the unique typed Commander', () => {
  const harness = createServiceHarness();
  const result = harness.service.ensure('dir-1', { enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.record.id, voiceGatewayId('dir-1'));
  assert.equal(result.record.type, 'gateway');
  assert.equal(result.record.kind, 'voice');
  assert.equal(result.record.gatewayKind, 'qwen-audio');
  assert.equal(result.record.provider, undefined, 'voice backend identity must not occupy the session provider field');
  assert.equal(result.record.commanderSessionId, 'commander-1');
  assert.equal(isVoiceGatewayRecord(result.record, 'dir-1'), true);
  assert.deepEqual(result.gateway.binding, {
    ready: true,
    code: null,
    canonicalCommanderSessionId: 'commander-1',
  });
  assert.deepEqual(harness.mutations, ['http.voice-gateway-put']);

  const repeated = harness.service.ensure('dir-1', { enabled: false });
  assert.equal(repeated.created, false);
  assert.equal(repeated.record.id, result.record.id);
  assert.equal(harness.service.list().length, 1);
  assert.equal(repeated.gateway.binding.code, 'voice_gateway_disabled');
});

test('voice gateway binding fails closed for zero, multiple, stale, or caller-selected Commanders', () => {
  let harness = createServiceHarness(new Map());
  assert.deepEqual(harness.service.ensure('dir-1'), { ok: false, code: 'commander_not_found' });

  const ambiguous = new Map([
    ['commander-a', commander('commander-a')],
    ['commander-b', commander('commander-b')],
  ]);
  harness = createServiceHarness(ambiguous);
  assert.deepEqual(harness.service.ensure('dir-1'), { ok: false, code: 'commander_ambiguous' });

  harness = createServiceHarness();
  assert.deepEqual(
    harness.service.ensure('dir-1', { commanderSessionId: 'worker-1' }),
    { ok: false, code: 'commander_binding_is_host_owned' },
  );
  const ready = harness.service.ensure('dir-1');
  ready.record.commanderSessionId = 'deleted-commander';
  assert.deepEqual(bindingState(harness.records, ready.record), {
    ready: false,
    code: 'commander_binding_stale',
    commanderSessionId: 'commander-1',
  });
});

test('duplicate voice gateway records are never guessed or silently repaired', () => {
  const records = new Map([['commander-1', commander()]]);
  for (const id of ['gateway-a', 'gateway-b']) {
    records.set(id, {
      id,
      dirId: 'dir-1',
      type: 'gateway',
      kind: 'voice',
      gatewayKind: 'qwen-audio',
      enabled: true,
      commanderSessionId: 'commander-1',
    });
  }
  assert.deepEqual(resolveVoiceGateway(records, 'dir-1'), {
    ok: false,
    code: 'voice_gateway_ambiguous',
    gatewayIds: ['gateway-a', 'gateway-b'],
  });
  const service = createServiceHarness(records).service;
  assert.deepEqual(service.list().map(gateway => gateway.binding), [
    { ready: false, code: 'voice_gateway_ambiguous', canonicalCommanderSessionId: null },
    { ready: false, code: 'voice_gateway_ambiguous', canonicalCommanderSessionId: null },
  ]);
  const result = service.ensure('dir-1');
  assert.deepEqual(result, {
    ok: false,
    code: 'voice_gateway_ambiguous',
    gatewayIds: ['gateway-a', 'gateway-b'],
  });
});

function createApp() {
  const routes = new Map();
  const add = method => (routePath, handler) => routes.set(`${method} ${routePath}`, handler);
  return { routes, get: add('GET'), put: add('PUT'), delete: add('DELETE') };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
  };
}

async function invoke(app, method, routePath, req) {
  const handler = app.routes.get(`${method} ${routePath}`);
  assert.ok(handler, `${method} ${routePath} mounted`);
  const res = response();
  await handler({ body: {}, params: {}, ...req }, res, error => { throw error; });
  return res;
}

test('voice gateway REST API exposes launch metadata without credentials', async () => {
  const records = new Map([['commander-1', commander()]]);
  const app = createApp();
  createVoiceGatewayRoutes({
    records,
    directories: new Map([['dir-1', { id: 'dir-1' }]]),
    sessionPersistence: { mutate(_source, operation) { return operation(records); } },
    acpAgentPath: '/opt/multicc/multicc-acp-agent.mjs',
    nodePath: '/usr/bin/node',
    getBaseUrl: () => 'http://127.0.0.1:3456',
  }).mountRoutes(app);

  let res = await invoke(app, 'PUT', '/api/directories/:id/voice-gateway', {
    params: { id: 'dir-1' },
    body: { enabled: true },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.gateway.commanderSessionId, 'commander-1');
  assert.deepEqual(res.body.gateway.acp, {
    protocol: 'acp-v1-stdio',
    command: '/usr/bin/node',
    args: ['/opt/multicc/multicc-acp-agent.mjs', '--directory-id', 'dir-1'],
    env: { MULTICC_BASE_URL: 'http://127.0.0.1:3456' },
    note: 'Qwen generic ACP 的第三层会话工具会被忽略；任务只由 MultiCC Commander 路由。',
  });
  assert.doesNotMatch(JSON.stringify(res.body), /access.?token|api.?key|secret/i);

  res = await invoke(app, 'GET', '/api/directories/:id/voice-gateway', {
    params: { id: 'dir-1' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');

  res = await invoke(app, 'GET', '/api/v1/directories/:id/voice-gateway', {
    params: { id: 'dir-1' },
    id: 'req-voice',
    correlationId: 'corr-voice',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.apiVersion, 'v1');
  assert.equal(res.body.gateway.acp, undefined);
  assert.equal(res.body.gateway.type, 'voice_gateway');

  res = await invoke(app, 'PUT', '/api/directories/:id/voice-gateway', {
    params: { id: 'dir-1' },
    body: { commanderSessionId: 'worker-1' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'commander_binding_is_host_owned');

  res = await invoke(app, 'DELETE', '/api/directories/:id/voice-gateway', {
    params: { id: 'dir-1' },
  });
  assert.equal(res.body.ok, true);
  assert.equal(records.has(voiceGatewayId('dir-1')), false);
});

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    });
  }

  send(value) {
    this.sent.push(JSON.parse(String(value)));
  }

  serverSend(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }
}

function okJson(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createBridgeHarness() {
  FakeWebSocket.instances = [];
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/voice-gateway')) {
      return okJson({
        ok: true,
        gateway: {
          id: '__voice_gateway__test',
          directoryId: 'dir-1',
          enabled: true,
          commanderSessionId: 'commander-1',
          binding: { ready: true, code: null },
        },
      });
    }
    if (url.includes('/queue/action')) return okJson({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  };
  const bridge = createVoiceAcpBridge({
    directoryId: 'dir-1',
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    randomUUID: (() => {
      let value = 0;
      return () => `uuid-${++value}`;
    })(),
  });
  return { bridge, requests };
}

test('ACP prompt waits for its correlated Commander turn and strips Qwen second-orchestrator instructions', async () => {
  const { bridge } = createBridgeHarness();
  const created = await bridge.createSession({ cwd: '/tmp/project', mcpServers: [{ name: 'qwen_audio_agent' }] });
  const updates = [];
  let settled = false;
  const resultPromise = bridge.prompt({
    sessionId: created.sessionId,
    prompt: [{
      type: 'text',
      text: '<qwen_audio_agent_backend_instructions>use only third-layer sessions</qwen_audio_agent_backend_instructions>\n修复登录问题',
    }],
  }, update => {
    updates.push(update);
  }).then(result => {
    settled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));

  const socket = FakeWebSocket.instances[0];
  const outgoing = socket.sent.find(message => message.type === 'user_message');
  assert.equal(outgoing.text, '修复登录问题');
  assert.doesNotMatch(outgoing.text, /third-layer|qwen_audio_agent/);

  socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: '旧任务输出' }] } });
  socket.serverSend({ type: 'result' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'an unrelated active turn must not settle the voice prompt');
  assert.equal(updates.length, 0);

  socket.serverSend({
    type: 'chat_msg_meta',
    role: 'user',
    clientMsgId: outgoing.clientMsgId,
  });
  socket.serverSend({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: '已' }] },
  });
  socket.serverSend({
    type: 'assistant',
    message: { textSnapshot: true, content: [{ type: 'text', text: '已处理' }] },
  });
  socket.serverSend({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'route_task', input: { task: '修复' } }] },
  });
  socket.serverSend({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'queued', is_error: false }] },
  });
  socket.serverSend({ type: 'result', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });

  const result = await resultPromise;
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.usage, { totalTokens: 5, inputTokens: 2, outputTokens: 3 });
  assert.deepEqual(
    updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text),
    ['已处理'],
    'TTS receives one fully buffered and sanitized response',
  );
  assert.equal(updates.find(update => update.sessionUpdate === 'tool_call').name, 'route_task');
  assert.equal(updates.find(update => update.sessionUpdate === 'tool_call_update').status, 'completed');
});

test('ACP cancellation removes its own queued entry and never cancels an unrelated active turn', async () => {
  const { bridge, requests } = createBridgeHarness();
  const created = await bridge.createSession({ cwd: '/tmp/project' });
  const prompt = bridge.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '排队任务' }],
  }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  const outgoing = socket.sent.find(message => message.type === 'user_message');

  const cancellation = await bridge.cancel({ sessionId: created.sessionId });
  assert.equal(cancellation.ok, true);
  assert.equal(socket.sent.some(message => message.type === 'cancel'), false);
  const cancelRequest = requests.find(request => request.url.includes('/queue/action'));
  const body = JSON.parse(cancelRequest.options.body);
  assert.equal(body.action, 'cancel_queued');
  assert.equal(body.entryId, stableQueueEntryId('commander-1', outgoing.clientMsgId));
  assert.equal((await prompt).stopReason, 'cancelled');
});

test('ACP cancellation after correlation cancels only the active voice turn', async () => {
  const { bridge } = createBridgeHarness();
  const created = await bridge.createSession({ cwd: '/tmp/project' });
  const prompt = bridge.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '当前语音任务' }],
  }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  const outgoing = socket.sent.find(message => message.type === 'user_message');
  socket.serverSend({ type: 'chat_msg_meta', role: 'user', clientMsgId: outgoing.clientMsgId });
  await bridge.cancel({ sessionId: created.sessionId });
  assert.equal(socket.sent.at(-1).type, 'cancel');
  socket.serverSend({ type: 'result' });
  assert.equal((await prompt).stopReason, 'cancelled');
});

test('ACP session close cancels its queued work before releasing the transport mapping', async () => {
  const { bridge, requests } = createBridgeHarness();
  const created = await bridge.createSession({ cwd: '/tmp/project' });
  const prompt = bridge.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '关闭前仍在排队' }],
  }, () => {});
  await new Promise(resolve => setImmediate(resolve));

  await bridge.closeSession({ sessionId: created.sessionId });
  const cancelRequest = requests.find(request => request.url.includes('/queue/action'));
  assert.ok(cancelRequest, 'close must remove the exact queued entry');
  assert.equal((await prompt).stopReason, 'cancelled');
  assert.equal(bridge.sessionCount(), 0);
  assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.CLOSED);
});

test('ACP transport security is loopback by default and authenticated HTTPS remotely', () => {
  assert.equal(validateTransportSecurity('http://127.0.0.1:3000', '').loopback, true);
  assert.equal(validateTransportSecurity('http://[::1]:3000', '').loopback, true);
  assert.throws(
    () => validateTransportSecurity('https://example.test', ''),
    /requires MULTICC_ACCESS_TOKEN/,
  );
  assert.throws(
    () => validateTransportSecurity('http://example.test', 'secret'),
    /requires HTTPS/,
  );
  assert.equal(validateTransportSecurity('https://example.test', 'secret').loopback, false);
  assert.equal(
    textFromPrompt([{ type: 'text', text: 'hello' }]),
    'hello',
  );
});

test('ACP bridge bounds per-process session mappings and releases capacity on close', async () => {
  FakeWebSocket.instances = [];
  const bridge = createVoiceAcpBridge({
    directoryId: 'dir-1',
    maxSessions: 1,
    fetchImpl: async url => {
      assert.match(url, /voice-gateway/);
      return okJson({
        gateway: {
          id: '__voice_gateway__bounded',
          directoryId: 'dir-1',
          enabled: true,
          commanderSessionId: 'commander-1',
          binding: { ready: true },
        },
      });
    },
    WebSocketImpl: FakeWebSocket,
  });
  const first = await bridge.createSession({ cwd: '/tmp' });
  await assert.rejects(
    bridge.createSession({ cwd: '/tmp' }),
    error => error.code === 'session_limit_reached',
  );
  await bridge.closeSession({ sessionId: first.sessionId });
  assert.ok((await bridge.createSession({ cwd: '/tmp' })).sessionId);
  await bridge.stop();
});

test('stdio ACP agent speaks the official v1 initialize contract', async () => {
  const { PROTOCOL_VERSION } = await import('@agentclientprotocol/sdk');
  const script = path.join(__dirname, '..', 'src', 'voice', 'multicc-acp-agent.mjs');
  const child = childProcess.spawn(process.execPath, [script, '--directory-id', 'dir-1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MULTICC_BASE_URL: 'http://127.0.0.1:3000' },
  });
  const responsePromise = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`ACP initialize timeout: ${stderr}`)), 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code && !stdout.includes('\n')) reject(new Error(`ACP agent exited ${code}: ${stderr}`));
    });
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  })}\n`);
  const response = await responsePromise;
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(response.result.agentCapabilities.sessionCapabilities, {
    resume: {},
    close: {},
  });
  assert.equal(response.result._meta.multicc.taskAuthority, 'multicc-task-board');
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
});

test('official ACP client completes a real stdio prompt through the Commander transport', async () => {
  const acp = await import('@agentclientprotocol/sdk');
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/directories/dir-1/voice-gateway') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        gateway: {
          id: '__voice_gateway__integration',
          directoryId: 'dir-1',
          enabled: true,
          commanderSessionId: 'commander-1',
          binding: { ready: true, code: null },
        },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws/chat' || url.searchParams.get('session') !== 'commander-1') {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, ws => websocketServer.emit('connection', ws));
  });
  websocketServer.on('connection', ws => {
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'user_message') return;
      ws.send(JSON.stringify({
        type: 'chat_msg_meta',
        role: 'user',
        clientMsgId: message.clientMsgId,
      }));
      ws.send(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `Commander:${message.text}` }] },
      }));
      ws.send(JSON.stringify({ type: 'result' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const script = path.join(__dirname, '..', 'src', 'voice', 'multicc-acp-agent.mjs');
  const child = childProcess.spawn(process.execPath, [script, '--directory-id', 'dir-1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MULTICC_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const observed = await acp.client({ name: 'multicc-voice-integration-test' })
      .connectWith(stream, async context => {
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        });
        assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
        return context.buildSession('/tmp').withSession(async session => {
          const promptResponse = session.prompt('语音任务');
          const text = await session.readText();
          return { text, response: await promptResponse };
        });
      });
    assert.equal(observed.text, 'Commander:语音任务');
    assert.equal(observed.response.stopReason, 'end_turn');
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    await new Promise(resolve => server.close(resolve));
  }
});

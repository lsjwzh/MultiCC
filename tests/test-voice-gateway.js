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
} = require('../src/voice/gateway');
const { createVoiceGatewayHost, HOST_PATH } = require('../src/routes/voice-gateway-host');
const { createVoiceRuntimeHost, HOST_PATH: VOICE_RUNTIME_HOST_PATH } = require('../src/routes/voice-runtime-host');
const {
  createVoiceAcpBridge,
  stableQueueEntryId,
  textFromPrompt,
  validateTransportSecurity,
} = require('../src/voice/acp-bridge');

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

// ── 宿主端口（voice-gateway-host.js）──────────────────────────────────────
// HTTP 方法、路径、状态码、错误码映射与 v1 元数据由 Rust 前门独占；这里只验
// /api/__host/voice-gateway 的 op 契约：回环闸门、四个 op 的每个分支，以及
// 「op 同步完成、options 缺键保持 undefined」这两条与旧单线程路由等价的前提。

function createHostApp() {
  const routes = new Map();
  return {
    routes,
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
  };
}

function hostResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function localRequest(body) {
  return {
    body,
    ip: '127.0.0.1',
    headers: { host: '127.0.0.1:3456' },
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

function remoteRequest(body) {
  return {
    body,
    ip: '192.168.1.20',
    headers: { host: '192.168.1.20:3456' },
    socket: { remoteAddress: '192.168.1.20' },
    connection: { remoteAddress: '192.168.1.20' },
  };
}

function mountHost(overrides = {}) {
  const records = overrides.records || new Map([['commander-1', commander()]]);
  const directories = overrides.directories || new Map([['dir-1', { id: 'dir-1' }]]);
  const mutations = [];
  const reconcileCalls = [];
  const stopCalls = [];
  const runtime = overrides.runtime || {
    reconcile(...args) { reconcileCalls.push(args); },
    stop(...args) { stopCalls.push(args); },
  };
  const app = createHostApp();
  const host = createVoiceGatewayHost({
    records,
    directories,
    sessionPersistence: overrides.sessionPersistence || {
      mutate(source, operation) {
        mutations.push(source);
        return operation(records);
      },
    },
    acpAgentPath: overrides.acpAgentPath || '/opt/multicc/multicc-acp-agent.mjs',
    nodePath: overrides.nodePath || '/usr/bin/node',
    getBaseUrl: overrides.getBaseUrl || (() => 'http://127.0.0.1:3456'),
    runtime,
  });
  host.mountRoutes(app);
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return { app, handler, host, mutations, records, reconcileCalls, stopCalls };
}

async function hostCall(harness, body, { local = true } = {}) {
  const res = hostResponse();
  await harness.handler(local ? localRequest(body) : remoteRequest(body), res);
  return res;
}

test('host port rejects anything but a loopback peer and refuses unknown operations', async () => {
  const harness = mountHost();
  for (const body of [{ op: 'list' }, { op: 'inspect', id: 'dir-1' },
    { op: 'ensure', id: 'dir-1' }, { op: 'remove', id: 'dir-1' }, {}]) {
    const res = await hostCall(harness, body, { local: false });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not found' });
  }
  // 非回环请求不产生任何副作用。
  assert.deepEqual(harness.mutations, []);
  assert.deepEqual(harness.reconcileCalls, []);
  assert.deepEqual(harness.stopCalls, []);

  for (const body of [{ op: 'nope' }, {}, null, []]) {
    const res = await hostCall(harness, body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'unknown host operation' });
  }
});

test('host factory exposes the shared service and requires its persistence port', () => {
  const harness = mountHost();
  assert.equal(harness.host.provider, 'qwen-audio-agent');
  assert.equal(typeof harness.host.service.ensureGlobal, 'function');
  assert.equal(Object.isFrozen(harness.host), true);
  assert.throws(
    () => createVoiceGatewayHost({ records: new Map(), directories: new Map() }),
    /sessionPersistence\.mutate/,
  );
  assert.throws(
    () => createVoiceGatewayHost({ records: new Map(), directories: new Map(), sessionPersistence: { mutate() {} } })
      .mountRoutes({ get() {} }),
    /Express-compatible app/,
  );
});

test('host list op returns gateway projections plus launch facts', async () => {
  const harness = mountHost({ getBaseUrl: () => 'http://127.0.0.1:3456/api?ignored=1#x' });
  let res = await hostCall(harness, { op: 'list' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    gateways: [],
    launch: {
      command: '/usr/bin/node',
      script: '/opt/multicc/multicc-acp-agent.mjs',
      baseUrl: 'http://127.0.0.1:3456',
    },
  });

  await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  res = await hostCall(harness, { op: 'list' });
  assert.equal(res.body.gateways.length, 1);
  assert.equal(res.body.gateways[0].directoryId, 'dir-1');
  assert.equal(res.body.gateways[0].commanderSessionId, 'commander-1');
  // 启动说明只在 op 契约里出现；记录与 dto 都不外泄凭据。
  assert.doesNotMatch(JSON.stringify(res.body.gateways), /access.?token|api.?key|secret/i);
});

test('host inspect op returns the gateway or the failure code without leaking the record', async () => {
  const harness = mountHost();
  let res = await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: false } });
  assert.equal(res.body.ok, true);

  res = await hostCall(harness, { op: 'inspect', id: 'dir-1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.gateway.id, voiceGatewayId('dir-1'));
  assert.equal(res.body.gateway.type, 'voice_gateway');
  assert.equal(res.body.gateway.enabled, false);
  assert.deepEqual(res.body.gateway.binding, {
    ready: false,
    code: 'voice_gateway_disabled',
    canonicalCommanderSessionId: 'commander-1',
  });
  assert.equal(res.body.record, undefined);
  assert.deepEqual(res.body.launch, {
    command: '/usr/bin/node',
    script: '/opt/multicc/multicc-acp-agent.mjs',
    baseUrl: 'http://127.0.0.1:3456',
  });

  res = await hostCall(harness, { op: 'inspect', id: 'missing-dir' });
  assert.deepEqual(res.body, { ok: false, code: 'directory_not_found' });
  res = await hostCall(harness, { op: 'inspect' });
  assert.deepEqual(res.body, { ok: false, code: 'directory_required' });

  const ambiguous = new Map([['commander-1', commander()]]);
  for (const id of ['gateway-b', 'gateway-a']) {
    ambiguous.set(id, {
      id, dirId: 'dir-1', type: 'gateway', kind: 'voice', gatewayKind: 'qwen-audio', enabled: true,
    });
  }
  res = await hostCall(mountHost({ records: ambiguous }), { op: 'inspect', id: 'dir-1' });
  assert.deepEqual(res.body, {
    ok: false,
    code: 'voice_gateway_ambiguous',
    gatewayIds: ['gateway-a', 'gateway-b'],
  });
});

test('host ensure op mirrors the service outcome and reconciles with the parsed autoInstall flag', async () => {
  const harness = mountHost();
  let res = await hostCall(harness, {
    op: 'ensure',
    id: 'dir-1',
    options: { enabled: true, provider: 'qwen-audio-agent', commanderSessionId: undefined },
    autoInstall: true,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.created, true);
  assert.equal(res.body.gateway.id, voiceGatewayId('dir-1'));
  assert.deepEqual(res.body.launch, {
    command: '/usr/bin/node',
    script: '/opt/multicc/multicc-acp-agent.mjs',
    baseUrl: 'http://127.0.0.1:3456',
  });
  assert.deepEqual(harness.reconcileCalls, [['dir-1', { installIfNeeded: true }]]);
  assert.deepEqual(harness.mutations, ['http.voice-gateway-put']);

  res = await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  assert.equal(res.body.created, false);
  assert.deepEqual(harness.reconcileCalls.at(-1), ['dir-1', { installIfNeeded: false }]);

  res = await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: true }, autoInstall: false });
  assert.deepEqual(harness.reconcileCalls.at(-1), ['dir-1', { installIfNeeded: false }]);
  res = await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: true }, autoInstall: 'yes' });
  assert.deepEqual(harness.reconcileCalls.at(-1), ['dir-1', { installIfNeeded: false }],
    'only a literal true may install');

  // 缺失的键保持 undefined：commanderSessionId 的缺省不算「调用方选了 Commander」。
  assert.equal(res.body.ok, true);
  // JSON null 原样透传，由 service 校验。
  const cases = [
    [{ commanderSessionId: 'worker-1' }, 'commander_binding_is_host_owned'],
    [{ enabled: null }, 'voice_gateway_enabled_invalid'],
    [{ provider: null }, 'voice_gateway_provider_invalid'],
    [{ commanderSessionId: null }, 'commander_binding_is_host_owned'],
  ];
  for (const [options, code] of cases) {
    const rejected = mountHost();
    const failed = await hostCall(rejected, { op: 'ensure', id: 'dir-1', options });
    assert.deepEqual(failed.body, { ok: false, code }, code);
    assert.deepEqual(rejected.reconcileCalls, [], 'a rejected ensure never reconciles');
  }

  res = await hostCall(mountHost(), { op: 'ensure', id: 'missing-dir', options: { enabled: true } });
  assert.deepEqual(res.body, { ok: false, code: 'directory_not_found' });
  res = await hostCall(mountHost({ records: new Map() }), { op: 'ensure', id: 'dir-1' });
  assert.deepEqual(res.body, { ok: false, code: 'commander_not_found' });
});

test('host ensure op reports thrown service errors in their transport shape', async () => {
  // 记录表里已有同 id 的非语音网关记录 -> mutable 事务抛 voice_gateway_id_conflict。
  const records = new Map([
    ['commander-1', commander()],
    [voiceGatewayId('dir-1'), { id: voiceGatewayId('dir-1'), dirId: 'other-dir', type: 'worker' }],
  ]);
  const harness = mountHost({ records });
  const res = await hostCall(harness, { op: 'ensure', id: 'dir-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    thrown: { code: 'voice_gateway_id_conflict', message: 'voice gateway id collision' },
  });
  assert.deepEqual(harness.reconcileCalls, []);
  assert.equal(records.get(voiceGatewayId('dir-1')).type, 'worker', 'a failed ensure leaves the record untouched');

  // 无 code 的意外异常也按同一形状回到前门（由前门映射 500）。
  const broken = mountHost({
    sessionPersistence: {
      mutate() { throw new Error('boom'); },
    },
  });
  const failed = await hostCall(broken, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  assert.deepEqual(failed.body, { thrown: { code: undefined, message: 'boom' } });
});

test('host remove op stops the runtime with the URL directory id, even when stop throws synchronously', async () => {
  const harness = mountHost();
  await hostCall(harness, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  const recordId = voiceGatewayId('dir-1');

  let res = await hostCall(harness, { op: 'remove', id: 'dir-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, id: recordId, directoryId: 'dir-1' });
  assert.deepEqual(harness.stopCalls, [['dir-1']],
    'stop identifies the Fleet by the URL id, not by the gateway record id');
  assert.equal(harness.records.has(recordId), false);

  res = await hostCall(harness, { op: 'remove', id: 'dir-1' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_gateway_not_found' });
  res = await hostCall(harness, { op: 'remove', id: 'missing-dir' });
  assert.deepEqual(res.body, { ok: false, code: 'directory_not_found' });

  const ambiguous = new Map([['commander-1', commander()]]);
  for (const id of ['gateway-b', 'gateway-a']) {
    ambiguous.set(id, {
      id, dirId: 'dir-1', type: 'gateway', kind: 'voice', gatewayKind: 'qwen-audio', enabled: true,
    });
  }
  const many = mountHost({ records: ambiguous });
  res = await hostCall(many, { op: 'remove', id: 'dir-1' });
  assert.deepEqual(res.body, {
    ok: false,
    code: 'voice_gateway_ambiguous',
    gatewayIds: ['gateway-a', 'gateway-b'],
  });
  assert.deepEqual(many.stopCalls, []);

  // 旧实现里 Promise.resolve(stop(...)) 的同步抛错会落到 500；宿主端口把它回成 thrown。
  const throwingStop = mountHost({ runtime: { reconcile() {}, stop() { throw new Error('stop failed'); } } });
  await hostCall(throwingStop, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  res = await hostCall(throwingStop, { op: 'remove', id: 'dir-1' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'stop failed' } });
  assert.equal(throwingStop.records.has(voiceGatewayId('dir-1')), false, 'the record removal already committed');

  // 异步拒绝被吞掉，不改变删除结果。
  const rejectingStop = mountHost({ runtime: { reconcile() {}, stop() { return Promise.reject(new Error('late')); } } });
  await hostCall(rejectingStop, { op: 'ensure', id: 'dir-1', options: { enabled: true } });
  res = await hostCall(rejectingStop, { op: 'remove', id: 'dir-1' });
  assert.deepEqual(res.body, { ok: true, id: voiceGatewayId('dir-1'), directoryId: 'dir-1' });
  await new Promise(resolve => setImmediate(resolve));

  // service.remove 内部事务抛错同样进 thrown。
  const brokenRecords = new Map([
    ['commander-1', commander()],
    [voiceGatewayId('dir-1'), {
      id: voiceGatewayId('dir-1'), dirId: 'dir-1', type: 'gateway', kind: 'voice',
      gatewayKind: 'qwen-audio', enabled: true, commanderSessionId: 'commander-1',
    }],
  ]);
  const broken = mountHost({
    records: brokenRecords,
    sessionPersistence: { mutate() { throw new Error('remove exploded'); } },
  });
  res = await hostCall(broken, { op: 'remove', id: 'dir-1' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'remove exploded' } });
  assert.equal(brokenRecords.has(voiceGatewayId('dir-1')), true);
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

// ── 宿主端口（voice-runtime-host.js）──────────────────────────────────────
// 公开的 /api/voice-gateway*、/api/voice-runtime* 与 per-Fleet runtime 路由由
// Rust 前门独占；这里只验 /api/__host/voice-runtime 的 12 个 op 契约：回环闸门、
// 每个分支的返回形状、options 缺键保持 undefined，以及 Rust 侧无法观察的副作用
// （router provisioning、reconcileAll 的 installIfNeeded、异步安装后的 reconcile）。

function runtimeHostApp() {
  const routes = new Map();
  return {
    routes,
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
  };
}

function mountRuntimeHost(overrides = {}) {
  const calls = {
    ensureGlobal: [], removeGlobal: 0, reconcileAll: [], stopGlobal: 0,
    statusGlobal: 0, startGlobal: 0, restartGlobal: 0, ensureRouter: 0,
    issue: [], resolve: [], revoke: [],
    fleetStatus: [], fleetRestart: [], statusGlobalSupervisor: 0, restartGlobalSupervisor: 0,
    startInstall: 0, waitForInstall: 0, reconcileAllSupervisor: 0,
    warn: [], info: [], error: [],
  };
  const running = { scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:32123' };
  const runtime = overrides.runtime !== undefined ? overrides.runtime : {
    statusGlobal() { calls.statusGlobal += 1; return { ...running }; },
    startGlobal() { calls.startGlobal += 1; return { ...running }; },
    restartGlobal() { calls.restartGlobal += 1; return { ...running }; },
    reconcileAll(options) { calls.reconcileAll.push(options); },
    stopGlobal() { calls.stopGlobal += 1; },
  };
  const voiceRouter = overrides.voiceRouter !== undefined ? overrides.voiceRouter : {
    ensure() { calls.ensureRouter += 1; return { ok: true }; },
  };
  const service = overrides.service || {
    inspectGlobal: () => ({
      ok: true,
      gateway: overrides.gateway || { configured: true, enabled: true },
      legacy: overrides.legacy || [],
    }),
    ensureGlobal(options) {
      calls.ensureGlobal.push(options);
      return { ok: true, created: true, gateway: { enabled: options.enabled !== false } };
    },
    removeGlobal() { calls.removeGlobal += 1; return { ok: true }; },
  };
  const launchRegistry = overrides.launchRegistry || {
    issue(options) {
      calls.issue.push(options);
      return {
        ok: true,
        launch: {
          id: 'ticket-1',
          scope: options.sourceSessionId ? 'chat' : 'global',
          sourceSessionId: options.sourceSessionId || null,
          expiresAt: '2026-01-01T00:00:00.000Z',
          display: '显示名',
        },
        context: { targetSessionId: options.sourceSessionId || '__voice_router__' },
      };
    },
    resolve(launchId) { calls.resolve.push(launchId); return { ok: true, context: { launchId } }; },
    revoke(launchId) { calls.revoke.push(launchId); },
  };
  const installer = overrides.installer || {
    status: () => ({ state: 'ready', installed: true }),
    startInstall() { calls.startInstall += 1; return { state: 'installing', installed: false }; },
    waitForInstall() { calls.waitForInstall += 1; return Promise.resolve(); },
  };
  const supervisor = overrides.supervisor || {
    hasGlobalGateway: () => overrides.projectsGlobal === true,
    status(id) { calls.fleetStatus.push(id); return { directoryId: id, state: 'stopped' }; },
    statusGlobal() { calls.statusGlobalSupervisor += 1; return { scope: 'global', state: 'running' }; },
    restart(id) { calls.fleetRestart.push(id); return Promise.resolve({ directoryId: id, state: 'running' }); },
    restartGlobal() { calls.restartGlobalSupervisor += 1; return Promise.resolve({ scope: 'global', state: 'running' }); },
    reconcileAll() { calls.reconcileAllSupervisor += 1; },
  };
  const app = runtimeHostApp();
  const host = createVoiceRuntimeHost({
    service,
    launchRegistry,
    voiceRouter,
    runtime,
    getBaseUrl: overrides.getBaseUrl || (() => 'http://127.0.0.1:3456/base?ignored=1#x'),
    log: {
      warn(...args) { calls.warn.push(args); },
      info(...args) { calls.info.push(args); },
      error(...args) { calls.error.push(args); },
    },
    installer,
    supervisor,
  });
  host.mountRoutes(app);
  const handler = app.routes.get(`POST ${VOICE_RUNTIME_HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return { app, calls, handler, host, installer, launchRegistry, runtime, service, supervisor, voiceRouter };
}

async function runtimeHostCall(harness, body, { local = true } = {}) {
  const res = hostResponse();
  await harness.handler(local ? localRequest(body) : remoteRequest(body), res);
  return res;
}

test('voice runtime host port rejects anything but a loopback peer and refuses unknown operations', async () => {
  const harness = mountRuntimeHost();
  for (const body of [
    { op: 'globalGet' }, { op: 'globalPut', options: { enabled: true } },
    { op: 'globalRemove' }, { op: 'globalRuntime' }, { op: 'globalRestart' },
    { op: 'launchBegin' }, { op: 'launchEnd', id: 'ticket-1' },
    { op: 'launchResolve', launchId: 'ticket-1' }, { op: 'runtimeGet' },
    { op: 'runtimeInstall' }, { op: 'fleetRuntime', id: 'dir-1' },
    { op: 'fleetRestart', id: 'dir-1' }, {}, null, [],
  ]) {
    const res = await runtimeHostCall(harness, body, { local: false });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not found' });
  }
  // 非回环请求不产生任何副作用。
  assert.deepEqual(harness.calls.ensureGlobal, []);
  assert.deepEqual(harness.calls.issue, []);
  assert.equal(harness.calls.startInstall, 0);

  for (const body of [{ op: 'nope' }, {}, null, []]) {
    const res = await runtimeHostCall(harness, body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'unknown host operation' });
  }
});

test('voice runtime host keeps both dependency contracts and mounts only its internal path', () => {
  const app = runtimeHostApp();
  const base = {
    service: { inspectGlobal() {} },
    launchRegistry: { issue() {} },
    installer: { status() {}, startInstall() {} },
    supervisor: { status() {} },
  };
  assert.throws(() => createVoiceRuntimeHost(), /voice gateway service/);
  assert.throws(() => createVoiceRuntimeHost({ service: base.service }), /launch registry/);
  assert.throws(
    () => createVoiceRuntimeHost({ service: base.service, launchRegistry: base.launchRegistry }),
    /qwen audio runtime routes require installer/,
  );
  assert.throws(
    () => createVoiceRuntimeHost({
      service: base.service, launchRegistry: base.launchRegistry, installer: base.installer,
    }),
    /qwen audio runtime routes require supervisor/,
  );
  assert.throws(
    () => createVoiceRuntimeHost({ ...base }).mountRoutes({ get() {} }),
    /Express-compatible app/,
  );
  const host = createVoiceRuntimeHost({ ...base });
  host.mountRoutes(app);
  assert.equal(Object.isFrozen(host), true);
  assert.deepEqual([...app.routes.keys()], [`POST ${VOICE_RUNTIME_HOST_PATH}`]);
  assert.equal(VOICE_RUNTIME_HOST_PATH, '/api/__host/voice-runtime');
});

test('globalGet and globalPut shape the gateway fact and pass options through verbatim', async () => {
  const harness = mountRuntimeHost({ legacy: [{ id: 'legacy-1', enabled: true }] });
  let res = await runtimeHostCall(harness, { op: 'globalGet' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    gateway: { configured: true, enabled: true },
    legacy: [{ id: 'legacy-1', enabled: true }],
    baseUrl: 'http://127.0.0.1:3456',
  });

  res = await runtimeHostCall(harness, {
    op: 'globalPut',
    options: { enabled: true, provider: undefined, commanderSessionId: undefined },
    autoInstall: true,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, created: true, gateway: { enabled: true } });
  assert.deepEqual(harness.calls.ensureGlobal, [
    { enabled: true, provider: undefined, commanderSessionId: undefined },
  ]);
  assert.equal(harness.calls.ensureRouter, 1, 'enabling the gateway provisions the router');
  assert.deepEqual(harness.calls.reconcileAll, [{ installIfNeeded: true }]);

  // 只有字面量 true 才会触发安装。
  await runtimeHostCall(harness, { op: 'globalPut', options: { enabled: true }, autoInstall: 'yes' });
  assert.deepEqual(harness.calls.reconcileAll.at(-1), { installIfNeeded: false });

  // 缺失的键保持 undefined；JSON null 原样透传。
  await runtimeHostCall(harness, { op: 'globalPut', options: { enabled: null, provider: null, commanderSessionId: null } });
  assert.deepEqual(harness.calls.ensureGlobal.at(-1), { enabled: null, provider: null, commanderSessionId: null });

  // enabled=false 不 provisioning router。
  const disabled = mountRuntimeHost();
  await runtimeHostCall(disabled, { op: 'globalPut', options: { enabled: false } });
  assert.equal(disabled.calls.ensureRouter, 0);

  // provisioning 失败只告警，不影响 PUT 成功。
  const provisioningFailed = mountRuntimeHost({
    voiceRouter: { ensure: () => ({ ok: false, code: 'voice_router_not_provisioned' }) },
  });
  res = await runtimeHostCall(provisioningFailed, { op: 'globalPut', options: { enabled: true } });
  assert.equal(res.body.ok, true);
  assert.deepEqual(provisioningFailed.calls.warn, [
    ['[multicc/voice] router provisioning failed', { code: 'voice_router_not_provisioned' }],
  ]);

  // service 拒绝：只回 code，不 provision、不 reconcile。
  const rejected = mountRuntimeHost({
    service: {
      inspectGlobal: () => ({ ok: true, gateway: { configured: false, enabled: false }, legacy: [] }),
      ensureGlobal: options => ({ ok: false, code: 'voice_gateway_provider_invalid' }),
      removeGlobal: () => ({ ok: true }),
    },
  });
  res = await runtimeHostCall(rejected, { op: 'globalPut', options: { provider: 'other' } });
  assert.deepEqual(res.body, { ok: false, code: 'voice_gateway_provider_invalid' });
  assert.deepEqual(rejected.calls.reconcileAll, []);

  // 意外异常回 thrown，由前门映射 500。
  const broken = mountRuntimeHost({
    service: {
      inspectGlobal: () => ({ ok: true, gateway: { configured: false, enabled: false }, legacy: [] }),
      ensureGlobal() {
        throw Object.assign(new Error('collision'), { code: 'voice_gateway_id_conflict' });
      },
      removeGlobal: () => ({ ok: true }),
    },
  });
  res = await runtimeHostCall(broken, { op: 'globalPut', options: { enabled: true } });
  assert.deepEqual(res.body, { thrown: { code: 'voice_gateway_id_conflict', message: 'collision' } });
});

test('globalRemove stops the child and reports failures and thrown errors', async () => {
  const harness = mountRuntimeHost();
  let res = await runtimeHostCall(harness, { op: 'globalRemove' });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(harness.calls.removeGlobal, 1);
  assert.equal(harness.calls.stopGlobal, 1);

  const rejected = mountRuntimeHost({
    service: {
      inspectGlobal: () => ({ ok: true, gateway: { configured: false, enabled: false }, legacy: [] }),
      ensureGlobal: () => ({ ok: true }),
      removeGlobal: () => ({ ok: false, code: 'voice_gateway_not_found' }),
    },
  });
  res = await runtimeHostCall(rejected, { op: 'globalRemove' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_gateway_not_found' });
  assert.equal(rejected.calls.stopGlobal, 0);

  // 同步抛错与异步拒绝都不改变删除结果；同步抛错回 thrown。
  const throwingStop = mountRuntimeHost({ runtime: { stopGlobal() { throw new Error('stop failed'); } } });
  res = await runtimeHostCall(throwingStop, { op: 'globalRemove' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'stop failed' } });

  const rejectingStop = mountRuntimeHost({ runtime: { stopGlobal() { return Promise.reject(new Error('late')); } } });
  res = await runtimeHostCall(rejectingStop, { op: 'globalRemove' });
  assert.deepEqual(res.body, { ok: true });
  await new Promise(resolve => setImmediate(resolve));

  const broken = mountRuntimeHost({
    service: {
      inspectGlobal: () => ({ ok: true, gateway: { configured: false, enabled: false }, legacy: [] }),
      ensureGlobal: () => ({ ok: true }),
      removeGlobal() { throw new Error('remove exploded'); },
    },
  });
  res = await runtimeHostCall(broken, { op: 'globalRemove' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'remove exploded' } });
});

test('globalRuntime and globalRestart pass the raw child status through, keeping loopback redaction in Rust', async () => {
  const harness = mountRuntimeHost();
  let res = await runtimeHostCall(harness, { op: 'globalRuntime' });
  assert.deepEqual(res.body, {
    status: { scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:32123' },
  });

  res = await runtimeHostCall(harness, { op: 'globalRestart' });
  assert.equal(res.body.status.state, 'running');
  assert.equal(harness.calls.restartGlobal, 1);

  // 没有运行时时回一个稳定的 stopped 形状，restart 回空对象。
  const bare = mountRuntimeHost({ runtime: null });
  res = await runtimeHostCall(bare, { op: 'globalRuntime' });
  assert.deepEqual(res.body, {
    status: { scope: 'global', state: 'stopped', desired: false, url: null },
  });
  res = await runtimeHostCall(bare, { op: 'globalRestart' });
  assert.deepEqual(res.body, { status: {} });

  const throwing = mountRuntimeHost({
    runtime: { statusGlobal: () => null, restartGlobal: async () => { throw new Error('restart failed'); } },
  });
  res = await runtimeHostCall(throwing, { op: 'globalRestart' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'restart failed' } });
});

test('launchBegin gates on the gateway, backfills the router, and starts a stopped child once', async () => {
  // 未配置 / 未启用都按 not found 失败，且不 provision、不签票。
  for (const gateway of [{ configured: false, enabled: false }, { configured: true, enabled: false }]) {
    const harness = mountRuntimeHost({ gateway });
    const res = await runtimeHostCall(harness, { op: 'launchBegin' });
    assert.deepEqual(res.body, { ok: false, code: 'voice_gateway_not_found' });
    assert.equal(harness.calls.ensureRouter, 0);
    assert.deepEqual(harness.calls.issue, []);
  }

  // 没有 sourceSessionId 时先补 router；补失败即失败，不签票。
  const unprovisioned = mountRuntimeHost({
    voiceRouter: { ensure: () => ({ ok: false, code: 'voice_router_id_conflict' }) },
  });
  let res = await runtimeHostCall(unprovisioned, { op: 'launchBegin' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_router_id_conflict' });
  assert.deepEqual(unprovisioned.calls.issue, []);

  const noCode = mountRuntimeHost({ voiceRouter: { ensure: () => ({ ok: false }) } });
  res = await runtimeHostCall(noCode, { op: 'launchBegin' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_router_not_provisioned' });

  // 带 sourceSessionId 时 router 不参与。
  const chatScoped = mountRuntimeHost();
  res = await runtimeHostCall(chatScoped, { op: 'launchBegin', sourceSessionId: 'chat-1' });
  assert.equal(chatScoped.calls.ensureRouter, 0);
  assert.deepEqual(chatScoped.calls.issue, [{ sourceSessionId: 'chat-1' }]);
  assert.deepEqual(res.body, {
    ok: true,
    launch: {
      id: 'ticket-1',
      scope: 'chat',
      expiresAt: '2026-01-01T00:00:00.000Z',
      display: '显示名',
      sourceSessionId: 'chat-1',
    },
    targetSessionId: 'chat-1',
    status: { scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:32123' },
  });
  assert.equal(chatScoped.calls.startGlobal, 0, 'an already running child is not restarted');

  // 全局 ticket 的 sourceSessionId 规范化为 null。
  res = await runtimeHostCall(chatScoped, { op: 'launchBegin' });
  assert.equal(res.body.launch.scope, 'global');
  assert.equal(res.body.launch.sourceSessionId, null);
  assert.equal(res.body.targetSessionId, '__voice_router__');

  // 签票失败原样回 code。
  const issueFailed = mountRuntimeHost({
    launchRegistry: {
      issue: () => ({ ok: false, code: 'voice_launch_source_not_found' }),
      resolve: () => ({ ok: false }),
      revoke: () => {},
    },
  });
  res = await runtimeHostCall(issueFailed, { op: 'launchBegin', sourceSessionId: 'gone' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_launch_source_not_found' });

  // 非 running 状态触发 startGlobal；其抛错被吞，沿用原状态。
  const stoppedStatus = { scope: 'global', state: 'stopped', desired: true, url: null };
  const stopped = mountRuntimeHost({
    runtime: {
      statusGlobal: () => ({ ...stoppedStatus }),
      startGlobal: async () => { throw new Error('start failed'); },
    },
  });
  res = await runtimeHostCall(stopped, { op: 'launchBegin' });
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.status, stoppedStatus);

  const started = mountRuntimeHost({
    runtime: {
      statusGlobal: () => ({ ...stoppedStatus }),
      startGlobal: () => ({ scope: 'global', state: 'running', desired: true, url: 'http://127.0.0.1:32123' }),
    },
  });
  res = await runtimeHostCall(started, { op: 'launchBegin' });
  assert.equal(res.body.status.state, 'running');

  // 状态未知（null）时不启动。
  const unknown = mountRuntimeHost({ runtime: { statusGlobal: () => null } });
  res = await runtimeHostCall(unknown, { op: 'launchBegin' });
  assert.equal(res.body.status, null);

  const broken = mountRuntimeHost({
    service: {
      inspectGlobal() { throw new Error('inspect exploded'); },
      ensureGlobal: () => ({ ok: true }),
      removeGlobal: () => ({ ok: true }),
    },
  });
  res = await runtimeHostCall(broken, { op: 'launchBegin' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'inspect exploded' } });
});

test('launchEnd revokes on request or logs the issue, and launchResolve forwards registry outcomes', async () => {
  const harness = mountRuntimeHost();
  let res = await runtimeHostCall(harness, { op: 'launchEnd', id: 'ticket-1', revoke: true });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(harness.calls.revoke, ['ticket-1']);
  assert.deepEqual(harness.calls.info, []);

  res = await runtimeHostCall(harness, {
    op: 'launchEnd', id: 'ticket-2', scope: 'chat', source: 'chat-1', target: 'chat-1',
  });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(harness.calls.revoke, ['ticket-1']);
  assert.deepEqual(harness.calls.info, [
    ['[multicc/voice] launch issued', { scope: 'chat', source: 'chat-1', target: 'chat-1' }],
  ]);

  // source 缺省规范化为 null。
  const defaultSource = mountRuntimeHost();
  res = await runtimeHostCall(defaultSource, { op: 'launchEnd', id: 'ticket-3', scope: 'global' });
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(defaultSource.calls.info, [
    ['[multicc/voice] launch issued', { scope: 'global', source: null, target: undefined }],
  ]);

  res = await runtimeHostCall(harness, { op: 'launchResolve', launchId: 'ticket-1' });
  assert.deepEqual(res.body, { ok: true, context: { launchId: 'ticket-1' } });
  assert.deepEqual(harness.calls.resolve, ['ticket-1']);

  const unknownTicket = mountRuntimeHost({
    launchRegistry: {
      issue: () => ({ ok: true }),
      resolve: () => ({ ok: false, code: 'voice_launch_unknown' }),
      revoke: () => {},
    },
  });
  res = await runtimeHostCall(unknownTicket, { op: 'launchResolve', launchId: 'forged' });
  assert.deepEqual(res.body, { ok: false, code: 'voice_launch_unknown' });
});

test('runtimeGet and runtimeInstall report the pre-install state and reconcile after the async install', async () => {
  const harness = mountRuntimeHost();
  let res = await runtimeHostCall(harness, { op: 'runtimeGet' });
  assert.deepEqual(res.body, { runtime: { state: 'ready', installed: true } });

  res = await runtimeHostCall(harness, { op: 'runtimeInstall' });
  assert.deepEqual(res.body, { installed: true, runtime: { state: 'installing', installed: false } });
  assert.equal(harness.calls.startInstall, 1);
  assert.equal(harness.calls.waitForInstall, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.calls.reconcileAllSupervisor, 1);

  // installed=false 时把安装前的值回给前门（由它决定 202/200）。
  const fresh = mountRuntimeHost({
    installer: {
      status: () => ({ state: 'not_installed', installed: false }),
      startInstall: () => ({ state: 'installing', installed: false }),
      waitForInstall: () => Promise.resolve(),
    },
  });
  res = await runtimeHostCall(fresh, { op: 'runtimeInstall' });
  assert.equal(res.body.installed, false);

  // 异步安装失败只记日志。
  const failing = mountRuntimeHost({
    installer: {
      status: () => ({ state: 'ready', installed: true }),
      startInstall: () => ({ state: 'installing', installed: false }),
      waitForInstall: () => Promise.reject(new Error('download failed')),
    },
  });
  res = await runtimeHostCall(failing, { op: 'runtimeInstall' });
  assert.equal(res.body.installed, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failing.calls.error, [
    ['[multicc/qwen-audio] asynchronous install failed', { error: 'download failed' }],
  ]);
  assert.equal(failing.calls.reconcileAllSupervisor, 0);

  // 同步抛错回 thrown。
  const broken = mountRuntimeHost({
    installer: {
      status: () => ({ installed: true }),
      startInstall() { throw new Error('install exploded'); },
      waitForInstall: () => Promise.resolve(),
    },
  });
  res = await runtimeHostCall(broken, { op: 'runtimeInstall' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'install exploded' } });
});

test('fleetRuntime and fleetRestart project the one global child or answer for the Fleet slot', async () => {
  const globalHarness = mountRuntimeHost({ projectsGlobal: true });
  let res = await runtimeHostCall(globalHarness, { op: 'fleetRuntime', id: 'dir-1' });
  assert.deepEqual(res.body, { projectsGlobal: true, status: { scope: 'global', state: 'running' } });
  assert.deepEqual(globalHarness.calls.fleetStatus, []);
  res = await runtimeHostCall(globalHarness, { op: 'fleetRestart', id: 'dir-1' });
  assert.deepEqual(res.body, { projectsGlobal: true, status: { scope: 'global', state: 'running' } });
  assert.deepEqual(globalHarness.calls.fleetRestart, []);

  const fleetHarness = mountRuntimeHost({ projectsGlobal: false });
  res = await runtimeHostCall(fleetHarness, { op: 'fleetRuntime', id: 'dir-1' });
  assert.deepEqual(res.body, { projectsGlobal: false, status: { directoryId: 'dir-1', state: 'stopped' } });
  res = await runtimeHostCall(fleetHarness, { op: 'fleetRestart', id: 'dir-1' });
  assert.deepEqual(res.body, { projectsGlobal: false, status: { directoryId: 'dir-1', state: 'running' } });
  assert.deepEqual(fleetHarness.calls.fleetRestart, ['dir-1']);

  const throwing = mountRuntimeHost({
    projectsGlobal: true,
    supervisor: {
      hasGlobalGateway: () => true,
      status: () => ({ state: 'stopped' }),
      statusGlobal: () => ({ state: 'running' }),
      restart: async () => ({ state: 'running' }),
      restartGlobal: async () => { throw new Error('restart exploded'); },
      reconcileAll() {},
    },
  });
  res = await runtimeHostCall(throwing, { op: 'fleetRestart', id: 'dir-1' });
  assert.deepEqual(res.body, { thrown: { code: undefined, message: 'restart exploded' } });
});

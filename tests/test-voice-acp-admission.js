'use strict';

// Acceptance tests for the structured terminal outcome of a global voice turn.
//
// The bug this pins: the voice router's assistant text reaches the ACP bridge —
// and from there the user's ear — with a `<<dispatch>>` marker fragmented across
// chunks, and the transport's `result` ends the ACP turn before the durable
// admission has answered. So the call both leaks the marker and reports nothing
// about whether the work was actually taken.
//
// The contract under test is therefore one-sided and request-correlated:
//   Host   — exactly one `voice_admission` frame per voice-router turn, stating
//            what the Host did (and only what it did), carrying no dispatch
//            message, no prompt, no credential and no target session id.
//   Bridge — only that matching Host frame ends a global turn. Generic shared
//            Router traffic is ignored; every scope buffers and sanitizes once.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createGatewayHost } = require('../src/dispatch/gateway-host');
const { VOICE_ROUTER_ID } = require('../src/voice-router');
const { createVoiceLaunchRegistry } = require('../src/voice-launch');
const { resolveDirectoryCommander } = require('../src/task-board');
const {
  ADMISSION_TIMEOUT_MAX_MS,
  ADMISSION_TIMEOUT_MIN_MS,
  admissionSpeech,
  boundedAdmissionTimeout,
  createVoiceAcpBridge,
  speakableFromBuffer,
} = require('../src/voice-acp-bridge');

const DISPATCH_MESSAGE = '检查登录接口 500 的原因并修复，然后跑一遍回归测试';
const MARKER_TURN = `好的，我让一号项目的 Commander 去查。\n<<dispatch target="commander-1">${DISPATCH_MESSAGE}</dispatch>>`;
const ROUTE_TURN = '先确认。\n<<route target="chat-1">内部 route</route>>';

function baseRecords() {
  const records = new Map([
    ['commander-1', {
      id: 'commander-1', dirId: 'dir-1', type: 'commander', kind: 'chat', label: 'Fleet 一 Commander',
    }],
    ['chat-1', { id: 'chat-1', dirId: 'dir-1', type: 'worker', kind: 'chat', label: '前端会话' }],
  ]);
  records.set(VOICE_ROUTER_ID, {
    id: VOICE_ROUTER_ID, type: 'gateway', kind: 'chat', label: '🎙️ 实时语音 Router', dirId: null,
  });
  return records;
}

function baseDirectories() {
  return new Map([['dir-1', { id: 'dir-1', path: '/tmp/fleet-one', label: 'Fleet 一' }]]);
}

// Records the Host-owned structured outcome. MCP admission, rather than
// assistant prose, is the only event allowed to produce an admitted frame.
function hostFixture({ admitDispatch, tick } = {}) {
  const records = baseRecords();
  const frames = [];
  const warnings = [];
  const chatSessions = new Map();
  const setTurn = (turnId, requestId) => {
    chatSessions.set(VOICE_ROUTER_ID, {
      _activeTurn: { turnId, requestId },
    });
  };
  setTurn('turn-1', 'req-1');
  const host = createGatewayHost({
    persistedSessions: records,
    chatSessions,
    directories: baseDirectories(),
    logger: { warn: (event, fields) => warnings.push({ event, fields }) },
    appendEvent() {},
    getSessionDelivery: () => ({ deliverContinuation() {}, deliverSystem() {} }),
    normalizeEffort: value => value,
    dispatchTargetHintFor: () => '',
    cwdForSession: () => '/tmp/fleet-one',
    getSetSessionStatus: () => () => {},
    isTargetBusy: () => false,
    getOrchestrationRuntime: () => ({
      operations: { get: async () => null },
      completeDispatch: async () => ({ ok: true }),
      admitDispatch: admitDispatch
        || (async () => ({ id: 'op-1', status: 'queued', createdAt: 1 })),
      tick: tick || (async () => {}),
    }),
    getTaskContextHost: () => ({ dispatchSpec: () => ({}) }),
    getCreateSessionRecord: () => async () => {
      throw new Error('voice dispatch must reuse existing sessions');
    },
    appendChatMessage() {},
    chatBroadcast: (sessionId, message) => frames.push({ sessionId, message }),
  });
  const admissions = () => frames
    .filter(frame => frame.message?.type === 'voice_admission')
    .map(frame => frame.message);
  return { admissions, chatSessions, frames, host, records, setTurn, warnings };
}

// The operation is durable the moment admitDispatch returns; the scheduler pass
// that follows is only a wake-up. If a failed wake-up were reported as a failed
// dispatch, the caller would resubmit work that is already committed and the
// user would receive the same task twice.
test('a wake-up that fails after a durable admission is still an admission', async () => {
  const fixture = hostFixture({
    tick: async () => { throw new Error('scheduler unavailable'); },
  });
  const result = await fixture.host.dispatchToSession('chat-1', DISPATCH_MESSAGE, {
    ownerSessionId: VOICE_ROUTER_ID,
    oneWay: true,
  });
  assert.equal(result.ok, true, 'a committed dispatch is never reported as a failure');
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.wakeupError, 'scheduler unavailable');
  const deferred = fixture.warnings.filter(w => w.event === 'dispatch_wakeup_deferred');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].fields.operationId, 'op-1');
});

test('a queue notice that failed upstream is reported, not swallowed', async () => {
  const fixture = hostFixture({
    admitDispatch: async () => ({
      id: 'op-2', status: 'queued', createdAt: 1, wakeupError: 'queue notice failed',
    }),
  });
  const result = await fixture.host.dispatchToSession('chat-1', DISPATCH_MESSAGE, {
    ownerSessionId: VOICE_ROUTER_ID,
    oneWay: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.wakeupError, 'queue notice failed');
  assert.equal(fixture.warnings.filter(w => w.event === 'dispatch_wakeup_deferred').length, 1);
});

// The dangerous direction: an admission that genuinely failed must still reject,
// or committed-looking work would never be committed at all.
test('an admission that genuinely fails is never dressed up as success', async () => {
  const fixture = hostFixture({
    admitDispatch: async () => { throw new Error('store unavailable'); },
  });
  await assert.rejects(
    () => fixture.host.dispatchToSession('chat-1', DISPATCH_MESSAGE, {
      ownerSessionId: VOICE_ROUTER_ID,
      oneWay: true,
    }),
    /store unavailable/,
  );
  assert.equal(fixture.warnings.filter(w => w.event === 'dispatch_wakeup_deferred').length, 0);
});

test('an MCP voice dispatch reports admission with an operation id and no task payload', () => {
  const fixture = hostFixture();
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'queued',
    duplicate: false,
  });

  const frames = fixture.admissions();
  assert.equal(frames.length, 1, 'exactly one terminal frame per turn');
  const frame = frames[0];
  assert.equal(frame.version, 1);
  assert.equal(frame.requestId, 'req-1');
  assert.equal(frame.turnId, 'turn-1');
  assert.equal(frame.gatewaySessionId, undefined);
  assert.equal(frame.outcome, 'admitted');
  assert.equal(frame.operationId, 'op-voice-1');
  assert.equal(frame.duplicate, false);
  assert.equal(frame.queueStatus, 'queued');
  assert.equal(frame.error, null);
  assert.match(frame.speechText, /任务已提交/);
  assert.equal(frame.targetLabel, undefined);

  const serialized = JSON.stringify(frame);
  assert.equal(serialized.includes(DISPATCH_MESSAGE), false, 'the task instruction never travels');
  assert.equal(serialized.includes('chat-1'), false, 'a target session id is never disclosed');
  assert.equal(serialized.includes('/tmp/fleet-one'), false, 'no cwd travels');
});

test('voice admission stays bound to the tool-call turn after the live turn switches', () => {
  const fixture = hostFixture();
  fixture.setTurn('turn-new', 'req-new');
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    callerTurnId: 'turn-original',
    callerRequestId: 'req-original',
    targetSessionId: 'chat-1',
    operationId: 'op-original',
    status: 'admitted',
  });

  const [frame] = fixture.admissions();
  assert.equal(frame.turnId, 'turn-original');
  assert.equal(frame.requestId, 'req-original');
  assert.equal(frame.operationId, 'op-original');
});

test('explicit voice admission metadata fails closed unless both correlation keys exist', () => {
  const fixture = hostFixture();
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    callerTurnId: 'turn-explicit',
    callerRequestId: '',
    targetSessionId: 'chat-1',
    operationId: 'op-unaddressable',
    status: 'admitted',
  });

  assert.equal(fixture.admissions().length, 0);
  assert.deepEqual(fixture.warnings.map(entry => entry.event), [
    'voice_admission_correlation_unresolved',
  ]);
});

test('authoritative MCP admission wins over turn-end no_dispatch fallback', () => {
  const fixture = hostFixture();
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'admitted',
  });
  fixture.host.handleGatewayTurnComplete('模型最终文本', VOICE_ROUTER_ID, 'turn-1', 'req-1');
  assert.deepEqual(fixture.admissions().map(frame => frame.outcome), ['admitted']);
});

test('a turn with no MCP admission states no_dispatch instead of going silent', () => {
  const fixture = hostFixture();
  fixture.setTurn('turn-2', 'req-2');
  fixture.host.handleGatewayTurnComplete(
    '这个功能已经在上一版做完了。', VOICE_ROUTER_ID, 'turn-2', 'req-2',
  );
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'no_dispatch');
  assert.equal(frame.operationId, null);
  assert.equal(frame.queueStatus, null);
  assert.equal(frame.error, null);
  assert.equal(frame.speechText, '这个功能已经在上一版做完了。');
});

test('Host speech is sanitized and redacted before it enters the voice frame', () => {
  const fixture = hostFixture();
  fixture.setTurn('turn-private', 'req-private');
  fixture.host.handleGatewayTurnComplete(
    `可以。\n<<dispatch target="commander-1">${DISPATCH_MESSAGE}</dispatch>>\n<<route target="chat-1">内部 route</route>>\nchat-1 /tmp/fleet-one`,
    VOICE_ROUTER_ID,
    'turn-private',
    'req-private',
  );
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'no_dispatch');
  assert.equal(frame.speechText, '可以。');
  assert.equal(frame.targetLabel, undefined);
  assert.equal(frame.gatewaySessionId, undefined);
  assert.doesNotMatch(frame.speechText, /dispatch|route|chat-1|\/tmp\/fleet-one/i);
});

test('an idempotent MCP replay is still an admission and is flagged duplicate', () => {
  const fixture = hostFixture();
  fixture.setTurn('turn-3', 'req-3a');
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'admitted',
    duplicate: false,
  });
  fixture.setTurn('turn-3', 'req-3b');
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'admitted',
    duplicate: true,
  });
  const frames = fixture.admissions();
  assert.deepEqual(frames.map(frame => frame.outcome), ['admitted', 'admitted']);
  assert.deepEqual(frames.map(frame => frame.duplicate), [false, true]);
  assert.deepEqual(frames.map(frame => frame.operationId), ['op-voice-1', 'op-voice-1']);
});

test('the same MCP admission request is never answered twice', () => {
  const fixture = hostFixture();
  const admission = {
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: 'op-voice-1',
    status: 'admitted',
  };
  fixture.host.recordRouterAdmission(admission);
  fixture.host.recordRouterAdmission(admission);
  assert.equal(fixture.admissions().length, 1);
});

test('an admitted frame without an operation id is downgraded to failure', () => {
  const fixture = hostFixture();
  fixture.host.recordRouterAdmission({
    callerSessionId: VOICE_ROUTER_ID,
    targetSessionId: 'chat-1',
    operationId: '',
    status: 'admitted',
  });
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'failed');
  assert.equal(frame.operationId, null);
  assert.equal(frame.error.code, 'operation_id_missing');
  assert.equal(frame.error.retryable, true);
});

test('the WeChat gateway emits no voice outcome frame', () => {
  const fixture = hostFixture();
  fixture.host.handleGatewayTurnComplete('闲聊', fixture.host.GATEWAY_ID, 'wechat-1', 'req-w1');
  fixture.host.handleGatewayTurnComplete('普通回复', fixture.host.GATEWAY_ID, 'wechat-2', 'req-w2');
  assert.equal(fixture.admissions().length, 0);
});

// ── Bridge ───────────────────────────────────────────────────────────────────

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

let harnessId = 0;

function okJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Launch mode (the one machine-wide child): no directoryId, and the routing
// target is resolved per utterance from the launch id in the prompt envelope.
function launchHarness({ scope = 'global', queueStatus = 200, queueThrows = null } = {}) {
  const instanceId = ++harnessId;
  FakeWebSocket.instances = [];
  const requests = [];
  const timers = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('/api/v1/voice-gateway/launch/')) {
      return okJson({
        ok: true,
        context: scope === 'chat'
          ? {
              scope: 'chat',
              sourceSessionId: 'chat-1',
              targetSessionId: 'chat-1',
              directoryId: 'dir-1',
              commanderSessionId: 'commander-1',
              display: '前端会话',
            }
          : {
              scope: 'global',
              sourceSessionId: null,
              targetSessionId: VOICE_ROUTER_ID,
              directoryId: null,
              commanderSessionId: null,
              display: '全局语音',
            },
      });
    }
    if (url.includes('/queue/action')) {
      if (queueThrows) throw queueThrows;
      return okJson(queueStatus === 200 ? { ok: true } : { error: `queue_${queueStatus}` }, queueStatus);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const bridge = createVoiceAcpBridge({
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    randomUUID: (() => {
      let value = 0;
      return () => `h${instanceId}-uuid-${++value}`;
    })(),
    // The real deadline is 15–30 s; firing it by hand is the only way to test it
    // without waiting it out.
    admissionTimers: {
      setTimeout: (fn) => { const entry = { fn }; timers.push(entry); return entry; },
      clearTimeout: entry => { if (entry) entry.cancelled = true; },
    },
  });
  const fireTimeout = () => {
    const entry = timers.find(t => !t.cancelled && !t.fired);
    assert.ok(entry, 'a voice turn must arm its overall deadline when sent');
    entry.fired = true;
    entry.fn();
  };
  return { bridge, fetchImpl, fireTimeout, requests, timers };
}

function promptBlocks(text, launchId = 'launch-1') {
  return [{
    type: 'text',
    text: `<qwen_audio_agent_request>${JSON.stringify({ voice_session_id: launchId })}</qwen_audio_agent_request>\n${text}`,
  }];
}

async function startTurn(harness, { text = '帮我修一下登录', scope } = {}) {
  const created = await harness.bridge.createSession({ cwd: '/tmp/project' });
  const updates = [];
  let settled = false;
  const promise = harness.bridge.prompt(
    { sessionId: created.sessionId, prompt: promptBlocks(text) },
    update => updates.push(update),
  ).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances.at(-1);
  const outgoing = socket.sent.find(message => message.type === 'user_message');
  socket.serverSend({ type: 'chat_msg_meta', role: 'user', clientMsgId: outgoing.clientMsgId });
  await new Promise(resolve => setImmediate(resolve));
  return {
    created,
    outgoing,
    promise,
    socket,
    updates,
    isSettled: () => settled,
    chunks: () => updates
      .filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content.text),
    spoken: () => updates
      .filter(update => update.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content.text)
      .join(''),
    scope,
  };
}

function admissionFrame(turn, overrides = {}) {
  return {
    type: 'voice_admission',
    version: 1,
    requestId: turn.outgoing.clientMsgId,
    turnId: 'turn-1',
    gatewaySessionId: VOICE_ROUTER_ID,
    outcome: 'admitted',
    operationId: 'op-voice-1',
    duplicate: false,
    queueStatus: 'admitted',
    speechText: '好的，我让一号项目的 Commander 去查。',
    targetLabel: 'Fleet 一 Commander',
    error: null,
    ...overrides,
  };
}

test('the launch ticket is consumed by the Bridge and never written into source Chat', async () => {
  const harness = launchHarness({ scope: 'chat' });
  const turn = await startTurn(harness, { text: '只把这一句话发到会话' });
  assert.equal(turn.outgoing.text, '只把这一句话发到会话');
  assert.doesNotMatch(JSON.stringify(turn.outgoing), /qwen_audio_agent_request|voice_session_id|launch-1/);
  turn.socket.serverSend({ type: 'result' });
  await turn.promise;
});

test('a globally routed turn never leaks a dispatch marker, character by character', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);

  // The marker arrives split as finely as a transport can split it. Any per-chunk
  // filter fails here: no single character is recognisable as part of a marker.
  for (const char of MARKER_TURN) {
    turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: char }] } });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(turn.chunks(), [], 'a turn that may carry a marker is buffered, never streamed');

  // Generic result/error/tool traffic on the shared Router has no authority.
  turn.socket.serverSend({ type: 'result' });
  turn.socket.serverSend({ type: 'error', error: 'another call failed' });
  turn.socket.serverSend({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'foreign', name: 'dispatch_master' }] },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false);
  turn.socket.serverSend(admissionFrame(turn, {
    speechText: `任务已提交。\n<<dispatch target="commander-1">${DISPATCH_MESSAGE}</dispatch>>\n<<route target="chat-1">内部 route</route>>\n/tmp/project`,
  }));
  const result = await turn.promise;

  assert.equal(result.stopReason, 'end_turn');
  const spoken = turn.spoken();
  assert.equal(spoken, '任务已提交。');
  assert.doesNotMatch(spoken, /<<|dispatch|route|>>/i);
  assert.equal(spoken.includes(DISPATCH_MESSAGE), false);
  assert.equal(spoken.includes('commander-1'), false);
});

test('a turn cut off mid-marker still says nothing about the marker', () => {
  assert.equal(speakableFromBuffer('好的。\n<<dispatch target="comm'), '好的。');
  assert.equal(speakableFromBuffer('好的。\n<<dispa'), '好的。');
  assert.equal(speakableFromBuffer('好的。\n<<'), '好的。');
  assert.equal(speakableFromBuffer(MARKER_TURN), '好的，我让一号项目的 Commander 去查。');
  assert.equal(speakableFromBuffer(`${MARKER_TURN}\n${ROUTE_TURN}`), '好的，我让一号项目的 Commander 去查。\n先确认。');
  assert.equal(speakableFromBuffer('好的。\n<<route target="chat'), '好的。');
  assert.equal(speakableFromBuffer('普通回答'), '普通回答');
});

test('the matching Host admission is the only terminal truth', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'result', usage: { total_tokens: 99 } });
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: 'foreign' }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false);
  assert.deepEqual(turn.chunks(), []);

  turn.socket.serverSend(admissionFrame(turn));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.usage, undefined, 'uncorrelated generic usage cannot pollute this call');
  assert.equal(turn.spoken(), '好的，我让一号项目的 Commander 去查。');
  assert.equal(turn.chunks().length, 1);
});

test('an outcome frame for another request or version cannot settle this turn', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER_TURN }] } });
  await new Promise(resolve => setImmediate(resolve));

  turn.socket.serverSend(admissionFrame(turn, { requestId: 'someone-elses-request' }));
  turn.socket.serverSend(admissionFrame(turn, { version: 2 }));
  turn.socket.serverSend(admissionFrame(turn, { requestId: '' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false, 'a mismatched envelope is not this turn’s answer');

  turn.socket.serverSend(admissionFrame(turn, { outcome: 'admitted' }));
  // requestId is sufficient and unique; turnId is metadata, not a second join.
  turn.socket.serverSend(admissionFrame(turn, { outcome: 'failed', speechText: '重复帧' }));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(turn.chunks().length, 1);
  assert.equal(turn.spoken(), '好的，我让一号项目的 Commander 去查。');
});

test('two concurrent calls settle only from their own request ids', async () => {
  const firstHarness = launchHarness();
  const first = await startTurn(firstHarness, { text: '第一条' });
  const secondHarness = launchHarness();
  const second = await startTurn(secondHarness, { text: '第二条' });

  first.socket.serverSend(admissionFrame(first, {
    requestId: second.outgoing.clientMsgId,
    speechText: '第二条回答',
  }));
  second.socket.serverSend(admissionFrame(second, {
    requestId: first.outgoing.clientMsgId,
    speechText: '第一条回答',
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.isSettled(), false);
  assert.equal(second.isSettled(), false);

  first.socket.serverSend(admissionFrame(first, { speechText: '第一条回答' }));
  second.socket.serverSend(admissionFrame(second, { speechText: '第二条回答' }));
  await Promise.all([first.promise, second.promise]);
  assert.equal(first.spoken(), '第一条回答');
  assert.equal(second.spoken(), '第二条回答');
});

test('a no_dispatch turn simply speaks its answer', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness, { text: '现在几点了' });
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: '这个我查不到。' }] } });
  turn.socket.serverSend({ type: 'result' });
  turn.socket.serverSend(admissionFrame(turn, {
    outcome: 'no_dispatch',
    operationId: null,
    queueStatus: null,
    speechText: '这个我查不到。',
  }));
  await turn.promise;
  assert.equal(turn.spoken(), '这个我查不到。');
});

test('a failed admission is spoken as a failure, never as the model’s optimistic prose', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER_TURN }] } });
  turn.socket.serverSend({ type: 'result' });
  turn.socket.serverSend(admissionFrame(turn, {
    outcome: 'failed',
    operationId: null,
    queueStatus: null,
    speechText: '好的，我让一号项目的 Commander 去查。',
    error: { code: 'dispatch_error', publicMessage: '这条语音任务投递时出错了。', retryable: true },
  }));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(turn.spoken(), '这条语音任务投递时出错了。');
  assert.equal(turn.spoken().includes('去查'), false, 'a failed turn must not claim the work is under way');
});

test('the Bridge fails closed when admitted has no operation id', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend(admissionFrame(turn, {
    outcome: 'admitted',
    operationId: '',
    speechText: '任务已提交。',
    error: null,
  }));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(turn.spoken(), '任务提交结果不完整，请稍后重试。');
  assert.doesNotMatch(turn.spoken(), /已提交/);
});

test('a bounded wait that expires reports uncertainty and never claims non-delivery', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false);
  assert.equal(harness.timers.filter(timer => !timer.cancelled).length, 1, 'deadline starts when prompt is sent');

  harness.fireTimeout();
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn', 'a lost outcome frame ends the call, it does not hang it');
  const spoken = turn.spoken();
  assert.match(spoken, /还没有确认/, 'silence is uncertainty');
  assert.doesNotMatch(spoken, /没有提交成功|投递失败|未送达/, 'the Host may have admitted it — do not deny delivery');
  assert.doesNotMatch(spoken, /<<|dispatch/i);
});

test('bounded wait stays inside the 15–30s window whatever it is configured with', () => {
  assert.equal(boundedAdmissionTimeout(1), ADMISSION_TIMEOUT_MIN_MS);
  assert.equal(boundedAdmissionTimeout(999_999), ADMISSION_TIMEOUT_MAX_MS);
  assert.equal(boundedAdmissionTimeout(18_000), 18_000);
  assert.equal(boundedAdmissionTimeout('nonsense') >= ADMISSION_TIMEOUT_MIN_MS, true);
  assert.equal(boundedAdmissionTimeout(undefined) <= ADMISSION_TIMEOUT_MAX_MS, true);
});

test('cancelling before admission ends the call without claiming anything was delivered', async () => {
  const harness = launchHarness();
  const created = await harness.bridge.createSession({ cwd: '/tmp/project' });
  const updates = [];
  const promise = harness.bridge.prompt(
    { sessionId: created.sessionId, prompt: promptBlocks('先别管了') },
    update => updates.push(update),
  );
  await new Promise(resolve => setImmediate(resolve));

  const result = await harness.bridge.cancel({ sessionId: created.sessionId }).then(() => promise);
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(updates.filter(u => u.sessionUpdate === 'agent_message_chunk'), []);
});

test('queued cancel 404/409/5xx and transport errors all settle and clear the call', async () => {
  for (const setup of [
    { queueStatus: 404 },
    { queueStatus: 409 },
    { queueStatus: 500 },
    { queueThrows: new Error('socket reset') },
  ]) {
    const harness = launchHarness(setup);
    const created = await harness.bridge.createSession({ cwd: '/tmp/project' });
    const promise = harness.bridge.prompt(
      { sessionId: created.sessionId, prompt: promptBlocks('取消这次语音') },
      () => {},
    );
    await new Promise(resolve => setImmediate(resolve));
    await harness.bridge.cancel({ sessionId: created.sessionId });
    assert.equal((await promise).stopReason, 'cancelled');
    const next = harness.bridge.prompt(
      { sessionId: created.sessionId, prompt: promptBlocks('下一次') },
      () => {},
    );
    await new Promise(resolve => setImmediate(resolve));
    await harness.bridge.cancel({ sessionId: created.sessionId });
    assert.equal((await next).stopReason, 'cancelled', 'active entry was cleaned after cancel failure');
  }
});

test('cancelling after admission only stops the speech — it never claims the task was withdrawn', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER_TURN }] } });
  await harness.bridge.cancel({ sessionId: turn.created.sessionId });
  assert.equal(turn.socket.sent.at(-1).type, 'cancel');

  turn.socket.serverSend({ type: 'result' });
  turn.socket.serverSend(admissionFrame(turn));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(
    turn.updates.filter(u => u.sessionUpdate === 'agent_message_chunk'),
    [],
    'a cancelled call says nothing — least of all that admitted work was recalled',
  );
});

test('error and socket close after a started cancellation cannot reopen or hang it', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  await harness.bridge.cancel({ sessionId: turn.created.sessionId });
  turn.socket.serverSend({ type: 'error', error: 'late error' });
  turn.socket.close();
  const result = await turn.promise;
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(turn.chunks(), []);
});

test('an unexpected socket close speaks unknown and clears the active entry', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.close();
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.match(turn.spoken(), /还没有确认/);
});

test('a chat-scoped voice turn buffers fully and sanitizes once at result', async () => {
  const harness = launchHarness({ scope: 'chat' });
  const turn = await startTurn(harness, { text: '把这一段改成中文' });
  turn.socket.serverSend({ type: 'assistant', message: { textSnapshot: true, content: [{ type: 'text', text: '好' }] } });
  turn.socket.serverSend({ type: 'assistant', message: { textSnapshot: true, content: [{ type: 'text', text: '好的' }] } });
  turn.socket.serverSend({
    type: 'assistant',
    message: {
      textSnapshot: true,
      content: [{
        type: 'text',
        text: `好的，改完了\n<<dispatch target="commander-1">${DISPATCH_MESSAGE}</dispatch>>\n<<rou`,
      }],
    },
  });
  turn.socket.serverSend({
    type: 'assistant',
    message: {
      content: [{
        type: 'text',
        text: 'te target="chat-1">内部 route</route>>\nchat-1 /tmp/project',
      }],
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(turn.chunks(), [], 'chat TTS waits for the complete response');

  turn.socket.serverSend({ type: 'result' });
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(turn.chunks(), ['好的，改完了']);
  assert.equal(harness.timers.length, 1, 'chat scope has the same bounded overall deadline');
});

test('close settles even when queued cancellation fails', async () => {
  const harness = launchHarness({ queueStatus: 500 });
  const created = await harness.bridge.createSession({ cwd: '/tmp/project' });
  const promise = harness.bridge.prompt(
    { sessionId: created.sessionId, prompt: promptBlocks('关闭会话') },
    () => {},
  );
  await new Promise(resolve => setImmediate(resolve));
  await harness.bridge.closeSession({ sessionId: created.sessionId });
  assert.equal((await promise).stopReason, 'cancelled');
  assert.equal(harness.bridge.sessionCount(), 0);
});

test('a chat launch targets the source session exactly, with no dynamic prompt in between', async () => {
  const records = baseRecords();
  const registry = createVoiceLaunchRegistry({
    records,
    directories: baseDirectories(),
    resolveCommander: resolveDirectoryCommander,
    randomId: (() => { let n = 0; return () => `launch-${++n}`; })(),
  });

  const chat = registry.issue({ sourceSessionId: 'chat-1' });
  assert.equal(chat.ok, true);
  assert.equal(chat.context.scope, 'chat');
  assert.equal(chat.context.targetSessionId, 'chat-1');
  assert.equal(chat.context.targetSessionId, chat.context.sourceSessionId, 'the target IS the source, verbatim');

  const resolved = registry.resolve(chat.launch.id);
  assert.equal(resolved.context.targetSessionId, 'chat-1', 're-resolution does not re-route');
  assert.equal(resolved.context.targetSessionId, resolved.context.sourceSessionId);

  // The global path is the only one that goes through the MCP-aware router.
  const global = registry.issue({ scope: 'global' });
  assert.equal(global.context.scope, 'global');
  assert.equal(global.context.targetSessionId, VOICE_ROUTER_ID);
  assert.equal(global.context.sourceSessionId, null);
});

test('spoken text prefers the Host’s own stripped text over the local buffer', () => {
  assert.equal(
    admissionSpeech('admitted', { speechText: '交给一号项目了' }, MARKER_TURN),
    '交给一号项目了',
  );
  assert.equal(
    admissionSpeech('admitted', { speechText: '' }, MARKER_TURN),
    '任务已提交到 MultiCC；后续状态以任务板为准。',
    'an admission never trusts generic Router prose as delivery evidence',
  );
  assert.equal(
    admissionSpeech('admitted', null, ''),
    '任务已提交到 MultiCC；后续状态以任务板为准。',
    'a settled turn is never silent',
  );
  const unknown = admissionSpeech('unknown', null, MARKER_TURN);
  assert.match(unknown, /还没有确认/);
  assert.doesNotMatch(unknown, /<<|dispatch/i);
  assert.equal(
    admissionSpeech('unknown', null, '今天没有待办。'),
    '这条任务的提交状态还没有确认，请稍后在 MultiCC 任务板上查看。',
    'unknown is explicit and contains no uncorrelated prose',
  );
});

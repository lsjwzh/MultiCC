'use strict';

// Acceptance tests for the structured terminal outcome of a global voice turn.
//
// The bug this pins: the voice router's assistant text reaches the ACP bridge —
// and from there the user's ear — with a `<<dispatch>>` marker fragmented across
// chunks, and the transport's `result` ends the ACP turn before the durable
// admission has answered. So the call both leaks the marker and reports nothing
// about whether the work was actually taken.
//
// The contract under test is therefore two-sided:
//   Host   — exactly one `voice_admission` frame per voice-router turn, stating
//            what the Host did (and only what it did), carrying no dispatch
//            message, no prompt, no credential and no target session id.
//   Bridge — a globally-routed turn is buffered rather than streamed, and ends
//            only when BOTH halves have landed (in either order) or a bounded
//            wait expires — and an expired wait reports uncertainty, never a
//            delivery verdict.

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

// Records every broadcast frame, not just the prose pushes: the structured
// frame is exactly the thing the existing global-gateway fixture filters out.
function hostFixture({ admit } = {}) {
  const records = baseRecords();
  const frames = [];
  const pushes = [];
  const seen = new Set();
  const host = createGatewayHost({
    persistedSessions: records,
    chatSessions: new Map(),
    directories: baseDirectories(),
    logger: { warn() {} },
    getChatHistoryService: () => ({ replace() {} }),
    appendEvent() {},
    getSessionDelivery: () => ({ deliverContinuation() {}, deliverSystem() {} }),
    normalizeEffort: value => value,
    dispatchTargetHintFor: () => '',
    cwdForSession: () => '/tmp/fleet-one',
    getSetSessionStatus: () => () => {},
    isTargetBusy: () => false,
    getOrchestrationRuntime: () => ({
      admitDispatch: async spec => {
        if (typeof admit === 'function') return admit(spec);
        const duplicate = seen.has(spec.idempotencyKey);
        seen.add(spec.idempotencyKey);
        return { id: 'op-voice-1', status: 'admitted', createdAt: 1, idempotent: duplicate };
      },
      tick: async () => {},
    }),
    getTaskContextHost: () => ({ dispatchSpec: () => ({}) }),
    getCreateSessionRecord: () => async () => { throw new Error('voice dispatch must reuse existing sessions'); },
    appendChatMessage() {},
    chatBroadcast: (sessionId, message) => {
      frames.push({ sessionId, message });
      const text = message?.message?.content?.[0]?.text;
      if (text) pushes.push({ sessionId, text });
    },
    loadChatHistory: () => [],
  });
  const admissions = () => frames.filter(f => f.message?.type === 'voice_admission').map(f => f.message);
  return { frames, host, pushes, records, admissions };
}

test('a voice turn that dispatches reports admission with an operation id and nothing else', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-1', 'req-1');

  const frames = fixture.admissions();
  assert.equal(frames.length, 1, 'exactly one terminal frame per turn');
  const frame = frames[0];
  assert.equal(frame.version, 1);
  assert.equal(frame.requestId, 'req-1');
  assert.equal(frame.turnId, 'turn-1');
  assert.equal(frame.gatewaySessionId, VOICE_ROUTER_ID);
  assert.equal(frame.outcome, 'admitted');
  assert.equal(frame.operationId, 'op-voice-1');
  assert.equal(frame.duplicate, false);
  assert.equal(frame.queueStatus, 'admitted');
  assert.equal(frame.error, null);
  assert.equal(frame.speechText, '好的，我让一号项目的 Commander 去查。');

  // The payload is an outcome, not a copy of the work.
  const serialized = JSON.stringify(frame);
  assert.doesNotMatch(serialized, /dispatch/i, 'the marker itself never travels in the outcome frame');
  assert.equal(serialized.includes(DISPATCH_MESSAGE), false, 'the dispatch instruction never travels');
  assert.equal(serialized.includes('commander-1'), false, 'a target session id is never disclosed');
  assert.equal(serialized.includes('/tmp/fleet-one'), false, 'no cwd travels');
  assert.equal(frame.targetLabel, 'Fleet 一 Commander', 'a human label is the most that may be named');

  assert.equal(fixture.pushes.at(-1).sessionId, VOICE_ROUTER_ID);
  assert.match(fixture.pushes.at(-1).text, /已提交给/);
});

test('the structured frame is broadcast before the prose push that also carries a result', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-order', 'req-order');
  const kinds = fixture.frames.map(f => (f.message?.type === 'voice_admission' ? 'admission' : 'prose'));
  assert.equal(kinds.indexOf('admission') >= 0, true);
  assert.ok(
    kinds.indexOf('admission') < kinds.indexOf('prose'),
    'a caller waiting on the outcome must hold it before the push that ends its turn',
  );
});

test('a turn with no marker states no_dispatch instead of going silent', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete('这个功能已经在上一版做完了。', VOICE_ROUTER_ID, 'turn-2', 'req-2');
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'no_dispatch');
  assert.equal(frame.operationId, null, 'nothing was admitted, so nothing has an operation id');
  assert.equal(frame.queueStatus, null);
  assert.equal(frame.error, null);
  assert.equal(frame.speechText, '这个功能已经在上一版做完了。');
});

test('an idempotent replay is still an admission, and is flagged as a duplicate', async () => {
  const fixture = hostFixture();
  // Same turn id (so the durable key matches) reached through a second request —
  // what a reconnecting bridge produces.
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-3', 'req-3a');
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-3', 'req-3b');
  const frames = fixture.admissions();
  assert.deepEqual(frames.map(f => f.outcome), ['admitted', 'admitted']);
  assert.deepEqual(frames.map(f => f.duplicate), [false, true]);
  assert.deepEqual(frames.map(f => f.operationId), ['op-voice-1', 'op-voice-1']);
});

test('the same request is never answered twice', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-4', 'req-4');
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-4', 'req-4');
  assert.equal(fixture.admissions().length, 1, 'exactly-once per (session, turn, request)');
});

test('an unroutable target is reported as rejected without naming the target id', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete(
    '<<dispatch target="ghost-9">干活</dispatch>>',
    VOICE_ROUTER_ID,
    'turn-5',
    'req-5',
  );
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'rejected');
  assert.equal(frame.operationId, null);
  assert.equal(frame.error.code, 'dispatch_target_rejected');
  assert.equal(frame.error.retryable, false);
  assert.equal(frame.error.publicMessage.includes('ghost-9'), false);
  // The operator-facing push keeps the detail the spoken frame withholds.
  assert.match(fixture.pushes.at(-1).text, /无法分发/);
});

test('an admission that throws is reported as failed and retryable, never as submitted', async () => {
  const fixture = hostFixture({ admit: async () => { throw new Error('durable store offline'); } });
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-6', 'req-6');
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'failed');
  assert.equal(frame.operationId, null);
  assert.equal(frame.error.code, 'dispatch_error');
  assert.equal(frame.error.retryable, true);
  assert.equal(JSON.stringify(frame).includes('durable store offline'), false, 'internal errors stay internal');
});

test('an admission without an operation id is not an admission', async () => {
  const fixture = hostFixture({
    admit: async () => ({ id: '', status: 'admitted', createdAt: 1, idempotent: false }),
  });
  await fixture.host.handleGatewayTurnComplete(MARKER_TURN, VOICE_ROUTER_ID, 'turn-7', 'req-7');
  const frame = fixture.admissions()[0];
  assert.equal(frame.outcome, 'failed');
  assert.equal(frame.error.code, 'operation_id_missing');
});

test('the WeChat gateway emits no voice outcome frame', async () => {
  const fixture = hostFixture();
  await fixture.host.handleGatewayTurnComplete('闲聊', fixture.host.GATEWAY_ID, 'wechat-1', 'req-w1');
  await fixture.host.handleGatewayTurnComplete(
    '<<dispatch target="chat-1">派活</dispatch>>',
    fixture.host.GATEWAY_ID,
    'wechat-2',
    'req-w2',
  );
  assert.equal(fixture.admissions().length, 0, 'the structured frame belongs to the live voice channel only');
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

function okJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Launch mode (the one machine-wide child): no directoryId, and the routing
// target is resolved per utterance from the launch id in the prompt envelope.
function launchHarness({ scope = 'global' } = {}) {
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
    if (url.includes('/queue/action')) return okJson({ ok: true });
    throw new Error(`unexpected request: ${url}`);
  };
  const bridge = createVoiceAcpBridge({
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    randomUUID: (() => {
      let value = 0;
      return () => `uuid-${++value}`;
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
    assert.ok(entry, 'a structured turn must arm its bounded wait');
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

  turn.socket.serverSend({ type: 'result' });
  turn.socket.serverSend(admissionFrame(turn, { speechText: '' }));
  const result = await turn.promise;

  assert.equal(result.stopReason, 'end_turn');
  const spoken = turn.spoken();
  assert.equal(spoken, '好的，我让一号项目的 Commander 去查。');
  assert.doesNotMatch(spoken, /<<|dispatch|>>/i);
  assert.equal(spoken.includes(DISPATCH_MESSAGE), false);
  assert.equal(spoken.includes('commander-1'), false);
});

test('a turn cut off mid-marker still says nothing about the marker', () => {
  assert.equal(speakableFromBuffer('好的。\n<<dispatch target="comm'), '好的。');
  assert.equal(speakableFromBuffer('好的。\n<<dispa'), '好的。');
  assert.equal(speakableFromBuffer('好的。\n<<'), '好的。');
  assert.equal(speakableFromBuffer(MARKER_TURN), '好的，我让一号项目的 Commander 去查。');
  assert.equal(speakableFromBuffer('普通回答'), '普通回答');
});

test('the turn settles when the result lands first, and when the outcome lands first', async () => {
  for (const order of ['result-first', 'outcome-first']) {
    const harness = launchHarness();
    const turn = await startTurn(harness);
    turn.socket.serverSend({
      type: 'assistant',
      message: { content: [{ type: 'text', text: MARKER_TURN }] },
    });

    if (order === 'result-first') {
      turn.socket.serverSend({ type: 'result', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(turn.isSettled(), false, `${order}: a result alone is only half the answer`);
      turn.socket.serverSend(admissionFrame(turn));
    } else {
      turn.socket.serverSend(admissionFrame(turn));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(turn.isSettled(), false, `${order}: an outcome alone is only half the answer`);
      turn.socket.serverSend({ type: 'result', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
    }

    const result = await turn.promise;
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.usage, { totalTokens: 5, inputTokens: 2, outputTokens: 3 });
    assert.equal(turn.spoken(), '好的，我让一号项目的 Commander 去查。');
    assert.equal(turn.chunks().length, 1, `${order}: a buffered turn speaks exactly once`);
  }
});

test('an outcome frame for another request, turn or version cannot settle this turn', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER_TURN }] } });
  turn.socket.serverSend({ type: 'result' });
  await new Promise(resolve => setImmediate(resolve));

  turn.socket.serverSend(admissionFrame(turn, { requestId: 'someone-elses-request' }));
  turn.socket.serverSend(admissionFrame(turn, { version: 2 }));
  turn.socket.serverSend(admissionFrame(turn, { requestId: '' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false, 'a mismatched envelope is not this turn’s answer');

  turn.socket.serverSend(admissionFrame(turn, { outcome: 'admitted' }));
  // A duplicate — and a late frame from a different turn on the same socket —
  // must not speak again or re-finish the turn.
  turn.socket.serverSend(admissionFrame(turn, { outcome: 'failed', speechText: '重复帧' }));
  turn.socket.serverSend(admissionFrame(turn, { turnId: 'turn-2', speechText: '另一个 turn' }));
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(turn.chunks().length, 1);
  assert.equal(turn.spoken(), '好的，我让一号项目的 Commander 去查。');
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

test('a bounded wait that expires reports uncertainty and never claims non-delivery', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  turn.socket.serverSend({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER_TURN }] } });
  turn.socket.serverSend({ type: 'result' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turn.isSettled(), false);

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

test('a cancelled turn whose host never answers still ends, rather than hanging the call', async () => {
  const harness = launchHarness();
  const turn = await startTurn(harness);
  await harness.bridge.cancel({ sessionId: turn.created.sessionId });
  harness.fireTimeout();
  const result = await turn.promise;
  assert.equal(result.stopReason, 'cancelled');
});

test('a chat-scoped voice turn keeps streaming word by word and needs no outcome frame', async () => {
  const harness = launchHarness({ scope: 'chat' });
  const turn = await startTurn(harness, { text: '把这一段改成中文' });
  turn.socket.serverSend({ type: 'assistant', message: { textSnapshot: true, content: [{ type: 'text', text: '好' }] } });
  turn.socket.serverSend({ type: 'assistant', message: { textSnapshot: true, content: [{ type: 'text', text: '好的' }] } });
  turn.socket.serverSend({ type: 'assistant', message: { textSnapshot: true, content: [{ type: 'text', text: '好的，改完了' }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(turn.chunks(), ['好', '的', '，改完了'], 'chat scope is unchanged: it streams');

  turn.socket.serverSend({ type: 'result' });
  const result = await turn.promise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(harness.timers.length, 0, 'chat scope arms no admission wait — it has no admission to wait for');
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

  // The global path is the only one that goes through the router — which is the
  // only session that gets a routing prompt and can therefore emit a marker.
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
    '好的，我让一号项目的 Commander 去查。',
    'without the Host’s text the local buffer is stripped locally',
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
    '今天没有待办。',
    'a turn with nothing pending has nothing to be uncertain about',
  );
});

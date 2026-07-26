'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  EXPERIMENT_MODE,
  createTuiChatMirrorRuntime,
  findRolloutFile,
  projectRecord,
  readFirstLine,
  validateExperimentalSession,
} = require('../src/experiments/tui-chat-mirror-runtime');

function temporaryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-tui-mirror-'));
  const cwd = path.join(root, 'workspace');
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });
  return { root, cwd, sessionsRoot };
}

function writeRollout(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('condition timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.isAlive = false;
    this.closed = false;
  }
  close() { this.closed = true; this.emit('close'); }
}

test('experimental session marker is fail-closed and codex-chat only', () => {
  assert.deepEqual(validateExperimentalSession({
    enabled: false,
    cli: 'codex',
    kind: 'chat',
    experimentalMode: EXPERIMENT_MODE,
  }), {
    ok: false,
    error: 'MULTICC_EXPERIMENT_TUI_CHAT=1 is required for tui-chat-mirror',
  });
  assert.equal(validateExperimentalSession({
    enabled: true,
    cli: 'claude',
    kind: 'chat',
    experimentalMode: EXPERIMENT_MODE,
  }).ok, false);
  assert.deepEqual(validateExperimentalSession({
    enabled: true,
    cli: 'codex',
    kind: 'chat',
    experimentalMode: EXPERIMENT_MODE,
  }), { ok: true, mode: EXPERIMENT_MODE });
  assert.deepEqual(validateExperimentalSession({
    enabled: false,
    cli: 'claude',
    kind: 'terminal',
    experimentalMode: null,
  }), { ok: true, mode: null });
});

test('rollout discovery supports Codex session_meta lines larger than 64 KiB', () => {
  const fixture = temporaryFixture();
  const file = path.join(fixture.sessionsRoot, '2026', '07', 'rollout.jsonl');
  const meta = {
    type: 'session_meta',
    payload: {
      id: 'native-large-meta',
      cwd: fixture.cwd,
      base_instructions: 'x'.repeat(96 * 1024),
    },
  };
  writeRollout(file, [meta]);
  assert.equal(JSON.parse(readFirstLine(file)).payload.id, 'native-large-meta');
  assert.equal(findRolloutFile({
    sessionsRoot: fixture.sessionsRoot,
    cwd: fixture.cwd,
    nativeSessionId: null,
    sinceMs: 0,
  }), file);
});

test('native rollout records map to stable chat semantics', () => {
  const start = projectRecord({
    timestamp: '2026-07-26T00:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  });
  const tool = projectRecord({
    timestamp: '2026-07-26T00:00:01.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}' },
  }, 'turn-1');
  const result = projectRecord({
    timestamp: '2026-07-26T00:00:02.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: '/tmp' },
  }, 'turn-1');
  assert.equal(start.kind, 'turn_start');
  assert.equal(start.turnId, 'turn-1');
  assert.equal(tool.kind, 'tool_start');
  assert.equal(tool.callId, 'call-1');
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.callId, 'call-1');
  assert.equal(projectRecord({
    timestamp: '2026-07-26T00:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: {} },
  }), null);
});

test('MultiCC chat input is injected once into TUI and native tool events project once', async t => {
  const fixture = temporaryFixture();
  const rollout = path.join(fixture.sessionsRoot, '2026', '07', 'rollout.jsonl');
  const nativeId = 'native-tui-test';
  const meta = {
    timestamp: '2026-07-26T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: nativeId,
      cwd: fixture.cwd,
      base_instructions: 'x'.repeat(70 * 1024),
    },
  };
  writeRollout(rollout, [meta]);

  const records = new Map([['exp-chat', {
    id: 'exp-chat',
    cli: 'codex',
    kind: 'chat',
    experimentalMode: EXPERIMENT_MODE,
  }]]);
  const writes = [];
  const sent = [];
  const statuses = [];
  const runtime = createTuiChatMirrorRuntime({
    enabled: true,
    records,
    sessionsRoot: fixture.sessionsRoot,
    cwdForSession: () => fixture.cwd,
    providerFor: () => ({ buildTerminalCmd: () => 'codex' }),
    send: (ws, payload) => { sent.push(payload); ws.last = payload; },
    setSessionStatus: (id, value) => statuses.push({ id, ...value }),
    saveBestEffort: () => {},
    tmux: {
      async tmuxHasSession() { return false; },
      async tmuxCreateSession() { return true; },
      async tmuxWriteInput(id, value) { writes.push({ id, value }); return true; },
    },
  });
  t.after(() => runtime.stop());

  const ws = new FakeWs();
  const handled = await runtime.handleWs(ws, {}, new URL('http://localhost/ws/chat?session=exp-chat'));
  assert.equal(handled, true);
  assert.equal(sent[0].type, 'system');
  assert.equal(sent[0].experimentalMode, EXPERIMENT_MODE);

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'user_message',
    text: 'run the read-only probe',
    clientMsgId: 'client-1',
  })));
  await waitFor(() => writes.length === 2);
  assert.deepEqual(writes.map(item => item.value), ['run the read-only probe', '\r']);
  assert.equal(sent.filter(item => item.type === 'session_queue').length, 1);

  fs.appendFileSync(rollout, [
    {
      timestamp: '2026-07-26T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    },
    {
      timestamp: '2026-07-26T00:00:01.100Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'run the read-only probe' },
    },
    {
      timestamp: '2026-07-26T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec_command', input: '{"cmd":"pwd"}' },
    },
    {
      timestamp: '2026-07-26T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: fixture.cwd },
    },
    {
      timestamp: '2026-07-26T00:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'probe complete' },
    },
    {
      timestamp: '2026-07-26T00:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 4000 },
    },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');

  await waitFor(() => sent.some(item => item.type === 'result'));
  assert.equal(sent.filter(item => item.type === 'session_queue').length, 1);
  assert.equal(sent.filter(item => item.type === 'assistant'
    && item.message?.content?.some(block => block.type === 'tool_use')).length, 1);
  assert.equal(sent.filter(item => item.type === 'user'
    && item.message?.content?.some(block => block.type === 'tool_result')).length, 1);
  assert.equal(sent.filter(item => item.type === 'result').length, 1);
  assert.equal(statuses.at(-1).status, 'idle');
  assert.equal(records.get('exp-chat').cliSessionId, nativeId);
});

test('business input waits behind the explicit Codex worktree trust handshake', async t => {
  const fixture = temporaryFixture();
  const records = new Map([['trust-chat', {
    id: 'trust-chat',
    cli: 'codex',
    kind: 'chat',
    experimentalMode: EXPERIMENT_MODE,
  }]]);
  let pane = 'Do you trust the contents of this directory?';
  const writes = [];
  const sent = [];
  const runtime = createTuiChatMirrorRuntime({
    enabled: true,
    records,
    sessionsRoot: fixture.sessionsRoot,
    cwdForSession: () => fixture.cwd,
    providerFor: () => ({ buildTerminalCmd: () => 'codex' }),
    send: (ws, payload) => sent.push(payload),
    tmux: {
      async tmuxHasSession() { return false; },
      async tmuxCreateSession() { return true; },
      async tmuxCapturePane() { return pane; },
      async tmuxWriteInput(id, value) { writes.push(value); return true; },
    },
  });
  t.after(() => runtime.stop());
  const ws = new FakeWs();
  await runtime.handleWs(ws, {}, new URL('http://localhost/ws/chat?session=trust-chat'));
  await waitFor(() => sent.some(item => item.type === 'user_input_required'));

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'user_message',
    text: 'do not inject before ready',
    clientMsgId: 'business-1',
  })));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(writes, []);

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'user_message',
    text: 'Yes, continue',
    clientMsgId: 'trust-answer-1',
    userInputRequestId: 'tui-trust:trust-chat',
  })));
  await waitFor(() => writes.length === 2);
  assert.deepEqual(writes, ['1', '\r']);

  pane = [
    'Do you trust the contents of this directory?',
    'OpenAI Codex (v0.145.0)',
    '› Implement {feature}',
  ].join('\n');
  await waitFor(() => writes.length >= 4);
  assert.deepEqual(writes, ['1', '\r', 'do not inject before ready', '\r']);
});

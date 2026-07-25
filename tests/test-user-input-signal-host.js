'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  USER_INPUT_SIGNAL_PROMPT,
  buildCodexUserInputConstraint,
  buildAdapterUserInputSignal,
  recordAdapterUserInput,
  createUserInputSignalHost,
} = require('../src/classify/user-input-host');
const { createCodexAdapter } = require('../src/cli-adapters/codex');

function fixture() {
  const states = new Map([['chat-1', {
    classifyState: 'C',
    goal: '发布版本',
    phase: 'verifying',
    pendingUserInput: null,
  }]]);
  const sessions = new Map([['chat-1', {
    isStreaming: true,
    _activeTurn: { turnId: 'turn-1' },
    _currentTaskId: 'task-1',
  }]]);
  const host = createUserInputSignalHost({
    getSession: id => sessions.get(id),
    getState: id => states.get(id),
    setState: (id, patch) => {
      const next = { ...(states.get(id) || {}), ...patch };
      states.set(id, next);
      return next;
    },
    now: () => 1234,
  });
  return { host, sessions, states };
}

test('records, deduplicates, and rejects stale request_user_input signals', () => {
  const { host, sessions, states } = fixture();
  const signal = {
    requestId: 'usrq-1',
    sessionId: 'chat-1',
    turnId: 'turn-1',
    question: '是否发布？',
    options: ['发布', '取消'],
  };
  assert.deepEqual(host.record(signal), { ok: true, duplicate: false });
  assert.deepEqual(host.record(signal), { ok: true, duplicate: true });
  assert.deepEqual(states.get('chat-1').pendingUserInput, {
    requestId: 'usrq-1',
    turnId: 'turn-1',
    taskId: 'task-1',
    question: '是否发布？',
    reason: '',
    options: ['发布', '取消'],
    allowMultiple: false,
    createdAt: 1234,
    resolved: false,
  });
  assert.equal(host.record({ ...signal, requestId: 'usrq-2' }).code,
    'user_input_already_pending');
  sessions.get('chat-1')._activeTurn.turnId = 'turn-2';
  assert.equal(host.record({ ...signal, requestId: 'usrq-3' }).code,
    'turn_not_active');
});

test('real user turn clears pending signal while automatic continuation preserves it', () => {
  const { host, states } = fixture();
  states.get('chat-1').pendingUserInput = { requestId: 'usrq-1' };
  host.beginTurn('chat-1', { originContinue: true, turnId: 'turn-auto' });
  assert.equal(states.get('chat-1').pendingUserInput.requestId, 'usrq-1');
  host.beginTurn('chat-1', { originContinue: false, turnId: 'turn-user' });
  assert.equal(states.get('chat-1').pendingUserInput, null);
  assert.equal(states.get('chat-1').classifyState, 'P');
  assert.equal(states.get('chat-1').userInputSignalTurnId, 'turn-user');
});

test('structured signal overrides Aux state and provides degraded W fallback', () => {
  const { host, states } = fixture();
  const completed = {
    state: 'completed', goal: '发布版本', phase: 'done',
    background: false, error: false,
  };
  assert.equal(host.apply('chat-1', completed), completed);
  states.get('chat-1').pendingUserInput = {
    requestId: 'usrq-1', resolved: false,
  };
  const effective = host.apply('chat-1', completed);
  assert.equal(effective.state, 'waiting');
  assert.equal(effective.evidence, 'request_user_input');
  assert.deepEqual(host.degradedResult('chat-1', {
    goal: '发布版本',
    phase: 'wrapping',
  }), {
    state: 'waiting',
    goal: '发布版本',
    phase: 'wrapping',
    background: false,
    error: false,
  });
});

test('a correlated answer resolves the pending request once and continuation keeps the evidence', () => {
  const { host, states } = fixture();
  states.get('chat-1').pendingUserInput = {
    requestId: 'usrq-1',
    turnId: 'turn-1',
    taskId: 'task-1',
    question: '是否发布？',
    resolved: false,
  };
  assert.deepEqual(host.resolve('chat-1', 'wrong'), {
    ok: false,
    code: 'request_id_mismatch',
  });
  assert.equal(states.get('chat-1').pendingUserInput.resolved, false);
  assert.deepEqual(host.resolve('chat-1', 'usrq-1'), {
    ok: true,
    duplicate: false,
  });
  assert.equal(states.get('chat-1').pendingUserInput.resolved, true);
  assert.equal(states.get('chat-1').pendingUserInput.resolvedAt, 1234);
  assert.deepEqual(host.resolve('chat-1', 'usrq-1'), {
    ok: true,
    duplicate: true,
  });
  host.beginTurn('chat-1', { originContinue: true, turnId: 'turn-answer' });
  assert.equal(states.get('chat-1').pendingUserInput.requestId, 'usrq-1');
  assert.equal(states.get('chat-1').pendingUserInput.resolved, true);
  assert.equal(host.apply('chat-1', {
    state: 'completed',
    background: false,
    error: false,
  }).state, 'completed');
});

test('prompt directs models to the MCP signal, not the unavailable built-in', () => {
  assert.match(USER_INPUT_SIGNAL_PROMPT.join('\n'), /MCP.*request_user_input/);
  const codex = buildCodexUserInputConstraint(true);
  assert.match(codex, /内置 request_user_input/);
  assert.match(codex, /MultiCC MCP/);
  assert.equal(buildCodexUserInputConstraint(false), '');
});

test('buildAdapterUserInputSignal sanitizes and yields an MCP-shaped requestId', () => {
  const sig = buildAdapterUserInputSignal({
    sessionId: 'chat-1', turnId: 'turn-1',
    question: '  用哪个环境？  ', reason: 'need decision',
    options: [' 生产 ', '生产', '', '预发'], allowMultiple: true,
  });
  assert.match(sig.requestId, /^usrq-[0-9a-f]{24}$/);
  assert.equal(sig.question, '用哪个环境？');
  assert.deepEqual(sig.options, ['生产', '预发']); // trimmed + deduped
  assert.equal(sig.allowMultiple, true);
  // Deterministic: same inputs → same id (dedup/resolve parity with MCP path).
  assert.equal(buildAdapterUserInputSignal({
    sessionId: 'chat-1', turnId: 'turn-1', question: '用哪个环境？',
    reason: 'need decision', options: ['生产', '预发'], allowMultiple: true,
  }).requestId, sig.requestId);
});

test('buildAdapterUserInputSignal returns null without a usable question', () => {
  assert.equal(buildAdapterUserInputSignal({ sessionId: 'c', turnId: 't', question: '   ' }), null);
  // allow_multiple with <2 options is downgraded, not accepted (mirrors MCP guard).
  assert.equal(buildAdapterUserInputSignal({
    sessionId: 'c', turnId: 't', question: 'q', options: ['only'], allowMultiple: true,
  }).allowMultiple, false);
});

test('recordAdapterUserInput lands on the record port and degrades on failure', () => {
  const calls = [];
  const okRec = recordAdapterUserInput({
    evt: { question: '继续吗？', options: ['是', '否'], fallbackText: 'FT' },
    sessionId: 'chat-1', turnId: 'turn-1',
    recordInput: (s) => { calls.push(s); return { ok: true }; },
  });
  assert.equal(okRec.ok, true);
  assert.match(okRec.requestId, /^usrq-/);
  assert.equal(okRec.fallbackText, '');
  assert.equal(calls[0].question, '继续吗？');
  assert.deepEqual(calls[0].options, ['是', '否']);

  const failRec = recordAdapterUserInput({
    evt: { question: '继续吗？', fallbackText: 'FALLBACK' },
    sessionId: 'chat-1', turnId: 'turn-1',
    recordInput: () => ({ ok: false, code: 'user_input_already_pending' }),
  });
  assert.equal(failRec.ok, false);
  assert.equal(failRec.requestId, null);
  assert.equal(failRec.fallbackText, 'FALLBACK'); // question is never lost
});

test('codex adapter decodes built-in AskUserQuestion into a user_input_signal', () => {
  const adapter = createCodexAdapter({});
  const out = adapter.decodeEvent({
    type: 'item.completed',
    item: {
      type: 'function_call', name: 'AskUserQuestion',
      arguments: JSON.stringify({ questions: [{
        header: '部署环境', question: '用哪个环境？',
        options: [{ label: '生产', description: 'prod' }, { label: '预发' }],
      }] }),
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'user_input_signal');
  assert.equal(out[0].toolName, 'AskUserQuestion');
  assert.match(out[0].question, /用哪个环境？/);
  assert.deepEqual(out[0].options, ['生产', '预发']);
  assert.match(out[0].fallbackText, /文本透传/); // degradation text retained
  // End-to-end: a decoded signal, recorded, produces an MCP-shaped requestId.
  const rec = recordAdapterUserInput({
    evt: out[0], sessionId: 'chat-1', turnId: 'turn-1',
    recordInput: () => ({ ok: true }),
  });
  assert.equal(rec.ok, true);
  assert.match(rec.requestId, /^usrq-/);
});

test('codex adapter still passes through malformed ask arguments as text', () => {
  const adapter = createCodexAdapter({});
  const out = adapter.decodeEvent({
    type: 'item.completed',
    item: { type: 'function_call', name: 'request_user_input', arguments: 'not json{' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'user_input_signal');
  assert.equal(out[0].question, 'not json{');
  assert.match(out[0].fallbackText, /not json\{/);
});

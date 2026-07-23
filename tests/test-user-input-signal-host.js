'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  USER_INPUT_SIGNAL_PROMPT,
  buildCodexUserInputConstraint,
  createUserInputSignalHost,
} = require('../src/classify/user-input-host');

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

test('prompt directs models to the MCP signal, not the unavailable built-in', () => {
  assert.match(USER_INPUT_SIGNAL_PROMPT.join('\n'), /MCP.*request_user_input/);
  const codex = buildCodexUserInputConstraint(true);
  assert.match(codex, /内置 request_user_input/);
  assert.match(codex, /MultiCC MCP/);
  assert.equal(buildCodexUserInputConstraint(false), '');
});

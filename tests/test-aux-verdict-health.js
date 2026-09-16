'use strict';

// A judgement is only worth showing while Aux is still revising it. When Aux is
// unhealthy the last verdict stops changing, and every surface that keeps
// rendering it — chat bar, Air deck, roster cards, app dashboard — was
// presenting a stale goal as "what the assistant currently thinks this session
// is doing". These tests pin the fact that travels with the verdict, and the
// two ways it reaches the wire: the shared session view and the workspace
// `task_state` broadcast.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  installAuxHealthProvider,
  auxVerdictStaleness,
  fanOutAuxVerdictStaleness,
} = require('../src/classify/aux-verdict-health');
const { taskStateSeed } = require('../src/chat/task-state-seed');
const { workspaceEntry } = require('../src/session/workspace-service');
const { createWorkspaceRuntime } = require('../src/workspace/runtime');

function withHealth(health, run) {
  installAuxHealthProvider(typeof health === 'function' ? health : () => health);
  try {
    return run();
  } finally {
    installAuxHealthProvider(null);
  }
}

test('a process with no installed Aux health source reads healthy', () => {
  // Unit tests and one-off scripts share this module; "no Aux at all" must not
  // be reported as an unhealthy one, or every such caller paints a stale marker.
  assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
  installAuxHealthProvider(null);
  assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
});

test('an unhealthy Aux is reported with the start of the episode', () => {
  withHealth({ unhealthy: true, sinceAt: 1_700_000_000_000 }, () => {
    assert.deepEqual(auxVerdictStaleness(),
      { auxUnhealthy: true, auxUnhealthySince: 1_700_000_000_000 });
  });
});

test('recovery clears the mark, and a broken source cannot fake one', () => {
  withHealth({ unhealthy: false }, () => {
    assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
  });
  withHealth({ unhealthy: true }, () => {
    // No `sinceAt` yet: still stale, just without a start time to show.
    assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: true, auxUnhealthySince: null });
  });
  withHealth(() => { throw new Error('queue torn down mid-read'); }, () => {
    assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
  });
  withHealth('not-an-object', () => {
    assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
  });
});

test('the workspace entry carries the pair without inventing a start time', () => {
  const stale = workspaceEntry({ id: 's1' }, { goal: '排查电量消耗增加原因', status: 'running',
    auxUnhealthy: true, auxUnhealthySince: 1_700_000_000_000 });
  assert.equal(stale.auxUnhealthy, true);
  assert.equal(stale.auxUnhealthySince, 1_700_000_000_000);
  assert.equal(stale.goal, '排查电量消耗增加原因', 'the judgement itself survives');

  // A truthy-but-not-`true` flag is not staleness; a non-numeric instant is not
  // a time. Both degrade to "nothing to report" rather than to a bogus date.
  assert.equal(workspaceEntry({ id: 's1' }, {}).auxUnhealthy, false);
  assert.equal(workspaceEntry({ id: 's1' }, { auxUnhealthy: 'yes' }).auxUnhealthy, false);
  assert.equal(workspaceEntry({ id: 's1' }, { auxUnhealthy: true, auxUnhealthySince: 'soon' })
    .auxUnhealthySince, null);
});

test('the connect seed carries the judgement and its freshness, or says nothing', () => {
  withHealth({ unhealthy: true, sinceAt: 1_700_000_000_000 }, () => {
    // A page can open in the middle of an outage, and nothing else will arrive
    // to correct it: this frame is its only chance to know the verdict is frozen.
    const { taskShortCode: code, ...rest } = taskStateSeed({ goal: '排查电量消耗增加原因',
      taskId: 't1', phase: 'implementation', classifyState: 'C' });
    assert.ok(code, 'the outward task handle must be minted, not omitted');
    assert.deepEqual(rest, {
      type: 'task_state', goal: '排查电量消耗增加原因',
      phase: 'implementation', classifyState: 'C',
      auxUnhealthy: true, auxUnhealthySince: 1_700_000_000_000,
    });
  });
  // No judgement yet: seeding an empty bar would render a goal-less bar.
  assert.equal(taskStateSeed({ phase: 'idle', classifyState: null }), null);
  assert.equal(taskStateSeed(null), null);
  // A phase is a judgement too — a running turn with no attributed goal still
  // shows progress in the bar.
  assert.equal(taskStateSeed({ phase: 'implementation' })?.phase, 'implementation');
});

test('the health transition fan-out skips what cannot show a judgement', () => {
  installAuxHealthProvider(() => ({ unhealthy: true, sinceAt: 5 }));
  const told = [];
  const chats = [];
  const workspaces = [];
  const sessions = new Map([
    ['judged', { id: 'judged', dirId: 'd1', taskState: { goal: 'g', classifyState: 'C' } }],
    ['bare', { id: 'bare', dirId: 'd1', taskState: {} }],
    ['aux', { id: 'aux', type: 'aux', dirId: 'd1', taskState: { goal: 'g' } }],
    ['gateway', { id: 'gateway', type: 'gateway', taskState: { goal: 'g' } }],
    ['homeless', { id: 'homeless', taskState: { classifyState: 'P' } }],
  ]);
  try {
    const count = fanOutAuxVerdictStaleness({
      sessions,
      getTaskState: record => record.taskState || {},
      chatBroadcast: (sessionId, payload) => { told.push(sessionId); chats.push(payload); },
      workspaceBroadcast: (dirId, payload) => workspaces.push({ dirId, payload }),
    });
    assert.equal(count, 2, 'the judged session and the session without a directory');
    assert.deepEqual(told, ['judged', 'homeless']);
    assert.deepEqual(chats[0],
      { type: 'aux_verdict_staleness', auxUnhealthy: true, auxUnhealthySince: 5 });
    // The workspace copy is addressed to one session; the chat copy is not.
    assert.deepEqual(workspaces, [{ dirId: 'd1', payload: { ...chats[0], sessionId: 'judged' } }]);
  } finally {
    installAuxHealthProvider(null);
  }
  // Recovery is the same broadcast with the flag cleared — a page must be able
  // to take the marker down, not only put it up.
  assert.deepEqual(auxVerdictStaleness(), { auxUnhealthy: false, auxUnhealthySince: null });
});

test('the workspace task_state broadcast carries the pair to every client', () => {
  const records = new Map([
    ['s1', { id: 's1', dirId: 'd1', taskState: { classifyState: 'P', goal: '排查电量消耗增加原因' } }],
  ]);
  const directories = new Map([['d1', { id: 'd1', label: 'One' }]]);
  const messages = [];
  const runtime = createWorkspaceRuntime({
    records,
    directories,
    chatSessions: new Map(),
    sessionView: id => (id === 's1' ? {
      classifyState: 'P', goal: '排查电量消耗增加原因', phase: 'implementation',
      taskShortCode: '6TFD', status: 'running', stateSource: null,
      auxUnhealthy: true, auxUnhealthySince: 1_700_000_000_000,
    } : null),
    workspaceSnapshot: () => [],
    recentEvents: () => [],
    mergeState: () => null,
    send: (socket, payload) => socket.messages.push(payload),
    broadcastClients: (clients, payload) => { for (const socket of clients) messages.push(payload); },
    setTaskState: () => {},
    saveBestEffort: () => {},
    clock: () => 1000,
  });
  const socket = { messages: [], on() {}, close() {}, isAlive: false };
  assert.equal(runtime.attachWorkspace(socket, { searchParams: new URLSearchParams('dirId=d1') }), true);

  runtime.publishSessionView('s1');
  const state = messages.filter(m => m.type === 'task_state').pop();
  assert.equal(state.sessionId, 's1');
  assert.equal(state.goal, '排查电量消耗增加原因');
  assert.equal(state.auxUnhealthy, true);
  assert.equal(state.auxUnhealthySince, 1_700_000_000_000);
  // The queue card is the same projection: a stale judgement is not a queue state.
  assert.equal(messages.some(m => m.type === 'session_queue_status'), true);
});

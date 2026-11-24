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
} = require('../src/native/runtime');
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
      phase: 'implementation', classifyState: 'C', goalState: null,
      apiError: null, cancelledAt: null, cancelReason: null,
      auxUnhealthy: true, auxUnhealthySince: 1_700_000_000_000,
    });
  });
  // The persisted upstream-error envelope rides the seed: api_error_policy
  // events are live-only, so this is a reopened page's only way to re-render
  // the API-error bar. It is also a judgement on its own — an unattributed
  // session whose last turn failed must still seed, or the error is lost.
  {
    const apiError = { provider: 'claude', category: 'network', httpStatus: 502, action: 'fail' };
    const seeded = taskStateSeed({ phase: 'idle', classifyState: 'E', apiError });
    assert.equal(seeded?.apiError, apiError);
    assert.equal(taskStateSeed({ goal: 'g', apiError })?.apiError, apiError);
    // 用户主动停止的轮次：状态仍是 E，但 cancelledAt 让界面说「已取消」。
    const cancelled = taskStateSeed({ goal: 'g', classifyState: 'E', cancelledAt: 123, cancelReason: 'user' });
    assert.deepEqual([cancelled?.cancelledAt, cancelled?.cancelReason], [123, 'user']);
    assert.equal(taskStateSeed({ goal: 'g', cancelReason: 'user' })?.cancelReason, null,
      'a reason without the cancellation itself must not leak');
  }
  // ✅ 的子状态随种子帧下发，聊天栏才能和任务卡说同一个词；乱值不透传。
  assert.equal(taskStateSeed({ goal: 'g', classifyState: 'D', goalState: 'interact' }).goalState, 'interact');
  assert.equal(taskStateSeed({ goal: 'g', classifyState: 'D', goalState: 'bogus' }).goalState, null);
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
    setTaskState: () => {},
    saveBestEffort: () => {},
    clock: () => 1000,
  });
  const socket = {
    messages: [], readyState: 1, bufferedAmount: 0,
    on() {}, close() {}, ping() {}, terminate() {},
    send(data, options, callback) {
      messages.push(JSON.parse(String(data)));
      if (typeof callback === 'function') callback(null);
    },
  };
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

const oldHealth = require('./helpers/legacy-aux-verdict-health');
const liveHealth = { installAuxHealthProvider, auxVerdictStaleness, fanOutAuxVerdictStaleness };

test('same health provider values produce the same two public fields and access order', () => {
  const stamp = { at: 17 };
  function project(api, unhealthy, sinceAt) {
    const reads = [];
    const health = {
      get unhealthy() { reads.push('unhealthy'); return unhealthy; },
      get sinceAt() { reads.push('sinceAt'); return sinceAt; },
      get diagnosis() { assert.fail('private diagnosis was accessed'); },
    };
    api.installAuxHealthProvider(() => { reads.push('provider'); return health; });
    try {
      const value = api.auxVerdictStaleness();
      assert.deepEqual(Object.keys(value), ['auxUnhealthy', 'auxUnhealthySince']);
      if (unhealthy && sinceAt) assert.strictEqual(value.auxUnhealthySince, sinceAt);
      return { value, reads };
    } finally { api.installAuxHealthProvider(null); }
  }
  for (const flag of [false, null, 0, '', true, 1, [], {}]) {
    for (const since of [undefined, null, 0, '', 12345, 'then', stamp]) {
      assert.deepStrictEqual(project(liveHealth, flag, since), project(oldHealth, flag, since));
    }
  }
  for (const source of [null, {}, () => null, () => true, () => Object.assign(() => {}, { unhealthy: true }),
    () => { throw new Error('queue offline'); }]) {
    const read = api => {
      api.installAuxHealthProvider(source);
      try { return api.auxVerdictStaleness(); } finally { api.installAuxHealthProvider(null); }
    };
    assert.deepStrictEqual(read(liveHealth), read(oldHealth));
  }
});

test('same session iterator preserves broadcast selection, sequence, reference sharing and failures', () => {
  const entries = [
    ['empty', null], ['aux', { type: 'aux' }], ['gateway', { type: 'gateway' }],
    ['idle', { task: {} }], ['goal', { dirId: 'dir', task: { goal: 'ship' } }],
    ['class', { dirId: 'dir', task: { classifyState: 'W' } }], ['solo', { task: { goal: 1 } }],
  ];
  function run(api, failChat, failWorkspace, failRead) {
    const trace = [];
    const sentinel = new Error('task lookup failed');
    let shared;
    const tag = Symbol('consumer addition');
    function* sessions() {
      try { yield* entries; } finally { trace.push('iterator closed'); }
    }
    api.installAuxHealthProvider(() => { trace.push('health'); return { unhealthy: true, sinceAt: 17 }; });
    try {
      const count = api.fanOutAuxVerdictStaleness({
        sessions: sessions(),
        getTaskState(record) {
          trace.push(['read', record.task]);
          if (failRead && record === entries[5][1]) throw sentinel;
          return record.task;
        },
        chatBroadcast(id, payload) {
          trace.push(['reused chat payload', shared ? payload === shared : true]);
          shared = payload;
          trace.push(['chat', id, payload.auxUnhealthy, payload.auxUnhealthySince, payload[tag]]);
          payload[tag] = id;
          payload.sessionId = 'from chat';
          if (failChat) throw new Error('chat closed');
        },
        workspaceBroadcast(dir, payload) {
          trace.push(['separate workspace payload', payload !== shared]);
          trace.push(['workspace', dir, payload.sessionId, payload[tag]]);
          if (failWorkspace) throw new Error('workspace closed');
        },
      });
      return { count, trace };
    } catch (error) {
      assert.strictEqual(error, sentinel);
      return { failed: true, trace };
    } finally { api.installAuxHealthProvider(null); }
  }
  for (const chat of [false, true]) for (const workspace of [false, true]) for (const read of [false, true]) {
    const expected = run(oldHealth, chat, workspace, read);
    assert.equal(expected.count, read ? undefined : 3);
    assert.deepStrictEqual(run(liveHealth, chat, workspace, read), expected);
  }
});

'use strict';
// Delivery INTO a held resident Claude turn: "background work is part of the
// turn". These tests pin the thin JS wiring around the Rust predicate
// (native/core/src/background_hold.rs → backgroundHoldMayInject):
//
//   - the delivery worker may only CLAIM an item the predicate would accept
//     (heldTurnInjectable), so a message typed during the held phase reaches
//     deliver() instead of waiting forever behind the busy gate;
//   - the write goes into the same live process, the user row is appended with
//     `heldTurnInjected`, and the outbox item settles exactly once — the
//     delivery identity is registered in Rust BEFORE the write, so a retry
//     after a failed row append re-appends the row and never writes stdin again;
//   - every refusal reason leaves the old waiting behaviour untouched, and a
//     message waiting because its spawn contract changed is announced as
//     waiting for background work — not as a wedged workspace.
//
// The lane-level proof (real CLI child, Agent SDK lane) lives in
// tests/test-monitor-admission.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createOrchestrationRuntime } = require('../src/orchestration/runtime');
const {
  createHeldTurnInjection, spawnContractFacts, spawnContractOf, isDirectUserTyped,
} = require('../src/chat/held-turn-injection');
const { heldBackgroundText, heldCapText, createSessionNotices } = require('../src/chat/session-notices');

const RECORD = {
  cli: 'claude', provider: 'official', providerSelection: { mode: 'auto' },
  model: 'claude-sonnet-4-6', effort: 'high', subagent: null,
  cliAccounts: { official: 'account-1' }, pendingConfiguration: null,
  cliSessionId: 'native-session', _streamSessionId: 'stream-session',
};

const ITEM = {
  id: 'delivery-1',
  sessionId: 'held-session',
  payload: {
    type: 'session.work', workKind: 'task', message: 'what is the status?', source: 'direct',
    options: {}, taskId: null, requestId: null,
  },
};

function live(overrides = {}) {
  return {
    held: true,
    alive: true,
    stale: false,
    // The SDK lane reports which user message each result answers.
    attributable: true,
    contract: spawnContractOf(RECORD),
    ...overrides,
  };
}

function harness({ liveFacts = live(), record = RECORD, active = true, persisted = false,
  written = true, saved = true, text = 'what is the status?' } = {}) {
  const writes = [];
  const appended = [];
  const registered = new Set();
  const held = { ...liveFacts };
  const state = { persisted, saved };
  const injection = createHeldTurnInjection({
    getRecord: id => (id === ITEM.sessionId ? record : null),
    chatStream: {
      heldTurn: id => (id === ITEM.sessionId ? held : null),
      // Same contract as the lane: register first, write once per identity, and
      // answer a retry with 'append_only' without touching stdin.
      injectHeldTurn: (id, value, identity) => {
        if (written === false) return { delivered: false, reason: 'write_failed' };
        if (registered.has(identity)) return { delivered: true, appendOnly: true, identity };
        registered.add(identity);
        writes.push({ id, value, identity, text });
        return { delivered: true, identity };
      },
    },
    isRunActive: id => (id === ITEM.sessionId ? active : false),
    appendMessage: (id, message) => { if (state.saved) appended.push({ id, message }); return state.saved; },
    activeTurnId: () => 'turn-9',
    hasPersistedDelivery: async () => state.persisted,
    log: () => {},
  });
  return { injection, writes, appended, held, registered,
    setHeld: next => Object.assign(held, next),
    setPersisted: value => { state.persisted = value; },
    setSaved: value => { state.saved = value; } };
}

// ── the persisted facts that decide WHICH process serves a turn ─────────────
test('the spawn contract is the persisted record, not host state', () => {
  const facts = spawnContractFacts(RECORD);
  assert.deepEqual(facts, {
    cli: 'claude', provider: 'official', providerSelection: { mode: 'auto' },
    model: 'claude-sonnet-4-6', effort: 'high', subagent: null,
    cliAccounts: { official: 'account-1' }, pendingConfiguration: null,
    nativeSessionId: 'native-session',
  });
  assert.equal(spawnContractFacts(null), null);
  assert.equal(spawnContractOf(null), null);
  assert.match(spawnContractOf(RECORD), /^[0-9a-f]{64}$/);
  // The stream session id is only a fallback for a not-yet-established native id.
  const { cliSessionId, ...withoutNative } = RECORD;
  assert.match(spawnContractOf({ ...withoutNative }), /^[0-9a-f]{64}$/);
  assert.equal(spawnContractOf(withoutNative), spawnContractOf({ ...withoutNative, _streamSessionId: 'stream-session' }));
  // Staged changes are the next-spawn signal while the turn is busy.
  assert.notEqual(spawnContractOf({ ...RECORD, pendingConfiguration: { model: 'other' } }),
    spawnContractOf(RECORD));
});

test('only a message the human typed directly may go into the turn', () => {
  const typed = (payload = {}, opts = {}) => isDirectUserTyped({ ...ITEM, payload: { ...ITEM.payload, ...payload } }, opts);
  assert.equal(typed(), true);
  assert.equal(typed({ source: 'trigger' }), false);
  assert.equal(typed({ source: 'operation' }), false);
  assert.equal(typed({}, { originContinue: true }), false);
  assert.equal(typed({}, { originDispatchId: 'op-1' }), false);
  assert.equal(typed({ originDispatchId: 'op-1' }), false);
  assert.equal(typed({ requestId: 'req-1' }), false);
  assert.equal(typed({}, { userInputRequestId: 'req-2' }), false);
  assert.equal(isDirectUserTyped({ ...ITEM, payload: { ...ITEM.payload, type: 'dispatch.request' } }), false);
  assert.equal(isDirectUserTyped(null), false);
});

// ── the wiring: write first, then the user row, then remember ───────────────
test('a typed message is written into the live process and recorded once', async () => {
  const h = harness();
  assert.equal(h.injection.canInject({ item: ITEM, sessionId: ITEM.sessionId, opts: {} }), true);
  const result = await h.injection.tryInject({
    item: ITEM, sessionId: ITEM.sessionId, text: 'what is the status?', opts: { clientMsgId: 'cm-1' },
  });
  assert.deepEqual(result, { delivered: true, identity: 'cm-1' });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].value, 'what is the status?');
  assert.equal(h.writes[0].identity, 'cm-1');
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].id, ITEM.sessionId);
  assert.deepEqual(h.appended[0].message, {
    role: 'user', content: 'what is the status?', ts: h.appended[0].message.ts,
    turnId: 'turn-9', clientMsgId: 'cm-1', heldTurnInjected: true,
  });
  assert.equal(typeof h.appended[0].message.ts, 'number');
  // Once the durable row exists the same delivery identity is settled: the
  // predicate refuses it before any write ('already_delivered').
  h.setPersisted(true);
  const replay = await h.injection.tryInject({
    item: ITEM, sessionId: ITEM.sessionId, text: 'what is the status?', opts: { clientMsgId: 'cm-1' },
  });
  assert.deepEqual(replay, { delivered: false, reason: 'already_delivered' });
  assert.equal(h.writes.length, 1);
});

test('every refusal keeps the message waiting and writes nothing', async () => {
  // `already_delivered` is the one reason the sync gate cannot see (the durable
  // row lives behind an async port); it is still refused at write time.
  const cases = [
    [live({ held: false }), {}, {}, 'not_held'],
    // A plain stream-json lane reports no answer attribution, so an injected
    // line there could never be settled: the message keeps waiting.
    [live({ attributable: false }), {}, {}, 'unattributable_lane'],
    // M3: route/credential/vault drift since the process spawned is the one
    // legitimate wait — the message must not enter a stale process.
    [live({ stale: true }), {}, {}, 'process_changed'],
    [live(), { active: false }, {}, 'no_active_turn'],
    [live(), {}, { payload: { source: 'operation' } }, 'not_user_typed'],
    [live({ alive: false }), {}, {}, 'process_not_alive'],
    [live({ contract: spawnContractOf({ ...RECORD, model: 'other-model' }) }), {}, {}, 'spawn_contract_changed'],
    [live({ contract: null }), {}, {}, 'spawn_contract_changed'],
    [live(), { persisted: true }, {}, 'already_delivered'],
  ];
  for (const [liveFacts, options, itemOverrides, reason] of cases) {
    const h = harness({ liveFacts, ...options });
    const item = { ...ITEM, payload: { ...ITEM.payload, ...itemOverrides.payload } };
    if (reason !== 'already_delivered') {
      assert.equal(h.injection.canInject({ item, sessionId: item.sessionId, opts: {} }), false, reason);
    }
    const result = await h.injection.tryInject({ item, sessionId: item.sessionId, text: 'hi', opts: {} });
    assert.deepEqual(result, { delivered: false, reason }, reason);
    assert.deepEqual(h.writes, [], reason);
    assert.deepEqual(h.appended, [], reason);
  }
});

test('a retry after write/row failure never writes stdin twice (H2)', async () => {
  // The stdin write itself failed: the identity was aborted in Rust, so the
  // retry may write. No row is appended for a line the process never saw.
  const failedWrite = harness({ written: false });
  assert.equal(failedWrite.injection.canInject({ item: ITEM, sessionId: ITEM.sessionId, opts: {} }), true);
  assert.deepEqual(await failedWrite.injection.tryInject({
    item: ITEM, sessionId: ITEM.sessionId, text: 'hi', opts: {},
  }), { delivered: false, reason: 'write_failed' });
  assert.deepEqual(failedWrite.appended, [], 'no row for a line that never reached the process');
  assert.deepEqual(failedWrite.writes, []);

  // The line reached the process but the history row did not persist. The
  // retry must append the row only — the identical message must not run twice.
  const unsaved = harness({ saved: false });
  assert.equal(unsaved.injection.canInject({ item: ITEM, sessionId: ITEM.sessionId, opts: {} }), true);
  assert.deepEqual(await unsaved.injection.tryInject({
    item: ITEM, sessionId: ITEM.sessionId, text: 'hi', opts: { clientMsgId: 'cm-retry' },
  }), { delivered: false, reason: 'row_not_persisted' });
  assert.equal(unsaved.writes.length, 1, 'the message was written once');
  assert.deepEqual(unsaved.appended, [], 'the row did not persist');

  unsaved.setSaved(true);
  assert.deepEqual(await unsaved.injection.tryInject({
    item: ITEM, sessionId: ITEM.sessionId, text: 'hi', opts: { clientMsgId: 'cm-retry' },
  }), { delivered: true, identity: 'cm-retry' });
  assert.equal(unsaved.writes.length, 1, 'a retry must not write stdin again');
  assert.equal(unsaved.appended.length, 1, 'the retry re-appended the missing row');
  assert.equal(unsaved.appended[0].message.clientMsgId, 'cm-retry');
  assert.equal(unsaved.appended[0].message.heldTurnInjected, true);
});

// ── the delivery worker: claim only what the predicate would take ───────────
function runtimeFixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-held-inject-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { value: 10_000 };
  const history = new Map();
  const calls = { injected: [], delivered: [], prepared: 0, noticed: [] };
  const runtime = createOrchestrationRuntime({
    file: path.join(dir, 'orchestration.json'),
    now: () => clock.value,
    onSchedulerEvent: () => {},
    runChatTurn: async (sessionId, text, opts) => {
      calls.delivered.push({ sessionId, text, opts });
      const ids = history.get(sessionId) || new Set();
      ids.add(opts.deliveryId);
      history.set(sessionId, ids);
      return true;
    },
    isBusy: overrides.isBusy || (() => true),
    busyReasons: overrides.busyReasons || (() => ['workspace_occupied', 'run_active']),
    isDeliveryLocked: () => false,
    hasPersistedDelivery: async (sessionId, deliveryId) => (
      history.get(sessionId)?.has(deliveryId) || false
    ),
    outboxOptions: { leaseMs: 100, maxAttempts: 4, backoff: () => 0 },
    ...(overrides.heldTurnInjectable === undefined
      ? { heldTurnInjectable: () => true } : { heldTurnInjectable: overrides.heldTurnInjectable }),
    tryInjectHeldTurn: async descriptor => {
      calls.injected.push(descriptor);
      // The gate and the write answer from the same facts, like production.
      if (overrides.injectable && overrides.injectable() === false) {
        return { delivered: false, reason: 'not_held' };
      }
      return overrides.injectionResult || { delivered: true, identity: descriptor.item.id };
    },
    beforeDeliver: async () => { calls.prepared += 1; return null; },
    heldForBackground: overrides.heldForBackground,
    stuckDeliveryNoticeMs: overrides.stuckDeliveryNoticeMs,
    notifyStuckDelivery: notice => calls.noticed.push(notice),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  return { runtime, calls, clock };
}

test('a held turn takes the typed message without a scheduler claim or a workspace lease', async t => {
  const h = runtimeFixture(t);
  const admitted = await h.runtime.admitSessionWork({
    sessionId: 'held-session', text: 'what is the status?', idempotencyKey: 'held-typed-1',
  });
  assert.equal(admitted.ok, true);
  await h.runtime.tick();
  assert.equal(h.calls.injected.length, 1, 'the held turn took the message');
  assert.equal(h.calls.injected[0].text, 'what is the status?');
  assert.equal(h.calls.delivered.length, 0, 'no next turn was started');
  assert.equal(h.calls.prepared, 0, 'no workspace preparation ran');
  const state = await h.runtime.outbox.get(admitted.entry.id);
  assert.equal(state.state, 'delivered', 'the outbox item settled exactly once');
  const queue = await h.runtime.sessionScheduler.status('held-session');
  assert.equal(queue.state, 'idle', 'no scheduler claim was made');
  await h.runtime.stop();
});

test('a message needing a different process waits and says it is the background work', async t => {
  // Different model during the held phase: the predicate refuses, so the item is
  // left pending behind the busy gate — and the notice must name the real owner.
  const h = runtimeFixture(t, { heldTurnInjectable: () => false, stuckDeliveryNoticeMs: 0, heldForBackground: () => true });
  const admitted = await h.runtime.admitSessionWork({
    sessionId: 'held-session', text: 'switch to another model', idempotencyKey: 'held-typed-2',
  });
  await h.runtime.tick();
  await h.runtime.tick();
  assert.deepEqual(h.calls.injected, [], 'the running process was not reused');
  assert.equal((await h.runtime.outbox.get(admitted.entry.id)).state, 'pending', 'it waits for the turn to end');
  assert.equal(h.calls.noticed.length, 1);
  assert.equal(h.calls.noticed[0].heldForBackground, true);
  assert.deepEqual(h.calls.noticed[0].reasons, ['workspace_occupied', 'run_active']);
  await h.runtime.stop();
});

test('a message typed while the answer is still generating waits, then goes in once held', async t => {
  // Before the main result the resident lane is actively generating: unchanged
  // behaviour — the message queues. The gate is re-evaluated every tick, so the
  // same item goes into the turn the moment the held phase begins.
  let held = false;
  const h = runtimeFixture(t, {
    isBusy: () => true,
    heldTurnInjectable: () => held,
    injectable: () => held,
    stuckDeliveryNoticeMs: 0,
    heldForBackground: () => held,
  });
  const admitted = await h.runtime.admitSessionWork({
    sessionId: 'held-session', text: 'while you were generating', idempotencyKey: 'held-typed-4',
  });
  await h.runtime.tick();
  assert.deepEqual(h.calls.injected, [], 'the generating turn takes no new message');
  assert.equal((await h.runtime.outbox.get(admitted.entry.id)).state, 'pending');
  held = true;
  await h.runtime.tick();
  assert.equal(h.calls.injected.length, 1, 'the held turn takes it on the next tick');
  assert.equal((await h.runtime.outbox.get(admitted.entry.id)).state, 'delivered');
  assert.equal(h.calls.delivered.length, 0, 'no next turn was started');
  await h.runtime.stop();
});

test('after the turn ends the waiting message is delivered by the normal path', async t => {
  let busy = true;
  // While held it needs a different process (e.g. a staged model change), so it
  // waits; once the turn ends, the ordinary delivery path takes it.
  const h = runtimeFixture(t, {
    isBusy: () => busy,
    heldTurnInjectable: () => false,
    injectable: () => false,
    stuckDeliveryNoticeMs: 0,
    heldForBackground: () => true,
  });
  const admitted = await h.runtime.admitSessionWork({
    sessionId: 'held-session', text: 'after the work ends', idempotencyKey: 'held-typed-3',
  });
  await h.runtime.tick();
  assert.equal((await h.runtime.outbox.get(admitted.entry.id)).state, 'pending');
  busy = false;
  await h.runtime.tick();
  assert.equal(h.calls.delivered.length, 1, 'the normal delivery path took over');
  assert.equal((await h.runtime.outbox.get(admitted.entry.id)).state, 'delivered');
  await h.runtime.stop();
});

// ── the notice the human sees ───────────────────────────────────────────────
test('the waiting notice names the background work instead of a wedged workspace', async () => {
  const text = heldBackgroundText({ waitedMs: 61_000 });
  assert.match(text, /后台任务/);
  assert.match(text, /Agent/);
  assert.match(text, /Monitor/);
  assert.match(text, /后台任务结束后这条会自动执行/);
  assert.doesNotMatch(text, /当前没有轮次在跑/);
  const said = [];
  const notices = createSessionNotices({
    appendChatMessage: (id, message) => { said.push({ id, message }); return true; },
    chatBroadcast: () => {},
    now: () => 1,
  });
  notices.notifyStuckDelivery({ sessionId: 's', reason: 'session_busy', reasons: ['run_active'], waitedMs: 61_000, heldForBackground: true });
  assert.equal(said.length, 1);
  assert.equal(said[0].message.role, 'system');
  assert.match(said[0].message.content, /后台任务/);
  notices.notifyStuckDelivery({ sessionId: 's', reason: 'session_busy', reasons: ['workspace_occupied'], waitedMs: 61_000 });
  assert.match(said[1].message.content, /工作区被占用/);
});

// L2: the hold cap is visibility, not release. Rust fires it at most once per
// held turn (see test-background-hold-differential.js); the host says it where
// the turn is watched instead of only on the console.
test('the hold cap is one visible notice, never a release', () => {
  const text = heldCapText({ minutes: 61 });
  assert.match(text, /61 分钟/);
  assert.match(text, /回合会继续保持开启/);
  assert.match(text, /立刻插入/);
  assert.doesNotMatch(text, /当前没有轮次在跑/);
  const said = [];
  const broadcasts = [];
  const notices = createSessionNotices({
    appendChatMessage: (id, message) => { said.push({ id, message }); return true; },
    chatBroadcast: (id, event) => broadcasts.push({ id, event }),
    now: () => 7,
  });
  notices.notifyHoldCap({ sessionId: 'held-session', minutes: 60 });
  assert.equal(said.length, 1);
  assert.equal(said[0].id, 'held-session');
  assert.equal(said[0].message.role, 'system');
  assert.match(said[0].message.content, /60 分钟/);
  assert.deepEqual(broadcasts, [{ id: 'held-session',
    event: { type: 'system', subtype: 'notice', message: said[0].message.content } }]);
});

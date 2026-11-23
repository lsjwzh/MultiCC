'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkRuntime } = require('./helpers/task-board-runtime');
const legacy = require('./helpers/load-legacy-task-board-runtime');
const current = require('../src/routes/task-board');
const baseline = require('./fixtures/task-board-runtime-baseline.json');
const queueBaseline = require('./fixtures/task-board-queue-baseline.json');
const queueEvents = [
  { type: 'queued', workKind: 'task' },
  { type: 'claimed' },
  { type: 'completed', turnOutcome: 'succeeded' },
  { type: 'completed', turnOutcome: 'failed' },
  { type: 'completed', turnOutcome: 'waiting_user' },
  { type: 'completed', turnOutcome: 'waiting_background' },
  { type: 'completed', turnOutcome: 'running' },
  ...['D', 'W', 'B', 'E', null].map(classifyState => ({ type: 'completed', classifyState })),
  { type: 'claim_released' },
  { type: 'claim_released', queuedItems: ['item'] },
  { type: 'claim_released', queuedItems: [], queueSummary: { classifyState: 'D' } },
  { type: 'claim_released', queueSummary: { classifyState: 'W' } },
  { type: 'claim_released', queueSummary: {} },
  { type: 'claim_released', queuedItems: null },
  { type: 'claim_released', queuedItems: { length: 3 } },
  { type: 'claim_released', freezeReason: 'incomplete_requires_resume' },
  { type: 'claim_released', freezeReason: 'configuration_required' },
  { type: 'claim_released', freezeReason: 'future_reason_with_error_inside' },
  { type: 'claim_released', freezeReason: 'future_reason_calm' },
  { type: 'frozen', freezeReason: 'incomplete_requires_resume' },
  { type: 'frozen', freezeReason: 'mystery_error_xyz' },
  { type: 'frozen', freezeReason: 'mystery_calm' },
  { type: 'frozen' },
  { type: 'started' },
  { type: 'resumed' },
  { type: 'skipped' },
  { type: 'mystery_type' },
  { type: 'queued', workKind: 'chat' },
  { type: 'completed', turnOutcome: 'made_up_outcome', classifyState: 'B' },
  { type: 'reconcile', classifyState: 'W' },
  { type: 'cancelled' },
  // A reconcile bypasses the stale guard on purpose (formal re-publish); the
  // trailing heartbeat with an old clock must then be rejected as stale.
  { type: 'reconcile', classifyState: 'B', at: 1 },
  { type: 'started', at: 1 },
];

// The clock and identifiers are controlled on both sides; output includes the
// persisted board and emitted notifications, not just function return values.
const histories = {
  'sess-1': [
    { id: 'mu1', role: 'user', content: '实现任务板', ts: 10 },
    { id: 'mu2', role: 'user', content: '正式任务卡', ts: 12, taskId: 'tsk-baseline', taskStart: true, taskText: '正式任务卡文本' },
    { id: 'ma1', role: 'assistant', content: '已实现，改了 src/task-board.js', ts: 20, taskId: 'tsk-baseline' },
  ],
  // An earlier taskStart in a second session pins the canonical merge order:
  // only a ts-sorted projection picks this one as the task body.
  'sess-2': [
    { id: 'ms2', role: 'user', content: '更早的开始', ts: 5, taskId: 'tsk-baseline', taskStart: true, taskText: '更早文本' },
  ],
};
const mockRes = () => ({ statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });
async function capture(createRuntime) {
  const oldNow = Date.now;
  Date.now = () => 1700000000000;
  let fixture;
  try {
    fixture = mkRuntime({ loadHistory: sessionId => histories[sessionId] || [] }, createRuntime);
    const { runtime, broadcasts, sessionMessages, file } = fixture;
    const input = { id: 'tsk-baseline', dirId: 'dir-1', sessionId: 'sess-1',
      title: '固定任务', createdAt: 1700000000000 };
    const results = [];
    results.push(runtime.markTaskSeen('missing'));
    results.push(await runtime.archiveTasks([]));
    results.push(runtime.registerShellTask(input));
    results.push(runtime.registerShellTask({ ...input, sessionId: 'different-session' }));
    results.push(await runtime.routeCommanderInput('missing', 'hello'));
    results.push(await runtime.routeCommanderInput('commander-1', '  '));
    results.push(await runtime.archiveTasks(['missing']));
    const queue = queueEvents.map((event, index) => {
      const result = runtime.onQueueEvent({ ...event, taskId: input.id,
        sessionId: input.sessionId, at: event.at ?? (1700000000001 + index) });
      return { result, runState: runtime.getBoard().tasks[input.id].runState };
    });
    // Transcript-projection pins: a second ref makes the canonical body come
    // from the earliest taskStart across sessions; the other three cards pin
    // the legacy ref fallback, the planned-record description branch and the
    // empty fallback. The status DTO embeds canonicalTaskBody's result.
    const liveBoard = runtime.getBoard();
    liveBoard.tasks[input.id].refs.push({ sessionId: 'sess-2', dirId: 'dir-1',
      userMsgId: null, assistantMsgId: null, ts: 1, excerpt: '' });
    liveBoard.tasks['tsk-legacy'] = { id: 'tsk-legacy', title: '遗留卡片', status: 'active',
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: null, ts: 10, excerpt: '' }],
      createdAt: 1700000000000, updatedAt: 1700000000000 };
    liveBoard.tasks['tsk-planned'] = { id: 'tsk-planned', recordType: 'planned',
      title: '计划标题', description: '  计划描述  ', status: 'active', chatSessionId: 'sess-9',
      refs: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
    liveBoard.tasks['tsk-empty'] = { id: 'tsk-empty', title: '空卡', status: 'active',
      refs: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
    const dtos = [];
    for (const taskId of [input.id, 'tsk-legacy', 'tsk-planned', 'tsk-empty']) {
      const res = mockRes();
      await runtime.routePorts.status({ taskId, body: { status: 'active' } }, res);
      dtos.push({ statusCode: res.statusCode, body: res.body });
    }
    // Cold-start seed pin: the commander followup binds a chat session and
    // routes through legacyImportMessages + contextMessages; the seeded
    // context lands in the recorded sendSessionMessage options. The client
    // key is pinned so every derived id is deterministic.
    const followup = await runtime.routeCommanderFollowup('commander-1', input.id,
      '继续处理', { clientMsgId: 'fixed-followup-key' });
    const board = JSON.parse(JSON.stringify(runtime.getBoard()));
    const persisted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const moduleIds = Object.keys(board.modules);
    assert.equal(moduleIds.length, 1);
    const [moduleId] = moduleIds;
    assert.match(moduleId, /^mod-[a-f0-9]{32}$/);
    assert.equal(board.modules[moduleId].id, moduleId);
    assert.equal(board.tasks['tsk-baseline'].moduleId, moduleId);
    assert.equal(persisted.modules[moduleId].id, moduleId);
    assert.equal(persisted.tasks['tsk-baseline'].moduleId, moduleId);
    const raw = JSON.stringify({ results, queue, dtos, followup, sessionMessages, board, broadcasts, persisted });
    return JSON.parse(raw.replaceAll(moduleId, '<generated-module-id>'));
  } finally {
    Date.now = oldNow;
    if (fixture) fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true });
  }
}

test('task board runtime matches its frozen host baseline', async () => {
  const expected = await capture(legacy.createTaskBoardRuntime);
  assert.deepEqual(expected.results, baseline);
  assert.deepEqual(expected.queue, queueBaseline);
  assert.deepEqual(await capture(current.createTaskBoardRuntime), expected);
});

test('queue result mutation is detected by the baseline', async () => {
  const expected = await capture(legacy.createTaskBoardRuntime);
  const mutated = await capture(deps => {
    const runtime = legacy.createTaskBoardRuntime(deps);
    return { ...runtime, onQueueEvent(event) {
      const result = runtime.onQueueEvent(event);
      return { ...result, changed: !result.changed };
    } };
  });
  assert.notDeepEqual(mutated, expected);
  assert.notDeepEqual(mutated.queue, queueBaseline);
  // The cold-start seed surface is pinned too: altering the followup result
  // must change the capture.
  const followupMutated = await capture(deps => {
    const runtime = legacy.createTaskBoardRuntime(deps);
    return { ...runtime, async routeCommanderFollowup(...args) {
      const result = await runtime.routeCommanderFollowup(...args);
      return { ...result, changed: true };
    } };
  });
  assert.notDeepEqual(followupMutated, expected);
});

test('native queue run-state adapter preserves live reads and exceptions', () => {
  const run = require('../src/native/runtime').getNative().taskBoardQueueRunState;
  const calls = [];
  const classify = value => { calls.push(value); return value; };
  const freeze = value => { calls.push(value); return value; };
  // completed reads turnOutcome then classifyState, both eagerly, and the
  // matched-outcome branches never consult the classifier.
  const reads = [];
  const eager = {};
  Object.defineProperties(eager, {
    turnOutcome: { get() { reads.push('turnOutcome'); return 'succeeded'; } },
    classifyState: { get() { reads.push('classifyState'); return 'W'; } },
  });
  assert.equal(run('completed', eager, freeze, classify), 'succeeded');
  assert.deepEqual(reads, ['turnOutcome', 'classifyState']);
  assert.deepEqual(calls, []);
  for (const [outcome, expected] of [['failed', 'error'], ['running', 'running']]) {
    assert.equal(run('completed', { turnOutcome: outcome }, freeze, classify), expected);
  }
  assert.equal(run('completed', { turnOutcome: 'waiting_user' }, freeze, classify), 'W');
  assert.equal(run('completed', { turnOutcome: 'waiting_background' }, freeze, classify), 'B');
  for (const value of [undefined, null, false, 0, NaN, '']) {
    assert.equal(run('completed', { classifyState: value }, freeze, classify), 'D');
  }
  const token = { state: 'W' };
  assert.equal(run('completed', { turnOutcome: new String('succeeded'), classifyState: token },
    freeze, classify), token);
  assert.equal(calls.at(-1), token);
  // reconcile reads classifyState exactly once.
  const reconcileReads = [];
  const reconcileEvent = {};
  Object.defineProperty(reconcileEvent, 'classifyState',
    { get() { reconcileReads.push('classifyState'); return 'B'; } });
  assert.equal(run('reconcile', reconcileEvent, freeze, classify), 'B');
  assert.deepEqual(reconcileReads, ['classifyState']);
  // frozen forwards the raw reason; callback exceptions propagate untouched.
  const reason = { why: 'auth' };
  assert.equal(run('frozen', { freezeReason: reason }, freeze, classify), reason);
  const error = new Error('lookup failed');
  assert.throws(() => run('frozen', { freezeReason: 'x' }, () => { throw error; }, classify),
    value => value === error);
  assert.throws(() => run('reconcile', { classifyState: 'W' }, freeze, () => { throw error; }),
    value => value === error);
  // claim_released reads freezeReason twice when set (check + argument) and
  // then short-circuits before touching queuedItems.
  const releaseReads = [];
  const release = {};
  Object.defineProperties(release, {
    freezeReason: { get() { releaseReads.push('freezeReason'); return 'configuration_required'; } },
    queuedItems: { get() { releaseReads.push('queuedItems'); return undefined; } },
  });
  assert.equal(run('claim_released', release, freeze, classify), 'configuration_required');
  assert.deepEqual(releaseReads, ['freezeReason', 'freezeReason']);
  // Depth rules: a non-empty array queues; an empty one falls back to the
  // queue summary's classify verdict; a missing summary selects 'D'.
  assert.equal(run('claim_released', { queuedItems: ['i'] }, freeze, classify), 'queued');
  assert.equal(run('claim_released', { queuedItems: [] }, freeze, classify), 'D');
  assert.equal(run('claim_released', { queuedItems: [], queueSummary: { classifyState: 'B' } },
    freeze, classify), 'B');
  assert.equal(run('claim_released', {}, freeze, classify), 'queued');
  assert.equal(run('queued', {}, freeze, classify), 'queued');
  assert.equal(run('claimed', {}, freeze, classify), 'running');
  assert.equal(run('skipped', {}, freeze, classify), 'idle');
  assert.equal(run('mystery', {}, freeze, classify), null);
});

test('native transcript adapters preserve live reads, callbacks and exceptions', () => {
  const crypto = require('node:crypto');
  const native = require('../src/native/runtime').getNative();
  // stableTaskId: the sha256 template digest with ToString coercion on both
  // sides, identical to the retired crypto chain.
  const expectId = (source, key) => 'tsk-' + crypto.createHash('sha256')
    .update(`${source}\0${key}`, 'utf8').digest('hex').slice(0, 32);
  assert.equal(native.taskBoardStableTaskId('board-send:dir-1', 'client-7'),
    'tsk-c0f07d4d4b9f10225f2c1edc608a681a');
  assert.equal(native.taskBoardStableTaskId('', ''), 'tsk-6e340b9cffb37a989ca544e6bb780a2c');
  assert.equal(native.taskBoardStableTaskId(5, null), expectId(5, null));
  // canonicalMessages: session ids collect refs first (deduped in insertion
  // order), then the routing lookups; a throwing or falsy loadHistory yields
  // an empty history; messages filter on taskId membership; the result sorts
  // by (ts || 0) and hands back the live message references.
  const calls = [];
  const first = { id: 'a', role: 'user', taskId: 't1', ts: 20 };
  const second = { id: 'b', role: 'user', taskId: 't1', ts: 10 };
  const skipped = { id: 'c', taskId: 'other', ts: 1 };
  const histories = { s1: [first, skipped], s2: [second] };
  const load = sessionId => {
    calls.push(sessionId);
    if (sessionId === 's3') throw new Error('io');
    if (sessionId === 's4') return null;
    return histories[sessionId];
  };
  const members = [
    { refs: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's1' }, { sessionId: null }],
      routing: null },
    null,
    { refs: [], routing: { workerSessionId: 's3', mode: 'manual', targetSessionId: 's4' } },
  ];
  const out = native.taskBoardCanonicalMessages(members, ['t1'], load);
  assert.deepEqual(calls, ['s1', 's2', 's3', 's4']);
  assert.equal(out.length, 2);
  assert.equal(out[0].message, second);
  assert.equal(out[0].sessionId, 's2');
  assert.equal(out[1].message, first);
  assert.equal(out[1].sessionId, 's1');
  // A truthy non-iterable history fails the projection exactly like for-of.
  assert.throws(() => native.taskBoardCanonicalMessages(
    [{ refs: [{ sessionId: 's1' }], routing: null }], ['t1'], () => ({})));
  // canonicalTaskBody: the earliest taskStart wins across sessions; a truthy
  // taskText short-circuits messageText; otherwise messageText receives the
  // live message and its exception propagates untouched.
  const start = { id: 'm1', role: 'user', taskId: 't1', taskStart: true, ts: 20, taskText: '任务文本' };
  const earlier = { id: 'm2', role: 'user', taskId: 't1', taskStart: true, ts: 10, content: '更早正文' };
  const plain = { id: 'm3', role: 'assistant', taskId: 't1', ts: 5 };
  const bodyHistories = { s1: [start], s2: [earlier, plain] };
  const bodyMembers = [
    { refs: [{ sessionId: 's1' }], routing: null },
    { refs: [{ sessionId: 's2' }], routing: null },
  ];
  const bodyLoad = sessionId => bodyHistories[sessionId];
  const mtCalls = [];
  const messageText = message => { mtCalls.push(message); return message.content; };
  const body = native.taskBoardCanonicalTaskBody(bodyMembers, ['t1'], {}, bodyLoad, messageText);
  assert.deepEqual(mtCalls, [earlier]);
  assert.deepEqual(body, { text: '更早正文', messageId: 'm2', sessionId: 's2', legacy: false });
  const swapped = native.taskBoardCanonicalTaskBody(bodyMembers, ['t1'], {},
    sessionId => bodyHistories[sessionId].map(message => ({ ...message, ts: 100 - message.ts })),
    messageText);
  assert.deepEqual(swapped, { text: '任务文本', messageId: 'm1', sessionId: 's1', legacy: false });
  const error = new Error('message text failed');
  assert.throws(() => native.taskBoardCanonicalTaskBody(bodyMembers, ['t1'], {}, bodyLoad,
    () => { throw error; }), value => value === error);
  // Planned records: the trimmed `description || title || ''` is the body and
  // JavaScript trim removes U+FEFF; an empty description falls through to the
  // legacy ref loop.
  const planned = native.taskBoardCanonicalTaskBody([], ['t1'],
    { recordType: 'planned', description: '\uFEFF 计划 \uFEFF', chatSessionId: 'sess-9' },
    () => [], messageText);
  assert.deepEqual(planned, { text: '计划', messageId: null, sessionId: 'sess-9', legacy: false });
  const titled = native.taskBoardCanonicalTaskBody([], ['t1'],
    { recordType: 'planned', description: '', title: '标题' }, () => [], messageText);
  assert.deepEqual(titled, { text: '标题', messageId: null, sessionId: null, legacy: false });
  // Legacy fallback: per-ref early exit, a re-read userMsgId per candidate,
  // messageId || null, and the final empty body when nothing resolves.
  const refMessage = { id: 'u9', content: '遗留正文' };
  const refCalls = [];
  const refLoad = sessionId => {
    refCalls.push(sessionId);
    if (sessionId === 'late') throw new Error('must not load');
    return [refMessage];
  };
  const legacy = native.taskBoardCanonicalTaskBody([], ['t1'],
    { refs: [{ sessionId: 'first', userMsgId: 'missing' },
      { sessionId: 'second', userMsgId: 'u9' }, { sessionId: 'late', userMsgId: 'u9' }] },
    refLoad, messageText);
  assert.deepEqual(refCalls, ['first', 'second']);
  assert.deepEqual(legacy, { text: '遗留正文', messageId: 'u9', sessionId: 'second', legacy: true });
  // A falsy userMsgId skips the scan but the ref's history still loads.
  const noIdCalls = [];
  const noId = native.taskBoardCanonicalTaskBody([], ['t1'],
    { refs: [{ sessionId: 's1', userMsgId: '' }] },
    sessionId => { noIdCalls.push(sessionId); return [{ id: 'x', content: 'y' }]; },
    messageText);
  assert.deepEqual(noIdCalls, ['s1']);
  assert.deepEqual(noId, { text: '', messageId: null, sessionId: null, legacy: true });
  // A canonical start message without an id projects messageId null.
  const anonymous = { role: 'user', taskId: 't1', taskStart: true, ts: 1, taskText: '匿名' };
  const anonBody = native.taskBoardCanonicalTaskBody(
    [{ refs: [{ sessionId: 's1' }], routing: null }], ['t1'], {}, () => [anonymous], messageText);
  assert.deepEqual(anonBody, { text: '匿名', messageId: null, sessionId: 's1', legacy: false });
  assert.deepEqual(native.taskBoardCanonicalTaskBody([], ['t1'], { refs: [] }, () => [], messageText),
    { text: '', messageId: null, sessionId: null, legacy: true });
  assert.deepEqual(native.taskBoardCanonicalTaskBody([], ['t1'],
    { recordType: 'planned', description: '   ' }, () => [], messageText),
    { text: '', messageId: null, sessionId: null, legacy: true });
});

test('native legacy-import adapter preserves dedupe, caching and sort order', () => {
  const crypto = require('node:crypto');
  const native = require('../src/native/runtime').getNative();
  const expectLegacyId = identity => 'legacy:' + crypto.createHash('sha256')
    .update(identity, 'utf8').digest('hex').slice(0, 40);
  const textOf = message => message.content;
  // Canonical phase first, then the per-ref fallback: the ref re-finds the
  // same message and the single entry upgrades canonicalBody; the excerpt
  // branch builds a lost entry from the ref fields; a system role never
  // reaches the text callback.
  const user = { id: 'u1', role: 'user', content: '实现任务板', taskId: 't1', taskStart: true, ts: 10 };
  const assistant = { id: 'a1', role: 'assistant', content: '已回复', taskId: 't1', ts: 20 };
  const system = { id: 's0', role: 'system', content: '忽略', taskId: 't1', ts: 5 };
  const calls = [];
  const load = sessionId => { calls.push(sessionId); return [system, user, assistant]; };
  const members = [{ refs: [{ sessionId: 's1' }], routing: null }];
  const task = { refs: [
    { sessionId: 's1', userMsgId: 'u1', assistantMsgId: 'a1' },
    { sessionId: 's1', userMsgId: 'missing', excerpt: '摘录文本', ts: 3 },
  ] };
  const out = native.taskBoardLegacyImportMessages(members, ['t1'], task, load, textOf);
  // One load for the canonical scan, one cache fill for both refs.
  assert.deepEqual(calls, ['s1', 's1']);
  assert.equal(out.length, 3);
  // Sorted by (createdAt, messageId): excerpt ts 3, user ts 10, assistant 20.
  assert.equal(out[0].messageId, expectLegacyId('s1\0user\0' + '3\0摘录文本'));
  assert.deepEqual(out[0].metadata, { sourceSessionId: 's1', sourceMessageId: null,
    canonicalBody: true, lost: true });
  assert.equal(out[0].content, '摘录文本');
  assert.equal(out[0].createdAt, 3);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].kind, 'legacy_import');
  assert.equal(out[1].messageId, expectLegacyId('s1\0id:u1'));
  assert.deepEqual(out[1].metadata, { sourceSessionId: 's1', sourceMessageId: 'u1',
    canonicalBody: true, lost: false });
  assert.equal(out[1].content, '实现任务板');
  assert.equal(out[2].messageId, expectLegacyId('s1\0id:a1'));
  assert.equal(out[2].metadata.canonicalBody, false);
  assert.equal(out[2].role, 'assistant');
  // An empty text drops non-assistant messages but keeps assistants.
  assert.equal(native.taskBoardLegacyImportMessages([], ['t1'],
    { refs: [{ sessionId: 'sx', userMsgId: 'u', excerpt: '', ts: 2 }] },
    () => [{ id: 'u', role: 'user', content: '', ts: 1 }], textOf).length, 0);
  const kept = native.taskBoardLegacyImportMessages([], ['t1'],
    { refs: [{ sessionId: 'sx', userMsgId: 'keep', excerpt: 'fallback', ts: 2 }] },
    () => [{ id: 'keep', role: 'assistant', content: '', ts: 1 }], textOf);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].role, 'assistant');
  assert.equal(kept[0].createdAt, 1);
  // A message id wins the identity; without one the identity carries the
  // Number-coerced timestamp (string ts coerces like Number()).
  const coerced = native.taskBoardLegacyImportMessages(
    [{ refs: [{ sessionId: 's2' }], routing: null }], ['t1'], { refs: [] },
    () => [{ role: 'user', content: '无标识', taskId: 't1', ts: '7' }], textOf);
  assert.equal(coerced.length, 1);
  assert.equal(coerced[0].messageId, expectLegacyId('s2\0user\0' + '7\0无标识'));
  assert.equal(coerced[0].createdAt, 7);
  // createdAt ties break on the message id bytes, not insertion order.
  const ties = native.taskBoardLegacyImportMessages(
    [{ refs: [{ sessionId: 's9' }], routing: null }], ['t1'], { refs: [] },
    () => [{ role: 'user', content: '乙', taskId: 't1' },
      { role: 'user', content: '甲', taskId: 't1' }], textOf);
  assert.equal(ties.length, 2);
  assert.deepEqual(ties.map(entry => entry.messageId),
    [...ties.map(entry => entry.messageId)].sort());
  assert.equal(ties[0].createdAt, 0);
  // The text callback runs with a fresh {content} object per message and its
  // exception propagates untouched.
  const error = new Error('text failed');
  assert.throws(() => native.taskBoardLegacyImportMessages(members, ['t1'], { refs: [] },
    load, () => { throw error; }), value => value === error);
  // contextMessages projects {id, role, ts, text} in key order with a fresh
  // {content} input per call.
  const seen = [];
  const context = native.taskBoardContextMessages([out[0], out[1]], value => {
    seen.push(value);
    return value.content;
  });
  assert.deepEqual(context, [
    { id: out[0].messageId, role: 'user', ts: 3, text: '摘录文本' },
    { id: out[1].messageId, role: 'user', ts: 10, text: '实现任务板' },
  ]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.deepEqual(Object.keys(seen[0]), ['content']);
  assert.equal(seen[0].content, '摘录文本');
});

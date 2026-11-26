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
const classifyBaseline = require('./fixtures/task-board-classify-baseline.json');
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
  // Classification-input resolution pins: a blank user message falls back to
  // the module-assignment seed; a marker line resolves through the third
  // scan; a taskId field resolves through the second.
  'sess-4': [
    { id: 'blank', role: 'user', content: '   ', ts: 8 },
  ],
  'sess-5': [
    { id: 'mk1', role: 'user', content: '修复登录 ｜tb:tsk-marker】', ts: 3 },
    { id: 'mk2', role: 'assistant', content: '标记回复', ts: 4 },
  ],
  'sess-6': [
    { id: 'sf1', role: 'user', content: '带任务字段', ts: 6, taskId: 'tsk-scan2' },
    { id: 'sf2', role: 'assistant', content: '好的', ts: 7, taskId: 'tsk-scan2' },
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
    fixture = mkRuntime({ loadHistory: sessionId => {
      if (sessionId === 'sess-3') throw new Error('history unreadable');
      return histories[sessionId] || [];
    } }, createRuntime);
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
    liveBoard.tasks['tsk-legacy'] = { id: 'tsk-legacy', title: '遗留卡片', areas: [], status: 'active',
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: null, ts: 10, excerpt: '' }],
      createdAt: 1700000000000, updatedAt: 1700000000000 };
    liveBoard.tasks['tsk-planned'] = { id: 'tsk-planned', recordType: 'planned',
      title: '计划标题', areas: [], description: '  计划描述  ', status: 'active', chatSessionId: 'sess-9',
      refs: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
    liveBoard.tasks['tsk-empty'] = { id: 'tsk-empty', title: '空卡', areas: [], status: 'active',
      refs: [], createdAt: 1700000000000, updatedAt: 1700000000000 };
    // Classification-queue pins: pending cards in every input-resolution
    // branch (direct ids, taskId scan, marker scan, seed fallback, unreadable
    // history, empty refs), plus the guard cards (archived, attempt limit) and
    // the startup-scan recovery states.
    const pendingAssignment = { running: false, attempts: 0, lastAttemptAt: 0, lastError: '', seed: '' };
    const stamp = { createdAt: 1700000000000, updatedAt: 1700000000000 };
    liveBoard.tasks['tsk-pending'] = { id: 'tsk-pending', title: '待归类', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 10, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-fallback'] = { id: 'tsk-fallback', title: '回退解析', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 10, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-nolabel'] = { id: 'tsk-nolabel', title: '无标签会话', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-2', dirId: null, userMsgId: 'ms2', assistantMsgId: null, ts: 5, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-archived'] = { id: 'tsk-archived', title: '已归档', status: 'archived',
      moduleAssignment: { ...pendingAssignment }, refs: [], ...stamp };
    liveBoard.tasks['tsk-attempts'] = { id: 'tsk-attempts', title: '次数耗尽', status: 'active',
      moduleAssignment: { ...pendingAssignment, attempts: 2, lastAttemptAt: 1, lastError: 'classification_failed' },
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 10, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-seed'] = { id: 'tsk-seed', title: '空引用', status: 'active',
      moduleAssignment: { ...pendingAssignment, seed: '种子文本' }, refs: [], ...stamp };
    liveBoard.tasks['tsk-seedtext'] = { id: 'tsk-seedtext', title: '种子回退', status: 'active',
      moduleAssignment: { ...pendingAssignment, seed: '种子任务描述' },
      refs: [{ sessionId: 'sess-4', dirId: 'dir-1', userMsgId: 'blank', assistantMsgId: null, ts: 8, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-unreadable'] = { id: 'tsk-unreadable', title: '历史不可读', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-3', dirId: 'dir-1', userMsgId: 'x', assistantMsgId: null, ts: 1, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-marker'] = { id: 'tsk-marker', title: '标记解析', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-5', dirId: 'dir-1', userMsgId: null, assistantMsgId: null, ts: 1, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-scan2'] = { id: 'tsk-scan2', title: '字段解析', status: 'active',
      moduleAssignment: { ...pendingAssignment },
      refs: [{ sessionId: 'sess-6', dirId: 'dir-1', userMsgId: null, assistantMsgId: null, ts: 1, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-scan-missing'] = { id: 'tsk-scan-missing', title: '扫描归档', status: 'active',
      moduleAssignment: { ...pendingAssignment, attempts: 1, lastAttemptAt: 1, lastError: 'missing_context' },
      refs: [], ...stamp };
    liveBoard.tasks['tsk-scan-unreadable'] = { id: 'tsk-scan-unreadable', title: '扫描不可读', status: 'active',
      moduleAssignment: { ...pendingAssignment, attempts: 1, lastAttemptAt: 1, lastError: 'missing_context' },
      refs: [{ sessionId: 'sess-3', dirId: 'dir-1', userMsgId: 'x', assistantMsgId: null, ts: 1, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-scan-recover'] = { id: 'tsk-scan-recover', title: '扫描恢复', status: 'active',
      moduleAssignment: { ...pendingAssignment, attempts: 1, lastAttemptAt: 1, lastError: 'missing_context' },
      refs: [{ sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'mu1', assistantMsgId: 'ma1', ts: 10, excerpt: '' }],
      ...stamp };
    liveBoard.tasks['tsk-scan-interrupted'] = { id: 'tsk-scan-interrupted', title: '扫描中断', status: 'active',
      moduleAssignment: { ...pendingAssignment, running: true, attempts: 1, lastAttemptAt: 1 },
      refs: [], ...stamp };
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
    // Classification-resolution pins: the settled-attribution hook resolves the
    // current turn first, falls back to the per-ref history scans when the turn
    // carries no user text, dedupes on the attribution key, and queues the Aux
    // tag job whose recorded enqueue carries the targeted prompt end to end.
    const settle = [];
    const turn1 = [
      { id: 'tu1', role: 'user', content: '归因文本', ts: 30 },
      { id: 'ta1', role: 'assistant', content: '归因回复', ts: 31 },
    ];
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-pending', turn1, { runId: 'run-1' }));
    // Same attribution key while the first job is still in flight: deduped.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-pending', turn1, { runId: 'run-1' }));
    // Empty turn: the fallback resolves through the ref's stored message ids.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-fallback', [], {}));
    // A session without a records entry labels the prompt with the raw id.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-nolabel', [], { runId: 'run-4' }));
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'missing-task', [], {}));
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-legacy', [], {}));
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-archived', [], {}));
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-attempts', turn1, { runId: 'run-8' }));
    // No refs at all: nothing to resolve, so the card reports missing context.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-seed', [], {}));
    // A throwing history marks the resolution unreadable.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-unreadable', [], {}));
    // Blank user text: the module-assignment seed becomes the user text.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-seedtext', [], { runId: 'run-11' }));
    // Third scan: the task marker inside the message text finds the ref pair.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-marker', [], {}));
    // Second scan: a stored taskId field on the message finds the ref pair.
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-scan2', [], {}));
    const auxJobs = fixture.auxJobs;
    assert.equal(auxJobs.length, 6);
    // Settling the first job applies the classification: the module assignment
    // clears, the module is created and the attribution dedupe resets.
    auxJobs[0].resolve({ text: '{"tasks":[{"id":"tsk-pending","title":"归因任务","module":"服务端","areas":["src/routes"]}]}' });
    await auxJobs[0].promise;
    await Promise.resolve();
    settle.push(await runtime.onTaskAttributionSettled('sess-1', 'tsk-pending', turn1, { runId: 'run-1' }));
    // Startup recovery: archive the proven-stale card, re-prove the unreadable
    // one, clear the recovered one and interrupt the abandoned running flag.
    const scanChanged = runtime.scanPendingClassifications();
    // Turn-end and classify-goal hooks share the turn-resolution projection.
    runtime.onTurnEnd({ currentUserText: '实现任务板', _currentTaskId: 'tsk-legacy' }, 'sess-1');
    runtime.onTurnEnd({ currentUserText: '无对应文本' }, 'sess-1');
    runtime.onClassifyGoal('sess-1', '目标标题', 'done',
      { currentUserText: '实现任务板', taskId: 'tsk-legacy', runState: 'completed' });
    runtime.onClassifyGoal('sess-1', '新目标', 'done',
      { currentUserText: '正式任务卡', runState: 'running' });
    const board = JSON.parse(JSON.stringify(runtime.getBoard()));
    const persisted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const moduleIds = Object.keys(board.modules);
    assert.equal(moduleIds.length, 2);
    for (const moduleId of moduleIds) assert.match(moduleId, /^mod-[a-f0-9]{32}$/);
    assert.equal(board.tasks['tsk-baseline'].moduleId, moduleIds[0]);
    assert.equal(board.tasks['tsk-pending'].moduleId, moduleIds[1]);
    assert.equal(board.modules[moduleIds[0]].id, moduleIds[0]);
    assert.equal(board.modules[moduleIds[1]].id, moduleIds[1]);
    assert.equal(board.modules[moduleIds[1]].name, '服务端');
    assert.equal(persisted.modules[moduleIds[0]].id, moduleIds[0]);
    assert.equal(persisted.tasks['tsk-baseline'].moduleId, moduleIds[0]);
    const jobIds = auxJobs.map(job => job.task.id);
    let raw = JSON.stringify({ results, queue, dtos, followup, sessionMessages,
      classify: { settle, scanChanged }, auxJobs: auxJobs.map(job => job.task),
      board, broadcasts, persisted });
    moduleIds.forEach((moduleId, index) => {
      raw = raw.replaceAll(moduleId, `<generated-module-id-${index}>`);
    });
    jobIds.forEach((jobId, index) => {
      raw = raw.replaceAll(jobId, `<generated-job-id-${index}>`);
    });
    return JSON.parse(raw);
  } finally {
    Date.now = oldNow;
    if (fixture) fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true });
  }
}

function capturePrompts() {
  const core = require('../src/task-board/core');
  const board = { modules: { server: { name: '服务端' } }, tasks: {
    a: { id: 'a', moduleId: 'server', title: '甲', status: 'active', areas: ['a', 'b', '', 'd'] },
    b: { id: 'b', moduleId: 'removed', title: '乙', updatedAt: 2, areas: [] },
    c: { id: 'c', status: 'archived' },
    d: { id: 'd', moduleAssignment: {} },
  } };
  const session = { board, sessionLabel: '工程师', dirLabel: '仓库' };
  const empty = { board: { modules: {}, tasks: {} } };
  const tag = core.buildTagUserPrompt({ ...session, userText: '甲'.repeat(1199) + '🌊',
    replyText: '乙'.repeat(1799) + '🌊' });
  const backfill = core.buildBackfillUserPrompt({ ...session, turns: [
    { n: 1, user: '甲'.repeat(499) + '🌊', reply: '乙'.repeat(699) + '🌊' },
    { n: 2, user: 7, reply: false },
  ] });
  // 以 UTF-16LE 冻结旧提示词，保留恰好从代理对中间截断的码元。
  return [core.buildTagSystemPrompt(), core.buildBackfillSystemPrompt(), tag, backfill,
    core.buildTagUserPrompt(empty), core.buildBackfillUserPrompt({ ...empty, turns: [] })]
    .map(prompt => require('node:crypto').createHash('sha256').update(prompt, 'utf16le').digest('hex'));
}

test('分类提示词与迁移前的 UTF-16 基线一致', () => {
  assert.deepEqual(capturePrompts(), classifyBaseline.promptSha256);
});

test('task board runtime matches its frozen host baseline', async () => {
  const expected = await capture(legacy.createTaskBoardRuntime);
  assert.deepEqual(expected.results, baseline);
  assert.deepEqual(expected.queue, queueBaseline);
  assert.deepEqual(expected.classify, { settle: classifyBaseline.settle, scanChanged: classifyBaseline.scanChanged });
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
  const run = require('../src/native/binding').getNative().taskBoardQueueRunState;
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
  const native = require('../src/native/binding').getNative();
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
  const native = require('../src/native/binding').getNative();
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

test('分类作业区分同步入队异常和异步拒绝，并允许下一轮重试', async t => {
  for (const implementation of [legacy, current]) {
    const logs = [];
    let calls = 0;
    const { runtime, file } = mkRuntime({
      logger: { log: message => logs.push(message) },
      auxQueue: { enqueue() {
        if (++calls === 1) throw new Error('队列未启动');
        return Promise.reject(new Error('工作进程退出'));
      } },
    }, implementation.createTaskBoardRuntime);
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    const task = require('../src/task-board/core').createPendingTask(runtime.getBoard(), {
      taskId: 'failure', sessionId: 'sess-1', taskText: '归类错误', now: 1,
    });
    const submit = runId => runtime.onTaskAttributionSettled('sess-1', task.id,
      [{ role: 'user', content: '归类错误' }], { runId });
    assert.deepEqual(submit('one'), { ok: false, error: 'enqueue_failed' });
    assert.equal(task.moduleAssignment.lastError, 'enqueue_failed');
    assert.deepEqual(submit('one'), { ok: true, queued: true });
    assert.deepEqual(submit('two'), { ok: false, error: 'classification_running' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.moduleAssignment.running, false);
    assert.equal(task.moduleAssignment.lastError, 'classification_failed');
    assert.equal(task.moduleAssignment.attempts, 2);
    assert.deepEqual(submit('two'), { ok: false, error: 'automatic_attempt_limit' });
    assert.ok(logs.some(line => line.endsWith('classify enqueue failed for failure: 队列未启动')));
    assert.ok(logs.some(line => line.endsWith('classify failed for failure: 工作进程退出')));
  }
});

test('恢复扫描取消已失去上下文的作业，迟到回执不能消费同任务的新作业', async t => {
  for (const implementation of [legacy, current]) {
    const jobs = [];
    const cancelled = [];
    const { runtime, file } = mkRuntime({
      auxQueue: {
        enqueue: message => new Promise(resolve => jobs.push({ message, resolve })),
        cancel: id => cancelled.push(id),
      },
    }, implementation.createTaskBoardRuntime);
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    const task = require('../src/task-board/core').createPendingTask(runtime.getBoard(), {
      taskId: 'stale-job', sessionId: 'sess-1', taskText: '恢复归类', now: 1,
    });
    const submit = runId => runtime.onTaskAttributionSettled('sess-1', task.id,
      [{ role: 'user', content: '恢复归类' }], { runId });
    assert.equal(submit('one').queued, true);
    task.moduleAssignment.lastError = 'missing_context';
    task.refs = [];
    assert.equal(runtime.scanPendingClassifications(12), 1);
    assert.deepEqual(cancelled, [jobs[0].message.id]);
    assert.equal(task.status, 'archived');
    task.status = 'active';
    assert.equal(submit('one').queued, true);
    jobs[0].resolve({ text: '{"tasks":[{"title":"迟到结果","module":"旧"}]}' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.moduleAssignment.running, true);
    assert.deepEqual(submit('two'), { ok: false, error: 'classification_running' });
    jobs[1].resolve({ cancelled: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.moduleAssignment.running, false);
    assert.equal(task.moduleAssignment.lastError, 'classification_cancelled');
  }
});

async function captureFirstDispatch(createRuntime, scenario) {
  const key = 'first-dispatch';
  const taskId = 'tsk-' + require('node:crypto').createHash('sha256')
    .update('task-board:dir-1\0' + key).digest('hex').slice(0, 32);
  const calls = [];
  const failure = Object.assign(new Error('派发端口故障'), { code: 'OPERATION_CONFLICT' });
  const fixture = mkRuntime({
    sendSessionMessage(...args) {
      calls.push(['send', ...args]);
      if (scenario === 'retry' && calls.length === 1) return Promise.reject(failure);
      return { chatId: args[0], queued: true, extra: '保留回执扩展字段' };
    },
    dispatchToSession(...args) {
      calls.push(['dispatch', ...args]);
      if (scenario === 'throw') throw failure;
      if (scenario === 'reject') return Promise.reject(failure);
      if (scenario === 'refuse') return null;
      const receipt = { ok: true, chatId: args[0], operationId: 'historical', status: 'running' };
      if (scenario === 'late') return Promise.resolve().then(() => {
        fixture.runtime.getBoard().tasks[taskId].routing.status = 'admitted';
        fixture.deps.records.get('sess-1').label = '更新后的会话名';
        return receipt;
      });
      return receipt;
    },
  }, createRuntime);
  try {
    const { runtime, deps, file, creates, broadcasts } = fixture;
    // Pre-existing module gives both boards the same durable foreign key.
    runtime.getBoard().modules.pending = { id: 'pending', name: '待归类', dirId: 'dir-1',
      source: 'classify', createdAt: 1, updatedAt: 1 };
    if (!['fresh', 'retry'].includes(scenario)) {
      const manual = ['conflict', 'slot', 'manual'].includes(scenario);
      runtime.getBoard().tasks[taskId] = {
        id: taskId, status: 'active', title: '历史任务', refs: [],
        routing: { mode: manual ? 'manual' : 'commander',
          targetSessionId: manual ? 'sess-1' : 'commander-1', workerSessionId: 'sess-1',
          operationId: ['slot', 'manual'].includes(scenario) ? '' : 'historical', status: 'queued' },
      };
      if (scenario === 'slot') deps.records.get('sess-1').taskExecutionSlot = true;
    }
    const results = [];
    const attempts = ['fresh', 'retry'].includes(scenario) ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        results.push(await runtime.routeCommanderInput('commander-1', ' \uFEFF处理任务 ', {
          idempotencyKey: ' ' + key, source: 'task-board', goalNote: '目标\n',
        }));
      } catch (error) {
        assert.equal(error, failure);
        results.push({ rejected: error.code });
      }
    }
    return { calls, results, creates, broadcasts, board: JSON.parse(JSON.stringify(runtime.getBoard())),
      disk: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
  } finally {
    fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true });
  }
}

test('首次派发在绑定、旧回执、手动路由和宿主故障上与冻结实现一致', async t => {
  t.mock.method(Date, 'now', () => 1700000000000);
  for (const scenario of ['fresh', 'retry', 'legacy', 'late', 'conflict', 'slot', 'manual', 'throw', 'reject', 'refuse']) {
    const old = await captureFirstDispatch(legacy.createTaskBoardRuntime, scenario);
    assert.deepEqual(await captureFirstDispatch(current.createTaskBoardRuntime, scenario), old, scenario);
    const [first, second] = old.results;
    switch (scenario) {
      case 'fresh':
        assert.equal(second.duplicate, true);
        assert.deepEqual(old.calls.map(call => call[0]), ['send']);
        assert.equal(old.disk.tasks[first.taskId].routing.operationId, first.operationId);
        break;
      case 'retry':
        assert.equal(first.rejected, 'OPERATION_CONFLICT');
        assert.equal(second.ok, true);
        assert.equal(old.creates.length, 1);
        assert.deepEqual(old.calls.map(call => call[1]), ['bound-1', 'bound-1']);
        break;
      case 'late':
        assert.equal(first.duplicate, true);
        assert.equal(first.queued, false);
        assert.equal(first.targetLabel, '更新后的会话名');
        break;
      case 'legacy':
      case 'manual':
        assert.equal(first.ok, true);
        assert.equal(first.duplicate, scenario === 'legacy' ? true : undefined);
        assert.equal(old.calls[0][3].idempotencyKey,
          scenario === 'legacy' ? 'task-run:historical' : 'task-start:' + first.taskId);
        break;
      case 'slot':
      case 'conflict':
        assert.equal(first.code, scenario === 'slot' ? 'no_relevant_target' : 'idempotency_conflict');
        assert.equal(old.calls.length, 0);
        break;
      case 'refuse':
        assert.deepEqual(first, { ok: false, error: 'dispatch_failed' });
        break;
      default:
        assert.deepEqual(first, { ok: false, code: 'idempotency_conflict', error: '派发端口故障' });
    }
  }
});

async function captureFollowup(factory, scenario) {
  const calls = [];
  const target = 'target';
  const bound = 'bound';
  const error = new Error('续发被拒绝');
  let failSave = false;
  const fixture = mkRuntime({
    loadHistory: () => [
      { id: 'u', role: 'user', content: '用户原文', ts: 1 },
      { id: 'a', role: 'assistant', content: '助手回复', ts: 2 },
    ],
    buildTaskRunContext({ task, messages, includeCurrent }) {
      calls.push(['上下文', task.id, messages.map(m => ({ ...m })), includeCurrent]);
      if (scenario === '坏上下文') throw error;
      return { text: '  上下文  ' };
    },
    sendSessionMessage(sessionId, body, options) {
      calls.push(['投递', sessionId, body, { ...options }]);
      if (scenario === '异步拒绝') return Promise.reject(error);
      if (scenario === '未投递') return { ok: false, code: 'not_accepted' };
      return { operationId: 'op-followup', queued: true };
    },
    atomicWriteJson(file, value) {
      if (failSave) throw new Error('写入失败');
      fs.writeFileSync(file, JSON.stringify(value));
    },
  }, factory);
  try {
    const { runtime, deps, file, broadcasts } = fixture;
    const tasks = runtime.getBoard().tasks;
    deps.records.set(bound, { id: bound, kind: 'chat', dirId: 'dir-1',
      taskBoundTaskId: target, cliSessionId: scenario === '热会话' ? 'native-id' : null });
    const ref = { sessionId: 'sess-1', dirId: 'dir-1', userMsgId: 'u', assistantMsgId: 'a', ts: 1 };
    const excerpt = { sessionId: 'sess-1', dirId: 'dir-1', ts: 4, excerpt: '旧摘录' };
    tasks[target] = { id: target, status: scenario === '归档' ? 'archived' : 'active',
      title: '父任务', refs: [ref, excerpt], chatSessionId: bound };
    tasks.child = { id: 'child', status: 'archived', mergedInto: target,
      refs: [{ ...ref, assistantMsgId: null }, { ...excerpt }] };
    runtime.save();
    failSave = scenario === '写失败';
    let result;
    try {
      result = await runtime.routeCommanderFollowup('commander-1', target, '  继续处理  ',
        { clientMsgId: ' 本次 ', source: 'commander', goalNote: '目标\n' });
    } catch (e) {
      assert.equal(e, error);
      result = { rejected: true };
    }
    return { result, calls, broadcasts, disk: JSON.parse(fs.readFileSync(file)),
      board: JSON.parse(JSON.stringify(runtime.getBoard())) };
  } finally {
    fs.rmSync(path.dirname(fixture.file), { recursive: true, force: true });
  }
}

test('续发的上下文、发送回执、广播及落盘失败回滚与冻结实现一致', async t => {
  t.mock.method(Date, 'now', () => 1700000000000);
  for (const scenario of ['冷启动', '热会话', '坏上下文', '异步拒绝', '未投递', '写失败', '归档']) {
    const expected = await captureFollowup(legacy.createTaskBoardRuntime, scenario);
    assert.deepEqual(await captureFollowup(current.createTaskBoardRuntime, scenario), expected, scenario);
    const send = expected.calls.find(row => row[0] === '投递');
    if (scenario === '归档') { assert.equal(send, undefined); continue; }
    assert.equal(send[2], '目标\n继续处理');
    if (scenario === '冷启动') {
      assert.equal(send[3].taskContextSeed, '  上下文  \n\n');
      const messages = expected.calls[0][2].map(m => m.text);
      assert.deepEqual(messages.sort(), ['用户原文', '助手回复', '旧摘录'].sort());
    }
    if (scenario === '热会话' || scenario === '坏上下文') assert.equal(send[3].taskContextSeed, undefined);
    if (scenario === '写失败') {
      assert.deepEqual(expected.result, { ok: false, code: 'persistence_failed', delivered: true });
      assert.deepEqual(expected.board.tasks.target, expected.disk.tasks.target);
    }
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRoutingContext,
  pickDirTarget,
  pickRouteTarget,
  rankRoutingCandidates,
  recordAppearsAvailable,
  routingRelevanceScore,
  routingTerms,
  resolveDirectoryCommander,
} = require('../src/task-board/core');

function rec(overrides = {}) {
  return {
    kind: 'chat',
    type: 'chat',
    dirId: 'dir-web',
    createdAt: 1,
    label: '',
    rolePrompt: '',
    taskState: {},
    ...overrides,
  };
}

function taskFixture(refs = []) {
  const board = {
    modules: {
      web: { id: 'web', name: '前端 UI', dirId: 'dir-web' },
    },
  };
  return {
    board,
    task: {
      id: 'tsk-route',
      moduleId: 'web',
      title: '修复任务详情消息跳转',
      areas: ['public/task-board-ui.js', '消息定位'],
      refs,
    },
  };
}

test('routing terms and scoring use only useful semantic metadata', () => {
  const terms = routingTerms('修复前端消息排序 task-board');
  assert.equal(terms.has('前端'), true);
  assert.equal(terms.has('任务'), false);
  assert.equal(terms.has('task'), false);
  assert.equal(terms.has('board'), true);

  const context = buildRoutingContext({ queryText: '前端消息排序' });
  assert.ok(routingRelevanceScore(context, rec({ label: '前端消息工程师' })) > 0);
  assert.equal(routingRelevanceScore(context, rec({ label: '数据库备份' })), 0);
});

test('directory routing excludes a busy newest session', () => {
  const records = new Map([
    ['busy-newest', rec({ label: '前端消息排序', active: true, lastActivity: 999 })],
    ['idle-relevant', rec({ label: '前端消息排序', lastActivity: 10 })],
  ]);
  assert.equal(pickDirTarget(records, 'dir-web', null, { queryText: '前端消息排序' }), 'idle-relevant');
});

test('older relevant session beats newer irrelevant session', () => {
  const records = new Map([
    ['relevant-old', rec({ label: '前端消息排序工程师', lastActivity: 10 })],
    ['irrelevant-new', rec({ label: '数据库备份', lastActivity: 999 })],
  ]);
  assert.equal(pickDirTarget(records, 'dir-web', null, { queryText: '修复前端消息排序' }), 'relevant-old');
});

test('explicit busy target fails closed instead of silently rerouting', () => {
  const records = new Map([
    ['busy', rec({ label: '前端', busy: true })],
    ['idle', rec({ label: '前端' })],
  ]);
  assert.equal(pickDirTarget(records, 'dir-web', 'busy', { queryText: '前端' }), null);
  const { board, task } = taskFixture();
  assert.equal(pickRouteTarget(board, task, records, 'busy', { queryText: '前端' }), null);
});

test('task routing skips busy refs and selects another relevant idle session', () => {
  const { board, task } = taskFixture([{ sessionId: 'busy-ref', dirId: 'dir-web', ts: 500 }]);
  const records = new Map([
    ['busy-ref', rec({ label: '前端任务板', active: true, lastActivity: 500 })],
    ['idle-router', rec({
      label: '前端路由工程师',
      rolePrompt: '负责任务详情消息跳转和精确定位',
      lastActivity: 10,
    })],
    ['idle-db', rec({ label: '数据库工程师', lastActivity: 900 })],
    ['wrong-dir', rec({ dirId: 'dir-other', label: '任务详情消息跳转', lastActivity: 999 })],
  ]);
  assert.equal(pickRouteTarget(board, task, records, null, { queryText: '继续修复消息跳转' }), 'idle-router');
});

test('all busy or zero relevance returns null', () => {
  const busyRecords = new Map([
    ['a', rec({ label: '前端消息', active: true })],
    ['b', rec({ label: '前端消息', status: 'running' })],
  ]);
  assert.equal(pickDirTarget(busyRecords, 'dir-web', null, { queryText: '前端消息' }), null);

  const unrelated = new Map([
    ['db', rec({ label: '数据库备份' })],
  ]);
  assert.equal(pickDirTarget(unrelated, 'dir-web', null, { queryText: '前端消息' }), null);
  const { board, task } = taskFixture();
  assert.equal(pickRouteTarget(board, task, unrelated, null, { queryText: '前端消息' }), null);
});

test('ranking is deterministic and uses recency only after equal score', () => {
  const contextTerms = buildRoutingContext({ queryText: '前端消息' });
  const records = new Map([
    ['older', rec({ label: '前端消息', lastActivity: 10 })],
    ['newer', rec({ label: '前端消息', lastActivity: 20 })],
  ]);
  assert.deepEqual(rankRoutingCandidates(records, { dirId: 'dir-web', contextTerms }).map(x => x.sid), ['newer', 'older']);

  records.get('older').lastActivity = 20;
  assert.deepEqual(rankRoutingCandidates(records, { dirId: 'dir-web', contextTerms }).map(x => x.sid), ['newer', 'older']);
});

test('availability callback is authoritative and task affinity never bypasses it', () => {
  const { board, task } = taskFixture([{ sessionId: 'ref', dirId: 'dir-web', ts: 5 }]);
  const records = new Map([
    ['ref', rec({ label: '前端消息' })],
    ['idle', rec({ label: '前消息跳转' })],
  ]);
  const available = sid => sid !== 'ref';
  assert.equal(pickRouteTarget(board, task, records, null, {
    queryText: '前端消息跳转',
    isAvailable: available,
  }), 'idle');
});

test('routed work only lands on a session whose own turn is settled', () => {
  // The classify letter decides whether the session's own turn is over, so a
  // parked B (a background job the router cannot see) must not be handed a
  // second task to run behind the first one's back — that was the bug: the old
  // `!['A','P'].includes(classifyState)` gated P alone, and 'A' is not even a
  // letter. P/C (in flight), B (parked) and E (ended in a fault) are all busy;
  // only D (executed) and W (back with the user) are free, and a session that
  // has never been classified has no outstanding turn at all.
  const FREE = { D: true, W: true, P: false, C: false, B: false, E: false, X: false };
  for (const [letter, free] of Object.entries(FREE)) {
    assert.equal(recordAppearsAvailable(rec({ taskState: { classifyState: letter } }), 'sid'), free,
      `${letter} availability`);
  }
  assert.equal(recordAppearsAvailable(rec({ taskState: {} }), 'sid'), true, 'unclassified is free');
  assert.equal(recordAppearsAvailable(rec(), 'sid'), true, 'no taskState is free');
  // A busy/active record is still rejected regardless of the letter.
  assert.equal(recordAppearsAvailable(rec({ active: true, taskState: { classifyState: 'D' } }), 'sid'), false);
  assert.equal(recordAppearsAvailable(rec({ runState: 'running', taskState: { classifyState: 'W' } }), 'sid'), false);
  // The letter is compared in canonical uppercase (callers hand over persisted
  // snapshots, which are uppercased before matching).
  assert.equal(recordAppearsAvailable(rec({ taskState: { classifyState: 'b' } }), 'sid'), false);
});

test('automatic authority resolves exactly one typed Commander in the requested directory', () => {
  const records = new Map([
    ['active-worker', rec({ active: true, label: '最近活跃 worker' })],
    ['label-only', rec({ label: '🫡 Agent Commander' })],
    ['commander-web', rec({ type: 'commander', label: '任意显示名' })],
    ['commander-other', rec({ type: 'commander', dirId: 'dir-other' })],
  ]);
  const resolved = resolveDirectoryCommander(records, 'dir-web');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sessionId, 'commander-web');
});

test('Commander resolution fails closed for missing, ambiguous and unscoped fleets', () => {
  const labelOnly = new Map([
    ['looks-like-commander', rec({ label: 'Agent Commander' })],
  ]);
  assert.deepEqual(resolveDirectoryCommander(labelOnly, 'dir-web'), {
    ok: false, code: 'commander_not_found',
  });
  assert.deepEqual(resolveDirectoryCommander(labelOnly, null), {
    ok: false, code: 'directory_required',
  });

  const duplicate = new Map([
    ['commander-a', rec({ type: 'commander' })],
    ['commander-b', rec({ type: 'commander' })],
  ]);
  assert.deepEqual(resolveDirectoryCommander(duplicate, 'dir-web'), {
    ok: false, code: 'commander_ambiguous',
  });
});

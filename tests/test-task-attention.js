'use strict';
// 「这个任务有结果你还没看」记在服务端的任务记录上（src/task-board/attention.js），
// 所有 Air 标签页、PWA 窗口和 App 读同一份答案；页面只决定响不响、念不念。
// 以前每个页面在 localStorage 里各记一份，多开标签时互相覆盖 → 已看过的又被提醒。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const attention = require('../src/task-board/attention');
const { mkRuntime } = require('./helpers/task-board-runtime');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const { mountAirRoutes } = require('../src/workspace/air-routes');

test('a run moving into completed / error / waiting leaves a mark; the same outcome again does not', () => {
  const task = { id: 't', status: 'active' };
  assert.equal(attention.noteRunState(task, 'running', 'succeeded', 100), true);
  assert.deepEqual(task.attention, { kind: 'completed', at: 100 });
  assert.equal(attention.noteRunState(task, 'succeeded', 'succeeded', 200), false);
  assert.equal(attention.noteRunState(task, 'running', 'queued', 200), false, 'a finished result survives a rerun');
  assert.deepEqual(attention.pendingAttention(task), { kind: 'completed', at: 100 });
  assert.equal(attention.noteRunState(task, 'running', 'error', 300), true);
  assert.equal(attention.pendingAttention(task).kind, 'error');
});

test('an answered question drops its mark; idle / background never ask for anything', () => {
  const task = { id: 't', status: 'active' };
  attention.noteRunState(task, 'running', 'waiting', 100);
  assert.equal(attention.pendingAttention(task).kind, 'waiting');
  assert.equal(attention.noteRunState(task, 'waiting', 'running', 150), true);
  assert.equal(attention.pendingAttention(task), null);
  for (const state of ['idle', 'background', 'queued', 'running']) {
    assert.equal(attention.noteRunState(task, 'running', state, 200), false, state);
  }
});

test('opening clears it; a later outcome is pending again even with a skewed clock', () => {
  const task = { id: 't', status: 'active' };
  assert.equal(attention.markSeen(task, 50), false, 'nothing to clear');
  attention.noteRunState(task, 'running', 'succeeded', 100);
  assert.equal(attention.markSeen(task, 90), true);
  assert.equal(task.seenAt, 100, 'seenAt never lands before the mark it cleared');
  assert.equal(attention.pendingAttention(task), null);
  assert.equal(attention.markSeen(task, 120), false, 'a second open changes nothing');
  attention.noteRunState(task, 'running', 'succeeded', 80);
  assert.equal(attention.pendingAttention(task)?.at, 101);
});

test('archived tasks and malformed persisted fields are never pending', () => {
  const task = { id: 't', status: 'archived', attention: { kind: 'completed', at: 100 } };
  assert.equal(attention.pendingAttention(task), null);
  const loaded = {};
  attention.normalizeAttention({ attention: { kind: 'nope', at: 5 }, seenAt: 'x' }, loaded);
  assert.deepEqual(loaded, {});
  attention.normalizeAttention({ attention: { kind: 'error', at: '7' }, seenAt: 3 }, loaded);
  assert.deepEqual(loaded, { attention: { kind: 'error', at: 7 }, seenAt: 3 });
});

test('runtime: queue events write the mark, markTaskSeen clears + broadcasts, both survive restart', t => {
  const f = mkRuntime();
  t.after(() => fs.rmSync(path.dirname(f.file), { recursive: true, force: true }));
  const board = f.runtime.getBoard();
  board.tasks.x = { id: 'x', title: 'X', status: 'active', origin: 'session', refs: [], areas: [] };
  f.runtime.onQueueEvent({ taskId: 'x', type: 'started', at: 1000 });
  assert.equal(attention.pendingAttention(board.tasks.x), null);
  f.runtime.onQueueEvent({ taskId: 'x', type: 'completed', turnOutcome: 'succeeded', at: 2000 });
  assert.equal(attention.pendingAttention(board.tasks.x)?.kind, 'completed');

  const reloaded = createTaskBoardRuntime(f.deps);
  assert.equal(attention.pendingAttention(reloaded.getBoard().tasks.x)?.kind, 'completed', 'mark persisted');

  const before = f.broadcasts.length;
  assert.equal(f.runtime.markTaskSeen('x'), true);
  assert.ok(f.broadcasts.length > before, 'other clients hear about it');
  assert.equal(f.runtime.markTaskSeen('x'), false, 'reopening is a no-op');
  assert.equal(f.runtime.markTaskSeen('missing'), false);
  const again = createTaskBoardRuntime(f.deps);
  assert.equal(attention.pendingAttention(again.getBoard().tasks.x), null, 'seen persisted');
});

test('GET /api/air/tasks/:id/open is where every client marks the task seen', async () => {
  const routes = new Map();
  const seen = [];
  mountAirRoutes({ get: (url, fn) => routes.set(url, fn), post() {}, put() {}, delete() {}, patch() {} }, {
    shell: { taskEntry: async id => ({ readOnly: false, sessionId: 's-' + id }), roleBindings: () => null },
    records: new Map(), directories: new Map(),
    markTaskSeen: id => seen.push(id),
  });
  const res = { json(body) { this.body = body; }, status(code) { this.code = code; return this; } };
  await routes.get('/api/air/tasks/:id/open')({ params: { id: 'x' }, headers: {} }, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(seen, ['x']);
});

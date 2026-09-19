'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskHistoryRetention, taskHistoryRefusal } = require('../src/session/task-history-retention');
const { createChatHistoryService } = require('../src/session/chat-history-service');

test('all task references, including archived and merged tasks, must be removed before history disposal', () => {
  const board = { tasks: {
    a: { id: 'a', status: 'archived', mergedInto: 'b', refs: [{ sessionId: 's1', userMsgId: 'u1' }] },
    b: { id: 'b', status: 'active', refs: [{ sessionId: 's1', userMsgId: 'u1' }] },
  } };
  const data = new Map([['s1', [{ id: 'u1', role: 'user', content: 'shared original' }]]]);
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: id => data.get(id) || [],
  });
  const service = createChatHistoryService({
    ...retention, idFactory: () => 'generated',
    history: { read: id => data.get(id) || [], write: (id, messages) => data.set(id, messages),
      deleteSession: id => data.delete(id), hasPersistedDelivery: () => false },
  });
  assert.throws(() => service.remove('s1', 'u1'), { code: 'TASK_HISTORY_REFERENCED' });
  assert.throws(() => service.replace('s1', []), { code: 'TASK_HISTORY_REFERENCED' });
  assert.throws(() => service.deleteSession('s1'), { code: 'TASK_HISTORY_REFERENCED' });
  delete board.tasks.b;
  assert.throws(() => service.deleteSession('s1'), { code: 'TASK_HISTORY_REFERENCED' });
  assert.equal(service.read('s1')[0].content, 'shared original');
  delete board.tasks.a;
  assert.equal(service.deleteSession('s1'), true);
  assert.equal(data.has('s1'), false);
});

test('metadata-only and bound-session ownership protect history even without message refs', () => {
  const board = { tasks: { a: { id: 'a', status: 'archived', refs: [] } } };
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null,
    loadHistory: () => [{ role: 'user', taskId: 'a' }],
  });
  assert.equal(retention.canDeleteSession('s1'), false);
  board.tasks.a.chatSessionId = 's2';
  assert.equal(retention.canDeleteSession('s2'), false);
  const failed = createTaskHistoryRetention({
    getBoard: () => { throw new Error('board unavailable'); }, getRecord: () => null, loadHistory: () => [],
  });
  assert.throws(() => failed.canDeleteSession('s1'), /board unavailable/);
});

test('normalization and retry dedup never discard a referenced assistant id', () => {
  const original = [{ id: 'a1', role: 'assistant', taskId: 'task-1', content: 'a complete answer with detail' },
    { id: 'a2', role: 'assistant', taskId: 'task-1', content: 'a complete answer with detail and more' }];
  const data = new Map([['s1', original]]);
  const service = createChatHistoryService({
    idFactory: () => 'a3',
    history: { read: id => data.get(id) || [], write: (id, messages) => data.set(id, messages),
      deleteSession: id => data.delete(id), hasPersistedDelivery: () => false },
  });
  assert.deepEqual(service.read('s1').map(m => m.id), ['a1', 'a2']);
  service.append('s1', { role: 'assistant', taskId: 'task-1', content: original[1].content });
  assert.deepEqual(service.read('s1').map(m => m.id), ['a1', 'a2', 'a3']);
});

test('referencingTasks names every task pinning a session, de-duplicated across linkage kinds', () => {
  const board = { tasks: {
    bound: { id: 'bound', title: '绑定任务', chatSessionId: 's1' },
    worker: { id: 'worker', title: '协作任务', routing: { workerSessionId: 's1' } },
    byMsg: { id: 'byMsg', title: '消息任务' },
    unrelated: { id: 'unrelated', title: '无关任务', chatSessionId: 'other' },
    deleting: { id: 'deleting', title: '删除中', chatSessionId: 's1', deleting: true },
  } };
  const data = new Map([['s1', [
    { id: 'u1', role: 'user', taskId: 'byMsg' },
    { id: 'u2', role: 'user', taskId: 'bound' }, // duplicate linkage must not double-count
  ]]]);
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: id => data.get(id) || [],
  });
  const ids = retention.referencingTasks('s1').map(task => task.id).sort();
  assert.deepEqual(ids, ['bound', 'byMsg', 'worker']);
  assert.deepEqual(retention.referencingTasks('s1').find(t => t.id === 'bound'),
    { id: 'bound', title: '绑定任务' });
  // A session nothing references reports an empty list, never a throw.
  assert.deepEqual(retention.referencingTasks('ghost'), []);
});

test('referencingTasks falls back to the id when a task has no title', () => {
  const board = { tasks: { t: { id: 't', chatSessionId: 's1' } } };
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: () => [],
  });
  assert.deepEqual(retention.referencingTasks('s1'), [{ id: 't', title: 't' }]);
});

test('a retention refusal error carries the referencing tasks for the UI to name', () => {
  const board = { tasks: { a: { id: 'a', title: '季度复盘', chatSessionId: 's1' } } };
  const data = new Map([['s1', [{ id: 'u1', role: 'user', content: 'x' }]]]);
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: id => data.get(id) || [],
  });
  const service = createChatHistoryService({
    ...retention, idFactory: () => 'generated',
    history: { read: id => data.get(id) || [], write: (id, messages) => data.set(id, messages),
      deleteSession: id => data.delete(id), hasPersistedDelivery: () => false },
  });
  let caught;
  try { service.deleteSession('s1'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'TASK_HISTORY_REFERENCED');
  assert.deepEqual(caught.tasks, [{ id: 'a', title: '季度复盘' }]);
  assert.deepEqual(caught.taskIds, ['a']);
});

test('a board read failure while enriching never masks the refusal', () => {
  const data = new Map([['s1', [{ id: 'u1', role: 'user', taskId: 'a' }]]]);
  const retention = createTaskHistoryRetention({
    getBoard: () => ({ tasks: { a: { id: 'a', title: 'A' } } }),
    getRecord: () => null,
    loadHistory: id => data.get(id) || [],
  });
  const service = createChatHistoryService({
    canDeleteSession: () => false,
    referencingTasks: () => { throw new Error('board unavailable'); },
    idFactory: () => 'generated',
    history: { read: id => data.get(id) || [], write: (id, messages) => data.set(id, messages),
      deleteSession: id => data.delete(id), hasPersistedDelivery: () => false },
  });
  let caught;
  try { service.deleteSession('s1'); } catch (error) { caught = error; }
  assert.equal(caught.code, 'TASK_HISTORY_REFERENCED');
  assert.deepEqual(caught.tasks, []);
  assert.ok(retention, 'retention still composed');
});

test('taskHistoryRefusal names the tasks in the user-facing message', () => {
  const named = taskHistoryRefusal({
    code: 'TASK_HISTORY_REFERENCED',
    tasks: [{ id: 'a', title: '季度复盘' }, { id: 'b', title: '预算表' }],
  });
  assert.equal(named.ok, false);
  assert.equal(named.code, 'TASK_HISTORY_REFERENCED');
  assert.equal(named.blocked, true);
  assert.deepEqual(named.reasons, ['task_history_referenced']);
  assert.deepEqual(named.taskIds, ['a', 'b']);
  assert.match(named.error, /季度复盘/);
  assert.match(named.error, /预算表/);
  // Without task names it still explains the refusal and the disposal path.
  const bare = taskHistoryRefusal({ code: 'TASK_HISTORY_REFERENCED' });
  assert.deepEqual(bare.tasks, []);
  assert.match(bare.error, /无法删除/);
  assert.match(bare.error, /清空历史/);
  // A missing/blank error degrades to history_check_failed, never undefined.
  assert.equal(taskHistoryRefusal().code, 'history_check_failed');
});

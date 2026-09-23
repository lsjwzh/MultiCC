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
    { id: 'bound', title: '绑定任务', via: 'session' });
  // A task with only stamped messages in this conversation is marked as a
  // same-shell sibling, so the UI can distinguish it from external owners.
  assert.deepEqual(retention.referencingTasks('s1').find(t => t.id === 'byMsg'),
    { id: 'byMsg', title: '消息任务', via: 'messages' });
  // A session nothing references reports an empty list, never a throw.
  assert.deepEqual(retention.referencingTasks('ghost'), []);
});

test('referencingTasks falls back to the id when a task has no title', () => {
  const board = { tasks: { t: { id: 't', chatSessionId: 's1' } } };
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: () => [],
  });
  assert.deepEqual(retention.referencingTasks('s1'), [{ id: 't', title: 't', via: 'session' }]);
});

test('stamps of already-deleted tasks are orphans and must not block disposal', () => {
  // A message stamped with a taskId that is gone from the board AND listed in
  // deletedTaskIds belongs to a deleted task; protecting it forever would
  // wedge every session it lives in. A stamp absent from both is a provisional
  // task awaiting classification and stays protected.
  const board = { tasks: {}, deletedTaskIds: ['gone'] };
  const data = new Map([['s1', [
    { id: 'u1', role: 'user', taskId: 'gone', content: 'orphan' },
    { id: 'u2', role: 'user', taskId: 'provisional', content: 'awaiting classification' },
  ]]]);
  const retention = createTaskHistoryRetention({
    getBoard: () => board, getRecord: () => null, loadHistory: id => data.get(id) || [],
  });
  const service = createChatHistoryService({
    ...retention, idFactory: () => 'generated',
    history: { read: id => data.get(id) || [], write: (id, messages) => data.set(id, messages),
      deleteSession: id => data.delete(id), hasPersistedDelivery: () => false },
  });
  assert.throws(() => service.remove('s1', 'u2'), { code: 'TASK_HISTORY_REFERENCED' });
  service.remove('s1', 'u1');
  assert.deepEqual(service.read('s1').map(m => m.id), ['u2']);
  // The provisional stamp still blocks whole-session disposal on its own.
  assert.equal(retention.isMessageProtected('s1', { id: 'u2', taskId: 'provisional' }), true);
  assert.equal(retention.isMessageProtected('s1', { id: 'u1', taskId: 'gone' }), false);
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
  assert.deepEqual(caught.tasks, [{ id: 'a', title: '季度复盘', via: 'session' }]);
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
  // Tasks are grouped by linkage kind: external owners vs same-conversation
  // siblings, so the user learns which cards live right in this shell.
  const grouped = taskHistoryRefusal({
    code: 'TASK_HISTORY_REFERENCED',
    tasks: [{ id: 'a', title: '外部任务', via: 'session' }, { id: 'b', title: '同壳任务', via: 'messages' }],
  });
  assert.match(grouped.error, /引用它的任务：「外部任务」/);
  assert.match(grouped.error, /同一对话中的任务：「同壳任务」/);
  // A missing/blank error degrades to history_check_failed, never undefined.
  assert.equal(taskHistoryRefusal().code, 'history_check_failed');
});

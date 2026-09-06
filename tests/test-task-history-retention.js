'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskHistoryRetention } = require('../src/session/task-history-retention');
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

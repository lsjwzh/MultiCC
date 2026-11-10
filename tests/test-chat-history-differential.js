'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const legacy = require('./helpers/legacy-chat-history-service');
const native = require('../src/session/chat-history-service');
const clone = value => value === undefined ? undefined : structuredClone(value);

function view(value) {
  if (value instanceof Date) return { date: value.getTime() };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(view);
  return Object.fromEntries(Object.keys(value).map(key => [key, view(value[key])]));
}
function harness(implementation, initial = []) {
  const stored = new Map([['s', clone(initial)]]);
  const calls = [];
  const control = { writeFailure: false, readFailure: false, deleteFailure: false,
    callbackFailure: false, protectedFailure: false, referencesFailure: false,
    retention: 4, id: 0, reenter: null, readonlyDuringWrite: false };
  let service;
  const history = {
    read(id) {
      assert.equal(this, history);
      calls.push(['read', id]);
      if (control.readFailure) throw new Error('read failed');
      return stored.get(id) || [];
    },
    write(id, messages) {
      assert.equal(this, history);
      calls.push(['write', id, view(messages)]);
      if (control.readonlyDuringWrite) calls.push(['before-write-view', view(service.view(id))]);
      if (control.writeFailure) throw new Error('write failed');
      stored.set(id, messages);
    },
    deleteSession(id) {
      calls.push(['delete', id]);
      if (control.deleteFailure) throw new Error('delete failed');
      return stored.delete(id);
    },
    hasPersistedDelivery(id, delivery) {
      calls.push(['durable-delivery', id, delivery]);
      if (control.readFailure) throw new Error('read failed');
      return (stored.get(id) || []).some(row => row.deliveryId === delivery || row.clientMsgId === delivery);
    },
  };
  service = implementation.createChatHistoryService({
    history,
    idFactory() { assert.equal(this, undefined); calls.push(['id']); return `generated-${++control.id}`; },
    clock() { assert.equal(this, undefined); calls.push(['clock']); return 1000 + control.id; },
    retentionPolicy(id) { calls.push(['retention', id]); return control.retention; },
    isMessageProtected(id, row) {
      calls.push(['protected', id, view(row)]);
      if (control.protectedFailure) throw new Error('protection failed');
      return !!row.taskId;
    },
    referencingTasks(id) {
      calls.push(['references', id]);
      if (control.referencesFailure) throw new Error('references failed');
      return [null, { id: 'task-1' }, { id: '' }];
    },
    postPersist(event) {
      assert.equal(this, undefined);
      assert.equal(Object.isFrozen(event), true);
      if (event.message) assert.equal(Object.isFrozen(event.message), true);
      calls.push(['post', view(event), view(service.view(event.sessionId))]);
      if (control.reenter) { const fn = control.reenter; control.reenter = null; fn(service); }
      if (control.callbackFailure) throw new Error('callback failed');
    },
    onPostPersistError(error, event) { calls.push(['post-error', error.message, view(event)]); },
  });
  const after = event => { calls.push(['after', view(event)]); };
  return { service, stored, calls, control, after };
}
function outcome(h, method, args) {
  try {
    const result = h.service[method](...args);
    if (result && typeof result === 'object' && !(result instanceof Date) && !Array.isArray(result)) {
      assert.equal(Object.isFrozen(result), true);
      if ('messages' in result) assert.equal(result.messages, result.messages);
    }
    return { ok: true, value: view(result) };
  } catch (error) {
    return { ok: false, error: { name: error.name, message: error.message, code: error.code,
      tasks: view(error.tasks), taskIds: view(error.taskIds) } };
  }
}
function pair(initial) { return [harness(legacy, initial), harness(native, initial)]; }
function run(pair, method, args, withAfter = false) {
  const results = pair.map(h => outcome(h, method, withAfter ? [...clone(args), { afterCommit: h.after }] : clone(args)));
  assert.deepEqual(results[1], results[0], `${method}: 返回值`);
  assert.deepEqual(pair[1].calls, pair[0].calls, `${method}: 端口轨迹`);
  assert.deepEqual([...pair[1].stored].map(view), [...pair[0].stored].map(view), `${method}: 持久状态`);
  return results[1];
}

const sources = [
  [],
  [null, 3, { role: 'user', content: '缺编号' }, { role: 'assistant', content: '旧快照', _interim: true }],
  [{ id: 'a', role: 'assistant', content: 'abcdefghijklmnop' },
    { role: 'user', content: '  🔇 继续' }, { role: 'assistant', content: 'abcdefghijklmnopQ' }],
  [{ id: 'a', role: 'assistant', content: '相同', heldResultId: 'q1' },
    { id: 'b', role: 'assistant', content: '相同', heldResultId: 'q2' }],
  [{ id: 'protected', role: 'assistant', content: 'abcdefghijklmnop', taskId: 'task-1' },
    { id: 'archive', role: 'assistant', content: 'abcdefghijklmnopQ', _handoffArchive: true }],
  [{ id: 'think', role: 'assistant', content: [{ type: 'thinking', thinking: '\uFEFF ' }, { type: 'text', text: '正文' }],
    tools: [{ name: 'Thinking', input: { text: '推理' }, result: '推理' }] }],
];
test('历史迁移：规范化、UUID 隔离、分页和写入回调与冻结旧实现一致', () => {
  for (const initial of sources) {
    const p = pair(initial);
    for (const method of ['view', 'read', 'ensurePersistedIds', 'latestAssistantAt']) run(p, method, ['s']);
    run(p, 'append', ['s', { role: 'assistant', content: '这是长度超过十六个字符的回答用于测试前缀去重' }], true);
    run(p, 'append', ['s', { role: 'user', content: '🔇 系统继续' }], true);
    run(p, 'append', ['s', { role: 'assistant', content: '这是长度超过十六个字符的回答用于测试前缀去重，扩展', deliveryId: 'd1' }], true);
    run(p, 'upsertInterim', ['s', { content: '下一查询', heldResultId: 'q3' }], true);
    run(p, 'upsertInterim', ['s', { content: '下一查询更新', heldResultId: 'q3' }], true);
    run(p, 'append', ['s', { role: 'assistant', content: '下一查询结束', heldResultId: 'q3' }], true);
    for (const limit of [undefined, 0, -2, '2.9', '1000', 'bad', null]) run(p, 'paginate', ['s', { limit }]);
    run(p, 'paginate', ['s', { before: 'missing', limit: 2 }]);
    run(p, 'containsDelivery', ['s', 'd1']);
    run(p, 'hasPersistedDelivery', ['s', 'd1']);
    run(p, 'remove', ['s', 'protected'], true);
    run(p, 'replace', ['s', []], true);
    run(p, 'deleteSession', ['s'], true);
  }
});

test('历史迁移：失败时缓存与缺失编号标记保持原提交顺序', () => {
  const p = pair([{ role: 'user', content: '需补编号' }]);
  run(p, 'read', ['s']);
  for (const h of p) h.control.writeFailure = true;
  run(p, 'ensurePersistedIds', ['s']);
  run(p, 'append', ['s', { role: 'user', content: '不能发布' }], true);
  run(p, 'read', ['s']);
  for (const h of p) { h.control.writeFailure = false; h.control.readonlyDuringWrite = true; }
  run(p, 'ensurePersistedIds', ['s']);
  run(p, 'append', ['s', { role: 'user', content: '成功', clientMsgId: 'd' }], true);
  for (const h of p) h.control.callbackFailure = true;
  run(p, 'upsertInterim', ['s', { content: '广播失败仍已写盘' }], true);
  for (const h of p) h.control.deleteFailure = true;
  run(p, 'deleteSession', ['s'], true);
  run(p, 'read', ['s']);
  for (const h of p) { h.control.readFailure = true; h.control.deleteFailure = false; }
  run(p, 'hasPersistedDelivery', ['s', 'd']);
  run(p, 'containsDelivery', ['s', 'd']);
  run(p, 'invalidate', ['s']);
  run(p, 'read', ['s']);
  for (const h of p) h.control.readFailure = false;
  run(p, 'read', ['s']);
});

test('历史迁移：任务保护、错误补充失败和动态保留策略不放行删除', () => {
  const p = pair([{ id: 'pin', role: 'assistant', taskId: 'task-1', content: '不能删' }]);
  for (const h of p) h.control.referencesFailure = true;
  for (const op of ['deleteSession', 'assertCanDeleteSession']) run(p, op, ['s']);
  run(p, 'replace', ['s', []], true);
  run(p, 'remove', ['s', 'pin'], true);
  for (const h of p) h.control.protectedFailure = true;
  run(p, 'remove', ['s', 'pin'], true);
  for (const value of [1, { maxMessages: 2 }, 0, '3', null, NaN, Infinity]) {
    for (const h of p) h.control.retention = value;
    run(p, 'paginate', ['s']);
  }
});

test('历史迁移：提交后回调同步重入，不持有借用且旧结果保持快照', () => {
  for (const impl of [legacy, native]) {
    const h = harness(impl);
    h.service.read('s');
    const initial = h.service.view('s');
    h.control.reenter = service => service.append('s', { id: 'inner', role: 'user', content: '内层' });
    const result = h.service.append('s', { id: 'outer', role: 'user', content: '外层' });
    assert.deepEqual(result.messages.map(x => x.id), ['outer']);
    assert.deepEqual(h.service.view('s').map(x => x.id), ['outer', 'inner']);
    assert.equal(initial.length, 0);
    result.messages[0].content = '修改副本';
    assert.equal(h.service.view('s')[0].content, '外层');
  }
});

test('历史迁移：固定种子操作序列对照缓存、磁盘和回调轨迹', () => {
  const p = pair(sources[1]);
  let seed = 0x91b42;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = values => values[Math.floor(random() * values.length)];
  for (let i = 0; i < 300; i++) {
    const method = pick(['append', 'append', 'upsertInterim', 'replace', 'remove', 'read', 'invalidate', 'paginate', 'latestAssistantAt']);
    const message = { id: `row-${i}`, role: method === 'upsertInterim' ? 'assistant' : pick(['assistant', 'user']),
      content: pick(['相同', 'abcdefghijklmnop', 'abcdefghijklmnop后续', '🔇 继续', [{ type: 'text', text: '结构化' }]]),
      heldResultId: pick([undefined, 'q1', 'q2']), taskId: random() < 0.1 ? 'task-1' : undefined,
      ts: pick([0, 100, -1, '300']) };
    for (const h of p) { h.control.writeFailure = i % 19 === 0; h.control.callbackFailure = i % 23 === 0; }
    const args = method === 'replace' ? ['s', [message]] : method === 'remove' ? ['s', `row-${i - 1}`]
      : method === 'paginate' ? ['s', { limit: pick([1, 3, '8']) }]
        : ['append', 'upsertInterim'].includes(method) ? ['s', message] : ['s'];
    run(p, method, args, ['append', 'upsertInterim', 'replace', 'remove'].includes(method));
  }
});

test('历史迁移：清理 thinking 保持原对象、稀疏数组和字符串转换', () => {
  for (const impl of [legacy, native]) {
    const value = { content: [null, , { type: 'thinking', thinking: '\uFEFF\t' }, { type: 'thinking', thinking: 7 }, { type: 'text', text: '\ud800' }] };
    assert.equal(impl.cleanThinkingBlocks(value), value);
    assert.deepEqual(value.content, [null, { type: 'thinking', thinking: 7 }, { type: 'text', text: '\ud800' }]);
    assert.throws(() => impl.cleanThinkingBlocks({ content: [{ type: 'thinking', thinking: Symbol('x') }] }), TypeError);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { handoffSnapshot, contextPage } = require('../src/task-shell/history-context');
const { shellHistoryPage, watchShellHistory } = require('../src/task-shell/chat-history');
const { createShellView } = require('../public/chat-shell-entry');

test('X1 executes in B, classifies to C despite partial failure, then continues C with X1 evidence', async t => {
  const f = fixture(t);
  const owner = f.runtime.adopt(f.a.id, 'a');
  const delivery = await f.runtime.send(f.a.id, { text: 'list four products', clientMsgId: 'listing' });
  const history = [
    { id: 'old-u', role: 'user', content: 'old price review' },
    { id: 'old-a', role: 'assistant', content: 'old price answer' },
    { id: 'u', role: 'user', content: 'list four products', taskId: 'tsk_listing', turnId: 'listing' },
    { id: 'a', role: 'assistant', content: 'uploaded first image', partial: true, taskId: 'tsk_listing', turnId: 'listing' },
  ];
  f.histories.set('a', history);
  const evidence = { taskId: 'tsk_listing', turnId: 'listing', anchorMessageId: 'a' };
  assert.equal(f.runtime.settleAttribution('a', delivery.receiptId, evidence).ok, true);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, 'tsk_listing');
  assert.equal(f.creations.length, 0, 'execution is created lazily after attribution');
  assert.deepEqual((await f.runtime.detail(f.a.id, 'tsk_listing')).messages.map(m => m.id), ['u', 'a']);
  const restarted = require('../src/task-shell/runtime').createTaskShellRuntime(f.ports);
  f.statuses.set('a', { busy: false });
  const continued = await restarted.send(f.a.id, { text: '继续', clientMsgId: 'continue' });
  assert.equal(continued.taskId, 'tsk_listing');
  assert.notEqual(continued.sessionId, 'a');
  f.records.get(continued.sessionId).kind = 'chat';
  assert.equal(restarted.open(continued.sessionId).id, f.a.id, 'generated execution URL reopens the original shell');
  assert.match(f.sends.at(-1).opts.taskContextSeed, /uploaded first image/);
  assert.match(f.sends.at(-1).opts.taskContextSeed, /"partial":true/);
  assert.doesNotMatch(f.sends.at(-1).opts.taskContextSeed, /old price/);
  assert.equal(history.at(-1).partial, true, 'canonical evidence is retained');
  const refilled = restarted.refillContext(continued.sessionId, { task_id: 'tsk_listing' });
  assert.deepEqual(refilled.page.messages.map(m => m.sourceSessionId), ['a', 'a']);
  assert.throws(() => restarted.refillContext(continued.sessionId, { task_id: 'outside' }));
  assert.equal(restarted.settleAttribution(continued.sessionId, continued.receiptId, { taskId: owner.id }).ok, true);
  assert.equal(f.runtime.view(f.a.id).currentTaskId, owner.id, 'classification can return to A');
});

test('long handoff preserves current evidence and supports retrieving the full source', () => {
  const history = [
    { id: 'u-old', role: 'user', content: 'old', taskId: 'x', turnId: 'old' },
    { id: 'a-old', role: 'assistant', content: 'done', taskId: 'x', turnId: 'old' },
    { id: 'u', role: 'user', content: 'goal', taskId: 'x', turnId: 'now' },
    { id: 'a', role: 'assistant', content: 'z'.repeat(13000), taskId: 'x', turnId: 'now' },
  ];
  history.at(-1).partial = true;
  const snap = handoffSnapshot('x', history, { turnId: 'now', anchorMessageId: 'a', sessionId: 'b', receipt: { payload: { text: 'goal' } } });
  assert.deepEqual(snap.messages.map(m => m.id), ['u', 'a']);
  assert.equal(snap.messages[1].partial, true);
  assert.equal(snap.messages[1].truncated, true);
  const records = history.map(m => ({ ...m, contextMessageId: 'b:' + m.id }));
  let offset = 0, full = '';
  do {
    const page = contextPage(records, { message_id: 'b:a', offset });
    full += page.message.evidenceExcerpt; offset = page.message.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(full).content, history.at(-1).content);
});

test('late classifier cannot move the cursor after a newer input on the same execution', async t => {
  const f = fixture(t); f.runtime.adopt(f.a.id, 'a');
  const first = await f.runtime.send(f.a.id, { text: 'X1', clientMsgId: 'x1' });
  const second = await f.runtime.send(f.a.id, { text: 'X2', clientMsgId: 'x2' });
  assert.equal(first.taskId, second.taskId);
  assert.equal(f.runtime.settleAttribution('a', first.receiptId, { taskId: 'stale' }).code, 'task_shell_attribution_superseded');
  assert.equal(f.runtime.view(f.a.id).currentTaskId, second.taskId);
});

test('shell pagination includes old history and new progress with independent IDs and visibility', () => {
  const histories = {
    a: [{ id: 'same', role: 'user', content: 'original goal', ts: 1 }, { id: 'a', role: 'assistant', content: 'interrupted', partial: true, ts: 2 }],
    b: [{ id: 'same', role: 'user', content: '继续', ts: 3 }, { id: 'b', role: 'assistant', content: 'new progress', _interim: true, ts: 4 }],
  };
  const state = { _currentTaskId: 'task-b', currentAssistantText: 'latest progress', isStreaming: true };
  const read = id => histories[id];
  const scope = { sessionIds: ['a', 'b'] };
  const newest = shellHistoryPage(scope, read, id => id === 'b' ? state : null, { activeSessionId: 'b', limit: 2 });
  assert.deepEqual(newest.messages.map(m => m.id), ['b:same', 'b:b']);
  assert.equal(newest.messages[1].content, 'latest progress');
  assert.equal(newest.messages[1].streaming, true);
  assert.equal(newest.hasMore, true);
  const older = shellHistoryPage(scope, read, null, { before: newest.messages[0].id, limit: 2 });
  assert.deepEqual(older.messages.map(m => m.id), ['a:same', 'a:a']);
  assert.equal(older.hasMore, false);
  assert.equal(histories.b[1].content, 'new progress', 'display never rewrites canonical/native history');
  assert.equal(shellHistoryPage(scope, read, null, { around: 'a:same' }).found, true);
  const visible = shellHistoryPage(scope, id => histories[id].filter(m => m.id !== 'a'), null, { limit: 100 });
  assert.ok(!visible.messages.some(m => m.id === 'a:a'), 'hidden records stay hidden');
});

test('shell membership checks reject unrelated execution sessions', t => {
  const f = fixture(t);
  f.runtime.adopt(f.a.id, 'a');
  assert.throws(() => f.runtime.chatScope(f.a.id, 'other'), { code: 'task_not_linked' });
  assert.throws(() => f.runtime.chatScope(f.a.id, 'b'), { code: 'task_not_linked' });
  assert.deepEqual(f.runtime.chatScope(f.a.id).sessionIds, ['a']);
});

test('browser reopens the same shell source, follows execution and reconciles namespaced live IDs', async () => {
  const requests = [], sessions = [];
  let activeSessionId = 'a';
  const view = createShellView({ sourceSessionId: 'a', onSession: id => sessions.push(id),
    request: async (url, options) => { requests.push({ url, options }); return options ? { id: 'shell' } : { activeSessionId }; } });
  await view.prepare();
  activeSessionId = 'b';
  await view.prepare();
  assert.equal(requests.filter(r => r.options).length, 1);
  assert.equal(requests[0].options.json.sessionId, 'a');
  assert.deepEqual(sessions, ['a', 'b']);
  assert.equal(view.historyUrl(), '/api/task-shells/shell/history');
  const live = view.event({ type: 'chat_msg_meta', role: 'assistant', id: 'm' });
  assert.equal(live.id, 'b:m');
  const replay = view.event({ type: 'chat_history', messages: [{ id: 'b:m', sourceSessionId: 'b', sourceMessageId: 'm' }] });
  assert.equal(replay.messages[0].id, live.id);
  const reopened = createShellView({ sourceSessionId: 'a', request: async (_url, opts) => opts ? { id: 'shell' } : { activeSessionId } });
  assert.equal(await reopened.prepare(), 'b');
});

test('passive shell subscription delivers background progress and releases listeners', async () => {
  let listener, removed = false;
  const events = [];
  const stop = watchShellHistory({ sessionIds: ['a', 'b'] }, 'b', {
    subscribe: fn => { listener = fn; return () => { removed = true; }; },
    readMessages: id => [{ id: 'm', role: 'assistant', content: id + ' progress', ts: 1 }],
    emit: event => events.push(event),
  });
  listener('b', { type: 'result' }); listener('unrelated', { type: 'result' });
  listener('a', { type: 'result' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(events.length, 1); assert.equal(events[0].messages[0].id, 'a:m');
  listener('a', { type: 'result' }); stop();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(events.length, 1); assert.equal(removed, true);
});

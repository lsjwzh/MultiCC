'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createTaskShellRuntime } = require('../src/task-shell/runtime');
const { parseTaskAttribution, buildTaskAttributionSystemPrompt } = require('../src/classify/task-attribution');
const { mountTaskShellRoutes } = require('../src/task-shell/routes');
const express = require('express');
async function setup(t, extra = {}) {
  const f = fixture(t, { captureForkBaseline: async (_task, _owner, capture) => ({ commit: 'a'.repeat(40), history: await capture() }), ...extra });
  const source = f.runtime.adopt(f.a.id, 'a');
  f.histories.set('a', [{ id: 'u0', role: 'user', content: 'Old goal', taskId: source.id }]);
  const sent = await f.runtime.send(f.a.id, { text: 'Unrelated goal', clientMsgId: 'new-goal' });
  f.histories.get('a').push({ id: 'u1', role: 'user', content: 'Unrelated goal', turnId: 'turn-1', clientMsgId: sent.receiptId, taskId: source.id },
    { id: 'a1', role: 'assistant', content: 'New result', turnId: 'turn-1', taskId: source.id });
  f.statuses.set('a', { busy: false });
  const input = { turnId: 'turn-1', anchorMessageId: 'a1', separation: { title: 'Independent goal', reason: 'Different output' } };
  return { ...f, source, sent, input, propose: () => f.runtime.separation.propose('a', sent.receiptId, input) };
}
test('only explicit low relevance with a title produces a suggestion; locked identity still judges relevance', () => {
  for (const contextRelevance of [undefined, null, 'medium', 'high', 0, 'LOW']) {
    assert.equal(parseTaskAttribution(JSON.stringify({ contextRelevance, splitTaskName: 'Goal' })).separation, undefined);
  }
  assert.deepEqual(parseTaskAttribution('{"contextRelevance":"low","splitTaskName":"New goal","relevanceReason":"Separate"}').separation,
    { title: 'New goal', reason: 'Separate' });
  assert.equal(parseTaskAttribution('{"contextRelevance":"low"}').separation, undefined);
  assert.match(buildTaskAttributionSystemPrompt({ identityLocked: true }), /即使任务身份锁定，也必须判断关联度/);
});
test('suggestion is durable, deduplicated and makes no task, identity, cursor or execution changes', async t => {
  const f = await setup(t), before = JSON.stringify(f.store.list('task')), shell = f.runtime.view(f.a.id);
  const p = f.propose(); assert.equal(p.state, 'pending');
  assert.deepEqual(f.propose(), p);
  assert.equal(JSON.stringify(f.store.list('task')), before);
  assert.deepEqual(f.runtime.view(f.a.id), shell); assert.equal(f.creations.length, 0);
  assert.deepEqual(createTaskShellRuntime(f.ports).separation.latest('a'), p);
});
test('first exchange, stale anchor and forged execution cannot propose separation', async t => {
  const f = await setup(t);
  f.histories.get('a').shift(); assert.equal(f.propose(), null);
  f.histories.get('a').unshift({ id: 'u0', role: 'user', content: 'Old goal' });
  assert.equal(f.runtime.separation.propose('a', f.sent.receiptId, { ...f.input, anchorMessageId: 'missing' }), null);
  assert.throws(() => f.runtime.separation.propose('b', f.sent.receiptId, f.input), { code: 'separation_not_found' });
});
test('keep is durable and idempotent; another client cannot later separate the same suggestion', async t => {
  const f = await setup(t), p = f.propose();
  assert.deepEqual(await f.runtime.separation.decide('a', p.id, 'keep'), { ok: true, decision: 'keep' });
  const restarted = createTaskShellRuntime(f.ports);
  assert.equal(restarted.separation.latest('a'), null);
  assert.equal((await restarted.separation.decide('a', p.id, 'keep')).ok, true);
  await assert.rejects(restarted.separation.decide('a', p.id, 'separate'), { code: 'separation_already_resolved' });
  assert.equal(f.store.list('task').length, 1);
});
test('confirmed separation creates one independent task and imports only this exchange with provenance', async t => {
  const f = await setup(t), p = f.propose(), before = JSON.stringify(f.histories.get('a'));
  const results = await Promise.all([1,2].map(() => f.runtime.separation.decide('a', p.id, 'separate')));
  assert.deepEqual(results[0], results[1]);
  const task = f.store.get('task', results[0].taskId);
  assert.equal(task.separatedFromTaskId, f.source.id); assert.equal(task.parentTaskId, undefined);
  assert.equal(task.forkBaseline.commit, 'a'.repeat(40));
  assert.equal(f.runtime.view(f.a.id).currentTaskId, f.source.id);
  assert.equal(f.store.get('shell', task.ownerShellId).standalone, true);
  assert.equal(f.creations.length, 1); assert.equal(f.sends.length, 1, 'confirmation must not send work to a model');
  assert.equal(JSON.stringify(f.histories.get('a')), before);
  const entry = await f.runtime.taskEntry(task.id);
  assert.deepEqual(entry.messages.map(m => m.content), ['Unrelated goal', 'New result']);
  assert.ok(entry.messages.every(m => m.sourceSessionId === 'a' && m.inherited));
  assert.equal(f.store.list('task').length, 2);
  assert.deepEqual(await createTaskShellRuntime(f.ports).separation.decide('a', p.id, 'separate'), results[0]);
});
test('a newer turn invalidates the old popup even before its receipt has changed', async t => {
  const f = await setup(t), p = f.propose();
  f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Next input' });
  assert.equal(f.runtime.separation.latest('a'), null);
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.equal(f.creations.length, 0);
});
test('busy and dirty sources retain the suggestion and expose the original error', async t => {
  const f = await setup(t, { captureForkBaseline: async () => { throw Object.assign(new Error('Commit first'), { code: 'fork_source_dirty' }); } }), p = f.propose();
  f.statuses.set('a', { busy: true });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_busy' });
  f.statuses.set('a', { busy: false });
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'fork_source_dirty', message: 'Commit first' });
  assert.equal(f.runtime.separation.latest('a').id, p.id); assert.equal(f.store.list('task').length, 1);
});
test('an anchor changed during code capture prevents task creation', async t => {
  const f = await setup(t);
  f.ports.captureForkBaseline = async () => { f.histories.get('a').push({ id: 'u2', role: 'user', content: 'Race' }); return { commit: 'abc' }; };
  const p = f.propose();
  await assert.rejects(f.runtime.separation.decide('a', p.id, 'separate'), { code: 'separation_stale' });
  assert.equal(f.store.list('task').length, 1);
});
test('partial creation resumes the frozen, already confirmed task after restart without duplicating it', async t => {
  const f = await setup(t), p = f.propose();
  const index = f.ports.indexTask;
  f.ports.indexTask = () => ({ ok: false });
  const broken = createTaskShellRuntime(f.ports);
  await assert.rejects(broken.separation.decide('a', p.id, 'separate'), { code: 'task_index_failed' });
  f.ports.indexTask = index;
  const recovered = createTaskShellRuntime(f.ports);
  await assert.rejects(recovered.separation.decide('a', p.id, 'keep'), { code: 'separation_already_confirmed' });
  const result = await recovered.separation.decide('a', p.id, 'separate');
  assert.equal(result.ok, true); assert.equal(f.store.list('task').length, 2); assert.equal(f.creations.length, 1);
});
test('HTTP confirmation binds session and suggestion, validates decisions and keeps errors structured', async t => {
  const f = await setup(t), p = f.propose(), app = express(); app.use(express.json());
  mountTaskShellRoutes(app, { getRuntime: () => f.runtime });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/sessions`;
  const get = await fetch(`${base}/a/task-separation`); assert.equal((await get.json()).suggestion.id, p.id);
  for (const [session, decision, code] of [['b','separate','separation_not_found'], ['a','yes','invalid_input'], ['a','keep',null]]) {
    const res = await fetch(`${base}/${session}/task-separation/${p.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    const body = await res.json(); assert.equal(body.code || null, code); assert.equal(body.ok, !code);
  }
});
